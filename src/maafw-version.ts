/**
 * The same MaaFramework release is spelled two ways across the toolchain.
 *
 * PyPI and `uv export` carry the PEP 440-normalized form (`5.15.0b1`), while GitHub tags — and the
 * Android kernel tags that copy them — keep the released form (`v5.15.0-beta.1`,
 * `3.13.15-maafw5.15.0-beta.1`). `requirements.txt`, `pyproject.toml` and `maa-project.json` can each
 * hold either one, so anything comparing them has to compare these keys instead of the raw strings.
 */
export function normalizeMaafwVersion(version: string): string {
  const value = version.trim().replace(/^[vV]/u, '')
  const match = /^(\d+(?:\.\d+)*)(.*)$/u.exec(value)
  if (match === null) return value.toLowerCase()
  return `${match[1] ?? ''}${prereleaseKey(match[2] ?? '')}`
}

/** `-beta.1` / `beta.1` / `b1` -> `b1`, `rc.2` / `c2` -> `rc2`, release -> empty. */
function prereleaseKey(text: string): string {
  const suffix = text.toLowerCase().replace(/^[-_.]+/u, '')
  if (suffix === '') return ''
  const match = /^(alpha|beta|preview|pre|rc|a|b|c)[-_.]?(\d*)(.*)$/u.exec(suffix)
  if (match === null) return suffix
  const word = match[1] ?? ''
  const short = word === 'a' || word === 'alpha' ? 'a' : word === 'b' || word === 'beta' ? 'b' : 'rc'
  return `${short}${match[2] ?? ''}${match[3] ?? ''}`
}
