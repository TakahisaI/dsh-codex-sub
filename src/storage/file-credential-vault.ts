import { constants as filesystemConstants } from 'node:fs'
import type { Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, unlink } from 'node:fs/promises'

import {
  withFileLock,
  writeFileAtomic,
} from '@deepseek-ai/dsh-atomic-write'
import type { WriteFileAtomicOptions } from '@deepseek-ai/dsh-atomic-write'

import type {
  CodexCredentialVault,
  CredentialVaultInspection,
} from '../core/contracts.js'
import {
  MAX_CREDENTIAL_DOCUMENT_BYTES,
  decodeCredentialDocument,
  encodeCredentialDocument,
} from '../core/credential-document.js'
import type { CodexCredentialDocument } from '../core/credential-document.js'
import { CodexError, isCodexError } from '../core/errors.js'
import { resolveCredentialStoragePaths } from './auth-path.js'

const AUTH_DIRECTORY_MODE = 0o700
const AUTH_DOCUMENT_MODE = 0o600
const GROUP_OR_OTHER_MODE_BITS = 0o077
const IS_WINDOWS = process.platform === 'win32'
const READ_FLAGS = IS_WINDOWS
  ? filesystemConstants.O_RDONLY
  : filesystemConstants.O_RDONLY | filesystemConstants.O_NOFOLLOW

type AtomicWriter = (
  filename: string,
  content: string,
  options: WriteFileAtomicOptions,
) => Promise<void>

export interface FileCredentialVaultOptions {
  /** Failure-injection seam. Production callers should use the default. */
  readonly atomicWriter?: AtomicWriter
}

function errorHasCode(error: unknown, code: string): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && error.code === code
}

function isMissingError(error: unknown): boolean {
  return errorHasCode(error, 'ENOENT')
}

function storageInvalid(reason: string, cause?: unknown): CodexError {
  return new CodexError('Credential storage is invalid.', 'CODEX_AUTH_STORAGE_INVALID', {
    cause,
    safeDetails: { reason },
  })
}

function storageInsecure(reason: string, cause?: unknown): CodexError {
  return new CodexError('Credential storage is insecure.', 'CODEX_AUTH_STORAGE_INSECURE', {
    cause,
    safeDetails: { reason },
  })
}

function normalizeFailure(error: unknown, reason: string): CodexError {
  return isCodexError(error) ? error : storageInvalid(reason, error)
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if (isMissingError(error)) {
      return undefined
    }
    throw error
  }
}

function assertPrivateMode(metadata: Stats, reason: string): void {
  if (!IS_WINDOWS && (metadata.mode & GROUP_OR_OTHER_MODE_BITS) !== 0) {
    throw storageInsecure(reason)
  }
}

function assertDirectoryMetadata(metadata: Stats): void {
  if (metadata.isSymbolicLink()) {
    throw storageInsecure('directory_symlink')
  }
  if (!metadata.isDirectory()) {
    throw storageInvalid('directory_type')
  }
  assertPrivateMode(metadata, 'directory_permissions')
}

function assertDocumentMetadata(metadata: Stats): void {
  if (metadata.isSymbolicLink()) {
    throw storageInsecure('document_symlink')
  }
  if (!metadata.isFile()) {
    throw storageInvalid('document_type')
  }
  assertPrivateMode(metadata, 'document_permissions')
}

function cloneDocument(
  document: CodexCredentialDocument | undefined,
): CodexCredentialDocument | undefined {
  return document === undefined
    ? undefined
    : decodeCredentialDocument(encodeCredentialDocument(document))
}

function permissionState(): CredentialVaultInspection['permissions'] {
  return IS_WINDOWS ? 'unsupported' : 'owner-only'
}

function inspectionForFailure(
  error: unknown,
  permissions: CredentialVaultInspection['permissions'],
): CredentialVaultInspection {
  if (isCodexError(error)) {
    if (error.code === 'CODEX_AUTH_STORAGE_INSECURE') {
      return Object.freeze({ state: 'insecure', permissions: 'insecure' })
    }
    if (error.safeDetails?.['reason'] === 'unreadable') {
      return Object.freeze({ state: 'unreadable', permissions })
    }
    return Object.freeze({ state: 'invalid', permissions })
  }
  return Object.freeze({ state: 'unreadable', permissions })
}

export class FileCredentialVault implements CodexCredentialVault {
  readonly #directoryPath: string
  readonly #documentPath: string
  readonly #atomicWriter: AtomicWriter

  constructor(options: FileCredentialVaultOptions = {}) {
    const paths = resolveCredentialStoragePaths()
    this.#directoryPath = paths.directory
    this.#documentPath = paths.document
    this.#atomicWriter = options.atomicWriter ?? writeFileAtomic
  }

  async read(): Promise<CodexCredentialDocument | undefined> {
    try {
      const directory = await this.#secureDirectory(false)
      if (directory === undefined) {
        return undefined
      }
      return await this.#readDocument()
    } catch (error) {
      throw normalizeFailure(error, 'unreadable')
    }
  }

  async modify(
    operation: (
      current: CodexCredentialDocument | undefined,
    ) => Promise<CodexCredentialDocument | undefined>,
  ): Promise<CodexCredentialDocument | undefined> {
    try {
      await this.#secureDirectory(true)
      return await withFileLock(this.#documentPath, async () => {
        await this.#requireSecureDirectory()
        const current = await this.#readDocument()
        const operationInput = cloneDocument(current)

        let candidate: CodexCredentialDocument | undefined
        try {
          candidate = await operation(operationInput)
        } catch (error) {
          throw normalizeFailure(error, 'operation_failed')
        }

        if (candidate === undefined) {
          return cloneDocument(current)
        }

        const encoded = encodeCredentialDocument(candidate)
        const normalizedCandidate = decodeCredentialDocument(encoded)

        await this.#requireSecureDirectory()
        const existing = await lstatIfPresent(this.#documentPath)
        if (existing !== undefined) {
          assertDocumentMetadata(existing)
        }

        try {
          await this.#atomicWriter(this.#documentPath, encoded, {
            dirMode: AUTH_DIRECTORY_MODE,
            mode: AUTH_DOCUMENT_MODE,
          })

          await this.#requireSecureDirectory()
          let committed = await lstatIfPresent(this.#documentPath)
          if (committed === undefined) {
            throw storageInvalid('publication_failed')
          }
          assertDocumentMetadata(committed)

          if (!IS_WINDOWS) {
            await chmod(this.#documentPath, AUTH_DOCUMENT_MODE)
            committed = await lstatIfPresent(this.#documentPath)
            if (committed === undefined) {
              throw storageInvalid('publication_failed')
            }
            assertDocumentMetadata(committed)
            if ((committed.mode & 0o777) !== AUTH_DOCUMENT_MODE) {
              throw storageInsecure('document_permissions')
            }
          }
        } catch (error) {
          throw normalizeFailure(error, 'publication_failed')
        }
        return normalizedCandidate
      })
    } catch (error) {
      throw normalizeFailure(error, 'lock_failed')
    }
  }

  async delete(): Promise<void> {
    try {
      const directory = await this.#secureDirectory(false)
      if (directory === undefined) {
        return
      }

      await withFileLock(this.#documentPath, async () => {
        await this.#requireSecureDirectory()
        const existing = await lstatIfPresent(this.#documentPath)
        if (existing === undefined) {
          return
        }
        assertDocumentMetadata(existing)
        try {
          await unlink(this.#documentPath)
        } catch (error) {
          if (!isMissingError(error)) {
            throw normalizeFailure(error, 'delete_failed')
          }
        }
      })
    } catch (error) {
      throw normalizeFailure(error, 'lock_failed')
    }
  }

  async inspect(): Promise<CredentialVaultInspection> {
    let permissions: CredentialVaultInspection['permissions'] = IS_WINDOWS
      ? 'unsupported'
      : 'unknown'

    try {
      const directory = await this.#secureDirectory(false)
      if (directory === undefined) {
        return Object.freeze({ state: 'absent', permissions })
      }
      permissions = permissionState()

      const existing = await lstatIfPresent(this.#documentPath)
      if (existing === undefined) {
        return Object.freeze({ state: 'absent', permissions })
      }
      assertDocumentMetadata(existing)

      const document = await this.#readOpenedDocument()
      if (document === undefined) {
        return Object.freeze({ state: 'absent', permissions })
      }
      return Object.freeze({
        state: 'present',
        formatVersion: document.schemaVersion,
        permissions,
      })
    } catch (error) {
      return inspectionForFailure(error, permissions)
    }
  }

  async #secureDirectory(create: boolean): Promise<Stats | undefined> {
    const existing = await lstatIfPresent(this.#directoryPath)
    if (existing !== undefined) {
      assertDirectoryMetadata(existing)
      return existing
    }
    if (!create) {
      return undefined
    }

    await mkdir(this.#directoryPath, {
      mode: AUTH_DIRECTORY_MODE,
      recursive: true,
    })
    let metadata = await lstatIfPresent(this.#directoryPath)
    if (metadata === undefined) {
      return undefined
    }
    assertDirectoryMetadata(metadata)

    if (!IS_WINDOWS) {
      await chmod(this.#directoryPath, AUTH_DIRECTORY_MODE)
      metadata = await lstatIfPresent(this.#directoryPath)
      if (metadata === undefined) {
        return undefined
      }
      assertDirectoryMetadata(metadata)
      if ((metadata.mode & 0o777) !== AUTH_DIRECTORY_MODE) {
        throw storageInsecure('directory_permissions')
      }
    }
    return metadata
  }

  async #requireSecureDirectory(): Promise<void> {
    const directory = await this.#secureDirectory(false)
    if (directory === undefined) {
      throw storageInvalid('directory_missing')
    }
  }

  async #readDocument(): Promise<CodexCredentialDocument | undefined> {
    const existing = await lstatIfPresent(this.#documentPath)
    if (existing === undefined) {
      return undefined
    }
    assertDocumentMetadata(existing)
    return this.#readOpenedDocument()
  }

  async #readOpenedDocument(): Promise<CodexCredentialDocument | undefined> {
    let handle
    try {
      handle = await open(this.#documentPath, READ_FLAGS)
    } catch (error) {
      if (isMissingError(error)) {
        return undefined
      }
      if (errorHasCode(error, 'ELOOP')) {
        throw storageInsecure('document_symlink', error)
      }
      throw error
    }

    try {
      const metadata = await handle.stat()
      assertDocumentMetadata(metadata)

      const bytes = Buffer.allocUnsafe(MAX_CREDENTIAL_DOCUMENT_BYTES + 1)
      let offset = 0
      while (offset < bytes.byteLength) {
        const result = await handle.read(bytes, offset, bytes.byteLength - offset, null)
        if (result.bytesRead === 0) {
          break
        }
        offset += result.bytesRead
      }
      if (offset > MAX_CREDENTIAL_DOCUMENT_BYTES) {
        throw storageInvalid('max_bytes')
      }

      let serialized: string
      try {
        serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))
      } catch (error) {
        throw storageInvalid('invalid_encoding', error)
      }
      return decodeCredentialDocument(serialized)
    } finally {
      await handle.close()
    }
  }
}
