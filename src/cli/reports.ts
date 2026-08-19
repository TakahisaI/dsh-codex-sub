import type {
  CodexAuthStatus,
  CredentialVaultInspection,
  DoctorReportV1,
  StatusReportV1,
  VersionCheck,
} from '../core/contracts.js'
import {
  PACKAGE_NAME,
  PROVIDER_ID,
} from '../core/constants.js'
import { CodexError } from '../core/errors.js'
import type { RuntimeCompatibilityReport } from '../dsh/compatibility.js'

const DSH_LLM_PACKAGE = '@deepseek-ai/dsh-llm'
const DSH_PIAI_PACKAGE = '@deepseek-ai/dsh-llm-pi-ai'
const PIAI_PACKAGE = '@earendil-works/pi-ai'

function runtimeFailure(reason: string): CodexError {
  return new CodexError('Runtime diagnostics failed.', 'CODEX_INCOMPATIBLE_RUNTIME', {
    safeDetails: { reason },
  })
}

function copyVersionCheck(value: VersionCheck | undefined, reason: string): VersionCheck {
  if (value === undefined) {
    throw runtimeFailure(reason)
  }
  return Object.freeze({
    supported: value.supported,
    installed: value.installed,
    status: value.status,
  })
}

function copyInspection(value: CredentialVaultInspection): CredentialVaultInspection {
  return Object.freeze({
    state: value.state,
    ...(value.formatVersion === undefined ? {} : { formatVersion: value.formatVersion }),
    permissions: value.permissions,
  })
}

function packageInfo(version: string): StatusReportV1['package'] {
  if (version.length === 0 || version.length > 128) {
    throw runtimeFailure('package_version')
  }
  return Object.freeze({ name: PACKAGE_NAME, version })
}

export function createStatusReport(
  version: string,
  status: CodexAuthStatus,
): StatusReportV1 {
  return Object.freeze({
    schemaVersion: 1,
    package: packageInfo(version),
    provider: PROVIDER_ID,
    status,
  })
}

function doctorOverall(
  runtimeChecks: readonly VersionCheck[],
  credentialStore: CredentialVaultInspection,
  modelCount: number,
): DoctorReportV1['overall'] {
  if (runtimeChecks.some((check) => check.status === 'incompatible')) {
    return 'incompatible'
  }
  if (runtimeChecks.some((check) => check.status === 'unknown')) {
    return 'unknown'
  }
  if (
    modelCount === 0
    || credentialStore.state === 'invalid'
    || credentialStore.state === 'insecure'
    || credentialStore.state === 'unreadable'
    || (
      credentialStore.state === 'present'
      && credentialStore.permissions !== 'owner-only'
    )
  ) {
    return 'degraded'
  }
  return 'compatible'
}

function doctorHints(
  runtimeChecks: readonly VersionCheck[],
  credentialStore: CredentialVaultInspection,
  modelCount: number,
): readonly string[] {
  const hints: string[] = []
  if (runtimeChecks.some((check) => check.status === 'incompatible')) {
    hints.push('Install the exact runtime versions verified by this package.')
  } else if (runtimeChecks.some((check) => check.status === 'unknown')) {
    hints.push('Some installed runtime versions could not be verified.')
  }

  switch (credentialStore.state) {
    case 'absent':
      hints.push('Run dsh-codex-sub login to authenticate this package.')
      break
    case 'invalid':
      hints.push('Run logout, then login again to replace the invalid package credential.')
      break
    case 'insecure':
      hints.push('Restrict credential storage to the current OS user before continuing.')
      break
    case 'unreadable':
      hints.push('Check local credential storage access, then run doctor again.')
      break
    case 'present':
      if (credentialStore.permissions === 'unsupported') {
        hints.push('Owner-only credential permissions cannot be verified on this platform.')
      } else if (credentialStore.permissions === 'unknown') {
        hints.push('Credential storage permissions could not be verified.')
      }
      break
  }

  if (modelCount === 0) {
    hints.push('The pinned Codex provider catalog is empty.')
  }
  return Object.freeze(hints)
}

export function createDoctorReport(input: {
  readonly version: string
  readonly runtime: RuntimeCompatibilityReport
  readonly credentialStore: CredentialVaultInspection
  readonly modelCount: number
}): DoctorReportV1 {
  if (!Number.isSafeInteger(input.modelCount) || input.modelCount < 0) {
    throw runtimeFailure('catalog_count')
  }

  const node = copyVersionCheck(input.runtime.node, 'node_version')
  const dshLlm = copyVersionCheck(input.runtime.packages[DSH_LLM_PACKAGE], 'dsh_llm_version')
  const dshPiAi = copyVersionCheck(input.runtime.packages[DSH_PIAI_PACKAGE], 'dsh_piai_version')
  const piAi = copyVersionCheck(input.runtime.packages[PIAI_PACKAGE], 'piai_version')
  const runtimeChecks = [node, ...Object.values(input.runtime.packages)]
  const credentialStore = copyInspection(input.credentialStore)

  return Object.freeze({
    schemaVersion: 1,
    overall: doctorOverall(runtimeChecks, credentialStore, input.modelCount),
    package: packageInfo(input.version),
    runtime: Object.freeze({ node, dshLlm, dshPiAi, piAi }),
    credentialStore,
    catalog: Object.freeze({
      provider: PROVIDER_ID,
      modelCount: input.modelCount,
    }),
    hints: doctorHints(runtimeChecks, credentialStore, input.modelCount),
  })
}
