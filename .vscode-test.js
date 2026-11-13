const { defineConfig } = require('@vscode/test-cli');
const path = require('path');

const installation = process.env.VSCODE_EXECUTABLE_PATH
	? { fromPath: process.env.VSCODE_EXECUTABLE_PATH } : undefined;

module.exports = defineConfig([
	{
		label: 'unit',
		files: 'out/test/**/*.test.js',
		useInstallation: installation,
		skipExtensionDependencies: true,
		launchArgs: ['--disable-extensions'],
		mocha: { ui: 'tdd' },
	},
	{
		label: 'csharp-integration',
		files: 'out/test/csharpLanguageService.integration.js',
		workspaceFolder: path.join(__dirname, 'src/test/fixtures/language-service'),
		useInstallation: installation,
		launchArgs: ['--disable-workspace-trust'],
		mocha: { ui: 'tdd', timeout: 120000 },
	},
]);
