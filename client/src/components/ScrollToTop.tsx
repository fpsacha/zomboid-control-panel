import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

/** Scrolls the main content area to top on every route change */
export function ScrollToTop() {
  const { pathname } = useLocation()

  useEffect(() => {
    // Scroll the main content area (not window — Layout uses flex overflow)
    const main = document.querySelector('main')
    if (main) {
      main.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
    }
  }, [pathname])

  return null
}
