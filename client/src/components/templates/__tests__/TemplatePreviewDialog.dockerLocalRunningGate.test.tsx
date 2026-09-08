import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { TemplatePreviewDialog } from '../TemplatePreviewDialog'
import { serverApi, serversApi, templatesApi, type ServerInstance, type SimTemplate } from '@/lib/api'

// 2026-09-08 (Angela's is-running enumeration, GH#114-shaped): this dialog's
// Apply button (overwrites live INI/Sandbox config) was gated on
// `running !== false` -- deliberately fail-closed, same convention as
// ServerConfig.tsx's own save-guard -- but `running` came straight from
// serverApi.getStatus()'s raw local process scan. That scan is blind to a
// docker-local server's containerized process: it reports a confident
// `running: false` for a server that is genuinely up, which doesn't just
// mis-show a badge, it silently DEFEATS the guard (Apply enabled, no
// warning) on a running server. Fixed by routing through
// resolveServerRunning() (client/src/lib/serverStatus.ts), the same
// provider-aware, fail-closed lookup ServerConfig.tsx already uses.

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    serverApi: { ...actual.serverApi, getStatus: vi.fn() },
    serversApi: { ...actual.serversApi, getResolvedActive: vi.fn(), getComposedStatus: vi.fn() },
    templatesApi: { ...actual.templatesApi, preview: vi.fn(), apply: vi.fn() },
  }
})

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}))

const getStatus = vi.mocked(serverApi.getStatus)
const getResolvedActive = vi.mocked(serversApi.getResolvedActive)
const getComposedStatus = vi.mocked(serversApi.getComposedStatus)
const preview = vi.mocked(templatesApi.preview)

const dockerServer = {
  id: 1,
  name: 'Docker Server',
  serverName: 'Docker Server',
  isRemote: false,
  isActive: true,
  dockerContainerName: 'pz-container',
} as unknown as ServerInstance

const template: SimTemplate = {
  schemaVersion: 1,
  meta: { id: 'tpl-1', name: 'Test Template', description: '', tags: [], pzBuild: '41' },
  sandboxVars: {},
  serverIni: {},
  iniExclusions: [],
  mods: [],
  map: { mapId: 'Muldraugh, KY' },
  difficulty: {},
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderDialog() {
  return render(
    <TemplatePreviewDialog template={template} canManage={true} onClose={vi.fn()} onApplied={vi.fn()} />,
  )
}

describe('TemplatePreviewDialog: provider-aware running check gates Apply', () => {
  it('keeps Apply disabled with a running warning for a docker-local server the raw scan cannot see, using the composed status instead', async () => {
    getResolvedActive.mockResolvedValue({ server: dockerServer })
    // The raw local scan is blind to this container -- it confidently
    // reports stopped even though the server is actually up.
    getStatus.mockResolvedValue({ running: false } as Awaited<ReturnType<typeof serverApi.getStatus>>)
    getComposedStatus.mockResolvedValue({
      provider: 'docker-local',
      host: { status: 'running' },
      server: { status: 'connected' },
      bridge: { status: 'active' },
    } as Awaited<ReturnType<typeof serversApi.getComposedStatus>>)
    preview.mockResolvedValue({
      success: true,
      diff: { serverIni: [{ key: 'X', from: '1', to: '2' }], sandboxVars: [], summary: { iniChanges: 1, sandboxChanges: 0, totalChanges: 1 } },
    })

    renderDialog()

    const applyButton = await screen.findByRole('button', { name: 'Apply Template' })
    expect(applyButton).toBeDisabled()
    expect(screen.getByText('Server is running')).toBeInTheDocument()
    expect(screen.getByText('Stop the server before applying this template.')).toBeInTheDocument()
  })

  it('enables Apply once the composed status confirms the docker-local server is actually stopped', async () => {
    getResolvedActive.mockResolvedValue({ server: dockerServer })
    getStatus.mockResolvedValue({ running: false } as Awaited<ReturnType<typeof serverApi.getStatus>>)
    getComposedStatus.mockResolvedValue({
      provider: 'docker-local',
      host: { status: 'stopped' },
      server: { status: 'disconnected' },
      bridge: { status: 'inactive' },
    } as Awaited<ReturnType<typeof serversApi.getComposedStatus>>)
    preview.mockResolvedValue({
      success: true,
      diff: { serverIni: [{ key: 'X', from: '1', to: '2' }], sandboxVars: [], summary: { iniChanges: 1, sandboxChanges: 0, totalChanges: 1 } },
    })

    renderDialog()

    const applyButton = await screen.findByRole('button', { name: 'Apply Template' })
    await waitFor(() => expect(applyButton).toBeEnabled())
    expect(screen.queryByText('Server is running')).not.toBeInTheDocument()
  })
})
