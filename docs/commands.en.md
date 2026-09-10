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
