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

  it('treats nonzero and signal exits as launch failures', async () => {
    const nonzero = spawnFixture()
    const nonzeroPending = createSafeBrowserOpener({ platform: 'linux', spawn: nonzero.spawn })
      .open('https://auth.example.test/authorize')
    nonzero.process.emit('exit', 1, null)
    await expect(nonzeroPending).resolves.toBe(false)

    const signaled = spawnFixture()
    const signaledPending = createSafeBrowserOpener({ platform: 'linux', spawn: signaled.spawn })
      .open('https://auth.example.test/authorize')
    signaled.process.emit('exit', null, 'SIGTERM')
    await expect(signaledPending).resolves.toBe(false)
  })

  it('turns a synchronous spawn failure into a safe result and removes abort listeners', async () => {
    const controller = new AbortController()
    const spawn = vi.fn<BrowserSpawn>(() => {
      throw new Error('native spawn sentinel')
    })
    const opener = createSafeBrowserOpener({ platform: 'linux', spawn })

    await expect(opener.open('https://auth.example.test/authorize', controller.signal))
      .resolves.toBe(false)
    controller.abort()
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('wins an abort race that fires synchronously during spawn without leaving a timer', async () => {
    const controller = new AbortController()
    const process = new FakeBrowserProcess()
    const spawn: BrowserSpawn = () => {
      controller.abort()
      return process
    }
    const opener = createSafeBrowserOpener({ platform: 'linux', spawn })

    await expect(opener.open('https://auth.example.test/authorize', controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(process.killCalls).toEqual(['SIGTERM'])
    process.emit('error', new Error('abort-before-enoent sentinel'))
    process.emit('close', null, 'SIGTERM')
    expect(process.listenerCount('error')).toBe(0)
    expect(process.listenerCount('exit')).toBe(0)
    expect(process.listenerCount('close')).toBe(0)
  })

  it('cancels and kills a pending native process without leaking process details', async () => {
    const fixture = spawnFixture()
    const opener = createSafeBrowserOpener({ platform: 'linux', spawn: fixture.spawn })
    const controller = new AbortController()
    const pending = opener.open('https://auth.example.test/authorize', controller.signal)

    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fixture.process.killCalls).toEqual(['SIGTERM'])
    fixture.process.emit('error', new Error('late error sentinel'))
    fixture.process.emit('close', 0, null)
    expect(fixture.process.killCalls).toEqual(['SIGTERM'])
    expect(fixture.process.listenerCount('error')).toBe(0)
    expect(fixture.process.listenerCount('exit')).toBe(0)
    expect(fixture.process.listenerCount('close')).toBe(0)
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
    fixture.process.emit('error', new Error('timeout-enoent sentinel'))
    fixture.process.emit('close', null, 'SIGTERM')
    expect(fixture.process.listenerCount('error')).toBe(0)
    expect(fixture.process.listenerCount('exit')).toBe(0)
    expect(fixture.process.listenerCount('close')).toBe(0)
  })

  it('cleans listeners after a timeout/close race and settles only once', async () => {
    const fixture = spawnFixture()
    const opener = createSafeBrowserOpener({
      platform: 'linux',
      spawn: fixture.spawn,
      timeoutMs: 1,
    })
    const pending = opener.open('https://auth.example.test/authorize')
    await expect(pending).resolves.toBe(false)

    fixture.process.emit('error', new Error('late error sentinel'))
    fixture.process.emit('close', 0, null)
    expect(fixture.process.listenerCount('error')).toBe(0)
    expect(fixture.process.listenerCount('exit')).toBe(0)
    expect(fixture.process.listenerCount('close')).toBe(0)
  })
})
