English | [简体中文](./mcp.md) | [Back to README](../README.en.md)

# Use With An MCP Client

MCP is the alternative to the Agent Skill, for environments where the agent has no shell access
or where permissions must be controlled per tool inside the client. It is not interactive by
itself: the agent should ask you for your requirements first and then call the matching tools
(see the calling conventions below). MCP tools share the same write paths as the CLI commands,
keeping behavior and rollback mechanisms consistent; new capabilities land in the CLI and the
Agent Skill first, and the MCP tool surface stays lean and stable.

Always prefer an explicit `--root` for the workspace the MCP server may access. A relative
root is resolved from the server process's startup directory; omitting it uses that directory.

If the CLI is installed globally, configure the MCP server like this:

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

If you do not want a global install, let the MCP client run it through `npx`:

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

For a Python-centric toolchain, let the MCP client launch it through `uvx`:

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

Typical agent request:

```text
Create a MaaFW project in ./MaaExample. Use a Pipeline project, Android controller,
and add dev-tools and GitHub workflows. Ask me before choosing optional add-ons.
```

Calling conventions:

- Before `create_project`, the agent should confirm with you: the project name, Pipeline or
  Python Agent, the controllers, the add-ons, and the resource pack folder name. The folder
  name is passed as `resourcePackSlug` (for example `extra` or `cn`) and is required when
  adding a resource pack; otherwise the tool rejects the call.
- The `add` tool takes either `addon` for a single add-on or an `addons` array for several
  add-ons in one call; pass exactly one of the two.
- The agent can call the read-only `get_project_context` tool first to confirm the server
  root and the project directory resolved from `projectPath`.
- After creating a child project, `doctor`, `sync`, `update`, `add`, `list_backups`,
  `show_backup`, `restore`, and `clean_cache` accept a relative `projectPath`. The path must
  resolve to a real directory under the MCP server root; absolute paths, `..`, and escaping
  symlinks are rejected.
- Before restoring, use `list_backups` to find a backup and `show_backup` to inspect it, then
  preview with `restore { backupId, dryRun: true }`; a preview never modifies project files.
  Backups and rollback are described under [State and Safety](../README.en.md#state-and-safety).
