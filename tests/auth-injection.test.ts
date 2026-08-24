import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { PROVIDER_ID } from '../src/core/constants.js'
import { isCodexError } from '../src/core/errors.js'
import { createFailClosedPiAiAuthInjection } from '../src/piai/auth-injection.js'

describe('fail-closed DSH pi-ai auth injection', () => {
  it('reports no native credential without touching package-owned storage', async () => {
    const { credentials } = createFailClosedPiAiAuthInjection()

    await expect(credentials.read(PROVIDER_ID)).resolves.toBeUndefined()
    await expect(credentials.list()).resolves.toEqual([])
  })

  it('reports no native credential for every provider identity', async () => {
    const { credentials } = createFailClosedPiAiAuthInjection()

    await expect(credentials.read('other-provider')).resolves.toBeUndefined()
  })

  it('rejects every native write and logout operation', async () => {
    const { credentials } = createFailClosedPiAiAuthInjection()
    const operation = async (): Promise<undefined> => undefined

    for (const failure of [
      credentials.modify(PROVIDER_ID, operation),
      credentials.delete(PROVIDER_ID),
    ]) {
      const error = await failure.catch((caught: unknown) => caught)
      expect(isCodexError(error)).toBe(true)
      expect(error).toMatchObject({
        code: 'CODEX_UPSTREAM_PROTOCOL',
        safeDetails: { reason: 'native_store_disabled' },
      })
    }
  })

  it('never exposes ambient keys or local credential files', async () => {
    const accessSentinel = `ACCESS_SENTINEL_${randomUUID()}`
    const pathSentinel = `/tmp/${randomUUID()}/credentials`
    const previousValue = process.env['OPENAI_API_KEY']
    process.env['OPENAI_API_KEY'] = accessSentinel
    try {
      const { authContext, credentials } = createFailClosedPiAiAuthInjection()

      expect(await authContext.env('OPENAI_API_KEY')).toBeUndefined()
      expect(await authContext.fileExists(pathSentinel)).toBe(false)

      await expect(credentials.read(`PROVIDER_SENTINEL_${randomUUID()}`)).resolves.toBeUndefined()
      expect(await authContext.env(accessSentinel)).toBeUndefined()
      expect(await authContext.fileExists(accessSentinel)).toBe(false)
    } finally {
      if (previousValue === undefined) {
        delete process.env['OPENAI_API_KEY']
      } else {
        process.env['OPENAI_API_KEY'] = previousValue
      }
    }
  })
})
