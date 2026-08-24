import { readFile } from 'node:fs/promises'

import {
  assertDshReleaseFamilyLock,
  collectWorkspaceDshOverrides,
  DSH_RELEASE_FAMILY_VERSION,
} from './dsh-release-family-lock.mjs'

async function readText(filename) {
  return readFile(new URL(`../${filename}`, import.meta.url), 'utf8')
}

const [packageJson, compatibility, workspaceText, lockText] = await Promise.all([
  readText('package.json').then(JSON.parse),
  readText('compatibility.json').then(JSON.parse),
  readText('pnpm-workspace.yaml'),
  readText('pnpm-lock.yaml'),
])

if (compatibility.dsh.release !== DSH_RELEASE_FAMILY_VERSION) {
  throw new Error(
    `compatibility.json DSH release must be ${DSH_RELEASE_FAMILY_VERSION}; received ${String(compatibility.dsh.release)}.`,
  )
}

for (const [name, expected] of Object.entries(compatibility.dsh.packages)) {
  if (name === '@deepseek-ai/cordis') {
    if (expected !== '4.0.1') {
      throw new Error(`Cordis pin drifted from 4.0.1: ${String(expected)}.`)
    }
    continue
  }
  for (const section of ['peerDependencies', 'devDependencies']) {
    const received = packageJson[section]?.[name]
    if (received !== expected || received !== DSH_RELEASE_FAMILY_VERSION) {
      throw new Error(`${section}.${name} must be ${DSH_RELEASE_FAMILY_VERSION}.`)
    }
  }
}

const report = assertDshReleaseFamilyLock({
  lockText,
  workspaceText,
  version: DSH_RELEASE_FAMILY_VERSION,
})

const workspaceOverrides = collectWorkspaceDshOverrides(workspaceText)
if (workspaceOverrides.get('@deepseek-ai/dsh') !== DSH_RELEASE_FAMILY_VERSION) {
  throw new Error('Workspace overrides did not include the Host DSH seed.')
}

process.stdout.write(
  `DSH release-family lock is exact at ${DSH_RELEASE_FAMILY_VERSION} (${String(report.names.length)} packages).\n`,
)
