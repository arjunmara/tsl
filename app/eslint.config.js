import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

// Layer rule:
// ui may import nothing else in src.
// features may import ui and domain.
// domain may import outbox and Supabase.
// outbox may import Supabase.
const supabase = { group: ['@supabase/*'], message: 'only domain and outbox import Supabase' }
const below = 'ui imports nothing below it'

export default tseslint.config(
  { ignores: ['dist', 'dev-dist'] },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: [supabase] }] },
  },
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/features', '**/features/**', '**/domain', '**/domain/**', '**/outbox', '**/outbox/**'], message: below },
          { group: ['@supabase/*'], message: below },
        ],
      }],
    },
  },
  {
    files: ['src/features/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [supabase, { group: ['**/outbox', '**/outbox/**'], message: 'features write through domain' }],
      }],
    },
  },
  {
    files: ['src/domain/**/*.{ts,tsx}', 'src/outbox/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['**/features', '**/features/**', '**/ui', '**/ui/**'], message: 'domain and outbox import nothing above them' }],
      }],
    },
  },
)
