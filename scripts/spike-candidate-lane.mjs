import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const candidateVersion = '0.1.1-rc.1'

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: '1',
      DSH_TELEMETRY_MODE: 'DISABLED',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `${options.label ?? command} failed with exit code ${String(result.status)}.`
        + `\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    )
  }
  return result.stdout
}

function runWithEnvironment(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: '1',
      DSH_TELEMETRY_MODE: 'DISABLED',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      ...options.values,
    },
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `${options.label ?? command} failed with exit code ${String(result.status)}.`
        + `\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    )
  }
}

function runCandidate(command, arguments_, label) {
  return runWithEnvironment(command, arguments_, { cwd: temporaryRoot, label, values: {} })
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}.`)
  }
}

async function createCandidateRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-sub-candidate-'))
  const manifest = {
    name: 'dsh-codex-sub-candidate-lane',
    private: true,
    type: 'module',
    dependencies: {
      '@deepseek-ai/cordis': '4.0.1',
      '@deepseek-ai/dsh-authorization': candidateVersion,
      '@deepseek-ai/dsh-attachment': candidateVersion,
      '@deepseek-ai/dsh-atomic-write': candidateVersion,
      '@deepseek-ai/dsh-credentials-local': candidateVersion,
      '@deepseek-ai/dsh-home-paths': candidateVersion,
      '@deepseek-ai/dsh-llm': candidateVersion,
      '@deepseek-ai/dsh-llm-pi-ai': candidateVersion,
      '@earendil-works/pi-ai': '0.82.1',
    },
  }
  await writeFile(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  run('pnpm', ['install', '--ignore-scripts'], { cwd: root, label: 'candidate install' })
  return root
}

async function resolvePackage(root, packageName) {
  const manifestPath = join(
    root,
    'node_modules',
    ...packageName.split('/'),
    'package.json',
  )
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.name !== packageName) {
    throw new Error(`Resolved package metadata did not identify ${packageName}.`)
  }
  return { directory: join(root, 'node_modules', ...packageName.split('/')), manifest }
}

async function resolvePeer(root, packageName) {
  try {
    return await resolvePackage(root, packageName)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    const storeRoot = join(root, 'node_modules', '.pnpm')
    const entries = await readdir(storeRoot, { withFileTypes: true })
    for (const entry of entries.filter(candidate => candidate.isDirectory() && candidate.name.includes(`${packageName.replace('/', '+')}@`))) {
      try {
        return await resolvePackage(join(storeRoot, entry.name), packageName)
      } catch (nested) {
        if (nested?.code !== 'ENOENT') throw nested
      }
    }
    throw new Error(`Could not resolve candidate peer ${packageName} from the isolated graph.`)
  }
}

const temporaryRoot = await createCandidateRoot()
try {
  const adapterPackage = await resolvePackage(temporaryRoot, '@deepseek-ai/dsh-llm-pi-ai')
  const piAiPackage = await resolvePackage(temporaryRoot, '@earendil-works/pi-ai')
  const llmPackage = await resolvePackage(temporaryRoot, '@deepseek-ai/dsh-llm')

  requireEqual(adapterPackage.manifest.version, candidateVersion, 'candidate dsh-llm-pi-ai')
  requireEqual(llmPackage.manifest.version, candidateVersion, 'candidate dsh-llm')
  requireEqual(piAiPackage.manifest.version, '0.82.1', 'shared pi-ai')
  requireEqual(adapterPackage.manifest.dependencies['@earendil-works/pi-ai'], '^0.82.1', 'upstream pi-ai range')

  for (const [name, range] of Object.entries(adapterPackage.manifest.peerDependencies)) {
    if (!name.startsWith('@deepseek-ai/')) continue
    const peer = await resolvePeer(temporaryRoot, name)
    const minimum = range.startsWith('^') ? range.slice(1) : range
    requireEqual(peer.manifest.version, minimum, `candidate peer ${name}`)
  }

  const probeSource = `
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'

const accessSentinel = 'ACCESS_SENTINEL_candidate_probe'
let nativeReads = 0
let nativeWrites = 0
const injection = {
  credentials: {
    async read(providerId) {
      nativeReads += 1
      assert.equal(providerId, 'openai-codex')
      return undefined
    },
    async list() { return [] },
    async modify() { nativeWrites += 1; throw new Error('must not write') },
    async delete() { nativeWrites += 1; throw new Error('must not delete') },
  },
  authContext: {
    async env(name) {
      assert.equal(name, 'OPENAI_API_KEY')
      return undefined
    },
    async fileExists(path) {
      assert.match(path, /credentials/)
      return false
    },
  },
}
const faux = fauxProvider({
  provider: 'openai-codex',
  models: [{ id: 'candidate-model', name: 'Candidate model' }],
})
faux.setResponses([fauxAssistantMessage('candidate-ok')])
const profile = Object.freeze({
  provider: 'openai-codex',
  displayName: 'OpenAI Codex (ChatGPT)',
  streamIdleTimeoutMs: 1_000,
  maxRequestImageBytes: 20 * 1024 * 1024,
  retryPolicy: { mode: 'normal', maxRetries: 0, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
  piProvider: faux.provider,
  configuredMaxTokens: new Map(),
})
const adapter = new PiAiAdapter({
  profiles: () => new Map([['openai-codex', profile]]),
  resolveApiKey: async () => accessSentinel,
  auth: injection,
})
const ctx = new Context()
const runtimeFiber = ctx.plugin(LlmRuntime)
await runtimeFiber
ctx.llm.registerConfigurableProviders([{
  provider: 'openai-codex',
  displayName: 'OpenAI Codex (ChatGPT)',
  settingsNs: 'llm-codex-sub',
  settingsPath: [],
}])
try {
  ctx.llm.registerConfigurableProviders([{
    provider: 'openai-codex',
    displayName: 'Duplicate candidate',
    settingsNs: 'other-namespace',
    settingsPath: [],
  }])
  assert.fail('duplicate directory registration succeeded')
} catch (error) {
  assert.equal(error.code, 'DUPLICATE_DIRECTORY')
}
ctx.llm.registerAdapter(['openai-codex'], adapter)
assert.deepEqual(ctx.llm.listProviders(), [
  { id: 'openai-codex', name: 'OpenAI Codex (ChatGPT)' },
])
assert.equal((await ctx.llm.listModels('openai-codex')).length, 1)
for await (const chunk of ctx.llm.stream({
  provider: 'openai-codex',
  model: 'candidate-model',
  messages: [],
})) {
  if (chunk.type === 'finish') assert.equal(chunk.reason.kind, 'stop')
}
assert.equal(nativeReads, 0)
assert.equal(nativeWrites, 0)
await runtimeFiber.dispose()
`
  const probePath = join(temporaryRoot, 'candidate-probe.mjs')
  await writeFile(probePath, probeSource)

const authorizationPackage = await resolvePackage(temporaryRoot, '@deepseek-ai/dsh-authorization')
  const localCredentialsPackage = await resolvePackage(
    temporaryRoot,
    '@deepseek-ai/dsh-credentials-local',
  )
  requireEqual(authorizationPackage.manifest.version, candidateVersion, 'candidate authorization')
  requireEqual(localCredentialsPackage.manifest.version, candidateVersion, 'candidate local credentials')

  // The probe resolves these Host-owned services from the isolated root only; neither becomes
  // a repository dependency or ships in the plugin artifact.
  const authorizationDirectory = authorizationPackage.directory


  const nativeAuthProbe = `
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
const authorizationUrl = pathToFileURL(${JSON.stringify(authorizationDirectory)} + '/lib/index.js').href
const AuthorizationService = (await import(authorizationUrl)).default
const localCredentialsUrl = ${JSON.stringify(pathToFileURL(join(localCredentialsPackage.directory, 'lib/index.js')).href)}
const LocalCredentialProvider = (await import(localCredentialsUrl)).default
const root = await mkdtemp(join(tmpdir(), 'candidate-native-auth-'))
const ctx = new Context()
await ctx.plugin(LocalCredentialProvider, { path: join(root, '.credentials.yaml'), watch: false })
await ctx.plugin(AuthorizationService)
ctx.authorization.registerFlow({
  key: 'llm-pi-ai/openai-codex',
  label: 'Codex offline fixture',
  methods: [{ id: 'oauth', label: 'OAuth' }],
  async run(session) {
    session.notify({ message: 'offline grant' })
    await ctx.credentials.modifyRecord('llm-pi-ai/openai-codex', async () => ({
      kind: 'grant',
      payload: { type: 'oauth', access: 'offline-access', refresh: 'offline-refresh', expires: 1 },
    }))
  },
})
assert.deepEqual(ctx.authorization.describe('llm-pi-ai/openai-codex')?.methods.map(({ id }) => id), ['oauth'])
assert.deepEqual(await ctx.authorization.begin({
  key: 'llm-pi-ai/openai-codex',
  interaction: { notify() {}, prompt() { return Promise.reject(new Error('declined')) } },
}), { status: 'authorized' })
const record = await ctx.credentials.readRecord('llm-pi-ai/openai-codex')
assert.equal(record?.kind, 'grant')
assert.equal(record.payload.type, 'oauth')
await ctx.credentials.deleteRecord('llm-pi-ai/openai-codex')
assert.equal(await ctx.credentials.readRecord('llm-pi-ai/openai-codex'), undefined)
`
  const nativeAuthProbePath = join(temporaryRoot, 'native-auth-probe.mjs')
  await writeFile(nativeAuthProbePath, nativeAuthProbe)

  runCandidate(process.execPath, [nativeAuthProbePath], 'candidate native auth probe')
  runCandidate(process.execPath, [probePath], 'candidate adapter probe')

  process.stdout.write(`DSH ${candidateVersion} candidate lane passed.\n`)
} finally {
  const cleanup = spawnSync('rm', ['-rf', temporaryRoot], { encoding: 'utf8', shell: false })
  if (cleanup.status !== 0) {
    process.stderr.write(`Failed to clean candidate lane: ${cleanup.stderr ?? ''}`)
  }
}
