import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const coreRoot = join(repositoryRoot, 'src', 'core')
const sourceExtensions = new Set(['.ts', '.mts', '.cts'])

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

function stringLiteralValue(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined
}

function sourceFacts(source, filename) {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.getScriptKindFromFileName(filename),
  )
  const specifiers = new Set()
  let hasDefaultExport = false

  function addSpecifier(node) {
    const specifier = stringLiteralValue(node)
    if (specifier !== undefined) {
      specifiers.add(specifier)
    }
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addSpecifier(node.moduleSpecifier)
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
    ) {
      addSpecifier(node.moduleReference.expression)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addSpecifier(node.argument.literal)
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if (isDynamicImport || isRequire) {
        addSpecifier(node.arguments[0])
      }
    }

    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      hasDefaultExport = true
    }
    if (
      ts.canHaveModifiers(node)
      && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      hasDefaultExport = true
    }
    if (
      ts.isExportDeclaration(node)
      && node.exportClause
      && ts.isNamedExports(node.exportClause)
      && node.exportClause.elements.some((element) => element.name.text === 'default')
    ) {
      hasDefaultExport = true
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return { hasDefaultExport, specifiers }
}

const policyExamples = [
  ["import /* filesystem */ 'node:fs'", 'fixture.ts', 'node:fs'],
  ["import { readFile } from /* filesystem */ 'node:fs'", 'fixture.mts', 'node:fs'],
  ["await import('node:fs', {})", 'fixture.cts', 'node:fs'],
  ["import fs = require('node:fs/promises')", 'fixture.ts', 'node:fs/promises'],
  ["type Fs = import('fs/promises').FileHandle", 'fixture.ts', 'fs/promises'],
  ["import '@deepseek-ai/dsh-llm'", 'fixture.ts', '@deepseek-ai/dsh-llm'],
  ["export * from 'react/jsx-runtime'", 'fixture.ts', 'react/jsx-runtime'],
]

for (const [source, filename, expected] of policyExamples) {
  const facts = sourceFacts(source, filename)
  if (!facts.specifiers.has(expected) || !isForbiddenCoreImport(expected)) {
    throw new Error(`Core boundary checker self-test failed for ${expected}`)
  }
}

for (const source of ['export default {}', 'export default class Example {}', 'export { value as default }']) {
  if (!sourceFacts(source, 'fixture.ts').hasDefaultExport) {
    throw new Error('Core boundary checker self-test failed for a default export')
  }
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(path))
    } else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      files.push(path)
    }
  }

  return files
}

const violations = []
for (const path of await sourceFiles(coreRoot)) {
  const source = await readFile(path, 'utf8')
  const facts = sourceFacts(source, path)
  for (const specifier of facts.specifiers) {
    if (isForbiddenCoreImport(specifier)) {
      violations.push(`${relative(repositoryRoot, path)} (forbidden import: ${specifier})`)
    }
  }
  if (facts.hasDefaultExport) {
    violations.push(`${relative(repositoryRoot, path)} (default export)`)
  }
}

if (violations.length > 0) {
  throw new Error(`Core boundary violation: ${violations.join(', ')}`)
}

process.stdout.write('Core import boundaries are valid.\n')
