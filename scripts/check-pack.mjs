import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { PACKAGE_FILE_ALLOWLIST } from './package-files.mjs'
import { assertPackageReadmeLinks } from './package-readme-contract.mjs'

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

const [englishReadme, japaneseReadme] = await Promise.all([
  readFile(new URL('../README.md', import.meta.url), 'utf8'),
  readFile(new URL('../README.ja.md', import.meta.url), 'utf8'),
])
assertPackageReadmeLinks(englishReadme, 'README.md')
assertPackageReadmeLinks(japaneseReadme, 'README.ja.md')

process.stdout.write('Package contents and README links match the distribution contract.\n')
