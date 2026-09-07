/**
 * Follows unraid/api's api/.eslintrc.ts: eslint recommended + typescript-eslint
 * recommended, with prettier enforced as a lint rule.
 *
 * Two deliberate divergences from upstream, both because they do not apply here:
 * no-relative-import-paths (this service has no @app alias) and the __dirname
 * ban (upstream's api is ESM; this service is CommonJS and uses it on purpose).
 *
 * Upstream also disables no-explicit-any, no-unsafe-*, no-unused-vars and
 * naming-convention. Those stay ON here: this codebase was largely machine-
 * written, so the findings need reading rather than silencing.
 */
import eslint from '@eslint/js';
import prettier from 'eslint-plugin-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        ignores: ['dist/**', 'build/**', 'node_modules/**', '*.config.mjs', '.prettierrc.cjs'],
    },
    {
        plugins: { prettier },
        rules: {
            'prettier/prettier': 'error',
            'no-multiple-empty-lines': ['error', { max: 1, maxBOF: 0, maxEOF: 1 }],
            'eol-last': ['error', 'always'],
            '@typescript-eslint/no-non-null-assertion': 'warn',
        },
    }
);
