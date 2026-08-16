/**
 * dsh-plugin-devkit — shared helpers. All host-side; subprocesses isolate
 * anything risky from the running DSH host.
 */

import { execFile, spawn } from "node:child_process";
import {
  readFileSync, writeFileSync, existsSync, unlinkSync, rmSync, mkdirSync,
  readdirSync, statSync, symlinkSync, copyFileSync, readlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import net from "node:net";
import { homedir } from "node:os";

export const dshHome = () => process.env.DSH_HOME ?? join(homedir(), ".dsh");
export const profileDir = (home, profile) => join(home, "profiles", profile);

export function runNode(args, { cwd, env, timeoutMs = 120000, input } = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, {
      cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
      env: { ...process.env, ...env },
      input,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

export function spawnDetached(program, args, { env, cwd } = {}) {
  return spawn(program, args, {
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, ...env },
    cwd,
  });
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export async function waitHttp(port, { attempts = 80, delayMs = 1500 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2500) });
      if (res.status >= 200 && res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

/** Resolve the dsh CLI bin.js the same way dsh-safe does. */
export function resolveDshBin(profileDirPath, explicit) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`--dsh path not found: ${explicit}`);
    return explicit;
  }
  try {
    const require = createRequire(join(profileDirPath, "package.json"));
    const resolved = require.resolve("@deepseek-ai/dsh/lib/bin.js");
    if (existsSync(resolved)) return resolved;
  } catch {
    /* fall through */
  }
  throw new Error(
    "cannot locate the dsh CLI. Pass dshBin explicitly, e.g. " +
    "/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js"
  );
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/**
 * Recursively remove a tree that may contain junctions (e.g. node_modules).
 * Junctions are unlinked explicitly FIRST so their targets are never touched.
 */
export function rmTree(root) {
  if (!existsSync(root)) return;
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        try { unlinkSync(full); } catch { /* already gone */ }
      } else if (entry.isDirectory()) {
        visit(full);
      } else {
        try { unlinkSync(full); } catch { /* already gone */ }
      }
    }
    rmSync(dir, { recursive: true, force: true });
  };
  visit(root);
}

/** Copy a directory tree, skipping node_modules and junctions. */
export function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
}

/** Append a patch entry block to a cordis.patch.yml-style file. */
export function appendPatchEntry(patchPath, entry) {
  const text = readFileSync(patchPath, "utf8");
  const block = (text.endsWith("\n") ? "" : "\n") + entry + "\n";
  writeFileSync(patchPath, text + block, "utf8");
}

/** Simple YAML emission for a flat/one-level-deep string-map config. */
export function renderSimpleConfig(config) {
  if (!config || typeof config !== "object") return "";
  const lines = [];
  const pushScalar = (key, value) => {
    if (typeof value === "string") return `${key}: '${String(value).replace(/'/g, "''")}'`;
    return `${key}: ${String(value)}`;
  };
  for (const [key, value] of Object.entries(config)) {
    if (Array.isArray(value)) {
      lines.push(`        ${key}:`);
      for (const item of value) lines.push(`          - ${String(item)}`);
    } else if (value && typeof value === "object") {
      lines.push(`        ${key}:`);
      for (const [k2, v2] of Object.entries(value)) lines.push(`          ${pushScalar(k2, v2)}`);
    } else {
      lines.push(`        ${pushScalar(key, value)}`);
    }
  }
  return lines.join("\n");
}
