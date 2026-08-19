import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import compatibilityDocument from '../../compatibility.json' with { type: 'json' }
import type { VersionCheck } from '../core/contracts.js'
import { CodexError } from '../core/errors.js'

const MAX_PACKAGE_METADATA_BYTES = 64 * 1024
const MAX_PACKAGE_ROOT_ASCENTS = 4

interface CompatibilityDocument {
  readonly node: string
  readonly dsh: {
    readonly packages: Readonly<Record<string, string>>
  }
  readonly piAi: {
    readonly package: string
    readonly version: string
  }
}

export interface InstalledRuntimeSnapshot {
  readonly node: string
  readonly packages: Readonly<Record<string, string | null | undefined>>
}

export interface RuntimeCompatibilityReport {
  readonly compatible: boolean
  readonly node: VersionCheck
  readonly packages: Readonly<Record<string, VersionCheck>>
}

type NumericVersion = readonly [major: number, minor: number, patch: number]

const compatibility = compatibilityDocument as CompatibilityDocument

function parseNumericVersion(value: string): NumericVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value)
  if (match === null) {
    return undefined
  }
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor) && Number.isSafeInteger(patch)
    ? [major, minor, patch]
    : undefined
}

function compareVersions(left: NumericVersion, right: NumericVersion): number {
  for (const index of [0, 1, 2] as const) {
    const difference = left[index] - right[index]
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

function caretUpperBound(version: NumericVersion): NumericVersion {
  if (version[0] > 0) {
    return [version[0] + 1, 0, 0]
  }
  if (version[1] > 0) {
    return [0, version[1] + 1, 0]
  }
  return [0, 0, version[2] + 1]
}

function matchesNodeComparator(version: NumericVersion, comparator: string): boolean {
  if (comparator.startsWith('^')) {
    const minimum = parseNumericVersion(comparator.slice(1))
    return minimum !== undefined
      && compareVersions(version, minimum) >= 0
      && compareVersions(version, caretUpperBound(minimum)) < 0
  }
  if (comparator.startsWith('>=')) {
    const minimum = parseNumericVersion(comparator.slice(2))
    return minimum !== undefined && compareVersions(version, minimum) >= 0
  }
  const exact = parseNumericVersion(comparator)
  return exact !== undefined && compareVersions(version, exact) === 0
}

export function matchesNodeRange(version: string, range: string): boolean {
  const parsed = parseNumericVersion(version)
  return parsed !== undefined
    && range.split('||').some((term) => matchesNodeComparator(parsed, term.trim()))
}

function versionCheck(
  supported: string,
  installed: string | null | undefined,
  compatible: boolean,
): VersionCheck {
  return Object.freeze({
    supported,
    installed: installed ?? null,
    status: installed === null || installed === undefined
      ? 'unknown'
      : compatible
        ? 'compatible'
        : 'incompatible',
  })
}

function expectedPackageVersions(): Readonly<Record<string, string>> {
  return Object.freeze({
    ...compatibility.dsh.packages,
    [compatibility.piAi.package]: compatibility.piAi.version,
  })
}

function packageVersion(packageName: string): string | null {
  let directory: string
  try {
    directory = dirname(fileURLToPath(import.meta.resolve(packageName)))
  } catch {
    return null
  }

  for (let ascent = 0; ascent < MAX_PACKAGE_ROOT_ASCENTS; ascent += 1) {
    try {
      const source = readFileSync(join(directory, 'package.json'), 'utf8')
      if (Buffer.byteLength(source, 'utf8') > MAX_PACKAGE_METADATA_BYTES) {
        return null
      }
      const value: unknown = JSON.parse(source)
      if (
        value !== null
        && typeof value === 'object'
        && 'name' in value
        && value.name === packageName
        && 'version' in value
        && typeof value.version === 'string'
        && value.version.length <= 128
      ) {
        return value.version
      }
    } catch {
      // The package entry commonly starts in lib/ or dist/; inspect its parent next.
    }
    const parent = dirname(directory)
    if (parent === directory) {
      break
    }
    directory = parent
  }
  return null
}

export function inspectInstalledRuntime(): InstalledRuntimeSnapshot {
  const packages: Record<string, string | null> = Object.create(null) as Record<
    string,
    string | null
  >
  for (const packageName of Object.keys(expectedPackageVersions())) {
    packages[packageName] = packageVersion(packageName)
  }
  return Object.freeze({
    node: process.versions.node,
    packages: Object.freeze(packages),
  })
}

export function evaluateRuntimeCompatibility(
  installed: InstalledRuntimeSnapshot,
): RuntimeCompatibilityReport {
  const nodeCompatible = matchesNodeRange(installed.node, compatibility.node)
  const packages: Record<string, VersionCheck> = Object.create(null) as Record<
    string,
    VersionCheck
  >
  let allPackagesCompatible = true

  for (const [packageName, supported] of Object.entries(expectedPackageVersions())) {
    const actual = installed.packages[packageName]
    const compatible = actual === supported
    packages[packageName] = versionCheck(supported, actual, compatible)
    allPackagesCompatible &&= compatible
  }

  return Object.freeze({
    compatible: nodeCompatible && allPackagesCompatible,
    node: versionCheck(compatibility.node, installed.node, nodeCompatible),
    packages: Object.freeze(packages),
  })
}

export function assertRuntimeCompatible(
  installed: InstalledRuntimeSnapshot = inspectInstalledRuntime(),
): RuntimeCompatibilityReport {
  const report = evaluateRuntimeCompatibility(installed)
  if (report.node.status !== 'compatible') {
    throw new CodexError('The installed runtime is not supported.', 'CODEX_INCOMPATIBLE_RUNTIME', {
      safeDetails: {
        packageName: 'node',
        supported: report.node.supported,
        installed: report.node.installed ?? 'unknown',
      },
    })
  }
  for (const [packageName, check] of Object.entries(report.packages)) {
    if (check.status !== 'compatible') {
      throw new CodexError('The installed runtime is not supported.', 'CODEX_INCOMPATIBLE_RUNTIME', {
        safeDetails: {
          packageName,
          supported: check.supported,
          installed: check.installed ?? 'unknown',
        },
      })
    }
  }
  return report
}
