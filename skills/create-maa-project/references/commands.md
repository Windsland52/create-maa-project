# create-maa-project command reference

Canonical source: `create-maa-project --help` and the `src/args.ts` parser in the
create-maa-project repository. Re-check both when the CLI version moves.

## Modes

```text
create-maa-project [project] [creation options]
create-maa-project --add <addon> [add-on options]
create-maa-project --sync <target> [value]
create-maa-project --update <target>
create-maa-project --doctor [--report]
create-maa-project --list-backups [--report]
create-maa-project --show-backup <backup-id> [--report]
create-maa-project --restore <backup-id> [--dry-run] [--report]
create-maa-project --clean-cache
create-maa-project --mcp [--root <path>]
```

## Creation options

| Option                                     | Meaning                                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `--template <pipeline\|agent>`             | Initial template; `agent` adds Python scaffolding (uv, Ruff, Pyright)                                                  |
| `--slug <project-id>`                      | ASCII project identifier used in package/interface files                                                               |
| `--name <display-name>`                    | Human-readable project name                                                                                            |
| `--controller <kind[,kind...]>`            | MaaFW controllers: `Adb`, `Win32`, `MacOS`, `PlayCover`, `Gamepad`, `WlRoots` (default `Adb`)                          |
| `--license <AGPL-3.0-or-later\|MIT\|None>` | Project license                                                                                                        |
| `--network <auto\|official>`               | Asset download network mode                                                                                            |
| `--add <addon>`                            | Include an add-on during creation (repeatable)                                                                         |
| `--git` / `--no-git`                       | Enable or disable Git initialization and initial commit (default: initialize unless inside an existing Git repository) |
| `--force`                                  | Permit creation into an existing target directory                                                                      |
| `--allow-non-git-dir`                      | Permit a forced create into a non-Git directory                                                                        |
| `--allow-pending-commit`                   | Permit an initial commit with pending work                                                                             |
| `--skip-download`                          | Defer OCR/dependency downloads; they come back as `pending` entries                                                    |
| `--yes`                                    | Accept defaults without prompting                                                                                      |
| `--no-interactive`                         | Disable interactive creation prompts                                                                                   |
| `--version <semver>`                       | Project version (distinct from `-V`, the CLI version)                                                                  |

## Maintenance options

| Option                              | Meaning                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--add <addon>`                     | Add a capability to the current project                                                                            |
| `--label <name>`                    | Label for a `resource-pack` add-on                                                                                 |
| `--sync <target> [value]`           | Sync metadata: `config`, `metadata`, `display-name`, `version`, `license`, `github-url`, `network`                 |
| `--sync version --version <semver>` | Example: bump the version everywhere                                                                               |
| `--update <target>`                 | One of `schema`, `maafw`, `runtime:mfa`, `runtime:mxu`, `ocr-models`, `node-deps`, `python-deps`, `python-runtime` |
| `--doctor`                          | Diagnose the current project; exit 1 when findings exist                                                           |
| `--list-backups`                    | List managed-files backups, newest first                                                                           |
| `--show-backup <backup-id>`         | Show paths and per-entry actions of one backup                                                                     |
| `--restore <backup-id>`             | Restore managed files (`.git` excluded); snapshots current state first                                             |
| `--dry-run`                         | Preview `--restore` without changing files                                                                         |
| `--clean-cache`                     | Remove the local download cache                                                                                    |

Add-ons: `dev-tools`, `vscode`, `github`, `agent`, `resource-pack` (takes a positional slug),
`git-cliff`, `auto-format`, `optimize-images`, `community`, `dependabot`, `schema-sync`.

Dependencies are resolved automatically for both `create` and `--add`, so no manual ordering is
needed:

| Add-on                                                                                  | Requires                          |
| --------------------------------------------------------------------------------------- | --------------------------------- |
| `vscode`, `github`, `agent`                                                             | `dev-tools`                       |
| `agent`                                                                                 | `vscode` (ships the debug config) |
| `git-cliff`, `auto-format`, `optimize-images`, `community`, `dependabot`, `schema-sync` | `github` (and thus `dev-tools`)   |

`--add community` therefore enables `dev-tools`, `github`, and `community`. Never assume the
enabled set equals your arguments: the human output prints `Add-ons required by dependencies:`,
and the `addons` field of the JSON report carries `requested` / `enabled` / `autoEnabled`.

`vscode` is optional: `--add dev-tools` writes the toolchain without `.vscode/`, so a caller that
wants editor integration must pass `--add vscode` (or rely on the interactive presets, which enable
it). `--template agent` implies `dev-tools` and `vscode`.

### Files written by dev-tools

`--add dev-tools` writes 13 files:

| File                                                          | Refresh |
| ------------------------------------------------------------- | ------- |
| `.node-version` (pins Node 24)                                | managed |
| `.prettierrc.mjs`                                             | managed |
| `.prettierignore`                                             | once    |
| `package.json` (devDependencies, engines, packageManager)     | once    |
| `pnpm-workspace.yaml`                                         | once    |
| `tools/validate-schema.mjs`                                   | managed |
| `tools/schema/interface.schema.json` (upstream)               | managed |
| `tools/schema/interface_config.schema.json` (upstream)        | managed |
| `tools/schema/interface_import.schema.json` (upstream)        | managed |
| `tools/schema/pipeline.schema.json` (upstream)                | managed |
| `tools/schema/schema-manifest.json`                           | managed |
| `tools/schema/custom.action.schema.json` (edit this one)      | once    |
| `tools/schema/custom.recognition.schema.json` (edit this one) | once    |

`managed` files are refreshed by `--update` (for example `--update schema`); `once` files are
written at creation only and then belong to the project, so later commands never overwrite them.

### Files written by vscode

`--add vscode` writes three files under `.vscode/` (an Agent project adds `launch.json`):

| File                      | Refresh           |
| ------------------------- | ----------------- |
| `.vscode/settings.json`   | once              |
| `.vscode/extensions.json` | once              |
| `.vscode/tasks.json`      | managed           |
| `.vscode/launch.json`     | once (Agent only) |

A project without this add-on has no `.vscode/`, and `--doctor` reports `vscode-settings` as
skipped rather than failed.

Scripts in `package.json` follow the enabled add-ons: `check` always chains `format:check`,
`check:schema`, and `check:maa`; `github` adds `release:dry-run` and `sync:runtime`,
`schema-sync` adds `sync:schema`, `optimize-images` adds `optimize:images`, and Agent projects
add `format:py`, `lint:py`, `typecheck:py`, and `check:py`.

## Common options

Command modes are mutually exclusive: one mode per invocation. Options below list the modes
where each is valid; the parser rejects mismatched options instead of ignoring them.

| Option                     | Valid modes                                                                        | Meaning                                                              |
| -------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `--report`                 | create, doctor, sync, update, add, list-backups, show-backup, restore, clean-cache | One machine-readable JSON document on stdout; forces non-interactive |
| `--log-file <path>`        | same modes as `--report`                                                           | Write logs to a specific file                                        |
| `--verbose`                | same modes as `--report`                                                           | Record and print invocation diagnostics                              |
| `--no-color`               | same modes as `--report`                                                           | Disable color for this process and child tools                       |
| `--clear-stale-lock`       | create, sync, update, add, list-backups, show-backup, restore                      | Clear a stale project write lock (only when the report asks)         |
| `--lang <auto\|en\|zh-CN>` | create only                                                                        | Prompt language; machine-readable output stays English               |
| `--dry-run`                | only together with `--restore <backup-id>`                                         | Preview the restore without changing files                           |
| `-h`, `--help`             | standalone                                                                         | Show help                                                            |
| `-V`, `--cli-version`      | standalone                                                                         | Print the CLI version                                                |

## Environment variables

| Variable                                            | Effect                                                                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `CREATE_MAA_PROJECT_AUTO_UPDATE=0`                  | Disable automatic CLI runtime handoff and Skill sync (default: enabled unless in CI)                                        |
| `CREATE_MAA_PROJECT_CONFIG_DIR=<path>`              | Custom path for CLI updates and persistent cache state                                                                      |
| `CREATE_MAA_PROJECT_DOWNLOAD_ATTEMPTS=<n>`          | Download retry count                                                                                                        |
| `CREATE_MAA_PROJECT_MAX_DOWNLOAD_BYTES=<n>`         | Per-download size cap (default 1 GiB; declared manifest sizes win when stricter)                                            |
| `CREATE_MAA_PROJECT_MAX_ARCHIVE_ENTRIES=<n>`        | Per-archive entry cap (default 100000)                                                                                      |
| `CREATE_MAA_PROJECT_OCR_SOURCE=submodule\|download` | Creation-time OCR source (default: `submodule` when Git is available; `download` inside a parent repository or without Git) |
| `CREATE_MAA_PROJECT_OCR_ZIP_PATH=<path>`            | Serve OCR assets from a local zip (download source)                                                                         |
| `CREATE_MAA_PROJECT_OCR_MANIFEST_URL=<url-or-path>` | Use a verified OCR manifest (download source)                                                                               |
| `CREATE_MAA_PROJECT_RUNTIME_PLATFORM=all`           | Sync every desktop MaaFramework and MFAAvalonia runtime platform (release jobs use `<os>-<arch>`)                           |
| `CREATE_MAA_PROJECT_LANG=auto\|en\|zh-CN`           | Interactive prompt language                                                                                                 |

### OCR submodule recovery

When creating a project in a subdirectory of an existing Git repository, use the default
download source. Explicit `submodule` mode requires a Git worktree root or a directory
outside the parent repository. At the worktree root, existing `.gitmodules` entries are
preserved when the OCR mapping is added.

Submodule-clone failures (during creation or `--update ocr-models`) list the exits in the
error message: switch `ocr.source` to `download` (CDN hosts ppocr_v6 tiny/small/medium
only), configure a scoped GitHub mirror, or point `CREATE_MAA_PROJECT_OCR_ZIP_PATH` at a
local zip. Mirror example:

```bash
git config --global url."https://gh-proxy.com/https://github.com/MaaXYZ/MaaCommonAssets.git".insteadOf "https://github.com/MaaXYZ/MaaCommonAssets.git"
```

`--doctor` reports empty/missing `resource/base/model/ocr/{det.onnx,rec.onnx,keys.txt}` as
a finding with the `--update ocr-models` repair command.

## Generated project toolchain

Generated repositories target Node 24 and pnpm 11.5.1. `dev-tools` projects get local
formatting, schema validation, MaaFW checks, and release dry-run scripts; `agent` projects
additionally get uv, Ruff, and Pyright. Opening the generated project in VS Code syncs
dependencies through `.vscode/tasks.json` (`pnpm install --frozen-lockfile`; agent projects
also run `uv sync`).
