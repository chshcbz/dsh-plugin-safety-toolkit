# dsh-plugin-devkit

DSH host 插件：把「检查 → 隔离测试启动 → 备份 → 安装 → 隔离」的安全流水线变成可调用工具。

## 工具

| 工具 | 作用 |
| --- | --- |
| `plugin_check` | 语法检查 + 子进程导入探针 |
| `plugin_test_boot` | 隔离 DSH home 完整启动 + HTTP 探活 |
| `plugin_backup` | 真实 profile 快照 + RESTORE.ps1 |
| `plugin_new` | 生成合规插件骨架 |
| `plugin_install` | 安全安装流水线（备份→检查→隔离启动→接线→dump-config 验证） |
| `plugin_quarantine` | 管理 dsh-safe 隔离层 |

## 安装到 DSH profile

```bash
# 官方装配（推荐）
dsh plugin --profile web add ./dsh-plugin-devkit

# 或使用你常用的运行时注入方式
dev_inject_plugin "/path/to/dsh-plugin-devkit"
```

## 使用

```bash
plugin_check /path/to/my-plugin
plugin_test_boot --sourceDir /path/to/my-plugin --sourceName my-plugin
plugin_backup
plugin_install my-plugin /path/to/my-plugin
```

## 测试

```bash
node test/test-unit.mjs

# 集成测试会操作真实 profile，请先备份并设置 DSH_BIN
$env:DSH_BIN = "/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js"
node test/test-integration.mjs
```

## License

MIT
