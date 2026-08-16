/**
 * dsh-plugin-devkit — plugin_test_boot: build an isolated DSH home, boot the
 * real host with the candidate plugin injected, probe HTTP, then clean up.
 * This is the "will a restart break?" gate — nothing touches the real profile.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dshHome, profileDir, runNode, spawnDetached, freePort, waitHttp, rmTree, copyTree, resolveDshBin,
} from "./shared.mjs";

const HOME_FILES = ["settings.yaml", ".credentials.yaml", "AGENTS.md", ".anonymous-user-id"];

/**
 * Build an isolated test home under a temp dir.
 * @returns {{ home, webDir, cleanup }}
 */
export function makeTestHome({ sourceDir, sourceName, profile = "web" } = {}) {
  const realHome = dshHome();
  const realProfile = profileDir(realHome, profile);
  const home = join(tmpdir(), `dsh-devkit-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const webDir = profileDir(home, profile);
  mkdirSync(webDir, { recursive: true });

  // profile files
  for (const file of ["cordis.patch.yml", "package.json", "pnpm-workspace.yaml"]) {
    const src = join(realProfile, file);
    if (existsSync(src)) copyFileSync(src, join(webDir, file));
  }
  // plugins tree (skips node_modules junctions by design)
  const pluginsSrc = join(realProfile, "plugins");
  if (existsSync(pluginsSrc)) copyTree(pluginsSrc, join(webDir, "plugins"));
  // junction node_modules so pnpm-managed links resolve
  const realNm = join(realProfile, "node_modules");
  if (existsSync(realNm)) {
    try { symlinkSync(realNm, join(webDir, "node_modules"), "junction"); } catch { /* best effort */ }
  }
  // junction the healed fallback ($DSH_HOME/profiles/node_modules) so package
  // resolution (including the dsh CLI itself) works exactly like the real home
  const realFallback = join(realHome, "profiles", "node_modules");
  if (existsSync(realFallback)) {
    try {
      symlinkSync(realFallback, join(home, "profiles", "node_modules"), "junction");
    } catch { /* best effort */ }
  }
  // home files (credentials etc.)
  for (const file of HOME_FILES) {
    const src = join(realHome, file);
    if (existsSync(src)) copyFileSync(src, join(home, file));
  }

  // inject the candidate plugin
  if (sourceDir && sourceName) {
    const pluginsDest = join(webDir, "plugins", sourceName);
    copyTree(sourceDir, pluginsDest);
    const patchPath = join(webDir, "cordis.patch.yml");
    const patch = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "- insert: []\n";
    // If the entry id already exists (candidate already installed in the real
    // profile), inject under a suffixed id to keep the patch valid.
    const already = new RegExp(`id:\\s*${sourceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(patch);
    const entryId = already ? `${sourceName}-inject` : sourceName;
    const entry = `
    # test-boot injection: ${sourceName}
    - id: ${entryId}
      name: './plugins/${sourceName}/lib/index.js'`;
    writeFileSync(patchPath, patch + entry + "\n", "utf8");
  }

  const cleanup = () => rmTree(home);
  return { home, webDir, cleanup };
}

/**
 * Boot the real host against an isolated home and wait for HTTP.
 * @returns { booted, port, httpOk, stdoutTail }
 */
export async function testBoot({ sourceDir, sourceName, profile = "web", port: wantedPort, dshBin, healthWaitMs = 20000, outputFile } = {}) {
  const { home, webDir, cleanup } = makeTestHome({ sourceDir, sourceName, profile });
  try {
    const bin = resolveDshBin(webDir, dshBin);
    const port = wantedPort ?? (await freePort());
    const env = { ...process.env, DSH_HOME: home };
    for (const key of ["DSH_SESSION_ID", "DSH_SESSION_JSONL", "DSH_WEB_URL"]) delete env[key];
    const child = outputFile
      ? spawn(process.execPath, [bin, "--profile", profile, "--port", String(port)], {
          env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawnDetached(process.execPath, [bin, "--profile", profile, "--port", String(port)], { env });
    if (outputFile) {
      const { createWriteStream } = await import("node:fs");
      const stream = createWriteStream(outputFile, { flags: "a" });
      child.stdout.pipe(stream);
      child.stderr.pipe(stream);
    }
    const httpOk = await waitHttp(port, { attempts: 80, delayMs: 1500 });
    let exitedEarly = child.exitCode !== null;
    if (httpOk && healthWaitMs > 0) {
      // keep it alive briefly to prove it survives the boot window
      await new Promise((r) => setTimeout(r, Math.min(healthWaitMs, 8000)));
      exitedEarly = child.exitCode !== null;
    }
    const alive = child.exitCode === null;
    const pid = child.pid ?? null;
    try { child.kill(); } catch { /* already gone */ }
    // give the process a moment to die, then clean the temp home
    await new Promise((r) => setTimeout(r, 1500));
    return {
      booted: alive || httpOk,
      httpOk,
      alive,
      exitedEarly,
      port,
      pid,
      home,
    };
  } finally {
    cleanup();
  }
}
