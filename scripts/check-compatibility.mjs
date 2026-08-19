import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

async function readJson(filename) {
  return JSON.parse(await readFile(join(repositoryRoot, filename), 'utf8'))
}

async function readText(filename) {
  return readFile(join(repositoryRoot, filename), 'utf8')
}

const packageJson = await readJson('package.json')
const compatibility = await readJson('compatibility.json')
const mismatches = []

function expectEqual(label, actual, expected) {
  if (actual !== expected) {
    mismatches.push(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}

function expectIncludes(label, text, expected) {
  if (!text.includes(expected)) {
    mismatches.push(`${label}: expected documentation to contain ${JSON.stringify(expected)}`)
  }
}

expectEqual('engines.node', packageJson.engines?.node, compatibility.node)
expectEqual('os', JSON.stringify(packageJson.os), JSON.stringify(compatibility.platforms))
expectEqual('packageManager', packageJson.packageManager, compatibility.packageManager)
expectEqual(
  'devDependencies.@deepseek-ai/dsh',
  packageJson.devDependencies?.['@deepseek-ai/dsh'],
  compatibility.dsh.release,
)
expectEqual(
  `dependencies.${compatibility.piAi.package}`,
  packageJson.dependencies?.[compatibility.piAi.package],
  compatibility.piAi.version,
)

for (const [name, version] of Object.entries(compatibility.dsh.packages)) {
  expectEqual(`peerDependencies.${name}`, packageJson.peerDependencies?.[name], version)
  expectEqual(`devDependencies.${name}`, packageJson.devDependencies?.[name], version)
}

for (const filename of [
  'README.md',
  'README.ja.md',
  'docs/known-limitations.md',
  'docs/known-limitations.ja.md',
]) {
  const contents = await readText(filename)
  expectIncludes(`${filename}: DSH release`, contents, compatibility.dsh.release)
  expectIncludes(`${filename}: Cordis`, contents, compatibility.dsh.packages['@deepseek-ai/cordis'])
  expectIncludes(`${filename}: pi-ai`, contents, compatibility.piAi.version)
  expectIncludes(`${filename}: Node`, contents, compatibility.node)
  for (const platform of compatibility.platforms) {
    const publicName = platform === 'darwin' ? 'macOS' : 'Linux'
    expectIncludes(`${filename}: ${publicName}`, contents, publicName)
  }
}

if (mismatches.length > 0) {
  throw new Error(`Compatibility metadata mismatch:\n${mismatches.join('\n')}`)
}

process.stdout.write('Compatibility metadata is consistent.\n')
