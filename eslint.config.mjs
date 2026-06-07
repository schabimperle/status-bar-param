import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
	{
		ignores: ['out/**', 'dist/**', '**/*.d.ts'],
	},
	{
		files: ['src/**/*.ts'],
		languageOptions: {
			parser: tsParser,
			ecmaVersion: 2022,
			sourceType: 'module',
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		plugins: {
			'@typescript-eslint': tsPlugin,
		},
		rules: {
			curly: 'warn',
			eqeqeq: 'warn',
			'no-throw-literal': 'warn',
			semi: 'warn',
			// prefer ?? over ||; ignorePrimitives.string leaves string-typed `||`
			// (e.g. the intentional empty-string fallbacks) unflagged
			'@typescript-eslint/prefer-nullish-coalescing': ['warn', { ignorePrimitives: { string: true } }],
			'@typescript-eslint/naming-convention': [
				'warn',
				{
					selector: 'memberLike',
					modifiers: ['static', 'readonly'],
					format: ['UPPER_CASE'],
				},
			],
		},
	},
	// keep ESLint out of formatting; Prettier owns it
	eslintConfigPrettier,
];
