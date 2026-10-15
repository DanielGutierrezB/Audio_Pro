'use strict';

const js = require('@eslint/js');
const globals = require('globals');

// Three environments live in this repo and they are genuinely different:
//
//   plugin/js   — runs inside CEP, which is Chromium *with* Node enabled
//                 (--enable-nodejs --mixed-context), so both sets of globals
//                 are real. `fetch`, `document` and `require` all exist.
//   plugin/core — plain Node (child processes, fs). Copied verbatim from
//                 audio_education, so its style is not ours to change: only
//                 the error-level rules apply, formatting is left alone.
//   test, scripts — plain Node.
//
// plugin/jsx is ExtendScript (ES3 with Adobe's own globals), which ESLint has
// no parser for. test/host-jsx.test.js parses it with acorn at ecmaVersion 3
// instead, which is the check that actually matters there.
module.exports = [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'plugin/jsx/**',
      'plugin/lib/CSInterface.js',
      'plugin/bin/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['plugin/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.browser,
        ...globals.node,
        CSInterface: 'readonly',
        CSEvent: 'readonly',
        SystemPath: 'readonly',
        cep: 'readonly',
        cep_node: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['plugin/core/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      // Upstream's style is not ours to enforce: this directory is a verbatim
      // copy that scripts/check-core.sh byte-compares against its tag, so a
      // lint fix here would fail CI by definition. Only rules that would catch
      // a real defect are left on.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-assignment': 'off',
    },
  },
  {
    files: ['test/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
