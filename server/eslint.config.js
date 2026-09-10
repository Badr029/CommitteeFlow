import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Server lint rules.
 *
 * Type-aware, because the rules worth having here — floating promises,
 * unchecked awaits — cannot be found without types.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false } },
      ],
      // Rows come back from `pg` as `any`; the repositories narrow them.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/require-await': 'off',
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // The seed script and the migration runner are operator tools.
    files: ['src/db/seed.ts', 'scripts/**/*'],
    rules: { 'no-console': 'off' },
  },
  {
    // supertest types `res.body` as `any`, which is the right call for a
    // generic HTTP client but makes every assertion an "unsafe" expression.
    // The tests assert on those bodies deliberately.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
);
