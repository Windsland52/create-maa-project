import { execFile } from 'node:child_process'
import { lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
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

  async function runBundler(
    packageDir: string,
    app: string,
    extra: string[] = [],
  ): Promise<ReturnType<typeof execFileAsync>> {
    return execFileAsync(process.execPath, [
      BUNDLER_TEMPLATE,
      '--package',
      packageDir,
      '--app',
      app,
      '--skip-sign',
      ...extra,
    ])
  }

  // These guards fail before any symlink is created, so they run on Windows too.
  describe('bundle guards', () => {
    it('fails when the package has no entrypoint and keeps a previous app', async () => {
      const root = await mkTempProject()
      const app = join(root, 'dist', 'BundleFailTest.app')
      const previous = join(app, 'Contents', 'Info.plist')
      await mkdir(dirname(previous), { recursive: true })
      await writeFile(previous, 'previous')
      const packageDir = await writeReleasePackage(root, 'bundle-fail-test')
      await rm(join(packageDir, 'bundle-fail-test'))

      await expect(runBundler(packageDir, app, ['--executable', 'bundle-fail-test'])).rejects.toThrow(
        'release package has no entrypoint: bundle-fail-test',
      )
      expect(await readFile(previous, 'utf8')).toBe('previous')
      expect((await stat(join(packageDir, 'interface.json'))).isFile()).toBe(true)
    })

    it('rejects --app inside the package without deleting the package', async () => {
      const root = await mkTempProject()
      const packageDir = await writeReleasePackage(root, 'bundle-inside-test')

      await expect(
        runBundler(packageDir, join(packageDir, 'Out.app'), ['--executable', 'bundle-inside-test']),
      ).rejects.toThrow('--app must not live inside the release package')
      expect((await stat(join(packageDir, 'bundle-inside-test'))).isFile()).toBe(true)
    })

    it('rejects --app that contains the package without deleting the package', async () => {
      const root = await mkTempProject()
      const nested = join(root, 'nested')
      await mkdir(nested)
      const packageDir = await writeReleasePackage(nested, 'bundle-contains-test')

      await expect(runBundler(packageDir, nested, ['--executable', 'bundle-contains-test'])).rejects.toThrow(
        '--app must not contain the release package',
      )
      expect((await stat(join(packageDir, 'bundle-contains-test'))).isFile()).toBe(true)
    })

    it('refuses to clean the working directory', async () => {
      const root = await mkTempProject()
      const keep = join(root, 'keep.txt')
      await writeFile(keep, 'keep')
      const packageDir = await writeReleasePackage(root, 'bundle-cwd-test')

      await expect(runBundler(packageDir, root, ['--executable', 'bundle-cwd-test'])).rejects.toThrow(
        '--app must not be the working directory',
      )
      expect(await readFile(keep, 'utf8')).toBe('keep')
    })

    it('rejects a non-numeric version before touching output', async () => {
      const root = await mkTempProject()
      const app = join(root, 'dist', 'BundleNightly.app')
      const previous = join(app, 'Contents', 'Info.plist')
      await mkdir(dirname(previous), { recursive: true })
      await writeFile(previous, 'previous')
      const packageDir = await writeReleasePackage(root, 'bundle-nightly-test')

      await expect(
        runBundler(packageDir, app, [
          '--executable',
          'bundle-nightly-test',
          '--version',
          'vnightly',
        ]),
      ).rejects.toThrow('--version must start with a numeric version')
      expect(await readFile(previous, 'utf8')).toBe('previous')
      expect((await stat(join(packageDir, 'bundle-nightly-test'))).isFile()).toBe(true)
    })

    it('resolves symlink aliases before comparing paths', async (context) => {
      const root = await mkTempProject()
      const real = join(root, 'real')
      await mkdir(real)
      const packageDir = await writeReleasePackage(real, 'bundle-alias-test')
      const alias = join(root, 'alias')
      try {
        await symlink(real, alias, 'dir')
      } catch {
        context.skip()
        return
      }

      await expect(runBundler(packageDir, alias, ['--executable', 'bundle-alias-test'])).rejects.toThrow(
        '--app must not contain the release package',
      )
      expect((await stat(join(packageDir, 'bundle-alias-test'))).isFile()).toBe(true)
    })
  })

  // Directory symlinks work on Windows only with elevated or developer-mode privileges, so the
  // assembly runs on the Unix hosts the dmg is actually produced on.
  describe.skipIf(process.platform === 'win32')('bundle assembly', () => {
    it('keeps only the executable real and links every other entry into MXU-portable', async () => {
      const root = await mkTempProject()
      const packageDir = await writeReleasePackage(root, 'bundle-run-test')
      const app = join(root, 'dist', 'BundleRunTest.app')

      const { stdout } = await runBundler(packageDir, app, [
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
      expect(plist).toContain('<key>CFBundleShortVersionString</key>\n    <string>1.2.3</string>')
      expect(plist).toContain('<key>CFBundleVersion</key>\n    <string>1.2.3</string>')
    })

    it('uses a numeric bundle version for prereleases', async () => {
      const root = await mkTempProject()
      const packageDir = await writeReleasePackage(root, 'bundle-pre-test')
      const app = join(root, 'dist', 'BundlePreTest.app')

      await runBundler(packageDir, app, [
        '--version',
        'v2.0.0-rc.1',
        '--executable',
        'bundle-pre-test',
      ])
      const plist = await readFile(join(app, 'Contents', 'Info.plist'), 'utf8')
      expect(plist).toContain('<key>CFBundleShortVersionString</key>\n    <string>2.0.0</string>')
      expect(plist).toContain('<key>CFBundleVersion</key>\n    <string>2.0.0</string>')
      expect(plist).not.toContain('2.0.0-rc.1')
    })
  })
})
