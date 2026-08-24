import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  assertDshReleaseFamilyLock,
  collectDshLockIdentities,
  parseStructuredYaml,
  DSH_RELEASE_FAMILY_VERSION,
} from '../scripts/dsh-release-family-lock.mjs'

const fixtureDirectory = new URL('./fixtures/rc1-release-host/', import.meta.url)

async function fixtureText(filename) {
  return readFile(new URL(filename, fixtureDirectory), 'utf8')
}

describe('override-free rc.1 release Host fixture', () => {
  it('contains exactly 188 direct DSH identities at rc.1', async () => {
    const manifest = JSON.parse(await fixtureText('package.json'))
    const names = Object.keys(manifest.dependencies)
      .filter(name => name.startsWith('@deepseek-ai/dsh'))
      .sort()
    expect(names).toHaveLength(188)
    expect(names.every(name => manifest.dependencies[name] === DSH_RELEASE_FAMILY_VERSION)).toBe(true)
    expect(manifest.dependencies['@deepseek-ai/cordis']).toBe('4.0.1')
    expect(manifest.dependencies['@deepseek-ai/schemastery']).toBe('3.18.1')
    expect(manifest.dependencies['@earendil-works/pi-ai']).toBe('0.82.1')
  })

  it('locks the same 188 names without override or resolution metadata', async () => {
    const manifest = JSON.parse(await fixtureText('package.json'))
    const names = Object.keys(manifest.dependencies)
      .filter(name => name.startsWith('@deepseek-ai/dsh'))
      .sort()
    const [lockText, workspaceText] = await Promise.all([
      fixtureText('pnpm-lock.yaml'),
      fixtureText('pnpm-workspace.yaml'),
    ])
    const report = assertDshReleaseFamilyLock({
      lockText,
      workspaceText,
      version: DSH_RELEASE_FAMILY_VERSION,
      overridePolicy: 'forbidden',
      expectedNames: names,
      requireAutoInstallPeers: true,
    })
    expect(report.names).toEqual(names)
    expect(report.packageIdentities).toHaveLength(188)
    expect(report.snapshotIdentities).toHaveLength(188)
    expect(report.packageIdentities.every(entry => entry.version === DSH_RELEASE_FAMILY_VERSION)).toBe(true)
    expect(report.snapshotIdentities.every(entry => entry.version === DSH_RELEASE_FAMILY_VERSION)).toBe(true)
    expect(parseStructuredYaml(workspaceText).overrides).toBeUndefined()
    expect(parseStructuredYaml(workspaceText).resolutions).toBeUndefined()
    expect(parseStructuredYaml(lockText).overrides).toBeUndefined()
    expect(parseStructuredYaml(lockText).settings.autoInstallPeers).toBe(false)
  })

  it('rejects an override or resolution reintroduced into locked mode', async () => {
    const manifest = JSON.parse(await fixtureText('package.json'))
    const names = Object.keys(manifest.dependencies)
      .filter(name => name.startsWith('@deepseek-ai/dsh'))
    const [lockText, workspaceText] = await Promise.all([
      fixtureText('pnpm-lock.yaml'),
      fixtureText('pnpm-workspace.yaml'),
    ])
    expect(() => assertDshReleaseFamilyLock({
      lockText: `${lockText}\noverrides:\n  '@deepseek-ai/dsh': ${DSH_RELEASE_FAMILY_VERSION}\n`,
      workspaceText,
      version: DSH_RELEASE_FAMILY_VERSION,
      overridePolicy: 'forbidden',
      expectedNames: names,
      requireAutoInstallPeers: true,
    })).toThrow(/override/u)
  })
})
