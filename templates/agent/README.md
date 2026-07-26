# {{displayName}}

由 create-maa-project 生成的 MaaFW Python Agent 项目。

## 开发

```bash
uv sync
uv run python agent/bootstrap.py
```

如果根目录存在 `package.json`，还可运行 `pnpm install`、`pnpm check` 和 `pnpm check:py`
使用生成的格式化与校验工具。

Agent 入口在 `agent/main.py`，启动前的 Python 版本和依赖检查在 `agent/bootstrap.py`。
Agent runtime 在 `agent/agent_runtime.py`，会导入 `agent/custom/action`、`agent/custom/reco`
和 `agent/custom/sink` 中的模块并注册自定义逻辑。PI 环境变量、参数解析、日志和路径工具在
`agent/utils/`。
VS Code Maa Support 插件通过 `uv run python agent/bootstrap.py` 启动 AgentServer；
调试会使用 `.vscode/launch.json` 中的 `Maa Agent: Debug` 配置，映射在
`maatools.config.mts`。

## 发布

如果存在 `.github/workflows/release.yml`，推送 `v{{version}}` 这样的 tag 会触发发布。
未启用时，可运行 `create-maa-project --add github` 添加 CI 和 Release 自动化。

English documentation: [README.en.md](./README.en.md)
