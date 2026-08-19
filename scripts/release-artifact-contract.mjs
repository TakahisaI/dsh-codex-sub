function invariant(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

export function selectReleaseTarball(entries, checksumFilename) {
  const tarballs = entries.filter((entry) => entry.endsWith('.tgz'))
  invariant(
    entries.length === 2 && tarballs.length === 1 && entries.includes(checksumFilename),
    'Release artifact must contain exactly one package tarball and SHA256SUMS.',
  )
  const tarballName = tarballs[0]
  invariant(tarballName !== undefined, 'Release artifact package tarball was missing.')
  return tarballName
}

export function assertReleaseChecksum(checksumText, sha256, tarballName) {
  invariant(
    checksumText === `${sha256}  ${tarballName}\n`,
    'Release artifact SHA-256 did not match the package tarball.',
  )
}
