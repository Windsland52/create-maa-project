# create-maa-project

MaaFW project scaffolding CLI.

```bash
npx create-maa-project my-project
```

Current implementation covers the local scaffold core:

- interactive create flow without LLM
- default `resource/base` project shape
- create presets for All (Recommended), Minimal, and Custom repository features
- multiple MaaFW PI V2 control targets such as `Adb`, `Win32`, `MacOS`, `PlayCover`, `Gamepad`, and `WlRoots`
- optional Python Agent template
- `--add dev-tools` and `--add github` for repository tooling and GitHub workflows
- `--add agent` for adding the Python Agent files to an existing project
- `--add resource-pack <folder> --label <display>`
- `--add git-cliff` for git-cliff release notes
- `--add auto-format` for a scheduled/manual formatting workflow
- `--add optimize-images` for a lossless PNG optimization script and workflow
- `--add community`, `--add dependabot`, and `--add schema-sync`
- reserved add-on reporting for options such as `mirrorchyan`
- committed `maa-project.json` and `maa-project.lock.json`
- project-owned files such as `interface.json`, `package.json`, `tasks/`, `resource/`, editor ignores/settings, and OCR model files are created once instead of managed as template baselines
- metadata sync for interface, package, controller, license, network mode, display name, and validated GitHub repository URLs
- managed file hash checks through `--doctor` and `--diff`
- `--accept-changes [path...]` to accept selected or all changed managed files
- accepted local baseline reporting in `--doctor` and generated `tools/check-project.mjs`
- `--update node-deps` and `--update python-deps` dependency refreshes, with successful pending-action cleanup
- `--update schema` refreshes the generated project from the CLI's embedded schema baseline
- runtime updates resolve MaaFramework and MFAAvalonia assets from GitHub Releases, verify GitHub-provided sha256 digests, cache MFAAvalonia GUI files for release staging, and extract MaaFramework into the generated runtime layout
- Agent runtime updates use embedded Python for Windows/macOS release packages and Linux wheel dependencies for system-`python3` `.venv` startup
- `pnpm sync:runtime` in generated projects calls `create-maa-project --update maafw --update runtime:mfa`, and Agent projects also run `--update python-runtime`; set `CREATE_MAA_PROJECT_RUNTIME_PLATFORM=all` to sync every desktop MaaFramework/MFAAvalonia platform instead of the current platform, while Agent Python dependency sync remains single-platform
- Generated GitHub Actions pass `CREATE_MAA_PROJECT_RUNTIME_PLATFORM` from the release matrix; runtime asset sync refuses to infer the platform from runner architecture inside GitHub Actions
- default asset downloads retry transient network failures; set `CREATE_MAA_PROJECT_DOWNLOAD_ATTEMPTS=<n>` to override the default
- OCR downloads can be seeded for local/offline verification with `CREATE_MAA_PROJECT_OCR_ZIP_PATH`
- OCR model updates use a verified manifest from `CREATE_MAA_PROJECT_OCR_MANIFEST_URL` when configured, with the existing OCR zip as fallback
- optional schema baseline sync through `--add schema-sync`, including `pnpm sync:schema` and a generated daily schema-sync workflow
- CLI project creation attempts OCR model download by default and runs `pnpm install` when dev tools are selected, keeping actionable pending items if either fails
- conservative `--update template` with `--update template --diff` preview and `--force` overwrite
- generated project lint and release dry-run smoke checks, including pending-action, pnpm lockfile, VS Code settings, and interface schema guards
- release staging through generated `tools/build-release.mjs`, with MFAAvalonia GUI files laid down first, MaaFramework runtime overlaid after it, package-only `interface.json` rewriting, tag-based version injection, Agent `child_exec` normalization, dev-file exclusion, package smoke checks, and Unix tar executable metadata smoke in the release workflow
- default release workflow packages the 3 OS x 2 arch desktop artifact matrix using M9A-style GUI suffixes such as `-MFAA`: Windows zip artifacts, plus Linux/macOS tar.gz artifacts; MFAAvalonia runtime sync uses its upstream `win/linux/osx` and `x64/arm64` asset matrix separately
- explicit `--git`/`--no-git` creation flow with parent-repository and pending-commit guards
- write lock, explicit stale-lock cleanup, local backups for file overwrites and non-empty target directories, cache cleanup, and backup restore
- PyPI wrapper trust-chain checks for the same-version release manifest and SEA asset, verified binary cache reuse, manual `npx`/source fallback guidance, and Windows execution diagnostics

Schema syncing is explicit and PR-based rather than part of build. The PyPI
wrapper source tree contains the trust-chain code; release wheels must embed the
matching release manifest digest before they can download and cache a SEA binary.

## JSON report mode

Pass `--report` to make `create`, `sync`, `update`, `diff`, and `doctor` emit a
single machine-readable JSON document on stdout. In report mode, `--report`
forces non-interactive execution. Progress, `Log:`, and human `Error:` text are
not written to stdout; wrappers may ignore stderr unless they want diagnostics.

Exit code `0` means the command completed successfully. Exit code `1` means the
command failed, or `doctor` found project problems. The JSON `exitCode` field
matches the process exit code.

```ts
type CliJsonReport = {
  schemaVersion: 1
  tool: 'create-maa-project'
  command: 'create' | 'sync' | 'update' | 'diff' | 'doctor'
  ok: boolean
  timestamp: string
  durationMs: number
  exitCode: 0 | 1
  executionId: string
  root: string
  logPath: string | null
  written: string[]
  skipped: string[]
  pending: Array<{ kind: string; reason: string; command: string }>
  changedManagedFiles: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }>
  changedUserFiles: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }>
  suggestedCommands: Array<{ command: string; description: string; autoRun: boolean }>
  git?: { initialized: boolean; committed: boolean; reason?: string }
  doctor?: { lines: string[] }
  diff?: { lines: string[] }
  error?: { message: string; code?: string }
}
```

Example success report:

```json
{
  "schemaVersion": 1,
  "tool": "create-maa-project",
  "command": "sync",
  "ok": true,
  "timestamp": "2026-06-12T10:30:00.000Z",
  "durationMs": 42,
  "exitCode": 0,
  "executionId": "2026-06-12T10-30-00-000Z-00000000-0000-4000-8000-000000000000",
  "root": "/path/to/project",
  "logPath": "/path/to/project/.create-maa-project/logs/2026-06-12T10-30-00-000Z-00000000-0000-4000-8000-000000000000.log",
  "written": [
    "interface.json",
    "maa-project.json",
    "maa-project.lock.json"
  ],
  "skipped": [],
  "pending": [],
  "changedManagedFiles": [],
  "changedUserFiles": [],
  "suggestedCommands": []
}
```

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
  "skipped": [],
  "pending": [],
  "changedManagedFiles": [],
  "changedUserFiles": [],
  "suggestedCommands": [],
  "error": {
    "message": "Invalid version \"not-semver\". Use a SemVer version such as 0.1.0."
  }
}
```

## Release

Pushing a `v*` tag runs `.github/workflows/release.yml`. The workflow checks the
repo, builds the npm package, builds SEA binaries for Windows/Linux/macOS on
`x86_64` and `aarch64`, writes `create-maa-project-manifest.json`, publishes the
GitHub Release assets, publishes npm, then builds the PyPI wrapper with the
release manifest digest embedded and publishes it through trusted publishing.
