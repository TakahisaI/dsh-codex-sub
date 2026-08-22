import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const candidateVersion = '0.1.1-rc.1'
const upstreamCommit = '528c682e061696f5a160f363f236ecbf53cbd006'

function redact(value, secrets) {
  let rendered = value ?? ''
  for (const secret of secrets) {
    rendered = rendered.replaceAll(secret, '[REDACTED]')
  }
  return rendered
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(options.env ?? {}),
      CI: '1',
      DSH_TELEMETRY_MODE: 'DISABLED',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `${options.label ?? command} failed with exit code ${String(result.status)}.\n`
        + redact(stdout, options.secrets)
        + '\n'
        + redact(stderr, options.secrets),
    )
  }
  for (const secret of options.secrets ?? []) {
    if (stdout.includes(secret) || stderr.includes(secret)) {
      throw new Error(`${options.label ?? command} exposed a generated sentinel.`)
    }
  }
  return { stderr, stdout }
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}.`)
  }
}

async function createCandidateRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-sub-candidate-'))
  run('pnpm', [
    'exec',
    'tsdown',
    join(repositoryRoot, 'scripts', 'spike-candidate-entry.ts'),
    '--format',
    'esm',
    '--out-dir',
    root,
    '--clean',
    '--logLevel',
    'warn',
  ], { cwd: repositoryRoot, label: 'bundle production candidate probe' })
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
  run('pnpm', ['install', '--ignore-scripts'], {
    cwd: root,
    label: 'candidate install',
  })
  return root
}

async function resolvePackage(root, packageName) {
  const packageDirectory = join(root, 'node_modules', ...packageName.split('/'))
  const manifestPath = join(packageDirectory, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.name !== packageName) {
    throw new Error(`Resolved package metadata did not identify ${packageName}.`)
  }
  return { directory: packageDirectory, manifest }
}

async function resolvePeer(root, packageName) {
  try {
    return await resolvePackage(root, packageName)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    const storeRoot = join(root, 'node_modules', '.pnpm')
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(storeRoot, { withFileTypes: true })
    const prefix = packageName.replace('/', '+')
    for (const entry of entries.filter(candidate => candidate.isDirectory() && candidate.name.includes(prefix))) {
      try {
        return await resolvePackage(join(storeRoot, entry.name), packageName)
      } catch (nested) {
        if (nested?.code !== 'ENOENT') throw nested
      }
    }
    throw new Error(`Could not resolve candidate peer ${packageName} from the isolated graph.`)
  }
}

async function assertCandidateGraph(root) {
  const adapterPackage = await resolvePackage(root, '@deepseek-ai/dsh-llm-pi-ai')
  const piAiPackage = await resolvePackage(root, '@earendil-works/pi-ai')
  const llmPackage = await resolvePackage(root, '@deepseek-ai/dsh-llm')

  requireEqual(adapterPackage.manifest.version, candidateVersion, 'candidate dsh-llm-pi-ai')
  requireEqual(llmPackage.manifest.version, candidateVersion, 'candidate dsh-llm')
  requireEqual(piAiPackage.manifest.version, '0.82.1', 'shared pi-ai')
  requireEqual(
    adapterPackage.manifest.dependencies['@earendil-works/pi-ai'],
    '^0.82.1',
    'upstream pi-ai range',
  )

  for (const [name, range] of Object.entries(adapterPackage.manifest.peerDependencies)) {
    if (!name.startsWith('@deepseek-ai/')) continue
    const peer = await resolvePeer(root, name)
    const minimum = range.startsWith('^') ? range.slice(1) : range
    requireEqual(peer.manifest.version, minimum, `candidate peer ${name}`)
  }
}

async function runNativeAuthProbe(root) {
  const accessSentinel = `ACCESS_SENTINEL_${randomUUID()}`
  const refreshSentinel = `REFRESH_SENTINEL_${randomUUID()}`
  const accountSentinel = `ACCOUNT_SENTINEL_${randomUUID()}`
  const source = `
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'

const access = process.env.CANDIDATE_ACCESS_SENTINEL
const refresh = process.env.CANDIDATE_REFRESH_SENTINEL
const account = process.env.CANDIDATE_ACCOUNT_SENTINEL
let credentialFiber
let authorizationFiber
let credentialRoot
try {
  credentialRoot = await mkdtemp(join(tmpdir(), 'candidate-native-auth-'))
  const ctx = new Context()
  credentialFiber = ctx.plugin(LocalCredentialProvider, {
    path: join(credentialRoot, '.credentials.yaml'),
    watch: false,
  })
  await credentialFiber
  authorizationFiber = ctx.plugin(AuthorizationService)
  await authorizationFiber

  ctx.authorization.registerFlow({
    key: 'llm-pi-ai/openai-codex',
    label: 'Codex offline fixture',
    methods: [{ id: 'oauth', label: 'OAuth' }],
    async run(session) {
      session.notify({ message: 'offline grant' })
      await ctx.credentials.modifyRecord('llm-pi-ai/openai-codex', async () => ({
        kind: 'grant',
        payload: {
          type: 'oauth',
          access,
          refresh,
          expires: Date.now() + 3_600_000,
          accountId: account,
        },
      }))
    },
  })
  assert.deepEqual(
    ctx.authorization.describe('llm-pi-ai/openai-codex')?.methods.map(({ id }) => id),
    ['oauth'],
  )
  assert.deepEqual(await ctx.authorization.begin({
    key: 'llm-pi-ai/openai-codex',
    interaction: {
      notify() {},
      prompt() { return Promise.reject(new Error('declined')) },
    },
  }), { status: 'authorized' })

  const record = await ctx.credentials.readRecord('llm-pi-ai/openai-codex')
  assert.equal(record?.kind, 'grant')
  assert.equal(record.payload.type, 'oauth')
  await ctx.credentials.deleteRecord('llm-pi-ai/openai-codex')
  assert.equal(await ctx.credentials.readRecord('llm-pi-ai/openai-codex'), undefined)
} finally {
  if (authorizationFiber !== undefined) await authorizationFiber.dispose()
  if (credentialFiber !== undefined) await credentialFiber.dispose()
  if (credentialRoot !== undefined) await rm(credentialRoot, { recursive: true, force: true })
}
`
  const probePath = join(root, 'native-auth-probe.mjs')
  await writeFile(probePath, source)
  run(process.execPath, [probePath], {
    cwd: root,
    env: {
      CANDIDATE_ACCESS_SENTINEL: accessSentinel,
      CANDIDATE_ACCOUNT_SENTINEL: accountSentinel,
      CANDIDATE_REFRESH_SENTINEL: refreshSentinel,
    },
    label: 'native authorization and credential-record probe',
    secrets: [accessSentinel, refreshSentinel, accountSentinel],
  })
}

async function runPluginProbe(root) {
  const bundlePath = join(root, 'spike-candidate-entry.mjs')
  await readFile(bundlePath, 'utf8')
  run(process.execPath, [
    '--input-type=module',
    '--eval',
    `const probe = await import(${JSON.stringify(pathToFileURL(bundlePath).href)});
     await probe.runCandidatePluginProbe();`,
  ], {
    cwd: root,
    label: 'production CodexDshAdapter candidate probe',
    secrets: ['ACCESS_SENTINEL_', 'REFRESH_SENTINEL_', 'ACCOUNT_SENTINEL_'],
  })
}

const temporaryRoot = await createCandidateRoot()
try {
  await assertCandidateGraph(temporaryRoot)
  await runNativeAuthProbe(temporaryRoot)
  await runPluginProbe(temporaryRoot)
  process.stdout.write(
    `DSH ${candidateVersion} (commit ${upstreamCommit}) candidate lane passed.\n`,
  )
} catch (error) {
  if (process.env.DSH_SPIKE_KEEP_TEMP !== '1') {
    await import('node:fs/promises').then(fs => fs.rm(temporaryRoot, { recursive: true, force: true }))
  }
  console.error(`Candidate root can be preserved with DSH_SPIKE_KEEP_TEMP=1; failed root: ${temporaryRoot}`)
  throw error
} finally {
  if (process.env.DSH_SPIKE_KEEP_TEMP !== '1') {
    const cleanup = spawnSync('rm', ['-rf', temporaryRoot], { encoding: 'utf8', shell: false })
    if (cleanup.status !== 0) {
      process.stderr.write(`Failed to clean candidate lane: ${cleanup.stderr ?? ''}`)
    }
  }
}
