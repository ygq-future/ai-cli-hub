import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['node_modules/**', 'dist/**', 'out/**', 'drizzle/**', 'index.ts', '**/*.cjs']),
  {
    files: ['**/*.{js,ts}'],
    // prettier 置于最后，关闭与 Prettier 冲突的样式规则（格式化交给 Prettier）
    extends: [js.configs.recommended, tseslint.configs.recommended, prettier],
  },
  {
    // CLAUDE.md 铁律：只允许在 src/config/ 读取 process.env
    files: ['src/**/*.ts'],
    ignores: ['src/config/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: '只允许在 src/config/ 读取 process.env（见 CLAUDE.md §5）',
        },
      ],
    },
  },
])
