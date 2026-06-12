import type { CliLanguage } from './types.js'

export type PromptLanguage = 'en' | 'zh-CN'

type Environment = Readonly<Record<string, string | undefined>>

export function parseCliLanguage(value: string, option: string): CliLanguage {
  const language = normalizeCliLanguage(value)
  if (!language) throw new Error(`${option} must be one of: auto, en, zh-CN`)
  return language
}

export function normalizeCliLanguage(value: string | undefined): CliLanguage | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === 'auto') return 'auto'
  if (normalized === 'en' || normalized === 'en-us' || normalized === 'english') return 'en'
  if (
    normalized === 'zh' ||
    normalized === 'zh-cn' ||
    normalized === 'zh_cn' ||
    normalized === 'cn' ||
    normalized === 'chinese'
  ) {
    return 'zh-CN'
  }
  return undefined
}

export function resolvePromptLanguage(
  requested: CliLanguage | undefined,
  environment: Environment = process.env,
  isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  systemLocale = defaultSystemLocale()
): PromptLanguage {
  if (requested === 'en' || requested === 'zh-CN') return requested

  const environmentLanguage = normalizeCliLanguage(environment.CREATE_MAA_PROJECT_LANG)
  if (environmentLanguage === 'en' || environmentLanguage === 'zh-CN') return environmentLanguage

  if (!isInteractive) return 'en'

  if (
    localeLooksChinese(environment.LC_ALL) ||
    localeLooksChinese(environment.LC_MESSAGES) ||
    localeLooksChinese(environment.LANG) ||
    localeLooksChinese(environment.LANGUAGE) ||
    localeLooksChinese(systemLocale)
  ) {
    return 'zh-CN'
  }

  return 'en'
}

function defaultSystemLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return undefined
  }
}

function localeLooksChinese(value: string | undefined): boolean {
  if (!value) return false
  return value
    .split(/[;:,\s]+/)
    .filter(Boolean)
    .some((part) => /^zh(?:[-_]|$)/i.test(part) || /^chinese$/i.test(part))
}
