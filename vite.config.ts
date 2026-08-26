import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    rollupOptions: {
      output: {
        // MapLibre is by far the largest dependency and changes far less often
        // than app code, so it gets its own long-lived chunk.
        manualChunks: {
          maplibre: ['maplibre-gl'],
          react: ['react', 'react-dom'],
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'favicon-32.png',
        'apple-touch-icon.png',
        'icon-192.png',
        'icon-512.png',
        'icon-maskable-512.png',
      ],
      manifest: {
        name: 'RTL Improved — Greater Malé buses',
        short_name: 'RTL Improved',
        description: 'Plan RTL bus trips across Malé, Hulhumalé and Villimalé.',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          {
            // Vector basemap tiles + style + glyphs/sprites.
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'openfreemap',
              expiration: { maxEntries: 600, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Static-ish: route + stop definitions. Timings are re-merged client side.
            urlPattern: /^https:\/\/bo\.rtl\.mv:4455\/maldives\/api\/booking\/v2\/bus\/routedetails/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'rtl-routedetails',
              networkTimeoutSeconds: 8,
              expiration: { maxEntries: 4, maxAgeSeconds: 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Route geometry never changes.
            urlPattern: /^https:\/\/bo\.rtl\.mv:4455\/maldives\/api\/booking\/v2\/bus\/roadshape/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'rtl-roadshape',
              expiration: { maxEntries: 20, maxAgeSeconds: 30 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Live data must never be served stale.
            urlPattern: /^https:\/\/bo\.rtl\.mv:4455\/maldives\/api\/(booking\/v1\/bus\/livecoordinates|gps-engine\/eta\/all-stops-of-route)/i,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
});
