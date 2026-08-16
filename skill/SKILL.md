---
name: dsh-plugin-safe-development
description: 安全开发与安装 DSH 插件的强制流程：检查 → 隔离测试启动 → 备份 → 安装 → 隔离/安全模式止血。任何插件（含语法错误）都不得让 DSH 起不来。Use this skill whenever developing, modifying, or installing a DSH plugin.
---

# DSH 插件安全开发

## 为什么必须这样做（机制背景）

DSH 的加载器（`cordis-plugin-loader`）并行创建全部插件条目，**任何一条失败即回滚整个启动**：
单个 `SyntaxError` 就会让 `dsh web` 起不来（已实证）。条目并行加载，宿主内部的守卫插件无法
先于坏条目运行——**保障只能在宿主外部**。因此本技能的所有流程都围绕"不触碰真实 profile、
先验证、可回滚"展开。

## 铁律（永远遵守，无例外）

1. **开发在工作区/临时目录**，绝不直接在 `~/.dsh/profiles/<profile>/plugins/` 里写插件代码。
2. **装前必查**：`plugin_check`（语法 + 子进程导入探针）。
3. **装前必启动测试**：`plugin_test_boot`（隔离 DSH_HOME 完整启动 + HTTP 探活）。
4. **装前必备份**：`plugin_backup`（快照 + RESTORE.ps1）。
5. **只通过 `plugin_install` 安装**：它自动执行 备份→检查→隔离启动→接线（复制 +
   junction + package.json + cordis.patch.yml）→ dump-config 验证。
6. **绝不手工编辑 `cordis.patch.yml`/复制插件进 profile**，除非走完上述流程。
7. 插件代码本身要防御：`apply()` 内所有注册用 try/catch 包裹（重名降级为警告）；
   `systemPrompt.section` 的 name 用 `ctx.fiber?.entry?.id` 后缀保持实例唯一；
   副作用（定时器/子进程/注册表）必须在 dispose 时清理。
8. 同一个插件**不要装两份**（工具与 prompt section 重名会炸启动）。

## 标准流水线

```
plugin_new <name> [--kind host|client|both]     # 生成合规骨架（如需要）
→ 实现 lib/index.js 的 apply(ctx)
→ plugin_check <dir>                            # 语法 + 导入探针
→ plugin_test_boot (sourceDir, sourceName)      # 隔离 home 完整启动
→ plugin_backup                                 # 真实 profile 快照
→ plugin_install <name> <sourceDir>             # 安全安装 + 验证
→ 重启宿主生效（plugin_install 会提示）
```

## 出问题时的止血

- 宿主启动失败（插件导入错误/运行期崩溃）：
  - 用 **`dsh-safe web`** 启动——它会预检、把坏条目隔离（`disabled: true` 覆盖层）、
    照常启动；若上次启动未健康则自动进入安全模式（全量隔离用户插件，只一次）。
  - `dsh-safe status` 查看隔离与健康状态；`dsh-safe probe` 单独预检。
- 运行时发现某插件行为异常：`plugin_quarantine add <id>`（下次 `dsh-safe` 启动禁用）；
  修复后用 `plugin_quarantine remove <id>` 或 `dsh-safe unquarantine <id>` 恢复。
- patch 文件出现重复条目 id：`dsh-safe probe` 会以退出码 3 明确报错——
  手工修 `cordis.patch.yml` 使 id 唯一（隔离层无法修复该问题）。
- 回滚：`plugin_backup` 生成的目录里有 `RESTORE.ps1`，一键恢复。

## 工具速查

| 工具 | 作用 | 何时用 |
| --- | --- | --- |
| `plugin_check` | 子进程语法检查 + 导入探针 | 任何安装/修改前 |
| `plugin_test_boot` | 隔离 home 完整启动验证 | 任何安装前 |
| `plugin_backup` | profile 快照 + 恢复脚本 | 任何安装前 |
| `plugin_new` | 合规骨架生成 | 新建插件 |
| `plugin_install` | 安全安装流水线 | 唯一允许的安装途径 |
| `plugin_quarantine` | 隔离层管理 | 出问题时止血 |
| `dsh-safe`（CLI） | 安全启动器（预检/隔离/健康握手/安全模式） | 日常启动建议用它替代 `dsh web` |
