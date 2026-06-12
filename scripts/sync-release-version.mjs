import { readFile, writeFile } from 'node:fs/promises'

const tag = releaseTag()

if (!tag) {
  console.log('No release tag found; keeping checked-in package versions.')
  process.exit(0)
}

const version = tag.slice(1)
assertReleaseVersion(version, tag)

const packageJsonPath = 'package.json'
const pyprojectPath = 'pyproject.toml'
const wrapperInitPath = 'py-wrapper/create_maa_project/__init__.py'

const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
packageJson.version = version
await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 4) + '\n', 'utf8')

await writeFile(
  pyprojectPath,
  withTrailingNewline(
    replaceRequired(
      await readFile(pyprojectPath, 'utf8'),
      /^version\s*=\s*"[^"]+"\s*$/m,
      `version = "${version}"`,
      'pyproject.toml project version'
    )
  ),
  'utf8'
)

await writeFile(
  wrapperInitPath,
  withTrailingNewline(
    replaceRequired(
      await readFile(wrapperInitPath, 'utf8'),
      /^__version__\s*=\s*"[^"]+"\s*$/m,
      `__version__ = "${version}"`,
      'PyPI wrapper version'
    )
  ),
  'utf8'
)

console.log(`Synchronized release version ${version} from ${tag}.`)

function releaseTag() {
  const explicit = process.argv[2] ?? process.env.CREATE_MAA_PROJECT_RELEASE_TAG ?? ''
  const refName = process.env.GITHUB_REF_NAME ?? ''
  const value = explicit || refName
  return value.startsWith('v') ? value : ''
}

function assertReleaseVersion(version, tag) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      version
    )
  ) {
    throw new Error(`Release tag ${tag} must be a v-prefixed SemVer version, such as v0.1.0.`)
  }
}

function replaceRequired(content, pattern, replacement, label) {
  if (!pattern.test(content)) {
    throw new Error(`Unable to find ${label}.`)
  }
  return content.replace(pattern, replacement)
}

function withTrailingNewline(content) {
  return content.endsWith('\n') ? content : `${content}\n`
}
