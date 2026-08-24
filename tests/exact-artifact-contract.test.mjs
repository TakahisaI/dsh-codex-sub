import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertWorkflowArtifactSha256,
  assertWorkflowArtifactSourceIdentity,
} from '../scripts/exact-artifact-contract.mjs'
import { calculateSha256 } from '../scripts/package-tarball.mjs'

async function repositoryInputs() {
  const [manifestText, compatibilityText] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../compatibility.json', import.meta.url), 'utf8'),
  ])
  return {
    repositoryManifest: JSON.parse(manifestText),
    repositoryCompatibility: JSON.parse(compatibilityText),
  }
}

describe('exact workflow artifact contract', () => {
  it('rejects malformed and mismatched workflow SHA values', () => {
    expect(() => assertWorkflowArtifactSha256('not-a-sha', '0'.repeat(64))).toThrow('lowercase digest')
    expect(() => assertWorkflowArtifactSha256('0'.repeat(64), '1'.repeat(64))).toThrow('SHA-256 mismatch')
  })

  it('detects a one-byte artifact mutation before install', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-codex-sub-artifact-contract-'))
    try {
      const artifact = join(directory, 'candidate.tgz')
      await writeFile(artifact, Buffer.from('immutable artifact\n'))
      const expected = await calculateSha256(artifact)
      await writeFile(artifact, Buffer.from('immutable artifact!\n'))
      const actual = await calculateSha256(artifact)
      expect(() => assertWorkflowArtifactSha256(actual, expected)).toThrow('SHA-256 mismatch')
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  it('rejects an alpha.1 manifest when the checkout is alpha.2', async () => {
    const inputs = await repositoryInputs()
    const packedManifest = structuredClone(inputs.repositoryManifest)
    packedManifest.version = '0.1.0-alpha.1'
    expect(() => assertWorkflowArtifactSourceIdentity({
      packedManifest,
      packedCompatibility: inputs.repositoryCompatibility,
      ...inputs,
      version: '0.1.1-rc.1',
      repositoryCommit: inputs.repositoryCompatibility.dsh.repositoryCommit,
    })).toThrow('packed manifest did not match')
  })

  it('accepts unchanged metadata and exact rc.1 identity', async () => {
    const inputs = await repositoryInputs()
    expect(() => assertWorkflowArtifactSourceIdentity({
      packedManifest: inputs.repositoryManifest,
      packedCompatibility: inputs.repositoryCompatibility,
      ...inputs,
      version: '0.1.1-rc.1',
      repositoryCommit: inputs.repositoryCompatibility.dsh.repositoryCommit,
    })).not.toThrow()
  })
})
