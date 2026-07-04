import { existsSync, readFileSync } from 'node:fs'

if (!existsSync('tools/schema')) {
  throw new Error('Missing tools/schema directory')
}

const interfaceJson = readJson('interface.json')
const interfaceSchema = readJson('tools/schema/interface.schema.json')
const packageJson = readJson('package.json')

assertRecord(interfaceJson, 'interface.json')
assertEqual(interfaceJson.interface_version, 2, 'interface.json interface_version must be 2')
assertSlug(interfaceJson.name, 'interface.json name')
assertNonEmptyString(interfaceJson.label, 'interface.json label')
assertVersion(interfaceJson.version, 'interface.json version', true)
assertArrayOfRecords(interfaceJson.controller, 'interface.json controller')
assertArrayOfRecords(interfaceJson.resource, 'interface.json resource')
assertArrayOfStrings(interfaceJson.import, 'interface.json import')

for (const [
  index,
  controller
] of interfaceJson.controller.entries()) {
  assertNonEmptyString(controller.name, 'interface.json controller[' + index + '].name')
  assertNonEmptyString(controller.label, 'interface.json controller[' + index + '].label')
  assertEnum(
    controller.type,
    [
      'Adb',
      'Win32',
      'MacOS',
      'PlayCover',
      'Gamepad',
      'WlRoots'
    ],
    'interface.json controller[' + index + '].type'
  )
}

for (const [
  index,
  resource
] of interfaceJson.resource.entries()) {
  assertNonEmptyString(resource.name, 'interface.json resource[' + index + '].name')
  assertArrayOfStrings(resource.path, 'interface.json resource[' + index + '].path')
}

if (interfaceJson.task !== undefined) {
  assertArrayOfRecords(interfaceJson.task, 'interface.json task')
  for (const [
    index,
    task
  ] of interfaceJson.task.entries()) {
    assertNonEmptyString(task.name, 'interface.json task[' + index + '].name')
    assertNonEmptyString(task.entry, 'interface.json task[' + index + '].entry')
  }
}

if (interfaceJson.agent !== undefined) {
  assertArrayOfRecords(interfaceJson.agent, 'interface.json agent')
  for (const [
    index,
    agent
  ] of interfaceJson.agent.entries()) {
    assertNonEmptyString(agent.child_exec, 'interface.json agent[' + index + '].child_exec')
    if (agent.child_args !== undefined) {
      assertArrayOfStrings(agent.child_args, 'interface.json agent[' + index + '].child_args')
    }
  }
}

assertRecord(interfaceSchema, 'tools/schema/interface.schema.json')
assertEqual(
  interfaceSchema.title,
  'MaaFramework Project Interface V2',
  'tools/schema/interface.schema.json title must be MaaFramework Project Interface V2'
)
assertRecord(interfaceSchema.properties, 'tools/schema/interface.schema.json properties')
assertRecord(
  interfaceSchema.properties.interface_version,
  'tools/schema/interface.schema.json properties.interface_version'
)
assertEqual(
  interfaceSchema.properties.interface_version.const,
  2,
  'tools/schema/interface.schema.json interface_version const must be 2'
)

assertRecord(packageJson, 'package.json')
assertSlug(packageJson.name, 'package.json name')
assertVersion(packageJson.version, 'package.json version', false)
assertEqual(packageJson.private, true, 'package.json private must be true')
assertEqual(packageJson.type, 'module', 'package.json type must be module')
assertRecord(packageJson.scripts, 'package.json scripts')

console.log('[OK] local project schema shape is valid')

function readJson(path) {
  if (!existsSync(path)) throw new Error(path + ' is missing')
  return JSON.parse(readFileSync(path, 'utf8'))
}

function assertRecord(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(label + ' must be an object')
  }
}

function assertArrayOfRecords(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'object' || item === null || Array.isArray(item))
  ) {
    throw new Error(label + ' must be an array of objects')
  }
}

function assertArrayOfStrings(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(label + ' must be an array of strings')
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(label + ' must be a non-empty string')
  }
}

function assertSlug(value, label) {
  assertNonEmptyString(value, label)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(label + ' must be an ASCII kebab-case slug')
  }
}

function assertVersion(value, label, withV) {
  assertNonEmptyString(value, label)
  const pattern = withV
    ? /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
    : /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
  if (!pattern.test(value)) {
    throw new Error(label + ' must be a SemVer version' + (withV ? ' with v prefix' : ''))
  }
}

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new Error(label + ' must be one of: ' + allowed.join(', '))
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message)
  }
}
