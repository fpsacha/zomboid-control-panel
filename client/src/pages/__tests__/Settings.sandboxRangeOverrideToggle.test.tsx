import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import Settings from '../Settings'
import { configApi } from '@/lib/api'
import { ALLOW_OUT_OF_RANGE_SANDBOX_STORAGE_KEY, getAllowOutOfRangeSandboxValues } from '@/lib/serverConfigSchema'

// sandbox-range-override toggle, 2026-09-09 dispatch objective 2: "It lives
// in panel settings, as he asked, not buried in the Sandbox tab" and "OFF by
// default." This is plain localStorage (see serverConfigSchema.ts's own
// comment for why: PUT /app-settings validates against a fixed key
// whitelist this change doesn't extend), not the server-persisted
// AppSettings blob every other toggle on this page uses -- this suite
// exists specifically to prove the client-only persistence actually works,
// since nothing else on this page exercises that path.

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'admin', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
  }),
}))

const getAppSettings = vi.spyOn(configApi, 'getAppSettings')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  localStorage.clear()
})

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <TooltipProvider>
        <Settings />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

describe('Settings.tsx: sandboxRangeOverride toggle', () => {
  it('defaults OFF when nothing is stored yet', async () => {
    getAppSettings.mockResolvedValue({ settings: {} } as never)
    renderSettings()

    const toggle = await screen.findByRole('switch', { name: /allow sandbox values outside known range/i })
    expect(toggle).not.toBeChecked()
    expect(getAllowOutOfRangeSandboxValues()).toBe(false)
  })

  it('turning it on persists to localStorage immediately (client-only, not the Save Settings button)', async () => {
    getAppSettings.mockResolvedValue({ settings: {} } as never)
    renderSettings()

    const toggle = await screen.findByRole('switch', { name: /allow sandbox values outside known range/i })
    fireEvent.click(toggle)

    await waitFor(() => expect(toggle).toBeChecked())
    expect(localStorage.getItem(ALLOW_OUT_OF_RANGE_SANDBOX_STORAGE_KEY)).toBe('true')
    expect(getAllowOutOfRangeSandboxValues()).toBe(true)
  })

  it('reflects a value already stored from a previous session', async () => {
    localStorage.setItem(ALLOW_OUT_OF_RANGE_SANDBOX_STORAGE_KEY, 'true')
    getAppSettings.mockResolvedValue({ settings: {} } as never)
    renderSettings()

    const toggle = await screen.findByRole('switch', { name: /allow sandbox values outside known range/i })
    expect(toggle).toBeChecked()
  })
})
