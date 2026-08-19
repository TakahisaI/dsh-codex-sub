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

process.stdout.write('Built CLI exposes the package version contract.\n')
