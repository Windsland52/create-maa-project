/**
 * Facts about the Android packaging add-on that more than one module needs.
 *
 * The add-on ships the Gradle shell as a Git submodule, a hand-maintained packaging recipe, and two
 * workflows that call `tools/android-packaging.mjs`. Keeping the paths here means the scaffolder,
 * the doctor and the generated release workflow cannot disagree about where they live.
 */

/** MaaFwApp is the Android shell: a Gradle project that turns a PI into an APK. */
export const ANDROID_SUBMODULE_PATH = 'Android/MaaFwApp'
export const ANDROID_SUBMODULE_URL = 'https://github.com/Aliothmoon/MaaFwApp.git'
export const ANDROID_SUBMODULE_BRANCH = 'main'

/** Recipe file: written once from one of the two variants, then owned by the project. */
export const ANDROID_PROFILE_PATH = 'Android/profile.yaml'

/** Where `build_agent_bundle.py` puts the Python runtime the shell packages. */
export const ANDROID_AGENT_DIST_PATH = 'Android/agent-dist'
export const ANDROID_GITIGNORE_COMMENT =
  '# Agent runtimes for the Android package are built from requirements.txt and must not be committed.'
export const ANDROID_GITIGNORE_LINE = `${ANDROID_AGENT_DIST_PATH}/`

export const ANDROID_PACKAGING_SCRIPT = 'tools/android-packaging.mjs'
export const ANDROID_ENTRY_WORKFLOW = '.github/workflows/android.yml'
export const ANDROID_BUILD_WORKFLOW = '.github/workflows/android-build.yml'
export const ANDROID_WORKFLOW_FILES = [
  ANDROID_ENTRY_WORKFLOW,
  ANDROID_BUILD_WORKFLOW,
]

/** The recipe variant is chosen at creation: a project with an agent packages its runtime too. */
export function androidProfileTemplate(includeAgent: boolean): string {
  return includeAgent ? 'addons/android/Android/profile.agent.yaml' : 'addons/android/Android/profile.pipeline.yaml'
}

/**
 * MaaFwApp turns `app.id` into package segments and rejects anything else, so it takes package rules
 * rather than the project id: lowercase, digits and underscores, each segment starting with a letter
 * (`build-logic/.../AndroidApplicationConventionPlugin.kt`, `APP_ID_PATTERN`). A kebab-case project
 * id therefore cannot be copied verbatim — `maa-helper` fails the build — and a slug that starts with
 * a digit needs a letter in front of it.
 */
export function androidAppId(slug: string): string {
  const segment = slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
  if (segment === '') return ''
  return /^[a-z]/.test(segment) ? segment : `p${segment}`
}

/** Whether a recipe's `app.id` is something MaaFwApp will accept. */
export function isValidAndroidAppId(value: string): boolean {
  return /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(value)
}
