import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

import { AUTH_DIRECTORY_NAME, AUTH_FILENAME } from '../core/constants.js'

export interface CredentialStoragePaths {
  readonly directory: string
  readonly document: string
}

export function resolveCredentialStoragePaths(): CredentialStoragePaths {
  return Object.freeze({
    directory: dshHomePath(AUTH_DIRECTORY_NAME),
    document: dshHomePath(AUTH_DIRECTORY_NAME, AUTH_FILENAME),
  })
}
