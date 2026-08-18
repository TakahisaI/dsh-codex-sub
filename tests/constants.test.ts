import { describe, expect, it } from 'vitest'

import {
  AUTH_DIRECTORY_NAME,
  AUTH_FILENAME,
  PACKAGE_NAME,
  PLUGIN_NAME,
  PLUGIN_ROW_ID,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_ID,
} from '../src/core/constants.js'

describe('stable constants', () => {
  it('matches the project identities', () => {
    expect({
      AUTH_DIRECTORY_NAME,
      AUTH_FILENAME,
      PACKAGE_NAME,
      PLUGIN_NAME,
      PLUGIN_ROW_ID,
      PROVIDER_DISPLAY_NAME,
      PROVIDER_ID,
    }).toEqual({
      AUTH_DIRECTORY_NAME: 'dsh-codex-sub',
      AUTH_FILENAME: 'auth.json',
      PACKAGE_NAME: 'dsh-codex-sub',
      PLUGIN_NAME: 'llm-codex-sub',
      PLUGIN_ROW_ID: 'llm-codex-sub',
      PROVIDER_DISPLAY_NAME: 'OpenAI Codex (ChatGPT)',
      PROVIDER_ID: 'openai-codex',
    })
  })
})
