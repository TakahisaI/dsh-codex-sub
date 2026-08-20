#!/usr/bin/env node

import {
  CLI_EXIT_FAILURE,
  runProductionCli,
} from './cli/main.js'
import { createCliStdioFlushBoundary } from './cli/stdio-flush.js'

const controller = new AbortController()
const stdio = createCliStdioFlushBoundary(process.stdout, process.stderr)
const cancel = (): void => {
  controller.abort()
}

process.once('SIGINT', cancel)
let exitCode = CLI_EXIT_FAILURE
try {
  exitCode = await runProductionCli(
    process.argv.slice(2),
    process.stdin,
    process.stdout,
    process.stderr,
    controller.signal,
  )
} catch {
  exitCode = CLI_EXIT_FAILURE
} finally {
  process.removeListener('SIGINT', cancel)
}

const flushed = await stdio.flush()
stdio.dispose()
process.exit(flushed ? exitCode : CLI_EXIT_FAILURE)
