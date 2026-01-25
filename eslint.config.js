 const globals = require('globals');
 
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
      'no-unused-vars': ['warn', { 
        argsIgnorePattern: '^_', 
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }],
       'no-console': 'off',
       semi: ['error', 'always'],
     },
   },
   {
     ignores: ['node_modules/**', 'dist2/**', 'whisper-cpp/**', '_models/**'],
   },
 ];
