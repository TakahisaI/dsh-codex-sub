import { spawn, spawnSync } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { appendCapture, assertCaptureComplete } from './capture-output.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validatePackageTarball } from './package-tarball.mjs'
import {
  deriveRc1CandidateSource,
  readRepositoryCandidateInputs,
  RC1_CANDIDATE_VERSION,
  RC1_UPSTREAM_COMMIT,
} from './spike-rc1-candidate-source.mjs'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const candidateVersion = RC1_CANDIDATE_VERSION
const upstreamCommit = RC1_UPSTREAM_COMMIT
const packageName = 'dsh-codex-sub'
const pluginRowId = 'llm-codex-sub'
const probeName = 'dsh-codex-sub-packed-install-probe'
const probeDirectory = join(repositoryRoot, 'tests', 'fixtures', 'packed-install-probe')
const maxCaptureBytes = 4 * 1024 * 1024
const bootTimeoutMs = 60_000
const shutdownTimeoutMs = 5_000

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new Error(`${label} did not emit valid JSON.`, { cause })
  }
}

function redact(value, secrets = []) {
  let rendered = value ?? ''
  for (const secret of secrets) rendered = rendered.replaceAll(secret, '[REDACTED]')
  return rendered.replaceAll(temporaryRoot, '[TEMP]')
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...options.env,
      CI: '1',
      DSH_TELEMETRY_MODE: 'DISABLED',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const acceptedStatuses = options.accepted ?? [0]
  if (result.error !== undefined || !acceptedStatuses.includes(result.status ?? -1)) {
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

async function readPackageRoot(packageName_, parentFile) {
  let directory = dirname(parentFile)
  const segments = packageName_.split('/')
  for (let ascent = 0; ascent < 16; ascent += 1) {
    const candidates = basename(directory) === 'node_modules'
      ? [join(directory, ...segments)]
      : [join(directory, 'node_modules', ...segments)]
    for (const candidate of candidates) {
      let resolved
      try {
        resolved = await realpath(candidate)
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
      const manifest = parseJson(
        await readFile(join(resolved, 'package.json'), 'utf8'),
        packageName_,
      )
      invariant(manifest.name === packageName_, `${packageName_} metadata identity drifted.`)
      return { directory: resolved, manifest }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error(`Could not resolve ${packageName_}.`)
}

async function assertAbsent(path, message) {
  try {
    await readFile(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error(message)
}

async function inspectTopology(compatibility) {
  const profilesDirectory = join(dshHome, 'profiles')
  const profileDirectory = join(profilesDirectory, 'web')
  const hostParent = join(profilesDirectory, 'package.json')
  const pluginParent = join(profileDirectory, 'node_modules', packageName, 'package.json')
  const plugin = await readPackageRoot(packageName, pluginParent)

  invariant(plugin.manifest.version === compatibility.packageVersion, 'Candidate package version drifted.')
  for (const [name, expected] of Object.entries(plugin.manifest.peerDependencies)) {
    invariant(compatibility.dsh.packages[name] === expected, `${name} candidate peer drifted.`)
    const [host, installed] = await Promise.all([
      readPackageRoot(name, hostParent),
      readPackageRoot(name, pluginParent),
    ])
    invariant(host.manifest.version === expected, `${name} Host version drifted.`)
    invariant(installed.directory === host.directory, `${name} was duplicated in the plugin graph.`)
    await assertAbsent(
      join(profileDirectory, 'node_modules', ...name.split('/')),
      `${name} was installed in the plugin profile root.`,
    )
  }

  const hostPiAi = await readPackageRoot('@earendil-works/pi-ai', hostParent)
  const pluginPiAi = await readPackageRoot('@earendil-works/pi-ai', pluginParent)
  invariant(hostPiAi.manifest.version === compatibility.piAi.version, 'Host pi-ai drifted.')
  invariant(pluginPiAi.manifest.version === compatibility.piAi.version, 'Plugin pi-ai drifted.')
  invariant(hostPiAi.directory !== pluginPiAi.directory, 'Expected the normal two pi-ai copies.')

  const adapter = await readPackageRoot('@deepseek-ai/dsh-llm-pi-ai', hostParent)
  const adapterPackageParent = join(adapter.directory, 'package.json')
  for (const [name, range] of Object.entries(adapter.manifest.peerDependencies)) {
    if (!name.startsWith('@deepseek-ai/')) continue
    const [hostPeer, adapterPeer] = await Promise.all([
      readPackageRoot(name, hostParent),
      readPackageRoot(name, adapterPackageParent),
    ])
    const minimum = range.startsWith('^') ? range.slice(1) : range
    invariant(hostPeer.manifest.version === minimum, `${name} Host peer was unresolved.`)
    invariant(
      adapterPeer.directory === hostPeer.directory,
      `${name} transitive peer resolution diverged between Host and adapter.`,
    )
  }

  return {
    dshPeersSharedWithHost: Object.keys(plugin.manifest.peerDependencies).length,
    piAiCopies: 2,
    transitiveHostPeersResolved: Object.keys(adapter.manifest.peerDependencies)
      .filter(name => name.startsWith('@deepseek-ai/'))
      .length,
  }
}

function countExactLine(text, line) {
  return text.split(/\r?\n/u).filter(candidate => candidate.trim() === line).length
}

/**
 * Enumerate every physical DSH release-line package in the Host graph.
 *
 * Scans pnpm's store directory (`@deepseek-ai+dsh-<name>@<version>_…`) and
 * returns one entry per physical copy with its name, exact version, and
 * store-relative directory. Cordis-scoped and schemastery packages are
 * versioned independently and are never pinned to the DSH candidate version.
 */
async function enumerateHostDshPackages() {
  const storeDirectory = join(hostRoot, 'node_modules', '.pnpm')
  let entries
  try {
    entries = await readdir(storeDirectory)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const packages = []
  for (const entry of entries) {
    if (!entry.startsWith('@deepseek-ai+')) continue
    const remainder = entry.slice('@deepseek-ai+'.length)
    const atSign = remainder.indexOf('@')
    if (atSign <= 0) continue
    const namePart = remainder.slice(0, atSign)
    if (!namePart.startsWith('dsh')) continue
    packages.push({
      directory: entry,
      name: `@deepseek-ai/${namePart}`,
      version: remainder.slice(atSign + 1).split('_')[0],
    })
  }
  return packages.sort((first, second) => first.directory.localeCompare(second.directory))
}

/**
 * Assert the final Host graph resolves entirely to the candidate version.
 *
 * Three independent checks:
 * 1. The pnpm lockfile — the authoritative resolution — must reference no
 *    DSH release-line version other than the candidate.
 * 2. Every lockfile-referenced physical store copy of a DSH package must sit
 *    at the candidate version, and every seed package must be present.
 * 3. Every live symlink (Host root, profile shared fallback, profile root)
 *    must resolve to a candidate-version manifest, so nothing reachable
 *    points at another release. Unreferenced directories left on disk by an
 *    earlier install are garbage, not part of the graph.
 */
async function assertWholeGraphIsCandidateVersion(seedNames) {
  // The pnpm lockfile is the authoritative resolution: it must reference the
  // candidate and no other DSH release-line version.
  const lockText = await readFile(join(hostRoot, 'pnpm-lock.yaml'), 'utf8')
  invariant(lockText.includes(`dsh@${candidateVersion}`), 'The Host lockfile lost the candidate pin.')
  const staleLockReferences = lockText.match(/0\.1\.\d+-rc(?!\.1)\d*/gu) ?? []
  invariant(
    staleLockReferences.length === 0,
    `The Host lockfile still references non-candidate releases (${staleLockReferences.length} matches).`,
  )

  // Physical store check: every store directory whose name+version pair is
  // referenced by the resolution must sit at the candidate version. pnpm
  // keeps unreferenced directories from earlier installs on disk, so entries
  // absent from the lockfile are garbage, not part of the graph.
  const referencedPairs = new Set(
    [...lockText.matchAll(/'(@deepseek-ai\/dsh[^@']*)@(0\.1\.\d+-rc\.\d+)':/gu)]
      .map(([, name, version]) => `${name}@${version}`),
  )
  const physical = await enumerateHostDshPackages()
  invariant(physical.length > 0, 'The Host graph resolved without any DSH packages.')
  const byName = new Map()
  for (const pkg of physical) {
    if (!referencedPairs.has(`${pkg.name}@${pkg.version}`)) continue
    const known = byName.get(pkg.name) ?? []
    known.push(pkg)
    byName.set(pkg.name, known)
  }
  for (const seed of seedNames) {
    invariant(byName.has(seed), `${seed} was absent from the final Host graph.`)
  }
  for (const [name, copies] of byName) {
    for (const copy of copies) {
      invariant(
        copy.version === candidateVersion,
        `${name} remained at ${copy.version} instead of ${candidateVersion}.`,
      )
    }
  }

  // Live links must resolve into candidate-version copies too.
  const liveRoots = [
    join(hostRoot, 'node_modules', '@deepseek-ai'),
    join(dshHome, 'profiles', 'node_modules', '@deepseek-ai'),
    join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai'),
  ]
  let liveLinksChecked = 0
  for (const liveRoot of liveRoots) {
    let names
    try {
      names = await readdir(liveRoot)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const name of names) {
      if (!name.startsWith('dsh')) continue
      const manifest = parseJson(
        await readFile(join(liveRoot, name, 'package.json'), 'utf8'),
        `live link @deepseek-ai/${name}`,
      )
      invariant(
        manifest.version === candidateVersion,
        `The live link @deepseek-ai/${name} resolved to ${manifest.version}.`,
      )
      liveLinksChecked += 1
    }
  }
  return { physicalCopies: physical.length, liveLinksChecked }
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

async function waitForProbe(child, resultPath) {
  const deadline = Date.now() + bootTimeoutMs
  while (Date.now() < deadline) {
    try {
      return await readFile(resultPath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (hasExited(child)) throw new Error('The rc.1 Host exited before the probe completed.')
    await delay(100)
  }
  throw new Error('Timed out waiting for the exact-artifact packed probe.')
}

async function stopChild(child, exited) {
  if (hasExited(child)) return
  child.kill('SIGTERM')
  await Promise.race([exited, delay(shutdownTimeoutMs)])
  if (!hasExited(child)) {
    child.kill('SIGKILL')
    await Promise.race([exited, delay(shutdownTimeoutMs)])
    invariant(hasExited(child), 'The rc.1 Host ignored SIGKILL.')
  }
}

function assertNoSentinel(value, label) {
  for (const secret of allSentinels) {
    invariant(!value.includes(secret), `${label} exposed a generated sentinel.`)
  }
}

async function bootProbe(environment, resultPath) {
  const bootOutput = {
    stderr: { bytes: 0, truncated: false, value: '' },
    stdout: { bytes: 0, truncated: false, value: '' },
  }
  const child = spawn(dshExecutable, [
    '--profile', 'web', '--port', '0',
  ], {
    cwd: hostRoot,
    env: environment,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  const closed = once(child, 'close')
  child.stdout.on('data', chunk => {
    appendCapture(bootOutput.stdout, chunk, maxCaptureBytes)
  })
  child.stderr.on('data', chunk => {
    appendCapture(bootOutput.stderr, chunk, maxCaptureBytes)
  })
  let probeText
  let failure
  try {
    probeText = await waitForProbe(child, resultPath)
  } catch (caught) {
    failure = caught
  } finally {
    await stopChild(child, exited)
    await Promise.race([closed, delay(shutdownTimeoutMs)])
  }
  invariant(
    child.stdout.readableEnded === true && child.stderr.readableEnded === true,
    'The rc.1 Host stdio did not close.',
  )
  assertCaptureComplete(bootOutput.stdout, bootOutput.stderr)
  if (failure !== undefined) {
    throw new Error(
      `${String(failure)}\n${redact(
        `${bootOutput.stdout.value}\n${bootOutput.stderr.value}`,
        allSentinels,
      )}`,
    )
  }
  assertNoSentinel(`${bootOutput.stdout.value}\n${bootOutput.stderr.value}`, 'Exact-artifact boot capture')
  assertNoSentinel(probeText, 'Exact-artifact probe result')
  return parseJson(probeText, 'exact-artifact packed probe')
}

/**
 * Build the exact rc.1 candidate tarball before any installation happens.
 *
 * The supported-line artifact is always built from the current reviewed
 * source — no external tarball input exists, so stale code cannot hide under
 * fresh metadata. It is packed by the reviewed pipeline, extracted once, and
 * transformed by the reviewed derivation: peers and the machine-readable
 * compatibility document move together to the candidate versions, and the
 * bundled compatibility identity inside lib follows them. The derivation
 * inputs are read from the extracted artifact itself and must match the
 * repository exactly before any mutation. Nothing is mutated after
 * installation; the Host receives these final bytes through its ordinary
 * `plugin add` path.
 */
async function buildExactCandidateArtifact() {
  const inputDestination = join(temporaryRoot, 'artifact-input')
  await mkdir(inputDestination, { recursive: true })
  run('pnpm', ['run', 'build'], { label: 'build supported source' })
  const inputPack = parseJson(run('pnpm', [
    'pack', '--pack-destination', inputDestination, '--json',
  ], { label: 'pack supported artifact' }).stdout, 'supported pack')
  const inputArtifact = await validatePackageTarball(inputPack.filename)

  // Extract once, then apply the reviewed derivation before anything is
  // installed so the Host only ever sees final candidate bytes.
  const stagingRoot = join(temporaryRoot, 'candidate-source-staging')
  const packageRoot = join(stagingRoot, 'package')
  await mkdir(stagingRoot, { recursive: true })
  run('tar', ['-xzf', inputArtifact.canonicalPath, '-C', stagingRoot], {
    label: 'extract candidate staging',
  })

  // Derivation inputs come from the extracted artifact itself and must equal
  // the reviewed source semantically. pnpm pack normalizes package.json
  // (dropping `packageManager` and reordering), so compare parsed content
  // with those normalizations applied to the repository manifest as well.
  const repositoryInputs = await readRepositoryCandidateInputs()
  const extractedManifestText = await readFile(join(packageRoot, 'package.json'), 'utf8')
  const extractedCompatibilityText = await readFile(join(packageRoot, 'compatibility.json'), 'utf8')
  const extractedManifest = JSON.parse(extractedManifestText)
  const PACK_NORMALIZED_KEYS = ['packageManager']
  const expectedManifest = Object.fromEntries(
    Object.entries(repositoryInputs.manifest).filter(([key]) => !PACK_NORMALIZED_KEYS.includes(key)),
  )
  const actualManifest = Object.fromEntries(
    Object.entries(extractedManifest).filter(([key]) => !PACK_NORMALIZED_KEYS.includes(key)),
  )
  invariant(
    JSON.stringify(actualManifest, Object.keys(actualManifest).sort())
      === JSON.stringify(expectedManifest, Object.keys(expectedManifest).sort()),
    'The packed manifest did not match the reviewed source.',
  )
  const extractedCompatibility = JSON.parse(extractedCompatibilityText)
  invariant(
    JSON.stringify(extractedCompatibility) === JSON.stringify(repositoryInputs.compatibility),
    'The packed compatibility document did not match the reviewed source.',
  )
  const candidateSource = deriveRc1CandidateSource({
    compatibility: extractedCompatibility,
    manifest: extractedManifest,
  })
  const candidateManifestPath = join(packageRoot, 'package.json')
  await writeFile(
    candidateManifestPath,
    `${JSON.stringify(candidateSource.manifest, null, 2)}\n`,
    'utf8',
  )
  await writeFile(
    join(packageRoot, 'compatibility.json'),
    `${JSON.stringify(candidateSource.compatibility, null, 2)}\n`,
    'utf8',
  )

  // tsdown inlines the compatibility document into every emitted entry, so
  // move only the pinned identity fields inside lib to match the reviewed
  // derivation while keeping the verified production bytecode unchanged.
  const libDirectory = join(packageRoot, 'lib')
  for (const entry of await readdir(libDirectory, { recursive: true })) {
    if (!entry.endsWith('.mjs')) continue
    const path = join(libDirectory, entry)
    let source = await readFile(path, 'utf8')
    source = source
      .replaceAll('"release": "0.1.0-rc.7"', `"release": "${candidateVersion}"`)
      .replaceAll('"repositoryCommit": "99f6f02fecdb7dff40c3fbc9470f5907c29f74ca"', `"repositoryCommit": "${upstreamCommit}"`)
      .replaceAll('"0.1.0-rc.7"', `"${candidateVersion}"`)
    await writeFile(path, source, 'utf8')
  }

  const candidatePack = parseJson(run('pnpm', [
    '--dir', packageRoot, 'pack', '--pack-destination', artifactDirectory, '--json',
  ], { label: 'pack exact candidate artifact' }).stdout, 'candidate pack')
  const candidate = await validatePackageTarball(candidatePack.filename)

  const stagedManifest = parseJson(await readFile(candidateManifestPath, 'utf8'), 'staged manifest')
  for (const [name, expected] of Object.entries(stagedManifest.peerDependencies)) {
    if (name === '@deepseek-ai/cordis') continue
    invariant(expected === candidateVersion, `${name} candidate peer was not applied.`)
  }
  const stagedCompatibility = candidateSource.compatibility
  invariant(stagedCompatibility.dsh.release === candidateVersion, 'Candidate release identity drifted.')
  invariant(stagedCompatibility.dsh.repositoryCommit === upstreamCommit, 'Candidate commit identity drifted.')

  return { candidateSource, candidate, inputArtifact }
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-codex-sub-exact-artifact-'))
const artifactDirectory = join(temporaryRoot, 'artifacts')
const hostRoot = join(temporaryRoot, 'host')
const dshHome = join(hostRoot, 'home')
let dshExecutable
const nativeSentinels = {
  access: `NATIVE_ACCESS_SENTINEL_${randomUUID()}`,
  refresh: `NATIVE_REFRESH_SENTINEL_${randomUUID()}`,
  account: `NATIVE_ACCOUNT_SENTINEL_${randomUUID()}`,
}
const packageSentinels = {
  access: `PACKAGE_ACCESS_SENTINEL_${randomUUID()}`,
  refresh: `PACKAGE_REFRESH_SENTINEL_${randomUUID()}`,
  account: `PACKAGE_ACCOUNT_SENTINEL_${randomUUID()}`,
}
const siblingSentinel = `SIBLING_SENTINEL_${randomUUID()}`
const allSentinels = [
  ...Object.values(nativeSentinels),
  ...Object.values(packageSentinels),
  siblingSentinel,
]
invariant(new Set(allSentinels).size === allSentinels.length, 'Generated credential sentinels collided.')

try {
  await mkdir(artifactDirectory, { recursive: true })
  const { candidateSource, candidate, inputArtifact } = await buildExactCandidateArtifact()

  // Phase 1 — compose a fresh isolated Host graph pinned to exact rc.1
  // packages. Every DSH release-line package declares a caret range, so an
  // unpinned install now resolves to the newer rc.2 release; the overrides
  // keep every shared peer at the inspected candidate version. The plugin is
  // still installed afterwards through DSH's own `plugin add` path.
  await mkdir(hostRoot, { recursive: true })
  const seedPackages = Object.keys(candidateSource.compatibility.dsh.packages)
    .filter(name => name !== '@deepseek-ai/cordis')
    // The Host CLI package is not a plugin peer and has no compatibility row,
    // but the exact-artifact claim covers it too.
    .concat('@deepseek-ai/dsh')
  const hostManifest = {
    name: 'dsh-codex-sub-exact-artifact-host',
    private: true,
    type: 'module',
    dependencies: {
      '@deepseek-ai/cordis': candidateSource.manifest.peerDependencies['@deepseek-ai/cordis'],
      '@deepseek-ai/schemastery': '^3.18.1',
      '@earendil-works/pi-ai': candidateSource.compatibility.piAi.version,
      ...Object.fromEntries(seedPackages.map(name => [name, candidateVersion])),
    },
  }
  await writeFile(join(hostRoot, 'package.json'), `${JSON.stringify(hostManifest, null, 2)}\n`)
  // pnpm 11 no longer reads the package.json "pnpm" field; overrides live in
  // pnpm-workspace.yaml.
  const workspacePath = join(hostRoot, 'pnpm-workspace.yaml')
  await writeFile(workspacePath, 'packages:\n  - .\noverrides: {}\n')
  run('pnpm', ['install', '--ignore-scripts'], {
    cwd: hostRoot,
    label: 'install seed rc.1 Host graph',
  })

  // Every DSH package declares a caret range and a newer rc.2 line already
  // exists, so transitive peers drift unless each discovered release-line
  // package is pinned explicitly. Reinstall once with the complete override
  // set, then verify the whole graph below.
  const discovered = await enumerateHostDshPackages()
  const seedNameSet = new Set(seedPackages)
  const discoveredNames = new Set(discovered.map(pkg => pkg.name))
  for (const seed of seedPackages) {
    invariant(discoveredNames.has(seed), `${seed} was absent from the seed rc.1 Host graph.`)
  }
  await writeFile(
    workspacePath,
    `packages:\n  - .\noverrides:\n${[...discoveredNames].map(name => `  '${name}': ${candidateVersion}`).join('\n')}\n`,
  )
  run('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile'], {
    cwd: hostRoot,
    label: 'reinstall exact-pinned rc.1 Host graph',
  })
  dshExecutable = join(hostRoot, 'node_modules', '.bin', 'dsh')

  // The whole release-line graph must now sit at the candidate version: every
  // physical store copy, every live link, and every seed package exactly once.
  const { physicalCopies } = await assertWholeGraphIsCandidateVersion(seedNameSet)

  const baseEnvironment = {
    ...process.env,
    CI: '1',
    DSH_HOME: dshHome,
    DSH_TELEMETRY_MODE: 'DISABLED',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    npm_config_auto_install_peers: 'false',
    npm_config_strict_peer_dependencies: 'false',
  }
  run(dshExecutable, ['--profile', 'web', '--dump-config'], {
    cwd: hostRoot,
    env: baseEnvironment,
    label: 'initialize exact-artifact Web profile',
  })

  const probePack = parseJson(run('pnpm', [
    '--dir', probeDirectory, 'pack', '--pack-destination', artifactDirectory, '--json',
  ], { env: baseEnvironment, label: 'pack probe fixture' }).stdout, 'probe pack')

  // Phase 2 — install the exact candidate bytes with the ordinary plugin path.
  run(dshExecutable, [
    'plugin', '--profile', 'web', 'add', candidate.canonicalPath,
    '--save-exact', '--allow-build=@google/genai', '--allow-build=protobufjs',
  ], { cwd: hostRoot, env: baseEnvironment, label: 'install exact candidate artifact' })
  run(dshExecutable, [
    'plugin', '--profile', 'web', 'add', probePack.filename, '--save-exact',
  ], { cwd: hostRoot, env: baseEnvironment, label: 'install probe fixture' })

  const installedConfig = run(dshExecutable, ['--profile', 'web', '--dump-config'], {
    cwd: hostRoot,
    env: baseEnvironment,
    label: 'installed exact-artifact config',
  })
  invariant(countExactLine(installedConfig.stdout, 'name: dsh-codex-sub') === 1, 'Candidate route row was not unique.')
  invariant(countExactLine(installedConfig.stdout, `- id: ${pluginRowId}`) === 1, 'Candidate bundle row was not unique.')
  const topology = await inspectTopology({
    ...candidateSource.compatibility,
    packageVersion: candidateSource.manifest.version,
  })
  // Plugin installation must not have reintroduced any non-candidate DSH
  // package or disturbed the pinned graph.
  const { physicalCopies: finalPhysicalCopies } = await assertWholeGraphIsCandidateVersion(seedNameSet)
  invariant(
    finalPhysicalCopies === physicalCopies,
    'Plugin installation changed the number of physical DSH packages.',
  )

  const resultPath = join(temporaryRoot, 'probe-result.json')
  const blockerPath = join(probeDirectory, 'block-network.mjs')
  // The probe fixture's own dsh.bundle.patch (cordis.patch.yml) inserts its
  // loader entry as part of the bundle stack; no extra --patch overlay is
  // needed and re-inserting the same id would fail with a duplicate entry.
  const probeEnvironment = {
    ...baseEnvironment,
    CANDIDATE_ACCESS_SENTINEL: nativeSentinels.access,
    CANDIDATE_ACCOUNT_SENTINEL: nativeSentinels.account,
    CANDIDATE_PACKAGE_ACCESS_SENTINEL: packageSentinels.access,
    CANDIDATE_PACKAGE_ACCOUNT_SENTINEL: packageSentinels.account,
    CANDIDATE_PACKAGE_REFRESH_SENTINEL: packageSentinels.refresh,
    CANDIDATE_REFRESH_SENTINEL: nativeSentinels.refresh,
    DSH_CODEX_SUB_PROBE_RESULT: resultPath,
    DSH_CODEX_SUB_CANDIDATE_PROBE_PHASE: 'save',
    NODE_OPTIONS: [`--import=${pathToFileURL(blockerPath).href}`],
    SSH_CONNECTION: 'packed-candidate-probe',
  }
  const probe = await bootProbe(probeEnvironment, resultPath)
  invariant(probe.providerOccurrences === 1, 'Candidate provider route was not unique.')
  invariant(probe.providerDisplayMatches === true, 'Candidate display metadata drifted.')
  invariant(probe.modelCount > 0 && probe.catalogIdsAreUnique === true, 'Candidate catalog was invalid.')
  invariant(probe.resolvedMatches === true, 'Candidate model resolution drifted.')
  invariant(probe.duplicateCode === 'DUPLICATE_ADAPTER', 'Candidate duplicate adapter guard did not fire.')
  invariant(probe.routeOccurrencesAfterConflict === 1, 'Duplicate registration disturbed the route.')
  invariant(probe.directoryConflictCode === 'DUPLICATE_DIRECTORY', 'Candidate directory conflict guard did not fire.')
  invariant(probe.phase === 'save' && probe.nativeCredentialKind === 'grant', 'Native credential save did not produce a grant record.')
  invariant(probe.nativeCredentialType === 'oauth', 'Native credential save did not preserve OAuth type.')
  invariant(probe.nativeCredentialMatches === true, 'Saved native credential content drifted.')
  invariant(probe.nativeCredentialMatchesForeignValues === false, 'Native save reused package-owned sentinel values.')
  invariant(probe.authFailureCode === 'CODEX_AUTH_REQUIRED', 'Signed-out request did not fail safely.')
  invariant(probe.networkAttempts === 0, 'Signed-out candidate request reached the network boundary.')

  const verifyResultPath = join(temporaryRoot, 'probe-verify-result.json')
  const verifyProbe = await bootProbe({
    ...probeEnvironment,
    DSH_CODEX_SUB_CANDIDATE_PROBE_PHASE: 'verify',
    DSH_CODEX_SUB_PROBE_RESULT: verifyResultPath,
  }, verifyResultPath)
  invariant(
    verifyProbe.phase === 'verify'
      && verifyProbe.nativeCredentialKind === 'grant'
      && verifyProbe.nativeCredentialType === 'oauth'
      && verifyProbe.nativeCredentialMatches === true
      && verifyProbe.nativeCredentialMatchesForeignValues === false,
    'Native credential did not survive a Host process restart.',
  )
  invariant(verifyProbe.authFailureCode === 'CODEX_AUTH_REQUIRED', 'Post-restart request did not fail safely.')
  invariant(verifyProbe.networkAttempts === 0, 'Post-restart candidate request reached the network boundary.')

  const signedOut = run(dshExecutable, [
    'plugin', '--profile', 'web', 'exec', packageName, 'status', '--json',
  ], {
    cwd: hostRoot,
    accepted: [1],
    env: baseEnvironment,
    label: 'exact-artifact signed-out status',
    secrets: allSentinels,
  })
  const signedOutReport = parseJson(signedOut.stdout, 'signed-out status')
  invariant(
    signedOutReport.status?.state === 'signed-out' && signedOutReport.schemaVersion === 1,
    'Candidate CLI did not report signed out.',
  )
  const doctor = run(dshExecutable, [
    'plugin', '--profile', 'web', 'exec', packageName, 'doctor', '--json',
  ], {
    cwd: hostRoot,
    env: baseEnvironment,
    label: 'exact-artifact doctor',
    secrets: allSentinels,
  })
  const doctorReport = parseJson(doctor.stdout, 'exact-artifact doctor')
  invariant(doctorReport.overall === 'compatible', 'Candidate doctor rejected the isolated rc.1 graph.')
  invariant(doctorReport.catalog?.modelCount === probe.modelCount, 'CLI and Host catalog counts disagreed.')

  const authDirectory = join(dshHome, packageName)
  const authFile = join(authDirectory, 'auth.json')
  await mkdir(authDirectory, { mode: 0o700, recursive: true })
  const credentialBytes = `${JSON.stringify({
    schemaVersion: 1,
    provider: 'openai-codex',
    credential: {
      accessToken: packageSentinels.access,
      refreshToken: packageSentinels.refresh,
      expiresAt: Date.now() + 86_400_000,
      providerData: { accountId: packageSentinels.account },
    },
  })}\n`
  await writeFile(authFile, credentialBytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const siblingFile = join(authDirectory, 'logout-preservation.marker')
  await writeFile(siblingFile, `${siblingSentinel}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const signedIn = run(dshExecutable, [
    'plugin', '--profile', 'web', 'exec', packageName, 'status', '--json',
  ], {
    cwd: hostRoot,
    env: baseEnvironment,
    label: 'exact-artifact signed-in status after restart',
    secrets: allSentinels,
  })
  const signedInReport = parseJson(signedIn.stdout, 'signed-in status')
  invariant(signedInReport.status?.state === 'signed-in', 'Candidate credential did not survive a process restart.')
  const logout = run(dshExecutable, [
    'plugin', '--profile', 'web', 'exec', packageName, 'logout',
  ], {
    cwd: hostRoot,
    env: baseEnvironment,
    label: 'exact-artifact logout',
    secrets: allSentinels,
  })
  await assertAbsent(authFile, 'Candidate logout did not remove package-owned auth.json.')
  invariant(await readFile(siblingFile, 'utf8') === `${siblingSentinel}\n`, 'Candidate logout disturbed an adjacent file.')

  const postLogoutResultPath = join(temporaryRoot, 'probe-post-logout-result.json')
  const postLogoutProbe = await bootProbe({
    ...probeEnvironment,
    DSH_CODEX_SUB_CANDIDATE_PROBE_PHASE: 'post-logout',
    DSH_CODEX_SUB_PROBE_RESULT: postLogoutResultPath,
  }, postLogoutResultPath)
  invariant(
    postLogoutProbe.phase === 'post-logout'
      && postLogoutProbe.nativeCredentialKind === 'grant'
      && postLogoutProbe.nativeCredentialType === 'oauth'
      && postLogoutProbe.nativeCredentialMatches === true
      && postLogoutProbe.nativeCredentialMatchesForeignValues === false
      && postLogoutProbe.nativeCredentialDeleted === true,
    'Package-owned logout changed the independent native credential.',
  )
  invariant(postLogoutProbe.authFailureCode === 'CODEX_AUTH_REQUIRED', 'Post-logout request did not fail safely.')
  invariant(postLogoutProbe.networkAttempts === 0, 'Post-logout candidate request reached the network boundary.')

  const confirmDeletedResultPath = join(temporaryRoot, 'probe-confirm-deleted-result.json')
  const confirmDeletedProbe = await bootProbe({
    ...probeEnvironment,
    DSH_CODEX_SUB_CANDIDATE_PROBE_PHASE: 'confirm-deleted',
    DSH_CODEX_SUB_PROBE_RESULT: confirmDeletedResultPath,
  }, confirmDeletedResultPath)
  invariant(
    confirmDeletedProbe.phase === 'confirm-deleted'
      && confirmDeletedProbe.nativeCredentialKind === undefined
      && confirmDeletedProbe.nativeCredentialType === undefined
      && confirmDeletedProbe.nativeCredentialMatches === false
      && confirmDeletedProbe.nativeCredentialDeleted === true,
    'Native credential deletion did not persist across a Host restart.',
  )
  invariant(confirmDeletedProbe.authFailureCode === 'CODEX_AUTH_REQUIRED', 'Post-delete request did not fail safely.')
  invariant(confirmDeletedProbe.networkAttempts === 0, 'Post-delete candidate request reached the network boundary.')

  assertNoSentinel(JSON.stringify({
    confirmDeletedProbe,
    doctorReport,
    logout,
    postLogoutProbe,
    probe,
    signedInReport,
    signedOutReport,
    topology,
    verifyProbe,
  }), 'Exact-artifact lane summary')

  process.stdout.write(`${JSON.stringify({
    candidateArtifactSha256: candidate.sha256,
    candidateVersion,
    catalogModelCount: probe.modelCount,
    doctorOverall: doctorReport.overall,
    hostDshPhysicalCopies: finalPhysicalCopies,
    inputArtifactSha256: inputArtifact.sha256,
    nativeCredentialDeletedAfterRestart: confirmDeletedProbe.nativeCredentialDeleted,
    networkAttempts: probe.networkAttempts,
    networkAttemptsAfterDelete: confirmDeletedProbe.networkAttempts,
    networkAttemptsAfterLogout: postLogoutProbe.networkAttempts,
    networkAttemptsAfterRestart: verifyProbe.networkAttempts,
    siblingFilePreserved: true,
    topology,
    upstreamCommit,
  })}\n`)
} finally {
  if (process.env.DSH_SPIKE_KEEP_TEMP !== '1') {
    await rm(temporaryRoot, { force: true, recursive: true })
  } else {
    console.error(`Preserved exact-artifact lane root: ${temporaryRoot}`)
  }
}
