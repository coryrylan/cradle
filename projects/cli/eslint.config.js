import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  { ignores: ['dist/**', '.wireit/**', '*.config.js'] },
  eslint.configs.recommended,
  tseslint.configs.strict,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      eqeqeq: 'error',
      complexity: ['error', { max: 10 }],
      'no-shadow': 'error',
      'prefer-const': 'error',
      'no-param-reassign': 'error',
      'max-depth': ['error', 3],
      'max-params': ['error', 4],
      'max-lines': ['error', 1000],
      'max-lines-per-function': ['error', 50],
      'max-nested-callbacks': ['error', 3],
      'max-statements': ['error', 15],
      'max-statements-per-line': ['error', { max: 1 }],
      'no-implicit-coercion': 'error',
      'no-unreachable': 'error',
      'no-useless-return': 'error',
      'no-useless-catch': 'error',
      'no-restricted-imports': ['error', { patterns: ['**/dist/**', '**/node_modules/**'] }],
      'id-length': ['error', { min: 2, exceptions: ['_'] }],
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['src/**/*.test.ts', 'src/test-helpers.ts'],
    rules: {
      'max-lines-per-function': 'off',
      'max-statements': 'off',
      'max-params': 'off',
      complexity: 'off',
      'id-length': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  {
    files: ['src/cli.ts'],
    rules: {
      'no-irregular-whitespace': 'off'
    }
  }
]);
