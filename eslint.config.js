export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['scripts/**/*.mjs', 'scripts/**/*.cjs', '*.cjs', '*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'always', { null: 'ignore' }],
    },
  },
];
