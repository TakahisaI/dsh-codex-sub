# ADR 0016: Flush CLI stdio within one bounded executable deadline

- Status: accepted
- Date: 2026-08-20

## Context

The package executable deliberately calls `process.exit()` after each command settles. This keeps
an unrelated handle left by an upstream OAuth implementation from holding a completed command open.
The reusable CLI layer writes synchronously to the Node stream interface, however, and an accepted
write can still be buffered when the command returns. Immediate forced termination can therefore
truncate human output or the single JSON document promised by `status --json` and `doctor --json`.

Closing process-owned stdout or stderr is not acceptable, and replacing forced termination with an
unbounded natural exit would restore the original lingering-handle failure. Stream failures are
also unsafe diagnostics: native errors can contain paths, buffered data, or host-specific text.

## Decision

Create a private stdio boundary before running the production command. The boundary observes
stdout and stderr errors without printing caught values. After the command settles and its SIGINT
listener is removed, wait until Node reports `writableLength === 0` for each unique stream. A
`drain` event triggers an immediate recheck when a write reported backpressure; event-loop checks
also cover accepted asynchronous writes that stayed below the high-water mark.

Use one shared 1,000 millisecond deadline for both streams. The flush phase performs no additional
write, because a consumer may legitimately close its pipe after reading the complete document. The
package never calls `end()`, `destroy()`, or another stream-closing operation. Remove every error,
close, and drain listener and the deadline resource before final process termination. A stream that
closes after its accepted byte queue reaches zero is complete; a close with pending bytes fails.

When both streams flush successfully, retain the command's selected exit code. When either stream
throws, emits an error, closes early, fails its write callback, or misses the shared deadline, emit
no additional diagnostic and use exit code 3. In all cases the executable then calls
`process.exit()`; the library entry remains reusable and never owns process termination.

## Consequences

- Complete accepted output and deterministic termination now hold together for normal CLI use.
- Backpressured stdout cannot turn one JSON document into a silently truncated success.
- A one-document consumer may close immediately after its newline without a post-output write
  changing the successful command into an `EPIPE` failure.
- A stalled or broken consumer delays exit by at most one second and cannot expose its native error.
- Flush failure may replace an otherwise successful exit code with 3 because output completeness
  could not be proven.
- The executable boundary gains Node stream listeners, so focused tests must prove their removal on
  success, failure, and deadline paths.
