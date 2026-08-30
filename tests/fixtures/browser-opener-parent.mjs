import { spawn as nodeSpawn } from 'node:child_process'

import { createSafeBrowserOpener } from '../../src/cli/browser-opener.ts'

process.env['DISPLAY'] = ':99'
delete process.env['XDG_RUNTIME_DIR']
delete process.env['WAYLAND_DISPLAY']
delete process.env['DBUS_SESSION_BUS_ADDRESS']

const child = nodeSpawn(process.execPath, [
  '-e',
  'process.stdout.write("READY " + process.pid + "\\n"); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
], {
  shell: false,
  stdio: ['ignore', 'pipe', 'ignore'],
  env: { PATH: '/usr/bin:/bin', DISPLAY: ':99' },
})

const readyPid = await new Promise((resolve, reject) => {
  let output = ''
  const onData = (chunk) => {
    output += chunk.toString('utf8')
    const match = /^READY (\d+)$/mu.exec(output)
    if (match !== null) {
      child.stdout?.removeListener('data', onData)
      resolve(Number(match[1]))
    }
  }
  child.stdout?.on('data', onData)
  child.once('error', reject)
})

// Report the PID before the opener starts its timeout clock. The child is
// intentionally left alive for the outer test to kill and reap.
process.stdout.write(`READY ${readyPid}\n`)
child.stdout?.resume()
child.stdout?.unref?.()

const launchProcess = {
  on(event, listener) {
    child.on(event, listener)
    return this
  },
  removeListener(event, listener) {
    child.removeListener(event, listener)
    return this
  },
  kill(signal) {
    return child.kill(signal)
  },
  unref() {
    if (process.env['CODEX_NOOP_UNREF'] !== '1') {
      child.unref()
    }
  },
}

const opened = await createSafeBrowserOpener({
  platform: process.platform,
  spawn: () => launchProcess,
  timeoutMs: 100,
}).open('https://auth.example.test/authorize')
process.stdout.write(`SETTLED ${String(opened)}\n`)
