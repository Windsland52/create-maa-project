import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

const manifestPath = process.argv[2] ?? 'dist/release/create-maa-project-manifest.json'
const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
const pyproject = await readFile('pyproject.toml', 'utf8')
const initPy = await readFile('py-wrapper/create_maa_project/__init__.py', 'utf8')
const manifest = await readFile(manifestPath)
const version = String(packageJson.version)
const pyprojectVersion = parseTomlString(pyproject, 'version')
const wrapperVersion = /__version__\s*=\s*"([^"]+)"/.exec(initPy)?.[1]
const tag = process.env.GITHUB_REF_NAME

if (pyprojectVersion !== version) {
    throw new Error(`pyproject.toml version ${pyprojectVersion ?? '<missing>'} does not match package version ${version}.`)
}
if (wrapperVersion !== version) {
    throw new Error(`PyPI wrapper version ${wrapperVersion ?? '<missing>'} does not match package version ${version}.`)
}
if (tag && tag.startsWith('v') && tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} does not match package version ${version}.`)
}

const digest = createHash('sha256').update(manifest).digest('hex')
await writeFile(
    'py-wrapper/create_maa_project/release_manifest.py',
    `# Filled by the release workflow when publishing the PyPI wrapper.\nRELEASE_MANIFEST_SHA256 = "${digest}"\n`,
    'utf8'
)
console.log(`Embedded release manifest digest ${digest}`)

function parseTomlString(content, key) {
    const match = new RegExp(`^${key}\\s*=\\s*"([^"]+)"\\s*$`, 'm').exec(content)
    return match?.[1]
}
