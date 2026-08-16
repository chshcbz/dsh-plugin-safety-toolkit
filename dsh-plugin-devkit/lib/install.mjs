/**
 * dsh-plugin-devkit — plugin_backup / plugin_install / plugin_quarantine.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  dshHome, profileDir, copyTree, writeJson, appendPatchEntry, renderSimpleConfig, rmTree, runNode, resolveDshBin,
} from "./shared.mjs";

/* ---------------- backup ---------------- */

export function backupProfile({ profile = "web", destRoot, home = dshHome() } = {}) {
  const realProfile = profileDir(home, profile);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dest = join(destRoot ?? join(home, "dsh-backups"), `${profile}-profile-${stamp}`);
  mkdirSync(dest, { recursive: true });
  for (const file of ["cordis.yml", "cordis.patch.yml", "package.json", "pnpm-workspace.yaml"]) {
    const src = join(realProfile, file);
    if (existsSync(src)) copyFileSync(src, join(dest, file));
  }
  const pluginsSrc = join(realProfile, "plugins");
  if (existsSync(pluginsSrc)) copyTree(pluginsSrc, join(dest, "plugins"));
  const restore = [
    "# Restore this DSH profile backup.",
    "$ErrorActionPreference = 'Stop'",
    `$profile = Join-Path $env:USERPROFILE '.dsh\\profiles\\${profile}'`,
    "foreach ($f in @('cordis.yml','cordis.patch.yml','package.json','pnpm-workspace.yaml')) {",
    "  $src = Join-Path $PSScriptRoot $f",
    "  if (Test-Path $src) { Copy-Item $src (Join-Path $profile $f) -Force; Write-Host \"restored $f\" }",
    "}",
    "if (Test-Path (Join-Path $PSScriptRoot 'plugins')) {",
    "  $dst = Join-Path $profile 'plugins'",
    "  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }",
    "  Copy-Item (Join-Path $PSScriptRoot 'plugins') $dst -Recurse -Force",
    "  Write-Host 'restored plugins/'",
    "}",
    "Write-Host 'Restore complete. Restart dsh web for it to take effect.'",
  ].join("\n");
  writeFileSync(join(dest, "RESTORE.ps1"), restore + "\n", "utf8");
  writeFileSync(join(dest, "MANIFEST.txt"), `backup of dsh profile '${profile}' created ${new Date().toISOString()}\n`, "utf8");
  return dest;
}

/* ---------------- install ---------------- */

/**
 * Install a plugin into the real profile: copy package + junction + package.json
 * dependency + cordis.patch.yml entry. The caller MUST have run check + test-boot
 * first; this function only performs the file wiring (and a dump-config verify).
 */
export async function installPlugin({ name, sourceDir, profile = "web", config = null, home = dshHome(), dshBin, logger = () => {} } = {}) {
  const realProfile = profileDir(home, profile);
  const pluginDest = join(realProfile, "plugins", name);
  if (existsSync(pluginDest)) throw new Error(`plugin dir already exists: ${pluginDest}`);
  copyTree(sourceDir, pluginDest);
  logger(`copied ${sourceDir} -> ${pluginDest}`);

  // junction
  const nm = join(realProfile, "node_modules");
  mkdirSync(nm, { recursive: true });
  const link = join(nm, name);
  if (!existsSync(link)) symlinkSync(pluginDest, link, "junction");
  logger(`junction: ${link}`);

  // package.json dependency
  const manifestPath = join(realProfile, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dependencies ??= {};
  manifest.dependencies[name] = `file:plugins/${name}`;
  writeJson(manifestPath, manifest);
  logger(`package.json dependency added`);

  // cordis.patch.yml entry
  const patchPath = join(realProfile, "cordis.patch.yml");
  const configYaml = renderSimpleConfig(config);
  const entry = [
    "",
    `    # ${name} — installed by dsh-plugin-devkit on ${new Date().toISOString()}`,
    `    - id: ${name}`,
    `      name: '${name}'`,
    ...(configYaml ? ["      config:", configYaml] : []),
  ].join("\n");
  appendPatchEntry(patchPath, entry);
  logger(`cordis.patch.yml entry added`);

  // verify composition
  let dump = null;
  let dumpError = null;
  try {
    const resolved = dshBin ?? resolveDshBin(realProfile, undefined);
    const { stdout } = await runNode([resolved, "--profile", profile, "--dump-config"], { env: { DSH_HOME: home }, timeoutMs: 60000 });
    dump = stdout;
  } catch (error) {
    dumpError = String(error.message ?? error);
  }
  const inDump = dump !== null && new RegExp(`id: ${name}`).test(dump);
  return { pluginDest, link, manifestPath, patchPath, dumpOk: inDump, dumpError };
}

export function uninstallPlugin({ name, profile = "web", home = dshHome() } = {}) {
  const realProfile = profileDir(home, profile);
  const pluginDest = join(realProfile, "plugins", name);
  const link = join(realProfile, "node_modules", name);
  if (existsSync(link)) rmTree(link);
  if (existsSync(pluginDest)) rmTree(pluginDest);
  const manifestPath = join(realProfile, "package.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.dependencies?.[name]) {
      delete manifest.dependencies[name];
      writeJson(manifestPath, manifest);
    }
  }
  return { removed: true };
}

/* ---------------- quarantine (dsh-safe state) ---------------- */

export function quarantinePaths({ profile = "web", home = dshHome() } = {}) {
  const dir = join(home, "dsh-safe");
  return {
    dir,
    stateFile: join(dir, `${profile}.state.json`),
    overlayFile: join(dir, `${profile}.quarantine.yml`),
  };
}

export function quarantineList({ profile = "web", home = dshHome() } = {}) {
  const paths = quarantinePaths({ profile, home });
  try {
    const state = JSON.parse(readFileSync(paths.stateFile, "utf8"));
    return state?.quarantine && typeof state.quarantine === "object" ? state.quarantine : {};
  } catch {
    return {};
  }
}

export function quarantineSet({ profile = "web", home = dshHome() }, ids, reason = "quarantined by dsh-plugin-devkit") {
  const paths = quarantinePaths({ profile, home });
  const state = (() => {
    try { return JSON.parse(readFileSync(paths.stateFile, "utf8")); } catch { return {}; }
  })();
  state.quarantine ??= {};
  for (const id of ids) {
    state.quarantine[id] = { name: null, reason, at: new Date().toISOString() };
  }
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
  regenerateOverlay(paths, state);
  return state.quarantine;
}

export function quarantineRemove({ profile = "web", home = dshHome() }, ids) {
  const paths = quarantinePaths({ profile, home });
  const state = (() => {
    try { return JSON.parse(readFileSync(paths.stateFile, "utf8")); } catch { return {}; }
  })();
  state.quarantine ??= {};
  for (const id of ids) delete state.quarantine[id];
  writeFileSync(paths.stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
  regenerateOverlay(paths, state);
  return state.quarantine;
}

function regenerateOverlay(paths, state) {
  const entries = Object.entries(state.quarantine ?? {});
  if (entries.length === 0) {
    rmSync(paths.overlayFile, { force: true });
    return;
  }
  const lines = [
    "# dsh-safe quarantine overlay — managed by dsh-plugin-devkit",
    "# Re-enable with the plugin_quarantine tool or: dsh-safe unquarantine <id>",
    "",
  ];
  for (const [id, info] of entries) {
    lines.push(`# reason: ${String(info?.reason ?? "unknown").replace(/\n/g, " ")}`);
    lines.push(`- id: ${id}`);
    lines.push("  disabled: true");
    lines.push("");
  }
  writeFileSync(paths.overlayFile, lines.join("\n"), "utf8");
}
