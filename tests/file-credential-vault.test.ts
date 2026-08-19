import { randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'

import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MAX_CREDENTIAL_DOCUMENT_BYTES,
  decodeCredentialDocument,
  encodeCredentialDocument,
} from '../src/core/credential-document.js'
import type { CodexCredentialDocument } from '../src/core/credential-document.js'
import { CodexError } from '../src/core/errors.js'
import { FileCredentialVault } from '../src/storage/file-credential-vault.js'

const IS_WINDOWS = process.platform === 'win32'
const ORIGINAL_DSH_HOME = process.env['DSH_HOME']

interface CredentialFixture {
  readonly document: CodexCredentialDocument
  readonly sentinels: readonly string[]
}

let temporaryRoot = ''
let dshHome = ''
let pathSentinel = ''

function storageDirectory(): string {
  return join(dshHome, 'dsh-codex-sub')
}

function storageDocument(): string {
  return join(storageDirectory(), 'auth.json')
}

function makeCredential(sequence = 0): CredentialFixture {
  const accessToken = `ACCESS_SENTINEL_${randomUUID()}`
  const refreshToken = `REFRESH_SENTINEL_${randomUUID()}`
  const accountId = `ACCOUNT_SENTINEL_${randomUUID()}`
  return {
    document: {
      schemaVersion: 1,
      provider: 'openai-codex',
      credential: {
        accessToken,
        refreshToken,
        expiresAt: 1_900_000_000_000,
        providerData: { accountId, sequence },
      },
    },
    sentinels: [accessToken, refreshToken, accountId],
  }
}

function withSequence(
  document: CodexCredentialDocument | undefined,
  sequence: number,
): CodexCredentialDocument {
  if (document === undefined) {
    throw new Error('Test credential is unexpectedly absent.')
  }
  return {
    ...document,
    credential: {
      ...document.credential,
      providerData: {
        ...document.credential.providerData,
        sequence,
      },
    },
  }
}

function sequenceOf(document: CodexCredentialDocument | undefined): number {
  if (document === undefined) {
    throw new Error('Test credential is unexpectedly absent.')
  }
  const sequence = document.credential.providerData['sequence']
  if (typeof sequence !== 'number') {
    throw new Error('Test credential sequence is invalid.')
  }
  return sequence
}

function printableError(error: CodexError): string {
  return [
    String(error),
    error.stack ?? '',
    JSON.stringify(error),
    inspect(error),
  ].join('\n')
}

async function expectSafeFailure(
  operation: Promise<unknown>,
  sentinels: readonly string[],
  expectedCode?: CodexError['code'],
): Promise<CodexError> {
  try {
    await operation
  } catch (error) {
    expect(error).toBeInstanceOf(CodexError)
    const codexError = error as CodexError
    if (expectedCode !== undefined) {
      expect(codexError.code).toBe(expectedCode)
    }
    const printable = printableError(codexError)
    for (const sentinel of [...sentinels, pathSentinel, dshHome]) {
      expect(printable).not.toContain(sentinel)
    }
    return codexError
  }
  throw new Error('Expected the storage operation to fail.')
}

async function createSecureDirectory(): Promise<void> {
  await mkdir(storageDirectory(), { mode: 0o700, recursive: true })
  if (!IS_WINDOWS) {
    await chmod(storageDirectory(), 0o700)
  }
}

async function writeStoredDocument(content: string | Uint8Array): Promise<void> {
  await createSecureDirectory()
  await writeFile(storageDocument(), content, { mode: 0o600 })
  if (!IS_WINDOWS) {
    await chmod(storageDocument(), 0o600)
  }
}

beforeEach(async () => {
  pathSentinel = `PATH_SENTINEL_${randomUUID()}`
  temporaryRoot = await mkdtemp(join(tmpdir(), `${pathSentinel}_`))
  dshHome = join(temporaryRoot, 'dsh-home')
  process.env['DSH_HOME'] = dshHome
})

afterEach(async () => {
  if (ORIGINAL_DSH_HOME === undefined) {
    delete process.env['DSH_HOME']
  } else {
    process.env['DSH_HOME'] = ORIGINAL_DSH_HOME
  }
  await rm(temporaryRoot, { force: true, recursive: true })
})

describe('FileCredentialVault', () => {
  it('reports a missing document and deletes it idempotently without creating storage', async () => {
    const vault = new FileCredentialVault()

    await expect(vault.read()).resolves.toBeUndefined()
    await expect(vault.delete()).resolves.toBeUndefined()
    await expect(vault.inspect()).resolves.toEqual({
      state: 'absent',
      permissions: IS_WINDOWS ? 'unsupported' : 'unknown',
    })
    await expect(lstat(storageDirectory())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('creates, reads, inspects, modifies, and deletes one fixed-path document', async () => {
    const initial = makeCredential(1)
    const vault = new FileCredentialVault()

    const created = await vault.modify(async (current) => {
      expect(current).toBeUndefined()
      return initial.document
    })

    expect(created).toEqual(initial.document)
    expect(created).not.toBe(initial.document)
    await expect(vault.read()).resolves.toEqual(initial.document)
    await expect(vault.inspect()).resolves.toEqual({
      state: 'present',
      formatVersion: 1,
      permissions: IS_WINDOWS ? 'unsupported' : 'owner-only',
    })

    const modified = await vault.modify(async (current) => withSequence(current, 2))
    expect(sequenceOf(modified)).toBe(2)
    expect(sequenceOf(await vault.read())).toBe(2)

    if (!IS_WINDOWS) {
      expect((await lstat(storageDirectory())).mode & 0o777).toBe(0o700)
      expect((await lstat(storageDocument())).mode & 0o777).toBe(0o600)
    }

    await vault.delete()
    await vault.delete()
    await expect(vault.read()).resolves.toBeUndefined()
    await expect(vault.inspect()).resolves.toEqual({
      state: 'absent',
      permissions: IS_WINDOWS ? 'unsupported' : 'owner-only',
    })
  })

  it.runIf(!IS_WINDOWS)('stamps exact creation modes under a restrictive process umask', async () => {
    const fixture = makeCredential(1)
    await mkdir(dshHome, { mode: 0o700, recursive: true })
    await chmod(dshHome, 0o700)
    const originalUmask = process.umask(0o777)
    try {
      const vault = new FileCredentialVault()
      await vault.modify(async () => fixture.document)
    } finally {
      process.umask(originalUmask)
    }

    expect((await lstat(storageDirectory())).mode & 0o777).toBe(0o700)
    expect((await lstat(storageDocument())).mode & 0o777).toBe(0o600)
    await expect(new FileCredentialVault().read()).resolves.toEqual(fixture.document)
  })

  it('detaches and freezes operation input, read results, and modify results', async () => {
    const fixture = makeCredential(1)
    const vault = new FileCredentialVault()
    await vault.modify(async () => fixture.document)

    const firstRead = await vault.read()
    const secondRead = await vault.read()
    expect(firstRead).not.toBe(secondRead)
    expect(firstRead?.credential.providerData).not.toBe(secondRead?.credential.providerData)
    expect(Object.isFrozen(firstRead)).toBe(true)
    expect(Object.isFrozen(firstRead?.credential)).toBe(true)
    expect(Object.isFrozen(firstRead?.credential.providerData)).toBe(true)

    let operationInput: CodexCredentialDocument | undefined
    const unchanged = await vault.modify(async (current) => {
      operationInput = current
      return undefined
    })
    expect(operationInput).toEqual(fixture.document)
    expect(unchanged).toEqual(fixture.document)
    expect(unchanged).not.toBe(operationInput)
    expect(unchanged?.credential.providerData).not.toBe(operationInput?.credential.providerData)
  })

  it('rejects a package-directory symbolic link', async () => {
    const fixture = makeCredential(1)
    const target = join(temporaryRoot, 'directory-target')
    await mkdir(dshHome, { mode: 0o700, recursive: true })
    await mkdir(target, { mode: 0o700 })
    await symlink(target, storageDirectory(), 'dir')
    const vault = new FileCredentialVault()

    await expect(vault.inspect()).resolves.toEqual({
      state: 'insecure',
      permissions: 'insecure',
    })
    await expectSafeFailure(
      vault.read(),
      fixture.sentinels,
      'CODEX_AUTH_STORAGE_INSECURE',
    )
    await expectSafeFailure(
      vault.modify(async () => fixture.document),
      fixture.sentinels,
      'CODEX_AUTH_STORAGE_INSECURE',
    )
    await expect(readFile(join(target, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an auth-document symbolic link without reading its target', async () => {
    const fixture = makeCredential(1)
    const target = join(temporaryRoot, 'document-target')
    await createSecureDirectory()
    await writeFile(target, encodeCredentialDocument(fixture.document), { mode: 0o600 })
    await symlink(target, storageDocument(), 'file')
    const vault = new FileCredentialVault()

    await expect(vault.inspect()).resolves.toEqual({
      state: 'insecure',
      permissions: 'insecure',
    })
    await expectSafeFailure(
      vault.read(),
      fixture.sentinels,
      'CODEX_AUTH_STORAGE_INSECURE',
    )
    await expectSafeFailure(
      vault.delete(),
      fixture.sentinels,
      'CODEX_AUTH_STORAGE_INSECURE',
    )
    await expect(readFile(target, 'utf8')).resolves.toBe(encodeCredentialDocument(fixture.document))
  })

  it.runIf(!IS_WINDOWS)('rejects group/other permissions on the directory and document', async () => {
    const fixture = makeCredential(1)
    const vault = new FileCredentialVault()
    await writeStoredDocument(encodeCredentialDocument(fixture.document))

    await chmod(storageDocument(), 0o644)
    await expect(vault.inspect()).resolves.toEqual({
      state: 'insecure',
      permissions: 'insecure',
    })
    await expectSafeFailure(
      vault.read(),
      fixture.sentinels,
      'CODEX_AUTH_STORAGE_INSECURE',
    )

    await chmod(storageDocument(), 0o600)
    await chmod(storageDirectory(), 0o755)
    await expect(vault.inspect()).resolves.toEqual({
      state: 'insecure',
      permissions: 'insecure',
    })
    await expectSafeFailure(
      vault.delete(),
      fixture.sentinels,
      'CODEX_AUTH_STORAGE_INSECURE',
    )
  })

  it('classifies malformed and unsupported documents without exposing their contents', async () => {
    const fixture = makeCredential(1)
    const malformed = `{"credential":{"accessToken":"${fixture.document.credential.accessToken}"}`
    await writeStoredDocument(malformed)
    const vault = new FileCredentialVault()

    await expect(vault.inspect()).resolves.toEqual({
      state: 'invalid',
      permissions: IS_WINDOWS ? 'unsupported' : 'owner-only',
    })
    await expectSafeFailure(
      vault.read(),
      fixture.sentinels,
      'CODEX_AUTH_STORAGE_INVALID',
    )

    const unsupported = {
      ...fixture.document,
      schemaVersion: 2,
    }
    await writeStoredDocument(JSON.stringify(unsupported))
    await expect(vault.inspect()).resolves.toEqual({
      state: 'invalid',
      permissions: IS_WINDOWS ? 'unsupported' : 'owner-only',
    })
    await expectSafeFailure(
      vault.read(),
      fixture.sentinels,
      'CODEX_AUTH_STORAGE_INVALID',
    )
  })

  it('reads only the bounded credential budget and rejects invalid UTF-8', async () => {
    const vault = new FileCredentialVault()
    await writeStoredDocument(' '.repeat(MAX_CREDENTIAL_DOCUMENT_BYTES + 1))
    const oversized = await expectSafeFailure(
      vault.read(),
      [],
      'CODEX_AUTH_STORAGE_INVALID',
    )
    expect(oversized.safeDetails).toEqual({ reason: 'max_bytes' })
    await expect(vault.inspect()).resolves.toMatchObject({ state: 'invalid' })

    await writeStoredDocument(Uint8Array.from([0x7b, 0x22, 0xff, 0x22, 0x7d]))
    const invalidEncoding = await expectSafeFailure(
      vault.read(),
      [],
      'CODEX_AUTH_STORAGE_INVALID',
    )
    expect(invalidEncoding.safeDetails).toEqual({ reason: 'invalid_encoding' })
  })

  it.runIf(!IS_WINDOWS)('classifies an unreadable owner-only document without exposing its path', async () => {
    const fixture = makeCredential(1)
    await writeStoredDocument(encodeCredentialDocument(fixture.document))
    await chmod(storageDocument(), 0o000)
    const vault = new FileCredentialVault()

    await expect(vault.inspect()).resolves.toEqual({
      state: 'unreadable',
      permissions: 'owner-only',
    })
    const error = await expectSafeFailure(
      vault.read(),
      fixture.sentinels,
      'CODEX_AUTH_STORAGE_INVALID',
    )
    expect(error.safeDetails).toEqual({ reason: 'unreadable' })
  })

  it('serializes concurrent modifies across vault instances', async () => {
    const fixture = makeCredential(0)
    const firstVault = new FileCredentialVault()
    const secondVault = new FileCredentialVault()
    await firstVault.modify(async () => fixture.document)

    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const first = firstVault.modify(async (current) => {
      entered.resolve()
      await release.promise
      return withSequence(current, sequenceOf(current) + 1)
    })
    await entered.promise

    let secondEntered = false
    const second = secondVault.modify(async (current) => {
      secondEntered = true
      return withSequence(current, sequenceOf(current) + 1)
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(secondEntered).toBe(false)

    release.resolve()
    await Promise.all([first, second])
    expect(sequenceOf(await firstVault.read())).toBe(2)
  })

  it('serializes delete after an in-flight modify so credentials are not resurrected', async () => {
    const fixture = makeCredential(0)
    const modifyingVault = new FileCredentialVault()
    const deletingVault = new FileCredentialVault()
    await modifyingVault.modify(async () => fixture.document)

    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const modify = modifyingVault.modify(async (current) => {
      entered.resolve()
      await release.promise
      return withSequence(current, 1)
    })
    await entered.promise
    const deletion = deletingVault.delete()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await expect(lstat(storageDocument())).resolves.toMatchObject({
      mode: expect.any(Number),
    })

    release.resolve()
    await Promise.all([modify, deletion])
    await expect(modifyingVault.read()).resolves.toBeUndefined()
  })

  it('fails a timed-out lock waiter without exposing the lock path', async () => {
    const fixture = makeCredential(0)
    const holdingVault = new FileCredentialVault()
    const waitingVault = new FileCredentialVault()
    await holdingVault.modify(async () => fixture.document)

    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const holdingModify = holdingVault.modify(async (current) => {
      entered.resolve()
      await release.promise
      return withSequence(current, 1)
    })
    await entered.promise

    try {
      const error = await expectSafeFailure(
        waitingVault.delete(),
        fixture.sentinels,
        'CODEX_AUTH_STORAGE_INVALID',
      )
      expect(error.safeDetails).toEqual({ reason: 'lock_failed' })
    } finally {
      release.resolve()
      await holdingModify
    }

    expect(sequenceOf(await holdingVault.read())).toBe(1)
  }, 10_000)

  it('preserves the committed document when the callback rejects or its candidate is invalid', async () => {
    const fixture = makeCredential(1)
    const callbackSentinel = `CODE_SENTINEL_${randomUUID()}`
    const vault = new FileCredentialVault()
    await vault.modify(async () => fixture.document)

    const callbackError = await expectSafeFailure(
      vault.modify(async () => {
        throw new Error(callbackSentinel)
      }),
      [...fixture.sentinels, callbackSentinel],
      'CODEX_AUTH_STORAGE_INVALID',
    )
    expect(callbackError.safeDetails).toEqual({ reason: 'operation_failed' })
    await expect(vault.read()).resolves.toEqual(fixture.document)

    const invalidCandidate = {
      ...fixture.document,
      credential: {
        ...fixture.document.credential,
        accessToken: '',
      },
    } as CodexCredentialDocument
    await expectSafeFailure(
      vault.modify(async () => invalidCandidate),
      fixture.sentinels,
      'CODEX_AUTH_STORAGE_INVALID',
    )
    await expect(vault.read()).resolves.toEqual(fixture.document)
  })

  it.each(['before', 'after'] as const)(
    'leaves only an old or new valid document when atomic publication fails %s commit',
    async (failurePoint) => {
      const initial = makeCredential(1)
      const replacement = makeCredential(2)
      const publicationSentinel = `REFRESH_SENTINEL_${randomUUID()}`
      const setupVault = new FileCredentialVault()
      await setupVault.modify(async () => initial.document)

      const failingVault = new FileCredentialVault({
        atomicWriter: async (filename, content, options) => {
          if (failurePoint === 'after') {
            await writeFileAtomic(filename, content, options)
          }
          throw new Error(publicationSentinel)
        },
      })
      const error = await expectSafeFailure(
        failingVault.modify(async () => replacement.document),
        [...initial.sentinels, ...replacement.sentinels, publicationSentinel],
        'CODEX_AUTH_STORAGE_INVALID',
      )
      expect(error.safeDetails).toEqual({ reason: 'publication_failed' })

      const serialized = await readFile(storageDocument(), 'utf8')
      const committed = decodeCredentialDocument(serialized)
      expect([initial.document, replacement.document]).toContainEqual(committed)
      if (failurePoint === 'before') {
        expect(committed).toEqual(initial.document)
      } else {
        expect(committed).toEqual(replacement.document)
      }
    },
  )
})
