import { readdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDocument } from 'yaml'

export const DSH_RELEASE_FAMILY_PREFIX = '@deepseek-ai/dsh'
export const DSH_RELEASE_FAMILY_VERSION = '0.1.1-rc.1'

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

/** Parse YAML with duplicate mapping keys rejected before converting to JS. */
export function parseStructuredYaml(text, label = 'YAML') {
  const document = parseDocument(text, {
    prettyErrors: false,
    uniqueKeys: true,
  })
  if (document.errors.length > 0) {
    throw new Error(`${label} is invalid: ${document.errors.map(error => error.message).join('; ')}`)
  }
  return document.toJS({ mapAsMap: false })
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isDshName(name) {
  return name === DSH_RELEASE_FAMILY_PREFIX
    || name.startsWith(`${DSH_RELEASE_FAMILY_PREFIX}-`)
}

function splitIdentity(identity) {
  const text = String(identity)
  const openParen = text.indexOf('(')
  const base = openParen >= 0 ? text.slice(0, openParen) : text
  const atSign = base.indexOf('@', DSH_RELEASE_FAMILY_PREFIX.length)
  if (atSign < DSH_RELEASE_FAMILY_PREFIX.length) return undefined
  const name = base.slice(0, atSign)
  if (!isDshName(name)) return undefined
  return { name, version: base.slice(atSign + 1) }
}

function coreVersion(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  const text = String(value).trim()
  const openParen = text.indexOf('(')
  return (openParen >= 0 ? text.slice(0, openParen) : text)
    .replace(/^['"]|['"]$/gu, '')
}

function resolutionVersion(value) {
  if (typeof value === 'string' || typeof value === 'number') return coreVersion(value)
  if (isRecord(value)) return coreVersion(value.version)
  return ''
}

function pushUnique(entries, entry) {
  if (!entries.some(existing => existing.name === entry.name && existing.version === entry.version)) {
    entries.push(entry)
  }
}

function objectEntries(value) {
  return isRecord(value) ? Object.entries(value) : []
}

/**
 * Enumerate selected DSH identities from lockfile package and snapshot keys,
 * plus DSH resolutions under dependencies/optionalDependencies. Peer ranges
 * are intentionally ignored: they describe an upstream declaration, not a
 * selected graph identity.
 */
export function collectDshLockIdentities(lockText) {
  const lock = parseStructuredYaml(lockText, 'pnpm-lock.yaml')
  const packages = []
  const snapshots = []
  for (const [identity] of objectEntries(lock.packages)) {
    const entry = splitIdentity(identity)
    if (entry !== undefined) pushUnique(packages, entry)
  }
  for (const [identity, snapshot] of objectEntries(lock.snapshots)) {
    const entry = splitIdentity(identity)
    if (entry !== undefined) pushUnique(snapshots, entry)
    if (!isRecord(snapshot)) continue
    for (const section of ['dependencies', 'optionalDependencies']) {
      for (const [name, resolution] of objectEntries(snapshot[section])) {
        if (!isDshName(name)) continue
        const version = resolutionVersion(resolution)
        if (version === '' || version.startsWith('^') || version.startsWith('~')) continue
        pushUnique(snapshots, { name, version })
      }
    }
  }
  return { packages, snapshots }
}

export function collectDshLockNames(lockText) {
  const { packages, snapshots } = collectDshLockIdentities(lockText)
  return new Set([
    ...packages.map(entry => entry.name),
    ...snapshots.map(entry => entry.name),
  ])
}

function collectOverrides(root, label) {
  const source = root?.overrides
  if (source === undefined) return new Map()
  invariant(isRecord(source), `${label} overrides must be a mapping.`)
  return new Map(Object.entries(source).map(([name, value]) => [name, resolutionVersion(value)]))
}

function collectResolutions(root, label) {
  const source = root?.resolutions
  if (source === undefined) return new Map()
  invariant(isRecord(source), `${label} resolutions must be a mapping.`)
  return new Map(Object.entries(source).map(([name, value]) => [name, resolutionVersion(value)]))
}

export function collectWorkspaceDshOverrides(workspaceText) {
  return collectOverrides(parseStructuredYaml(workspaceText, 'pnpm-workspace.yaml'), 'Workspace')
}

export function collectLockDshOverrides(lockText) {
  return collectOverrides(parseStructuredYaml(lockText, 'pnpm-lock.yaml'), 'Lock')
}

/** Inspect every importer dependency category in the lockfile. */
export function collectImporterDshEntries(lockText) {
  const lock = parseStructuredYaml(lockText, 'pnpm-lock.yaml')
  const result = new Map()
  for (const [importer, body] of objectEntries(lock.importers)) {
    if (!isRecord(body)) continue
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, value] of objectEntries(body[section])) {
        if (!isDshName(name)) continue
        const entry = isRecord(value)
          ? {
              importer,
              name,
              specifier: coreVersion(value.specifier),
              version: resolutionVersion(value.version),
            }
          : {
              importer,
              name,
              specifier: coreVersion(value),
              version: '',
            }
        result.set(`${importer}:${name}`, entry)
      }
    }
  }
  return result
}

function assertExactEntries(entries, label, version) {
  for (const entry of entries) {
    invariant(
      entry.version === version,
      `${label} ${entry.name} selected ${entry.version}; expected ${version}.`,
    )
  }
}

function assertOverrideMap(map, names, label, version) {
  for (const [name, value] of map) {
    invariant(isDshName(name), `${label} contains non-DSH override ${name}.`)
    invariant(value === version, `${label} ${name} selected ${value}; expected ${version}.`)
  }
  const expected = new Set(names)
  const actual = new Set(map.keys())
  invariant(
    expected.size === actual.size && [...expected].every(name => actual.has(name)),
    `${label} names did not match the selected DSH release-family graph.`,
  )
}

/** Validate importer/package/snapshot/override structure for an exact DSH line. */
export function assertDshReleaseFamilyLock({
  lockText,
  workspaceText,
  version = DSH_RELEASE_FAMILY_VERSION,
  overridePolicy = 'required',
  expectedNames,
  requireAutoInstallPeers = false,
}) {
  invariant(
    overridePolicy === 'required' || overridePolicy === 'forbidden',
    `Unknown DSH release-family override policy: ${String(overridePolicy)}.`,
  )
  const identities = collectDshLockIdentities(lockText)
  invariant(identities.packages.length > 0, 'The lockfile selected no DSH package identities.')
  assertExactEntries(identities.packages, 'packages', version)
  assertExactEntries(identities.snapshots, 'snapshots', version)

  const names = new Set(identities.packages.map(entry => entry.name))
  const snapshotNames = new Set(identities.snapshots.map(entry => entry.name))
  invariant(
    [...snapshotNames].every(name => names.has(name)),
    'The lockfile selected a DSH snapshot without a package identity.',
  )

  for (const entry of collectImporterDshEntries(lockText).values()) {
    invariant(
      entry.specifier === version,
      `Importer ${entry.importer} ${entry.name} specifier drifted from ${version}.`,
    )
    invariant(
      entry.version === version,
      `Importer ${entry.importer} ${entry.name} resolution drifted from ${version}.`,
    )
  }

  const workspaceOverrides = collectWorkspaceDshOverrides(workspaceText)
  const lockOverrides = collectLockDshOverrides(lockText)
  const workspaceDocument = parseStructuredYaml(workspaceText, 'pnpm-workspace.yaml')
  const lockDocument = parseStructuredYaml(lockText, 'pnpm-lock.yaml')
  const workspaceResolutions = collectResolutions(workspaceDocument, 'Workspace')
  const lockResolutions = collectResolutions(lockDocument, 'Lock')
  if (overridePolicy === 'required') {
    assertOverrideMap(workspaceOverrides, names, 'Workspace overrides', version)
    assertOverrideMap(lockOverrides, names, 'Lock overrides', version)
    invariant(
      [...workspaceOverrides].every(([name, value]) => lockOverrides.get(name) === value),
      'Workspace and lock override mappings differ.',
    )
  } else {
    invariant(workspaceOverrides.size === 0, 'Fixture workspace must not define overrides.')
    invariant(lockOverrides.size === 0, 'Fixture lockfile must not define overrides.')
  }
  invariant(workspaceResolutions.size === 0, 'Workspace must not define resolutions.')
  invariant(lockResolutions.size === 0, 'Lockfile must not define resolutions.')
  if (requireAutoInstallPeers) {
    invariant(
      workspaceDocument.autoInstallPeers === false,
      'Fixture workspace must set autoInstallPeers: false.',
    )
    invariant(
      lockDocument.settings?.autoInstallPeers === false,
      'Fixture lockfile must set settings.autoInstallPeers: false.',
    )
  }
  if (expectedNames !== undefined) {
    const expected = new Set(expectedNames)
    invariant(
      expected.size === names.size && [...expected].every(name => names.has(name)),
      `DSH release-family names did not match the expected fixture graph (${String(expected.size)}).`,
    )
  }
  return Object.freeze({
    names: Object.freeze([...names].sort()),
    packageIdentities: Object.freeze(identities.packages),
    snapshotIdentities: Object.freeze(identities.snapshots),
    importerEntries: collectImporterDshEntries(lockText),
    overridePolicy,
    autoInstallPeers: lockDocument.settings?.autoInstallPeers,
  })
}

/** Enumerate physical DSH release-family packages in a pnpm host store. */
export async function enumerateHostDshPackages(hostRoot) {
  const storeDirectory = join(hostRoot, 'node_modules', '.pnpm')
  let entries
  try {
    entries = await readdir(storeDirectory)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const packages = []
  for (const entry of entries) {
    if (!entry.startsWith('@deepseek-ai+')) continue
    const remainder = entry.slice('@deepseek-ai+'.length)
    const atSign = remainder.indexOf('@')
    if (atSign <= 0) continue
    const namePart = remainder.slice(0, atSign)
    if (!namePart.startsWith('dsh')) continue
    const root = join(storeDirectory, entry, 'node_modules', '@deepseek-ai', namePart)
    try {
      const directory = await realpath(root)
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
      const expectedName = `@deepseek-ai/${namePart}`
      if (manifest.name !== expectedName) continue
      packages.push({ name: expectedName, version: manifest.version, directory })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return packages.sort((first, second) => (
    `${first.name}@${first.version}`.localeCompare(`${second.name}@${second.version}`)
  ))
}

export function assertHostDshPackages(
  packages,
  seedNames,
  version = DSH_RELEASE_FAMILY_VERSION,
  { requireUniqueNames = false } = {},
) {
  invariant(packages.length > 0, 'The Host graph resolved without any DSH packages.')
  const observedNames = new Set(packages.map(package_ => package_.name))
  if (requireUniqueNames) {
    invariant(
      packages.length === observedNames.size,
      'The Host graph contained duplicate physical DSH package names.',
    )
  }
  for (const name of seedNames) {
    invariant(observedNames.has(name), `${name} was absent from the Host graph.`)
  }
  for (const package_ of packages) {
    invariant(
      package_.version === version,
      `${package_.name} physical copy resolved at ${package_.version}; expected ${version}.`,
    )
  }
  return Object.freeze({ names: Object.freeze([...observedNames].sort()), copies: packages.length })
}
