import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'docs/', 'supabase/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['src/ts/**/*.ts'], languageOptions: { globals: globals.browser } },
  { files: ['scripts/**/*.mjs', '*.js', '*.ts', 'e2e/**/*.ts'], languageOptions: { globals: globals.node } },
);
