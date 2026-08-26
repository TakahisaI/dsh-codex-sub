import { spawn as nodeSpawn } from 'node:child_process'

import { CodexError } from '../core/errors.js'

const BROWSER_OPEN_TIMEOUT_MS = 5_000
const LATE_ERROR_DRAIN_MS = 5_000

export interface BrowserLaunchProcess {
  on(event: string, listener: (...arguments_: readonly unknown[]) => void): this
  removeListener(event: string, listener: (...arguments_: readonly unknown[]) => void): this
  kill(signal?: NodeJS.Signals): boolean
}

export interface BrowserSpawnOptions {
  readonly shell: false
  readonly stdio: 'ignore'
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
  return nodeSpawn(command, [...arguments_], options) as unknown as BrowserLaunchProcess
}

function commandForPlatform(platform: NodeJS.Platform): string | undefined {
  switch (platform) {
    case 'darwin':
      return '/usr/bin/open'
    case 'linux':
      return 'xdg-open'
    default:
      return undefined
  }
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

      return new Promise<boolean>((resolve, reject) => {
        let child: BrowserLaunchProcess | undefined
        let timer: ReturnType<typeof setTimeout> | undefined
        let drainTimer: ReturnType<typeof setTimeout> | undefined
        let settled = false
        let drainInstalled = false

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
          child = spawn(command, argumentsForPlatform(platform, url), { shell: false, stdio: 'ignore' })
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
