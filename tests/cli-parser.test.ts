import { describe, expect, it } from 'vitest'

import {
  CliUsageError,
  parseCliArguments,
} from '../src/cli/parser.js'

describe('CLI argument parser', () => {
  it.each([
    [[], { command: 'help' }],
    [['help'], { command: 'help' }],
    [['--help'], { command: 'help' }],
    [['login'], { command: 'login' }],
    [['logout'], { command: 'logout' }],
    [['status'], { command: 'status', json: false }],
    [['status', '--json'], { command: 'status', json: true }],
    [['doctor', '--json'], { command: 'doctor', json: true }],
    [['version'], { command: 'version' }],
    [['--version'], { command: 'version' }],
  ] as const)('parses %j', (arguments_, expected) => {
    expect(parseCliArguments(arguments_)).toEqual(expected)
  })

  it.each([
    ['unknown'],
    ['login', '--json'],
    ['logout', '--json'],
    ['version', '--json'],
    ['help', 'status'],
    ['status', 'extra'],
    ['--json'],
    ['--version', 'status'],
    ['--unknown'],
  ])('rejects invalid usage %j', (...arguments_) => {
    expect(() => parseCliArguments(arguments_)).toThrow(CliUsageError)
  })
})
