export const UPDATE_TARGETS = [
  'schema',
  'maafw',
  'runtime:mfa',
  'runtime:mxu',
  'ocr-models',
  'node-deps',
  'python-deps',
  'python-runtime',
] as const

export type UpdateTarget = (typeof UPDATE_TARGETS)[number]

export function isUpdateTarget(value: string): value is UpdateTarget {
  return (UPDATE_TARGETS as readonly string[]).includes(value)
}
