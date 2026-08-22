import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/webui/',
  root: 'src/webui',
  publicDir: 'public',
  plugins: [tailwindcss(), react()],
  build: {
    outDir: '../../public/webui',
    assetsDir: 'assets',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        assetFileNames: 'assets/app.[ext]',
        manualChunks(id) {
          const normalizedId = id.replaceAll('\\', '/')
          if (!normalizedId.includes('/node_modules/')) return undefined
          if (normalizedId.includes('/react/') || normalizedId.includes('/react-dom/')) return 'react-vendor'
          if (normalizedId.includes('/lucide-react/')) return 'icons-vendor'
          if (
            normalizedId.includes('/react-markdown/') ||
            normalizedId.includes('/remark-gfm/') ||
            normalizedId.includes('/mdast-') ||
            normalizedId.includes('/micromark') ||
            normalizedId.includes('/unified/') ||
            normalizedId.includes('/remark-') ||
            normalizedId.includes('/rehype-') ||
            normalizedId.includes('/hast-') ||
            normalizedId.includes('/vfile') ||
            normalizedId.includes('/unist-')
          )
            return 'markdown-vendor'
          if (normalizedId.includes('/@radix-ui/')) return 'ui-vendor'
          return undefined
        },
      },
    },
  },
})
