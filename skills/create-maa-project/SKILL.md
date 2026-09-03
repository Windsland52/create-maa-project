---
name: create-maa-project
description: Scaffold and maintain MaaFW (MaaFramework) application projects with the create-maa-project CLI. Use when creating a new MaaFW pipeline or Python agent project, adding add-ons such as dev-tools, GitHub workflows, resource packs, or the Python agent template, syncing project metadata, updating MaaFramework or MFAAvalonia runtimes, OCR models, or dependencies, diagnosing a project with doctor, or inspecting and restoring backups. Trigger even when the user just says "新建一个 MAA 项目", "升级 runtime", or asks to repair an existing MaaFW project without naming the CLI.
---

# Create Maa Project

`create-maa-project` scaffolds new MaaFW application projects and maintains existing ones:
metadata sync, runtime/dependency updates, add-ons, backups, and diagnostics. Every write
command snapshots the files it manages before changing them, so the safe default is to let
the CLI act and then read its JSON report — never hand-edit generated files to fake a result.

## Start small

Before the first command, run `create-maa-project --cli-version`. Use the installed CLI rather
than a checkout's `dist/index.js` when an installed CLI exists.

Choose the smallest operation that answers the user's intent:

- New MaaFW project: `create-maa-project <path> --yes --no-interactive` with explicit template and add-on flags.
- Inspect project health or diagnose issues: `create-maa-project --doctor --report`.
- Single metadata update: `create-maa-project --sync <target> [value] --report`.
- Single runtime / dependency update: `create-maa-project --update <target> --report`.
- Add single capability: `create-maa-project --add <addon> --report`.
- Restore or preview backup: `create-maa-project --restore <id> --dry-run --report`.

## Run non-interactive and read the JSON report

Never drive this CLI through interactive prompts; an agent cannot answer them. Only
`create` prompts by default — run it with `--yes --no-interactive` (plus explicit
`--template`, `--slug`, `--name`, and so on, because accepted defaults may not be what the
user wants). Maintenance commands never prompt; just add `--report`:

```bash
create-maa-project --doctor --report
create-maa-project --update maafw --report
```

`--report` prints exactly one JSON document on stdout. Progress and human-readable errors go
to stderr, so parse stdout and only look at stderr when a failure is unclear. Exit code 0 is
success; exit code 1 is failure or doctor findings. `--report` also forces non-interactive
execution. Command modes are mutually exclusive — one mode per invocation — and several
options such as `--yes`, `--no-interactive`, `--force`, and `--lang` are valid only in
create mode; the report rejects mismatched flags with a `CMP_*` error instead of guessing.

Interpret the report like this (full schema in [references/json-report.md](references/json-report.md)):

- `ok` / `exitCode` — overall result; on failure `error.code` is a stable `CMP_*` code.
- `pending` — unfinished work, each entry carrying `reason` and a ready-made `command`.
  Run those commands (typically retried downloads or installs) before declaring success.
- `suggestedCommands` — next steps the CLI recommends; `autoRun: true` entries are safe to
  run immediately.
- `written` / `removed` / `skipped` — what actually changed on disk.
- `doctor.checks` — one entry per check with `pass`/`fail`/`skipped` plus `details`; fix
  failures from that evidence instead of guessing.
- `backupId` — snapshot created by this run; keep it until the result is verified.
- `git` — git initialization status (`initialized`, `committed`, and optional `reason`).
- `logPath` — full log; read it when the report alone does not explain a failure.

## Choosing a command

| Intent                                             | Command                                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| New MaaFW project                                  | `create-maa-project <path> --yes --no-interactive` plus creation options                |
| Python agent project                               | add `--template agent` to the create command                                            |
| Add a capability to an existing project            | `create-maa-project --add <addon>`                                                      |
| Change display name, version, license, GitHub URL  | `create-maa-project --sync <target> [value]`                                            |
| Update schemas, runtimes, OCR models, dependencies | `create-maa-project --update <target>`                                                  |
| Project state unclear or something broke           | `create-maa-project --doctor --report`                                                  |
| Undo a CLI change                                  | `--list-backups` → `--show-backup <id>` → `--restore <id> --dry-run` → `--restore <id>` |
| Free disk space                                    | `create-maa-project --clean-cache`                                                      |

## Safety model

- Every write command first snapshots managed files into a backup and reports its
  `backupId`. Restore is the rollback path: preview with `--restore <id> --dry-run`, then
  run it for real. Restores exclude `.git` and create a further backup of the current
  state first, so a restore is itself reversible.
- `--update all` does not exist by design. Run one specific target at a time so pending
  actions and logs stay attributable to what caused them.
- Legacy `maa-project.json` (schema v1) is never rewritten as a side effect of other
  commands. Migrate explicitly with `--sync config`, then verify with `--doctor`.
- Do not add `--force`, `--clear-stale-lock`, `--allow-non-git-dir`, or
  `--allow-pending-commit` unless the report's error message asks for that exact flag or
  the user explicitly agrees. Each one waives a protection the CLI enforces on purpose.
- Creating into a non-empty directory requires `--force`; confirm with the user first.

## Create specifics

```bash
create-maa-project maa-helper --template agent --slug maa-helper \
  --name "明日方舟助手" --controller Adb,Win32 --license MIT \
  --add dev-tools --add github --yes --no-interactive
```

- `<path>` creates a subfolder; `.` targets the current directory.
- `--template` is `pipeline` (default) or `agent` (adds Python agent scaffolding with uv).
- A normal repository setup is `--add dev-tools --add github`.
- `--controller` kinds: `Adb`, `Win32`, `MacOS`, `PlayCover`, `Gamepad`, `WlRoots`.
- `--license` is `AGPL-3.0-or-later`, `MIT`, or `None`.
- A resource pack takes a positional slug: `--add resource-pack extra --label "Extra Resource"`.
- Git repository initialization is enabled by default: creation (including non-interactive paths
  such as `--yes`/`--no-interactive` and MCP `create_project` without `git`) automatically
  runs `git init` and creates the initial commit unless the target is inside an existing Git
  repository. Pass `--no-git` (or `git=false` in MCP) to disable it. When Git is missing or
  `git init` fails, creation still succeeds, and details are reported in the `git` field of
  the report.

## Maintenance targets

- Add-ons (`--add`): `dev-tools`, `github`, `agent`, `resource-pack`, `git-cliff`,
  `auto-format`, `optimize-images`, `community`, `dependabot`, `schema-sync`.
- Sync (`--sync`): `config`, `metadata`, `display-name`, `version`, `license`,
  `github-url`, `network`.
- Update (`--update`): `schema`, `maafw`, `runtime:mfa`, `runtime:mxu`, `ocr-models`,
  `node-deps`, `python-deps`, `python-runtime`.

Updates download assets when the network allows. On constrained networks use
`--skip-download` at create time, or cap downloads with `CREATE_MAA_PROJECT_MAX_DOWNLOAD_BYTES`;
treat the resulting `pending` entries as follow-up work, not failures to paper over.

## MCP mode

When the host is an MCP client rather than a shell agent, `create-maa-project --mcp`
exposes the same operations as MCP tools (`create_project`, `sync`, `update`, `add`,
`doctor`, `list_backups`, `show_backup`, `restore`, `clean_cache`). Prefer those tools in
that setting; the CLI guidance above — one target at a time, read the report, restore via
backups — applies unchanged.

## Progressive references

Read additional material only when reaching that specific branch:

- Full command reference, valid modes, add-on details, and environment variables:
  [references/commands.md](references/commands.md).
- Complete JSON report schema, exit codes, backup inspection shapes, and error-handling recipes:
  [references/json-report.md](references/json-report.md).
