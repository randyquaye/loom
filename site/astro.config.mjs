import { defineConfig } from 'astro/config'

// Static output in dist/; the toolbar would appear in local screenshots.
export default defineConfig({
  devToolbar: { enabled: false }
})
