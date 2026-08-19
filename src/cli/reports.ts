import type {
  CodexAuthStatus,
  CredentialVaultInspection,
  DoctorReportV1,
  PlatformCheck,
  StatusReportV1,
  VersionCheck,
} from '../core/contracts.js'
import {
  PACKAGE_NAME,
  PROVIDER_ID,
} from '../core/constants.js'
import { CodexError } from '../core/errors.js'
import {
  RUNTIME_PACKAGE_NAMES,
  type RuntimeCompatibilityReport,
} from '../dsh/compatibility.js'

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

function copyPlatformCheck(value: PlatformCheck | undefined): PlatformCheck {
  if (
    value === undefined
    || value.supported.length === 0
    || value.installed.length === 0
  ) {
    throw runtimeFailure('platform')
  }
  return Object.freeze({
    supported: Object.freeze([...value.supported]),
    installed: value.installed,
    status: value.status,
  })
}

function copyPackageChecks(
  values: Readonly<Record<string, VersionCheck>>,
): Readonly<Record<string, VersionCheck>> {
  if (
    Object.keys(values).length !== RUNTIME_PACKAGE_NAMES.length
    || !RUNTIME_PACKAGE_NAMES.every((packageName) => Object.hasOwn(values, packageName))
  ) {
    throw runtimeFailure('package_versions')
  }
  const packages: Record<string, VersionCheck> = Object.create(null) as Record<
    string,
    VersionCheck
  >
  for (const packageName of RUNTIME_PACKAGE_NAMES) {
    packages[packageName] = copyVersionCheck(values[packageName], 'package_versions')
  }
  return Object.freeze(packages)
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
  platform: PlatformCheck,
  runtimeChecks: readonly VersionCheck[],
  credentialStore: CredentialVaultInspection,
  modelCount: number,
): DoctorReportV1['overall'] {
  if (
    platform.status === 'incompatible'
    || runtimeChecks.some((check) => check.status === 'incompatible')
  ) {
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
  platform: PlatformCheck,
  runtimeChecks: readonly VersionCheck[],
  credentialStore: CredentialVaultInspection,
  modelCount: number,
): readonly string[] {
  const hints: string[] = []
  if (platform.status === 'incompatible') {
    hints.push('Run this package on a supported operating system.')
  }
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

  const platform = copyPlatformCheck(input.runtime.platform)
  const node = copyVersionCheck(input.runtime.node, 'node_version')
  const packages = copyPackageChecks(input.runtime.packages)
  const runtimeChecks = [node, ...Object.values(packages)]
  const credentialStore = copyInspection(input.credentialStore)

  return Object.freeze({
    schemaVersion: 1,
    overall: doctorOverall(platform, runtimeChecks, credentialStore, input.modelCount),
    package: packageInfo(input.version),
    runtime: Object.freeze({ platform, node, packages }),
    credentialStore,
    catalog: Object.freeze({
      provider: PROVIDER_ID,
      modelCount: input.modelCount,
    }),
    hints: doctorHints(platform, runtimeChecks, credentialStore, input.modelCount),
  })
}
