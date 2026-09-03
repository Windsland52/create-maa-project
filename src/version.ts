import packageJson from '../package.json' with { type: 'json' }

export const CLI_VERSION: string = packageJson.version
