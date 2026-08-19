# ADR 0013: Verify and publish one immutable release artifact

- Status: accepted
- Date: 2026-08-19

## Context

The packed-install gate previously built and packed the project inside every job that exercised the
installed bundle. That proves that each runner can construct a working package, but it does not
prove that Linux verification, macOS verification, manual smoke, and eventual publication consume
the same bytes. Repacking after a successful test creates a new artifact outside the evidence even
when it comes from the same commit.

The first Alpha claims support for Linux and macOS on Node 22.19, 24, and 26. Blocking CI previously
ran all three Node lines on Ubuntu but only Node 24 on macOS, so the support claim was broader than
the platform evidence.

The packed DSH process also captures stdout and stderr so generated credential sentinels can be
checked. Silently truncating that capture could hide a sentinel beyond the limit and turn an
incomplete scan into a passing gate.

## Decision

Add `--package-tarball <absolute path>` to the packed-install driver. In that mode the driver must
not build or repack the project package. Before installation it rejects a relative path, symbolic
link, non-regular file, empty or oversized archive, unexpected archive entry, non-regular archive
entry, package name mismatch, version mismatch, or deviation from the package allowlist. The
separate Host probe may still be packed locally because it is test instrumentation and not the
release candidate.

Bound extraction as well as compressed input. No package entry may exceed 2 MiB, each README is
limited to 512 KiB, `package.json` is limited to 64 KiB, and all file contents together are limited
to 8 MiB. Read every allowlisted entry through a bounded archive extraction before use so a highly
compressible file cannot bypass the 16 MiB compressed-input limit. Validate the README contents
from the archive: relative links may target only files shipped in the package, while repository
documentation omitted from the tarball must use canonical HTTPS URLs.

Blocking CI and the release workflow each construct the package once in a clean Ubuntu/Node 24 job,
compute its SHA-256, and upload the tarball plus `SHA256SUMS` as one workflow artifact. Every Linux
and macOS packed-install job downloads that artifact, verifies both the checksum and archive
contract, and passes its absolute path to the non-repacking packed-install mode. This makes the
cross-platform artifact handoff executable before the disabled release workflow is enabled. The
release workflow's final candidate-ready job also verifies the same artifact and contains no
publication command. A later approval or publish job must depend on those jobs and consume that
workflow artifact without running a build or pack command.

The release workflow may construct that artifact only when manually dispatched from protected
`main`. An executing `release-ref` job fails for every other ref, and the candidate job depends on
both that guard and source checks. Pin every third-party Action to a reviewed full commit SHA so the
workflow implementation used by the candidate cannot move under an unchanged repository commit.

Run the packed-install gate on Ubuntu and macOS for Node 22.19, 24, and 26. A supported Node or OS
combination without a blocking matrix entry is a release-state defect. Derive the expected matrix
from `compatibility.json` and check both workflow files mechanically.

Treat stdout or stderr capture overflow as a failed packed-install gate. Retaining only a prefix is
permitted for safe error reporting, but an incomplete capture can never satisfy the sentinel scan.

The first trusted-publishing workflow must use npm CLI `11.15.0` or a separately reviewed later
version and Node 22.14 or newer. The release workflow pins `11.15.0` for that future job but
does not install npm, authenticate, request an OIDC token, or publish while the package does not
exist in the registry. ADR 0011 accepts a separately approved interactive bootstrap for only the
first complete Alpha.

## Consequences

- The candidate SHA identifies the bytes tested across every supported platform, not merely a
  commit from which equivalent bytes might be rebuilt.
- Manual real-account smoke must begin from the downloaded candidate artifact and record its
  SHA-256. Publication must consume the same artifact or the automated and manual evidence is void.
- The ordinary development command may still build and pack locally when no tarball argument is
  supplied.
- Archive validation uses the platform `tar` program already present on supported Linux and macOS
  runners; Windows remains outside the first-Alpha support boundary.
- The blocking packed-install matrix grows from four to six jobs.
- Unit tests cover bounded path, archive-list, checksum, stdout/stderr capture-overflow, and
  workflow-topology rejection paths without generating credentials or making network requests.
  Archive tests include highly compressed per-entry and aggregate size violations plus README
  links to omitted package files.
  The topology contract includes block- and flow-style matrix entries, rebuild/repack rejection in
  every non-producer job, the exact verification-only job set, the enabled/disabled workflow rename,
  and the pre-publication prohibition on publication, npm registry credentials at any workflow scope,
  or any permission beyond a required workflow-level canonical `contents: read` block.
- Pure fixtures exercise the private-development and public-Alpha release-state branches before the
  first metadata transition, and the package metadata fixes publication to the public npm registry.
