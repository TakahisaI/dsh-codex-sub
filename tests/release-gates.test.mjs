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
import { join } from 'node:path'

import {
  appendCapture,
  assertCaptureComplete,
} from '../scripts/capture-output.mjs'
import {
  assertPackageFiles,
  PACKAGE_TARBALL_LIMIT_BYTES,
  validatePackageTarball,
} from '../scripts/package-tarball.mjs'
import { PACKAGE_FILE_ALLOWLIST } from '../scripts/package-files.mjs'
import {
  assertReleaseChecksum,
  selectReleaseTarball,
} from '../scripts/release-artifact-contract.mjs'
import { validateWorkflowContracts } from '../scripts/workflow-contract.mjs'

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
      '      - uses: actions/download-artifact@v7',
      '      - run: pnpm run build\n      - uses: actions/download-artifact@v7',
    )
    expect(() => validateWorkflowContracts({ ...inputs, ciWorkflow })).toThrow(
      'CI must not rebuild the package.',
    )
  })

  it('rejects a direct package repack inside a candidate consumer', async () => {
    const inputs = await repositoryInputs()
    const ciWorkflow = inputs.ciWorkflow.replace(
      '      - uses: actions/download-artifact@v7',
      '      - run: pnpm pack\n      - uses: actions/download-artifact@v7',
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
      ['npm publish', 'Release workflow must not contain a publish operation.'],
    ]
    for (const [command, expectedMessage] of cases) {
      const releaseWorkflow = inputs.releaseWorkflow.replace(
        '          node-version: 24\n      - uses: actions/download-artifact@v7',
        `          node-version: 24\n      - run: ${command}\n`
          + '      - uses: actions/download-artifact@v7',
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
        'Release workflow permissions must use a block containing only contents: read.',
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
      'Release workflow job set did not match the verification-only contract.',
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
      '      - uses: actions/setup-node@v7\n        with:\n          registry-url: https://registry.npmjs.org',
    ]
    for (const step of cases) {
      const releaseWorkflow = inputs.releaseWorkflow.replace(
        '      - uses: actions/checkout@v7\n      - uses: actions/setup-node@v7',
        `${step}\n      - uses: actions/checkout@v7\n      - uses: actions/setup-node@v7`,
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
})
