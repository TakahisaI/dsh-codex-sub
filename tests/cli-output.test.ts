import { describe, expect, it } from 'vitest'

import { writeJson } from '../src/cli/output.js'
import type { CliIo } from '../src/cli/types.js'
import type { DoctorReportV1 } from '../src/core/contracts.js'

describe('CLI JSON output', () => {
  it('emits one valid document when bounded safe hints contain Unicode', () => {
    let stdout = ''
    const io: CliIo = {
      stdout(text) {
        stdout += text
      },
      stderr() {
        throw new Error('stderr must remain unused')
      },
    }
    const check = {
      supported: '1.0.0',
      installed: '1.0.0',
      status: 'compatible' as const,
    }
    const report: DoctorReportV1 = {
      schemaVersion: 1,
      overall: 'compatible',
      package: { name: 'dsh-codex-sub', version: '1.0.0' },
      runtime: {
        platform: { supported: ['darwin', 'linux'], installed: 'linux', status: 'compatible' },
        node: check,
        packages: { '@example/runtime': check },
      },
      credentialStore: { state: 'absent', permissions: 'unknown' },
      catalog: { provider: 'openai-codex', modelCount: 1 },
      hints: ['認証状態を確認してください。'],
    }

    writeJson(io, report)

    expect(JSON.parse(stdout)).toEqual(report)
    expect(stdout.trim().split('\n')).toHaveLength(1)
    expect(stdout.endsWith('\n')).toBe(true)
  })
})
