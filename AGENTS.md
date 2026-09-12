# Repository Guidelines

> **Primary rule: the CLI's output is a contract. Generated projects, the JSON report, and the
> documented file sets are consumed by users and by agents, so change them deliberately.**

create-maa-project scaffolds and maintains MaaFramework (MaaFW) application projects. It ships as
an npm package, a PyPI wrapper, and a single-executable (SEA) binary, and it also runs as an MCP
server. It generates projects; it is not a build system for the generated projects.

This file is for agents **changing this repository**. To use the CLI, read
[`skills/create-maa-project/SKILL.md`](skills/create-maa-project/SKILL.md) instead.

## Architecture

```text
src/
  index.ts            CLI entry: mode dispatch, human output, exit codes, report emission
  args.ts             Argument parsing and --help text
  prompt.ts           Interactive prompts (TTY only), dependency-aware multi-select, cancellation
  addons.ts           Add-on dependency graph, ordering, and the text derived from it
  features.ts         Config-derived capability queries (hasDevTools, hasGithubAutomation, ...)
  scaffold.ts         Project creation, incremental add-ons, config writing, file transactions
  templates.ts        Every generated file, as data (managed vs once)
  project.ts          Project config IO, write locks, managed-files backups
  update.ts sync.ts   --update / --sync targets
  doctor.ts           Read-only diagnosis
  report.ts           The --report JSON schema
  mcp.ts              MCP server and tool schemas
templates/            Source templates rendered by templates.ts (read from disk, embedded in SEA)
docs/                 User-facing references (commands, json-report, mcp) in zh-CN and en
skills/               The bundled Agent Skill shipped to users
```

- Keep the CLI the single source of behavior: the MCP server and the Python wrapper must call the
  same code paths rather than reimplementing them.
- `agent`, `resource-pack`, and `vscode` are add-ons, not features. Anything that writes files
  belongs to an add-on entry in `src/addons.ts`.
- Add-on behavior is derived from `ADDON_DEPENDENCIES` and `ADDON_ORDER`. Never hand-write a
  dependency list, an indentation level, or a display order anywhere else.

## Generated Output Is a Contract

- Files are `managed` (refreshable by `--update`) or `once` (written at creation, then owned by the
  project). Never turn a `once` file into `managed` without saying so in the docs and changelog.
- The file sets and their refresh modes are pinned by `tests/templates.test.ts` and documented in
  `docs/commands.md`. Changing one without the other fails the suite on purpose: update both.
- The JSON report is versioned (`schemaVersion`) and mirrored in `src/report.ts`, the MCP output
  schemas in `src/mcp.ts`, and `docs/json-report.md`. Change all three together.
- Human output lines (`Add-ons:`, `Add-ons required by dependencies:`, `Written files:`,
  `Pending actions:`) are consumed by scripts. Treat a new or renamed line as a contract change.
- `--help` text is partly generated from the dependency graph. Do not hand-write what
  `addonDependencyText()` / `addonDependencyLines()` already derive.

## Interactive Prompt Rules

- Prompts run only on a TTY; non-interactive paths must never block. `--report` forces
  non-interactive execution.
- Ctrl+C must stay a quiet cancel: `PromptCancelledError`, exit code `130`, no `Error:` line.
  readline closes its interface on SIGINT unless the interface owns a listener, which is why
  `prompt.ts` registers its own.
- The selectable prompts suspend readline's keypress handlers for their lifetime. Without that,
  typed keys echo onto the screen and leak into the next `rl.question()` as its answer.
- Rendering counts **physical** rows: lines are wrapped by display width (CJK is two columns) and
  the redraw moves the cursor by the wrapped row count. Do not assume one logical line is one row,
  and keep the cursor marker and checkbox columns aligned when adding indentation.

## Release Metadata

- The version is **derived from the git tag** at release time by `scripts/sync-release-version.mjs`;
  the checked-in `package.json` / `pyproject.toml` versions are placeholders. A locally built
  artifact therefore reports `0.1.0`, which is expected and not a bug.
- Every release needs a curated `CHANGELOG.md` section for its tag. `scripts/changelog-notes.mjs`
  turns it into the GitHub Release body, and the `check` job fails the release when the section is
  missing, so a tag without a changelog entry cannot publish.
- `CHANGELOG.md` is written for users: merge related commits, describe the effect, and put
  migration steps under `### 不兼容变更`. `pnpm changelog:draft` prints the per-commit draft as a
  completeness checklist; never let it overwrite the curated file.
- Mark a breaking change with `!` in the commit subject (for example `feat(addons)!: ...`) plus a
  `BREAKING CHANGE:` footer. git-cliff renders the marker from the subject and the footer text as a
  quoted note beneath the entry, so write the footer for users, not for developers.

## Required Checks

Every change must pass, and `pnpm check` runs the first three:

```powershell
pnpm format:check
pnpm typecheck
pnpm test
```

Coverage and the Python wrapper tests are part of `pnpm test`. Fix the cause of a formatting
failure rather than reformatting unrelated files; the Prettier config uses a MaaFW sort plugin and
`multilineArraysWrapThreshold: -1` for TypeScript, so array and key order are deliberate.

## Node Support Floor

`src/node-support.ts` is the single source of truth: `SUPPORTED_NODE_MAJOR` drives `.node-version`
and every generated workflow, `SUPPORTED_NODE_RANGE` drives `engines.node`. The floor is set by the
pnpm major the generated projects pin (pnpm 11 needs Node >=22.13 for the `node:sqlite` builtin),
not by anything in the CLI's own code, so raising or lowering it is a pnpm decision.

Never write the version literally in a template, in `doctor.ts`, or in generated output; that is
how it drifted before. `tests/node-support.test.ts` fails if a hardcoded `24` reappears, and CI runs
the full suite on both the floor and the current LTS so the floor cannot drift upward unnoticed.

## Template Dependency Pins

`src/template-deps.json` is the single source of truth for the npm versions a generated project's
`package.json` pins. `templates/addons/dev-tools/package.json` carries `{{devDependencies}}` /
`{{pnpmVersion}}` placeholders rendered from it — never write a version literal back into that
template. This repository's own `devDependencies` mirror the shared toolchain packages, because the
CLI formats its templates with the same Prettier plugins a generated project uses.

`pnpm sync:deps` resolves every pin from the npm registry, mirrors the shared ones into
`package.json`, and refreshes the lockfile. `.github/workflows/deps-sync.yml` runs it daily on the
Node floor and commits only when `pnpm check` passes; it refuses to commit when the run touched files
outside the pin set, because a formatter bump can reflow generated templates and that is a contract
change for a human to land with a changelog entry. Only same-major moves are automatic: `--major` is
a human decision, and a same-major pnpm bump is held when its published `engines.node` would outgrow
the floor — best-effort, since pnpm does not publish its real requirement, which leaves the floor CI
run as the backstop. `tests/template-deps.test.ts` fails if a pin reappears as a literal in the
template, if this repository's pins drift from the source, or if a document states the pnpm patch
version.

## Testing the CLI

- Tests import `src/` directly; the child-process suites run `dist/index.js`, so **rebuild
  (`pnpm build`) before trusting a CLI-level test or manual run**.
- Always set `CREATE_MAA_PROJECT_AUTO_UPDATE=0` when invoking the CLI by hand. Otherwise it checks
  npm and hands the command off to the **published** version, so you end up testing old code.
- Use `--skip-download` for throwaway projects; without it the CLI performs real asset downloads.
- Interactive behavior is tested by faking the TTY (`tests/prompt-interactive.test.ts`) rather than
  spawning a terminal. Reuse that harness instead of adding a real-prompt dependency.
- When a test pins a document, changing the code is meant to fail it. Update the document, not the
  assertion, and keep the reason visible in the test name.

## Change Discipline

- Conventional Commits. `<type>(<scope>): <subject>`, `!` for breaking changes.
- Keep `docs/` (zh-CN and en) and the two READMEs in sync; the docs are shipped in the npm package
  and read by the bundled Skill.
- Do not commit generated output: `dist/`, `coverage/`, `CHANGELOG.draft.md`, and
  `.create-maa-project/` are ignored.
- Do not push, tag, publish, or change repository settings unless explicitly asked.
