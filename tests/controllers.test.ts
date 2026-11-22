import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CONTROLLER_KINDS, normalizeControllerKind } from '../src/controllers.js'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const schemaPath = join(repoRoot, 'templates/base/tools/schema/interface.schema.json')

async function schemaControllerTypes(): Promise<string[]> {
  const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as {
    definitions?: { controllerItem?: { properties?: { type?: { enum?: unknown } } } }
  }
  const types = schema.definitions?.controllerItem?.properties?.type?.enum
  if (!Array.isArray(types)) throw new Error('interface.schema.json has no controllerItem.properties.type.enum')
  return types.filter((type): type is string => typeof type === 'string')
}

describe('MaaFW controller types', () => {
  it('mirrors the controller enum from the synced interface schema', async () => {
    // The schema sync bot updates templates/base/tools/schema from upstream. A new MaaFW controller
    // type must reach CONTROLLER_KINDS too, otherwise --controller, the prompt, MCP and doctor all
    // keep treating it as unknown.
    const types = await schemaControllerTypes()
    expect(CONTROLLER_KINDS).toEqual(types)
    for (const type of types) {
      expect(normalizeControllerKind(type), type).toBe(type)
    }
  })

  it('accepts the IOS aliases used by hand-written configs', () => {
    expect(normalizeControllerKind('IOS')).toBe('IOS')
    expect(normalizeControllerKind('ios')).toBe('IOS')
  })
})
