import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const coreRoot = join(repositoryRoot, 'src', 'core')
const forbiddenSpecifier = /(?:from\s+|import\s*\()\s*['"](?:node:|@deepseek-ai\/|@earendil-works\/pi-ai|react(?:\/|['"]))/u

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
  if (forbiddenSpecifier.test(source)) {
    violations.push(relative(repositoryRoot, path))
  }
  if (/\bexport\s+default\b/u.test(source)) {
    violations.push(`${relative(repositoryRoot, path)} (default export)`)
  }
}

if (violations.length > 0) {
  throw new Error(`Core boundary violation: ${violations.join(', ')}`)
}

process.stdout.write('Core import boundaries are valid.\n')
