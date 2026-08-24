import { parseArgs } from 'node:util'

export const PROBE_SCOPES = Object.freeze(['credential-topology', 'request-contracts'])

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * Parse the required lane scope without a default. A lane invocation must say
 * which evidence it is allowed to claim; silently selecting the heavy request
 * lane would make a credential-only CI job claim #51 coverage.
 */
export function parseProbeScope(arguments_) {
  const occurrences = arguments_.filter((argument) => argument === '--probe-scope' || argument.startsWith('--probe-scope='))
  invariant(occurrences.length === 1, occurrences.length === 0
    ? '--probe-scope is required (credential-topology or request-contracts).'
    : '--probe-scope must be supplied exactly once.')
  const scopeArguments = []
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--probe-scope') {
      const value = arguments_[index + 1]
      invariant(value !== undefined, '--probe-scope requires a value.')
      scopeArguments.push(argument, value)
      index += 1
    } else if (argument?.startsWith('--probe-scope=')) {
      scopeArguments.push(argument)
    }
  }
  const { values } = parseArgs({
    args: scopeArguments,
    allowPositionals: false,
    options: { 'probe-scope': { type: 'string' } },
    strict: true,
  })
  const scope = values['probe-scope']
  invariant(typeof scope === 'string' && PROBE_SCOPES.includes(scope), `Unknown --probe-scope: ${String(scope)}.`)
  return scope
}
