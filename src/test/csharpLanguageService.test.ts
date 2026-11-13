import * as assert from 'assert';
import * as vscode from 'vscode';
import { CSharpLanguageService } from '../services/csharpLanguageService.js';

suite('C# language service', () => {
	const disposables: vscode.Disposable[] = [];
	let service: CSharpLanguageService;

	setup(() => {
		service = new CSharpLanguageService(async () => {});
		disposables.push(service);
	});

	teardown(() => {
		for (const disposable of disposables.splice(0)) { disposable.dispose(); }
	});

	function provide(provider: vscode.DocumentSymbolProvider): void {
		disposables.push(vscode.languages.registerDocumentSymbolProvider(
			{ language: 'plaintext', scheme: 'untitled' }, provider
		));
	}

	function symbol(document: vscode.TextDocument, name: string, declaration: string, kind: vscode.SymbolKind): vscode.DocumentSymbol {
		const content = document.getText();
		const start = content.indexOf(declaration);
		const nameStart = content.indexOf(name, start);
		return new vscode.DocumentSymbol(
			name, 'not a namespace', kind,
			new vscode.Range(document.positionAt(start), document.positionAt(start + declaration.length)),
			new vscode.Range(document.positionAt(nameStart), document.positionAt(nameStart + name.length))
		);
	}

	test('rejects cancelled semantic renames before dispatch and while the provider is running', async () => {
		const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'public class Book {}' });
		const declaration = symbol(document, 'Book', 'public class Book {}', vscode.SymbolKind.Class);
		provide({ provideDocumentSymbols: () => [declaration] });
		const type = (await service.getTypes(document))[0];
		let calls = 0;
		let started!: () => void;
		let finish!: (edit: vscode.WorkspaceEdit) => void;
		const providerStarted = new Promise<void>(resolve => { started = resolve; });
		const providerResult = new Promise<vscode.WorkspaceEdit>(resolve => { finish = resolve; });
		disposables.push(vscode.languages.registerRenameProvider({ language: 'plaintext', scheme: 'untitled' }, {
			provideRenameEdits: () => { calls++; started(); return providerResult; },
		}));
		const cancellation = new vscode.CancellationTokenSource();
		disposables.push(cancellation);
		cancellation.cancel();
		await assert.rejects(service.getRenameEdit(document, type, 'Publication', cancellation.token), vscode.CancellationError);
		assert.strictEqual(calls, 0);

		const inFlightCancellation = new vscode.CancellationTokenSource();
		disposables.push(inFlightCancellation);
		const rename = service.getRenameEdit(document, type, 'Publication', inFlightCancellation.token);
		await providerStarted;
		inFlightCancellation.cancel();
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, declaration.selectionRange, 'Publication');
		finish(edit);
		await assert.rejects(rename, vscode.CancellationError);
		assert.strictEqual(calls, 1);
	});

	test('shares in-flight requests and reuses only the current document version', async () => {
		const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'public class Book {}' });
		let calls = 0;
		provide({
			provideDocumentSymbols: doc => {
				calls++;
				return [symbol(doc, 'Book', 'public class Book {}', vscode.SymbolKind.Class)];
			},
		});
		const [first, second] = await Promise.all([service.getSymbols(document), service.getSymbols(document)]);
		assert.strictEqual(calls, 1);
		assert.strictEqual(first, second);
		await service.getTypes(document);
		assert.strictEqual(calls, 1);

		const edit = new vscode.WorkspaceEdit();
		edit.insert(document.uri, new vscode.Position(0, 0), '// unsaved edit\n');
		assert.ok(await vscode.workspace.applyEdit(edit));
		await service.getTypes(document);
		assert.strictEqual(calls, 2);
	});

	test('uses provider hierarchy and ignores type-looking comments and strings', async () => {
		const declaration = 'public record class Order<T>(T Value) { public class Nested {} }';
		const content = `// public class Fake {}\n${declaration}\nconst string Example = "public class Other {}";`;
		const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content });
		const order = symbol(document, 'Order', declaration, vscode.SymbolKind.Class);
		order.children.push(symbol(document, 'Nested', 'public class Nested {}', vscode.SymbolKind.Class));
		provide({ provideDocumentSymbols: () => [order] });

		const types = await service.getTypes(document);
		assert.deepStrictEqual(types.map(type => [type.name, type.type, type.nested, type.namespace]), [
			['Order', 'record', false, ''], ['Nested', 'class', true, ''],
		]);
		assert.strictEqual(await service.getTypeAtPosition(document, new vscode.Position(0, 16)), undefined);
		assert.strictEqual((await service.getTypeAtPosition(document, order.selectionRange.start))?.name, 'Order');
		assert.strictEqual(service.getHeader(document, types[0]), 'public record class Order<T>(T Value)');
	});

	test('collects aliases and static imports only from the selected type namespace scopes', async () => {
		const declaration = 'public class Book { public string Text => "using Wrong;"; public void Work() { using var stream = Open(); } }';
		const innerText = `namespace Inner {\nusing static External.Helpers;\n${declaration}\n}`;
		const outerText = `namespace Outer {\nusing Payload = External.Payload;\n${innerText}\n}`;
		const otherText = 'namespace Other { using Wrong; public class OtherBook {} }';
		const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: [
			'global using System;',
			'using FileAlias = External.Payload;',
			outerText,
			otherText,
		].join('\n') });
		const outer = symbol(document, 'Outer', outerText, vscode.SymbolKind.Namespace);
		const inner = symbol(document, 'Inner', innerText, vscode.SymbolKind.Namespace);
		const book = symbol(document, 'Book', declaration, vscode.SymbolKind.Class);
		inner.children.push(book);
		outer.children.push(inner);
		provide({ provideDocumentSymbols: () => [
			outer, symbol(document, 'Other', otherText, vscode.SymbolKind.Namespace),
		] });
		const type = (await service.getTypes(document))[0];
		assert.deepStrictEqual(await service.getTypeFileContext(document, type), {
			usings: ['using FileAlias = External.Payload;'],
			namespaces: [
				{ name: 'Outer', usings: ['using Payload = External.Payload;'] },
				{ name: 'Inner', usings: ['using static External.Helpers;'] },
			],
		});
	});

	test('supports flat SymbolInformation results without guessing declarations from the whole file', async () => {
		const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'namespace Library.Models {\npublic class Book {}\n}' });
		const range = new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length));
		const declaration = symbol(document, 'Book', 'public class Book {}', vscode.SymbolKind.Class);
		provide({
			provideDocumentSymbols: () => [
				new vscode.SymbolInformation('Library.Models', vscode.SymbolKind.Namespace, '', new vscode.Location(document.uri, range)),
				new vscode.SymbolInformation('Book', vscode.SymbolKind.Class, 'Library.Models', new vscode.Location(document.uri, declaration.range)),
			],
		});
		const types = await service.getTypes(document);
		assert.strictEqual(types[0].name, 'Book');
		assert.strictEqual(types[0].namespace, 'Library.Models');
		assert.strictEqual(document.getText(types[0].symbol.selectionRange), 'Book');
	});

	test('does not mistake attributes and declaration comments for type modifiers', async () => {
		const content = '[Marker("public partial class Fake")]\ninternal /* partial */ class /* note */ Book {}';
		const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content });
		provide({ provideDocumentSymbols: () => [symbol(document, 'Book', content, vscode.SymbolKind.Class)] });
		const types = await service.getTypes(document);
		assert.strictEqual(types[0].name, 'Book');
		assert.strictEqual(types[0].public, false);
		assert.strictEqual(types[0].partial, false);
	});

	test('does not cancel a shared request for other consumers', async () => {
		const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'public class Book {}' });
		let resolve!: (symbols: vscode.DocumentSymbol[]) => void;
		let started!: () => void;
		const ready = new Promise<void>(done => { started = done; });
		provide({
			provideDocumentSymbols: () => {
				started();
				return new Promise<vscode.DocumentSymbol[]>(done => { resolve = done; });
			},
		});
		const token = new vscode.CancellationTokenSource();
		disposables.push(token);
		const cancelled = service.getSymbols(document, token.token);
		const other = service.getSymbols(document);
		await ready;
		token.cancel();
		resolve([]);
		await assert.rejects(cancelled, vscode.CancellationError);
		assert.deepStrictEqual(await other, []);
	});

	test('rejects stale in-flight results instead of publishing old symbol ranges', async () => {
		const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'public class Book {}' });
		let resolve!: (symbols: vscode.DocumentSymbol[]) => void;
		let started!: () => void;
		const ready = new Promise<void>(done => { started = done; });
		provide({
			provideDocumentSymbols: () => {
				started();
				return new Promise<vscode.DocumentSymbol[]>(done => { resolve = done; });
			},
		});
		const pending = service.getSymbols(document);
		await ready;
		const edit = new vscode.WorkspaceEdit();
		edit.insert(document.uri, new vscode.Position(0, 0), '\n');
		assert.ok(await vscode.workspace.applyEdit(edit));
		resolve([]);
		await assert.rejects(pending, vscode.CancellationError);
	});

	test('surfaces readiness failures and retries instead of falling back to source text', async () => {
		const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'public class Book {}' });
		let ready = false;
		let calls = 0;
		service = new CSharpLanguageService(async () => {
			if (!ready) { throw new Error('C# server unavailable'); }
		});
		disposables.push(service);
		provide({ provideDocumentSymbols: () => { calls++; return []; } });
		await assert.rejects(service.getTypes(document), /C# server unavailable/);
		assert.strictEqual(calls, 0);
		ready = true;
		assert.deepStrictEqual(await service.getTypes(document), []);
		assert.strictEqual(calls, 1);
	});
});
