# 代码审查报告：通用性与个人信息

审查范围：

- `dsh-safe`（安全启动器）
- `dsh-plugin-devkit`（安全开发工具）
- `skill/dsh-plugin-safe-development`（开发流程技能）

## 结论

**核心逻辑是通用的，适合开源发布。** 代码通过 `DSH_HOME` 环境变量、`os.homedir()`、`~/.dsh/profiles/<profile>` 等运行时方式解析路径，没有把本机文件地址写死在业务逻辑里。没有发现真实 API key / token / 密码。

但发现以下**需要清理后再发布**的内容，已在 `dsh-plugin-safety-toolkit` 副本中修复。

## 已修复（本仓库副本）

| 文件 | 问题 | 处理 |
| --- | --- | --- |
| `dsh-safe/cli.mjs` | 报错示例里写了一条本机风格绝对路径 | 改为 `/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js` |
| `dsh-plugin-devkit/lib/shared.mjs` | 同样的本机风格绝对路径示例 | 改为通用路径 |
| `dsh-plugin-devkit/test/test-integration.mjs` | 测试里硬编码 dsh bin 绝对路径 | 改为 `process.env.DSH_BIN`，未设置时自动解析 |
| `dsh-plugin-devkit/package.json` | `"private": true` 会阻止 npm publish | 已移除 |
| `dsh-safe/package.json` | `files` 包含不存在的 `bin` 目录 | 已移除 |
| `dsh-plugin-devkit/lib/index.js` | 提示文本写死 `~/.dsh/profiles/web/plugins` | 改为通用描述 |
| `skill/SKILL.md` | 铁律里写死 `web` profile | 改为 `<profile>` |

## 为什么核心逻辑是通用的

- `dsh-safe`：
  - `DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh")`
  - profile 目录 = `join(home, "profiles", profile)`
  - 状态文件在 `$DSH_HOME/dsh-safe/<profile>.*`
  - 没有写死 Windows 路径，跨平台可用。
- `dsh-plugin-devkit`：
  - 所有工具接受 `profile` 参数，默认 `web`，但没有把 `web` 写进文件系统逻辑。
  - 安装/备份/测试都基于 `dshHome()` 和 `profileDir()` 动态计算。
- 技能：
  - 只描述流程，不包含环境相关路径。

## 隔离测试结果

在清理后的副本上执行：

| 测试 | 结果 |
| --- | --- |
| `dsh-safe status`（隔离临时 home） | ✅ 通过，正常输出 profile / quarantine / health |
| `dsh-safe probe`（隔离临时 home） | ✅ 通过，`0 probed, 0 broken` |
| `plugin_test_boot`（隔离 DSH home 注入 `dsh-plugin-devkit`） | ✅ 通过，HTTP reachable: true，process alive: true |
| JS 语法检查（已修改文件） | ✅ 通过 |

> 说明：在沙箱里直接跑 `dsh-plugin-devkit` 的单元测试时，子进程 `spawn` 会被沙箱限制（EPERM），且测试目录没有安装 `@deepseek-ai/dsh-tools` 依赖；这不属于代码问题。`plugin_test_boot` 才是“能否在隔离 DSH 环境跑通”的权威验证，已通过。

## 建议发布前再跑一遍

```bash
# 在准备发布的目录里
grep -RniE "C:\\\\Users|D:/|F:/|/home/|/Users/|node_global" .
grep -RniE "sk-[A-Za-z0-9]{20,}|api[_-]?key|secret|BEGIN (RSA|OPENSSH|PRIVATE)" .
```

确认没有真实个人信息后，再按 `docs/PUBLISH.md` 发布。
