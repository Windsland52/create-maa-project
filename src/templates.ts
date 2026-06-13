import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ControllerKind,
  LicenseKind,
  MaaProjectConfig,
  ManagedFileInput,
  ResourcePackConfig
} from './types.js'
import { embeddedBinaryTemplates, embeddedTextTemplates } from './template-assets.generated.js'
import { addV, prettyJson, stableJson } from './utils.js'

const TEMPLATE_ROOT = resolveTemplateRoot()
const UPSTREAM_MAAFW_SCHEMA_FILES = [
  'interface.schema.json',
  'interface_config.schema.json',
  'interface_import.schema.json',
  'pipeline.schema.json'
]
const PROJECT_CUSTOM_SCHEMA_FILES = [
  'custom.action.schema.json',
  'custom.recognition.schema.json'
]
const RELEASE_TARGETS = [
  {
    runner: 'windows-latest',
    artifactOs: 'win',
    arch: 'x86_64',
    ext: 'zip',
    runtimeOs: 'win',
    runtimeArch: 'x64'
  },
  {
    runner: 'windows-11-arm',
    artifactOs: 'win',
    arch: 'aarch64',
    ext: 'zip',
    runtimeOs: 'win',
    runtimeArch: 'arm64'
  },
  {
    runner: 'ubuntu-latest',
    artifactOs: 'linux',
    arch: 'x86_64',
    ext: 'tar.gz',
    runtimeOs: 'linux',
    runtimeArch: 'x64'
  },
  {
    runner: 'ubuntu-latest',
    artifactOs: 'linux',
    arch: 'aarch64',
    ext: 'tar.gz',
    runtimeOs: 'linux',
    runtimeArch: 'arm64'
  },
  {
    runner: 'macos-15-intel',
    artifactOs: 'macos',
    arch: 'x86_64',
    ext: 'tar.gz',
    runtimeOs: 'osx',
    runtimeArch: 'x64'
  },
  {
    runner: 'macos-latest',
    artifactOs: 'macos',
    arch: 'aarch64',
    ext: 'tar.gz',
    runtimeOs: 'osx',
    runtimeArch: 'arm64'
  }
] as const

export type ProjectTemplateInput = {
  slug: string
  displayName: string
  version: string
  controllers: ControllerKind[]
  license: LicenseKind
  includeDevTools: boolean
  includeGithub: boolean
  includeAgent: boolean
  includeGitCliff: boolean
  includeAutoFormat: boolean
  includeOptimizeImages: boolean
  includeSchemaSync: boolean
  pythonDevCommand?: string[] | undefined
  resources?: Pick<ResourcePackConfig, 'slug' | 'label' | 'path'>[]
}

const AGENT_DEBUG_SESSION_NAME = 'Maa Agent: Debug'
const DEFAULT_AGENT_DEV_COMMAND = [
  'uv',
  'run',
  'python',
  'agent/bootstrap.py'
]

export function defaultAgentDevCommand(): string[] {
  return [
    ...DEFAULT_AGENT_DEV_COMMAND
  ]
}

export function baseProjectFiles(input: ProjectTemplateInput): ManagedFileInput[] {
  const files: ManagedFileInput[] = [
    managed('.editorconfig', template('base/.editorconfig')),
    once('.gitignore', template('base/gitignore.tmpl')),
    managed('.gitattributes', template('base/.gitattributes')),
    once('interface.json', interfaceJson(input)),
    once('tasks/tutorial.json', tutorialTaskJson()),
    once('resource/base/default_pipeline.json', defaultPipelineJson()),
    once('resource/base/pipeline/tutorial.json', tutorialPipelineJson()),
    once('resource/base/image/empty.png', templateBinary('base/resource/base/image/empty.png')),
    once('resource/base/model/ocr/manifest.json', ocrManifestJson()),
    once('resource/base/model/ocr/det.onnx', ''),
    once('resource/base/model/ocr/rec.onnx', ''),
    once('resource/base/model/ocr/keys.txt', ''),
    once('resource/base/model/ocr/README.md', ''),
    once('README.md', generatedReadme(input)),
    once('README.en.md', generatedEnglishReadme(input)),
    once('LICENSE', licenseText(input)),
    once(
      'maatools.config.mts',
      maatoolsConfig(resourcePaths(input.resources ?? defaultResources()), input.includeAgent)
    )
  ]

  if (input.includeDevTools) {
    files.push(...devToolFiles(input))
  }

  if (input.includeGithub) {
    files.push(...githubFiles(input))
  }

  if (input.includeGitCliff) {
    files.push(...gitCliffFiles())
  }

  if (input.includeAutoFormat) {
    files.push(...autoFormatFiles())
  }

  if (input.includeOptimizeImages) {
    files.push(...optimizeImagesFiles())
  }

  if (input.includeSchemaSync) {
    files.push(...schemaSyncFiles())
  }

  if (input.includeAgent) {
    files.push(...agentFiles(input))
  }

  return files
}

export function devToolFiles(input: ProjectTemplateInput): ManagedFileInput[] {
  return [
    managed('.node-version', '24\n'),
    managed('.prettierrc.mjs', template('base/.prettierrc.mjs')),
    once('.prettierignore', template('base/.prettierignore')),
    once('.vscode/extensions.json', vscodeExtensions(input.includeAgent)),
    once('.vscode/settings.json', vscodeSettings(input.includeAgent)),
    ...(input.includeAgent ? [
          once('.vscode/launch.json', vscodeLaunch())
        ] : []),
    managed('.vscode/tasks.json', vscodeTasks(input.includeGithub)),
    managed('tools/check-project.mjs', checkProjectScript()),
    managed('tools/validate-schema.mjs', validateSchemaScript()),
    ...schemaFiles(input.includeAgent),
    once('package.json', generatedPackageJson(input)),
    once('pnpm-workspace.yaml', pnpmWorkspaceYaml())
  ]
}

export function githubFiles(input: ProjectTemplateInput): ManagedFileInput[] {
  return [
    managed('.github/workflows/check.yml', checkWorkflow()),
    releaseWorkflowFile(input),
    managed('tools/build-release.mjs', buildReleaseScript(input)),
    managed('tools/sync-runtime.mjs', syncRuntimeScript())
  ]
}

export function agentFiles(
  input: Pick<ProjectTemplateInput, 'slug' | 'version'>
): ManagedFileInput[] {
  return [
    managed('.python-version', '3.13\n'),
    managed('pyproject.toml', agentPyproject(input)),
    managed('uv.lock', generatedUvLockPlaceholder()),
    managed('requirements.txt', agentRequirements()),
    managed('agent/__init__.py', agentTemplate('__init__.py')),
    managed('agent/agent_runtime.py', agentTemplate('agent_runtime.py')),
    managed('agent/bootstrap.py', agentBootstrapPy()),
    managed('agent/main.py', agentMainPy()),
    managed('agent/custom/__init__.py', agentTemplate('custom/__init__.py')),
    managed('agent/custom/action/__init__.py', agentTemplate('custom/action/__init__.py')),
    managed('agent/custom/action/general.py', agentTemplate('custom/action/general.py')),
    managed('agent/custom/reco/__init__.py', agentTemplate('custom/reco/__init__.py')),
    managed('agent/custom/reco/general.py', agentTemplate('custom/reco/general.py')),
    managed('agent/custom/sink/__init__.py', agentTemplate('custom/sink/__init__.py')),
    managed('agent/utils/__init__.py', agentTemplate('utils/__init__.py')),
    managed('agent/utils/logger.py', agentTemplate('utils/logger.py')),
    managed('agent/utils/maa_types.py', agentTemplate('utils/maa_types.py')),
    managed('agent/utils/params.py', agentTemplate('utils/params.py')),
    managed('agent/utils/pienv.py', agentTemplate('utils/pienv.py')),
    managed('agent/utils/runtime_paths.py', agentTemplate('utils/runtime_paths.py'))
  ]
}

export function configFile(config: MaaProjectConfig): ManagedFileInput {
  return once('maa-project.json', stableJson(config))
}

export function maatoolsConfigFile(resources: string[], includeAgent = false): ManagedFileInput {
  return once('maatools.config.mts', maatoolsConfig(resources, includeAgent))
}

export function gitCliffFiles(): ManagedFileInput[] {
  return [
    managed('.github/cliff.toml', gitCliffConfig())
  ]
}

export function autoFormatFiles(): ManagedFileInput[] {
  return [
    managed('.github/workflows/format.yml', autoFormatWorkflow())
  ]
}

export function optimizeImagesFiles(): ManagedFileInput[] {
  return [
    managed('.github/workflows/optimize-images.yml', optimizeImagesWorkflow()),
    managed('tools/optimize-images.mjs', optimizeImagesScript())
  ]
}

export function dependabotFile(): ManagedFileInput {
  return managed('.github/dependabot.yml', dependabotConfig())
}

export function releaseWorkflowFile(
  input: Pick<ProjectTemplateInput, 'slug' | 'displayName' | 'includeGitCliff'>
): ManagedFileInput {
  return managed('.github/workflows/release.yml', releaseWorkflow(input))
}

export function schemaSyncFiles(): ManagedFileInput[] {
  return [
    managed(
      '.github/workflows/schema-sync.yml',
      template('addons/schema-sync/.github/workflows/schema-sync.yml')
    ),
    managed('tools/sync-schema.mjs', template('addons/schema-sync/tools/sync-schema.mjs'))
  ]
}

export function communityFiles(
  input: Pick<ProjectTemplateInput, 'displayName'>
): ManagedFileInput[] {
  return [
    once('CONTRIBUTING.md', generatedContributing(input)),
    once('.github/ISSUE_TEMPLATE/config.yml', generatedIssueTemplateConfig()),
    once('.github/ISSUE_TEMPLATE/bug_report.yml', generatedBugReportTemplate(input)),
    once('.github/ISSUE_TEMPLATE/feature_request.yml', generatedFeatureRequestTemplate()),
    once('.github/ISSUE_TEMPLATE/other_issue.yml', generatedOtherIssueTemplate(input)),
    once('.github/PULL_REQUEST_TEMPLATE.md', generatedPullRequestTemplate())
  ]
}

function managed(path: string, content: string | Buffer): ManagedFileInput {
  return { path, content, managed: true }
}

function once(path: string, content: string | Buffer): ManagedFileInput {
  return { path, content, managed: false }
}

export function emptyPng(): Buffer {
  return templateBinary('base/resource/base/image/empty.png')
}

function interfaceJson(input: ProjectTemplateInput): string {
  const controller = interfaceController(input.controllers)
  const agentBlock = input.includeAgent
    ? `,\n    "agent": ${jsonFragment([
        interfaceAgent(input.slug, input.pythonDevCommand)
      ])}`
    : ''

  return template('base/interface.json.tmpl', {
    slug: jsonStringContent(input.slug),
    displayName: jsonStringContent(input.displayName),
    version: jsonStringContent(addV(input.version)),
    description: jsonStringContent(`${input.displayName} MaaFW project`),
    controller: jsonFragment(controller),
    resources: jsonFragment(interfaceResourceItems(input.resources ?? defaultResources())),
    agentBlock
  })
}

export function interfaceController(
  kinds: ControllerKind[]
): Array<{ name: string; label: string; type: string; display_short_side: number }> {
  return kinds.map((kind) => {
    const metadata = controllerMetadata(kind)
    return {
      name: metadata.name,
      label: metadata.label,
      type: kind,
      display_short_side: 720
    }
  })
}

function controllerMetadata(kind: ControllerKind): { name: string; label: string } {
  switch (kind) {
    case 'Adb':
      return { name: 'Android', label: 'Android / Emulator' }
    case 'Win32':
      return { name: 'Windows', label: 'Windows app' }
    case 'MacOS':
      return { name: 'macOS', label: 'macOS app' }
    case 'PlayCover':
      return { name: 'PlayCover', label: 'PlayCover iOS app' }
    case 'Gamepad':
      return { name: 'Gamepad', label: 'Gamepad (Windows)' }
    case 'WlRoots':
      return { name: 'WlRoots', label: 'wlroots app (Linux)' }
  }
}

export function interfaceResourceItems(
  resources: Pick<ResourcePackConfig, 'slug' | 'label' | 'path'>[]
): Array<{ name: string; label: string; path: string[] }> {
  return resources.map((pack) => ({
    name: pack.slug,
    label: pack.label,
    path: [
      `./${pack.path}`
    ]
  }))
}

function defaultResources(): Array<Pick<ResourcePackConfig, 'slug' | 'label' | 'path'>> {
  return [
    { slug: 'base', label: 'Base', path: 'resource/base' }
  ]
}

function resourcePaths(resources: Pick<ResourcePackConfig, 'path'>[]): string[] {
  return resources.map((resource) => `./${resource.path}`)
}

export function interfaceAgent(
  slug: string,
  command: string[] | undefined
): { child_exec: string; child_args?: string[]; identifier: string } {
  const [
    childExec = '',
    ...childArgs
  ] = command ?? defaultAgentDevCommand()
  return {
    child_exec: childExec,
    ...(childArgs.length > 0 ? { child_args: childArgs } : {}),
    identifier: `${slug}.agent`
  }
}

function tutorialTaskJson(): string {
  return template('base/tasks/tutorial.json')
}

function defaultPipelineJson(): string {
  return template('base/resource/base/default_pipeline.json')
}

function tutorialPipelineJson(): string {
  return template('base/resource/base/pipeline/tutorial.json')
}

function ocrManifestJson(): string {
  return template('base/resource/base/model/ocr/manifest.json')
}

export function projectCustomSchemaFiles(includeAgent: boolean): ManagedFileInput[] {
  const customSchemaRoot = includeAgent ? 'agent/tools/schema' : 'base/tools/schema'
  return PROJECT_CUSTOM_SCHEMA_FILES.map((file) =>
    once(`tools/schema/${file}`, template(`${customSchemaRoot}/${file}`))
  )
}

function schemaFiles(includeAgent: boolean): ManagedFileInput[] {
  return [
    ...UPSTREAM_MAAFW_SCHEMA_FILES.map((file) =>
      managed(`tools/schema/${file}`, template(`base/tools/schema/${file}`))
    ),
    ...projectCustomSchemaFiles(includeAgent),
    managed('tools/schema/schema-manifest.json', template('base/tools/schema/schema-manifest.json'))
  ]
}

function generatedPackageJson(input: ProjectTemplateInput): string {
  return template('addons/dev-tools/package.json', {
    name: jsonStringContent(input.slug),
    version: jsonStringContent(input.version),
    license: jsonStringContent(packageLicense(input.license)),
    scripts: indentContinuation(stableJson(packageScripts(input)).trimEnd(), 4)
  })
}

function packageScripts(
  input: Pick<
    ProjectTemplateInput,
    'includeGithub' | 'includeSchemaSync' | 'includeAgent' | 'includeOptimizeImages'
  >
): Record<string, string> {
  const scripts: Record<string, string> = {
    format: 'prettier --write .',
    'format:check': 'prettier --check .',
    lint: 'node tools/check-project.mjs',
    'check:schema': 'node tools/validate-schema.mjs',
    'check:maa': 'pnpm exec maa-tools check',
    check: 'pnpm format:check && pnpm check:schema && pnpm check:maa && pnpm lint'
  }
  if (input.includeGithub) {
    scripts['release:dry-run'] = 'node tools/build-release.mjs --dry-run'
    scripts['sync:runtime'] = 'node tools/sync-runtime.mjs'
  }
  if (input.includeSchemaSync) {
    scripts['sync:schema'] = 'node tools/sync-schema.mjs'
  }
  if (input.includeOptimizeImages) {
    scripts['optimize:images'] = 'node tools/optimize-images.mjs'
  }
  if (input.includeAgent) {
    scripts['format:py'] = 'uv run --frozen ruff format .'
    scripts['lint:py'] = 'uv run --frozen ruff check .'
    scripts['typecheck:py'] = 'uv run --frozen pyright'
    scripts['check:py'] = 'pnpm lint:py && pnpm typecheck:py'
  }
  return scripts
}

function pnpmWorkspaceYaml(): string {
  return template('addons/dev-tools/pnpm-workspace.yaml')
}

function maatoolsConfig(resources: string[], includeAgent = false): string {
  return template('base/maatools.config.mts', {
    resources: javascriptStringArray(resources),
    vscodeBlock: includeAgent
      ? `,\n  vscode: {\n    agents: {\n      uv: '${AGENT_DEBUG_SESSION_NAME}'\n    }\n  }`
      : ''
  })
}

function checkWorkflow(): string {
  return template('addons/github/.github/workflows/check.yml')
}

function releaseWorkflow(
  input: Pick<ProjectTemplateInput, 'slug' | 'displayName' | 'includeGitCliff'>
): string {
  return trimTrailingWhitespace(
    template('addons/github/.github/workflows/release.yml', {
      slug: input.slug,
      releaseArtifactName: releaseArtifactName(input),
      releaseTargetMatrix: releaseTargetMatrixYaml(),
      gitCliffJob: input.includeGitCliff ? `  ${gitCliffWorkflowJob()}\n` : '',
      releaseNeeds: input.includeGitCliff ? '[package, git_cliff]' : 'package',
      releaseNotesInput: input.includeGitCliff
        ? 'body_path: release-assets/CHANGES.md'
        : 'generate_release_notes: true'
    })
  )
}

function gitCliffWorkflowJob(): string {
  return `git_cliff:
    name: Generate release notes
    if: startsWith(github.ref, 'refs/tags/')
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - name: Generate release notes
        shell: bash
        env:
          GITHUB_REPO: \${{ github.repository }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          version="2.13.1"
          archive="git-cliff-\${version}-x86_64-unknown-linux-gnu.tar.gz"
          mkdir -p "$RUNNER_TEMP/git-cliff"
          curl -fsSL "https://github.com/orhun/git-cliff/releases/download/v\${version}/$archive" -o "$RUNNER_TEMP/$archive"
          tar -xzf "$RUNNER_TEMP/$archive" -C "$RUNNER_TEMP/git-cliff"
          git_cliff="$(find "$RUNNER_TEMP/git-cliff" -type f -name git-cliff -perm -111 | head -n 1)"
          if [[ -z "$git_cliff" ]]; then
            echo "[ERR] git-cliff binary was not found after extraction"
            exit 1
          fi
          "$git_cliff" --config .github/cliff.toml --latest --strip header --output CHANGES.md
      - name: Upload release notes
        uses: actions/upload-artifact@v7
        with:
          name: release-notes
          path: CHANGES.md
`
}

function vscodeExtensions(includeAgent: boolean): string {
  return template(
    includeAgent
      ? 'addons/dev-tools/.vscode/extensions.agent.json'
      : 'addons/dev-tools/.vscode/extensions.json'
  )
}

function vscodeSettings(includeAgent: boolean): string {
  return template(
    includeAgent
      ? 'addons/dev-tools/.vscode/settings.agent.json'
      : 'addons/dev-tools/.vscode/settings.json'
  )
}

function vscodeTasks(includeGithub: boolean): string {
  return template(
    includeGithub
      ? 'addons/dev-tools/.vscode/tasks.github.json'
      : 'addons/dev-tools/.vscode/tasks.json'
  )
}

function vscodeLaunch(): string {
  return template('addons/dev-tools/.vscode/launch.agent.json', {
    agentDebugSessionName: AGENT_DEBUG_SESSION_NAME
  })
}

function checkProjectScript(): string {
  return template('addons/dev-tools/tools/check-project.mjs')
}

function validateSchemaScript(): string {
  return template('addons/dev-tools/tools/validate-schema.mjs')
}

function buildReleaseScript(input: Pick<ProjectTemplateInput, 'slug' | 'displayName'>): string {
  return template('addons/github/tools/build-release.mjs', {
    projectSlug: javascriptString(input.slug),
    releaseArtifactName: javascriptString(releaseArtifactName(input)),
    releaseTargetArtifactTuples: releaseTargetArtifactTuples()
  })
}

function releaseArtifactName(input: Pick<ProjectTemplateInput, 'slug' | 'displayName'>): string {
  const sanitized = [
    ...input.displayName.trim().normalize('NFKC')
  ]
    .map((char) => {
      if (/\s/u.test(char)) return '-'
      return /^[\p{L}\p{N}._-]$/u.test(char) ? char : '-'
    })
    .join('')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return sanitized || input.slug
}

function releaseTargetMatrixYaml(): string {
  return RELEASE_TARGETS.map(
    (target) => `- os: ${target.runner}
            artifact_os: ${target.artifactOs}
            arch: ${target.arch}
            runtime_os: ${target.runtimeOs}
            runtime_arch: ${target.runtimeArch}
            ext: ${target.ext}`
  ).join('\n          ')
}

function releaseTargetArtifactTuples(): string {
  return RELEASE_TARGETS.map(
    (target) => `  [
    '${target.artifactOs}',
    '${target.arch}',
    '${target.ext}'
  ]`
  ).join(',\n')
}

function syncRuntimeScript(): string {
  return template('addons/github/tools/sync-runtime.mjs')
}

function generatedReadme(input: ProjectTemplateInput): string {
  return template(input.includeAgent ? 'agent/README.md' : 'base/README.md', {
    displayName: input.displayName,
    version: input.version
  })
}

function generatedEnglishReadme(input: ProjectTemplateInput): string {
  return template(input.includeAgent ? 'agent/README.en.md' : 'base/README.en.md', {
    displayName: input.displayName,
    version: input.version
  })
}

function gitCliffConfig(): string {
  return template('addons/git-cliff/.github/cliff.toml')
}

function autoFormatWorkflow(): string {
  return template('addons/auto-format/.github/workflows/format.yml')
}

function optimizeImagesWorkflow(): string {
  return template('addons/optimize-images/.github/workflows/optimize-images.yml')
}

function optimizeImagesScript(): string {
  return template('addons/optimize-images/tools/optimize-images.mjs')
}

function trimTrailingWhitespace(content: string): string {
  return content.replace(/[ \t]+$/gm, '')
}

function dependabotConfig(): string {
  return template('addons/dependabot/.github/dependabot.yml')
}

function generatedContributing(input: Pick<ProjectTemplateInput, 'displayName'>): string {
  return template('addons/community/CONTRIBUTING.md', {
    displayName: input.displayName
  })
}

function generatedIssueTemplateConfig(): string {
  return template('addons/community/issue_config.yml')
}

function generatedBugReportTemplate(input: Pick<ProjectTemplateInput, 'displayName'>): string {
  return template('addons/community/bug_report.yml', {
    displayName: jsonStringContent(input.displayName)
  })
}

function generatedFeatureRequestTemplate(): string {
  return template('addons/community/feature_request.yml')
}

function generatedOtherIssueTemplate(input: Pick<ProjectTemplateInput, 'displayName'>): string {
  return template('addons/community/other_issue.yml', {
    displayName: jsonStringContent(input.displayName)
  })
}

function generatedPullRequestTemplate(): string {
  return template('addons/community/PULL_REQUEST_TEMPLATE.md')
}

function licenseText(input: Pick<ProjectTemplateInput, 'license' | 'displayName'>): string {
  if (input.license === 'None') return ''
  if (input.license === 'MIT') {
    return template('base/licenses/MIT.txt', {
      year: String(new Date().getFullYear()),
      displayName: input.displayName
    })
  }
  return template('base/licenses/AGPL-3.0-or-later.txt')
}

function packageLicense(license: LicenseKind): string {
  return license === 'None' ? 'UNLICENSED' : license
}

function agentPyproject(input: Pick<ProjectTemplateInput, 'slug' | 'version'>): string {
  return template('agent/pyproject.toml', {
    slug: input.slug,
    version: input.version
  })
}

function generatedUvLockPlaceholder(): string {
  return template('agent/uv.lock')
}

function agentMainPy(): string {
  return template('agent/agent/main.py')
}

function agentTemplate(path: string): string {
  return template(`agent/agent/${path}`)
}

function agentRequirements(): string {
  return template('agent/requirements.txt')
}

function agentBootstrapPy(): string {
  return template('agent/agent/bootstrap.py')
}

function template(path: string, values: Record<string, string> = {}): string {
  let content = embeddedTextTemplates[path] ?? readFileSync(join(TEMPLATE_ROOT, path), 'utf8')
  for (const [
    key,
    value
  ] of Object.entries(values)) {
    content = content.replaceAll(`{{${key}}}`, value)
  }
  return content
}

function templateBinary(path: string): Buffer {
  const embedded = embeddedBinaryTemplates[path]
  if (embedded !== undefined) return Buffer.from(embedded, 'base64')
  return readFileSync(join(TEMPLATE_ROOT, path))
}

function resolveTemplateRoot(): string {
  const metaUrl = import.meta.url
  return metaUrl
    ? join(dirname(fileURLToPath(metaUrl)), '..', 'templates')
    : join(process.cwd(), 'templates')
}

function jsonFragment(value: unknown): string {
  return prettyJson(value).trimEnd().replace(/\n/g, '\n    ')
}

function jsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

function javascriptStringArray(values: string[]): string {
  if (values.length === 0) return '[]'
  return `[\n${values.map((value) => `    ${javascriptString(value)}`).join(',\n')}\n  ]`
}

function javascriptString(value: string): string {
  return `'${value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')}'`
}

function indentContinuation(value: string, spaces: number): string {
  const indent = ' '.repeat(spaces)
  const [
    first = '',
    ...rest
  ] = value.split('\n')
  return [
    first,
    ...rest.map((line) => indent + line)
  ].join('\n')
}
