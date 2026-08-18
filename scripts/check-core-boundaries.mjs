import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const coreRoot = join(repositoryRoot, 'src', 'core')
const staticImportPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gu
const dynamicImportPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu
const requirePattern = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu

function importSpecifiers(source) {
  const specifiers = new Set()
  for (const pattern of [staticImportPattern, dynamicImportPattern, requirePattern]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) {
        specifiers.add(match[1])
      }
    }
  }
  return specifiers
}

function isForbiddenCoreImport(specifier) {
  return specifier === 'fs'
    || specifier.startsWith('fs/')
    || specifier === 'node:fs'
    || specifier.startsWith('node:fs/')
    || specifier.startsWith('@deepseek-ai/')
    || specifier === '@earendil-works/pi-ai'
    || specifier.startsWith('@earendil-works/pi-ai/')
    || specifier === 'react'
    || specifier.startsWith('react/')
}

const policyExamples = [
  ["import { readFile } from 'fs/promises'", 'fs/promises'],
  ["import 'node:fs'", 'node:fs'],
  ["import '@deepseek-ai/dsh-llm'", '@deepseek-ai/dsh-llm'],
  ["const provider = await import('@earendil-works/pi-ai')", '@earendil-works/pi-ai'],
  ["import fs = require('node:fs/promises')", 'node:fs/promises'],
  ["export * from 'react/jsx-runtime'", 'react/jsx-runtime'],
]

for (const [source, expected] of policyExamples) {
  const found = importSpecifiers(source)
  if (!found.has(expected) || !isForbiddenCoreImport(expected)) {
    throw new Error(`Core boundary checker self-test failed for ${expected}`)
  }
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(path))
    } else if (entry.isFile() && extname(entry.name) === '.ts') {
      files.push(path)
    }
  }

  return files
}

const violations = []
for (const path of await sourceFiles(coreRoot)) {
  const source = await readFile(path, 'utf8')
  for (const specifier of importSpecifiers(source)) {
    if (isForbiddenCoreImport(specifier)) {
      violations.push(`${relative(repositoryRoot, path)} (forbidden import: ${specifier})`)
    }
  }
  if (/\bexport\s+default\b/u.test(source)) {
    violations.push(`${relative(repositoryRoot, path)} (default export)`)
  }
}

if (violations.length > 0) {
  throw new Error(`Core boundary violation: ${violations.join(', ')}`)
}

process.stdout.write('Core import boundaries are valid.\n')
