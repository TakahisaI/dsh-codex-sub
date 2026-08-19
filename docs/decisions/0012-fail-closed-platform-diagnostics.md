# ADR 0012: Fail closed on platform compatibility and expose complete diagnostics

- Status: accepted
- Date: 2026-08-19

## Context

`compatibility.json` and package metadata limit the first Alpha to Linux and macOS, but the runtime
guard previously evaluated only Node and package versions. Package-manager operating-system checks
are an installation convenience rather than a sufficient runtime boundary: a forced install,
direct extraction, or different installer could still start the plugin on an unsupported platform.
On Windows, a signed-out installation could consequently pass doctor because the owner-only
credential-permission limitation was not reached until a credential existed.

The same evaluator checks all six direct DSH/Cordis packages and the exact pi-ai dependency. The
versioned doctor document previously projected only Node, DSH LLM, DSH pi-ai, and pi-ai. A mismatch
in Cordis, attachment, atomic-write, or home-path utilities could therefore make `overall`
incompatible without exposing the check responsible for that result.

The package has not published an Alpha, so this is the last safe point to correct the version 1
doctor shape without preserving an incomplete diagnostic contract.

## Decision

Add `platform` to the installed runtime snapshot and evaluate it against the exact `platforms`
array in `compatibility.json`. `assertRuntimeCompatible()` checks platform before Node and package
versions and throws `CODEX_INCOMPATIBLE_RUNTIME` before provider construction or registration when
the platform is unsupported. Safe details contain only the label `platform`, the bounded supported
platform list, and the installed platform identifier.

Change `DoctorReportV1.runtime` to contain:

```text
platform  supported platform identifiers, installed identifier, and compatible/incompatible status
node      the existing VersionCheck
packages  every package VersionCheck keyed by the published package name
```

The package keys and their deterministic order come from the same compatibility document used by
the runtime guard. Report construction requires exactly that complete key set and copies every
check into a detached frozen object. It does not use a second version table. An unsupported platform
always makes doctor `incompatible` and produces a fixed bounded hint. Human-readable doctor output
prints the same complete set.

Keep the schema name and `schemaVersion: 1` because no package version containing the earlier shape
was published. Any later structural change to this JSON document requires a new schema version or
an explicitly compatible extension decision.

## Consequences

- Package metadata and runtime enforcement now express the same Linux/macOS boundary.
- A forced installation on Windows fails before credential or provider work.
- Doctor can no longer report compatible on an unsupported operating system.
- Every version check contributing to `overall` is visible in both JSON and human output.
- Consumers of pre-release source snapshots using the incomplete doctor shape must update, but no
  published npm consumer is affected.
