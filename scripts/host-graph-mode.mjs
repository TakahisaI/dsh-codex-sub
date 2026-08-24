import { parseArgs } from 'node:util'

export const HOST_GRAPH_MODES = Object.freeze([
  'override-pinned',
  'locked-no-overrides',
])

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * Parse the required Host graph policy without a default. The release lane
 * must state whether it is exercising the historical override-pinned graph or
 * the #50 fixture whose frozen lock has no override/resolution metadata.
 */
export function parseHostGraphMode(arguments_) {
  const occurrences = arguments_.filter(argument => (
    argument === '--host-graph-mode' || argument.startsWith('--host-graph-mode=')
  ))
  invariant(occurrences.length === 1, occurrences.length === 0
    ? '--host-graph-mode is required (override-pinned or locked-no-overrides).'
    : '--host-graph-mode must be supplied exactly once.')
  const modeArguments = []
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--host-graph-mode') {
      const value = arguments_[index + 1]
      invariant(value !== undefined, '--host-graph-mode requires a value.')
      modeArguments.push(argument, value)
      index += 1
    } else if (argument.startsWith('--host-graph-mode=')) {
      modeArguments.push(argument)
    }
  }
  const { values } = parseArgs({
    args: modeArguments,
    allowPositionals: false,
    options: { 'host-graph-mode': { type: 'string' } },
    strict: true,
  })
  const mode = values['host-graph-mode']
  invariant(
    typeof mode === 'string' && HOST_GRAPH_MODES.includes(mode),
    `Unknown --host-graph-mode: ${String(mode)}.`,
  )
  return mode
}
