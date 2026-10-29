/* eslint-disable react-refresh/only-export-components -- test helper module, not a component file */
// Shared setup for the Files.*.test.tsx suites: an in-memory stand-in for
// the /api/files routes (spec §A10) behind a stubbed fetch, entry and
// profile builders, and a render() with the providers the page needs.
import { render } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/toaster'
import { ConfirmProvider } from '@/contexts/ConfirmContext'
import { SocketContext } from '@/contexts/SocketContext'
import type {
  FileEntry,
  ListResponse,
  ProfileFiles,
  RootDescriptor,
  RootId,
  TextResponse,
} from '@/types/files'
import Files from '../Files'

export function makeEntry(path: string, type: FileEntry['type'] = 'file', extra: Partial<FileEntry> = {}): FileEntry {
  const name = path.split('/').pop() ?? path
  const isText = type === 'file' && /\.(ini|lua|txt|json|sh)$/i.test(name)
  return {
    name,
    path,
    type,
    size: type === 'dir' ? null : 1234,
    modifiedAt: '2026-09-01T12:00:00.000Z',
    mode: type === 'dir' ? '0755' : '0644',
    etag: `s:1234-${name.length}`,
    protection: null,
    ...extra,
    flags: {
      editable: isText,
      binaryHint: type === 'file' && !isText,
      secretBearing: name.endsWith('.ini'),
      executable: false,
      worldState: false,
      unsupportedName: false,
      ...(extra.flags ?? {}),
    },
  }
}

export function makeRoot(id: RootId, extra: Partial<RootDescriptor> = {}): RootDescriptor {
  return {
    id,
    backend: 'local',
    displayPath: id === 'data' ? '/home/pz/Zomboid' : '/opt/pz',
    available: true,
    writable: true,
    freeBytes: 50 * 1024 ** 3,
    totalBytes: 100 * 1024 ** 3,
    warnings: [],
    trashItemCount: 0,
    ...extra,
  }
}

export function makeProfile(extra: Partial<ProfileFiles> = {}): ProfileFiles {
  return {
    id: 'p1',
    name: 'Main',
    serverName: 'servertest',
    isActive: true,
    provider: 'native',
    remote: null,
    roots: [makeRoot('data'), makeRoot('install')],
    bookmarks: [],
    serverState: 'stopped',
    serverStateCheckedAt: '2026-09-29T12:00:00.000Z',
    ...extra,
  }
}

export function makeListing(entries: FileEntry[], extra: Partial<ListResponse> = {}): ListResponse {
  return {
    dir: makeEntry('.', 'dir'),
    entries,
    total: entries.length,
    offset: 0,
    limit: 500,
    sortLimited: false,
    truncated: false,
    dirEtag: 'dir-1',
    ...extra,
  }
}

export function makeText(entry: FileEntry, content: string, extra: Partial<TextResponse> = {}): TextResponse {
  return {
    entry,
    content,
    etag: 'h:original',
    bom: false,
    eol: 'lf',
    masked: false,
    truncated: false,
    readOnly: false,
    readOnlyReason: null,
    hints: [],
    serverState: 'stopped',
    ...extra,
  }
}

export interface Call {
  method: string
  url: URL
  body: any
}

export interface FakeRequest {
  method: string
  url: URL
  path: string
  body: any
}

type Override = (request: FakeRequest) => Response | Promise<Response> | undefined

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

export function fmError(status: number, code: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Response {
  return json(status, { error: `server says ${code}`, code, params, ...extra })
}

/** A fake of the /api/files routes. Listings and texts are keyed "root|path". */
export class FakeFilesServer {
  profiles: ProfileFiles[] = [makeProfile()]
  listings = new Map<string, ListResponse>()
  texts = new Map<string, TextResponse>()
  calls: Call[] = []
  private overrides: Override[] = []

  /** Checked first, newest first; return undefined to fall through. */
  on(override: Override) {
    this.overrides.unshift(override)
  }

  callsTo(method: string, pathSuffix: string): Call[] {
    return this.calls.filter((call) => call.method === method && call.url.pathname.endsWith(pathSuffix))
  }

  async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, 'http://panel.test')
    const method = (init?.method ?? 'GET').toUpperCase()
    let body: any = null
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body) } catch { body = init.body }
    }
    this.calls.push({ method, url, body })
    const path = url.pathname.replace(/^\/api\/files/, '')
    for (const override of this.overrides) {
      const response = await override({ method, url, path, body })
      if (response) return response
    }
    if (!url.pathname.startsWith('/api/files')) return json(200, {})
    if (method === 'GET' && path === '/profiles') {
      return json(200, { profiles: this.profiles.map(({ serverState: _s, serverStateCheckedAt: _c, ...rest }) => rest) })
    }
    if (method === 'GET' && path === '/audit') return json(200, { entries: [] })
    const match = /^\/profiles\/([^/]+)(\/.*)?$/.exec(path)
    if (!match) return fmError(404, 'FM_NOT_FOUND')
    const profile = this.profiles.find((p) => p.id === decodeURIComponent(match[1]))
    if (!profile) return fmError(404, 'FM_PROFILE_NOT_FOUND')
    const sub = match[2] ?? ''
    const key = `${url.searchParams.get('root')}|${url.searchParams.get('path') ?? ''}`
    if (method === 'GET' && sub === '') return json(200, { profile })
    if (method === 'GET' && sub === '/list') {
      const listing = this.listings.get(key)
      return listing ? json(200, listing) : fmError(404, 'FM_NOT_FOUND')
    }
    if (method === 'GET' && sub === '/stat') {
      for (const listing of this.listings.values()) {
        const entry = listing.entries.find((item) => item.path === url.searchParams.get('path'))
        if (entry) return json(200, { entry })
      }
      return fmError(404, 'FM_NOT_FOUND')
    }
    if (method === 'GET' && sub === '/text') {
      const text = this.texts.get(key)
      return text ? json(200, text) : fmError(404, 'FM_NOT_FOUND')
    }
    if (method === 'GET' && sub === '/trash') return json(200, { items: [], totalBytes: 0 })
    return fmError(500, 'FM_INTERNAL')
  }

  install() {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => this.handle(input, init))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }
}

// ---- Uploads go through XMLHttpRequest ----

export interface XhrRequest {
  url: string
  headers: Record<string, string>
  body: unknown
  xhr: FakeXhr
}

export class FakeXhr {
  static requests: XhrRequest[] = []
  /** Decides each request's fate; leave a request unanswered to keep it in flight. */
  static respond: (request: XhrRequest) => void = (request) => request.xhr.finish(201, { entry: makeEntry('x'), sha256: 'abc', replaced: null })

  status = 0
  responseText = ''
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  private url = ''
  private headers: Record<string, string> = {}
  private responseHeaders: Record<string, string> = {}

  open(_method: string, url: string) {
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }
  getResponseHeader(name: string) {
    return this.responseHeaders[name.toLowerCase()] ?? null
  }
  send(body: unknown) {
    const request = { url: this.url, headers: { ...this.headers }, body, xhr: this }
    FakeXhr.requests.push(request)
    setTimeout(() => FakeXhr.respond(request), 0)
  }
  abort() {
    setTimeout(() => this.onabort?.(), 0)
  }
  finish(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status
    this.responseText = JSON.stringify(body)
    this.responseHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 1 })
    this.onload?.()
  }

  static install() {
    FakeXhr.requests = []
    FakeXhr.respond = (request) => request.xhr.finish(201, { entry: makeEntry('x'), sha256: 'abc', replaced: null })
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
  }
}

/**
 * jsdom lays nothing out, so every element is 0x0 and the virtualized file
 * table (which measures its scroll box through clientWidth/clientHeight, and
 * through offsetWidth/offsetHeight before @tanstack/virtual-core 3.19.6)
 * would render no rows. Gives every element a 800x600 box; returns the
 * undo.
 */
export function stubLayout(width = 800, height = 600): () => void {
  const proto = HTMLElement.prototype
  const sizes = { offsetWidth: width, offsetHeight: height, clientWidth: width, clientHeight: height }
  const originals = Object.keys(sizes).map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const)
  for (const [key, value] of Object.entries(sizes)) {
    Object.defineProperty(proto, key, { configurable: true, get: () => value })
  }
  return () => {
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(proto, key, original)
    }
  }
}

/** Shows the current location, and stands in for the browser's Back button. */
export function LocationProbe() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <div data-testid="location">{`${location.pathname}${location.search}`}</div>
      <button type="button" data-testid="history-back" onClick={() => navigate(-1)} />
    </>
  )
}

/** A socket stand-in: `emit(event)` runs the page's handler for it. */
export function makeFakeSocket() {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  return {
    on: (event: string, handler: (...args: unknown[]) => void) => { handlers.set(event, handler) },
    off: (event: string) => { handlers.delete(event) },
    emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
  }
}

export function renderFiles(initialEntry = '/files?server=p1&root=data', { socket = null }: { socket?: unknown } = {}) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <SocketContext.Provider value={socket as never}>
        <TooltipProvider>
          <ConfirmProvider>
            <Files />
            <LocationProbe />
            <Toaster />
          </ConfirmProvider>
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  )
}

/** Search params of the probe's current location. */
export function currentParams(getByTestId: (id: string) => HTMLElement): URLSearchParams {
  const text = getByTestId('location').textContent ?? ''
  return new URLSearchParams(text.split('?')[1] ?? '')
}
