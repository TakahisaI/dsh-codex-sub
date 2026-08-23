import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import {
  assertCandidateVersion,
  assertPackedCompatibilityMatchesSource,
  assertPackedManifestMatchesSource,
  collectLockfileDshPackageEntries,
  RC1_CANDIDATE_VERSION,
  RC1_UPSTREAM_COMMIT,
  deriveRc1CandidateSource,
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

describe('packed artifact identity checks', () => {
  it('accepts the real packed manifest and compatibility document', async () => {
    const inputs = await repositoryInputs()
    // Simulate pnpm pack normalization: drop `packageManager`, reorder keys.
    const packed = structuredClone(inputs.manifest)
    delete packed.packageManager
    const reordered = Object.fromEntries(
      [...Object.entries(packed)].sort(([first], [second]) => first.localeCompare(second)),
    )
    expect(() => assertPackedManifestMatchesSource(reordered, inputs.manifest)).not.toThrow()
    expect(() => assertPackedCompatibilityMatchesSource(inputs.compatibility, inputs.compatibility)).not.toThrow()
  })

  it.each([
    ['peerDependencies version', (manifest) => {
      const firstPeer = Object.keys(manifest.peerDependencies)[0]
      manifest.peerDependencies[firstPeer] = '9.9.9'
    }],
    ['nested exports target', (manifest) => {
      manifest.exports['.'].default = './lib/wrong.mjs'
    }],
    ['script body', (manifest) => {
      manifest.scripts.build = 'echo wrong'
    }],
    ['bundle patch path', (manifest) => {
      manifest.dsh.bundle.patch = './wrong.patch.yml'
    }],
    ['bin path', (manifest) => {
      manifest.bin['dsh-codex-sub'] = './lib/wrong-bin.mjs'
    }],
    ['devDependency range', (manifest) => {
      const firstDev = Object.keys(manifest.devDependencies)[0]
      manifest.devDependencies[firstDev] = '0.0.1'
    }],
  ])('detects a changed %s', async (_label, mutate) => {
    const inputs = await repositoryInputs()
    const packed = structuredClone(inputs.manifest)
    delete packed.packageManager
    mutate(packed)
    expect(() => assertPackedManifestMatchesSource(packed, inputs.manifest)).toThrow(
      'The packed manifest did not match the reviewed source.',
    )
  })

  it('detects a changed nested compatibility value', async () => {
    const inputs = await repositoryInputs()
    const packed = structuredClone(inputs.compatibility)
    packed.dsh.packages['@deepseek-ai/dsh-llm'] = '0.1.0-rc.8'
    expect(() => assertPackedCompatibilityMatchesSource(packed, inputs.compatibility)).toThrow(
      'The packed compatibility document did not match the reviewed source.',
    )
  })
})

describe('lockfile DSH release-line enumeration', () => {
  function lockWith(...packageKeys) {
    return [
      'lockfileVersion: \'9.0\'',
      '',
      'packages:',
      '',
      ...packageKeys.map((key) => `  '${key}':\n    resolution: {integrity: sha512-x}`),
    ].join('\n')
  }

  it('collects plain and peer-resolved entries from the packages section only', () => {
    const lockText = [
      'lockfileVersion: \'9.0\'',
      '',
      'importers:',
      '',
      '  .:',
      "    dependencies:\n      '@deepseek-ai/dsh-llm':",
      '        specifier: 0.1.1-rc.1',
      '        version: 0.1.1-rc.1()',
      '',
      'packages:',
      '',
      "  '@deepseek-ai/dsh-llm@0.1.1-rc.1':",
      '    resolution: {integrity: sha512-a}',
      '',
      "  '@deepseek-ai/dsh-llm@0.1.1-rc.1(@deepseek-ai/cordis@4.0.1)':",
      '    resolution: {integrity: sha512-b}',
      '',
      "  '@other/pkg@0.1.0-rc.7':",
      '    resolution: {integrity: sha512-c}',
    ].join('\n')
    expect(collectLockfileDshPackageEntries(lockText)).toEqual([
      { name: '@deepseek-ai/dsh-llm', version: '0.1.1-rc.1' },
    ])
  })

  it('returns nothing when a packages section is absent', () => {
    expect(collectLockfileDshPackageEntries("lockfileVersion: '9.0'\n")).toEqual([])
  })

  it('stops at the next top-level section instead of scanning snapshots', () => {
    const lockText = [
      "lockfileVersion: '9.0'",
      '',
      'packages:',
      '',
      "  '@deepseek-ai/dsh-llm@0.1.1-rc.1':",
      '    resolution: {integrity: sha512-a}',
      '',
      'snapshots:',
      '',
      "  '@deepseek-ai/dsh-llm@0.1.1-rc.2(snap)':",
      '    dependencies: {}',
    ].join('\n')
    expect(collectLockfileDshPackageEntries(lockText)).toEqual([
      { name: '@deepseek-ai/dsh-llm', version: '0.1.1-rc.1' },
    ])
  })
})

describe('candidate version equality', () => {
  it.each(['0.1.1-rc.2', '0.1.1-rc.10', '0.1.2-rc.1', '0.1.2'])(
    'rejects non-candidate release %s',
    (version) => {
      expect(() => assertCandidateVersion('@deepseek-ai/dsh-x', version, RC1_CANDIDATE_VERSION))
        .toThrow(`was ${version}, expected ${RC1_CANDIDATE_VERSION}`)
    },
  )

  it('accepts only the exact candidate version', () => {
    expect(() => assertCandidateVersion('@deepseek-ai/dsh-x', RC1_CANDIDATE_VERSION, RC1_CANDIDATE_VERSION))
      .not.toThrow()
    expect(() => assertCandidateVersion('@deepseek-ai/dsh-x', 'v0.1.1-rc.1', RC1_CANDIDATE_VERSION))
      .toThrow('was not a plain release version')
  })
})
