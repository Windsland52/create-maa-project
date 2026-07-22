import { describe, expect, it } from 'vitest'
import { prepareManagedFileContent } from '../src/project.js'

describe('prepareManagedFileContent', () => {
  it('uses explicitly generated content', () => {
    expect(prepareManagedFileContent('tools/schema/test.json', 'old', 'new')).toBe('new')
  })
})
