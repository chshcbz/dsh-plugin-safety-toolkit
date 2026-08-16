# dsh-safe

DSH 安全启动保障器：**保证任何语法/导入错误的用户插件都不会让 DSH 起不来**。

## 问题

DSH 的加载器（`cordis-plugin-loader`）用 `Promise.allSettled` 并行创建全部插件条目，
**任何一条导入失败都会抛错并回滚整个启动**（已实证：单个 `SyntaxError` → `plugin tree failed to load` → 进程退出）。
且条目并行加载，宿主内部的守卫插件不可能先于坏条目运行——因此保障只能在**宿主外部**实现。

## 原理（三件套）

1. **子进程导入探针（probe）**：启动前，对 profile 用户层每个插件条目，在独立 `node` 子进程中
   `import()` 其包（相对名按 profile 目录解析，包名按 healed fallback 解析，与加载器一致）。
   语法错误/缺依赖/顶层异常 → 标记 broken 并记录原因。子进程隔离：探针卡死/崩溃都不碰宿主。
2. **隔离层（quarantine overlay）**：broken 条目生成 `$DSH_HOME/dsh-safe/<profile>.quarantine.yml`
   （`- id: X` + `disabled: true` + 原因注释），以 `dsh --profile <p> --patch <overlay>` 传入，
   按 id 禁用坏条目，**不改动** `cordis.patch.yml`。
3. **健康握手 + 安全模式（health/safe mode）**：启动后若进程存活超过 `--health-wait`（默认 45s）
   且（已知端口时）HTTP 应答 → 写 `healthy` 标记。下次启动若上次**未**健康且无隔离层 →
   **安全模式**：一次性隔离全部用户插件并照常启动（只触发一次），保证宿主永远能回来。

Bundle 层（`@deepseek-ai/*`）永远信任不探；已 `disabled` 条目跳过；状态文件带 BOM 容忍。

## 安装与用法

```
dsh-safe web [dsh 参数...]      # 安全启动 web profile（推荐日常用它替代 dsh web）
dsh-safe probe                  # 只跑预检并报告
dsh-safe status                 # 查看隔离层与健康状态
dsh-safe unquarantine <id>      # 修复插件后解除隔离
dsh-safe clear-quarantine       # 解除全部隔离（危险）
```

选项：`--profile <name>`（默认 web）、`--strict`（有坏插件拒绝启动）、
`--health-wait <秒>`、`--dsh <bin.js 路径>`、`--dsh-home <路径>`。

shim：`~/.dsh/bin/dsh-safe.ps1` / `dsh-safe.cmd`（包装 `~/.dsh/bin/dsh-safe/cli.mjs`）。

## 测试

- 建议使用 `dsh-safe probe` 在隔离的 `--dsh-home` 上验证探针逻辑。
- 本仓库快照暂未附带 `test/` 目录；完整测试位于原始开发仓库。

## 布局

```
cli.mjs           入口（boot/probe/status/unquarantine/clear-quarantine）
lib/worker.mjs    子进程导入探针（由 probe 派生）
lib/probe.mjs     探针调度（超时/收集）
lib/entries.mjs   用户层条目扫描（cordis.patch.yml + home patch）
lib/overlay.mjs   隔离层生成/解析
lib/state.mjs     状态与健康标记（BOM 容忍）
lib/run.mjs       启动编排（纯决策函数可单测）
```
