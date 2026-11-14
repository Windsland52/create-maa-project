import { execFile } from 'node:child_process'
import { lstat, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createProject } from '../src/scaffold.js'
import type { CliOptions } from '../src/types.js'

const execFileAsync = promisify(execFile)
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const BUNDLER_TEMPLATE = join(repoRoot, 'templates/addons/github/tools/macos-app-bundle.mjs')
const tempRoots: string[] = []
let previousCwd = process.cwd()

afterEach(async () => {
  process.chdir(previousCwd)
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function mkTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cmp-bundle-'))
  tempRoots.push(root)
  process.chdir(root)
  return root
}

// The bundle keeps a Mach-O-looking executable at every location signing would inspect: the magic
// header is what tools/macos-app-bundle.mjs collects, not a real binary.
const MACHO_MAGIC = Buffer.from([
  0xcf,
  0xfa,
  0xed,
  0xfe,
  0,
  0,
  0,
  0,
])

async function writeReleasePackage(root: string, slug: string): Promise<string> {
  const packageDir = join(root, 'package-mxu')
  const files: Record<string, Buffer> = {
    [slug]: MACHO_MAGIC,
    'interface.json': Buffer.from(`{"name":"${slug}"}`),
    'resource/logo.png': Buffer.from('png'),
    'agent/main.py': Buffer.from('# main\n'),
    'agent/libs/helper.so': MACHO_MAGIC,
    'maafw/libMaaFramework.dylib': MACHO_MAGIC,
    'python/bin/python3': MACHO_MAGIC,
  }
  for (const [
    relative,
    content,
  ] of Object.entries(files)) {
    const path = join(packageDir, relative)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  return packageDir
}

describe('macos app bundle template', () => {
  it('renders with project placeholders and is written by the github add-on', async () => {
    const root = await mkTempProject()
    const result = await createProject({
      name: 'bundle-test',
      slug: 'bundle-test',
      displayName: 'Bundle Test',
      template: 'agent',
      add: [
        'github',
      ],
      skipDownload: true,
    } as CliOptions)

    expect(result.written).toContain('tools/macos-app-bundle.mjs')
    expect(result.written).toContain('tools/ci/smoke-macos-app.sh')
    const bundler = await readFile(join(root, 'bundle-test', 'tools/macos-app-bundle.mjs'), 'utf8')
    expect(bundler).not.toContain('{{')
    expect(bundler).toContain('executable: "bundle-test"')
    expect(bundler).toContain('"com.bundle-test.app"')
    // The .app display name follows the sanitized release artifact name, not the raw display name.
    expect(bundler).toContain('displayName: "Bundle-Test"')
    const smokeScript = await readFile(join(root, 'bundle-test', 'tools/ci/smoke-macos-app.sh'), 'utf8')
    expect(smokeScript).not.toContain('{{')
    expect(smokeScript).toContain('Bundle-Test.app')
  })

  it('renders release and package-smoke workflows with dmg packaging steps', async () => {
    const root = await mkTempProject()
    await createProject({
      name: 'bundle-wf-test',
      slug: 'bundle-wf-test',
      displayName: 'BundleWfTest',
      template: 'agent',
      add: [
        'github',
      ],
      skipDownload: true,
    } as CliOptions)
    const projectRoot = join(root, 'bundle-wf-test')

    const release = await readFile(join(projectRoot, '.github/workflows/release.yml'), 'utf8')
    expect(release).toContain('--package "$pkg_dir"')
    expect(release).toContain('--app "dist/BundleWfTest.app"')
    expect(release).toContain('--dmg "dist/$archive"')
    expect(release).toContain('release-assets/*.dmg')
    // The dmg is named like every other archive, with the GUI suffix and the tag.
    expect(release).toContain(
      'BundleWfTest-${{ matrix.artifact_os }}-${{ matrix.arch }}-${GITHUB_REF_NAME}-${gui_upper}.$ext',
    )

    const smoke = await readFile(join(projectRoot, '.github/workflows/package-smoke.yml'), 'utf8')
    expect(smoke).toContain('bash tools/ci/smoke-macos-app.sh "dist/BundleWfTest.app"')
    expect(smoke).toContain('loaded interface for project')
    expect(smoke).toContain('--app "dist/BundleWfTest.app"')
    // Only a project that ships MXU has a package-mxu to bundle; both macOS steps bail out without it.
    expect(smoke).toContain('if [ ! -d dist/package-mxu ]; then')
    expect(smoke).toContain('if [ ! -d "dist/BundleWfTest.app" ]; then')
    expect(smoke.replaceAll('${{', '')).not.toContain('{{')
  })

  // Directory symlinks work on Windows only with elevated or developer-mode privileges, so the
  // assembly runs on the Unix hosts the dmg is actually produced on.
  describe.skipIf(process.platform === 'win32')('bundle assembly', () => {
    it('keeps only the executable real and links every other entry into MXU-portable', async () => {
      const root = await mkTempProject()
      const packageDir = await writeReleasePackage(root, 'bundle-run-test')
      const app = join(root, 'dist', 'BundleRunTest.app')

      const { stdout } = await execFileAsync(process.execPath, [
        BUNDLER_TEMPLATE,
        '--package',
        packageDir,
        '--app',
        app,
        '--skip-sign',
        '--version',
        'v1.2.3',
        '--executable',
        'bundle-run-test',
        '--bundle-id',
        'com.bundle-run-test.app',
        '--display-name',
        'BundleRunTest',
      ])
      expect(stdout).toContain('[OK] macOS app bundle')

      const macos = join(app, 'Contents', 'MacOS')
      const portable = join(app, 'Contents', 'Resources', 'MXU-portable')
      expect((await stat(join(macos, 'bundle-run-test'))).isFile()).toBe(true)
      expect((await lstat(join(macos, 'bundle-run-test'))).isSymbolicLink()).toBe(false)
      for (const relative of [
        'interface.json',
        'agent',
        'resource',
        'maafw',
        'python',
      ]) {
        expect((await lstat(join(macos, relative))).isSymbolicLink(), relative).toBe(true)
      }
      expect(await readFile(join(portable, 'interface.json'), 'utf8')).toBe('{"name":"bundle-run-test"}')
      const plist = await readFile(join(app, 'Contents', 'Info.plist'), 'utf8')
      expect(plist).toContain('<string>com.bundle-run-test.app</string>')
      expect(plist).toContain('<key>CFBundleExecutable</key>\n    <string>bundle-run-test</string>')
      expect(plist).toContain('<string>1.2.3</string>')
    })

    it('fails when the package has no entrypoint', async () => {
      const root = await mkTempProject()
      const packageDir = await writeReleasePackage(root, 'bundle-fail-test')
      await rm(join(packageDir, 'bundle-fail-test'))

      await expect(
        execFileAsync(process.execPath, [
          BUNDLER_TEMPLATE,
          '--package',
          packageDir,
          '--app',
          join(root, 'dist', 'BundleFailTest.app'),
          '--skip-sign',
          '--executable',
          'bundle-fail-test',
        ]),
      ).rejects.toThrow('release package has no entrypoint: bundle-fail-test')
    })
  })
})
