const PLATFORM_RUNNERS = Object.freeze({
  darwin: 'macos-latest',
  linux: 'ubuntu-latest',
})
const RELEASE_ARTIFACT_NAME = 'dsh-codex-sub-unpublished'

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function nodeMatrixValues(nodeRange) {
  return nodeRange.split('||').map((alternative) => {
    const match = /^\s*\^(\d+)\.(\d+)\.(\d+)\s*$/u.exec(alternative)
    invariant(match !== null, 'compatibility.json contained an unsupported Node range shape.')
    const [, major, minor, patch] = match
    invariant(major !== undefined && minor !== undefined && patch !== undefined, 'Node range was incomplete.')
    return minor === '0' && patch === '0' ? major : `${major}.${minor}.${patch}`
  })
}

export function expectedPackedInstallMatrix(compatibility) {
  const nodes = nodeMatrixValues(compatibility.node)
  return compatibility.platforms.flatMap((platform) => {
    const runner = Object.hasOwn(PLATFORM_RUNNERS, platform)
      ? PLATFORM_RUNNERS[platform]
      : undefined
    invariant(runner !== undefined, `Unsupported CI platform identifier: ${String(platform)}.`)
    return nodes.map((node) => `${runner}|${node}`)
  })
}

function jobBody(workflow, jobName) {
  const marker = `\n  ${jobName}:\n`
  const start = workflow.indexOf(marker)
  invariant(start >= 0, `Workflow job was missing: ${jobName}.`)
  const bodyStart = start + marker.length
  const nextJob = workflow.slice(bodyStart).search(/^  [a-z][a-z0-9-]*:\s*$/mu)
  return nextJob < 0
    ? workflow.slice(bodyStart)
    : workflow.slice(bodyStart, bodyStart + nextJob)
}

function matrixCells(job) {
  return [...job.matchAll(/^\s+- os:\s*(\S+)\s*\r?\n\s+node:\s*(\S+)\s*$/gmu)]
    .map((match) => `${match[1]}|${match[2]}`)
}

function count(text, pattern) {
  return text.split(pattern).length - 1
}

function assertMatrix(job, expected, label) {
  const actual = matrixCells(job).sort()
  const sortedExpected = [...expected].sort()
  invariant(
    JSON.stringify(actual) === JSON.stringify(sortedExpected),
    `${label} packed-install matrix did not match compatibility.json.`,
  )
}

function assertArtifactProducer(job, label) {
  invariant(count(job, 'pnpm run build') === 1, `${label} must build the candidate exactly once.`)
  invariant(
    count(job, 'node scripts/release-artifact.mjs create') === 1,
    `${label} must create the candidate exactly once.`,
  )
  invariant(
    count(job, 'actions/upload-artifact@v6') === 1,
    `${label} must upload exactly one workflow artifact.`,
  )
  invariant(
    count(job, `name: ${RELEASE_ARTIFACT_NAME}`) === 1,
    `${label} must upload the canonical workflow artifact.`,
  )
}

function assertArtifactConsumer(job, expected, label) {
  assertMatrix(job, expected, label)
  invariant(/^    needs: candidate$/mu.test(job), `${label} must depend on the candidate job.`)
  invariant(
    count(job, 'actions/download-artifact@v7') === 1,
    `${label} must download the candidate artifact exactly once per cell.`,
  )
  invariant(
    count(job, `name: ${RELEASE_ARTIFACT_NAME}`) === 1,
    `${label} must download the canonical workflow artifact.`,
  )
  invariant(
    count(job, 'node scripts/release-artifact.mjs verify') === 1,
    `${label} must verify the downloaded candidate exactly once per cell.`,
  )
  invariant(count(job, '--package-tarball') === 1, `${label} must install the verified tarball.`)
  invariant(!job.includes('pnpm run build'), `${label} must not rebuild the package.`)
  invariant(
    !job.includes('node scripts/release-artifact.mjs create'),
    `${label} must not repack the candidate.`,
  )
}

export function validateWorkflowContracts({ ciWorkflow, compatibility, releaseWorkflow }) {
  const expected = expectedPackedInstallMatrix(compatibility)
  assertArtifactProducer(jobBody(ciWorkflow, 'candidate'), 'CI candidate job')
  assertArtifactConsumer(jobBody(ciWorkflow, 'packed-install'), expected, 'CI')
  assertArtifactProducer(jobBody(releaseWorkflow, 'candidate'), 'Release candidate job')
  assertArtifactConsumer(
    jobBody(releaseWorkflow, 'candidate-install'),
    expected,
    'Release workflow',
  )
}
