# JSON report reference

Canonical source: the "JSON Report 模式" section of the create-maa-project README and
`src/report.ts`. `schemaVersion` is currently `1`; re-sync this file when the schema moves.

With `--report`, the CLI prints exactly one JSON document on stdout. Exit code 0 means the
command completed; exit code 1 means the command failed, or `doctor` found issues. The JSON
field `exitCode` always equals the process exit code.

## Top-level shape

```ts
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
        code: ErrorCode;
        causeCode?: string;
    };
};

type ErrorCode =
    | "CMP_CREATE_FAILED"
    | "CMP_SYNC_FAILED"
    | "CMP_UPDATE_FAILED"
    | "CMP_ADD_FAILED"
    | "CMP_DOCTOR_FAILED"
    | "CMP_BACKUP_FAILED"
    | "CMP_CLEAN_CACHE_FAILED";

type BackupSummary = {
    id: string;
    format: "managed-files" | "legacy" | "invalid";
    createdAt: string;
    command: string | null;
    status: "in-progress" | "complete" | "rolled-back" | "rollback-failed" | "legacy" | "invalid";
    entryCount: number;
    error?: string;
};

type BackupInspection = {
    id: string;
    format: "managed-files" | "legacy";
    createdAt: string;
    command: string | null;
    status: "in-progress" | "complete" | "rolled-back" | "rollback-failed" | "legacy";
    entries: Array<{path: string; action: "restore" | "remove"}>;
};
```

## Handling recipes

- **Failure**: read `error.message` and `error.code` first. `error.causeCode` carries native
  codes such as `ENOENT` when the operating system provided one; do not infer OS details from
  the message text.
- **`pending` non-empty**: the command itself succeeded but left unfinished work, usually a
  failed download or install. Each entry's `command` is ready to run; execute those, then
  re-run the original command or the relevant `--doctor` to confirm the project is clean.
  A pending entry is expected work, not an error to suppress.
- **`suggestedCommands`**: run `autoRun: true` entries immediately; surface the others to the
  user before running them.
- **`doctor.checks`**: fix `fail` entries using their `summary` and `details`. Re-run
  `create-maa-project --doctor --report --yes --no-interactive` after each fix; exit code 0
  with no `fail` checks means the project is healthy.
- **Backups**: pick a snapshot from `backup.operation === "list"`, inspect its `entries`
  with `show`, preview the restore (`--restore <id> --dry-run` produces
  `operation: "restore-preview"`), then restore for real. A completed restore reports
  `preRestoreBackupId` — the snapshot of the pre-restore state, which is the rollback path
  for the restore itself.
- **`git`**: `committed: false` with a `reason` means the CLI left work uncommitted on
  purpose; do not commit on the user's behalf without asking.

## Example failure report

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
