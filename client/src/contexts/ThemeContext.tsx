import { createContext, useContext, useState, useEffect, ReactNode } from 'react'

export type ThemeName = 'clean' | 'survival'

interface ThemeContextType {
  theme: ThemeName
  setTheme: (theme: ThemeName) => void
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeName>(() => {
    const saved = localStorage.getItem('pz-theme')
    return (saved as ThemeName) || 'clean'
  })

  useEffect(() => {
    localStorage.setItem('pz-theme', theme)
    
    // Update document class for theme
    document.documentElement.classList.remove('theme-clean', 'theme-survival')
    document.documentElement.classList.add(`theme-${theme}`)
  }, [theme])

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
