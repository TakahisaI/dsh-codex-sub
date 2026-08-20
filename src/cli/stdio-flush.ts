import type { Writable } from 'node:stream'

export const CLI_STDIO_FLUSH_DEADLINE_MS = 1_000

export interface CliStdioFlushBoundary {
  flush(): Promise<boolean>
  dispose(): void
}

export function createCliStdioFlushBoundary(
  stdout: Writable,
  stderr: Writable,
): CliStdioFlushBoundary {
  const streams = [...new Set([stdout, stderr])]
  const closedStreams = new Set<Writable>()
  const closeListeners = new Map<Writable, () => void>()
  let activeCheck: (() => void) | undefined
  let activeFailure: (() => void) | undefined
  let disposed = false
  let failed = false
  let flushStarted = false

  const markFailed = (): void => {
    failed = true
    activeFailure?.()
  }

  for (const stream of streams) {
    const markClosed = (): void => {
      closedStreams.add(stream)
      activeCheck?.()
    }
    closeListeners.set(stream, markClosed)
    stream.on('error', markFailed)
    stream.on('close', markClosed)
  }

  return Object.freeze({
    flush(): Promise<boolean> {
      if (disposed || failed || flushStarted) {
        return Promise.resolve(false)
      }
      flushStarted = true

      return new Promise((resolve) => {
        let checkImmediate: NodeJS.Immediate | undefined
        let settled = false
        let timer: NodeJS.Timeout | undefined

        const finish = (success: boolean): void => {
          if (settled) {
            return
          }
          settled = true
          activeCheck = undefined
          activeFailure = undefined
          if (checkImmediate !== undefined) {
            clearImmediate(checkImmediate)
            checkImmediate = undefined
          }
          if (timer !== undefined) {
            clearTimeout(timer)
          }
          for (const stream of streams) {
            stream.removeListener('drain', scheduleCheck)
          }
          resolve(success && !failed)
        }

        const check = (): void => {
          if (failed) {
            finish(false)
            return
          }
          if (streams.every((stream) => stream.writableLength === 0)) {
            finish(true)
            return
          }
          if (streams.some(
            (stream) => closedStreams.has(stream) && stream.writableLength > 0,
          )) {
            finish(false)
            return
          }
          scheduleCheck()
        }

        function scheduleCheck(): void {
          if (settled || checkImmediate !== undefined) {
            return
          }
          checkImmediate = setImmediate(() => {
            checkImmediate = undefined
            check()
          })
        }

        activeCheck = scheduleCheck
        activeFailure = () => {
          finish(false)
        }
        timer = setTimeout(() => {
          finish(false)
        }, CLI_STDIO_FLUSH_DEADLINE_MS)
        for (const stream of streams) {
          stream.on('drain', scheduleCheck)
        }
        scheduleCheck()
      })
    },
    dispose(): void {
      if (disposed) {
        return
      }
      disposed = true
      activeFailure?.()
      activeCheck = undefined
      activeFailure = undefined
      for (const stream of streams) {
        stream.removeListener('error', markFailed)
        const markClosed = closeListeners.get(stream)
        if (markClosed !== undefined) {
          stream.removeListener('close', markClosed)
        }
      }
    },
  })
}
