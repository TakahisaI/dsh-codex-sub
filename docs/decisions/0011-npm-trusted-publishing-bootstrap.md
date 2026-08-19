# ADR 0011: Bootstrap npm ownership before trusted publishing

- Status: proposed
- Date: 2026-08-19

## Context

The release plan assumed that npm trusted publishing could be configured before the first public
version. The published npm contract does not support that order for a new package: package names
are established by a real first publish, while `npm trust` requires the package to exist in the
registry already. A registry lookup on 2026-08-19 found no public package named `dsh-codex-sub`,
but that result neither reserves the name nor establishes ownership.

Publishing an empty or artificial version only to hold the name is not an acceptable bootstrap.
The first registry artifact must be a reviewed, installable release that has passed the same
security and compatibility gates as every later Alpha. The package cannot silently fall back to a
long-lived npm token merely to preserve the original workflow order.

Relevant upstream contracts:

- [npm package-name disputes and username policy](https://docs.npmjs.com/policies/disputes/);
- [`npm trust`, including the existing-package prerequisite](https://docs.npmjs.com/cli/v11/commands/npm-trust/);
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/);
- [`npm publish`](https://docs.npmjs.com/cli/v11/commands/npm-publish/).

## Proposed decision

Do not publish a placeholder or treat a successful name lookup as ownership. The maintainer may
prepare the npm account, two-factor authentication, and recovery access before release, but must
wait to establish package ownership until the actual `0.1.0-alpha.0` candidate has passed every
automated gate, the manual real-account smoke, license selection, and final tarball review.

Bootstrap the first real Alpha from a clean maintainer-controlled workstation using interactive
npm authentication with two-factor authentication and the `alpha` dist-tag. Do not create or
store a repository publishing token for this step. Record that this one version cannot carry
trusted-publisher provenance because the publisher could not be configured before the package
existed.

Before the first public metadata commit, enable the reviewed `.github/workflows/release.yml` as a
non-publishing release gate. It may verify and retain the candidate artifact, but it must contain no
npm credential, OIDC permission, or publish command. Package metadata must force public access and
the `alpha` dist-tag so the interactive bootstrap cannot update `latest` by omission.

Immediately after the package exists, configure that exact workflow as its trusted publisher,
restrict conventional token publishing in npm package settings, and add OIDC-backed publishing in
a reviewed follow-up for every later version. Prefer npm's staged-publishing approval flow. Verify
the next published Alpha's provenance and install that exact registry artifact in a clean DSH
profile.

The maintainer must explicitly accept the one-release provenance exception before this ADR changes
to accepted. If provenance on the first public artifact is non-negotiable, publication must wait
for an upstream bootstrap mechanism or use a different package identity whose publisher can
already be configured; neither alternative is currently established.

## Consequences

- npm registration is not a current Milestone 7 preparation task; npm account hardening may be.
- `0.1.0-alpha.0` must be a complete release rather than a name-reservation artifact.
- The first Alpha's release record must state that trusted-publisher provenance is unavailable and
  link to this decision if the exception is accepted.
- The release workflow is enabled before the first public metadata commit, but remains a
  non-publishing verification workflow until after the first package exists.
- A repository token is not introduced as an undocumented bootstrap shortcut.
- Release documentation must not claim that an unused registry name is owned or reserved.
