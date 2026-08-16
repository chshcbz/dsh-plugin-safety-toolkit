#!/usr/bin/env node
/**
 * dsh-safe probe worker — spawned in a SUBPROCESS by probe.mjs.
 *
 * Resolves one plugin entry exactly like the cordis loader would (relative
 * names against the profile dir; package names resolved with the profile dir
 * as parent) and imports it. A syntax error, missing dependency, or top-level
 * throw is reported as structured JSON on stdout. The worker never touches
 * the host process.
 */

import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { join } from "node:path";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const entryName = arg("--name");
const baseDir = arg("--base");
const timeoutMs = Number(arg("--timeout") ?? "20000");

const report = (payload) => {
  console.log(JSON.stringify(payload));
  process.exit(payload.ok ? 0 : 1);
};

if (!entryName || !baseDir) {
  report({ ok: false, error: { name: "UsageError", message: "worker needs --name and --base" } });
}

const timer = setTimeout(() => {
  report({ ok: false, error: { name: "TimeoutError", message: `import probe timed out after ${timeoutMs}ms` } });
}, timeoutMs);

try {
  const basePkg = pathToFileURL(join(baseDir, "package.json")).href;
  let resolved;
  if (entryName.startsWith(".")) {
    resolved = pathToFileURL(join(baseDir, entryName)).href;
  } else {
    try {
      resolved = import.meta.resolve(entryName, basePkg);
    } catch {
      // CJS-style fallback (packages exposing only `main`).
      resolved = pathToFileURL(createRequire(basePkg).resolve(entryName)).href;
    }
  }
  const mod = await import(resolved);
  if (typeof mod?.apply !== "function") {
    report({
      ok: false,
      error: {
        name: "ShapeError",
        message: `plugin resolved at ${resolved} but exports no apply() function (exports: ${Object.keys(mod ?? {}).join(", ") || "none"})`,
      },
    });
  }
  clearTimeout(timer);
  report({ ok: true, resolved });
} catch (error) {
  clearTimeout(timer);
  report({
    ok: false,
    error: {
      name: error?.name ?? "Error",
      message: error?.message ?? String(error),
      stack: error?.stack,
    },
  });
}
