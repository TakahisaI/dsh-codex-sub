import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import {
  deriveRc1CandidateSource,
  RC1_CANDIDATE_VERSION,
  RC1_UPSTREAM_COMMIT,
  readRepositoryCandidateInputs,
} from '../scripts/spike-rc1-candidate-source.mjs'

async function repositoryInputs() {
  const [manifestText, compatibilityText] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../compatibility.json', import.meta.url), 'utf8'),
  ])
  return {
    compatibility: JSON.parse(compatibilityText),
    manifest: JSON.parse(manifestText),
  }
}

describe('rc.1 candidate source derivation', () => {
  it('pins the inspected rc.1 upstream identity', () => {
    expect(RC1_CANDIDATE_VERSION).toBe('0.1.1-rc.1')
    expect(RC1_UPSTREAM_COMMIT).toBe('528c682e061696f5a160f363f236ecbf53cbd006')
  })

  it('moves every DSH peer and the compatibility document to the candidate versions together', async () => {
    const inputs = await repositoryInputs()
    const { compatibility, manifest } = deriveRc1CandidateSource(inputs)

    expect(manifest.version).toBe(inputs.manifest.version)
    for (const [name, supported] of Object.entries(inputs.manifest.peerDependencies)) {
      if (name === '@deepseek-ai/cordis') {
        expect(manifest.peerDependencies[name]).toBe(supported)
      } else {
        expect(supported).toBe(inputs.compatibility.dsh.packages[name])
        expect(manifest.peerDependencies[name]).toBe(RC1_CANDIDATE_VERSION)
        expect(compatibility.dsh.packages[name]).toBe(RC1_CANDIDATE_VERSION)
      }
    }
    expect(compatibility.dsh.release).toBe(RC1_CANDIDATE_VERSION)
    expect(compatibility.dsh.repositoryCommit).toBe(RC1_UPSTREAM_COMMIT)
    expect(compatibility.piAi).toEqual(inputs.compatibility.piAi)
    expect(compatibility.node).toBe(inputs.compatibility.node)
    expect(compatibility.platforms).toEqual(inputs.compatibility.platforms)
  })

  it('does not mutate its inputs', async () => {
    const inputs = await repositoryInputs()
    const manifestSnapshot = JSON.stringify(inputs.manifest)
    const compatibilitySnapshot = JSON.stringify(inputs.compatibility)
    deriveRc1CandidateSource(inputs)
    expect(JSON.stringify(inputs.manifest)).toBe(manifestSnapshot)
    expect(JSON.stringify(inputs.compatibility)).toBe(compatibilitySnapshot)
  })

  it('rejects a foreign package identity', async () => {
    const inputs = await repositoryInputs()
    expect(() => deriveRc1CandidateSource({
      ...inputs,
      manifest: { ...inputs.manifest, name: 'other-package' },
    })).toThrow('Candidate source must derive from this package.')
  })
})
