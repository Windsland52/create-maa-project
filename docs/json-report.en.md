English | [简体中文](./json-report.md) | [Back to README](../README.en.md)

# JSON Report Mode

Pass `--report` to make `create`, `sync`, `update`, `doctor`, and backup inspection/restore
commands emit a single machine-readable JSON document on stdout. In report mode,
`--report` forces non-interactive execution. Progress, `Log:`, and human `Error:` text are
not written to stdout; wrappers may ignore stderr unless they want diagnostics.

Exit code `0` means the command completed successfully. Exit code `1` means the command
failed, or `doctor` found project problems. The JSON `exitCode` field matches the process
exit code.

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

Failure reports always carry a stable `CMP_*` command error code. If the underlying system
provides a native code such as `ENOENT`, it is kept in `causeCode` so callers do not depend
on OS-specific information.

Example failure report:

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
