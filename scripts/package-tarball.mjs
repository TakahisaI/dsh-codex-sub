import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import { PACKAGE_FILE_ALLOWLIST } from './package-files.mjs'

const MAX_TARBALL_BYTES = 16 * 1024 * 1024
const MAX_TAR_OUTPUT_BYTES = 1024 * 1024
const PACKAGE_PREFIX = 'package/'

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function runTar(arguments_, label) {
  const result = spawnSync('tar', arguments_, {
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    maxBuffer: MAX_TAR_OUTPUT_BYTES,
    shell: false,
  })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`${label} failed.`)
  }
  return result.stdout ?? ''
}

function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} was not valid JSON.`)
  }
}

function compareFiles(actualFiles) {
  const expected = new Set(PACKAGE_FILE_ALLOWLIST)
  const actual = new Set(actualFiles)
  const missing = [...expected].filter((path) => !actual.has(path))
  const unexpected = [...actual].filter((path) => !expected.has(path))
  invariant(
    missing.length === 0 && unexpected.length === 0 && actualFiles.length === actual.size,
    `Package tarball contents did not match the allowlist. Missing: ${missing.join(', ') || 'none'}. `
      + `Unexpected: ${unexpected.join(', ') || 'none'}.`,
  )
}

export async function calculateSha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

export async function validatePackageTarball(packageTarball) {
  invariant(isAbsolute(packageTarball), '--package-tarball must be an absolute path.')
  invariant(packageTarball.endsWith('.tgz'), '--package-tarball must name a .tgz file.')

  const metadata = await lstat(packageTarball)
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), 'Package tarball must be a regular file.')
  invariant(
    metadata.size > 0 && metadata.size <= MAX_TARBALL_BYTES,
    `Package tarball must be between 1 and ${String(MAX_TARBALL_BYTES)} bytes.`,
  )

  const canonicalPath = await realpath(packageTarball)
  const entries = runTar(['-tzf', canonicalPath], 'Package tarball listing')
    .split(/\r?\n/u)
    .filter((entry) => entry.length > 0)
  invariant(entries.length > 0, 'Package tarball was empty.')
  const verboseEntries = runTar(['-tvzf', canonicalPath], 'Package tarball metadata listing')
    .split(/\r?\n/u)
    .filter((entry) => entry.length > 0)
  invariant(
    verboseEntries.length === entries.length && verboseEntries.every((entry) => entry.startsWith('-')),
    'Package tarball entries must all be regular files.',
  )
  invariant(
    entries.every((entry) => entry.startsWith(PACKAGE_PREFIX)),
    'Package tarball contained an entry outside the package directory.',
  )
  const packedFiles = entries.map((entry) => entry.slice(PACKAGE_PREFIX.length)).sort()
  compareFiles(packedFiles)

  const [packedManifest, repositoryManifest] = await Promise.all([
    Promise.resolve(parseJson(
      runTar(['-xOzf', canonicalPath, `${PACKAGE_PREFIX}package.json`], 'Package manifest read'),
      'Packed package.json',
    )),
    readFile(new URL('../package.json', import.meta.url), 'utf8')
      .then((text) => parseJson(text, 'Repository package.json')),
  ])
  invariant(packedManifest.name === repositoryManifest.name, 'Package tarball name did not match this repository.')
  invariant(
    packedManifest.version === repositoryManifest.version,
    'Package tarball version did not match this repository.',
  )
  invariant(
    basename(canonicalPath) === `${repositoryManifest.name}-${repositoryManifest.version}.tgz`,
    'Package tarball filename did not match its package name and version.',
  )

  return {
    canonicalPath,
    packedFiles,
    sha256: await calculateSha256(canonicalPath),
  }
}

export const PACKAGE_TARBALL_LIMIT_BYTES = MAX_TARBALL_BYTES
