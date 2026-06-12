import { describe, expect, it } from 'vitest'
import { managedFileHash } from '../src/project.js'

describe('managedFileHash', () => {
  it('normalizes text file line endings', () => {
    expect(managedFileHash('requirements.txt', 'alpha\nbeta\n')).toBe(
      managedFileHash('requirements.txt', 'alpha\r\nbeta\r\n')
    )
    expect(managedFileHash('requirements.txt', 'alpha\nbeta\n')).toBe(
      managedFileHash('requirements.txt', 'alpha\rbeta\r')
    )
  })

  it('keeps binary file hashes byte-exact', () => {
    expect(
      managedFileHash(
        'resource/base/model/ocr/det.onnx',
        Buffer.from([
          13,
          10
        ])
      )
    ).not.toBe(
      managedFileHash(
        'resource/base/model/ocr/det.onnx',
        Buffer.from([
          10
        ])
      )
    )
  })

  it('hashes only the managed gitignore block', () => {
    const block = '# BEGIN create-maa-project\nnode_modules/\n# END create-maa-project\n'
    expect(managedFileHash('.gitignore', `${block}local-cache/\n`)).toBe(
      managedFileHash('.gitignore', `${block}other-cache/\n`)
    )
    expect(managedFileHash('.gitignore', block)).toBe(
      managedFileHash('.gitignore', block.replace(/\n/g, '\r\n'))
    )
  })
})
