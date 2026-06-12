import { describe, expect, it } from 'vitest'
import { normalizeCliLanguage, resolvePromptLanguage } from '../src/lang.js'

describe('prompt language', () => {
  it('normalizes language aliases', () => {
    expect(normalizeCliLanguage('auto')).toBe('auto')
    expect(normalizeCliLanguage('english')).toBe('en')
    expect(normalizeCliLanguage('zh_CN')).toBe('zh-CN')
    expect(normalizeCliLanguage('fr')).toBeUndefined()
  })

  it('uses explicit language before environment detection', () => {
    expect(resolvePromptLanguage('en', { LANG: 'zh_CN.UTF-8' }, true, 'zh-CN')).toBe('en')
    expect(resolvePromptLanguage('zh-CN', {}, false, 'en-US')).toBe('zh-CN')
  })

  it('uses CREATE_MAA_PROJECT_LANG for auto mode', () => {
    expect(resolvePromptLanguage('auto', { CREATE_MAA_PROJECT_LANG: 'zh' }, false, 'en-US')).toBe(
      'zh-CN'
    )
    expect(resolvePromptLanguage(undefined, { CREATE_MAA_PROJECT_LANG: 'en' }, true, 'zh-CN')).toBe(
      'en'
    )
  })

  it('keeps auto mode in English for non-interactive output', () => {
    expect(resolvePromptLanguage('auto', { LANG: 'zh_CN.UTF-8' }, false, 'zh-CN')).toBe('en')
  })

  it('detects Chinese locales in interactive auto mode', () => {
    expect(resolvePromptLanguage('auto', { LANG: 'zh_CN.UTF-8' }, true, 'en-US')).toBe('zh-CN')
    expect(resolvePromptLanguage('auto', { LANGUAGE: 'zh_CN:en_US' }, true, 'en-US')).toBe('zh-CN')
    expect(resolvePromptLanguage('auto', {}, true, 'zh-CN')).toBe('zh-CN')
  })
})
