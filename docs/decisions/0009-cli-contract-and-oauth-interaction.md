# ADR 0009: Stable CLI contract and terminal OAuth interaction

- Status: accepted
- Date: 2026-08-19

## Context

The first release has no DSH Web or browser-hosted account surface. It therefore needs a package
executable that composes the existing authentication service, credential-vault inspection, and
runtime compatibility evaluator without introducing a second agent runtime. The public CLI JSON
schemas and exit codes are compatibility surfaces, while pi-ai's published OAuth interaction
contains both display events and prompts that may carry ephemeral authorization data.

## Decision

Publish one `dsh-codex-sub` executable with `login`, `logout`, `status`, `doctor`, and `version`
commands. Parse arguments with Node's `parseArgs`; add no command-line runtime dependency and no
public library export for CLI internals.

`status` calls only the local authentication-status projection. `doctor` calls the local runtime
compatibility evaluator, bounded credential-vault inspection, and the pinned provider's in-memory
catalog. It never starts OAuth, resolves or refreshes request auth, reads a complete credential
through the auth service, makes a model request, or performs network I/O.

The versioned JSON projections remain exactly `StatusReportV1` and `DoctorReportV1`, followed by one
newline and no incidental stdout. Doctor classification is deterministic:

- a known runtime mismatch is `incompatible`;
- missing runtime metadata is `unknown`;
- an invalid, insecure, or unreadable credential store, unverifiable permissions on a present
  credential, or an empty provider catalog is `degraded`;
- otherwise the installation is `compatible`.

An absent credential does not make the installation incompatible; doctor reports a bounded login
hint, while `status` is authoritative for signed-in versus signed-out state. Doctor exits zero only
for `compatible`; every other doctor classification exits one. Status uses one for signed out and
three for an invalid or insecure storage failure. Usage errors use two, other failures use three,
and login cancellation uses four.

Adapt pi-ai's published `AuthInteraction` structurally inside `src/piai/**` and implement terminal
rendering in `src/cli/**`. Validate every displayed destination with the platform URL parser and
allow only HTTPS URLs without username or password. Print validated authorization URLs and device
codes only as ephemeral interactive output; never place them in reports or persistence. Do not open
a browser automatically. Before login, reject an explicit `PI_OAUTH_CALLBACK_HOST` unless it is the
loopback literal `127.0.0.1` or `::1`; the configured value never enters output. Read `secret` and
`manual_code` prompts with a non-echoing input path, render `select` prompts as numbered choices,
and propagate the combined interaction/prompt abort signal to every pending read.

Never print caught objects, stacks, causes, or arbitrary provider data. Expected project failures
print only their stable code and safe fixed message; unexpected failures use one fixed message.
When pi-ai wraps a project credential-conversion failure during login, retain the safe
`CODEX_UPSTREAM_PROTOCOL` classification rather than reducing it to a generic login failure.

## Consequences

- Headless and Web-profile installations share one local account-management surface.
- Scripts can rely on one-document JSON and the documented five exit statuses.
- Signed-out installations can still pass compatibility diagnostics while `status` exits one.
- Authorization destinations remain visible long enough for the user to complete OAuth but are not
  durable diagnostic data.
- Hidden prompt handling and SIGINT cleanup require dedicated stream and cancellation tests.
- Packed DSH profile invocation remains a Milestone 6 installation test; Milestone 5 verifies the
  emitted executable directly.
