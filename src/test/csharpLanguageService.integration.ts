import * as assert from 'assert';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as vscode from 'vscode';
import { csharpLanguageService } from '../services/csharpLanguageService.js';
import { parseDocumentTypeFields } from '../services/generateMapTo.js';
import { findTypeInWorkspaceWithOptions, findHandlerForMediator } from '../utils/typeSearch.js';
import { adjustDocumentNamespace, prepareDocumentNamespaceAdjustment } from '../namespace/adjust.js';
import { applyNamespaceAdjustmentPlans } from '../namespace/refactor.js';
import { extractTypeToFile } from '../services/extractTypeToFile.js';
import { CSharpDiagnosticsCodeActionProvider } from '../diagnostics/codeActionProvider.js';
import { DIAGNOSTIC_CODE_NAMESPACE, DIAGNOSTIC_SOURCE } from '../diagnostics/diagnosticsProvider.js';
import { deriveNamespaceFromFile } from '../namespace/compute.js';
import { adjustNamespaceForFolder } from '../services/namespaceAdjuster.js';

suite('Microsoft C# integration', () => {
	let bookDocument: vscode.TextDocument;

	suiteSetup(async () => {
		if (process.env.CSHARP_TEST_DOTNET_PATH) {
			await vscode.workspace.getConfiguration('dotnetAcquisitionExtension').update('existingDotnetPath', [
				{ extensionId: 'ms-dotnettools.csharp', path: process.env.CSHARP_TEST_DOTNET_PATH },
			], vscode.ConfigurationTarget.Global);
		}
		const extension = vscode.extensions.getExtension<{ initializationFinished(): Promise<void> }>('ms-dotnettools.csharp');
		assert.ok(extension, 'Microsoft C# must be installed for integration tests.');
		const api = await extension.activate();
		await api.initializationFinished();
		const painkiller = vscode.extensions.getExtension('DzmitryPratsko.csharppainkiller');
		assert.ok(painkiller, 'C# Painkiller must be loaded as the development extension.');
		await painkiller.activate();
		assert.ok(painkiller.isActive, 'C# Painkiller activation must finish successfully.');
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		assert.ok(root, 'Open the language-service fixture workspace.');
		bookDocument = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'Book.cs'));
		await vscode.window.showTextDocument(bookDocument);
	});

	test('gets real C# type ranges and excludes comments, strings and nested properties from mapping', async () => {
		const types = await csharpLanguageService.getTypes(bookDocument);
		assert.deepStrictEqual(types.map(type => [type.name, type.type, type.nested]), [
			['Book', 'class', false], ['Nested', 'class', true], ['BookDto', 'record', false],
		]);
		assert.ok(types.every(type => type.namespace === 'LanguageService'));
		const fields = await parseDocumentTypeFields(bookDocument, 'Book');
		assert.deepStrictEqual(fields.map(field => field.name), ['Id', 'Name', 'Example']);
		const dtoFields = await parseDocumentTypeFields(bookDocument, 'BookDto');
		assert.deepStrictEqual(dtoFields.map(field => [field.name, field.typeName]), [['Id', 'int'], ['Name', 'string']]);
	});

	test('resolves source types through the workspace symbol provider', async () => {
		const found = await findTypeInWorkspaceWithOptions('Consumer', { contextUri: bookDocument.uri });
		assert.ok(found);
		assert.strictEqual(found.namespace, 'LanguageService');
		assert.strictEqual(path.basename(found.fileUri.fsPath), 'Consumer.cs');
		assert.strictEqual(await findTypeInWorkspaceWithOptions('FakeBook'), undefined);
	});

	test('recognizes Roslyn constructor symbols for immutable mapping targets', async () => {
		const root = vscode.workspace.workspaceFolders![0].uri;
		const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'Consumer.cs'));
		const fields = await parseDocumentTypeFields(document, 'ReadOnlyBook');
		assert.strictEqual(fields[0].name, 'Id');
		assert.strictEqual(fields[0].canWrite, false);
		assert.deepStrictEqual(fields.constructors?.map(constructor => constructor.parameters.map(parameter => [parameter.name, parameter.typeName])), [
			[['id', 'int']],
		]);
	});

	test('semantic identifier ranges ignore type-looking comments and raw strings', async () => {
		const identifiers = (await csharpLanguageService.getIdentifierRanges(bookDocument)).map(range => bookDocument.getText(range));
		assert.ok(identifiers.includes('Book'));
		assert.ok(identifiers.includes('Name'));
		assert.ok(!identifiers.includes('FakeBook'));
		assert.ok(!identifiers.includes('StringBook'));
	});

	test('semantic rename includes constructors and cross-file references, but not string literals', async () => {
		const book = (await csharpLanguageService.getTypes(bookDocument)).find(type => type.name === 'Book');
		assert.ok(book);
		const edit = await csharpLanguageService.getRenameEdit(bookDocument, book, 'Publication');
		const root = vscode.workspace.workspaceFolders![0].uri;
		const consumerUri = vscode.Uri.joinPath(root, 'Consumer.cs');
		assert.ok(edit.get(bookDocument.uri).length >= 2, 'Rename must update the type and its constructor.');
		assert.strictEqual(edit.get(consumerUri).length, 2, 'Rename must update the return type and constructor call only.');
		const consumer = await vscode.workspace.openTextDocument(consumerUri);
		assert.ok(edit.get(consumerUri).every(change => consumer.getText(change.range) === 'Book'));
		assert.ok(edit.get(consumerUri).every(change => change.range.start.line !== 5));
	});

	test('resolves mediator libraries through definitions with global usings and ignores handler constraints', async () => {
		const root = vscode.workspace.workspaceFolders![0].uri;
		const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'MediatorTypes.cs'));
		const info = await csharpLanguageService.getMediatorInfo(document);
		assert.strictEqual(info?.className, 'FindBookQuery');
		assert.strictEqual(info?.returnType, 'string');
		assert.strictEqual(info?.library, 'MediatR');
		const other = await csharpLanguageService.getMediatorInfo(document, 'OtherQuery');
		assert.strictEqual(other?.className, 'OtherQuery');
		assert.strictEqual(other?.returnType, 'int');
		assert.strictEqual(other?.library, 'MediatR');
		const handler = await findHandlerForMediator('FindBookQuery', 'request', { contextUri: document.uri });
		assert.strictEqual(handler?.name, 'ArbitraryHandler');
		assert.strictEqual(handler?.namespace, 'LanguageService');
	});

	test('extracts a record class using its real declaration range', async () => {
		const root = vscode.workspace.workspaceFolders![0].uri;
		const uri = vscode.Uri.joinPath(root, 'BookDto.cs');
		await assert.rejects(Promise.resolve(vscode.workspace.fs.stat(uri)), (error: unknown) =>
			error instanceof vscode.FileSystemError && error.code === 'FileNotFound');
		const original = bookDocument.getText();
		try {
			await extractTypeToFile(bookDocument, 'BookDto');
			const extracted = await vscode.workspace.openTextDocument(uri);
			assert.ok(extracted.getText().includes('namespace LanguageService;'));
			assert.ok(extracted.getText().includes('public record class BookDto(int Id, string Name);'));
			assert.ok(!bookDocument.getText().includes('public record class BookDto'));
			assert.ok(bookDocument.getText().includes('"""public class StringBook { }"""'));
		} finally {
			const restore = new vscode.WorkspaceEdit();
			restore.replace(bookDocument.uri, new vscode.Range(new vscode.Position(0, 0), bookDocument.positionAt(bookDocument.getText().length)), original);
			restore.deleteFile(uri, { ignoreIfNotExists: true });
			assert.ok(await vscode.workspace.applyEdit(restore));
			assert.ok(await bookDocument.save());
		}
	});

	test('renaming a file applies semantic type and cross-file reference edits before the move', async () => {
		const root = vscode.workspace.workspaceFolders![0].uri;
		const originalUri = vscode.Uri.joinPath(root, 'RenameTarget.cs');
		const renamedUri = vscode.Uri.joinPath(root, 'RenamedTarget.cs');
		const target = await vscode.workspace.openTextDocument(originalUri);
		const consumer = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'Consumer.cs'));
		const targetContent = target.getText();
		const consumerContent = consumer.getText();
		const rename = new vscode.WorkspaceEdit();
		rename.renameFile(originalUri, renamedUri);
		assert.ok(await vscode.workspace.applyEdit(rename));
		try {
			const renamed = await vscode.workspace.openTextDocument(renamedUri);
			assert.ok(renamed.getText().includes('class RenamedTarget'));
			assert.ok(renamed.getText().includes('public RenamedTarget()'));
			assert.ok(consumer.getText().includes('public RenamedTarget Target() => new RenamedTarget();'));
		} finally {
			const restoreFile = new vscode.WorkspaceEdit();
			restoreFile.renameFile(renamedUri, originalUri);
			assert.ok(await vscode.workspace.applyEdit(restoreFile));
			const restored = await vscode.workspace.openTextDocument(originalUri);
			const restoreContents = new vscode.WorkspaceEdit();
			restoreContents.replace(originalUri, new vscode.Range(new vscode.Position(0, 0), restored.positionAt(restored.getText().length)), targetContent);
			restoreContents.replace(consumer.uri, new vscode.Range(new vscode.Position(0, 0), consumer.positionAt(consumer.getText().length)), consumerContent);
			assert.ok(await vscode.workspace.applyEdit(restoreContents));
			assert.ok(await restored.save());
			assert.ok(await consumer.save());
		}
	});

	test('namespace adjustment removes only server-reported namespace braces', async () => {
		const content = 'namespace Old.Section\n{\n    public class BraceSample\n    {\n        public const string Text = """namespace Fake { }""";\n    }\n}';
		const document = await vscode.workspace.openTextDocument({ language: 'csharp', content });
		const result = await adjustDocumentNamespace(document, 'Updated');
		assert.ok(result.adjusted);
		assert.strictEqual(result.oldNamespace, 'Old.Section');
		assert.ok(document.getText().startsWith('namespace Updated;'));
		assert.ok(document.getText().includes('"""namespace Fake { }"""'));
		assert.deepStrictEqual((await csharpLanguageService.getTypes(document)).map(type => [type.name, type.namespace]), [
			['BraceSample', 'Updated'],
		]);
	});

	test('adjusts file-scoped namespaces while preserving usings, comments and the type body', async () => {
		const body = 'public class ScopeSample { public const string Text = "namespace Fake;"; }';
		const document = await vscode.workspace.openTextDocument({
			language: 'csharp', content: `using System;\n\nnamespace Old.Section; // keep this comment\n\n${body}`,
		});
		const namespace = (await csharpLanguageService.getSymbols(document))[0];
		await assert.doesNotReject(adjustDocumentNamespace(document, 'Updated.Section'),
			JSON.stringify({ selected: document.getText(namespace.selectionRange), range: document.getText(namespace.range) }));
		assert.ok(document.getText().includes('namespace Updated.Section;'));
		assert.ok(document.getText().includes('// keep this comment'));
		assert.ok(document.getText().includes('using System;'));
		assert.ok(document.getText().includes(body));
		assert.deepStrictEqual((await csharpLanguageService.getTypes(document)).map(type => type.namespace), ['Updated.Section']);
	});

	test('the namespace quick fix executes the registered command on an unsaved file-scoped document', async () => {
		const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'RenameTarget.cs');
		const document = await vscode.workspace.openTextDocument(uri);
		const original = document.getText();
		try {
			const changed = new vscode.WorkspaceEdit();
			changed.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(original.length)),
				original.replace('namespace LanguageService;', 'namespace Incorrect.Section;'));
			assert.ok(await vscode.workspace.applyEdit(changed));
			const expectedNamespace = await deriveNamespaceFromFile(uri);
			const diagnostic = new vscode.Diagnostic(document.lineAt(0).range, 'Wrong namespace');
			diagnostic.source = DIAGNOSTIC_SOURCE;
			diagnostic.code = DIAGNOSTIC_CODE_NAMESPACE;
			const cancellation = new vscode.CancellationTokenSource();
			try {
				const actions = new CSharpDiagnosticsCodeActionProvider().provideCodeActions(document, diagnostic.range,
					{ diagnostics: [diagnostic], only: vscode.CodeActionKind.QuickFix, triggerKind: vscode.CodeActionTriggerKind.Invoke }, cancellation.token);
				const command = actions[0]?.command;
				assert.ok(command);
				await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
			} finally {
				cancellation.dispose();
			}
			assert.ok(document.getText().includes(`namespace ${expectedNamespace};`), document.getText());
			assert.ok(document.isDirty, 'Namespace edits must preserve unsaved document behavior.');
		} finally {
			const restore = new vscode.WorkspaceEdit();
			restore.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), original);
			assert.ok(await vscode.workspace.applyEdit(restore));
			assert.ok(await document.save());
		}
	});

	async function namespaceScenario(action: (documents: Map<string, vscode.TextDocument>) => Promise<void>): Promise<void> {
		const root = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'NamespaceScenarios');
		const files = ['Move/Moving.cs', 'Move/Second.cs', 'Staying.cs', 'OnlyMoving.cs', 'Mixed.cs', 'Unrelated.cs', 'Specialty.cs', 'GlobalImports.cs', 'GlobalOnly.cs', 'Solo.cs', 'SoloConsumer.cs', 'Collision.cs', 'SoloUnused.cs'];
		const documents = new Map<string, vscode.TextDocument>();
		const originals = new Map<string, string>();
		for (const file of files) {
			const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, file));
			documents.set(file, document);
			originals.set(file, document.getText());
		}
		try {
			await action(documents);
			for (const document of documents.values()) { assert.ok(await document.save()); }
			const build = spawnSync(process.env.CSHARP_TEST_DOTNET_PATH ?? 'dotnet',
				['build', 'LanguageService.csproj', '--no-restore', '--verbosity', 'quiet'],
				{ cwd: vscode.workspace.workspaceFolders![0].uri.fsPath, encoding: 'utf8', timeout: 60000 });
			assert.strictEqual(build.status, 0, `${build.error ?? ''}\n${build.stdout}\n${build.stderr}`);
		} finally {
			const restore = new vscode.WorkspaceEdit();
			for (const [file, document] of documents) {
				restore.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), originals.get(file)!);
			}
			assert.ok(await vscode.workspace.applyEdit(restore));
			for (const document of documents.values()) { assert.ok(await document.save()); }
		}
	}

	test('namespace moves update only real consumers and retain imports needed by types left behind', async () => {
		await namespaceScenario(async documents => {
			const source = documents.get('Move/Moving.cs')!;
			const unrelated = documents.get('Unrelated.cs')!.getText();
			await adjustDocumentNamespace(source, 'NamespaceScenarios.After');
			const only = documents.get('OnlyMoving.cs')!.getText();
			assert.ok(only.includes('using NamespaceScenarios.After;'), only);
			assert.ok(!only.includes('using NamespaceScenarios.Before;'), only);
			assert.ok(only.includes('// preserve the comment'));
			const mixed = documents.get('Mixed.cs')!.getText();
			assert.ok(mixed.includes('using NamespaceScenarios.Before;'), mixed);
			assert.ok(mixed.includes('using NamespaceScenarios.After;'), mixed);
			assert.strictEqual(documents.get('Unrelated.cs')!.getText(), unrelated);
			assert.ok(!source.getText().includes('using NamespaceScenarios.Before;'), 'The existing global import already covers types left behind.');
			assert.ok(documents.get('Move/Second.cs')!.getText().includes('using NamespaceScenarios.After;'));
			const special = documents.get('Specialty.cs')!.getText();
			assert.ok(special.includes('using M = global::NamespaceScenarios.After.Moving;'), special);
			assert.ok(special.includes('using N = NamespaceScenarios.Before;'));
			assert.ok(special.includes('global::NamespaceScenarios.After.Moving Another'));
			assert.ok(special.includes('N.Staying Other'));
			assert.ok(special.includes('using static global::NamespaceScenarios.After.Moving;'));
			assert.ok(!special.includes('global::NamespaceScenarios.Before.Moving'));
			assert.ok(special.includes('using NamespaceScenarios.Before;'));
			assert.ok(special.includes('using NamespaceScenarios.After;'));
			assert.ok(special.includes('global::NamespaceScenarios.After.Moving Value'));
			const staticExtension = special.slice(special.indexOf('namespace NamespaceScenarios.StaticExtension'));
			assert.ok(!staticExtension.includes('using NamespaceScenarios.After;'), staticExtension);
			assert.ok(staticExtension.includes('global::NamespaceScenarios.After.MovingExtensions.MovedExtension'), staticExtension);
		});
	});

	test('folder namespace moves capture inter-file references before modifying any declaration', async () => {
		await namespaceScenario(async documents => {
			const source = documents.get('Move/Moving.cs')!;
			const expected = await deriveNamespaceFromFile(source.uri);
			const count = await adjustNamespaceForFolder(vscode.Uri.joinPath(source.uri, '..'));
			assert.strictEqual(count, 2);
			assert.ok(source.getText().includes(`namespace ${expected};`));
			const second = documents.get('Move/Second.cs')!.getText();
			assert.ok(second.includes(`namespace ${expected};`), second);
			assert.ok(!second.includes('using NamespaceScenarios.Before;'), second);
			assert.ok(documents.get('OnlyMoving.cs')!.getText().includes(`using ${expected};`));
			assert.ok(!documents.get('Unrelated.cs')!.getText().includes(`using ${expected};`));
		});
	});

	test('global imports do not spread new namespaces and orphaned global imports are removed', async () => {
		await namespaceScenario(async documents => {
			const unrelated = documents.get('Unrelated.cs')!.getText();
			await adjustDocumentNamespace(documents.get('Solo.cs')!, 'NamespaceScenarios.SoloAfter');
			assert.ok(!documents.get('GlobalImports.cs')!.getText().includes('using NamespaceScenarios.SoloBefore;'));
			assert.ok(!documents.get('GlobalImports.cs')!.getText().includes('using NamespaceScenarios.SoloAfter;'));
			assert.ok(documents.get('SoloConsumer.cs')!.getText().includes('using NamespaceScenarios.SoloAfter;'));
			assert.ok(!documents.get('SoloUnused.cs')!.getText().includes('using NamespaceScenarios.SoloBefore;'));
			assert.ok(!documents.get('SoloUnused.cs')!.getText().includes('using NamespaceScenarios.SoloAfter;'));
			assert.strictEqual(documents.get('Unrelated.cs')!.getText(), unrelated);
			await adjustDocumentNamespace(documents.get('Move/Moving.cs')!, 'NamespaceScenarios.After');
			assert.ok(documents.get('GlobalImports.cs')!.getText().includes('using NamespaceScenarios.Before;'));
			assert.ok(documents.get('GlobalOnly.cs')!.getText().includes('using NamespaceScenarios.After;'));
		});
	});

	test('namespace import conflicts qualify moved references rather than making unrelated types ambiguous', async () => {
		await namespaceScenario(async documents => {
			await adjustDocumentNamespace(documents.get('Solo.cs')!, 'NamespaceScenarios.Collision');
			const consumer = documents.get('SoloConsumer.cs')!.getText();
			assert.ok(!consumer.includes('using NamespaceScenarios.Collision;'), consumer);
			assert.ok(consumer.includes('global::NamespaceScenarios.Collision.Solo'), consumer);
		});
	});

	test('unsafe extension-import conflicts fail before modifying any declaration or consumer', async () => {
		await namespaceScenario(async documents => {
			const originals = new Map([...documents].map(([file, document]) => [file, document.getText()]));
			await assert.rejects(adjustDocumentNamespace(documents.get('Move/Moving.cs')!, 'NamespaceScenarios.Collision'), /ambiguous import/);
			for (const [file, document] of documents) { assert.strictEqual(document.getText(), originals.get(file)); }
		});
	});

	test('consumer edits during namespace planning abort the refactoring without overwriting the edit', async () => {
		await namespaceScenario(async documents => {
			const source = documents.get('Move/Moving.cs')!;
			const consumer = documents.get('OnlyMoving.cs')!;
			const original = source.getText();
			const plan = await prepareDocumentNamespaceAdjustment(source, 'NamespaceScenarios.After');
			assert.ok(plan);
			const getRanges = csharpLanguageService.getIdentifierRanges;
			let changed = false;
			csharpLanguageService.getIdentifierRanges = async (document, kinds) => {
				if (document.uri.toString() === consumer.uri.toString() && !changed) {
					changed = true;
					const edit = new vscode.WorkspaceEdit();
					edit.insert(document.uri, new vscode.Position(0, 0), '// concurrent editor change\n');
					assert.ok(await vscode.workspace.applyEdit(edit));
				}
				return getRanges.call(csharpLanguageService, document, kinds);
			};
			try {
				await assert.rejects(applyNamespaceAdjustmentPlans([plan]), /changed while preparing/);
				assert.strictEqual(source.getText(), original);
				assert.ok(consumer.getText().startsWith('// concurrent editor change'));
			} finally {
				csharpLanguageService.getIdentifierRanges = getRanges;
			}
		});
	});

	test('multiple namespace declarations are rejected rather than flattening scoped imports unsafely', async () => {
		const content = 'namespace First { public class One {} }\nnamespace Second { using System; public class Two {} }';
		const document = await vscode.workspace.openTextDocument({ language: 'csharp', content });
		await assert.rejects(adjustDocumentNamespace(document, 'Merged'), /multiple namespace/);
		assert.strictEqual(document.getText(), content);
	});
});
