import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateReleaseState } from './release-state-contract.mjs'

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
  'docs/decisions/0013-single-release-artifact.md',
  'docs/decisions/0014-post-bootstrap-dist-tags.md',
  'docs/dependency-licenses.md',
  'docs/known-limitations.ja.md',
  'docs/known-limitations.md',
  'docs/releases/0.1.0-alpha.0.md',
  'LICENSE',
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
const postBootstrapDistTagsDecision = await readText(
  'docs/decisions/0014-post-bootstrap-dist-tags.md',
)
const enabledWorkflow = await exists('.github/workflows/release.yml')
const disabledWorkflow = await exists('.github/workflows/release.yml.disabled')
const securityPolicy = await readText('SECURITY.md')
const issueConfig = await readText('.github/ISSUE_TEMPLATE/config.yml')
const releaseWorkflowPath = enabledWorkflow
  ? '.github/workflows/release.yml'
  : '.github/workflows/release.yml.disabled'
const releaseNotesPath = `docs/releases/${String(packageJson.version)}.md`
const releaseNotesExists = await exists(releaseNotesPath)
const [
  bootstrapReleaseRecord,
  ciWorkflow,
  releaseWorkflow,
  compatibility,
  releaseNotesText,
] = await Promise.all([
  readText('docs/releases/0.1.0-alpha.0.md'),
  readText('.github/workflows/ci.yml'),
  readText(releaseWorkflowPath),
  readText('compatibility.json').then((text) => JSON.parse(text)),
  releaseNotesExists ? readText(releaseNotesPath) : undefined,
])
validateReleaseState({
  bootstrapReleaseRecord,
  ciWorkflow,
  compatibility,
  disabledWorkflowExists: disabledWorkflow,
  enabledWorkflowExists: enabledWorkflow,
  issueConfig,
  licenseExists: await exists('LICENSE'),
  npmBootstrapDecision,
  packageJson,
  postBootstrapDistTagsDecision,
  releaseNotes: { exists: releaseNotesExists, text: releaseNotesText },
  releaseWorkflow,
  securityPolicy,
})

process.stdout.write('Release state and support files are internally consistent.\n')
