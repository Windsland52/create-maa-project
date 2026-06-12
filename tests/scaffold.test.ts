import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createProject,
  addAgent,
  addCommunity,
  addDependabot,
  addGitCliff,
  addResourcePack,
  assertCanCreateTarget,
  type GitRunner
} from '../src/scaffold.js'
import { syncProject } from '../src/sync.js'
import { previewTemplateUpdate, recordUpdateRequests } from '../src/update.js'
import {
  acceptManagedChanges,
  cleanCache,
  diffManagedFiles,
  restoreBackup
} from '../src/project.js'
import { runDoctor } from '../src/doctor.js'
import { applyIncrementalAddons } from '../src/incremental-addons.js'
import type { CliOptions } from '../src/types.js'
import {
  downloadManifestAssets,
  downloadProjectManifestAssets,
  resolveProductAssetManifestFromGithubRelease,
  type DownloadProgress
} from '../src/assets.js'
import { sha256 } from '../src/utils.js'

const cwdStack: string[] = []
const execFileAsync = promisify(execFile)
const EXPECTED_RELEASE_TARGETS = [
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

beforeEach(() => {
  cwdStack.push(process.cwd())
})

afterEach(() => {
  vi.restoreAllMocks()
  const cwd = cwdStack.pop()
  if (cwd) process.chdir(cwd)
})

describe('scaffold', () => {
  it('creates minimal project without repository add-ons', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)

    const result = await createProject(minimalOptions({ name: 'maa-minimal' }))
    const projectRoot = join(root, 'maa-minimal')

    expect(result.config.features).toMatchObject({
      ci: { enabled: false },
      release: { enabled: false },
      vscode: { enabled: false },
      quality: { enabled: false }
    })
    expect(result.config.runtime.mfa.enabled).toBe(false)
    expect(result.config.addons).toEqual({})
    expect(result.written).toEqual(
      expect.arrayContaining([
        'interface.json',
        'tasks/tutorial.json',
        'resource/base/default_pipeline.json',
        'resource/base/pipeline/tutorial.json',
        'maatools.config.mts',
        'maa-project.json'
      ])
    )
    expect(result.written).not.toContain('package.json')
    expect(result.written).not.toContain('.vscode/settings.json')
    expect(result.written).not.toContain('.github/workflows/check.yml')
    expect(result.written).not.toContain('tools/check-project.mjs')
    expect(result.written).not.toContain('tools/schema/interface.schema.json')
    expect(await pathExists(join(projectRoot, 'package.json'))).toBe(false)
    expect(await pathExists(join(projectRoot, '.vscode/settings.json'))).toBe(false)
    expect(await pathExists(join(projectRoot, '.github/workflows/check.yml'))).toBe(false)
    expect(await pathExists(join(projectRoot, 'tools/check-project.mjs'))).toBe(false)
    expect(await pathExists(join(projectRoot, 'tools/schema/interface.schema.json'))).toBe(false)
    expect(result.pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'ocr-model',
          command: 'create-maa-project --update ocr-models'
        })
      ])
    )
    expect(result.pending.some((item) => item.kind === 'node-deps')).toBe(false)
  })

  it('creates repository tooling project under resource/base', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)

    const result = await createProject(defaultOptions({ name: 'Maa Test' }))

    expect(result.config.project.slug).toBe('maa-test')
    expect(result.written).toContain('interface.json')
    expect(result.written).toContain('tasks/tutorial.json')
    expect(result.written).toContain('resource/base/pipeline/tutorial.json')
    expect(result.written).toContain('tools/schema/interface.schema.json')
    expect(result.written).toContain('tools/schema/schema-manifest.json')
    expect(result.written).not.toContain('tools/sync-schema.mjs')
    expect(result.written).not.toContain('.github/workflows/schema-sync.yml')
    expect(result.written).toContain('resource/base/model/ocr/det.onnx')
    expect(result.written).toContain('resource/base/model/ocr/rec.onnx')
    expect(result.written).toContain('resource/base/model/ocr/keys.txt')
    expect(result.written).toContain('resource/base/model/ocr/README.md')
    const tutorial = await readFile(
      join(root, 'Maa Test', 'resource/base/pipeline/tutorial.json'),
      'utf8'
    )
    const defaultPipeline = await readFile(
      join(root, 'Maa Test', 'resource/base/default_pipeline.json'),
      'utf8'
    )
    const readme = await readFile(join(root, 'Maa Test', 'README.md'), 'utf8')
    const readmeEn = await readFile(join(root, 'Maa Test', 'README.en.md'), 'utf8')
    const license = await readFile(join(root, 'Maa Test', 'LICENSE'), 'utf8')
    const syncRuntime = await readFile(join(root, 'Maa Test', 'tools/sync-runtime.mjs'), 'utf8')
    const emptyImage = await readFile(join(root, 'Maa Test', 'resource/base/image/empty.png'))
    const interfaceSchema = await readJson(
      join(root, 'Maa Test', 'tools/schema/interface.schema.json')
    )
    const vscodeSettings = await readJson(join(root, 'Maa Test', '.vscode/settings.json'))
    expect(readme).toContain('由 create-maa-project 生成')
    expect(readme).toContain('README.en.md')
    expect(readmeEn).toContain('MaaFW project generated')
    expect(readmeEn).toContain('README.md')
    expect(license).toContain('GNU AFFERO GENERAL PUBLIC LICENSE')
    expect(license).toContain('Version 3, 19 November 2007')
    expect(license).not.toContain('Replace this placeholder')
    expect(syncRuntime).toContain('create-maa-project@latest')
    expect(syncRuntime).toContain("'maafw'")
    expect(syncRuntime).toContain("'runtime:mfa'")
    expect(emptyImage.subarray(0, 8)).toEqual(
      Buffer.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a
      ])
    )
    expect(defaultPipeline).toContain('"rate_limit": 1000')
    expect(defaultPipeline).toContain('"recognition": "OCR"')
    expect(defaultPipeline).not.toMatch(/"next"\s*:/)
    expect(tutorial.indexOf('"recognition"')).toBeLessThan(tutorial.indexOf('"roi"'))
    expect(tutorial.indexOf('"roi"')).toBeLessThan(tutorial.indexOf('"expected"'))
    expect(tutorial.indexOf('"expected"')).toBeLessThan(tutorial.indexOf('"action"'))
    expect(await readJson(join(root, 'Maa Test', 'interface.json'))).toMatchObject({
      name: 'maa-test',
      label: 'Maa Test',
      controller: [
        { name: 'Android', label: 'Android / Emulator', type: 'Adb' }
      ],
      resource: [
        { name: 'base', path: [
            './resource/base'
          ] }
      ],
      import: [
        './tasks/tutorial.json'
      ]
    })
    expect(await readJson(join(root, 'Maa Test', 'interface.json'))).not.toHaveProperty('task')
    expect(await readJson(join(root, 'Maa Test', 'interface.json'))).not.toHaveProperty('$schema')
    expect(interfaceSchema).toMatchObject({
      title: 'MaaFramework Project Interface V2',
      properties: {
        interface_version: {
          const: 2
        }
      }
    })
    expect(vscodeSettings).toMatchObject({
      '[json]': {
        'editor.defaultFormatter': 'esbenp.prettier-vscode'
      },
      '[jsonc]': {
        'editor.defaultFormatter': 'esbenp.prettier-vscode'
      },
      'files.associations': {
        '*.json': 'jsonc',
        '*.jsonc': 'jsonc'
      },
      'json.schemas': expect.arrayContaining([
        expect.objectContaining({
          fileMatch: [
            '/interface.json'
          ],
          url: './tools/schema/interface.schema.json'
        })
      ])
    })
    expect(await readJson(join(root, 'Maa Test', 'maa-project.json'))).toMatchObject({
      controller: { kinds: [
          'Adb'
        ] },
      resources: [
        { path: 'resource/base' }
      ]
    })
    const packageJson = (await readJson(join(root, 'Maa Test', 'package.json'))) as {
      license?: string
      scripts?: Record<string, string>
    }
    expect(packageJson.license).toBe('AGPL-3.0-or-later')
    expect(packageJson.scripts).not.toHaveProperty('sync:schema')
    const customActionSchema = await readJson(
      join(root, 'Maa Test', 'tools/schema/custom.action.schema.json')
    )
    const customRecognitionSchema = await readJson(
      join(root, 'Maa Test', 'tools/schema/custom.recognition.schema.json')
    )
    expect(customActionSchema).toMatchObject({
      properties: {
        custom_action: {},
        custom_action_param: {}
      }
    })
    expect(customActionSchema).not.toHaveProperty('$defs')
    expect(customRecognitionSchema).toMatchObject({
      properties: {
        custom_recognition: {},
        custom_recognition_param: {}
      }
    })
    expect(customRecognitionSchema).not.toHaveProperty('$defs')
    const schemaManifest = (await readJson(
      join(root, 'Maa Test', 'tools/schema/schema-manifest.json')
    )) as {
      files: Array<{ path: string }>
    }
    expect(schemaManifest.files.map((file: { path: string }) => file.path)).not.toEqual(
      expect.arrayContaining([
        'tools/schema/custom.action.schema.json',
        'tools/schema/custom.recognition.schema.json'
      ])
    )
    const lock = (await readJson(join(root, 'Maa Test', 'maa-project.lock.json'))) as {
      managedFiles: Record<string, unknown>
      createdFiles: Record<string, unknown>
      pending: Array<{ kind: string; command: string }>
    }
    expect(lock).toMatchObject({
      schemaVersion: 1
    })
    expect(lock.pending.some((item) => item.kind === 'runtime')).toBe(false)
    for (const path of [
      '.gitignore',
      '.prettierignore',
      '.vscode/extensions.json',
      '.vscode/settings.json',
      'interface.json',
      'maa-project.json',
      'maatools.config.mts',
      'package.json',
      'pnpm-workspace.yaml',
      'resource/base/default_pipeline.json',
      'resource/base/image/empty.png',
      'resource/base/model/ocr/manifest.json',
      'resource/base/model/ocr/det.onnx',
      'resource/base/model/ocr/rec.onnx',
      'resource/base/model/ocr/keys.txt',
      'resource/base/model/ocr/README.md',
      'resource/base/pipeline/tutorial.json',
      'tasks/tutorial.json'
    ]) {
      expect(lock.managedFiles).not.toHaveProperty(path)
      expect(lock.createdFiles).toHaveProperty(path)
    }
    expect(lock.managedFiles).not.toHaveProperty('tools/schema/custom.action.schema.json')
    expect(lock.managedFiles).not.toHaveProperty('tools/schema/custom.recognition.schema.json')
    expect(lock.createdFiles).toMatchObject({
      'tools/schema/custom.action.schema.json': { managed: false },
      'tools/schema/custom.recognition.schema.json': { managed: false }
    })
    expect(await readJson(join(root, 'Maa Test', '.vscode/extensions.json'))).toMatchObject({
      recommendations: expect.arrayContaining([
        'windsland52.maa-log-analyzer'
      ])
    })
    const editorconfig = await readFile(join(root, 'Maa Test', '.editorconfig'), 'utf8')
    expect(editorconfig).toContain('[*.{yml,yaml,json,jsonc}]')
    const gitattributes = await readFile(join(root, 'Maa Test', '.gitattributes'), 'utf8')
    expect(gitattributes).toContain('interface.json linguist-language=JSON-with-Comments')
    expect(gitattributes).toContain(
      'resource/**/default_pipeline.json linguist-language=JSON-with-Comments'
    )
    expect(gitattributes).toContain(
      'resource/**/pipeline/**/*.json linguist-language=JSON-with-Comments'
    )
    expect(await pathExists(join(root, 'Maa Test', '.github/workflows/schema-sync.yml'))).toBe(
      false
    )
    expect(await pathExists(join(root, 'Maa Test', 'tools/sync-schema.mjs'))).toBe(false)
    const checkWorkflow = await readFile(
      join(root, 'Maa Test', '.github/workflows/check.yml'),
      'utf8'
    )
    const releaseWorkflow = await readFile(
      join(root, 'Maa Test', '.github/workflows/release.yml'),
      'utf8'
    )
    expect(checkWorkflow.indexOf('node tools/check-project.mjs')).toBeLessThan(
      checkWorkflow.indexOf('pnpm install --frozen-lockfile')
    )
    expect(releaseWorkflow.indexOf('node tools/check-project.mjs')).toBeLessThan(
      releaseWorkflow.indexOf('pnpm install --frozen-lockfile')
    )
    expect(releaseWorkflow).toContain('pnpm release:dry-run')
    expect(releaseWorkflow).toContain("if: github.event_name == 'workflow_dispatch'")
    expect(releaseWorkflow).toContain("if: github.event_name != 'workflow_dispatch'")
    expectReleaseWorkflowTargets(releaseWorkflow)
    expect(releaseWorkflow).toContain(
      'archive="maa-test-${{ matrix.artifact_os }}-${{ matrix.arch }}-${GITHUB_REF_NAME}-MFAA.${{ matrix.ext }}"'
    )
    expect(releaseWorkflow).toContain('7z a "../$archive" .')
    expect(releaseWorkflow).toContain('tar -czf "../$archive" .')
    expect(releaseWorkflow).toContain('tar -tzvf "../$archive" > "../$archive.manifest"')
    expect(releaseWorkflow).toContain('Unix archive executable metadata smoke passed')
    expect(releaseWorkflow).toContain('actions/download-artifact@v7')
    expect(releaseWorkflow).toContain('generate_release_notes: true')
    expect(releaseWorkflow).not.toContain('orhun/git-cliff-action@v4')
    expect(releaseWorkflow).not.toContain('package_paths=')
    expect(releaseWorkflow).not.toContain('|| true')
    expect(result.pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'node-deps',
          command: 'create-maa-project --update node-deps'
        }),
        expect.objectContaining({
          kind: 'ocr-model',
          command: 'create-maa-project --update ocr-models'
        })
      ])
    )
    const doctorOutput = (await runDoctor(join(root, 'Maa Test'))).lines.join('\n')
    expect(doctorOutput).toContain('create-maa-project --update node-deps')
    expect(doctorOutput).toContain('create-maa-project --update ocr-models')
    expect(doctorOutput).not.toContain('create-maa-project --sync ocr-model')
  })

  it('creates MIT license text when selected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)

    await createProject(defaultOptions({ name: 'maa-mit-test', license: 'MIT' }))

    const license = await readFile(join(root, 'maa-mit-test', 'LICENSE'), 'utf8')
    expect(license).toContain('MIT License')
    expect(license).toContain(`Copyright (c) ${new Date().getFullYear()} maa-mit-test contributors`)
    expect(license).not.toContain('GNU AFFERO GENERAL PUBLIC LICENSE')
    expect(await readJson(join(root, 'maa-mit-test', 'package.json'))).toMatchObject({
      license: 'MIT'
    })
  })

  it('can install node dependencies during project creation and clear node pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    const commands: Array<{ root: string; command: string; args: string[] }> = []
    const progress: string[] = []
    process.chdir(root)

    const result = await createProject(defaultOptions({ name: 'maa-create-install' }), {
      installNodeDeps: true,
      commandRunner: async (cwd, command, args) => {
        commands.push({ root: cwd, command, args })
        await writeFile(join(cwd, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\n", 'utf8')
      },
      onProgress: (message) => progress.push(message)
    })

    const projectRoot = join(root, 'maa-create-install')
    expect(commands).toEqual([
      { root: projectRoot, command: 'pnpm', args: [
          'install'
        ] }
    ])
    expect(progress).toEqual([
      'Installing Node dependencies...',
      'Node dependencies installed.'
    ])
    expect(result.pending.some((item) => item.kind === 'node-deps')).toBe(false)
    expect(result.written).toContain('pnpm-lock.yaml')
    expect(await pathExists(join(projectRoot, 'pnpm-lock.yaml'))).toBe(true)
    expect((await runDoctor(projectRoot)).lines.join('\n')).not.toContain(
      'create-maa-project --update node-deps'
    )
  })

  it('keeps node dependency pending when creation install fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    const progress: string[] = []
    process.chdir(root)

    const result = await createProject(defaultOptions({ name: 'maa-create-install-fail' }), {
      installNodeDeps: true,
      commandRunner: async () => {
        throw new Error('offline registry')
      },
      onProgress: (message) => progress.push(message)
    })

    expect(progress).toEqual([
      'Installing Node dependencies...',
      'Node dependency install failed (offline registry); continuing with a pending action.'
    ])
    expect(result.pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'node-deps',
          reason: expect.stringContaining('offline registry'),
          command: 'create-maa-project --update node-deps'
        })
      ])
    )
  })

  it('downloads OCR model assets during project creation and clears OCR pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)

    const assets = new Map([
      [
        'https://example.test/det.onnx',
        Buffer.from([
          0,
          1,
          2,
          3
        ])
      ],
      [
        'https://example.test/rec.onnx',
        Buffer.from([
          4,
          5,
          6
        ])
      ],
      [
        'https://example.test/keys.txt',
        Buffer.from('hello\nworld\n')
      ],
      [
        'https://example.test/README.md',
        Buffer.from('# OCR\n')
      ]
    ])
    const progress: string[] = []
    const downloadProgress: DownloadProgress[] = []
    const result = await createProject(defaultOptions({ name: 'maa-create-ocr' }), {
      downloadOcrModels: true,
      ocrManifestResolver: async () => ({
        schemaVersion: 1,
        assets: [
          {
            path: 'det.onnx',
            url: 'https://example.test/det.onnx',
            sha256: sha256(assets.get('https://example.test/det.onnx') as Buffer),
            size: 4
          },
          {
            path: 'rec.onnx',
            url: 'https://example.test/rec.onnx',
            sha256: sha256(assets.get('https://example.test/rec.onnx') as Buffer),
            size: 3
          },
          {
            path: 'keys.txt',
            url: 'https://example.test/keys.txt',
            sha256: sha256(assets.get('https://example.test/keys.txt') as Buffer),
            size: 12
          },
          {
            path: 'README.md',
            url: 'https://example.test/README.md',
            sha256: sha256(assets.get('https://example.test/README.md') as Buffer),
            size: 6
          }
        ]
      }),
      assetDownloader: async (url, options) => {
        const content = assets.get(url)
        if (!content) throw new Error(`unexpected URL: ${url}`)
        const firstChunk = Math.max(1, Math.floor(content.byteLength / 2))
        options?.onProgress?.({
          url,
          downloadedBytes: firstChunk,
          totalBytes: content.byteLength
        })
        options?.onProgress?.({
          url,
          downloadedBytes: content.byteLength,
          totalBytes: content.byteLength
        })
        return content
      },
      onProgress: (message) => progress.push(message),
      onDownloadProgress: (event) => downloadProgress.push(event)
    })

    const projectRoot = join(root, 'maa-create-ocr')
    expect(result.written).toEqual(
      expect.arrayContaining([
        'resource/base/model/ocr/det.onnx',
        'resource/base/model/ocr/rec.onnx',
        'resource/base/model/ocr/keys.txt',
        'resource/base/model/ocr/README.md',
        'resource/base/model/ocr/manifest.json'
      ])
    )
    expect(result.pending.some((item) => item.kind === 'ocr-model')).toBe(false)
    expect(await readFile(join(projectRoot, 'resource/base/model/ocr/det.onnx'))).toEqual(
      assets.get('https://example.test/det.onnx')
    )
    expect(
      await readJson(join(projectRoot, 'resource/base/model/ocr/manifest.json'))
    ).toMatchObject({
      assets: expect.arrayContaining([
        expect.objectContaining({
          path: 'det.onnx',
          sha256: sha256(assets.get('https://example.test/det.onnx') as Buffer),
          size: 4
        })
      ])
    })
    expect(await diffManagedFiles(projectRoot)).toEqual([
      'No managed file changes.'
    ])
    expect(progress).toEqual([
      'Downloading OCR models...',
      'OCR models downloaded.'
    ])
    expect(downloadProgress).toContainEqual(
      expect.objectContaining({
        path: 'det.onnx',
        downloadedBytes: 2,
        totalBytes: 25
      })
    )
    expect(downloadProgress.at(-1)).toMatchObject({
      path: 'README.md',
      downloadedBytes: 25,
      totalBytes: 25
    })
    const doctorOutput = (await runDoctor(projectRoot)).lines.join('\n')
    expect(doctorOutput).not.toContain('create-maa-project --update ocr-models')
    expect(doctorOutput).not.toContain(
      'Managed file changed since last accepted baseline: resource/base/model/ocr'
    )
  })

  it('keeps OCR pending when creation download fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    const progress: string[] = []

    const result = await createProject(defaultOptions({ name: 'maa-create-ocr-fail' }), {
      downloadOcrModels: true,
      assetDownloader: async () => {
        throw new Error('offline OCR mirror')
      },
      onProgress: (message) => progress.push(message)
    })

    expect(progress).toEqual([
      'Downloading OCR models...',
      'OCR model download failed (offline OCR mirror); continuing with a pending action.'
    ])
    expect(result.pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'ocr-model',
          reason: expect.stringContaining('offline OCR mirror'),
          command: 'create-maa-project --update ocr-models'
        })
      ])
    )
  })

  it('retries transient default asset download failures', async () => {
    const content = Buffer.from('downloaded asset')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    fetchMock.mockResolvedValueOnce(new Response(content))

    const assets = await downloadManifestAssets(
      {
        schemaVersion: 1,
        assets: [
          {
            path: 'asset.bin',
            url: 'https://example.test/asset.bin',
            sha256: sha256(content),
            size: content.byteLength
          }
        ]
      },
      {
        allowedPaths: [
          'asset.bin'
        ]
      }
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(assets).toEqual([
      expect.objectContaining({
        path: 'asset.bin',
        content
      })
    ])
  })

  it('does not install node dependencies during creation when downloads are skipped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    const commands: string[] = []
    process.chdir(root)

    const result = await createProject(
      defaultOptions({ name: 'maa-create-skip-install', skipDownload: true }),
      {
        installNodeDeps: true,
        commandRunner: async (_cwd, command) => {
          commands.push(command)
        }
      }
    )

    expect(commands).toEqual([])
    expect(result.pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'node-deps'
        })
      ])
    )
  })

  it('adds agent incrementally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-agent-test' }))
    process.chdir(join(root, 'maa-agent-test'))

    const result = await addAgent(
      defaultOptions({ add: [
          'agent'
        ] })
    )

    expect(result.written).toContain('pyproject.toml')
    expect(result.written).toEqual(
      expect.arrayContaining([
        'agent/agent_runtime.py',
        'agent/custom/action/general.py',
        'agent/custom/reco/general.py',
        'agent/custom/sink/__init__.py',
        'agent/utils/pienv.py',
        'agent/utils/params.py',
        'agent/utils/runtime_paths.py',
        'agent/utils/maa_types.py'
      ])
    )
    expect(result.written).not.toContain('config/pip_config.json')
    expect(result.config.python).toMatchObject({
      recommendedPython: '3.13'
    })
    expect(result.pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'python-deps',
          command: 'create-maa-project --update python-deps'
        })
      ])
    )
    const pyproject = await readFile(join(root, 'maa-agent-test', 'pyproject.toml'), 'utf8')
    expect(pyproject).toContain('name = "maa-agent-test"\nversion = "0.1.0"')
    expect(pyproject).toContain('[tool.ruff]')
    expect(pyproject).toContain('[tool.pyright]')
    expect(pyproject).toContain('extraPaths = ["agent"]')
    expect(await pathExists(join(root, 'maa-agent-test', 'ruff.toml'))).toBe(false)
    expect(await pathExists(join(root, 'maa-agent-test', 'pyrightconfig.json'))).toBe(false)
    const bootstrap = await readFile(join(root, 'maa-agent-test', 'agent/bootstrap.py'), 'utf8')
    const main = await readFile(join(root, 'maa-agent-test', 'agent/main.py'), 'utf8')
    const agentRuntime = await readFile(
      join(root, 'maa-agent-test', 'agent/agent_runtime.py'),
      'utf8'
    )
    const custom = await readFile(join(root, 'maa-agent-test', 'agent/custom/__init__.py'), 'utf8')
    const action = await readFile(
      join(root, 'maa-agent-test', 'agent/custom/action/general.py'),
      'utf8'
    )
    const reco = await readFile(
      join(root, 'maa-agent-test', 'agent/custom/reco/general.py'),
      'utf8'
    )
    const pienv = await readFile(join(root, 'maa-agent-test', 'agent/utils/pienv.py'), 'utf8')
    const params = await readFile(join(root, 'maa-agent-test', 'agent/utils/params.py'), 'utf8')
    const gitignore = await readFile(join(root, 'maa-agent-test', '.gitignore'), 'utf8')
    expect(bootstrap).toContain('debug')
    expect(bootstrap).toContain('agent-bootstrap.log')
    expect(bootstrap).toContain('created config/pip_config.json')
    expect(bootstrap).toContain('importlib.metadata.version("maafw")')
    expect(bootstrap).toContain('create-maa-project --update python-deps')
    expect(main).toContain('from agent_runtime import run_agent')
    expect(main).toContain('sys.exit(main())')
    expect(agentRuntime).toContain('custom.register_all()')
    expect(agentRuntime).toContain('AgentServer.start_up(socket_id)')
    expect(custom).toContain('action.register_all()')
    expect(custom).toContain('reco.register_all()')
    expect(action).toContain('@AgentServer.custom_action("DisableNode")')
    expect(action).toContain('@AgentServer.custom_action("SubTask")')
    expect(reco).toContain('@AgentServer.custom_recognition("ExampleRecognition")')
    expect(pienv).toContain('PI_CONTROLLER')
    expect(pienv).toContain('PI_RESOURCE')
    expect(params).toContain('parse_params')
    expect(await pathExists(join(root, 'maa-agent-test', 'config/pip_config.json'))).toBe(false)
    expect(gitignore).toContain('config/')
    expect(await readJson(join(root, 'maa-agent-test', 'interface.json'))).toMatchObject({
      name: 'maa-agent-test',
      agent: [
        {
          identifier: 'maa-agent-test.agent'
        }
      ]
    })
    expect(await readJson(join(root, 'maa-agent-test', 'package.json'))).toMatchObject({
      scripts: {
        'format:py': 'uv run --frozen ruff format .',
        'lint:py': 'uv run --frozen ruff check .',
        'typecheck:py': 'uv run --frozen pyright',
        'check:py': 'pnpm lint:py && pnpm typecheck:py'
      }
    })
    expect(
      await readJson(join(root, 'maa-agent-test', 'tools/schema/custom.action.schema.json'))
    ).toMatchObject({
      $defs: {
        DisableNodeParam: {
          required: [
            'node_name'
          ]
        },
        SubTaskParam: {
          required: [
            'sub'
          ]
        }
      }
    })
    expect(
      await readJson(join(root, 'maa-agent-test', 'tools/schema/custom.recognition.schema.json'))
    ).toMatchObject({
      $defs: {
        ExampleRecognitionParam: {
          properties: {
            node: {
              type: 'string'
            },
            box: {
              $ref: '#/$defs/Rect'
            }
          }
        }
      }
    })
    expect(await readJson(join(root, 'maa-agent-test', '.vscode/extensions.json'))).toMatchObject({
      recommendations: expect.arrayContaining([
        'windsland52.maa-log-analyzer',
        'charliermarsh.ruff',
        'ms-python.python',
        'ms-python.vscode-pylance'
      ])
    })
    expect(await readJson(join(root, 'maa-agent-test', '.vscode/settings.json'))).toMatchObject({
      'python.defaultInterpreterPath': '${workspaceFolder}/.venv/bin/python',
      '[jsonc]': {
        'editor.defaultFormatter': 'esbenp.prettier-vscode'
      },
      '[python]': {
        'editor.defaultFormatter': 'charliermarsh.ruff'
      },
      'files.associations': {
        '*.json': 'jsonc',
        '*.jsonc': 'jsonc'
      },
      'json.schemas': expect.arrayContaining([
        expect.objectContaining({
          fileMatch: [
            '/interface.json'
          ],
          url: './tools/schema/interface.schema.json'
        })
      ])
    })
    const releaseWorkflow = await readFile(
      join(root, 'maa-agent-test', '.github/workflows/release.yml'),
      'utf8'
    )
    expect(releaseWorkflow).toContain('actions/setup-python@v6')
    expect(releaseWorkflow).toContain('astral-sh/setup-uv@v8.1.0')
    expect(releaseWorkflow).toContain('pnpm check:py')
    expect(releaseWorkflow).toContain('-MFAA.${{ matrix.ext }}"')
    expect(releaseWorkflow).not.toContain('package_paths=')
    expectReleaseWorkflowTargets(releaseWorkflow)
    expect(releaseWorkflow).not.toContain('|| true')
  })

  it('keeps resource packs in append order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-resource-test' }))
    process.chdir(join(root, 'maa-resource-test'))

    await addResourcePack(
      defaultOptions({ add: [
          'resource-pack'
        ], resourcePackSlug: 'pack-a' })
    )
    const result = await addResourcePack(
      defaultOptions({ add: [
          'resource-pack'
        ], resourcePackSlug: 'pack-b', label: '  Pack B  ' })
    )

    expect(result.config.resources.map((pack) => pack.path)).toEqual([
      'resource/base',
      'resource/pack-a',
      'resource/pack-b'
    ])
    expect(result.config.resources.map((pack) => pack.label)).toEqual([
      'Base',
      'Pack A',
      'Pack B'
    ])
    expect(await readJson(join(root, 'maa-resource-test', 'interface.json'))).toMatchObject({
      resource: [
        { name: 'base', path: [
            './resource/base'
          ] },
        { name: 'pack-a', path: [
            './resource/pack-a'
          ] },
        { name: 'pack-b', path: [
            './resource/pack-b'
          ] }
      ]
    })
    const maatoolsConfig = await readFile(
      join(root, 'maa-resource-test', 'maatools.config.mts'),
      'utf8'
    )
    expect(maatoolsConfig).toContain("'./resource/base'")
    expect(maatoolsConfig).toContain("'./resource/pack-a'")
    expect(maatoolsConfig).toContain("'./resource/pack-b'")
    expect(
      await pathExists(join(root, 'maa-resource-test', 'resource/pack-b/image/empty.png'))
    ).toBe(true)
    expect(
      await pathExists(join(root, 'maa-resource-test', 'resource/pack-b/image/.gitkeep'))
    ).toBe(false)
  })

  it('adds a resource pack during project creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)

    const result = await createProject(
      defaultOptions({
        name: 'maa-resource-create',
        add: [
          'resource-pack'
        ],
        resourcePackSlug: 'pack-a',
        label: 'Pack A'
      })
    )

    expect(result.config.resources.map((pack) => pack.path)).toEqual([
      'resource/base',
      'resource/pack-a'
    ])
    expect(await readJson(join(root, 'maa-resource-create', 'interface.json'))).toMatchObject({
      resource: [
        { name: 'base', path: [
            './resource/base'
          ] },
        { name: 'pack-a', label: 'Pack A', path: [
            './resource/pack-a'
          ] }
      ]
    })
    const maatoolsConfig = await readFile(
      join(root, 'maa-resource-create', 'maatools.config.mts'),
      'utf8'
    )
    expect(maatoolsConfig).toContain("'./resource/base'")
    expect(maatoolsConfig).toContain("'./resource/pack-a'")
    expect(result.written).toEqual(
      expect.arrayContaining([
        'resource/pack-a/pipeline/.gitkeep',
        'resource/pack-a/image/empty.png'
      ])
    )
  })

  it('rejects blank resource pack labels', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-resource-label-test' }))
    process.chdir(join(root, 'maa-resource-label-test'))

    await expect(
      addResourcePack(
        defaultOptions({ add: [
            'resource-pack'
          ], resourcePackSlug: 'blank-label', label: '   ' })
      )
    ).rejects.toThrow('Resource pack label cannot be blank')
  })

  it('adds git-cliff, community, and dependabot incrementally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-addon-test' }))
    process.chdir(join(root, 'maa-addon-test'))

    await writeFile(join(root, 'maa-addon-test', 'CHANGELOG.md'), '# User Changelog\n', 'utf8')
    await writeFile(join(root, 'maa-addon-test', 'CONTRIBUTING.md'), '# User Guide\n', 'utf8')
    const gitCliffResult = await addGitCliff(
      defaultOptions({ add: [
          'git-cliff'
        ] })
    )
    const communityResult = await addCommunity(
      defaultOptions({ add: [
          'community'
        ] })
    )
    const dependabotResult = await addDependabot(
      defaultOptions({ add: [
          'dependabot'
        ] })
    )

    expect(gitCliffResult.written).toEqual(
      expect.arrayContaining([
        '.github/cliff.toml',
        '.github/workflows/release.yml'
      ])
    )
    expect(gitCliffResult.skipped).not.toContain('CHANGELOG.md')
    expect(await readFile(join(root, 'maa-addon-test', 'CHANGELOG.md'), 'utf8')).toBe(
      '# User Changelog\n'
    )
    expect(await readFile(join(root, 'maa-addon-test', '.github/cliff.toml'), 'utf8')).toContain(
      '[git.github]'
    )
    expect(await readFile(join(root, 'maa-addon-test', '.github/cliff.toml'), 'utf8')).toContain(
      '新功能 | Features'
    )
    expect(
      await readFile(join(root, 'maa-addon-test', '.github/workflows/release.yml'), 'utf8')
    ).toContain('orhun/git-cliff-action@v4')
    expect(communityResult.skipped).toContain('CONTRIBUTING.md')
    expect(communityResult.written).toEqual(
      expect.arrayContaining([
        '.github/ISSUE_TEMPLATE/config.yml',
        '.github/ISSUE_TEMPLATE/bug_report.yml',
        '.github/ISSUE_TEMPLATE/feature_request.yml',
        '.github/ISSUE_TEMPLATE/other_issue.yml',
        '.github/PULL_REQUEST_TEMPLATE.md'
      ])
    )
    expect(await readFile(join(root, 'maa-addon-test', 'CONTRIBUTING.md'), 'utf8')).toBe(
      '# User Guide\n'
    )
    expect(
      await readFile(join(root, 'maa-addon-test', '.github/ISSUE_TEMPLATE/bug_report.yml'), 'utf8')
    ).toContain('maa-addon-test 版本 / maa-addon-test Version')
    expect(
      await readFile(join(root, 'maa-addon-test', '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8')
    ).toContain('验证 / Validation')
    expect(dependabotResult.written).toContain('.github/dependabot.yml')
    expect(
      await readFile(join(root, 'maa-addon-test', '.github/dependabot.yml'), 'utf8')
    ).toContain('package-ecosystem: npm')
    expect(await readJson(join(root, 'maa-addon-test', 'maa-project.json'))).toMatchObject({
      addons: {
        gitCliff: { enabled: true },
        community: { enabled: true },
        dependabot: { enabled: true }
      }
    })
    expect(await readJson(join(root, 'maa-addon-test', 'maa-project.lock.json'))).toMatchObject({
      managedFiles: {
        '.github/cliff.toml': expect.any(Object),
        '.github/dependabot.yml': expect.any(Object)
      },
      createdFiles: {
        '.github/ISSUE_TEMPLATE/config.yml': expect.any(Object),
        '.github/ISSUE_TEMPLATE/bug_report.yml': expect.any(Object),
        '.github/ISSUE_TEMPLATE/feature_request.yml': expect.any(Object),
        '.github/ISSUE_TEMPLATE/other_issue.yml': expect.any(Object),
        '.github/PULL_REQUEST_TEMPLATE.md': expect.any(Object)
      }
    })
  })

  it('supports git-cliff, community, and dependabot during project creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)

    const result = await createProject(
      defaultOptions({
        name: 'maa-create-addons',
        add: [
          'git-cliff',
          'community',
          'dependabot'
        ]
      })
    )

    expect(result.written).toEqual(
      expect.arrayContaining([
        '.github/cliff.toml',
        'CONTRIBUTING.md',
        '.github/ISSUE_TEMPLATE/config.yml',
        '.github/ISSUE_TEMPLATE/bug_report.yml',
        '.github/ISSUE_TEMPLATE/feature_request.yml',
        '.github/ISSUE_TEMPLATE/other_issue.yml',
        '.github/PULL_REQUEST_TEMPLATE.md',
        '.github/dependabot.yml'
      ])
    )
    expect(await readFile(join(root, 'maa-create-addons', '.github/cliff.toml'), 'utf8')).toContain(
      '[git.github]'
    )
    expect(await readFile(join(root, 'maa-create-addons', '.github/cliff.toml'), 'utf8')).toContain(
      '问题修复 | Bug Fixes'
    )
    expect(
      await readFile(join(root, 'maa-create-addons', '.github/workflows/release.yml'), 'utf8')
    ).toContain('body: ${{ needs.git_cliff.outputs.release_body }}')
    expect(await readFile(join(root, 'maa-create-addons', 'CONTRIBUTING.md'), 'utf8')).toContain(
      'Contributing to maa-create-addons'
    )
    expect(await readFile(join(root, 'maa-create-addons', 'CONTRIBUTING.md'), 'utf8')).toContain(
      '开发 / Development'
    )
    expect(
      await readFile(join(root, 'maa-create-addons', '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8')
    ).toContain('检查清单 / Checklist')
    expect(
      await readFile(
        join(root, 'maa-create-addons', '.github/ISSUE_TEMPLATE/feature_request.yml'),
        'utf8'
      )
    ).toContain('需求建议 / Feature Request')
    expect(
      await readFile(
        join(root, 'maa-create-addons', '.github/ISSUE_TEMPLATE/other_issue.yml'),
        'utf8'
      )
    ).toContain('maa-create-addons 版本 / maa-create-addons Version')
    expect(await readJson(join(root, 'maa-create-addons', 'maa-project.json'))).toMatchObject({
      addons: {
        gitCliff: { enabled: true },
        community: { enabled: true },
        dependabot: { enabled: true }
      }
    })
  })

  it('rejects unsupported add-ons during project creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)

    await expect(
      createProject(
        defaultOptions({ name: 'maa-reserved-addon', add: [
            'mirrorchyan'
          ] })
      )
    ).rejects.toThrow(
      '--add mirrorchyan is reserved for v1.x and is not implemented in this version'
    )
    await expect(
      createProject(
        defaultOptions({ name: 'maa-old-changelog-addon', add: [
            'changelog'
          ] })
      )
    ).rejects.toThrow('Unsupported add-on: changelog')
    await expect(
      createProject(
        defaultOptions({ name: 'maa-unknown-addon', add: [
            'unknown-addon'
          ] })
      )
    ).rejects.toThrow('Unsupported add-on: unknown-addon')
  })

  it('supports git-cliff during project creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)

    const result = await createProject(
      defaultOptions({ name: 'maa-git-cliff-addon', add: [
          'git-cliff'
        ] })
    )

    expect(result.written).toEqual(
      expect.arrayContaining([
        '.github/cliff.toml',
        '.github/workflows/check.yml',
        '.github/workflows/release.yml',
        'package.json'
      ])
    )
    expect(await readJson(join(root, 'maa-git-cliff-addon', 'maa-project.json'))).toMatchObject({
      addons: {
        devTools: { enabled: true },
        github: { enabled: true },
        gitCliff: { enabled: true }
      }
    })
    expect(
      await readFile(join(root, 'maa-git-cliff-addon', '.github/workflows/release.yml'), 'utf8')
    ).toContain('orhun/git-cliff-action@v4')
  })

  it('supports auto-format during project creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)

    const result = await createProject(
      defaultOptions({ name: 'maa-auto-format-create', add: [
          'auto-format'
        ] })
    )

    expect(result.written).toEqual(
      expect.arrayContaining([
        '.github/workflows/check.yml',
        '.github/workflows/release.yml',
        '.github/workflows/format.yml',
        'package.json'
      ])
    )
    expect(await readJson(join(root, 'maa-auto-format-create', 'maa-project.json'))).toMatchObject({
      addons: {
        devTools: { enabled: true },
        github: { enabled: true },
        autoFormat: { enabled: true }
      }
    })
    const formatWorkflow = await readFile(
      join(root, 'maa-auto-format-create', '.github/workflows/format.yml'),
      'utf8'
    )
    expect(formatWorkflow).toContain('pnpm format')
    expect(formatWorkflow).toContain('pnpm format:py')
    expect(formatWorkflow).toContain('[skip changelog]')
    expect(formatWorkflow).not.toContain('actions-js/push')
  })

  it('adds auto-format files to an existing project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(minimalOptions({ name: 'maa-auto-format-addon' }))
    const projectRoot = join(root, 'maa-auto-format-addon')
    process.chdir(projectRoot)

    const result = await applyIncrementalAddons(
      defaultOptions({ add: [
          'auto-format'
        ] })
    )

    expect(result?.written).toEqual(
      expect.arrayContaining([
        '.github/workflows/format.yml'
      ])
    )
    expect(await readJson(join(projectRoot, 'maa-project.json'))).toMatchObject({
      addons: {
        devTools: { enabled: true },
        github: { enabled: true },
        autoFormat: { enabled: true }
      }
    })
    await expect(pathExists(join(projectRoot, 'tools/check-project.mjs'))).resolves.toBe(true)
    await expect(pathExists(join(projectRoot, '.github/workflows/check.yml'))).resolves.toBe(true)
    await expect(pathExists(join(projectRoot, '.github/workflows/release.yml'))).resolves.toBe(true)
    await expect(pathExists(join(projectRoot, '.github/workflows/format.yml'))).resolves.toBe(true)
    expect(await readFile(join(projectRoot, '.github/workflows/format.yml'), 'utf8')).toContain(
      'git commit -m "style: auto format code [skip changelog]"'
    )
  })

  it('supports optimize-images during project creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)

    const result = await createProject(
      defaultOptions({ name: 'maa-optimize-images-create', add: [
          'optimize-images'
        ] })
    )

    expect(result.written).toEqual(
      expect.arrayContaining([
        '.github/workflows/check.yml',
        '.github/workflows/release.yml',
        '.github/workflows/optimize-images.yml',
        'tools/optimize-images.mjs',
        'package.json'
      ])
    )
    expect(
      await readJson(join(root, 'maa-optimize-images-create', 'maa-project.json'))
    ).toMatchObject({
      addons: {
        devTools: { enabled: true },
        github: { enabled: true },
        optimizeImages: { enabled: true }
      }
    })
    expect(await readJson(join(root, 'maa-optimize-images-create', 'package.json'))).toMatchObject({
      scripts: {
        'optimize:images': 'node tools/optimize-images.mjs'
      }
    })
    const optimizeWorkflow = await readFile(
      join(root, 'maa-optimize-images-create', '.github/workflows/optimize-images.yml'),
      'utf8'
    )
    expect(optimizeWorkflow).toContain('baptiste0928/cargo-install@v3')
    expect(optimizeWorkflow).toContain("github.actor != 'github-actions[bot]'")
    expect(optimizeWorkflow).toContain('[skip changelog]')
    expect(optimizeWorkflow).toContain('git push origin "HEAD:$GITHUB_REF_NAME"')
    expect(optimizeWorkflow).not.toContain('actions-js/push')
    const optimizeScript = await readFile(
      join(root, 'maa-optimize-images-create', 'tools/optimize-images.mjs'),
      'utf8'
    )
    expect(optimizeScript).toContain('function runOxipng(args)')
    expect(optimizeScript).toContain("'--fast'")
    expect(optimizeScript).toContain("'-Z'")
  })

  it('adds optimize-images files to an existing project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(minimalOptions({ name: 'maa-optimize-images-addon' }))
    const projectRoot = join(root, 'maa-optimize-images-addon')
    process.chdir(projectRoot)

    const result = await applyIncrementalAddons(
      defaultOptions({ add: [
          'optimize-images'
        ] })
    )

    expect(result?.written).toEqual(
      expect.arrayContaining([
        '.github/workflows/optimize-images.yml',
        'tools/optimize-images.mjs',
        'package.json'
      ])
    )
    expect(await readJson(join(projectRoot, 'maa-project.json'))).toMatchObject({
      addons: {
        devTools: { enabled: true },
        github: { enabled: true },
        optimizeImages: { enabled: true }
      }
    })
    expect(await readJson(join(projectRoot, 'package.json'))).toMatchObject({
      scripts: {
        'optimize:images': 'node tools/optimize-images.mjs'
      }
    })
    await expect(pathExists(join(projectRoot, 'tools/check-project.mjs'))).resolves.toBe(true)
    await expect(pathExists(join(projectRoot, '.github/workflows/check.yml'))).resolves.toBe(true)
    await expect(pathExists(join(projectRoot, '.github/workflows/release.yml'))).resolves.toBe(true)
    await expect(
      pathExists(join(projectRoot, '.github/workflows/optimize-images.yml'))
    ).resolves.toBe(true)
    expect(
      await readFile(join(projectRoot, '.github/workflows/optimize-images.yml'), 'utf8')
    ).toContain('node tools/optimize-images.mjs')
  })

  it('records schema-sync add-on state during project creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)

    const result = await createProject(
      defaultOptions({ name: 'maa-schema-sync-create', add: [
          'schema-sync'
        ] })
    )

    expect(result.written).toEqual(
      expect.arrayContaining([
        '.github/workflows/schema-sync.yml',
        'tools/sync-schema.mjs'
      ])
    )
    expect(await readJson(join(root, 'maa-schema-sync-create', 'maa-project.json'))).toMatchObject({
      addons: {
        schemaSync: { enabled: true }
      }
    })
    expect(await readJson(join(root, 'maa-schema-sync-create', 'package.json'))).toMatchObject({
      scripts: {
        'sync:schema': 'node tools/sync-schema.mjs'
      }
    })
    const schemaSyncWorkflow = await readFile(
      join(root, 'maa-schema-sync-create', '.github/workflows/schema-sync.yml'),
      'utf8'
    )
    expect(schemaSyncWorkflow).toContain('if: github.event.repository.fork == false')
    expect(schemaSyncWorkflow).toContain('git push')
    expect(schemaSyncWorkflow).toContain('git add tools/schema')
    expect(schemaSyncWorkflow).toContain(
      'git commit -m "chore: sync MaaFW schema [skip changelog]"'
    )
    expect(schemaSyncWorkflow).not.toContain('create-pull-request')
    expect(schemaSyncWorkflow).not.toContain('pull-requests: write')
  })

  it('uses shared add-on semantics from the incremental entrypoint', async () => {
    await expect(
      applyIncrementalAddons(
        defaultOptions({ add: [
            'ci'
          ] })
      )
    ).rejects.toThrow('Unsupported add-on: ci')
    await expect(
      applyIncrementalAddons(
        defaultOptions({ add: [
            'schema-sync'
          ] })
      )
    ).rejects.toThrow('No maa-project.json found')
  })

  it('adds schema-sync files to an existing project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(minimalOptions({ name: 'maa-schema-sync-addon' }))
    const projectRoot = join(root, 'maa-schema-sync-addon')
    process.chdir(projectRoot)

    const result = await applyIncrementalAddons(
      defaultOptions({ add: [
          'schema-sync'
        ] })
    )

    expect(result?.written).toEqual(
      expect.arrayContaining([
        '.github/workflows/schema-sync.yml',
        'tools/sync-schema.mjs'
      ])
    )
    expect(await readJson(join(projectRoot, 'maa-project.json'))).toMatchObject({
      addons: {
        devTools: { enabled: true },
        github: { enabled: true },
        schemaSync: { enabled: true }
      }
    })
    expect(await pathExists(join(projectRoot, '.github/workflows/check.yml'))).toBe(true)
    expect(await pathExists(join(projectRoot, '.github/workflows/release.yml'))).toBe(true)
    expect(await pathExists(join(projectRoot, 'tools/check-project.mjs'))).toBe(true)
    expect(await readJson(join(projectRoot, 'package.json'))).toMatchObject({
      scripts: {
        'sync:schema': 'node tools/sync-schema.mjs'
      }
    })
  })

  it('syncs version and display name metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'MaaSync' }))
    process.chdir(join(root, 'MaaSync'))

    await syncProject(defaultOptions({ sync: 'version', version: '0.2.0' }))
    const result = await syncProject(
      defaultOptions({ sync: 'display-name', displayName: 'Maa Sync' })
    )

    expect(result.config.project.version).toBe('0.2.0')
    expect(result.config.project.displayName).toBe('Maa Sync')
    expect(await readJson(join(root, 'MaaSync', 'interface.json'))).toMatchObject({
      name: 'maasync',
      label: 'Maa Sync',
      version: 'v0.2.0'
    })
    expect(await readJson(join(root, 'MaaSync', 'package.json'))).toMatchObject({
      name: 'maasync',
      version: '0.2.0',
      license: 'AGPL-3.0-or-later'
    })
  })

  it('rejects blank display names during sync', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-blank-name-test' }))
    process.chdir(join(root, 'maa-blank-name-test'))

    await expect(
      syncProject(defaultOptions({ sync: 'display-name', displayName: '   ' }))
    ).rejects.toThrow('--sync display-name requires --name <display-name>')
  })

  it('syncs agent pyproject version metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-pyproject-sync' }))
    process.chdir(join(root, 'maa-pyproject-sync'))
    await addAgent(
      defaultOptions({ add: [
          'agent'
        ] })
    )

    await syncProject(defaultOptions({ sync: 'version', version: '0.2.0' }))

    expect(await readFile(join(root, 'maa-pyproject-sync', 'pyproject.toml'), 'utf8')).toContain(
      'name = "maa-pyproject-sync"\nversion = "0.2.0"'
    )
  })

  it('syncs license metadata to project state and package json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-license-test' }))
    process.chdir(join(root, 'maa-license-test'))

    const result = await syncProject(defaultOptions({ sync: 'license', license: 'MIT' }))

    expect(result.config.license.spdx).toBe('MIT')
    expect(await readJson(join(root, 'maa-license-test', 'maa-project.json'))).toMatchObject({
      license: { spdx: 'MIT' }
    })
    expect(await readJson(join(root, 'maa-license-test', 'package.json'))).toMatchObject({
      license: 'MIT'
    })
  })

  it('syncs github url to project state and interface metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-github-test' }))
    process.chdir(join(root, 'maa-github-test'))

    const result = await syncProject(
      defaultOptions({ sync: 'github-url', syncValue: 'https://github.com/MaaXYZ/MaaTest/' })
    )

    expect(result.config.project.github).toBe('https://github.com/MaaXYZ/MaaTest')
    expect(await readJson(join(root, 'maa-github-test', 'interface.json'))).toMatchObject({
      github: 'https://github.com/MaaXYZ/MaaTest'
    })
    expect((await runDoctor(join(root, 'maa-github-test'))).lines.join('\n')).toContain(
      'Interface metadata matches project config'
    )
  })

  it('rejects invalid github urls during sync', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-github-url-test' }))
    process.chdir(join(root, 'maa-github-url-test'))

    for (const syncValue of [
      'http://github.com/MaaXYZ/MaaTest',
      'https://example.com/MaaXYZ/MaaTest',
      'https://github.com/MaaXYZ',
      'https://github.com/MaaXYZ/MaaTest/issues/1',
      'https://github.com/MaaXYZ/MaaTest?tab=readme'
    ]) {
      await expect(syncProject(defaultOptions({ sync: 'github-url', syncValue }))).rejects.toThrow(
        'Use an HTTPS GitHub repository URL'
      )
    }
  })

  it('syncs network mode to project state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-network-test' }))
    process.chdir(join(root, 'maa-network-test'))

    const result = await syncProject(defaultOptions({ sync: 'network', network: 'official' }))

    expect(result.config.network.mode).toBe('official')
    expect(await readJson(join(root, 'maa-network-test', 'maa-project.json'))).toMatchObject({
      network: { mode: 'official' }
    })
  })

  it('syncs controller metadata from project state to interface json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(
      defaultOptions({ name: 'maa-controller-test', controllers: [
          'Win32'
        ] })
    )
    const projectRoot = join(root, 'maa-controller-test')
    const interfacePath = join(projectRoot, 'interface.json')
    const interfaceJson = (await readJson(interfacePath)) as Record<string, unknown>
    interfaceJson.controller = []
    await writeFile(interfacePath, JSON.stringify(interfaceJson, null, 4), 'utf8')

    let report = await runDoctor(projectRoot)
    expect(report.ok).toBe(false)
    expect(report.lines.join('\n')).toContain('interface.json controller differs')

    process.chdir(projectRoot)
    await syncProject(defaultOptions({ sync: 'metadata' }))
    report = await runDoctor(projectRoot)

    expect(await readJson(interfacePath)).toMatchObject({
      controller: [
        { name: 'Windows', label: 'Windows app', type: 'Win32' }
      ]
    })
    expect(report.lines.join('\n')).toContain('Interface metadata matches project config')
  })

  it('rejects Chinese-only non-interactive project ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)

    await expect(createProject(defaultOptions({ name: '测试项目' }))).rejects.toThrow(
      'Project ID cannot be inferred'
    )
  })

  it('supports Chinese display name with an ASCII project slug', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)

    const result = await createProject(
      defaultOptions({ name: 'maa-helper', displayName: '  明日方舟助手  ' })
    )

    expect(result.config.project.slug).toBe('maa-helper')
    expect(result.config.project.displayName).toBe('明日方舟助手')
  })

  it('rejects blank project display names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)

    await expect(
      createProject(defaultOptions({ name: 'maa-blank-display', displayName: '   ' }))
    ).rejects.toThrow('Project display name cannot be blank')
  })

  it('supports Chinese directory names when slug is provided', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)

    const result = await createProject(
      defaultOptions({ name: '明日方舟助手', slug: 'arknights-helper' })
    )

    expect(result.root).toBe(join(root, '明日方舟助手'))
    expect(result.config.project.slug).toBe('arknights-helper')
    expect(result.config.project.displayName).toBe('明日方舟助手')
  })

  it('keeps uppercase directory names while normalizing slug', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)

    const result = await createProject(defaultOptions({ name: 'MaaXX' }))

    expect(result.root).toBe(join(root, 'MaaXX'))
    expect(result.config.project.slug).toBe('maaxx')
    expect(result.config.project.displayName).toBe('MaaXX')
    expect(await readJson(join(root, 'MaaXX', 'interface.json'))).toMatchObject({
      name: 'maaxx',
      label: 'MaaXX'
    })
    expect(await readFile(join(root, 'MaaXX', 'README.md'), 'utf8')).toContain('# MaaXX')
  })

  it('doctor reports interface metadata drift with a repair command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-doctor-test' }))
    const projectRoot = join(root, 'maa-doctor-test')
    const interfacePath = join(projectRoot, 'interface.json')
    const interfaceJson = (await readJson(interfacePath)) as Record<string, unknown>
    interfaceJson.name = 'Wrong Display Name'
    await writeFile(interfacePath, JSON.stringify(interfaceJson, null, 4), 'utf8')

    const report = await runDoctor(projectRoot)

    expect(report.ok).toBe(false)
    expect(report.lines.join('\n')).toContain('interface.json name differs')
    expect(report.lines.join('\n')).toContain('create-maa-project --sync metadata')
  })

  it('doctor reports interface version and agent drift with a repair command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-interface-agent-test' }))
    const projectRoot = join(root, 'maa-interface-agent-test')
    process.chdir(projectRoot)
    await addAgent(
      defaultOptions({ add: [
          'agent'
        ] })
    )
    const interfacePath = join(projectRoot, 'interface.json')
    const interfaceJson = (await readJson(interfacePath)) as Record<string, unknown>
    interfaceJson.version = 'v9.9.9'
    interfaceJson.agent = [
      {
        child_exec: [
          'python',
          'wrong.py'
        ],
        identifier: 'wrong.agent'
      }
    ]
    await writeFile(interfacePath, JSON.stringify(interfaceJson, null, 4), 'utf8')

    const report = await runDoctor(projectRoot)
    const output = report.lines.join('\n')

    expect(report.ok).toBe(false)
    expect(output).toContain('interface.json version differs')
    expect(output).toContain('interface.json agent differs')
    expect(output).toContain('create-maa-project --sync metadata')
  })

  it('doctor reports package metadata drift with a repair command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-package-test' }))
    const projectRoot = join(root, 'maa-package-test')
    const packagePath = join(projectRoot, 'package.json')
    const packageJson = (await readJson(packagePath)) as Record<string, unknown>
    packageJson.name = 'wrong-package'
    packageJson.license = 'MIT'
    await writeFile(packagePath, JSON.stringify(packageJson, null, 4), 'utf8')

    const report = await runDoctor(projectRoot)
    const output = report.lines.join('\n')

    expect(report.ok).toBe(false)
    expect(output).toContain('package.json name differs')
    expect(output).toContain('package.json license differs')
    expect(output).toContain('create-maa-project --sync metadata')
  })

  it('doctor reports package tooling drift with a repair command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-package-tooling-test' }))
    const projectRoot = join(root, 'maa-package-tooling-test')
    const packagePath = join(projectRoot, 'package.json')
    const packageJson = (await readJson(packagePath)) as {
      packageManager?: unknown
      engines?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
      scripts?: Record<string, unknown>
    }
    packageJson.packageManager = 'npm@11.0.0'
    packageJson.engines = { ...(packageJson.engines ?? {}), node: '>=22' }
    packageJson.devDependencies = {
      ...(packageJson.devDependencies ?? {}),
      '@nekosu/maa-tools': '^0.4.0',
      prettier: '^3.8.4'
    }
    packageJson.scripts = {
      ...(packageJson.scripts ?? {}),
      'format:check': 'prettier . --check',
      'check:maa': 'maa-tools check'
    }
    await writeFile(packagePath, JSON.stringify(packageJson, null, 4) + '\n', 'utf8')

    const report = await runDoctor(projectRoot)
    const output = report.lines.join('\n')

    expect(report.ok).toBe(false)
    expect(output).toContain('package.json packageManager must be pnpm@11.5.1')
    expect(output).toContain('package.json engines.node must be >=24')
    expect(output).toContain('package.json @nekosu/maa-tools must be pinned to 1.0.24')
    expect(output).toContain('package.json devDependencies.prettier must be pinned to 3.8.4')
    expect(output).toContain('package.json scripts.format:check must be prettier --check .')
    expect(output).toContain(
      'package.json scripts.check:maa must use local pnpm exec maa-tools check'
    )
    expect(output).toContain('create-maa-project --update template')
  })

  it('doctor reports agent package tooling drift with a repair command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-agent-package-tooling-test' }))
    const projectRoot = join(root, 'maa-agent-package-tooling-test')
    process.chdir(projectRoot)
    await addAgent(
      defaultOptions({ add: [
          'agent'
        ] })
    )
    const packagePath = join(projectRoot, 'package.json')
    const packageJson = (await readJson(packagePath)) as {
      scripts?: Record<string, unknown>
    }
    packageJson.scripts = { ...(packageJson.scripts ?? {}), 'check:py': 'uv run pyright' }
    await writeFile(packagePath, JSON.stringify(packageJson, null, 4) + '\n', 'utf8')

    const report = await runDoctor(projectRoot)
    const output = report.lines.join('\n')

    expect(report.ok).toBe(false)
    expect(output).toContain(
      'package.json scripts.check:py must be pnpm lint:py && pnpm typecheck:py'
    )
    expect(output).toContain('create-maa-project --update template')
  })

  it('doctor reports Node tooling file drift with a repair command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-node-tooling-test' }))
    const projectRoot = join(root, 'maa-node-tooling-test')
    await writeFile(join(projectRoot, '.node-version'), '22\n', 'utf8')
    await writeFile(
      join(projectRoot, '.github/workflows/check.yml'),
      `name: Check
jobs:
  check:
    steps:
      - uses: actions/setup-node@v6
        with:
          node-version: 22
`,
      'utf8'
    )

    const report = await runDoctor(projectRoot)
    const output = report.lines.join('\n')

    expect(report.ok).toBe(false)
    expect(output).toContain('.node-version must pin Node 24')
    expect(output).toContain('.github/workflows/check.yml must use Node 24')
    expect(output).toContain('create-maa-project --update template')
  })

  it('doctor reports VS Code settings drift with a repair command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-vscode-doctor' }))
    const projectRoot = join(root, 'maa-vscode-doctor')
    const settingsPath = join(projectRoot, '.vscode/settings.json')
    const settings = (await readJson(settingsPath)) as Record<string, unknown>
    settings['editor.formatOnSave'] = false
    settings['[jsonc]'] = {}
    settings['json.schemas'] = []
    await writeFile(settingsPath, JSON.stringify(settings, null, 4) + '\n', 'utf8')

    const report = await runDoctor(projectRoot)
    const output = report.lines.join('\n')

    expect(report.ok).toBe(false)
    expect(output).toContain('.vscode/settings.json editor.formatOnSave must be true')
    expect(output).toContain(
      '.vscode/settings.json [jsonc] editor.defaultFormatter must be esbenp.prettier-vscode'
    )
    expect(output).toContain(
      '.vscode/settings.json json.schemas must map /interface.json to ./tools/schema/interface.schema.json'
    )
    expect(output).toContain('create-maa-project --update template')
  })

  it('doctor reports pyproject metadata drift with a repair command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-pyproject-doctor' }))
    const projectRoot = join(root, 'maa-pyproject-doctor')
    process.chdir(projectRoot)
    await addAgent(
      defaultOptions({ add: [
          'agent'
        ] })
    )
    await writeFile(
      join(projectRoot, 'pyproject.toml'),
      `[project]
name = "wrong-agent"
version = "9.9.9"

[tool.example]
name = "ignored"
version = "ignored"
`,
      'utf8'
    )

    const report = await runDoctor(projectRoot)
    const output = report.lines.join('\n')

    expect(report.ok).toBe(false)
    expect(output).toContain('pyproject.toml project.name differs')
    expect(output).toContain('pyproject.toml project.version differs')
    expect(output).toContain('create-maa-project --sync metadata')
  })

  it('doctor reports path and resource config drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-path-test' }))
    const projectRoot = join(root, 'maa-path-test')
    const interfacePath = join(projectRoot, 'interface.json')
    const interfaceJson = (await readJson(interfacePath)) as Record<string, unknown>
    interfaceJson.import = [
      './tasks/missing.json'
    ]
    await writeFile(interfacePath, JSON.stringify(interfaceJson, null, 4), 'utf8')
    await writeFile(
      join(projectRoot, 'tasks/tutorial.json'),
      JSON.stringify({ path: 'resource\\base' }, null, 4),
      'utf8'
    )
    await writeFile(
      join(projectRoot, 'maatools.config.mts'),
      'export default { resource: ["./resource/other"] }\n',
      'utf8'
    )

    const report = await runDoctor(projectRoot)
    const output = report.lines.join('\n')

    expect(report.ok).toBe(false)
    expect(output).toContain('interface.json import path is missing')
    expect(output).toContain('MaaFW JSON paths must use forward slashes')
    expect(output).toContain('maatools.config.mts resource order differs')
  })

  it('generated project lint script checks project state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-lint-test' }))
    const projectRoot = join(root, 'maa-lint-test')

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/check-project.mjs'
        ],
        { cwd: projectRoot }
      )
    ).rejects.toThrow('project has pending actions')

    await clearPending(projectRoot, { writePnpmLock: false })

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/check-project.mjs'
        ],
        { cwd: projectRoot }
      )
    ).rejects.toThrow('pnpm-lock.yaml is missing; run pnpm install')

    await clearPending(projectRoot)

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/check-project.mjs'
        ],
        { cwd: projectRoot }
      )
    ).resolves.toBeDefined()

    const packagePath = join(projectRoot, 'package.json')
    const packageJson = (await readJson(packagePath)) as Record<string, unknown>
    packageJson.name = 'wrong-package'
    await writeFile(packagePath, JSON.stringify(packageJson, null, 4) + '\n', 'utf8')

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/check-project.mjs'
        ],
        { cwd: projectRoot }
      )
    ).rejects.toThrow('package.json name must match')
  })

  it('generated project lint script checks package tooling metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-package-tooling-lint' }))
    const projectRoot = join(root, 'maa-package-tooling-lint')
    const packagePath = join(projectRoot, 'package.json')
    const originalPackageJson = (await readJson(packagePath)) as {
      packageManager?: unknown
      engines?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
      scripts?: Record<string, unknown>
    }
    await clearPending(projectRoot)

    async function expectPackageToolingError(
      patch: (packageJson: typeof originalPackageJson) => void,
      message: string
    ): Promise<void> {
      const packageJson = JSON.parse(
        JSON.stringify(originalPackageJson)
      ) as typeof originalPackageJson
      patch(packageJson)
      await writeFile(packagePath, JSON.stringify(packageJson, null, 4) + '\n', 'utf8')
      await expect(
        execFileAsync(
          process.execPath,
          [
            'tools/check-project.mjs'
          ],
          { cwd: projectRoot }
        )
      ).rejects.toThrow(message)
    }

    await expectPackageToolingError((packageJson) => {
      packageJson.packageManager = 'pnpm@10.0.0'
    }, 'package.json packageManager must be pnpm@11.5.1')
    await expectPackageToolingError((packageJson) => {
      packageJson.engines = { ...(packageJson.engines ?? {}), node: '>=22' }
    }, 'package.json engines.node must be >=24')
    await expectPackageToolingError((packageJson) => {
      packageJson.devDependencies = {
        ...(packageJson.devDependencies ?? {}),
        '@nekosu/maa-tools': '^0.4.0'
      }
    }, 'package.json @nekosu/maa-tools must be pinned to 1.0.24')
    await expectPackageToolingError((packageJson) => {
      packageJson.devDependencies = {
        ...(packageJson.devDependencies ?? {}),
        prettier: '^3.8.4'
      }
    }, 'package.json devDependencies.prettier must be pinned to 3.8.4')
    await expectPackageToolingError((packageJson) => {
      packageJson.scripts = {
        ...(packageJson.scripts ?? {}),
        'format:check': 'prettier . --check'
      }
    }, 'package.json scripts.format:check must be prettier --check .')
    await expectPackageToolingError((packageJson) => {
      packageJson.scripts = { ...(packageJson.scripts ?? {}), 'check:maa': 'maa-tools check' }
    }, 'package.json scripts.check:maa must use local pnpm exec maa-tools check')
  })

  it('generated project lint script checks agent package tooling metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-agent-package-tooling-lint' }))
    const projectRoot = join(root, 'maa-agent-package-tooling-lint')
    process.chdir(projectRoot)
    await addAgent(
      defaultOptions({ add: [
          'agent'
        ] })
    )
    await clearPending(projectRoot)
    const packagePath = join(projectRoot, 'package.json')
    const packageJson = (await readJson(packagePath)) as {
      scripts?: Record<string, unknown>
    }
    packageJson.scripts = { ...(packageJson.scripts ?? {}), 'check:py': 'uv run pyright' }
    await writeFile(packagePath, JSON.stringify(packageJson, null, 4) + '\n', 'utf8')

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/check-project.mjs'
        ],
        { cwd: projectRoot }
      )
    ).rejects.toThrow('package.json scripts.check:py must be pnpm lint:py && pnpm typecheck:py')
  })

  it('generated project lint script checks Node tooling files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-node-tooling-lint' }))
    const projectRoot = join(root, 'maa-node-tooling-lint')
    await clearPending(projectRoot)

    await writeFile(join(projectRoot, '.node-version'), '22\n', 'utf8')
    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/check-project.mjs'
        ],
        { cwd: projectRoot }
      )
    ).rejects.toThrow('.node-version must pin Node 24')

    await writeFile(join(projectRoot, '.node-version'), '24\n', 'utf8')
    await writeFile(
      join(projectRoot, '.github/workflows/release.yml'),
      `name: Release
jobs:
  release:
    steps:
      - uses: actions/setup-node@v6
        with:
          node-version: 22
`,
      'utf8'
    )
    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/check-project.mjs'
        ],
        { cwd: projectRoot }
      )
    ).rejects.toThrow('.github/workflows/release.yml must use Node 24')
  })

  it('generated project lint script checks VS Code settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-vscode-lint' }))
    const projectRoot = join(root, 'maa-vscode-lint')
    await clearPending(projectRoot)
    const settingsPath = join(projectRoot, '.vscode/settings.json')
    const settings = (await readJson(settingsPath)) as Record<string, unknown>
    settings['[jsonc]'] = {}
    await writeFile(settingsPath, JSON.stringify(settings, null, 4) + '\n', 'utf8')

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/check-project.mjs'
        ],
        { cwd: projectRoot }
      )
    ).rejects.toThrow(
      '.vscode/settings.json [jsonc] editor.defaultFormatter must be esbenp.prettier-vscode'
    )

    settings['[jsonc]'] = { 'editor.defaultFormatter': 'esbenp.prettier-vscode' }
    settings['json.schemas'] = []
    await writeFile(settingsPath, JSON.stringify(settings, null, 4) + '\n', 'utf8')

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/check-project.mjs'
        ],
        { cwd: projectRoot }
      )
    ).rejects.toThrow(
      '.vscode/settings.json json.schemas must map /interface.json to ./tools/schema/interface.schema.json'
    )
  })

  it('generated project lint script checks maa tools resource order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-maatools-lint' }))
    const projectRoot = join(root, 'maa-maatools-lint')
    await clearPending(projectRoot)
    await writeFile(
      join(projectRoot, 'maatools.config.mts'),
      'export default { resource: ["./resource/other"] }\n',
      'utf8'
    )

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/check-project.mjs'
        ],
        { cwd: projectRoot }
      )
    ).rejects.toThrow('maatools.config.mts resource order differs')
  })

  it('generated project lint script checks interface version and agent metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-interface-agent-lint' }))
    const projectRoot = join(root, 'maa-interface-agent-lint')
    process.chdir(projectRoot)
    await addAgent(
      defaultOptions({ add: [
          'agent'
        ] })
    )
    await clearPending(projectRoot)

    const interfacePath = join(projectRoot, 'interface.json')
    const interfaceJson = (await readJson(interfacePath)) as Record<string, unknown>
    interfaceJson.version = 'v9.9.9'
    await writeFile(interfacePath, JSON.stringify(interfaceJson, null, 4) + '\n', 'utf8')

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/check-project.mjs'
        ],
        { cwd: projectRoot }
      )
    ).rejects.toThrow('interface.json version must match')

    interfaceJson.version = 'v0.1.0'
    interfaceJson.agent = [
      {
        child_exec: [],
        identifier: 'wrong.agent'
      }
    ]
    await writeFile(interfacePath, JSON.stringify(interfaceJson, null, 4) + '\n', 'utf8')

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/check-project.mjs'
        ],
        { cwd: projectRoot }
      )
    ).rejects.toThrow('interface.json agent must match')
  })

  it('generated project lint script checks pyproject metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-pyproject-lint' }))
    const projectRoot = join(root, 'maa-pyproject-lint')
    process.chdir(projectRoot)
    await addAgent(
      defaultOptions({ add: [
          'agent'
        ] })
    )
    await clearPending(projectRoot)

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/check-project.mjs'
        ],
        { cwd: projectRoot }
      )
    ).resolves.toBeDefined()

    await writeFile(
      join(projectRoot, 'pyproject.toml'),
      `[project]
name = "wrong-agent"
version = "0.1.0"
`,
      'utf8'
    )

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/check-project.mjs'
        ],
        { cwd: projectRoot }
      )
    ).rejects.toThrow('pyproject.toml project.name must match')
  })

  it('generated schema validation script checks local project JSON shape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-schema-test' }))
    const projectRoot = join(root, 'maa-schema-test')

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/validate-schema.mjs'
        ],
        { cwd: projectRoot }
      )
    ).resolves.toBeDefined()

    const interfacePath = join(projectRoot, 'interface.json')
    const interfaceJson = (await readJson(interfacePath)) as Record<string, unknown>
    interfaceJson.interface_version = 1
    await writeFile(interfacePath, JSON.stringify(interfaceJson, null, 4) + '\n', 'utf8')

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/validate-schema.mjs'
        ],
        { cwd: projectRoot }
      )
    ).rejects.toThrow('interface.json interface_version must be 2')

    interfaceJson.interface_version = 2
    interfaceJson.resource = [
      { name: 'base', path: './resource/base' }
    ]
    await writeFile(interfacePath, JSON.stringify(interfaceJson, null, 4) + '\n', 'utf8')

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/validate-schema.mjs'
        ],
        { cwd: projectRoot }
      )
    ).rejects.toThrow('interface.json resource[0].path must be an array of strings')
  })

  it('checks generated interface schema baseline files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-schema-reference-test' }))
    const projectRoot = join(root, 'maa-schema-reference-test')
    await clearPending(projectRoot)
    await rm(join(projectRoot, 'tools/schema/interface.schema.json'))

    const report = await runDoctor(projectRoot)
    expect(report.ok).toBe(false)
    expect(report.lines.join('\n')).toContain(
      'Managed file is missing: tools/schema/interface.schema.json'
    )

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/check-project.mjs'
        ],
        { cwd: projectRoot }
      )
    ).rejects.toThrow('managed file is missing: tools/schema/interface.schema.json')

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/validate-schema.mjs'
        ],
        { cwd: projectRoot }
      )
    ).rejects.toThrow('tools/schema/interface.schema.json is missing')
  })

  it('generated schema validation script accepts agent project shape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-agent-schema-test', template: 'agent' }))
    const projectRoot = join(root, 'maa-agent-schema-test')

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/validate-schema.mjs'
        ],
        { cwd: projectRoot }
      )
    ).resolves.toBeDefined()
  })

  it('generated release dry-run smoke checks package references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-release-test' }))
    const projectRoot = join(root, 'maa-release-test')

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/build-release.mjs',
          '--dry-run'
        ],
        {
          cwd: projectRoot
        }
      )
    ).rejects.toThrow('release cannot run while project has pending actions')

    await clearPending(projectRoot)

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/build-release.mjs',
          '--dry-run'
        ],
        {
          cwd: projectRoot
        }
      )
    ).resolves.toBeDefined()
    expectReleaseScriptTargets(await readFile(join(projectRoot, 'tools/build-release.mjs'), 'utf8'))

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/build-release.mjs'
        ],
        {
          cwd: projectRoot,
          env: { ...process.env, GITHUB_REF: '', GITHUB_REF_NAME: '' }
        }
      )
    ).rejects.toThrow('release build requires a SemVer Git tag')

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/build-release.mjs',
          '--dry-run'
        ],
        {
          cwd: projectRoot,
          env: { ...process.env, GITHUB_REF: 'refs/tags/nightly', GITHUB_REF_NAME: '' }
        }
      )
    ).rejects.toThrow('release tag must be a SemVer tag')

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/build-release.mjs'
        ],
        {
          cwd: projectRoot,
          env: { ...process.env, GITHUB_REF_NAME: 'v1.2.3' }
        }
      )
    ).rejects.toThrow('release package path is missing: .create-maa-project')

    const runtimePlatform = currentRuntimePlatformForTest()
    const guiEntrypoint = mfaaEntrypointForTest('maa-release-test', runtimePlatform)
    const guiRoot = join(projectRoot, '.create-maa-project/runtime/mfaa', runtimePlatform)
    await mkdir(join(guiRoot, 'runtimes', runtimePlatform, 'native'), { recursive: true })
    await writeFile(
      join(guiRoot, runtimePlatform.startsWith('win-') ? 'MFAAvalonia.exe' : 'MFAAvalonia'),
      'gui',
      'utf8'
    )
    await writeFile(
      join(guiRoot, 'runtimes', runtimePlatform, 'native', 'libMaaCore.so'),
      'gui-fw',
      'utf8'
    )

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/build-release.mjs'
        ],
        {
          cwd: projectRoot,
          env: { ...process.env, GITHUB_REF_NAME: 'v1.2.3' }
        }
      )
    ).rejects.toThrow('release package path is missing: runtimes')

    await mkdir(join(projectRoot, 'runtimes', runtimePlatform, 'native'), { recursive: true })
    await mkdir(join(projectRoot, 'libs/MaaAgentBinary'), { recursive: true })
    await mkdir(join(projectRoot, 'plugins'), { recursive: true })
    await writeFile(
      join(projectRoot, 'runtimes', runtimePlatform, 'native', 'libMaaCore.so'),
      'maafw-fw',
      'utf8'
    )
    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/build-release.mjs'
        ],
        {
          cwd: projectRoot,
          env: { ...process.env, GITHUB_REF_NAME: 'v1.2.3' }
        }
      )
    ).resolves.toBeDefined()
    const packageInterface = (await readJson(
      join(projectRoot, 'dist/package/interface.json')
    )) as Record<string, unknown>
    const sourceInterface = (await readJson(join(projectRoot, 'interface.json'))) as Record<
      string,
      unknown
    >
    expect(packageInterface.version).toBe('v1.2.3')
    expect(packageInterface.$schema).toBeUndefined()
    expect(sourceInterface.version).toBe('v0.1.0')
    expect(sourceInterface.$schema).toBeUndefined()
    expect((await readdir(join(projectRoot, 'dist/package'))).sort()).toEqual(
      [
        'interface.json',
        'libs',
        guiEntrypoint,
        'plugins',
        'resource',
        'runtimes',
        'tasks'
      ].sort()
    )
    for (const devPath of [
      '.github',
      '.vscode',
      'package.json',
      'pnpm-lock.yaml',
      'maa-project.json',
      'maa-project.lock.json',
      'tools/schema'
    ]) {
      expect(await pathExists(join(projectRoot, 'dist/package', devPath))).toBe(false)
    }
    expect(await readFile(join(projectRoot, 'dist/package/tasks/tutorial.json'), 'utf8')).toContain(
      'Tutorial'
    )
    expect(await readFile(join(projectRoot, 'dist/package', guiEntrypoint), 'utf8')).toBe('gui')
    expect(
      await readFile(
        join(projectRoot, 'dist/package/runtimes', runtimePlatform, 'native/libMaaCore.so'),
        'utf8'
      )
    ).toBe('maafw-fw')
    expect(await readFile(join(projectRoot, 'tools/build-release.mjs'), 'utf8')).toContain(
      'const version = releaseTag ?? sourceVersion'
    )

    const interfacePath = join(projectRoot, 'interface.json')
    const interfaceJson = (await readJson(interfacePath)) as Record<string, unknown>
    interfaceJson.import = [
      './README.md'
    ]
    await writeFile(interfacePath, JSON.stringify(interfaceJson, null, 4) + '\n', 'utf8')

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/build-release.mjs'
        ],
        {
          cwd: projectRoot,
          env: { ...process.env, GITHUB_REF_NAME: 'v1.2.3' }
        }
      )
    ).rejects.toThrow('release package smoke failed: referenced path is missing: ./README.md')

    interfaceJson.import = [
      './tasks/missing.json'
    ]
    await writeFile(interfacePath, JSON.stringify(interfaceJson, null, 4) + '\n', 'utf8')

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/build-release.mjs',
          '--dry-run'
        ],
        { cwd: projectRoot }
      )
    ).rejects.toThrow('release referenced path does not exist')
  })

  it('generated release staging rewrites agent child exec without changing source interface', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-agent-release-test', template: 'agent' }))
    const projectRoot = join(root, 'maa-agent-release-test')
    await clearPending(projectRoot)
    const runtimePlatform = currentRuntimePlatformForTest()
    const guiRoot = join(projectRoot, '.create-maa-project/runtime/mfaa', runtimePlatform)
    await mkdir(guiRoot, { recursive: true })
    await writeFile(
      join(guiRoot, runtimePlatform.startsWith('win-') ? 'MFAAvalonia.exe' : 'MFAAvalonia'),
      'gui',
      'utf8'
    )
    await mkdir(join(projectRoot, 'runtimes'), { recursive: true })
    await mkdir(join(projectRoot, 'libs/MaaAgentBinary'), { recursive: true })
    await mkdir(join(projectRoot, 'plugins'), { recursive: true })
    await mkdir(join(projectRoot, 'python'), { recursive: true })

    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/build-release.mjs'
        ],
        {
          cwd: projectRoot,
          env: { ...process.env, GITHUB_REF_NAME: 'v2.0.0', RUNNER_OS: 'Linux' }
        }
      )
    ).resolves.toBeDefined()

    const packageInterface = (await readJson(join(projectRoot, 'dist/package/interface.json'))) as {
      $schema?: unknown
      version?: unknown
      agent?: Array<{ child_exec?: unknown; child_args?: unknown }>
    }
    const sourceInterface = (await readJson(join(projectRoot, 'interface.json'))) as {
      $schema?: unknown
      version?: unknown
      agent?: Array<{ child_exec?: unknown; child_args?: unknown }>
    }

    expect(packageInterface.$schema).toBeUndefined()
    expect(packageInterface.version).toBe('v2.0.0')
    expect(packageInterface.agent?.[0]?.child_exec).toBe('python3')
    expect(packageInterface.agent?.[0]?.child_args).toEqual([
      'python/agent/bootstrap.py'
    ])
    expect(sourceInterface.$schema).toBeUndefined()
    expect(sourceInterface.version).toBe('v0.1.0')
    expect(sourceInterface.agent?.[0]?.child_args).not.toEqual(
      packageInterface.agent?.[0]?.child_args
    )
    const packagedBootstrap = await readFile(
      join(projectRoot, 'dist/package/python/agent/bootstrap.py'),
      'utf8'
    )
    expect(packagedBootstrap).toContain('Python >=3.11,<3.14 is required')
    expect(packagedBootstrap).toContain('agent-bootstrap.log')
  })

  it('diffs and accepts managed local changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-diff-test' }))
    const projectRoot = join(root, 'maa-diff-test')
    const toolPath = join(projectRoot, 'tools/check-project.mjs')
    await writeFile(
      toolPath,
      `${await readFile(toolPath, 'utf8')}\nconsole.log('local check')\n`,
      'utf8'
    )

    const diff = await diffManagedFiles(projectRoot)
    expect(diff.join('\n')).toContain('--- a/tools/check-project.mjs')
    expect(diff.join('\n')).toContain("+console.log('local check')")

    const accepted = await acceptManagedChanges(projectRoot, [
      'tools/check-project.mjs'
    ])
    const report = await runDoctor(projectRoot)

    expect(accepted).toEqual([
      'tools/check-project.mjs'
    ])
    expect(report.lines.join('\n')).toContain(
      'Managed file has accepted local changes: tools/check-project.mjs'
    )
    expect(await diffManagedFiles(projectRoot)).toEqual([
      'No managed file changes.'
    ])

    const lock = (await readJson(join(projectRoot, 'maa-project.lock.json'))) as {
      managedFiles?: Record<string, { acceptedAt?: string }>
    }
    const generatedLint = await readFile(join(projectRoot, 'tools/check-project.mjs'), 'utf8')
    expect(lock.managedFiles?.['tools/check-project.mjs']?.acceptedAt).toEqual(expect.any(String))
    expect(generatedLint).toContain('Managed file has accepted local changes')
    expect(generatedLint).toContain('Future template updates may conflict with this file.')
  })

  it('does not diff or accept project-owned local files as managed files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-project-owned-files' }))
    const projectRoot = join(root, 'maa-project-owned-files')
    const packagePath = join(projectRoot, 'package.json')
    const interfacePath = join(projectRoot, 'interface.json')
    const packageJson = (await readJson(packagePath)) as Record<string, unknown>
    const interfaceJson = (await readJson(interfacePath)) as Record<string, unknown>
    packageJson.private = false
    interfaceJson.description = 'Local description'
    await writeFile(packagePath, JSON.stringify(packageJson, null, 4) + '\n', 'utf8')
    await writeFile(interfacePath, JSON.stringify(interfaceJson, null, 4) + '\n', 'utf8')

    expect(await diffManagedFiles(projectRoot)).toEqual([
      'No managed file changes.'
    ])
    await expect(
      acceptManagedChanges(projectRoot, [
        'package.json'
      ])
    ).rejects.toThrow('Not a managed file: package.json')
  })

  it('doctor reports missing managed files with a repair command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-missing-managed' }))
    const projectRoot = join(root, 'maa-missing-managed')
    await rm(join(projectRoot, 'tools/check-project.mjs'))

    const report = await runDoctor(projectRoot)
    const output = report.lines.join('\n')

    expect(report.ok).toBe(false)
    expect(output).toContain('Managed file is missing: tools/check-project.mjs')
    expect(output).toContain('restore it from backup or run create-maa-project --update template')
  })

  it('doctor reports missing pnpm lockfile after node deps pending is cleared', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-pnpm-lock-test' }))
    const projectRoot = join(root, 'maa-pnpm-lock-test')
    await clearPending(projectRoot, { writePnpmLock: false })

    const report = await runDoctor(projectRoot)
    const output = report.lines.join('\n')

    expect(report.ok).toBe(false)
    expect(output).toContain('pnpm-lock.yaml is missing')
    expect(output).toContain('To fix: pnpm install')
  })

  it('accepts all changed managed files when no paths are provided', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-accept-all-test' }))
    const projectRoot = join(root, 'maa-accept-all-test')
    const checkPath = join(projectRoot, 'tools/check-project.mjs')
    const validatePath = join(projectRoot, 'tools/validate-schema.mjs')
    await writeFile(
      checkPath,
      `${await readFile(checkPath, 'utf8')}\nconsole.log('check')\n`,
      'utf8'
    )
    await writeFile(
      validatePath,
      `${await readFile(validatePath, 'utf8')}\nconsole.log('schema')\n`,
      'utf8'
    )

    const accepted = await acceptManagedChanges(projectRoot, [])

    expect(accepted).toEqual([
      'tools/check-project.mjs',
      'tools/validate-schema.mjs'
    ])
    expect(await diffManagedFiles(projectRoot)).toEqual([
      'No managed file changes.'
    ])
  })

  it('backs up project state files before overwriting them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-backup-test' }))
    const projectRoot = join(root, 'maa-backup-test')
    process.chdir(projectRoot)

    await syncProject(defaultOptions({ sync: 'version', version: '0.2.0' }))

    expect(
      await findBackedUpFile(
        join(projectRoot, '.create-maa-project/backups'),
        'maa-project.lock.json'
      )
    ).toBe(true)
    expect(
      await findBackedUpFile(join(projectRoot, '.create-maa-project/backups'), 'maa-project.json')
    ).toBe(true)
  })

  it('records remote asset update requests as pending and rejects update all', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-update-test' }))
    process.chdir(join(root, 'maa-update-test'))

    const result = await recordUpdateRequests(
      defaultOptions({ update: [
          'maafw',
          'runtime:mfa'
        ] }),
      {
        productManifestResolver: async () => undefined
      }
    )

    expect(result.pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'runtime',
          command: 'create-maa-project --update runtime:mfa'
        }),
        expect.objectContaining({
          kind: 'maafw',
          command: 'create-maa-project --update maafw'
        })
      ])
    )
    await expect(
      recordUpdateRequests(
        defaultOptions({ update: [
            'all'
          ] })
      )
    ).rejects.toThrow('--update all is not supported')
  })

  it('resolves MaaFramework and MFAAvalonia assets from GitHub release metadata', async () => {
    const mfa = await resolveProductAssetManifestFromGithubRelease(
      { product: 'MFAAvalonia', channel: 'latest', platform: 'win-x64' },
      {
        fetchJson: async (url, options) => {
          expect(url).toBe('https://api.github.com/repos/MaaXYZ/MFAAvalonia/releases/latest')
          expect(options.headers.Accept).toBe('application/vnd.github+json')
          return {
            tag_name: 'v2.12.1',
            assets: [
              {
                name: 'MFAAvalonia-v2.12.1-win-x64.zip',
                browser_download_url:
                  'https://github.com/MaaXYZ/MFAAvalonia/releases/download/v2.12.1/MFAAvalonia-v2.12.1-win-x64.zip',
                digest: `sha256:${'a'.repeat(64)}`,
                size: 94025878
              },
              {
                name: 'MFAAvalonia-v2.12.1-android-arm64.zip',
                browser_download_url: 'https://example.test/android.zip',
                digest: `sha256:${'b'.repeat(64)}`,
                size: 1
              }
            ]
          }
        }
      }
    )

    expect(mfa).toMatchObject({
      product: 'MFAAvalonia',
      tag: 'v2.12.1',
      platform: 'win-x64',
      assets: [
        {
          path: '.create-maa-project/runtime/mfaa/win-x64/MFAAvalonia-v2.12.1-win-x64.zip',
          sha256: 'a'.repeat(64),
          extract: {
            product: 'MFAAvalonia',
            platform: 'win-x64',
            format: 'zip'
          }
        }
      ]
    })

    const maafw = await resolveProductAssetManifestFromGithubRelease(
      { product: 'MaaFramework', channel: 'v5.10.5', platform: 'linux-x64' },
      {
        fetchJson: async (url) => {
          expect(url).toBe('https://api.github.com/repos/MaaXYZ/MaaFramework/releases/tags/v5.10.5')
          return {
            tag_name: 'v5.10.5',
            assets: [
              {
                name: 'MAA-linux-x86_64-v5.10.5.zip',
                browser_download_url:
                  'https://github.com/MaaXYZ/MaaFramework/releases/download/v5.10.5/MAA-linux-x86_64-v5.10.5.zip',
                digest: `sha256:${'c'.repeat(64)}`,
                size: 70450783
              }
            ]
          }
        }
      }
    )

    expect(maafw).toMatchObject({
      product: 'MaaFramework',
      tag: 'v5.10.5',
      platform: 'linux-x64',
      assets: [
        {
          path: 'plugins/linux-x64/MAA-linux-x86_64-v5.10.5.zip',
          sha256: 'c'.repeat(64),
          extract: {
            product: 'MaaFramework',
            platform: 'linux-x64',
            format: 'zip'
          }
        }
      ]
    })
  })

  it('extracts MFAAvalonia archives into the GUI release input layout and preserves executable bits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-runtime-archive-update' }))
    const projectRoot = join(root, 'maa-runtime-archive-update')
    process.chdir(projectRoot)

    const archive = createTarGzArchive([
      {
        path: 'MFAAvalonia-v1/MFAAvalonia',
        content: Buffer.from('runner'),
        mode: 0o755
      },
      {
        path: 'MFAAvalonia-v1/libhostfxr.so',
        content: Buffer.from('library'),
        mode: 0o644
      }
    ])

    const result = await recordUpdateRequests(
      defaultOptions({ update: [
          'runtime:mfa'
        ] }),
      {
        productManifestResolver: async () => ({
          schemaVersion: 1,
          product: 'MFAAvalonia',
          version: 'v1',
          assets: [
            {
              path: '.create-maa-project/runtime/mfaa/linux-x64/MFAAvalonia-v1-linux-x64.tar.gz',
              url: 'https://example.test/MFAAvalonia-v1-linux-x64.tar.gz',
              sha256: sha256(archive),
              size: archive.byteLength,
              extract: {
                product: 'MFAAvalonia',
                platform: 'linux-x64',
                format: 'tar.gz'
              }
            }
          ]
        }),
        assetDownloader: async () => archive
      }
    )

    expect(result.pending.some((item) => item.kind === 'runtime')).toBe(false)
    expect(result.written).toEqual(
      expect.arrayContaining([
        '.create-maa-project/runtime/mfaa/linux-x64/MFAAvalonia',
        '.create-maa-project/runtime/mfaa/linux-x64/libhostfxr.so'
      ])
    )
    expect(
      await readFile(
        join(projectRoot, '.create-maa-project/runtime/mfaa/linux-x64/MFAAvalonia'),
        'utf8'
      )
    ).toBe('runner')
    expect(
      (await stat(join(projectRoot, '.create-maa-project/runtime/mfaa/linux-x64/MFAAvalonia')))
        .mode & 0o111
    ).not.toBe(0)
  })

  it('maps MaaFramework archive contents into agent binary and plugin directories', async () => {
    const archive = createTarGzArchive([
      {
        path: 'MAA/bin/MaaAgentBinary',
        content: Buffer.from('agent'),
        mode: 0o755
      },
      {
        path: 'MAA/bin/libMaaCore.so',
        content: Buffer.from('core'),
        mode: 0o755
      },
      {
        path: 'MAA/share/MaaAgentBinary/MaaAgentServer',
        content: Buffer.from('server'),
        mode: 0o755
      },
      {
        path: 'MAA/bin/plugins/libMaaPlugin.so',
        content: Buffer.from('plugin'),
        mode: 0o644
      }
    ])

    const assets = await downloadProjectManifestAssets(
      {
        schemaVersion: 1,
        product: 'MaaFramework',
        assets: [
          {
            path: 'plugins/linux-x64/MAA-linux-x86_64-v5.10.5.tar.gz',
            url: 'https://example.test/maa.tar.gz',
            sha256: sha256(archive),
            size: archive.byteLength,
            extract: {
              product: 'MaaFramework',
              platform: 'linux-x64',
              format: 'tar.gz'
            }
          }
        ]
      },
      {
        downloader: async () => archive,
        allowedPathPrefixes: [
          '.create-maa-project/runtime/',
          'runtimes/',
          'libs/',
          'plugins/'
        ]
      }
    )

    expect(assets.map((asset) => asset.path).sort()).toEqual([
      'libs/MaaAgentBinary/MaaAgentServer',
      'plugins/linux-x64/libMaaPlugin.so',
      'runtimes/linux-x64/native/MaaAgentBinary',
      'runtimes/linux-x64/native/libMaaCore.so'
    ])
  })

  it('downloads MFA runtime assets from a product manifest and clears runtime pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-runtime-update' }))
    const projectRoot = join(root, 'maa-runtime-update')
    process.chdir(projectRoot)

    const assets = new Map([
      [
        'https://example.test/MFAAvalonia.exe',
        Buffer.from('runtime')
      ],
      [
        'https://example.test/MaaAgentBinary',
        Buffer.from('agent')
      ],
      [
        'https://example.test/plugin.dll',
        Buffer.from('plugin')
      ]
    ])
    const progress: string[] = []
    const requests: Array<{ product: string; channel?: string }> = []
    const result = await recordUpdateRequests(
      defaultOptions({ update: [
          'runtime:mfa'
        ] }),
      {
        productManifestResolver: async (request) => {
          requests.push(request)
          return {
            schemaVersion: 1,
            product: 'MFAAvalonia',
            version: 'v1.2.3',
            assets: [
              {
                path: '.create-maa-project/runtime/mfaa/win-x64/MFAAvalonia.exe',
                url: 'https://example.test/MFAAvalonia.exe',
                sha256: sha256(assets.get('https://example.test/MFAAvalonia.exe') as Buffer),
                size: 7
              },
              {
                path: 'libs/MaaAgentBinary/MaaAgentBinary',
                url: 'https://example.test/MaaAgentBinary',
                sha256: sha256(assets.get('https://example.test/MaaAgentBinary') as Buffer),
                size: 5
              },
              {
                path: 'plugins/win-x64/plugin.dll',
                url: 'https://example.test/plugin.dll',
                sha256: sha256(assets.get('https://example.test/plugin.dll') as Buffer),
                size: 6
              }
            ]
          }
        },
        assetDownloader: async (url) => {
          const content = assets.get(url)
          if (!content) throw new Error(`unexpected URL: ${url}`)
          return content
        },
        onProgress: (message) => progress.push(message)
      }
    )

    expect(requests).toEqual([
      { product: 'MFAAvalonia', channel: 'latest' }
    ])
    expect(result.written).toEqual(
      expect.arrayContaining([
        '.create-maa-project/runtime/mfaa/win-x64/MFAAvalonia.exe',
        'libs/MaaAgentBinary/MaaAgentBinary',
        'plugins/win-x64/plugin.dll'
      ])
    )
    expect(result.pending.some((item) => item.kind === 'runtime')).toBe(false)
    expect(
      await readFile(join(projectRoot, '.create-maa-project/runtime/mfaa/win-x64/MFAAvalonia.exe'))
    ).toEqual(assets.get('https://example.test/MFAAvalonia.exe'))
    expect(progress).toEqual([
      'Resolving MFAAvalonia runtime assets...',
      'MFAAvalonia runtime assets downloaded.'
    ])
  })

  it('downloads OCR model assets from a verified manifest and clears OCR pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-ocr-update' }))
    const projectRoot = join(root, 'maa-ocr-update')
    process.chdir(projectRoot)

    const assets = new Map([
      [
        'https://example.test/det.onnx',
        Buffer.from([
          0,
          1,
          2,
          3
        ])
      ],
      [
        'https://example.test/rec.onnx',
        Buffer.from([
          4,
          5,
          6
        ])
      ],
      [
        'https://example.test/keys.txt',
        Buffer.from('hello\nworld\n')
      ],
      [
        'https://example.test/README.md',
        Buffer.from('# OCR\n')
      ]
    ])
    const progress: string[] = []
    const result = await recordUpdateRequests(
      defaultOptions({ update: [
          'ocr-models'
        ] }),
      {
        ocrManifestResolver: async () => ({
          schemaVersion: 1,
          assets: [
            {
              path: 'det.onnx',
              url: 'https://example.test/det.onnx',
              sha256: sha256(assets.get('https://example.test/det.onnx') as Buffer),
              size: 4
            },
            {
              path: 'rec.onnx',
              url: 'https://example.test/rec.onnx',
              sha256: sha256(assets.get('https://example.test/rec.onnx') as Buffer),
              size: 3
            },
            {
              path: 'keys.txt',
              url: 'https://example.test/keys.txt',
              sha256: sha256(assets.get('https://example.test/keys.txt') as Buffer),
              size: 12
            },
            {
              path: 'README.md',
              url: 'https://example.test/README.md',
              sha256: sha256(assets.get('https://example.test/README.md') as Buffer),
              size: 6
            }
          ]
        }),
        assetDownloader: async (url) => {
          const content = assets.get(url)
          if (!content) throw new Error(`unexpected URL: ${url}`)
          return content
        },
        onProgress: (message) => progress.push(message)
      }
    )

    expect(result.written).toEqual(
      expect.arrayContaining([
        'resource/base/model/ocr/det.onnx',
        'resource/base/model/ocr/rec.onnx',
        'resource/base/model/ocr/keys.txt',
        'resource/base/model/ocr/README.md',
        'resource/base/model/ocr/manifest.json'
      ])
    )
    expect(result.pending.some((item) => item.kind === 'ocr-model')).toBe(false)
    expect(await readFile(join(projectRoot, 'resource/base/model/ocr/det.onnx'))).toEqual(
      assets.get('https://example.test/det.onnx')
    )
    expect(
      await readJson(join(projectRoot, 'resource/base/model/ocr/manifest.json'))
    ).toMatchObject({
      assets: expect.arrayContaining([
        expect.objectContaining({
          path: 'det.onnx',
          sha256: sha256(assets.get('https://example.test/det.onnx') as Buffer),
          size: 4
        })
      ])
    })
    expect(await diffManagedFiles(projectRoot)).toEqual([
      'No managed file changes.'
    ])
    expect(progress).toEqual([
      'Downloading OCR models...',
      'OCR models downloaded.'
    ])
  })

  it('updates embedded schema baseline and clears schema pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-schema-update' }))
    const projectRoot = join(root, 'maa-schema-update')
    const lockPath = join(projectRoot, 'maa-project.lock.json')
    const lock = (await readJson(lockPath)) as {
      pending?: Array<{ kind: string; reason: string; command: string }>
    }
    lock.pending = [
      ...(lock.pending ?? []),
      {
        kind: 'schema',
        reason: 'Schema baseline update is pending.',
        command: 'create-maa-project --update schema'
      }
    ]
    await writeFile(lockPath, JSON.stringify(lock, null, 4) + '\n', 'utf8')
    await rm(join(projectRoot, 'tools/schema/interface.schema.json'))
    process.chdir(projectRoot)

    const result = await recordUpdateRequests(
      defaultOptions({ update: [
          'schema'
        ] })
    )

    expect(result.written).toContain('tools/schema/interface.schema.json')
    expect(result.pending.some((item) => item.kind === 'schema')).toBe(false)
    expect(await readJson(join(projectRoot, 'tools/schema/interface.schema.json'))).toMatchObject({
      title: 'MaaFramework Project Interface V2'
    })
  })

  it('previews schema updates without writing files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-schema-preview' }))
    const projectRoot = join(root, 'maa-schema-preview')
    const schemaPath = join(projectRoot, 'tools/schema/interface.schema.json')
    await writeFile(schemaPath, '{"title":"old schema"}\n', 'utf8')
    process.chdir(projectRoot)

    const preview = await previewTemplateUpdate(
      defaultOptions({ update: [
          'schema'
        ], force: true })
    )

    expect(preview.join('\n')).toContain('--- a/tools/schema/interface.schema.json')
    expect(preview.join('\n')).toContain('"old schema"')
    expect(await readFile(schemaPath, 'utf8')).toBe('{"title":"old schema"}\n')
  })

  it('runs dependency updates and clears resolved pending items', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    const commands: Array<{ root: string; command: string; args: string[] }> = []
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-deps-update', template: 'agent' }))
    const projectRoot = join(root, 'maa-deps-update')
    process.chdir(projectRoot)

    const result = await recordUpdateRequests(
      defaultOptions({ update: [
          'node-deps',
          'python-deps'
        ] }),
      {
        commandRunner: async (cwd, command, args) => {
          commands.push({ root: cwd, command, args })
          if (command === 'pnpm') {
            await writeFile(join(cwd, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\n", 'utf8')
          }
          if (command === 'uv' && args[0] === 'lock') {
            await writeFile(join(cwd, 'uv.lock'), '# updated uv lock\n', 'utf8')
          }
          if (command === 'uv' && args[0] === 'export') {
            await writeFile(join(cwd, 'requirements.txt'), 'maa-fw==0.0.0\n', 'utf8')
          }
        }
      }
    )

    expect(commands).toEqual([
      { root: projectRoot, command: 'pnpm', args: [
          'install'
        ] },
      { root: projectRoot, command: 'uv', args: [
          'lock'
        ] },
      {
        root: projectRoot,
        command: 'uv',
        args: [
          'export',
          '--format',
          'requirements-txt',
          '--no-hashes',
          '--output-file',
          'requirements.txt'
        ]
      }
    ])
    expect(result.written).toEqual(
      expect.arrayContaining([
        'pnpm-lock.yaml',
        'uv.lock',
        'requirements.txt',
        'maa-project.json',
        'maa-project.lock.json'
      ])
    )
    expect(result.pending.some((item) => item.kind === 'node-deps')).toBe(false)
    expect(result.pending.some((item) => item.kind === 'python-deps')).toBe(false)
    expect(await diffManagedFiles(projectRoot)).toEqual([
      'No managed file changes.'
    ])
  })

  it('rejects python dependency updates outside Agent projects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-no-python-deps' }))
    process.chdir(join(root, 'maa-no-python-deps'))

    await expect(
      recordUpdateRequests(
        defaultOptions({ update: [
            'python-deps'
          ] }),
        {
          commandRunner: async () => {
            throw new Error('should not run')
          }
        }
      )
    ).rejects.toThrow('--update python-deps requires an Agent project')
  })

  it('previews template updates without writing files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-template-preview' }))
    const projectRoot = join(root, 'maa-template-preview')
    process.chdir(projectRoot)
    const toolPath = join(projectRoot, 'tools/check-project.mjs')
    await writeFile(toolPath, "console.log('old template')\n", 'utf8')
    await acceptManagedChanges(projectRoot, [
      'tools/check-project.mjs'
    ])

    const preview = await previewTemplateUpdate(
      defaultOptions({ update: [
          'template'
        ], force: true })
    )

    expect(preview.join('\n')).toContain('--- a/tools/check-project.mjs')
    expect(preview.join('\n')).toContain("console.log('old template')")
    expect(await readFile(toolPath, 'utf8')).toBe("console.log('old template')\n")
  })

  it('rejects unsupported template diff target combinations before writing', async () => {
    await expect(
      previewTemplateUpdate(
        defaultOptions({ update: [
            'template',
            'schema'
          ] })
      )
    ).rejects.toThrow(
      '--update <target> --diff is only supported for --update template or --update schema'
    )
    await expect(
      previewTemplateUpdate(
        defaultOptions({ update: [
            'maafw'
          ] })
      )
    ).rejects.toThrow(
      '--update <target> --diff is only supported for --update template or --update schema'
    )
  })

  it('skips local template changes unless force is used', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-template-update' }))
    const projectRoot = join(root, 'maa-template-update')
    process.chdir(projectRoot)
    const toolPath = join(projectRoot, 'tools/check-project.mjs')
    await writeFile(toolPath, "console.log('local change')\n", 'utf8')

    const skipped = await recordUpdateRequests(
      defaultOptions({ update: [
          'template'
        ] })
    )

    expect(skipped.written).not.toContain('tools/check-project.mjs')
    expect(skipped.skipped.join('\n')).toContain('tools/check-project.mjs: local changes')
    expect(await readFile(toolPath, 'utf8')).toBe("console.log('local change')\n")

    const forced = await recordUpdateRequests(
      defaultOptions({ update: [
          'template'
        ], force: true })
    )

    expect(forced.written).toContain('tools/check-project.mjs')
    expect(await readFile(toolPath, 'utf8')).toContain('project structure looks valid')
    expect(await diffManagedFiles(projectRoot)).toEqual([
      'No managed file changes.'
    ])
  })

  it('protects non-empty target directories without force', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    const target = join(root, 'existing')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'note.txt'), 'important', 'utf8')
    process.chdir(root)

    await expect(createProject(defaultOptions({ name: 'existing' }))).rejects.toThrow(
      'Target directory is not empty'
    )
  })

  it('requires explicit non-git allowance for forced non-empty directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    const target = join(root, 'existing-non-git')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'note.txt'), 'important', 'utf8')
    process.chdir(root)

    await expect(
      assertCanCreateTarget(target, defaultOptions({ force: true }), async () => false)
    ).rejects.toThrow('without Git protection')
    await expect(
      assertCanCreateTarget(target, defaultOptions({ force: true }), async () => true)
    ).resolves.toBeUndefined()
    await expect(
      assertCanCreateTarget(
        target,
        defaultOptions({ force: true, allowNonGitDir: true }),
        async () => false
      )
    ).resolves.toBeUndefined()

    const result = await createProject(
      defaultOptions({ name: 'existing-non-git', force: true, allowNonGitDir: true })
    )

    expect(result.written).toContain('interface.json')
    expect(await readFile(join(target, 'note.txt'), 'utf8')).toBe('important')
    expect(await findBackedUpFile(join(target, '.create-maa-project/backups'), 'note.txt')).toBe(
      true
    )
  })

  it('preserves one-time files in existing git directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    const target = join(root, 'existing-git')
    await mkdir(join(target, '.git'), { recursive: true })
    await writeFile(join(target, 'README.md'), '# User README\n', 'utf8')
    await writeFile(join(target, 'LICENSE'), 'User license\n', 'utf8')
    await writeFile(join(target, '.gitignore'), 'custom-cache/\n', 'utf8')
    process.chdir(root)

    const result = await createProject(defaultOptions({ name: 'existing-git', force: true }))

    const gitignore = await readFile(join(target, '.gitignore'), 'utf8')
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        'README.md',
        'LICENSE'
      ])
    )
    expect(await readFile(join(target, 'README.md'), 'utf8')).toBe('# User README\n')
    expect(await readFile(join(target, 'LICENSE'), 'utf8')).toBe('User license\n')
    expect(gitignore).toBe('custom-cache/\n')
    expect(await diffManagedFiles(target)).toEqual([
      'No managed file changes.'
    ])

    await writeFile(join(target, '.gitignore'), `${gitignore}local-only/\n`, 'utf8')
    await clearPending(target)

    expect(await diffManagedFiles(target)).toEqual([
      'No managed file changes.'
    ])
    await expect(
      execFileAsync(
        process.execPath,
        [
          'tools/check-project.mjs'
        ],
        { cwd: target }
      )
    ).resolves.toBeDefined()
  })

  it('initializes git without committing while generated project has pending actions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    const commands: Array<{ root: string; args: string[] }> = []
    const gitRunner: GitRunner = async (cwd, args) => {
      commands.push({ root: cwd, args })
    }
    process.chdir(root)

    const result = await createProject(
      defaultOptions({ name: 'maa-git-pending', initializeGit: true }),
      {
        gitRunner,
        detectGitTree: async () => false
      }
    )

    expect(result.git).toEqual({
      initialized: true,
      committed: false,
      reason: 'project has pending actions'
    })
    expect(commands).toEqual([
      { root: join(root, 'maa-git-pending'), args: [
          'init'
        ] }
    ])
  })

  it('allows initial commit with pending actions only when explicitly requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    const commands: string[][] = []
    const gitRunner: GitRunner = async (_cwd, args) => {
      commands.push(args)
    }
    process.chdir(root)

    const result = await createProject(
      defaultOptions({
        name: 'maa-git-commit',
        initializeGit: true,
        allowPendingCommit: true
      }),
      {
        gitRunner,
        detectGitTree: async () => false
      }
    )

    expect(result.git).toEqual({
      initialized: true,
      committed: true
    })
    expect(commands).toEqual([
      [
        'init'
      ],
      [
        'add',
        '.'
      ],
      [
        'commit',
        '-m',
        'chore: scaffold MaaFW project'
      ]
    ])
  })

  it('does not initialize git inside a parent git repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    const commands: string[][] = []
    const gitRunner: GitRunner = async (_cwd, args) => {
      commands.push(args)
    }
    await mkdir(join(root, '.git'), { recursive: true })
    process.chdir(root)

    const result = await createProject(
      defaultOptions({ name: 'maa-git-parent', initializeGit: true }),
      {
        gitRunner,
        detectGitTree: async () => true
      }
    )

    expect(result.git).toEqual({
      initialized: false,
      committed: false,
      reason: 'target is inside an existing Git repository'
    })
    expect(commands).toEqual([])
  })

  it('rejects active and stale write locks with actionable errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-lock-test' }))
    const projectRoot = join(root, 'maa-lock-test')
    process.chdir(projectRoot)

    await writeFile(
      join(projectRoot, '.create-maa-project/run.lock'),
      JSON.stringify({ pid: process.pid, command: 'test', startedAt: new Date().toISOString() }),
      'utf8'
    )
    await expect(
      syncProject(defaultOptions({ sync: 'version', version: '0.2.0' }))
    ).rejects.toThrow('Another create-maa-project command is running')

    await writeFile(
      join(projectRoot, '.create-maa-project/run.lock'),
      JSON.stringify({ pid: 99999999, command: 'test', startedAt: new Date().toISOString() }),
      'utf8'
    )
    await expect(
      syncProject(defaultOptions({ sync: 'version', version: '0.2.0' }))
    ).rejects.toThrow('Stale write lock exists')

    const result = await syncProject(
      defaultOptions({ sync: 'version', version: '0.2.0', clearStaleLock: true })
    )

    expect(result.config.project.version).toBe('0.2.0')
    expect(await pathExists(join(projectRoot, '.create-maa-project/run.lock'))).toBe(false)
  })

  it('cleans cache and restores backups', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-'))
    process.chdir(root)
    await createProject(defaultOptions({ name: 'maa-maintenance' }))
    const projectRoot = join(root, 'maa-maintenance')
    process.chdir(projectRoot)

    await mkdir(join(projectRoot, '.create-maa-project/cache'), { recursive: true })
    await writeFile(join(projectRoot, '.create-maa-project/cache/temp.txt'), 'cache', 'utf8')
    await mkdir(join(projectRoot, '.create-maa-project/backups/backup-1'), { recursive: true })
    await writeFile(
      join(projectRoot, '.create-maa-project/backups/backup-1/README.md'),
      '# Restored\n',
      'utf8'
    )

    expect(await cleanCache(projectRoot)).toBe(join(projectRoot, '.create-maa-project/cache'))
    const restored = await restoreBackup(projectRoot, 'backup-1')

    expect(restored).toEqual([
      'README.md'
    ])
    expect(await readFile(join(projectRoot, 'README.md'), 'utf8')).toBe('# Restored\n')
  })
})

function expectReleaseWorkflowTargets(releaseWorkflow: string): void {
  expect(releaseWorkflow.match(/artifact_os:/g) ?? []).toHaveLength(EXPECTED_RELEASE_TARGETS.length)
  for (const target of EXPECTED_RELEASE_TARGETS) {
    expect(releaseWorkflow).toContain(`          - os: ${target.runner}
            artifact_os: ${target.artifactOs}
            arch: ${target.arch}
            runtime_os: ${target.runtimeOs}
            runtime_arch: ${target.runtimeArch}
            ext: ${target.ext}`)
  }
}

function expectReleaseScriptTargets(releaseScript: string): void {
  for (const target of EXPECTED_RELEASE_TARGETS) {
    expect(releaseScript).toContain(`'${target.artifactOs}'`)
    expect(releaseScript).toContain(`'${target.arch}'`)
    expect(releaseScript).toContain(`'${target.ext}'`)
    expect(releaseScript).toContain('-MFAA.')
  }
}

function currentRuntimePlatformForTest(): string {
  const os =
    process.platform === 'win32'
      ? 'win'
      : process.platform === 'darwin'
        ? 'osx'
        : process.platform === 'linux'
          ? 'linux'
          : undefined
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : undefined
  if (!os || !arch) {
    throw new Error(`unsupported test platform: ${process.platform}-${process.arch}`)
  }
  return `${os}-${arch}`
}

function mfaaEntrypointForTest(slug: string, runtimePlatform: string): string {
  return runtimePlatform.startsWith('win-') ? `${slug}.exe` : slug
}

function defaultOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    template: 'pipeline',
    add: [
      'dev-tools',
      'github'
    ],
    update: [],
    doctor: false,
    diff: false,
    yes: true,
    noInteractive: true,
    force: false,
    clearStaleLock: false,
    allowNonGitDir: false,
    allowPendingCommit: false,
    skipDownload: false,
    verbose: false,
    noColor: false,
    assist: false,
    dryRun: false,
    acceptChanges: [],
    acceptChangesRequested: false,
    cleanCache: false,
    report: false,
    explicitTemplate: false,
    ...overrides
  }
}

function minimalOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return defaultOptions({ add: [], ...overrides })
}

function createTarGzArchive(
  files: Array<{
    path: string
    content: Buffer
    mode: number
  }>
): Buffer {
  const chunks: Buffer[] = []
  for (const file of files) {
    const header = Buffer.alloc(512)
    writeTarString(header, file.path, 0, 100)
    writeTarOctal(header, file.mode, 100, 8)
    writeTarOctal(header, 0, 108, 8)
    writeTarOctal(header, 0, 116, 8)
    writeTarOctal(header, file.content.byteLength, 124, 12)
    writeTarOctal(header, 0, 136, 12)
    header.fill(0x20, 148, 156)
    header[156] = '0'.charCodeAt(0)
    writeTarString(header, 'ustar', 257, 6)
    writeTarString(header, '00', 263, 2)
    let checksum = 0
    for (const byte of header) checksum += byte
    writeTarOctal(header, checksum, 148, 8)
    chunks.push(header, file.content)
    const padding = (512 - (file.content.byteLength % 512)) % 512
    if (padding > 0) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

function writeTarString(buffer: Buffer, value: string, offset: number, length: number): void {
  buffer.write(value, offset, Math.min(Buffer.byteLength(value), length), 'utf8')
}

function writeTarOctal(buffer: Buffer, value: number, offset: number, length: number): void {
  const text = value
    .toString(8)
    .padStart(length - 1, '0')
    .slice(-(length - 1))
  buffer.write(`${text}\0`, offset, length, 'ascii')
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function clearPending(
  root: string,
  options: { writePnpmLock?: boolean } = {}
): Promise<void> {
  const lockPath = join(root, 'maa-project.lock.json')
  const lock = (await readJson(lockPath)) as { pending?: unknown[] }
  lock.pending = []
  await writeFile(lockPath, JSON.stringify(lock, null, 4) + '\n', 'utf8')
  if (options.writePnpmLock ?? true) {
    await writeFile(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\n", 'utf8')
  }
}

async function findBackedUpFile(root: string, target: string): Promise<boolean> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (await findBackedUpFile(path, target)) return true
      continue
    }
    if (path.replaceAll('\\', '/').endsWith(`/${target}`)) return true
  }
  return false
}
