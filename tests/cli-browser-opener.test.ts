import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import {
  createSafeBrowserOpener,
  type BrowserLaunchProcess,
  type BrowserSpawn,
} from '../src/cli/browser-opener.js'

class FakeBrowserProcess extends EventEmitter implements BrowserLaunchProcess {
  killCalls: string[] = []

  kill(signal?: NodeJS.Signals): boolean {
    if (signal !== undefined) {
      this.killCalls.push(signal)
    }
    return true
  }
}

function spawnFixture(): {
  readonly process: FakeBrowserProcess
  readonly spawn: BrowserSpawn
  readonly calls: Array<{ command: string; arguments_: readonly string[]; options: unknown }>
} {
  const process = new FakeBrowserProcess()
  const calls: Array<{ command: string; arguments_: readonly string[]; options: unknown }> = []
  const spawn: BrowserSpawn = (command, arguments_, options) => {
    calls.push({ command, arguments_, options })
    return process
  }
  return { process, spawn, calls }
}

describe('safe browser opener', () => {
  it.each([
    ['darwin', '/usr/bin/open'],
    ['linux', 'xdg-open'],
  ] as const)('uses the fixed %s command without a shell', async (platform, command) => {
    const fixture = spawnFixture()
    const opener = createSafeBrowserOpener({ platform, spawn: fixture.spawn })
    const pending = opener.open('https://auth.example.test/authorize')

    expect(fixture.calls).toEqual([{
      command,
      arguments_: platform === 'darwin'
        ? ['--', 'https://auth.example.test/authorize']
        : ['https://auth.example.test/authorize'],
      options: { shell: false, stdio: 'ignore' },
    }])
    fixture.process.emit('close', 0, null)
    await expect(pending).resolves.toBe(true)
  })

  it('does not spawn on an unsupported platform', async () => {
    const spawn = vi.fn<BrowserSpawn>()
    const opener = createSafeBrowserOpener({ platform: 'win32', spawn })

    await expect(opener.open('https://auth.example.test/authorize')).resolves.toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each([
    'http://auth.example.test/authorize',
    'https://user:password@auth.example.test/authorize',
    'not a URL',
  ])('rejects an unsafe destination before spawning: %s', async (url) => {
    const fixture = spawnFixture()
    const opener = createSafeBrowserOpener({ platform: 'linux', spawn: fixture.spawn })

    await expect(opener.open(url)).rejects.toMatchObject({ code: 'CODEX_UPSTREAM_PROTOCOL' })
    expect(fixture.calls).toHaveLength(0)
  })

  it('turns launch errors into a safe false result', async () => {
    const fixture = spawnFixture()
    const opener = createSafeBrowserOpener({ platform: 'linux', spawn: fixture.spawn })
    const pending = opener.open('https://auth.example.test/authorize')

    fixture.process.emit('error', new Error('native path sentinel'))
    await expect(pending).resolves.toBe(false)
  })

  it('cancels and kills a pending native process without leaking process details', async () => {
    const fixture = spawnFixture()
    const opener = createSafeBrowserOpener({ platform: 'linux', spawn: fixture.spawn })
    const controller = new AbortController()
    const pending = opener.open('https://auth.example.test/authorize', controller.signal)

    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fixture.process.killCalls).toEqual(['SIGTERM'])
  })

  it('applies the bounded timeout and kills a hung process', async () => {
    const fixture = spawnFixture()
    const opener = createSafeBrowserOpener({
      platform: 'linux',
      spawn: fixture.spawn,
      timeoutMs: 1,
    })

    await expect(opener.open('https://auth.example.test/authorize')).resolves.toBe(false)
    expect(fixture.process.killCalls).toEqual(['SIGTERM'])
  })
})
