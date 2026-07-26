# create-maa-project

English | [简体中文](https://github.com/Windsland52/create-maa-project/blob/main/README.md)

[![npm](https://img.shields.io/npm/v/create-maa-project)](https://www.npmjs.com/package/create-maa-project)
[![PyPI](https://img.shields.io/pypi/v/create-maa-project)](https://pypi.org/project/create-maa-project)
[![license](https://img.shields.io/github/license/Windsland52/create-maa-project)](./LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D24-green)
![platform](https://img.shields.io/badge/platform-win%20%7C%20linux%20%7C%20osx-blueviolet)

`create-maa-project` is the scaffold and maintenance CLI for new MaaFW application
projects. It creates deterministic Pipeline or Python Agent projects, records project
intent in committed configuration, and provides explicit update, sync, doctor, and JSON report
interfaces for humans and tool wrappers.

The CLI also ships an MCP stdio server. MCP tools call the same internal write paths as
the CLI, so backups, run locks, per-command pending actions, and JSON reports stay consistent.

## Table of Contents

- [Install The CLI](#install-the-cli)
- [Create A Project Interactively](#create-a-project-interactively)
- [Use With An MCP Client](#use-with-an-mcp-client)
- [Project Model](#project-model)
- [State and Safety](#state-and-safety)
- [Commands](#commands)
- [Tooling](#tooling)
- [Agent Projects](#agent-projects)
- [Release and Runtime](#release-and-runtime)
- [JSON Report Mode](#json-report-mode)
- [License](#license)

## Install The CLI

The simplest setup is the npm CLI. Install Node.js (>= 24) first, then install
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
            ]
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
            ]
        }
    }
}
```

For a Python-centric toolchain, let the MCP client launch it through `uvx`:

```json
{
    "mcpServers": {
        "create-maa-project": {
            "command": "uvx",
            "args": [
                "create-maa-project",
                "--mcp"
            ]
        }
    }
}
```

Typical agent request:

```text
Create a MaaFW project in ./MaaExample. Use a Pipeline project, Android controller,
and add dev-tools and GitHub workflows. Ask me before choosing optional add-ons.
```

If the agent adds a resource pack, it must pass a `resourcePackSlug` such as `extra` or
`cn`; otherwise the MCP tool will reject the call.
After creating a child project, the agent can pass a relative `projectPath` to `doctor`,
`sync`, `update`, `add`, `restore`, and `clean_cache`. The path must resolve to a real
directory under the MCP server root; absolute paths, `..`, and escaping symlinks are rejected.

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
`resource/`, README, and license once. After creation, only an explicit `--sync`, `--add`,
or concrete `--update` operation rewrites the corresponding files. General template upgrades
should use versioned migrations.

## State and Safety

Committed state:

- `maa-project.json`: user intent, including project metadata, feature/add-on choices,
  resources, runtime channels, network mode, license, and Agent configuration.

Local state lives under `.create-maa-project/` and is ignored by generated projects:

```text
.create-maa-project/
├── backups/
├── cache/
├── logs/
└── run-locks/
```

Safety rules:

- Writes to configuration and generated files use an owner-identified project run lock;
  use `--clear-stale-lock` to clear a lock left by an interrupted process.
- Managed files are registered in one operation backup before they are overwritten or
  created. Failed operations roll back automatically, and successful operations report a
  backup id that can be restored later.
- `--list-backups` and `--show-backup <id>` inspect backups. `--restore <id> --dry-run`
  lists restore/remove actions without changing files.
- `.git` is protected repository state and is excluded from managed-file backups.
- `--force` skips prompts but still keeps backups.
- `--yes` accepts creation defaults without prompting, but it is not `--force` and does not
  permit overwriting a non-empty target.
- Non-empty non-Git targets require explicit `--force --allow-non-git-dir`.
- `--doctor` is read-only and checks the current project files directly.

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
create-maa-project --sync config
create-maa-project --sync metadata
create-maa-project --sync display-name --name "New Display Name"
create-maa-project --sync version --version 0.2.0
create-maa-project --sync license --license MIT
create-maa-project --sync github-url https://github.com/MaaXYZ/MaaExample
create-maa-project --sync network --network official
```

Other maintenance commands never rewrite a legacy `maa-project.json` implicitly. For schema v1,
run `create-maa-project --sync config` explicitly; the migration creates a project backup that can
be rolled back with `--restore`.

Updates:

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

`--update all` is intentionally unsupported. Run explicit updates so pending actions and
logs stay clear.

Diagnostics and maintenance:

```bash
create-maa-project --doctor
create-maa-project --doctor --report
create-maa-project --list-backups
create-maa-project --show-backup <backup-id>
create-maa-project --restore <backup-id> --dry-run
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
- Network or tool failures return pending actions for the current command with repair commands.
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

Pass `--report` to make `create`, `sync`, `update`, `doctor`, and backup inspection/restore
commands emit a single machine-readable JSON document on stdout. In report mode,
`--report` forces non-interactive execution. Progress, `Log:`, and human `Error:` text are
not written to stdout; wrappers may ignore stderr unless they want diagnostics.

Exit code `0` means the command completed successfully. Exit code `1` means the command
failed, or `doctor` found project problems. The JSON `exitCode` field matches the process
exit code.

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
    command: "create" | "sync" | "update" | "doctor" | "backup" | "clean-cache";
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
    doctor?: {lines: string[]};
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
    error?: {message: string; code?: string};
};
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
    "removed": [],
    "skipped": [],
    "pending": [],
    "suggestedCommands": [],
    "error": {
        "message": "Invalid version \"not-semver\". Use a SemVer version such as 0.1.0."
    }
}
```

## License

[AGPL-3.0-or-later](./LICENSE)
