import js from '@eslint/js';

const globals = Object.fromEntries(
  ['process', 'console', 'fetch', 'URL', 'URLSearchParams', 'AbortSignal', 'setTimeout', 'clearTimeout', 'Buffer', 'TextDecoder', 'TextEncoder'].map((n) => [n, 'readonly']),
);

export default [
  { ignores: ['node_modules/'] },
  js.configs.recommended,
  { languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals } },
];
