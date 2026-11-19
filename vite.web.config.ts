/**
 * The web app (the product): a static single-page app built to dist/web and
 * served by Vercel. `npm run dev` / `npm run build` / `npm run preview`.
 *
 * The Supabase project URL and publishable key are read from the environment
 * at build time (`.env` locally, Project Settings → Environment Variables on
 * Vercel). A production build fails if they are missing — or if a secret key
 * was put there by mistake — so a misconfigured deployment never goes live.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { validateServerConfig } from './src/shared/serverConfig'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }
const vercel = JSON.parse(readFileSync(resolve(__dirname, 'vercel.json'), 'utf8')) as {
  headers: { source: string; headers: { key: string; value: string }[] }[]
}

/** The same security headers Vercel sends, so `npm run preview` behaves like production. */
function productionHeaders(supabaseUrl: string | undefined): Record<string, string> {
  const all = vercel.headers.find((h) => h.source === '/(.*)')?.headers ?? []
  const out: Record<string, string> = {}
  for (const { key, value } of all) {
    if (key === 'Strict-Transport-Security') continue
    let v = value.replace('; upgrade-insecure-requests', '')
    // A local test server (end-to-end tests) is not on *.supabase.co.
    if (key === 'Content-Security-Policy' && supabaseUrl?.startsWith('http://')) {
      const origin = new URL(supabaseUrl).origin
      v = v.replace('connect-src ', `connect-src ${origin} ${origin.replace('http://', 'ws://')} `)
      // Profile pictures are served by that server's Storage.
      v = v.replace('img-src ', `img-src ${origin} `)
    }
    out[key] = v
  }
  return out
}

/**
 * Production builds only: load public/runtime-guard.js before the app, so React
 * DevTools cannot attach and the browser console stays silent.
 */
function productionHardening(): Plugin {
  return {
    name: 'fusion-production-hardening',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: () => [{ tag: 'script', attrs: { src: '/runtime-guard.js' }, injectTo: 'head-prepend' }]
    }
  }
}

/**
 * Production builds: writes sw.js, the service worker that keeps this exact
 * version of the app on the device so it opens offline (src/renderer/sw.template.js),
 * with the list of every built file and public file filled in.
 */
function offlineShell(): Plugin {
  const publicDir = resolve(__dirname, 'src/renderer/public')
  const publicFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name)
      return statSync(full).isDirectory() ? publicFiles(full) : ['/' + relative(publicDir, full).split('\\').join('/')]
    })
  return {
    name: 'fusion-offline-shell',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle).filter((f) => f !== 'index.html' && f !== 'sw.js').map((f) => '/' + f)
      const files = ['/', '/index.html', ...publicFiles(publicDir), ...built].filter((v, i, all) => all.indexOf(v) === i).sort()
      const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12)
      const template = readFileSync(resolve(__dirname, 'src/renderer/sw.template.js'), 'utf8')
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: template.replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(files, null, 2))
      })
    }
  }
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, __dirname, 'VITE_')
  const url = env.VITE_SUPABASE_URL
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY
  if (command === 'build') {
    if (!url || !key) {
      throw new Error(
        'VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY must be set for a web build (in .env locally, or in Vercel → Settings → Environment Variables).'
      )
    }
    const invalid = validateServerConfig(url, key)
    if (invalid) throw new Error(`Supabase settings rejected: ${invalid}`)
  }

  return {
    root: resolve(__dirname, 'src/renderer'),
    envDir: __dirname,
    publicDir: resolve(__dirname, 'src/renderer/public'),
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    plugins: [react(), tailwindcss(), productionHardening(), offlineShell()],
    build: {
      outDir: resolve(__dirname, mode === 'e2e' ? 'dist/e2e' : 'dist/web'),
      emptyOutDir: true,
      // No source maps: the original source is never published.
      sourcemap: false,
      chunkSizeWarningLimit: 1500,
      rolldownOptions: {
        output: {
          // Minified, without console output or debugger statements.
          minify: { compress: { dropConsole: true, dropDebugger: true }, mangle: true },
          // Libraries change rarely: keep them in their own long-cached file so
          // an app update downloads only FUSION's own code. (The PDF libraries
          // stay separate and load only on export.)
          codeSplitting: {
            groups: [
              {
                name: 'vendor',
                test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler|@tanstack|@supabase|framer-motion|motion-dom|motion-utils|radix-ui|@radix-ui|@floating-ui|recharts|d3-[a-z]+|victory-vendor|lucide-react|zod)[\\/]/,
                priority: 10
              }
            ]
          }
        }
      }
    },
    server: { port: 5173 },
    preview: { port: 4173, strictPort: true, headers: productionHeaders(url) }
  }
})
