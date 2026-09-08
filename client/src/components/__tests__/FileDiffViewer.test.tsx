import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import i18n from '@/i18n'
import { FileDiffViewer } from '../FileDiffViewer'

const baseProps = {
  file: 'media/lua/shared/Recipes.lua',
  modAId: 'modA',
  modBId: 'modB',
  modAName: 'Café Mod',
  modBName: 'Zombie Overhaul',
  severity: 'high' as const,
}

function textDiff(overrides: Partial<any> = {}) {
  return {
    type: 'text',
    ext: '.lua',
    modA: { size: 100, lineCount: 10 },
    modB: { size: 120, lineCount: 12 },
    hunks: [
      { startA: 1, startB: 1, countA: 1, countB: 1, lines: [{ type: 'remove', text: 'old line', lineA: 3 }, { type: 'add', text: 'new line', lineB: 3 }] },
    ],
    totalAdded: 1,
    totalRemoved: 1,
    ...overrides,
  }
}

// 2026-09-08 (auth-transport-parity sibling): FileDiffViewer now goes through
// apiFetch()/handleResponse() instead of a raw fetch() -- handleResponse's
// own parseResponseBody() reads response.headers.get('content-type') before
// it ever calls .json(), so a mock lacking a real `headers` object (this
// file's loose `{ ok, status, json }` shape, cast `as any`) throws before
// reaching the behavior under test. Real Response objects instead of loose
// fakes -- less to keep in sync with handleResponse's own expectations, and
// it's what apiFetch actually receives from fetch() in production.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

describe('FileDiffViewer', () => {
  it('does not fetch the diff until the row is expanded -- no wasted requests for collapsed rows', () => {
    render(<FileDiffViewer {...baseProps} />)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fetches and renders the real added/removed counts on first expand', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(textDiff()))
    render(<FileDiffViewer {...baseProps} />)

    fireEvent.click(screen.getByRole('button', { name: /Recipes.lua/ }))

    expect(await screen.findByText('+1')).toBeInTheDocument()
    expect(screen.getByText('-1')).toBeInTheDocument()
    expect(screen.getByText('old line')).toBeInTheDocument()
    expect(screen.getByText('new line')).toBeInTheDocument()
  })

  it('does not re-fetch on a second click -- it just collapses/re-expands from cache', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(textDiff()))
    render(<FileDiffViewer {...baseProps} />)

    const row = screen.getByRole('button', { name: /Recipes.lua/ })
    fireEvent.click(row)
    await screen.findByText('+1')
    fireEvent.click(row) // collapse
    fireEvent.click(row) // re-expand

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(screen.getByText('+1')).toBeInTheDocument()
  })

  it('surfaces a real fetch error, not a silently empty panel', async () => {
    // 2026-08-26: this fetch bypasses lib/api.ts's handleResponse(), so the
    // component constructs an ApiError itself (status + code preserved) and
    // routes it through getUserErrorMessage() -- a 500 with no code now gets
    // wrapUncodedServerError()'s generic wrapper around the preserved raw
    // detail, so the displayed text CONTAINS the server's message rather
    // than being byte-identical to it. Regex match, not exact, so this
    // doesn't need updating every time that wrapper's copy changes.
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'diff service unavailable' }, 500))
    render(<FileDiffViewer {...baseProps} />)

    fireEvent.click(screen.getByRole('button', { name: /Recipes.lua/ }))

    expect(await screen.findByText(/diff service unavailable/)).toBeInTheDocument()
  })

  it('Retry after a failure actually re-fetches, not a no-op button', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
      .mockResolvedValueOnce(jsonResponse(textDiff()))
    render(<FileDiffViewer {...baseProps} />)

    fireEvent.click(screen.getByRole('button', { name: /Recipes.lua/ }))
    await screen.findByText(/boom/)

    fireEvent.click(screen.getByRole('button', { name: 'Retry file comparison' }))

    expect(await screen.findByText('+1')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  // 2026-08-26: before this fix, the fetch here threw a plain Error built
  // from res.status/body.code discarded -- so a registered, already-
  // translated code (mods.js emits MODS_CONFLICTS_DIFF_FILES_NOT_FOUND)
  // never reached getUserErrorMessage() at all and every locale saw the
  // same raw English text. Proves the fix actually unlocks that dormant
  // translation, not just that it doesn't crash.
  describe('translates a registered error code once status/code survive the fetch', () => {
    afterEach(() => {
      void i18n.changeLanguage('en')
    })

    it('shows the French translation for a coded 4xx instead of the raw English text', async () => {
      void i18n.changeLanguage('fr')
      vi.mocked(fetch).mockResolvedValue(jsonResponse({
        error: 'Could not find both mod files on disk — they may have been removed or updated since the last scan',
        code: 'MODS_CONFLICTS_DIFF_FILES_NOT_FOUND',
      }, 404))
      render(<FileDiffViewer {...baseProps} />)

      fireEvent.click(screen.getByRole('button', { name: /Recipes.lua/ }))

      expect(await screen.findByText(/Impossible de trouver les deux fichiers de mod/)).toBeInTheDocument()
    })
  })

  it('renders the real hash/size for a binary file instead of pretending it has a text diff', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({
      type: 'binary', ext: '.png',
      modA: { size: 2048, hash: 'aaaaaaaaaaaaaaaa' },
      modB: { size: 4096, hash: 'bbbbbbbbbbbbbbbb' },
    }))
    render(<FileDiffViewer {...baseProps} file="media/textures/icon.png" />)

    fireEvent.click(screen.getByRole('button', { name: /icon\.png/ }))

    expect(await screen.findByText(/Binary file/)).toBeInTheDocument()
    expect(screen.getByText(/2\.0 KB/)).toBeInTheDocument()
    expect(screen.getByText(/4\.0 KB/)).toBeInTheDocument()
    expect(screen.getByText(/aaaaaaaa/)).toBeInTheDocument()
  })

  it('caps visible hunks and Show more reveals the rest, rather than dumping or silently hiding them', async () => {
    const hunks = Array.from({ length: 5 }, (_, i) => ({
      startA: i, startB: i, countA: 1, countB: 1,
      lines: [{ type: 'context' as const, text: `hunk-${i}`, lineA: i, lineB: i }],
    }))
    vi.mocked(fetch).mockResolvedValue(jsonResponse(textDiff({ hunks, totalAdded: 0, totalRemoved: 0 })))
    render(<FileDiffViewer {...baseProps} />)

    fireEvent.click(screen.getByRole('button', { name: /Recipes.lua/ }))
    await screen.findByText('hunk-0')

    expect(screen.queryByText('hunk-4')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Show 2 more sections/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Show 2 more sections/ }))
    expect(screen.getByText('hunk-4')).toBeInTheDocument()
  })

  it('renders an accented mod name in the diff header verbatim', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(textDiff()))
    render(<FileDiffViewer {...baseProps} />)

    fireEvent.click(screen.getByRole('button', { name: /Recipes.lua/ }))
    await screen.findByText('+1')
    expect(screen.getByTitle('Café Mod')).toBeInTheDocument()
  })

  it('explains what "shadowed" means as real content when the row is expanded, not just in the badge\'s hover title', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(textDiff()))
    render(<FileDiffViewer {...baseProps} overlap={{ kind: 'lua-shadow', items: [], total: 0 }} />)

    // Sighted on a mouse, the explanation is already reachable via the
    // compact badge's hover title -- confirm that's still there too.
    expect(screen.getByTitle(/no symbol names overlap/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Recipes.lua/ }))
    await screen.findByText('+1')

    // A touch user who taps the row open (no hover available) must be able
    // to read the same explanation as real, visible content.
    expect(screen.getByText(/no symbol names overlap/)).toBeInTheDocument()
  })
})
