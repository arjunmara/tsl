import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import pkg from './package.json' with { type: 'json' }

export default defineConfig(({ mode }) => {
  // loadEnv with '' prefix also returns process.env, so CF_PAGES is visible here.
  const env = loadEnv(mode, '.', '')
  // Cloudflare Pages sets CF_PAGES=1: never ship a build that points at no database.
  if (env.CF_PAGES) {
    for (const name of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_TURNSTILE_SITE_KEY']) {
      if (!env[name]) throw new Error(`${name} is not set in this Cloudflare Pages environment`)
    }
    try {
      new URL(env.VITE_SUPABASE_URL)
    } catch {
      throw new Error('VITE_SUPABASE_URL is not a valid URL')
    }
  }
  return {
    // Recorded on every outbox entry.
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    build: {
      rollupOptions: { input: { main: 'index.html', tokens: 'tokens.html', components: 'components.html' } },
    },
    plugins: [
      react(),
      VitePWA({
        // 'prompt': a new service worker waits; features/app/start.ts activates it only when the outbox is empty (AD-25).
        registerType: 'prompt',
        // Google Fonts cached on first load so offline phones keep Barlow and Bebas Neue.
        workbox: {
          // MediaPipe's wasm and model (Story 2.5) load only on the photo screen, then stay cached for offline use.
          globIgnores: ['**/node_modules/**/*', 'mediapipe/**'],
          runtimeCaching: [
            {
              urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/mediapipe/'),
              handler: 'CacheFirst',
              options: { cacheName: 'mediapipe', cacheableResponse: { statuses: [200] } },
            },
            {
              urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com',
              handler: 'CacheFirst',
              options: { cacheName: 'google-fonts-css' },
            },
            {
              urlPattern: ({ url }) => url.origin === 'https://fonts.gstatic.com',
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-files',
                cacheableResponse: { statuses: [0, 200] },
                expiration: { maxEntries: 20, maxAgeSeconds: 31536000 },
              },
            },
          ],
        },
        manifest: {
          name: 'Tamghas Super League',
          short_name: 'TSL',
          start_url: '.',
          display: 'standalone',
          background_color: '#ffffff',
          theme_color: '#0a1a3f',
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          ],
        },
      }),
    ],
  }
})
