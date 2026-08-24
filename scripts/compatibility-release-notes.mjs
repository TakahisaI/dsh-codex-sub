import { createHash } from 'node:crypto'

export const PUBLISHED_RELEASE_RECORD_SHA256 = Object.freeze({
  'docs/releases/0.1.0-alpha.0.md': '3ca568794ef9546edcd821c8e89317beffcd51a88bfa96ce07e04d1225bb95f6',
  'docs/releases/0.1.0-alpha.1.md': '90ce33545879dc153d596229a42f3d57a0f44c830d2c45e4c4eec24e1b971dd7',
})

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * Select only the unpublished candidate note for the package currently being
 * checked. Historical release records are immutable evidence and must not be
 * required to repeat a newer compatibility baseline.
 */
export function selectCurrentUnpublishedCandidateNotes(notes, packageVersion) {
  const expectedFilename = `docs/releases/${packageVersion}.md`
  return notes.filter(({ filename, text }) => (
    filename === expectedFilename
      && text.startsWith(`# ${packageVersion} release notes\n`)
      && text.includes('> Release candidate.')
      && text.includes('has not been published')
  ))
}

export function assertPublishedReleaseRecordHashes(notes) {
  const byFilename = new Map(notes.map(note => [note.filename, note.text]))
  for (const [filename, expected] of Object.entries(PUBLISHED_RELEASE_RECORD_SHA256)) {
    const text = byFilename.get(filename)
    invariant(text !== undefined, `Published release record is missing: ${filename}.`)
    const actual = createHash('sha256').update(text, 'utf8').digest('hex')
    invariant(actual === expected, `Published release record changed: ${filename}.`)
  }
}

export function assertCurrentCandidateReleaseNote(notes, packageVersion) {
  const selected = selectCurrentUnpublishedCandidateNotes(notes, packageVersion)
  invariant(
    selected.length === 1,
    `Expected exactly one unpublished candidate release note for ${packageVersion}.`,
  )
  return selected[0]
}
