/**
 * dsh-plugin-devkit unit tests — skeleton generation, check logic, backup,
 * quarantine management, install wiring (against scratch dirs, never the
 * real profile), and plugin module loading with a fake ctx.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSkeleton } from "../lib/skeleton.mjs";
import { checkPlugin, mainModuleOf, collectSourceFiles } from "../lib/check.mjs";
import { backupProfile } from "../lib/install.mjs";
import { quarantineList, quarantineSet, quarantineRemove } from "../lib/install.mjs";
import { rmTree } from "../lib/shared.mjs";

const TMP = mkdtempSync(join(tmpdir(), "dsh-devkit-unit-"));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));

let passed = 0;
let failed = 0;
const failures = [];
const test = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`  ok   ${name}`); })
    .catch((error) => { failed += 1; failures.push({ name, error }); console.error(`  FAIL ${name}\n       ${error?.stack ?? error}`); });

/* ---------------- skeleton ---------------- */

await test("generateSkeleton produces a valid host plugin package", () => {
  const dir = join(TMP, "skel");
  mkdirSync(dir, { recursive: true });
  const target = generateSkeleton({ name: "my-test-plugin", dir, kind: "host" });
  assert.equal(existsSync(join(target, "package.json")), true);
  assert.equal(existsSync(join(target, "lib", "index.js")), true);
  assert.equal(existsSync(join(target, "lib", "client.js")), false);
  const manifest = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
  assert.equal(manifest.name, "my-test-plugin");
  assert.equal(manifest.main, "lib/index.js");
});

await test("generateSkeleton with kind=both adds the client half", () => {
  const dir = join(TMP, "skel2");
  mkdirSync(dir, { recursive: true });
  const target = generateSkeleton({ name: "both-plugin", dir, kind: "both" });
  assert.equal(existsSync(join(target, "lib", "client.js")), true);
  const manifest = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
  assert.equal(manifest.exports["./client"], "./lib/client.js");
  assert.ok(manifest.dsh?.client, "dsh.client declaration");
});

await test("generateSkeleton rejects invalid names and existing targets", () => {
  const dir = join(TMP, "skel3");
  mkdirSync(dir, { recursive: true });
  assert.throws(() => generateSkeleton({ name: "Bad Name!", dir, kind: "host" }), /invalid plugin name/);
  generateSkeleton({ name: "dup-plugin", dir, kind: "host" });
  assert.throws(() => generateSkeleton({ name: "dup-plugin", dir, kind: "host" }), /already exists/);
});

/* ---------------- check ---------------- */

await test("checkPlugin passes a good package and fails a syntax-broken one", async () => {
  const good = join(TMP, "good");
  mkdirSync(join(good, "lib"), { recursive: true });
  writeFileSync(join(good, "package.json"), JSON.stringify({ name: "good", type: "module", main: "lib/index.js" }));
  writeFileSync(join(good, "lib", "index.js"), "export function apply() {}\n");
  const okResult = await checkPlugin(good);
  assert.equal(okResult.ok, true, JSON.stringify(okResult.issues));

  const bad = join(TMP, "bad");
  mkdirSync(join(bad, "lib"), { recursive: true });
  writeFileSync(join(bad, "package.json"), JSON.stringify({ name: "bad", type: "module", main: "lib/index.js" }));
  writeFileSync(join(bad, "lib", "index.js"), "export function apply( {\n");
  const badResult = await checkPlugin(bad);
  assert.equal(badResult.ok, false);
  assert.ok(badResult.issues.some((i) => i.stage === "syntax"), "syntax issue reported");
  assert.ok(badResult.issues.some((i) => i.stage === "import"), "import issue reported");
});

await test("checkPlugin fails on missing directory / missing package.json", async () => {
  const missing = await checkPlugin(join(TMP, "nope"));
  assert.equal(missing.ok, false);
  const noManifest = join(TMP, "nomanifest");
  mkdirSync(noManifest, { recursive: true });
  writeFileSync(join(noManifest, "index.js"), "export function apply() {}\n");
  const result = await checkPlugin(noManifest);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.stage === "manifest"));
});

await test("mainModuleOf resolves package.json main with fallbacks", () => {
  const a = join(TMP, "mma");
  mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "package.json"), JSON.stringify({ main: "src/entry.js" }));
  assert.equal(mainModuleOf(a), "src/entry.js");
  const b = join(TMP, "mmb");
  mkdirSync(join(b, "lib"), { recursive: true });
  writeFileSync(join(b, "package.json"), JSON.stringify({}));
  writeFileSync(join(b, "lib", "index.js"), "");
  assert.equal(mainModuleOf(b), "lib/index.js");
});

await test("collectSourceFiles skips node_modules and test dirs", () => {
  const dir = join(TMP, "collect");
  mkdirSync(join(dir, "lib"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "lib", "a.js"), "");
  writeFileSync(join(dir, "node_modules", "x", "b.js"), "");
  writeFileSync(join(dir, "test", "c.js"), "");
  const files = collectSourceFiles(dir);
  assert.deepEqual(files.map((f) => f.replace(/\\/g, "/").split("/").at(-1)), ["a.js"]);
});

/* ---------------- backup ---------------- */

await test("backupProfile snapshots config + plugins + RESTORE.ps1", async () => {
  const fakeHome = join(TMP, "home");
  const fakeProfile = join(fakeHome, "profiles", "web");
  mkdirSync(join(fakeProfile, "plugins", "p1"), { recursive: true });
  writeFileSync(join(fakeProfile, "cordis.patch.yml"), "- insert: []\n");
  writeFileSync(join(fakeProfile, "package.json"), "{}\n");
  writeFileSync(join(fakeProfile, "plugins", "p1", "index.js"), "");
  const dest = backupProfile({ home: fakeHome, profile: "web", destRoot: join(TMP, "bk") });
  assert.equal(existsSync(join(dest, "cordis.patch.yml")), true);
  assert.equal(existsSync(join(dest, "package.json")), true);
  assert.equal(existsSync(join(dest, "plugins", "p1", "index.js")), true);
  assert.equal(existsSync(join(dest, "RESTORE.ps1")), true);
  assert.equal(existsSync(join(dest, "MANIFEST.txt")), true);
});

/* ---------------- quarantine management ---------------- */

await test("quarantine set/list/remove round-trip", () => {
  const fakeHome = join(TMP, "qh");
  const params = { home: fakeHome, profile: "web" };
  assert.deepEqual(quarantineList(params), {});
  const q = quarantineSet(params, ["a", "b"], "unit test");
  assert.deepEqual(Object.keys(q).sort(), ["a", "b"]);
  const overlay = readFileSync(join(fakeHome, "dsh-safe", "web.quarantine.yml"), "utf8");
  assert.match(overlay, /- id: a/);
  assert.match(overlay, /disabled: true/);
  const after = quarantineRemove(params, ["a"]);
  assert.deepEqual(Object.keys(after), ["b"]);
  quarantineRemove(params, ["b"]);
  assert.equal(existsSync(join(fakeHome, "dsh-safe", "web.quarantine.yml")), false, "overlay removed when empty");
});

/* ---------------- plugin module load ---------------- */

await test("plugin module loads and apply() registers six tools", async () => {
  const plugin = await import("../lib/index.js");
  assert.equal(typeof plugin.apply, "function");
  const registered = [];
  const sections = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    effect(fn) { fn(); return () => {}; },
    tools: { register(def) { registered.push(def); } },
    systemPrompt: { section(s) { sections.push(s); } },
  };
  plugin.apply(ctx, {});
  const names = registered.map((t) => t.name).sort();
  assert.deepEqual(names, ["plugin_backup", "plugin_check", "plugin_install", "plugin_new", "plugin_quarantine", "plugin_test_boot"]);
  assert.ok(sections.some((s) => s.name.startsWith("tool:plugin-devkit")), "instance-unique prompt section");
});

const totalFailed = failed;
console.log(`\ndsh-plugin-devkit unit: ${passed} passed, ${failed} failed`);
process.exit(totalFailed > 0 ? 1 : 0);
