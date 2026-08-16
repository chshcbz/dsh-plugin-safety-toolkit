/**
 * dsh-safe — boot orchestration.
 *
 * Pipeline (all decisions are pure functions exported for testing):
 *   1. decideSafeMode — a previous boot that never became healthy and no
 *      quarantine existed → quarantine ALL user entries once (safe mode).
 *   2. probe every non-quarantined user entry in a subprocess.
 *   3. merge broken entries into the quarantine registry, render the overlay.
 *   4. `--strict` refuses to boot with broken entries; otherwise boot with
 *      the overlay via `--patch`.
 *   5. Health handshake: mark healthy once the child survives `healthWaitMs`
 *      (and, when the port is known, answers HTTP 200).
 */

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probedEntries, duplicateIds } from "./entries.mjs";
import { renderOverlay } from "./overlay.mjs";
import { probeEntries, reasonOf } from "./probe.mjs";
import { statePaths, loadState, saveState, quarantineMap, hasQuarantine, appendLog } from "./state.mjs";

/** Pure: should safe mode quarantine everything? */
export function decideSafeMode(state) {
  if (!state) return false;
  if (state.safeModeEntered === true) return false; // only once
  if (state.healthy === true) return false;
  if (state.lastStart === undefined || state.lastStart === null) return false; // first run
  if (hasQuarantine(state)) return false; // already quarantining something
  return true;
}

/** Pure: merge probe failures into the quarantine registry. */
export function mergeBroken(quarantine, probeResults) {
  const next = { ...quarantine };
  for (const result of probeResults) {
    if (result.ok) continue;
    const id = result.entry.id;
    if (!next[id]) {
      next[id] = {
        name: result.entry.name ?? null,
        reason: reasonOf(result),
        at: new Date().toISOString(),
      };
    }
  }
  return next;
}

/** Pure: quarantine every user entry (safe mode). */
export function quarantineAll(entries, reason) {
  const map = {};
  for (const entry of entries) {
    map[entry.id] = { name: entry.name ?? null, reason, at: new Date().toISOString() };
  }
  return map;
}

export async function runBoot({
  dshBin,
  profile,
  dshHome,
  profileDir,
  userArgs = [],
  healthWaitMs = 45000,
  port,
  strict = false,
  spawnImpl = spawn,
  httpProbe = defaultHttpProbe,
  nodePath = process.execPath,
  onLog = () => {},
}) {
  const paths = statePaths(dshHome, profile);
  const log = (line) => {
    onLog(line);
    appendLog(paths, line);
  };
  const state = loadState(paths) ?? {};

  log(`dsh-safe boot: profile=${profile} home=${dshHome} args=${JSON.stringify(userArgs)}`);

  // 1) User-layer entries (bundle layers trusted).
  const { userEntriesFor } = await import("./entries.mjs");
  const allEntries = userEntriesFor(profileDir, dshHome);
  const toProbe = probedEntries(allEntries);
  log(`user entries: ${allEntries.length} total, ${toProbe.length} to probe`);

  // 1b) Duplicate ids are a hard patch error the overlay cannot fix — refuse
  // with a clear message instead of a cryptic loader crash.
  const duplicates = duplicateIds(allEntries);
  if (duplicates.length > 0) {
    log(`FATAL: duplicate entry ids in user patch layers: ${duplicates.join(", ")}`);
    console.error(
      `dsh-safe: duplicate entry ids in your patch file(s): ${duplicates.join(", ")}\n` +
      "The loader rejects duplicate ids and no quarantine overlay can fix that. " +
      `Edit ${join(profileDir, "cordis.patch.yml")} (and $DSH_HOME/cordis.patch.yml) to make ids unique, then boot again.`
    );
    return { booted: false, broken: [], duplicateIds: duplicates, refused: true };
  }

  // 2) Safe mode decision.
  let quarantine = quarantineMap(state);
  let safeMode = false;
  if (decideSafeMode(state)) {
    quarantine = quarantineAll(toProbe, "safe-mode: previous boot never became healthy");
    safeMode = true;
    log("SAFE MODE: previous boot did not become healthy — quarantining all user plugins");
  }

  // 3) Probe the entries that are not already quarantined.
  const probeTargets = toProbe.filter((entry) => !quarantine[entry.id]);
  const probeResults = await probeEntries(probeTargets, { baseDir: profileDir });
  const broken = probeResults.filter((result) => !result.ok);
  if (broken.length > 0) {
    log(`probe found ${broken.length} broken plugin(s):`);
    for (const result of broken) {
      log(`  - ${result.entry.id} (${result.entry.name}): ${reasonOf(result)}`);
    }
  }

  // 4) Merge + render overlay.
  quarantine = mergeBroken(quarantine, probeResults);
  const overlayText = renderOverlay(quarantine);
  const stateNow = {
    ...state,
    quarantine,
    safeModeEntered: state.safeModeEntered === true || safeMode,
    lastStart: Date.now(),
    healthy: false,
  };
  saveState(paths, stateNow);
  if (overlayText) {
    writeFileSync(paths.overlayFile, overlayText, "utf8");
    log(`quarantine overlay written: ${paths.overlayFile} (${Object.keys(quarantine).length} disabled)`);
  } else if (existsSync(paths.overlayFile)) {
    // nothing quarantined anymore — drop the overlay
    try {
      const { rmSync } = await import("node:fs");
      rmSync(paths.overlayFile, { force: true });
    } catch {
      /* best effort */
    }
  }

  if (broken.length > 0 && strict) {
    log("--strict: refusing to boot with broken plugins");
    console.error(`dsh-safe: ${broken.length} broken plugin(s) and --strict is set; refusing to boot.`);
    return { booted: false, broken, strictRefused: true };
  }

  // 5) Spawn the host.
  const dshArgs = ["--profile", profile];
  if (overlayText) dshArgs.push("--patch", paths.overlayFile);
  dshArgs.push(...userArgs);
  log(`spawning: ${nodePath} ${dshBin} ${dshArgs.join(" ")}`);
  const child = spawnImpl(nodePath, [dshBin, ...dshArgs], {
    stdio: "inherit",
    windowsHide: false,
    env: { ...process.env, DSH_HOME: dshHome },
  });
  try {
    saveState(paths, { ...(loadState(paths) ?? {}), childPid: child.pid ?? null });
  } catch {
    /* best effort */
  }

  // 6) Health handshake.
  let healthyMarked = false;
  const healthTimer = setTimeout(async () => {
    try {
      if (child.exitCode !== null) return; // already exited
      let ok = true;
      if (port !== null && port !== undefined && port > 0) {
        try {
          const res = await httpProbe(`http://127.0.0.1:${port}`);
          ok = res >= 200 && res < 500;
        } catch {
          ok = false;
        }
      }
      if (ok) {
        healthyMarked = true;
        const current = loadState(paths) ?? {};
        saveState(paths, { ...current, healthy: true });
        log(`health: host alive after ${healthWaitMs}ms${port ? ` and HTTP ${port} answered` : ""} — marked healthy`);
      } else {
        log(`health: host alive after ${healthWaitMs}ms but HTTP probe failed — not marked healthy`);
      }
    } catch (error) {
      log(`health check failed: ${error.message}`);
    }
  }, healthWaitMs);

  return await new Promise((resolve) => {
    const cleanup = () => {
      clearTimeout(healthTimer);
    };
    child.on("exit", (code) => {
      cleanup();
      const final = loadState(paths) ?? {};
      saveState(paths, { ...final, lastExit: code ?? null });
      log(`dsh exited with code ${code ?? "null"} (healthyThisRun=${healthyMarked})`);
      resolve({ booted: true, broken, exitCode: code ?? null, healthy: healthyMarked, safeMode });
    });
    child.on("error", (error) => {
      cleanup();
      log(`failed to spawn dsh: ${error.message}`);
      resolve({ booted: false, broken, spawnError: error.message });
    });
  });
}

export async function defaultHttpProbe(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" });
  return res.status;
}
