import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const requiredSupportFiles = [
  '.github/ISSUE_TEMPLATE/bug-report.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/ISSUE_TEMPLATE/feature-request.yml',
  '.github/ISSUE_TEMPLATE/installation-problem.yml',
  'CHANGELOG.md',
  'SECURITY.md',
  'docs/alpha-smoke-record.md',
  'docs/decisions/0011-npm-trusted-publishing-bootstrap.md',
  'docs/dependency-licenses.md',
  'docs/known-limitations.ja.md',
  'docs/known-limitations.md',
  'docs/releases/0.1.0-alpha.0.md',
]

async function exists(filename) {
  try {
    await access(join(repositoryRoot, filename))
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function readText(filename) {
  return readFile(join(repositoryRoot, filename), 'utf8')
}

for (const filename of requiredSupportFiles) {
  if (!await exists(filename)) {
    throw new Error(`Required release support file is missing: ${filename}`)
  }
  if ((await readText(filename)).trim().length === 0) {
    throw new Error(`Required release support file is empty: ${filename}`)
  }
}

const packageJson = JSON.parse(await readText('package.json'))
const npmBootstrapDecision = await readText(
  'docs/decisions/0011-npm-trusted-publishing-bootstrap.md',
)
const expectedRepository = 'git+https://github.com/TakahisaI/dsh-codex-sub.git'
const expectedIssues = 'https://github.com/TakahisaI/dsh-codex-sub/issues'
const expectedHomepage = 'https://github.com/TakahisaI/dsh-codex-sub#readme'
const enabledWorkflow = await exists('.github/workflows/release.yml')
const disabledWorkflow = await exists('.github/workflows/release.yml.disabled')

if (packageJson.private === true) {
  if (packageJson.version !== '0.0.0-development' || packageJson.license !== 'UNLICENSED') {
    throw new Error('A private development package must remain versioned and licensed as blocked.')
  }
  if (enabledWorkflow || !disabledWorkflow) {
    throw new Error('The publishing workflow must remain disabled while publication is blocked.')
  }
} else {
  if (!npmBootstrapDecision.includes('- Status: accepted')) {
    throw new Error('The npm bootstrap decision must be accepted before publication is enabled.')
  }
  if (!/^\d+\.\d+\.\d+-alpha\.\d+$/u.test(packageJson.version)) {
    throw new Error('A public package version must be an explicit Alpha prerelease.')
  }
  if (packageJson.license === 'UNLICENSED' || !await exists('LICENSE')) {
    throw new Error('A public package requires a selected license and committed LICENSE file.')
  }
  if (!enabledWorkflow || disabledWorkflow) {
    throw new Error('A public package requires the reviewed release workflow to be enabled once.')
  }
  const notesPath = `docs/releases/${packageJson.version}.md`
  if (!await exists(notesPath) || (await readText(notesPath)).includes('Draft only.')) {
    throw new Error(`Final release notes are missing for ${packageJson.version}.`)
  }
}

const securityPolicy = await readText('SECURITY.md')
const issueConfig = await readText('.github/ISSUE_TEMPLATE/config.yml')
if (
  packageJson.repository?.url !== expectedRepository
  || packageJson.bugs?.url !== expectedIssues
  || packageJson.homepage !== expectedHomepage
) {
  throw new Error('Package registry links drifted from the canonical repository.')
}

const privateReportUrl = 'https://github.com/TakahisaI/dsh-codex-sub/security/advisories/new'
if (!securityPolicy.includes(privateReportUrl) || !issueConfig.includes(privateReportUrl)) {
  throw new Error('The private vulnerability reporting URL drifted from support documentation.')
}

process.stdout.write('Release state and support files are internally consistent.\n')
