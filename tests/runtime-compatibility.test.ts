import { describe, expect, it } from 'vitest'

import { CodexError } from '../src/core/errors.js'
import {
  assertRuntimeCompatible,
  evaluateRuntimeCompatibility,
  inspectInstalledRuntime,
  matchesNodeRange,
} from '../src/dsh/compatibility.js'

const SUPPORTED_PACKAGES = Object.freeze({
  '@deepseek-ai/cordis': '4.0.1',
  '@deepseek-ai/dsh-llm': '0.1.0-rc.7',
  '@deepseek-ai/dsh-llm-pi-ai': '0.1.0-rc.7',
  '@deepseek-ai/dsh-attachment': '0.1.0-rc.7',
  '@deepseek-ai/dsh-atomic-write': '0.1.0-rc.7',
  '@deepseek-ai/dsh-home-paths': '0.1.0-rc.7',
  '@earendil-works/pi-ai': '0.82.1',
})

describe('runtime compatibility', () => {
  it('evaluates the supported Node range without optimistic major-version gaps', () => {
    expect(matchesNodeRange('22.19.0', '^22.19.0 || >=24.0.0')).toBe(true)
    expect(matchesNodeRange('22.99.0', '^22.19.0 || >=24.0.0')).toBe(true)
    expect(matchesNodeRange('22.18.9', '^22.19.0 || >=24.0.0')).toBe(false)
    expect(matchesNodeRange('23.9.0', '^22.19.0 || >=24.0.0')).toBe(false)
    expect(matchesNodeRange('24.0.0', '^22.19.0 || >=24.0.0')).toBe(true)
    expect(matchesNodeRange('26.1.0', '^22.19.0 || >=24.0.0')).toBe(true)
    expect(matchesNodeRange('invalid', '^22.19.0 || >=24.0.0')).toBe(false)
  })

  it('reports the exact pinned package combination as compatible', () => {
    const report = evaluateRuntimeCompatibility({
      node: '24.0.0',
      packages: SUPPORTED_PACKAGES,
    })

    expect(report.compatible).toBe(true)
    expect(report.node.status).toBe('compatible')
    expect(report.packages).toEqual(
      Object.fromEntries(
        Object.entries(SUPPORTED_PACKAGES).map(([name, version]) => [
          name,
          { supported: version, installed: version, status: 'compatible' },
        ]),
      ),
    )
  })

  it.each([
    ['missing', null],
    ['mismatched', '0.1.0-rc.8'],
  ] as const)('fails closed for a %s runtime package', (_label, version) => {
    const packages = { ...SUPPORTED_PACKAGES, '@deepseek-ai/dsh-llm': version }

    expect(() => assertRuntimeCompatible({ node: '24.0.0', packages })).toThrowError(
      expect.objectContaining({
        code: 'CODEX_INCOMPATIBLE_RUNTIME',
        safeDetails: {
          packageName: '@deepseek-ai/dsh-llm',
          supported: '0.1.0-rc.7',
          installed: version ?? 'unknown',
        },
      }),
    )
  })

  it('keeps package resolution paths out of printable compatibility failures', () => {
    let failure: unknown
    try {
      assertRuntimeCompatible({
        node: '23.0.0',
        packages: SUPPORTED_PACKAGES,
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(CodexError)
    expect(String(failure)).not.toContain('/Users/')
    expect(JSON.stringify(failure)).not.toContain('node_modules')
  })

  it('recognizes the installed test runtime through package metadata only', () => {
    const snapshot = inspectInstalledRuntime()
    expect(snapshot.packages).toEqual(SUPPORTED_PACKAGES)
    expect(assertRuntimeCompatible(snapshot).compatible).toBe(true)
  })
})
