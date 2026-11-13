import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { computeNamespaceForFile } from '../namespace/compute.js';
import * as fs from 'fs/promises';
import { CsprojCache } from '../utils/csprojCache.js';
import { adjustDocumentNamespace, adjustFileNamespace } from '../namespace/adjust.js';
import { adjustNamespaceForFolder, adjustNamespaceForSingleFile } from '../services/namespaceAdjuster.js';
import { CSharpLanguageService, csharpLanguageService } from '../services/csharpLanguageService.js';
import { applyNamespaceAdjustmentPlans } from '../namespace/refactor.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import {
	addUsingForNewNamespace,
	findTypeReferencesInContent,
	removeUsingDirective,
} from '../namespace/usingDirectives.js';

suite('namespace', () => {
	test('adjusts a parent folder containing multiple projects after VS Code evicts earlier documents', async function () {
		this.timeout(30000);
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'painkiller-batch-namespace-'));
		const root = vscode.Uri.file(path.join(directory, 'src'));
		const projects = ['First', 'Second'].map(name => vscode.Uri.joinPath(root, name, `${name}.csproj`));
		const files = projects.flatMap(project => Array.from({ length: 36 }, (_, index) =>
			vscode.Uri.joinPath(project, '..', `Item${index}.cs`)));
		const originals = new Map<string, string>();
		const cache = new CsprojCache(async () => projects, async uri => `Company.${path.basename(uri.fsPath, '.csproj')}`);
		const service = new CSharpLanguageService(async () => {});
		const originalCache = CsprojCache.getInstance;
		const originalFind = vscode.workspace.findFiles;
		const getSymbols = csharpLanguageService.getSymbols;
		const getTypes = csharpLanguageService.getTypes;
		const getRanges = csharpLanguageService.getIdentifierRanges;
		const request = csharpLanguageService.request;
		const showError = ErrorHandler.showError;
		const errors: string[] = [];
		const selector: vscode.DocumentSelector = { language: 'csharp', scheme: 'file', pattern: `${root.path}/**` };
		const registrations: vscode.Disposable[] = [];
		let evicted = false;
		try {
			for (const project of projects) {
				await fs.mkdir(path.dirname(project.fsPath), { recursive: true });
				await fs.writeFile(project.fsPath, '<Project Sdk="Microsoft.NET.Sdk" />');
			}
			for (const uri of files) {
				const content = `namespace Old;\npublic class ${path.basename(uri.fsPath, '.cs')} {}\n`;
				originals.set(uri.toString(), content);
				await fs.writeFile(uri.fsPath, content);
			}
			registrations.push(vscode.languages.registerDocumentSymbolProvider(selector, {
				provideDocumentSymbols: document => {
					const namespace = new vscode.DocumentSymbol('Old', '', vscode.SymbolKind.Namespace,
						new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), new vscode.Range(0, 10, 0, 13));
					const name = path.basename(document.uri.fsPath, '.cs');
					namespace.children = [new vscode.DocumentSymbol(name, '', vscode.SymbolKind.Class,
						document.lineAt(1).range, new vscode.Range(1, 13, 1, 13 + name.length))];
					return [namespace];
				},
			}), vscode.languages.registerDocumentSemanticTokensProvider(selector, {
				provideDocumentSemanticTokens: () => new vscode.SemanticTokens(new Uint32Array()),
			}, new vscode.SemanticTokensLegend(['class'])),
			vscode.workspace.onDidCloseTextDocument(document => {
				if (originals.has(document.uri.toString())) { evicted = true; }
			}));
			CsprojCache.getInstance = () => cache;
			Object.defineProperty(vscode.workspace, 'findFiles', { configurable: true,
				value: async (pattern: vscode.GlobPattern, exclude?: vscode.GlobPattern | null, maxResults?: number, token?: vscode.CancellationToken) =>
					typeof pattern !== 'string' && pattern.baseUri.toString() === root.toString()
						? files : originalFind(pattern, exclude, maxResults, token),
			});
			csharpLanguageService.getSymbols = service.getSymbols.bind(service);
			csharpLanguageService.getTypes = service.getTypes.bind(service);
			csharpLanguageService.getIdentifierRanges = service.getIdentifierRanges.bind(service);
			csharpLanguageService.request = service.request.bind(service);
			registrations.push(vscode.languages.registerReferenceProvider(selector, { provideReferences: () => [] }));
			ErrorHandler.showError = title => { errors.push(title); };

			const count = await adjustNamespaceForFolder(root);
			assert.deepStrictEqual(errors, []);
			assert.strictEqual(count, files.length);
			assert.ok(evicted, "The batch must exceed VS Code's retained document limit.");
			for (const uri of files) {
				const document = await vscode.workspace.openTextDocument(uri);
				const projectName = path.basename(path.dirname(uri.fsPath));
				assert.ok(document.getText().startsWith(`namespace Company.${projectName};`), document.getText());
			}
		} finally {
			CsprojCache.getInstance = originalCache;
			Object.defineProperty(vscode.workspace, 'findFiles', { configurable: true, value: originalFind });
			csharpLanguageService.getSymbols = getSymbols;
			csharpLanguageService.getTypes = getTypes;
			csharpLanguageService.getIdentifierRanges = getRanges;
			csharpLanguageService.request = request;
			ErrorHandler.showError = showError;
			for (const registration of registrations) { registration.dispose(); }
			service.dispose();
			cache.dispose();
			for (const uri of files) {
				const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
				if (!document?.isDirty) { continue; }
				const restore = new vscode.WorkspaceEdit();
				restore.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), originals.get(uri.toString())!);
				assert.ok(await vscode.workspace.applyEdit(restore));
				assert.ok(await document.save());
			}
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('rejects disk changes in evicted namespace documents even when reopening resets the version', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'painkiller-evicted-namespace-'));
		const uri = vscode.Uri.file(path.join(directory, 'Namespace.cs'));
		const content = 'namespace Old;\n';
		try {
			await fs.writeFile(uri.fsPath, content);
			const document = await vscode.workspace.openTextDocument(uri);
			const plan = {
				document, version: document.version, newNamespace: 'Updated', types: [],
				edits: [vscode.TextEdit.replace(new vscode.Range(0, 10, 0, 13), 'Updated')],
			};
			for (let index = 0; index < 72; index++) {
				const other = vscode.Uri.file(path.join(directory, `Other${index}.cs`));
				await fs.writeFile(other.fsPath, '// unchanged\n');
				await vscode.workspace.openTextDocument(other);
			}
			assert.ok(document.isClosed, 'The original document must have been evicted.');
			const changed = `${content}// concurrent disk edit\n`;
			await fs.writeFile(uri.fsPath, changed);
			const reopened = await vscode.workspace.openTextDocument(uri);
			assert.strictEqual(reopened.version, plan.version);
			await assert.rejects(applyNamespaceAdjustmentPlans([plan]), /changed while preparing namespace references/);
			assert.strictEqual(reopened.getText(), changed);
			assert.strictEqual(await fs.readFile(uri.fsPath, 'utf8'), changed);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('reports single-file adjustment failures instead of claiming the namespace is correct', async () => {
		const uri = vscode.Uri.file(path.join(os.tmpdir(), `missing-namespace-${process.pid}-${Date.now()}.cs`));
		const showError = ErrorHandler.showError;
		const errors: string[] = [];
		ErrorHandler.showError = title => { errors.push(title); };
		try {
			await adjustNamespaceForSingleFile(uri);
			assert.strictEqual(errors.length, 1);
			assert.ok(errors[0].includes('Namespace adjustment failed'));
			assert.ok(errors[0].includes(uri.fsPath));
		} finally {
			ErrorHandler.showError = showError;
		}
	});

	suite('semantic namespace formatting', () => {
		async function adjust(sourceContent: string, consumerContent: string): Promise<[string, string]> {
			const source = await vscode.workspace.openTextDocument({ language: 'csharp', content: sourceContent });
			const consumer = await vscode.workspace.openTextDocument({ language: 'csharp', content: consumerContent });
			const staying = await vscode.workspace.openTextDocument({ language: 'csharp', content: 'namespace Old;\npublic class Staying {}' });
			const service = new CSharpLanguageService(async () => {});
			const getSymbols = csharpLanguageService.getSymbols;
			const getTypes = csharpLanguageService.getTypes;
			const getRanges = csharpLanguageService.getIdentifierRanges;
			const request = csharpLanguageService.request;
			const selector: vscode.DocumentSelector = { language: 'csharp', scheme: 'untitled' };
			const registrations: vscode.Disposable[] = [];
			const declarations = new Map<string, vscode.DocumentSymbol>();
			try {
				registrations.push(vscode.languages.registerDocumentSymbolProvider(selector, {
					provideDocumentSymbols: document => {
						const content = document.getText();
						const ns = /\bnamespace (\w+)\s*[;{]/.exec(content)!;
						const type = /\bpublic class (\w+) \{[^}]*\}/.exec(content)!;
						const declaration = new vscode.DocumentSymbol(type[1], '', vscode.SymbolKind.Class,
							new vscode.Range(document.positionAt(type.index), document.positionAt(type.index + type[0].length)),
							new vscode.Range(document.positionAt(type.index + 13), document.positionAt(type.index + 13 + type[1].length)));
						const namespace = new vscode.DocumentSymbol(ns[1], '', vscode.SymbolKind.Namespace,
							new vscode.Range(document.positionAt(ns.index), document.positionAt(content.trimEnd().length)),
							new vscode.Range(document.positionAt(ns.index + 10), document.positionAt(ns.index + 10 + ns[1].length)));
						namespace.children = [declaration];
						declarations.set(document.uri.toString(), declaration);
						return [namespace];
					},
				}), vscode.languages.registerDocumentSemanticTokensProvider(selector, {
					provideDocumentSemanticTokens: document => {
						const builder = new vscode.SemanticTokensBuilder(new vscode.SemanticTokensLegend(['class']));
						for (const match of document.getText().matchAll(/\b(Moved|Staying) Value\b/g)) {
							builder.push(new vscode.Range(document.positionAt(match.index),
								document.positionAt(match.index + match[1].length)), 'class');
						}
						return builder.build();
					},
				}, new vscode.SemanticTokensLegend(['class'])),
				vscode.languages.registerReferenceProvider(selector, {
					provideReferences: (document, position) => {
						if (document !== source || !declarations.get(source.uri.toString())?.selectionRange.contains(position)) { return []; }
						const start = consumer.getText().lastIndexOf('Moved');
						return [new vscode.Location(consumer.uri,
							new vscode.Range(consumer.positionAt(start), consumer.positionAt(start + 5)))];
					},
				}), vscode.languages.registerDefinitionProvider(selector, {
					provideDefinition: async (document, position) => {
						const name = document.getText(document.getWordRangeAtPosition(position));
						const target = name === 'Moved' ? source : staying;
						await service.getSymbols(target);
						return new vscode.Location(target.uri, declarations.get(target.uri.toString())!.selectionRange);
					},
				}));
				csharpLanguageService.getSymbols = service.getSymbols.bind(service);
				csharpLanguageService.getTypes = service.getTypes.bind(service);
				csharpLanguageService.getIdentifierRanges = service.getIdentifierRanges.bind(service);
				csharpLanguageService.request = service.request.bind(service);

				await adjustDocumentNamespace(source, 'Updated');
				return [source.getText(), consumer.getText()];
			} finally {
				csharpLanguageService.getSymbols = getSymbols;
				csharpLanguageService.getTypes = getTypes;
				csharpLanguageService.getIdentifierRanges = getRanges;
				csharpLanguageService.request = request;
				for (const registration of registrations) { registration.dispose(); }
				service.dispose();
			}
		}

		for (const eol of ['\n', '\r\n']) {
			test(`inserts file imports before namespaces and preserves ${eol === '\n' ? 'LF' : 'CRLF'} spacing`, async () => {
				const source = `namespace Old;${eol}${eol}public class Moved { Staying Value; }${eol}`;
				const consumer = `namespace Consumer;${eol}${eol}public class Usage { Moved Value; }${eol}`;
				const [moved, usage] = await adjust(source, consumer);
				assert.strictEqual(moved, `using Old;${eol}${source.replace('namespace Old;', 'namespace Updated;')}`);
				assert.strictEqual(usage, `using Updated;${eol}${consumer}`);
			});
		}

		test('appends file imports after existing global and alias usings without splitting trailing comments', async () => {
			const prefix = '// header\n global using System;\nusing IO = System.IO; // keep comment\n\n';
			const source = `${prefix}namespace Old; // namespace comment\npublic class Moved { Staying Value; }\n`;
			const consumer = `${prefix}namespace Consumer;\npublic class Usage { Moved Value; }\n`;
			const [moved, usage] = await adjust(source, consumer);
			assert.strictEqual(moved, source.replace('namespace Old;', 'namespace Updated;')
				.replace('// keep comment\n', '// keep comment\nusing Old;\n'));
			assert.strictEqual(usage, consumer.replace('// keep comment\n', '// keep comment\nusing Updated;\n'));
		});

		test('keeps existing namespace-scoped imports while placing new file-scoped imports at the top', async () => {
			const source = 'namespace Old;\nusing System;\n\npublic class Moved { Staying Value; }\n';
			const consumer = 'namespace Consumer;\nusing System;\n\npublic class Usage { Moved Value; }\n';
			const [moved, usage] = await adjust(source, consumer);
			assert.strictEqual(moved, `using Old;\n${source.replace('namespace Old;', 'namespace Updated;')}`);
			assert.strictEqual(usage, `using Updated;\n${consumer}`);
		});

		test('does not place new imports inside conditional using blocks', async () => {
			const prefix = '#if OPTIONAL\nusing System;\n#endif\n\n';
			const source = `${prefix}namespace Old;\npublic class Moved { Staying Value; }\n`;
			const consumer = `${prefix}namespace Consumer;\npublic class Usage { Moved Value; }\n`;
			const [moved, usage] = await adjust(source, consumer);
			assert.strictEqual(moved, `using Old;\n${source.replace('namespace Old;', 'namespace Updated;')}`);
			assert.strictEqual(usage, `using Updated;\n${consumer}`);
		});

		test('converts block declarations without adding blank lines and retains consumer import scope', async () => {
			const source = 'namespace Old\n{\npublic class Moved { Staying Value; }\n}\n';
			const consumer = 'namespace Consumer {\nusing System; // keep scoped\npublic class Usage { Moved Value; }\n}\n';
			const [moved, usage] = await adjust(source, consumer);
			assert.strictEqual(moved, 'using Old;\nnamespace Updated;\npublic class Moved { Staying Value; }\n\n');
			assert.strictEqual(usage, consumer.replace('// keep scoped\n', '// keep scoped\nusing Updated;\n'));
		});
	});

	suite('computeNamespaceForFile', () => {
		const csprojs = [{ dirPath: '/workspace/MyApp/src/MyApp.Domain' }];

		test('builds namespace from project root and relative path', () => {
			const ns = computeNamespaceForFile(
				'/workspace/MyApp/src/MyApp.Domain/Books',
				'/workspace/MyApp/src/MyApp.Domain',
				csprojs,
				'workspace'
			);
			assert.strictEqual(ns, 'MyApp.Domain.Books');
		});

		test('uses fallback when project root is missing', () => {
			const ns = computeNamespaceForFile(
				'/tmp/other/Books',
				'/tmp/other/Books',
				undefined,
				'Fallback'
			);
			assert.strictEqual(ns, 'Books');
		});

		test('uses evaluated RootNamespace instead of the directory and preserves its casing', () => {
			assert.strictEqual(computeNamespaceForFile('/workspace/src/Books', '/workspace/src', [
				{ dirPath: '/workspace/src', rootNamespace: 'company.Library' },
			], 'Workspace'), 'company.Library.Books');
			assert.throws(() => computeNamespaceForFile('/workspace/src', '/workspace/src', [
				{ dirPath: '/workspace/src', rootNamespace: 'First' },
				{ dirPath: '/workspace/src', rootNamespace: 'Second' },
			], 'Workspace'), /ambiguous/);
		});
	});

	test('caches evaluated namespaces, falls back to the project name and retries evaluation failures', async () => {
		const uri = vscode.Uri.file('/workspace/src/Library.csproj');
		let calls = 0;
		let namespace = 'company.Library';
		const cache = new CsprojCache(async () => [uri], async () => { calls++; return namespace; });
		try {
			assert.deepStrictEqual(await Promise.all([cache.getRootNamespace(uri), cache.getRootNamespace(uri)]), [
				'company.Library', 'company.Library',
			]);
			assert.strictEqual(calls, 1);
			namespace = '';
			cache.invalidate(uri);
			assert.strictEqual(await cache.getRootNamespace(uri), 'Library');
			namespace = 'invalid namespace';
			cache.invalidate(uri);
			await assert.rejects(cache.getRootNamespace(uri), /invalid RootNamespace/);
			namespace = 'Updated';
			assert.strictEqual(await cache.getRootNamespace(uri), 'Updated');
		} finally { cache.dispose(); }
	});

	test('invalidates namespace evaluations on imported props edits and refuses unsaved MSBuild settings', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'painkiller-root-namespace-'));
		const uri = vscode.Uri.file(path.join(directory, 'Library.csproj'));
		const props = vscode.Uri.file(path.join(directory, 'Directory.Build.props'));
		let namespace = 'First';
		let calls = 0;
		const cache = new CsprojCache(async () => [uri], async () => { calls++; return namespace; });
		try {
			await fs.writeFile(props.fsPath, '<Project />');
			await cache.initialize({ subscriptions: [] });
			assert.strictEqual(await cache.getRootNamespace(uri), 'First');
			const document = await vscode.workspace.openTextDocument(props);
			await vscode.window.showTextDocument(document);
			const edit = new vscode.WorkspaceEdit();
			edit.insert(props, document.positionAt(0), '<!-- edited -->');
			assert.ok(await vscode.workspace.applyEdit(edit));
			await assert.rejects(cache.getRootNamespace(uri), /Save .* before evaluating/);
			namespace = 'Second';
			await vscode.commands.executeCommand('workbench.action.files.revert');
			assert.ok(!document.isDirty);
			assert.strictEqual(await cache.getRootNamespace(uri), 'Second');
			assert.strictEqual(calls, 2);
		} finally {
			cache.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	suite('adjustFileNamespace', () => {
		test('replaces block namespace without usings at file start', () => {
			const content = 'namespace Books.Domain.Test\n{\n\tpublic class Book\n\t{\n\t}\n}';
			const result = adjustFileNamespace(content, 'test/Books/Book.cs', 'Books.Domain');

			assert.ok(result.wasAdjusted);
			assert.strictEqual(result.oldNamespace, 'Books.Domain.Test');
			assert.strictEqual(result.adjustedContent, 'namespace Books.Domain;\n\npublic class Book\n{\n}');
		});

		test('replaces block namespace when file has BOM', () => {
			const content = '\uFEFFnamespace Books.Domain.Test\n{\n\tpublic class Book\n\t{\n\t}\n}';
			const result = adjustFileNamespace(content, 'test/Books/Book.cs', 'Books.Domain');

			assert.ok(result.wasAdjusted);
			assert.strictEqual(result.oldNamespace, 'Books.Domain.Test');
			assert.strictEqual(result.adjustedContent, '\uFEFFnamespace Books.Domain;\n\npublic class Book\n{\n}');
		});
	});

	suite('usingDirectives', () => {
		test('finds type usage in file body', () => {
			const content = [
				'using Old.Namespace;',
				'namespace MyApp;',
				'public class Handler {',
				'    private readonly Book _book;',
				'}',
			].join('\n');

			const found = findTypeReferencesInContent(content, new Set(['Book']));
			assert.deepStrictEqual([...found], ['Book']);
		});

		test('does not treat type name in using directive as usage', () => {
			const content = [
				'using Old.Namespace.Book;',
				'namespace MyApp;',
				'public class Handler {',
				'}',
			].join('\n');

			const found = findTypeReferencesInContent(content, new Set(['Book']));
			assert.strictEqual(found.size, 0);
		});

		test('addUsingForNewNamespace inserts using directive', () => {
			const content = [
				'using System;',
				'namespace MyApp.Old;',
				'public class Handler { private readonly Book _book; }',
			].join('\n');
			const result = addUsingForNewNamespace(content, 'MyApp.Domain', 'MyApp.Old');
			assert.ok(result.wasAdded);
			assert.ok(result.adjustedContent.includes('using MyApp.Domain;'));
		});

		test('addUsingForNewNamespace removes redundant using when namespaces match', () => {
			const content = [
				'using MyApp.Domain;',
				'namespace MyApp.Domain;',
				'public class Book { }',
			].join('\n');
			const result = addUsingForNewNamespace(content, 'MyApp.Domain', 'MyApp.Domain');
			assert.ok(result.wasRemoved);
			assert.ok(!result.adjustedContent.includes('using MyApp.Domain;'));
		});

		test('removeUsingDirective removes matching using', () => {
			const content = [
				'using System;',
				'using System.IO;',
				'namespace MyApp;',
			].join('\n');
			const result = removeUsingDirective(content, 'System.IO');
			assert.ok(result.wasRemoved);
			assert.ok(!result.adjustedContent.includes('using System.IO;'));
		});
	});
});
