# {{displayName}}

由 create-maa-project 生成的 MaaFW 项目。

## 开发

项目入口配置为 `interface.json`，任务定义在 `tasks/`，资源位于 `resource/`。

如果根目录存在 `package.json`，说明已启用开发工具，可运行：

```bash
pnpm install
pnpm check
```

在 VS Code 中打开项目时，`.vscode/tasks.json` 会自动执行 `pnpm install --frozen-lockfile`。

未启用时，可按需运行 `create-maa-project --add dev-tools` 添加格式化、校验和编辑器配置。

## 发布

如果存在 `.github/workflows/release.yml`，推送 `v{{version}}` 这样的 tag 会触发发布。
未启用时，可运行 `create-maa-project --add github` 添加 CI 和 Release 自动化。

English documentation: [README.en.md](./README.en.md)
