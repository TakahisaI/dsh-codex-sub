import { spawn, spawnSync } from 'node:child_process'
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { appendCapture, assertCaptureComplete } from './capture-output.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validatePackageTarball } from './package-tarball.mjs'
import {
  assertWorkflowArtifactSha256,
  assertWorkflowArtifactSourceIdentity,
} from './exact-artifact-contract.mjs'
import {
  RC1_CANDIDATE_VERSION,
  RC1_UPSTREAM_COMMIT,
} from './spike-rc1-candidate-source.mjs'
import {
  assertDshReleaseFamilyLock,
  assertHostDshPackages,
  enumerateHostDshPackages,
} from './dsh-release-family-lock.mjs'
import { parseProbeScope } from './probe-scope.mjs'
import { parseHostGraphMode } from './host-graph-mode.mjs'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const candidateVersion = RC1_CANDIDATE_VERSION
const upstreamCommit = RC1_UPSTREAM_COMMIT
const packageName = 'dsh-codex-sub'
const pluginRowId = 'llm-codex-sub'
const probeDirectory = join(repositoryRoot, 'tests', 'fixtures', 'packed-install-probe')
const releaseHostFixtureDirectory = join(repositoryRoot, 'tests', 'fixtures', 'rc1-release-host')
const maxCaptureBytes = 4 * 1024 * 1024
const bootTimeoutMs = 60_000
const resumeBootTimeoutMs = 120_000
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

function packageTarballArguments() {
  const arguments_ = process.argv[2] === '--' ? process.argv.slice(3) : process.argv.slice(2)
  const probeScope = parseProbeScope(arguments_)
  const hostGraphMode = parseHostGraphMode(arguments_)
  const { values } = parseArgs({
    args: arguments_,
    allowPositionals: false,
    options: {
      'expected-sha256': { type: 'string' },
      'package-tarball': { type: 'string' },
      'probe-scope': { type: 'string' },
      'host-graph-mode': { type: 'string' },
    },
    strict: true,
  })
  const packageTarball = values['package-tarball']
  const expectedSha256 = values['expected-sha256']
    ?? process.env.DSH_WORKFLOW_ARTIFACT_SHA256
  invariant(packageTarball !== undefined, '--package-tarball is required for the exact artifact lane.')
  invariant(isAbsolute(packageTarball), '--package-tarball must be an absolute path.')
  invariant(packageTarball.endsWith('.tgz'), '--package-tarball must name a .tgz file.')
  invariant(
    expectedSha256 !== undefined && /^[0-9a-f]{64}$/u.test(expectedSha256),
    '--expected-sha256 (or DSH_WORKFLOW_ARTIFACT_SHA256) must be a lowercase SHA-256 digest.',
  )
  invariant(values['probe-scope'] === probeScope, '--probe-scope parser disagreement.')
  invariant(values['host-graph-mode'] === hostGraphMode, '--host-graph-mode parser disagreement.')
  return {
    expectedSha256,
    hostGraphMode,
    packageTarball: resolve(packageTarball),
    probeScope,
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
async function assertWholeGraphIsCandidateVersion(seedNames, hostGraphMode, expectedNames) {
  // The pnpm lockfile is the authoritative resolution: every DSH release-line
  // entry it references must be the exact candidate version.
  const lockText = await readFile(join(hostRoot, 'pnpm-lock.yaml'), 'utf8')
  const workspaceText = await readFile(join(hostRoot, 'pnpm-workspace.yaml'), 'utf8')
  const lockReport = assertDshReleaseFamilyLock({
    lockText,
    workspaceText,
    version: candidateVersion,
    overridePolicy: hostGraphMode === 'locked-no-overrides' ? 'forbidden' : 'required',
    expectedNames,
    requireAutoInstallPeers: hostGraphMode === 'locked-no-overrides',
  })
  const referencedPairs = new Set([
    ...lockReport.packageIdentities,
    ...lockReport.snapshotIdentities,
  ].map(({ name, version }) => `${name}@${version}`))

  // Physical store check: every store directory whose name+version pair is
  // referenced by the resolution must sit at the candidate version. pnpm
  // keeps unreferenced directories from earlier installs on disk, so entries
  // absent from the lockfile are garbage, not part of the graph.
  const physical = await enumerateHostDshPackages(hostRoot)
  invariant(physical.length > 0, 'The Host graph resolved without any DSH packages.')
  const selectedPhysical = physical.filter(pkg => referencedPairs.has(`${pkg.name}@${pkg.version}`))
  assertHostDshPackages(selectedPhysical, seedNames, candidateVersion, {
    requireUniqueNames: hostGraphMode === 'locked-no-overrides',
  })

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

async function sha256File(path) {
  const bytes = await readFile(path)
  const hash = createHash('sha256')
  hash.update(bytes)
  return hash.digest('hex')
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

async function waitForProbe(child, resultPath, timeoutMs = bootTimeoutMs) {
  const deadline = Date.now() + timeoutMs
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

async function bootProbe(environment, resultPath, timeoutMs = bootTimeoutMs) {
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
    probeText = await waitForProbe(child, resultPath, timeoutMs)
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
  const { expectedSha256, hostGraphMode, packageTarball, probeScope } = packageTarballArguments()
  const inputArtifact = await validatePackageTarball(packageTarball)
  assertWorkflowArtifactSha256(inputArtifact.sha256, expectedSha256)
  const packedManifest = parseJson(run('tar', [
    '-xOf', inputArtifact.canonicalPath, 'package/package.json',
  ], { label: 'read workflow artifact manifest' }).stdout, 'workflow artifact manifest')
  const packedCompatibility = parseJson(run('tar', [
    '-xOf', inputArtifact.canonicalPath, 'package/compatibility.json',
  ], { label: 'read workflow artifact compatibility' }).stdout, 'workflow artifact compatibility')
  const repositoryManifest = parseJson(await readFile(join(repositoryRoot, 'package.json'), 'utf8'), 'repository package.json')
  const repositoryCompatibility = parseJson(await readFile(join(repositoryRoot, 'compatibility.json'), 'utf8'), 'repository compatibility.json')
  assertWorkflowArtifactSourceIdentity({
    packedManifest,
    packedCompatibility,
    repositoryManifest,
    repositoryCompatibility,
    version: candidateVersion,
    repositoryCommit: upstreamCommit,
  })
  const candidateSource = { manifest: packedManifest, compatibility: packedCompatibility }
  await mkdir(artifactDirectory, { recursive: true })

  // Phase 1 — compose a fresh isolated Host graph. The historical
  // override-pinned lane builds the graph dynamically for regression. The
  // #50 lane copies a reviewed fixture and performs one frozen install with
  // no override or resolution metadata before using the ordinary plugin path.
  await mkdir(hostRoot, { recursive: true })
  const seedPackages = Object.keys(candidateSource.compatibility.dsh.packages)
    .filter(name => name !== '@deepseek-ai/cordis')
    // The Host CLI package is not a plugin peer and has no compatibility row,
    // but the exact-artifact claim covers it too.
    .concat('@deepseek-ai/dsh')
  await writeFile(
    join(hostRoot, 'compatibility.json'),
    `${JSON.stringify(candidateSource.compatibility, null, 2)}\n`,
  )
  let fixtureDshNames
  let seedNameSet
  let expectedHostNames
  if (hostGraphMode === 'locked-no-overrides') {
    const fixtureFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
    const fixtureBytes = new Map()
    for (const filename of fixtureFiles) {
      const source = join(releaseHostFixtureDirectory, filename)
      fixtureBytes.set(filename, await sha256File(source))
      await cp(source, join(hostRoot, filename))
    }
    const fixtureManifest = parseJson(
      await readFile(join(hostRoot, 'package.json'), 'utf8'),
      'rc.1 release Host fixture package.json',
    )
    fixtureDshNames = Object.keys(fixtureManifest.dependencies ?? {})
      .filter(name => name.startsWith('@deepseek-ai/dsh'))
      .sort()
    invariant(fixtureDshNames.length === 188, 'The rc.1 release Host fixture must contain 188 DSH identities.')
    for (const name of fixtureDshNames) {
      invariant(
        fixtureManifest.dependencies[name] === candidateVersion,
        `${name} fixture dependency drifted from ${candidateVersion}.`,
      )
    }
    const fixtureLockText = await readFile(join(hostRoot, 'pnpm-lock.yaml'), 'utf8')
    const fixtureWorkspaceText = await readFile(join(hostRoot, 'pnpm-workspace.yaml'), 'utf8')
    assertDshReleaseFamilyLock({
      lockText: fixtureLockText,
      workspaceText: fixtureWorkspaceText,
      version: candidateVersion,
      overridePolicy: 'forbidden',
      expectedNames: fixtureDshNames,
      requireAutoInstallPeers: true,
    })
    run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], {
      cwd: hostRoot,
      label: 'install locked-no-overrides rc.1 Host fixture',
    })
    for (const filename of fixtureFiles) {
      invariant(
        await sha256File(join(hostRoot, filename)) === fixtureBytes.get(filename),
        `${filename} changed during the frozen fixture install.`,
      )
    }
    seedNameSet = new Set(fixtureDshNames)
    expectedHostNames = fixtureDshNames
  } else {
    const hostManifest = {
      name: 'dsh-codex-sub-exact-artifact-host',
      private: true,
      type: 'module',
      dependencies: {
        '@deepseek-ai/cordis': candidateSource.manifest.peerDependencies['@deepseek-ai/cordis'],
        '@deepseek-ai/schemastery': '^3.18.1',
        '@earendil-works/pi-ai': candidateSource.compatibility.piAi.version,
      },
      devDependencies: Object.fromEntries(seedPackages.map(name => [name, candidateVersion])),
    }
    await writeFile(join(hostRoot, 'package.json'), `${JSON.stringify(hostManifest, null, 2)}\n`)
    const workspacePath = join(hostRoot, 'pnpm-workspace.yaml')
    await writeFile(workspacePath, 'packages:\n  - .\noverrides: {}\n')
    run('pnpm', ['install', '--ignore-scripts'], {
      cwd: hostRoot,
      label: 'install seed rc.1 Host graph',
    })
    const discovered = await enumerateHostDshPackages(hostRoot)
    seedNameSet = new Set(seedPackages)
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
  }
  dshExecutable = join(hostRoot, 'node_modules', '.bin', 'dsh')

  // The whole release-line graph must now sit at the candidate version: every
  // physical store copy, every live link, and every seed package exactly once.
  const { physicalCopies } = await assertWholeGraphIsCandidateVersion(
    seedNameSet,
    hostGraphMode,
    expectedHostNames,
  )

  const baseEnvironment = {
    ...process.env,
    CI: '1',
    DSH_HOME: dshHome,
    DSH_TELEMETRY_MODE: 'DISABLED',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    npm_config_auto_install_peers: 'false',
    ...(hostGraphMode === 'override-pinned' ? { npm_config_strict_peer_dependencies: 'false' } : {}),
  }
  run(dshExecutable, ['--profile', 'web', '--dump-config'], {
    cwd: hostRoot,
    env: baseEnvironment,
    label: 'initialize exact-artifact Web profile',
  })

  const probePack = parseJson(run('pnpm', [
    '--dir', probeDirectory, 'pack', '--pack-destination', artifactDirectory, '--json',
  ], { env: baseEnvironment, label: 'pack probe fixture' }).stdout, 'probe pack')
  const beforeInstallArtifact = await validatePackageTarball(inputArtifact.canonicalPath)
  assertWorkflowArtifactSha256(beforeInstallArtifact.sha256, expectedSha256)

  // Phase 2 — install the exact candidate bytes with the ordinary plugin path.
  run(dshExecutable, [
    'plugin', '--profile', 'web', 'add', inputArtifact.canonicalPath,
    '--save-exact', '--allow-build=@google/genai', '--allow-build=protobufjs',
  ], { cwd: hostRoot, env: baseEnvironment, label: 'install exact candidate artifact' })
  const afterInstallArtifact = await validatePackageTarball(inputArtifact.canonicalPath)
  assertWorkflowArtifactSha256(afterInstallArtifact.sha256, expectedSha256)
  run(dshExecutable, [
    'plugin', '--profile', 'web', 'add', probePack.filename, '--save-exact',
  ], { cwd: hostRoot, env: baseEnvironment, label: 'install probe fixture' })
  let resumeArtifact = afterInstallArtifact

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
  const { physicalCopies: finalPhysicalCopies } = await assertWholeGraphIsCandidateVersion(
    seedNameSet,
    hostGraphMode,
    expectedHostNames,
  )
  invariant(
    finalPhysicalCopies === physicalCopies,
    'Plugin installation changed the number of physical DSH packages.',
  )

  const resultPath = join(temporaryRoot, 'probe-result.json')
  const blockerPath = join(probeDirectory, 'block-network.mjs')
  // The probe fixture's own dsh.bundle.patch (cordis.patch.yml) inserts its
  // loader entry as part of the bundle stack; no extra patch argument is
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

  let requests
  let resumeRequests
  let requestsSeedProbe
  let requestsResumeProbe
  if (probeScope === 'request-contracts') {
    // Requests boots (#51) reuse the one installed artifact and one DSH_HOME.
    // Seed and resume are separate Host processes so replay evidence crosses a
    // real persistence boundary. The scripted transport is installed by the
    // fixture at module load and keeps every non-pinned destination fail closed.
    const requestsAuthDirectory = join(dshHome, packageName)
  await mkdir(requestsAuthDirectory, { mode: 0o700, recursive: true })
  const requestsAuthFile = join(requestsAuthDirectory, 'auth.json')
  // pi-ai's Codex client reads the account claim out of the access token and
  // refuses to stream without it, so the signed-in boot needs a shape-only
  // three-part token. The payload carries no real data: the account value is
  // a fixed probe constant, the signature part is a literal, and nothing
  // leaves the process (the scripted transport answers every request).
  const stubAccessToken = [
    Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64'),
    Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'packed-probe-account' },
      exp: Math.floor(Date.now() / 1000) + 86_400,
    })).toString('base64'),
    'stub-signature',
  ].join('.')
  const requestsCredentialBytes = `${JSON.stringify({
    schemaVersion: 1,
    provider: 'openai-codex',
    credential: {
      accessToken: stubAccessToken,
      refreshToken: `REFRESH_SENTINEL_${packageSentinels.refresh}`,
      expiresAt: Date.now() + 86_400_000,
      providerData: { accountId: packageSentinels.account },
    },
  })}\n`
  await writeFile(requestsAuthFile, requestsCredentialBytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const requestSessionId = `packed-rc1-replay-${randomUUID()}`
  const requestsSeedResultPath = join(temporaryRoot, 'probe-requests-seed-result.json')
  requestsSeedProbe = await bootProbe({
    ...probeEnvironment,
    DSH_CODEX_SUB_CANDIDATE_PROBE_PHASE: 'requests-seed',
    DSH_CODEX_SUB_REQUEST_SESSION_ID: requestSessionId,
    DSH_CODEX_SUB_PROBE_RESULT: requestsSeedResultPath,
    NODE_OPTIONS: [],
  }, requestsSeedResultPath)
  requests = requestsSeedProbe.requests
  invariant(requests !== undefined, 'The requests-seed probe result was absent.')
  invariant(requests.handoff?.sessionId === requestSessionId, 'Seed handoff session id drifted.')
  invariant(requests.handoff?.seedReady === true, 'Seed handoff was not marked ready.')
  invariant(typeof requests.handoff?.modelId === 'string', 'Seed handoff model id was absent.')
  invariant(requests.replay.responseId === 'resp_packed_replay_seed', 'Seed replay response identity drifted.')
  invariant(requests.replay.assistantMessages >= 1 && requests.replay.requestHeaders >= 1, 'Seed replay/request events were not durable.')
  invariant(requests.retry.providerAttempts === 3, `Retry provider attempts drifted: ${requests.retry.providerAttempts}`)
  invariant(requests.retry.executionCount === 1 && requests.retry.retryCount === 1 && requests.retry.retryStartedCount === 1, 'Retry policy/event counts drifted.')
  invariant(requests.retry.toolCallCount === 1 && requests.retry.toolResultCount === 1 && requests.retry.assistantMessageCount === 2, 'Tool/assistant event counts drifted.')
  invariant(requests.retry.attempts.length === 3, 'Retry transport attempt trace was not exactly three.')
  invariant(requests.retry.finishKind === 'completed' && requests.retry.finalAssistantText === 'packed retry final response' && requests.retry.finalResponseId === 'resp_packed_retry_final' && requests.retry.failedCallAdopted === false, 'Retry final durable surface drifted.')
  invariant(requests.cancellation.directPreAborted.fetchCount === 0 && requests.cancellation.directPreAborted.wsCount === 0, 'Direct pre-aborted stream reached a provider transport.')
  invariant(requests.cancellation.preDispatch.fetchCount === 0 && requests.cancellation.preDispatch.wsCount === 0, 'Pre-dispatch cancellation reached a provider transport.')
  invariant(requests.cancellation.midStream.fetchCountAtLatch === 1 && requests.cancellation.midStream.fetchCountAfterAbort === 1 && requests.cancellation.midStream.fetchCountAfterAbortDelta === 0 && requests.cancellation.midStream.wsCountAtLatch === 1 && requests.cancellation.midStream.wsCountAfterAbort === 1 && requests.cancellation.midStream.wsCountAfterAbortDelta === 0, 'Mid-stream cancellation transport count drifted.')
  invariant(requests.cancellation.midStream.retryCount === 0 && requests.cancellation.midStream.assistantMessageCount === 0 && requests.cancellation.midStream.toolCallCount === 0 && requests.cancellation.midStream.toolResultCount === 0, 'Mid-stream cancellation admitted derived output or retry.')
  invariant(requests.images.offloadedTextCount === 2 && requests.images.imageWire?.survivorCount === 4, 'Attachment image budget wire survivors drifted.')
  invariant(requests.images.durableReferenceCount === 6 && requests.images.durableReferenceOrderUnchanged === true && requests.images.durableReferenceShapeUnchanged === true, 'Durable attachment references drifted.')
  invariant(requests.totals.fetchRequests.length === 6 && requests.totals.wsUrls.length === 4 && requests.totals.externalHosts.length === 0 && requests.totals.loopbackUrls.length === 0 && requests.totals.stickyError === undefined && requests.totals.wsSendCount === 0, 'Requests seed left the transport boundary.')

  const requestsResumeResultPath = join(temporaryRoot, 'probe-requests-resume-result.json')
  requestsResumeProbe = await bootProbe({
    ...probeEnvironment,
    DSH_CODEX_SUB_CANDIDATE_PROBE_PHASE: 'requests-resume',
    DSH_CODEX_SUB_REQUEST_SESSION_ID: requestSessionId,
    DSH_CODEX_SUB_PROBE_RESULT: requestsResumeResultPath,
    NODE_OPTIONS: [],
  }, requestsResumeResultPath, resumeBootTimeoutMs)
  resumeRequests = requestsResumeProbe.requests
  invariant(resumeRequests !== undefined, 'The requests-resume probe result was absent.')
  invariant(resumeRequests.handoff?.sessionId === requestSessionId && resumeRequests.handoff?.seedReady === true, 'Resume handoff drifted.')
  invariant(resumeRequests.replay.responseId === 'resp_packed_replay_continue', 'Resume replay response identity drifted.')
  invariant(resumeRequests.replay.firstLiveSeq > 0 && resumeRequests.replay.titleSource === 'user', 'Resume did not restore firstLiveSeq/user title.')
  invariant(resumeRequests.replay.continuationObserved === true, 'Resume continuation wire was not observed.')
  invariant(resumeRequests.replay.durableHistoryHasSeed === true && resumeRequests.replay.durableHistoryHasContinuation === true, 'Resume durable history lost a response.')
  invariant(resumeRequests.totals.providerAttempts === 1 && resumeRequests.totals.fetchRequests.length === 1 && resumeRequests.totals.wsUrls.length === 1 && resumeRequests.totals.externalHosts.length === 0 && resumeRequests.totals.loopbackUrls.length === 0 && resumeRequests.totals.stickyError === undefined && resumeRequests.totals.wsSendCount === 0, 'Resume left the transport boundary.')
  resumeArtifact = await validatePackageTarball(inputArtifact.canonicalPath)
  assertWorkflowArtifactSha256(resumeArtifact.sha256, expectedSha256)

  // Restore the signed-out state the credential-lifecycle phases expect: the
  // requests boots created the package credential, so remove it again and
  // prove nothing else about the install drifted.
    await rm(requestsAuthFile, { force: true })
    const signedOutAgain = run(dshExecutable, [
    'plugin', '--profile', 'web', 'exec', packageName, 'status', '--json',
  ], {
    cwd: hostRoot,
    accepted: [1],
    env: baseEnvironment,
    label: 'exact-artifact signed-out status after requests boots',
    secrets: allSentinels,
  })
    const signedOutAgainReport = parseJson(signedOutAgain.stdout, 'signed-out status after requests boot')
    invariant(
      signedOutAgainReport.status?.state === 'signed-out',
      'Candidate CLI did not report signed out after the requests boot cleanup.',
    )
  }

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
  const finalArtifact = await validatePackageTarball(inputArtifact.canonicalPath)
  assertWorkflowArtifactSha256(finalArtifact.sha256, expectedSha256)

  assertNoSentinel(JSON.stringify({
    confirmDeletedProbe,
    doctorReport,
    logout,
    postLogoutProbe,
    probe,
    requestsSeedProbe,
    requestsResumeProbe,
    signedInReport,
    signedOutReport,
    topology,
    verifyProbe,
  }), 'Exact-artifact lane summary')

  process.stdout.write(`${JSON.stringify({
    installedArtifactSha256: afterInstallArtifact.sha256,
    resumedArtifactSha256: resumeArtifact.sha256,
    finalArtifactSha256: finalArtifact.sha256,
    artifactSha256Checkpoints: {
      input: inputArtifact.sha256,
      beforeInstall: beforeInstallArtifact.sha256,
      afterInstall: afterInstallArtifact.sha256,
      afterResume: resumeArtifact.sha256,
      final: finalArtifact.sha256,
    },
    packageArtifactFilename: basename(inputArtifact.canonicalPath),
    packageVersion: candidateSource.manifest.version,
    candidateVersion,
    catalogModelCount: probe.modelCount,
    doctorOverall: doctorReport.overall,
    hostDshPhysicalCopies: finalPhysicalCopies,
    workflowArtifactSha256: inputArtifact.sha256,
    nativeCredentialDeletedAfterRestart: confirmDeletedProbe.nativeCredentialDeleted,
    networkAttempts: probe.networkAttempts,
    networkAttemptsAfterDelete: confirmDeletedProbe.networkAttempts,
    networkAttemptsAfterLogout: postLogoutProbe.networkAttempts,
    networkAttemptsAfterRestart: verifyProbe.networkAttempts,
    ...(requests === undefined ? {} : {
      requestContracts: {
        attachmentImageOnWire: requests.images.imageWire?.survivorCount === 4,
        replaySeedResponseId: requests.replay.responseId,
        replayResumeResponseId: resumeRequests?.replay.responseId,
        replayContinuationObserved: resumeRequests?.replay.continuationObserved,
        attachmentDurableReferenceOrderUnchanged: requests.images.durableReferenceOrderUnchanged,
        attachmentDurableReferenceShapeUnchanged: requests.images.durableReferenceShapeUnchanged,
        retryProviderAttempts: requests.retry.providerAttempts,
        retryExecutionCount: requests.retry.executionCount,
        cancellationPreDispatchFetch: requests.cancellation.preDispatch.fetchCount,
        cancellationMidStreamFetchAtLatch: requests.cancellation.midStream.fetchCountAtLatch,
        cancellationMidStreamFetchAfterAbort: requests.cancellation.midStream.fetchCountAfterAbort,
        cancellationMidStreamFetchAfterAbortDelta: requests.cancellation.midStream.fetchCountAfterAbortDelta,
        cancellationMidStreamWsAtLatch: requests.cancellation.midStream.wsCountAtLatch,
        cancellationMidStreamWsAfterAbort: requests.cancellation.midStream.wsCountAfterAbort,
        cancellationMidStreamWsAfterAbortDelta: requests.cancellation.midStream.wsCountAfterAbortDelta,
        cancelledPartialChunkCount: requests.cancellation.midStream.partialChunkCount,
        externalHosts: [...new Set([...requests.totals.externalHosts, ...(resumeRequests?.totals.externalHosts ?? [])])],
      },
    }),
    bootPhases: probeScope === 'request-contracts'
      ? ['save', 'verify', 'requests-seed', 'requests-resume', 'post-logout', 'confirm-deleted']
      : ['save', 'verify', 'post-logout', 'confirm-deleted'],
    probeScope,
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
