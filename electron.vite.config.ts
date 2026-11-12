import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      // The runner is the same services with no window; it runs under plain Node.
      rollupOptions: { input: { index: 'src/main/index.ts', runner: 'src/main/runner/index.ts' } }
    }
  },
  preload: {
    // zod must be bundled, not externalized: a sandboxed preload may only
    // require() the Electron API, so an external require("zod") would throw
    // before contextBridge.exposeInMainWorld runs.
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    build: { outDir: 'out/preload' }
  },
  renderer: {
    plugins: [react()],
    root: 'src/renderer',
    build: { outDir: 'out/renderer' }
  }
})
