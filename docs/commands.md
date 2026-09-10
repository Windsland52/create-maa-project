[English](./commands.en.md) | 简体中文 | [返回 README](../README.md)

# 命令

常用创建选项：

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

可用的控制目标：`Adb`、`Win32`、`MacOS`、`PlayCover`、`Gamepad`、`WlRoots`。默认为 `Adb`。

Git 初始化默认开启：目标不在已有 Git 仓库内时，创建（含 `--yes`/`--no-interactive` 和 MCP 未传 `git` 的非交互路径）会自动 `git init` 并做首次提交；`--no-git` 可显式关闭。Git 未安装或 `git init` 失败时创建仍然成功，具体原因写入 JSON report 的 `git` 字段。

增量能力：

```bash
create-maa-project --add dev-tools
create-maa-project --add github
create-maa-project --add agent
create-maa-project --add resource-pack extra --label "额外资源"
create-maa-project --add git-cliff
create-maa-project --add auto-format
create-maa-project --add optimize-images
create-maa-project --add community
create-maa-project --add dependabot
create-maa-project --add schema-sync
```

add-on 依赖会被自动补全，无需手动按顺序添加：

- `github`、`agent` 依赖 `dev-tools`；
- `git-cliff`、`auto-format`、`optimize-images`、`community`、`dependabot`、`schema-sync` 依赖 `github`（因而也依赖 `dev-tools`）。

例如 `create-maa-project --add community` 实际会启用 `dev-tools`、`github`、`community`。
人类可读输出会打印 `Add-ons required by dependencies:`，JSON report 的 `addons` 字段给出
`requested` / `enabled` / `autoEnabled`。

元数据同步：

```bash
create-maa-project --sync config
create-maa-project --sync metadata
create-maa-project --sync display-name --name "新显示名"
create-maa-project --sync version --version 0.2.0
create-maa-project --sync license --license MIT
create-maa-project --sync github-url https://github.com/MaaXYZ/MaaExample
create-maa-project --sync network --network official
```

旧版 `maa-project.json` 不会在其他维护命令中被静默改写。遇到 schema v1 时，请显式运行
`create-maa-project --sync config`；迁移会进入项目备份，可用 `--restore` 回退。

更新：

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

`--update all` 故意不支持。显式执行具体更新可以让 pending action 和日志更清楚。

诊断和维护：

```bash
create-maa-project --doctor
create-maa-project --doctor --report
create-maa-project --list-backups
create-maa-project --show-backup <backup-id>
create-maa-project --restore <backup-id> --dry-run
create-maa-project --restore <backup-id>
create-maa-project --clean-cache
```

常用执行控制：

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
