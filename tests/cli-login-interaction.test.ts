import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { createTerminalLoginInteraction } from '../src/cli/login-interaction.js'
import { NodePromptReader } from '../src/cli/node-prompt-reader.js'
import type {
  CliIo,
  PromptReadOptions,
  PromptReader,
} from '../src/cli/types.js'

class QueuePromptReader implements PromptReader {
  readonly calls: Array<{ readonly prompt: string; readonly options: PromptReadOptions }> = []
  closeCalls = 0

  constructor(private readonly responses: string[]) {}

  async read(prompt: string, options: PromptReadOptions): Promise<string> {
    this.calls.push({ prompt, options })
    const response = this.responses.shift()
    if (response === undefined) {
      throw new Error('The test prompt queue is empty.')
    }
    return response
  }

  close(): void {
    this.closeCalls += 1
  }
}

function captureIo(): { readonly io: CliIo; stdout: () => string; stderr: () => string } {
  let stdout = ''
  let stderr = ''
  return {
    io: {
      stdout(text) {
        stdout += text
      },
      stderr(text) {
        stderr += text
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

describe('terminal pi-ai login interaction', () => {
  it('accepts Enter for exactly one explicitly marked default', async () => {
    const reader = new QueuePromptReader([''])
    const interaction = createTerminalLoginInteraction({ io: captureIo().io, reader })

    await expect(interaction.prompt({
      type: 'select',
      message: 'Select login method',
      options: [
        { id: 'browser', label: 'Browser login (default)' },
        { id: 'device', label: 'Device code login' },
      ],
    })).resolves.toBe('browser')
    expect(reader.calls[0]?.prompt).toBe('Selection [n]: ')
  })

  it('does not guess when a select prompt has no default', async () => {
    const reader = new QueuePromptReader(['', 'device'])
    const capture = captureIo()
    const interaction = createTerminalLoginInteraction({ io: capture.io, reader })

    await expect(interaction.prompt({
      type: 'select',
      message: 'Select login method',
      options: [
        { id: 'browser', label: 'Browser login' },
        { id: 'device', label: 'Device code login' },
      ],
    })).resolves.toBe('device')
    expect(capture.stdout()).toContain('Enter one of the listed numbers.\n')
  })

  it.each([
    'Browser login (Default)',
    'Browser login (default) extra',
  ])('requires the exact case-sensitive default suffix: %s', async (label) => {
    const reader = new QueuePromptReader(['', 'device'])
    const interaction = createTerminalLoginInteraction({ io: captureIo().io, reader })

    await expect(interaction.prompt({
      type: 'select',
      message: 'Select login method',
      options: [
        { id: 'browser', label },
        { id: 'device', label: 'Device code login' },
      ],
    })).resolves.toBe('device')
  })

  it('rejects multiple defaults before reading a selection', async () => {
    const reader = new QueuePromptReader([''])
    const capture = captureIo()
    const interaction = createTerminalLoginInteraction({ io: capture.io, reader })

    await expect(interaction.prompt({
      type: 'select',
      message: 'Select login method',
      options: [
        { id: 'browser', label: 'Browser login (default)' },
        { id: 'device', label: 'Device code login (default)' },
      ],
    })).rejects.toMatchObject({
      code: 'CODEX_UPSTREAM_PROTOCOL',
      safeDetails: { reason: 'select_default' },
    })
    expect(reader.calls).toHaveLength(0)
    expect(capture.stdout()).toBe('')
  })

  it('accepts exact ids and unique rendered labels without fuzzy matching', async () => {
    const reader = new QueuePromptReader(['device', 'Browser login'])
    const interaction = createTerminalLoginInteraction({ io: captureIo().io, reader })
    const prompt = {
      type: 'select' as const,
      message: 'Select login method',
      options: [
        { id: 'browser', label: 'Browser login' },
        { id: 'device', label: 'Device code login' },
      ],
    }

    await expect(interaction.prompt(prompt)).resolves.toBe('device')
    await expect(interaction.prompt(prompt)).resolves.toBe('browser')
  })

  it('rejects a cross-category exact id/label collision and retries', async () => {
    const reader = new QueuePromptReader(['shared', 'browser'])
    const capture = captureIo()
    const interaction = createTerminalLoginInteraction({ io: capture.io, reader })

    await expect(interaction.prompt({
      type: 'select',
      message: 'Select login method',
      options: [
        { id: 'shared', label: 'Browser login' },
        { id: 'browser', label: 'shared' },
      ],
    })).resolves.toBe('browser')
    expect(capture.stdout()).toContain('Enter one of the listed numbers.\n')
  })

  it('renders every published notification form after validating destinations', () => {
    const capture = captureIo()
    const interaction = createTerminalLoginInteraction({
      io: capture.io,
      reader: new QueuePromptReader([]),
    })

    interaction.notify({
      type: 'info',
      message: 'Use the official sign-in page.',
      links: [{ label: 'Help', url: 'https://example.test/help' }],
    })
    interaction.notify({
      type: 'auth_url',
      url: 'https://auth.example.test/authorize?client_id=public',
      instructions: 'Continue in a browser.',
    })
    interaction.notify({
      type: 'device_code',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.example.test/device',
    })
    interaction.notify({ type: 'progress', message: 'Waiting for authorization.' })

    expect(capture.stdout()).toBe(
      'Use the official sign-in page.\n'
      + 'Help: https://example.test/help\n'
      + 'Continue in a browser.\n'
      + 'Open this URL to continue:\n'
      + 'https://auth.example.test/authorize?client_id=public\n'
      + 'Open this URL to continue:\n'
      + 'https://auth.example.test/device\n'
      + 'Device code: ABCD-EFGH\n'
      + 'Waiting for authorization.\n',
    )
    expect(capture.stderr()).toBe('')
  })

  it.each([
    'http://auth.example.test/authorize',
    'ftp://auth.example.test/authorize',
    'https://user:password@auth.example.test/authorize',
    'not a URL',
    'https://auth.example.test/authorize\nmalicious',
  ])('rejects an unsafe authorization destination before output: %s', (url) => {
    const capture = captureIo()
    const interaction = createTerminalLoginInteraction({
      io: capture.io,
      reader: new QueuePromptReader([]),
    })

    expect(() => interaction.notify({ type: 'auth_url', url })).toThrowError(
      expect.objectContaining({ code: 'CODEX_UPSTREAM_PROTOCOL' }),
    )
    expect(capture.stdout()).toBe('')
    expect(capture.stderr()).toBe('')
  })

  it('handles text, secret, manual-code, and select prompts without echoing answers', async () => {
    const text = 'workspace'
    const secret = `ACCESS_SENTINEL_${randomUUID()}`
    const manualCode = `CODE_SENTINEL_${randomUUID()}`
    const reader = new QueuePromptReader([text, secret, manualCode, '0', '2'])
    const capture = captureIo()
    const interaction = createTerminalLoginInteraction({ io: capture.io, reader })

    await expect(interaction.prompt({ type: 'text', message: 'Workspace' })).resolves.toBe(text)
    await expect(interaction.prompt({ type: 'secret', message: 'Secret' })).resolves.toBe(secret)
    await expect(interaction.prompt({
      type: 'manual_code',
      message: 'Authorization code',
    })).resolves.toBe(manualCode)
    await expect(interaction.prompt({
      type: 'select',
      message: 'Choose an account',
      options: [
        { id: 'personal', label: 'Personal' },
        { id: 'work', label: 'Work', description: 'Organization account' },
      ],
    })).resolves.toBe('work')

    expect(reader.calls.map(({ options }) => options.hidden)).toEqual([
      false,
      true,
      true,
      false,
      false,
    ])
    expect(capture.stdout()).toContain('Choose an account\n')
    expect(capture.stdout()).toContain('Enter one of the listed numbers.\n')
    expect(capture.stdout()).not.toContain(secret)
    expect(capture.stdout()).not.toContain(manualCode)
    expect(capture.stderr()).toBe('')
  })

  it('redacts secret-shaped data in upstream messages and combines cancellation signals', async () => {
    const sentinel = `ACCESS_SENTINEL_${randomUUID()}`
    const reader = new QueuePromptReader(['answer'])
    const capture = captureIo()
    const interactionController = new AbortController()
    const promptController = new AbortController()
    const interaction = createTerminalLoginInteraction({
      io: capture.io,
      reader,
      signal: interactionController.signal,
    })

    interaction.notify({
      type: 'progress',
      message: `accessToken=${sentinel}\nStill working`,
    })
    await interaction.prompt({
      type: 'text',
      message: 'Continue',
      signal: promptController.signal,
    })
    interactionController.abort()

    expect(capture.stdout()).toContain('accessToken=[REDACTED] Still working\n')
    expect(capture.stdout()).not.toContain(sentinel)
    expect(reader.calls[0]?.options.signal?.aborted).toBe(true)
  })

  it('opens one validated authorization URL after an empty manual-code response', async () => {
    const reader = new QueuePromptReader(['', ''])
    const opened: string[] = []
    const capture = captureIo()
    const interaction = createTerminalLoginInteraction({
      io: capture.io,
      reader,
      browserOpener: {
        async open(url) {
          opened.push(url)
          return true
        },
      },
    })

    interaction.notify({
      type: 'auth_url',
      url: 'https://auth.example.test/authorize?client_id=public',
    })
    await expect(interaction.prompt({
      type: 'manual_code',
      message: 'Complete login',
    })).resolves.toBe('')

    expect(opened).toEqual(['https://auth.example.test/authorize?client_id=public'])
    expect(reader.calls[0]?.prompt).toContain('Press Enter to open in your default browser')
  })

  it('retains the canonical pending auth URL across non-consuming notifications', async () => {
    const reader = new QueuePromptReader(['', 'CODE_SENTINEL'])
    const opened: string[] = []
    const interaction = createTerminalLoginInteraction({
      io: captureIo().io,
      reader,
      browserOpener: {
        async open(url) {
          opened.push(url)
          return true
        },
      },
    })
    interaction.notify({
      type: 'auth_url',
      url: 'HTTPS://Auth.Example.test:443/authorize?client_id=public',
    })
    interaction.notify({ type: 'progress', message: 'Waiting.' })
    interaction.notify({ type: 'info', message: 'Continue in the browser.' })
    interaction.notify({
      type: 'device_code',
      userCode: 'DEVICE-CODE',
      verificationUri: 'https://auth.example.test/device',
    })

    await expect(interaction.prompt({
      type: 'manual_code',
      message: 'Authorization code',
    })).resolves.toBe('CODE_SENTINEL')
    expect(opened).toEqual(['https://auth.example.test/authorize?client_id=public'])
  })

  it('rejects a second auth URL without invoking the opener', async () => {
    const opener = { open: vi.fn(async () => true) }
    const interaction = createTerminalLoginInteraction({
      io: captureIo().io,
      reader: new QueuePromptReader(['CODE_SENTINEL']),
      browserOpener: opener,
    })
    interaction.notify({ type: 'auth_url', url: 'https://auth.example.test/one' })

    expect(() => interaction.notify({
      type: 'auth_url',
      url: 'https://auth.example.test/two',
    })).toThrowError(expect.objectContaining({
      code: 'CODEX_UPSTREAM_PROTOCOL',
      safeDetails: { reason: 'auth_sequence' },
    }))
    expect(opener.open).not.toHaveBeenCalled()
  })

  it('passes through a non-empty manual code without opening the browser', async () => {
    const reader = new QueuePromptReader(['CODE_SENTINEL'])
    const opener = { open: vi.fn(async () => true) }
    const interaction = createTerminalLoginInteraction({
      io: captureIo().io,
      reader,
      browserOpener: opener,
    })

    interaction.notify({ type: 'auth_url', url: 'https://auth.example.test/authorize' })
    await expect(interaction.prompt({
      type: 'manual_code',
      message: 'Authorization code',
    })).resolves.toBe('CODE_SENTINEL')
    expect(opener.open).not.toHaveBeenCalled()
  })

  it('keeps a safe manual fallback when browser launch fails', async () => {
    const reader = new QueuePromptReader(['', 'CODE_SENTINEL'])
    const capture = captureIo()
    const interaction = createTerminalLoginInteraction({
      io: capture.io,
      reader,
      browserOpener: {
        async open() {
          throw new Error('native detail sentinel')
        },
      },
    })

    interaction.notify({ type: 'auth_url', url: 'https://auth.example.test/authorize' })
    await expect(interaction.prompt({
      type: 'manual_code',
      message: 'Authorization code',
    })).resolves.toBe('CODE_SENTINEL')
    expect(capture.stdout()).toContain('Could not open the browser automatically. Open the URL manually.\n')
    expect(capture.stdout()).not.toContain('native detail sentinel')
  })

  it('does not start a second prompt when callback cancellation wins browser launch', async () => {
    const reader = new QueuePromptReader([''])
    const controller = new AbortController()
    let rejectOpen: ((error: unknown) => void) | undefined
    const opener = {
      open: vi.fn((_url: string, signal?: AbortSignal) => new Promise<boolean>((_resolve, reject) => {
        rejectOpen = reject
        signal?.addEventListener('abort', () => {
          reject(new DOMException('browser callback won', 'AbortError'))
        }, { once: true })
      })),
    }
    const interaction = createTerminalLoginInteraction({
      io: captureIo().io,
      reader,
      signal: controller.signal,
      browserOpener: opener,
    })
    interaction.notify({ type: 'auth_url', url: 'https://auth.example.test/authorize' })

    const pending = interaction.prompt({ type: 'manual_code', message: 'Authorization code' })
    await vi.waitFor(() => expect(opener.open).toHaveBeenCalledOnce())
    controller.abort()
    rejectOpen?.(new DOMException('late callback', 'AbortError'))

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(reader.calls).toHaveLength(1)
    expect(opener.open).toHaveBeenCalledOnce()
  })

  it('does not start a second prompt when callback cancellation wins immediately after launch', async () => {
    const reader = new QueuePromptReader([''])
    const controller = new AbortController()
    const opener = {
      open: vi.fn(async () => {
        controller.abort()
        return true
      }),
    }
    const interaction = createTerminalLoginInteraction({
      io: captureIo().io,
      reader,
      signal: controller.signal,
      browserOpener: opener,
    })
    interaction.notify({ type: 'auth_url', url: 'https://auth.example.test/authorize' })

    await expect(interaction.prompt({
      type: 'manual_code',
      message: 'Authorization code',
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(reader.calls).toHaveLength(1)
    expect(opener.open).toHaveBeenCalledOnce()
  })

  it('does not open invalid destinations or device-code URLs', async () => {
    const reader = new QueuePromptReader(['CODE_SENTINEL'])
    const opener = { open: vi.fn(async () => true) }
    const capture = captureIo()
    const interaction = createTerminalLoginInteraction({
      io: capture.io,
      reader,
      browserOpener: opener,
    })

    expect(() => interaction.notify({ type: 'auth_url', url: 'http://unsafe.example.test' })).toThrowError(
      expect.objectContaining({ code: 'CODEX_UPSTREAM_PROTOCOL' }),
    )
    interaction.notify({
      type: 'device_code',
      userCode: 'DEVICE_CODE',
      verificationUri: 'https://auth.example.test/device',
    })
    await expect(interaction.prompt({ type: 'manual_code', message: 'Code' })).resolves.toBe('CODE_SENTINEL')
    expect(opener.open).not.toHaveBeenCalled()
  })

  it.each(['eof', 'ctrl-d', 'non-tty'] as const)('does not open on %s and settles input safely', async (mode) => {
    const input = new PassThrough()
    const output = new PassThrough()
    const reader = new NodePromptReader(input, output, {
      requireInteractive: mode === 'non-tty',
    })
    const opener = { open: vi.fn(async () => true) }
    const interaction = createTerminalLoginInteraction({
      io: { stdout: () => undefined, stderr: () => undefined },
      reader,
      browserOpener: opener,
    })
    interaction.notify({ type: 'auth_url', url: 'https://auth.example.test/authorize' })
    const pending = interaction.prompt({ type: 'manual_code', message: 'Authorization code' })
    if (mode === 'eof') {
      input.end()
    } else if (mode === 'ctrl-d') {
      input.write('\u0004')
    }

    await expect(pending).rejects.toMatchObject({ code: 'CODEX_AUTH_LOGIN_FAILED' })
    expect(opener.open).not.toHaveBeenCalled()
    expect(input.listenerCount('data')).toBe(0)
    expect(input.listenerCount('end')).toBe(0)
    expect(input.listenerCount('error')).toBe(0)
    reader.close()
    reader.close()
  })

  it('fails closed for a prompt sequence that is not manual_code after auth_url', async () => {
    const interaction = createTerminalLoginInteraction({
      io: captureIo().io,
      reader: new QueuePromptReader(['browser']),
    })
    interaction.notify({ type: 'auth_url', url: 'https://auth.example.test/authorize' })

    await expect(interaction.prompt({
      type: 'select',
      message: 'Unexpected next prompt',
      options: [{ id: 'browser', label: 'Browser' }],
    })).rejects.toMatchObject({
      code: 'CODEX_UPSTREAM_PROTOCOL',
      safeDetails: { reason: 'auth_sequence' },
    })
  })
})
