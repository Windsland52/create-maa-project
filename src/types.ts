export type TemplateName = 'pipeline' | 'agent'
export type ControllerKind = 'Adb' | 'Win32' | 'MacOS' | 'PlayCover' | 'Gamepad' | 'WlRoots'
export type LicenseKind = 'AGPL-3.0-or-later' | 'MIT' | 'None'
export type NetworkMode = 'auto' | 'official'
export type MaaProjectConfig = {
  schemaVersion: 1
  project: {
    slug: string
    displayName: string
    version: string
    initialTemplate: TemplateName
    github?: string
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
    channel: 'latest' | string
  }
  runtime: {
    mfa: {
      channel: 'latest' | string
      enabled: boolean
    }
  }
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

export type FeatureState = {
  enabled: boolean
}

export type ResourcePackConfig = {
  slug: string
  label: string
  path: string
  enabled: boolean
}

export type MaaProjectLock = {
  schemaVersion: 1
  template: {
    createdBy: string
    lastUpdatedBy: string
    templateVersion: string
  }
  pending: PendingItem[]
  managedFiles: Record<string, ManagedFileState>
  createdFiles: Record<string, CreatedFileState>
}

export type PendingItem = {
  kind: string
  reason: string
  command: string
}

export type ChangedFileStatus = 'added' | 'modified' | 'deleted'

export type ChangedFileReport = {
  path: string
  status: ChangedFileStatus
}

export type ManagedFileState = {
  hash: string
  templateHash?: string
  acceptedAt?: string
  acceptedBy?: string
}

export type CreatedFileState = {
  createdAt: string
  managed: false
}

export type CliOptions = {
  name?: string
  slug?: string
  template: TemplateName
  add: string[]
  update: string[]
  sync?: string
  syncValue?: string
  doctor: boolean
  diff: boolean
  yes: boolean
  noInteractive: boolean
  force: boolean
  clearStaleLock: boolean
  allowNonGitDir: boolean
  allowPendingCommit: boolean
  skipDownload: boolean
  verbose: boolean
  noColor: boolean
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
  acceptChanges: string[]
  acceptChangesRequested: boolean
  resourcePackSlug?: string
  restore?: string
  cleanCache: boolean
  report: boolean
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
  lock: MaaProjectLock
  written: string[]
  skipped: string[]
  pending: PendingItem[]
  git?: GitInitResult
}

export type GitInitResult = {
  initialized: boolean
  committed: boolean
  reason?: string
}
