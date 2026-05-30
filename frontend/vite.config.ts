import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), wasm(), topLevelAwait()],
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          stellar: ['@stellar/stellar-sdk', '@stellar/freighter-api'],
          crypto: ['@noble/curves', '@noble/hashes'],
          state: ['zustand', 'idb'],
          animation: ['framer-motion'],
          prover: ['snarkjs', 'circomlibjs'],
        },
      },
    },
  },
  resolve: {
    alias: {
      '@wasm': path.resolve(__dirname, 'public/pkg'),
      '@deployments': path.resolve(__dirname, '../deployments'),
      buffer: 'buffer',
      process: 'process/browser',
    },
  },
  server: {
    fs: {
      allow: [path.resolve(__dirname, '..')],
    },
  },
  optimizeDeps: {
    // Prevent Vite from pre-bundling/corrupting the WASM binary
    exclude: ['cryptography', '@wasm/cryptography.js', '/pkg/cryptography.js'],
  },
})
