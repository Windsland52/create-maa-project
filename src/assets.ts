import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'
import { setTimeout as sleep } from 'node:timers/promises'
import { sha256, stableJson } from './utils.js'

export const DEFAULT_OCR_ZIP_URL =
  'https://download.maafw.xyz/MaaCommonAssets/OCR/ppocr_v5/ppocr_v5-zh_cn.zip'

export type AssetManifest = {
  schemaVersion?: number
  assets: AssetEntry[]
}

export type ProductAssetManifest = Omit<AssetManifest, 'assets'> & {
  assets: ProductAssetEntry[]
  product?: string
  version?: string
  tag?: string
  channel?: string
  platform?: string
}

export type ProductAssetManifestRequest = {
  product: string
  channel?: string
  platform?: string
}

export type ProductAssetManifestResolver = (
  request: ProductAssetManifestRequest
) => Promise<ProductAssetManifest | undefined>

export type ProductAssetManifestResolveOptions = {
  explicitEnvNames?: string[]
  fetchJson?: GithubReleaseJsonFetcher
}

export type AssetEntry = {
  path: string
  url: string
  sha256: string
  size?: number
}

export type ProductAssetEntry = AssetEntry & {
  extract?: ProjectArchiveExtraction
}

export type ProjectArchiveExtraction = {
  format: 'zip' | 'tar.gz'
  product: 'MaaFramework' | 'MFAAvalonia' | 'Python'
  platform: string
}

export type DownloadedAsset = {
  path: string
  content: Buffer
  sha256: string
  size: number
  url: string
  mode?: number
}

export type DownloadProgress = {
  url: string
  downloadedBytes: number
  totalBytes?: number
  path?: string
}
export type DownloadProgressReporter = (progress: DownloadProgress) => void
export type AssetDownloaderOptions = {
  onProgress?: DownloadProgressReporter
}
export type AssetDownloader = (url: string, options?: AssetDownloaderOptions) => Promise<Buffer>
export type AssetManifestResolver = () => Promise<AssetManifest | undefined>
export type GithubReleaseJsonFetcher = (
  url: string,
  options: {
    headers: Record<string, string>
  }
) => Promise<unknown>

type ProductReleaseConfig = {
  product: ProjectArchiveExtraction['product']
  owner: string
  repo: string
}

const PRODUCT_RELEASES: ProductReleaseConfig[] = [
  {
    product: 'MaaFramework',
    owner: 'MaaXYZ',
    repo: 'MaaFramework'
  },
  {
    product: 'MFAAvalonia',
    owner: 'MaaXYZ',
    repo: 'MFAAvalonia'
  },
  {
    product: 'Python',
    owner: 'astral-sh',
    repo: 'python-build-standalone'
  }
]
const DEFAULT_DOWNLOAD_ATTEMPTS = 3
export const PYTHON_EMBED_VERSION = '3.13.14'
const PYTHON_STANDALONE_MINOR = '3.13'

export async function resolveOcrManifestFromEnvironment(
  options: ProductAssetManifestResolveOptions = {}
): Promise<AssetManifest | undefined> {
  return resolveProductAssetManifestFromEnvironment(
    { product: 'OCR', channel: 'latest' },
    {
      ...options,
      explicitEnvNames: [
        'CREATE_MAA_PROJECT_OCR_MANIFEST_URL',
        ...(options.explicitEnvNames ?? [])
      ]
    }
  )
}

export async function resolveProductAssetManifestFromEnvironment(
  request: ProductAssetManifestRequest,
  options: ProductAssetManifestResolveOptions = {}
): Promise<ProductAssetManifest | undefined> {
  const explicitUrl = firstEnvironmentValue([
    ...(options.explicitEnvNames ?? []),
    ...productManifestEnvironmentNames(request.product)
  ])
  if (explicitUrl) {
    return loadProductAssetManifest(explicitUrl, true)
  }

  return undefined
}

export async function resolveProductAssetManifest(
  request: ProductAssetManifestRequest,
  options: ProductAssetManifestResolveOptions = {}
): Promise<ProductAssetManifest | undefined> {
  return (
    (await resolveProductAssetManifestFromEnvironment(request, options)) ??
    (await resolveProductAssetManifestFromGithubRelease(request, options))
  )
}

export async function resolveProductAssetManifestFromGithubRelease(
  request: ProductAssetManifestRequest,
  options: ProductAssetManifestResolveOptions = {}
): Promise<ProductAssetManifest | undefined> {
  const config = productReleaseConfig(request.product)
  if (!config) return undefined

  const requestedPlatform = resolveRequestedRuntimePlatform(request.platform)
  if (!requestedPlatform) return undefined
  const selectedPlatform = requestedPlatform === 'all' ? undefined : requestedPlatform
  const release = await fetchGithubRelease(config, request.channel ?? 'latest', options.fetchJson)
  return parseGithubReleaseManifest(config, release, request.channel ?? 'latest', selectedPlatform)
}

export async function downloadManifestAssets(
  manifest: AssetManifest,
  options: {
    downloader?: AssetDownloader
    allowedPaths: string[]
    onProgress?: DownloadProgressReporter
  }
): Promise<DownloadedAsset[]> {
  const downloader = options.downloader ?? defaultDownload
  const allowedPaths = new Set(options.allowedPaths)
  const assets = manifest.assets.map(validateAssetEntry)
  const totalBytes = assets.every((asset) => asset.size !== undefined)
    ? assets.reduce((sum, asset) => sum + (asset.size ?? 0), 0)
    : undefined
  const unexpected = assets.find((asset) => !allowedPaths.has(asset.path))
  if (unexpected) {
    throw new Error(`Asset manifest contains unsupported path: ${unexpected.path}`)
  }

  const missing = options.allowedPaths.find((path) => !assets.some((asset) => asset.path === path))
  if (missing) {
    throw new Error(`Asset manifest is missing required asset: ${missing}`)
  }

  const downloaded: DownloadedAsset[] = []
  let completedBytes = 0
  for (const asset of assets) {
    const content = await downloader(
      asset.url,
      options.onProgress
        ? {
            onProgress: (progress) => {
              options.onProgress?.({
                url: progress.url,
                path: asset.path,
                downloadedBytes: completedBytes + progress.downloadedBytes,
                ...(totalBytes !== undefined ? { totalBytes } : {})
              })
            }
          }
        : undefined
    )
    const actualSha256 = sha256(content)
    if (actualSha256 !== asset.sha256) {
      throw new Error(
        `Checksum mismatch for ${asset.path}: expected ${asset.sha256}, got ${actualSha256}`
      )
    }
    if (asset.size !== undefined && content.byteLength !== asset.size) {
      throw new Error(
        `Size mismatch for ${asset.path}: expected ${asset.size}, got ${content.byteLength}`
      )
    }
    completedBytes += content.byteLength
    options.onProgress?.({
      url: asset.url,
      path: asset.path,
      downloadedBytes: completedBytes,
      ...(totalBytes !== undefined ? { totalBytes } : {})
    })
    downloaded.push({
      path: asset.path,
      content,
      sha256: actualSha256,
      size: content.byteLength,
      url: asset.url
    })
  }
  return downloaded
}

export async function downloadProjectManifestAssets(
  manifest: ProductAssetManifest,
  options: {
    downloader?: AssetDownloader
    allowedPathPrefixes: string[]
    onProgress?: DownloadProgressReporter
  }
): Promise<DownloadedAsset[]> {
  const downloader = options.downloader ?? defaultDownload
  const assets = manifest.assets.map(validateProductAssetEntry)
  const unexpected = assets.find(
    (asset) => !options.allowedPathPrefixes.some((prefix) => asset.path.startsWith(prefix))
  )
  if (unexpected) {
    throw new Error(`Asset manifest contains unsupported path: ${unexpected.path}`)
  }
  if (assets.length === 0) {
    throw new Error('Asset manifest does not contain downloadable assets.')
  }

  const totalBytes = assets.every((asset) => asset.size !== undefined)
    ? assets.reduce((sum, asset) => sum + (asset.size ?? 0), 0)
    : undefined
  const downloaded: DownloadedAsset[] = []
  let completedBytes = 0
  for (const asset of assets) {
    const content = await downloader(
      asset.url,
      options.onProgress
        ? {
            onProgress: (progress) => {
              options.onProgress?.({
                url: progress.url,
                path: asset.path,
                downloadedBytes: completedBytes + progress.downloadedBytes,
                ...(totalBytes !== undefined ? { totalBytes } : {})
              })
            }
          }
        : undefined
    )
    const actualSha256 = sha256(content)
    if (actualSha256 !== asset.sha256) {
      throw new Error(
        `Checksum mismatch for ${asset.path}: expected ${asset.sha256}, got ${actualSha256}`
      )
    }
    if (asset.size !== undefined && content.byteLength !== asset.size) {
      throw new Error(
        `Size mismatch for ${asset.path}: expected ${asset.size}, got ${content.byteLength}`
      )
    }
    completedBytes += content.byteLength
    options.onProgress?.({
      url: asset.url,
      path: asset.path,
      downloadedBytes: completedBytes,
      ...(totalBytes !== undefined ? { totalBytes } : {})
    })
    if (asset.extract) {
      downloaded.push(...extractProjectArchiveAsset(content, asset))
    } else {
      downloaded.push({
        path: asset.path,
        content,
        sha256: actualSha256,
        size: content.byteLength,
        url: asset.url
      })
    }
  }
  return downloaded
}

export async function downloadUrl(
  url: string,
  options: AssetDownloaderOptions = {}
): Promise<Buffer> {
  return defaultDownload(url, options)
}

export function extractProjectArchiveAssets(
  archive: Buffer,
  asset: ProductAssetEntry
): DownloadedAsset[] {
  return extractProjectArchiveAsset(archive, validateProductAssetEntry(asset))
}

export function resolveRuntimePlatform(value?: string): string | undefined {
  return resolveRequestedRuntimePlatform(value)
}

export async function writeDownloadedAssets(
  root: string,
  basePath: string,
  assets: DownloadedAsset[]
): Promise<{ written: string[]; manifestContent: string }> {
  const written: string[] = []
  for (const asset of assets) {
    const relativePath = join(basePath, asset.path)
    const target = join(root, relativePath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, asset.content)
    written.push(relativePath)
  }
  const manifestContent = stableJson({
    schemaVersion: 1,
    assets: assets.map((asset) => ({
      path: asset.path,
      sha256: asset.sha256,
      size: asset.size,
      source: asset.url
    }))
  })
  await writeFile(join(root, basePath, 'manifest.json'), manifestContent, 'utf8')
  written.push(join(basePath, 'manifest.json'))
  return { written, manifestContent }
}

export async function writeDownloadedProjectAssets(
  root: string,
  assets: DownloadedAsset[]
): Promise<string[]> {
  const written: string[] = []
  for (const asset of assets) {
    const target = join(root, asset.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, asset.content)
    if (asset.mode !== undefined) {
      await chmod(target, asset.mode & 0o777)
    }
    written.push(asset.path)
  }
  return written
}

export async function downloadDefaultOcrZip(
  options: {
    downloader?: AssetDownloader
    url?: string
    onProgress?: DownloadProgressReporter
  } = {}
): Promise<DownloadedAsset[]> {
  const url = options.url ?? DEFAULT_OCR_ZIP_URL
  const zip = options.downloader
    ? await options.downloader(
        url,
        options.onProgress
          ? {
              onProgress: options.onProgress
            }
          : undefined
      )
    : await downloadDefaultOcrZipContent(
        url,
        options.onProgress
          ? {
              onProgress: options.onProgress
            }
          : undefined
      )
  return extractOcrZipAssets(zip, url)
}

export function extractOcrZipAssets(zip: Buffer, sourceUrl: string): DownloadedAsset[] {
  const entries = readZipEntries(zip)
  const selected = new Map<string, { sourcePath: string; content: Buffer }>()
  for (const entry of entries) {
    const fileName = entry.path.split('/').at(-1)?.toLowerCase()
    if (!fileName) continue
    if (fileName === 'det.onnx') selected.set('det.onnx', entry)
    if (fileName === 'rec.onnx') selected.set('rec.onnx', entry)
    if (fileName === 'keys.txt') selected.set('keys.txt', entry)
    if (fileName === 'readme.md' || fileName === 'readme.txt' || fileName === 'readme') {
      selected.set('README.md', entry)
    }
  }

  const required = [
    'det.onnx',
    'rec.onnx',
    'keys.txt',
    'README.md'
  ]
  const missing = required.find((path) => !selected.has(path))
  if (missing) {
    throw new Error(`OCR zip is missing required asset: ${missing}`)
  }

  return required.map((path) => {
    const entry = selected.get(path)
    if (!entry) throw new Error(`OCR zip is missing required asset: ${path}`)
    return {
      path,
      content: entry.content,
      sha256: sha256(entry.content),
      size: entry.content.byteLength,
      url: `${sourceUrl}#${entry.sourcePath}`
    }
  })
}

function extractProjectArchiveAsset(archive: Buffer, asset: ProductAssetEntry): DownloadedAsset[] {
  const extraction = asset.extract
  if (!extraction) {
    throw new Error(`Project archive asset is missing extraction metadata: ${asset.path}`)
  }
  const entries = stripArchiveRoot(
    extraction.product,
    extraction.format === 'zip' ? readZipEntries(archive) : readTarGzipEntries(archive)
  )
  const selected = new Map<string, DownloadedAsset>()
  for (const entry of entries) {
    if (isIgnoredArchiveEntry(entry.path)) continue
    for (const targetPath of mapProjectArchiveEntry(extraction, entry.path)) {
      const downloaded: DownloadedAsset = {
        path: targetPath,
        content: entry.content,
        sha256: sha256(entry.content),
        size: entry.content.byteLength,
        url: `${asset.url}#${entry.sourcePath}`,
        ...(entry.mode !== undefined ? { mode: entry.mode } : {})
      }
      const existing = selected.get(targetPath)
      if (existing && existing.sha256 !== downloaded.sha256) {
        throw new Error(`Archive extraction would overwrite ${targetPath} with different content.`)
      }
      selected.set(targetPath, downloaded)
    }
  }
  if (selected.size === 0) {
    throw new Error(`Project archive did not contain usable runtime files: ${asset.path}`)
  }
  return [
    ...selected.values()
  ]
}

function mapProjectArchiveEntry(
  extraction: ProjectArchiveExtraction,
  relativePath: string
): string[] {
  let mapped: string[]
  if (extraction.product === 'MFAAvalonia') {
    mapped = [
      `.create-maa-project/runtime/mfaa/${extraction.platform}/${relativePath}`
    ]
  } else if (extraction.product === 'Python') {
    mapped = mapPythonArchiveEntry(extraction.platform, relativePath)
  } else {
    mapped = mapMaaFrameworkArchiveEntry(extraction.platform, relativePath)
  }
  for (const path of mapped) {
    if (!isSafeRelativePath(path)) {
      throw new Error(`Archive extraction produced an invalid path: ${path}`)
    }
  }
  return mapped
}

function mapMaaFrameworkArchiveEntry(platform: string, relativePath: string): string[] {
  const parts = relativePath.split('/')
  const first = parts[0]?.toLowerCase()
  const rest = parts.slice(1).join('/')

  if (first === 'bin' && rest) {
    if (parts[1]?.toLowerCase() === 'plugins' && parts.length > 2) {
      return [
        `plugins/${platform}/${parts.slice(2).join('/')}`
      ]
    }
    return [
      `runtimes/${platform}/native/${rest}`
    ]
  }
  if ((first === 'lib' || first === 'plugins') && rest) {
    return [
      `plugins/${platform}/${rest}`
    ]
  }
  if (first === 'share' && parts[1]?.toLowerCase() === 'maaagentbinary' && parts.length > 2) {
    return [
      `libs/MaaAgentBinary/${parts.slice(2).join('/')}`
    ]
  }
  if (parts.length === 1) {
    return [
      `runtimes/${platform}/native/${relativePath}`
    ]
  }
  return []
}

function mapPythonArchiveEntry(platform: string, relativePath: string): string[] {
  const normalizedPath = relativePath.startsWith('python/')
    ? relativePath.slice('python/'.length)
    : relativePath
  const installPath = normalizedPath.startsWith('install/')
    ? normalizedPath.slice('install/'.length)
    : normalizedPath
  if (!installPath) return []
  return [
    `.create-maa-project/runtime/python/${platform}/${installPath}`
  ]
}

function stripArchiveRoot(
  product: ProjectArchiveExtraction['product'],
  entries: ArchiveFileEntry[]
): ArchiveFileEntry[] {
  const roots = new Set(entries.map((entry) => entry.path.split('/')[0]).filter(Boolean))
  if (roots.size !== 1) return entries
  const [
    root
  ] = [
    ...roots
  ]
  if (!root) return entries
  if (entries.some((entry) => !entry.path.includes('/'))) return entries
  if (product === 'MFAAvalonia' && root.toLowerCase().endsWith('.app')) return entries
  if (product === 'MaaFramework' && [
      'bin',
      'lib',
      'share',
      'include',
      'plugins'
    ].includes(root.toLowerCase())) {
    return entries
  }
  return entries
    .map((entry) => ({
      ...entry,
      path: entry.path.split('/').slice(1).join('/')
    }))
    .filter((entry) => entry.path.length > 0)
}

function isIgnoredArchiveEntry(path: string): boolean {
  const lower = path.toLowerCase()
  return lower === '.ds_store' || lower.endsWith('/.ds_store') || lower.startsWith('__macosx/')
}

async function fetchGithubRelease(
  config: ProductReleaseConfig,
  channel: string,
  fetchJson: GithubReleaseJsonFetcher = defaultGithubReleaseJsonFetch
): Promise<unknown> {
  const releasePath = channel === 'latest' ? 'latest' : `tags/${encodeURIComponent(channel)}`
  return fetchJson(
    `https://api.github.com/repos/${config.owner}/${config.repo}/releases/${releasePath}`,
    {
      headers: githubRequestHeaders()
    }
  )
}

async function defaultGithubReleaseJsonFetch(
  url: string,
  options: {
    headers: Record<string, string>
  }
): Promise<unknown> {
  const attempts = configuredDownloadAttempts()
  let lastError: unknown
  let usedAttempts = 0
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    usedAttempts = attempt
    try {
      const response = await fetch(url, { headers: options.headers })
      if (!response.ok) {
        throw new DownloadHttpError(response.status)
      }
      return response.json() as Promise<unknown>
    } catch (error) {
      lastError = error
      if (attempt >= attempts || !isRetryableDownloadError(error)) {
        break
      }
      await sleep(downloadRetryDelayMs(attempt))
    }
  }
  const suffix = usedAttempts > 1 ? ` after ${usedAttempts} attempts` : ''
  throw new Error(`Failed to resolve GitHub release ${url}${suffix}: ${errorMessage(lastError)}`)
}

function githubRequestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }
  const token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim()
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

function parseGithubReleaseManifest(
  config: ProductReleaseConfig,
  value: unknown,
  channel: string,
  selectedPlatform: string | undefined
): ProductAssetManifest | undefined {
  if (!isRecord(value) || typeof value.tag_name !== 'string' || !Array.isArray(value.assets)) {
    throw new Error(`Invalid GitHub release payload for ${config.product}.`)
  }
  const tag = value.tag_name
  const assets: ProductAssetEntry[] = []
  for (const entry of value.assets) {
    const asset = parseGithubReleaseAsset(config.product, tag, entry)
    if (!asset) continue
    if (!asset.extract) continue
    if (selectedPlatform && asset.extract.platform !== selectedPlatform) continue
    assets.push(asset)
  }
  if (assets.length === 0) return undefined
  assets.sort((left, right) =>
    (left.extract?.platform ?? '').localeCompare(right.extract?.platform ?? '')
  )
  return {
    schemaVersion: 1,
    product: config.product,
    version: tag,
    tag,
    channel,
    ...(selectedPlatform ? { platform: selectedPlatform } : { platform: 'all' }),
    assets
  }
}

function parseGithubReleaseAsset(
  product: ProjectArchiveExtraction['product'],
  tag: string,
  value: unknown
): ProductAssetEntry | undefined {
  if (!isRecord(value) || typeof value.name !== 'string') return undefined
  const match = matchProductReleaseAsset(product, tag, value.name)
  if (!match) return undefined
  if (
    typeof value.browser_download_url !== 'string' ||
    !/^https?:\/\//.test(value.browser_download_url)
  ) {
    throw new Error(`GitHub release asset has no download URL: ${value.name}`)
  }
  const digest =
    typeof value.digest === 'string' ? parseGithubSha256Digest(value.digest) : undefined
  if (!digest) {
    throw new Error(`GitHub release asset has no sha256 digest: ${value.name}`)
  }
  const path =
    product === 'MFAAvalonia'
      ? `.create-maa-project/runtime/mfaa/${match.platform}/${value.name}`
      : product === 'Python'
        ? `.create-maa-project/runtime/python/${match.platform}/${value.name}`
        : `plugins/${match.platform}/${value.name}`
  return validateProductAssetEntry({
    path,
    url: value.browser_download_url,
    sha256: digest,
    ...(Number.isSafeInteger(value.size) && (value.size as number) >= 0
      ? { size: value.size as number }
      : {}),
    extract: {
      product,
      platform: match.platform,
      format: match.format
    }
  })
}

function matchProductReleaseAsset(
  product: ProjectArchiveExtraction['product'],
  tag: string,
  name: string
): { platform: string; format: ProjectArchiveExtraction['format'] } | undefined {
  const escapedTag = escapeRegExp(tag)
  if (product === 'MFAAvalonia') {
    const match = new RegExp(
      `^MFAAvalonia-${escapedTag}-(win|linux|osx)-(x64|arm64)\\.(zip|tar\\.gz)$`
    ).exec(name)
    if (!match) return undefined
    const os = normalizeReleaseOs(match[1] as string)
    const arch = normalizeReleaseArch(match[2] as string)
    const format = match[3] === 'zip' ? 'zip' : 'tar.gz'
    return os && arch ? { platform: `${os}-${arch}`, format } : undefined
  }
  if (product === 'Python') {
    const match = new RegExp(
      `^cpython-(${escapeRegExp(PYTHON_STANDALONE_MINOR)}\\.\\d+)\\+${escapedTag}-([^-]+(?:-[^-]+)+)-install_only_stripped\\.tar\\.gz$`
    ).exec(name)
    if (!match) return undefined
    const platform = pythonStandalonePlatform(match[2] as string)
    return platform ? { platform, format: 'tar.gz' } : undefined
  }
  const match = new RegExp(`^MAA-(win|linux|macos)-(x86_64|aarch64)-${escapedTag}\\.zip$`).exec(
    name
  )
  if (!match) return undefined
  const os = normalizeReleaseOs(match[1] as string)
  const arch = normalizeReleaseArch(match[2] as string)
  return os && arch ? { platform: `${os}-${arch}`, format: 'zip' } : undefined
}

function parseGithubSha256Digest(value: string): string | undefined {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(value.trim())
  return match?.[1]?.toLowerCase()
}

function productReleaseConfig(product: string): ProductReleaseConfig | undefined {
  const normalized = product.toLowerCase().replace(/[^a-z0-9]+/g, '')
  if (normalized === 'maaframework' || normalized === 'maafw') {
    return PRODUCT_RELEASES.find((config) => config.product === 'MaaFramework')
  }
  if (normalized === 'mfaavalonia' || normalized === 'mfa') {
    return PRODUCT_RELEASES.find((config) => config.product === 'MFAAvalonia')
  }
  if (normalized === 'python' || normalized === 'pythonruntime' || normalized === 'cpython') {
    return PRODUCT_RELEASES.find((config) => config.product === 'Python')
  }
  return undefined
}

function pythonStandalonePlatform(value: string): string | undefined {
  switch (value) {
    case 'x86_64-apple-darwin':
      return 'osx-x64'
    case 'aarch64-apple-darwin':
      return 'osx-arm64'
    default:
      return undefined
  }
}

function resolveRequestedRuntimePlatform(value: string | undefined): string | undefined {
  const explicit =
    value?.trim() ||
    process.env.CREATE_MAA_PROJECT_RUNTIME_PLATFORM?.trim() ||
    process.env.CREATE_MAA_PROJECT_PLATFORM?.trim()
  if (explicit) {
    const normalized = normalizeRuntimePlatform(explicit)
    if (!normalized) {
      throw new Error(`Unsupported runtime platform: ${explicit}`)
    }
    return normalized
  }
  if (process.env.GITHUB_ACTIONS === 'true') {
    throw new Error(
      'Runtime platform must be explicit in GitHub Actions. Set CREATE_MAA_PROJECT_RUNTIME_PLATFORM from the workflow matrix, for example win-arm64.'
    )
  }
  return currentRuntimePlatform()
}

function currentRuntimePlatform(): string | undefined {
  const os =
    process.platform === 'win32'
      ? 'win'
      : process.platform === 'darwin'
        ? 'osx'
        : process.platform === 'linux'
          ? 'linux'
          : undefined
  const arch = normalizeReleaseArch(process.arch)
  return os && arch ? `${os}-${arch}` : undefined
}

function normalizeRuntimePlatform(value: string): string | undefined {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^windows/, 'win')
    .replace(/^win32/, 'win')
    .replace(/^darwin/, 'osx')
    .replace(/^macos/, 'osx')
    .replace(/x86_64/g, 'x64')
    .replace(/amd64/g, 'x64')
    .replace(/aarch64/g, 'arm64')
    .replace(/_/g, '-')
  if (normalized === 'all') return 'all'
  return /^(win|linux|osx)-(x64|arm64)$/.test(normalized) ? normalized : undefined
}

function normalizeReleaseOs(value: string): 'win' | 'linux' | 'osx' | undefined {
  if (value === 'win') return 'win'
  if (value === 'linux') return 'linux'
  if (value === 'macos' || value === 'osx') return 'osx'
  return undefined
}

function normalizeReleaseArch(value: string): 'x64' | 'arm64' | undefined {
  if (value === 'x64' || value === 'x86_64' || value === 'amd64') return 'x64'
  if (value === 'arm64' || value === 'aarch64') return 'arm64'
  return undefined
}

async function defaultDownload(url: string, options: AssetDownloaderOptions = {}): Promise<Buffer> {
  const attempts = configuredDownloadAttempts()
  let lastError: unknown
  let usedAttempts = 0
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    usedAttempts = attempt
    try {
      return await downloadOnce(url, options)
    } catch (error) {
      lastError = error
      if (attempt >= attempts || !isRetryableDownloadError(error)) {
        break
      }
      await sleep(downloadRetryDelayMs(attempt))
    }
  }
  const suffix = usedAttempts > 1 ? ` after ${usedAttempts} attempts` : ''
  throw new Error(`Failed to download ${url}${suffix}: ${errorMessage(lastError)}`)
}

async function downloadOnce(url: string, options: AssetDownloaderOptions = {}): Promise<Buffer> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new DownloadHttpError(response.status)
  }
  const totalBytes = parseContentLength(response.headers.get('content-length'))
  if (!response.body) {
    const content = Buffer.from(await response.arrayBuffer())
    options.onProgress?.({
      url,
      downloadedBytes: content.byteLength,
      ...(totalBytes !== undefined ? { totalBytes } : {})
    })
    return content
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let downloadedBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    downloadedBytes += value.byteLength
    options.onProgress?.({
      url,
      downloadedBytes,
      ...(totalBytes !== undefined ? { totalBytes } : {})
    })
  }
  return Buffer.concat(chunks, downloadedBytes)
}

class DownloadHttpError extends Error {
  readonly retryable: boolean

  constructor(status: number) {
    super(`HTTP ${status}`)
    this.retryable = status === 429 || status >= 500
  }
}

function configuredDownloadAttempts(): number {
  const value = Number(process.env.CREATE_MAA_PROJECT_DOWNLOAD_ATTEMPTS ?? '')
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_DOWNLOAD_ATTEMPTS
}

function downloadRetryDelayMs(failedAttempt: number): number {
  if (failedAttempt <= 1) return 0
  return Math.min(1000, 250 * 2 ** (failedAttempt - 2))
}

function isRetryableDownloadError(error: unknown): boolean {
  if (error instanceof DownloadHttpError) return error.retryable
  return true
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function downloadDefaultOcrZipContent(
  url: string,
  options: AssetDownloaderOptions = {}
): Promise<Buffer> {
  const localPath = process.env.CREATE_MAA_PROJECT_OCR_ZIP_PATH?.trim()
  if (localPath) {
    const content = await readFile(localPath)
    options.onProgress?.({
      url,
      downloadedBytes: content.byteLength,
      totalBytes: content.byteLength
    })
    return content
  }
  return defaultDownload(url, options)
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) return undefined
  const size = Number(value)
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined
}

async function loadProductAssetManifest(
  location: string,
  strict: boolean
): Promise<ProductAssetManifest | undefined> {
  try {
    const manifest = JSON.parse((await readLocator(location)).toString('utf8')) as unknown
    return parseProductAssetManifest(manifest, strict)
  } catch (error) {
    if (strict) throw error
    return undefined
  }
}

async function readLocator(location: string): Promise<Buffer> {
  if (/^https?:\/\//.test(location)) {
    return defaultDownload(location)
  }
  if (location.startsWith('file://')) {
    return readFile(fileURLToPath(location))
  }
  return readFile(location)
}

function parseProductAssetManifest(
  value: unknown,
  strict: boolean
): ProductAssetManifest | undefined {
  if (!isRecord(value) || !Array.isArray(value.assets)) {
    if (strict) throw new Error('Asset manifest must contain an assets array.')
    return undefined
  }
  const manifest: ProductAssetManifest = {
    assets: value.assets.map((entry) => validateProductAssetEntry(entry as ProductAssetEntry))
  }
  if (typeof value.schemaVersion === 'number') manifest.schemaVersion = value.schemaVersion
  if (typeof value.product === 'string') manifest.product = value.product
  if (typeof value.version === 'string') manifest.version = value.version
  if (typeof value.tag === 'string') manifest.tag = value.tag
  if (typeof value.channel === 'string') manifest.channel = value.channel
  if (typeof value.platform === 'string') manifest.platform = value.platform
  return manifest
}

function productManifestEnvironmentNames(product: string): string[] {
  const normalized = product.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  const names = [
    `CREATE_MAA_PROJECT_${normalized}_MANIFEST_URL`
  ]
  if (normalized === 'MAAFRAMEWORK') {
    names.push('CREATE_MAA_PROJECT_MAAFW_MANIFEST_URL')
  }
  if (normalized === 'MFAAVALONIA') {
    names.push('CREATE_MAA_PROJECT_MFA_MANIFEST_URL')
  }
  return names
}

function firstEnvironmentValue(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateAssetEntry(entry: AssetEntry): AssetEntry {
  if (!isSafeRelativePath(entry.path)) {
    throw new Error(`Invalid asset path: ${entry.path}`)
  }
  if (!entry.url || !/^https?:\/\//.test(entry.url)) {
    throw new Error(`Invalid asset URL for ${entry.path}`)
  }
  if (!/^[a-f0-9]{64}$/i.test(entry.sha256)) {
    throw new Error(`Invalid asset sha256 for ${entry.path}`)
  }
  if (entry.size !== undefined && (!Number.isSafeInteger(entry.size) || entry.size < 0)) {
    throw new Error(`Invalid asset size for ${entry.path}`)
  }
  return {
    path: entry.path,
    url: entry.url,
    sha256: entry.sha256.toLowerCase(),
    ...(entry.size !== undefined ? { size: entry.size } : {})
  }
}

function validateProductAssetEntry(entry: ProductAssetEntry): ProductAssetEntry {
  const asset = validateAssetEntry(entry)
  if (!entry.extract) return asset
  if (!isRecord(entry.extract)) {
    throw new Error(`Invalid asset extraction metadata for ${entry.path}`)
  }
  const format = entry.extract.format
  const product = entry.extract.product
  const platform =
    typeof entry.extract.platform === 'string'
      ? normalizeRuntimePlatform(entry.extract.platform)
      : undefined
  if (format !== 'zip' && format !== 'tar.gz') {
    throw new Error(`Invalid asset extraction format for ${entry.path}`)
  }
  if (product !== 'MaaFramework' && product !== 'MFAAvalonia' && product !== 'Python') {
    throw new Error(`Invalid asset extraction product for ${entry.path}`)
  }
  if (!platform || platform === 'all') {
    throw new Error(`Invalid asset extraction platform for ${entry.path}`)
  }
  return {
    ...asset,
    extract: {
      format,
      product,
      platform
    }
  }
}

type ArchiveFileEntry = {
  path: string
  sourcePath: string
  content: Buffer
  mode?: number
}

function readTarGzipEntries(archive: Buffer): ArchiveFileEntry[] {
  return readTarEntries(gunzipSync(archive))
}

function readTarEntries(tar: Buffer): ArchiveFileEntry[] {
  const entries: ArchiveFileEntry[] = []
  let offset = 0
  let globalPax: Record<string, string> = {}
  let nextPax: Record<string, string> | undefined
  let nextLongPath: string | undefined

  while (offset + 512 <= tar.byteLength) {
    if (isZeroBlock(tar, offset)) break
    const header = tar.subarray(offset, offset + 512)
    const size = parseTarOctal(header.subarray(124, 136), 'size')
    const mode = parseTarOctal(header.subarray(100, 108), 'mode')
    const type = String.fromCharCode(header[156] ?? 0)
    const dataOffset = offset + 512
    const dataEnd = dataOffset + size
    if (dataEnd > tar.byteLength) {
      throw new Error('Invalid TAR archive: entry extends beyond archive size.')
    }
    const data = tar.subarray(dataOffset, dataEnd)
    const nextOffset = dataOffset + Math.ceil(size / 512) * 512

    if (type === 'g') {
      globalPax = { ...globalPax, ...parsePaxHeaders(data) }
      offset = nextOffset
      continue
    }
    if (type === 'x') {
      nextPax = parsePaxHeaders(data)
      offset = nextOffset
      continue
    }
    if (type === 'L') {
      nextLongPath = readNullTerminatedString(data)
      offset = nextOffset
      continue
    }

    const pax = { ...globalPax, ...(nextPax ?? {}) }
    nextPax = undefined
    if (type === '5') {
      nextLongPath = undefined
      offset = nextOffset
      continue
    }
    if (type !== '0' && type !== '\0' && type !== '') {
      nextLongPath = undefined
      offset = nextOffset
      continue
    }

    const sourcePath = pax.path ?? nextLongPath ?? tarHeaderPath(header)
    nextLongPath = undefined
    const path = normalizeArchiveFilePath(sourcePath, 'TAR')
    entries.push({
      path,
      sourcePath,
      content: Buffer.from(data),
      ...(mode > 0 ? { mode } : {})
    })
    offset = nextOffset
  }
  return entries
}

function readZipEntries(zip: Buffer): ArchiveFileEntry[] {
  const eocdOffset = findEndOfCentralDirectory(zip)
  const centralDirectorySize = zip.readUInt32LE(eocdOffset + 12)
  const centralDirectoryOffset = zip.readUInt32LE(eocdOffset + 16)
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize
  const entries: ArchiveFileEntry[] = []
  let offset = centralDirectoryOffset

  while (offset < centralDirectoryEnd) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory.')
    }
    const flags = zip.readUInt16LE(offset + 8)
    const method = zip.readUInt16LE(offset + 10)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const uncompressedSize = zip.readUInt32LE(offset + 24)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const externalAttributes = zip.readUInt32LE(offset + 38)
    const localHeaderOffset = zip.readUInt32LE(offset + 42)
    const rawName = zip.subarray(offset + 46, offset + 46 + nameLength)
    const sourcePath = decodeZipName(rawName, flags)
    offset += 46 + nameLength + extraLength + commentLength

    if (sourcePath.endsWith('/')) continue
    const path = normalizeArchiveFilePath(sourcePath, 'ZIP')
    const mode = (externalAttributes >>> 16) & 0xffff
    entries.push({
      path,
      sourcePath,
      content: readZipEntryContent(zip, {
        localHeaderOffset,
        compressedSize,
        uncompressedSize,
        method
      }),
      ...(mode > 0 ? { mode } : {})
    })
  }
  return entries
}

function readZipEntryContent(
  zip: Buffer,
  entry: {
    localHeaderOffset: number
    compressedSize: number
    uncompressedSize: number
    method: number
  }
): Buffer {
  const offset = entry.localHeaderOffset
  if (zip.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error('Invalid ZIP local file header.')
  }
  const nameLength = zip.readUInt16LE(offset + 26)
  const extraLength = zip.readUInt16LE(offset + 28)
  const dataOffset = offset + 30 + nameLength + extraLength
  const compressed = zip.subarray(dataOffset, dataOffset + entry.compressedSize)
  if (entry.method === 0) return compressed
  if (entry.method === 8) {
    const content = inflateRawSync(compressed)
    if (content.byteLength !== entry.uncompressedSize) {
      throw new Error('ZIP entry size mismatch after inflate.')
    }
    return content
  }
  throw new Error(`Unsupported ZIP compression method: ${entry.method}`)
}

function tarHeaderPath(header: Buffer): string {
  const name = readNullTerminatedString(header.subarray(0, 100))
  const prefix = readNullTerminatedString(header.subarray(345, 500))
  return prefix ? `${prefix}/${name}` : name
}

function parseTarOctal(value: Buffer, label: string): number {
  const text = readNullTerminatedString(value).trim()
  if (!text) return 0
  if (!/^[0-7]+$/.test(text)) {
    throw new Error(`Invalid TAR ${label}: ${text}`)
  }
  return Number.parseInt(text, 8)
}

function parsePaxHeaders(content: Buffer): Record<string, string> {
  const headers: Record<string, string> = {}
  let offset = 0
  while (offset < content.byteLength) {
    const space = content.indexOf(0x20, offset)
    if (space < 0) break
    const lengthText = content.subarray(offset, space).toString('utf8')
    const length = Number.parseInt(lengthText, 10)
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > content.byteLength) {
      throw new Error('Invalid TAR PAX header length.')
    }
    const record = content.subarray(space + 1, offset + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0) {
      headers[record.slice(0, equals)] = record.slice(equals + 1)
    }
    offset += length
  }
  return headers
}

function readNullTerminatedString(value: Buffer): string {
  const end = value.indexOf(0)
  return value.subarray(0, end >= 0 ? end : value.byteLength).toString('utf8')
}

function isZeroBlock(buffer: Buffer, offset: number): boolean {
  for (let index = 0; index < 512; index += 1) {
    if (buffer[offset + index] !== 0) return false
  }
  return true
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const minimumSize = 22
  const maxCommentSize = 0xffff
  const start = Math.max(0, zip.length - minimumSize - maxCommentSize)
  for (let offset = zip.length - minimumSize; offset >= start; offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) return offset
  }
  throw new Error('Invalid ZIP: end of central directory not found.')
}

function decodeZipName(rawName: Buffer, flags: number): string {
  return rawName.toString(flags & 0x0800 ? 'utf8' : 'latin1')
}

function normalizeArchiveFilePath(path: string, archiveType: string): string {
  let normalized = path
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2)
  }
  if (!isSafeRelativePath(normalized)) {
    throw new Error(`Invalid ${archiveType} entry path: ${path}`)
  }
  return normalized
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isSafeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
}
