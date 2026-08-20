import {
  spawn,
  spawnSync,
} from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import packageDocument from '../package.json' with { type: 'json' }

const result = spawnSync(process.execPath, ['lib/bin.mjs', 'version'], {
  encoding: 'utf8',
  shell: false,
})

if (
  result.status !== 0
  || result.stdout !== `${packageDocument.version}\n`
  || result.stderr !== ''
) {
  throw new Error('Built CLI did not expose the package version contract.')
}

const lingeringHandle = spawnSync(process.execPath, [
  '--import',
  'data:text/javascript,setInterval(() => {}, 1000)',
  'lib/bin.mjs',
  'version',
], {
  encoding: 'utf8',
  shell: false,
  timeout: 2_000,
})

if (
  lingeringHandle.status !== 0
  || lingeringHandle.signal !== null
  || lingeringHandle.error !== undefined
  || lingeringHandle.stdout !== `${packageDocument.version}\n`
  || lingeringHandle.stderr !== ''
) {
  throw new Error('Built CLI did not terminate after the command settled.')
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-codex-sub-built-cli-'))
const secretSentinel = `ACCESS_SENTINEL_${randomUUID()}`

async function runDoctorWithReadThenCloseConsumer(environment) {
  const child = spawn(process.execPath, ['lib/bin.mjs', 'doctor', '--json'], {
    env: environment,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let completeLine = false
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    if (completeLine) {
      return
    }
    stdout += chunk
    const newline = stdout.indexOf('\n')
    if (newline !== -1) {
      stdout = stdout.slice(0, newline + 1)
      completeLine = true
      child.stdout.destroy()
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const [status, signal] = await once(child, 'close')
  let report
  try {
    report = JSON.parse(stdout)
  } catch {
    throw new Error('Read-then-close consumer did not receive complete doctor JSON.')
  }
  if (
    !completeLine
    || status !== 0
    || signal !== null
    || stderr !== ''
    || !stdout.endsWith('\n')
    || report.schemaVersion !== 1
    || report.overall !== 'compatible'
  ) {
    throw new Error('Read-then-close consumer changed the built CLI result.')
  }
}

try {
  const childEnvironment = {
    ...process.env,
    DSH_CODEX_SUB_UNUSED_SECRET: secretSentinel,
    DSH_HOME: join(temporaryRoot, 'dsh-home'),
  }
  const doctor = spawnSync(process.execPath, ['lib/bin.mjs', 'doctor', '--json'], {
    encoding: 'utf8',
    env: childEnvironment,
    shell: false,
  })
  let report
  try {
    report = JSON.parse(doctor.stdout)
  } catch {
    throw new Error('Built CLI doctor output was not complete JSON.')
  }
  if (
    doctor.status !== 0
    || doctor.stderr !== ''
    || !doctor.stdout.endsWith('\n')
    || doctor.stdout.trim().split('\n').length !== 1
    || report.schemaVersion !== 1
    || report.overall !== 'compatible'
    || `${doctor.stdout}\n${doctor.stderr}`.includes(secretSentinel)
    || `${doctor.stdout}\n${doctor.stderr}`.includes(temporaryRoot)
  ) {
    throw new Error('Built CLI doctor output violated the complete JSON contract.')
  }
  for (let iteration = 0; iteration < 5; iteration += 1) {
    await runDoctorWithReadThenCloseConsumer(childEnvironment)
  }
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true })
}

process.stdout.write('Built CLI flushes complete output and terminates deterministically.\n')
