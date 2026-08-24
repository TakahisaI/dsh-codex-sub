import { describe, expect, it } from 'vitest'

import {
  HOST_GRAPH_MODES,
  parseHostGraphMode,
} from '../scripts/host-graph-mode.mjs'

describe('Host graph mode parser', () => {
  it('requires exactly one reviewed mode', () => {
    expect(parseHostGraphMode(['--host-graph-mode', 'override-pinned'])).toBe('override-pinned')
    expect(parseHostGraphMode(['--host-graph-mode=locked-no-overrides'])).toBe('locked-no-overrides')
    expect(HOST_GRAPH_MODES).toEqual(['override-pinned', 'locked-no-overrides'])
  })

  it.each([
    [],
    ['--host-graph-mode', 'override-pinned', '--host-graph-mode', 'locked-no-overrides'],
    ['--host-graph-mode', 'unknown'],
    ['--host-graph-mode'],
  ])('fails closed for invalid invocation %j', arguments_ => {
    expect(() => parseHostGraphMode(arguments_)).toThrow()
  })
})
