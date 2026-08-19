#!/usr/bin/env node

import { runProductionCli } from './cli/main.js'

const controller = new AbortController()
const cancel = (): void => {
  controller.abort()
}

process.once('SIGINT', cancel)
try {
  process.exitCode = await runProductionCli(
    process.argv.slice(2),
    process.stdin,
    process.stdout,
    process.stderr,
    controller.signal,
  )
} finally {
  process.removeListener('SIGINT', cancel)
}
