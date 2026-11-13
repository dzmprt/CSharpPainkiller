import * as assert from 'assert';
import * as vscode from 'vscode';
import { type DotnetTemplate, registerDynamicTemplateCommands } from '../services/dotnetTemplates.js';

suite('Dynamic .NET template commands', () => {
	const context = { subscriptions: [] as vscode.Disposable[] };

	teardown(() => {
		for (const disposable of context.subscriptions.splice(0)) { disposable.dispose(); }
	});

	function template(name: string, shorthand: string, classId: string): DotnetTemplate {
		return { name, shorthand, classId, language: ['[C#]'], tags: ['MAUI'], menuOrder: 0 };
	}

	test('registers repeated CLI short names only once, including alias lists', async () => {
		const page = template('MAUI ContentPage (C#)', 'maui-page-csharp', 'csharppainkiller.dotnet.create.mauipagecsharp');
		const web = template('Web App', 'webapp,razor', 'csharppainkiller.dotnet.create.webapprazor');
		const entries = registerDynamicTemplateCommands([
			page,
			{ ...page, name: 'MAUI ContentPage (C#) (Preview)' },
			web,
			{ ...web, shorthand: 'webapp' },
		], context);

		assert.deepStrictEqual(entries.map(entry => entry.template.shorthand), ['maui-page-csharp', 'webapp,razor']);
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes(page.classId));
		assert.ok(commands.includes('csharppainkiller.dotnet.createProject'));
	});

	test('preserves distinct templates whose sanitized command IDs collide', async () => {
		const classId = 'csharppainkiller.dotnet.create.testtemplate';
		const templates = [
			template('Dashed', 'test-template', classId),
			template('Plain', 'testtemplate', classId),
			template('Reserved suffix', 'testtemplate1', `${classId}_1`),
		];
		const entries = registerDynamicTemplateCommands(templates, context);
		assert.deepStrictEqual(entries.map(entry => entry.template.shorthand), templates.map(item => item.shorthand));
		assert.strictEqual(new Set(entries.map(entry => entry.template.classId)).size, 3);
		const commands = await vscode.commands.getCommands(true);
		assert.ok(entries.every(entry => commands.includes(entry.template.classId)));
	});
});
