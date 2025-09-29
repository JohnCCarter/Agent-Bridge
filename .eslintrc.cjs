module.exports = {
  root: true,
  env: { node: true, es2022: true },
  ignorePatterns: ['dist/', 'node_modules/', 'package-lock.json'],
  overrides: [
    {
      files: ['**/*.ts', '**/*.tsx'],
      parser: '@typescript-eslint/parser',
      plugins: ['@typescript-eslint'],
      extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
      rules: {
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      },
    },
    {
      files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
      extends: ['eslint:recommended'],
      rules: {
        'no-unused-vars': 'off',
        'no-console': 'off'
      },
    },
  ],
};