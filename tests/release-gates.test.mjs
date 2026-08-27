import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  appendCapture,
  assertCaptureComplete,
} from '../scripts/capture-output.mjs'
import {
  assertPackageEntrySize,
  assertPackageFiles,
  assertPackageUnpackedSize,
  PACKAGE_ENTRY_LIMIT_BYTES,
  PACKAGE_JSON_LIMIT_BYTES,
  PACKAGE_README_LIMIT_BYTES,
  PACKAGE_TARBALL_LIMIT_BYTES,
  PACKAGE_UNPACKED_LIMIT_BYTES,
  validatePackageTarball,
} from '../scripts/package-tarball.mjs'
import { PACKAGE_FILE_ALLOWLIST } from '../scripts/package-files.mjs'
import { assertPackageReadmeLinks } from '../scripts/package-readme-contract.mjs'
import {
  assertReleaseChecksum,
  selectReleaseTarball,
} from '../scripts/release-artifact-contract.mjs'
import { validateReleaseState } from '../scripts/release-state-contract.mjs'
import {
  PINNED_ACTIONS,
  validateWorkflowContracts,
} from '../scripts/workflow-contract.mjs'

const temporaryDirectories = []

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-codex-sub-release-gate-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { force: true, recursive: true })
  )))
})

async function packageTarball(overrides = new Map()) {
  const directory = await temporaryDirectory()
  const packageDirectory = join(directory, 'package')
  const manifestText = await readFile(new URL('../package.json', import.meta.url), 'utf8')
  const manifest = JSON.parse(manifestText)
  for (const path of PACKAGE_FILE_ALLOWLIST) {
    const destination = join(packageDirectory, path)
    await mkdir(dirname(destination), { recursive: true })
    const fallback = path === 'package.json' ? manifestText : ''
    await writeFile(destination, overrides.get(path) ?? fallback)
  }
  const tarball = join(directory, `${String(manifest.name)}-${String(manifest.version)}.tgz`)
  const report = spawnSync('tar', [
    '-czf',
    tarball,
    '-C',
    directory,
    ...PACKAGE_FILE_ALLOWLIST.map((path) => `package/${path}`),
  ], { encoding: 'utf8', shell: false })
  expect(report.status).toBe(0)
  return tarball
}

async function readReleaseWorkflow() {
  for (const path of ['../.github/workflows/release.yml', '../.github/workflows/release.yml.disabled']) {
    try {
      return await readFile(new URL(path, import.meta.url), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error
      }
    }
  }
  throw new Error('Release workflow was missing.')
}

function mutateCiJob(workflow, jobName, mutator) {
  const marker = `\n  ${jobName}:\n`
  const start = workflow.indexOf(marker)
  expect(start).toBeGreaterThanOrEqual(0)
  const bodyStart = start + marker.length
  const nextJob = workflow.slice(bodyStart).search(/^  [a-z][a-z0-9-]*:\s*$/mu)
  const end = nextJob < 0 ? workflow.length : bodyStart + nextJob
  return workflow.slice(0, bodyStart) + mutator(workflow.slice(bodyStart, end)) + workflow.slice(end)
}

describe('package tarball fail-closed validation', () => {
  it('rejects relative paths before reading the filesystem', async () => {
    await expect(validatePackageTarball('candidate.tgz')).rejects.toThrow(
      '--package-tarball must be an absolute path.',
    )
  })

  it('rejects symbolic links and oversized regular files', async () => {
    const directory = await temporaryDirectory()
    const target = join(directory, 'target.tgz')
    const link = join(directory, 'linked.tgz')
    const oversized = join(directory, 'oversized.tgz')
    await writeFile(target, 'not-a-tarball')
    await symlink(target, link)
    await writeFile(oversized, '')
    await truncate(oversized, PACKAGE_TARBALL_LIMIT_BYTES + 1)

    await expect(validatePackageTarball(link)).rejects.toThrow(
      'Package tarball must be a regular file.',
    )
    await expect(validatePackageTarball(oversized)).rejects.toThrow(
      `Package tarball must be between 1 and ${String(PACKAGE_TARBALL_LIMIT_BYTES)} bytes.`,
    )
  })

  it('rejects non-regular entries inside an archive', async () => {
    const directory = await temporaryDirectory()
    const packageDirectory = join(directory, 'package')
    const tarball = join(directory, 'non-regular.tgz')
    await mkdir(packageDirectory)
    await writeFile(join(packageDirectory, 'package.json'), '{}')
    await symlink('package.json', join(packageDirectory, 'linked.json'))
    const report = spawnSync('tar', [
      '-czf',
      tarball,
      '-C',
      directory,
      'package/linked.json',
    ], { encoding: 'utf8', shell: false })
    expect(report.status).toBe(0)

    await expect(validatePackageTarball(tarball)).rejects.toThrow(
      'Package tarball entries must all be regular files.',
    )
  })

  it('rejects missing, unexpected, and duplicate archive paths', () => {
    expect(() => assertPackageFiles([])).toThrow('Package tarball contents did not match the allowlist.')
    expect(() => assertPackageFiles(['unexpected.txt'])).toThrow('Unexpected: unexpected.txt.')
    expect(() => assertPackageFiles([...PACKAGE_FILE_ALLOWLIST, 'package.json'])).toThrow(
      'Package tarball contents did not match the allowlist.',
    )
  })

  it('enforces entry-specific and total unpacked byte budgets', () => {
    expect(() => assertPackageEntrySize('lib/runtime.mjs', PACKAGE_ENTRY_LIMIT_BYTES)).not.toThrow()
    expect(() => assertPackageEntrySize('lib/runtime.mjs', PACKAGE_ENTRY_LIMIT_BYTES + 1)).toThrow(
      `Package tarball entry lib/runtime.mjs must be at most ${String(PACKAGE_ENTRY_LIMIT_BYTES)} bytes.`,
    )
    expect(() => assertPackageEntrySize('package.json', PACKAGE_JSON_LIMIT_BYTES + 1)).toThrow(
      `Package tarball entry package.json must be at most ${String(PACKAGE_JSON_LIMIT_BYTES)} bytes.`,
    )
    expect(() => assertPackageEntrySize('README.md', PACKAGE_README_LIMIT_BYTES + 1)).toThrow(
      `Package tarball entry README.md must be at most ${String(PACKAGE_README_LIMIT_BYTES)} bytes.`,
    )
    expect(() => assertPackageUnpackedSize(PACKAGE_UNPACKED_LIMIT_BYTES)).not.toThrow()
    expect(() => assertPackageUnpackedSize(PACKAGE_UNPACKED_LIMIT_BYTES + 1)).toThrow(
      `Package tarball unpacked content must be at most ${String(PACKAGE_UNPACKED_LIMIT_BYTES)} bytes.`,
    )
  })

  it('rejects a highly compressed oversized README from the actual archive', async () => {
    const tarball = await packageTarball(new Map([
      ['README.md', Buffer.alloc(PACKAGE_README_LIMIT_BYTES + 1, 0x61)],
    ]))
    await expect(validatePackageTarball(tarball)).rejects.toThrow(
      `Package tarball entry README.md must be at most ${String(PACKAGE_README_LIMIT_BYTES)} bytes.`,
    )
  })

  it('rejects a highly compressed oversized normal entry from the actual archive', async () => {
    const tarball = await packageTarball(new Map([
      ['lib/runtime.mjs', Buffer.alloc(PACKAGE_ENTRY_LIMIT_BYTES + 1, 0x61)],
    ]))
    await expect(validatePackageTarball(tarball)).rejects.toThrow(
      `Package tarball entry lib/runtime.mjs must be at most ${String(PACKAGE_ENTRY_LIMIT_BYTES)} bytes.`,
    )
  })

  it('rejects a highly compressed oversized manifest from the actual archive', async () => {
    const tarball = await packageTarball(new Map([
      ['package.json', Buffer.alloc(PACKAGE_JSON_LIMIT_BYTES + 1, 0x61)],
    ]))
    await expect(validatePackageTarball(tarball)).rejects.toThrow(
      `Package tarball entry package.json must be at most ${String(PACKAGE_JSON_LIMIT_BYTES)} bytes.`,
    )
  })

  it('rejects highly compressed entries whose combined size exceeds the total budget', async () => {
    const largeEntry = Buffer.alloc(PACKAGE_ENTRY_LIMIT_BYTES, 0x61)
    const tarball = await packageTarball(new Map([
      ['lib/bin.d.mts', largeEntry],
      ['lib/bin.mjs', largeEntry],
      ['lib/index.d.mts', largeEntry],
      ['lib/index.mjs', largeEntry],
    ]))
    await expect(validatePackageTarball(tarball)).rejects.toThrow(
      `Package tarball unpacked content must be at most ${String(PACKAGE_UNPACKED_LIMIT_BYTES)} bytes.`,
    )
  })
})

describe('packaged README link validation', () => {
  it('accepts HTTPS, anchors, and links to files shipped in the package', () => {
    expect(() => assertPackageReadmeLinks(
      '[repository](https://github.com/TakahisaI/dsh-codex-sub) '
        + '[section](#install) [license](LICENSE)',
      'README.md',
    )).not.toThrow()
  })

  it('rejects inline and reference links to files omitted from the package', () => {
    const cases = [
      '[security](docs/security.md)',
      '[security][policy]\n\n[policy]: docs/security.md',
    ]
    for (const markdown of cases) {
      expect(() => assertPackageReadmeLinks(markdown, 'README.md')).toThrow(
        'README.md link target is not available from the package: docs/security.md',
      )
    }
  })

  it('validates README links from the actual package archive', async () => {
    const tarball = await packageTarball(new Map([
      ['README.md', '[security](docs/security.md)'],
    ]))
    await expect(validatePackageTarball(tarball)).rejects.toThrow(
      'Packed README.md link target is not available from the package: docs/security.md',
    )
  })
})

describe('release artifact fail-closed validation', () => {
  it('requires exactly one tarball and one checksum file', () => {
    expect(selectReleaseTarball(['SHA256SUMS', 'candidate.tgz'], 'SHA256SUMS')).toBe(
      'candidate.tgz',
    )
    expect(() => selectReleaseTarball(
      ['SHA256SUMS', 'candidate.tgz', 'nested/candidate.tgz'],
      'SHA256SUMS',
    )).toThrow('Release artifact must contain exactly one package tarball and SHA256SUMS.')
  })

  it('rejects any checksum or filename mismatch', () => {
    expect(() => assertReleaseChecksum('wrong  candidate.tgz\n', 'expected', 'candidate.tgz'))
      .toThrow('Release artifact SHA-256 did not match the package tarball.')
    expect(() => assertReleaseChecksum('expected  other.tgz\n', 'expected', 'candidate.tgz'))
      .toThrow('Release artifact SHA-256 did not match the package tarball.')
    expect(() => assertReleaseChecksum('expected  candidate.tgz\n', 'expected', 'candidate.tgz'))
      .not.toThrow()
  })

  it('fails when stdout capture exceeds its byte limit', () => {
    const stdout = { bytes: 0, truncated: false, value: '' }
    const stderr = { bytes: 0, truncated: false, value: '' }
    appendCapture(stdout, 'abcdef', 4)
    expect(stdout).toEqual({ bytes: 4, truncated: true, value: 'abcd' })
    expect(() => assertCaptureComplete(stdout, stderr)).toThrow(
      'DSH output exceeded the packed-install capture limit.',
    )
  })

  it('accepts a complete capture exactly at the limit and rejects later stdout or stderr', () => {
    const stdout = { bytes: 0, truncated: false, value: '' }
    const stderr = { bytes: 0, truncated: false, value: '' }
    appendCapture(stdout, 'abcd', 4)
    expect(() => assertCaptureComplete(stdout, stderr)).not.toThrow()

    appendCapture(stderr, 'abcde', 4)
    expect(stderr).toEqual({ bytes: 4, truncated: true, value: 'abcd' })
    expect(() => assertCaptureComplete(stdout, stderr)).toThrow(
      'DSH output exceeded the packed-install capture limit.',
    )
  })
})

describe('workflow release evidence', () => {
  async function repositoryInputs() {
    const [ciWorkflow, releaseWorkflow, compatibilityText] = await Promise.all([
      readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
      readReleaseWorkflow(),
      readFile(new URL('../compatibility.json', import.meta.url), 'utf8'),
    ])
    return { ciWorkflow, compatibility: JSON.parse(compatibilityText), releaseWorkflow }
  }

  it('requires both workflows to distribute one candidate across the exact supported matrix', async () => {
    const inputs = await repositoryInputs()
    expect(() => validateWorkflowContracts(inputs)).not.toThrow()
  })

  it('pins artifact actions to the reviewed v8 and v7 commit SHAs', async () => {
    const inputs = await repositoryInputs()
    expect(inputs.ciWorkflow.match(/actions\/download-artifact@/gu)).toHaveLength(3)
    expect(inputs.releaseWorkflow.match(/actions\/download-artifact@/gu)).toHaveLength(4)
    expect(inputs.ciWorkflow.match(/actions\/upload-artifact@/gu)).toHaveLength(1)
    expect(inputs.releaseWorkflow.match(/actions\/upload-artifact@/gu)).toHaveLength(1)
    for (const [workflowKey, oldPin, tagPin, otherSha] of [
      ['ciWorkflow', 'actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131', 'actions/download-artifact@v8', 'actions/download-artifact@0000000000000000000000000000000000000000'],
      ['releaseWorkflow', 'actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f', 'actions/upload-artifact@v7', 'actions/upload-artifact@0000000000000000000000000000000000000000'],
    ]) {
      for (const replacement of [oldPin, tagPin, otherSha]) {
        const workflow = inputs[workflowKey].replace(
          workflowKey === 'ciWorkflow' ? PINNED_ACTIONS.downloadArtifact : PINNED_ACTIONS.uploadArtifact,
          replacement,
        )
        expect(workflow).not.toBe(inputs[workflowKey])
        expect(() => validateWorkflowContracts({ ...inputs, [workflowKey]: workflow })).toThrow(
          `${workflowKey === 'ciWorkflow' ? 'CI' : 'Release'} workflow actions must use reviewed full commit SHAs.`,
        )
      }
    }
  })

  it('requires the aggregate gate to cover every other CI job', async () => {
    const inputs = await repositoryInputs()
    const gateNeeds = [
      '      - check\n',
      '      - candidate\n',
      '      - candidate-lane\n',
      '      - packed-candidate-lane\n',
      '      - exact-artifact-lane\n',
      '      - packed-install\n',
      '      - dependency-review\n',
    ]
    for (const need of gateNeeds) {
      const ciWorkflow = inputs.ciWorkflow.replace(need, '')
      expect(ciWorkflow).not.toBe(inputs.ciWorkflow)
      expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow })).toThrow(
        'CI required-ci-gate job needs must contain every other CI job exactly once.',
      )
    }

    const duplicate = inputs.ciWorkflow.replace(
      '      - check\n      - candidate\n',
      '      - check\n      - check\n      - candidate\n',
    )
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow: duplicate })).toThrow(
      'CI required-ci-gate job needs must not contain duplicate job IDs.',
    )

    const unknown = inputs.ciWorkflow.replace(
      '      - dependency-review\n    runs-on: ubuntu-latest\n',
      '      - unknown-job\n    runs-on: ubuntu-latest\n',
    )
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow: unknown })).toThrow(
      'CI required-ci-gate job needs must contain every other CI job exactly once.',
    )
  })

  it('rejects a CI job added without extending the reviewed aggregate gate', async () => {
    const inputs = await repositoryInputs()
    const ciWorkflow = inputs.ciWorkflow.replace(
      '\n  required-ci-gate:\n',
      '\n  unreviewed-job:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n\n  required-ci-gate:\n',
    )
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow })).toThrow(
      'CI workflow job set did not match the reviewed contract.',
    )
  })

  it('requires the aggregate gate to use the fixed always, permissions, and action-free topology', async () => {
    const inputs = await repositoryInputs()
    const cases = [
      [
        'if: ${{ always() }}',
        'if: always()',
        'CI required-ci-gate job must execute with always() exactly once.',
      ],
      [
        'permissions: {}',
        'permissions: write-all',
        'CI required-ci-gate job must disable all job permissions exactly once.',
      ],
      [
        '      - name: Evaluate required CI results',
        `      - uses: ${PINNED_ACTIONS.checkout}\n      - name: Evaluate required CI results`,
        'CI required-ci-gate job must not use an Action.',
      ],
      [
        '      - name: Evaluate required CI results',
        `      - uses: ${PINNED_ACTIONS.downloadArtifact}\n      - name: Evaluate required CI results`,
        'CI required-ci-gate job must not use an Action.',
      ],
      [
        '      - name: Evaluate required CI results',
        `      - uses: ${PINNED_ACTIONS.uploadArtifact}\n      - name: Evaluate required CI results`,
        'CI required-ci-gate job must not use an Action.',
      ],
    ]
    for (const [from, to, expected] of cases) {
      const ciWorkflow = inputs.ciWorkflow.replace(from, to)
      expect(ciWorkflow).not.toBe(inputs.ciWorkflow)
      expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow })).toThrow(expected)
    }
  })

  it('requires the aggregate gate environment to map every need result exactly', async () => {
    const inputs = await repositoryInputs()
    const mappings = [
      [
        '          CANDIDATE_RESULT: ${{ needs.candidate.result }}\n',
        '          CANDIDATE_RESULT: ${{ needs.check.result }}\n',
      ],
      [
        '          PACKED_INSTALL_RESULT: ${{ needs.packed-install.result }}\n',
        '',
      ],
      [
        '          EVENT_NAME: ${{ github.event_name }}\n',
        '          EXTRA_RESULT: ${{ needs.check.result }}\n'
          + '          EVENT_NAME: ${{ github.event_name }}\n',
      ],
    ]
    for (const [from, to] of mappings) {
      const ciWorkflow = inputs.ciWorkflow.replace(from, to)
      expect(ciWorkflow).not.toBe(inputs.ciWorkflow)
      expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow })).toThrow(
        'CI required-ci-gate job environment mapping did not match the required results.',
      )
    }
  })

  it('requires the aggregate gate shell to fail closed for every result and event', async () => {
    const inputs = await repositoryInputs()
    const cases = [
      [
        '[ "$CHECK_RESULT" != "success" ]',
        '[ "$CHECK_RESULT" == "success" ]',
        'CI required-ci-gate job must require CHECK_RESULT to be success.',
      ],
      [
        'set -euo pipefail',
        'set -e',
        'CI required-ci-gate job must enable strict shell failure handling.',
      ],
      [
        '            echo "A required CI job did not succeed." >&2\n',
        '            echo "A required CI job did not succeed." >&2 || true\n',
        'CI required-ci-gate job shell must not mask a failed result.',
      ],
      [
        '            *)\n',
        '            pull_request|push)\n',
        'CI required-ci-gate job must fail closed for dependency review and unknown events.',
      ],
    ]
    for (const [from, to, expected] of cases) {
      const ciWorkflow = inputs.ciWorkflow.replace(from, to)
      expect(ciWorkflow).not.toBe(inputs.ciWorkflow)
      expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow })).toThrow(expected)
    }
  })

  it('requires the aggregate gate shell to match the reviewed script exactly', async () => {
    const inputs = await repositoryInputs()
    const cases = [
      [
        'if false wrapper',
        (workflow) => mutateCiJob(workflow, 'required-ci-gate', (job) => job.replace(
          '          set -euo pipefail\n',
          '          set -euo pipefail\n          if false; then\n',
        )),
        'CI required-ci-gate job must use the reviewed fail-closed script exactly.',
      ],
      [
        'exit immediately',
        (workflow) => mutateCiJob(workflow, 'required-ci-gate', (job) => job.replace(
          '          set -euo pipefail\n',
          '          set -euo pipefail\n          exit 0\n',
        )),
        'CI required-ci-gate job shell must not mask a failed result.',
      ],
      [
        'mask an error',
        (workflow) => mutateCiJob(workflow, 'required-ci-gate', (job) => job.replace(
          '            echo "A required CI job did not succeed." >&2\n',
          '            echo "A required CI job did not succeed." >&2 || true\n',
        )),
        'CI required-ci-gate job shell must not mask a failed result.',
      ],
      [
        'override exit function',
        (workflow) => mutateCiJob(workflow, 'required-ci-gate', (job) => job.replace(
          '          set -euo pipefail\n',
          '          set -euo pipefail\n          exit() { :; }\n',
        )),
        'CI required-ci-gate job must use the reviewed fail-closed script exactly.',
      ],
      [
        'disable errexit',
        (workflow) => mutateCiJob(workflow, 'required-ci-gate', (job) => job.replace(
          '          set -euo pipefail\n',
          '          set -euo pipefail\n          set +e\n',
        )),
        'CI required-ci-gate job must use the reviewed fail-closed script exactly.',
      ],
      [
        'extra command',
        (workflow) => mutateCiJob(workflow, 'required-ci-gate', (job) => job.replace(
          '          esac\n',
          '          esac\n          echo unexpected\n',
        )),
        'CI required-ci-gate job must use the reviewed fail-closed script exactly.',
      ],
      [
        'trailing whitespace',
        (workflow) => mutateCiJob(workflow, 'required-ci-gate', (job) => job.replace(
          '          set -euo pipefail\n',
          '          set -euo pipefail \n',
        )),
        'CI required-ci-gate job must use the reviewed fail-closed script exactly.',
      ],
    ]
    for (const [label, mutate, expected] of cases) {
      const ciWorkflow = mutate(inputs.ciWorkflow)
      expect(ciWorkflow, label).not.toBe(inputs.ciWorkflow)
      expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow })).toThrow(expected)
    }
  })

  it('accepts only the reviewed gate script with LF or CRLF and one optional final newline', async () => {
    const inputs = await repositoryInputs()
    const withoutFinalNewline = inputs.ciWorkflow.replace(/\n$/u, '')
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow: withoutFinalNewline })).not.toThrow()

    const crlf = inputs.ciWorkflow.replace(/\n/gu, '\r\n')
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow: crlf })).not.toThrow()

    const crlfWithoutFinalNewline = crlf.replace(/\r\n$/u, '')
    expect(() => validateWorkflowContracts({
      ...inputs,
      ciWorkflow: crlfWithoutFinalNewline,
    })).not.toThrow()

    expect(() => validateWorkflowContracts({
      ...inputs,
      ciWorkflow: `${inputs.ciWorkflow}\n`,
    })).toThrow('CI required-ci-gate job must use the reviewed fail-closed script exactly.')
  })

  it('keeps dependency review conditional only on pull requests and forbids ignored checks', async () => {
    const inputs = await repositoryInputs()
    const wrongCondition = inputs.ciWorkflow.replace(
      "if: github.event_name == 'pull_request'",
      'if: always()',
    )
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow: wrongCondition })).toThrow(
      'CI dependency-review job must run only on pull_request events.',
    )

    const ignored = inputs.ciWorkflow.replace(
      '  candidate:\n',
      '  candidate:\n    continue-on-error: true\n',
    )
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow: ignored })).toThrow(
      'CI candidate job must not ignore a failed check.',
    )

    const conditional = inputs.ciWorkflow.replace(
      '  candidate:\n',
      '  candidate:\n    if: always()\n',
    )
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow: conditional })).toThrow(
      'CI candidate job must not have a job-level condition.',
    )
  })

  it('rejects quoted job and step skip or ignore controls semantically', async () => {
    const inputs = await repositoryInputs()
    const cases = [
      [
        'gate job continue-on-error',
        'required-ci-gate',
        (job) => job.replace(
          '    name: Required CI gate\n',
          '    \'continue-on-error\': true\n    name: Required CI gate\n',
        ),
        'CI required-ci-gate job must not ignore a failed check.',
      ],
      [
        'gate step continue-on-error',
        'required-ci-gate',
        (job) => job.replace(
          '      - name: Evaluate required CI results\n',
          '      - name: Evaluate required CI results\n        "continue-on-error": true\n',
        ),
        'CI required-ci-gate job steps must not skip or ignore a failed check.',
      ],
      [
        'gate step if',
        'required-ci-gate',
        (job) => job.replace(
          '      - name: Evaluate required CI results\n',
          '      - name: Evaluate required CI results\n        \'if\': false\n',
        ),
        'CI required-ci-gate job steps must not skip or ignore a failed check.',
      ],
      [
        'candidate job if',
        'candidate',
        (job) => job.replace(
          '    name: Build candidate artifact\n',
          '    "if": always()\n    name: Build candidate artifact\n',
        ),
        'CI candidate job must not have a job-level condition.',
      ],
      [
        'candidate job continue-on-error',
        'candidate',
        (job) => job.replace(
          '    name: Build candidate artifact\n',
          '    \'continue-on-error\': true\n    name: Build candidate artifact\n',
        ),
        'CI candidate job must not ignore a failed check.',
      ],
      [
        'candidate step if',
        'candidate',
        (job) => job.replace(
          '      - run: corepack enable\n',
          '      - run: corepack enable\n        "if": false\n',
        ),
        'CI candidate job steps must not skip or ignore a failed check.',
      ],
      [
        'candidate step continue-on-error',
        'candidate',
        (job) => job.replace(
          '      - run: corepack enable\n',
          '      - run: corepack enable\n        \'continue-on-error\': true\n',
        ),
        'CI candidate job steps must not skip or ignore a failed check.',
      ],
      [
        'dependency-review step if',
        'dependency-review',
        (job) => job.replace(
          `      - uses: ${PINNED_ACTIONS.checkout} # v7.0.1\n`,
          `      - uses: ${PINNED_ACTIONS.checkout} # v7.0.1\n        "if": false\n`,
        ),
        'CI dependency-review job steps must not skip or ignore a failed check.',
      ],
      [
        'dependency-review step continue-on-error',
        'dependency-review',
        (job) => job.replace(
          `      - uses: ${PINNED_ACTIONS.checkout} # v7.0.1\n`,
          `      - uses: ${PINNED_ACTIONS.checkout} # v7.0.1\n        'continue-on-error': true\n`,
        ),
        'CI dependency-review job steps must not skip or ignore a failed check.',
      ],
    ]
    for (const [label, jobName, mutateJob, expected] of cases) {
      const ciWorkflow = mutateCiJob(inputs.ciWorkflow, jobName, mutateJob)
      expect(ciWorkflow, label).not.toBe(inputs.ciWorkflow)
      expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow })).toThrow(expected)
    }
  })

  it('ignores comments and scalar content while enforcing the gate scalar exactly', async () => {
    const inputs = await repositoryInputs()
    const comment = mutateCiJob(inputs.ciWorkflow, 'candidate', (job) => job.replace(
      '    name: Build candidate artifact\n',
      '    # if: always()\n    name: Build candidate artifact\n',
    ))
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow: comment })).not.toThrow()

    const scalar = mutateCiJob(inputs.ciWorkflow, 'candidate', (job) => job.replace(
      '      - run: corepack enable\n',
      '      - name: "if: always() continue-on-error: true"\n        run: corepack enable\n',
    ))
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow: scalar })).not.toThrow()

    const gateScalar = mutateCiJob(inputs.ciWorkflow, 'required-ci-gate', (job) => job.replace(
      '          set -euo pipefail\n',
      '          set -euo pipefail\n          echo "if: always()"\n',
    ))
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow: gateScalar })).toThrow(
      'CI required-ci-gate job must use the reviewed fail-closed script exactly.',
    )
  })

  it('fails closed for duplicate keys and aliases in the CI workflow YAML', async () => {
    const inputs = await repositoryInputs()
    const duplicate = mutateCiJob(inputs.ciWorkflow, 'candidate', (job) => job.replace(
      '      - run: corepack enable\n',
      '      - run: corepack enable\n        name: first\n        name: second\n',
    ))
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow: duplicate })).toThrow(
      'CI workflow YAML could not be parsed.',
    )

    const alias = inputs.ciWorkflow
      .replace('    name: Build candidate artifact\n', '    name: &candidate-name Build candidate artifact\n')
      .replace('    name: DSH rc.1 candidate lane\n', '    name: *candidate-name\n')
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow: alias })).toThrow(
      'CI workflow YAML could not be parsed.',
    )
  })

  it('requires the exact-artifact and compatibility-release six-cell matrix with explicit modes', async () => {
    const inputs = await repositoryInputs()
    const exactCells = [
      '          - os: ubuntu-latest\n            node: 22.19.0',
      '          - os: ubuntu-latest\n            node: 24',
      '          - os: ubuntu-latest\n            node: 26',
      '          - os: macos-latest\n            node: 22.19.0',
      '          - os: macos-latest\n            node: 24',
      '          - os: macos-latest\n            node: 26',
    ]
    expect(inputs.ciWorkflow.match(/--host-graph-mode locked-no-overrides/gu)).toHaveLength(1)
    expect(inputs.ciWorkflow.match(/--host-graph-mode override-pinned/gu)).toHaveLength(1)
    expect(inputs.releaseWorkflow.match(/--host-graph-mode locked-no-overrides/gu)).toHaveLength(1)
    expect(inputs.releaseWorkflow).toContain('  compatibility-release:')
    expect(inputs.releaseWorkflow).toContain(
      '      - candidate-install\n      - compatibility-release\n',
    )
    for (const cell of exactCells) {
      expect(inputs.ciWorkflow).toContain(cell)
      expect(inputs.releaseWorkflow).toContain(cell)
    }
  })

  it('rejects a missing exact-artifact cell or a mode omission', async () => {
    const inputs = await repositoryInputs()
    const missingCell = inputs.ciWorkflow.replace(
      '          - os: macos-latest\n            node: 26\n',
      '',
    )
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow: missingCell })).toThrow(
      'CI exact-artifact-lane packed-install matrix did not match compatibility.json.',
    )
    const missingMode = inputs.ciWorkflow.replace(
      '          --host-graph-mode locked-no-overrides\n',
      '',
    )
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow: missingMode })).toThrow(
      'CI exact-artifact-lane must pass --host-graph-mode locked-no-overrides exactly once.',
    )
  })

  it('requires one explicit scope per packed lane and rejects missing, swapped, or duplicate flags', async () => {
    const inputs = await repositoryInputs()
    const missing = inputs.ciWorkflow.replace('          --probe-scope credential-topology\n', '')
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow: missing })).toThrow(
      'CI workflow must invoke the credential-topology scope exactly once.',
    )

    const swapped = inputs.ciWorkflow.replace(
      '          --probe-scope credential-topology\n',
      '          --probe-scope request-contracts\n',
    )
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow: swapped })).toThrow(
      'CI workflow must invoke the request-contracts scope exactly once.',
    )

    const duplicate = inputs.ciWorkflow.replace(
      '          --probe-scope request-contracts\n',
      '          --probe-scope request-contracts\n          --probe-scope request-contracts\n',
    )
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow: duplicate })).toThrow(
      'CI workflow must invoke the request-contracts scope exactly once.',
    )
  })

  it('serializes releases without cancelling a candidate already in progress', async () => {
    const inputs = await repositoryInputs()
    const canonical = 'concurrency:\n  group: dsh-codex-sub-release\n  cancel-in-progress: false'
    const cases = [
      '',
      'concurrency:\n  group: another-release\n  cancel-in-progress: false',
      'concurrency:\n  group: dsh-codex-sub-release\n  cancel-in-progress: true',
      'concurrency: { group: dsh-codex-sub-release, cancel-in-progress: false }',
      '"concurrency":\n  group: dsh-codex-sub-release\n  cancel-in-progress: false',
      `${canonical}\n\n  concurrency: nested-release`,
    ]
    for (const replacement of cases) {
      const releaseWorkflow = inputs.releaseWorkflow.replace(canonical, replacement)
      expect(releaseWorkflow).not.toBe(inputs.releaseWorkflow)
      expect(() => validateWorkflowContracts({ ...inputs, releaseWorkflow })).toThrow(
        'Release workflow must serialize runs without cancelling an in-progress release.',
      )
    }
  })

  it('rejects a missing supported matrix cell', async () => {
    const inputs = await repositoryInputs()
    const releaseWorkflow = inputs.releaseWorkflow.replace(
      '          - os: macos-latest\n            node: 26\n',
      '',
    )
    expect(() => validateWorkflowContracts({ ...inputs, releaseWorkflow })).toThrow(
      'Release workflow packed-install matrix did not match compatibility.json.',
    )
  })

  it('rejects rebuilding inside a candidate consumer', async () => {
    const inputs = await repositoryInputs()
    const ciWorkflow = inputs.ciWorkflow.replace(
      `      - uses: ${PINNED_ACTIONS.downloadArtifact}`,
      `      - run: pnpm run build\n      - uses: ${PINNED_ACTIONS.downloadArtifact}`,
    )
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow })).toThrow(
      'CI must not rebuild the package.',
    )
  })

  it('rejects a direct package repack inside a candidate consumer', async () => {
    const inputs = await repositoryInputs()
    const ciWorkflow = inputs.ciWorkflow.replace(
      `      - uses: ${PINNED_ACTIONS.downloadArtifact}`,
      `      - run: pnpm pack\n      - uses: ${PINNED_ACTIONS.downloadArtifact}`,
    )
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow })).toThrow(
      'CI must not pack the package.',
    )
  })

  it('does not ignore a flow-style matrix cell', async () => {
    const inputs = await repositoryInputs()
    const releaseWorkflow = inputs.releaseWorkflow.replace(
      '          - os: macos-latest\n            node: 26\n',
      '          - os: macos-latest\n            node: 26\n'
        + '          - { os: windows-latest, node: 24 }\n',
    )
    expect(() => validateWorkflowContracts({ ...inputs, releaseWorkflow })).toThrow(
      'Release workflow packed-install matrix did not match compatibility.json.',
    )
  })

  it('accepts the exact supported matrix when every cell uses flow style', async () => {
    const inputs = await repositoryInputs()
    const blockMatrix = [
      '          - os: ubuntu-latest\n            node: 22.19.0',
      '          - os: ubuntu-latest\n            node: 24',
      '          - os: ubuntu-latest\n            node: 26',
      '          - os: macos-latest\n            node: 22.19.0',
      '          - os: macos-latest\n            node: 24',
      '          - os: macos-latest\n            node: 26',
    ].join('\n')
    const flowMatrix = [
      '          - { os: ubuntu-latest, node: 22.19.0 }',
      '          - { os: ubuntu-latest, node: 24 }',
      '          - { os: ubuntu-latest, node: 26 }',
      '          - { os: macos-latest, node: 22.19.0 }',
      '          - { os: macos-latest, node: 24 }',
      '          - { os: macos-latest, node: 26 }',
    ].join('\n')
    const releaseWorkflow = inputs.releaseWorkflow.replace(blockMatrix, flowMatrix)
    expect(releaseWorkflow).not.toBe(inputs.releaseWorkflow)
    expect(() => validateWorkflowContracts({ ...inputs, releaseWorkflow })).not.toThrow()
  })

  it('rejects rebuilding, repacking, or publishing after candidate verification', async () => {
    const inputs = await repositoryInputs()
    const cases = [
      ['pnpm run build', 'Release candidate-ready job must not rebuild the package.'],
      ['pnpm --silent pack', 'Release candidate-ready job must not pack the package.'],
      ['npm publish', 'Release workflow must not publish directly.'],
    ]
    for (const [command, expectedMessage] of cases) {
      const releaseWorkflow = inputs.releaseWorkflow.replace(
        `          node-version: 24\n      - uses: ${PINNED_ACTIONS.downloadArtifact}`,
        `          node-version: 24\n      - run: ${command}\n`
          + `      - uses: ${PINNED_ACTIONS.downloadArtifact}`,
      )
      expect(() => validateWorkflowContracts({ ...inputs, releaseWorkflow })).toThrow(expectedMessage)
    }
  })

  it('rejects every non-canonical or write-capable permissions form', async () => {
    const inputs = await repositoryInputs()
    const cases = [
      'permissions:\n  contents: read\n  id-token: write # required for the JWT',
      'permissions:\n  contents: read\n  id-token: "write"',
      'permissions: { id-token: write, contents: read }',
      'permissions: write-all',
      'permissions: "write-all"',
    ]
    for (const permissions of cases) {
      const releaseWorkflow = inputs.releaseWorkflow.replace(
        'permissions:\n  contents: read',
        permissions,
      )
      expect(() => validateWorkflowContracts({ ...inputs, releaseWorkflow })).toThrow(
        'Release workflow default permissions must use the reviewed block form.',
      )
    }
  })

  it('rejects artifact mutation in any added release job', async () => {
    const inputs = await repositoryInputs()
    const releaseWorkflow = `${inputs.releaseWorkflow}\n  replacement-artifact:\n`
      + '    runs-on: ubuntu-latest\n'
      + '    steps:\n'
      + '      - run: pnpm pack\n'
    expect(() => validateWorkflowContracts({ ...inputs, releaseWorkflow })).toThrow(
      'Release workflow job set did not match the reviewed contract.',
    )
  })

  it('rejects npm registry credential plumbing in the release workflow', async () => {
    const inputs = await repositoryInputs()
    const cases = [
      '      - run: npm login',
      '      - run: pnpm login',
      '      - run: touch .npmrc',
      '      - run: touch ~/.npmrc',
      '      - run: npm whoami\n        env:\n          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}',
      '      - run: npm whoami\n        env:\n          REGISTRY_AUTH: ${{ vars.NPM_AUTH }}',
      `      - uses: ${PINNED_ACTIONS.setupNode}\n        with:\n          registry-url: https://registry.npmjs.org`,
    ]
    for (const step of cases) {
      const releaseWorkflow = inputs.releaseWorkflow.replace(
        `      - uses: ${PINNED_ACTIONS.checkout}`,
        `${step}\n      - uses: ${PINNED_ACTIONS.checkout}`,
      )
      expect(() => validateWorkflowContracts({ ...inputs, releaseWorkflow })).toThrow(
        'Release workflow must not contain npm registry credential plumbing.',
      )
    }
  })

  it('rejects registry credentials in workflow-level environment variables', async () => {
    const inputs = await repositoryInputs()
    const releaseWorkflow = inputs.releaseWorkflow.replace(
      'env:\n  TRUSTED_PUBLISHING_NPM_VERSION: 11.15.0',
      'env:\n  TRUSTED_PUBLISHING_NPM_VERSION: 11.15.0\n'
        + '  NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}',
    )
    expect(() => validateWorkflowContracts({ ...inputs, releaseWorkflow })).toThrow(
      'Release workflow must not contain npm registry credential plumbing.',
    )
  })

  it('requires workflow-level permissions even when a job has canonical permissions', async () => {
    const inputs = await repositoryInputs()
    const ciWorkflow = inputs.ciWorkflow.replace(
      'permissions:\n  contents: read\n\n',
      '',
    )
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow })).toThrow(
      'CI workflow must declare exactly one workflow-level permissions block.',
    )
  })

  it('requires reviewed full commit SHAs for every workflow action', async () => {
    const inputs = await repositoryInputs()
    const cases = [
      inputs.ciWorkflow.replace(PINNED_ACTIONS.checkout, 'actions/checkout@v7'),
      inputs.ciWorkflow.replace(
        `      - uses: ${PINNED_ACTIONS.checkout}`,
        '      - name: Movable checkout\n        uses: actions/checkout@v7',
      ),
    ]
    for (const ciWorkflow of cases) {
      expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow })).toThrow(
        'CI workflow actions must use reviewed full commit SHAs.',
      )
    }
  })

  it('keeps the reviewed action allowlist on full commit SHAs', () => {
    expect(
      Object.values(PINNED_ACTIONS).every((pin) => /^[^@\s]+@[0-9a-f]{40}$/u.test(pin)),
    ).toBe(true)
  })

  it('requires the staging job to consume the verified artifact with the reviewed npm CLI', async () => {
    const inputs = await repositoryInputs()
    const cases = [
      [
        'npm install --global "npm@$TRUSTED_PUBLISHING_NPM_VERSION"',
        'npm install --global npm@latest',
        'Release staging job must install and verify the reviewed npm CLI version.',
      ],
      [
        'npm stage publish "${{ steps.release-artifact.outputs.package-tarball }}"',
        'npm stage publish ./rebuilt.tgz',
        'Release staging job must stage the exact candidate with reviewed registry metadata.',
      ],
      [
        '--tag alpha',
        '--tag latest',
        'Release staging job must stage the exact candidate with reviewed registry metadata.',
      ],
    ]
    for (const [from, to, expected] of cases) {
      const releaseWorkflow = inputs.releaseWorkflow.replace(from, to)
      expect(() => validateWorkflowContracts({ ...inputs, releaseWorkflow })).toThrow(expected)
    }
  })

  it('rejects direct publishing or automated staged-package decisions', async () => {
    const inputs = await repositoryInputs()
    const cases = [
      ['npm stage publish', 'npm publish', 'Release staging job must stage the exact candidate'],
      ['npm stage publish', 'npm stage approve', 'Release staging job must stage the exact candidate'],
      ['npm stage publish', 'npm stage reject', 'Release staging job must stage the exact candidate'],
    ]
    for (const [from, to, expected] of cases) {
      const releaseWorkflow = inputs.releaseWorkflow.replace(from, to)
      expect(() => validateWorkflowContracts({ ...inputs, releaseWorkflow })).toThrow(expected)
    }
  })

  it('rejects dry runs, shell failure masking, or extra OIDC-capable steps', async () => {
    const inputs = await repositoryInputs()
    const cases = [
      inputs.releaseWorkflow.replace(
        '          --access public\n          --registry=https://registry.npmjs.org\n',
        '          --access public\n          --registry=https://registry.npmjs.org\n          --dry-run\n',
      ),
      inputs.releaseWorkflow.replace(
        '          --access public\n          --registry=https://registry.npmjs.org\n',
        '          --access public\n          --registry=https://registry.npmjs.org || true\n',
      ),
      inputs.releaseWorkflow.replace(
        '      - name: Stage the exact candidate\n',
        '      - run: npm whoami\n      - name: Stage the exact candidate\n',
      ),
    ]
    for (const releaseWorkflow of cases) {
      expect(() => validateWorkflowContracts({ ...inputs, releaseWorkflow })).toThrow(
        'Release staging job steps must exactly match the reviewed OIDC staging topology.',
      )
    }
  })

  it('limits OIDC permission to the staging job and rejects a skippable stage', async () => {
    const inputs = await repositoryInputs()
    const workflowOidc = inputs.releaseWorkflow.replace(
      'permissions:\n  contents: read',
      'permissions:\n  contents: read\n  id-token: write',
    )
    expect(() => validateWorkflowContracts({ ...inputs, releaseWorkflow: workflowOidc })).toThrow(
      'Release workflow default permissions must use the reviewed block form.',
    )

    const skippedStage = inputs.releaseWorkflow.replace(
      '    name: Stage exact candidate for maintainer approval\n',
      '    name: Stage exact candidate for maintainer approval\n    if: always()\n',
    )
    expect(() => validateWorkflowContracts({ ...inputs, releaseWorkflow: skippedStage })).toThrow(
      'Release staging job must not skip or ignore the protected-main gate.',
    )
  })

  it('rejects checkout ref or repository overrides', async () => {
    const inputs = await repositoryInputs()
    for (const override of ['          ref: unreviewed', '          repository: other/project']) {
      const releaseWorkflow = inputs.releaseWorkflow.replace(
        '          node-version: 24',
        `          node-version: 24\n${override}`,
      )
      expect(() => validateWorkflowContracts({ ...inputs, releaseWorkflow })).toThrow(
        'Release workflow must not override the checked-out ref or repository.',
      )
    }
  })

  it('rejects flow-style action steps instead of leaving them uninspected', async () => {
    const inputs = await repositoryInputs()
    const ciWorkflow = inputs.ciWorkflow.replace(
      `      - uses: ${PINNED_ACTIONS.checkout}`,
      '      - { uses: actions/checkout@v7 }',
    )
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow })).toThrow(
      'CI workflow actions must use block-style reviewed full commit SHAs.',
    )
  })

  it('requires an executing protected-main ref guard before candidate construction', async () => {
    const inputs = await repositoryInputs()
    const wrongRef = inputs.releaseWorkflow.replace('refs/heads/main', 'refs/heads/release')
    expect(() => validateWorkflowContracts({ ...inputs, releaseWorkflow: wrongRef })).toThrow(
      'Release ref verification must fail outside protected main.',
    )

    const skippedGuard = inputs.releaseWorkflow.replace(
      '    name: Verify release ref\n',
      '    name: Verify release ref\n    if: github.ref == \'refs/heads/main\'\n',
    )
    expect(() => validateWorkflowContracts({ ...inputs, releaseWorkflow: skippedGuard })).toThrow(
      'Release ref verification must not skip or ignore the protected-main gate.',
    )

    const missingDependency = inputs.releaseWorkflow.replace('      - release-ref\n', '')
    expect(() => validateWorkflowContracts({ ...inputs, releaseWorkflow: missingDependency })).toThrow(
      'Release candidate job must depend on source-checks and release-ref.',
    )
  })

  it('rejects every conditional or ignored protected-main gate', async () => {
    const inputs = await repositoryInputs()
    const cases = [
      {
        expected: 'Release ref verification must not skip or ignore the protected-main gate.',
        workflow: inputs.releaseWorkflow.replace(
          '    name: Verify release ref\n',
          '    name: Verify release ref\n    continue-on-error: true\n',
        ),
      },
      {
        expected: 'Release ref verification must not skip or ignore the protected-main gate.',
        workflow: inputs.releaseWorkflow.replace(
          '      - name: Require protected main\n',
          '      - name: Require protected main\n        if: false\n',
        ),
      },
      {
        expected: 'Release candidate job must not skip or ignore the protected-main gate.',
        workflow: inputs.releaseWorkflow.replace(
          '    name: Build candidate artifact\n',
          '    name: Build candidate artifact\n    if: always()\n',
        ),
      },
      {
        expected: 'Release source-checks job must not skip or ignore the protected-main gate.',
        workflow: inputs.releaseWorkflow.replace(
          '    name: Source checks (Node ${{ matrix.node }})\n',
          '    name: Source checks (Node ${{ matrix.node }})\n    continue-on-error: true\n',
        ),
      },
      {
        expected: 'Release candidate-install job must not skip or ignore the protected-main gate.',
        workflow: inputs.releaseWorkflow.replace(
          '    name: Candidate install (${{ matrix.os }}, Node ${{ matrix.node }})\n',
          '    name: Candidate install (${{ matrix.os }}, Node ${{ matrix.node }})\n'
            + '    continue-on-error: true\n',
        ),
      },
      {
        expected: 'Release candidate-install job must not skip or ignore the protected-main gate.',
        workflow: inputs.releaseWorkflow.replace(
          '      - run: >-\n          pnpm run test:packed-install --\n',
          '      - continue-on-error: true\n        run: >-\n'
            + '          pnpm run test:packed-install --\n',
        ),
      },
      {
        expected: 'Release candidate-ready job must not skip or ignore the protected-main gate.',
        workflow: inputs.releaseWorkflow.replace(
          '    name: Candidate ready for staging\n',
          '    name: Candidate ready for staging\n    if: always()\n',
        ),
      },
    ]
    for (const { expected, workflow: releaseWorkflow } of cases) {
      expect(() => validateWorkflowContracts({ ...inputs, releaseWorkflow })).toThrow(expected)
    }
  })
})

describe('release state transitions', () => {
  async function repositoryFixture() {
    const packageText = await readFile(new URL('../package.json', import.meta.url), 'utf8')
    const packageJson = JSON.parse(packageText)
    const [
      bootstrapReleaseRecord,
      ciWorkflow,
      compatibilityText,
      issueConfig,
      npmBootstrapDecision,
      postBootstrapDistTagsDecision,
      releaseNotesText,
      releaseWorkflow,
      securityPolicy,
    ] = await Promise.all([
      readFile(new URL('../docs/releases/0.1.0-alpha.0.md', import.meta.url), 'utf8'),
      readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
      readFile(new URL('../compatibility.json', import.meta.url), 'utf8'),
      readFile(new URL('../.github/ISSUE_TEMPLATE/config.yml', import.meta.url), 'utf8'),
      readFile(new URL('../docs/decisions/0011-npm-trusted-publishing-bootstrap.md', import.meta.url), 'utf8'),
      readFile(new URL('../docs/decisions/0014-post-bootstrap-dist-tags.md', import.meta.url), 'utf8'),
      readFile(new URL(`../docs/releases/${String(packageJson.version)}.md`, import.meta.url), 'utf8'),
      readReleaseWorkflow(),
      readFile(new URL('../SECURITY.md', import.meta.url), 'utf8'),
    ])
    return {
      bootstrapReleaseRecord,
      ciWorkflow,
      compatibility: JSON.parse(compatibilityText),
      disabledWorkflowExists: false,
      enabledWorkflowExists: true,
      issueConfig,
      licenseExists: true,
      npmBootstrapDecision,
      packageJson,
      postBootstrapDistTagsDecision,
      releaseNotes: { exists: true, text: releaseNotesText },
      releaseWorkflow,
      securityPolicy,
    }
  }

  async function publicAlphaFixture() {
    return repositoryFixture()
  }

  async function privateDevelopmentFixture() {
    const fixture = await repositoryFixture()
    const releaseWorkflow = fixture.releaseWorkflow.replace(/\n  stage-publish:\n[\s\S]*$/u, '\n')
    expect(releaseWorkflow).not.toBe(fixture.releaseWorkflow)
    return {
      ...fixture,
      disabledWorkflowExists: true,
      enabledWorkflowExists: false,
      packageJson: {
        ...fixture.packageJson,
        private: true,
        version: '0.0.0-development',
      },
      releaseWorkflow,
    }
  }

  it('accepts the legacy private state and the current public Alpha state', async () => {
    const privateFixture = await privateDevelopmentFixture()
    const publicFixture = await publicAlphaFixture()
    expect(() => validateReleaseState(privateFixture)).not.toThrow()
    expect(() => validateReleaseState(publicFixture)).not.toThrow()
  })

  it('rejects a public Alpha while the release workflow remains disabled', async () => {
    const fixture = await publicAlphaFixture()
    expect(() => validateReleaseState({
      ...fixture,
      disabledWorkflowExists: true,
      enabledWorkflowExists: false,
    })).toThrow('A public package requires the reviewed release workflow to be enabled once.')
  })

  it('rejects direct publication, a missing staging job, or workflow-wide OIDC', async () => {
    const fixture = await publicAlphaFixture()
    const publishWorkflow = fixture.releaseWorkflow.replace(
      '      - name: Require protected main',
      '      - run: npm publish\n      - name: Require protected main',
    )
    expect(() => validateReleaseState({ ...fixture, releaseWorkflow: publishWorkflow })).toThrow(
      'Release workflow must not publish directly.',
    )

    const missingStage = fixture.releaseWorkflow.replace(/\n  stage-publish:\n[\s\S]*$/u, '\n')
    expect(() => validateReleaseState({ ...fixture, releaseWorkflow: missingStage })).toThrow(
      'Release workflow job set did not match the reviewed contract.',
    )

    const oidcWorkflow = fixture.releaseWorkflow.replace(
      'permissions:\n  contents: read',
      'permissions:\n  contents: read\n  id-token: write',
    )
    expect(() => validateReleaseState({ ...fixture, releaseWorkflow: oidcWorkflow })).toThrow(
      'Release workflow default permissions must use the reviewed block form.',
    )
  })

  it('rejects a wrong public dist-tag or incomplete release evidence', async () => {
    const fixture = await publicAlphaFixture()
    expect(() => validateReleaseState({
      ...fixture,
      packageJson: {
        ...fixture.packageJson,
        publishConfig: { ...fixture.packageJson.publishConfig, tag: 'latest' },
      },
    })).toThrow(
      'Publishing metadata must force the public npm registry, public access, and the alpha dist-tag.',
    )
    expect(() => validateReleaseState({
      ...fixture,
      releaseNotes: { exists: true, text: '> Draft only. Publication pending.' },
    })).toThrow(`Reviewed release notes are missing for ${String(fixture.packageJson.version)}.`)
  })

  it('requires the post-bootstrap dist-tag decision to remain accepted', async () => {
    const fixture = await publicAlphaFixture()
    expect(() => validateReleaseState({
      ...fixture,
      postBootstrapDistTagsDecision: fixture.postBootstrapDistTagsDecision.replace(
        '- Status: accepted',
        '- Status: proposed',
      ),
    })).toThrow(
      'The post-bootstrap dist-tag decision must be accepted before another Alpha is prepared.',
    )
  })

  it('accepts reviewed notes for the next unpublished Alpha without weakening the first record', async () => {
    const fixture = await publicAlphaFixture()
    expect(() => validateReleaseState({
      ...fixture,
      packageJson: { ...fixture.packageJson, version: '0.1.0-alpha.1' },
      releaseNotes: {
        exists: true,
        text: '# 0.1.0-alpha.1 release notes\n\n> Release candidate. This version has not been published.',
      },
    })).not.toThrow()

    expect(() => validateReleaseState({
      ...fixture,
      bootstrapReleaseRecord: '> Release candidate. This version has not been published.',
    })).toThrow('The first Alpha release record must retain its final exact-artifact evidence.')
  })

  it('rejects release notes copied from a different version', async () => {
    const fixture = await publicAlphaFixture()
    expect(() => validateReleaseState({
      ...fixture,
      releaseNotes: {
        exists: true,
        text: '# 0.1.0-alpha.0 release notes\n\n> Release candidate. This version has not been published.',
      },
    })).toThrow(`Reviewed release notes are missing for ${String(fixture.packageJson.version)}.`)
  })

  it('rejects a final record whose heading alone was changed to another version', async () => {
    const fixture = await publicAlphaFixture()
    const copiedFinalRecord = fixture.bootstrapReleaseRecord.replace(
      '# 0.1.0-alpha.0 release notes',
      '# 0.1.0-alpha.1 release notes',
    )
    expect(copiedFinalRecord).not.toBe(fixture.bootstrapReleaseRecord)
    expect(() => validateReleaseState({
      ...fixture,
      packageJson: { ...fixture.packageJson, version: '0.1.0-alpha.1' },
      releaseNotes: { exists: true, text: copiedFinalRecord },
    })).toThrow('Reviewed release notes are missing for 0.1.0-alpha.1.')
  })
})
