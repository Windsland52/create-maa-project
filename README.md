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
- `pnpm sync:runtime` in generated projects calls `create-maa-project --update maafw --update runtime:mfa`; set `CREATE_MAA_PROJECT_RUNTIME_PLATFORM=all` to sync every desktop platform instead of the current platform
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

## Release

Pushing a `v*` tag runs `.github/workflows/release.yml`. The workflow checks the
repo, builds the npm package, builds SEA binaries for Windows/Linux/macOS on
`x86_64` and `aarch64`, writes `create-maa-project-manifest.json`, publishes the
GitHub Release assets, publishes npm, then builds the PyPI wrapper with the
release manifest digest embedded and publishes it through trusted publishing.
