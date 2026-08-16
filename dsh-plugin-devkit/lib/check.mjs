/**
 * dsh-plugin-devkit — plugin_check: syntax check + subprocess import probe.
 * Never starts the host; everything runs in child node processes.
 */

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { runNode, dshHome } from "./shared.mjs";

const JS_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"]);

export function collectSourceFiles(dir) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.name === "test") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (JS_EXT.has(extname(entry.name))) files.push(full);
    }
  };
  visit(dir);
  return files;
}

/** Syntax-check every source file with `node --check`. */
export async function syntaxCheck(dir) {
  const files = collectSourceFiles(dir);
  const results = [];
  for (const file of files) {
    try {
      await runNode(["--check", file], { timeoutMs: 30000 });
      results.push({ file, ok: true });
    } catch (error) {
      const stderr = String(error.stderr ?? "").trim();
      const match = stderr.split(/\r?\n/).find((l) => /SyntaxError|Error:/.test(l));
      results.push({ file, ok: false, error: match ?? (stderr || error.message) });
    }
  }
  return results;
}

/** Resolve the module to import for a plugin package directory. */
export function mainModuleOf(dir) {
  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    pkg = null;
  }
  if (pkg?.main) return pkg.main;
  for (const candidate of ["lib/index.js", "index.js", "lib/index.mjs", "index.mjs"]) {
    if (existsSync(join(dir, candidate))) return candidate;
  }
  return "index.js";
}

/**
 * Import-probe one plugin package in a subprocess (dsh-safe worker).
 * @returns {ok, error?, resolved?}
 */
export async function importProbe(dir, { dshSafeDir } = {}) {
  const safeDir = dshSafeDir ?? join(dshHome(), "bin", "dsh-safe");
  const worker = join(safeDir, "lib", "worker.mjs");
  if (!existsSync(worker)) {
    // Fallback: a self-contained inline probe (no dsh-safe dependency).
    return inlineProbe(dir);
  }
  const main = mainModuleOf(dir);
  try {
    const { stdout } = await runNode([worker, "--name", `./${main}`, "--base", dir], { timeoutMs: 60000 });
    const line = stdout.trim().split(/\r?\n/).at(-1) ?? "";
    const parsed = JSON.parse(line);
    return { ok: Boolean(parsed.ok), error: parsed.error ?? null, resolved: parsed.resolved ?? null };
  } catch (error) {
    return { ok: false, error: { name: "ProbeError", message: String(error.message ?? error) } };
  }
}

async function inlineProbe(dir) {
  const main = mainModuleOf(dir);
  const code = `
    import { pathToFileURL } from "node:url";
    import { join } from "node:path";
    try {
      const mod = await import(pathToFileURL(join(process.argv[1], "${main.replace(/\\/g, "/")}")).href);
      if (typeof mod?.apply !== "function") throw new Error("exports no apply() function");
      console.log(JSON.stringify({ ok: true }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: { name: e?.name, message: e?.message } }));
      process.exit(1);
    }
  `;
  try {
    const { stdout } = await runNode(["--input-type=module", "-e", code, dir], { timeoutMs: 60000 });
    const parsed = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "");
    return { ok: Boolean(parsed.ok), error: parsed.error ?? null };
  } catch (error) {
    return { ok: false, error: { name: "ProbeError", message: String(error.message ?? error) } };
  }
}

/** Full check: syntax + import probe. */
export async function checkPlugin(dir, options = {}) {
  const issues = [];
  if (!existsSync(dir)) {
    return { ok: false, issues: [{ stage: "io", error: `directory not found: ${dir}` }], probe: null };
  }
  const stat = statSync(dir);
  if (!stat.isDirectory()) {
    return { ok: false, issues: [{ stage: "io", error: `not a directory: ${dir}` }], probe: null };
  }
  const syntax = await syntaxCheck(dir);
  for (const result of syntax) {
    if (!result.ok) issues.push({ stage: "syntax", file: result.file, error: result.error });
  }
  if (!existsSync(join(dir, "package.json"))) {
    issues.push({ stage: "manifest", error: "package.json missing" });
  }
  const probe = await importProbe(dir, options);
  if (!probe.ok) issues.push({ stage: "import", error: `${probe.error?.name ?? "Error"}: ${String(probe.error?.message ?? "")}` });
  return { ok: issues.length === 0, issues, probe, sourceFiles: syntax.length };
}
