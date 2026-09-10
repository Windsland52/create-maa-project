# create-maa-project

[English](https://github.com/Windsland52/create-maa-project/blob/main/README.en.md) | 简体中文

[![npm](https://img.shields.io/npm/v/create-maa-project)](https://www.npmjs.com/package/create-maa-project)
[![PyPI](https://img.shields.io/pypi/v/create-maa-project)](https://pypi.org/project/create-maa-project)
[![license](https://img.shields.io/github/license/Windsland52/create-maa-project)](./LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D24-green)
![platform](https://img.shields.io/badge/platform-win%20%7C%20linux%20%7C%20osx-blueviolet)

`create-maa-project` 是 [MaaFramework](https://github.com/MaaXYZ/MaaFramework)（MaaFW）应用项目的脚手架 CLI：回答几个问题，它会生成一个可以直接提交、构建的 Pipeline 或 Python Agent 项目。创建时的所有选择都记录在仓库内的 `maa-project.json` 中，之后通过显式的 `--sync`、`--add`、`--update`、`--doctor` 命令维护，人和 AI 工具都能读取并复现同样的结果。

AI coding agent 推荐通过 [Agent Skill](#配合-agent-skill-使用) 接入：agent 读取工作流指引后，直接调用与人类用户相同的 CLI 命令。CLI 也内置 MCP stdio server 作为替代接入方式，适合 agent 没有 shell 权限或需要按 tool 粒度管控权限的环境；两条路径共用同一条写入路径，行为和回滚机制保持一致。

## 目录

- [安装 CLI](#安装-cli)
- [交互式创建项目](#交互式创建项目)
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
- [License](#license)

## 安装 CLI

最简单的方式是使用 npm 版本。先安装 Node.js（>= 24），然后全局安装 `create-maa-project`：

```bash
npm install -g create-maa-project
```

也可以不全局安装，直接临时运行最新版：

```bash
npx create-maa-project@latest
```

PyPI 包适合更偏 Python 工具链的环境，但 npm 是主分发渠道：

```bash
uvx create-maa-project
pipx run create-maa-project
```

## 交互式创建项目

第一次使用时，直接运行 CLI，然后按提示回答问题：

```bash
create-maa-project
```

如果使用 `npx`，运行：

```bash
npx create-maa-project@latest
```

交互流程按顺序询问以下问题，直接回车即可接受默认值：

1. **项目目录**：默认 `maa-project`。
2. **项目 ID**：仅当目录名无法自动转成合法 ID 时追问；否则自动推导并显示。
3. **显示名称**：默认取目录名。
4. **项目类型**：`pipeline` 适合普通任务/资源项目；只有需要 Python 自定义逻辑时才选 `agent`。
5. **许可证**：默认 AGPL-3.0-or-later。
6. **控制目标**：可多选，默认 Adb。
7. **仓库配置**：全部 / 最小 / 自定义；每个预设都会显示一行说明，全部会装上 `dev-tools`、`github`、`git-cliff`、`auto-format`、`optimize-images`、`schema-sync`、`community`、`dependabot`，最小则不添加任何仓库功能。
8. **额外资源包**：默认不添加。
9. **初始化 Git 仓库**：目标已在 Git 仓库内时默认否，否则默认是。

第 8、9 项按单键 `y`/`n` 回答，回车接受默认值。提示宽度会跟随终端列数折行；随时按 Ctrl+C 可安静退出（退出码 `130`，不会打印 `Error:`）。

项目创建完成后：

```bash
cd <project-folder>
create-maa-project --doctor
```

如果工具输出 pending actions，就在项目根目录执行它提示的命令。带 dev tools 的项目之后可以运行：

```bash
pnpm check
```

如果自动语言识别不符合你的终端，可以强制指定提示语言：

```bash
create-maa-project --lang zh-CN
create-maa-project --lang en
```

## 配合 Agent Skill 使用

这是 AI coding agent 的推荐接入方式。本项目内置了遵循 Agent Skills 规范的技能包 [`skills/create-maa-project`](./skills/create-maa-project)，可为 AI Coding Agent（如 Claude Code、Cursor、Windsurf、GitHub Copilot、Antigravity、Cline 等）提供完整的工作流指引、最佳实践、命令参数规范与故障排查知识；agent 读取指引后直接调用与人类用户相同的 CLI 命令，CLI 的新能力自动可用。

使用 [skills CLI](https://github.com/vercel-labs/skills) 即可一键为本地 Agent 安装该技能：

```bash
# 全局安装 create-maa-project skill 到所支持的本地 Agent
npx skills add https://github.com/Windsland52/create-maa-project --skill create-maa-project --global
```

省去 `--agent` 参数时，CLI 会交互式探测本地已安装的 AI 工具并供你勾选。安装后，Coding Agent 在面对创建 MaaFramework 项目、添加 add-ons、运行 `--doctor` 诊断或升级依赖等任务时，会自动阅读并遵守该技能指引。

详细信息与本地开发安装说明请参见 [Skills 文档](./skills/README.md)。

## 配合 MCP Client 使用

MCP 是 Agent Skill 之外的替代接入方式，适合 agent 没有 shell 权限、或需要在 client 中按 tool 粒度管控权限的环境。启动 MCP server 时建议始终用 `--root` 显式指定允许 MCP 操作的工作区。

JSON 配置示例（全局安装 / `npx` / `uvx`）、tool 调用约定与 `projectPath` 路径规则，见 [MCP 文档](./docs/mcp.md)。

## 自动更新

为了保证 CLI 运行时与 AI Agent 掌握的规范始终保持最新，`create-maa-project` 内置了轻量级、零干扰的自动更新与热交付机制：

- **24 小时更新检查**：CLI 最多每 24 小时向 npm 官方 registry 查询一次最新稳定版本。网络请求设置了极短超时（1500ms），遇离线、代理异常或网络延迟时静默回退至本地版本，绝不阻断用户正常命令；
- **运行时热交付（Runtime Handoff）**：若检测到远端发布了更高版本的稳定 CLI，会自动将当前命令行参数安全交接给最新版本的临时运行时执行，无需手动反复升级；
- **Agent Skill 自动同步**：在新版本首次运行后，CLI 会在后台自动触发 `skills update create-maa-project --global --yes`，同步更新全局安装的 Agent Skill（每个发布版本仅触发一次）；
- **离线与 CI 环境变量控制**：
    - `CREATE_MAA_PROJECT_AUTO_UPDATE=0`：完全禁用自动更新检查、运行时转交与 Skill 同步（在 CI 环境下默认自动禁用）；
    - `CREATE_MAA_PROJECT_AUTO_UPDATE=1`：在 CI 环境下强制启用自动更新。

## 项目模型

项目身份拆成两个字段：

- `slug`：ASCII kebab-case ID，用于仓库名、package 名、artifact 名和 `interface.json` 的 `name`。
- `displayName`：面向用户的显示名，用于 `interface.json` 的 `label`，可以是中文或其它展示文本。

完整仓库/工具项目通常包含：

```text
my-project/
├── interface.json
├── maa-project.json
├── tasks/tutorial.json
├── resource/base/
│   ├── default_pipeline.json
│   ├── pipeline/tutorial.json
│   ├── image/empty.png
│   └── model/ocr/
├── tools/
├── tools/schema/
├── .github/workflows/
├── .vscode/
├── package.json
├── maatools.config.mts
└── README.md
```

资源结构固定围绕 `resource/base/` 和可选的 `resource/<pack>/`。`interface.json` 的 resource 路径按 `maa-project.json` 中记录的顺序生成；后添加的资源包在 MaaFW 资源查找中有更高覆盖优先级。

CLI 只在首次创建时写入 `interface.json`、`package.json`、`tasks/`、`resource/`、README、license 等项目自有文件。之后仅由明确的 `--sync`、`--add` 或具体 `--update` 操作改写对应文件；通用模板升级应通过版本化 migration 实现。

## 状态与安全

进入 Git 的状态文件：

- `maa-project.json`：用户意图，包括项目元数据、功能/插件选择、资源包、runtime channel/version、网络模式、license 和 Agent 配置。`version` 非空时精确版本优先；为空时按 `stable`、`beta`（含 rc）或 `alpha` channel 解析。

本机状态放在 `.create-maa-project/`，生成项目默认忽略该目录：

```text
.create-maa-project/
├── backups/
├── cache/
├── logs/
└── run-locks/
```

安全规则：

- 写配置或生成文件前会创建带唯一所有者标识的项目运行锁；异常退出留下的锁可用 `--clear-stale-lock` 清理。
- 覆盖或创建受管文件前会先登记到同一次操作备份；失败时自动回滚，成功后也可用输出的 backup id 恢复。
- `--list-backups` 和 `--show-backup <id>` 可检查备份；`--restore <id> --dry-run` 会列出恢复/删除动作但不改文件。
- `.git` 属于受保护的仓库状态，不进入受管文件备份。创建项目时 Git 初始化在受管文件事务完成后执行；`git init` 失败产生的新 `.git` 会被安全清理。
- `--force` 跳过确认，但不跳过备份。
- `--yes` 接受创建默认值并关闭交互，但不等于 `--force`，也不会允许覆盖非空目录。
- 非空且不在 Git 仓库中的目标目录需要显式 `--force --allow-non-git-dir`。
- `--doctor` 只读，并直接检查当前项目文件状态。

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

完整的创建选项（`--slug`、`--controller`、`--license`、`--git` 等）、add-on 与 sync/update 目标清单、执行控制 flag，以及 Git 初始化和 schema v1 迁移行为，见[命令文档](./docs/commands.md)。

## 工具链

生成的仓库工具链面向 Node 24 和 pnpm 11.5.1。带 dev-tools 的项目会包含本地格式化、schema 校验、MaaFW 检查和 release dry-run 脚本。Agent 项目额外包含 uv、Ruff、Pyright 和 Python 检查。在 VS Code 中打开生成的项目时，`.vscode/tasks.json` 会自动同步依赖：pipeline 项目执行 `pnpm install --frozen-lockfile`，Agent 项目额外执行 `uv sync`。

### OCR 模型供应

- 创建项目时默认把 `MaaXYZ/MaaCommonAssets` 以 `--depth 1` 克隆为子模块，并把 `ppocr_v6/small` 的 OCR 模型复制到 `resource/base/model/ocr/`。子模块模式下该目录会写入 `.gitignore`（模型是派生文件），同时生成或合并 `.gitmodules`，保留已有子模块映射，版本由提交中的 gitlink 钉死。
- 在已有 Git 仓库的子目录中创建项目时，默认使用 download 模式，模型随子项目提交。显式设置 `CREATE_MAA_PROJECT_OCR_SOURCE=submodule` 时需要在 Git 工作树根目录或父仓库之外创建项目；子项目不会改写父仓库的 `.gitmodules`。
- 本地 Git 不可用（或显式 `CREATE_MAA_PROJECT_OCR_SOURCE=download`）时改为从下载源获取 OCR 模型：写入 `manifest.json` 记录 sha256，模型文件纳入版本控制。
- 子模块克隆失败会登记 pending action，稍后执行 `create-maa-project --update ocr-models` 补齐；该命令也会自动初始化已注册但尚未拉取的子模块。
- `--doctor` 会检查 `resource/base/model/ocr/` 下 `det.onnx`/`rec.onnx`/`keys.txt` 是否存在且非空（新建克隆后未供模型的项目会在此报出 finding）。
- Runtime 更新会记录工具安装的文件，后续更新只清理其中已从新版本移除的文件；旧文件和安装记录均可通过本次备份恢复。
- 网络或工具失败会在本次命令结果中返回 pending action，并附带修复命令；常见网络问题的恢复方法见[常见问题](#常见问题)。

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
├── bootstrap.py
├── main.py
├── agent_runtime.py
├── custom/
└── utils/
pyproject.toml
uv.lock
requirements.txt
```

生成的 bootstrap 负责本地运行时准备、依赖检查、debug 日志和启动 `agent/main.py`。`config/pip_config.json`、`.venv/`、`debug/` 等运行时本地文件会被忽略，不进入提交。

## Release 与 Runtime

带 GitHub add-on 的项目会包含 check 和 release workflows。发布打包以 Git tag 为准：源码元数据可以保持 `0.1.0`，release staging 会把 Git tag 版本注入包内的 `interface.json`。

默认 runtime profile 面向 [MFAAvalonia](https://github.com/MaaXYZ/MFAAvalonia)：

- `create-maa-project --update maafw` 同步 MaaFramework 资产。
- `create-maa-project --update runtime:mfa` 同步 MFAAvalonia GUI runtime 资产。
- 生成的 `pnpm sync:runtime` 会执行二者；Agent 项目还会同步 Python runtime。
- Release job 通过 `CREATE_MAA_PROJECT_RUNTIME_PLATFORM=<os>-<arch>` 选择目标 runtime 资产。

默认 release artifact 覆盖 Windows、Linux、macOS 的 `x86_64` 和 `aarch64`。Windows 使用 `.zip`，Linux 和 macOS 使用 `.tar.gz`。

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

给 `create`、`sync`、`update`、`doctor` 和备份检查/恢复命令传入 `--report` 后，CLI 会在 stdout 输出唯一一个机器可读 JSON 文档。Report 模式强制非交互执行；进度、`Log:` 和人类可读 `Error:` 不会写入 stdout。退出码 `0` 表示成功，`1` 表示失败或 `doctor` 发现问题；JSON 中的 `exitCode` 与进程退出码一致。

完整的 report schema（含 `doctor.checks` 与备份操作结果）、稳定 `CMP_*` 错误码和失败示例，见 [JSON Report 文档](./docs/json-report.md)。

## License

[AGPL-3.0-or-later](./LICENSE)
