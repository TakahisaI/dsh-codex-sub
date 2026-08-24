# Compatibility policy

## 1. Baseline

The current unpublished candidate baseline is:

- DeepSeek Harness `0.1.1-rc.1`;
- `@deepseek-ai/cordis` `4.0.1`;
- `@deepseek-ai/dsh-llm-pi-ai` `0.1.1-rc.1`;
- `@earendil-works/pi-ai` `0.82.1`;
- Node.js `^22.19.0 || ^24.0.0 || ^26.0.0`;
- Linux and macOS;
- pnpm `11.7.0` for repository development.

The exact machine-readable values live in the root `compatibility.json`.

The pi-ai `0.83.0` compatibility spike is retained as evidence only; its conclusion is recorded
in [`docs/compatibility-reports/pi-ai-0.83.0.md`](compatibility-reports/pi-ai-0.83.0.md). The
formal candidate remains on pi-ai `0.82.1`.

The measured local fresh packed `0.1.1-rc.1` request-contracts lane against a Darwin arm64 Node
24 candidate artifact also proves the deferred Issue #51 contracts—attachment budgeting, replay
across a process boundary, retry/tool exact-once behavior, cancellation, and transport
containment. The separate packed credential-topology lane remains a four-boot auth/topology check
and is not used as #51 request evidence; CI remains an external gate. See
[`docs/compatibility-reports/rc1-request-contracts.md`](compatibility-reports/rc1-request-contracts.md).

Issue #50 adds the publication-bound artifact gate. Its reviewed Host fixture lists all 188 DSH
release-family names at exact `0.1.1-rc.1`, sets `autoInstallPeers: false`, and contains no pnpm
`overrides` or `resolutions`. The lane copies that fixture, validates it, performs one frozen
install, installs the candidate once through `dsh plugin add`, and runs the same six request boots.
The CI and release workflows consume one producer tarball across Ubuntu/macOS and Node 22.19/24/26;
they do not publish or repack it. See
[`compatibility-reports/rc1-release-artifact.md`](compatibility-reports/rc1-release-artifact.md).

## 2. Exact verification, not optimistic ranges

DSH is in developer preview and may make compatibility-breaking changes. The plugin therefore
publishes claims only for combinations it has tested.

For public prereleases:

- direct DSH peer dependencies use the exact verified release;
- pi-ai uses the exact verified release;
- Node uses only the three release lines exercised by blocking CI;
- package metadata rejects operating systems outside Linux and macOS;
- the runtime guard rejects a known mismatch before provider registration.

A broader npm range may be considered only after multiple releases demonstrate a stable public
contract and an ADR records the evidence.

## 3. Single source of truth

`compatibility.json` drives or is checked against:

- package peer/dependency versions;
- runtime compatibility guard;
- `doctor --json`;
- CI matrix;
- README compatibility table;
- release notes.

Add a verification script that fails when these values drift.

## 4. Runtime behavior

```text
verified combination      start normally
known incompatible        fail before provider registration
missing package metadata  fail closed before provider registration
newer unverified release  fail closed for public builds
```

The production guard loads the supported values from `compatibility.json`, checks
`process.platform`, checks Node with the documented range, and compares every direct DSH/pi-ai
runtime package exactly. It rejects operating systems outside Linux and macOS, prerelease Node
builds, odd major lines, and later untested major lines before provider registration. Package
metadata is resolved locally and reduced to name/version only; resolved filesystem paths never
enter the report or error details.

The package root then verifies that the injected LLM service has the exact constructor identity of
the verified `@deepseek-ai/dsh-llm` export. The Host publishes no service version property, so a
different module identity fails closed even when plugin-local package metadata still reports the
supported version. A dynamically loaded runtime module lets the package root classify missing or
incompatible static exports as `CODEX_INCOMPATIBLE_RUNTIME`.

The CLI doctor uses this same evaluator and maps the platform, Node, and every checked package into
`DoctorReportV1`; it does not maintain a smaller package subset or a second version table. An
unsupported platform is `incompatible`, including when the credential is absent. See ADR 0012.

A development-only environment override may allow experimentation, but it must:

- be clearly named as unsupported;
- emit a warning;
- never change `doctor` to report compatible;
- never be documented as a normal user solution.

Suggested name:

```text
DSH_CODEX_SUB_ALLOW_UNSUPPORTED=1
```

Do not add a persistent settings field for this override.

## 5. Upgrade workflow

For each DSH or pi-ai update:

1. open a compatibility branch;
2. update only `compatibility.json` first;
3. install exact candidate versions;
4. run typecheck to identify public-contract changes;
5. run focused pi-ai auth and DSH adapter contract tests;
6. review ADR 0006's configurable-provider decision and whether the documented discovery-namespace
   list has become a published API;
7. run the packed-install matrix;
8. perform a manual real-account smoke when auth or provider behavior changed;
9. update ADRs and public limitations;
10. publish a prerelease before promoting the normal dist-tag.

Never merge an automated dependency update solely because compilation passes.

## 6. Upstream volatility boundary

The project intentionally treats these as volatile:

- ChatGPT OAuth eligibility and flow;
- the Codex subscription backend;
- model IDs and capabilities;
- token refresh details;
- pi-ai provider auth shapes;
- DSH `PiAiAdapter` profile types;
- DSH model-selection discovery.

Each volatile surface is isolated to `src/piai/**`, `src/storage/**`, or `src/dsh/**` and covered by
contract tests.

## 7. Unsupported combinations

Do not provide speculative troubleshooting for unsupported runtime combinations. The supported
response is:

- state the installed and verified versions;
- point to `doctor --json`;
- recommend installing a verified combination or contributing a compatibility update.

Windows is outside the first-alpha support boundary because owner-only credential ACLs cannot be
verified by the current vault. A new Node major or operating system is unsupported until its packed
install is a blocking CI job and the machine-readable compatibility metadata is updated.
