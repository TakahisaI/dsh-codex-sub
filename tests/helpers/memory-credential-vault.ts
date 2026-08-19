import type {
  CodexCredentialVault,
  CredentialVaultInspection,
} from '../../src/core/contracts.js'
import {
  decodeCredentialDocument,
  encodeCredentialDocument,
} from '../../src/core/credential-document.js'
import type { CodexCredentialDocument } from '../../src/core/credential-document.js'
import { CodexError, isCodexError } from '../../src/core/errors.js'

function cloneDocument(
  document: CodexCredentialDocument | undefined,
): CodexCredentialDocument | undefined {
  return document === undefined
    ? undefined
    : decodeCredentialDocument(encodeCredentialDocument(document))
}

export class MemoryCredentialVault implements CodexCredentialVault {
  activeWriters = 0
  deleteCalls = 0
  maxActiveWriters = 0
  modifyCalls = 0
  readCalls = 0
  afterModify: (() => void) | undefined
  deleteError: unknown
  modifyError: unknown
  readError: unknown
  wrapOperationErrors = false

  #document: CodexCredentialDocument | undefined
  #writerTail: Promise<void> = Promise.resolve()

  constructor(document?: CodexCredentialDocument) {
    this.#document = cloneDocument(document)
  }

  async read(): Promise<CodexCredentialDocument | undefined> {
    this.readCalls += 1
    if (this.readError !== undefined) {
      throw this.readError
    }
    return cloneDocument(this.#document)
  }

  async modify(
    operation: (
      current: CodexCredentialDocument | undefined,
    ) => Promise<CodexCredentialDocument | undefined>,
  ): Promise<CodexCredentialDocument | undefined> {
    this.modifyCalls += 1
    if (this.modifyError !== undefined) {
      throw this.modifyError
    }
    const result = await this.#withWriter(async () => {
      let candidate: CodexCredentialDocument | undefined
      try {
        candidate = await operation(cloneDocument(this.#document))
      } catch (error) {
        if (isCodexError(error) && !this.wrapOperationErrors) {
          throw error
        }
        throw new CodexError('Credential storage is invalid.', 'CODEX_AUTH_STORAGE_INVALID', {
          cause: error,
          safeDetails: { reason: 'operation_failed' },
        })
      }
      if (candidate !== undefined) {
        this.#document = cloneDocument(candidate)
      }
      return cloneDocument(this.#document)
    })
    this.afterModify?.()
    return result
  }

  async delete(): Promise<void> {
    this.deleteCalls += 1
    if (this.deleteError !== undefined) {
      throw this.deleteError
    }
    await this.#withWriter(async () => {
      this.#document = undefined
    })
  }

  async inspect(): Promise<CredentialVaultInspection> {
    return this.#document === undefined
      ? Object.freeze({ state: 'absent', permissions: 'owner-only' })
      : Object.freeze({ state: 'present', formatVersion: 1, permissions: 'owner-only' })
  }

  peek(): CodexCredentialDocument | undefined {
    return cloneDocument(this.#document)
  }

  async #withWriter<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#writerTail
    let release = (): void => undefined
    this.#writerTail = new Promise<void>((resolve) => {
      release = resolve
    })

    await previous
    this.activeWriters += 1
    this.maxActiveWriters = Math.max(this.maxActiveWriters, this.activeWriters)
    try {
      return await operation()
    } finally {
      this.activeWriters -= 1
      release()
    }
  }
}
