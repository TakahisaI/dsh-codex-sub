import { parseStructuredYaml } from './dsh-release-family-lock.mjs'

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const PI_AI_SELECTOR_PATTERNS = Object.freeze([
  // pnpm `parent>child`, Yarn `**/child`, nested parent/child selectors, and
  // package aliases (`npm:child`) all put package components behind a
  // delimiter. The delimiter is part of the token boundary; the slash inside
  // a scoped package is not a boundary for the scoped pattern below.
  new RegExp('(?:^|[>/:])\\s*pi-ai(?:@[^>/]*)?(?=$|[>/])', 'iu'),
  new RegExp('(?:^|[>/:])\\s*@earendil-works/pi-ai(?:@[^>/]*)?(?=$|[>/])', 'iu'),
])

export function isPiAiSelector(key) {
  const normalized = String(key).trim()
  return PI_AI_SELECTOR_PATTERNS.some((pattern) => pattern.test(normalized))
}

function hasPiAiSelector(value, label, path) {
  if (Array.isArray(value)) {
    for (const [index, nested] of value.entries()) {
      if (hasPiAiSelector(nested, label, `${path}[${String(index)}]`)) return true
    }
    return false
  }
  if (!isRecord(value)) return false
  for (const [key, nested] of Object.entries(value)) {
    if (isPiAiSelector(key)) {
      throw new Error(`${label} ${path} contains pi-ai selector ${key}.`)
    }
    if (hasPiAiSelector(nested, label, `${path}.${key}`)) return true
  }
  return false
}

function inspectManifest(manifest, label) {
  invariant(isRecord(manifest), `${label} package manifest must be an object.`)
  for (const field of ['overrides', 'resolutions']) {
    if (manifest[field] !== undefined) hasPiAiSelector(manifest[field], label, field)
  }
  if (isRecord(manifest.pnpm)) {
    for (const field of ['overrides', 'resolutions']) {
      if (manifest.pnpm[field] !== undefined) hasPiAiSelector(manifest.pnpm[field], label, `pnpm.${field}`)
    }
  }
}

export function assertNoPiAiSelectorsInManifest(manifest, label = 'package.json') {
  inspectManifest(manifest, label)
}

export function assertNoPiAiSelectorsInWorkspace(workspaceText, label = 'pnpm-workspace.yaml') {
  const workspace = parseStructuredYaml(workspaceText, label)
  for (const field of ['overrides', 'resolutions']) {
    if (workspace[field] !== undefined) hasPiAiSelector(workspace[field], label, field)
  }
}

export function assertNoPiAiSelectorsInLock(lockText, label = 'pnpm-lock.yaml') {
  const lock = parseStructuredYaml(lockText, label)
  for (const field of ['overrides', 'resolutions']) {
    if (lock[field] !== undefined) hasPiAiSelector(lock[field], label, field)
  }
}

export function assertNoPiAiTopology({
  manifests = [],
  workspaces = [],
  locks = [],
}) {
  for (const { label, manifest } of manifests) {
    assertNoPiAiSelectorsInManifest(manifest, label)
  }
  for (const { label, text } of workspaces) {
    assertNoPiAiSelectorsInWorkspace(text, label)
  }
  for (const { label, text } of locks) {
    assertNoPiAiSelectorsInLock(text, label)
  }
}

/**
 * Render the externally visible topology with opaque copy labels. Real paths
 * remain useful for identity comparison inside the probe but must never enter
 * its report or failure details.
 */
export function formatOpaquePiAiTopology({ resolutions, additional = [] }) {
  invariant(isRecord(resolutions), 'pi-ai resolutions must be an object.')
  const entries = Object.entries(resolutions)
  const directories = [...new Set(entries.map(([, value]) => value.directory))].sort()
  const labels = new Map(directories.map((directory, index) => [directory, `copy-${String(index + 1)}`]))
  const rendered = Object.fromEntries(entries.map(([consumer, value]) => {
    invariant(isRecord(value), `pi-ai resolution ${consumer} must be an object.`)
    const label = labels.get(value.directory)
    invariant(label !== undefined, `pi-ai resolution ${consumer} had no physical copy label.`)
    return [consumer, `${label}@${String(value.version)}`]
  }))
  return {
    piAiCopies: directories.length,
    piAiResolutions: rendered,
    additionalPiAiStoreIdentities: additional.map((value, index) => `additional-${String(index + 1)}@${String(value.version)}`),
  }
}
