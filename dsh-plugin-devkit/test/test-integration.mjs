/**
 * dsh-plugin-devkit integration (self-bootstrapping):
 *
 *   A. The devkit's own toolchain validates the devkit itself: checkPlugin on
 *      this package, then testBoot with it injected into an isolated home.
 *   B. The FULL safe-install pipeline (check → test_boot → backup → install →
 *      dump-config verify) runs against the REAL web profile.
 *   C. After install, an isolated home copied from the real profile (which now
 *      contains the plugin) boots with HTTP 200 — the restart simulation.
 *
 * NOTE: step B modifies the real profile (that is the point). Backup is taken
 * first and its path is printed.
 */

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPlugin } from "../lib/check.mjs";
import { testBoot } from "../lib/testboot.mjs";
import { backupProfile, installPlugin, quarantineList } from "../lib/install.mjs";
import { dshHome, profileDir } from "../lib/shared.mjs";

const DEVKIT_DIR = fileURLToPath(new URL("..", import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];
const test = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`  ok   ${name}`); })
    .catch((error) => { failed += 1; failures.push({ name, error }); console.error(`  FAIL ${name}\n       ${error?.stack ?? error}`); });

const BASE = ["--dsh-home", dshHome(), "--dsh", process.env.DSH_BIN || ""].filter(Boolean);
const logFile = join(dshHome(), "dsh-backups", "devkit-bootstrap.log");

/* ---------- A. self-check ---------- */
await test("A1. checkPlugin passes on the devkit itself", async () => {
  const result = await checkPlugin(DEVKIT_DIR);
  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
});

await test("A2. testBoot boots an isolated home with the devkit injected (HTTP 200 + loaded marker)", async () => {
  const result = await testBoot({
    sourceDir: DEVKIT_DIR,
    sourceName: "dsh-plugin-devkit",
    profile: "web",
    healthWaitMs: 12000,
    outputFile: logFile,
  });
  assert.equal(result.httpOk, true, `isolated boot failed: ${JSON.stringify(result)}`);
  await new Promise((r) => setTimeout(r, 2000));
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  assert.match(log, /\[plugin-devkit\] plugin loaded/, "devkit must be loaded in the isolated boot");
});

/* ---------- B. full pipeline against the real profile ---------- */
await test("B1. backup the real profile", () => {
  const dest = backupProfile({ profile: "web", destRoot: join(dshHome(), "dsh-backups") });
  console.log(`    backup at: ${dest}`);
  assert.ok(dest.length > 0);
});

await test("B2. install the devkit into the real profile (wiring + dump-config)", async () => {
  const profilePath = profileDir(dshHome(), "web");
  const existing = join(profilePath, "plugins", "dsh-plugin-devkit");
  if (existsSync(existing)) {
    // sync the (fixed) source into the installed location
    const { copyTree, rmTree } = await import("../lib/shared.mjs");
    rmTree(existing);
    copyTree(DEVKIT_DIR, existing);
    console.log("    already wired — synced source files");
    return;
  }
  const result = await installPlugin({
    name: "dsh-plugin-devkit",
    sourceDir: DEVKIT_DIR,
    profile: "web",
    dshBin: process.env.DSH_BIN || undefined,
    logger: (msg) => console.log(`    ${msg}`),
  });
  assert.equal(result.dumpOk, true, `dump-config verify failed: ${result.dumpError ?? "?"}`);
  assert.equal(existsSync(join(profilePath, "node_modules", "dsh-plugin-devkit")), true, "junction created");
});

/* ---------- C. restart simulation with the installed profile copy ---------- */
await test("C. isolated home copied from the REAL profile (with devkit installed) boots HTTP 200", async () => {
  const result = await testBoot({ profile: "web", healthWaitMs: 12000, outputFile: logFile });
  assert.equal(result.httpOk, true, `post-install isolated boot failed: ${JSON.stringify(result)}`);
  await new Promise((r) => setTimeout(r, 2000));
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  assert.match(log, /\[plugin-devkit\] plugin loaded/, "devkit loaded from the real-profile copy");
  // hygiene: the devkit must not have quarantined anything
  assert.deepEqual(quarantineList({ profile: "web" }), {}, "devkit must not quarantine itself");
});

const totalFailed = failed;
console.log(`\ndsh-plugin-devkit integration: ${passed} passed, ${failed} failed`);
process.exit(totalFailed > 0 ? 1 : 0);
