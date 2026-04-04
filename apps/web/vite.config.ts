import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '../..')

function resolvePkg(name: string): string {
  const atRoot = path.join(root, 'node_modules', name)
  const atWeb = path.join(__dirname, 'node_modules', name)
  if (fs.existsSync(atRoot)) return atRoot
  if (fs.existsSync(atWeb)) return atWeb
  return atRoot
}

export default defineConfig({
  plugins: [react()],
  envPrefix: 'VITE_',
  // Monorepo: react-router must resolve the same React instance as react-dom (invalid hook call otherwise).
  resolve: {
    dedupe: ['react', 'react-dom', 'react-router', 'react-router-dom'],
    alias: {
      react: resolvePkg('react'),
      'react-dom': resolvePkg('react-dom'),
    },
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-router-dom'],
  },
  server: {
    proxy: {
      '/bdl': { target: 'http://localhost:3001', changeOrigin: true },
      '/leaderboard': { target: 'http://localhost:3001', changeOrigin: true },
      '/internal': { target: 'http://localhost:3001', changeOrigin: true },
      '/health': { target: 'http://localhost:3001', changeOrigin: true },
      '/billing': { target: 'http://localhost:3001', changeOrigin: true },
    },
    fs: {
      // Allow Vite to import HTML mock files from the monorepo root.
      allow: [path.resolve(__dirname, '../..')],
    },
  },
})
