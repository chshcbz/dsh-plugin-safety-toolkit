/**
 * dsh-safe — subprocess import probe.
 *
 * Probes each entry in a child `node lib/worker.mjs` process. A plugin whose
 * module cannot even be imported (syntax error, missing dependency) is marked
 * broken. The child process isolates the probe completely: even a hang or a
 * hard crash cannot affect the host.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_PROBE_TIMEOUT_MS = 20000;

/**
 * @param entries - [{ id, name }] entries to probe (name required).
 * @param options - { baseDir, workerPath, timeoutMs, spawnImpl, nodePath }
 * @returns [{ entry, ok, error?, resolved? }]
 */
export async function probeEntries(entries, options = {}) {
  const {
    baseDir,
    workerPath = join(MODULE_DIR, "worker.mjs"),
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    spawnImpl = spawn,
    nodePath = process.execPath,
  } = options;
  const results = [];
  for (const entry of entries) {
    if (!entry.name) continue;
    results.push(await probeOne(entry, { baseDir, workerPath, timeoutMs, spawnImpl, nodePath }));
  }
  return results;
}

function probeOne(entry, { baseDir, workerPath, timeoutMs, spawnImpl, nodePath }) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ entry, ok: false, error: { name: "TimeoutError", message: `probe timed out after ${timeoutMs}ms` } });
    }, timeoutMs + 1000);
    let child;
    try {
      child = spawnImpl(nodePath, [workerPath, "--name", entry.name, "--base", baseDir, "--timeout", String(timeoutMs)], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      clearTimeout(timer);
      resolve({ entry, ok: false, error: { name: "SpawnError", message: error.message } });
      return;
    }
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      finish({ entry, ok: false, error: { name: "SpawnError", message: error.message } });
    });
    child.on("exit", (code) => {
      const lastLine = stdout.trim().split(/\r?\n/).at(-1) ?? "";
      let parsed = null;
      try {
        parsed = JSON.parse(lastLine);
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed.ok === "boolean") {
        finish({ entry, ok: parsed.ok, error: parsed.error ?? null, resolved: parsed.resolved ?? null });
        return;
      }
      finish({
        entry,
        ok: false,
        error: {
          name: "ProbeError",
          message: `probe produced no result (exit ${code ?? "null"})${stderr ? `: ${stderr.trim().split(/\r?\n/).at(-1)}` : ""}`,
        },
      });
    });
  });
}

/** Short human-readable one-line reason from a probe error. */
export function reasonOf(probeResult) {
  const err = probeResult.error;
  if (!err) return "unknown";
  const message = String(err.message ?? "").replace(/\s+/g, " ").slice(0, 400);
  return `${err.name ?? "Error"}: ${message}`;
}
