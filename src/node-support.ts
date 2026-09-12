/**
 * The Node.js version this project and every generated project target.
 *
 * The floor is set by pnpm: generated projects pin pnpm through `src/template-deps.json`, and the
 * pinned pnpm major requires Node >=22.13 (pnpm 11 uses the `node:sqlite` builtin). A pnpm major
 * never moves automatically, and `pnpm sync:deps` also holds a same-major bump whose published
 * `engines.node` would exceed this floor. Node 22 is an LTS line supported into 2027 and is the
 * oldest line still receiving security fixes, so it is the lowest floor worth supporting.
 *
 * `SUPPORTED_NODE_MAJOR` is what `.node-version` and generated CI workflows pin, so version
 * managers resolve the newest patch of that line instead of freezing a single minor.
 * `SUPPORTED_NODE_RANGE` is the exact floor and is what `engines.node` declares.
 */
export const SUPPORTED_NODE_MAJOR = '22'

/** Minimum minor that satisfies pnpm 11's own engine requirement. */
export const SUPPORTED_NODE_MINOR = 13

/** Exact minimum, matching pnpm 11's engine requirement. */
export const SUPPORTED_NODE_RANGE = `>=${SUPPORTED_NODE_MAJOR}.${SUPPORTED_NODE_MINOR}`

/**
 * Whether a `.node-version` value or a workflow `node-version:` value pins the supported line.
 *
 * Accepts the bare major (`22`, which version managers resolve to the newest 22.x) and any
 * `22.x`/`22.x.y` at or above the floor. Rejects a minor below the floor such as `22.1`, which
 * would resolve to a Node that cannot run the pinned pnpm.
 */
export function pinsSupportedNode(version: string): boolean {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(version.trim())
  if (!match) return false
  const [, major, minor] = match
  if (major !== SUPPORTED_NODE_MAJOR) return false
  if (minor === undefined) return true
  return Number(minor) >= SUPPORTED_NODE_MINOR
}
