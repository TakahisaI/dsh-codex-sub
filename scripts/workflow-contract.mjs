const PLATFORM_RUNNERS = Object.freeze({
  darwin: 'macos-latest',
  linux: 'ubuntu-latest',
})
const RELEASE_ARTIFACT_NAME = 'dsh-codex-sub-unpublished'
const REQUIRED_CI_GATE_JOB = 'required-ci-gate'
const REQUIRED_CI_BLOCKING_JOBS = Object.freeze([
  'check',
  'candidate',
  'candidate-lane',
  'packed-candidate-lane',
  'exact-artifact-lane',
  'packed-install',
])
const REQUIRED_CI_GATE_ENV = Object.freeze([
  ['CHECK_RESULT', '${{ needs.check.result }}'],
  ['CANDIDATE_RESULT', '${{ needs.candidate.result }}'],
  ['CANDIDATE_LANE_RESULT', '${{ needs.candidate-lane.result }}'],
  ['PACKED_CANDIDATE_LANE_RESULT', '${{ needs.packed-candidate-lane.result }}'],
  ['EXACT_ARTIFACT_LANE_RESULT', '${{ needs.exact-artifact-lane.result }}'],
  ['PACKED_INSTALL_RESULT', '${{ needs.packed-install.result }}'],
  ['DEPENDENCY_REVIEW_RESULT', '${{ needs.dependency-review.result }}'],
  ['EVENT_NAME', '${{ github.event_name }}'],
])
export const PINNED_ACTIONS = Object.freeze({
  checkout: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  dependencyReview: 'actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294',
  downloadArtifact: 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
  setupNode: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  uploadArtifact: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
})

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

function workflowJobs(workflow) {
  const lines = workflow.split(/\r?\n/u)
  const jobsIndex = lines.findIndex((line) => line === 'jobs:')
  invariant(jobsIndex >= 0, 'Workflow jobs were missing.')
  const jobsEnd = blockEnd(lines, jobsIndex + 1, 0)
  const names = []
  for (const line of lines.slice(jobsIndex + 1, jobsEnd)) {
    if (!isContent(line) || indentation(line) !== 2) {
      continue
    }
    const match = /^  ([a-z][a-z0-9-]*):\s*$/u.exec(line)
    invariant(match !== null, 'Workflow jobs must use block-style definitions.')
    const name = match[1]
    invariant(name !== undefined && !names.includes(name), 'Workflow job name was invalid or repeated.')
    names.push(name)
  }
  invariant(names.length > 0, 'Workflow contained no jobs.')
  return names.map((name) => ({ body: jobBody(workflow, name), name }))
}

function assertExactJobSet(workflow, expected, label) {
  const actual = workflowJobs(workflow).map((job) => job.name).sort()
  const sortedExpected = [...expected].sort()
  invariant(
    JSON.stringify(actual) === JSON.stringify(sortedExpected),
    `${label} job set did not match the reviewed contract.`,
  )
}

function workflowJobsBody(workflow) {
  const marker = '\njobs:\n'
  const start = workflow.indexOf(marker)
  invariant(start >= 0, 'Workflow jobs were missing.')
  return workflow.slice(start + marker.length)
}

function matrixCells(job) {
  const lines = job.split(/\r?\n/u)
  const matrixIndex = lines.findIndex((line) => /^\s+matrix:\s*$/u.test(line))
  invariant(matrixIndex >= 0, 'Packed-install job matrix was missing.')
  const matrixIndent = indentation(lines[matrixIndex])
  const matrixEnd = blockEnd(lines, matrixIndex + 1, matrixIndent)
  const matrixLines = lines.slice(matrixIndex + 1, matrixEnd)
  const directChildren = matrixLines
    .map((line, index) => ({ index, line }))
    .filter(({ line }) => isContent(line) && indentation(line) === matrixIndent + 2)
  invariant(
    directChildren.length === 1 && directChildren[0]?.line.trim() === 'include:',
    'Packed-install matrix must contain only one block-style include list.',
  )

  const include = directChildren[0]
  invariant(include !== undefined, 'Packed-install matrix include list was missing.')
  const includeIndex = matrixIndex + 1 + include.index
  const includeIndent = indentation(lines[includeIndex])
  const includeEnd = blockEnd(lines, includeIndex + 1, includeIndent)
  const entryLines = lines.slice(includeIndex + 1, includeEnd)
  const entryIndent = includeIndent + 2
  const cells = []

  for (let index = 0; index < entryLines.length;) {
    const line = entryLines[index]
    invariant(line !== undefined, 'Packed-install matrix entry was missing.')
    if (!isContent(line)) {
      index += 1
      continue
    }
    invariant(
      indentation(line) === entryIndent && line.trimStart().startsWith('- '),
      'Packed-install matrix contained unsupported entry syntax.',
    )

    const properties = new Map()
    const firstProperty = line.trimStart().slice(2).trim()
    if (firstProperty.startsWith('{')) {
      parseFlowProperties(firstProperty, properties)
      index += 1
    } else {
      parseBlockProperty(firstProperty, properties)
      index += 1
      while (index < entryLines.length) {
        const propertyLine = entryLines[index]
        invariant(propertyLine !== undefined, 'Packed-install matrix property was missing.')
        if (!isContent(propertyLine)) {
          index += 1
          continue
        }
        if (indentation(propertyLine) === entryIndent) {
          break
        }
        invariant(
          indentation(propertyLine) === entryIndent + 2,
          'Packed-install matrix contained unsupported property indentation.',
        )
        parseBlockProperty(propertyLine.trim(), properties)
        index += 1
      }
    }
    invariant(
      properties.size === 2 && properties.has('os') && properties.has('node'),
      'Packed-install matrix entries must contain exactly os and node.',
    )
    cells.push(`${properties.get('os')}|${properties.get('node')}`)
  }

  return cells
}

function indentation(line) {
  const prefix = /^[ \t]*/u.exec(line)?.[0] ?? ''
  invariant(!prefix.includes('\t'), 'Workflow indentation must use spaces.')
  return prefix.length
}

function isContent(line) {
  const trimmed = line.trim()
  return trimmed.length > 0 && !trimmed.startsWith('#')
}

function blockEnd(lines, start, parentIndent) {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]
    if (line !== undefined && isContent(line) && indentation(line) <= parentIndent) {
      return index
    }
  }
  return lines.length
}

function addMatrixProperty(properties, key, value) {
  invariant(key === 'os' || key === 'node', 'Packed-install matrix contained an unsupported property.')
  invariant(!properties.has(key), `Packed-install matrix repeated ${key}.`)
  invariant(/^[A-Za-z0-9._-]+$/u.test(value), `Packed-install matrix ${key} was not a plain scalar.`)
  properties.set(key, value)
}

function parseBlockProperty(property, properties) {
  const match = /^(os|node):\s*([^\s]+)\s*$/u.exec(property)
  invariant(match !== null, 'Packed-install matrix contained unsupported property syntax.')
  const [, key, value] = match
  invariant(key !== undefined && value !== undefined, 'Packed-install matrix property was incomplete.')
  addMatrixProperty(properties, key, value)
}

function parseFlowProperties(entry, properties) {
  invariant(entry.endsWith('}'), 'Packed-install matrix flow entry was incomplete.')
  const body = entry.slice(1, -1).trim()
  invariant(body.length > 0, 'Packed-install matrix flow entry was empty.')
  for (const property of body.split(',')) {
    parseBlockProperty(property.trim(), properties)
  }
}

function count(text, pattern) {
  return text.split(pattern).length - 1
}

function assertProbeScopeInvocation(job, expected, label) {
  const other = expected === 'credential-topology' ? 'request-contracts' : 'credential-topology'
  invariant(
    count(job, `--probe-scope ${expected}`) === 1,
    `${label} must pass --probe-scope ${expected} exactly once.`,
  )
  invariant(
    count(job, `--probe-scope ${other}`) === 0,
    `${label} must not pass --probe-scope ${other}.`,
  )
}

function assertHostGraphModeInvocation(job, expected, label) {
  const other = expected === 'override-pinned' ? 'locked-no-overrides' : 'override-pinned'
  invariant(
    count(job, `--host-graph-mode ${expected}`) === 1,
    `${label} must pass --host-graph-mode ${expected} exactly once.`,
  )
  invariant(
    count(job, `--host-graph-mode ${other}`) === 0,
    `${label} must not pass --host-graph-mode ${other}.`,
  )
}

function assertPinnedActions(workflow, label) {
  const pins = Object.values(PINNED_ACTIONS)
  invariant(
    pins.every((pin) => /^[^@\s]+@[0-9a-f]{40}$/u.test(pin)),
    'Reviewed action pins must use full commit SHAs.',
  )
  const allowed = new Set(Object.values(PINNED_ACTIONS))
  const actions = [...workflow.matchAll(
    /^\s*(?:-\s*)?(?:uses|'uses'|"uses")\s*:\s*(\S+?)(?:\s+#.*)?$/gmu,
  )]
    .map((match) => match[1])
  invariant(
    !/^\s*-\s*\{[^\n}]*?(?:uses|'uses'|"uses")\s*:/mu.test(workflow),
    `${label} actions must use block-style reviewed full commit SHAs.`,
  )
  invariant(actions.length > 0, `${label} contained no actions.`)
  invariant(
    actions.every((action) => action !== undefined && allowed.has(action)),
    `${label} actions must use reviewed full commit SHAs.`,
  )
}

function assertNoCheckoutOverrides(workflow, label) {
  invariant(
    !/^\s+(?:ref|repository):\s*/mu.test(workflow),
    `${label} must not override the checked-out ref or repository.`,
  )
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
    count(job, PINNED_ACTIONS.uploadArtifact) === 1,
    `${label} must upload exactly one workflow artifact.`,
  )
  invariant(
    count(job, `name: ${RELEASE_ARTIFACT_NAME}`) === 1,
    `${label} must upload the canonical workflow artifact.`,
  )
}

function assertNoArtifactMutation(job, label) {
  invariant(
    !/\bbuild\b/u.test(job),
    `${label} must not rebuild the package.`,
  )
  invariant(
    !/\bpack\b/u.test(job),
    `${label} must not pack the package.`,
  )
  invariant(
    !job.includes('node scripts/release-artifact.mjs create'),
    `${label} must not recreate the candidate.`,
  )
}

function assertOnlyProducerMutatesArtifact(workflow, producerName, label) {
  for (const job of workflowJobs(workflow)) {
    if (job.name !== producerName) {
      assertNoArtifactMutation(job.body, `${label} ${job.name} job`)
    }
  }
}

function assertCandidateLaneJob(job, label) {
  invariant(
    count(job, 'runs-on: ubuntu-latest') === 1,
    `${label} candidate-lane job must use the reviewed Linux runner exactly once.`,
  )
  invariant(
    count(job, 'node-version: 24') === 1,
    `${label} candidate-lane job must pin Node 24 exactly once.`,
  )
  invariant(
    count(job, 'pnpm install --frozen-lockfile') === 1,
    `${label} candidate-lane job must install the locked graph exactly once.`,
  )
  invariant(
    count(job, 'pnpm run test:candidate-lane') === 1,
    `${label} candidate-lane job must execute the reviewed probe exactly once.`,
  )
}

function assertPackedCandidateLaneJob(job, label) {
  invariant(
    count(job, 'runs-on: ubuntu-latest') === 1,
    `${label} packed-candidate-lane job must use the reviewed Linux runner exactly once.`,
  )
  invariant(
    count(job, 'node-version: 24') === 1,
    `${label} packed-candidate-lane job must pin Node 24 exactly once.`,
  )
  invariant(
    count(job, 'pnpm install --frozen-lockfile') === 1,
    `${label} packed-candidate-lane job must install the locked graph exactly once.`,
  )
  invariant(
    /^    needs: candidate$/mu.test(job),
    `${label} packed-candidate-lane job must consume the candidate job's artifact.`,
  )
  invariant(
    count(job, 'pnpm run test:packed-candidate-lane') === 1,
    `${label} packed-candidate-lane job must execute the reviewed fresh-install probe exactly once.`,
  )
  assertProbeScopeInvocation(job, 'credential-topology', `${label} packed-candidate-lane`)
  assertHostGraphModeInvocation(job, 'override-pinned', `${label} packed-candidate-lane`)
  invariant(
    count(job, PINNED_ACTIONS.downloadArtifact) === 1,
    `${label} packed-candidate-lane job must download the candidate artifact exactly once.`,
  )
  invariant(
    count(job, `name: ${RELEASE_ARTIFACT_NAME}`) === 1,
    `${label} packed-candidate-lane job must download the canonical workflow artifact.`,
  )
  invariant(
    count(job, 'node scripts/release-artifact.mjs verify') === 1,
    `${label} packed-candidate-lane job must verify the downloaded candidate exactly once.`,
  )
  invariant(
    count(job, '--package-tarball "${{ steps.release-artifact.outputs.package-tarball }}"') === 1,
    `${label} packed-candidate-lane job must install the verified tarball.`,
  )
  invariant(
    count(job, '--expected-sha256 "${{ steps.release-artifact.outputs.sha256 }}"') === 1,
    `${label} packed-candidate-lane job must pass the verified SHA-256 to the runner.`,
  )
  assertNoArtifactMutation(job, label)
}

// The exact-artifact lane consumes the same immutable workflow artifact as the
// packed-candidate lane and installs it into a fresh exact DSH Host.
function assertExactArtifactLaneJob(job, expected, label) {
  invariant(
    count(job, 'runs-on: ${{ matrix.os }}') === 1,
    `${label} exact-artifact-lane job must use the reviewed matrix runner exactly once.`,
  )
  invariant(
    count(job, 'node-version: ${{ matrix.node }}') === 1,
    `${label} exact-artifact-lane job must use the reviewed Node matrix exactly once.`,
  )
  assertMatrix(job, expected, `${label} exact-artifact-lane`)
  invariant(
    count(job, 'pnpm install --frozen-lockfile') === 1,
    `${label} exact-artifact-lane job must install the locked graph exactly once.`,
  )
  invariant(
    /^    needs: candidate$/mu.test(job),
    `${label} exact-artifact-lane job must consume the candidate artifact.`,
  )
  invariant(
    count(job, PINNED_ACTIONS.downloadArtifact) === 1,
    `${label} exact-artifact-lane job must download the shared artifact exactly once.`,
  )
  invariant(
    count(job, `name: ${RELEASE_ARTIFACT_NAME}`) === 1,
    `${label} exact-artifact-lane job must download the canonical workflow artifact.`,
  )
  invariant(
    count(job, 'node scripts/release-artifact.mjs verify') === 1,
    `${label} exact-artifact-lane job must verify the downloaded artifact exactly once.`,
  )
  invariant(
    count(job, 'pnpm run test:exact-artifact-lane') === 1,
    `${label} exact-artifact-lane job must execute the reviewed probe exactly once.`,
  )
  assertProbeScopeInvocation(job, 'request-contracts', `${label} exact-artifact-lane`)
  assertHostGraphModeInvocation(job, 'locked-no-overrides', `${label} exact-artifact-lane`)
  invariant(
    count(job, '--package-tarball "${{ steps.release-artifact.outputs.package-tarball }}"') === 1,
    `${label} exact-artifact-lane job must install the verified tarball.`,
  )
  invariant(
    count(job, '--expected-sha256 "${{ steps.release-artifact.outputs.sha256 }}"') === 1,
    `${label} exact-artifact-lane job must pass the verified SHA-256 to the runner.`,
  )
  assertNoArtifactMutation(job, label)
}

function assertCompatibilityReleaseJob(job, expected, label) {
  invariant(
    count(job, 'runs-on: ${{ matrix.os }}') === 1,
    `${label} compatibility-release job must use the reviewed matrix runner exactly once.`,
  )
  invariant(
    count(job, 'node-version: ${{ matrix.node }}') === 1,
    `${label} compatibility-release job must use the reviewed Node matrix exactly once.`,
  )
  assertMatrix(job, expected, `${label} compatibility-release`)
  invariant(/^    needs: candidate$/mu.test(job), `${label} compatibility-release must depend on candidate.`)
  invariant(
    count(job, 'pnpm install --frozen-lockfile') === 1,
    `${label} compatibility-release job must install the locked graph exactly once per cell.`,
  )
  invariant(
    count(job, PINNED_ACTIONS.downloadArtifact) === 1,
    `${label} compatibility-release job must download the shared artifact exactly once per cell.`,
  )
  invariant(
    count(job, `name: ${RELEASE_ARTIFACT_NAME}`) === 1,
    `${label} compatibility-release job must download the canonical workflow artifact.`,
  )
  invariant(
    count(job, 'node scripts/release-artifact.mjs verify') === 1,
    `${label} compatibility-release job must verify the downloaded candidate exactly once per cell.`,
  )
  invariant(
    count(job, 'pnpm run test:exact-artifact-lane') === 1,
    `${label} compatibility-release job must execute the exact probe exactly once per cell.`,
  )
  assertProbeScopeInvocation(job, 'request-contracts', `${label} compatibility-release`)
  assertHostGraphModeInvocation(job, 'locked-no-overrides', `${label} compatibility-release`)
  invariant(
    count(job, '--package-tarball "${{ steps.release-artifact.outputs.package-tarball }}"') === 1,
    `${label} compatibility-release job must pass the verified tarball.`,
  )
  invariant(
    count(job, '--expected-sha256 "${{ steps.release-artifact.outputs.sha256 }}"') === 1,
    `${label} compatibility-release job must pass the verified SHA-256.`,
  )
  assertNoArtifactMutation(job, label)
}

function assertArtifactConsumer(job, expected, label) {
  assertMatrix(job, expected, label)
  invariant(/^    needs: candidate$/mu.test(job), `${label} must depend on the candidate job.`)
  invariant(
    count(job, PINNED_ACTIONS.downloadArtifact) === 1,
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
  assertNoArtifactMutation(job, label)
}

function assertArtifactFinalizer(job, label) {
  invariant(
    job.includes('    needs:\n      - candidate-install\n      - compatibility-release\n'),
    `${label} must depend on candidate-install and compatibility-release.`,
  )
  invariant(
    count(job, PINNED_ACTIONS.downloadArtifact) === 1,
    `${label} must download the candidate artifact exactly once.`,
  )
  invariant(
    count(job, `name: ${RELEASE_ARTIFACT_NAME}`) === 1,
    `${label} must download the canonical workflow artifact.`,
  )
  invariant(
    count(job, 'node scripts/release-artifact.mjs verify') === 1,
    `${label} must verify the downloaded candidate exactly once.`,
  )
  assertNoArtifactMutation(job, label)
}

function parseJobNeeds(job, label) {
  const lines = job.split(/\r?\n/u)
  const needsIndex = lines.findIndex((line) => line === '    needs:')
  invariant(needsIndex >= 0, `${label} needs block was missing.`)
  const entriesEnd = blockEnd(lines, needsIndex + 1, 4)
  const entries = lines.slice(needsIndex + 1, entriesEnd).filter(isContent)
  invariant(entries.length > 0, `${label} needs block was empty.`)
  const names = entries.map((line) => {
    invariant(
      indentation(line) === 6 && /^      - [a-z][a-z0-9-]*$/u.test(line),
      `${label} needs must use a block list of job IDs.`,
    )
    return line.slice('      - '.length)
  })
  return names
}

function assertExactStringSet(actual, expected, message) {
  const sortedActual = [...actual].sort()
  const sortedExpected = [...expected].sort()
  invariant(JSON.stringify(sortedActual) === JSON.stringify(sortedExpected), message)
}

function parseGateEnvironment(job, label) {
  const lines = job.split(/\r?\n/u)
  const envIndex = lines.findIndex((line) => line === '        env:')
  invariant(envIndex >= 0, `${label} environment mapping was missing.`)
  const envEnd = blockEnd(lines, envIndex + 1, 8)
  const entries = lines.slice(envIndex + 1, envEnd).filter(isContent)
  invariant(
    entries.length === REQUIRED_CI_GATE_ENV.length,
    `${label} environment mapping did not match the required results.`,
  )
  const actual = entries.map((line) => {
    invariant(indentation(line) === 10, `${label} environment mapping indentation was invalid.`)
    const match = /^\s{10}([A-Z][A-Z0-9_]*)\s*:\s*(.+)$/u.exec(line)
    invariant(match !== null, `${label} environment mapping syntax was invalid.`)
    const [, name, value] = match
    invariant(name !== undefined && value !== undefined, `${label} environment mapping was incomplete.`)
    return [name, value]
  })
  invariant(
    JSON.stringify(actual) === JSON.stringify(REQUIRED_CI_GATE_ENV),
    `${label} environment mapping did not match the required results.`,
  )
}

function gateShellBody(job, label) {
  const lines = job.split(/\r?\n/u)
  const runIndex = lines.findIndex((line) => line === '        run: |')
  invariant(runIndex >= 0, `${label} must contain one literal bash script.`)
  const runEnd = blockEnd(lines, runIndex + 1, 8)
  return lines.slice(runIndex + 1, runEnd).map((line) => line.trim()).join('\n')
}

function assertRequiredCiGateJob(job, expectedNeeds) {
  const label = 'CI required-ci-gate job'
  const directIfLines = job.split(/\r?\n/u).filter((line) => /^    if\s*:/u.test(line))
  invariant(
    count(job, '    name: Required CI gate') === 1,
    `${label} must use the reviewed name exactly once.`,
  )
  invariant(
    directIfLines.length === 1 && directIfLines[0] === '    if: ${{ always() }}',
    `${label} must execute with always() exactly once.`,
  )
  const needs = parseJobNeeds(job, label)
  invariant(
    new Set(needs).size === needs.length,
    `${label} needs must not contain duplicate job IDs.`,
  )
  assertExactStringSet(
    needs,
    expectedNeeds,
    `${label} needs must contain every other CI job exactly once.`,
  )
  invariant(
    count(job, '    runs-on: ubuntu-latest') === 1,
    `${label} must use the reviewed Linux runner exactly once.`,
  )
  invariant(
    count(job, '    permissions: {}') === 1,
    `${label} must disable all job permissions exactly once.`,
  )
  invariant(
    count(job, '    steps:') === 1
      && count(job, '      - name: Evaluate required CI results') === 1
      && count(job, '        shell: bash') === 1
      && count(job, '        run: |') === 1,
    `${label} must contain exactly one bash step.`,
  )
  invariant(
    !/^\s*-\s+uses\s*:/mu.test(job) && !/\buses\s*:/u.test(job),
    `${label} must not use an Action.`,
  )
  const stepLinesSource = job.split(/\r?\n/u)
  const stepsIndex = stepLinesSource.findIndex((line) => line === '    steps:')
  const stepsEnd = blockEnd(stepLinesSource, stepsIndex + 1, 4)
  const stepLines = stepLinesSource.slice(stepsIndex + 1, stepsEnd)
    .filter((line) => /^      -\s+/u.test(line))
  invariant(stepLines.length === 1, `${label} must contain exactly one step.`)
  parseGateEnvironment(job, label)

  const shell = gateShellBody(job, label)
  invariant(
    count(shell, 'set -euo pipefail') === 1,
    `${label} must enable strict shell failure handling.`,
  )
  for (const [name] of REQUIRED_CI_GATE_ENV.slice(0, REQUIRED_CI_BLOCKING_JOBS.length)) {
    invariant(
      count(shell, `[ "$${name}" != "success" ]`) === 1,
      `${label} must require ${name} to be success.`,
    )
  }
  invariant(
    shell.includes('case "$EVENT_NAME" in')
      && shell.includes('pull_request)')
      && shell.includes('if [ "$DEPENDENCY_REVIEW_RESULT" != "success" ]')
      && shell.includes('push)')
      && shell.includes('if [ "$DEPENDENCY_REVIEW_RESULT" != "skipped" ]')
      && shell.includes('*)')
      && count(shell, 'exit 1') >= 3,
    `${label} must fail closed for dependency review and unknown events.`,
  )
  invariant(
    !shell.includes('|| true') && !shell.includes('exit 0') && !shell.includes('continue'),
    `${label} shell must not mask a failed result.`,
  )
}

function assertCiJobTopology(workflow) {
  for (const job of workflowJobs(workflow)) {
    const label = `CI ${job.name} job`
    invariant(
      !/^\s+continue-on-error\s*:/mu.test(job.body),
      `${label} must not ignore a failed check.`,
    )
    if (job.name === REQUIRED_CI_GATE_JOB) {
      continue
    }
    if (job.name === 'dependency-review') {
      const directIfLines = job.body.split(/\r?\n/u)
        .filter((line) => /^    if\s*:/u.test(line))
      invariant(
        directIfLines.length === 1
          && directIfLines[0] === "    if: github.event_name == 'pull_request'",
        `${label} must run only on pull_request events.`,
      )
      continue
    }
    invariant(
      !/^    if\s*:/mu.test(job.body),
      `${label} must not have a job-level condition.`,
    )
  }
}

function permissionDeclarations(workflow) {
  return workflow.split(/\r?\n/u)
    .map((line, index) => ({ index, line }))
    .filter(({ line }) => /^\s*(?:permissions|'permissions'|"permissions")\s*:/u.test(line))
}

function concurrencyDeclarations(workflow) {
  return workflow.split(/\r?\n/u)
    .map((line, index) => ({ index, line }))
    .filter(({ line }) => /^\s*(?:concurrency|'concurrency'|"concurrency")\s*:/u.test(line))
}

function assertSerializedReleaseWorkflow(workflow) {
  const declarations = concurrencyDeclarations(workflow)
  invariant(
    declarations.length === 1 && indentation(declarations[0]?.line ?? '') === 0,
    'Release workflow must serialize runs without cancelling an in-progress release.',
  )
  const declaration = declarations[0]
  invariant(
    declaration !== undefined && declaration.line === 'concurrency:',
    'Release workflow must serialize runs without cancelling an in-progress release.',
  )

  const lines = workflow.split(/\r?\n/u)
  const end = blockEnd(lines, declaration.index + 1, 0)
  const entries = lines.slice(declaration.index + 1, end).filter(isContent)
  invariant(
    entries.length === 2
      && entries[0] === '  group: dsh-codex-sub-release'
      && entries[1] === '  cancel-in-progress: false',
    'Release workflow must serialize runs without cancelling an in-progress release.',
  )
}

function assertPermissionBlock(workflow, declaration, expectedEntries, label) {
  const lines = workflow.split(/\r?\n/u)
  const parentIndent = indentation(declaration.line)
  invariant(
    declaration.line.trim() === 'permissions:',
    `${label} permissions must use the reviewed block form.`,
  )
  const end = blockEnd(lines, declaration.index + 1, parentIndent)
  const entries = lines.slice(declaration.index + 1, end).filter(isContent)
  invariant(
    entries.length === expectedEntries.length
      && entries.every((entry, index) => (
        entry.trim() === expectedEntries[index]
          && indentation(entry) === parentIndent + 2
      )),
    `${label} permissions must use the reviewed block form.`,
  )
}

function assertNoReleaseGateOverride(job, label) {
  invariant(
    !/^\s*(?:-\s*)?(?:(?:if|continue-on-error)|'(?:if|continue-on-error)'|"(?:if|continue-on-error)")\s*:/mu.test(job),
    `${label} must not skip or ignore the protected-main gate.`,
  )
}

function assertReleaseGateChain(workflow, releaseMode) {
  const jobs = [
    ['release-ref', 'Release ref verification'],
    ['source-checks', 'Release source-checks job'],
    ['candidate', 'Release candidate job'],
    ['candidate-install', 'Release candidate-install job'],
    ['compatibility-release', 'Release compatibility-release job'],
    ['candidate-ready', 'Release candidate-ready job'],
  ]
  if (releaseMode === 'staged') {
    jobs.push(['stage-publish', 'Release staging job'])
  }
  for (const [jobId, label] of jobs) {
    assertNoReleaseGateOverride(jobBody(workflow, jobId), label)
  }
}

function assertReleaseRefGuard(job) {
  invariant(
    /^          RELEASE_REF:\s*\$\{\{ github\.ref \}\}\s*$/mu.test(job),
    'Release ref verification must read github.ref explicitly.',
  )
  invariant(
    job.includes('if [ "$RELEASE_REF" != "refs/heads/main" ]; then')
      && job.includes('exit 1'),
    'Release ref verification must fail outside protected main.',
  )
}

function assertReleaseCandidateDependencies(job) {
  invariant(
    job.includes('    needs:\n      - release-ref\n      - source-checks\n'),
    'Release candidate job must depend on source-checks and release-ref.',
  )
}

function assertReadOnlyWorkflowPermissions(workflow, label, options = {}) {
  const declarations = permissionDeclarations(workflow)
  const workflowDeclarations = declarations.filter(({ line }) => indentation(line) === 0)
  invariant(
    workflowDeclarations.length === 1,
    `${label} must declare exactly one workflow-level permissions block.`,
  )

  const emptyJobDeclarations = declarations.filter(({ line }) => line.trim() === 'permissions: {}')
  if (options.allowEmptyJob !== undefined) {
    invariant(
      emptyJobDeclarations.length === 1
        && indentation(emptyJobDeclarations[0]?.line ?? '') === 4
        && jobBody(workflow, options.allowEmptyJob).includes('\n    permissions: {}\n'),
      `${label} must contain exactly one empty permission block for ${options.allowEmptyJob}.`,
    )
  } else {
    invariant(emptyJobDeclarations.length === 0, `${label} contained an unexpected empty permission block.`)
  }

  for (const declaration of declarations) {
    if (options.allowEmptyJob !== undefined && declaration.line.trim() === 'permissions: {}') {
      continue
    }
    try {
      assertPermissionBlock(workflow, declaration, ['contents: read'], label)
    } catch {
      throw new Error(`${label} permissions must use a block containing only contents: read.`)
    }
  }
}

function assertReleaseWorkflowPermissions(workflow, stageJob) {
  const declarations = permissionDeclarations(workflow)
  const workflowDeclarations = declarations.filter(({ line }) => indentation(line) === 0)
  invariant(
    workflowDeclarations.length === 1 && declarations.length === 2,
    'Release workflow must have one read-only default and one stage-only OIDC permission block.',
  )
  const workflowDeclaration = workflowDeclarations[0]
  invariant(workflowDeclaration !== undefined, 'Release workflow permissions were missing.')
  assertPermissionBlock(
    workflow,
    workflowDeclaration,
    ['contents: read'],
    'Release workflow default',
  )

  const stageDeclarations = permissionDeclarations(stageJob)
  invariant(
    stageDeclarations.length === 1,
    'Release staging job must declare exactly one OIDC permission block.',
  )
  const stageDeclaration = stageDeclarations[0]
  invariant(stageDeclaration !== undefined, 'Release staging permissions were missing.')
  assertPermissionBlock(
    stageJob,
    stageDeclaration,
    ['contents: read', 'id-token: write'],
    'Release staging job',
  )
}

function assertTrustedPublishingVersion(workflow) {
  const lines = workflow.split(/\r?\n/u)
  const envIndex = lines.findIndex((line) => line === 'env:')
  invariant(envIndex >= 0, 'Release workflow npm CLI version pin was missing.')
  const envEnd = blockEnd(lines, envIndex + 1, 0)
  const entries = lines.slice(envIndex + 1, envEnd).filter(isContent)
  invariant(
    entries.length === 1 && entries[0] === '  TRUSTED_PUBLISHING_NPM_VERSION: 11.15.0',
    'Release workflow must pin the reviewed npm CLI version exactly once.',
  )
}

function assertStagePublisher(job) {
  const installCommand = 'npm install --global "npm@$TRUSTED_PUBLISHING_NPM_VERSION"\n'
    + '          --registry=https://registry.npmjs.org'
  const stageCommand = 'npm stage publish "${{ steps.release-artifact.outputs.package-tarball }}"\n'
    + '          --tag alpha\n'
    + '          --access public\n'
    + '          --registry=https://registry.npmjs.org'
  invariant(/^    needs: candidate-ready$/mu.test(job), 'Release staging job must depend on candidate-ready.')
  invariant(
    count(job, PINNED_ACTIONS.downloadArtifact) === 1,
    'Release staging job must download the candidate artifact exactly once.',
  )
  invariant(
    count(job, `name: ${RELEASE_ARTIFACT_NAME}`) === 1,
    'Release staging job must download the canonical workflow artifact.',
  )
  invariant(
    count(job, 'node scripts/release-artifact.mjs verify') === 1
      && count(job, '--github-output') === 1,
    'Release staging job must verify and resolve the downloaded candidate exactly once.',
  )
  invariant(
    count(job, installCommand) === 1
      && count(job, 'test "$(npm --version)" = "$TRUSTED_PUBLISHING_NPM_VERSION"') === 1,
    'Release staging job must install and verify the reviewed npm CLI version.',
  )
  invariant(
    count(job, stageCommand) === 1,
    'Release staging job must stage the exact candidate with reviewed registry metadata.',
  )
  assertNoArtifactMutation(job, 'Release staging job')

  const expected = [
    '    name: Stage exact candidate for maintainer approval',
    '    needs: candidate-ready',
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      contents: read',
    '      id-token: write',
    '    steps:',
    `      - uses: ${PINNED_ACTIONS.checkout}`,
    `      - uses: ${PINNED_ACTIONS.setupNode}`,
    '        with:',
    '          node-version: 24',
    `      - uses: ${PINNED_ACTIONS.downloadArtifact}`,
    '        with:',
    `          name: ${RELEASE_ARTIFACT_NAME}`,
    '          path: ${{ runner.temp }}/release-artifact',
    '      - id: release-artifact',
    '        run: >-',
    '          node scripts/release-artifact.mjs verify',
    '          --directory "$RUNNER_TEMP/release-artifact"',
    '          --github-output',
    '      - name: Install the reviewed npm CLI',
    '        run: >-',
    '          npm install --global "npm@$TRUSTED_PUBLISHING_NPM_VERSION"',
    '          --registry=https://registry.npmjs.org',
    '      - name: Verify the npm CLI version',
    '        run: test "$(npm --version)" = "$TRUSTED_PUBLISHING_NPM_VERSION"',
    '      - name: Stage the exact candidate',
    '        run: >-',
    '          npm stage publish "${{ steps.release-artifact.outputs.package-tarball }}"',
    '          --tag alpha',
    '          --access public',
    '          --registry=https://registry.npmjs.org',
  ].join('\n')
  const normalized = job.replace(/\s+#.*$/gmu, '').trimEnd()
  invariant(
    normalized === expected,
    'Release staging job steps must exactly match the reviewed OIDC staging topology.',
  )
}

function assertNoRegistryCredentials(workflow) {
  const forbidden = [
    /\b(?:NODE_AUTH_TOKEN|NPM_TOKEN)\b/iu,
    /\bsecrets(?:\.|\[)/iu,
    /\bvars(?:\.|\[)/iu,
    /_authToken/iu,
    /\.npmrc\b/iu,
    /\b(?:always-auth|registry-url)\s*:/iu,
    /\b(?:npm|pnpm|yarn\s+npm)\s+(?:adduser|login)\b/iu,
  ]
  invariant(
    forbidden.every((pattern) => !pattern.test(workflow)),
    'Release workflow must not contain npm registry credential plumbing.',
  )
}

function assertNonPublishingWorkflow(workflow, label, options = {}) {
  const jobs = workflowJobsBody(workflow)
  invariant(!/\bpublish\b/u.test(jobs), `${label} must not contain a publish operation.`)
  assertReadOnlyWorkflowPermissions(workflow, label, options)
}

function assertStagedPublishingWorkflow(workflow, stageJob) {
  const jobs = workflowJobsBody(workflow)
  invariant(
    !/\b(?:npm|pnpm|yarn(?:\s+npm)?)\s+publish\b/iu.test(jobs),
    'Release workflow must not publish directly.',
  )
  invariant(
    !/\bnpm\s+stage\s+(?:approve|reject)\b/iu.test(jobs),
    'Release workflow must leave staged-package approval to a maintainer.',
  )
  invariant(
    count(jobs, 'npm stage publish') === 1 && count(stageJob, 'npm stage publish') === 1,
    'Release workflow must contain exactly one reviewed staging operation.',
  )
  assertReleaseWorkflowPermissions(workflow, stageJob)
  assertTrustedPublishingVersion(workflow)
}

export function validateWorkflowContracts({
  ciWorkflow,
  compatibility,
  releaseMode = 'staged',
  releaseWorkflow,
}) {
  const expected = expectedPackedInstallMatrix(compatibility)
  assertPinnedActions(ciWorkflow, 'CI workflow')
  assertPinnedActions(releaseWorkflow, 'Release workflow')
  assertNoCheckoutOverrides(ciWorkflow, 'CI workflow')
  assertNoCheckoutOverrides(releaseWorkflow, 'Release workflow')
  assertNoRegistryCredentials(releaseWorkflow)
  assertSerializedReleaseWorkflow(releaseWorkflow)
  invariant(
    count(ciWorkflow, '--probe-scope request-contracts') === 1,
    'CI workflow must invoke the request-contracts scope exactly once.',
  )
  invariant(
    count(ciWorkflow, '--probe-scope credential-topology') === 1,
    'CI workflow must invoke the credential-topology scope exactly once.',
  )
  assertExactJobSet(
    ciWorkflow,
    [
      'candidate',
      'candidate-lane',
      'check',
      'dependency-review',
      'exact-artifact-lane',
      'packed-candidate-lane',
      'packed-install',
      REQUIRED_CI_GATE_JOB,
    ],
    'CI workflow',
  )
  const ciJobNames = workflowJobs(ciWorkflow).map((job) => job.name)
  assertRequiredCiGateJob(
    jobBody(ciWorkflow, REQUIRED_CI_GATE_JOB),
    ciJobNames.filter((name) => name !== REQUIRED_CI_GATE_JOB),
  )
  assertCiJobTopology(ciWorkflow)
  assertCandidateLaneJob(jobBody(ciWorkflow, 'candidate-lane'), 'CI')
  assertPackedCandidateLaneJob(jobBody(ciWorkflow, 'packed-candidate-lane'), 'CI')
  assertExactArtifactLaneJob(jobBody(ciWorkflow, 'exact-artifact-lane'), expected, 'CI')
  const releaseJobs = [
    'candidate',
    'candidate-install',
    'candidate-ready',
    'compatibility-release',
    'release-ref',
    'source-checks',
  ]
  if (releaseMode === 'staged') {
    releaseJobs.push('stage-publish')
  } else {
    invariant(releaseMode === 'verification-only', 'Release workflow mode was invalid.')
  }
  assertExactJobSet(releaseWorkflow, releaseJobs, 'Release workflow')
  assertReleaseGateChain(releaseWorkflow, releaseMode)
  assertArtifactProducer(jobBody(ciWorkflow, 'candidate'), 'CI candidate job')
  assertArtifactConsumer(jobBody(ciWorkflow, 'packed-install'), expected, 'CI')
  assertOnlyProducerMutatesArtifact(ciWorkflow, 'candidate', 'CI')
  assertNonPublishingWorkflow(ciWorkflow, 'CI workflow', { allowEmptyJob: REQUIRED_CI_GATE_JOB })
  assertReleaseRefGuard(jobBody(releaseWorkflow, 'release-ref'))
  const releaseCandidate = jobBody(releaseWorkflow, 'candidate')
  assertReleaseCandidateDependencies(releaseCandidate)
  assertArtifactProducer(releaseCandidate, 'Release candidate job')
  assertArtifactConsumer(
    jobBody(releaseWorkflow, 'candidate-install'),
    expected,
    'Release workflow',
  )
  assertCompatibilityReleaseJob(
    jobBody(releaseWorkflow, 'compatibility-release'),
    expected,
    'Release workflow',
  )
  assertArtifactFinalizer(
    jobBody(releaseWorkflow, 'candidate-ready'),
    'Release candidate-ready job',
  )
  assertOnlyProducerMutatesArtifact(releaseWorkflow, 'candidate', 'Release workflow')
  if (releaseMode === 'staged') {
    const stageJob = jobBody(releaseWorkflow, 'stage-publish')
    assertStagePublisher(stageJob)
    assertStagedPublishingWorkflow(releaseWorkflow, stageJob)
  } else {
    assertNonPublishingWorkflow(releaseWorkflow, 'Release workflow')
  }
}
