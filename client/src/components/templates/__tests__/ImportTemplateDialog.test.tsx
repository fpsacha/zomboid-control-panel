import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ImportTemplateDialog } from '../ImportTemplateDialog'
import en from '../../../locales/en/templateImportDialog.json'

// bug-hunt-2026-09-06 (client silent-failure lane, components/contexts pass):
// handleFile did `setText(await file.text())` with no try/catch, called
// fire-and-forget from the file input's onChange with no .catch() at the
// call site either. file.text() can reject (a removable/network-drive file
// going away between selection and read) -- an uncaught rejection left the
// dialog sitting open with an empty textarea and zero indication anything
// went wrong. This is the same "nobody's listening for the outcome" shape
// as the server uploadStream crash and the 3 socket-layer HUNG-ACTION bugs
// found earlier tonight, just on a plain Promise instead of a socket event.

function makeFile(content: string): File {
  return new File([content], 'template.pztemplate.json', { type: 'application/json' })
}

function makeUnreadableFile(): File {
  const file = new File([], 'template.pztemplate.json', { type: 'application/json' })
  // jsdom's File.text() otherwise resolves fine -- override it to reproduce
  // the real-world failure (drive disconnected between picking and reading).
  // Empty message deliberately exercises getUserErrorMessage's fallback
  // path (a real File.text() rejection often carries a raw DOMException
  // with no useful message at all) -- proving the new failedToReadFile
  // copy is actually reachable, not just that SOME text appears.
  Object.defineProperty(file, 'text', {
    value: () => Promise.reject(new Error('')),
  })
  return file
}

// Radix's Dialog portals its content into document.body, not into the
// render() container -- query the whole document instead.
function getFileInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ImportTemplateDialog: a file that fails to read surfaces an error instead of leaving the dialog silently stuck', () => {
  it('shows the error banner and never populates the textarea when file.text() rejects', async () => {
    render(<ImportTemplateDialog open onClose={vi.fn()} onImported={vi.fn()} />)

    fireEvent.change(getFileInput(), { target: { files: [makeUnreadableFile()] } })

    await waitFor(() => expect(screen.getByText(en.failedToReadFile)).toBeInTheDocument())
    expect(screen.getByText(en.importFailedTitle)).toBeInTheDocument()
    expect(screen.getByPlaceholderText(en.pastePlaceholder)).toHaveValue('')
  })

  it('control: a normal file still populates the textarea with no error shown', async () => {
    render(<ImportTemplateDialog open onClose={vi.fn()} onImported={vi.fn()} />)

    fireEvent.change(getFileInput(), { target: { files: [makeFile('{"hello":"world"}')] } })

    await waitFor(() => expect(screen.getByPlaceholderText(en.pastePlaceholder)).toHaveValue('{"hello":"world"}'))
    expect(screen.queryByText(en.importFailedTitle)).not.toBeInTheDocument()
  })
})
