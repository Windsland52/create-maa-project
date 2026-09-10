# create-maa-project

English | [简体中文](https://github.com/Windsland52/create-maa-project/blob/main/README.md)

[![npm](https://img.shields.io/npm/v/create-maa-project)](https://www.npmjs.com/package/create-maa-project)
[![PyPI](https://img.shields.io/pypi/v/create-maa-project)](https://pypi.org/project/create-maa-project)
[![license](https://img.shields.io/github/license/Windsland52/create-maa-project)](./LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D24-green)
![platform](https://img.shields.io/badge/platform-win%20%7C%20linux%20%7C%20osx-blueviolet)

`create-maa-project` is the scaffold CLI for [MaaFramework](https://github.com/MaaXYZ/MaaFramework)
(MaaFW) application projects: answer a few questions and it generates a Pipeline or Python Agent
project that is ready to commit and build. Every choice made at creation time is recorded in the
committed `maa-project.json`; afterwards the project is maintained through explicit `--sync`,
`--add`, `--update`, and `--doctor` commands, so humans and AI tools can read and reproduce the
same result.

The recommended way for AI coding agents to use this tool is the
[Agent Skill](#use-with-agent-skills): the agent reads the workflow guidance and calls the same
CLI commands a human would. The CLI also ships an MCP stdio server as an alternative for
environments without shell access or where tool-level permission control is required. Both
paths share the same write paths, keeping behavior and rollback mechanisms consistent.

## Table of Contents

- [Install The CLI](#install-the-cli)
- [Create A Project Interactively](#create-a-project-interactively)
- [Use With Agent Skills](#use-with-agent-skills)
- [Use With An MCP Client](#use-with-an-mcp-client)
- [Automatic Updates](#automatic-updates)
- [Project Model](#project-model)
- [State and Safety](#state-and-safety)
- [Commands](#commands)
- [Tooling](#tooling)
- [Agent Projects](#agent-projects)
- [Release and Runtime](#release-and-runtime)
- [Troubleshooting](#troubleshooting)
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

The interactive flow asks the following questions in order; press Enter to accept the default:

1. **Project folder**: defaults to `maa-project`.
2. **Project ID**: only asked when the folder name cannot be converted into a valid ID
   automatically; otherwise the ID is derived and shown.
3. **Display name**: defaults to the folder name.
4. **License**: defaults to AGPL-3.0-or-later.
5. **Control targets**: multi-select, defaults to Adb.
6. **Project type**: `pipeline` for a normal task/resource project; choose `agent` only when
   you need Python custom logic.
7. **Repository setup**: all / minimal / custom presets.
8. **Extra resource pack**: not added by default.
9. **Git repository initialization**: defaults to no inside an existing Git repository,
   yes otherwise.

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

## Use With Agent Skills

This is the recommended way for AI coding agents to work with `create-maa-project`. The
repository bundles an agent skill in [`skills/create-maa-project`](./skills/create-maa-project)
adhering to the Agent Skills standard. It provides AI coding agents (such as Claude Code, Cursor,
Windsurf, GitHub Copilot, Antigravity, Cline, etc.) with structured workflows, parameter
constraints, diagnostic steps, and JSON report analysis; the agent reads the guidance and calls
the same CLI commands a human would, so new CLI capabilities are available immediately.

Install the skill using the [skills CLI](https://github.com/vercel-labs/skills):

```bash
# Install the create-maa-project skill globally across detected local agents
npx skills add https://github.com/Windsland52/create-maa-project --skill create-maa-project --global
```

Omit `--agent` for interactive detection of your installed AI tools. Once installed, your agent will automatically leverage the skill when scaffolding new MaaFramework projects, configuring add-ons, running doctor diagnostics, or performing backups and upgrades.

See the [Skills Documentation](./skills/README.md) for further details and local development workflows.

## Use With An MCP Client

MCP is the alternative to the Agent Skill, for environments where the agent has no shell access
or where permissions must be controlled per tool inside the client. It is not interactive by
itself: the agent should ask you for your requirements first and then call the matching tools
(see the calling conventions below). MCP tools share the same write paths as the CLI commands,
keeping behavior and rollback mechanisms consistent; new capabilities land in the CLI and the
Agent Skill first, and the MCP tool surface stays lean and stable.

Always prefer an explicit `--root` for the workspace the MCP server may access. A relative
root is resolved from the server process's startup directory; omitting it uses that directory.

If the CLI is installed globally, configure the MCP server like this:

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

If you do not want a global install, let the MCP client run it through `npx`:

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

For a Python-centric toolchain, let the MCP client launch it through `uvx`:

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

Typical agent request:

```text
Create a MaaFW project in ./MaaExample. Use a Pipeline project, Android controller,
and add dev-tools and GitHub workflows. Ask me before choosing optional add-ons.
```

Calling conventions:

- Before `create_project`, the agent should confirm with you: the project name, Pipeline or
  Python Agent, the controllers, the add-ons, and the resource pack folder name. The folder
  name is passed as `resourcePackSlug` (for example `extra` or `cn`) and is required when
  adding a resource pack; otherwise the tool rejects the call.
- The `add` tool takes either `addon` for a single add-on or an `addons` array for several
  add-ons in one call; pass exactly one of the two.
- The agent can call the read-only `get_project_context` tool first to confirm the server
  root and the project directory resolved from `projectPath`.
- After creating a child project, `doctor`, `sync`, `update`, `add`, `list_backups`,
  `show_backup`, `restore`, and `clean_cache` accept a relative `projectPath`. The path must
  resolve to a real directory under the MCP server root; absolute paths, `..`, and escaping
  symlinks are rejected.
- Before restoring, use `list_backups` to find a backup and `show_backup` to inspect it, then
  preview with `restore { backupId, dryRun: true }`; a preview never modifies project files.
  Backups and rollback are described under [State and Safety](#state-and-safety).

## Automatic Updates

To ensure the CLI runtime and Agent Skill instructions remain up-to-date, `create-maa-project` includes a lightweight, unobtrusive automatic update mechanism:

- **24-Hour Throttled Check**: The CLI queries the npm registry for the latest stable version at most once every 24 hours. A short network timeout (1500ms) guarantees that offline environments, proxies, or slow connections immediately and silently fall back to the installed local version without delaying commands.
- **Runtime Handoff**: When a newer stable version is detected, execution is transparently handed off to the latest runtime via `npm exec`, ensuring you always run the latest stable release.
- **Managed Skill Synchronization**: When a newer CLI release is detected, the CLI triggers `skills update create-maa-project --global --yes` once per release version in the background to update the global skill installation.
- **Environment Controls**:
    - `CREATE_MAA_PROJECT_AUTO_UPDATE=0`: Completely disables update checks, runtime handoff, and skill synchronization (automatically disabled in CI environments by default).
    - `CREATE_MAA_PROJECT_AUTO_UPDATE=1`: Explicitly forces auto-update on even in CI environments.

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

Git initialization is enabled by default: when the target is outside an existing Git repository, project creation (including non-interactive paths like `--yes`/`--no-interactive` and MCP without `git`) automatically runs `git init` and creates the initial commit; pass `--no-git` to disable it. If Git is not installed or `git init` fails, creation still succeeds and the reason is recorded in the `git` field of the JSON report.

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
When a generated project is opened in VS Code, `.vscode/tasks.json` syncs dependencies
automatically: pipeline projects run `pnpm install --frozen-lockfile`, agent projects
additionally run `uv sync`.

### OCR model provisioning

- Project creation clones `MaaXYZ/MaaCommonAssets` as a `--depth 1` submodule by default
  and copies the `ppocr_v6/small` OCR models into `resource/base/model/ocr/`. In submodule
  mode that directory is gitignored (models are derived files). The CLI creates or merges
  `.gitmodules`, preserving existing submodule mappings; the committed gitlink pins the model version.
- Projects created in a subdirectory of an existing Git repository default to downloaded,
  tracked OCR models. Explicit `CREATE_MAA_PROJECT_OCR_SOURCE=submodule` requires a Git
  worktree root or a directory outside the parent repository. Child projects do not edit
  the parent repository's `.gitmodules`.
- When local Git is unavailable (or `CREATE_MAA_PROJECT_OCR_SOURCE=download` is set
  explicitly), models are fetched from the download source instead: recorded in
  `manifest.json` with sha256 checksums, with model files tracked in version control.
- When the submodule clone fails, a pending action is recorded; run
  `create-maa-project --update ocr-models` later to recover. That command also initializes
  a registered but not-yet-fetched submodule automatically.
- `--doctor` checks that `det.onnx`/`rec.onnx`/`keys.txt` exist and are non-empty under
  `resource/base/model/ocr/` (fresh clones without provisioned models surface here).
- Runtime updates record the files installed by the tool; later updates only clean up files
  that the new version removed. Old files and the install record can both be restored through
  the operation's backup.
- Network or tool failures return pending actions for the current command with repair
  commands; recovery for common network problems is described under
  [Troubleshooting](#troubleshooting).

### Environment variables

| Variable                                            | Description                                                                                                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CREATE_MAA_PROJECT_OCR_SOURCE=submodule\|download` | Selects the creation-time OCR source.                                                                                                                 |
| `CREATE_MAA_PROJECT_OCR_ZIP_PATH=<path>`            | Seeds OCR assets from a local zip (download fallback).                                                                                                |
| `CREATE_MAA_PROJECT_OCR_MANIFEST_URL=<url-or-path>` | Uses a verified OCR manifest (download fallback).                                                                                                     |
| `CREATE_MAA_PROJECT_DOWNLOAD_ATTEMPTS=<n>`          | Changes download retry attempts.                                                                                                                      |
| `CREATE_MAA_PROJECT_MAX_DOWNLOAD_BYTES=<n>`         | Per-download size cap, default 1 GiB; assets that declare a manifest size use the stricter declared value.                                            |
| `CREATE_MAA_PROJECT_MAX_ARCHIVE_ENTRIES=<n>`        | Per-archive entry count cap, default 100000.                                                                                                          |
| `CREATE_MAA_PROJECT_RUNTIME_PLATFORM=all`           | Syncs all desktop MaaFramework and MFAAvalonia runtime platforms.                                                                                     |
| `CREATE_MAA_PROJECT_LANG=auto\|en\|zh-CN`           | Controls interactive prompt language. `auto` only enables bilingual prompts for Chinese interactive terminals; machine-readable output stays English. |

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

The default runtime profile targets [MFAAvalonia](https://github.com/MaaXYZ/MFAAvalonia):

- `create-maa-project --update maafw` syncs MaaFramework assets.
- `create-maa-project --update runtime:mfa` syncs MFAAvalonia GUI runtime assets.
- Generated `pnpm sync:runtime` runs both, plus Python runtime sync for Agent projects.
- Release jobs pass `CREATE_MAA_PROJECT_RUNTIME_PLATFORM=<os>-<arch>` for the target
  runtime asset.

Default release artifacts cover Windows, Linux, and macOS on `x86_64` and `aarch64`.
Windows artifacts are `.zip`; Linux and macOS artifacts are `.tar.gz`.

## Troubleshooting

**OCR model or asset downloads fail (restricted networks, proxies)**

- With the default v6 setup, switch `ocr.source` in `maa-project.json` to `download` to use
  the CDN (hosts ppocr_v6 tiny/small/medium only). For other model versions, configure a
  GitHub mirror and retry:

    ```bash
    git config --global url."https://gh-proxy.com/https://github.com/MaaXYZ/MaaCommonAssets.git".insteadOf "https://github.com/MaaXYZ/MaaCommonAssets.git"
    ```

    Then run `create-maa-project --update ocr-models`.

- On fully offline machines, use `CREATE_MAA_PROJECT_OCR_ZIP_PATH` to seed OCR assets from a
  local zip.

**Stale write lock (a leftover project run lock blocks commands)**

- After confirming that no other create-maa-project process is running, run
  `create-maa-project --clear-stale-lock`.

**Undoing a write**

- Use `--list-backups` to find a backup, preview with
  `--restore <backup-id> --dry-run`, then rerun without `--dry-run` to restore.

For other failures, start with the `--doctor` output and the logs under the project's
`.create-maa-project/logs/`.

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

Failure reports always carry a stable `CMP_*` command error code. If the underlying system
provides a native code such as `ENOENT`, it is kept in `causeCode` so callers do not depend
on OS-specific information.

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
        "message": "Invalid version \"not-semver\". Use a SemVer version such as 0.1.0.",
        "code": "CMP_SYNC_FAILED"
    }
}
```

## License

[AGPL-3.0-or-later](./LICENSE)
