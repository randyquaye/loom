import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '.context/**',
      'out/**',
      'release/**',
      'node_modules/**',
      'test/fixtures/**',
      'mobile/android/**/build/**'
    ]
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'test/**/*.ts', '*.config.ts', '*.config.mjs'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error'
    }
  },
  {
    files: ['src/renderer/**/*.tsx'],
    rules: {
      'react-hooks/rules-of-hooks': 'off'
    }
  }
)
