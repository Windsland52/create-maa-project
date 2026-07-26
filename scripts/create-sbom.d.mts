export interface DependencyNode {
  version?: string | number
  dependencies?: Record<string, DependencyNode>
}

export interface LicenseEntry {
  name: string
  versions?: Array<string | number>
  license?: string
}

export interface CycloneDxComponent {
  type: 'application' | 'library'
  'bom-ref': string
  group?: string
  name: string
  version: string
  purl: string
  licenses?: Array<{ license: { id?: string; name?: string } }>
}

export interface CycloneDxBom {
  bomFormat: 'CycloneDX'
  specVersion: '1.6'
  version: 1
  metadata: { component: CycloneDxComponent }
  components: CycloneDxComponent[]
  dependencies: Array<{ ref: string; dependsOn: string[] }>
}

export function createCycloneDxBom(
  packageJson: { name: string; version: string | number; license?: string },
  dependencyRoot: { dependencies?: Record<string, DependencyNode> },
  licenseReport: Record<string, LicenseEntry[]>,
): CycloneDxBom
