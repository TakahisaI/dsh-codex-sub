import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validatePackageTarball } from './package-tarball.mjs'

const CHECKSUM_FILENAME = 'SHA256SUMS'
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function parseCommandLine(arguments_) {
  const { positionals, values } = parseArgs({
    args: arguments_,
    allowPositionals: true,
    options: {
      directory: { type: 'string' },
      'github-output': { type: 'boolean', default: false },
    },
    strict: true,
  })
  invariant(positionals.length === 1, 'Expected exactly one command: create or verify.')
  invariant(positionals[0] === 'create' || positionals[0] === 'verify', 'Command must be create or verify.')
  invariant(values.directory !== undefined, '--directory is required.')
  invariant(isAbsolute(values.directory), '--directory must be an absolute path.')
  invariant(
    positionals[0] === 'verify' || values['github-output'] === false,
    '--github-output is valid only with verify.',
  )
  return {
    command: positionals[0],
    directory: values.directory,
    githubOutput: values['github-output'],
  }
}

function runPack(directory) {
  const result = spawnSync('pnpm', ['pack', '--pack-destination', directory, '--json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    shell: false,
  })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('Package artifact construction failed.')
  }
  try {
    return JSON.parse(result.stdout ?? '')
  } catch {
    throw new Error('Package artifact construction did not return valid JSON.')
  }
}

async function assertEmptyDirectory(directory) {
  await mkdir(directory, { recursive: true })
  invariant((await readdir(directory)).length === 0, 'Release artifact directory must be empty.')
}

async function createArtifact(directory) {
  await assertEmptyDirectory(directory)
  const report = runPack(directory)
  invariant(typeof report.filename === 'string', 'Package artifact filename was missing.')
  const tarballPath = isAbsolute(report.filename)
    ? report.filename
    : join(directory, report.filename)
  const validated = await validatePackageTarball(tarballPath)
  const checksumText = `${validated.sha256}  ${basename(validated.canonicalPath)}\n`
  await writeFile(join(directory, CHECKSUM_FILENAME), checksumText, {
    encoding: 'utf8',
    flag: 'wx',
  })
  return validated
}

async function verifyArtifact(directory) {
  const entries = (await readdir(directory)).sort()
  const tarballs = entries.filter((entry) => entry.endsWith('.tgz'))
  invariant(
    entries.length === 2 && tarballs.length === 1 && entries.includes(CHECKSUM_FILENAME),
    'Release artifact must contain exactly one package tarball and SHA256SUMS.',
  )
  const tarballName = tarballs[0]
  invariant(tarballName !== undefined, 'Release artifact package tarball was missing.')
  const tarballPath = join(directory, tarballName)
  const validated = await validatePackageTarball(tarballPath)
  const checksumText = await readFile(join(directory, CHECKSUM_FILENAME), 'utf8')
  invariant(
    checksumText === `${validated.sha256}  ${tarballName}\n`,
    'Release artifact SHA-256 did not match the package tarball.',
  )
  return validated
}

const options = parseCommandLine(process.argv.slice(2))
const result = options.command === 'create'
  ? await createArtifact(options.directory)
  : await verifyArtifact(options.directory)

if (options.githubOutput) {
  const githubOutput = process.env.GITHUB_OUTPUT
  invariant(githubOutput !== undefined && isAbsolute(githubOutput), 'GITHUB_OUTPUT must be an absolute path.')
  await appendFile(
    githubOutput,
    `package-tarball=${result.canonicalPath}\nsha256=${result.sha256}\n`,
    'utf8',
  )
}

process.stdout.write(`${JSON.stringify({
  packageTarball: basename(result.canonicalPath),
  sha256: result.sha256,
})}\n`)
