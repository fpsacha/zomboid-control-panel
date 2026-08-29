import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { WorkshopCollectionPanel } from '../WorkshopCollectionPanel'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import { modsApi } from '@/lib/api'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    modsApi: {
      ...actual.modsApi,
      collectionDiff: vi.fn(),
      purgeMod: vi.fn(),
      collectionRemoveItem: vi.fn(),
      collectionAddItem: vi.fn(),
      trackMod: vi.fn(),
      collectionUntrack: vi.fn(),
      addToIni: vi.fn(),
      batchRemove: vi.fn(),
    },
  }
})

const toastSpy = vi.fn()
vi.mock('@/components/ui/use-toast', async () => {
  const actual = await vi.importActual<typeof import('@/components/ui/use-toast')>('@/components/ui/use-toast')
  return {
    ...actual,
    useToast: () => ({ toast: toastSpy, toasts: [], dismiss: vi.fn() }),
  }
})

const collectionDiff = vi.mocked(modsApi.collectionDiff)
const purgeMod = vi.mocked(modsApi.purgeMod)
const collectionUntrack = vi.mocked(modsApi.collectionUntrack)
const collectionAddItem = vi.mocked(modsApi.collectionAddItem)

// A name with accents/non-ASCII, since the panel is the primary place an
// operator sees Workshop titles rendered verbatim from Steam.
const ACCENTED_NAME = 'Café Épée & Bouclier Ünïcode Mod'

function baseDiff(items: any[]) {
  return {
    ok: true,
    items,
    collectionId: 'coll-1',
    autoSync: true,
    hasCredentials: true,
    tokenExpiry: null,
    tokenExpired: false,
    trackedCount: items.length,
  }
}

beforeEach(() => {
  collectionDiff.mockReset()
  purgeMod.mockReset()
  collectionUntrack.mockReset()
  collectionAddItem.mockReset()
  toastSpy.mockReset()
})

async function renderPanel(items: any[]) {
  collectionDiff.mockResolvedValue(baseDiff(items) as any)
  render(
    <MemoryRouter>
      <TooltipProvider>
        <ConfirmProvider>
          <WorkshopCollectionPanel />
        </ConfirmProvider>
      </TooltipProvider>
    </MemoryRouter>
  )
  await waitFor(() => expect(collectionDiff).toHaveBeenCalled())
}

describe('WorkshopCollectionPanel', () => {
  it('takes Configure directly to the Mods settings tab', async () => {
    await renderPanel([])
    expect(screen.getByRole('link', { name: /configure/i })).toHaveAttribute('href', '/settings?tab=mods')
  })

  it('renders an accented, non-ASCII mod name verbatim -- not stripped or mangled', async () => {
    await renderPanel([
      { workshopId: '111', name: ACCENTED_NAME, status: 'to-add', inTracked: true, inCollection: false, inServer: false },
    ])
    expect(await screen.findByText(ACCENTED_NAME)).toBeInTheDocument()
  })

  it('does NOT purge on a single click of "Remove everywhere" -- it only opens a confirmation', async () => {
    await renderPanel([
      { workshopId: '111', name: ACCENTED_NAME, status: 'to-add', inTracked: true, inCollection: false, inServer: false },
    ])
    await screen.findByText(ACCENTED_NAME)

    fireEvent.pointerDown(screen.getByTitle('More'), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByText('Remove everywhere'))

    // The dialog must appear, naming the real mod, before anything destructive happens.
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByText(`Remove ${ACCENTED_NAME} everywhere?`)).toBeInTheDocument()
    expect(purgeMod).not.toHaveBeenCalled()
  })

  it('Cancel on the purge dialog leaves the mod untouched', async () => {
    await renderPanel([
      { workshopId: '111', name: ACCENTED_NAME, status: 'to-add', inTracked: true, inCollection: false, inServer: false },
    ])
    await screen.findByText(ACCENTED_NAME)

    fireEvent.pointerDown(screen.getByTitle('More'), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByText('Remove everywhere'))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(purgeMod).not.toHaveBeenCalled()
  })

  it('confirming the purge dialog calls purgeMod exactly once with the real workshop id and name', async () => {
    purgeMod.mockResolvedValue({
      success: true,
      workshopId: '111',
      name: ACCENTED_NAME,
      collection: { attempted: false, ok: false, error: null },
      deletedFromDisk: true,
      modIdsStripped: 1,
      mapFoldersStripped: 0,
    } as any)
    await renderPanel([
      { workshopId: '111', name: ACCENTED_NAME, status: 'to-add', inTracked: true, inCollection: false, inServer: false },
    ])
    await screen.findByText(ACCENTED_NAME)

    fireEvent.pointerDown(screen.getByTitle('More'), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByText('Remove everywhere'))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove everywhere' }))

    await waitFor(() => expect(purgeMod).toHaveBeenCalledTimes(1))
    expect(purgeMod).toHaveBeenCalledWith('111', ACCENTED_NAME)
  })

  it('the confirm click is a one-shot -- the dialog closes immediately and cannot double-fire the purge', async () => {
    let resolvePurge: (v: any) => void
    purgeMod.mockReturnValue(new Promise((resolve) => { resolvePurge = resolve }))
    await renderPanel([
      { workshopId: '111', name: ACCENTED_NAME, status: 'to-add', inTracked: true, inCollection: false, inServer: false },
    ])
    await screen.findByText(ACCENTED_NAME)

    fireEvent.pointerDown(screen.getByTitle('More'), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByText('Remove everywhere'))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove everywhere' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    resolvePurge!({
      success: true, workshopId: '111', name: ACCENTED_NAME,
      collection: { attempted: false, ok: false, error: null }, deletedFromDisk: true,
      modIdsStripped: 0, mapFoldersStripped: 0,
    })
    expect(purgeMod).toHaveBeenCalledTimes(1)
  })

  it('the safe, non-destructive Track action still works and does not require any confirmation', async () => {
    await renderPanel([
      { workshopId: '222', name: ACCENTED_NAME, status: 'to-add', inTracked: false, inCollection: false, inServer: false },
    ])
    await screen.findByText(ACCENTED_NAME)

    fireEvent.click(screen.getByRole('button', { name: 'Track' }))

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await waitFor(() => expect(vi.mocked(modsApi.trackMod)).toHaveBeenCalledWith('222'))
  })

  it('a failed row action surfaces failure and does not silently mark the mod as untracked', async () => {
    collectionUntrack.mockRejectedValue(new Error('server rejected untrack'))
    await renderPanel([
      { workshopId: '333', name: ACCENTED_NAME, status: 'to-add', inTracked: true, inCollection: false, inServer: false },
    ])
    await screen.findByText(ACCENTED_NAME)

    fireEvent.click(screen.getByRole('button', { name: 'Untrack' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Untrack & remove from Steam' }))

    await waitFor(() => expect(collectionUntrack).toHaveBeenCalledWith('333'))
    // Refresh isn't called on failure, and the button returns to its idle (non-busy) state
    // rather than getting stuck -- proving the failure path doesn't leave the row lying about status.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Untrack' })).toBeEnabled())
  })

  // bug-hunt-2026-08-26: unlike Settings.tsx's plain untrack (local tracking
  // only), this untrack also writes an ignore-list entry and mirrors the
  // removal into the user's real Steam Workshop collection -- untiered in
  // Pam's 52-action destructive audit and previously fired on a single
  // click with zero confirmation.
  it('does NOT untrack on a single click -- it only opens a confirmation naming the Steam-collection side effect', async () => {
    await renderPanel([
      { workshopId: '333', name: ACCENTED_NAME, status: 'to-add', inTracked: true, inCollection: false, inServer: false },
    ])
    await screen.findByText(ACCENTED_NAME)

    fireEvent.click(screen.getByRole('button', { name: 'Untrack' }))

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument()
    expect(screen.getByText('Untrack this mod?')).toBeInTheDocument()
    expect(collectionUntrack).not.toHaveBeenCalled()
  })

  it('Cancel on the untrack dialog leaves the mod tracked', async () => {
    await renderPanel([
      { workshopId: '333', name: ACCENTED_NAME, status: 'to-add', inTracked: true, inCollection: false, inServer: false },
    ])
    await screen.findByText(ACCENTED_NAME)

    fireEvent.click(screen.getByRole('button', { name: 'Untrack' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(collectionUntrack).not.toHaveBeenCalled()
  })

  it('confirming the untrack dialog calls collectionUntrack exactly once', async () => {
    collectionUntrack.mockResolvedValue({ ok: true, workshopId: '333', removed: true, message: 'ok' } as any)
    await renderPanel([
      { workshopId: '333', name: ACCENTED_NAME, status: 'to-add', inTracked: true, inCollection: false, inServer: false },
    ])
    await screen.findByText(ACCENTED_NAME)

    fireEvent.click(screen.getByRole('button', { name: 'Untrack' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Untrack & remove from Steam' }))

    await waitFor(() => expect(collectionUntrack).toHaveBeenCalledTimes(1))
    expect(collectionUntrack).toHaveBeenCalledWith('333')
  })

  it('exposes the Add-to-collection disabled reason as an accessible name, not just a hover title', async () => {
    collectionDiff.mockResolvedValue({
      ...baseDiff([
        { workshopId: '444', name: ACCENTED_NAME, status: 'to-add', inTracked: true, inCollection: false, inServer: false },
      ]),
      hasCredentials: false,
    } as any)
    render(
      <MemoryRouter>
        <TooltipProvider>
          <WorkshopCollectionPanel />
        </TooltipProvider>
      </MemoryRouter>
    )
    await screen.findByText(ACCENTED_NAME)

    // 2026-08-27 no-dead-disabled-title triage: a native title is invisible on a
    // disabled element (confirmed empirically, no tooltip on hover) -- the reason
    // now lives in aria-label AND in a real DisabledReason/Radix Tooltip on a
    // focusable wrapper, so it reaches both assistive tech and a sighted mouse
    // user hovering the (now-focusable) wrapper. The dead title= is gone, not
    // just duplicated -- find the button by its accessible name instead.
    const addButton = screen.getByRole('button', { name: 'Need Steam cookies' })
    expect(addButton).toBeDisabled()
    expect(addButton).toHaveAccessibleName('Need Steam cookies')
    expect(addButton).not.toHaveAttribute('title')
  })

  it('defaults to the "missing from collection" filter, hiding in-sync items until asked', async () => {
    await renderPanel([
      { workshopId: '1', name: 'Missing Mod', status: 'to-add', inTracked: true, inCollection: false, inServer: false },
      { workshopId: '2', name: 'Synced Mod', status: 'synced', inTracked: true, inCollection: true, inServer: true },
    ])
    expect(await screen.findByText('Missing Mod')).toBeInTheDocument()
    expect(screen.queryByText('Synced Mod')).not.toBeInTheDocument()
  })

  // user-report-steam-collection-import-fails-success8-filetype2, part (d):
  // a bulk failure toast used to show only errors[0].error under a "First
  // error:" label, silently discarding every other item's failure reason
  // -- "if 47 different failures can hide behind one message, that is its
  // own bug". These prove the toast now says whether every failure shares
  // one cause or several, instead of always implying "there's more, who
  // knows what".
  it('bulk-add failure toast states all items shared the same error, not just "first error"', async () => {
    collectionAddItem.mockRejectedValue(
      new Error('Steam rejected this: that Workshop item is itself a collection, not a mod.'),
    )
    await renderPanel([
      { workshopId: '1', name: 'Sub A', status: 'to-add', inTracked: true, inCollection: false, inServer: false },
      { workshopId: '2', name: 'Sub B', status: 'to-add', inTracked: true, inCollection: false, inServer: false },
    ])
    await screen.findByText('Sub A')

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all visible' }))
    fireEvent.click(screen.getByRole('button', { name: /Add to collection/i }))

    await waitFor(() => expect(collectionAddItem).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'destructive',
        description: expect.stringContaining('all with the same error'),
      }),
    ))
    const call = toastSpy.mock.calls.find((c) => c[0]?.variant === 'destructive')
    expect(call![0].description).not.toMatch(/First error/i)
  })

  it('bulk-add failure toast reports the number of distinct errors when items fail differently', async () => {
    collectionAddItem
      .mockRejectedValueOnce(new Error('Steam session expired'))
      .mockRejectedValueOnce(new Error('That item is itself a collection, not a mod.'))
    await renderPanel([
      { workshopId: '1', name: 'Sub A', status: 'to-add', inTracked: true, inCollection: false, inServer: false },
      { workshopId: '2', name: 'Sub B', status: 'to-add', inTracked: true, inCollection: false, inServer: false },
    ])
    await screen.findByText('Sub A')

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all visible' }))
    fireEvent.click(screen.getByRole('button', { name: /Add to collection/i }))

    await waitFor(() => expect(collectionAddItem).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'destructive',
        description: expect.stringContaining('2 different errors'),
      }),
    ))
  })
})
