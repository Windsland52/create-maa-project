import data from './template-deps.json' with { type: 'json' }

/**
 * Versions pinned into the `package.json` of every generated project.
 *
 * This file and `template-deps.json` are the single source of truth. The template carries the
 * `{{devDependencies}}` / `{{pnpmVersion}}` placeholders instead of literals, the same way the Node
 * floor is carried by `{{nodeRange}}`, because a version written in two places drifts.
 *
 * `pnpm sync:deps` resolves both from the npm registry and rewrites `template-deps.json`. It only
 * moves within the current major unless `--major` is passed: a pnpm major bump can raise the Node
 * floor (`src/node-support.ts`) and a toolchain major bump can change generated output, so both
 * need a human. `tests/template-deps.test.ts` fails if a version literal reappears in the template.
 */
export const TEMPLATE_DEV_DEPENDENCIES: Record<string, string> = data.devDependencies

/** The pnpm version generated projects pin through `packageManager`. */
export const TEMPLATE_PNPM_VERSION: string = data.pnpm
