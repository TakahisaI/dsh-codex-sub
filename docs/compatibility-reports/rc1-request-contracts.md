# Fresh packed rc.1 request-behavior contracts (#51)

## Scope

This report records the secret-free evidence for issue #51: attachment budget offload,
replay metadata survival, the retry boundary, and cancellation proven on one fresh isolated
DSH `0.1.1-rc.1` Host installation of the exact packed candidate artifact — closing the
"NOT TESTED" row in ADR 0017's packed-topology status table.

No compatibility metadata, peer range, release metadata, or package version changed as part
of this work.

## Candidate identity

- Package under test: `dsh-codex-sub@0.1.0-alpha.2` packed tarball,
  SHA-256 `296bacf8c3b7e5f9550b0d99b402e25ff80c97a2193ac72fd36fe333d87261ae`.
- Host: fresh `0.1.1-rc.1` release-line graph (439 physical DSH package copies), exact-pinned,
  verified by the existing whole-graph candidate-version checks.
- Topology after install: 6 direct DSH peers shared with the Host, 2 pi-ai copies
  (Host + plugin-owned `0.82.1`), 9 adapter-transitive Host peers resolved.
- Upstream inspected commit: `528c682e061696f5a160f363f236ecbf53cbd006`.

## Method

The exact-artifact lane (`scripts/spike-exact-artifact-lane.mjs`) gained a fifth probe boot,
phase `requests`. The boot signs the packed route in through the package-owned vault and
streams through the real pi-ai Codex client (`openai-codex-responses`). A scripted in-memory
transport replaces `globalThis.fetch` at plugin-module load and answers only the pinned Codex
responses endpoint; it keeps every other destination fail-closed and records any external
attempt. A rejecting WebSocket constructor exercises pi-ai's documented fall-back to SSE.
The access token is a shape-only three-part stand-in whose payload carries no real data; its
account claim is a fixed probe constant and nothing leaves the process.

The four behaviors are then driven through the public `ctx.llm.stream` boundary on the
packed adapter:

1. **Attachment/image-budget** — a genuine 1×1 PNG is admitted through the deployment's real
   `LocalAttachmentStore` (`saveImages`: validation, content-addressed storage, durable
   reference) and referenced by the request. The transport asserts the store-resolved bytes
   arrived inside the provider payload as an `input_image` data URL.
2. **Replay survival** — the assembled assistant message is fed back as durable history with
   its replay envelope; the continuation request must carry the restored native assistant
   item, and both terminal envelopes must keep the scripted response identity.
3. **Retry boundary** — one pre-response transport failure (`ECONNRESET`) is injected for a
   marked request; the observed failure must classify `TRANSPORT` at the public DSH boundary.
   The packed profile ships no retry executor (`llm-retry` is a separate optional plugin and
   the production profile does not bundle it), so exactly one provider attempt is expected;
   the failure surfaces to the caller unmodified instead of being retried or masked.
4. **Cancellation** — abort mid-stream before any output byte; the stream must end in an
   `aborted` finish (not a raw `AbortError`), admit no partial output deltas, and make no
   further provider attempt.

## Results

| Behavior | Result | Observed |
| --- | --- | --- |
| Attachment resolution onto the wire | PASS | admitted reference resolved via the deployment store; PNG bytes present as `input_image` data URL; exactly 1 provider attempt |
| Replay metadata survival | PASS | continuation request carried the native assistant item; response identity matched across both streams |
| Retry boundary | PASS | scripted transport failure classified `TRANSPORT`; exactly 1 provider attempt (no hidden retry); failure surfaced unmodified |
| Cancellation | PASS | terminal `aborted` finish; zero partial output deltas; no further provider attempt |
| Network containment (whole boot) | PASS | zero external hosts; every dial answered by the scripted transport |

Signed-in streaming also re-proved on this same fresh install: clean stop, assembled text,
usage, and a replay envelope whose response identity matches the scripted response. All four
credential-lifecycle boots (save/restart/post-logout/confirm-deleted) still pass unchanged
after the requests boot, including signed-out `CODEX_AUTH_REQUIRED` with zero network
attempts, confirming the requests phase left no residue (the re-created credential is removed
and signed-out state re-verified by CLI before those boots).

Generated sentinels remain absent from all captures; the lane summary carries only public
version, topology, and pass/fail data.

## Classification update

ADR 0017's "Fresh-packed rc.1 replay, retry, cancellation" row moves from NOT TESTED to PASS
with this evidence; exit criterion 2's deferred clause ("fresh-packed replay, retry, and
cancellation remain explicitly deferred to #51") is satisfied. The remaining promotion gates
(#50 published-artifact matrix, #33 natural refresh observation) are unchanged.
