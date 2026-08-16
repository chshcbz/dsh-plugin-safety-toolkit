/**
 * dsh-safe — user-layer entry extraction.
 *
 * Reads the profile's own patch layer(s) with a minimal scanner for the
 * restricted cordis patch shape: top-level `- id:` entries and `- insert:`
 * child entries, each carrying optional `name:` / `disabled:` fields. Bundle
 * layers are trusted and never scanned.
 *
 * Returns [{ id, name, disabled }].
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export function scanPatchEntries(text, source) {
  const entries = [];
  let current = null; // { indent, id, name, disabled }
  for (const raw of String(text).replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "  ");
    const content = stripComment(line);
    if (content.trim() === "") continue;
    const indent = content.length - content.trimStart().length;
    const trimmed = content.trimStart();

    let m = trimmed.match(/^- id:\s*(.+)$/);
    if (m) {
      push(entries, current, source);
      current = { indent, id: unquote(m[1]), name: undefined, disabled: false };
      continue;
    }
    m = trimmed.match(/^name:\s*(.+)$/);
    if (m && current && indent > current.indent) {
      current.name = unquote(m[1]);
      continue;
    }
    m = trimmed.match(/^disabled:\s*(.+)$/);
    if (m && current && indent > current.indent) {
      current.disabled = m[1].trim() === "true";
      continue;
    }
  }
  push(entries, current, source);
  return entries;
}

function push(entries, current, source) {
  if (current) {
    entries.push({
      id: current.id,
      name: current.name ?? null,
      disabled: Boolean(current.disabled),
      source,
    });
  }
}

export function userEntriesFor(profileDir, homeDir) {
  const entries = [];
  const files = [
    { path: join(profileDir, "cordis.patch.yml"), source: "profile" },
    { path: join(homeDir, "cordis.patch.yml"), source: "home" },
  ];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file.path, "utf8");
    } catch {
      continue; // patch file absent — fine
    }
    entries.push(...scanPatchEntries(text, file.source));
  }
  return entries;
}

export function probedEntries(entries) {
  return entries.filter((entry) => entry.name && !entry.disabled);
}

/**
 * Duplicate entry ids inside the USER patch layers are a hard loader error
 * (the quarantine overlay cannot fix them). Return the duplicated ids.
 */
export function duplicateIds(entries) {
  const seen = new Set();
  const duplicates = new Set();
  for (const entry of entries) {
    if (seen.has(entry.id)) duplicates.add(entry.id);
    seen.add(entry.id);
  }
  return [...duplicates];
}

/** Strip a YAML comment, honoring single/double quotes loosely. */
function stripComment(line) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (ch === "#" && !inS && !inD && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(value) {
  const v = value.trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return v.slice(1, -1);
  }
  return v;
}
