import { spawnSync } from 'node:child_process'

const allowedLicenses = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
])
const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const report = spawnSync(executable, ['licenses', 'list', '--prod', '--json'], {
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
  shell: false,
})

if (report.error !== undefined || report.status !== 0) {
  throw new Error('Could not inspect the production dependency licenses.')
}

let licenses
try {
  licenses = JSON.parse(report.stdout)
} catch {
  throw new Error('The production dependency license report was not valid JSON.')
}

const observedLicenses = Object.keys(licenses)
if (observedLicenses.length === 0) {
  throw new Error('The production dependency license report was empty.')
}

const unreviewed = observedLicenses.filter((license) => !allowedLicenses.has(license)).sort()
if (unreviewed.length > 0) {
  throw new Error(`Unreviewed production dependency licenses: ${unreviewed.join(', ')}`)
}

process.stdout.write(`Production dependency licenses are reviewed: ${observedLicenses.sort().join(', ')}.\n`)
