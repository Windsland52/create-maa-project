# create-maa-project

[English](https://github.com/Windsland52/create-maa-project/blob/main/README.en.md) | 简体中文

[![npm](https://img.shields.io/npm/v/create-maa-project)](https://www.npmjs.com/package/create-maa-project)
[![PyPI](https://img.shields.io/pypi/v/create-maa-project)](https://pypi.org/project/create-maa-project)
[![license](https://img.shields.io/github/license/Windsland52/create-maa-project)](./LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D22.13-green)
![platform](https://img.shields.io/badge/platform-win%20%7C%20linux%20%7C%20osx-blueviolet)

`create-maa-project` 是 [MaaFramework](https://github.com/MaaXYZ/MaaFramework)（MaaFW）应用项目的脚手架 CLI：回答几个问题，它会生成一个可以直接提交、构建的 Pipeline 或 Python Agent 项目。创建时的所有选择都记录在仓库内的 `maa-project.json` 中，之后通过显式的 `--sync`、`--add`、`--update`、`--doctor` 命令维护，人和 AI 工具都能读取并复现同样的结果。

AI coding agent 推荐通过 [Agent Skill](#配合-agent-skill-使用) 接入：agent 读取工作流指引后，直接调用与人类用户相同的 CLI 命令。CLI 也内置 MCP stdio server 作为替代接入方式，适合 agent 没有 shell 权限或需要按 tool 粒度管控权限的环境；两条路径共用同一条写入路径，行为和回滚机制保持一致。

## 目录

- [能力边界](#能力边界)
- [安装 CLI](#安装-cli)
- [创建项目](#创建项目)
- [配合 Agent Skill 使用](#配合-agent-skill-使用)
- [配合 MCP Client 使用](#配合-mcp-client-使用)
- [自动更新](#自动更新)
- [项目模型](#项目模型)
- [状态与安全](#状态与安全)
- [命令](#命令)
- [工具链](#工具链)
- [Agent 项目](#agent-项目)
- [Release 与 Runtime](#release-与-runtime)
- [常见问题](#常见问题)
- [JSON Report 模式](#json-report-模式)
- [变更记录](#变更记录)
- [License](#license)

## 能力边界

| create-maa-project 负责                                                                                        | create-maa-project 不负责                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 生成与增量维护项目文件：`create`、`--add`、`--sync`、`--update`                                                | 构建、校验、打包、发布生成的产物——那是生成项目里 dev-tools 与 github workflows（`pnpm check`、`release:dry-run`、`package-smoke`、`release`）的职责 |
| 获取资产与依赖：OCR 模型、MaaFramework 与 MFAAvalonia runtime、schema、pnpm 与 uv 依赖                         | 编写业务内容（pipeline、任务、资源、自定义逻辑）：创建时只写一份起步模板；项目自有的 `once` 文件同样归项目所有，后续命令不覆盖                      |
| 写入前登记备份、失败自动回滚，并提供 `--list-backups` / `--show-backup` / `--restore`                          | 对已创建项目做通用模板升级（需版本化 migration）；旧 schema 不会被隐式改写，v1 迁移必须显式 `--sync config`                                         |
| 只读诊断：`--doctor` 检查 `maa-project.json`、`interface.json` 与资源路径、依赖锁、已启用工具链和 OCR 模型文件 | 解析运行日志、做 MaaFW 运行时诊断、定位识别或任务失败原因                                                                                           |
| 本地 `git init` 与首次提交（在受管文件事务完成之后）                                                           | 推送、打 tag、建远端仓库或发版                                                                                                                      |
| 输出稳定的 JSON report（`schemaVersion`、`CMP_*` 错误码）；MCP 与 Agent Skill 走同一条写入路径                 | 收集遥测或上报使用数据                                                                                                                              |

## 安装 CLI

需要 Node.js（>= 22.13）。最简单的方式是 npm 全局安装：

```bash
npm install -g create-maa-project
```

也可以临时运行最新版：

```bash
npx create-maa-project@latest
```

PyPI 包适合偏 Python 工具链的环境（npm 仍是主分发渠道）：

```bash
uvx create-maa-project
pipx run create-maa-project
```

## 创建项目

直接运行 CLI 并按提示回答，回车接受默认值：

```bash
create-maa-project
```

几个关键选择：

- **项目类型**：`pipeline` 适合普通任务/资源项目；需要 Python 自定义逻辑时才选 `agent`。
- **控制目标**：可多选，默认 `Adb`，完整清单见[命令文档](./docs/commands.md)。
- **仓库功能**：预设 全部 / 最小 / 自定义，「全部」包含开发工具、GitHub 自动化与社区文件，add-on 清单见[命令文档](./docs/commands.md)。勾选会自动补全依赖（例如 `community` 会带上 `github` 与 `dev-tools`），人类输出中的 `Add-ons required by dependencies:` 一行与 JSON report 的 `addons` 字段会说明差异。
- **Git 初始化**：目标已在 Git 仓库内时默认否，否则默认是。

随时按 Ctrl+C 可安静退出（退出码 `130`）。创建完成后建议跑一次只读诊断：

```bash
cd <project-folder>
create-maa-project --doctor
```

输出 pending actions 时，在项目根目录执行它提示的命令；带 dev-tools 的项目之后可以运行 `pnpm check`。提示语言默认自动识别，可用 `--lang zh-CN|en` 强制指定。

## 配合 Agent Skill 使用

这是 AI coding agent 的推荐接入方式。仓库内置遵循 Agent Skills 规范的技能包 [`skills/create-maa-project`](./skills/create-maa-project)，为 Claude Code、Codex 等 AI 工具提供工作流指引、命令参数规范与故障排查知识；agent 读取指引后调用与人类用户相同的 CLI 命令，CLI 的新能力自动可用。

用 [skills CLI](https://github.com/vercel-labs/skills) 一键安装到本地 Agent（省略 `--agent` 参数时交互式探测并勾选）：

```bash
npx skills add https://github.com/Windsland52/create-maa-project --skill create-maa-project --global
```

安装后，agent 在创建 MaaFramework 项目、添加 add-ons、运行 `--doctor` 诊断等任务时会自动遵守该技能指引。详见 [Skills 文档](./skills/README.md)。

## 配合 MCP Client 使用

MCP 是 Agent Skill 之外的替代接入方式。启动 MCP server 时建议始终用 `--root` 显式指定允许 MCP 操作的工作区。JSON 配置示例（全局安装 / `npx` / `uvx`）、tool 调用约定与 `projectPath` 路径规则，见 [MCP 文档](./docs/mcp.md)。

## 自动更新

CLI 内置零干扰的自动更新：最多每 24 小时向 npm registry 查询一次最新版本（超时 1500ms，离线或网络异常时静默回退本地版本）；发现新版本时把当前命令交接给最新版的临时运行时执行，并在后台同步更新全局安装的 Agent Skill（每个发布版本仅一次）。设置 `CREATE_MAA_PROJECT_AUTO_UPDATE=0` 可完全禁用（CI 环境默认禁用，`=1` 强制启用）。

## 项目模型

项目身份拆成两个字段：

- `slug`：ASCII kebab-case ID，用于仓库名、package 名、artifact 名和 `interface.json` 的 `name`。
- `displayName`：面向用户的显示名，用于 `interface.json` 的 `label`，可以是中文或其它展示文本。

资源结构固定围绕 `resource/base/` 与可选的 `resource/<pack>/`；`interface.json` 的 resource 路径按 `maa-project.json` 中记录的顺序生成，后添加的资源包在 MaaFW 资源查找中有更高覆盖优先级。项目自有文件只在首次创建时写入，之后仅由显式的 `--sync`、`--add`、`--update` 改写对应文件。

## 状态与安全

进入 Git 的状态文件是 `maa-project.json`（用户意图：项目元数据、add-on 选择、资源包、runtime channel/version、网络模式、license 与 Agent 配置）。本机状态放在生成项目默认忽略的 `.create-maa-project/` 下（`backups/`、`cache/`、`logs/`、`run-locks/`）。

安全规则：

- 写配置或生成文件前会创建带唯一所有者标识的项目运行锁；异常退出留下的锁用 `--clear-stale-lock` 清理。
- 覆盖或创建受管文件前会先登记到同一次操作备份，失败时自动回滚；`--list-backups`、`--show-backup <id>` 与 `--restore <id> --dry-run` 用于检查和预演恢复。`.git` 属于受保护状态，不进入备份。
- `--force` 跳过确认但不跳过备份；`--yes` 接受创建默认值，但不等于 `--force`，不允许覆盖非空目录。
- 非空且不在 Git 仓库中的目标目录需要显式 `--force --allow-non-git-dir`。
- `--doctor` 只读，直接检查当前项目文件状态。

## 命令

常用命令速查：

```bash
create-maa-project [name]                    # 交互式创建项目（回车接受默认值）
create-maa-project [name] --template agent   # 创建 Python Agent 项目
create-maa-project --add dev-tools           # 为当前项目添加 add-on
create-maa-project --sync version --version 0.2.0
create-maa-project --update ocr-models       # 补齐 / 更新 OCR 模型
create-maa-project --doctor                  # 诊断当前项目（只读）
```

完整的创建选项、add-on 与 sync/update 目标清单、执行控制 flag，以及 Git 初始化和 schema v1 迁移行为，见[命令文档](./docs/commands.md)。

## 工具链

生成的仓库工具链面向 Node 22（>= 22.13）和 pnpm 11：确切的 pnpm 版本由生成项目的 `packageManager` 固定。dev-tools 提供本地格式化、schema 校验与 MaaFW 检查脚本，`github` 再追加 release dry-run 与 runtime 同步脚本，Agent 项目额外包含 uv、Ruff、Pyright 检查；带 `vscode` add-on 的项目在 VS Code 中打开时，`.vscode/tasks.json` 会自动同步依赖。每个 add-on 写入哪些文件、哪些可被 `--update` 刷新（`managed` / `once`），见[命令文档](./docs/commands.md#dev-tools-写入的文件)。

OCR 模型默认以 `--depth 1` 子模块克隆 `MaaXYZ/MaaCommonAssets`，并把 `ppocr_v6/small` 复制到 `resource/base/model/ocr/`；在已有仓库的子目录或本机 Git 不可用时自动改用 download 模式，提交带 sha256 的 `manifest.json`。克隆或下载失败会登记 pending action，稍后用 `create-maa-project --update ocr-models` 补齐。两种供应方式的细节见[命令文档](./docs/commands.md#ocr-模型的两种供应方式)。

### 环境变量

| 环境变量                                            | 说明                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `CREATE_MAA_PROJECT_OCR_SOURCE=submodule\|download` | 调整创建时的 OCR 供应方式                                                         |
| `CREATE_MAA_PROJECT_OCR_ZIP_PATH=<path>`            | 从本地 zip 提供 OCR 资产（download 回退路径）                                     |
| `CREATE_MAA_PROJECT_OCR_MANIFEST_URL=<url-or-path>` | 使用经过校验的 OCR manifest（download 回退路径）                                  |
| `CREATE_MAA_PROJECT_DOWNLOAD_ATTEMPTS=<n>`          | 调整下载重试次数                                                                  |
| `CREATE_MAA_PROJECT_MAX_DOWNLOAD_BYTES=<n>`         | 调整单个下载的体积上限，默认 1 GiB；带有 manifest 大小的资产会采用更严格的声明值  |
| `CREATE_MAA_PROJECT_MAX_ARCHIVE_ENTRIES=<n>`        | 调整单个归档的条目数上限，默认 100000                                             |
| `CREATE_MAA_PROJECT_RUNTIME_PLATFORM=all`           | 同步全部桌面 MaaFramework 和 MFAAvalonia runtime 平台                             |
| `CREATE_MAA_PROJECT_LANG=auto\|en\|zh-CN`           | 控制交互式提示语言。`auto` 只会在中文交互终端启用中文提示；机器可读输出仍保持英文 |

## Agent 项目

`--template agent` 或 `--add agent` 会在 Pipeline 项目上增加 Python Agent 脚手架：

```text
agent/
├── main.py
├── agent_runtime.py
├── custom/
└── utils/
pyproject.toml
uv.lock
requirements.txt
```

`agent/main.py` 是 Agent 入口（含 Python 版本检查），`agent_runtime.py` 注册 `custom/` 下的自定义逻辑；本地开发用 `uv sync` 准备依赖。发布包自带 Python 运行时与依赖（Windows 用 python.org 嵌入式发行版，macOS 与 Linux 用 python-build-standalone），不依赖用户系统里的 Python。`config/`、`.venv/`、`debug/` 等运行时本地文件不进入提交。

## Release 与 Runtime

带 GitHub add-on 的项目会包含 check、release 和 package-smoke workflows。发布打包以 Git tag 为准：源码元数据可以保持 `0.1.0`，release staging 会把 tag 版本注入包内的 `interface.json`；`package-smoke` 在 push / PR 时用与 release 相同的目标矩阵先行构建校验，打包问题不必等到打 tag 才暴露。

默认 runtime profile 面向 [MFAAvalonia](https://github.com/MaaXYZ/MFAAvalonia)：`--update maafw` 同步 MaaFramework 资产，`--update runtime:mfa` 同步 MFAAvalonia GUI runtime，生成的 `pnpm sync:runtime` 执行二者（Agent 项目还会同步 Python runtime）。默认 release artifact 覆盖 Windows、Linux、macOS 的 `x86_64` 与 `aarch64`，Windows 使用 `.zip`，Linux 和 macOS 使用 `.tar.gz`。

## 常见问题

**OCR 模型或资源下载失败（网络受限、代理环境）**

- 默认 v6 配置可把 `maa-project.json` 中的 `ocr.source` 切为 `download`，直接从 CDN 获取（CDN 仅托管 ppocr_v6 tiny/small/medium）；需要其它版本时给 GitHub 配镜像后重试：

    ```bash
    git config --global url."https://gh-proxy.com/https://github.com/MaaXYZ/MaaCommonAssets.git".insteadOf "https://github.com/MaaXYZ/MaaCommonAssets.git"
    ```

    然后运行 `create-maa-project --update ocr-models`。

- 完全离线的机器可用 `CREATE_MAA_PROJECT_OCR_ZIP_PATH` 从本地 zip 提供 OCR 资产。

**提示 Stale write lock（项目运行锁被残留占用）**

- 确认没有其它 create-maa-project 进程正在运行后，执行 `create-maa-project --clear-stale-lock`。

**想撤销某次写入**

- 用 `--list-backups` 找到备份，先 `--restore <backup-id> --dry-run` 预演，确认后去掉 `--dry-run` 执行恢复。

其它失败场景先看 `--doctor` 的输出，以及项目 `.create-maa-project/logs/` 下的日志。

## JSON Report 模式

给 `create`、`sync`、`update`、`doctor` 和备份检查/恢复命令传入 `--report` 后，CLI 会在 stdout 输出唯一一个机器可读 JSON 文档。Report 模式强制非交互执行；进度、`Log:` 和人类可读 `Error:` 不会写入 stdout。退出码 `0` 表示成功，`1` 表示失败或 `doctor` 发现问题。完整的 report schema、稳定 `CMP_*` 错误码和失败示例，见 [JSON Report 文档](./docs/json-report.md)。

## 变更记录

各版本的用户可见变更、修复与升级注意事项见 [CHANGELOG.md](./CHANGELOG.md)；每个版本的 GitHub Release 说明取自该文件的对应段落。

## License

[AGPL-3.0-or-later](./LICENSE)
