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
cross-platform artifact handoff executable before and after release workflow activation. The
release workflow's candidate-ready job also verifies the same artifact. Its later staging job
depends on that boundary, downloads and verifies the same workflow artifact again, and passes its
resolved tarball path to `npm stage publish` without running a build or pack command.

The release workflow may construct that artifact only when manually dispatched from protected
`main`. An executing `release-ref` job fails for every other ref, and the candidate job depends on
both that guard and source checks. Pin every third-party Action to a reviewed full commit SHA so the
workflow implementation used by the candidate cannot move under an unchanged repository commit.
Serialize release runs in one repository-specific workflow concurrency group and disable
in-progress cancellation. A later dispatch waits instead of cancelling or racing the candidate
whose artifact and staged-package identity are being reviewed.

Run the packed-install gate on Ubuntu and macOS for Node 22.19, 24, and 26. A supported Node or OS
combination without a blocking matrix entry is a release-state defect. Derive the expected matrix
from `compatibility.json` and check both workflow files mechanically.

Treat stdout or stderr capture overflow as a failed packed-install gate. Retaining only a prefix is
permitted for safe error reporting, but an incomplete capture can never satisfy the sentinel scan.

The first trusted-publishing workflow must use npm CLI `11.15.0` or a separately reviewed later
version and Node 22.14 or newer. The release workflow pins and verifies `11.15.0` in the staging
job. Only that job receives `id-token: write`; the workflow default and every earlier job remain
read-only. It may stage the exact candidate but cannot approve or publish it. ADR 0011 records the
separately approved interactive bootstrap used only for the first complete Alpha.

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
  every non-producer job, the exact workflow job set, the enabled/disabled workflow transition,
  and rejection of direct publication, automated staged-package approval, npm registry credentials
  at any workflow scope, or OIDC permission outside the staging job.
- The topology contract also fixes release concurrency and rejects cancellation-enabled, missing,
  duplicate, nested, or alternate-form declarations.
- Pure fixtures preserve coverage of the legacy private-development and current public-Alpha
  release-state branches, and the package metadata fixes publication to the public npm registry.
