[English](./mcp.en.md) | 简体中文 | [返回 README](../README.md)

# 配合 MCP Client 使用

MCP 是 Agent Skill 之外的替代接入方式，适合 agent 没有 shell 权限、或需要在 client 中按 tool 粒度管控权限的环境。MCP 本身不是交互式的：agent 应先向你问清需求，再调用对应 tool（见下文调用约定）。MCP tools 与 CLI 命令共用同一条写入路径，行为和回滚机制保持一致；新能力优先通过 CLI 与 Agent Skill 提供，MCP tool 面保持精简稳定。

启动 MCP server 时建议始终用 `--root` 显式指定允许 MCP 操作的工作区；相对的 `--root` 按 MCP server 启动时的当前目录解析，省略时默认使用当前目录。

如果已经全局安装 CLI，可以这样配置 MCP server：

```json
{
    "mcpServers": {
        "create-maa-project": {
            "command": "create-maa-project",
            "args": [
                "--mcp",
                "--root",
                "/absolute/path/to/workspace"
            ]
        }
    }
}
```

如果不想全局安装，可以让 MCP client 通过 `npx` 启动：

```json
{
    "mcpServers": {
        "create-maa-project": {
            "command": "npx",
            "args": [
                "-y",
                "create-maa-project@latest",
                "--mcp",
                "--root",
                "/absolute/path/to/workspace"
            ]
        }
    }
}
```

如果更偏 Python 工具链，可以让 MCP client 通过 `uvx` 启动：

```json
{
    "mcpServers": {
        "create-maa-project": {
            "command": "uvx",
            "args": [
                "create-maa-project",
                "--mcp",
                "--root",
                "/absolute/path/to/workspace"
            ]
        }
    }
}
```

可以这样要求 agent：

```text
在 ./MaaExample 创建一个 MaaFW 项目。使用 Pipeline 项目、Android 控制器，并添加 dev-tools 和 GitHub workflows。
其它可选 add-ons 先问我。
```

调用约定：

- `create_project` 之前，agent 应向你确认：项目名、Pipeline 还是 Python Agent、控制器、add-ons，以及 resource pack 的文件夹名。resource pack 的文件夹名通过 `resourcePackSlug` 传入（例如 `extra` 或 `cn`）；要添加 resource pack 时必传，否则 tool 会拒绝调用。
- `add` tool 单次调用传 `addon` 添加单项，或传 `addons` 数组添加多项；两者必须且只能传一个。
- agent 可先调用只读的 `get_project_context` 确认 server root，以及 `projectPath` 最终解析到的项目目录。
- 创建子项目后，`doctor`、`sync`、`update`、`add`、`list_backups`、`show_backup`、`restore`、`clean_cache` 都接受相对 `projectPath` 继续维护。路径只能指向 MCP server 根目录内的真实目录，不能用绝对路径、`..` 或根外符号链接。
- 恢复前可先用 `list_backups` 查找备份、`show_backup` 检查内容，再以 `restore { backupId, dryRun: true }` 预演；预演不会修改项目文件。备份与回滚机制见[状态与安全](../README.md#状态与安全)。
