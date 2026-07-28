export type TemplateName = 'pipeline' | 'agent'
export type ControllerKind = 'Adb' | 'Win32' | 'MacOS' | 'PlayCover' | 'Gamepad' | 'WlRoots'
export type LicenseKind = 'AGPL-3.0-or-later' | 'MIT' | 'None'
export type NetworkMode = 'auto' | 'official'
export type CliLanguage = 'auto' | 'en' | 'zh-CN'
export type ReleaseChannel = 'stable' | 'beta' | 'alpha'
export type MaaProjectConfig = {
  schemaVersion: 1 | 2
  project: {
    slug: string
    displayName: string
    version: string
    initialTemplate: TemplateName
    github?: string
    interfaceUnmanaged?: boolean
  }
  features: {
    ci: FeatureState
    release: FeatureState
    vscode: FeatureState
    quality: FeatureState
  }
  addons: Record<string, unknown>
  controller: {
    kinds: ControllerKind[]
  }
  resources: ResourcePackConfig[]
  maafw: {
    channel: ReleaseChannel | string
    version?: string
  }
  runtime: {
    mfa: RuntimeGuiConfig
    mxu?: RuntimeGuiConfig
  }
  ocr?: OcrConfig
  python?: {
    devCommand?: string[]
    requiresPython: string
    recommendedPython: string
  }
  network: {
    mode: NetworkMode
  }
  license: {
    spdx: LicenseKind
  }
}

export type RuntimeGuiConfig = {
  channel: ReleaseChannel | string
  version?: string
  enabled: boolean
}

export type OcrConfig = {
  source: 'download' | 'submodule'
  submodulePath?: string
  files?: Record<string, string>
}

export type FeatureState = {
  enabled: boolean
}

export type ResourcePackConfig = {
  slug: string
  label: string
  path: string
  enabled: boolean
}

export type PendingItem = {
  kind: string
  reason: string
  command: string
}

export type CliOptions = {
  help?: boolean
  cliVersion?: boolean
  name?: string
  slug?: string
  template: TemplateName
  add: string[]
  update: string[]
  sync?: string
  syncValue?: string
  doctor: boolean
  yes: boolean
  noInteractive: boolean
  force: boolean
  clearStaleLock: boolean
  allowNonGitDir: boolean
  allowPendingCommit: boolean
  skipDownload: boolean
  verbose: boolean
  noColor: boolean
  lang?: CliLanguage
  assist: boolean
  initializeGit?: boolean
  network?: NetworkMode
  from?: string
  migrate?: string
  target?: string
  dryRun: boolean
  label?: string
  displayName?: string
  version?: string
  license?: LicenseKind
  controllers?: ControllerKind[]
  resourcePackSlug?: string
  listBackups: boolean
  showBackup?: string
  restore?: string
  cleanCache: boolean
  report: boolean
  mcp: boolean
  mcpRoot?: string
  logFile?: string
  explicitTemplate: boolean
}

export type ManagedFileInput = {
  path: string
  content: string | Buffer
  managed: boolean
}

export type ScaffoldResult = {
  root: string
  config: MaaProjectConfig
  written: string[]
  skipped: string[]
  pending: PendingItem[]
  backupId?: string
  git?: GitInitResult
}

export type GitInitResult = {
  initialized: boolean
  committed: boolean
  reason?: string
}
