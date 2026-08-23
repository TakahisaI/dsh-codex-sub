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
import { parseArgs } from 'node:util'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { appendCapture, assertCaptureComplete } from './capture-output.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validatePackageTarball } from './package-tarball.mjs'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const candidateVersion = '0.1.1-rc.1'
const upstreamCommit = '528c682e061696f5a160f363f236ecbf53cbd006'
const packageName = 'dsh-codex-sub'
const pluginRowId = 'llm-codex-sub'
const probeName = 'dsh-codex-sub-packed-candidate-probe'
const probeDirectory = join(repositoryRoot, 'tests', 'fixtures', 'packed-install-probe')
const maxCaptureBytes = 4 * 1024 * 1024
const bootTimeoutMs = 60_000
const shutdownTimeoutMs = 5_000

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function packageTarballFromArguments() {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      'package-tarball': { type: 'string' },
    },
  })
  const packageTarball = values['package-tarball']
  if (packageTarball === undefined) return undefined
  invariant(isAbsolute(packageTarball), '--package-tarball must be an absolute path.')
  invariant(packageTarball.endsWith('.tgz'), '--package-tarball must name a .tgz file.')
  return resolve(packageTarball)
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
      npm_config_auto_install_peers: 'false',
      npm_config_strict_peer_dependencies: 'false',
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
  const hostParent = join(hostRoot, 'package.json')
  const pluginParent = join(profileDirectory, 'node_modules', packageName, 'package.json')
  const plugin = await readPackageRoot(packageName, pluginParent)

  invariant(plugin.manifest.version === '0.1.0-alpha.1', 'Candidate package version drifted.')
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
    if (hasExited(child)) throw new Error('Candidate DSH exited before the probe completed.')
    await delay(100)
  }
  throw new Error('Timed out waiting for the candidate packed probe.')
}

async function stopChild(child, exited) {
  if (hasExited(child)) return
  child.kill('SIGTERM')
  await Promise.race([exited, delay(shutdownTimeoutMs)])
  if (!hasExited(child)) {
    child.kill('SIGKILL')
    await Promise.race([exited, delay(shutdownTimeoutMs)])
    invariant(hasExited(child), 'Candidate DSH ignored SIGKILL.')
  }
}

function assertNoSentinel(value, label) {
  for (const secret of Object.values(sentinels)) {
    invariant(!value.includes(secret), `${label} exposed a generated sentinel.`)
  }
}

async function bootProbe(environment, resultPath, patchPath) {
  const bootOutput = {
    stderr: { bytes: 0, truncated: false, value: '' },
    stdout: { bytes: 0, truncated: false, value: '' },
  }
  const child = spawn(dshExecutable, [
    '--profile', 'web', '--patch', patchPath, '--port', '0',
  ], {
    cwd: hostRoot,
    env: environment,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
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
  }
  assertCaptureComplete(bootOutput.stdout, bootOutput.stderr)
  if (failure !== undefined) {
    throw new Error(
      `${String(failure)}\n${redact(
        `${bootOutput.stdout.value}\n${bootOutput.stderr.value}`,
        Object.values(sentinels),
      )}`,
    )
  }
  const probe = parseJson(probeText, 'candidate packed probe')
  assertNoSentinel(`${bootOutput.stdout.value}\n${bootOutput.stderr.value}`, 'Candidate boot capture')
  return probe
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-codex-sub-packed-candidate-'))
const artifactDirectory = join(temporaryRoot, 'artifacts')
const stagingDirectory = join(temporaryRoot, 'candidate-staging')
const hostRoot = join(temporaryRoot, 'host')
const dshHome = join(hostRoot, 'home')
const dshExecutable = join(hostRoot, 'node_modules', '.bin', 'dsh')
const sentinels = {
  access: `ACCESS_SENTINEL_${randomUUID()}`,
  refresh: `REFRESH_SENTINEL_${randomUUID()}`,
  account: `ACCOUNT_SENTINEL_${randomUUID()}`,
}

try {
  await mkdir(artifactDirectory, { recursive: true })
  const requestedTarball = packageTarballFromArguments()
  let sourceArtifact
  if (requestedTarball === undefined) {
    run('pnpm', ['run', 'build'], { label: 'build supported source' })
    const sourcePack = parseJson(run('pnpm', [
      'pack', '--pack-destination', artifactDirectory, '--json',
    ], { label: 'pack source artifact' }).stdout, 'source pack')
    sourceArtifact = await validatePackageTarball(sourcePack.filename)
  } else {
    sourceArtifact = await validatePackageTarball(requestedTarball)
  }

  await mkdir(stagingDirectory, { recursive: true })
  run('tar', ['-xzf', sourceArtifact.canonicalPath, '-C', stagingDirectory], {
    label: 'extract candidate staging',
  })
  const packageRoot = join(stagingDirectory, 'package')
  const candidateManifestPath = join(packageRoot, 'package.json')
  const candidateManifest = parseJson(
    await readFile(candidateManifestPath, 'utf8'),
    'candidate manifest',
  )
  for (const name of Object.keys(candidateManifest.peerDependencies)) {
    if (name === '@deepseek-ai/cordis') continue
    candidateManifest.peerDependencies[name] = candidateVersion
  }
  await writeFile(
    candidateManifestPath,
    `${JSON.stringify(candidateManifest, null, 2)}\n`,
    'utf8',
  )
  const candidateCompatibilityPath = join(packageRoot, 'compatibility.json')
  const candidateCompatibility = parseJson(
    await readFile(candidateCompatibilityPath, 'utf8'),
    'candidate compatibility',
  )
  const pinnedCandidatePackages = new Set([
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-authorization',
    '@deepseek-ai/dsh-brand',
    '@deepseek-ai/dsh-credentials-local',
    '@deepseek-ai/dsh-credentials',
    '@deepseek-ai/dsh-credentials-local',
    '@deepseek-ai/dsh-attachment',
    '@deepseek-ai/dsh-atomic-write',
    '@deepseek-ai/dsh-home-paths',
    '@deepseek-ai/dsh-invariants',
    '@deepseek-ai/dsh-launch-environment',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-llm-pi-ai',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/dsh-timeout',
  ])
  candidateCompatibility.dsh.release = candidateVersion
  candidateCompatibility.dsh.repositoryCommit = upstreamCommit
  for (const name of Object.keys(candidateCompatibility.dsh.packages)) {
    if (!pinnedCandidatePackages.has(name)) delete candidateCompatibility.dsh.packages[name]
  }
  for (const name of Object.keys(candidateCompatibility.dsh.packages)) {
    if (name !== '@deepseek-ai/cordis') candidateCompatibility.dsh.packages[name] = candidateVersion
  }
  await writeFile(
    candidateCompatibilityPath,
    `${JSON.stringify(candidateCompatibility, null, 2)}\n`,
    'utf8',
  )
  // tsdown inlines the compatibility document into every emitted entry. Rewrite
  // only the pinned identity fields so the ephemeral candidate tests the same
  // production bytecode against rc.1 while the repository stays frozen.
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
    'pack', '--pack-destination', artifactDirectory, '--json',
  ], {
    cwd: packageRoot,
    label: 'pack ephemeral candidate artifact',
  }).stdout, 'candidate pack')
  const candidate = await validatePackageTarball(candidatePack.filename)

  const manifest = {
    name: 'dsh-codex-sub-packed-candidate-host',
    private: true,
    type: 'module',
    dependencies: {
      '@deepseek-ai/cordis': '4.0.1',
      '@deepseek-ai/dsh': candidateVersion,
      '@deepseek-ai/dsh-attachment': candidateVersion,
      '@deepseek-ai/dsh-atomic-write': candidateVersion,
      '@deepseek-ai/dsh-home-paths': candidateVersion,
      '@deepseek-ai/dsh-llm': candidateVersion,
      '@deepseek-ai/dsh-llm-pi-ai': candidateVersion,
      '@deepseek-ai/dsh-authorization': candidateVersion,
      '@deepseek-ai/dsh-credentials': candidateVersion,
      '@deepseek-ai/dsh-launch-environment': candidateVersion,
      '@deepseek-ai/dsh-invariants': candidateVersion,
      '@deepseek-ai/dsh-brand': candidateVersion,
      '@deepseek-ai/dsh-settings': candidateVersion,
      '@deepseek-ai/dsh-timeout': candidateVersion,
      '@deepseek-ai/schemastery': '^3.18.1',
      '@earendil-works/pi-ai': '0.82.1',
    },
    pnpm: {
      overrides: {
        '@deepseek-ai/dsh-authorization': candidateVersion,
        '@deepseek-ai/dsh-attachment': candidateVersion,
        '@deepseek-ai/dsh-atomic-write': candidateVersion,
        '@deepseek-ai/dsh-credentials': candidateVersion,
        '@deepseek-ai/dsh-credentials-local': candidateVersion,
        '@deepseek-ai/dsh-brand': candidateVersion,
        '@deepseek-ai/dsh-home-paths': candidateVersion,
        '@deepseek-ai/dsh-invariants': candidateVersion,
        '@deepseek-ai/dsh-launch-environment': candidateVersion,
        '@deepseek-ai/dsh-llm': candidateVersion,
        '@deepseek-ai/dsh-llm-pi-ai': candidateVersion,
        '@deepseek-ai/dsh-settings': candidateVersion,
        '@deepseek-ai/dsh-timeout': candidateVersion,
      },
    },
  }
  await mkdir(hostRoot, { recursive: true })
  await writeFile(join(hostRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  run('pnpm', ['install', '--ignore-scripts'], {
    cwd: hostRoot,
    label: 'install isolated DSH rc.1 Host',
  })

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
    label: 'initialize candidate Web profile',
  })

  const probePack = parseJson(run('pnpm', [
    '--dir', probeDirectory, 'pack', '--pack-destination', artifactDirectory, '--json',
  ], { env: baseEnvironment, label: 'pack probe fixture' }).stdout, 'probe pack')
  run(dshExecutable, [
    'plugin', '--profile', 'web', 'add', candidate.canonicalPath,
    '--save-exact', '--allow-build=@google/genai', '--allow-build=protobufjs',
  ], { cwd: hostRoot, env: baseEnvironment, label: 'install candidate packed artifact' })
  run(dshExecutable, [
    'plugin', '--profile', 'web', 'add', probePack.filename, '--save-exact',
  ], { cwd: hostRoot, env: baseEnvironment, label: 'install probe fixture' })

  const installedConfig = run(dshExecutable, ['--profile', 'web', '--dump-config'], {
    cwd: hostRoot,
    env: baseEnvironment,
    label: 'installed candidate config',
  })
  invariant(countExactLine(installedConfig.stdout, 'name: dsh-codex-sub') === 1, 'Candidate route row was not unique.')
  invariant(countExactLine(installedConfig.stdout, `- id: ${pluginRowId}`) === 1, 'Candidate bundle row was not unique.')
  const topology = await inspectTopology(candidateCompatibility)

  const resultPath = join(temporaryRoot, 'probe-result.json')
  const blockerPath = join(probeDirectory, 'block-network.mjs')
  const patchPath = join(temporaryRoot, 'candidate-probe.patch.yml')
  await writeFile(patchPath, `${[
    '- insert:',
    `    - id: ${probeName}`,
    `      name: ${probeName}`,
    '',
  ].join('\n')}`)
  const probeEnvironment = {
    ...baseEnvironment,
    CANDIDATE_ACCESS_SENTINEL: sentinels.access,
    CANDIDATE_ACCOUNT_SENTINEL: sentinels.account,
    CANDIDATE_REFRESH_SENTINEL: sentinels.refresh,
    DSH_CODEX_SUB_PROBE_RESULT: resultPath,
    DSH_CODEX_SUB_CANDIDATE_PROBE_PHASE: 'save',
    NODE_OPTIONS: [`--import=${pathToFileURL(blockerPath).href}`],
    SSH_CONNECTION: 'packed-candidate-probe',
  }
  const probe = await bootProbe(probeEnvironment, resultPath, patchPath)
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
  invariant(probe.authFailureCode === 'CODEX_AUTH_REQUIRED', 'Signed-out request did not fail safely.')
  invariant(probe.networkAttempts === 0, 'Signed-out candidate request reached the network boundary.')

  const verifyResultPath = join(temporaryRoot, 'probe-verify-result.json')
  const verifyProbe = await bootProbe({
    ...probeEnvironment,
    DSH_CODEX_SUB_CANDIDATE_PROBE_PHASE: 'verify',
    DSH_CODEX_SUB_PROBE_RESULT: verifyResultPath,
  }, verifyResultPath, patchPath)
  invariant(
    verifyProbe.phase === 'verify'
      && verifyProbe.nativeCredentialKind === 'grant'
      && verifyProbe.nativeCredentialType === 'oauth'
      && verifyProbe.nativeCredentialMatches === true,
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
    label: 'candidate signed-out status',
    secrets: Object.values(sentinels),
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
    label: 'candidate doctor',
    secrets: Object.values(sentinels),
  })
  const doctorReport = parseJson(doctor.stdout, 'candidate doctor')
  invariant(doctorReport.overall === 'compatible', 'Candidate doctor rejected the isolated rc.1 graph.')
  invariant(doctorReport.catalog?.modelCount === probe.modelCount, 'CLI and Host catalog counts disagreed.')

  const authDirectory = join(dshHome, packageName)
  const authFile = join(authDirectory, 'auth.json')
  await mkdir(authDirectory, { mode: 0o700, recursive: true })
  const credentialBytes = `${JSON.stringify({
    schemaVersion: 1,
    provider: 'openai-codex',
    credential: {
      accessToken: sentinels.access,
      refreshToken: sentinels.refresh,
      expiresAt: Date.now() + 86_400_000,
      providerData: { accountId: sentinels.account },
    },
  })}\n`
  await writeFile(authFile, credentialBytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const siblingFile = join(authDirectory, 'logout-preservation.marker')
  const siblingMarker = `SIBLING_MARKER_${randomUUID()}\n`
  await writeFile(siblingFile, siblingMarker, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const logoutSecrets = [...Object.values(sentinels), siblingMarker]
  const signedIn = run(dshExecutable, [
    'plugin', '--profile', 'web', 'exec', packageName, 'status', '--json',
  ], {
    cwd: hostRoot,
    env: baseEnvironment,
    label: 'candidate signed-in status after restart',
    secrets: logoutSecrets,
  })
  const signedInReport = parseJson(signedIn.stdout, 'signed-in status')
  invariant(signedInReport.status?.state === 'signed-in', 'Candidate credential did not survive a process restart.')
  const logout = run(dshExecutable, [
    'plugin', '--profile', 'web', 'exec', packageName, 'logout',
  ], {
    cwd: hostRoot,
    env: baseEnvironment,
    label: 'candidate logout',
    secrets: logoutSecrets,
  })
  await assertAbsent(authFile, 'Candidate logout did not remove package-owned auth.json.')
  invariant(await readFile(siblingFile, 'utf8') === siblingMarker, 'Candidate logout disturbed an adjacent file.')

  const postLogoutResultPath = join(temporaryRoot, 'probe-post-logout-result.json')
  const postLogoutProbe = await bootProbe({
    ...probeEnvironment,
    DSH_CODEX_SUB_CANDIDATE_PROBE_PHASE: 'post-logout',
    DSH_CODEX_SUB_PROBE_RESULT: postLogoutResultPath,
  }, postLogoutResultPath, patchPath)
  invariant(
    postLogoutProbe.phase === 'post-logout'
      && postLogoutProbe.nativeCredentialKind === 'grant'
      && postLogoutProbe.nativeCredentialType === 'oauth'
      && postLogoutProbe.nativeCredentialMatches === true,
    'Package-owned logout changed the independent native credential.',
  )
  invariant(postLogoutProbe.authFailureCode === 'CODEX_AUTH_REQUIRED', 'Post-logout request did not fail safely.')
  invariant(postLogoutProbe.networkAttempts === 0, 'Post-logout candidate request reached the network boundary.')

  assertNoSentinel(JSON.stringify({
    doctorReport,
    logout,
    logoutPreservation: {
      adjacentMarkerPreserved: true,
      packageAuthRemoved: true,
    },
    postLogoutProbe,
    probe,
    signedInReport,
    signedOutReport,
    topology,
  }), 'Candidate lane summary')

  process.stdout.write(`${JSON.stringify({
    candidateArtifactSha256: candidate.sha256,
    candidateVersion,
    catalogModelCount: probe.modelCount,
    doctorOverall: doctorReport.overall,
    inputArtifactSha256: sourceArtifact.sha256,
    networkAttempts: probe.networkAttempts,
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
    console.error(`Preserved candidate lane root: ${temporaryRoot}`)
  }
}
