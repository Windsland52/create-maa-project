# create-maa-project

English | [简体中文](https://github.com/Windsland52/create-maa-project/blob/main/README.md)

[![npm](https://img.shields.io/npm/v/create-maa-project)](https://www.npmjs.com/package/create-maa-project)
[![PyPI](https://img.shields.io/pypi/v/create-maa-project)](https://pypi.org/project/create-maa-project)
[![license](https://img.shields.io/github/license/Windsland52/create-maa-project)](./LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D22.13-green)
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

- [Scope](#scope)
- [Install The CLI](#install-the-cli)
- [Create A Project](#create-a-project)
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
- [Changelog](#changelog)
- [License](#license)

## Scope

| Handles                                                                                                                                           | Does not handle                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creating and maintaining project files: `create`, `--add`, `--sync`, `--update`                                                                   | Building, checking, packaging, or publishing the generated artifact — the generated project's dev-tools and GitHub workflows do that (`pnpm check`, `release:dry-run`, `package-smoke`, `release`)          |
| Acquiring assets and dependencies: OCR models, MaaFramework / MFAAvalonia runtimes, schemas, pnpm and uv dependencies                             | Writing your business content (pipelines, tasks, resources, custom logic): creation writes one starter template, and project-owned `once` files belong to the project — later commands never overwrite them |
| Backing up before every write, rolling back on failure, and exposing `--list-backups` / `--show-backup` / `--restore`                             | General template upgrades on an existing project (those need versioned migrations); legacy schemas are never rewritten implicitly, and a v1 migration requires an explicit `--sync config`                  |
| Read-only diagnostics: `--doctor` checks `maa-project.json`, `interface.json` and resource paths, lockfiles, enabled tooling, and OCR model files | Parsing runtime logs, diagnosing MaaFW at runtime, or finding the root cause of a recognition or task failure                                                                                               |
| Local `git init` and the initial commit, after the managed-file transaction completes                                                             | Pushing, tagging, creating a remote repository, or publishing a release                                                                                                                                     |
| Emitting a stable JSON report (`schemaVersion`, `CMP_*` error codes), with MCP and the Agent Skill sharing the same write path                    | Collecting telemetry or reporting usage data                                                                                                                                                                |

## Install The CLI

Node.js (>= 22.13) is required. The simplest setup is a global npm install:

```bash
npm install -g create-maa-project
```

You can also run it once without a global install:

```bash
npx create-maa-project@latest
```

The PyPI package is available for Python-based environments (npm remains the primary
distribution channel):

```bash
uvx create-maa-project
pipx run create-maa-project
```

## Create A Project

Run the CLI without flags and answer the prompts; press Enter to accept the default:

```bash
create-maa-project
```

The key choices:

- **Project type**: `pipeline` for a normal task/resource project; choose `agent` only when
  you need Python custom logic.
- **Control targets**: multi-select, defaults to `Adb`; the full list is in the
  [commands documentation](./docs/commands.en.md).
- **Repository setup**: the all / minimal / custom presets; "all" includes dev tools, GitHub
  automation, and community files, and the add-on list is in the
  [commands documentation](./docs/commands.en.md). Selections auto-complete their dependencies
  (`community`, for example, pulls in `github` and `dev-tools`); the
  `Add-ons required by dependencies:` line and the JSON report's `addons` field spell out the
  difference.
- **Git initialization**: defaults to no inside an existing Git repository, yes otherwise.

Ctrl+C always exits quietly with code `130`. After the project is created, run the read-only
diagnostic:

```bash
cd <project-folder>
create-maa-project --doctor
```

If the tool prints pending actions, run the suggested commands from the project root. Projects
with the `dev-tools` add-on can then run `pnpm check`. Prompt language is detected automatically
and can be forced with `--lang zh-CN|en`.

## Use With Agent Skills

This is the recommended way for AI coding agents to work with `create-maa-project`. The
repository bundles an agent skill in [`skills/create-maa-project`](./skills/create-maa-project)
adhering to the Agent Skills standard. It provides AI coding agents (such as Claude Code, Codex)
with structured workflows, parameter constraints, and diagnostic steps; the agent reads the
guidance and calls the same CLI commands a human would, so new CLI capabilities are available
immediately.

Install the skill using the [skills CLI](https://github.com/vercel-labs/skills) (omit `--agent`
for interactive detection of your installed AI tools):

```bash
npx skills add https://github.com/Windsland52/create-maa-project --skill create-maa-project --global
```

Once installed, your agent automatically follows the skill when scaffolding MaaFramework
projects, configuring add-ons, or running doctor diagnostics. See the
[Skills Documentation](./skills/README.md) for details.

## Use With An MCP Client

MCP is the alternative to the Agent Skill. Always prefer an explicit `--root` for the workspace
the MCP server may access. For JSON configuration examples (global install / `npx` / `uvx`),
tool calling conventions, and the `projectPath` rules, see the
[MCP documentation](./docs/mcp.en.md).

## Automatic Updates

The CLI includes an unobtrusive automatic update mechanism: it queries the npm registry for the
latest version at most once every 24 hours (1500ms timeout, silently falling back to the local
version when offline); when a newer release is detected, execution is handed off to a temporary
runtime of that version, and the globally installed Agent Skill is updated in the background
(once per release). Set `CREATE_MAA_PROJECT_AUTO_UPDATE=0` to disable everything (disabled by
default in CI; `=1` forces it on).

## Project Model

Project identity is split into two fields:

- `slug`: ASCII kebab-case ID used for repository names, package names, artifacts, and
  `interface.json` `name`.
- `displayName`: user-facing label used for `interface.json` `label`; it may be Chinese
  or any other display text.

The resource layout is fixed around `resource/base/` plus optional `resource/<pack>/` folders.
`interface.json` resource paths are generated in the order recorded in `maa-project.json`; later
packs have higher override priority in MaaFW resource lookup. Project-owned files are written
once at creation; afterwards only an explicit `--sync`, `--add`, or `--update` operation rewrites
the corresponding files.

## State and Safety

The committed state file is `maa-project.json` (user intent: project metadata, add-on choices,
resources, runtime channels, network mode, license, and Agent configuration). Local state lives
under `.create-maa-project/` (`backups/`, `cache/`, `logs/`, `run-locks/`), which generated
projects ignore by default.

Safety rules:

- Writes to configuration and generated files use an owner-identified project run lock; clear a
  lock left by an interrupted process with `--clear-stale-lock`.
- Managed files are registered in one operation backup before they are overwritten or created,
  and failed operations roll back automatically; `--list-backups`, `--show-backup <id>`, and
  `--restore <id> --dry-run` inspect and preview restores. `.git` is protected repository state
  and is excluded from backups.
- `--force` skips prompts but still keeps backups; `--yes` accepts creation defaults without
  prompting, but it is not `--force` and does not permit overwriting a non-empty target.
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

For the full creation options, the add-on / sync / update target lists, execution flags, and the
Git initialization and schema v1 migration behavior, see the
[Commands documentation](./docs/commands.en.md).

## Tooling

Generated repository tooling targets Node 22 (>= 22.13) and pnpm 11; the exact pnpm version is
pinned by the generated project's `packageManager`. Dev-tool projects include project-local
scripts for formatting, schema validation, and MaaFW checks, and the `github` add-on adds release
dry-run and runtime-sync scripts; agent projects add uv, Ruff, and Pyright checks. With the
`vscode` add-on, `.vscode/tasks.json` syncs dependencies when the project is opened in VS Code.
See the [commands documentation](./docs/commands.en.md#files-written-by-dev-tools) for which files
each add-on writes and how they are refreshed (`managed` / `once`).

OCR models are provisioned by cloning `MaaXYZ/MaaCommonAssets` as a `--depth 1` submodule and
copying `ppocr_v6/small` into `resource/base/model/ocr/`; inside a parent repository or without
local Git, the download mode is used instead, committing a sha256 `manifest.json`. Clone and
download failures record a pending action to be repaired later with
`create-maa-project --update ocr-models`. The two provisioning modes are detailed in the
[commands documentation](./docs/commands.en.md#the-two-ocr-provisioning-modes).

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
├── main.py
├── agent_runtime.py
├── custom/
└── utils/
pyproject.toml
uv.lock
requirements.txt
```

`agent/main.py` is the Agent entrypoint (including the Python version check) and
`agent/agent_runtime.py` registers the custom logic under `custom/`; local development prepares
dependencies with `uv sync`. Release packages ship their own Python runtime and dependencies
(python.org embeddable on Windows, python-build-standalone on macOS and Linux), so they never
depend on the Python installed on the user's machine. Runtime-local files such as `config/`,
`.venv/`, and `debug/` are not committed.

## Release and Runtime

Projects with the GitHub add-on include check, release and package-smoke workflows. Release
packaging is tag-driven: source metadata can stay at `0.1.0`, while the release package injects
the Git tag version into the staged `interface.json`; `package-smoke` builds and verifies packages
on push and pull requests using the same target matrix as the release, so packaging problems
surface long before a tag is pushed.

The default runtime profile targets [MFAAvalonia](https://github.com/MaaXYZ/MFAAvalonia):
`--update maafw` syncs MaaFramework assets, `--update runtime:mfa` syncs the MFAAvalonia GUI
runtime, and the generated `pnpm sync:runtime` runs both (agent projects additionally sync the
Python runtime). Default release artifacts cover Windows, Linux, and macOS on `x86_64` and
`aarch64`; Windows artifacts are `.zip`, Linux and macOS artifacts are `.tar.gz`.

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

Pass `--report` to `create`, `sync`, `update`, `doctor`, and the backup inspection/restore
commands to receive a single machine-readable JSON document on stdout. Report mode forces
non-interactive execution; progress, `Log:`, and human `Error:` text are not written to stdout.
Exit code `0` means success; `1` means failure or `doctor` findings. For the full report schema,
the stable `CMP_*` error codes, and a failure example, see the
[JSON Report documentation](./docs/json-report.en.md).

## Changelog

User-visible changes, fixes, and upgrade notes for each release are in
[CHANGELOG.md](./CHANGELOG.md); each GitHub Release body is taken from that file's section for
the version.

## License

[AGPL-3.0-or-later](./LICENSE)
