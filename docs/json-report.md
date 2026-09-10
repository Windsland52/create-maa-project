[English](./json-report.en.md) | 简体中文 | [返回 README](../README.md)

# JSON Report 模式

给 `create`、`sync`、`update`、`doctor` 和备份检查/恢复命令传入 `--report` 后，CLI 会在 stdout 输出唯一一个机器可读 JSON 文档。Report 模式下 `--report` 强制非交互执行。进度、`Log:` 和人类可读 `Error:` 不会写入 stdout；封装工具可以忽略 stderr，除非需要诊断信息。

退出码 `0` 表示命令成功完成。退出码 `1` 表示命令失败，或 `doctor` 发现项目问题。JSON 中的 `exitCode` 与进程退出码一致。

```ts
type BackupInspection = {
    id: string;
    format: "managed-files" | "legacy";
    createdAt: string;
    command: string | null;
    status: "in-progress" | "complete" | "rolled-back" | "rollback-failed" | "legacy";
    entries: Array<{path: string; action: "restore" | "remove"}>;
};

type BackupSummary = {
    id: string;
    format: "managed-files" | "legacy" | "invalid";
    createdAt: string;
    command: string | null;
    status: BackupInspection["status"] | "invalid";
    entryCount: number;
    error?: string;
};

type CliJsonReport = {
    schemaVersion: 1;
    tool: "create-maa-project";
    command: "create" | "sync" | "update" | "add" | "doctor" | "backup" | "clean-cache";
    ok: boolean;
    timestamp: string;
    durationMs: number;
    exitCode: 0 | 1;
    executionId: string;
    root: string;
    logPath: string | null;
    written: string[];
    removed: string[];
    skipped: string[];
    pending: Array<{kind: string; reason: string; command: string}>;
    suggestedCommands: Array<{command: string; description: string; autoRun: boolean}>;
    backupId?: string;
    backupScope?: "managed-files";
    git?: {initialized: boolean; committed: boolean; reason?: string};
    addons?: {
        requested: string[];
        enabled: string[];
        autoEnabled: string[];
    };
    doctor?: {
        lines: string[];
        checks: Array<{
            id: string;
            status: "pass" | "fail" | "skipped";
            summary: string;
            details: string[];
        }>;
    };
    backup?:
        | {operation: "list"; backups: BackupSummary[]}
        | {operation: "show" | "restore-preview"; backup: BackupInspection}
        | {
              operation: "restore";
              backupId: string;
              restored: string[];
              removed: string[];
              preRestoreBackupId: string;
          };
    error?: {
        message: string;
        code:
            | "CMP_CREATE_FAILED"
            | "CMP_SYNC_FAILED"
            | "CMP_UPDATE_FAILED"
            | "CMP_ADD_FAILED"
            | "CMP_DOCTOR_FAILED"
            | "CMP_BACKUP_FAILED"
            | "CMP_CLEAN_CACHE_FAILED";
        causeCode?: string;
    };
};
```

失败报告始终包含稳定的 `CMP_*` 命令错误码；如果底层系统还提供了 `ENOENT` 等原生错误码，会另外保存在
`causeCode`，避免调用方依赖操作系统相关信息。

`addons` 字段只在 `create` 与 `add` 命令中出现：`requested` 是命令行显式请求的 add-on，
`enabled` 是本次操作解析后的完整集合，`autoEnabled` 是其中因依赖关系自动补上的部分
（`enabled` 减去 `requested`）。例如 `--add community` 会得到
`{"requested":["community"],"enabled":["dev-tools","github","community"],"autoEnabled":["dev-tools","github"]}`。
在已有项目上执行 `add` 时，`autoEnabled` 中的 add-on 可能早已启用，该字段表达的是「因依赖而被纳入本次操作」，
不代表本次新安装。

失败报告示例：

```json
{
    "schemaVersion": 1,
    "tool": "create-maa-project",
    "command": "sync",
    "ok": false,
    "timestamp": "2026-06-12T10:31:00.000Z",
    "durationMs": 6,
    "exitCode": 1,
    "executionId": "2026-06-12T10-31-00-000Z-00000000-0000-4000-8000-000000000000",
    "root": "/path/to/project",
    "logPath": "/path/to/project/.create-maa-project/logs/2026-06-12T10-31-00-000Z-00000000-0000-4000-8000-000000000000.log",
    "written": [],
    "removed": [],
    "skipped": [],
    "pending": [],
    "suggestedCommands": [],
    "error": {
        "message": "Invalid version \"not-semver\". Use a SemVer version such as 0.1.0.",
        "code": "CMP_SYNC_FAILED"
    }
}
```
