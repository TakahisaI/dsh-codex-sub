import { EventEmitter } from 'node:events'
import {
  accessSync,
  chmodSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { userInfo as nodeUserInfo } from 'node:os'
import { join } from 'node:path'
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process'
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

function repoTemp(prefix: string): string {
  return mkdtempSync(join(process.cwd(), `.${prefix}`))
}

function currentUid(): number {
  const uid = process.getuid?.()
  if (uid === undefined || process.geteuid?.() !== uid) {
    throw new Error('test process must have matching real/effective uid')
  }
  return uid
}

function canonicalHome(): string {
  return realpathSync.native(nodeUserInfo().homedir)
}

function browserEnvironment(call: {
  readonly options: unknown
}): Record<string, string> {
  return (call.options as { readonly env: Record<string, string> }).env
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return true
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  return existsSync(path)
}

describe('safe browser opener', () => {
  beforeEach(() => {
    // A local DISPLAY is enough to exercise the opener without depending on
    // the host test runner's desktop session.
    vi.stubEnv('DISPLAY', ':99')
    vi.stubEnv('WAYLAND_DISPLAY', '')
    vi.stubEnv('XDG_RUNTIME_DIR', '')
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', '')
    vi.stubEnv('XDG_CONFIG_HOME', '')
    vi.stubEnv('XDG_DATA_HOME', '')
    vi.stubEnv('XDG_CONFIG_DIRS', '')
    vi.stubEnv('XDG_DATA_DIRS', '')
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

  it.each(['unset', 'empty'] as const)('uses XDG specification defaults when roots are %s', async (state) => {
    const home = repoTemp('dsh-opener-default-home-')
    try {
      for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_DIRS', 'XDG_DATA_DIRS']) {
        if (state === 'unset') {
          delete process.env[name]
        } else {
          vi.stubEnv(name, '')
        }
      }
      const fixture = spawnFixture()
      const pending = createSafeBrowserOpener({
        platform: 'linux',
        spawn: fixture.spawn,
        userInfo: () => ({ uid: currentUid(), homedir: home }),
      }).open('https://auth.example.test/authorize')
      const call = fixture.calls[0]
      if (call === undefined) {
        throw new Error('browser spawn call missing')
      }
      expect(browserEnvironment(call)).toEqual(expect.objectContaining({
        HOME: realpathSync.native(home),
        XDG_CONFIG_HOME: join(realpathSync.native(home), '.config'),
        XDG_DATA_HOME: join(realpathSync.native(home), '.local', 'share'),
        XDG_CONFIG_DIRS: '/etc/xdg',
        XDG_DATA_DIRS: '/usr/local/share:/usr/share',
      }))
      fixture.process.emit('close', 0, null)
      await expect(pending).resolves.toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not spawn on an unsupported platform', async () => {
    const spawn = vi.fn<BrowserSpawn>()
    const opener = createSafeBrowserOpener({ platform: 'win32', spawn })

    await expect(opener.open('https://auth.example.test/authorize')).resolves.toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('ignores hostile XDG values on macOS', async () => {
    vi.stubEnv('XDG_CONFIG_HOME', '/tmp/hostile-config')
    vi.stubEnv('XDG_DATA_HOME', '/tmp/hostile-data')
    vi.stubEnv('XDG_CONFIG_DIRS', '/tmp/hostile-config-dirs')
    vi.stubEnv('XDG_DATA_DIRS', '/tmp/hostile-data-dirs')
    const fixture = spawnFixture()
    const pending = createSafeBrowserOpener({ platform: 'darwin', spawn: fixture.spawn })
      .open('https://auth.example.test/authorize')
    const call = fixture.calls[0]
    if (call === undefined) {
      throw new Error('browser spawn call missing')
    }
    expect(browserEnvironment(call)).toEqual({ PATH: '/usr/bin:/bin' })
    fixture.process.emit('close', 0, null)
    await expect(pending).resolves.toBe(true)
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
    vi.stubEnv('XDG_CONFIG_HOME', '')
    vi.stubEnv('XDG_DATA_HOME', '')
    vi.stubEnv('XDG_CONFIG_DIRS', '')
    vi.stubEnv('XDG_DATA_DIRS', '')
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
        HOME: canonicalHome(),
        XDG_CONFIG_HOME: join(canonicalHome(), '.config'),
        XDG_DATA_HOME: join(canonicalHome(), '.local', 'share'),
        XDG_CONFIG_DIRS: '/etc/xdg',
        XDG_DATA_DIRS: '/usr/local/share:/usr/share',
        DISPLAY: ':99',
      },
    })
    fixture.process.emit('close', 0, null)
    await expect(pending).resolves.toBe(true)
  })

  it('canonicalizes custom XDG single roots and preserves de-duplicated list order', async () => {
    const home = repoTemp('dsh-opener-xdg-home-')
    const configTarget = join(home, 'config-target')
    const configLink = join(home, 'config-link')
    const dataTarget = join(home, 'data-target')
    const dataLink = join(home, 'data-link')
    const configListA = join(home, 'config-list-a')
    const configListB = join(home, 'config-list-b')
    const configListLink = join(home, 'config-list-link')
    const dataListA = join(home, 'data-list-a')
    const dataListB = join(home, 'データ-list-b')
    const dataListLink = join(home, 'data-list-link')
    for (const path of [
      configTarget,
      dataTarget,
      configListA,
      configListB,
      dataListA,
      dataListB,
    ]) {
      mkdirSync(path, { mode: 0o700 })
      chmodSync(path, 0o700)
    }
    symlinkSync(configTarget, configLink)
    symlinkSync(dataTarget, dataLink)
    symlinkSync(configListA, configListLink)
    symlinkSync(dataListA, dataListLink)
    try {
      vi.stubEnv('XDG_CONFIG_HOME', configLink)
      vi.stubEnv('XDG_DATA_HOME', dataLink)
      vi.stubEnv('XDG_CONFIG_DIRS', `${configListLink}:${configListB}:${configListA}`)
      vi.stubEnv('XDG_DATA_DIRS', `${dataListLink}:${dataListB}:${dataListA}`)
      const fixture = spawnFixture()
      const pending = createSafeBrowserOpener({
        platform: 'linux',
        spawn: fixture.spawn,
        userInfo: () => ({ uid: currentUid(), homedir: home }),
      }).open('https://auth.example.test/authorize')
      const call = fixture.calls[0]
      if (call === undefined) {
        throw new Error('browser spawn call missing')
      }
      const originalConfigLink = `${configLink}-original`
      renameSync(configLink, originalConfigLink)
      symlinkSync(dataTarget, configLink)
      const canonical = realpathSync.native
      expect(browserEnvironment(call)).toMatchObject({
        XDG_CONFIG_HOME: canonical(configTarget),
        XDG_DATA_HOME: canonical(dataTarget),
        XDG_CONFIG_DIRS: `${canonical(configListA)}:${canonical(configListB)}`,
        XDG_DATA_DIRS: `${canonical(dataListA)}:${canonical(dataListB)}`,
      })
      fixture.process.emit('close', 0, null)
      await expect(pending).resolves.toBe(true)
    } finally {
      rmSync(configLink, { force: true })
      rmSync(`${configLink}-original`, { force: true })
      rmSync(dataLink, { force: true })
      rmSync(configListLink, { force: true })
      rmSync(dataListLink, { force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('rejects invalid or unsafe custom XDG roots before spawning', async () => {
    const home = repoTemp('dsh-opener-xdg-invalid-home-')
    const outside = repoTemp('dsh-opener-xdg-outside-')
    const file = join(home, 'not-a-directory')
    const writable = join(home, 'writable')
    const sticky = join(home, 'sticky')
    writeFileSync(file, 'not a directory')
    mkdirSync(writable, { mode: 0o700 })
    mkdirSync(sticky, { mode: 0o1777 })
    chmodSync(writable, 0o777)
    chmodSync(sticky, 0o1777)
    try {
      const invalidValues = [
        'relative/path',
        ' ',
        `${home}/has\ncontrol`,
        `/${'a'.repeat(4_096)}`,
        file,
        join(home, 'does-not-exist'),
        outside,
        writable,
        sticky,
      ]
      for (const value of invalidValues) {
        vi.stubEnv('XDG_CONFIG_HOME', value)
        const fixture = spawnFixture()
        await expect(createSafeBrowserOpener({
          platform: 'linux',
          spawn: fixture.spawn,
          userInfo: () => ({ uid: currentUid(), homedir: home }),
        }).open('https://auth.example.test/authorize')).resolves.toBe(false)
        expect(fixture.calls).toHaveLength(0)
      }

      const listValues = [
        ':',
        `${home}:`,
        `${home}:relative/path`,
        `${home}:${join(home, 'does-not-exist')}`,
        `${home}:${file}`,
        `${home}:${writable}`,
        `${home}:${sticky}`,
        Array.from({ length: 33 }, () => home).join(':'),
        `${home}:/${'b'.repeat(4_096)}`,
        `${home}:${home}/has\tcontrol`,
      ]
      for (const value of listValues) {
        vi.stubEnv('XDG_CONFIG_HOME', '')
        vi.stubEnv('XDG_CONFIG_DIRS', value)
        const fixture = spawnFixture()
        await expect(createSafeBrowserOpener({
          platform: 'linux',
          spawn: fixture.spawn,
          userInfo: () => ({ uid: currentUid(), homedir: home }),
        }).open('https://auth.example.test/authorize')).resolves.toBe(false)
        expect(fixture.calls).toHaveLength(0)
      }
    } finally {
      chmodSync(writable, 0o700)
      chmodSync(sticky, 0o700)
      rmSync(outside, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('rejects an invalid second XDG list entry instead of dropping it', async () => {
    const home = repoTemp('dsh-opener-xdg-second-home-')
    const first = join(home, 'first')
    mkdirSync(first, { mode: 0o700 })
    chmodSync(first, 0o700)
    try {
      vi.stubEnv('XDG_CONFIG_DIRS', `${first}:${join(home, 'missing')}`)
      const fixture = spawnFixture()
      await expect(createSafeBrowserOpener({
        platform: 'linux',
        spawn: fixture.spawn,
        userInfo: () => ({ uid: currentUid(), homedir: home }),
      }).open('https://auth.example.test/authorize')).resolves.toBe(false)
      expect(fixture.calls).toHaveLength(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('allows root-owned system XDG list roots but rejects them as single roots', async () => {
    if (!existsSync('/usr/share')) {
      return
    }
    const home = repoTemp('dsh-opener-xdg-system-home-')
    try {
      vi.stubEnv('XDG_CONFIG_HOME', '/usr/share')
      const singleFixture = spawnFixture()
      await expect(createSafeBrowserOpener({
        platform: 'linux',
        spawn: singleFixture.spawn,
        userInfo: () => ({ uid: currentUid(), homedir: home }),
      }).open('https://auth.example.test/authorize')).resolves.toBe(false)
      expect(singleFixture.calls).toHaveLength(0)

      vi.stubEnv('XDG_CONFIG_HOME', '')
      vi.stubEnv('XDG_CONFIG_DIRS', '/usr/share')
      const listFixture = spawnFixture()
      const pending = createSafeBrowserOpener({
        platform: 'linux',
        spawn: listFixture.spawn,
        userInfo: () => ({ uid: currentUid(), homedir: home }),
      }).open('https://auth.example.test/authorize')
      const call = listFixture.calls[0]
      if (call === undefined) {
        throw new Error('browser spawn call missing')
      }
      expect(browserEnvironment(call)['XDG_CONFIG_DIRS']).toBe('/usr/share')
      listFixture.process.emit('close', 0, null)
      await expect(pending).resolves.toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not search PATH or spawn without one validated local GUI route', async () => {
    vi.stubEnv('DISPLAY', 'remote.example.test:0')
    vi.stubEnv('PATH', '/tmp/fake-path')
    const fixture = spawnFixture()
    const opener = createSafeBrowserOpener({ platform: 'linux', spawn: fixture.spawn })

    await expect(opener.open('https://auth.example.test/authorize')).resolves.toBe(false)
    expect(fixture.calls).toHaveLength(0)
  })

  it('copies only bounded desktop/session values and the KDE version allow-list', async () => {
    vi.stubEnv('XDG_CURRENT_DESKTOP', 'GNOME:Wayland')
    vi.stubEnv('XDG_SESSION_DESKTOP', 'gnome.desktop')
    vi.stubEnv('XDG_SESSION_TYPE', 'wayland')
    vi.stubEnv('KDE_SESSION_VERSION', '5')
    const fixture = spawnFixture()
    const pending = createSafeBrowserOpener({ platform: 'linux', spawn: fixture.spawn })
      .open('https://auth.example.test/authorize')
    const call = fixture.calls[0]
    if (call === undefined) {
      throw new Error('browser spawn call missing')
    }
    expect((call.options as { env: Record<string, string> }).env).toEqual(expect.objectContaining({
      XDG_CURRENT_DESKTOP: 'GNOME:Wayland',
      XDG_SESSION_DESKTOP: 'gnome.desktop',
      XDG_SESSION_TYPE: 'wayland',
      KDE_SESSION_VERSION: '5',
    }))
    vi.stubEnv('KDE_SESSION_VERSION', '7')
    fixture.process.emit('close', 0, null)
    await expect(pending).resolves.toBe(true)

    const invalid = spawnFixture()
    const invalidPending = createSafeBrowserOpener({ platform: 'linux', spawn: invalid.spawn })
      .open('https://auth.example.test/authorize')
    const invalidCall = invalid.calls[0]
    if (invalidCall === undefined) {
      throw new Error('browser spawn call missing')
    }
    expect((invalidCall.options as { env: Record<string, string> }).env)
      .not.toHaveProperty('KDE_SESSION_VERSION')
    invalid.process.emit('close', 0, null)
    await expect(invalidPending).resolves.toBe(true)
  })

  it('rejects symlinked or group/world-readable runtime directories', async () => {
    const root = repoTemp('dsh-opener-runtime-')
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
    const root = repoTemp('dsh-opener-bus-')
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
      const canonicalRuntime = realpathSync.native(root)
      expect(env).toMatchObject({
        PATH: '/usr/bin:/bin',
        HOME: canonicalHome(),
        XDG_RUNTIME_DIR: canonicalRuntime,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(canonicalRuntime, 'bus')}`,
      })
      expect(env['DBUS_SESSION_BUS_ADDRESS']).not.toContain('evil-bus-sentinel')
      fixture.process.emit('close', 0, null)
      await expect(pending).resolves.toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('emits only the canonical runtime after resolving an intermediate symlink', async () => {
    const target = repoTemp('r-')
    const runtime = join(target, 'r')
    mkdirSync(runtime, { mode: 0o700 })
    chmodSync(runtime, 0o700)
    const sourceLink = `${target}-l`
    symlinkSync(target, sourceLink)
    let evilTarget: string | undefined
    const socketPath = join(runtime, 'bus')
    const server = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolve)
      })
      chmodSync(socketPath, 0o600)
      vi.stubEnv('DISPLAY', '')
      vi.stubEnv('XDG_RUNTIME_DIR', join(sourceLink, 'r'))
      const fixture = spawnFixture()
      const opener = createSafeBrowserOpener({
        platform: 'linux',
        spawn: (command, arguments_, options) => {
          // Swapping the source after browserEnvironment has returned must not
          // change the canonical value already handed to the child.
          renameSync(sourceLink, `${sourceLink}-old`)
          evilTarget = repoTemp('dsh-opener-canonical-evil-')
          symlinkSync(evilTarget, sourceLink)
          return fixture.spawn(command, arguments_, options)
        },
      })
      const pending = opener.open('https://auth.example.test/authorize')
      const call = fixture.calls[0]
      if (call === undefined) {
        throw new Error('browser spawn call missing')
      }
      const env = (call.options as { env: Record<string, string> }).env
      const canonicalRuntime = realpathSync.native(runtime)
      expect(env['XDG_RUNTIME_DIR']).toBe(canonicalRuntime)
      expect(env['DBUS_SESSION_BUS_ADDRESS']).toBe(`unix:path=${join(canonicalRuntime, 'bus')}`)
      expect(env['XDG_RUNTIME_DIR']).not.toContain(sourceLink)
      fixture.process.emit('close', 0, null)
      await expect(pending).resolves.toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(sourceLink, { force: true })
      rmSync(`${sourceLink}-old`, { force: true })
      if (evilTarget !== undefined) {
        rmSync(evilTarget, { recursive: true, force: true })
      }
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('rejects unsafe canonical runtime components and hostile ancestors', async () => {
    const unsafeBase = repoTemp('dsh-opener-unsafe-base-')
    const unsafeTarget = `${unsafeBase}-日本`
    renameSync(unsafeBase, unsafeTarget)
    const unsafeRuntime = join(unsafeTarget, 'runtime')
    mkdirSync(unsafeRuntime, { mode: 0o700 })
    chmodSync(unsafeRuntime, 0o700)
    const unsafeLink = `${unsafeBase}-link`
    symlinkSync(unsafeTarget, unsafeLink)
    const ancestor = repoTemp('dsh-opener-hostile-ancestor-')
    const nestedRuntime = join(ancestor, 'runtime')
    mkdirSync(nestedRuntime, { mode: 0o700 })
    chmodSync(nestedRuntime, 0o700)
    chmodSync(ancestor, 0o777)
    try {
      vi.stubEnv('DISPLAY', '')
      vi.stubEnv('XDG_RUNTIME_DIR', join(unsafeLink, 'runtime'))
      const unsafeFixture = spawnFixture()
      await expect(createSafeBrowserOpener({ platform: 'linux', spawn: unsafeFixture.spawn })
        .open('https://auth.example.test/authorize')).resolves.toBe(false)
      expect(unsafeFixture.calls).toHaveLength(0)

      vi.stubEnv('XDG_RUNTIME_DIR', nestedRuntime)
      const hostileFixture = spawnFixture()
      await expect(createSafeBrowserOpener({ platform: 'linux', spawn: hostileFixture.spawn })
        .open('https://auth.example.test/authorize')).resolves.toBe(false)
      expect(hostileFixture.calls).toHaveLength(0)
    } finally {
      rmSync(unsafeLink, { force: true })
      rmSync(unsafeTarget, { recursive: true, force: true })
      chmodSync(ancestor, 0o700)
      rmSync(ancestor, { recursive: true, force: true })
    }
  })

  it('uses a canonical injected home and ignores ambient HOME and user mismatch', async () => {
    const home = repoTemp('dsh-opener-home-')
    const hostileHome = repoTemp('dsh-opener-hostile-home-')
    try {
      vi.stubEnv('DISPLAY', ':99')
      vi.stubEnv('HOME', hostileHome)
      const fixture = spawnFixture()
      const pending = createSafeBrowserOpener({
        platform: 'linux',
        spawn: fixture.spawn,
        userInfo: () => ({ uid: currentUid(), homedir: home }),
      }).open('https://auth.example.test/authorize')
      const call = fixture.calls[0]
      if (call === undefined) {
        throw new Error('browser spawn call missing')
      }
      expect((call.options as { env: Record<string, string> }).env).toEqual(expect.objectContaining({
        HOME: realpathSync.native(home),
        XDG_CONFIG_HOME: join(realpathSync.native(home), '.config'),
        XDG_DATA_HOME: join(realpathSync.native(home), '.local', 'share'),
        XDG_CONFIG_DIRS: '/etc/xdg',
        XDG_DATA_DIRS: '/usr/local/share:/usr/share',
      }))
      expect((call.options as { env: Record<string, string> }).env['HOME']).not.toBe(hostileHome)
      fixture.process.emit('close', 0, null)
      await expect(pending).resolves.toBe(true)

      const mismatchFixture = spawnFixture()
      await expect(createSafeBrowserOpener({
        platform: 'linux',
        spawn: mismatchFixture.spawn,
        userInfo: () => ({ uid: currentUid() + 1, homedir: home }),
      }).open('https://auth.example.test/authorize')).resolves.toBe(false)
      expect(mismatchFixture.calls).toHaveLength(0)
    } finally {
      rmSync(hostileHome, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('keeps Linux default-handler discovery browser-free and uses the fixed xdg-mime path', () => {
    if (process.platform !== 'linux') {
      return
    }
    accessSync('/usr/bin/xdg-mime', fsConstants.X_OK)
    const home = repoTemp('dsh-opener-mime-home-')
    const config = join(home, '.config')
    const applications = join(home, '.local', 'share', 'applications')
    mkdirSync(config, { recursive: true, mode: 0o700 })
    mkdirSync(applications, { recursive: true, mode: 0o700 })
    chmodSync(home, 0o700)
    chmodSync(config, 0o700)
    chmodSync(applications, 0o700)
    writeFileSync(join(config, 'mimeapps.list'), [
      '[Default Applications]',
      'x-scheme-handler/https=fixture-browser.desktop;',
      '',
    ].join('\n'))
    writeFileSync(join(applications, 'fixture-browser.desktop'), [
      '[Desktop Entry]',
      'Type=Application',
      'Name=DSH test handler',
      'Exec=/bin/true %u',
      '',
    ].join('\n'))
    try {
      const result = nodeSpawnSync('/usr/bin/xdg-mime', [
        'query',
        'default',
        'x-scheme-handler/https',
      ], {
        shell: false,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: realpathSync.native(home),
          XDG_CONFIG_HOME: join(realpathSync.native(home), '.config'),
          XDG_DATA_HOME: join(realpathSync.native(home), '.local', 'share'),
          XDG_CONFIG_DIRS: '/etc/xdg',
          XDG_DATA_DIRS: '/usr/local/share:/usr/share',
        },
        encoding: 'utf8',
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe('fixture-browser.desktop')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('uses a default HTTPS handler from non-default XDG roots without launching a browser', async () => {
    if (process.platform !== 'linux') {
      return
    }
    accessSync('/usr/bin/xdg-open', fsConstants.X_OK)
    accessSync('/usr/bin/touch', fsConstants.X_OK)
    const home = repoTemp('dsh-opener-xdg-integration-home-')
    const configHome = join(home, 'custom-config')
    const dataRoot = join(home, 'custom-data-root')
    const defaultDataHome = join(home, '.local', 'share')
    const customApplications = join(dataRoot, 'applications')
    const fallbackApplications = join(defaultDataHome, 'applications')
    const customMarker = join(home, 'custom-handler.marker')
    const fallbackMarker = join(home, 'fallback-handler.marker')
    mkdirSync(configHome, { mode: 0o700 })
    mkdirSync(customApplications, { recursive: true, mode: 0o700 })
    mkdirSync(fallbackApplications, { recursive: true, mode: 0o700 })
    for (const path of [home, configHome, dataRoot, customApplications, defaultDataHome, fallbackApplications]) {
      chmodSync(path, 0o700)
    }
    writeFileSync(join(configHome, 'mimeapps.list'), [
      '[Default Applications]',
      'x-scheme-handler/https=custom-dsh-handler.desktop;',
      '',
    ].join('\n'))
    writeFileSync(join(customApplications, 'custom-dsh-handler.desktop'), [
      '[Desktop Entry]',
      'Type=Application',
      'Name=DSH custom handler',
      `Exec=/usr/bin/touch ${customMarker}`,
      '',
    ].join('\n'))
    writeFileSync(join(fallbackApplications, 'fallback-dsh-handler.desktop'), [
      '[Desktop Entry]',
      'Type=Application',
      'Name=DSH fallback handler',
      `Exec=/usr/bin/touch ${fallbackMarker}`,
      '',
    ].join('\n'))
    try {
      vi.stubEnv('XDG_CONFIG_HOME', configHome)
      vi.stubEnv('XDG_DATA_HOME', '')
      vi.stubEnv('XDG_CONFIG_DIRS', '')
      vi.stubEnv('XDG_DATA_DIRS', `${dataRoot}:/usr/local/share:/usr/share`)
      vi.stubEnv('XDG_CURRENT_DESKTOP', 'generic')
      const opener = createSafeBrowserOpener({
        platform: 'linux',
        timeoutMs: 2_000,
        userInfo: () => ({ uid: currentUid(), homedir: home }),
      })
      await expect(opener.open('https://auth.example.test/authorize')).resolves.toBe(true)
      expect(await waitForFile(customMarker)).toBe(true)
      expect(existsSync(fallbackMarker)).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('fails closed for delimiter-bearing runtime paths and omits DBus on a separate display route', async () => {
    const delimiters = [';', ',', '%', '=', ':', '\\', ' ', '日本']
    for (const delimiter of delimiters) {
      const root = repoTemp('dsh-opener-path-')
      const unsafe = `${root}-${delimiter}`
      renameSync(root, unsafe)
      try {
        vi.stubEnv('DISPLAY', '')
        vi.stubEnv('XDG_RUNTIME_DIR', unsafe)
        const noRoute = spawnFixture()
        await expect(createSafeBrowserOpener({ platform: 'linux', spawn: noRoute.spawn })
          .open('https://auth.example.test/authorize')).resolves.toBe(false)
        expect(noRoute.calls).toHaveLength(0)

        vi.stubEnv('DISPLAY', ':99')
        vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/tmp/evil-bus-sentinel')
        const displayRoute = spawnFixture()
        const pending = createSafeBrowserOpener({ platform: 'linux', spawn: displayRoute.spawn })
          .open('https://auth.example.test/authorize')
        const call = displayRoute.calls[0]
        if (call === undefined) {
          throw new Error('browser spawn call missing')
        }
        expect(call.options).toEqual({
          shell: false,
          stdio: 'ignore',
          env: {
            PATH: '/usr/bin:/bin',
            HOME: canonicalHome(),
            XDG_CONFIG_HOME: join(canonicalHome(), '.config'),
            XDG_DATA_HOME: join(canonicalHome(), '.local', 'share'),
            XDG_CONFIG_DIRS: '/etc/xdg',
            XDG_DATA_DIRS: '/usr/local/share:/usr/share',
            DISPLAY: ':99',
          },
        })
        displayRoute.process.emit('close', 0, null)
        await expect(pending).resolves.toBe(true)
      } finally {
        rmSync(unsafe, { recursive: true, force: true })
      }
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

  it('lets a separate parent exit naturally after timeout while its child remains for cleanup', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') {
      return
    }

    const fixturePath = join(process.cwd(), 'tests/fixtures/browser-opener-parent.mjs')
    const loaderPath = join(process.cwd(), 'tests/fixtures/resolve-ts-js-loader.mjs')

    const killAndReap = async (pid: number): Promise<void> => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          return
        }
        throw error
      }
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            return
          }
          throw error
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25))
      }
      throw new Error(`child process ${pid} did not exit after cleanup`)
    }

    for (const noOpUnref of [false, true]) {
      const parent = nodeSpawn(process.execPath, [
        '--experimental-strip-types',
        '--loader',
        loaderPath,
        fixturePath,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, CODEX_NOOP_UNREF: noOpUnref ? '1' : '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let childPid: number | undefined
      let stdout = ''
      let stderr = ''
      parent.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        if (childPid === undefined) {
          const match = /^READY (\d+)$/mu.exec(stdout)
          if (match !== null) {
            childPid = Number(match[1])
          }
        }
      })
      parent.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      let timedOut = false
      const parentExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        parent.once('error', reject)
        parent.once('close', (code, signal) => resolve({ code, signal }))
      })
      const deadline = setTimeout(() => {
        timedOut = true
        try {
          parent.kill('SIGKILL')
        } catch {
          // The close handler below still settles the bounded wait.
        }
      }, noOpUnref ? 3_000 : 10_000)

      try {
        const result = await parentExit
        expect(childPid, `${stdout}\n${stderr}`).toBeDefined()
        expect(stdout).toContain('SETTLED false')
        if (noOpUnref) {
          expect(timedOut, `${stdout}\n${stderr}`).toBe(true)
          expect(result.signal).toBe('SIGKILL')
        } else {
          expect(timedOut, `${stdout}\n${stderr}`).toBe(false)
          expect(result.code, `${stdout}\n${stderr}`).toBe(0)
          expect(result.signal).toBeNull()
        }
      } finally {
        clearTimeout(deadline)
        if (childPid !== undefined) {
          await killAndReap(childPid)
        }
      }
    }
  }, 20_000)
})
