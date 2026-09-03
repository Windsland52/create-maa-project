# create-maa-project

[English](https://github.com/Windsland52/create-maa-project/blob/main/README.en.md) | 简体中文

[![npm](https://img.shields.io/npm/v/create-maa-project)](https://www.npmjs.com/package/create-maa-project)
[![PyPI](https://img.shields.io/pypi/v/create-maa-project)](https://pypi.org/project/create-maa-project)
[![license](https://img.shields.io/github/license/Windsland52/create-maa-project)](./LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D24-green)
![platform](https://img.shields.io/badge/platform-win%20%7C%20linux%20%7C%20osx-blueviolet)

`create-maa-project` 是用于创建和维护新 MaaFW 应用项目的脚手架 CLI。它可以生成确定性的 Pipeline 或 Python Agent 项目，把项目意图记录在已提交的配置中，并提供显式 update、sync、doctor 和 JSON report 接口，方便人类用户和工具封装层使用。

CLI 也内置 MCP stdio server。MCP tools 调用的仍是 CLI 内部同一套写入路径，因此备份、运行锁、本次操作的 pending action 和 JSON report 都能保持一致。

## 目录

- [安装 CLI](#安装-cli)
- [交互式创建项目](#交互式创建项目)
- [配合 MCP Client 使用](#配合-mcp-client-使用)
- [配合 Agent Skill 使用](#配合-agent-skill-使用)
- [自动更新](#自动更新)
- [项目模型](#项目模型)
- [状态与安全](#状态与安全)
- [命令](#命令)
- [工具链](#工具链)
- [Agent 项目](#agent-项目)
- [Release 与 Runtime](#release-与-runtime)
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

交互流程会询问项目名、项目类型、控制目标和可选 add-ons。普通任务/资源项目选择 `pipeline`；只有需要 Python 自定义逻辑时才选择 `agent`。

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

## 配合 MCP Client 使用

MCP 适合让 AI coding agent 帮你创建或维护项目。MCP 本身不是交互式的：`create_project` 要求 agent 先向你问清项目名、
要 Pipeline 还是 Python Agent、支持哪些控制器、要启用哪些 add-ons，以及 resource pack 的文件夹名，再调用 MCP tool。

如果已经全局安装 CLI，可以这样配置 MCP server：

```json
{
    "mcpServers": {
        "create-maa-project": {
            "command": "create-maa-project",
            "args": [
                "--mcp",
                "--root",
                "/absolute/path/to/workspace"
            ]
        }
    }
}
```

如果不想全局安装，可以让 MCP client 通过 `npx` 启动：

```json
{
    "mcpServers": {
        "create-maa-project": {
            "command": "npx",
            "args": [
                "-y",
                "create-maa-project@latest",
                "--mcp",
                "--root",
                "/absolute/path/to/workspace"
            ]
        }
    }
}
```

如果更偏 Python 工具链，可以让 MCP client 通过 `uvx` 启动：

```json
{
    "mcpServers": {
        "create-maa-project": {
            "command": "uvx",
            "args": [
                "create-maa-project",
                "--mcp",
                "--root",
                "/absolute/path/to/workspace"
            ]
        }
    }
}
```

可以这样要求 agent：

```text
在 ./MaaExample 创建一个 MaaFW 项目。使用 Pipeline 项目、Android 控制器，并添加 dev-tools 和 GitHub workflows。
其它可选 add-ons 先问我。
```

如果 agent 要添加 resource pack，必须传 `resourcePackSlug`，例如 `extra` 或 `cn`；否则 MCP tool 会拒绝调用。
`add` tool 可用 `addon` 添加单项，也可用 `addons` 数组在同一个项目锁和 managed-files 备份事务中添加多项；两者必须且只能传一个。
建议始终用 `--root` 显式指定允许 MCP 操作的工作区；相对的 `--root` 按 MCP server 启动时的当前目录解析，省略时默认使用当前目录。
Agent 可先调用只读的 `get_project_context` 确认 server root，以及 `projectPath` 最终解析到的项目目录。

创建子项目后，agent 可在 `doctor`、`sync`、`update`、`add`、`list_backups`、`show_backup`、`restore`
和 `clean_cache` 中传相对 `projectPath` 继续维护。路径只能指向 MCP server 根目录内的真实目录，不能用绝对路径、
`..` 或根外符号链接。恢复前可先用 `list_backups` 查找备份、用 `show_backup` 检查内容，再以
`restore { backupId, dryRun: true }` 预演；预演不会修改项目文件。

## 配合 Agent Skill 使用

本项目内置了遵循 Agent Skills 规范的技能包 [`skills/create-maa-project`](./skills/create-maa-project)，可为 AI Coding Agent（如 Claude Code、Cursor、Windsurf、GitHub Copilot、Antigravity、Cline 等）提供完整的工作流指引、最佳实践、命令参数规范与故障排查知识。

使用 [skills CLI](https://github.com/vercel-labs/skills) 即可一键为本地 Agent 安装该技能：

```bash
# 全局安装 create-maa-project skill 到所支持的本地 Agent
npx skills add https://github.com/Windsland52/create-maa-project --skill create-maa-project --global
```

省去 `--agent` 参数时，CLI 会交互式探测本地已安装的 AI 工具并供你勾选。安装后，Coding Agent 在面对创建 MaaFramework 项目、添加 add-ons、运行 `--doctor` 诊断或升级依赖等任务时，会自动阅读并遵守该技能指引。

详细信息与本地开发安装说明请参见 [Skills 文档](./skills/README.md)。

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

## 工具链

生成的仓库工具链面向 Node 24 和 pnpm 11.5.1。带 dev-tools 的项目会包含本地格式化、schema 校验、MaaFW 检查和 release dry-run 脚本。Agent 项目额外包含 uv、Ruff、Pyright 和 Python 检查。在 VS Code 中打开生成的项目时，`.vscode/tasks.json` 会自动同步依赖：pipeline 项目执行 `pnpm install --frozen-lockfile`，Agent 项目额外执行 `uv sync`。

资产和依赖操作是显式且可恢复的：

- 创建项目时会在相关场景尝试 OCR 下载和 `pnpm install`。
- 网络或工具失败会在本次命令结果中返回 pending action，并附带修复命令。
- Runtime 更新会记录工具安装的文件，后续更新只清理其中已从新版本移除的文件；旧文件和安装记录均可通过本次备份恢复。
- `CREATE_MAA_PROJECT_DOWNLOAD_ATTEMPTS=<n>` 调整下载重试次数。
- `CREATE_MAA_PROJECT_MAX_DOWNLOAD_BYTES=<n>` 调整单个下载的体积上限，默认 1 GiB；带有 manifest 大小的资产会采用更严格的声明值。
- `CREATE_MAA_PROJECT_MAX_ARCHIVE_ENTRIES=<n>` 调整单个归档的条目数上限，默认 100000。
- `CREATE_MAA_PROJECT_OCR_ZIP_PATH=<path>` 从本地 zip 提供 OCR 资产。
- `CREATE_MAA_PROJECT_OCR_MANIFEST_URL=<url-or-path>` 使用经过校验的 OCR manifest。
- `CREATE_MAA_PROJECT_RUNTIME_PLATFORM=all` 同步全部桌面 MaaFramework 和 MFAAvalonia runtime 平台。
- `CREATE_MAA_PROJECT_LANG=auto|en|zh-CN` 控制交互式提示语言。`auto` 只会在中文交互终端启用中英提示；机器可读输出仍保持英文。

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

默认 runtime profile 面向 MFAAvalonia：

- `create-maa-project --update maafw` 同步 MaaFramework 资产。
- `create-maa-project --update runtime:mfa` 同步 MFAAvalonia GUI runtime 资产。
- 生成的 `pnpm sync:runtime` 会执行二者；Agent 项目还会同步 Python runtime。
- Release job 通过 `CREATE_MAA_PROJECT_RUNTIME_PLATFORM=<os>-<arch>` 选择目标 runtime 资产。

默认 release artifact 覆盖 Windows、Linux、macOS 的 `x86_64` 和 `aarch64`。Windows 使用 `.zip`，Linux 和 macOS 使用 `.tar.gz`。

## JSON Report 模式

给 `create`、`sync`、`update`、`doctor` 和备份检查/恢复命令传入 `--report` 后，CLI 会在 stdout 输出唯一一个机器可读 JSON 文档。Report 模式下 `--report` 强制非交互执行。进度、`Log:` 和人类可读 `Error:` 不会写入 stdout；封装工具可以忽略 stderr，除非需要诊断信息。

退出码 `0` 表示命令成功完成。退出码 `1` 表示命令失败，或 `doctor` 发现项目问题。JSON 中的 `exitCode` 与进程退出码一致。

```ts
type BackupInspection = {
    id: string;
    format: "managed-files" | "legacy";
    createdAt: string;
    command: string | null;
    status: "in-progress" | "complete" | "rolled-back" | "rollback-failed" | "legacy";
    entries: Array<{path: string; action: "restore" | "remove"}>;
};

type BackupSummary = {
    id: string;
    format: "managed-files" | "legacy" | "invalid";
    createdAt: string;
    command: string | null;
    status: BackupInspection["status"] | "invalid";
    entryCount: number;
    error?: string;
};

type CliJsonReport = {
    schemaVersion: 1;
    tool: "create-maa-project";
    command: "create" | "sync" | "update" | "add" | "doctor" | "backup" | "clean-cache";
    ok: boolean;
    timestamp: string;
    durationMs: number;
    exitCode: 0 | 1;
    executionId: string;
    root: string;
    logPath: string | null;
    written: string[];
    removed: string[];
    skipped: string[];
    pending: Array<{kind: string; reason: string; command: string}>;
    suggestedCommands: Array<{command: string; description: string; autoRun: boolean}>;
    backupId?: string;
    backupScope?: "managed-files";
    git?: {initialized: boolean; committed: boolean; reason?: string};
    doctor?: {
        lines: string[];
        checks: Array<{
            id: string;
            status: "pass" | "fail" | "skipped";
            summary: string;
            details: string[];
        }>;
    };
    backup?:
        | {operation: "list"; backups: BackupSummary[]}
        | {operation: "show" | "restore-preview"; backup: BackupInspection}
        | {
              operation: "restore";
              backupId: string;
              restored: string[];
              removed: string[];
              preRestoreBackupId: string;
          };
    error?: {
        message: string;
        code:
            | "CMP_CREATE_FAILED"
            | "CMP_SYNC_FAILED"
            | "CMP_UPDATE_FAILED"
            | "CMP_ADD_FAILED"
            | "CMP_DOCTOR_FAILED"
            | "CMP_BACKUP_FAILED"
            | "CMP_CLEAN_CACHE_FAILED";
        causeCode?: string;
    };
};
```

失败报告始终包含稳定的 `CMP_*` 命令错误码；如果底层系统还提供了 `ENOENT` 等原生错误码，会另外保存在
`causeCode`，避免调用方依赖操作系统相关信息。

失败报告示例：

```json
{
    "schemaVersion": 1,
    "tool": "create-maa-project",
    "command": "sync",
    "ok": false,
    "timestamp": "2026-06-12T10:31:00.000Z",
    "durationMs": 6,
    "exitCode": 1,
    "executionId": "2026-06-12T10-31-00-000Z-00000000-0000-4000-8000-000000000000",
    "root": "/path/to/project",
    "logPath": "/path/to/project/.create-maa-project/logs/2026-06-12T10-31-00-000Z-00000000-0000-4000-8000-000000000000.log",
    "written": [],
    "removed": [],
    "skipped": [],
    "pending": [],
    "suggestedCommands": [],
    "error": {
        "message": "Invalid version \"not-semver\". Use a SemVer version such as 0.1.0.",
        "code": "CMP_SYNC_FAILED"
    }
}
```

## License

[AGPL-3.0-or-later](./LICENSE)
