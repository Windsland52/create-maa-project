import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadManifestAssets, type DownloadProgress } from '../src/assets.js'
import { runDoctor } from '../src/doctor.js'
import { diffManagedFiles } from '../src/project.js'
import { createProject, assertCanCreateTarget, type GitRunner } from '../src/scaffold.js'
import { syncProject } from '../src/sync.js'
import { previewTemplateUpdate, recordUpdateRequests } from '../src/update.js'
import type { CliOptions } from '../src/types.js'
import { sha256 } from '../src/utils.js'

const cwdStack: string[] = []
const EXPECTED_RELEASE_TARGETS = [
    ['windows-latest', 'win', 'x86_64', 'win', 'x64', 'zip'],
    ['windows-11-arm', 'win', 'aarch64', 'win', 'arm64', 'zip'],
    ['ubuntu-latest', 'linux', 'x86_64', 'linux', 'x64', 'tar.gz'],
    ['ubuntu-latest', 'linux', 'aarch64', 'linux', 'arm64', 'tar.gz'],
    ['macos-15-intel', 'macos', 'x86_64', 'osx', 'x64', 'tar.gz'],
    ['macos-latest', 'macos', 'aarch64', 'osx', 'arm64', 'tar.gz']
] as const

beforeEach(() => {
    cwdStack.push(process.cwd())
})

afterEach(() => {
    vi.restoreAllMocks()
    const cwd = cwdStack.pop()
    if (cwd) process.chdir(cwd)
})

describe('pure pipeline scaffold', () => {
    it('creates a default MaaFW pipeline project', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cmp-'))
        process.chdir(root)

        const result = await createProject(defaultOptions({ name: 'Maa Test' }))
        const projectRoot = join(root, 'Maa Test')

        expect(result.config.project).toMatchObject({
            slug: 'maa-test',
            initialTemplate: 'pipeline'
        })
        expect(result.config.addons).toEqual({})
        expect(result.written).toEqual(
            expect.arrayContaining([
                'interface.json',
                'tasks/tutorial.json',
                'resource/base/default_pipeline.json',
                'resource/base/pipeline/tutorial.json',
                'resource/base/image/empty.png',
                'resource/base/model/ocr/det.onnx',
                'resource/base/model/ocr/rec.onnx',
                'resource/base/model/ocr/keys.txt',
                'tools/schema/interface.schema.json',
                'tools/sync-runtime.mjs',
                '.github/workflows/check.yml',
                '.github/workflows/release.yml',
                '.github/workflows/schema-sync.yml'
            ])
        )
        expect(result.pending).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'node-deps' }),
                expect.objectContaining({ kind: 'ocr-model' })
            ])
        )
        expect(result.pending.some((item) => item.kind === 'runtime')).toBe(false)

        const interfaceJson = await readJson(join(projectRoot, 'interface.json'))
        expect(interfaceJson).toMatchObject({
            name: 'maa-test',
            label: 'Maa Test',
            controller: [{ name: 'adb', type: 'Adb' }],
            resource: [{ name: 'base', path: ['./resource/base'] }],
            import: ['./tasks/tutorial.json']
        })
        expect(interfaceJson).not.toHaveProperty('agent')

        const packageJson = await readJson(join(projectRoot, 'package.json'))
        expect(packageJson).toMatchObject({
            name: 'maa-test',
            license: 'AGPL-3.0-or-later',
            scripts: {
                'sync:runtime': 'node tools/sync-runtime.mjs',
                'release:dry-run': 'node tools/build-release.mjs --dry-run'
            },
            devDependencies: {
                '@nekosu/maa-tools': '1.0.24'
            }
        })
        expect(packageJson.scripts).not.toHaveProperty('check:py')

        const license = await readFile(join(projectRoot, 'LICENSE'), 'utf8')
        expect(license).toContain('GNU AFFERO GENERAL PUBLIC LICENSE')
        expect(license).toContain('Version 3, 19 November 2007')
        expect(license).not.toContain('Replace this placeholder')

        const emptyImage = await readFile(join(projectRoot, 'resource/base/image/empty.png'))
        expect(emptyImage.subarray(0, 8)).toEqual(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        )

        const releaseWorkflow = await readFile(join(projectRoot, '.github/workflows/release.yml'), 'utf8')
        for (const [runner, artifactOs, arch, runtimeOs, runtimeArch, ext] of EXPECTED_RELEASE_TARGETS) {
            expect(releaseWorkflow).toContain(`os: ${runner}`)
            expect(releaseWorkflow).toContain(`artifact_os: ${artifactOs}`)
            expect(releaseWorkflow).toContain(`arch: ${arch}`)
            expect(releaseWorkflow).toContain(`runtime_os: ${runtimeOs}`)
            expect(releaseWorkflow).toContain(`runtime_arch: ${runtimeArch}`)
            expect(releaseWorkflow).toContain(`ext: ${ext}`)
        }
        expect(releaseWorkflow).toContain(
            'archive="maa-test-${{ matrix.artifact_os }}-${{ matrix.arch }}-${GITHUB_REF_NAME}-MFAA.${{ matrix.ext }}"'
        )
        expect(releaseWorkflow).toContain('7z a "../$archive" .')
        expect(releaseWorkflow).toContain('tar -czf "../$archive" .')
        expect(releaseWorkflow).not.toContain('actions/setup-python')
        expect(releaseWorkflow).not.toContain('pnpm check:py')

        const buildReleaseScript = await readFile(join(projectRoot, 'tools/build-release.mjs'), 'utf8')
        expect(buildReleaseScript).toContain("copyDirectoryContents(mfaaGuiPath(runtimePlatform), 'dist/package')")
        expect(buildReleaseScript).toContain("copyPath(path, join('dist/package', path))")
        expect(buildReleaseScript).not.toContain("copyPath('agent'")

        const lock = (await readJson(join(projectRoot, 'maa-project.lock.json'))) as {
            managedFiles: Record<string, unknown>
            createdFiles: Record<string, unknown>
        }
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

        const doctorOutput = (await runDoctor(projectRoot)).lines.join('\n')
        expect(doctorOutput).toContain('create-maa-project --update node-deps')
        expect(doctorOutput).toContain('create-maa-project --update ocr-models')
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

    it('downloads OCR model assets during creation and clears OCR pending', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cmp-'))
        process.chdir(root)

        const assets = new Map([
            ['https://example.test/det.onnx', Buffer.from([0, 1, 2, 3])],
            ['https://example.test/rec.onnx', Buffer.from([4, 5, 6])],
            ['https://example.test/keys.txt', Buffer.from('hello\nworld\n')],
            ['https://example.test/README.md', Buffer.from('# OCR\n')]
        ])
        const progress: string[] = []
        const downloadProgress: DownloadProgress[] = []

        const result = await createProject(
            defaultOptions({ name: 'maa-create-ocr' }),
            {
                downloadOcrModels: true,
                ocrManifestResolver: async () => ({
                    schemaVersion: 1,
                    assets: [...assets].map(([url, content]) => ({
                        path: url.split('/').at(-1) as string,
                        url,
                        sha256: sha256(content),
                        size: content.byteLength
                    }))
                }),
                assetDownloader: async (url, options) => {
                    const content = assets.get(url)
                    if (!content) throw new Error(`unexpected URL: ${url}`)
                    options?.onProgress?.({
                        url,
                        downloadedBytes: content.byteLength,
                        totalBytes: content.byteLength
                    })
                    return content
                },
                onProgress: (message) => progress.push(message),
                onDownloadProgress: (event) => downloadProgress.push(event)
            }
        )

        const projectRoot = join(root, 'maa-create-ocr')
        expect(result.pending.some((item) => item.kind === 'ocr-model')).toBe(false)
        expect(await readFile(join(projectRoot, 'resource/base/model/ocr/det.onnx'))).toEqual(
            assets.get('https://example.test/det.onnx')
        )
        expect(await readJson(join(projectRoot, 'resource/base/model/ocr/manifest.json'))).toMatchObject({
            assets: expect.arrayContaining([
                expect.objectContaining({
                    path: 'det.onnx',
                    sha256: sha256(assets.get('https://example.test/det.onnx') as Buffer),
                    size: 4
                })
            ])
        })
        expect(progress).toEqual(['Downloading OCR models...', 'OCR models downloaded.'])
        expect(downloadProgress.at(-1)).toMatchObject({
            path: 'README.md',
            downloadedBytes: 25,
            totalBytes: 25
        })
        expect(await diffManagedFiles(projectRoot)).toEqual(['No managed file changes.'])
    })

    it('keeps OCR pending when creation download fails', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cmp-'))
        process.chdir(root)
        const progress: string[] = []

        const result = await createProject(
            defaultOptions({ name: 'maa-create-ocr-fail' }),
            {
                downloadOcrModels: true,
                assetDownloader: async () => {
                    throw new Error('offline OCR mirror')
                },
                onProgress: (message) => progress.push(message)
            }
        )

        expect(progress).toEqual([
            'Downloading OCR models...',
            'OCR model download failed (offline OCR mirror); continuing with a pending action.'
        ])
        expect(result.pending).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'ocr-model',
                    reason: expect.stringContaining('offline OCR mirror')
                })
            ])
        )
    })

    it('installs node dependencies during creation and keeps pending on failure', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cmp-'))
        process.chdir(root)

        const success = await createProject(
            defaultOptions({ name: 'maa-create-install' }),
            {
                installNodeDeps: true,
                commandRunner: async (cwd) => {
                    await writeFile(join(cwd, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\n", 'utf8')
                }
            }
        )
        expect(success.pending.some((item) => item.kind === 'node-deps')).toBe(false)
        expect(success.written).toContain('pnpm-lock.yaml')

        const failed = await createProject(
            defaultOptions({ name: 'maa-create-install-fail' }),
            {
                installNodeDeps: true,
                commandRunner: async () => {
                    throw new Error('offline registry')
                }
            }
        )
        expect(failed.pending).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'node-deps',
                    reason: expect.stringContaining('offline registry')
                })
            ])
        )
    })

    it('updates MaaFW and MFAAvalonia runtime assets from manifests', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cmp-'))
        process.chdir(root)
        await createProject(defaultOptions({ name: 'maa-runtime' }))
        const projectRoot = join(root, 'maa-runtime')
        process.chdir(projectRoot)

        const assets = new Map([
            ['https://example.test/MaaCore', Buffer.from('core')],
            ['https://example.test/MFAAvalonia', Buffer.from('gui')]
        ])
        const result = await recordUpdateRequests(
            defaultOptions({ update: ['maafw', 'runtime:mfa'] }),
            {
                productManifestResolver: async (request) => {
                    if (request.product === 'MaaFramework') {
                        const content = assets.get('https://example.test/MaaCore') as Buffer
                        return {
                            schemaVersion: 1,
                            product: request.product,
                            assets: [
                                {
                                    path: 'runtimes/linux-x64/native/MaaCore',
                                    url: 'https://example.test/MaaCore',
                                    sha256: sha256(content),
                                    size: content.byteLength
                                }
                            ]
                        }
                    }
                    if (request.product === 'MFAAvalonia') {
                        const content = assets.get('https://example.test/MFAAvalonia') as Buffer
                        return {
                            schemaVersion: 1,
                            product: request.product,
                            assets: [
                                {
                                    path: '.create-maa-project/runtime/mfaa/linux-x64/MFAAvalonia',
                                    url: 'https://example.test/MFAAvalonia',
                                    sha256: sha256(content),
                                    size: content.byteLength
                                }
                            ]
                        }
                    }
                    return undefined
                },
                assetDownloader: async (url) => {
                    const content = assets.get(url)
                    if (!content) throw new Error(`unexpected URL: ${url}`)
                    return content
                }
            }
        )

        expect(result.written).toEqual(
            expect.arrayContaining([
                'runtimes/linux-x64/native/MaaCore',
                '.create-maa-project/runtime/mfaa/linux-x64/MFAAvalonia'
            ])
        )
        expect(await readFile(join(projectRoot, 'runtimes/linux-x64/native/MaaCore'), 'utf8')).toBe('core')
        expect(await readFile(join(projectRoot, '.create-maa-project/runtime/mfaa/linux-x64/MFAAvalonia'), 'utf8')).toBe(
            'gui'
        )
    })

    it('syncs project metadata and previews template changes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cmp-'))
        process.chdir(root)
        await createProject(defaultOptions({ name: 'maa-sync' }))
        const projectRoot = join(root, 'maa-sync')
        process.chdir(projectRoot)

        await syncProject(
            defaultOptions({
                sync: 'version',
                version: '0.2.0'
            })
        )
        await syncProject(
            defaultOptions({
                sync: 'github-url',
                syncValue: 'https://github.com/MaaXYZ/MaaXX'
            })
        )

        expect(await readJson(join(projectRoot, 'interface.json'))).toMatchObject({
            version: 'v0.2.0',
            github: 'https://github.com/MaaXYZ/MaaXX'
        })
        expect(await readJson(join(projectRoot, 'package.json'))).toMatchObject({
            version: '0.2.0'
        })
        expect(await previewTemplateUpdate(defaultOptions({ update: ['template'], diff: true }))).toEqual([
            'No template updates.'
        ])
    })

    it('guards non-empty target directories and git initialization', async () => {
        const root = await mkdtemp(join(tmpdir(), 'cmp-'))
        const targetRoot = join(root, 'non-empty')
        await writeFile(targetRoot, '', 'utf8').catch(async () => {
            await writeFile(join(root, 'placeholder'), '', 'utf8')
        })
        await expect(
            assertCanCreateTarget(root, defaultOptions({ force: true }), async () => false)
        ).rejects.toThrow('Refusing to write into a non-empty directory without Git protection')

        const gitRoot = await mkdtemp(join(tmpdir(), 'cmp-'))
        process.chdir(gitRoot)
        const gitCommands: string[][] = []
        const gitRunner: GitRunner = async (_cwd, args) => {
            gitCommands.push(args)
        }
        const result = await createProject(
            defaultOptions({
                name: 'maa-git',
                initializeGit: true,
                allowPendingCommit: true
            }),
            {
                gitRunner,
                detectGitTree: async () => false
            }
        )
        expect(result.git).toEqual({ initialized: true, committed: true })
        expect(gitCommands).toEqual([['init'], ['add', '.'], ['commit', '-m', 'chore: scaffold MaaFW project']])
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
                allowedPaths: ['asset.bin']
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
})

function defaultOptions(overrides: Partial<CliOptions> = {}): CliOptions {
    return {
        template: 'pipeline',
        add: [],
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

async function readJson(path: string): Promise<Record<string, any>> {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, any>
}
