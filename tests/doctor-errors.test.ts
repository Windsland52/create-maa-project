import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { runDoctor } from '../src/doctor.js'
import { createProject } from '../src/scaffold.js'

const originalCwd = process.cwd()
const tempRoots: string[] = []

afterEach(async () => {
  process.chdir(originalCwd)
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('doctor malformed JSON diagnostics', () => {
  it('reports an unreadable project config instead of throwing', async () => {
    const projectRoot = await createTempProject('invalid-project-config')
    await writeFile(join(projectRoot, 'maa-project.json'), '{ invalid', 'utf8')

    const report = await runDoctor(projectRoot)

    expect(report.ok).toBe(false)
    expect(report.lines.join('\n')).toContain('[ERR] maa-project.json could not be read:')
    expect(report.checks).toEqual([
      expect.objectContaining({ id: 'project-config', status: 'fail' }),
    ])
  })

  it('reports malformed interface JSON and continues checking other files', async () => {
    const projectRoot = await createTempProject('invalid-interface')
    await writeFile(join(projectRoot, 'interface.json'), '{ invalid', 'utf8')

    const report = await runDoctor(projectRoot)
    const output = report.lines.join('\n')

    expect(report.ok).toBe(false)
    expect(output).toContain('[ERR] interface.json is not valid JSON:')
    expect(output).toContain('[OK] Resource pack paths are present.')
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'interface-json', status: 'fail' }),
        expect.objectContaining({ id: 'interface-metadata', status: 'skipped' }),
        expect.objectContaining({ id: 'interface-paths', status: 'skipped' }),
        expect.objectContaining({ id: 'resource-paths', status: 'pass' }),
      ]),
    )
  })

  it('reports malformed VS Code settings and continues checking other tooling', async () => {
    const projectRoot = await createTempProject('invalid-vscode-settings', [
      'dev-tools',
      'vscode',
    ])
    await writeFile(join(projectRoot, '.vscode/settings.json'), '[]', 'utf8')

    const report = await runDoctor(projectRoot)
    const output = report.lines.join('\n')

    expect(report.ok).toBe(false)
    expect(output).toContain('[ERR] .vscode/settings.json is not valid JSON: the top-level value must be an object')
    expect(output).toContain('[ERR] pnpm-lock.yaml is missing.')
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'vscode-settings', status: 'fail' }),
        expect.objectContaining({ id: 'node-lockfile', status: 'fail' }),
      ]),
    )
  })

  it('reports empty OCR model files with a repair command', async () => {
    const projectRoot = await createTempProject('empty-ocr-models')

    const pendingReport = await runDoctor(projectRoot)
    const pendingOutput = pendingReport.lines.join('\n')

    expect(pendingReport.ok).toBe(false)
    expect(pendingOutput).toContain('[ERR] OCR model file is missing or empty: resource/base/model/ocr/det.onnx')
    expect(pendingOutput).toContain('[ERR] OCR model file is missing or empty: resource/base/model/ocr/rec.onnx')
    expect(pendingOutput).toContain('[ERR] OCR model file is missing or empty: resource/base/model/ocr/keys.txt')
    expect(pendingOutput).toContain('To fix: create-maa-project --update ocr-models')
    expect(pendingReport.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'ocr-models', status: 'fail' }),
      ]),
    )

    await writeFile(join(projectRoot, 'resource/base/model/ocr/det.onnx'), 'detector', 'utf8')
    await writeFile(join(projectRoot, 'resource/base/model/ocr/rec.onnx'), 'recognizer', 'utf8')
    await writeFile(join(projectRoot, 'resource/base/model/ocr/keys.txt'), 'keys\n', 'utf8')

    const provisionedReport = await runDoctor(projectRoot)
    expect(provisionedReport.lines.join('\n')).toContain(
      '[OK] OCR model files are present under resource/base/model/ocr.',
    )
    expect(provisionedReport.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'ocr-models', status: 'pass' }),
      ]),
    )
  })
})

async function createTempProject(name: string, addons: string[] = []): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cmp-doctor-'))
  tempRoots.push(root)
  process.chdir(root)
  const args = [
    name,
    '--no-interactive',
    '--no-git',
    '--skip-download',
    ...addons.flatMap((addon) => [
      '--add',
      addon,
    ]),
  ]
  const result = await createProject(parseArgs(args))
  return result.root
}
