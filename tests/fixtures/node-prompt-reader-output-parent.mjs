import { PassThrough, Writable } from 'node:stream'

import { NodePromptReader } from '../../src/cli/node-prompt-reader.ts'

const mode = process.argv[2]
if (mode !== 'prompt' && mode !== 'newline') {
  throw new Error('fixture mode must be prompt or newline')
}

let uncaught = false
process.on('uncaughtException', (error) => {
  uncaught = true
  process.stdout.write(`UNCAUGHT ${error instanceof Error ? error.message : String(error)}\n`)
})

class AsyncFailureWritable extends Writable {
  _write(chunk, _encoding, callback) {
    const text = chunk.toString('utf8')
    const shouldFail = mode === 'prompt'
      ? text === 'Secret: '
      : text === '\n'
    if (shouldFail) {
      setImmediate(() => callback(new Error(`${mode} async output failure sentinel`)))
      return
    }
    callback()
  }
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

const input = new PassThrough()
const output = new AsyncFailureWritable()
const reader = new NodePromptReader(input, output)
const pending = reader.read('Secret: ', { hidden: true })

let result
if (mode === 'prompt') {
  result = await Promise.race([
    pending.then(
      () => 'UNEXPECTED_SUCCESS',
      (error) => `${error?.code ?? 'UNKNOWN'} ${error?.safeDetails?.reason ?? 'unknown'}`,
    ),
    new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 1_000)),
  ])
} else {
  input.write('answer\n')
  result = await pending.then(
    (answer) => `SUCCESS ${answer}`,
    (error) => `UNEXPECTED_FAILURE ${error?.code ?? 'UNKNOWN'}`,
  )
}

// The `_write` callback and the subsequent `error` event are both deferred.
await nextTurn()
await nextTurn()
process.stdout.write(`RESULT ${String(result)}\n`)
if (uncaught || result === 'TIMEOUT' || result === 'UNEXPECTED_SUCCESS') {
  process.exitCode = 91
}
