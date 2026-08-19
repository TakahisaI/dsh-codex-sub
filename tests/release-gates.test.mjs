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
      ['npm publish', 'Release workflow must not contain a publish operation.'],
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
    ]
    for (const { expected, workflow: releaseWorkflow } of cases) {
      expect(() => validateWorkflowContracts({ ...inputs, releaseWorkflow })).toThrow(expected)
    }
  })
})

describe('release state transitions', () => {
  async function repositoryFixture() {
    const [
      ciWorkflow,
      compatibilityText,
      issueConfig,
      npmBootstrapDecision,
      packageText,
      releaseNotesText,
      releaseWorkflow,
      securityPolicy,
    ] = await Promise.all([
      readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
      readFile(new URL('../compatibility.json', import.meta.url), 'utf8'),
      readFile(new URL('../.github/ISSUE_TEMPLATE/config.yml', import.meta.url), 'utf8'),
      readFile(new URL('../docs/decisions/0011-npm-trusted-publishing-bootstrap.md', import.meta.url), 'utf8'),
      readFile(new URL('../package.json', import.meta.url), 'utf8'),
      readFile(new URL('../docs/releases/0.1.0-alpha.0.md', import.meta.url), 'utf8'),
      readFile(new URL('../.github/workflows/release.yml.disabled', import.meta.url), 'utf8'),
      readFile(new URL('../SECURITY.md', import.meta.url), 'utf8'),
    ])
    return {
      ciWorkflow,
      compatibility: JSON.parse(compatibilityText),
      disabledWorkflowExists: true,
      enabledWorkflowExists: false,
      issueConfig,
      licenseExists: true,
      npmBootstrapDecision,
      packageJson: JSON.parse(packageText),
      releaseNotes: { exists: true, text: releaseNotesText },
      releaseWorkflow,
      securityPolicy,
    }
  }

  async function publicAlphaFixture() {
    const fixture = await repositoryFixture()
    return {
      ...fixture,
      disabledWorkflowExists: false,
      enabledWorkflowExists: true,
      npmBootstrapDecision: fixture.npmBootstrapDecision.replace(
        '- Status: proposed',
        '- Status: accepted',
      ),
      packageJson: {
        ...fixture.packageJson,
        private: false,
        version: '0.1.0-alpha.0',
      },
      releaseNotes: {
        exists: true,
        text: fixture.releaseNotes.text.replace('Draft only.', 'Release candidate.'),
      },
    }
  }

  it('accepts the current private state and a complete public Alpha fixture', async () => {
    const privateFixture = await repositoryFixture()
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

  it('rejects publication commands or OIDC permission in the public Alpha state', async () => {
    const fixture = await publicAlphaFixture()
    const publishWorkflow = fixture.releaseWorkflow.replace(
      '      - name: Require protected main',
      '      - run: npm publish\n      - name: Require protected main',
    )
    expect(() => validateReleaseState({ ...fixture, releaseWorkflow: publishWorkflow })).toThrow(
      'Release workflow must not contain a publish operation.',
    )

    const oidcWorkflow = fixture.releaseWorkflow.replace(
      'permissions:\n  contents: read',
      'permissions:\n  contents: read\n  id-token: write',
    )
    expect(() => validateReleaseState({ ...fixture, releaseWorkflow: oidcWorkflow })).toThrow(
      'Release workflow permissions must use a block containing only contents: read.',
    )
  })

  it('rejects a wrong public dist-tag or draft release notes', async () => {
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
      releaseNotes: { exists: true, text: '> Draft only. Not published.' },
    })).toThrow('Final release notes are missing for 0.1.0-alpha.0.')
  })
})
