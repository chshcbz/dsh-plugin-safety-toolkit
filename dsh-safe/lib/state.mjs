/**
 * dsh-safe — state file management (health handshake + quarantine registry).
 * All dsh-safe runtime state lives under $DSH_HOME/dsh-safe/<profile>.*.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function statePaths(dshHome, profile) {
  const dir = join(dshHome, "dsh-safe");
  return {
    dir,
    stateFile: join(dir, `${profile}.state.json`),
    overlayFile: join(dir, `${profile}.quarantine.yml`),
    logFile: join(dir, `${profile}.log`),
  };
}

export function loadState(paths) {
  try {
    const raw = readFileSync(paths.stateFile, "utf8");
    const parsed = JSON.parse(stripBom(raw));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Strip a UTF-8 BOM (PowerShell/notepad hand-edits often add one). */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function saveState(paths, state) {
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.stateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** Quarantine registry: { id: { name, reason, at } }. */
export function quarantineMap(state) {
  const q = state?.quarantine;
  return q && typeof q === "object" && !Array.isArray(q) ? q : {};
}

export function hasQuarantine(state) {
  return Object.keys(quarantineMap(state)).length > 0;
}

export function appendLog(paths, line) {
  try {
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.logFile, `${new Date().toISOString()} ${line}\n`, { flag: "a" });
  } catch {
    /* logging must never break the launcher */
  }
}

export function readLogTail(paths, maxLines = 40) {
  try {
    if (!existsSync(paths.logFile)) return "";
    const lines = readFileSync(paths.logFile, "utf8").split(/\r?\n/);
    return lines.slice(-maxLines).join("\n");
  } catch {
    return "";
  }
}
