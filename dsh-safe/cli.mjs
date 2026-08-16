#!/usr/bin/env node
/**
 * dsh-safe — safe launcher for DSH.
 *
 * Usage:
 *   dsh-safe web [args...]                  boot the web profile safely (default)
 *   dsh-safe --profile <name> [args...]
 *   dsh-safe probe                          only run the pre-boot probe + report
 *   dsh-safe status                         show quarantine/health state
 *   dsh-safe unquarantine <id> [<id>...]    re-enable quarantined entries
 *   dsh-safe clear-quarantine               re-enable everything (dangerous)
 *
 * Options: --strict (refuse boot on broken plugins), --health-wait <sec>,
 *          --port <n> (HTTP health probe), --dsh <path-to-bin.js>,
 *          --dsh-home <path>.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { statePaths, loadState, saveState, quarantineMap, appendLog } from "./lib/state.mjs";
import { userEntriesFor, probedEntries } from "./lib/entries.mjs";
import { probeEntries } from "./lib/probe.mjs";
import { renderOverlay } from "./lib/overlay.mjs";
import { runBoot } from "./lib/run.mjs";

const DSH_HOME = () => process.env.DSH_HOME ?? join(homedir(), ".dsh");
const PROFILE_DIR = (home, profile) => join(home, "profiles", profile);

function fail(message) {
  console.error(`dsh-safe: ${message}`);
  process.exit(1);
}

async function resolveDshBin(profileDir, explicit) {
  if (explicit) {
    if (!existsSync(explicit)) fail(`--dsh path not found: ${explicit}`);
    return explicit;
  }
  // 1) resolve from the profile dir (walks the healed profiles/node_modules fallback)
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(join(profileDir, "package.json"));
    const resolved = require.resolve("@deepseek-ai/dsh/lib/bin.js");
    if (existsSync(resolved)) return resolved;
  } catch {
    /* fall through */
  }
  fail(
    "cannot locate the dsh CLI (lib/bin.js). Pass it explicitly with --dsh <path> " +
    "(e.g. --dsh /path/to/node_modules/@deepseek-ai/dsh/lib/bin.js)"
  );
}

function parseArgs(argv) {
  const out = {
    command: "boot",
    profile: "web",
    strict: false,
    healthWaitMs: 45000,
    port: undefined,
    dshBin: undefined,
    dshHome: undefined,
    userArgs: [],
    unquarantineIds: [],
  };
  const COMMANDS = new Set(["boot", "probe", "status", "unquarantine", "clear-quarantine"]);
  let i = 0;
  const rest = [];
  if (argv[0] && COMMANDS.has(argv[0])) {
    out.command = argv[0];
    i = 1;
  } else if (argv[0] === "web") {
    out.profile = "web";
    i = 1;
  }
  for (; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i] ?? fail("--profile needs a value");
    else if (a === "--strict") out.strict = true;
    else if (a === "--health-wait") out.healthWaitMs = Number(argv[++i]) * 1000;
    else if (a === "--dsh") out.dshBin = argv[++i];
    else if (a === "--dsh-home") out.dshHome = argv[++i];
    else rest.push(a); // everything else is forwarded to the dsh app
  }
  // Health-probe port: mirror of a forwarded `--port <n>` if present.
  const portIdx = rest.indexOf("--port");
  if (portIdx >= 0 && rest[portIdx + 1] !== undefined && /^\d+$/.test(rest[portIdx + 1])) {
    out.port = Number(rest[portIdx + 1]);
  }
  out.userArgs = rest;
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const home = opts.dshHome ?? DSH_HOME();
  const profileDir = PROFILE_DIR(home, opts.profile);
  if (!existsSync(profileDir)) fail(`profile dir not found: ${profileDir}`);
  const paths = statePaths(home, opts.profile);
  const state = loadState(paths) ?? {};

  if (opts.command === "status") {
    console.log(`profile: ${opts.profile}`);
    console.log(`home:    ${home}`);
    const q = quarantineMap(state);
    console.log(`quarantine: ${Object.keys(q).length} entry(ies)`);
    for (const [id, info] of Object.entries(q)) {
      console.log(`  - ${id} (${info.name ?? "?"}): ${String(info.reason ?? "").replace(/\n/g, " ")}`);
    }
    console.log(`health: ${state.healthy === true ? "healthy (last boot OK)" : "not confirmed"}`);
    if (state.safeModeEntered) console.log("safe mode: was entered once");
    return;
  }

  if (opts.command === "unquarantine" || opts.command === "clear-quarantine") {
    const q = quarantineMap(state);
    const ids = opts.command === "clear-quarantine" ? Object.keys(q) : opts.userArgs;
    if (ids.length === 0) {
      console.log("nothing to unquarantine (quarantine is empty).");
      return;
    }
    for (const id of ids) {
      if (q[id]) {
        delete q[id];
        console.log(`unquarantined: ${id}`);
      } else {
        console.log(`not quarantined: ${id}`);
      }
    }
    saveState(paths, { ...state, quarantine: q });
    const text = renderOverlay(q);
    const { writeFileSync, rmSync } = await import("node:fs");
    if (text) writeFileSync(paths.overlayFile, text, "utf8");
    else rmSync(paths.overlayFile, { force: true });
    console.log("overlay updated. The change takes effect on the next dsh-safe boot.");
    return;
  }

  if (opts.command === "probe") {
    const entries = userEntriesFor(profileDir, home);
    const { duplicateIds } = await import("./lib/entries.mjs");
    const dups = duplicateIds(entries);
    if (dups.length > 0) {
      console.error(`FATAL: duplicate entry ids in user patch layers: ${dups.join(", ")}`);
      console.error("Fix cordis.patch.yml (and $DSH_HOME/cordis.patch.yml) to make ids unique.");
      process.exit(3);
    }
    const results = await probeEntries(probedEntries(entries), { baseDir: profileDir });
    let brokenCount = 0;
    for (const result of results) {
      if (result.ok) {
        console.log(`ok      ${result.entry.id} (${result.entry.name})`);
      } else {
        brokenCount += 1;
        console.log(`BROKEN  ${result.entry.id} (${result.entry.name}): ${result.error?.name}: ${String(result.error?.message ?? "").replace(/\s+/g, " ")}`);
      }
    }
    console.log(`${results.length} probed, ${brokenCount} broken`);
    return;
  }

  // boot (default)
  const dshBin = await resolveDshBin(profileDir, opts.dshBin);
  const result = await runBoot({
    dshBin,
    profile: opts.profile,
    dshHome: home,
    profileDir,
    userArgs: opts.userArgs,
    healthWaitMs: opts.healthWaitMs,
    port: opts.port,
    strict: opts.strict,
    onLog: (line) => console.log(`[dsh-safe] ${line}`),
  });
  if (result.spawnError) process.exit(1);
  if (result.duplicateIds) process.exit(3);
  if (result.strictRefused) process.exit(1);
  if (result.exitCode !== null && result.exitCode !== 0) process.exit(result.exitCode);
}

await main();
