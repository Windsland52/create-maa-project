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
    controller: ControllerKind
    license: LicenseKind
    includeAgent: boolean
    pythonDevCommand?: string[] | undefined
    resources?: Pick<ResourcePackConfig, 'slug' | 'label' | 'path'>[]
}

export function baseProjectFiles(input: ProjectTemplateInput): ManagedFileInput[] {
    const files: ManagedFileInput[] = [
        managed('.editorconfig', template('base/.editorconfig')),
        once('.gitignore', template('base/gitignore.tmpl')),
        managed('.gitattributes', template('base/.gitattributes')),
        managed('.node-version', '24\n'),
        managed('.prettierrc.mjs', template('base/.prettierrc.mjs')),
        once('.prettierignore', template('base/.prettierignore')),
        once('.vscode/extensions.json', vscodeExtensions(input.includeAgent)),
        once('.vscode/settings.json', vscodeSettings(input.includeAgent)),
        managed('.vscode/tasks.json', vscodeTasks()),
        managed('.github/workflows/check.yml', checkWorkflow(input.includeAgent)),
        releaseWorkflowFile(input),
        ...schemaSyncFiles(),
        managed('tools/check-project.mjs', checkProjectScript()),
        managed('tools/validate-schema.mjs', validateSchemaScript()),
        managed('tools/build-release.mjs', buildReleaseScript(input.slug)),
        managed('tools/sync-runtime.mjs', syncRuntimeScript()),
        ...schemaFiles(),
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
        once('package.json', generatedPackageJson(input)),
        once('pnpm-workspace.yaml', pnpmWorkspaceYaml()),
        once('maatools.config.mts', maatoolsConfig(resourcePaths(input.resources ?? defaultResources())))
    ]

    if (input.includeAgent) {
        files.push(...agentFiles(input))
    }

    return files
}

export function agentFiles(input: Pick<ProjectTemplateInput, 'slug' | 'version'>): ManagedFileInput[] {
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

export function maatoolsConfigFile(resources: string[]): ManagedFileInput {
    return once('maatools.config.mts', maatoolsConfig(resources))
}

export function releaseWorkflowFile(
    input: Pick<ProjectTemplateInput, 'slug' | 'includeAgent'>
): ManagedFileInput {
    return managed('.github/workflows/release.yml', releaseWorkflow(input.slug, input.includeAgent))
}

export function schemaSyncFiles(): ManagedFileInput[] {
    return [
        managed('.github/workflows/schema-sync.yml', template('base/.github/workflows/schema-sync.yml')),
        managed('tools/sync-schema.mjs', template('base/tools/sync-schema.mjs'))
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
    const controller = interfaceController(input.controller)
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

export function interfaceController(kind: ControllerKind): Array<{ name: string; type: string }> {
    if (kind === 'None') return []
    return [
        {
            name: kind.toLowerCase(),
            type: kind === 'ADB' ? 'Adb' : kind
        }
    ]
}

export function interfaceResourceItems(
    resources: Pick<ResourcePackConfig, 'slug' | 'label' | 'path'>[]
): Array<{ name: string; label: string; path: string[] }> {
    return resources.map((pack) => ({
        name: pack.slug,
        label: pack.label,
        path: [`./${pack.path}`]
    }))
}

function defaultResources(): Array<Pick<ResourcePackConfig, 'slug' | 'label' | 'path'>> {
    return [{ slug: 'base', label: 'Base', path: 'resource/base' }]
}

function resourcePaths(resources: Pick<ResourcePackConfig, 'path'>[]): string[] {
    return resources.map((resource) => `./${resource.path}`)
}

export function interfaceAgent(
    slug: string,
    command: string[] | undefined
): { child_exec: string; child_args?: string[]; identifier: string } {
    const [childExec = 'python', ...childArgs] = command ?? ['python', 'agent/bootstrap.py']
    return {
        child_exec: childExec,
        ...(childArgs.length > 0 ? { child_args: childArgs } : {}),
        identifier: `${slug}.agent`
    }
}

function tutorialTaskJson(): string {
    return prettyJson({
        task: [
            {
                name: 'Tutorial',
                entry: 'Tutorial.Start'
            }
        ]
    })
}

function defaultPipelineJson(): string {
    return template('base/resource/base/default_pipeline.json')
}

function tutorialPipelineJson(): string {
    return template('base/resource/base/pipeline/tutorial.json')
}

function ocrManifestJson(): string {
    return prettyJson({
        schemaVersion: 1,
        assets: [
            { path: 'det.onnx', sha256: null, pending: true },
            { path: 'rec.onnx', sha256: null, pending: true },
            { path: 'keys.txt', sha256: null, pending: true },
            { path: 'README.md', sha256: null, pending: true }
        ]
    })
}

function schemaFiles(): ManagedFileInput[] {
    return [
        ...UPSTREAM_MAAFW_SCHEMA_FILES.map((file) =>
            managed(`tools/schema/${file}`, template(`base/tools/schema/${file}`))
        ),
        ...PROJECT_CUSTOM_SCHEMA_FILES.map((file) =>
            once(`tools/schema/${file}`, template(`base/tools/schema/${file}`))
        ),
        managed(
            'tools/schema/schema-manifest.json',
            template('base/tools/schema/schema-manifest.json')
        )
    ]
}

function generatedPackageJson(input: ProjectTemplateInput): string {
    const scripts: Record<string, string> = {
        format: 'prettier --write .',
        'format:check': 'prettier --check .',
        lint: 'node tools/check-project.mjs',
        'check:schema': 'node tools/validate-schema.mjs',
        'check:maa': 'pnpm exec maa-tools check',
        check: 'pnpm format:check && pnpm check:schema && pnpm check:maa && pnpm lint',
        'release:dry-run': 'node tools/build-release.mjs --dry-run',
        'sync:schema': 'node tools/sync-schema.mjs',
        'sync:runtime': 'node tools/sync-runtime.mjs'
    }
    if (input.includeAgent) {
        scripts['format:py'] = 'uv run --frozen ruff format .'
        scripts['lint:py'] = 'uv run --frozen ruff check .'
        scripts['typecheck:py'] = 'uv run --frozen pyright'
        scripts['check:py'] = 'pnpm lint:py && pnpm typecheck:py'
    }
    return stableJson({
        name: input.slug,
        version: input.version,
        private: true,
        type: 'module',
        license: packageLicense(input.license),
        scripts,
        engines: {
            node: '>=24'
        },
        devDependencies: {
            '@nekosu/maa-tools': '1.0.24',
            '@nekosu/prettier-plugin-maafw-sort': '1.0.5',
            prettier: '3.8.4',
            'prettier-plugin-multiline-arrays': '4.1.9'
        },
        packageManager: 'pnpm@11.5.1'
    })
}

function pnpmWorkspaceYaml(): string {
    return `packages: []
minimumReleaseAgeExclude:
  - prettier@3.8.4
`
}

function maatoolsConfig(resources: string[]): string {
    return `import { defineConfig } from '@nekosu/maa-tools'

export default defineConfig({
    interface: 'interface.json',
    resource: ${JSON.stringify(resources)}
})
`
}

function pythonWorkflowSetup(includeAgent: boolean): string {
    return includeAgent
        ? `      - uses: actions/setup-python@v6
        with:
          python-version: '3.13'
      - uses: astral-sh/setup-uv@v8.1.0
`
        : ''
}

function pythonWorkflowCheck(includeAgent: boolean): string {
    return includeAgent ? `      - run: pnpm check:py\n` : ''
}

function checkWorkflow(includeAgent: boolean): string {
    return `name: Check

on:
  pull_request:
  push:
    branches: [main, master]

jobs:
  check:
    permissions:
      contents: read
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
${pythonWorkflowSetup(includeAgent)}
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: pnpm
      - run: node tools/check-project.mjs
      - run: pnpm install --frozen-lockfile
      - run: pnpm check
${pythonWorkflowCheck(includeAgent)}
`
}

function releaseWorkflow(slug: string, includeAgent: boolean): string {
    return `name: Release

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:

jobs:
  package:
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        include:
${releaseTargetMatrixYaml()}
    runs-on: \${{ matrix.os }}
    steps:
      - uses: actions/checkout@v6
${pythonWorkflowSetup(includeAgent)}
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: pnpm
      - run: node tools/check-project.mjs
      - run: pnpm install --frozen-lockfile
      - run: pnpm check
${pythonWorkflowCheck(includeAgent)}
      - run: pnpm release:dry-run
        if: github.event_name == 'workflow_dispatch'
      - run: pnpm sync:runtime
        if: github.event_name != 'workflow_dispatch'
        env:
          CREATE_MAA_PROJECT_RUNTIME_PLATFORM: \${{ matrix.runtime_os }}-\${{ matrix.runtime_arch }}
      - run: node tools/build-release.mjs
        if: github.event_name != 'workflow_dispatch'
        env:
          CREATE_MAA_PROJECT_RUNTIME_PLATFORM: \${{ matrix.runtime_os }}-\${{ matrix.runtime_arch }}
      - name: Package
        if: github.event_name != 'workflow_dispatch'
        shell: bash
        run: |
          mkdir -p dist
          archive="${slug}-\${{ matrix.artifact_os }}-\${{ matrix.arch }}-\${GITHUB_REF_NAME}-MFAA.\${{ matrix.ext }}"
          (
            cd dist/package
            if [[ "\${{ matrix.ext }}" == "zip" ]]; then
              7z a "../$archive" .
            else
              tar -czf "../$archive" .
              tar -tzvf "../$archive" > "../$archive.manifest"
              if ! awk '$1 ~ /^-/ && $0 ~ /(^|\\/)(${slug}|MFAAvalonia|MaaPiCli|MaaAgentServer|maa-cli)$/ && $1 !~ /^-..x/ { print; bad=1 } END { exit bad }' "../$archive.manifest"; then
                echo "[ERR] Unix archive is missing executable permission metadata"
                exit 1
              fi
              echo "[OK] Unix archive executable metadata smoke passed"
            fi
          )
          rm -rf dist/package
      - uses: actions/upload-artifact@v7
        if: github.event_name != 'workflow_dispatch'
        with:
          name: \${{ matrix.artifact_os }}-\${{ matrix.arch }}
          path: dist/*
      - uses: softprops/action-gh-release@v3
        if: startsWith(github.ref, 'refs/tags/')
        with:
          generate_release_notes: true
          files: dist/*
`
}

function vscodeExtensions(includeAgent: boolean): string {
    const recommendations = [
        'nekosu.maa-support',
        'esbenp.prettier-vscode',
        'DavidAnson.vscode-markdownlint'
    ]
    if (includeAgent) {
        recommendations.push('charliermarsh.ruff', 'ms-python.python', 'ms-python.vscode-pylance')
    }
    return stableJson({
        recommendations
    })
}

function vscodeSettings(includeAgent: boolean): string {
    const settings: Record<string, unknown> = {
        'editor.formatOnSave': true,
        'files.eol': '\n',
        'files.associations': {
            '*.json': 'jsonc',
            '*.jsonc': 'jsonc'
        },
        '[json]': {
            'editor.defaultFormatter': 'esbenp.prettier-vscode'
        },
        '[jsonc]': {
            'editor.defaultFormatter': 'esbenp.prettier-vscode'
        },
        'json.schemas': [
            {
                fileMatch: ['/interface.json'],
                url: './tools/schema/interface.schema.json'
            },
            {
                fileMatch: ['/tasks/*.json'],
                url: './tools/schema/interface_import.schema.json'
            },
            {
                fileMatch: [
                    '/resource/*/default_pipeline.json',
                    '/resource/*/pipeline/*.json',
                    '/resource/*/pipeline/**/*.json'
                ],
                url: './tools/schema/pipeline.schema.json'
            }
        ]
    }
    if (includeAgent) {
        settings['python.defaultInterpreterPath'] = '${workspaceFolder}/.venv/bin/python'
        settings['[python]'] = {
            'editor.defaultFormatter': 'charliermarsh.ruff'
        }
    }
    return stableJson(settings)
}

function vscodeTasks(): string {
    return stableJson({
        version: '2.0.0',
        tasks: [
            { label: 'check', type: 'shell', command: 'pnpm check', problemMatcher: [] },
            { label: 'lint', type: 'shell', command: 'pnpm lint', problemMatcher: [] },
            { label: 'format', type: 'shell', command: 'pnpm format', problemMatcher: [] },
            {
                label: 'release dry-run',
                type: 'shell',
                command: 'pnpm release:dry-run',
                problemMatcher: []
            }
        ]
    })
}

function checkProjectScript(): string {
    return `import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'

const interfaceJson = JSON.parse(readFileSync('interface.json', 'utf8'))
const project = JSON.parse(readFileSync('maa-project.json', 'utf8'))
const lock = JSON.parse(readFileSync('maa-project.lock.json', 'utf8'))
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const imports = interfaceJson.import ?? []

if (interfaceJson.name !== project.project?.slug) {
    throw new Error('interface.json name must match maa-project.json project.slug')
}

if (interfaceJson.label !== project.project?.displayName) {
    throw new Error('interface.json label must match maa-project.json project.displayName')
}

if (interfaceJson.version !== addV(project.project?.version)) {
    throw new Error('interface.json version must match maa-project.json project.version')
}

if (packageJson.name !== project.project?.slug) {
    throw new Error('package.json name must match maa-project.json project.slug')
}

if (packageJson.version !== project.project?.version) {
    throw new Error('package.json version must match maa-project.json project.version')
}

const expectedPackageLicense = project.license?.spdx === 'None' ? 'UNLICENSED' : project.license?.spdx
if (packageJson.license !== expectedPackageLicense) {
    throw new Error('package.json license must match maa-project.json license.spdx')
}

if (packageJson.packageManager !== 'pnpm@11.5.1') {
    throw new Error('package.json packageManager must be pnpm@11.5.1')
}

if (packageJson.engines?.node !== '>=24') {
    throw new Error('package.json engines.node must be >=24')
}

for (const [name, version] of Object.entries(expectedDevDependencies())) {
    if (packageJson.devDependencies?.[name] !== version) {
        throw new Error(\`package.json \${dependencyLabel(name)} must be pinned to \${version}\`)
    }
}

for (const [name, command] of Object.entries(expectedPackageScripts(project))) {
    if (packageJson.scripts?.[name] !== command) {
        const message =
            name === 'check:maa'
                ? 'package.json scripts.check:maa must use local pnpm exec maa-tools check'
                : \`package.json scripts.\${name} must be \${command}\`
        throw new Error(message)
    }
}

if (!existsSync('.node-version')) {
    throw new Error('.node-version is missing')
}

if (readFileSync('.node-version', 'utf8').trim() !== '24') {
    throw new Error('.node-version must pin Node 24')
}

for (const workflow of ['.github/workflows/check.yml', '.github/workflows/release.yml', '.github/workflows/schema-sync.yml']) {
    if (!existsSync(workflow)) {
        throw new Error(\`\${workflow} is missing\`)
    }
    if (!workflowPinsNode24(readFileSync(workflow, 'utf8'))) {
        throw new Error(\`\${workflow} must use Node 24 in actions/setup-node\`)
    }
}

if (!existsSync('.vscode/settings.json')) {
    throw new Error('.vscode/settings.json is missing')
}

const vscodeSettings = JSON.parse(readFileSync('.vscode/settings.json', 'utf8'))
if (vscodeSettings['editor.formatOnSave'] !== true) {
    throw new Error('.vscode/settings.json editor.formatOnSave must be true')
}

if (vscodeSettings['files.eol'] !== '\\n') {
    throw new Error('.vscode/settings.json files.eol must be LF')
}

if (!hasJsoncFileAssociations(vscodeSettings['files.associations'])) {
    throw new Error('.vscode/settings.json files.associations must map *.json and *.jsonc to jsonc')
}

for (const language of ['[json]', '[jsonc]']) {
    if (editorDefaultFormatter(vscodeSettings[language]) !== 'esbenp.prettier-vscode') {
        throw new Error(
            \`.vscode/settings.json \${language} editor.defaultFormatter must be esbenp.prettier-vscode\`
        )
    }
}

if (!hasInterfaceJsonSchema(vscodeSettings['json.schemas'])) {
    throw new Error(
        '.vscode/settings.json json.schemas must map /interface.json to ./tools/schema/interface.schema.json'
    )
}

if (
    !hasPending(lock, 'node-deps') &&
    typeof packageJson.packageManager === 'string' &&
    packageJson.packageManager.startsWith('pnpm@') &&
    !existsSync('pnpm-lock.yaml')
) {
    throw new Error('pnpm-lock.yaml is missing; run pnpm install')
}

if (existsSync('pyproject.toml')) {
    const pyproject = parseTomlProjectMetadata(readFileSync('pyproject.toml', 'utf8'))
    if (pyproject.name !== project.project?.slug) {
        throw new Error('pyproject.toml project.name must match maa-project.json project.slug')
    }
    if (pyproject.version !== project.project?.version) {
        throw new Error('pyproject.toml project.version must match maa-project.json project.version')
    }
}

if (JSON.stringify(interfaceJson.controller ?? []) !== JSON.stringify(interfaceController(projectControllerKind(project)))) {
    throw new Error('interface.json controller must match maa-project.json controller.kind')
}

if (interfaceJson.agent !== undefined && !Array.isArray(interfaceJson.agent)) {
    throw new Error('interface.json agent must be an array')
}

if (JSON.stringify(interfaceJson.agent) !== JSON.stringify(interfaceAgent(project))) {
    throw new Error('interface.json agent must match maa-project.json python config')
}

const resources = interfaceResources(interfaceJson.resource)
if (!Array.isArray(interfaceJson.resource) || resources[0]?.path?.[0] !== './resource/base') {
    throw new Error('interface.json resource must start with ./resource/base')
}

const expectedResources = interfaceResourceItems(project.resources ?? [])
if (JSON.stringify(resources) !== JSON.stringify(expectedResources)) {
    throw new Error('interface.json resource order differs from maa-project.json resources')
}

const expectedResourcePaths = (project.resources ?? []).map((pack) => './' + pack.path)
if (!existsSync('maatools.config.mts')) {
    throw new Error('maatools.config.mts is missing')
}

const maatoolsResources = parseMaatoolsResourceArray(readFileSync('maatools.config.mts', 'utf8'))
if (!maatoolsResources || JSON.stringify(maatoolsResources) !== JSON.stringify(expectedResourcePaths)) {
    throw new Error('maatools.config.mts resource order differs from maa-project.json resources')
}

for (const path of [...interfaceResourcePaths(interfaceJson.resource), ...imports]) {
    if (typeof path !== 'string' || path.includes('\\\\')) {
        throw new Error('interface/import paths must be strings with forward slashes')
    }
    if (!existsSync(path)) {
        throw new Error(\`referenced path does not exist: \${path}\`)
    }
}

for (const path of walkJsonFiles(['interface.json', 'tasks', 'resource'])) {
    const content = readFileSync(path, 'utf8')
    if (content.includes('\\\\')) {
        throw new Error(\`MaaFW JSON paths must use forward slashes: \${path}\`)
    }
}

for (const [path, state] of Object.entries(lock.managedFiles ?? {})) {
    if (!existsSync(path)) {
        throw new Error(\`managed file is missing: \${path}\`)
    }
    const hash = managedFileHash(path, readFileSync(path))
    if (hash !== state.hash) {
        throw new Error(\`managed file changed since last accepted baseline: \${path}\`)
    }
    if (state.acceptedAt) {
        console.warn('[INFO] Managed file has accepted local changes: ' + path)
        console.warn('       Future template updates may conflict with this file.')
    }
}

for (const item of lock.pending ?? []) {
    console.error(\`[ERR] Pending \${item.kind}: \${item.command}\`)
}

if ((lock.pending ?? []).length > 0) {
    throw new Error('project has pending actions; run create-maa-project --doctor')
}

console.log('[OK] project structure looks valid')

function sha256(content) {
    return createHash('sha256').update(content).digest('hex')
}

function projectControllerKind(project) {
    const kind = project.controller?.kind
    return kind === 'ADB' || kind === 'Win32' || kind === 'None' ? kind : 'ADB'
}

function interfaceController(kind) {
    return kind === 'None' ? [] : [{ name: kind.toLowerCase(), type: kind === 'ADB' ? 'Adb' : kind }]
}

function interfaceAgent(project) {
    if (!project.python) return undefined
    const [childExec = 'python', ...childArgs] = project.python.devCommand ?? ['python', 'agent/bootstrap.py']
    return [
        {
            child_exec: childExec,
            ...(childArgs.length > 0 ? { child_args: childArgs } : {}),
            identifier: project.project?.slug + '.agent'
        }
    ]
}

function interfaceResourceItems(resources) {
    return resources.map((pack) => ({
        name: pack.slug,
        label: pack.label,
        path: ['./' + pack.path]
    }))
}

function interfaceResources(value) {
    return Array.isArray(value) ? value.filter((item) => isRecord(item)) : []
}

function arrayOfStrings(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

function interfaceResourcePaths(value) {
    return interfaceResources(value).flatMap((item) => arrayOfStrings(item.path))
}

function addV(version) {
    return String(version ?? '').startsWith('v') ? version : 'v' + version
}

function hasPending(lock, kind) {
    return (lock.pending ?? []).some((item) => item?.kind === kind)
}

function workflowPinsNode24(content) {
    return /node-version:\\s*['"]?24['"]?/.test(content)
}

function editorDefaultFormatter(value) {
    if (!isRecord(value)) return undefined
    return typeof value['editor.defaultFormatter'] === 'string'
        ? value['editor.defaultFormatter']
        : undefined
}

function hasInterfaceJsonSchema(value) {
    if (!Array.isArray(value)) return false
    return value.some((item) => {
        if (!isRecord(item) || item.url !== './tools/schema/interface.schema.json') return false
        return Array.isArray(item.fileMatch) && item.fileMatch.includes('/interface.json')
    })
}

function hasJsoncFileAssociations(value) {
    return isRecord(value) && value['*.json'] === 'jsonc' && value['*.jsonc'] === 'jsonc'
}

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripDotSlash(path) {
    return path.startsWith('./') ? path.slice(2) : path
}

function dependencyLabel(name) {
    return name === '@nekosu/maa-tools' ? '@nekosu/maa-tools' : 'devDependencies.' + name
}

function expectedDevDependencies() {
    return {
        '@nekosu/maa-tools': '1.0.24',
        '@nekosu/prettier-plugin-maafw-sort': '1.0.5',
        prettier: '3.8.4',
        'prettier-plugin-multiline-arrays': '4.1.9'
    }
}

function expectedPackageScripts(project) {
    const scripts = {
        format: 'prettier --write .',
        'format:check': 'prettier --check .',
        lint: 'node tools/check-project.mjs',
        'check:schema': 'node tools/validate-schema.mjs',
        'check:maa': 'pnpm exec maa-tools check',
        check: 'pnpm format:check && pnpm check:schema && pnpm check:maa && pnpm lint',
        'release:dry-run': 'node tools/build-release.mjs --dry-run',
        'sync:schema': 'node tools/sync-schema.mjs',
        'sync:runtime': 'node tools/sync-runtime.mjs'
    }
    if (project.python) {
        scripts['format:py'] = 'uv run --frozen ruff format .'
        scripts['lint:py'] = 'uv run --frozen ruff check .'
        scripts['typecheck:py'] = 'uv run --frozen pyright'
        scripts['check:py'] = 'pnpm lint:py && pnpm typecheck:py'
    }
    return scripts
}

function managedFileHash(path, content) {
    if (path === '.gitignore') {
        return sha256(extractGitignoreBlock(content.toString()) ?? content)
    }
    return sha256(content)
}

function extractGitignoreBlock(content) {
    const start = content.indexOf('# BEGIN create-maa-project')
    if (start < 0) return undefined
    const markerEnd = content.indexOf('# END create-maa-project', start)
    if (markerEnd < 0) return undefined
    const endOfLine = content.indexOf('\\n', markerEnd)
    return content.slice(start, endOfLine >= 0 ? endOfLine + 1 : content.length)
}

function walkJsonFiles(paths) {
    const files = []
    for (const path of paths) {
        if (!existsSync(path)) continue
        const stat = statSync(path)
        if (stat.isDirectory()) {
            for (const entry of readdirSync(path)) {
                files.push(...walkJsonFiles([\`\${path}/\${entry}\`]))
            }
        } else if (path.endsWith('.json')) {
            files.push(path)
        }
    }
    return files
}

function parseTomlProjectMetadata(content) {
    const section = tomlProjectSection(content)
    return {
        name: parseTomlStringField(section, 'name'),
        version: parseTomlStringField(section, 'version')
    }
}

function tomlProjectSection(content) {
    const section = []
    let inside = false
    for (const line of content.split(/\\r?\\n/)) {
        if (/^\\s*\\[project\\]\\s*$/.test(line)) {
            inside = true
            continue
        }
        if (inside && /^\\s*\\[[^\\]]+\\]\\s*$/.test(line)) break
        if (inside) section.push(line)
    }
    return section.join('\\n')
}

function parseTomlStringField(section, key) {
    const match = section.match(new RegExp('^\\\\s*' + key + '\\\\s*=\\\\s*"([^"]*)"\\\\s*$', 'm'))
    return match?.[1]
}

function parseMaatoolsResourceArray(content) {
    const match = content.match(/resource\\s*:\\s*(\\[[^\\]]*\\])/)
    if (!match?.[1]) return undefined
    try {
        const parsed = JSON.parse(match[1])
        return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
    } catch {
        return undefined
    }
}
`
}

function validateSchemaScript(): string {
    return `import { existsSync, readFileSync } from 'node:fs'

if (!existsSync('tools/schema')) {
    throw new Error('Missing tools/schema directory')
}

const interfaceJson = readJson('interface.json')
const interfaceSchema = readJson('tools/schema/interface.schema.json')
const project = readJson('maa-project.json')
const lock = readJson('maa-project.lock.json')
const packageJson = readJson('package.json')

assertRecord(interfaceJson, 'interface.json')
assertEqual(interfaceJson.interface_version, 2, 'interface.json interface_version must be 2')
assertSlug(interfaceJson.name, 'interface.json name')
assertNonEmptyString(interfaceJson.label, 'interface.json label')
assertVersion(interfaceJson.version, 'interface.json version', true)
assertArrayOfRecords(interfaceJson.controller, 'interface.json controller')
assertArrayOfRecords(interfaceJson.resource, 'interface.json resource')
assertArrayOfStrings(interfaceJson.import, 'interface.json import')

for (const [index, controller] of interfaceJson.controller.entries()) {
    assertNonEmptyString(controller.name, 'interface.json controller[' + index + '].name')
    assertEnum(controller.type, ['Adb', 'Win32'], 'interface.json controller[' + index + '].type')
}

for (const [index, resource] of interfaceJson.resource.entries()) {
    assertNonEmptyString(resource.name, 'interface.json resource[' + index + '].name')
    assertArrayOfStrings(resource.path, 'interface.json resource[' + index + '].path')
}

if (interfaceJson.task !== undefined) {
    assertArrayOfRecords(interfaceJson.task, 'interface.json task')
    for (const [index, task] of interfaceJson.task.entries()) {
        assertNonEmptyString(task.name, 'interface.json task[' + index + '].name')
        assertNonEmptyString(task.entry, 'interface.json task[' + index + '].entry')
    }
}

if (interfaceJson.agent !== undefined) {
    assertArrayOfRecords(interfaceJson.agent, 'interface.json agent')
    for (const [index, agent] of interfaceJson.agent.entries()) {
        assertNonEmptyString(agent.child_exec, 'interface.json agent[' + index + '].child_exec')
        if (agent.child_args !== undefined) {
            assertArrayOfStrings(agent.child_args, 'interface.json agent[' + index + '].child_args')
        }
        assertNonEmptyString(agent.identifier, 'interface.json agent[' + index + '].identifier')
    }
}

assertRecord(interfaceSchema, 'tools/schema/interface.schema.json')
assertEqual(interfaceSchema.title, 'MaaFramework Project Interface V2', 'tools/schema/interface.schema.json title must be MaaFramework Project Interface V2')
assertRecord(interfaceSchema.properties, 'tools/schema/interface.schema.json properties')
assertRecord(interfaceSchema.properties.interface_version, 'tools/schema/interface.schema.json properties.interface_version')
assertEqual(interfaceSchema.properties.interface_version.const, 2, 'tools/schema/interface.schema.json interface_version const must be 2')

assertRecord(project, 'maa-project.json')
assertEqual(project.schemaVersion, 1, 'maa-project.json schemaVersion must be 1')
assertRecord(project.project, 'maa-project.json project')
assertSlug(project.project.slug, 'maa-project.json project.slug')
assertNonEmptyString(project.project.displayName, 'maa-project.json project.displayName')
assertVersion(project.project.version, 'maa-project.json project.version', false)
assertEnum(project.project.initialTemplate, ['pipeline', 'agent'], 'maa-project.json project.initialTemplate')
assertRecord(project.features, 'maa-project.json features')
for (const feature of ['ci', 'release', 'vscode', 'quality']) {
    assertFeature(project.features[feature], 'maa-project.json features.' + feature)
}
assertRecord(project.controller, 'maa-project.json controller')
assertEnum(project.controller.kind, ['ADB', 'Win32', 'None'], 'maa-project.json controller.kind')
assertArrayOfRecords(project.resources, 'maa-project.json resources')
for (const [index, resource] of project.resources.entries()) {
    assertSlug(resource.slug, 'maa-project.json resources[' + index + '].slug')
    assertNonEmptyString(resource.label, 'maa-project.json resources[' + index + '].label')
    assertForwardRelativePath(resource.path, 'maa-project.json resources[' + index + '].path')
    assertBoolean(resource.enabled, 'maa-project.json resources[' + index + '].enabled')
}
assertRecord(project.runtime, 'maa-project.json runtime')
assertRecord(project.runtime.mfa, 'maa-project.json runtime.mfa')
assertNonEmptyString(project.runtime.mfa.channel, 'maa-project.json runtime.mfa.channel')
assertBoolean(project.runtime.mfa.enabled, 'maa-project.json runtime.mfa.enabled')
assertRecord(project.network, 'maa-project.json network')
assertEnum(project.network.mode, ['auto', 'official'], 'maa-project.json network.mode')
assertRecord(project.license, 'maa-project.json license')
assertEnum(project.license.spdx, ['AGPL-3.0-or-later', 'MIT', 'None'], 'maa-project.json license.spdx')

assertRecord(lock, 'maa-project.lock.json')
assertEqual(lock.schemaVersion, 1, 'maa-project.lock.json schemaVersion must be 1')
assertRecord(lock.template, 'maa-project.lock.json template')
for (const field of ['createdBy', 'lastUpdatedBy', 'templateVersion']) {
    assertNonEmptyString(lock.template[field], 'maa-project.lock.json template.' + field)
}
assertArrayOfRecords(lock.pending, 'maa-project.lock.json pending')
for (const [index, item] of lock.pending.entries()) {
    assertNonEmptyString(item.kind, 'maa-project.lock.json pending[' + index + '].kind')
    assertNonEmptyString(item.reason, 'maa-project.lock.json pending[' + index + '].reason')
    assertNonEmptyString(item.command, 'maa-project.lock.json pending[' + index + '].command')
}
assertRecord(lock.managedFiles, 'maa-project.lock.json managedFiles')
assertRecord(lock.createdFiles, 'maa-project.lock.json createdFiles')

assertRecord(packageJson, 'package.json')
assertSlug(packageJson.name, 'package.json name')
assertVersion(packageJson.version, 'package.json version', false)
assertEqual(packageJson.private, true, 'package.json private must be true')
assertEqual(packageJson.type, 'module', 'package.json type must be module')
assertRecord(packageJson.scripts, 'package.json scripts')

console.log('[OK] local project schema shape is valid')

function readJson(path) {
    if (!existsSync(path)) throw new Error(path + ' is missing')
    return JSON.parse(readFileSync(path, 'utf8'))
}

function assertRecord(value, label) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(label + ' must be an object')
    }
}

function assertArrayOfRecords(value, label) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'object' || item === null || Array.isArray(item))) {
        throw new Error(label + ' must be an array of objects')
    }
}

function assertArrayOfStrings(value, label) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new Error(label + ' must be an array of strings')
    }
}

function assertNonEmptyString(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(label + ' must be a non-empty string')
    }
}

function assertSlug(value, label) {
    assertNonEmptyString(value, label)
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
        throw new Error(label + ' must be an ASCII kebab-case slug')
    }
}

function assertVersion(value, label, withV) {
    assertNonEmptyString(value, label)
    const pattern = withV
        ? /^v(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$/
        : /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$/
    if (!pattern.test(value)) {
        throw new Error(label + ' must be a SemVer version' + (withV ? ' with v prefix' : ''))
    }
}

function assertEnum(value, allowed, label) {
    if (!allowed.includes(value)) {
        throw new Error(label + ' must be one of: ' + allowed.join(', '))
    }
}

function assertBoolean(value, label) {
    if (typeof value !== 'boolean') {
        throw new Error(label + ' must be a boolean')
    }
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(message)
    }
}

function assertFeature(value, label) {
    assertRecord(value, label)
    assertBoolean(value.enabled, label + '.enabled')
}

function assertForwardRelativePath(value, label) {
    assertNonEmptyString(value, label)
    if (value.startsWith('/') || value.includes('..') || value.includes('\\\\')) {
        throw new Error(label + ' must be a forward-slash relative path')
    }
}
`
}

function buildReleaseScript(slug: string): string {
    return `import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const dryRun = process.argv.includes('--dry-run')
const projectSlug = ${JSON.stringify(slug)}
mkdirSync('dist', { recursive: true })

const lock = readJson('maa-project.lock.json')
for (const item of lock.pending ?? []) {
    console.error(\`[ERR] Pending \${item.kind}: \${item.command}\`)
}

if ((lock.pending ?? []).length > 0) {
    throw new Error('release cannot run while project has pending actions')
}

const interfaceJson = readJson('interface.json')
if (interfaceJson.name !== projectSlug) {
    throw new Error('interface.json name must match release artifact slug')
}

const sourceVersion = String(interfaceJson.version ?? '')
if (!isReleaseVersion(sourceVersion)) {
    throw new Error('interface.json version must be a release tag such as v0.1.0')
}

const releaseTag = detectReleaseTag()
if (!dryRun && !releaseTag) {
    throw new Error('release build requires a SemVer Git tag such as v0.1.0')
}

const version = releaseTag ?? sourceVersion
if (!isReleaseVersion(version)) {
    throw new Error('release tag must be a SemVer tag such as v0.1.0')
}

const packageInterfaceJson = prepareReleaseInterface(interfaceJson, version)
const packagePaths = mfaaReleasePackagePaths(interfaceJson)
const runtimePlatform = detectRuntimePlatform()

for (const path of [...strings(interfaceJson.resource), ...strings(interfaceJson.import)]) {
    if (path.includes('\\\\')) {
        throw new Error(\`release paths must use forward slashes: \${path}\`)
    }
    const relativePath = path.startsWith('./') ? path.slice(2) : path
    if (!existsSync(relativePath)) {
        throw new Error(\`release referenced path does not exist: \${path}\`)
    }
}

if (!dryRun) {
    const guiPath = mfaaGuiPath(runtimePlatform)
    if (!existsSync(guiPath)) {
        throw new Error(\`release package path is missing: \${guiPath}\`)
    }
    for (const path of packagePaths) {
        if (!existsSync(path)) {
            throw new Error(\`release package path is missing: \${path}\`)
        }
    }
    prepareReleasePackage(packagePaths, packageInterfaceJson, runtimePlatform)
    smokeReleasePackage('dist/package', packagePaths, runtimePlatform)
}

const artifacts = [
${releaseTargetArtifactTuples()}
].map(([os, arch, ext]) => \`\${projectSlug}-\${os}-\${arch}-\${version}-MFAA.\${ext}\`)

for (const artifact of artifacts) {
    if (!new RegExp('^' + escapeRegExp(projectSlug) + '-(win|linux|macos)-(x86_64|aarch64)-v.+-MFAA\\\\.(zip|tar\\\\.gz)$').test(artifact)) {
        throw new Error(\`invalid artifact name: \${artifact}\`)
    }
    console.log(\`[OK] artifact name: \${artifact}\`)
}

if (!existsSync('runtimes')) {
    console.warn('[WARN] Runtime assets are not present yet; run pnpm sync:runtime before a real release.')
}

console.log(
    dryRun
        ? \`[OK] release dry-run smoke check completed for \${projectSlug}\`
        : \`[OK] release build placeholder completed for \${projectSlug}\`
)

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
    writeFileSync(path, JSON.stringify(value, null, 4) + '\\n', 'utf8')
}

function strings(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

function interfaceResourcePaths(value) {
    return Array.isArray(value)
        ? value.flatMap((item) => (isRecord(item) ? strings(item.path) : []))
        : []
}

function mfaaReleasePackagePaths(interfaceJson) {
    // Current generated release layout is the MFAAvalonia profile.
    // Other runners should add their own package profile instead of sharing these paths.
    const paths = ['tasks', 'resource', 'runtimes', 'libs/MaaAgentBinary', 'plugins']
    if (Array.isArray(interfaceJson.agent) && interfaceJson.agent.length > 0) {
        paths.push('python')
    }
    return paths
}

function prepareReleaseInterface(interfaceJson, version) {
    const releaseInterface = { ...interfaceJson, version }
    delete releaseInterface.$schema
    if (Array.isArray(interfaceJson.agent) && interfaceJson.agent.length > 0) {
        releaseInterface.agent = interfaceJson.agent.map((agent) =>
            isRecord(agent)
                ? { ...agent, child_exec: releaseAgentChildExec(), child_args: releaseAgentChildArgs() }
                : agent
        )
    }
    return releaseInterface
}

function prepareReleasePackage(packagePaths, interfaceJson, runtimePlatform) {
    rmSync('dist/package', { recursive: true, force: true })
    mkdirSync('dist/package', { recursive: true })
    copyDirectoryContents(mfaaGuiPath(runtimePlatform), 'dist/package')
    renameMfaaEntrypoint('dist/package', runtimePlatform)
    writeJson('dist/package/interface.json', interfaceJson)
    for (const path of packagePaths) {
        if (path === 'python' && !existsSync(path)) continue
        copyPath(path, join('dist/package', path))
    }
    if (Array.isArray(interfaceJson.agent) && interfaceJson.agent.length > 0 && existsSync('agent')) {
        copyPath('agent', join('dist/package', 'python', 'agent'))
    }
}

function smokeReleasePackage(root, packagePaths, runtimePlatform) {
    if (!existsSync(join(root, 'interface.json'))) {
        throw new Error('release package smoke failed: interface.json is missing at package root')
    }
    const entrypoint = mfaaEntrypointName(runtimePlatform)
    if (!existsSync(join(root, entrypoint))) {
        throw new Error(\`release package smoke failed: GUI entrypoint is missing: \${entrypoint}\`)
    }
    if (existsSync(join(root, 'MFAAvalonia')) || existsSync(join(root, 'MFAAvalonia.exe'))) {
        throw new Error('release package smoke failed: MFAAvalonia entrypoint must be renamed')
    }
    if (existsSync(join(root, projectSlug, 'interface.json'))) {
        throw new Error('release package smoke failed: package must not contain a top-level wrapper directory')
    }
    for (const path of packagePaths) {
        if (!existsSync(join(root, path))) {
            throw new Error(\`release package smoke failed: package path is missing: \${path}\`)
        }
    }
    for (const path of releaseDevPaths()) {
        if (existsSync(join(root, path))) {
            throw new Error(\`release package smoke failed: package includes dev file: \${path}\`)
        }
    }

    const packagedInterface = readJson(join(root, 'interface.json'))
    if (!isRecord(packagedInterface)) {
        throw new Error('release package smoke failed: interface.json must be an object')
    }
    if (packagedInterface.$schema !== undefined) {
        throw new Error('release package smoke failed: package interface.json must not include $schema')
    }
    if (!isReleaseVersion(String(packagedInterface.version ?? ''))) {
        throw new Error('release package smoke failed: package interface.json version must be a release tag')
    }
    for (const path of [...interfaceResourcePaths(packagedInterface.resource), ...strings(packagedInterface.import)]) {
        if (path.includes('\\\\')) {
            throw new Error(\`release package smoke failed: package path uses backslashes: \${path}\`)
        }
        const relativePath = path.startsWith('./') ? path.slice(2) : path
        if (!existsSync(join(root, relativePath))) {
            throw new Error(\`release package smoke failed: referenced path is missing: \${path}\`)
        }
    }
}

function releaseDevPaths() {
    return [
        '.github',
        '.vscode',
        '.create-maa-project',
        'cache',
        'debug',
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'maa-project.json',
        'maa-project.lock.json',
        'tools/schema'
    ]
}

function copyPath(source, target) {
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target, { recursive: true, force: true })
}

function copyDirectoryContents(source, target) {
    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(source)) {
        copyPath(join(source, entry), join(target, entry))
    }
}

function mfaaGuiPath(runtimePlatform) {
    return join('.create-maa-project', 'runtime', 'mfaa', runtimePlatform)
}

function mfaaEntrypointName(runtimePlatform) {
    return runtimePlatform.startsWith('win-') ? \`\${projectSlug}.exe\` : projectSlug
}

function renameMfaaEntrypoint(root, runtimePlatform) {
    const target = join(root, mfaaEntrypointName(runtimePlatform))
    const candidates = runtimePlatform.startsWith('win-')
        ? ['MFAAvalonia.exe', 'MFAAvalonia']
        : ['MFAAvalonia', 'MFAAvalonia.exe']
    for (const candidate of candidates) {
        const source = join(root, candidate)
        if (existsSync(source)) {
            renameSync(source, target)
            return
        }
    }
}

function detectRuntimePlatform() {
    const explicit = normalizeRuntimePlatform(process.env.CREATE_MAA_PROJECT_RUNTIME_PLATFORM ?? '')
    if (explicit) return explicit
    const os =
        process.platform === 'win32'
            ? 'win'
            : process.platform === 'darwin'
              ? 'osx'
              : process.platform === 'linux'
                ? 'linux'
                : ''
    const arch = normalizeRuntimeArch(process.arch)
    const platform = os && arch ? \`\${os}-\${arch}\` : ''
    if (!platform) {
        throw new Error('release runtime platform could not be detected')
    }
    return platform
}

function normalizeRuntimePlatform(value) {
    const normalized = String(value)
        .trim()
        .toLowerCase()
        .replace(/^windows/, 'win')
        .replace(/^win32/, 'win')
        .replace(/^darwin/, 'osx')
        .replace(/^macos/, 'osx')
        .replace(/x86_64/g, 'x64')
        .replace(/amd64/g, 'x64')
        .replace(/aarch64/g, 'arm64')
        .replace(/_/g, '-')
    return /^(win|linux|osx)-(x64|arm64)$/.test(normalized) ? normalized : ''
}

function normalizeRuntimeArch(value) {
    if (value === 'x64' || value === 'x86_64' || value === 'amd64') return 'x64'
    if (value === 'arm64' || value === 'aarch64') return 'arm64'
    return ''
}

function releaseAgentChildExec() {
    const runnerOs = String(process.env.RUNNER_OS ?? '').toLowerCase()
    if (runnerOs.startsWith('windows')) return 'python/python.exe'
    if (runnerOs.startsWith('macos')) return 'python/bin/python3'
    if (runnerOs.startsWith('linux')) return 'python3'
    if (process.platform === 'win32') return 'python/python.exe'
    if (process.platform === 'darwin') return 'python/bin/python3'
    return 'python3'
}

function releaseAgentChildArgs() {
    return ['python/agent/bootstrap.py']
}

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function detectReleaseTag() {
    const refName = process.env.GITHUB_REF_NAME
    if (typeof refName === 'string' && refName.startsWith('v')) return refName
    const ref = process.env.GITHUB_REF
    return typeof ref === 'string' && ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : undefined
}

function isReleaseVersion(value) {
    return /^v(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?$/.test(value)
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${'${'}|}()|[\\]\\\\]/g, '\\\\$&')
}
`
}

function releaseTargetMatrixYaml(): string {
    return RELEASE_TARGETS.map(
        (target) => `          - os: ${target.runner}
            artifact_os: ${target.artifactOs}
            arch: ${target.arch}
            runtime_os: ${target.runtimeOs}
            runtime_arch: ${target.runtimeArch}
            ext: ${target.ext}`
    ).join('\n')
}

function releaseTargetArtifactTuples(): string {
    return RELEASE_TARGETS.map(
        (target) => `    ['${target.artifactOs}', '${target.arch}', '${target.ext}']`
    ).join(',\n')
}

function syncRuntimeScript(): string {
    return `import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const updateArgs = ['--update', 'maafw', '--update', 'runtime:mfa']
const invocation = resolveCreateMaaProject()

const result = spawnSync(invocation.command, [...invocation.args, ...updateArgs], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: invocation.shell
})

if (result.error) {
    throw result.error
}
if (result.status !== 0) {
    process.exit(result.status ?? 1)
}

function resolveCreateMaaProject() {
    const override = process.env.CREATE_MAA_PROJECT_BIN?.trim()
    if (override) {
        return {
            command: override,
            args: [],
            shell: true
        }
    }

    const localBin = findLocalGeneratorBin()
    if (localBin) {
        return {
            command: process.execPath,
            args: [localBin],
            shell: false
        }
    }

    return {
        command: 'pnpm',
        args: ['dlx', 'create-maa-project@latest'],
        shell: process.platform === 'win32'
    }
}

function findLocalGeneratorBin() {
    let dir = process.cwd()
    for (let depth = 0; depth < 6; depth += 1) {
        const bin = join(dir, 'dist', 'index.js')
        if (existsSync(bin) && packageName(dir) === 'create-maa-project') {
            return bin
        }
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
    }
    return undefined
}

function packageName(dir) {
    try {
        return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name
    } catch {
        return undefined
    }
}
`
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
    return `[project]
name = "${input.slug}"
version = "${input.version}"
requires-python = ">=3.11,<3.14"
dependencies = [
    "maafw>=0.0.0"
]

[dependency-groups]
dev = [
    "pyright>=1.1.400",
    "ruff>=0.11.0"
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.ruff]
target-version = "py313"
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B"]

[tool.pyright]
include = ["agent"]
extraPaths = ["agent"]
pythonVersion = "3.13"
typeCheckingMode = "strict"
`
}

function generatedUvLockPlaceholder(): string {
    return `version = 1
revision = 1
requires-python = ">=3.11, <3.14"
`
}

function agentMainPy(): string {
    return template('agent/agent/main.py')
}

function agentTemplate(path: string): string {
    return template(`agent/agent/${path}`)
}

function agentRequirements(): string {
    return `maafw>=0.0.0
`
}

function agentBootstrapPy(): string {
    return template('agent/agent/bootstrap.py')
}

function template(path: string, values: Record<string, string> = {}): string {
    let content = embeddedTextTemplates[path] ?? readFileSync(join(TEMPLATE_ROOT, path), 'utf8')
    for (const [key, value] of Object.entries(values)) {
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
    return metaUrl ? join(dirname(fileURLToPath(metaUrl)), '..', 'templates') : join(process.cwd(), 'templates')
}

function jsonFragment(value: unknown): string {
    return JSON.stringify(value, null, 4).replace(/\n/g, '\n    ')
}

function jsonStringContent(value: string): string {
    return JSON.stringify(value).slice(1, -1)
}
