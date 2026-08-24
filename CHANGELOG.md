# Changelog

## Unreleased

## 0.1.0-alpha.2

> Release candidate. This version has not been published, staged, or verified as public support.

### Changed

- Updated the reviewed candidate compatibility line to DeepSeek Harness `0.1.1-rc.1` at commit
  `528c682e061696f5a160f363f236ecbf53cbd006`.
- Kept Cordis at `4.0.1` and pi-ai at `0.82.1`; the pi-ai `0.83.0` spike remains a conclusion-B
  compatibility report only.
- Added fail-closed native DSH auth injection and a fixed 20 MiB DSH-owned image replacement
  budget.

This is an unpublished candidate record. No npm staging, publishing, GitHub release, or real
credential operation is part of this change.

## 0.1.0-alpha.1

### Changed

- Finalized the first Alpha's exact-artifact publication record.
- Restricted later releases to OIDC staging of the verified workflow artifact followed by separate
  maintainer approval with two-factor authentication.
- Serialized release workflow runs without cancelling an in-progress candidate.
- Documented the post-bootstrap npm dist-tag policy for prereleases and the first stable release.

Published through stage-only npm Trusted Publishing under the `alpha` dist-tag on 2026-08-19.
The matching GitHub release is marked as a prerelease, and the registry artifact includes npm
provenance.

## 0.1.0-alpha.0

### Added

- Secret-safe security reporting and support templates.
- English and Japanese Alpha compatibility and limitation documentation.
- A maintainer-only real-account smoke-record template.
- Release notes and exact-artifact evidence for `0.1.0-alpha.0`.
- The MIT project license.
- Single-artifact blocking CI with fail-closed release-contract tests.
- Hardened release contracts for alternate matrix syntax, direct repacks in any non-producer job,
  exact verification job topology, registry credential plumbing at every workflow scope, and
  premature publication permissions.
- Protected-main release-ref verification, full-SHA GitHub Actions pins, public-registry metadata,
  and fixture-tested private/public release-state transitions.
- Bounded archive extraction and package-aware README link validation for the npm tarball.

Published to npm under the `alpha` dist-tag on 2026-08-19. The matching GitHub release is marked
as a prerelease.
