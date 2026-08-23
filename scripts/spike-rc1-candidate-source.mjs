import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

export const RC1_CANDIDATE_VERSION = '0.1.1-rc.1'
// Upstream inspected release for the rc.1 ownership decision (ADR 0017).
export const RC1_UPSTREAM_COMMIT = '528c682e061696f5a160f363f236ecbf53cbd006'

function invariant(condition, message) {
  if (!condition) throw new Error(message)
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
