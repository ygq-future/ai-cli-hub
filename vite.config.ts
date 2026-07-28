import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/webui/',
  root: 'src/webui',
  publicDir: 'public',
  plugins: [react()],
  build: {
    outDir: '../../public/webui',
    assetsDir: 'assets',
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'assets/app.js', assetFileNames: 'assets/app.[ext]' } },
  },
})
