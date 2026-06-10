process.env.MAA_SCHEMA_TARGET ??= 'templates/base/tools/schema'

await import('../templates/base/tools/sync-schema.mjs')
