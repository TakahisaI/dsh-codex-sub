const networkCounter = '__DSH_CODEX_SUB_NETWORK_ATTEMPTS__'

globalThis[networkCounter] = 0
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  value: async () => {
    globalThis[networkCounter] += 1
    throw new Error('Network access is disabled during the packed-install probe.')
  },
  writable: true,
})
