import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { createTerminalLoginInteraction } from '../src/cli/login-interaction.js'
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
})
