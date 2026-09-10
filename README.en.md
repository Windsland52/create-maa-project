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
4. **Project type**: `pipeline` for a normal task/resource project; choose `agent` only when
   you need Python custom logic.
5. **License**: defaults to AGPL-3.0-or-later.
6. **Control targets**: multi-select, defaults to Adb.
7. **Repository setup**: all / minimal / custom; every preset prints a one-line summary
   (all = dev tools, GitHub automation, and community files; minimal = no repository
   features). The add-ons All installs are `dev-tools`, `github`, `git-cliff`,
   `auto-format`, `optimize-images`, `schema-sync`, `community`, and `dependabot`; pick
   custom to review and toggle each one by name.
8. **Extra resource pack**: not added by default.
9. **Git repository initialization**: defaults to no inside an existing Git repository,
   yes otherwise.

Questions 8 and 9 take a single `y`/`n` key; Enter accepts the default. Prompt rows wrap to the
terminal width, and Ctrl+C always exits quietly with code `130` instead of printing `Error:`.

Custom repository features are indented by dependency: selecting a feature also selects the
features it requires, and clearing a required feature clears everything that depends on it, so
the checkboxes always show the final set. The rule is `github` and `agent` require `dev-tools`,
while `git-cliff`, `auto-format`, `optimize-images`, `community`, `dependabot`, and `schema-sync`
require `github`. The same resolution applies to `--add`, and both the
`Add-ons required by dependencies:` line and the `addons` field of the JSON report spell out the
difference between what you asked for and what was enabled.

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

MCP is the alternative to the Agent Skill, for environments where the agent has no shell access or where permissions must be controlled per tool inside the client. Always prefer an explicit `--root` for the workspace the MCP server may access.

For JSON configuration examples (global install / `npx` / `uvx`), tool calling conventions, and the `projectPath` rules, see the [MCP documentation](./docs/mcp.en.md).

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

Quick reference:

```bash
create-maa-project [name]                    # interactive project creation
create-maa-project [name] --template agent   # Python Agent project
create-maa-project --add dev-tools           # add an add-on to the current project
create-maa-project --sync version --version 0.2.0
create-maa-project --update ocr-models       # provision / update OCR models
create-maa-project --doctor                  # read-only project diagnostics
```

For the full creation options (`--slug`, `--controller`, `--license`, `--git`, ...), the add-on / sync / update target lists, execution flags, and the Git initialization and schema v1 migration behavior, see the [Commands documentation](./docs/commands.en.md).

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

| Variable                                            | Description                                                                                                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CREATE_MAA_PROJECT_OCR_SOURCE=submodule\|download` | Selects the creation-time OCR source.                                                                                                               |
| `CREATE_MAA_PROJECT_OCR_ZIP_PATH=<path>`            | Seeds OCR assets from a local zip (download fallback).                                                                                              |
| `CREATE_MAA_PROJECT_OCR_MANIFEST_URL=<url-or-path>` | Uses a verified OCR manifest (download fallback).                                                                                                   |
| `CREATE_MAA_PROJECT_DOWNLOAD_ATTEMPTS=<n>`          | Changes download retry attempts.                                                                                                                    |
| `CREATE_MAA_PROJECT_MAX_DOWNLOAD_BYTES=<n>`         | Per-download size cap, default 1 GiB; assets that declare a manifest size use the stricter declared value.                                          |
| `CREATE_MAA_PROJECT_MAX_ARCHIVE_ENTRIES=<n>`        | Per-archive entry count cap, default 100000.                                                                                                        |
| `CREATE_MAA_PROJECT_RUNTIME_PLATFORM=all`           | Syncs all desktop MaaFramework and MFAAvalonia runtime platforms.                                                                                   |
| `CREATE_MAA_PROJECT_LANG=auto\|en\|zh-CN`           | Controls interactive prompt language. `auto` only enables Chinese prompts for Chinese interactive terminals; machine-readable output stays English. |

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

Pass `--report` to `create`, `sync`, `update`, `doctor`, and the backup inspection/restore commands to receive a single machine-readable JSON document on stdout. Report mode forces non-interactive execution; progress, `Log:`, and human `Error:` text are not written to stdout. Exit code `0` means success; `1` means failure or `doctor` findings; the JSON `exitCode` matches the process exit code.

For the full report schema (including `doctor.checks` and backup operation results), the stable `CMP_*` error codes, and a failure example, see the [JSON Report documentation](./docs/json-report.en.md).

## License

[AGPL-3.0-or-later](./LICENSE)
