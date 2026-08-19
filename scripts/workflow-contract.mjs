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
  assertNoArtifactMutation(job, label)
}

function assertArtifactFinalizer(job, label) {
  invariant(/^    needs: candidate-install$/mu.test(job), `${label} must depend on candidate-install.`)
  invariant(
    count(job, 'actions/download-artifact@v7') === 1,
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

function assertNonPublishingWorkflow(workflow) {
  const jobsMarker = '\njobs:\n'
  const jobsStart = workflow.indexOf(jobsMarker)
  invariant(jobsStart >= 0, 'Release workflow jobs were missing.')
  const jobs = workflow.slice(jobsStart + jobsMarker.length)
  invariant(!/\bpublish\b/u.test(jobs), 'Release workflow must not contain a publish operation.')
  invariant(
    !/^\s*id-token:\s*write\s*$/mu.test(workflow),
    'Release workflow must not request OIDC write permission before trusted publishing is enabled.',
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
  assertArtifactFinalizer(
    jobBody(releaseWorkflow, 'candidate-ready'),
    'Release candidate-ready job',
  )
  assertNonPublishingWorkflow(releaseWorkflow)
}
