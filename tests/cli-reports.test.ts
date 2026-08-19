import { describe, expect, it } from 'vitest'

import type {
  CredentialVaultInspection,
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
  overrides: Partial<Record<'node' | 'dshLlm' | 'dshPiAi' | 'piAi', VersionCheck>> = {},
): RuntimeCompatibilityReport {
  const node = overrides.node ?? versionCheck('24.0.0')
  const dshLlm = overrides.dshLlm ?? versionCheck('0.1.0-rc.7')
  const dshPiAi = overrides.dshPiAi ?? versionCheck('0.1.0-rc.7')
  const piAi = overrides.piAi ?? versionCheck('0.82.1')
  const checks = [node, dshLlm, dshPiAi, piAi]
  return Object.freeze({
    compatible: checks.every((check) => check.status === 'compatible'),
    node,
    packages: Object.freeze({
      '@deepseek-ai/dsh-llm': dshLlm,
      '@deepseek-ai/dsh-llm-pi-ai': dshPiAi,
      '@earendil-works/pi-ai': piAi,
    }),
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
        node: { supported: '24.0.0', installed: '24.0.0', status: 'compatible' },
        dshLlm: {
          supported: '0.1.0-rc.7',
          installed: '0.1.0-rc.7',
          status: 'compatible',
        },
        dshPiAi: {
          supported: '0.1.0-rc.7',
          installed: '0.1.0-rc.7',
          status: 'compatible',
        },
        piAi: { supported: '0.82.1', installed: '0.82.1', status: 'compatible' },
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
      runtime({ dshLlm: versionCheck('0.1.0-rc.8', 'incompatible') }),
      inspection('present', 'owner-only'),
      7,
    ],
    [
      'unknown',
      runtime({ piAi: versionCheck(null, 'unknown') }),
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

  it('includes non-projected verified packages in the overall runtime classification', () => {
    const base = runtime()
    const runtimeWithCordisMismatch: RuntimeCompatibilityReport = {
      ...base,
      compatible: false,
      packages: {
        ...base.packages,
        '@deepseek-ai/cordis': {
          supported: '4.0.1',
          installed: '4.0.2',
          status: 'incompatible',
        },
      },
    }

    const report = createDoctorReport({
      version: PACKAGE_VERSION,
      runtime: runtimeWithCordisMismatch,
      credentialStore: inspection('present', 'owner-only'),
      modelCount: 7,
    })

    expect(report.overall).toBe('incompatible')
    expect(report.hints).toContain('Install the exact runtime versions verified by this package.')
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
