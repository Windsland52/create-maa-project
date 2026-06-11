process.env.MAA_SCHEMA_TARGET ??= 'templates/base/tools/schema'

await import('../templates/addons/schema-sync/tools/sync-schema.mjs')
