import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'src-tauri/**', 'node_modules/**', 'tests/e2e/screenshots/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The model is pure UI state: no DOM, no Tauri, no view code.
    files: ['src/model/**/*.ts', 'src/config.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@tauri-apps/*'], message: 'src/model must not import Tauri.' },
          { group: ['**/view/**', '**/input/**', '**/transport*'], message: 'src/model must not import view, input or transport code.' },
        ],
      }],
      'no-restricted-globals': ['error',
        ...['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Range', 'getComputedStyle', 'requestAnimationFrame', 'localStorage']
          .map((name) => ({ name, message: 'src/model must not touch the DOM.' })),
      ],
    },
  },
);
