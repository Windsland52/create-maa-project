import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const script = join(repoRoot, 'templates', 'addons', 'dev-tools', 'tools', 'validate-i18n.mjs')

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** Writes a project fixture; a string value is written verbatim, anything else as JSON. */
async function fixture(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cmp-i18n-'))
  tempRoots.push(root)
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, typeof content === 'string' ? content : `${JSON.stringify(content, null, 4)}\n`, 'utf8')
  }
  return root
}

async function run(root: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script], { cwd: root })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

const pipeline = (focus: unknown) => ({
  Tutorial: {
    action: 'Click',
    focus,
  },
})

describe('validate-i18n.mjs', () => {
  it('passes a single-language project that declares no translations', async () => {
    const root = await fixture({
      // JSONC comments are allowed in the files this script reads.
      'interface.json': `{
        "interface_version": 2,
        "name": "maa-example",
        // No languages block: i18n is opt-in, so UI text in any language is not drift.
        "label": "示例项目"
      }`,
      // Only `focus.*.content` may hold a `$key`; expression-style values elsewhere
      // are pipeline data, not i18n references.
      'resource/base/pipeline/Tutorial/Tutorial.json': {
        Tutorial: {
          action: 'Click',
          attach: { value: '$0' },
          focus: { 'Node.Action.Succeeded': { content: '教程完成', display: ['log'] } },
        },
        // Legacy focus values are arbitrary JSON, not a message-template map.
        TutorialDone: { focus: '旧版自定义 focus' },
      },
    })

    const result = await run(root)

    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('[OK] no translation files are declared and no i18n keys are in use')
  })

  it('passes interface, task, and focus keys that every language file defines', async () => {
    const root = await fixture({
      'interface.json': {
        interface_version: 2,
        name: 'maa-example',
        label: '$Common.Name',
        languages: { zh_cn: 'locales/zh_cn.json', en_us: 'locales/en_us.json' },
        import: ['./tasks/tutorial.json'],
      },
      'locales/zh_cn.json': { 'Common.Name': '示例项目', 'Task.Tutorial': '教程' },
      'locales/en_us.json': { 'Common.Name': 'Maa Example', 'Task.Tutorial': 'Tutorial' },
      'tasks/tutorial.json': { task: [{ name: 'Tutorial', label: '$Task.Tutorial', entry: 'Tutorial' }] },
      'resource/base/pipeline/Tutorial/Tutorial.json': pipeline({
        'Node.Action.Failed': { content: '$Common.Name' },
      }),
    })

    const result = await run(root)

    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('[OK] i18n is consistent (2 keys across 2 languages)')
  })

  it('reports a focus key that no language file defines', async () => {
    const root = await fixture({
      'interface.json': {
        interface_version: 2,
        name: 'maa-example',
        languages: { zh_cn: 'locales/zh_cn.json', en_us: 'locales/en_us.json' },
      },
      'locales/zh_cn.json': {},
      'locales/en_us.json': {},
      'resource/base/pipeline/Combat/Combat.json': pipeline({
        'Node.PipelineNode.Failed': '$Focus.Combat.StageNotFound',
      }),
    })

    const result = await run(root)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      'missing "Focus.Combat.StageNotFound" (referenced by resource/base/pipeline/Combat/Combat.json.Tutorial.focus.Node.PipelineNode.Failed)',
    )
  })

  it('reports a key that only one language file defines', async () => {
    const root = await fixture({
      'interface.json': {
        interface_version: 2,
        name: 'maa-example',
        label: '$Common.Name',
        languages: { zh_cn: 'locales/zh_cn.json', en_us: 'locales/en_us.json' },
      },
      'locales/zh_cn.json': { 'Common.Name': '示例项目', 'Only.Zh': '只有中文' },
      'locales/en_us.json': { 'Common.Name': 'Maa Example' },
    })

    const result = await run(root)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('"Only.Zh" is present in locales/zh_cn.json but missing here')
  })

  it('reports a literal text field once translations exist, whatever its language', async () => {
    const root = await fixture({
      'interface.json': {
        interface_version: 2,
        name: 'maa-example',
        label: 'Maa Example',
        languages: { zh_cn: 'locales/zh_cn.json' },
      },
      'locales/zh_cn.json': {},
    })

    const result = await run(root)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('literal text in a translatable field (use a `$key`): interface.json.label')
  })

  it('reports literal focus content once translations exist', async () => {
    const root = await fixture({
      'interface.json': {
        interface_version: 2,
        name: 'maa-example',
        languages: { zh_cn: 'locales/zh_cn.json' },
      },
      'locales/zh_cn.json': {},
      'resource/base/pipeline/Combat/Combat.json': pipeline({
        'Node.PipelineNode.Failed': 'Stage not found',
      }),
    })

    const result = await run(root)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      'literal text in a translatable field (use a `$key`): resource/base/pipeline/Combat/Combat.json.Tutorial.focus.Node.PipelineNode.Failed.content',
    )
  })

  it('keeps identifiers such as icon, license, and contact literal', async () => {
    const root = await fixture({
      'interface.json': {
        interface_version: 2,
        name: 'maa-example',
        label: '$Common.Name',
        icon: 'resource/base/image/icon.png',
        license: 'AGPL-3.0-or-later',
        contact: 'https://example.invalid',
        languages: { zh_cn: 'locales/zh_cn.json' },
      },
      'locales/zh_cn.json': { 'Common.Name': '示例项目' },
    })

    const result = await run(root)

    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
  })

  it('reports a translation entry that nothing references any more', async () => {
    const root = await fixture({
      'interface.json': {
        interface_version: 2,
        name: 'maa-example',
        label: '$Common.Name',
        languages: { zh_cn: 'locales/zh_cn.json' },
      },
      'locales/zh_cn.json': { 'Common.Name': '示例项目', 'Obsolete.Key': '旧文案' },
    })

    const result = await run(root)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('"Obsolete.Key" is never referenced')
  })

  it('counts a focus key in default_pipeline.json as a reference', async () => {
    // The default pipeline sits beside `pipeline/`, not inside it, so a walk of the
    // pipeline directory would leave this key looking orphaned.
    const root = await fixture({
      'interface.json': {
        interface_version: 2,
        name: 'maa-example',
        languages: { zh_cn: 'locales/zh_cn.json' },
      },
      'locales/zh_cn.json': { 'Focus.Shared.Done': '全部完成' },
      'resource/base/default_pipeline.json': {
        focus: { 'Node.Action.Succeeded': { content: '$Focus.Shared.Done' } },
      },
      'resource/base/pipeline/Demo/Demo.json': { Demo: { action: 'Click' } },
    })

    const result = await run(root)

    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('[OK] i18n is consistent (1 keys across 1 languages)')
  })

  it('reports literal focus content in default_pipeline.json', async () => {
    const root = await fixture({
      'interface.json': {
        interface_version: 2,
        name: 'maa-example',
        label: '$Common.Name',
        languages: { zh_cn: 'locales/zh_cn.json' },
      },
      'locales/zh_cn.json': { 'Common.Name': '示例项目' },
      'resource/base/default_pipeline.json': {
        focus: { 'Node.Action.Succeeded': 'All done' },
      },
    })

    const result = await run(root)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      'literal text in a translatable field (use a `$key`): resource/base/default_pipeline.json.focus.Node.Action.Succeeded.content',
    )
  })

  it('reports a $key reference in a project that declares no languages', async () => {
    const root = await fixture({
      'interface.json': { interface_version: 2, name: 'maa-example', label: '$Common.Name' },
    })

    const result = await run(root)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('interface.json has no `languages` block, but 1 i18n key(s) are in use')
  })
})
