const globals = require('globals');
const eslintConfigPrettier = require('eslint-config-prettier');

module.exports = [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'commonjs',
      globals: {
        ...globals.browser,
        ...globals.node,
        I18N: 'readonly',
        electronAPI: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-console': 'off',
      semi: ['error', 'always'],
      // prettier와 충돌하는 서식 규칙 비활성화 (eslint-config-prettier).
      ...eslintConfigPrettier.rules,
    },
  },
  {
    ignores: ['node_modules/**', 'dist2/**', 'whisper-cpp/**', '_models/**'],
  },
];
