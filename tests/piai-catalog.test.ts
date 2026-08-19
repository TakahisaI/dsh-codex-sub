import { describe, expect, it } from 'vitest'

import { codexCatalogModelCount } from '../src/piai/catalog.js'

describe('pi-ai Codex catalog projection', () => {
  it('counts the pinned provider catalog offline without hard-coded model IDs', () => {
    expect(codexCatalogModelCount()).toBeGreaterThan(0)
  })
})
