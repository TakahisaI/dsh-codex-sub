# Compatibility policy

## 1. Baseline

The design baseline is:

- DeepSeek Harness `0.1.0-rc.7`;
- `@deepseek-ai/cordis` `4.0.1`;
- `@deepseek-ai/dsh-llm-pi-ai` `0.1.0-rc.7`;
- `@earendil-works/pi-ai` `0.82.1`;
- Node.js `^22.19.0 || >=24.0.0`;
- pnpm `11.7.0` for repository development.

The exact machine-readable values live in the root `compatibility.json`.

## 2. Exact verification, not optimistic ranges

DSH is in developer preview and may make compatibility-breaking changes. The plugin therefore
publishes claims only for combinations it has tested.

For public prereleases:

- direct DSH peer dependencies use the exact verified release;
- pi-ai uses the exact verified release;
- Node uses the DSH-supported engine range;
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

The production guard loads the supported values from `compatibility.json`, checks Node with the
documented range, and compares every direct DSH/pi-ai runtime package exactly. Package metadata is
resolved locally and reduced to name/version only; resolved filesystem paths never enter the
report or error details.

The CLI doctor uses this same evaluator and maps only the documented Node, DSH LLM, DSH pi-ai, and
pi-ai checks into `DoctorReportV1`; it does not maintain a second version table.

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
