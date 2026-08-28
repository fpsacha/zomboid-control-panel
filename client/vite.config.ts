import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'

/// <reference types="vitest" />

const rootPkg = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'))

function resolveBuildSha() {
  if (process.env.PANEL_BUILD_SHA) return process.env.PANEL_BUILD_SHA
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
    }).trim()
  } catch {
    return 'unknown'
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const basePath = env.VITE_BASE_PATH || '/'
  const buildSha = resolveBuildSha()
  const apiContractVersion = Number(process.env.PANEL_API_CONTRACT_VERSION || 1)

  return {
    base: basePath,
    define: {
      __PANEL_VERSION__: JSON.stringify(rootPkg.version),
      __PANEL_BUILD_SHA__: JSON.stringify(buildSha),
      __PANEL_API_CONTRACT_VERSION__: JSON.stringify(apiContractVersion),
    },
    plugins: [
      react(),
      {
        name: 'panel-build-info',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'build-info.json',
            source: JSON.stringify({
              panelVersion: rootPkg.version,
              buildSha,
              apiContractVersion,
            }, null, 2),
          })
        },
      },
    ],
    esbuild: {
      drop: ['console', 'debugger'],
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined

            // Heavy charting library - only loaded on Dashboard/Debug
            if (id.includes('recharts') || id.includes('d3-') || id.includes('victory-')) return 'charts'
            // Real-time socket - loaded on connect
            if (id.includes('socket.io-client') || id.includes('engine.io')) return 'socket'
            // Radix UI primitives - loaded as components use them
            if (id.includes('@radix-ui')) return 'radix-vendor'
            // Icons - separate chunk for tree-shaken icon set
            if (id.includes('lucide-react')) return 'icons'
            // Form validation - only needed on pages with forms
            if (id.includes('react-hook-form') || id.includes('@hookform') || id.includes('zod')) return 'forms'
            // React Router - needed on first load but separate from core React
            if (id.includes('react-router')) return 'router'

            // Core: react, react-dom, clsx, tailwind-merge, cva
            return 'vendor'
          },
        },
      },
    },
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
        '/socket.io': {
          target: 'http://localhost:3001',
          changeOrigin: true,
          ws: true,
        },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: './src/test-setup.ts',
      // Stock vitest per-test timeout is 5000ms. This floor commonly runs several concurrent
      // Claude agents plus normal dev tooling, and a cold-clone client-suite run has been
      // observed failing a single test under that contention while passing comfortably once
      // warm. 60000ms matches the same evidence-based value adopted in the root vitest.config.js
      // for the equivalent server-suite contention artifacts (see that file's comment for the
      // reproduction). Not a defect mask -- a test failing for a reason other than contention
      // still fails at 60000ms, it just isn't falsely blamed on the clock.
      testTimeout: 60000,
    },
  }
})
