import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// GitHub Pages (legacy, Jekyll) drops anything starting with "_".
const stripLeadingUnderscores = (name: string): string => name.replace(/^_+/, '');

// Ship the notices (source of truth: viewer-src/THIRD_PARTY_NOTICES.md) in the build.
function thirdPartyNotices(): Plugin {
  return {
    name: 'third-party-notices',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_NOTICES.md',
        source: readFileSync(new URL('./THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8'),
      });
    },
  };
}

export default defineConfig({
  base: '/viewer/',
  plugins: [thirdPartyNotices()],
  build: {
    outDir: fileURLToPath(new URL('../viewer', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
        sanitizeFileName: stripLeadingUnderscores,
      },
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
