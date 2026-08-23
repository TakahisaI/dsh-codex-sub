import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

export const RC1_CANDIDATE_VERSION = '0.1.1-rc.1'
// Upstream inspected release for the rc.1 ownership decision (ADR 0017).
export const RC1_UPSTREAM_COMMIT = '528c682e061696f5a160f363f236ecbf53cbd006'

// pnpm pack normalizes package.json: it drops `packageManager` (pnpm reads
// that setting from pnpm-workspace.yaml since v10) and reorders keys. The
// extracted manifest must otherwise equal the reviewed source.
const PACK_NORMALIZED_KEYS = new Set(['packageManager'])

const DSH_RELEASE_LINE_PREFIX = '@deepseek-ai/dsh'

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function stripPackNormalizedKeys(manifest) {
  const copy = structuredClone(manifest)
  for (const key of PACK_NORMALIZED_KEYS) delete copy[key]
  return copy
}

/**
 * Compare the packed manifest with the reviewed source manifest deeply.
 *
 * `packageManager` is dropped from both sides because pnpm pack removes it;
 * everything else — including nested peerDependencies, exports, scripts,
 * bin, engines, and the dsh bundle patch — must match exactly.
 */
export function assertPackedManifestMatchesSource(extractedManifest, repositoryManifest) {
  invariant(
    isDeepStrictEqual(
      stripPackNormalizedKeys(extractedManifest),
      stripPackNormalizedKeys(repositoryManifest),
    ),
    'The packed manifest did not match the reviewed source.',
  )
}

/**
 * Compare the packed compatibility document with the reviewed source deeply.
 */
export function assertPackedCompatibilityMatchesSource(extractedCompatibility, repositoryCompatibility) {
  invariant(
    isDeepStrictEqual(extractedCompatibility, repositoryCompatibility),
    'The packed compatibility document did not match the reviewed source.',
  )
}

/**
 * Parse every DSH release-line package entry from a pnpm lockfile's
 * `packages:` section and return `{ name, version }` pairs.
 *
 * Lockfile package keys are either `'name@version':` or the peer-resolved
 * form `'name@version(peer@peerVersion)(…)':`. Only the leading
 * `name@<release version>` before the first `(` counts, and only keys shaped
 * `'@deepseek-ai/dsh…@…':` inside the packages section are collected, so
 * versions mentioned in importers, prose, or peer suffixes never leak in.
 * The section ends at the next top-level key (`snapshots:` on pnpm 9+), so
 * later sections are never scanned.
 */
export function collectLockfileDshPackageEntries(lockText) {
  const packagesIndex = lockText.indexOf('\npackages:\n')
  if (packagesIndex < 0) return []
  const sectionStart = packagesIndex + '\npackages:\n'.length
  const nextSection = lockText.slice(sectionStart).match(/\n[a-zA-Z][a-zA-Z0-9-]*:\s*\n/u)
  const packagesSection = nextSection === null
    ? lockText.slice(sectionStart)
    : lockText.slice(sectionStart, sectionStart + nextSection.index + 1)
  const entries = []
  const seen = new Set()
  const entryPattern = /^  '((?:@deepseek-ai\/dsh[^']*)@[^']*)':\s*$/gmu
  for (const match of packagesSection.matchAll(entryPattern)) {
    const key = match[1]
    const openParen = key.indexOf('(')
    const identity = openParen >= 0 ? key.slice(0, openParen) : key
    const atSign = identity.indexOf('@', DSH_RELEASE_LINE_PREFIX.length - 1)
    if (atSign < DSH_RELEASE_LINE_PREFIX.length) continue
    const name = identity.slice(0, atSign)
    if (!name.startsWith(DSH_RELEASE_LINE_PREFIX)) continue
    const version = identity.slice(atSign + 1)
    const dedupe = `${name}@${version}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    entries.push({ name, version })
  }
  return entries
}

/**
 * Assert a parsed semver-like release version equals the candidate exactly.
 *
 * Accepts only `<major>.<minor>.<patch>` with optional `-<prerelease>`; any
 * prerelease on top of a different release (rc.2), a higher patch line, or a
 * later prerelease counter fails against the candidate.
 */
export function assertCandidateVersion(name, version, candidateVersion) {
  const shape = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u
  const match = shape.exec(version)
  invariant(match !== null, `${name} lockfile version ${version} was not a plain release version.`)
  invariant(
    version === candidateVersion,
    `${name} lockfile version was ${version}, expected ${candidateVersion}.`,
  )
}

/**
 * Derive the reviewed rc.1 candidate source from the supported-line metadata.
 *
 * This is the single reviewed transformation between the frozen rc.7 support
 * line and an rc.1-compatible candidate: every DSH release-line peer moves to
 * the exact candidate version, Cordis keeps its independent pin, and the
 * machine-readable compatibility document moves with the peers. Everything
 * else — package version, Node range, platforms, package manager, and the
 * pinned pi-ai dependency — is carried over unchanged.
 */
export function deriveRc1CandidateSource({ manifest, compatibility }) {
  invariant(manifest.name === 'dsh-codex-sub', 'Candidate source must derive from this package.')

  const candidateManifest = structuredClone(manifest)
  const candidateCompatibility = structuredClone(compatibility)

  const cordisPin = candidateManifest.peerDependencies['@deepseek-ai/cordis']
  invariant(typeof cordisPin === 'string', 'The Cordis pin was missing.')
  for (const [name, supported] of Object.entries(manifest.peerDependencies)) {
    if (name === '@deepseek-ai/cordis') continue
    invariant(supported === compatibility.dsh.packages[name], `${name} peer drifted from compatibility.json.`)
    candidateManifest.peerDependencies[name] = RC1_CANDIDATE_VERSION
  }

  candidateCompatibility.dsh.release = RC1_CANDIDATE_VERSION
  candidateCompatibility.dsh.repositoryCommit = RC1_UPSTREAM_COMMIT
  const candidatePackages = candidateCompatibility.dsh.packages
  for (const name of Object.keys(candidatePackages)) {
    if (name === '@deepseek-ai/cordis') continue
    candidatePackages[name] = RC1_CANDIDATE_VERSION
  }
  invariant(
    candidateCompatibility.piAi.version === compatibility.piAi.version,
    'The pi-ai pin must not move as part of the rc.1 candidate.',
  )
  return { compatibility: candidateCompatibility, manifest: candidateManifest }
}

export async function readRepositoryCandidateInputs() {
  const [manifestText, compatibilityText] = await Promise.all([
    readFile(join(repositoryRoot, 'package.json'), 'utf8'),
    readFile(join(repositoryRoot, 'compatibility.json'), 'utf8'),
  ])
  return {
    compatibility: JSON.parse(compatibilityText),
    manifest: JSON.parse(manifestText),
  }
}
