import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  assertNoPiAiSelectorsInLock,
  assertNoPiAiSelectorsInManifest,
  assertNoPiAiSelectorsInWorkspace,
  assertNoPiAiTopology,
  formatOpaquePiAiTopology,
  isPiAiSelector,
} from '../scripts/pi-ai-topology.mjs'

describe('pi-ai topology policy', () => {
  it.each([
    ['package overrides', { overrides: { '@earendil-works/pi-ai': '0.83.0' } }],
    ['package resolutions', { resolutions: { '@earendil-works/pi-ai': '0.83.0' } }],
    ['pnpm overrides', { pnpm: { overrides: { '@earendil-works/pi-ai': '0.83.0' } } }],
    ['pnpm resolutions', { pnpm: { resolutions: { '@earendil-works/pi-ai': '0.83.0' } } }],
  ])('rejects %s selectors in manifests', (_label, manifest) => {
    expect(() => assertNoPiAiSelectorsInManifest(manifest, 'fixture package.json')).toThrow('pi-ai selector')
  })

  it('rejects pi-ai selectors in workspace and lock override maps', () => {
    const workspace = [
      'overrides:',
      "  '@earendil-works/pi-ai': 0.83.0",
    ].join('\n')
    const lock = [
      'lockfileVersion: \'9.0\'',
      'overrides:',
      "  '@earendil-works/pi-ai': 0.83.0",
    ].join('\n')
    expect(() => assertNoPiAiSelectorsInWorkspace(workspace, 'fixture workspace')).toThrow('pi-ai selector')
    expect(() => assertNoPiAiSelectorsInLock(lock, 'fixture lock')).toThrow('pi-ai selector')
  })

  it.each([
    'pi-ai',
    'pi-ai@0.83.0',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-ai@0.83.0',
    'parent>pi-ai',
    'parent>@earendil-works/pi-ai@0.83.0',
    'npm:pi-ai@0.83.0',
    'npm:@earendil-works/pi-ai@0.83.0',
    '**/pi-ai',
    '**/@earendil-works/pi-ai',
    'parent/pi-ai',
    'parent/@earendil-works/pi-ai@^0.83.0',
  ])('recognizes a complete pi-ai package token in %s', (selector) => {
    expect(isPiAiSelector(selector)).toBe(true)
    expect(() => assertNoPiAiSelectorsInManifest({ overrides: { [selector]: '0.83.0' } })).toThrow(
      'pi-ai selector',
    )
  })

  it.each([
    '@deepseek-ai/dsh-llm-pi-ai',
    '@deepseek-ai/dsh-llm-pi-ai@0.1.1-rc.1',
    'parent>@deepseek-ai/dsh-llm-pi-ai',
    'parent/@deepseek-ai/dsh-llm-pi-ai',
    'not-pi-ai',
  ])('does not reject a non-pi-ai package token %s', (selector) => {
    expect(isPiAiSelector(selector)).toBe(false)
    expect(() => assertNoPiAiSelectorsInManifest({ overrides: { [selector]: '0.1.1-rc.1' } })).not.toThrow()
  })

  it('rejects complex selectors in every manifest, workspace, and lock override location', () => {
    const selectors = [
      'parent>pi-ai@0.83.0',
      'parent/@earendil-works/pi-ai',
      '**/@earendil-works/pi-ai@0.83.0',
    ]
    for (const selector of selectors) {
      for (const field of ['overrides', 'resolutions']) {
        expect(() => assertNoPiAiSelectorsInManifest({ [field]: { [selector]: '0.83.0' } })).toThrow(
          'pi-ai selector',
        )
        expect(() => assertNoPiAiSelectorsInManifest({ pnpm: { [field]: { [selector]: '0.83.0' } } })).toThrow(
          'pi-ai selector',
        )
        const workspace = `${field}:\n  '${selector}': 0.83.0`
        const lock = `lockfileVersion: '9.0'\n${field}:\n  '${selector}': 0.83.0`
        expect(() => assertNoPiAiSelectorsInWorkspace(workspace)).toThrow('pi-ai selector')
        expect(() => assertNoPiAiSelectorsInLock(lock)).toThrow('pi-ai selector')
      }
    }
  })

  it('recurses through nested maps and arrays', () => {
    expect(() => assertNoPiAiSelectorsInManifest({
      overrides: [{ nested: { '**/pi-ai@0.83.0': '0.83.0' } }],
    })).toThrow('pi-ai selector')
  })

  it('checks all manifest, workspace, and lock locations together', () => {
    expect(() => assertNoPiAiTopology({
      manifests: [{ label: 'repository', manifest: {} }, { label: 'plugin', manifest: {} }],
      workspaces: [{ label: 'repository workspace', text: 'overrides: {}' }],
      locks: [{ label: 'repository lock', text: 'lockfileVersion: \'9.0\'\noverrides: {}' }],
    })).not.toThrow()
  })

  it('does not confuse the DSH adapter package with a pi-ai override', () => {
    expect(() => assertNoPiAiSelectorsInWorkspace([
      'overrides:',
      "  '@deepseek-ai/dsh-llm-pi-ai': 0.1.1-rc.1",
    ].join('\n'))).not.toThrow()
  })

  it('accepts every committed DSH release-family override', async () => {
    const [workspaceText, lockText] = await Promise.all([
      readFile(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8'),
      readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8'),
    ])
    expect(() => assertNoPiAiTopology({
      workspaces: [{ label: 'workspace', text: workspaceText }],
      locks: [{ label: 'lock', text: lockText }],
    })).not.toThrow()
  })

  it('keeps repository and store paths out of the external topology report', () => {
    const report = formatOpaquePiAiTopology({
      resolutions: {
        hostRoot: { directory: '/private/repository/node_modules/pi-ai', version: '0.82.1' },
        hostAdapter: { directory: '/private/store/pi-ai', version: '0.82.1' },
        plugin: { directory: '/private/profile/node_modules/pi-ai', version: '0.82.1' },
      },
      additional: [{ directory: '/private/store/unused', version: '0.82.1' }],
    })
    const printable = JSON.stringify(report)
    expect(printable).not.toContain('/private/')
    expect(report.piAiResolutions).toEqual({
      hostRoot: 'copy-2@0.82.1',
      hostAdapter: 'copy-3@0.82.1',
      plugin: 'copy-1@0.82.1',
    })
    expect(report.additionalPiAiStoreIdentities).toEqual(['additional-1@0.82.1'])
  })

  it('fails closed when report-only mode is missing its spike opt-in or runs in a restricted environment', () => {
    const script = fileURLToPath(new URL('../scripts/packed-install.mjs', import.meta.url))
    const checkoutRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/u, '')
    const cases = [
      {
        name: 'missing spike opt-in',
        PACKED_INSTALL_TOPOLOGY_REPORT: '1',
        PACKED_INSTALL_COMPATIBILITY_SPIKE: '0',
      },
      {
        name: 'CI',
        PACKED_INSTALL_TOPOLOGY_REPORT: '1',
        PACKED_INSTALL_COMPATIBILITY_SPIKE: '1',
        CI: 'true',
      },
      {
        name: 'GitHub Actions',
        PACKED_INSTALL_TOPOLOGY_REPORT: '1',
        PACKED_INSTALL_COMPATIBILITY_SPIKE: '1',
        GITHUB_ACTIONS: 'true',
      },
      {
        name: 'release',
        PACKED_INSTALL_TOPOLOGY_REPORT: '1',
        PACKED_INSTALL_COMPATIBILITY_SPIKE: '1',
        RELEASE: '1',
      },
      {
        name: 'production',
        PACKED_INSTALL_TOPOLOGY_REPORT: '1',
        PACKED_INSTALL_COMPATIBILITY_SPIKE: '1',
        NODE_ENV: 'production',
      },
    ]
    for (const { name, ...overrides } of cases) {
      const result = spawnSync(process.execPath, [script], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, ...overrides },
        encoding: 'utf8',
      })
      expect(result.status, name).not.toBe(0)
      const output = `${result.stdout}\n${result.stderr}`
      expect(output, name).toContain('PACKED_INSTALL_TOPOLOGY_REPORT requires')
      expect(output, name).toMatch(/^\s*packed-install failed:/mu)
      for (const forbidden of [
        checkoutRoot,
        'node_modules',
        'dsh-codex-sub-packed-install-',
        'at file://',
      ]) {
        expect(output, `${name} leaked ${forbidden}`).not.toContain(forbidden)
      }
    }
  })
})
