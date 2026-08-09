import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/next-env.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Tooling config files are CommonJS; the flat-config default of ESM would
  // flag `module.exports`.
  {
    files: ['**/*.config.js', '**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },

  {
    files: ['apps/api/**/*.spec.ts'],
    languageOptions: { globals: { ...globals.jest } },
  },

  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      // App Router only — this rule looks for a `pages/` directory that will
      // never exist and warns on every run.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },

  // Must stay last: turns off every rule that fights Prettier.
  prettier,
);
