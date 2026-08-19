import { spawnSync } from 'node:child_process'

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

process.stdout.write('Built CLI exposes the version contract and terminates deterministically.\n')
