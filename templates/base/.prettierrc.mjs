export default {
    semi: false,
    singleQuote: true,
    trailingComma: 'none',
    tabWidth: 2,
    printWidth: 100,
    plugins: ['@nekosu/prettier-plugin-maafw-sort', 'prettier-plugin-multiline-arrays'],
    overrides: [
        {
            files: ['*.json', '*.jsonc'],
            options: {
                parser: 'jsonc',
                tabWidth: 4
            }
        }
    ]
}
