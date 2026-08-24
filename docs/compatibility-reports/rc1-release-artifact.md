# Fresh release-artifact matrix (#50)

## Scope

This report records the publication-bound release-artifact gate for Issue #50. It proves that one
unpublished `dsh-codex-sub@0.1.0-alpha.2` tarball can be installed and exercised against the DSH
`0.1.1-rc.1` Host graph across the supported Linux/macOS and Node 22.19/24/26 matrix. It does not
publish the package, change an npm tag, create a GitHub release, or claim that registry bytes are
identical. Registry identity remains a later publication gate.

## Local evidence

The local Darwin arm64 / Node 24 run used the canonical alpha.2 candidate artifact:

- filename and package manifest/CLI: `dsh-codex-sub-0.1.0-alpha.2.tgz`, `0.1.0-alpha.2`;
- SHA-256 at input, before install, after install, after resume, and final: `296bacf8c3b7e5f9550b0d99b402e25ff80c97a2193ac72fd36fe333d87261ae`;
- Host fixture: `autoInstallPeers: false`, no `overrides` or `resolutions`, frozen install once;
- DSH lock and physical graph: exactly 188 unique DSH package names, all `0.1.1-rc.1`;
- request-contracts lane: six boots (`save`, `verify`, `requests-seed`, `requests-resume`,
  `post-logout`, `confirm-deleted`), PASS;
- regression lane: four override-pinned credential/topology boots, PASS.

The six request boots observed process-boundary replay, exact-once retry/tool execution, split
cancellation, attachment image budgeting, fail-closed transport, credential lifecycle, route and
directory conflict handling, and secret-free output. The four regression boots preserve the
historical override-pinned candidate lane as a separate, non-#50 evidence scope.

## Formal matrix

The CI and manually dispatched release workflow each have one Ubuntu/Node 24 producer and a shared
artifact download for every cell below:

| OS | Node |
| --- | --- |
| Ubuntu | 22.19.0 |
| Ubuntu | 24 |
| Ubuntu | 26 |
| macOS | 22.19.0 |
| macOS | 24 |
| macOS | 26 |

Every cell verifies the producer SHA and invokes
`test:exact-artifact-lane --host-graph-mode locked-no-overrides --probe-scope request-contracts`.
The ordinary packed-install matrix remains separate, and the Node 24 packed candidate lane keeps
`override-pinned` as its explicit mode. The release `candidate-ready` boundary depends on both the
ordinary candidate-install matrix and this `compatibility-release` matrix.

The formal GitHub run is the merge gate. Until that run is green, this report is local evidence of
the implementation and must not be read as a claim about unobserved OS/Node cells or about a
published registry artifact. Native OAuth refresh is outside the serving path and remains
unclaimed; natural package refresh belongs to Issue #33.
