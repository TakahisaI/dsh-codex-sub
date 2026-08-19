import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

async function readJson(filename) {
  return JSON.parse(await readFile(join(repositoryRoot, filename), 'utf8'))
}

const packageJson = await readJson('package.json')
const compatibility = await readJson('compatibility.json')
const mismatches = []

function expectEqual(label, actual, expected) {
  if (actual !== expected) {
    mismatches.push(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
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

if (mismatches.length > 0) {
  throw new Error(`Compatibility metadata mismatch:\n${mismatches.join('\n')}`)
}

process.stdout.write('Compatibility metadata is consistent.\n')
