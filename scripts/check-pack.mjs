import { spawnSync } from 'node:child_process'
import { PACKAGE_FILE_ALLOWLIST } from './package-files.mjs'

const requiredFiles = new Set(PACKAGE_FILE_ALLOWLIST)

const result = spawnSync('pnpm', ['pack', '--dry-run', '--json'], {
  encoding: 'utf8',
  shell: false,
})

if (result.status !== 0) {
  throw new Error(`pnpm pack --dry-run failed with exit code ${String(result.status)}`)
}

const report = JSON.parse(result.stdout)
const packedFiles = new Set(report.files.map(({ path }) => path))
const missing = [...requiredFiles].filter((path) => !packedFiles.has(path))
const unexpected = [...packedFiles].filter((path) => !requiredFiles.has(path))

if (missing.length > 0 || unexpected.length > 0) {
  throw new Error(
    `Unexpected package contents. Missing: ${missing.join(', ') || 'none'}. `
      + `Unexpected: ${unexpected.join(', ') || 'none'}.`,
  )
}

process.stdout.write('Package contents match the allowlist.\n')
