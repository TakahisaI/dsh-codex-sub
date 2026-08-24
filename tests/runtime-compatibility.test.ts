import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'

import { CodexError } from '../src/core/errors.js'
import {
  assertRuntimeCompatible,
  assertHostLlmRuntime,
  evaluateRuntimeCompatibility,
  inspectInstalledRuntime,
  matchesNodeRange,
} from '../src/dsh/compatibility.js'

const SUPPORTED_PACKAGES = Object.freeze({
  '@deepseek-ai/cordis': '4.0.1',
  '@deepseek-ai/dsh-llm': '0.1.1-rc.1',
  '@deepseek-ai/dsh-llm-pi-ai': '0.1.1-rc.1',
  '@deepseek-ai/dsh-attachment': '0.1.1-rc.1',
  '@deepseek-ai/dsh-atomic-write': '0.1.1-rc.1',
  '@deepseek-ai/dsh-home-paths': '0.1.1-rc.1',
  '@earendil-works/pi-ai': '0.82.1',
})

class AlternateLlmRuntime extends LlmRuntime {}

describe('runtime compatibility', () => {
  it('evaluates the supported Node range without optimistic major-version gaps', () => {
    const range = '^22.19.0 || ^24.0.0 || ^26.0.0'
    expect(matchesNodeRange('22.19.0', range)).toBe(true)
    expect(matchesNodeRange('22.99.0', range)).toBe(true)
    expect(matchesNodeRange('22.18.9', range)).toBe(false)
    expect(matchesNodeRange('23.9.0', range)).toBe(false)
    expect(matchesNodeRange('24.0.0', range)).toBe(true)
    expect(matchesNodeRange('25.1.0', range)).toBe(false)
    expect(matchesNodeRange('26.1.0', range)).toBe(true)
    expect(matchesNodeRange('27.0.0', range)).toBe(false)
    expect(matchesNodeRange('26.1.0-rc.1', range)).toBe(false)
    expect(matchesNodeRange('invalid', range)).toBe(false)
  })

  it('reports the exact pinned package combination as compatible', () => {
    const report = evaluateRuntimeCompatibility({
      platform: 'linux',
      node: '24.0.0',
      packages: SUPPORTED_PACKAGES,
    })

    expect(report.compatible).toBe(true)
    expect(report.platform).toEqual({
      supported: ['darwin', 'linux'],
      installed: 'linux',
      status: 'compatible',
    })
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
    ['mismatched', '0.1.1-rc.2'],
  ] as const)('fails closed for a %s runtime package', (_label, version) => {
    const packages = { ...SUPPORTED_PACKAGES, '@deepseek-ai/dsh-llm': version }

    expect(() => assertRuntimeCompatible({ platform: 'linux', node: '24.0.0', packages })).toThrowError(
      expect.objectContaining({
        code: 'CODEX_INCOMPATIBLE_RUNTIME',
        safeDetails: {
          packageName: '@deepseek-ai/dsh-llm',
          supported: '0.1.1-rc.1',
          installed: version ?? 'unknown',
        },
      }),
    )
  })

  it('fails closed on an unsupported operating system before package registration', () => {
    expect(() => assertRuntimeCompatible({
      platform: 'win32',
      node: '24.0.0',
      packages: SUPPORTED_PACKAGES,
    })).toThrowError(expect.objectContaining({
      code: 'CODEX_INCOMPATIBLE_RUNTIME',
      safeDetails: {
        packageName: 'platform',
        supported: 'darwin, linux',
        installed: 'win32',
      },
    }))
  })

  it('keeps package resolution paths out of printable compatibility failures', () => {
    let failure: unknown
    try {
      assertRuntimeCompatible({
        platform: 'linux',
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
    expect(['darwin', 'linux']).toContain(snapshot.platform)
    expect(snapshot.packages).toEqual(SUPPORTED_PACKAGES)
    expect(assertRuntimeCompatible(snapshot).compatible).toBe(true)
  })

  it('ties the accepted host service to the verified dsh-llm module identity', async () => {
    const ctx = new Context()
    const runtimeFiber = ctx.plugin(LlmRuntime)
    await runtimeFiber
    try {
      expect(() => assertHostLlmRuntime(ctx.llm)).not.toThrow()
    } finally {
      await runtimeFiber.dispose()
    }
  })

  it('rejects another host constructor identity even when plugin metadata resolves as verified', async () => {
    expect(inspectInstalledRuntime().packages['@deepseek-ai/dsh-llm']).toBe('0.1.1-rc.1')

    const ctx = new Context()
    const runtimeFiber = ctx.plugin(AlternateLlmRuntime)
    await runtimeFiber
    try {
      expect(() => assertHostLlmRuntime(ctx.llm)).toThrowError(expect.objectContaining({
        code: 'CODEX_INCOMPATIBLE_RUNTIME',
        safeDetails: {
          packageName: '@deepseek-ai/dsh-llm:host',
          supported: '0.1.1-rc.1',
          installed: 'unverified',
        },
      }))
    } finally {
      await runtimeFiber.dispose()
    }
  })
})
