import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { resolveServerConfigDeepLink, SectionHeader } from '../ServerConfig'

// conv-hunt-pages-2 phone-width overflow sweep: the ini/sandbox/spawn-points/
// spawn-regions/mod-settings tab toolbars (Form/Raw toggle, download, Wiki
// link, Save & reload) all share this one SectionHeader component. Its
// action group had `shrink-0` with no wrap, so on a 390px viewport the Save
// button's own right edge sat past the visible edge (measured live: right
// ~407px against a 390px viewport, via Playwright) -- a real control shoved
// half off-screen, not just a cosmetic clip.
//
// Wrapping the outer row alone wasn't enough (confirmed live -- it dropped
// the action group to its own line, but that line was STILL too narrow for
// its own five children, still clipping the Save button at ~395px): a
// flex-wrap child with a shrink-0/auto-width sibling sizes to its own
// max-content, not to the row it wrapped onto, so its own flex-wrap never
// gets a width to wrap against. The action wrapper needs `w-full` below the
// `sm` breakpoint so that once it wraps, it actually claims the full row
// width its own children can then wrap inside of.
// (jsdom has no real layout engine -- asserted by class, verified for real
// pixel behavior live in a browser via Playwright.)
describe('ServerConfig -- SectionHeader', () => {
  it('lets the label and action row wrap onto separate lines', () => {
    const { container } = render(
      <SectionHeader
        label="Server settings"
        sublabel="INI - behavior, network, players"
        action={<button type="button">Save &amp; reload</button>}
      />,
    )
    const header = container.firstElementChild
    expect(header).toHaveClass('flex-wrap')
  })

  it('gives the wrapped action row the full row width below sm, so its own children have room to wrap', () => {
    const { container } = render(
      <SectionHeader
        label="Server settings"
        action={<button type="button">Save &amp; reload</button>}
      />,
    )
    const actionWrapper = container.querySelector('button')?.parentElement
    expect(actionWrapper).toHaveClass('w-full')
    expect(actionWrapper).toHaveClass('sm:w-auto')
  })
})

describe('ServerConfig deep links', () => {
  it('opens the INI tab with a bounded search term', () => {
    expect(resolveServerConfigDeepLink(new URLSearchParams('tab=ini&search=%20Mods%20&unresolved=ArcadiaQOLSafehouse_B42')))
      .toEqual({ tab: 'ini', search: 'Mods', unresolved: ['ArcadiaQOLSafehouse_B42'] })
  })

  it('falls back to the INI tab for unknown tab values', () => {
    expect(resolveServerConfigDeepLink(new URLSearchParams('tab=unknown')))
      .toEqual({ tab: 'ini', search: '', unresolved: [] })
  })
})
