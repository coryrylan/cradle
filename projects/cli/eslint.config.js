import { defineConfig } from 'eslint/config';
import { typescriptConfig, testsConfig, jsonConfig } from '@coryrylan/tools/eslint';

export default defineConfig([
  { ignores: ['dist/**', '.wireit/**', '*.config.js'] },
  typescriptConfig,
  testsConfig,
  jsonConfig,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      complexity: ['error', { max: 10 }],
      'max-params': ['error', 4],
      'max-lines': ['error', 1000],
      // Sandbox rationale (seatbelt last-match-wins ordering, MISE_CACHE_DIR
      // override, argv-only composition) is why-prose that no type or test can
      // encode; a prose budget would delete the reasoning, not relocate it.
      'tools/no-excessive-comments': 'off'
    }
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      'id-length': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off'
    }
  },
  {
    files: ['src/cli.ts'],
    rules: {
      'no-irregular-whitespace': 'off'
    }
  }
]);
