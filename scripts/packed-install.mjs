import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { validatePackageTarball } from './package-tarball.mjs'

const PACKAGE_NAME = 'dsh-codex-sub'
const PLUGIN_ROW_ID = 'llm-codex-sub'
const PROBE_NAME = 'dsh-codex-sub-packed-install-probe'
const PROVIDER_ID = 'openai-codex'
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024
const BOOT_TIMEOUT_MS = 45_000
const SHUTDOWN_TIMEOUT_MS = 5_000
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const dshExecutable = join(repositoryRoot, 'node_modules', '.bin', 'dsh')
const probeDirectory = join(repositoryRoot, 'tests', 'fixtures', 'packed-install-probe')
const blockerPath = join(probeDirectory, 'block-network.mjs')

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} did not emit valid JSON.`)
  }
}

function appendCapture(target, chunk) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
  const remaining = MAX_CAPTURE_BYTES - target.bytes
  if (remaining <= 0) {
    target.truncated = true
    return
  }
  const captured = bytes.subarray(0, remaining)
  target.value += captured.toString('utf8')
  target.bytes += captured.length
  if (bytes.length > remaining) {
    target.truncated = true
  }
}

function redactTestOutput(text) {
  let detail = text.slice(-4_000).replaceAll(temporaryRoot, '[TEMP]')
  for (const sentinel of sentinels) {
    detail = detail.replaceAll(sentinel, '[REDACTED]')
  }
  return detail
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: 'utf8',
    env: options.env,
    maxBuffer: MAX_CAPTURE_BYTES,
    shell: false,
  })
  const accepted = options.accepted ?? [0]
  if (result.error !== undefined || !accepted.includes(result.status ?? -1)) {
    const detail = redactTestOutput(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    throw new Error(
      `${options.label ?? command} failed with exit code ${String(result.status)}.\n${detail}`,
    )
  }
  return {
    status: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  }
}

function countExactLine(text, line) {
  return text.split(/\r?\n/u).filter((candidate) => candidate.trim() === line).length
}

function parseCommandLine(arguments_) {
  const normalizedArguments = arguments_[0] === '--' ? arguments_.slice(1) : arguments_
  const { values } = parseArgs({
    args: normalizedArguments,
    allowPositionals: false,
    options: {
      'package-tarball': { type: 'string' },
    },
    strict: true,
  })
  if (values['package-tarball'] !== undefined) {
    invariant(
      isAbsolute(values['package-tarball']),
      '--package-tarball must be an absolute path.',
    )
  }
  return values['package-tarball']
}

async function waitForProbe(child, resultPath) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      return await readFile(resultPath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error
      }
    }
    if (child.exitCode !== null) {
      throw new Error(`DSH exited before the packed-install probe completed.`)
    }
    await delay(100)
  }
  throw new Error('Timed out waiting for the packed-install probe.')
}

async function stopChild(child) {
  if (child.exitCode !== null) {
    return
  }
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), delay(SHUTDOWN_TIMEOUT_MS)])
  if (child.exitCode === null) {
    child.kill('SIGKILL')
    await once(child, 'exit')
  }
}

async function readPackageRoot(packageName, parentFile) {
  let directory = dirname(parentFile)
  const packageSegments = packageName.split('/')
  for (let index = 0; index < 16; index += 1) {
    const candidates = basename(directory) === 'node_modules'
      ? [join(directory, ...packageSegments)]
      : [join(directory, 'node_modules', ...packageSegments)]
    for (const candidate of candidates) {
      let resolved
      try {
        resolved = await realpath(candidate)
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw error
        }
        continue
      }
      const manifest = parseJson(
        await readFile(join(resolved, 'package.json'), 'utf8'),
        packageName,
      )
      if (manifest.name === packageName) {
        return { directory: resolved, manifest }
      }
      throw new Error(`Resolved package metadata did not identify ${packageName}.`)
    }
    const parent = dirname(directory)
    if (parent === directory) {
      break
    }
    directory = parent
  }
  throw new Error(`Could not resolve public package metadata for ${packageName}.`)
}

async function assertAbsent(path, message) {
  try {
    await access(path)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return
    }
    throw error
  }
  throw new Error(message)
}

async function inspectDependencyTopology(dshHome, compatibility) {
  const profilesDirectory = join(dshHome, 'profiles')
  const profileDirectory = join(profilesDirectory, 'web')
  const hostParent = join(profilesDirectory, 'package.json')
  const profileParent = join(profileDirectory, 'package.json')
  const plugin = await readPackageRoot(PACKAGE_NAME, profileParent)

  for (const [packageName, expectedVersion] of Object.entries(plugin.manifest.peerDependencies)) {
    invariant(
      compatibility.dsh.packages[packageName] === expectedVersion,
      `${packageName} did not match compatibility.json.`,
    )
    const [hostPackage, pluginResolvedPackage] = await Promise.all([
      readPackageRoot(packageName, hostParent),
      readPackageRoot(packageName, join(plugin.directory, 'package.json')),
    ])
    invariant(hostPackage.manifest.version === expectedVersion, `${packageName} Host version drifted.`)
    invariant(
      pluginResolvedPackage.directory === hostPackage.directory,
      `${packageName} was not shared with the DSH Host.`,
    )
    await assertAbsent(
      join(profileDirectory, 'node_modules', ...packageName.split('/')),
      `${packageName} was unexpectedly installed in the plugin profile root.`,
    )
  }

  const hostPiAi = await readPackageRoot('@earendil-works/pi-ai', hostParent)
  const pluginPiAi = await readPackageRoot(
    '@earendil-works/pi-ai',
    join(plugin.directory, 'package.json'),
  )
  invariant(hostPiAi.manifest.version === compatibility.piAi.version, 'Host pi-ai version drifted.')
  invariant(pluginPiAi.manifest.version === compatibility.piAi.version, 'Plugin pi-ai version drifted.')
  invariant(hostPiAi.directory !== pluginPiAi.directory, 'Packed install did not exercise two pi-ai copies.')

  const hostPiAiAdapter = await readPackageRoot('@deepseek-ai/dsh-llm-pi-ai', hostParent)
  for (const [packageName, supported] of Object.entries(hostPiAiAdapter.manifest.peerDependencies)) {
    const peer = await readPackageRoot(packageName, hostParent)
    const minimum = supported.startsWith('^') ? supported.slice(1) : supported
    invariant(peer.manifest.version === minimum, `${packageName} did not resolve at the verified Host version.`)
  }

  return {
    dshPeersSharedWithHost: Object.keys(plugin.manifest.peerDependencies).length,
    piAiCopies: 2,
    transitiveHostPeersResolved: Object.keys(hostPiAiAdapter.manifest.peerDependencies).length,
  }
}

const suppliedPackageTarball = parseCommandLine(process.argv.slice(2))
const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-codex-sub-packed-install-'))
const artifactDirectory = join(temporaryRoot, 'artifacts')
const dshHome = join(temporaryRoot, 'dsh-home')
const resultPath = join(temporaryRoot, 'probe-result.json')
const transcript = []
const sentinels = [
  `ACCESS_SENTINEL_${randomUUID()}`,
  `REFRESH_SENTINEL_${randomUUID()}`,
  `ACCOUNT_SENTINEL_${randomUUID()}`,
]

try {
  await mkdir(artifactDirectory, { recursive: true })
  const compatibility = parseJson(
    await readFile(join(repositoryRoot, 'compatibility.json'), 'utf8'),
    'compatibility.json',
  )
  const environment = {
    ...process.env,
    CI: '1',
    DSH_HOME: dshHome,
    DSH_TELEMETRY_MODE: 'DISABLED',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  }

  let packageTarball
  let packedFiles
  if (suppliedPackageTarball === undefined) {
    run('pnpm', ['run', 'build'], { env: environment, label: 'build' })
    const packageReport = parseJson(run('pnpm', [
      'pack',
      '--pack-destination',
      artifactDirectory,
      '--json',
    ], { env: environment, label: 'package pack' }).stdout, 'package pack')
    packageTarball = isAbsolute(packageReport.filename)
      ? packageReport.filename
      : join(artifactDirectory, packageReport.filename)
    const validated = await validatePackageTarball(packageTarball)
    packedFiles = validated.packedFiles
  } else {
    const validated = await validatePackageTarball(suppliedPackageTarball)
    packageTarball = validated.canonicalPath
    packedFiles = validated.packedFiles
  }

  const probeReport = parseJson(run('pnpm', [
    '--dir',
    probeDirectory,
    'pack',
    '--pack-destination',
    artifactDirectory,
    '--json',
  ], { env: environment, label: 'probe pack' }).stdout, 'probe pack')
  const probeTarball = isAbsolute(probeReport.filename)
    ? probeReport.filename
    : join(artifactDirectory, probeReport.filename)

  transcript.push(run(dshExecutable, ['--profile', 'web', '--dump-config'], {
    env: environment,
    label: 'profile initialization',
  }))
  transcript.push(run(dshExecutable, [
    'plugin',
    '--profile',
    'web',
    'add',
    packageTarball,
    '--save-exact',
    '--allow-build=@google/genai',
    '--allow-build=protobufjs',
  ], { env: environment, label: 'package install' }))
  transcript.push(run(dshExecutable, [
    'plugin',
    '--profile',
    'web',
    'add',
    probeTarball,
    '--save-exact',
  ], { env: environment, label: 'probe install' }))

  const installedConfig = run(dshExecutable, ['--profile', 'web', '--dump-config'], {
    env: environment,
    label: 'installed config',
  })
  transcript.push(installedConfig)
  invariant(countExactLine(installedConfig.stdout, 'name: dsh-codex-sub') === 1, 'Expected one plugin row.')
  invariant(countExactLine(installedConfig.stdout, `- id: ${PLUGIN_ROW_ID}`) === 1, 'Expected the stable plugin row ID.')
  invariant(countExactLine(installedConfig.stdout, '# == dsh-codex-sub') === 1, 'Expected one bundle layer.')

  const topology = await inspectDependencyTopology(dshHome, compatibility)
  const bootOutput = {
    stderr: { bytes: 0, truncated: false, value: '' },
    stdout: { bytes: 0, truncated: false, value: '' },
  }
  const previousNodeOptions = environment.NODE_OPTIONS?.trim()
  const bootEnvironment = {
    ...environment,
    DSH_CODEX_SUB_PROBE_RESULT: resultPath,
    NODE_OPTIONS: [previousNodeOptions, `--import=${pathToFileURL(blockerPath).href}`]
      .filter(Boolean)
      .join(' '),
    SSH_CONNECTION: 'packed-install-probe',
  }
  const child = spawn(dshExecutable, ['--profile', 'web', '--port', '0'], {
    cwd: repositoryRoot,
    env: bootEnvironment,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => appendCapture(bootOutput.stdout, chunk))
  child.stderr.on('data', (chunk) => appendCapture(bootOutput.stderr, chunk))
  let probeText
  let bootFailure
  try {
    probeText = await waitForProbe(child, resultPath)
  } catch (error) {
    bootFailure = error
  } finally {
    await stopChild(child)
  }
  transcript.push({ status: child.exitCode, stdout: bootOutput.stdout.value, stderr: bootOutput.stderr.value })
  if (bootOutput.stdout.truncated || bootOutput.stderr.truncated) {
    throw new Error('DSH output exceeded the packed-install capture limit.')
  }
  if (bootFailure !== undefined) {
    throw new Error(
      `${String(bootFailure)}\n${redactTestOutput(
        `${bootOutput.stdout.value}\n${bootOutput.stderr.value}`,
      )}`,
    )
  }
  const probe = parseJson(probeText, 'packed-install probe')
  invariant(probe.providerOccurrences === 1, 'Packed provider route was not unique.')
  invariant(probe.providerDisplayMatches === true, 'Packed provider display metadata drifted.')
  invariant(Number.isSafeInteger(probe.modelCount) && probe.modelCount > 0, 'Packed catalog was empty.')
  invariant(probe.catalogIdsAreUnique === true, 'Packed catalog contained duplicate model IDs.')
  invariant(probe.resolvedMatches === true, 'Packed model resolution changed identity.')
  invariant(probe.duplicateCode === 'DUPLICATE_ADAPTER', 'Packed duplicate-route guard did not fire.')
  invariant(probe.routeOccurrencesAfterConflict === 1, 'Duplicate registration disturbed the route.')
  invariant(probe.authFailureCode === 'CODEX_AUTH_REQUIRED', 'Signed-out streaming did not fail before provider I/O.')
  invariant(probe.networkAttempts === 0, 'Packed signed-out boot attempted network access.')

  const signedOut = run(dshExecutable, [
    'plugin', '--profile', 'web', 'exec', PACKAGE_NAME, 'status', '--json',
  ], { accepted: [1], env: environment, label: 'signed-out status' })
  transcript.push(signedOut)
  const signedOutReport = parseJson(signedOut.stdout, 'signed-out status')
  invariant(signedOutReport.status?.state === 'signed-out', 'Packaged CLI did not report signed out.')

  const doctor = run(dshExecutable, [
    'plugin', '--profile', 'web', 'exec', PACKAGE_NAME, 'doctor', '--json',
  ], { env: environment, label: 'doctor' })
  transcript.push(doctor)
  const doctorReport = parseJson(doctor.stdout, 'doctor')
  invariant(doctorReport.overall === 'compatible', 'Packaged doctor did not report compatible.')
  invariant(doctorReport.catalog?.modelCount === probe.modelCount, 'CLI and Host catalog counts disagreed.')

  const authDirectory = join(dshHome, PACKAGE_NAME)
  const authFile = join(authDirectory, 'auth.json')
  await mkdir(authDirectory, { mode: 0o700, recursive: true })
  await chmod(authDirectory, 0o700)
  const credentialBytes = `${JSON.stringify({
    schemaVersion: 1,
    provider: PROVIDER_ID,
    credential: {
      accessToken: sentinels[0],
      refreshToken: sentinels[1],
      expiresAt: Date.now() + 86_400_000,
      providerData: { accountId: sentinels[2] },
    },
  })}\n`
  await writeFile(authFile, credentialBytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  await chmod(authFile, 0o600)

  const signedIn = run(dshExecutable, [
    'plugin', '--profile', 'web', 'exec', PACKAGE_NAME, 'status', '--json',
  ], { env: environment, label: 'signed-in status' })
  transcript.push(signedIn)
  const signedInReport = parseJson(signedIn.stdout, 'signed-in status')
  invariant(signedInReport.status?.state === 'signed-in', 'Packaged CLI did not read its credential.')

  transcript.push(run(dshExecutable, [
    'plugin', '--profile', 'web', 'remove', PROBE_NAME,
  ], { env: environment, label: 'probe uninstall' }))
  transcript.push(run(dshExecutable, [
    'plugin', '--profile', 'web', 'remove', PACKAGE_NAME,
  ], { env: environment, label: 'package uninstall' }))
  const removedConfig = run(dshExecutable, ['--profile', 'web', '--dump-config'], {
    env: environment,
    label: 'removed config',
  })
  transcript.push(removedConfig)
  invariant(countExactLine(removedConfig.stdout, 'name: dsh-codex-sub') === 0, 'Plugin row survived uninstall.')
  invariant(countExactLine(removedConfig.stdout, `- id: ${PLUGIN_ROW_ID}`) === 0, 'Plugin row ID survived uninstall.')
  invariant(await readFile(authFile, 'utf8') === credentialBytes, 'Uninstall changed package credentials.')
  transcript.push(run(dshExecutable, [
    'plugin', '--profile', 'web', 'exec', PACKAGE_NAME, 'version',
  ], { accepted: [1], env: environment, label: 'removed executable lookup' }))

  transcript.push(run(dshExecutable, [
    'plugin',
    '--profile',
    'web',
    'add',
    packageTarball,
    '--save-exact',
    '--allow-build=@google/genai',
    '--allow-build=protobufjs',
  ], { env: environment, label: 'package reinstall' }))
  const siblingFile = join(authDirectory, 'keep.txt')
  await writeFile(siblingFile, 'preserve\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const logout = run(dshExecutable, [
    'plugin', '--profile', 'web', 'exec', PACKAGE_NAME, 'logout',
  ], { env: environment, label: 'logout' })
  transcript.push(logout)
  await assertAbsent(authFile, 'Logout did not remove the credential document.')
  invariant(await readFile(siblingFile, 'utf8') === 'preserve\n', 'Logout removed another package-owned file.')

  const printable = JSON.stringify(transcript)
  for (const sentinel of sentinels) {
    invariant(!printable.includes(sentinel), 'A generated credential sentinel entered command output.')
  }

  process.stdout.write(`${JSON.stringify({
    catalogModelCount: probe.modelCount,
    configRows: 1,
    credentialPreservedOnUninstall: true,
    logoutRemovedOnlyCredential: true,
    networkAttempts: 0,
    packedFiles,
    topology,
  })}\n`)
} finally {
  await rm(temporaryRoot, { force: true, recursive: true })
}
