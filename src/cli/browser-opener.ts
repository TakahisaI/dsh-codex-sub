import { lstatSync } from 'node:fs'
import { spawn as nodeSpawn } from 'node:child_process'
import { posix as posixPath } from 'node:path'

import { CodexError } from '../core/errors.js'

const BROWSER_OPEN_TIMEOUT_MS = 5_000
const LATE_ERROR_DRAIN_MS = 5_000
const FIXED_BROWSER_PATH = '/usr/bin:/bin'
const MAX_RUNTIME_DIRECTORY_LENGTH = 4_096
const MAX_WAYLAND_DISPLAY_LENGTH = 128
const MAX_DISPLAY_LENGTH = 64
const DESKTOP_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u
const WAYLAND_DISPLAY_PATTERN = /^wayland-[0-9]+$/u
const DISPLAY_PATTERN = /^:[0-9]+(?:\.[0-9]+)?$/u
const UNIX_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/u

export interface BrowserLaunchProcess {
  on(event: string, listener: (...arguments_: readonly unknown[]) => void): this
  removeListener(event: string, listener: (...arguments_: readonly unknown[]) => void): this
  kill(signal?: NodeJS.Signals): boolean
  unref(): void
}

export interface BrowserSpawnOptions {
  readonly shell: false
  readonly stdio: 'ignore'
  readonly env: Readonly<Record<string, string>>
}

export type BrowserSpawn = (
  command: string,
  arguments_: readonly string[],
  options: BrowserSpawnOptions,
) => BrowserLaunchProcess

export interface BrowserOpener {
  open(url: string, signal?: AbortSignal): Promise<boolean>
}

function abortFailure(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function protocolFailure(): CodexError {
  return new CodexError(
    'The pi-ai OAuth interaction is incompatible.',
    'CODEX_UPSTREAM_PROTOCOL',
    { safeDetails: { reason: 'auth_destination' } },
  )
}

function validateDestination(url: string): void {
  if (url.length === 0 || url.length > 8_192 || [...url].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined
      && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
  })) {
    throw protocolFailure()
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (error) {
    throw new CodexError(
      'The pi-ai OAuth interaction is incompatible.',
      'CODEX_UPSTREAM_PROTOCOL',
      { cause: error, safeDetails: { reason: 'auth_destination' } },
    )
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw protocolFailure()
  }
}

function defaultSpawn(
  command: string,
  arguments_: readonly string[],
  options: BrowserSpawnOptions,
): BrowserLaunchProcess {
  return nodeSpawn(command, [...arguments_], {
    shell: options.shell,
    stdio: options.stdio,
    env: { ...options.env },
  }) as unknown as BrowserLaunchProcess
}

function commandForPlatform(platform: NodeJS.Platform): string | undefined {
  switch (platform) {
    case 'darwin':
      return '/usr/bin/open'
    case 'linux':
      return '/usr/bin/xdg-open'
    default:
      return undefined
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined
      && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
  })
}

function currentUserOwns(uid: number): boolean {
  return uid === process.getuid?.()
}

function safeUnixPath(value: string | undefined): string | undefined {
  if (
    value === undefined
    || value.length === 0
    || value.length > MAX_RUNTIME_DIRECTORY_LENGTH
    || !value.startsWith('/')
    || hasControlCharacters(value)
    || posixPath.normalize(value) !== value
  ) {
    return undefined
  }
  const segments = value.split('/')
  if (segments[0] !== '' || segments.slice(1).some((segment) => {
    return !UNIX_PATH_SEGMENT_PATTERN.test(segment)
  })) {
    return undefined
  }
  return value
}

function privateRuntimeDirectory(value: string | undefined): string | undefined {
  const safePath = safeUnixPath(value)
  if (safePath === undefined) {
    return undefined
  }
  try {
    const stats = lstatSync(safePath)
    if (
      !stats.isDirectory()
      || stats.isSymbolicLink()
      || !currentUserOwns(stats.uid)
      || (stats.mode & 0o077) !== 0
    ) {
      return undefined
    }
    return safePath
  } catch {
    return undefined
  }
}

function privateRuntimeSocket(runtime: string, name: string): string | undefined {
  const socketPath = safeUnixPath(posixPath.join(runtime, name))
  if (socketPath === undefined) {
    return undefined
  }
  try {
    const stats = lstatSync(socketPath)
    return stats.isSocket() && !stats.isSymbolicLink() && currentUserOwns(stats.uid)
      ? socketPath
      : undefined
  } catch {
    return undefined
  }
}

function browserEnvironment(platform: NodeJS.Platform): Readonly<Record<string, string>> | undefined {
  const environment: Record<string, string> = { PATH: FIXED_BROWSER_PATH }
  if (platform !== 'linux') {
    return Object.freeze(environment)
  }

  const runtime = privateRuntimeDirectory(process.env['XDG_RUNTIME_DIR'])
  const display = process.env['DISPLAY']
  const hasDisplayRoute = display !== undefined
    && display.length <= MAX_DISPLAY_LENGTH
    && !hasControlCharacters(display)
    && DISPLAY_PATTERN.test(display)

  let waylandDisplay: string | undefined
  const candidateWayland = process.env['WAYLAND_DISPLAY']
  const waylandSocket = runtime !== undefined
    && candidateWayland !== undefined
    && candidateWayland.length <= MAX_WAYLAND_DISPLAY_LENGTH
    && !hasControlCharacters(candidateWayland)
    && WAYLAND_DISPLAY_PATTERN.test(candidateWayland)
    ? privateRuntimeSocket(runtime, candidateWayland)
    : undefined
  if (waylandSocket !== undefined && candidateWayland !== undefined) {
    waylandDisplay = candidateWayland
  }

  const busSocket = runtime === undefined ? undefined : privateRuntimeSocket(runtime, 'bus')
  if (!hasDisplayRoute && waylandDisplay === undefined && busSocket === undefined) {
    return undefined
  }

  if (runtime !== undefined) {
    environment['XDG_RUNTIME_DIR'] = runtime
  }
  if (hasDisplayRoute) {
    environment['DISPLAY'] = display
  }
  if (waylandDisplay !== undefined) {
    environment['WAYLAND_DISPLAY'] = waylandDisplay
  }
  if (busSocket !== undefined) {
    // Never copy a caller-supplied bus address. A private runtime socket is
    // the only accepted local session route.
    environment['DBUS_SESSION_BUS_ADDRESS'] = `unix:path=${busSocket}`
  }

  for (const name of ['XDG_CURRENT_DESKTOP', 'XDG_SESSION_DESKTOP'] as const) {
    const value = process.env[name]
    if (value !== undefined && DESKTOP_NAME_PATTERN.test(value)) {
      environment[name] = value
    }
  }
  const sessionType = process.env['XDG_SESSION_TYPE']
  if (sessionType === 'x11' || sessionType === 'wayland') {
    environment['XDG_SESSION_TYPE'] = sessionType
  }

  return Object.freeze(environment)
}

function argumentsForPlatform(platform: NodeJS.Platform, url: string): readonly string[] {
  return platform === 'darwin' ? ['--', url] : [url]
}

function hasAbortSignal(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * Open one already validated authorization destination with a fixed native
 * command. The boolean result deliberately hides native process details so a
 * caller can print one safe manual fallback.
 */
export function createSafeBrowserOpener(options: {
  readonly platform?: NodeJS.Platform
  readonly spawn?: BrowserSpawn
  readonly timeoutMs?: number
} = {}): BrowserOpener {
  const platform = options.platform ?? process.platform
  const command = commandForPlatform(platform)
  const spawn = options.spawn ?? defaultSpawn
  const timeoutMs = options.timeoutMs ?? BROWSER_OPEN_TIMEOUT_MS

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Invalid browser opener timeout.')
  }

  return Object.freeze({
    async open(url: string, signal?: AbortSignal): Promise<boolean> {
      validateDestination(url)
      if (hasAbortSignal(signal)) {
        throw abortFailure()
      }
      if (command === undefined) {
        return false
      }
      const environment = browserEnvironment(platform)
      if (environment === undefined) {
        return false
      }

      return new Promise<boolean>((resolve, reject) => {
        let child: BrowserLaunchProcess | undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        let drainTimer: ReturnType<typeof setTimeout> | undefined
        let settled = false
        let drainInstalled = false
        let childUnrefed = false

        const unrefChild = (): void => {
          if (child !== undefined && !childUnrefed) {
            childUnrefed = true
            try {
              child.unref()
            } catch {
              // Process lifetime hints are best effort and never affect the
              // safe browser-open result.
            }
          }
        }

        const onError = (): void => {
          finish(false, false)
        }
        const onExit = (code: unknown, signalName: unknown): void => {
          finish(code === 0 && signalName == null, false)
        }
        const onClose = (code: unknown, signalName: unknown): void => {
          finish(code === 0 && signalName == null, true)
        }
        const onAbort = (): void => {
          if (!settled) {
            finishAbort()
            try {
              child?.kill('SIGTERM')
            } catch {
              // Native process details are intentionally not surfaced.
            }
          }
        }
        const cleanup = (): void => {
          if (timer !== undefined) {
            clearTimeout(timer)
            timer = undefined
          }
          child?.removeListener('error', onError)
          child?.removeListener('exit', onExit)
          child?.removeListener('close', onClose)
          signal?.removeEventListener('abort', onAbort)
        }
        const cleanupDrain = (): void => {
          if (!drainInstalled) {
            return
          }
          drainInstalled = false
          if (drainTimer !== undefined) {
            clearTimeout(drainTimer)
            drainTimer = undefined
          }
          child?.removeListener('error', drainError)
          child?.removeListener('exit', drainExit)
          child?.removeListener('close', drainClose)
        }
        const installDrain = (): void => {
          if (child === undefined || drainInstalled) {
            return
          }
          drainInstalled = true
          child.on('error', drainError)
          child.on('exit', drainExit)
          child.on('close', drainClose)
          drainTimer = setTimeout(cleanupDrain, LATE_ERROR_DRAIN_MS)
          drainTimer.unref?.()
        }
        const finish = (opened: boolean, closed: boolean): void => {
          if (settled) {
            return
          }
          settled = true
          cleanup()
          if (closed) {
            cleanupDrain()
          } else {
            // Keep one native error sink alive until the child closes (or the
            // bounded drain grace period expires). This prevents a late ENOENT
            // after abort/timeout from becoming an uncaught EventEmitter error.
            installDrain()
          }
          resolve(opened)
        }
        const finishAbort = (): void => {
          if (settled) {
            return
          }
          settled = true
          cleanup()
          installDrain()
          reject(abortFailure())
        }
        const drainError = (): void => undefined
        const drainExit = (): void => undefined
        const drainClose = (): void => {
          cleanupDrain()
        }

        if (signal !== undefined) {
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) {
            onAbort()
            return
          }
        }

        try {
          child = spawn(command, argumentsForPlatform(platform, url), {
            shell: false,
            stdio: 'ignore',
            env: environment,
          })
          // Detach the native child from the parent event-loop immediately,
          // before an abort/exit race can install any post-spawn handlers.
          unrefChild()
          if (settled) {
            installDrain()
            try {
              child.kill('SIGTERM')
            } catch {
              // Native process details are intentionally not surfaced.
            }
            return
          }
          child.on('error', onError)
          if (settled) {
            installDrain()
            try {
              child.kill('SIGTERM')
            } catch {
              // Native process details are intentionally not surfaced.
            }
            return
          }
          child.on('exit', onExit)
          if (settled) {
            installDrain()
            try {
              child.kill('SIGTERM')
            } catch {
              // Native process details are intentionally not surfaced.
            }
            return
          }
          child.on('close', onClose)
          if (settled) {
            installDrain()
            try {
              child.kill('SIGTERM')
            } catch {
              // Native process details are intentionally not surfaced.
            }
            return
          }
          timer = setTimeout(() => {
            finish(false, false)
            try {
              child?.kill('SIGTERM')
            } catch {
              // Native process details are intentionally not surfaced.
            }
          }, timeoutMs)
        } catch {
          finish(false, false)
        }
      })
    },
  })
}
