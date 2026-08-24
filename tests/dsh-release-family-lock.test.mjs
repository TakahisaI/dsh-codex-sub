import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  assertDshReleaseFamilyLock,
  collectDshLockIdentities,
  collectLockDshOverrides,
  collectWorkspaceDshOverrides,
  parseStructuredYaml,
  DSH_RELEASE_FAMILY_VERSION,
} from '../scripts/dsh-release-family-lock.mjs'

function fixtureLock({
  importerSpecifier = DSH_RELEASE_FAMILY_VERSION,
  importerVersion = DSH_RELEASE_FAMILY_VERSION,
  packageVersion = DSH_RELEASE_FAMILY_VERSION,
  snapshotVersion = DSH_RELEASE_FAMILY_VERSION,
  snapshotDependency = DSH_RELEASE_FAMILY_VERSION,
  packagePeer = '^0.1.1-rc.2',
  overrides = [
    "  '@deepseek-ai/dsh': 0.1.1-rc.1",
    '  "@deepseek-ai/dsh-llm": "0.1.1-rc.1"',
  ],
  importer = 'block',
} = {}) {
  const importerLines = importer === 'flow'
    ? [
        '  .:',
        '    devDependencies:',
        `      '@deepseek-ai/dsh': {specifier: ${importerSpecifier}, version: ${importerVersion}(peer@1.0.0)}`,
      ]
    : [
        '  .:',
        '    devDependencies:',
        "      '@deepseek-ai/dsh':",
        `        specifier: ${importerSpecifier}`,
        `        version: ${importerVersion}(peer@1.0.0)`,
      ]
  return [
    "lockfileVersion: '9.0'",
    'overrides:',
    ...overrides,
    'importers:',
    ...importerLines,
    'packages:',
    `  '@deepseek-ai/dsh@${packageVersion}(peer@1.0.0)':`,
    '    peerDependencies:',
    `      '@deepseek-ai/dsh-llm': ${packagePeer}`,
    `  '@deepseek-ai/dsh-llm@${packageVersion}': {resolution: {integrity: sha512-a}}`,
    'snapshots:',
    `  '@deepseek-ai/dsh@${snapshotVersion}(peer@1.0.0)':`,
    '    dependencies:',
    `      '@deepseek-ai/dsh-llm': ${snapshotDependency}(peer@1.0.0)`,
    `  '@deepseek-ai/dsh-llm@${snapshotVersion}': {}`,
  ].join('\n')
}

function fixtureWorkspace(overrides = [
  "  '@deepseek-ai/dsh': 0.1.1-rc.1",
  '  "@deepseek-ai/dsh-llm": "0.1.1-rc.1"',
]) {
  return ['overrides:', ...overrides].join('\n')
}

describe('DSH release-family lock contract', () => {
  it('accepts the committed exact rc.1 graph and matching overrides', async () => {
    const [lockText, workspaceText] = await Promise.all([
      readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8'),
      readFile(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8'),
    ])
    const report = assertDshReleaseFamilyLock({ lockText, workspaceText })
    expect(report.names).toHaveLength(189)
    expect(report.packageIdentities.every(entry => entry.version === DSH_RELEASE_FAMILY_VERSION)).toBe(true)
    expect(report.snapshotIdentities.every(entry => entry.version === DSH_RELEASE_FAMILY_VERSION)).toBe(true)
  })

  it('does not mistake upstream peer ranges for selected identities', () => {
    const lockText = [
      'packages:',
      "  '@deepseek-ai/dsh@0.1.1-rc.1':",
      '    peerDependencies:',
      "      '@deepseek-ai/dsh-llm': ^0.1.1-rc.2",
      'snapshots:',
      "  '@deepseek-ai/dsh@0.1.1-rc.1':",
      '    dependencies:',
      "      '@deepseek-ai/dsh-llm': 0.1.1-rc.1(peer@1.0.0)",
    ].join('\n')
    const identities = collectDshLockIdentities(lockText)
    expect(identities.packages).toEqual([{ name: '@deepseek-ai/dsh', version: DSH_RELEASE_FAMILY_VERSION }])
    expect(identities.snapshots).toEqual([
      { name: '@deepseek-ai/dsh', version: DSH_RELEASE_FAMILY_VERSION },
      { name: '@deepseek-ai/dsh-llm', version: DSH_RELEASE_FAMILY_VERSION },
    ])
  })

  it('requires workspace and lock override maps to match exactly', () => {
    const workspaceText = [
      'overrides:',
      "  '@deepseek-ai/dsh': 0.1.1-rc.1",
      "  '@deepseek-ai/dsh-llm': 0.1.1-rc.1",
    ].join('\n')
    const lockText = [
      'overrides:',
      "  '@deepseek-ai/dsh': 0.1.1-rc.1",
      "  '@deepseek-ai/dsh-llm': 0.1.1-rc.2",
      'packages:',
      "  '@deepseek-ai/dsh@0.1.1-rc.1':",
      "  '@deepseek-ai/dsh-llm@0.1.1-rc.1':",
      'snapshots:',
      "  '@deepseek-ai/dsh@0.1.1-rc.1':",
      "  '@deepseek-ai/dsh-llm@0.1.1-rc.1':",
      'importers:',
      '  .:',
      '    devDependencies:',
      "      '@deepseek-ai/dsh':",
      '        specifier: 0.1.1-rc.1',
      '        version: 0.1.1-rc.1',
    ].join('\n')
    expect([...collectWorkspaceDshOverrides(workspaceText).keys()]).toEqual([
      '@deepseek-ai/dsh',
      '@deepseek-ai/dsh-llm',
    ])
    expect([...collectLockDshOverrides(lockText).keys()]).toEqual([
      '@deepseek-ai/dsh',
      '@deepseek-ai/dsh-llm',
    ])
    expect(() => assertDshReleaseFamilyLock({ lockText, workspaceText })).toThrow(
      'Lock overrides @deepseek-ai/dsh-llm selected 0.1.1-rc.2',
    )
  })

  it('accepts block and flow importers with peer suffixes', () => {
    for (const importer of ['block', 'flow']) {
      const lockText = fixtureLock({ importer })
      expect(() => assertDshReleaseFamilyLock({
        lockText,
        workspaceText: fixtureWorkspace(),
      })).not.toThrow()
    }
  })

  it.each([
    ['importer specifier', { importerSpecifier: '0.1.1-rc.2' }, 'specifier drifted'],
    ['importer resolution', { importerVersion: '0.1.1-rc.2' }, 'resolution drifted'],
    ['package identity', { packageVersion: '0.1.1-rc.2' }, 'packages @deepseek-ai/dsh selected'],
    ['snapshot identity', { snapshotVersion: '0.1.1-rc.2' }, 'snapshots @deepseek-ai/dsh selected'],
    ['snapshot dependency', { snapshotDependency: '0.1.1-rc.2' }, 'snapshots @deepseek-ai/dsh-llm selected'],
  ])('rejects selected rc.2 drift in %s', (_label, changes, message) => {
    expect(() => assertDshReleaseFamilyLock({
      lockText: fixtureLock(changes),
      workspaceText: fixtureWorkspace(),
    })).toThrow(message)
  })

  it('does not treat an exact rc.2 peer dependency declaration as selected', () => {
    expect(() => assertDshReleaseFamilyLock({
      lockText: fixtureLock({ packagePeer: '0.1.1-rc.2' }),
      workspaceText: fixtureWorkspace(),
    })).not.toThrow()
  })

  it.each([
    ['wildcard', ["  '@deepseek-ai/dsh-*': 0.1.1-rc.1"]],
    ['non-DSH', ["  '@example/other': 0.1.1-rc.1"]],
    ['pi-ai', ["  '@earendil-works/pi-ai': 0.82.1"]],
    ['Cordis', ["  '@deepseek-ai/cordis': 4.0.1"]],
  ])('rejects %s override selectors', (_label, overrides) => {
    expect(() => assertDshReleaseFamilyLock({
      lockText: fixtureLock({ overrides: [
        ...overrides,
        "  '@deepseek-ai/dsh': 0.1.1-rc.1",
        "  '@deepseek-ai/dsh-llm': 0.1.1-rc.1",
      ] }),
      workspaceText: fixtureWorkspace([
        ...overrides,
        "  '@deepseek-ai/dsh': 0.1.1-rc.1",
        "  '@deepseek-ai/dsh-llm': 0.1.1-rc.1",
      ]),
    })).toThrow(/override|names/i)
  })

  it.each([
    ['missing', ["  '@deepseek-ai/dsh': 0.1.1-rc.1"]],
    ['extra', [
      "  '@deepseek-ai/dsh': 0.1.1-rc.1",
      '  "@deepseek-ai/dsh-llm": "0.1.1-rc.1"',
      "  '@deepseek-ai/dsh-extra': 0.1.1-rc.1",
    ]],
  ])('rejects %s override mappings', (_label, overrides) => {
    expect(() => assertDshReleaseFamilyLock({
      lockText: fixtureLock({ overrides }),
      workspaceText: fixtureWorkspace(overrides),
    })).toThrow('names did not match')
  })

  it('rejects workspace-lock override mismatch and duplicate YAML keys', () => {
    expect(() => assertDshReleaseFamilyLock({
      lockText: fixtureLock(),
      workspaceText: fixtureWorkspace([
        "  '@deepseek-ai/dsh': 0.1.1-rc.2",
        '  "@deepseek-ai/dsh-llm": "0.1.1-rc.1"',
      ]),
    })).toThrow('selected 0.1.1-rc.2')
    expect(() => parseStructuredYaml('overrides:\n  a: 1\n  a: 2\n', 'duplicate fixture')).toThrow('invalid')
  })
})
