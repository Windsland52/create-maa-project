# create-maa-project

English | [简体中文](./README.zh-CN.md)

`create-maa-project` is the scaffold and maintenance CLI for new MaaFW application
projects. It creates deterministic Pipeline or Python Agent projects, records project
intent in committed state files, and provides update, sync, diff, doctor, and JSON report
interfaces for humans and tool wrappers.

The CLI also ships an MCP stdio server. MCP tools call the same internal write paths as
the CLI, so backups, locks, hashes, pending actions, and JSON reports stay consistent.

## Install The CLI

The simplest setup is the npm CLI. Install Node.js first, then install
`create-maa-project` globally:

```bash
npm install -g create-maa-project
```

You can also run it once without a global install:

```bash
npx create-maa-project@latest
```

The PyPI package is available for Python-based environments, but npm is the primary
distribution channel:

```bash
uvx create-maa-project
pipx run create-maa-project
```

## Create A Project Interactively

For a first project, run the CLI without flags and answer the prompts:

```bash
create-maa-project
```

If you used `npx`, run:

```bash
npx create-maa-project@latest
```

The interactive flow asks for the project name, project type, controller targets, and
optional add-ons. Choose `pipeline` for a normal task/resource project. Choose `agent`
only when you need Python custom logic.

After the project is created:

```bash
cd <project-folder>
create-maa-project --doctor
```

If the tool prints pending actions, run the suggested commands from the project root.
Projects with dev tools can then run:

```bash
pnpm check
```

If automatic language detection does not match your terminal, force the prompt language:

```bash
create-maa-project --lang zh-CN
create-maa-project --lang en
```

## Use With An MCP Client

MCP is useful when an AI coding agent should create or maintain the project for you. It is
not interactive by itself: the agent should ask you for the project name, whether you want
a Pipeline or Python Agent project, which add-ons to include, and any resource pack folder
name before it calls the MCP tool.

If the CLI is installed globally, configure the MCP server like this:

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

If you do not want a global install, let the MCP client run it through `npx`:

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

Set `cwd` to the parent directory when creating a new project. Set `cwd` to an existing
MaaFW project root when running `doctor`, `diff`, `sync`, `update`, `add`,
`accept_changes`, `restore`, or `clean_cache`.

Typical agent request:

```text
Create a MaaFW project in ./MaaExample. Use a Pipeline project, Android controller,
and add dev-tools and GitHub workflows. Ask me before choosing optional add-ons.
```

If the agent adds a resource pack, it must pass a `resourcePackSlug` such as `extra` or
`cn`; otherwise the MCP tool will reject the call.

## Project Model

Project identity is split into two fields:

- `slug`: ASCII kebab-case ID used for repository names, package names, artifacts, and
  `interface.json` `name`.
- `displayName`: user-facing label used for `interface.json` `label`; it may be Chinese
  or any other display text.

A full repository/tooling project can include:

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

The resource layout is fixed around `resource/base/` plus optional `resource/<pack>/`
folders. `interface.json` resource paths are generated in the order recorded in
`maa-project.json`; later packs have higher override priority in MaaFW resource lookup.

The CLI creates project-owned files such as `interface.json`, `package.json`, `tasks/`,
`resource/`, README, and license once. Later updates do not treat those as managed
template baselines unless a specific `--sync` or `--add` operation rewrites a supported
structured field.

## State and Safety

Committed state:

- `maa-project.json`: user intent, including project metadata, feature/add-on choices,
  resources, runtime channels, network mode, license, and Agent configuration.
- `maa-project.lock.json`: resolved state, pending actions, template version, and managed
  file hashes.

Local state lives under `.create-maa-project/` and is ignored by generated projects:

```text
.create-maa-project/
├── backups/
├── baselines/
├── cache/
├── logs/
└── run.lock
```

Safety rules:

- Writes to config, lock, and managed files use a project write lock.
- Files are backed up before overwrites.
- `--force` skips prompts but still keeps backups.
- `--yes` is not the same as `--force`.
- Non-empty non-Git targets require explicit `--force --allow-non-git-dir`.
- `--doctor` and `--diff` are read-only.
- `--accept-changes [path...]` accepts current managed-file contents as the new local
  baseline; it does not restore the official template.

Managed files are tool-owned files such as workflows, schema baselines, generated release
scripts, and project checks. If they drift, `--diff` shows the change and `--doctor` gives
an actionable repair or accept command.

## Commands

Common create options:

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

Supported `--controller` targets: `Adb`, `Win32`, `MacOS`, `PlayCover`, `Gamepad`,
`WlRoots`. Comma-separated for multiple targets. Default is `Adb`.

Add-ons:

```bash
create-maa-project --add dev-tools
create-maa-project --add github
create-maa-project --add agent
create-maa-project --add resource-pack extra --label "Extra Resource"
create-maa-project --add git-cliff
create-maa-project --add auto-format
create-maa-project --add optimize-images
create-maa-project --add community
create-maa-project --add dependabot
create-maa-project --add schema-sync
```

Metadata sync:

```bash
create-maa-project --sync metadata
create-maa-project --sync display-name --name "New Display Name"
create-maa-project --sync version --version 0.2.0
create-maa-project --sync license --license MIT
create-maa-project --sync github-url https://github.com/MaaXYZ/MaaExample
create-maa-project --sync network --network official
```

Updates:

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

`--update all` is intentionally unsupported. Run explicit updates so pending actions and
logs stay clear.

Diagnostics and maintenance:

```bash
create-maa-project --doctor
create-maa-project --doctor --report
create-maa-project --diff
create-maa-project --accept-changes [path...]
create-maa-project --restore <backup-id>
create-maa-project --clean-cache
```

Useful execution flags:

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

## Tooling

Generated repository tooling targets Node 24 and pnpm 11.5.1. Dev-tool projects include
project-local scripts for formatting, schema validation, MaaFW checks, project state
linting, and release dry-runs. Agent projects add uv, Ruff, Pyright, and Python checks.

Asset and dependency operations are explicit and recoverable:

- Project creation tries OCR download and `pnpm install` when relevant.
- Network or tool failures leave committed pending actions with repair commands.
- `CREATE_MAA_PROJECT_DOWNLOAD_ATTEMPTS=<n>` changes download retry attempts.
- `CREATE_MAA_PROJECT_OCR_ZIP_PATH=<path>` seeds OCR assets from a local zip.
- `CREATE_MAA_PROJECT_OCR_MANIFEST_URL=<url-or-path>` uses a verified OCR manifest.
- `CREATE_MAA_PROJECT_RUNTIME_PLATFORM=all` syncs all desktop MaaFramework and
  MFAAvalonia runtime platforms.
- `CREATE_MAA_PROJECT_LANG=auto|en|zh-CN` controls interactive prompt language.
  `auto` only enables Chinese prompts for Chinese interactive terminals; machine-readable
  output stays English.

## Agent Projects

`--template agent` or `--add agent` adds a Python Agent scaffold on top of the Pipeline
project:

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

The generated bootstrap handles local runtime setup, dependency checks, debug logging, and
starting `agent/main.py`. Runtime-local files such as `config/pip_config.json`, `.venv/`,
and `debug/` are ignored instead of committed.

## Release and Runtime

Projects with the GitHub add-on include check and release workflows. Release packaging is
tag-driven: source metadata can stay at `0.1.0`, while the release package injects the Git
tag version into the staged `interface.json`.

The default runtime profile targets MFAAvalonia:

- `create-maa-project --update maafw` syncs MaaFramework assets.
- `create-maa-project --update runtime:mfa` syncs MFAAvalonia GUI runtime assets.
- Generated `pnpm sync:runtime` runs both, plus Python runtime sync for Agent projects.
- Release jobs pass `CREATE_MAA_PROJECT_RUNTIME_PLATFORM=<os>-<arch>` for the target
  runtime asset.

Default release artifacts cover Windows, Linux, and macOS on `x86_64` and `aarch64`.
Windows artifacts are `.zip`; Linux and macOS artifacts are `.tar.gz`.

## JSON Report Mode

Pass `--report` to make `create`, `sync`, `update`, `diff`, and `doctor` emit a single
machine-readable JSON document on stdout. In report mode, `--report` forces
non-interactive execution. Progress, `Log:`, and human `Error:` text are not written to
stdout; wrappers may ignore stderr unless they want diagnostics.

Exit code `0` means the command completed successfully. Exit code `1` means the command
failed, or `doctor` found project problems. The JSON `exitCode` field matches the process
exit code.

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

Example failure report:

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

## Releasing This CLI

Pushing a `v*` tag runs `.github/workflows/release.yml`. The workflow checks the repo,
builds the npm package, builds SEA binaries for Windows/Linux/macOS on `x86_64` and
`aarch64`, writes `create-maa-project-manifest.json`, publishes GitHub Release assets,
publishes npm, then builds the PyPI wrapper with the release manifest digest embedded and
publishes it through trusted publishing.
