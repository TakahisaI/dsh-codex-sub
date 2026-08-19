function invariant(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

export function appendCapture(target, chunk, maximumBytes) {
  invariant(Number.isSafeInteger(maximumBytes) && maximumBytes > 0, 'Capture limit must be positive.')
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
  const remaining = maximumBytes - target.bytes
  if (remaining <= 0) {
    target.truncated = true
    return
  }
  const captured = bytes.subarray(0, remaining)
  target.value += captured.toString('utf8')
  target.bytes += captured.length
  if (bytes.length > remaining) {
    target.truncated = true
  }
}

export function assertCaptureComplete(stdout, stderr) {
  if (stdout.truncated || stderr.truncated) {
    throw new Error('DSH output exceeded the packed-install capture limit.')
  }
}
