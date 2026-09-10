[English](./commands.en.md) | 简体中文 | [返回 README](../README.md)

# 命令

常用创建选项：

```bash
create-maa-project [name]
create-maa-project .
create-maa-project [name] --template pipeline
create-maa-project [name] --template agent
create-maa-project [name] --slug maa-helper --name "明日方舟助手"
create-maa-project [name] --controller Adb,Win32,MacOS
create-maa-project [name] --license MIT
create-maa-project [name] --git
create-maa-project [name] --no-git
```

可用的控制目标：`Adb`、`Win32`、`MacOS`、`PlayCover`、`Gamepad`、`WlRoots`。默认为 `Adb`。

Git 初始化默认开启：目标不在已有 Git 仓库内时，创建（含 `--yes`/`--no-interactive` 和 MCP 未传 `git` 的非交互路径）会自动 `git init` 并做首次提交；`--no-git` 可显式关闭。Git 未安装或 `git init` 失败时创建仍然成功，具体原因写入 JSON report 的 `git` 字段。

增量能力：

```bash
create-maa-project --add dev-tools
create-maa-project --add vscode
create-maa-project --add github
create-maa-project --add agent
create-maa-project --add resource-pack extra --label "额外资源"
create-maa-project --add git-cliff
create-maa-project --add auto-format
create-maa-project --add optimize-images
create-maa-project --add community
create-maa-project --add dependabot
create-maa-project --add schema-sync
```

add-on 依赖会被自动补全，无需手动按顺序添加：

- `vscode`、`github`、`agent` 依赖 `dev-tools`；
- `agent` 还依赖 `vscode`（Agent 项目自带 `Maa Agent: Debug` 调试配置）；
- `git-cliff`、`auto-format`、`optimize-images`、`community`、`dependabot`、`schema-sync` 依赖 `github`（因而也依赖 `dev-tools`）。

例如 `create-maa-project --add community` 实际会启用 `dev-tools`、`github`、`community`。
人类可读输出会打印 `Add-ons required by dependencies:`，JSON report 的 `addons` 字段给出
`requested` / `enabled` / `autoEnabled`。

`vscode` 是可选的：`--add dev-tools` 只写工具链，不再写 `.vscode/`；需要编辑器集成时显式加
`--add vscode`。交互式流程中「全部」预设会包含它，而「自定义」的仓库功能列表默认不勾选它。

### dev-tools 写入的文件

`--add dev-tools` 会写入 13 个文件：

| 文件                                          | 用途                                                    | 刷新方式 |
| --------------------------------------------- | ------------------------------------------------------- | -------- |
| `.node-version`                               | 固定 Node 24                                            | managed  |
| `.prettierrc.mjs`                             | Prettier 配置（含 MaaFW 排序与多行数组插件）            | managed  |
| `.prettierignore`                             | 忽略生成的 schema baseline 等                           | once     |
| `package.json`                                | devDependencies、`engines.node >= 24`、`packageManager` | once     |
| `pnpm-workspace.yaml`                         | pnpm workspace 配置                                     | once     |
| `tools/validate-schema.mjs`                   | `check:schema` 使用的校验脚本                           | managed  |
| `tools/schema/interface.schema.json`          | 上游 MaaFW baseline（interface）                        | managed  |
| `tools/schema/interface_config.schema.json`   | 上游 MaaFW baseline（interface config）                 | managed  |
| `tools/schema/interface_import.schema.json`   | 上游 MaaFW baseline（interface import）                 | managed  |
| `tools/schema/pipeline.schema.json`           | 上游 MaaFW baseline（pipeline）                         | managed  |
| `tools/schema/schema-manifest.json`           | schema 版本清单                                         | managed  |
| `tools/schema/custom.action.schema.json`      | 自定义动作 schema，供项目自行编辑                       | once     |
| `tools/schema/custom.recognition.schema.json` | 自定义识别 schema，供项目自行编辑                       | once     |

`managed` 文件会被 `--update`（如 `--update schema`）刷新；`once` 文件只在首次创建时写入，
之后归项目所有，不会被后续命令覆盖。

### vscode 写入的文件

`--add vscode` 会写入 `.vscode/` 下的 3 个文件（Agent 项目再多 1 个 `launch.json`）。这些文件引用
dev-tools 的产物（Prettier formatter、`tools/schema/*`、`pnpm install`），因此该 add-on 依赖 dev-tools：

| 文件                      | 用途                                                      | 刷新方式 |
| ------------------------- | --------------------------------------------------------- | -------- |
| `.vscode/settings.json`   | formatOnSave、LF、jsonc 关联、schema 映射与默认 formatter | once     |
| `.vscode/extensions.json` | 推荐扩展（Prettier、MaaFW 等；Agent 追加 Pylance）        | once     |
| `.vscode/tasks.json`      | 打开项目时自动同步依赖                                    | managed  |
| `.vscode/launch.json`     | 仅 Agent 项目：`Maa Agent: Debug` 调试配置                | once     |

未启用该 add-on 时项目没有 `.vscode/`，`--doctor` 会把 `vscode-settings` 检查标记为 skipped 而不是失败。

`package.json` 中的脚本按启用的 add-on 组合：`check` 始终包含 `format:check`、`check:schema`、
`check:maa`；`github` 追加 `release:dry-run`、`sync:runtime`，`schema-sync` 追加 `sync:schema`，
`optimize-images` 追加 `optimize:images`，Agent 项目追加 `format:py`、`lint:py`、`typecheck:py`、
`check:py`。

元数据同步：

```bash
create-maa-project --sync config
create-maa-project --sync metadata
create-maa-project --sync display-name --name "新显示名"
create-maa-project --sync version --version 0.2.0
create-maa-project --sync license --license MIT
create-maa-project --sync github-url https://github.com/MaaXYZ/MaaExample
create-maa-project --sync network --network official
```

旧版 `maa-project.json` 不会在其他维护命令中被静默改写。遇到 schema v1 时，请显式运行
`create-maa-project --sync config`；迁移会进入项目备份，可用 `--restore` 回退。

更新：

```bash
create-maa-project --update schema
create-maa-project --update maafw
create-maa-project --update runtime:mfa
create-maa-project --update runtime:mxu
create-maa-project --update ocr-models
create-maa-project --update node-deps
create-maa-project --update python-deps
create-maa-project --update python-runtime
```

`--update all` 故意不支持。显式执行具体更新可以让 pending action 和日志更清楚。

### OCR 模型的两种供应方式

默认供应方式取决于创建时**本机 Git 是否可用**，这与 `--git`/`--no-git` 无关（后者只管项目是否执行 `git init`）：

| 创建时 Git | `.gitmodules` | `maa-project.json` 的 `ocr` | `resource/base/model/ocr/`              |
| ---------- | ------------- | --------------------------- | --------------------------------------- |
| 可用       | 写入          | `{"source":"submodule",…}`  | 写入 `.gitignore`（模型为派生文件）     |
| 不可用     | 不写入        | **完全没有 `ocr` 键**       | 改为提交 `manifest.json`（记录 sha256） |

因此同一个创建命令在不同机器上产出的项目**结构可能不同**，而两者的退出码与文件计数相同。可用
`CREATE_MAA_PROJECT_OCR_SOURCE=submodule` 或 `=download` 显式指定，避免依赖本机环境。

注意：Git 可用时即使传入 `--no-git`，生成的 `.gitmodules` 也会被写入（此时还没有 `.git` 目录）。
该文件是为之后的 `git init` 或手动初始化准备的子模块声明，不是错误；不想保留可以删除。

诊断和维护：

```bash
create-maa-project --doctor
create-maa-project --doctor --report
create-maa-project --list-backups
create-maa-project --show-backup <backup-id>
create-maa-project --restore <backup-id> --dry-run
create-maa-project --restore <backup-id>
create-maa-project --clean-cache
```

常用执行控制：

```bash
--yes
--no-interactive
--force
--clear-stale-lock
--allow-non-git-dir
--allow-pending-commit
--skip-download
--log-file <path>
--lang auto|en|zh-CN
--no-color
```
