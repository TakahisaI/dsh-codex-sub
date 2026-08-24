import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

import {
  assertCurrentCandidateReleaseNote,
  assertPublishedReleaseRecordHashes,
  PUBLISHED_RELEASE_RECORD_SHA256,
  selectCurrentUnpublishedCandidateNotes,
} from '../scripts/compatibility-release-notes.mjs'

describe('compatibility candidate release-note selection', () => {
  it('does not apply the current baseline to historical publication records', () => {
    const notes = [
      {
        filename: 'docs/releases/0.1.0-alpha.0.md',
        text: '# 0.1.0-alpha.0 release notes\n\n> Release candidate. This version has not been published.\n',
      },
      {
        filename: 'docs/releases/0.1.0-alpha.1.md',
        text: '# 0.1.0-alpha.1 release notes\n\n> Release candidate. This version has not been published.\n',
      },
    ]
    expect(selectCurrentUnpublishedCandidateNotes(notes, '0.1.0-alpha.2')).toEqual([])
  })

  it('selects only the current version note with the candidate marker and unpublished evidence', () => {
    const selected = selectCurrentUnpublishedCandidateNotes([
      {
        filename: 'docs/releases/0.1.0-alpha.1.md',
        text: '# 0.1.0-alpha.1 release notes\n\n> Release candidate. This version has not been published.\n',
      },
      {
        filename: 'docs/releases/0.1.0-alpha.2.md',
        text: '# 0.1.0-alpha.2 release notes\n\n> Release candidate. This version has not been published.\n',
      },
      {
        filename: 'docs/releases/0.1.0-alpha.2-draft.md',
        text: '# 0.1.0-alpha.2 release notes\n\n> Release candidate. This version has not been published.\n',
      },
    ], '0.1.0-alpha.2')
    expect(selected.map(({ filename }) => filename)).toEqual(['docs/releases/0.1.0-alpha.2.md'])
  })

  it('keeps the published alpha.0 and alpha.1 records byte-identical while checking selection', async () => {
    const [alpha0, alpha1] = await Promise.all([
      readFile(new URL('../docs/releases/0.1.0-alpha.0.md', import.meta.url), 'utf8'),
      readFile(new URL('../docs/releases/0.1.0-alpha.1.md', import.meta.url), 'utf8'),
    ])
    expect(selectCurrentUnpublishedCandidateNotes([
      { filename: 'docs/releases/0.1.0-alpha.0.md', text: alpha0 },
      { filename: 'docs/releases/0.1.0-alpha.1.md', text: alpha1 },
    ], '0.1.0-alpha.2')).toEqual([])
    expect(alpha0).toContain('0.1.0-rc.7')
    expect(alpha1).toContain('0.1.0-rc.7')
    expect(() => assertPublishedReleaseRecordHashes([
      { filename: 'docs/releases/0.1.0-alpha.0.md', text: alpha0 },
      { filename: 'docs/releases/0.1.0-alpha.1.md', text: alpha1 },
    ])).not.toThrow()
  })

  it('rejects a one-byte mutation in a published record', () => {
    const original = 'published record'
    const filename = 'docs/releases/0.1.0-alpha.0.md'
    const expected = PUBLISHED_RELEASE_RECORD_SHA256[filename]
    expect(expected).toMatch(/^[0-9a-f]{64}$/u)
    expect(() => assertPublishedReleaseRecordHashes([
      { filename, text: `${original}x` },
      { filename: 'docs/releases/0.1.0-alpha.1.md', text: 'other' },
    ])).toThrow('Published release record changed')
  })

  it('rejects a missing or unmarked current candidate note', () => {
    expect(() => assertCurrentCandidateReleaseNote([], '0.1.0-alpha.2')).toThrow(
      'Expected exactly one unpublished candidate release note',
    )
    expect(() => assertCurrentCandidateReleaseNote([
      {
        filename: 'docs/releases/0.1.0-alpha.2.md',
        text: '# 0.1.0-alpha.2 release notes\n\nCandidate without the marker.\n',
      },
    ], '0.1.0-alpha.2')).toThrow('Expected exactly one unpublished candidate release note')
  })
})
