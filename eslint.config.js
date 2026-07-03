import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'out/**', 'drizzle/**', 'index.ts', '**/*.cjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
);
