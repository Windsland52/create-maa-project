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

Add-ons: `dev-tools`, `github`, `agent`, `resource-pack` (takes a positional slug),
`git-cliff`, `auto-format`, `optimize-images`, `community`, `dependabot`, `schema-sync`.

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

| Variable                                            | Effect                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `CREATE_MAA_PROJECT_AUTO_UPDATE=0`                  | Disable automatic CLI runtime handoff and Skill sync (default: enabled unless in CI)              |
| `CREATE_MAA_PROJECT_CONFIG_DIR=<path>`              | Custom path for CLI updates and persistent cache state                                            |
| `CREATE_MAA_PROJECT_DOWNLOAD_ATTEMPTS=<n>`          | Download retry count                                                                              |
| `CREATE_MAA_PROJECT_MAX_DOWNLOAD_BYTES=<n>`         | Per-download size cap (default 1 GiB; declared manifest sizes win when stricter)                  |
| `CREATE_MAA_PROJECT_MAX_ARCHIVE_ENTRIES=<n>`        | Per-archive entry cap (default 100000)                                                            |
| `CREATE_MAA_PROJECT_OCR_ZIP_PATH=<path>`            | Serve OCR assets from a local zip                                                                 |
| `CREATE_MAA_PROJECT_OCR_MANIFEST_URL=<url-or-path>` | Use a verified OCR manifest                                                                       |
| `CREATE_MAA_PROJECT_RUNTIME_PLATFORM=all`           | Sync every desktop MaaFramework and MFAAvalonia runtime platform (release jobs use `<os>-<arch>`) |
| `CREATE_MAA_PROJECT_LANG=auto\|en\|zh-CN`           | Interactive prompt language                                                                       |

## Generated project toolchain

Generated repositories target Node 24 and pnpm 11.5.1. `dev-tools` projects get local
formatting, schema validation, MaaFW checks, and release dry-run scripts; `agent` projects
additionally get uv, Ruff, and Pyright. Opening the generated project in VS Code syncs
dependencies through `.vscode/tasks.json` (`pnpm install --frozen-lockfile`; agent projects
also run `uv sync`).
