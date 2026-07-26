import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { runDoctor } from '../src/doctor.js'
import { readProjectConfig } from '../src/project.js'
import { syncProject } from '../src/sync.js'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('project config validation', () => {
  it('accepts a valid config and preserves addon extension data', async () => {
    const root = await projectRoot(validConfig())

    await expect(readProjectConfig(root)).resolves.toMatchObject({
      schemaVersion: 2,
      addons: {
        extension: {
          custom: [
            'value',
          ],
        },
      },
    })
  })

  it('validates required structure and semantic values with JSON paths', async () => {
    const cases: Array<{
      expected: string
      mutate: (config: Record<string, any>) => void
    }> = [
      {
        expected: 'runtime must be an object',
        mutate: (config) => delete config.runtime,
      },
      {
        expected: 'features.ci.enabled must be a boolean',
        mutate: (config) => (config.features.ci.enabled = 'true'),
      },
      {
        expected: 'project.slug must use lowercase ASCII letters, numbers, and hyphens',
        mutate: (config) => (config.project.slug = 'Invalid Slug'),
      },
      {
        expected: 'project.version must be a valid SemVer version',
        mutate: (config) => (config.project.version = '1.0'),
      },
      {
        expected: 'controller.kinds[0] must be one of: Adb, Win32, MacOS, PlayCover, Gamepad, WlRoots',
        mutate: (config) =>
          (config.controller.kinds = [
            'Win3',
          ]),
      },
      {
        expected: 'controller.kinds[1] duplicates controller "Adb"',
        mutate: (config) =>
          (config.controller.kinds = [
            'Adb',
            'Adb',
          ]),
      },
      {
        expected: 'resources[0].path must be a project-relative path',
        mutate: (config) => (config.resources[0].path = '../outside'),
      },
      {
        expected: 'resources[1].slug duplicates resource slug "base"',
        mutate: (config) =>
          config.resources.push({ slug: 'base', label: 'Duplicate', path: 'resource/duplicate', enabled: true }),
      },
      {
        expected: 'resources[1].path duplicates resource path "RESOURCE/BASE"',
        mutate: (config) =>
          config.resources.push({ slug: 'other', label: 'Duplicate', path: 'RESOURCE/BASE', enabled: true }),
      },
      {
        expected: 'network.mode must be one of: auto, official',
        mutate: (config) => (config.network.mode = 'mirror'),
      },
      {
        expected: 'license.spdx must be one of: AGPL-3.0-or-later, MIT, None',
        mutate: (config) => (config.license.spdx = 'GPL-3.0'),
      },
      {
        expected: 'python.devCommand[1] must not be blank',
        mutate: (config) =>
          (config.python = { requiresPython: '>=3.13,<3.14', recommendedPython: '3.13', devCommand: ['uv', ''] }),
      },
    ]

    for (const testCase of cases) {
      const config = validConfig()
      testCase.mutate(config)
      const root = await projectRoot(config)
      await expect(readProjectConfig(root), testCase.expected).rejects.toThrow(
        `Invalid maa-project.json: ${testCase.expected}`,
      )
    }
  })

  it('rejects unsupported schema versions before accessing nested fields', async () => {
    const root = await projectRoot({ schemaVersion: 3 })

    await expect(readProjectConfig(root)).rejects.toThrow('Unsupported maa-project.json schemaVersion: 3')
  })

  it('validates OCR submodule paths and mappings at the read boundary', async () => {
    const config = validConfig()
    config.ocr = {
      source: 'submodule',
      submodulePath: 'vendor/ocr',
      files: {
        'model.onnx': '../outside.onnx',
      },
    }
    const root = await projectRoot(config)

    await expect(readProjectConfig(root)).rejects.toThrow(
      'Invalid maa-project.json: ocr.files["model.onnx"] must be a project-relative path',
    )
  })

  it('requires and performs an explicit v1 config migration', async () => {
    const config = validConfig()
    config.schemaVersion = 1
    config.maafw = { channel: 'v5.11.0-rc.1' }
    config.runtime.mfa = { channel: 'latest', enabled: true }
    const root = await projectRoot(config)
    const before = await readFile(join(root, 'maa-project.json'), 'utf8')

    await expect(readProjectConfig(root)).rejects.toThrow(
      'maa-project.json schemaVersion 1 requires an explicit migration. Run create-maa-project --sync config.',
    )
    await expect(syncProject(parseArgs(['--sync', 'metadata']), { root })).rejects.toThrow(
      'Run create-maa-project --sync config.',
    )
    await expect(readFile(join(root, 'maa-project.json'), 'utf8')).resolves.toBe(before)

    const result = await syncProject(parseArgs(['--sync', 'config']), { root })

    expect(result).toMatchObject({
      root,
      written: [
        'maa-project.json',
      ],
      skipped: [],
      config: {
        schemaVersion: 2,
        maafw: { channel: 'beta', version: 'v5.11.0-rc.1' },
        runtime: { mfa: { channel: 'stable', version: '' } },
      },
    })
    expect(result.backupId).toBeTruthy()
    await expect(readProjectConfig(root)).resolves.toMatchObject({
      schemaVersion: 2,
      maafw: { channel: 'beta', version: 'v5.11.0-rc.1' },
      runtime: { mfa: { channel: 'stable', version: '' } },
    })
  })

  it('reports a current config migration as an unchanged no-op', async () => {
    const root = await projectRoot(validConfig())

    const result = await syncProject(parseArgs(['--sync', 'config']), { root })

    expect(result.written).toEqual([])
    expect(result.skipped).toEqual([
      'maa-project.json (already schemaVersion 2)',
    ])
    expect(result.backupId).toBeUndefined()
  })

  it('prevents maintenance writes when the config is invalid', async () => {
    const config = validConfig()
    config.controller.kinds = [
      'Unknown',
    ]
    const root = await projectRoot(config)
    const paths = [
      'maa-project.json',
      'interface.json',
      'package.json',
    ]
    await writeFile(join(root, 'interface.json'), '{"name":"unchanged"}\n', 'utf8')
    await writeFile(join(root, 'package.json'), '{"name":"unchanged"}\n', 'utf8')
    const before = await Promise.all(paths.map((path) => readFile(join(root, path), 'utf8')))

    await expect(syncProject(parseArgs(['--sync', 'metadata']), { root })).rejects.toThrow(
      'Invalid maa-project.json: controller.kinds[0]',
    )

    await expect(Promise.all(paths.map((path) => readFile(join(root, path), 'utf8')))).resolves.toEqual(before)
  })

  it('surfaces validation failures through doctor diagnostics', async () => {
    const config = validConfig()
    config.resources[0].enabled = 'yes'
    const root = await projectRoot(config)

    const report = await runDoctor(root)

    expect(report.ok).toBe(false)
    expect(report.lines.join('\n')).toContain(
      '[ERR] maa-project.json could not be read: Invalid maa-project.json: resources[0].enabled must be a boolean.',
    )
  })
})

async function projectRoot(config: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cmp-config-'))
  tempRoots.push(root)
  await writeFile(join(root, 'maa-project.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return root
}

function validConfig(): Record<string, any> {
  return {
    schemaVersion: 2,
    project: {
      slug: 'valid-project',
      displayName: 'Valid Project',
      version: '0.1.0',
      initialTemplate: 'pipeline',
      github: 'https://github.com/MaaXYZ/ValidProject',
    },
    features: {
      ci: { enabled: true },
      release: { enabled: true },
      vscode: { enabled: true },
      quality: { enabled: true },
    },
    addons: {
      extension: {
        custom: [
          'value',
        ],
      },
    },
    controller: {
      kinds: [
        'Adb',
      ],
    },
    resources: [
      {
        slug: 'base',
        label: 'Base',
        path: 'resource/base',
        enabled: true,
      },
    ],
    maafw: {
      channel: 'stable',
      version: '',
    },
    runtime: {
      mfa: {
        channel: 'stable',
        version: '',
        enabled: true,
      },
    },
    network: {
      mode: 'auto',
    },
    license: {
      spdx: 'AGPL-3.0-or-later',
    },
  }
}
