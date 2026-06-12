import {
  DEFAULT_OCR_ZIP_URL,
  downloadDefaultOcrZip,
  resolveOcrManifestFromEnvironment,
  resolveProductAssetManifestFromGithubRelease,
  type ProductAssetManifest
} from '../src/assets.js'

const EXPECTED_RUNTIME_PLATFORMS = [
  'linux-arm64',
  'linux-x64',
  'osx-arm64',
  'osx-x64',
  'win-arm64',
  'win-x64'
] as const

const OCR_REQUIRED_FILES = [
  'README.md',
  'det.onnx',
  'keys.txt',
  'rec.onnx'
] as const

type AssetLike = {
  path: string
  url: string
  sha256: string
  size?: number
}

async function main(): Promise<void> {
  await checkRuntimeRelease('MaaFramework')
  await checkRuntimeRelease('MFAAvalonia')
  await checkOcrAssets()
}

async function checkRuntimeRelease(product: 'MaaFramework' | 'MFAAvalonia'): Promise<void> {
  const manifest = await resolveProductAssetManifestFromGithubRelease({
    product,
    channel: 'latest',
    platform: 'all'
  })
  assertRuntimeManifest(product, manifest)
  const platforms = manifest.assets
    .map((asset) => asset.extract?.platform)
    .filter((platform): platform is string => Boolean(platform))
    .sort()
  console.log(
    `[OK] ${product} ${manifest.tag ?? manifest.version ?? 'latest'}: ${manifest.assets.length} assets (${platforms.join(', ')})`
  )
}

async function checkOcrAssets(): Promise<void> {
  const manifest = await resolveOcrManifestFromEnvironment()
  if (manifest) {
    assertOcrAssets('OCR manifest', manifest.assets)
    console.log(`[OK] OCR manifest: ${manifest.assets.length} assets`)
    return
  }

  const assets = await downloadDefaultOcrZip()
  assertOcrAssets(`default OCR zip ${DEFAULT_OCR_ZIP_URL}`, assets)
  console.log(`[OK] default OCR zip: ${assets.length} assets`)
}

function assertRuntimeManifest(
  product: 'MaaFramework' | 'MFAAvalonia',
  manifest: ProductAssetManifest | undefined
): asserts manifest is ProductAssetManifest {
  if (!manifest) {
    throw new Error(`${product} latest release did not expose compatible runtime assets.`)
  }
  const platforms = new Set<string>()
  for (const asset of manifest.assets) {
    const extraction = asset.extract
    if (!extraction) {
      throw new Error(`${product} asset is missing extraction metadata: ${asset.path}`)
    }
    if (extraction.product !== product) {
      throw new Error(`${product} asset has mismatched extraction product: ${asset.path}`)
    }
    platforms.add(extraction.platform)
    assertHttpsUrl(asset.url, `${product} asset URL ${asset.path}`)
    assertSha256(asset.sha256, `${product} asset sha256 ${asset.path}`)
    assertPositiveSize(asset, `${product} asset size ${asset.path}`)
    const prefix =
      product === 'MFAAvalonia'
        ? `.create-maa-project/runtime/mfaa/${extraction.platform}/`
        : `plugins/${extraction.platform}/`
    if (!asset.path.startsWith(prefix)) {
      throw new Error(`${product} asset path does not match runtime layout: ${asset.path}`)
    }
  }

  const missing = EXPECTED_RUNTIME_PLATFORMS.filter((platform) => !platforms.has(platform))
  if (missing.length > 0) {
    throw new Error(`${product} latest release is missing runtime platforms: ${missing.join(', ')}`)
  }
}

function assertOcrAssets(label: string, assets: readonly AssetLike[]): void {
  const paths = new Set<string>()
  const allowedPaths = new Set<string>(OCR_REQUIRED_FILES)
  for (const asset of assets) {
    if (!allowedPaths.has(asset.path)) {
      throw new Error(`${label} contains unsupported OCR asset path: ${asset.path}`)
    }
    paths.add(asset.path)
    assertHttpsUrl(asset.url, `${label} asset URL ${asset.path}`)
    assertSha256(asset.sha256, `${label} asset sha256 ${asset.path}`)
    assertPositiveSize(asset, `${label} asset size ${asset.path}`)
  }

  const missing = OCR_REQUIRED_FILES.filter((path) => !paths.has(path))
  if (missing.length > 0) {
    throw new Error(`${label} is missing OCR assets: ${missing.join(', ')}`)
  }
}

function assertHttpsUrl(value: string, label: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} is not a valid URL: ${value}`)
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${label} must use https: ${value}`)
  }
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${label} is not a sha256 digest: ${value}`)
  }
}

function assertPositiveSize(asset: AssetLike, label: string): void {
  if (asset.size !== undefined && (!Number.isSafeInteger(asset.size) || asset.size <= 0)) {
    throw new Error(`${label} must be a positive integer.`)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
