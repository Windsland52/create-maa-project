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

Supported `--controller` targets: `Adb`, `Win32`, `MacOS`, `PlayCover`, `Gamepad`, `Linux`
(a wlroots desktop app on Linux). Comma-separated for multiple targets, case-insensitive.
Default is `Adb`. The pre-rename spelling `WlRoots` is still accepted and normalizes to `Linux`.

The generated `interface.json` carries the same MaaFW controller types: `Adb`, `Win32`, `MacOS`,
`PlayCover`, `Gamepad` and `Linux`. Each target becomes one entry: `name` is the controller ID
(`Adb`, `Windows`, `macOS`, `PlayCover`, `Gamepad`, `Linux`), `label` the display text
(e.g. `Android / Emulator`), and `type` the value above.

Git initialization is enabled by default: when the target is outside an existing Git repository, project creation (including non-interactive paths like `--yes`/`--no-interactive` and MCP without `git`) automatically runs `git init` and creates the initial commit; pass `--no-git` to disable it. If Git is not installed or `git init` fails, creation still succeeds and the reason is recorded in the `git` field of the JSON report.

Interactive creation defaults: project folder `maa-project` (the project ID is derived from the folder name and only asked for when no valid ID can be derived), display name from the folder name, project type `pipeline`, license `AGPL-3.0-or-later`, control target `Adb`, the All repository preset, and no extra resource pack; Git initialization follows the rule above. `--yes --no-interactive` uses these same defaults.

Add-ons:

```bash
create-maa-project --add dev-tools
create-maa-project --add vscode
create-maa-project --add github
create-maa-project --add android
create-maa-project --add agent
create-maa-project --add resource-pack extra --label "Extra Resource"
create-maa-project --add git-cliff
create-maa-project --add auto-format
create-maa-project --add optimize-images
create-maa-project --add community
create-maa-project --add dependabot
create-maa-project --add schema-sync
```

Add-on dependencies are resolved automatically, so no manual ordering is required:

- `vscode`, `github`, and `agent` require `dev-tools`;
- `agent` also requires `vscode`, because Agent projects ship the `Maa Agent: Debug` launch config;
- `git-cliff`, `auto-format`, `optimize-images`, `community`, `dependabot`, and `schema-sync`
  require `github` (and therefore `dev-tools`);
- `android` requires nothing: it ships its own entry workflow and builds a debug APK without the
  `github` add-on.

For example, `create-maa-project --add community` also enables `dev-tools` and `github`. The
human-readable output prints `Add-ons required by dependencies:`, and the `addons` field of the
JSON report carries `requested` / `enabled` / `autoEnabled`.

`vscode` is optional: `--add dev-tools` writes only the toolchain and no longer creates `.vscode/`.
Add `--add vscode` when you want the editor integration. The interactive `All` preset includes it,
while the Custom repository-feature list leaves it unchecked by default.

### Files written by dev-tools

`--add dev-tools` writes 13 files:

| File                                          | Purpose                                                      | Refresh |
| --------------------------------------------- | ------------------------------------------------------------ | ------- |
| `.node-version`                               | Pins Node 22                                                 | managed |
| `.prettierrc.mjs`                             | Prettier config (MaaFW sort and multiline-array plugins)     | managed |
| `.prettierignore`                             | Ignores generated schema baselines and project-owned sources | once    |
| `package.json`                                | devDependencies, `engines.node >= 22.13`, `packageManager`   | once    |
| `pnpm-workspace.yaml`                         | pnpm workspace config                                        | once    |
| `tools/validate-schema.mjs`                   | Validation script used by `check:schema`                     | managed |
| `tools/schema/interface.schema.json`          | Upstream MaaFW baseline (interface)                          | managed |
| `tools/schema/interface_config.schema.json`   | Upstream MaaFW baseline (interface config)                   | managed |
| `tools/schema/interface_import.schema.json`   | Upstream MaaFW baseline (interface import)                   | managed |
| `tools/schema/pipeline.schema.json`           | Upstream MaaFW baseline (pipeline)                           | managed |
| `tools/schema/schema-manifest.json`           | Schema version manifest                                      | managed |
| `tools/schema/custom.action.schema.json`      | Custom action schema, meant to be edited by the project      | once    |
| `tools/schema/custom.recognition.schema.json` | Custom recognition schema, meant to be edited by the project | once    |

`managed` files are refreshed by `--update` (for example `--update schema`); `once` files are
written at creation only and then belong to the project, so later commands never overwrite them.

### Files written by vscode

`--add vscode` writes three files under `.vscode/` (an Agent project adds `launch.json`). They
refer to dev-tools artifacts (the Prettier formatter, `tools/schema/*`, `pnpm install`), which is
why the add-on requires dev-tools:

| File                      | Purpose                                                             | Refresh |
| ------------------------- | ------------------------------------------------------------------- | ------- |
| `.vscode/settings.json`   | formatOnSave, LF, jsonc associations, schema map, default formatter | once    |
| `.vscode/extensions.json` | Recommended extensions (Prettier, MaaFW; Agent adds Pylance)        | once    |
| `.vscode/tasks.json`      | Syncs dependencies when the project is opened                       | managed |
| `.vscode/launch.json`     | Agent projects only: the `Maa Agent: Debug` launch config           | once    |

Those three `once` files are merged rather than replaced when the add-on runs: `settings.json` and
`extensions.json` keep the keys the project already has (`--add vscode` again does not drop your own
`editor.rulers` or an extension you added), and `launch.json` merges `configurations` by `name`. Only
the `managed` `tasks.json` is refreshed whole. `maatools.config.mts` is `once` as well: `--add agent`
only adds the `vscode.agents.uv` debug session to the file that is already there, and `--sync` only
recreates it when it is missing. Doctor checks its required fields and points at deleting the file and
running `--sync metadata` when it needs rebuilding.

A project without this add-on has no `.vscode/`, and `--doctor` reports `vscode-settings` as
skipped rather than failed.

Scripts in `package.json` follow the enabled add-ons: `check` always chains `format:check`,
`check:schema`, and `check:maa`; `github` adds `release:dry-run` and `sync:runtime`,
`schema-sync` adds `sync:schema`, `optimize-images` adds `optimize:images`, and Agent projects
add `format:py`, `lint:py`, `typecheck:py`, and `check:py`.

### Files written by android

`--add android` connects the project to the MaaFwApp shell (Kotlin/Gradle) that CI turns into an APK:

| File                                  | Purpose                                                                   | Refresh |
| ------------------------------------- | ------------------------------------------------------------------------- | ------- |
| `Android/profile.yaml`                | Packaging recipe, one of two variants (pipeline / agent), hand-maintained | once    |
| `Android/README.md`                   | Local builds, signing secrets, shell upgrades, troubleshooting            | once    |
| `tools/android-packaging.mjs`         | Resolves the MaaFW version, kernel tag, artifact prefix and Chaquopy args | managed |
| `.github/workflows/android.yml`       | Entry: debug APK on push / PR, optional release on manual dispatch        | managed |
| `.github/workflows/android-build.yml` | Reusable pipeline: debug / universal / single-ABI packages                | managed |

Re-running `--add android` refreshes the `managed` files (`--update` has no android target). Beyond
the files:

- The shell `Android/MaaFwApp` is a Git submodule (`Aliothmoon/MaaFwApp`, `branch = main`): creation or
  `--add android` shallow-clones it, appends its `.gitmodules` section and stages both that file and
  the gitlink, because CI checks out submodules recursively and a missing gitlink or URL yields an
  empty directory. A failed clone
  does not fail creation; it records an `android-submodule` pending action whose command is
  `git submodule add -b main …`.
- `.gitignore` gains `Android/agent-dist/`: the agent runtime is a build artifact.
- `pyproject.toml` gains `extend-exclude = ["Android/MaaFwApp"]` under `[tool.ruff]` (**Agent
  projects**): `release.yml` checks submodules out, so an unscoped `ruff check .` reads the shell's own
  `scripts/*.py`, trips `UP009`, and fails `pnpm check:py` in every `package` job — which is what keeps
  the release from being created. When the project already has an `extend-exclude`, the path is merged
  into that array (single-line or multi-line) instead of adding a second key: duplicate keys make
  `pyproject.toml` invalid TOML and break `--update python-deps`, which parses the file.
- An **Agent** project also needs an exact `maafw==X` in `requirements.txt`: the Android Python binding
  only ships inside the MaaAgentCoreAndroid kernel release (`X-maafwY` tags), which is what pairs the
  kernel with the native libraries inside the APK. Without it the add-on records an `android-version`
  pending action. When `maa-project.json` carries an exact `maafw.version`, `--add android` pins
  `pyproject.toml` to it as well; when it is empty, `--update python-deps` resolves `maafw.channel`
  and pins that version instead. Either way `--update python-deps` exports the pin to `requirements.txt`.
  When upstream ships a patch release before the kernel catches up, CI degrades to the highest pairing
  at or below the pin and prints a `::warning::` (the APK stays internally consistent, it is just older
  than the pin); only a pin older than every kernel pairing is an error. Pre-releases pair too: kernel
  and release tags keep the released spelling (`3.13.15-maafw5.15.0-beta.1`, `v5.15.0-beta.1`) while
  `requirements.txt` carries the PEP 440-normalized form `uv export` produces (`5.15.0b1`); the resolver
  and `--doctor` compare normalized versions, and `maafw.version` accepts either spelling.
- Native Python packages (the ones carrying `.so` files) are probed per package against the Chaquopy
  index, and the resolver emits the downgrade arguments: a desktop pin with no build for the kernel
  CPython is pinned to the highest version the index has, a package the index does not carry at all is
  pure Python and stays untouched, and an index that has builds but none for the kernel CPython fails
  the resolver instead of failing pip in the middle of the build.
- With `github` enabled, `release.yml` gains an `android` job that runs **in parallel** with desktop
  `package`; the release job waits for both, the assets grow `release-assets/*.apk`, and the Android
  job only runs for tags. A tag release without `KEYSTORE_BASE64` fails; a manual dispatch may still
  upload an unsigned APK. Without the add-on, `release.yml` is byte-for-byte what it was.
- The interactive `All` preset does **not** include `android` (it checks out a shell repository); pick
  it in Custom or pass `--add android`.
- Artifact names: `<prefix>-android-<tag>.apk` (universal, deliberately without an ABI segment) and
  `<prefix>-android-<abi>-<tag>.apk` (single ABI). The prefix is `project.displayName`, falling back to
  `project.slug` when it is not ASCII — in-app updates select assets by name, so the prefix must be.
- The recipe's `app.id` is validated by the shell: it only takes lowercase package segments (letters,
  digits and underscores, each starting with a letter) and becomes `com.aliothmoon.maafw.<id>`. A
  kebab-case project id is converted (`maa-helper` → `maa_helper`), and one starting with a digit gets
  a `p` prefix; a hyphen hand-edited back into the recipe is reported by `--doctor` instead of failing
  the Gradle build.
- Doctor's `android-packaging` check covers those five files, the recipe's `assets` and `app.id`, the
  submodule registration / checkout / gitlink state, the `.gitignore` section, and the maafw pin
  agreement for Agent projects.

The authoritative field reference lives in the shell repository:
`Android/MaaFwApp/INTEGRATION.md` and `pi-profile.sample.yaml`.

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
be reverted with `--restore`.

`--sync` refreshes only what `maa-project.json` derives, and keeps whatever the project wrote by
hand into `interface.json`:

- Controller entries have their ID and `type` repaired in place for each configured target, while
  `label`, `attach_resource_path`, `icon`, `option`, `display_long_side` and the per-type blocks
  (`linux`, `adb`, …) are left as they are — a tuned `display_short_side` or `label` is not reset. A
  controller the config cannot express (a second Adb client, say) is kept; the controller IDs the CLI
  used to write (`Android`, `WlRoots`) are renamed in place instead of gaining a duplicate entry; and
  when a configured target is served by the project's own entry (the default Adb entry replaced by a
  cloud client, say), only its `type` is repaired and its identity is left alone.
- Resource packs work the same way: packs the config knows are refreshed in config order, a pack the
  config turned off is removed, and a pack it has never heard of is kept.
- `github` is written only when `maa-project.json` records a repository, so a hand-written link
  survives; `--doctor` reports it as `[INFO]` with `--sync github-url` as the way to record it,
  instead of failing the check.
- The `agent` block is regenerated only for Python Agent projects, and is otherwise left alone.
- The `once` files under `.vscode/` are not written at all, and `maatools.config.mts` is recreated only
  when it is missing — an existing one is left byte for byte alone. Doctor points at `--sync metadata`
  for a missing config, so that repair has to exist.

`--sync metadata` therefore still repairs controller drift back to the upstream enum, without
discarding anything the config never expressed.

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

Python dependencies in Agent projects are a two-step chain. `uv add <package>` writes
`[project].dependencies` in `pyproject.toml`, updates `uv.lock`, and installs into the local
`.venv` — local `uv run` works at this point — but `requirements.in` / `requirements.txt` do not
move until you run `create-maa-project --update python-deps`, which regenerates
`requirements.in` from `pyproject.toml` and refreshes `requirements.txt` through `uv lock` +
`uv export`. Release packages preinstall their dependencies from `requirements.txt`
(`tools/sync-runtime.mjs` fails outright when that file is missing), so stopping at `uv add`
leaves local runs working while the built package ships without the new dependency. After every
dependency change, commit `pyproject.toml`, `uv.lock`, `requirements.in`, and `requirements.txt`
together.

For an Agent project with the `android` add-on, `--update python-deps` also reconciles the
MaaFramework version: the target is an exact `maafw.version` from `maa-project.json`, or the newest
release of `maafw.channel` (`beta` / `alpha` include prereleases) when that is empty. It pins
`maafw==X` into `pyproject.toml` before `uv lock` / `uv export`, then verifies the exported
`requirements.txt` still carries the same version (compared after PEP 440 normalization) and fails
instead of letting the APK and the desktop package use different frameworks. Agent projects without
the `android` add-on are untouched: `maafw` stays floating, so uv and Dependabot's `lockfile-only`
updates own the version. The release workflows (`release.yml` for desktop and `android-build.yml` for
APKs) re-export `requirements.txt` from `uv.lock` with `uv export --frozen` before packaging, so a
merged Dependabot uv PR needs no manual re-export; `--update python-deps` only keeps the committed
file current for local development. `--frozen` fails when `pyproject.toml` and `uv.lock` disagree
instead of silently exporting the old lock.

`--update python-runtime` takes its platform from `CREATE_MAA_PROJECT_RUNTIME_PLATFORM=<os>-<arch>`
(one platform per run), downloads the embedded interpreter into
`.create-maa-project/runtime/python/<platform>`, and reinstalls from `requirements.txt`; after a
dependency change, run `python-deps` first so the runtime picks up the new versions.

`maafw.channel` / `maafw.version` in `maa-project.json` decide how MaaFramework runtime assets
resolve. A non-empty `version` fetches that release, and its `v` prefix is optional: upstream tags
read `v5.13.1`, so `5.13.1` is looked up as written and then as `v5.13.1`, and a pin that neither
spelling resolves still fails with the spelling written in the config. An empty `version` selects the
newest release
the `channel` (default `stable`) allows — `stable` accepts final releases only, `beta` also accepts
rc and beta builds (rc counts as beta), and `alpha` also accepts alpha builds.
`runtime.mfa.version` and `runtime.mxu.version` behave the same way.

### The two OCR provisioning modes

Which mode creation uses depends on whether **Git is available on the machine** and whether the
project directory is itself a Git worktree root, not on `--git`/`--no-git` (that flag only
controls whether the project runs `git init`):

| Git at creation      | `.gitmodules` | `ocr` in `maa-project.json` | `resource/base/model/ocr/`             |
| -------------------- | ------------- | --------------------------- | -------------------------------------- |
| available            | written       | `{"source":"submodule",…}`  | added to `.gitignore` (models derived) |
| available, in parent | not written   | **no `ocr` key at all**     | `manifest.json` with sha256, committed |
| unavailable          | not written   | **no `ocr` key at all**     | `manifest.json` with sha256, committed |

So the same create command can produce structurally different projects on different machines,
while both report the same exit code and file count. Set `CREATE_MAA_PROJECT_OCR_SOURCE=submodule`
or `=download` to pin the mode instead of depending on the environment.

Creating inside a subdirectory of a parent repository always falls back to download mode (the
models are committed with the child project, and the parent's `.gitmodules` is never rewritten);
requesting `CREATE_MAA_PROJECT_OCR_SOURCE=submodule` there fails immediately, so create the project
at a Git worktree root or outside the parent repository.

Note: when Git is available, `.gitmodules` is written even with `--no-git`, before any `.git`
directory exists. It is the submodule declaration for a later `git init`, not a defect; delete it
if you do not want it.

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
