import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'

async function dependabotConfig() {
  const document = parseDocument(
    await readFile(new URL('../.github/dependabot.yml', import.meta.url), 'utf8'),
    { prettyErrors: false, uniqueKeys: true },
  )
  expect(document.errors).toEqual([])
  return document.toJS({ mapAsMap: false })
}

describe('Dependabot configuration', () => {
  it('groups only safe Vitest and YAML minor/patch updates', async () => {
    const config = await dependabotConfig()
    const npm = config.updates.find(update => update['package-ecosystem'] === 'npm')

    expect(npm.groups).toEqual({
      'safe-development-tooling': {
        'dependency-type': 'development',
        patterns: ['vitest', 'yaml'],
        'update-types': ['minor', 'patch'],
      },
    })
  })

  it('keeps release-family and major runtime upgrades on manual review', async () => {
    const config = await dependabotConfig()
    const npm = config.updates.find(update => update['package-ecosystem'] === 'npm')

    expect(npm.ignore).toEqual([
      { 'dependency-name': '@deepseek-ai/dsh*' },
      {
        'dependency-name': 'typescript',
        'update-types': ['version-update:semver-major'],
      },
      {
        'dependency-name': '@types/node',
        'update-types': ['version-update:semver-major'],
      },
    ])
  })

  it('retains a separate GitHub Actions update configuration', async () => {
    const config = await dependabotConfig()

    expect(config.updates).toHaveLength(2)
    expect(config.updates[1]).toEqual({
      'package-ecosystem': 'github-actions',
      directory: '/',
      schedule: { interval: 'weekly' },
    })
  })
})
