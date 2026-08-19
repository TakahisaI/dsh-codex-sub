import { describe, expect, it } from 'vitest'

import type {
  CredentialVaultInspection,
  PlatformCheck,
  VersionCheck,
} from '../src/core/contracts.js'
import type { RuntimeCompatibilityReport } from '../src/dsh/compatibility.js'
import {
  createDoctorReport,
  createStatusReport,
} from '../src/cli/reports.js'

const PACKAGE_VERSION = '1.2.3-test'

function versionCheck(
  installed: string | null,
  status: VersionCheck['status'] = 'compatible',
): VersionCheck {
  return Object.freeze({
    supported: installed ?? 'expected-version',
    installed,
    status,
  })
}

function runtime(
  overrides: {
    readonly platform?: PlatformCheck
    readonly node?: VersionCheck
    readonly packages?: Readonly<Record<string, VersionCheck>>
  } = {},
): RuntimeCompatibilityReport {
  const node = overrides.node ?? versionCheck('24.0.0')
  const platform = overrides.platform ?? Object.freeze({
    supported: Object.freeze(['darwin', 'linux']),
    installed: 'linux',
    status: 'compatible' as const,
  })
  const packages = overrides.packages ?? Object.freeze({
    '@deepseek-ai/cordis': versionCheck('4.0.1'),
    '@deepseek-ai/dsh-llm': versionCheck('0.1.0-rc.7'),
    '@deepseek-ai/dsh-llm-pi-ai': versionCheck('0.1.0-rc.7'),
    '@deepseek-ai/dsh-attachment': versionCheck('0.1.0-rc.7'),
    '@deepseek-ai/dsh-atomic-write': versionCheck('0.1.0-rc.7'),
    '@deepseek-ai/dsh-home-paths': versionCheck('0.1.0-rc.7'),
    '@earendil-works/pi-ai': versionCheck('0.82.1'),
  })
  const checks = [node, ...Object.values(packages)]
  return Object.freeze({
    compatible: platform.status === 'compatible'
      && checks.every((check) => check.status === 'compatible'),
    platform,
    node,
    packages,
  })
}

function runtimeWithPackage(packageName: string, check: VersionCheck): RuntimeCompatibilityReport {
  const base = runtime()
  return runtime({
    packages: Object.freeze({ ...base.packages, [packageName]: check }),
  })
}

function inspection(
  state: CredentialVaultInspection['state'],
  permissions: CredentialVaultInspection['permissions'],
): CredentialVaultInspection {
  return Object.freeze({ state, permissions })
}

describe('CLI report projections', () => {
  it('creates the exact versioned status schema', () => {
    const report = createStatusReport(PACKAGE_VERSION, {
      state: 'signed-in',
      refreshExpected: true,
    })

    expect(report).toEqual({
      schemaVersion: 1,
      package: { name: 'dsh-codex-sub', version: PACKAGE_VERSION },
      provider: 'openai-codex',
      status: { state: 'signed-in', refreshExpected: true },
    })
    expect(Object.isFrozen(report)).toBe(true)
  })

  it('creates a deterministic compatible doctor report without credential contents', () => {
    const report = createDoctorReport({
      version: PACKAGE_VERSION,
      runtime: runtime(),
      credentialStore: inspection('absent', 'unknown'),
      modelCount: 7,
    })

    expect(report).toEqual({
      schemaVersion: 1,
      overall: 'compatible',
      package: { name: 'dsh-codex-sub', version: PACKAGE_VERSION },
      runtime: {
        platform: {
          supported: ['darwin', 'linux'],
          installed: 'linux',
          status: 'compatible',
        },
        node: { supported: '24.0.0', installed: '24.0.0', status: 'compatible' },
        packages: {
          '@deepseek-ai/cordis': {
            supported: '4.0.1',
            installed: '4.0.1',
            status: 'compatible',
          },
          '@deepseek-ai/dsh-llm': {
            supported: '0.1.0-rc.7',
            installed: '0.1.0-rc.7',
            status: 'compatible',
          },
          '@deepseek-ai/dsh-llm-pi-ai': {
            supported: '0.1.0-rc.7',
            installed: '0.1.0-rc.7',
            status: 'compatible',
          },
          '@deepseek-ai/dsh-attachment': {
            supported: '0.1.0-rc.7',
            installed: '0.1.0-rc.7',
            status: 'compatible',
          },
          '@deepseek-ai/dsh-atomic-write': {
            supported: '0.1.0-rc.7',
            installed: '0.1.0-rc.7',
            status: 'compatible',
          },
          '@deepseek-ai/dsh-home-paths': {
            supported: '0.1.0-rc.7',
            installed: '0.1.0-rc.7',
            status: 'compatible',
          },
          '@earendil-works/pi-ai': {
            supported: '0.82.1',
            installed: '0.82.1',
            status: 'compatible',
          },
        },
      },
      credentialStore: { state: 'absent', permissions: 'unknown' },
      catalog: { provider: 'openai-codex', modelCount: 7 },
      hints: ['Run dsh-codex-sub login to authenticate this package.'],
    })
    expect(JSON.stringify(report)).toBe(JSON.stringify(createDoctorReport({
      version: PACKAGE_VERSION,
      runtime: runtime(),
      credentialStore: inspection('absent', 'unknown'),
      modelCount: 7,
    })))
  })

  it.each([
    [
      'incompatible',
      runtimeWithPackage(
        '@deepseek-ai/dsh-llm',
        versionCheck('0.1.0-rc.8', 'incompatible'),
      ),
      inspection('present', 'owner-only'),
      7,
    ],
    [
      'unknown',
      runtimeWithPackage('@earendil-works/pi-ai', versionCheck(null, 'unknown')),
      inspection('present', 'owner-only'),
      7,
    ],
    ['degraded', runtime(), inspection('invalid', 'unknown'), 7],
    ['degraded', runtime(), inspection('present', 'unsupported'), 7],
    ['degraded', runtime(), inspection('present', 'owner-only'), 0],
  ] as const)('classifies %s doctor results', (overall, runtimeReport, store, modelCount) => {
    expect(createDoctorReport({
      version: PACKAGE_VERSION,
      runtime: runtimeReport,
      credentialStore: store,
      modelCount,
    }).overall).toBe(overall)
  })

  it('surfaces every verified package used in the overall runtime classification', () => {
    const runtimeWithCordisMismatch = runtimeWithPackage(
      '@deepseek-ai/cordis',
      { supported: '4.0.1', installed: '4.0.2', status: 'incompatible' },
    )

    const report = createDoctorReport({
      version: PACKAGE_VERSION,
      runtime: runtimeWithCordisMismatch,
      credentialStore: inspection('present', 'owner-only'),
      modelCount: 7,
    })

    expect(report.overall).toBe('incompatible')
    expect(report.runtime.packages['@deepseek-ai/cordis']).toEqual({
      supported: '4.0.1',
      installed: '4.0.2',
      status: 'incompatible',
    })
    expect(Object.keys(report.runtime.packages)).toEqual([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-llm-pi-ai',
      '@deepseek-ai/dsh-attachment',
      '@deepseek-ai/dsh-atomic-write',
      '@deepseek-ai/dsh-home-paths',
      '@earendil-works/pi-ai',
    ])
    expect(report.hints).toContain('Install the exact runtime versions verified by this package.')
  })

  it('reports an unsupported platform as incompatible with a bounded platform hint', () => {
    const report = createDoctorReport({
      version: PACKAGE_VERSION,
      runtime: runtime({
        platform: {
          supported: ['darwin', 'linux'],
          installed: 'win32',
          status: 'incompatible',
        },
      }),
      credentialStore: inspection('absent', 'unknown'),
      modelCount: 7,
    })

    expect(report.overall).toBe('incompatible')
    expect(report.runtime.platform).toEqual({
      supported: ['darwin', 'linux'],
      installed: 'win32',
      status: 'incompatible',
    })
    expect(report.hints).toContain('Run this package on a supported operating system.')
  })

  it('rejects malformed runtime and catalog projections with fixed safe errors', () => {
    const missingPiAi: RuntimeCompatibilityReport = {
      ...runtime(),
      packages: {},
    }

    expect(() => createDoctorReport({
      version: PACKAGE_VERSION,
      runtime: missingPiAi,
      credentialStore: inspection('absent', 'unknown'),
      modelCount: 7,
    })).toThrowError(expect.objectContaining({ code: 'CODEX_INCOMPATIBLE_RUNTIME' }))
    expect(() => createDoctorReport({
      version: PACKAGE_VERSION,
      runtime: runtime(),
      credentialStore: inspection('absent', 'unknown'),
      modelCount: -1,
    })).toThrowError(expect.objectContaining({ code: 'CODEX_INCOMPATIBLE_RUNTIME' }))
  })
})
