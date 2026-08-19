import { posix } from 'node:path'
import { PACKAGE_FILE_ALLOWLIST } from './package-files.mjs'

const PACKED_FILES = new Set(PACKAGE_FILE_ALLOWLIST)

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function markdownDestinations(markdown) {
  const inline = [...markdown.matchAll(
    /!?\[[^\]]*\]\(\s*<?([^>\s)]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/gu,
  )].map((match) => match[1])
  const references = [...markdown.matchAll(
    /^\s{0,3}\[[^\]]+\]:\s*<?([^>\s]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/gmu,
  )].map((match) => match[1])
  return [...inline, ...references]
}

export function assertPackageReadmeLinks(markdown, label) {
  invariant(typeof markdown === 'string', `${label} must be UTF-8 Markdown text.`)
  for (const destination of markdownDestinations(markdown)) {
    invariant(destination !== undefined, `${label} contained an incomplete Markdown link.`)
    if (destination.startsWith('#') || destination.startsWith('https://')) {
      continue
    }
    invariant(
      !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(destination),
      `${label} link must use HTTPS: ${destination}`,
    )
    const path = destination.split(/[?#]/u, 1)[0]
    invariant(path !== undefined && path.length > 0, `${label} contained an empty link target.`)
    const normalized = posix.normalize(path.replace(/^\.\//u, ''))
    invariant(
      PACKED_FILES.has(normalized),
      `${label} link target is not available from the package: ${destination}`,
    )
  }
}
