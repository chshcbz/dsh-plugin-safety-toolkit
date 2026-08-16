/**
 * dsh-plugin-devkit — DSH host plugin entry.
 *
 * Registers the safe plugin-development toolchain:
 *   plugin_check, plugin_test_boot, plugin_backup, plugin_new,
 *   plugin_install, plugin_quarantine
 *
 * The philosophy: generation is only scaffolding — verification (syntax +
 * subprocess import probe), isolated test boot, backup, and only then
 * installation into the real profile. Nothing ever installs untested code.
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { join } from "node:path";
import { checkPlugin } from "./check.mjs";
import { testBoot } from "./testboot.mjs";
import { backupProfile, installPlugin, quarantineList, quarantineSet, quarantineRemove } from "./install.mjs";
import { generateSkeleton } from "./skeleton.mjs";
import { dshHome } from "./shared.mjs";

export const name = "plugin-devkit";

export const inject = ["tools", "systemPrompt"];

export const Config = z.object({
  dshBin: z.string().default(""),
  dshSafeDir: z.string().default(""),
  backupRoot: z.string().default(""),
});

const DEFAULTS = {
  dshBin: "",
  dshSafeDir: "",
  backupRoot: "",
};

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const logger = ctx.logger ?? console;
  const dshSafeDir = cfg.dshSafeDir || join(dshHome(), "bin", "dsh-safe");
  const backupRoot = cfg.backupRoot || join(dshHome(), "dsh-backups");
  const entryId = ctx.fiber?.entry?.id ?? "plugin-devkit";

  console.log(`[plugin-devkit] plugin loaded (entry ${entryId})`);

  ctx.systemPrompt.section({
    name: `tool:plugin-devkit:${entryId}`,
    order: 220,
    text: "When developing or installing DSH plugins, always follow the safe pipeline: " +
      "plugin_check (syntax + import probe) → plugin_test_boot (isolated full boot) → " +
      "plugin_backup (snapshot of the real profile) → plugin_install (wires the plugin in). " +
      "Never copy plugin code directly into your DSH profile's plugins/ directory or edit cordis.patch.yml by hand " +
      "before those gates pass. If a plugin ever breaks the host, use dsh-safe to boot with " +
      "quarantine and plugin_quarantine to manage the disabled entries.",
  });

  const register = (definition) => {
    try {
      ctx.tools.register(definition);
    } catch (error) {
      // A duplicate tool name (e.g. the same plugin installed twice) must
      // degrade to a warning, never crash the host boot.
      logger.warn?.(`[plugin-devkit] tool "${definition.name}" already registered — skipping (${error.message})`);
    }
  };

  /* ---------------- plugin_check ---------------- */
  register(defineTool({
    name: "plugin_check",
    description: "Syntax-check and import-probe a plugin package directory in subprocesses. Returns a report; the host is never started and never touched. Use before any install.",
    parameters: {
      dir: { type: "string", required: true, description: "Absolute path to the plugin package directory (must contain package.json)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string", required: true } },
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const result = await checkPlugin(args.dir, { dshSafeDir });
        const lines = [`plugin_check ${args.dir}`, `source files checked: ${result.sourceFiles ?? 0}`];
        if (result.issues.length === 0) lines.push("RESULT: PASS — syntax and import probe OK");
        else {
          lines.push(`RESULT: FAIL (${result.issues.length} issue(s))`);
          for (const issue of result.issues) {
            lines.push(`  - [${issue.stage}] ${issue.file ?? ""} ${issue.error}`);
          }
        }
        if (result.probe) {
          lines.push(result.probe.ok
            ? `  import probe: OK${result.probe.resolved ? ` (${result.probe.resolved})` : ""}`
            : `  import probe: FAIL — ${result.probe.error?.name}: ${String(result.probe.error?.message ?? "")}`);
        }
        return { text: lines.join("\n") };
      } catch (error) {
        return { text: `plugin_check failed: ${error.message}` };
      }
    },
    presentCall: (args) => ({ card: "generic", title: `plugin_check ${args.dir}` }),
    presentResult: (_args, result) => ({ card: "generic", title: "plugin_check", text: result.text }),
  }));

  /* ---------------- plugin_test_boot ---------------- */
  register(defineTool({
    name: "plugin_test_boot",
    description: "Build an isolated DSH home (copy of the real profile + the candidate plugin injected), boot the real dsh host against it, probe HTTP, then tear everything down. This is the definitive 'will a restart break?' test — the real profile is never touched.",
    parameters: {
      sourceDir: { type: "string", description: "Candidate plugin package directory to inject (optional)." },
      sourceName: { type: "string", description: "Entry id/name for the injected plugin (required with sourceDir)." },
      profile: { type: "string", description: "Profile name (default web)." },
      port: { type: "number", description: "Port to boot on (default: a free port)." },
      dshBin: { type: "string", description: "Path to dsh lib/bin.js (default: auto-resolved)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string", required: true } },
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const result = await testBoot({
          sourceDir: args.sourceDir || undefined,
          sourceName: args.sourceName || undefined,
          profile: args.profile || "web",
          port: args.port,
          dshBin: args.dshBin || cfg.dshBin || undefined,
        });
        const lines = [
          `plugin_test_boot (profile=${args.profile || "web"}${args.sourceDir ? `, candidate=${args.sourceDir}` : ""})`,
          `  booted on port ${result.port}`,
          `  HTTP reachable: ${result.httpOk}`,
          `  process alive at probe: ${result.alive}`,
          `  exited early: ${result.exitedEarly}`,
          result.httpOk ? "RESULT: PASS — isolated host booted and answered HTTP" : "RESULT: FAIL — host did not answer HTTP",
        ];
        return { text: lines.join("\n") };
      } catch (error) {
        return { text: `plugin_test_boot failed: ${error.message}` };
      }
    },
    presentCall: (args) => ({ card: "generic", title: "plugin_test_boot" }),
    presentResult: (_args, result) => ({ card: "generic", title: "plugin_test_boot", text: result.text }),
  }));

  /* ---------------- plugin_backup ---------------- */
  register(defineTool({
    name: "plugin_backup",
    description: "Snapshot the real profile (cordis.patch.yml, package.json, plugins/) into a timestamped backup directory with a RESTORE.ps1 script. Run before every install.",
    parameters: {
      profile: { type: "string", description: "Profile name (default web)." },
      destRoot: { type: "string", description: "Backup root directory (default: <DSH_HOME>/dsh-backups)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string", required: true } },
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const dest = backupProfile({ profile: args.profile || "web", destRoot: args.destRoot || backupRoot });
        return { text: `plugin_backup OK: ${dest}\n(RESTORE.ps1 included)` };
      } catch (error) {
        return { text: `plugin_backup failed: ${error.message}` };
      }
    },
    presentCall: () => ({ card: "generic", title: "plugin_backup" }),
    presentResult: (_args, result) => ({ card: "generic", title: "plugin_backup", text: result.text }),
  }));

  /* ---------------- plugin_new ---------------- */
  register(defineTool({
    name: "plugin_new",
    description: "Generate a valid DSH plugin skeleton (package.json, lib/index.js host half, optional client half) in <dir>/<name>. Scaffolding only — run plugin_check, plugin_test_boot, plugin_backup, then plugin_install.",
    parameters: {
      name: { type: "string", required: true, description: "Plugin package name (lowercase letters, digits, dashes)." },
      dir: { type: "string", required: true, description: "Parent directory for the new plugin folder." },
      kind: { type: "string", description: "host | client | both (default host)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string", required: true } },
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const target = generateSkeleton({ name: args.name, dir: args.dir, kind: args.kind || "host" });
        return { text: `plugin_new OK: ${target}\nNext: plugin_check -> plugin_test_boot -> plugin_backup -> plugin_install` };
      } catch (error) {
        return { text: `plugin_new failed: ${error.message}` };
      }
    },
    presentCall: (args) => ({ card: "generic", title: `plugin_new ${args.name}` }),
    presentResult: (_args, result) => ({ card: "generic", title: "plugin_new", text: result.text }),
  }));

  /* ---------------- plugin_install ---------------- */
  register(defineTool({
    name: "plugin_install",
    description: "SAFE INSTALL pipeline for a plugin package: (1) backup the real profile, (2) plugin_check the source, (3) plugin_test_boot with the candidate injected into an isolated home, (4) only if all pass: copy into plugins/, create the node_modules junction, add the package.json file: dependency and the cordis.patch.yml entry, then verify with dump-config. Never installs untested code.",
    parameters: {
      name: { type: "string", required: true, description: "Plugin id and package name." },
      sourceDir: { type: "string", required: true, description: "Absolute path to the plugin package directory." },
      profile: { type: "string", description: "Profile name (default web)." },
      config: { type: "string", description: "Optional JSON string with entry config values." },
      dshBin: { type: "string", description: "Path to dsh lib/bin.js (default auto-resolve)." },
      skipTestBoot: { type: "boolean", description: "DANGER: skip the isolated boot test (default false)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string", required: true } },
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const report = [];
      const step = (msg) => {
        report.push(msg);
        logger.info?.(`[plugin-devkit] ${msg}`);
      };
      try {
        step(`plugin_install ${args.name} from ${args.sourceDir}`);
        step("1/4 backup");
        const backupDest = backupProfile({ profile: args.profile || "web", destRoot: backupRoot });
        step(`  backup: ${backupDest}`);
        step("2/4 check");
        const check = await checkPlugin(args.sourceDir, { dshSafeDir });
        if (check.issues.length > 0) {
          for (const issue of check.issues) step(`  FAIL [${issue.stage}] ${issue.error}`);
          return { text: report.join("\n") + "\n\nRESULT: ABORTED — plugin_check failed" };
        }
        step("  check PASS");
        if (!args.skipTestBoot) {
          step("3/4 isolated test boot");
          const boot = await testBoot({ sourceDir: args.sourceDir, sourceName: args.name, profile: args.profile || "web", dshBin: args.dshBin || cfg.dshBin || undefined });
          step(`  boot HTTP: ${boot.httpOk} (port ${boot.port})`);
          if (!boot.httpOk) {
            return { text: report.join("\n") + "\n\nRESULT: ABORTED — isolated boot did not answer HTTP" };
          }
        } else {
          step("3/4 SKIPPED (skipTestBoot=true)");
        }
        step("4/4 wiring");
        let configObj = null;
        if (args.config) {
          try { configObj = JSON.parse(args.config); } catch { return { text: report.join("\n") + "\n\nRESULT: ABORTED — config is not valid JSON" }; }
        }
        const result = await installPlugin({ name: args.name, sourceDir: args.sourceDir, profile: args.profile || "web", config: configObj, dshBin: args.dshBin || cfg.dshBin || undefined, logger: step });
        if (!result.dumpOk) {
          return { text: report.join("\n") + `\n\nRESULT: WARNING — installed but dump-config did not show the entry (${result.dumpError ?? "?"}). Inspect before restarting.` };
        }
        step("  dump-config verified");
        return {
          text: report.join("\n") + "\n\nRESULT: PASS — plugin installed and composition verified.\nRestart the Host (dsh web) to activate it.",
        };
      } catch (error) {
        return { text: report.join("\n") + `\n\nRESULT: ERROR — ${error.message}` };
      }
    },
    presentCall: (args) => ({ card: "generic", title: `plugin_install ${args.name}` }),
    presentResult: (_args, result) => ({ card: "generic", title: "plugin_install", text: result.text }),
  }));

  /* ---------------- plugin_quarantine ---------------- */
  register(defineTool({
    name: "plugin_quarantine",
    description: "Manage the dsh-safe quarantine registry for a profile: list disabled entries, add ids to quarantine (disables them on next dsh-safe boot), remove ids (re-enable). Use when a plugin breaks the host at runtime.",
    parameters: {
      action: { type: "string", required: true, description: "list | add | remove | clear" },
      ids: { type: "string", description: "Comma-separated entry ids (for add/remove)." },
      profile: { type: "string", description: "Profile name (default web)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string", required: true } },
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const profile = args.profile || "web";
        const ids = (args.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        switch (args.action) {
          case "list": {
            const q = quarantineList({ profile });
            const lines = [`quarantine for profile '${profile}': ${Object.keys(q).length} entry(ies)`];
            for (const [id, info] of Object.entries(q)) lines.push(`  - ${id}: ${String(info?.reason ?? "unknown").replace(/\n/g, " ")}`);
            return { text: lines.join("\n") };
          }
          case "add": {
            if (ids.length === 0) return { text: "add needs ids (comma-separated)" };
            const q = quarantineSet({ profile }, ids);
            return { text: `quarantined: ${ids.join(", ")}\nActive on next dsh-safe boot: ${Object.keys(q).join(", ")}` };
          }
          case "remove": {
            if (ids.length === 0) return { text: "remove needs ids (comma-separated)" };
            const q = quarantineRemove({ profile }, ids);
            return { text: `unquarantined: ${ids.join(", ")}\nRemaining: ${Object.keys(q).join(", ") || "none"}` };
          }
          case "clear": {
            const q = quarantineList({ profile });
            const all = Object.keys(q);
            quarantineRemove({ profile }, all);
            return { text: `cleared quarantine for profile '${profile}' (${all.length} re-enabled)` };
          }
          default:
            return { text: `unknown action "${args.action}" — use list, add, remove or clear` };
        }
      } catch (error) {
        return { text: `plugin_quarantine failed: ${error.message}` };
      }
    },
    presentCall: (args) => ({ card: "generic", title: `plugin_quarantine ${args.action}` }),
    presentResult: (_args, result) => ({ card: "generic", title: "plugin_quarantine", text: result.text }),
  }));
}
