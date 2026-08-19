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

export function validateReleaseState({
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
      releaseNotes.exists
        && typeof releaseNotes.text === 'string'
        && !releaseNotes.text.includes('Draft only.'),
      `Final release notes are missing for ${String(packageJson.version)}.`,
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

  validateWorkflowContracts({ ciWorkflow, compatibility, releaseWorkflow })
}
