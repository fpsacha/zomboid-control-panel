import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { TooltipProvider } from '@/components/ui/tooltip'
import Console from '../Console'
import { serverApi, serversApi, rconApi, configApi, type ServerInstance } from '@/lib/api'
import { MemoryRouter } from 'react-router-dom'

// Caldac: the Server Log tab downloads server-console.txt on its own
// (GET /server/console-log/download), instead of the whole support bundle.

const toastSpy = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
}))

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', username: 'someone', role: 'moderator', capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => 'fake-token',
    can: () => true,
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    serverApi: {
      ...actual.serverApi,
      getConsoleLog: vi.fn(),
      streamConsoleLog: vi.fn(),
      downloadConsoleLog: vi.fn(),
    },
    serversApi: { ...actual.serversApi, getAll: vi.fn() },
    rconApi: { ...actual.rconApi, getHistory: vi.fn() },
    configApi: { ...actual.configApi, testRcon: vi.fn() },
  }
})

const server: ServerInstance = {
  id: 1, name: 'Caldac', serverName: 'Caldac', installPath: 'C:/servers/caldac',
  zomboidDataPath: null, serverConfigPath: null, rconHost: '', rconPort: 0, rconPassword: '',
  serverPort: 16261, minMemory: 2048, maxMemory: 4096, useNoSteam: false, useDebug: false,
  isRemote: false, isActive: true, startCommand: '', adminPassword: '',
  createdAt: '2026-01-01T00:00:00.000Z',
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function renderWithLog(exists = true) {
  vi.mocked(serversApi.getAll).mockResolvedValue({ servers: [server] })
  vi.mocked(serverApi.getConsoleLog).mockResolvedValue({
    lines: exists ? ['boot ok'] : [], size: exists ? 42 : 0, path: 'server-console.txt', exists,
  })
  vi.mocked(serverApi.streamConsoleLog).mockResolvedValue({ newLines: [], currentSize: 42 })
  vi.mocked(rconApi.getHistory).mockResolvedValue({ history: [] })
  vi.mocked(configApi.testRcon).mockResolvedValue({ success: true, connected: true })
  render(
    <TooltipProvider>
      <ConfirmProvider>
        <MemoryRouter><Console /></MemoryRouter>
      </ConfirmProvider>
    </TooltipProvider>,
  )
  if (exists) await screen.findByText('boot ok')
  return screen.findByRole('button', { name: /^download server-console\.txt$/i })
}

describe('Console.tsx: Download server-console.txt', () => {
  it('downloads the console log alone from the log tab', async () => {
    vi.mocked(serverApi.downloadConsoleLog).mockResolvedValue()
    const download = await renderWithLog()

    expect(download).not.toBeDisabled()
    fireEvent.click(download)

    await waitFor(() => expect(serverApi.downloadConsoleLog).toHaveBeenCalledTimes(1))
  })

  it('says so when the download fails', async () => {
    vi.mocked(serverApi.downloadConsoleLog).mockRejectedValue(new Error('network down'))
    const download = await renderWithLog()

    fireEvent.click(download)

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })),
    )
    await waitFor(() => expect(download).not.toBeDisabled())
  })

  it('is disabled while the game has not written the log yet', async () => {
    const download = await renderWithLog(false)
    await waitFor(() => expect(download).toBeDisabled())
  })
})
