# ADR 0015: Keep retry and tool-call acceptance at the DSH turn boundary

- Status: accepted
- Date: 2026-08-20

## Context

Real use of the Alpha needs a clear answer for transient Codex failures: a retry must not admit a
failed attempt's partial text, reasoning, or tool call into model-visible history, and a tool with
side effects must not run twice. The package currently exposes DSH's normal provider retry policy
but deliberately implements neither an agent loop nor a retry executor.

Inspection of the exact public packages pinned by `compatibility.json` established these
boundaries:

- `ctx.llm.stream()` and `PiAiAdapter` perform one provider attempt; pi-ai retries are disabled at
  that adapter boundary;
- `@deepseek-ai/dsh-llm-retry` acts through the agent loop's durable request-error boundary;
- a tool becomes executable only after a successful assistant message is assembled and its
  `tool/call` is recorded;
- session repair distinguishes a request not recorded as started (`TOOL_NOT_STARTED`) from a
  recorded call with no durable outcome (`TOOL_OUTCOME_UNKNOWN`), and the latter must not be
  retried blindly.

Focused execution against DSH `0.1.0-rc.7` found one mismatch with its published retry README. The
README says every retry opens a fresh numbered turn, but the observed durable events keep retries
inside the same open turn and step, separated by `llm/retry` and `llm/retry-started` records. Failed
chunks remain non-surface events and only the successful attempt produces `assistant/message`, so
the safety property holds even though the documented numbering description does not.

The same contract probe found that error text carrying 429, 500, 503, or a recognizable transport
failure maps to `RATE_LIMIT`, `SERVER`, or `TRANSPORT` and is eligible for the normal finite retry
budget. A bare overload phrase with no provider status or recognized type maps to `PI_AI_ERROR` and
stops after one attempt. The plugin cannot safely improve that classification without parsing
provider text or owning the upstream transport error, both outside its boundary.

## Decision

Keep all general retry execution and tool-call acceptance in DSH. `dsh-codex-sub` continues to:

- expose DSH's normal retry policy for `openai-codex`;
- resolve OAuth exactly once for each provider attempt, including each DSH retry;
- delegate stream timeout, cancellation, message assembly, tool execution, durable history, and
  resume to the pinned DSH packages;
- avoid retrying inside `CodexDshAdapter`, where partial chunks have no durable attempt boundary;
- avoid parsing provider messages to manufacture a retryable code.

Pin this behavior with a full public-agent-loop contract suite using only official DSH test
packages and pi-ai's public faux provider and event stream. The suite covers pre-output 429, 500,
503, transport failure, overload, stream timeout, cancellation during streaming and backoff,
finite exhaustion, partial text/reasoning/tool output, a completed-looking failed tool call,
crash-repair classifications, accepted-tool restart/resume, and persisted outcome-unknown-tool
restart/resume. Every captured durable value is scanned for the generated access-token sentinel.

Treat the same-turn/same-step observation as an upstream documentation mismatch, not a project
reason to emulate the documented turn numbering. A future DSH upgrade must rerun this suite and
review the event topology as part of the compatibility project.

## Consequences

- The plugin adds no retry loop, idempotency registry, tool wrapper, or new runtime dependency.
- Transient attempts are bounded by DSH's provider policy; direct `ctx.llm.stream()` callers remain
  single-attempt.
- Failed partial output may remain in the raw durable chunk log for replay fidelity but never
  enters `deriveMessages()` or tool execution.
- A retry obtains fresh request authentication once. It does not reuse an access token captured by
  a failed attempt across the logical retry sequence.
- An unclassified overload fails once with `PI_AI_ERROR`; a status-bearing 429 or 5xx failure uses
  the finite retry budget. Improving upstream classification requires a separately reviewed DSH or
  pi-ai compatibility change.
- After a crash with an uncertain tool outcome, DSH resumes with explicit model-visible recovery
  guidance instead of silently executing the call again.
