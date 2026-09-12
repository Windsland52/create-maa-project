English | [简体中文](./commands.md) | [Back to README](../README.en.md)

# Commands

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

The generated `interface.json` carries MaaFW's own controller types: `Adb`, `Win32`, `MacOS`,
`PlayCover`, `Gamepad` and `Linux` for the `WlRoots` target (a wlroots desktop app on Linux).
Each target becomes one entry: `name` is the controller ID (e.g. `Adb`), `label` the display text
(e.g. `Android / Emulator`), and `type` the value above.

Git initialization is enabled by default: when the target is outside an existing Git repository, project creation (including non-interactive paths like `--yes`/`--no-interactive` and MCP without `git`) automatically runs `git init` and creates the initial commit; pass `--no-git` to disable it. If Git is not installed or `git init` fails, creation still succeeds and the reason is recorded in the `git` field of the JSON report.

Add-ons:

```bash
create-maa-project --add dev-tools
create-maa-project --add vscode
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

Add-on dependencies are resolved automatically, so no manual ordering is required:

- `vscode`, `github`, and `agent` require `dev-tools`;
- `agent` also requires `vscode`, because Agent projects ship the `Maa Agent: Debug` launch config;
- `git-cliff`, `auto-format`, `optimize-images`, `community`, `dependabot`, and `schema-sync`
  require `github` (and therefore `dev-tools`).

For example, `create-maa-project --add community` also enables `dev-tools` and `github`. The
human-readable output prints `Add-ons required by dependencies:`, and the `addons` field of the
JSON report carries `requested` / `enabled` / `autoEnabled`.

`vscode` is optional: `--add dev-tools` writes only the toolchain and no longer creates `.vscode/`.
Add `--add vscode` when you want the editor integration. The interactive `All` preset includes it,
while the Custom repository-feature list leaves it unchecked by default.

### Files written by dev-tools

`--add dev-tools` writes 13 files:

| File                                          | Purpose                                                      | Refresh |
| --------------------------------------------- | ------------------------------------------------------------ | ------- |
| `.node-version`                               | Pins Node 22                                                 | managed |
| `.prettierrc.mjs`                             | Prettier config (MaaFW sort and multiline-array plugins)     | managed |
| `.prettierignore`                             | Ignores generated schema baselines and project-owned sources | once    |
| `package.json`                                | devDependencies, `engines.node >= 22.13`, `packageManager`   | once    |
| `pnpm-workspace.yaml`                         | pnpm workspace config                                        | once    |
| `tools/validate-schema.mjs`                   | Validation script used by `check:schema`                     | managed |
| `tools/schema/interface.schema.json`          | Upstream MaaFW baseline (interface)                          | managed |
| `tools/schema/interface_config.schema.json`   | Upstream MaaFW baseline (interface config)                   | managed |
| `tools/schema/interface_import.schema.json`   | Upstream MaaFW baseline (interface import)                   | managed |
| `tools/schema/pipeline.schema.json`           | Upstream MaaFW baseline (pipeline)                           | managed |
| `tools/schema/schema-manifest.json`           | Schema version manifest                                      | managed |
| `tools/schema/custom.action.schema.json`      | Custom action schema, meant to be edited by the project      | once    |
| `tools/schema/custom.recognition.schema.json` | Custom recognition schema, meant to be edited by the project | once    |

`managed` files are refreshed by `--update` (for example `--update schema`); `once` files are
written at creation only and then belong to the project, so later commands never overwrite them.

### Files written by vscode

`--add vscode` writes three files under `.vscode/` (an Agent project adds `launch.json`). They
refer to dev-tools artifacts (the Prettier formatter, `tools/schema/*`, `pnpm install`), which is
why the add-on requires dev-tools:

| File                      | Purpose                                                             | Refresh |
| ------------------------- | ------------------------------------------------------------------- | ------- |
| `.vscode/settings.json`   | formatOnSave, LF, jsonc associations, schema map, default formatter | once    |
| `.vscode/extensions.json` | Recommended extensions (Prettier, MaaFW; Agent adds Pylance)        | once    |
| `.vscode/tasks.json`      | Syncs dependencies when the project is opened                       | managed |
| `.vscode/launch.json`     | Agent projects only: the `Maa Agent: Debug` launch config           | once    |

A project without this add-on has no `.vscode/`, and `--doctor` reports `vscode-settings` as
skipped rather than failed.

Scripts in `package.json` follow the enabled add-ons: `check` always chains `format:check`,
`check:schema`, and `check:maa`; `github` adds `release:dry-run` and `sync:runtime`,
`schema-sync` adds `sync:schema`, `optimize-images` adds `optimize:images`, and Agent projects
add `format:py`, `lint:py`, `typecheck:py`, and `check:py`.

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

### The two OCR provisioning modes

Which mode creation uses depends on whether **Git is available on the machine**, not on
`--git`/`--no-git` (that flag only controls whether the project runs `git init`):

| Git at creation | `.gitmodules` | `ocr` in `maa-project.json` | `resource/base/model/ocr/`             |
| --------------- | ------------- | --------------------------- | -------------------------------------- |
| available       | written       | `{"source":"submodule",…}`  | added to `.gitignore` (models derived) |
| unavailable     | not written   | **no `ocr` key at all**     | `manifest.json` with sha256, committed |

So the same create command can produce structurally different projects on different machines,
while both report the same exit code and file count. Set `CREATE_MAA_PROJECT_OCR_SOURCE=submodule`
or `=download` to pin the mode instead of depending on the environment.

Note: when Git is available, `.gitmodules` is written even with `--no-git`, before any `.git`
directory exists. It is the submodule declaration for a later `git init`, not a defect; delete it
if you do not want it.

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
