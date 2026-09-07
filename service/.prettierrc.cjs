/**
 * Mirrors unraid/api's api/.prettierrc.cjs so the companion service formats
 * the same way as the codebase it extends. Import groups drop their @nestjs
 * and @app entries: this service has neither.
 *
 * @type {import("prettier").Config}
 */
module.exports = {
    trailingComma: 'es5',
    tabWidth: 4,
    semi: true,
    singleQuote: true,
    printWidth: 105,
    plugins: ['@ianvs/prettier-plugin-sort-imports'],
    importOrderParserPlugins: ['typescript'],
    importOrder: [
        '<TYPES>^(node:)',
        '<BUILTIN_MODULES>',
        '',
        '<TYPES>',
        '<THIRD_PARTY_MODULES>',
        '',
        '<TYPES>^[.]',
        '^[.]',
    ],
};
