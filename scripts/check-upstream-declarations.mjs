import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const typescriptCli = require.resolve('typescript/bin/tsc')

const expectedDiagnostics = [
  {
    count: 7,
    name: 'Anthropic SDK undici-types path',
    pattern: /@anthropic-ai\/sdk\/internal\/types\.d\.mts\(.+\): error TS2307: Cannot find module '.+\/undici-types\/index\.d\.ts'/u,
  },
  {
    count: 1,
    name: 'Google GenAI optional MCP client type',
    pattern: /@google\/genai\/dist\/node\/node\.d\.ts\(.+\): error TS2307: Cannot find module '@modelcontextprotocol\/sdk\/client\/index\.js'/u,
  },
  {
    count: 2,
    name: 'Google GenAI ErrorEvent browser global',
    pattern: /@google\/genai\/dist\/node\/node\.d\.ts\(.+\): error TS2552: Cannot find name 'ErrorEvent'/u,
  },
  {
    count: 2,
    name: 'Google GenAI CloseEvent browser global',
    pattern: /@google\/genai\/dist\/node\/node\.d\.ts\(.+\): error TS2304: Cannot find name 'CloseEvent'/u,
  },
]

const result = spawnSync(
  process.execPath,
  [typescriptCli, '--noEmit', '--skipLibCheck', 'false', '--pretty', 'false'],
  {
    cwd: repositoryRoot,
    encoding: 'utf8',
  },
)

if (result.error !== undefined) {
  throw result.error
}

const output = `${result.stdout}${result.stderr}`.trim()
if (result.status === 0) {
  throw new Error(
    'Dependency declarations now type-check without the workaround; remove skipLibCheck and update ADR 0007.',
  )
}

const counts = new Map(expectedDiagnostics.map((diagnostic) => [diagnostic.name, 0]))
const unexpected = []
for (const line of output.split(/\r?\n/u).filter((value) => value.length > 0)) {
  const diagnostic = expectedDiagnostics.find((candidate) => candidate.pattern.test(line))
  if (diagnostic === undefined) {
    unexpected.push(line)
  } else {
    counts.set(diagnostic.name, (counts.get(diagnostic.name) ?? 0) + 1)
  }
}

const countMismatches = expectedDiagnostics.filter(
  (diagnostic) => counts.get(diagnostic.name) !== diagnostic.count,
)
if (unexpected.length > 0 || countMismatches.length > 0) {
  const mismatchSummary = countMismatches.map(
    (diagnostic) => `${diagnostic.name}: expected ${diagnostic.count}, received ${counts.get(diagnostic.name) ?? 0}`,
  )
  throw new Error([
    'Dependency declaration diagnostics changed; review the pinned upstream contract.',
    ...mismatchSummary,
    ...unexpected,
  ].join('\n'))
}

process.stdout.write('Only the pinned, documented dependency declaration diagnostics remain.\n')
