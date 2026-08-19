import { validateWorkflowContracts } from './workflow-contract.mjs'

const EXPECTED_HOMEPAGE = 'https://github.com/TakahisaI/dsh-codex-sub#readme'
const EXPECTED_ISSUES = 'https://github.com/TakahisaI/dsh-codex-sub/issues'
const EXPECTED_REGISTRY = 'https://registry.npmjs.org/'
const EXPECTED_REPOSITORY = 'git+https://github.com/TakahisaI/dsh-codex-sub.git'
const PRIVATE_REPORT_URL = 'https://github.com/TakahisaI/dsh-codex-sub/security/advisories/new'

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function isFinalReleaseRecord(text) {
  return !/\bpending\b/iu.test(text)
    && !text.includes('Draft only.')
    && !text.includes('has not been published')
    && /- Git commit: `[0-9a-f]{40}`/u.test(text)
    && /- Tarball SHA-256: `[0-9a-f]{64}`/u.test(text)
    && /- Manual smoke: PASS/u.test(text)
    && /- Publication date: `\d{4}-\d{2}-\d{2}`/u.test(text)
}

function isReleaseCandidate(text) {
  return text.includes('> Release candidate.')
    && text.includes('has not been published')
    && !text.includes('Draft only.')
}

export function validateReleaseState({
  bootstrapReleaseRecord,
  ciWorkflow,
  compatibility,
  disabledWorkflowExists,
  enabledWorkflowExists,
  issueConfig,
  licenseExists,
  npmBootstrapDecision,
  packageJson,
  releaseNotes,
  releaseWorkflow,
  securityPolicy,
}) {
  if (packageJson.private === true) {
    invariant(
      packageJson.version === '0.0.0-development' && packageJson.license === 'MIT',
      'A private development package must keep its development version and MIT license.',
    )
    invariant(
      !enabledWorkflowExists && disabledWorkflowExists,
      'The publishing workflow must remain disabled while publication is blocked.',
    )
  } else {
    invariant(
      npmBootstrapDecision.includes('- Status: accepted'),
      'The npm bootstrap decision must be accepted before publication is enabled.',
    )
    invariant(
      /^\d+\.\d+\.\d+-alpha\.\d+$/u.test(packageJson.version),
      'A public package version must be an explicit Alpha prerelease.',
    )
    invariant(
      packageJson.license === 'MIT' && licenseExists,
      'A public package requires the selected MIT license and committed LICENSE file.',
    )
    invariant(
      enabledWorkflowExists && !disabledWorkflowExists,
      'A public package requires the reviewed release workflow to be enabled once.',
    )
    invariant(
      typeof bootstrapReleaseRecord === 'string' && isFinalReleaseRecord(bootstrapReleaseRecord),
      'The first Alpha release record must retain its final exact-artifact evidence.',
    )
    invariant(
      releaseNotes.exists
        && typeof releaseNotes.text === 'string'
        && (isFinalReleaseRecord(releaseNotes.text) || isReleaseCandidate(releaseNotes.text)),
      `Reviewed release notes are missing for ${String(packageJson.version)}.`,
    )
  }

  invariant(
    packageJson.repository?.url === EXPECTED_REPOSITORY
      && packageJson.bugs?.url === EXPECTED_ISSUES
      && packageJson.homepage === EXPECTED_HOMEPAGE,
    'Package registry links drifted from the canonical repository.',
  )
  invariant(
    packageJson.publishConfig?.access === 'public'
      && packageJson.publishConfig?.tag === 'alpha'
      && packageJson.publishConfig?.registry === EXPECTED_REGISTRY,
    'Publishing metadata must force the public npm registry, public access, and the alpha dist-tag.',
  )
  invariant(
    securityPolicy.includes(PRIVATE_REPORT_URL) && issueConfig.includes(PRIVATE_REPORT_URL),
    'The private vulnerability reporting URL drifted from support documentation.',
  )

  validateWorkflowContracts({
    ciWorkflow,
    compatibility,
    releaseMode: packageJson.private === true ? 'verification-only' : 'staged',
    releaseWorkflow,
  })
}
