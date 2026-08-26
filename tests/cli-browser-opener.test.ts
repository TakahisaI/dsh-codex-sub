import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { createServer } from 'node:net'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createSafeBrowserOpener,
  type BrowserLaunchProcess,
  type BrowserSpawn,
} from '../src/cli/browser-opener.js'

class FakeBrowserProcess extends EventEmitter implements BrowserLaunchProcess {
  killCalls: string[] = []
  unrefCalls = 0
  killResult = true
  killThrows = false

  kill(signal?: NodeJS.Signals): boolean {
    if (signal !== undefined) {
      this.killCalls.push(signal)
    }
    if (this.killThrows) {
      throw new Error('kill secret sentinel')
    }
    return this.killResult
  }

  unref(): void {
    this.unrefCalls += 1
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
  beforeEach(() => {
    // A local DISPLAY is enough to exercise the opener without depending on
    // the host test runner's desktop session.
    vi.stubEnv('DISPLAY', ':99')
    vi.stubEnv('WAYLAND_DISPLAY', '')
    vi.stubEnv('XDG_RUNTIME_DIR', '')
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each([
    ['darwin', '/usr/bin/open'],
    ['linux', '/usr/bin/xdg-open'],
  ] as const)('uses the fixed %s command without a shell', async (platform, command) => {
    const fixture = spawnFixture()
    const opener = createSafeBrowserOpener({ platform, spawn: fixture.spawn })
    const pending = opener.open('https://auth.example.test/authorize')

    expect(fixture.calls).toEqual([{
      command,
      arguments_: platform === 'darwin'
        ? ['--', 'https://auth.example.test/authorize']
        : ['https://auth.example.test/authorize'],
      options: {
        shell: false,
        stdio: 'ignore',
        env: expect.objectContaining({ PATH: '/usr/bin:/bin' }),
      },
    }])
    const firstCall = fixture.calls[0]
    if (firstCall === undefined) {
      throw new Error('browser spawn call missing')
    }
    expect((firstCall.options as { env: Record<string, string> }).env).not.toHaveProperty('BROWSER')
    expect(fixture.process.unrefCalls).toBe(1)
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
    expect(fixture.process.unrefCalls).toBe(1)
  })

  it('treats nonzero and signal exits as launch failures', async () => {
    const nonzero = spawnFixture()
    const nonzeroPending = createSafeBrowserOpener({ platform: 'linux', spawn: nonzero.spawn })
      .open('https://auth.example.test/authorize')
    nonzero.process.emit('exit', 1, null)
    await expect(nonzeroPending).resolves.toBe(false)
    expect(nonzero.process.unrefCalls).toBe(1)

    const signaled = spawnFixture()
    const signaledPending = createSafeBrowserOpener({ platform: 'linux', spawn: signaled.spawn })
      .open('https://auth.example.test/authorize')
    signaled.process.emit('exit', null, 'SIGTERM')
    await expect(signaledPending).resolves.toBe(false)
    expect(signaled.process.unrefCalls).toBe(1)
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
    expect(process.unrefCalls).toBe(1)
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
    expect(fixture.process.unrefCalls).toBe(1)
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
    expect(fixture.process.unrefCalls).toBe(1)
    fixture.process.emit('error', new Error('timeout-enoent sentinel'))
    fixture.process.emit('close', null, 'SIGTERM')
    expect(fixture.process.listenerCount('error')).toBe(0)
    expect(fixture.process.listenerCount('exit')).toBe(0)
    expect(fixture.process.listenerCount('close')).toBe(0)
  })

  it('keeps abort settlement safe when native kill returns false or throws', async () => {
    for (const mode of ['false', 'throw'] as const) {
      const fixture = spawnFixture()
      if (mode === 'false') {
        fixture.process.killResult = false
      } else {
        fixture.process.killThrows = true
      }
      const controller = new AbortController()
      const opener = createSafeBrowserOpener({ platform: 'linux', spawn: fixture.spawn })
      const pending = opener.open('https://auth.example.test/authorize', controller.signal)
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      expect(fixture.process.unrefCalls).toBe(1)
      fixture.process.emit('close', null, 'SIGTERM')
    }
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
    expect(fixture.process.unrefCalls).toBe(1)

    fixture.process.emit('error', new Error('late error sentinel'))
    fixture.process.emit('close', 0, null)
    expect(fixture.process.listenerCount('error')).toBe(0)
    expect(fixture.process.listenerCount('exit')).toBe(0)
    expect(fixture.process.listenerCount('close')).toBe(0)
  })

  it('passes only the fixed path and validated local display environment', async () => {
    vi.stubEnv('PATH', '/tmp/hostile-path')
    vi.stubEnv('HOME', '/tmp/hostile-home')
    vi.stubEnv('BROWSER', 'browser-secret-sentinel')
    vi.stubEnv('LD_PRELOAD', '/tmp/hostile-loader')
    vi.stubEnv('XDG_CONFIG_HOME', '/tmp/hostile-config')
    vi.stubEnv('XDG_DATA_HOME', '/tmp/hostile-data')
    vi.stubEnv('XDG_DATA_DIRS', '/tmp/hostile-dirs')
    vi.stubEnv('NODE_OPTIONS', '--require=/tmp/hostile-node-loader')
    vi.stubEnv('BASH_ENV', '/tmp/hostile-shell-startup')
    vi.stubEnv('ENV', '/tmp/hostile-shell-startup')
    const fixture = spawnFixture()
    const opener = createSafeBrowserOpener({ platform: 'linux', spawn: fixture.spawn })
    const pending = opener.open('https://auth.example.test/authorize')

    const call = fixture.calls[0]
    expect(call?.command).toBe('/usr/bin/xdg-open')
    expect(call?.options).toEqual({
      shell: false,
      stdio: 'ignore',
      env: {
        PATH: '/usr/bin:/bin',
        DISPLAY: ':99',
      },
    })
    fixture.process.emit('close', 0, null)
    await expect(pending).resolves.toBe(true)
  })

  it('does not search PATH or spawn without one validated local GUI route', async () => {
    vi.stubEnv('DISPLAY', 'remote.example.test:0')
    vi.stubEnv('PATH', '/tmp/fake-path')
    const fixture = spawnFixture()
    const opener = createSafeBrowserOpener({ platform: 'linux', spawn: fixture.spawn })

    await expect(opener.open('https://auth.example.test/authorize')).resolves.toBe(false)
    expect(fixture.calls).toHaveLength(0)
  })

  it('rejects symlinked or group/world-readable runtime directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-opener-runtime-'))
    const symlink = `${root}-link`
    try {
      symlinkSync(root, symlink)
      vi.stubEnv('DISPLAY', '')
      vi.stubEnv('XDG_RUNTIME_DIR', symlink)
      const symlinkFixture = spawnFixture()
      await expect(createSafeBrowserOpener({ platform: 'linux', spawn: symlinkFixture.spawn })
        .open('https://auth.example.test/authorize')).resolves.toBe(false)
      expect(symlinkFixture.calls).toHaveLength(0)

      vi.stubEnv('XDG_RUNTIME_DIR', root)
      chmodSync(root, 0o755)
      const modeFixture = spawnFixture()
      await expect(createSafeBrowserOpener({ platform: 'linux', spawn: modeFixture.spawn })
        .open('https://auth.example.test/authorize')).resolves.toBe(false)
      expect(modeFixture.calls).toHaveLength(0)
    } finally {
      rmSync(symlink, { force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('constructs a local DBus address instead of copying a hostile source value', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-opener-bus-'))
    const socketPath = join(root, 'bus')
    const server = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolve)
      })
      chmodSync(socketPath, 0o600)
      vi.stubEnv('DISPLAY', '')
      vi.stubEnv('XDG_RUNTIME_DIR', root)
      vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'tcp:host=/tmp/evil-bus-sentinel')
      const fixture = spawnFixture()
      const opener = createSafeBrowserOpener({ platform: 'linux', spawn: fixture.spawn })
      const pending = opener.open('https://auth.example.test/authorize')
      const call = fixture.calls[0]
      if (call === undefined) {
        throw new Error('browser spawn call missing')
      }
      const env = (call.options as { env: Record<string, string> }).env
      expect(env).toMatchObject({
        PATH: '/usr/bin:/bin',
        XDG_RUNTIME_DIR: root,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${socketPath}`,
      })
      expect(env['DBUS_SESSION_BUS_ADDRESS']).not.toContain('evil-bus-sentinel')
      fixture.process.emit('close', 0, null)
      await expect(pending).resolves.toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('unrefs a real SIGTERM-ignoring child while keeping the parent bounded', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') {
      return
    }
    let child: ReturnType<typeof nodeSpawn> | undefined
    const spawn: BrowserSpawn = (_command, _arguments_, options) => {
      child = nodeSpawn(process.execPath, [
        '-e',
        'process.on("SIGTERM", () => {}); setTimeout(() => {}, 60000)',
      ], {
        shell: false,
        stdio: 'ignore',
        env: { ...options.env },
      })
      return child
    }
    const opener = createSafeBrowserOpener({ platform: process.platform, spawn, timeoutMs: 25 })
    const started = Date.now()
    try {
      await expect(opener.open('https://auth.example.test/authorize')).resolves.toBe(false)
      expect(Date.now() - started).toBeLessThan(1_000)
    } finally {
      if (child !== undefined && child.exitCode === null) {
        child.kill('SIGKILL')
        await new Promise<void>((resolve) => child?.once('close', () => resolve()))
      }
    }
  })
})
