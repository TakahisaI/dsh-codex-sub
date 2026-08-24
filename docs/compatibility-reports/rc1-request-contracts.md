# Fresh packed rc.1 request contracts (#51)

## Scope

This report records the secret-free evidence for Issue #51 on one fresh, exact-pinned
DSH `0.1.1-rc.1` Host installation. The lane covers attachment budgeting, process-boundary
replay, retry/tool exact-once behavior, cancellation, and transport containment.

No compatibility metadata, peer range, release metadata, package version, or workflow was
changed as part of this evidence.

## Candidate and environment

- Candidate artifact SHA-256: `f277bdccb31232f597b93b07b4b0e990a05c53ef38f8e86538671e2341f47269`.
- Host graph: exact-pinned `0.1.1-rc.1`, 439 physical DSH package copies.
- Topology: 6 direct DSH peers shared with Host, 2 pi-ai `0.82.1` copies, and 9 adapter
  transitive Host peers.
- Host OS: Darwin 24.6.0, arm64 (`Macmini`).
- Node: `v24.19.0`; pnpm: `11.7.0`.
- Upstream inspected commit: `528c682e061696f5a160f363f236ecbf53cbd006`.
- Measured lane elapsed: `42.50s` (`real`, one run).

## Method and boot matrix

`scripts/spike-exact-artifact-lane.mjs` installs the candidate once, then runs six isolated
Host boots over one `DSH_HOME`: `save`, `verify`, `requests-seed`, `requests-resume`,
`post-logout`, and `confirm-deleted`. The seed and resume boots share one SessionId and stop
through the outer `bootProbe`; resume has the 120-second bound while ordinary boots use 60
seconds. The artifact SHA is checked before install, after install, after resume, and at the
final gate; all four values above matched.

The packed fixture uses only public root imports and injects the public `llm`, `credentials`,
`attachments`, `agents`, `sessions`, `sessionPersistence`, `tools`, and `sessionTitle` services.
It installs a fail-closed in-memory SSE transport that accepts only
`POST https://chatgpt.com/backend-api/codex/responses`, records all fetch and WebSocket URLs,
and rejects unknown URL, method, body, or marker with a sticky secret-free error. The allowed
WebSocket dial sends zero frames before SSE fallback.

## Observed results

| Contract | Observed result |
| --- | --- |
| Replay seed/resume | Seed response `resp_packed_replay_seed` persisted with native item `msg_pi_1`; separate resume process reported `firstLiveSeq > 0`, user-sourced pinned title, exact assistant envelope on continuation, response `resp_packed_replay_continue`, and durable seed+continuation history. |
| Retry/tool exact-once | HTTP provider attempts exactly 3; attempt 1 emitted complete function-call frames then `ECONNRESET` without `response.completed`; attempt 2 repeated the user-only request and completed the call; attempt 3 carried exactly one accepted `function_call` and one `function_call_output`; tool execution=1, `llm/retry`=1, `llm/retry-started`=1, `tool/call`=1, `tool/result`=1, `assistant/message`=2. Any fourth fetch is sticky-rejected. |
| Direct pre-aborted stream | Fetch=0, WebSocket=0, terminal outcome aborted. |
| Agent pre-dispatch cancellation | Fetch=0, WebSocket=0, no retry/assistant message, user-aborted turn end. |
| Agent mid-stream cancellation | Fetch=1 and remains 1 after abort, partial tool-only `assistant/chunk` durable, no assistant/message or tool call/result, no retry, derived and durable logical surface user-only, aborted turn end. |
| Image budget | Five distinct 1070×1070 RGB PNGs (zlib level 0, CRC32) plus a small PNG were stored through `saveImages`; wire retained large1..large4, replaced small+large0 with exactly two `OFFLOADED_IMAGE_TEXT` blocks, and durable six-reference order/metadata remained unchanged. |
| Transport containment | All provider URLs were exact; WebSocket URLs were exact; allowed WS send count=0; external host set remained empty. |
| Credential/topology gates | Existing save/verify/post-logout/confirm-deleted gates remained passing, signed-out requests stayed `CODEX_AUTH_REQUIRED` with zero network attempts, and package logout preserved the adjacent sentinel file. |

The generated credential sentinels were absent from all subprocess captures and result summaries.

## Classification update

The measured six-boot lane resolves the fresh-packed replay, retry/tool, cancellation, and image
budget evidence deferred to Issue #51. ADR 0017 and `docs/compatibility.md` now reflect PASS /
RESOLVED based only on this observed OS/Node run. The separate published-artifact matrix (#50)
and natural-refresh smoke (#33) remain promotion gates.
