import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const inputDir = process.argv[2] ?? 'dist/release-assets'
const outputPath = process.argv[3] ?? 'dist/release/create-maa-project-manifest.json'
const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
const version = String(packageJson.version)
const tag = process.env.GITHUB_REF_NAME?.startsWith('v')
    ? process.env.GITHUB_REF_NAME
    : `v${version}`
const repository = process.env.GITHUB_REPOSITORY ?? 'Windsland52/create-maa-project'
const files = await readdir(inputDir)
const assets = []

if (tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} does not match package version ${version}.`)
}

for (const file of files.sort()) {
    const match = /^create-maa-project-(win|linux|macos)-(x86_64|aarch64)(\.exe)?$/.exec(file)
    if (!match) continue
    const [, os, arch, extension] = match
    if (os === 'win' && extension !== '.exe') {
        throw new Error(`Windows SEA asset must use .exe extension: ${file}`)
    }
    if (os !== 'win' && extension) {
        throw new Error(`Non-Windows SEA asset must not use .exe extension: ${file}`)
    }
    const content = await readFile(join(inputDir, file))
    assets.push({
        kind: 'sea',
        os,
        arch,
        version,
        name: file,
        url: `https://github.com/${repository}/releases/download/${tag}/${file}`,
        sha256: createHash('sha256').update(content).digest('hex'),
        size: content.byteLength
    })
}

const expected = [
    ['win', 'x86_64'],
    ['win', 'aarch64'],
    ['linux', 'x86_64'],
    ['linux', 'aarch64'],
    ['macos', 'x86_64'],
    ['macos', 'aarch64']
]
for (const [os, arch] of expected) {
    if (!assets.some((asset) => asset.os === os && asset.arch === arch)) {
        throw new Error(`Missing SEA asset for ${os}/${arch}.`)
    }
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(
    outputPath,
    JSON.stringify(
        {
            schemaVersion: 1,
            name: basename(packageJson.name),
            version,
            tag,
            assets
        },
        null,
        4
    ) + '\n',
    'utf8'
)
console.log(`Wrote ${outputPath}`)
