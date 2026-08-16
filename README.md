# dsh-plugin-safety-toolkit

DSH（DeepSeek Harness）插件安全开发与安装工具集：**保证任何语法/导入错误的用户插件都不会让 DSH 起不来**。

这套工具由三部分组成：

| 组件 | 作用 |
| --- | --- |
| [`dsh-safe/`](./dsh-safe) | 宿主外安全启动器：预检导入探针、隔离层、健康握手、安全模式。 |
| [`dsh-plugin-devkit/`](./dsh-plugin-devkit) | DSH 宿主插件：把安全流水线变成可调用工具 `plugin_check` / `plugin_test_boot` / `plugin_backup` / `plugin_new` / `plugin_install` / `plugin_quarantine`。 |
| [`skill/`](./skill) | 强制开发流程技能：检查 → 隔离测试启动 → 备份 → 安装 → 隔离/安全模式止血。 |

## 为什么需要它

DSH 的加载器并行创建全部插件条目，**任何一条导入失败都会回滚整个启动**（单个 `SyntaxError` 就能让 `dsh web` 起不来）。条目并行加载意味着宿主内部的守卫插件无法先于坏条目运行，因此保障只能在宿主外部实现。

本工具集的做法：

1. **子进程导入探针**：启动前，在独立 `node` 子进程中 `import()` 每个用户插件条目；语法错误、缺依赖、顶层异常都会被标记并记录。
2. **隔离层（quarantine overlay）**：坏条目生成 `disabled: true` 覆盖层，不改动你的 `cordis.patch.yml`。
3. **健康握手 + 安全模式**：上次启动未健康且无隔离时，自动一次性隔离全部用户插件，保证宿主永远能回来。
4. **安装流水线**：装前必查、必隔离启动、必备份，最后才接线；未测试代码永远不会进入真实 profile。

## 快速开始

```bash
# 1. 用安全启动器替代日常 dsh web
dsh-safe web

# 2. 只做预检
dsh-safe probe

# 3. 查看隔离/健康状态
dsh-safe status

# 4. 在 DSH 内使用插件开发工具（安装 dsh-plugin-devkit 后）
plugin_check <dir>
plugin_test_boot --sourceDir <dir> --sourceName <name>
plugin_backup
plugin_install <name> <dir>
```

详细用法见各组件 README。

## 目录结构

```text
.
├── dsh-safe/               # Node CLI，零运行时依赖
│   ├── cli.mjs             # boot / probe / status / unquarantine / clear-quarantine
│   └── lib/                # 探针、条目扫描、隔离层、状态、启动编排
├── dsh-plugin-devkit/      # DSH host 插件
│   ├── lib/                # 工具实现
│   └── test/               # 单元 + 集成测试
└── skill/                  # dsh-plugin-safe-development 技能
    └── SKILL.md
```

## 开发与测试

```bash
# dsh-safe
cd dsh-safe
node cli.mjs probe --dsh-home <isolated-home>

# dsh-plugin-devkit
cd dsh-plugin-devkit
node test/test-unit.mjs
# 集成测试会操作真实 profile，请先备份并设置 DSH_BIN：
#   $env:DSH_BIN = "/path/to/@deepseek-ai/dsh/lib/bin.js"
#   node test/test-integration.mjs
```

## 安全边界

- 所有预检在子进程中完成，探针卡死/崩溃不影响宿主。
- 隔离层只通过 `--patch` 传入，不修改用户 patch 文件。
- 安装前强制 `plugin_check` → `plugin_test_boot` → `plugin_backup`。
- `plugin_install` 会调用 `dump-config` 验证接线后才报告成功。

## License

[MIT](./LICENSE)
