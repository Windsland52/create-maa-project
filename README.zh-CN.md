# create-maa-project

[English](./README.md) | 简体中文

`create-maa-project` 是用于创建和维护新 MaaFW 应用项目的脚手架 CLI。它可以生成确定性的
Pipeline 或 Python Agent 项目，把项目意图记录在已提交的状态文件中，并提供 update、sync、
diff、doctor 和 JSON report 接口，方便人类用户和工具封装层使用。

CLI 也内置 MCP stdio server。MCP tools 调用的仍是 CLI 内部同一套写入路径，因此备份、锁、
hash、pending action 和 JSON report 都能保持一致。

## 安装 CLI

最简单的方式是使用 npm 版本。先安装 Node.js，然后全局安装 `create-maa-project`：

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

交互流程会询问项目名、项目类型、控制目标和可选 add-ons。普通任务/资源项目选择 `pipeline`；
只有需要 Python 自定义逻辑时才选择 `agent`。

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

MCP 适合让 AI coding agent 帮你创建或维护项目。MCP 本身不是交互式的：agent 应该先向你问清项
目名、要 Pipeline 还是 Python Agent、要启用哪些 add-ons，以及 resource pack 的文件夹名，再调
用 MCP tool。

如果已经全局安装 CLI，可以这样配置 MCP server：

```json
{
  "mcpServers": {
    "create-maa-project": {
      "command": "create-maa-project",
      "args": [
        "--mcp"
      ],
      "cwd": "/path/to/project-or-parent"
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
        "--mcp"
      ],
      "cwd": "/path/to/project-or-parent"
    }
  }
}
```

创建新项目时，`cwd` 配成新项目所在的父目录。维护已有项目时，`cwd` 配成 MaaFW 项目根目录，用
于 `doctor`、`diff`、`sync`、`update`、`add`、`accept_changes`、`restore` 或
`clean_cache`。

可以这样要求 agent：

```text
在 ./MaaExample 创建一个 MaaFW 项目。使用 Pipeline 项目、Android 控制器，并添加 dev-tools
和 GitHub workflows。其它可选 add-ons 先问我。
```

如果 agent 要添加 resource pack，必须传 `resourcePackSlug`，例如 `extra` 或 `cn`；否则 MCP
tool 会拒绝调用。

## 项目模型

项目身份拆成两个字段：

- `slug`：ASCII kebab-case ID，用于仓库名、package 名、artifact 名和 `interface.json` 的
  `name`。
- `displayName`：面向用户的显示名，用于 `interface.json` 的 `label`，可以是中文或其它展示文
  本。

完整仓库/工具项目通常包含：

```text
my-project/
├── interface.json
├── maa-project.json
├── maa-project.lock.json
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

资源结构固定围绕 `resource/base/` 和可选的 `resource/<pack>/`。`interface.json` 的 resource
路径按 `maa-project.json` 中记录的顺序生成；后添加的资源包在 MaaFW 资源查找中有更高覆盖优先级。

CLI 只在首次创建时写入 `interface.json`、`package.json`、`tasks/`、`resource/`、README、license
等项目自有文件。后续模板更新不会把这些文件当成 managed baseline，除非明确的 `--sync` 或 `--add`
操作需要改写受支持的结构化字段。

## 状态与安全

进入 Git 的状态文件：

- `maa-project.json`：用户意图，包括项目元数据、功能/插件选择、资源包、runtime channel、网络模
  式、license 和 Agent 配置。
- `maa-project.lock.json`：resolved 状态、pending actions、模板版本和 managed file hash。

本机状态放在 `.create-maa-project/`，生成项目默认忽略该目录：

```text
.create-maa-project/
├── backups/
├── baselines/
├── cache/
├── logs/
└── run.lock
```

安全规则：

- 写 config、lock 和 managed 文件前会创建项目写锁。
- 覆盖文件前会先备份。
- `--force` 跳过确认，但不跳过备份。
- `--yes` 不等于 `--force`。
- 非空且不在 Git 仓库中的目标目录需要显式 `--force --allow-non-git-dir`。
- `--doctor` 和 `--diff` 只读。
- `--accept-changes [path...]` 表示接受当前 managed 文件内容为新的本地基线，不表示恢复官方模板。

Managed files 是工具拥有的文件，例如 workflows、schema baseline、release 脚本和项目检查脚本。如
果它们发生漂移，`--diff` 会展示变更，`--doctor` 会给出可执行的修复或接受命令。

## 命令

常用创建选项：

```bash
create-maa-project [name]
create-maa-project .
create-maa-project [name] --template pipeline
create-maa-project [name] --template agent
create-maa-project [name] --slug maa-helper --name "明日方舟助手"
create-maa-project [name] --controller Adb,Win32
create-maa-project [name] --license MIT
create-maa-project [name] --git
create-maa-project [name] --no-git
```

可用的控制目标：`Adb`、`Win32`、`MacOS`、`PlayCover`、`Gamepad`、`WlRoots`。默认为 `Adb`。

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
create-maa-project --sync metadata
create-maa-project --sync display-name --name "新显示名"
create-maa-project --sync version --version 0.2.0
create-maa-project --sync license --license MIT
create-maa-project --sync github-url https://github.com/MaaXYZ/MaaExample
create-maa-project --sync network --network official
```

更新：

```bash
create-maa-project --update schema
create-maa-project --update maafw
create-maa-project --update runtime:mfa
create-maa-project --update ocr-models
create-maa-project --update node-deps
create-maa-project --update python-deps
create-maa-project --update python-runtime
create-maa-project --update template
create-maa-project --update template --diff
create-maa-project --update schema --diff
```

`--update all` 故意不支持。显式执行具体更新可以让 pending action 和日志更清楚。

诊断和维护：

```bash
create-maa-project --doctor
create-maa-project --doctor --report
create-maa-project --diff
create-maa-project --accept-changes [path...]
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

生成的仓库工具链面向 Node 24 和 pnpm 11.5.1。带 dev-tools 的项目会包含本地格式化、schema 校
验、MaaFW 检查、项目状态 lint 和 release dry-run 脚本。Agent 项目额外包含 uv、Ruff、Pyright
和 Python 检查。

资产和依赖操作是显式且可恢复的：

- 创建项目时会在相关场景尝试 OCR 下载和 `pnpm install`。
- 网络或工具失败会留下已提交的 pending action，并附带修复命令。
- `CREATE_MAA_PROJECT_DOWNLOAD_ATTEMPTS=<n>` 调整下载重试次数。
- `CREATE_MAA_PROJECT_OCR_ZIP_PATH=<path>` 从本地 zip 提供 OCR 资产。
- `CREATE_MAA_PROJECT_OCR_MANIFEST_URL=<url-or-path>` 使用经过校验的 OCR manifest。
- `CREATE_MAA_PROJECT_RUNTIME_PLATFORM=all` 同步全部桌面 MaaFramework 和 MFAAvalonia
  runtime 平台。
- `CREATE_MAA_PROJECT_LANG=auto|en|zh-CN` 控制交互式提示语言。`auto` 只会在中文交互终端
  启用中英提示；机器可读输出仍保持英文。

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

生成的 bootstrap 负责本地运行时准备、依赖检查、debug 日志和启动 `agent/main.py`。
`config/pip_config.json`、`.venv/`、`debug/` 等运行时本地文件会被忽略，不进入提交。

## Release 与 Runtime

带 GitHub add-on 的项目会包含 check 和 release workflows。发布打包以 Git tag 为准：源码元数
据可以保持 `0.1.0`，release staging 会把 Git tag 版本注入包内的 `interface.json`。

默认 runtime profile 面向 MFAAvalonia：

- `create-maa-project --update maafw` 同步 MaaFramework 资产。
- `create-maa-project --update runtime:mfa` 同步 MFAAvalonia GUI runtime 资产。
- 生成的 `pnpm sync:runtime` 会执行二者；Agent 项目还会同步 Python runtime。
- Release job 通过 `CREATE_MAA_PROJECT_RUNTIME_PLATFORM=<os>-<arch>` 选择目标 runtime 资产。

默认 release artifact 覆盖 Windows、Linux、macOS 的 `x86_64` 和 `aarch64`。Windows 使用
`.zip`，Linux 和 macOS 使用 `.tar.gz`。

## JSON Report 模式

给 `create`、`sync`、`update`、`diff` 和 `doctor` 传入 `--report` 后，CLI 会在 stdout 输出唯一
一个机器可读 JSON 文档。Report 模式下 `--report` 强制非交互执行。进度、`Log:` 和人类可读
`Error:` 不会写入 stdout；封装工具可以忽略 stderr，除非需要诊断信息。

退出码 `0` 表示命令成功完成。退出码 `1` 表示命令失败，或 `doctor` 发现项目问题。JSON 中的
`exitCode` 与进程退出码一致。

```ts
type CliJsonReport = {
  schemaVersion: 1
  tool: 'create-maa-project'
  command: 'create' | 'sync' | 'update' | 'diff' | 'doctor'
  ok: boolean
  timestamp: string
  durationMs: number
  exitCode: 0 | 1
  executionId: string
  root: string
  logPath: string | null
  written: string[]
  skipped: string[]
  pending: Array<{ kind: string; reason: string; command: string }>
  changedManagedFiles: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }>
  changedUserFiles: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }>
  suggestedCommands: Array<{ command: string; description: string; autoRun: boolean }>
  git?: { initialized: boolean; committed: boolean; reason?: string }
  doctor?: { lines: string[] }
  diff?: { lines: string[] }
  error?: { message: string; code?: string }
}
```

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
  "skipped": [],
  "pending": [],
  "changedManagedFiles": [],
  "changedUserFiles": [],
  "suggestedCommands": [],
  "error": {
    "message": "Invalid version \"not-semver\". Use a SemVer version such as 0.1.0."
  }
}
```

## 发布本 CLI

推送 `v*` tag 会运行 `.github/workflows/release.yml`。workflow 会检查仓库、构建 npm 包、构建
Windows/Linux/macOS 的 `x86_64` 和 `aarch64` SEA 二进制、写出
`create-maa-project-manifest.json`、发布 GitHub Release assets、发布 npm，然后把 release
manifest digest 嵌入 PyPI wrapper 并通过 trusted publishing 发布。
