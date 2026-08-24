import {
  assertPackedCompatibilityMatchesSource,
  assertPackedManifestMatchesSource,
} from './spike-rc1-candidate-source.mjs'

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

export function assertWorkflowArtifactSha256(actual, expected) {
  invariant(/^[0-9a-f]{64}$/u.test(actual), 'Observed workflow artifact SHA-256 must be a lowercase digest.')
  invariant(/^[0-9a-f]{64}$/u.test(expected), 'Workflow artifact SHA-256 must be a lowercase digest.')
  invariant(actual === expected, `Workflow artifact SHA-256 mismatch: expected ${expected}, received ${actual}.`)
}

export function assertWorkflowArtifactSourceIdentity({
  packedManifest,
  packedCompatibility,
  repositoryManifest,
  repositoryCompatibility,
  version,
  repositoryCommit,
}) {
  assertPackedManifestMatchesSource(packedManifest, repositoryManifest)
  assertPackedCompatibilityMatchesSource(packedCompatibility, repositoryCompatibility)
  invariant(packedCompatibility.dsh.release === version, 'Workflow artifact DSH release drifted.')
  invariant(
    packedCompatibility.dsh.repositoryCommit === repositoryCommit,
    'Workflow artifact repository commit drifted.',
  )
  for (const [name, expected] of Object.entries(packedManifest.peerDependencies)) {
    if (name === '@deepseek-ai/cordis') continue
    invariant(expected === version, `${name} workflow artifact peer drifted.`)
  }
  for (const [name, expected] of Object.entries(packedCompatibility.dsh.packages)) {
    if (name === '@deepseek-ai/cordis') continue
    invariant(expected === version, `${name} workflow artifact compatibility package drifted.`)
  }
}
