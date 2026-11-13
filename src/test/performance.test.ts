import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import childProcess = require('child_process');
import { AsyncCache, WorkQueue, waitWithCancellation } from '../utils/asyncWork.js';
import { CsprojCache } from '../utils/csprojCache.js';
import { runDotnet } from '../utils/dotnetCli.js';
import { csharpLanguageService, type CSharpType } from '../services/csharpLanguageService.js';
import { runDiagnosticsInBatches } from '../diagnostics/scheduler.js';
import {
	clearDiagnosticsCache, runDiagnosticsForUri, publishDuplicateTypes,
	DIAGNOSTIC_CODE_DUPLICATE_TYPE_NAME, type AnalyzerSelection, type WorkspaceDuplicateIndex,
} from '../diagnostics/diagnosticsProvider.js';
import { clearNugetCaches, getPackageDependencies, getDependenciesFromAssets } from '../services/nugetCommands.js';
import { fetchDotnetTemplates, parseDotnetTemplateList, registerLazyTemplateCommands } from '../services/dotnetTemplates.js';
import { CsprojProjectsTreeProvider, CsprojProjectTreeItem } from '../decoration/csprojProjectsTreeProvider.js';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}

class CountingFileSystem implements vscode.FileSystemProvider {
	private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this.emitter.event;
	readonly files = new Map<string, string>();
	readonly reads = new Map<string, number>();

	watch(): vscode.Disposable { return new vscode.Disposable(() => {}); }
	stat(uri: vscode.Uri): vscode.FileStat {
		const content = this.files.get(uri.path);
		if (content === undefined) { throw vscode.FileSystemError.FileNotFound(uri); }
		return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: content.length };
	}
	readFile(uri: vscode.Uri): Uint8Array {
		const content = this.files.get(uri.path);
		if (content === undefined) { throw vscode.FileSystemError.FileNotFound(uri); }
		this.reads.set(uri.path, (this.reads.get(uri.path) ?? 0) + 1);
		return Buffer.from(content);
	}
	readDirectory(): [string, vscode.FileType][] { return []; }
	createDirectory(): void {}
	writeFile(uri: vscode.Uri, content: Uint8Array): void { this.files.set(uri.path, Buffer.from(content).toString('utf8')); }
	delete(uri: vscode.Uri): void { this.files.delete(uri.path); }
	rename(oldUri: vscode.Uri, newUri: vscode.Uri): void {
		this.files.set(newUri.path, this.files.get(oldUri.path) ?? '');
		this.files.delete(oldUri.path);
	}
	dispose(): void { this.emitter.dispose(); }
}

suite('Performance regression tests', () => {
	test('coalesces empty cache results, evicts old results and retries failures', async () => {
		const cache = new AsyncCache<string, string[]>(2);
		let calls = 0;
		const load = async () => { calls++; return []; };
		await Promise.all([cache.get('empty', load), cache.get('empty', load)]);
		await cache.get('empty', load);
		assert.strictEqual(calls, 1);
		await cache.get('second', load);
		await cache.get('third', load);
		await cache.get('empty', load);
		assert.strictEqual(calls, 4);
		await assert.rejects(cache.get('failure', async () => { throw new Error('offline'); }), /offline/);
		assert.deepStrictEqual(await cache.get('failure', load), []);
	});

	test('does not republish an invalidated in-flight cache result', async () => {
		const cache = new AsyncCache<string, number>(1);
		const old = deferred<number>();
		const pending = cache.get('key', () => old.promise);
		cache.clear();
		assert.strictEqual(await cache.get('key', async () => 2), 2);
		old.resolve(1);
		assert.strictEqual(await pending, 1);
		assert.strictEqual(await cache.get('key', async () => 3), 2);
	});

	test('expires cached results rather than permanently caching remote metadata', async () => {
		const originalNow = Date.now;
		let now = 1000;
		try {
			Date.now = () => now;
			const cache = new AsyncCache<string, number>(1, 100);
			assert.strictEqual(await cache.get('key', async () => 1), 1);
			now += 101;
			assert.strictEqual(await cache.get('key', async () => 2), 2);
		} finally { Date.now = originalNow; }
	});

	test('limits queued work, prioritizes interactive work and removes cancelled work', async () => {
		const queue = new WorkQueue(2);
		const gate = deferred<void>();
		const started = deferred<void>();
		const order: string[] = [];
		let running = 0;
		let maximum = 0;
		const work = (name: string) => async () => {
			order.push(name);
			running++;
			maximum = Math.max(maximum, running);
			if (order.length === 2) { started.resolve(); }
			await gate.promise;
			running--;
		};
		const first = queue.run(work('first'));
		const second = queue.run(work('second'));
		await started.promise;
		const background = queue.run(work('background'));
		const source = new vscode.CancellationTokenSource();
		const cancelled = queue.run(work('cancelled'), source.token);
		const interactive = queue.run(work('interactive'), undefined, true);
		source.cancel();
		await assert.rejects(cancelled, vscode.CancellationError);
		gate.resolve();
		await Promise.all([first, second, background, interactive]);
		source.dispose();
		assert.strictEqual(maximum, 2);
		assert.deepStrictEqual(order, ['first', 'second', 'interactive', 'background']);
	});

	test('cancels a shared consumer immediately without cancelling the other consumer', async () => {
		const result = deferred<number>();
		const source = new vscode.CancellationTokenSource();
		const cancelled = waitWithCancellation(result.promise, source.token);
		source.cancel();
		await assert.rejects(cancelled, vscode.CancellationError);
		result.resolve(42);
		assert.strictEqual(await result.promise, 42);
		source.dispose();
	});

	test('shares project discovery, including an empty workspace, and invalidates on structure changes', async () => {
		let calls = 0;
		let projects: vscode.Uri[] = [];
		const cache = new CsprojCache(async () => { calls++; return projects; });
		try {
			await Promise.all([cache.getCsprojs(), cache.getCsprojs()]);
			await cache.getCsprojs();
			assert.strictEqual(calls, 1);
			projects = [vscode.Uri.file('/workspace/App/App.csproj')];
			cache.invalidate(projects[0], true);
			await cache.getCsprojs();
			assert.strictEqual(calls, 2);
			assert.strictEqual(cache.findProjectRootForPath('/workspace/App/Book.cs'), '/workspace/App');
			cache.invalidate(projects[0]);
			await cache.getCsprojs();
			assert.strictEqual(calls, 2);
		} finally { cache.dispose(); }
	});

	test('shares project content and caches reference graphs until a referenced project changes', async () => {
		const app = vscode.Uri.parse('painkiller-performance:/workspace/App/App.csproj');
		const domain = vscode.Uri.parse('painkiller-performance:/workspace/Domain/Domain.csproj');
		const provider = new CountingFileSystem();
		provider.files.set(app.path, '<Project><ProjectReference Include="../Domain/Domain.csproj" /></Project>');
		provider.files.set(domain.path, '<Project />');
		const registration = vscode.workspace.registerFileSystemProvider('painkiller-performance', provider);
		const cache = new CsprojCache(async () => [app, domain]);
		try {
			await Promise.all([cache.getProjectContent(app), cache.getProjectContent(app)]);
			await cache.getProjectContent(app);
			assert.strictEqual(provider.reads.get(app.path), 1);
			assert.deepStrictEqual(await cache.getReferencedProjectOrder(app), [path.dirname(app.fsPath), path.dirname(domain.fsPath)]);
			await cache.getReferencedProjectOrder(app);
			assert.strictEqual(provider.reads.get(domain.path), 1);
			provider.files.set(domain.path, '<Project><ProjectReference Include="../App/App.csproj" /></Project>');
			cache.invalidate(domain);
			assert.deepStrictEqual(await cache.getReferencedProjectOrder(app), [path.dirname(app.fsPath), path.dirname(domain.fsPath)]);
			assert.strictEqual(provider.reads.get(app.path), 1);
			assert.strictEqual(provider.reads.get(domain.path), 2);
		} finally {
			cache.dispose();
			registration.dispose();
			provider.dispose();
		}
	});

	test('reuses solution trees and reads only the changed project when refreshing its node', async () => {
		const project = vscode.Uri.parse('painkiller-performance:/workspace/App/App.csproj');
		const solution = vscode.Uri.parse('painkiller-performance:/workspace/App.slnx');
		const provider = new CountingFileSystem();
		provider.files.set(project.path, '<Project Sdk="Microsoft.NET.Sdk"><TargetFramework>net8.0</TargetFramework></Project>');
		provider.files.set(solution.path, '<Solution><Project Path="App/App.csproj" /></Solution>');
		const registration = vscode.workspace.registerFileSystemProvider('painkiller-performance', provider);
		const originalCache = CsprojCache.getInstance;
		const cache = new CsprojCache(async () => [project]);
		let searches = 0;
		let tree: CsprojProjectsTreeProvider | undefined;
		try {
			CsprojCache.getInstance = () => cache;
			tree = new CsprojProjectsTreeProvider(vscode.Uri.file('/workspace'), undefined, async () => { searches++; return [solution]; });
			const roots = await tree.getChildren();
			const nodes = await tree.getChildren(roots[0]);
			await tree.getChildren();
			assert.strictEqual(searches, 1);
			assert.strictEqual(provider.reads.get(project.path), 1);
			const updated = deferred<void>();
			const subscription = tree.onDidChangeTreeData(item => { if (item?.node.kind === 'project') { updated.resolve(); } });
			try {
				provider.files.set(project.path, '<Project Sdk="Microsoft.NET.Sdk"><TargetFramework>net9.0</TargetFramework><UseMaui>true</UseMaui></Project>');
				cache.invalidate(project);
				await updated.promise;
				assert.ok(String(tree.getTreeItem(nodes[0]).description).includes('net9.0'));
				const icon = tree.getTreeItem(nodes[0]).iconPath;
				assert.ok(icon instanceof vscode.Uri);
				assert.strictEqual(path.basename(icon.path), 'dotnetMauiFolder.png');
				assert.strictEqual(provider.reads.get(project.path), 2);
				assert.strictEqual(searches, 1);
			} finally { subscription.dispose(); }
		} finally {
			tree?.dispose();
			cache.dispose();
			CsprojCache.getInstance = originalCache;
			registration.dispose();
			provider.dispose();
		}
	});

	for (const method of ['picker', 'drag']) {
		for (const openProject of [false, true]) {
			test(`refreshes project references after ${method} edits without watcher events (${openProject ? 'open' : 'closed'} project)`, async () => {
				const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'painkiller-project-references-'));
				const projects = ['App', 'Domain', 'Helpers'].map(name => vscode.Uri.file(path.join(directory, name, `${name}.csproj`)));
				const [app, domain, helpers] = projects;
				const solution = vscode.Uri.file(path.join(directory, 'App.slnx'));
				const originalCache = CsprojCache.getInstance;
				const originalPick = vscode.window.showQuickPick;
				const originalWarning = vscode.window.showWarningMessage;
				const cache = new CsprojCache(async () => projects);
				let tree: CsprojProjectsTreeProvider | undefined;
				try {
					for (const project of projects) {
						await fs.mkdir(path.dirname(project.fsPath), { recursive: true });
						await fs.writeFile(project.fsPath, '<Project Sdk="Microsoft.NET.Sdk">\n</Project>\n');
					}
					await fs.writeFile(solution.fsPath, `<Solution>${projects.map(uri =>
						`<Project Path="${path.relative(directory, uri.fsPath).replace(/\\/g, '/')}" />`).join('')}</Solution>`);
					if (openProject) {
						const document = await vscode.workspace.openTextDocument(app);
						const edit = new vscode.WorkspaceEdit();
						edit.insert(app, document.positionAt(0), '<!-- unsaved change -->\n');
						assert.ok(await vscode.workspace.applyEdit(edit));
					}
					CsprojCache.getInstance = () => cache;
					const currentTree = new CsprojProjectsTreeProvider(vscode.Uri.file(directory), undefined, async () => [solution]);
					tree = currentTree;
					let selected = domain;
					Object.defineProperty(vscode.window, 'showQuickPick', { configurable: true,
						value: async (items: { uri: vscode.Uri }[]) => items.find(item => item.uri.toString() === selected.toString()),
					});
					Object.defineProperty(vscode.window, 'showWarningMessage', { configurable: true,
						value: async (message: string) => message.startsWith('Remove reference') ? 'Remove Reference' : 'Confirm',
					});
					const projectItems = async () => {
						const roots = await currentTree.getChildren();
						return currentTree.getChildren(roots[0]);
					};
					const referenceGroup = async () => {
						const item = (await projectItems()).find(item => item.node.kind === 'project' &&
							item.node.csprojUri.toString() === app.toString());
						assert.ok(item);
						const group = (await currentTree.getChildren(item)).find(item => item.node.kind === 'referenceGroup');
						assert.ok(group);
						return group;
					};
					const assertReferences = async (expected: vscode.Uri[]) => {
						const references = await currentTree.getChildren(await referenceGroup());
						assert.deepStrictEqual(references.map(item => item.node.kind === 'projectReference'
							? item.node.resolvedUri.toString() : ''), expected.map(uri => uri.toString()));
						assert.deepStrictEqual(await cache.getReferencedProjectOrder(app),
							[app, ...expected].map(uri => path.dirname(uri.fsPath)));
					};
					await assertReferences([]);
					for (const target of [domain, helpers]) {
						selected = target;
						if (method === 'picker') {
							await currentTree.addProjectReference(await referenceGroup());
						} else {
							const items = await projectItems();
							const source = items.find(item => item.node.kind === 'project' && item.node.csprojUri.toString() === target.toString());
							const destination = items.find(item => item.node.kind === 'project' && item.node.csprojUri.toString() === app.toString());
							assert.ok(source && destination);
							const transfer = new vscode.DataTransfer();
							currentTree.handleDrag([source], transfer);
							await currentTree.handleDrop(destination, transfer);
						}
						const persisted = await fs.readFile(app.fsPath, 'utf8');
						assert.ok(persisted.includes('Include="../Domain/Domain.csproj"'));
						if (target === helpers) { assert.ok(persisted.includes('Include="../Helpers/Helpers.csproj"')); }
						if (openProject) {
							const document = await vscode.workspace.openTextDocument(app);
							assert.ok(persisted.startsWith('<!-- unsaved change -->\n'));
							assert.strictEqual(document.getText(), persisted);
							assert.ok(!document.isDirty);
						}
						await assertReferences(target === domain ? [domain] : [domain, helpers]);
					}
					const references = await currentTree.getChildren(await referenceGroup());
					await currentTree.removeProjectReference(references[0]);
					await assertReferences([helpers]);
					assert.ok(!(await fs.readFile(app.fsPath, 'utf8')).includes('Include="../Domain/Domain.csproj"'));
				} finally {
					tree?.dispose();
					cache.dispose();
					CsprojCache.getInstance = originalCache;
					Object.defineProperty(vscode.window, 'showQuickPick', { configurable: true, value: originalPick });
					Object.defineProperty(vscode.window, 'showWarningMessage', { configurable: true, value: originalWarning });
					await fs.rm(directory, { recursive: true, force: true });
				}
			});
		}
	}

	test('recognizes Blazor and MAUI project icons while preserving ASP.NET and test priorities', async () => {
		const root = vscode.Uri.parse('painkiller-performance:/workspace/Icons');
		const solution = vscode.Uri.joinPath(root, 'App.slnx');
		const cases: { name: string; content: string; components?: string[]; icon: string }[] = [
			{ name: 'Default', content: '<Project Sdk="Microsoft.NET.Sdk" />', icon: 'dotnetDefaultFolder.svg' },
			{
				name: 'AspNet', content: '<Project Sdk="Microsoft.NET.Sdk.Web" />',
				components: ['obj/Generated.razor', 'bin/Copy.razor', '.dotnet/Template.razor'],
				icon: 'dotnetAspNetFolder.svg',
			},
			{
				name: 'AspNet/Nested', content: '<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly" />',
				components: ['App.razor'], icon: 'dotnetBlazorFolder.png',
			},
			{ name: 'Wasm', content: '<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly" />', icon: 'dotnetBlazorFolder.png' },
			{
				name: 'WasmAttributes', content: "<Project Label='Example' Sdk = 'Microsoft.NET.Sdk.BlazorWebAssembly' />",
				icon: 'dotnetBlazorFolder.png',
			},
			{
				name: 'SdkSuffix', content: '<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly.Custom" />',
				icon: 'dotnetDefaultFolder.svg',
			},
			{
				name: 'SdkText', content: '<Project Sdk="Microsoft.NET.Sdk.Web"><Description>Microsoft.NET.Sdk.BlazorWebAssembly</Description></Project>',
				icon: 'dotnetAspNetFolder.svg',
			},
			{
				name: 'SdkComment', content: '<!-- <Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly" /> --><Project Sdk="Microsoft.NET.Sdk.Web" />',
				icon: 'dotnetAspNetFolder.svg',
			},
			{
				name: 'Host', content: '<Project Sdk="Microsoft.NET.Sdk.Web"><PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly.Server" /></Project>',
				icon: 'dotnetAspNetFolder.svg',
			},
			{
				name: 'Server', content: '<Project Sdk="Microsoft.NET.Sdk.Web" />',
				components: ['Pages/Index.razor'], icon: 'dotnetAspNetFolder.svg',
			},
			{
				name: 'WebApp', content: '<Project Sdk="Microsoft.NET.Sdk.Web" />',
				components: ['Components/App.razor'], icon: 'dotnetAspNetFolder.svg',
			},
			{
				name: 'Components', content: '<Project Sdk="Microsoft.NET.Sdk.Razor" />',
				components: ['Component1.razor'], icon: 'dotnetDefaultFolder.svg',
			},
			{
				name: 'MvcLibrary', content: '<Project Sdk="Microsoft.NET.Sdk.Razor"><FrameworkReference Include="Microsoft.AspNetCore.App" /></Project>',
				icon: 'dotnetAspNetFolder.svg',
			},
			{
				name: 'Maui', content: '<Project Sdk="Microsoft.NET.Sdk"><UseMaui Condition="true"> true </UseMaui></Project>',
				icon: 'dotnetMauiFolder.png',
			},
			{
				name: 'Hybrid', content: '<Project Sdk="Microsoft.NET.Sdk.Razor"><UseMaui>true</UseMaui><PackageReference Include="Microsoft.AspNetCore.Components.WebView.Maui" /></Project>',
				icon: 'dotnetMauiFolder.png',
			},
			{
				name: 'Disabled', content: '<Project Sdk="Microsoft.NET.Sdk"><UseMaui>false</UseMaui><!-- <UseMaui>true</UseMaui><PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly" /> --></Project>',
				icon: 'dotnetDefaultFolder.svg',
			},
			{
				name: 'Tests', content: '<Project Sdk="Microsoft.NET.Sdk.Web"><UseMaui>true</UseMaui><IsTestProject>true</IsTestProject><PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly" /></Project>',
				icon: 'dotnetTestsFolder.svg',
			},
		];
		const projectUris = cases.map(item => vscode.Uri.joinPath(root, item.name, `${path.basename(item.name)}.csproj`));
		const components = cases.flatMap(item => (item.components ?? []).map(file => vscode.Uri.joinPath(root, item.name, file)));
		const provider = new CountingFileSystem();
		cases.forEach((item, index) => provider.files.set(projectUris[index].path, item.content));
		provider.files.set(solution.path, `<Solution>${cases.map(item =>
			`<Project Path="${item.name}/${path.basename(item.name)}.csproj" />`).join('')}</Solution>`);
		const registration = vscode.workspace.registerFileSystemProvider('painkiller-performance', provider);
		const originalCache = CsprojCache.getInstance;
		const originalFind = vscode.workspace.findFiles;
		const cache = new CsprojCache(async () => projectUris);
		const extensionUri = vscode.Uri.file(path.resolve(__dirname, '../..'));
		let tree: CsprojProjectsTreeProvider | undefined;
		try {
			CsprojCache.getInstance = () => cache;
			Object.defineProperty(vscode.workspace, 'findFiles', { configurable: true,
				value: async (pattern: vscode.GlobPattern, exclude?: vscode.GlobPattern | null, maxResults?: number, token?: vscode.CancellationToken) =>
					typeof pattern !== 'string' && pattern.pattern === '**/*.razor'
						? components.filter(uri => uri.path.startsWith(pattern.baseUri.path + '/'))
						: originalFind(pattern, exclude, maxResults, token),
			});
			tree = new CsprojProjectsTreeProvider(extensionUri, undefined, async () => [solution]);
			const roots = await tree.getChildren();
			const nodes = (await tree.getChildren(roots[0])).filter(item => item.node.kind === 'project');
			assert.strictEqual(nodes.length, cases.length);
			for (let index = 0; index < cases.length; index++) {
				const node = nodes.find(item => item.node.kind === 'project' &&
					item.node.csprojUri.toString() === projectUris[index].toString());
				assert.ok(node, cases[index].name);
				const icon: vscode.TreeItem['iconPath'] = tree.getTreeItem(node).iconPath;
				assert.ok(icon instanceof vscode.Uri);
				assert.strictEqual(path.basename(icon.path), cases[index].icon, cases[index].name);
				await vscode.workspace.fs.stat(icon);
			}
		} finally {
			tree?.dispose();
			cache.dispose();
			CsprojCache.getInstance = originalCache;
			Object.defineProperty(vscode.workspace, 'findFiles', { configurable: true, value: originalFind });
			registration.dispose();
			provider.dispose();
		}
	});

	test('refreshes Blazor project icons when the explicit project SDK changes', async () => {
		const project = vscode.Uri.parse('painkiller-performance:/workspace/App/App.csproj');
		const solution = vscode.Uri.parse('painkiller-performance:/workspace/App.slnx');
		const provider = new CountingFileSystem();
		provider.files.set(project.path, '<Project Sdk="Microsoft.NET.Sdk.Web" />');
		provider.files.set(solution.path, '<Solution><Project Path="App/App.csproj" /></Solution>');
		const registration = vscode.workspace.registerFileSystemProvider('painkiller-performance', provider);
		const originalCache = CsprojCache.getInstance;
		const cache = new CsprojCache(async () => [project]);
		let tree: CsprojProjectsTreeProvider | undefined;
		try {
			CsprojCache.getInstance = () => cache;
			const currentTree = new CsprojProjectsTreeProvider(vscode.Uri.file('/workspace'), undefined, async () => [solution]);
			tree = currentTree;
			const projectIcon = async () => {
				const roots = await currentTree.getChildren();
				const nodes = await currentTree.getChildren(roots[0]);
				const icon = currentTree.getTreeItem(nodes[0]).iconPath;
				assert.ok(icon instanceof vscode.Uri);
				return path.basename(icon.path);
			};
			assert.strictEqual(await projectIcon(), 'dotnetAspNetFolder.svg');
			for (const sdk of ['Microsoft.NET.Sdk.BlazorWebAssembly', 'Microsoft.NET.Sdk.Web']) {
				const refreshed = deferred<void>();
				const subscription = currentTree.onDidChangeTreeData(item => {
					if (item?.node.kind === 'project') { refreshed.resolve(); }
				});
				try {
					provider.files.set(project.path, `<Project Sdk="${sdk}" />`);
					cache.invalidate(project);
					await refreshed.promise;
					assert.strictEqual(await projectIcon(), sdk === 'Microsoft.NET.Sdk.BlazorWebAssembly'
						? 'dotnetBlazorFolder.png' : 'dotnetAspNetFolder.svg');
				} finally { subscription.dispose(); }
			}
		} finally {
			tree?.dispose();
			cache.dispose();
			CsprojCache.getInstance = originalCache;
			registration.dispose();
			provider.dispose();
		}
	});

	test('reads resolved dependency graphs locally, including cycles and different target frameworks', () => {
		const dependencies = getDependenciesFromAssets({ targets: {
			net8: {
				'Root/1.0.0': { dependencies: { Child: '[2.0.0, )' } },
				'Child/2.0.0': { dependencies: { Root: '1.0.0' } },
			},
			net9: {
				'Root/1.0.0': { dependencies: { Child: '3.0.0' } },
				'Child/3.0.0': {},
			},
		} }, 'root', '1.0.0');
		assert.deepStrictEqual(dependencies, [
			{ id: 'Child', version: '2.0.0', dependencies: [{ id: 'Root', version: '1.0.0' }] },
			{ id: 'Child', version: '3.0.0' },
		]);
		assert.strictEqual(getDependenciesFromAssets({ targets: {} }, 'missing', '1'), undefined);
		assert.deepStrictEqual(getDependenciesFromAssets({ targets: {
			net8: { 'Root/1': { dependencies: { Child: '2' } }, 'Child/2': { dependencies: { A: '3' } }, 'A/3': {} },
			net9: { 'Root/1': { dependencies: { Child: '2' } }, 'Child/2': { dependencies: { B: '4' } }, 'B/4': {} },
		} }, 'Root', '1'), [{ id: 'Child', version: '2', dependencies: [{ id: 'A', version: '3' }, { id: 'B', version: '4' }] }]);
	});

	test('deleting projects preserves shared, nested and solution-root folders', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'painkiller-project-delete-'));
		const originalCache = CsprojCache.getInstance;
		const originalWarning = vscode.window.showWarningMessage;
		try {
			for (const scenario of ['shared', 'nested', 'uncached', 'solution-root', 'dedicated']) {
				const root = path.join(directory, scenario);
				const folder = scenario === 'solution-root' ? root : path.join(root, 'Common');
				const projectUri = vscode.Uri.file(path.join(folder, 'A.csproj'));
				const siblingUri = vscode.Uri.file(path.join(scenario === 'dedicated' ? root : folder,
					scenario === 'nested' ? 'Nested/B.csproj' : 'B.csproj'));
				const solutionUri = vscode.Uri.file(path.join(root, 'App.slnx'));
				const projectPath = path.relative(root, projectUri.fsPath).replace(/\\/g, '/');
				const siblingPath = path.relative(root, siblingUri.fsPath).replace(/\\/g, '/');
				await fs.mkdir(path.dirname(siblingUri.fsPath), { recursive: true });
				await fs.mkdir(folder, { recursive: true });
				await fs.writeFile(projectUri.fsPath, '<Project />');
				await fs.writeFile(siblingUri.fsPath, '<Project />');
				await fs.writeFile(solutionUri.fsPath, `<Solution>\n  <Project Path="${projectPath}" />\n  <Project Path="${siblingPath}" />\n</Solution>\n`);
				const cache = new CsprojCache(async () => ['uncached', 'solution-root'].includes(scenario) ? [projectUri] : [projectUri, siblingUri]);
				CsprojCache.getInstance = () => cache;
				const provider = new CsprojProjectsTreeProvider(vscode.Uri.file(root), undefined, async () => [solutionUri]);
				let protectedWarning = false;
				Object.defineProperty(vscode.window, 'showWarningMessage', { configurable: true, value: async (message: string) => {
					if (message.includes('from the solution?')) { return 'Delete Project'; }
					if (scenario === 'dedicated') {
						assert.ok(message.includes('Delete physical folder'));
						return 'Keep Physical Folder';
					}
					assert.ok(message.includes('will be kept'));
					protectedWarning = true;
					return undefined;
				} });
				try {
					const item = new CsprojProjectTreeItem({
						kind: 'project', label: 'A', folderUri: vscode.Uri.file(folder), csprojUri: projectUri, solutionUri,
						projectPath, existsOnDisk: true, solutionProjectPaths: new Set(), isAspNet: false, isTest: false,
						isBlazor: false, isMaui: false,
					}, vscode.Uri.file(root));
					await provider.deleteProject(item);
					assert.strictEqual(protectedWarning, scenario !== 'dedicated');
					assert.strictEqual(await fs.readFile(projectUri.fsPath, 'utf8'), '<Project />');
					assert.strictEqual(await fs.readFile(siblingUri.fsPath, 'utf8'), '<Project />');
					const solution = await fs.readFile(solutionUri.fsPath, 'utf8');
					assert.ok(!solution.includes(`Path="${projectPath}"`));
					assert.ok(solution.includes(`Path="${siblingPath}"`));
				} finally { provider.dispose(); cache.dispose(); }
			}
		} finally {
			CsprojCache.getInstance = originalCache;
			Object.defineProperty(vscode.window, 'showWarningMessage', { configurable: true, value: originalWarning });
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('physical project and solution folder deletion refreshes excluded projects without watcher events', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'painkiller-excluded-projects-'));
		const originalCache = CsprojCache.getInstance;
		const originalWarning = vscode.window.showWarningMessage;
		try {
			for (const kind of ['project', 'folder']) {
				for (const deletePhysical of [true, false]) {
					const root = path.join(directory, `${kind}-${deletePhysical}`);
					const projectUri = vscode.Uri.file(path.join(root, 'Items', 'A', 'A.csproj'));
					const siblingUri = vscode.Uri.file(path.join(root, 'B', 'B.csproj'));
					const solutionUri = vscode.Uri.file(path.join(root, 'App.slnx'));
					await fs.mkdir(path.dirname(projectUri.fsPath), { recursive: true });
					await fs.mkdir(path.dirname(siblingUri.fsPath), { recursive: true });
					await fs.writeFile(projectUri.fsPath, '<Project />');
					await fs.writeFile(siblingUri.fsPath, '<Project />');
					const projectEntry = '    <Project Path="Items/A/A.csproj" />\n';
					await fs.writeFile(solutionUri.fsPath, `<Solution>\n${kind === 'folder'
						? `  <Folder Name="/Items/">\n${projectEntry}  </Folder>\n` : projectEntry}  <Project Path="B/B.csproj" />\n</Solution>\n`);
					const cache = new CsprojCache(async () => (await fs.readdir(root, { recursive: true }))
						.filter(file => file.endsWith('.csproj'))
						.map(file => vscode.Uri.file(path.join(root, file))));
					CsprojCache.getInstance = () => cache;
					const provider = new CsprojProjectsTreeProvider(vscode.Uri.file(root), undefined, async () => [solutionUri]);
					Object.defineProperty(vscode.window, 'showWarningMessage', { configurable: true, value: async (message: string) => {
						if (message.includes('from the solution?')) { return kind === 'project' ? 'Delete Project' : 'Delete'; }
						return deletePhysical ? 'Delete Physical Folder' : 'Keep Physical Folder';
					} });
					try {
						const roots = await provider.getChildren();
						const nodes = await provider.getChildren(roots[0]);
						const target = nodes.find(item => kind === 'folder'
							? item.node.kind === 'folder'
							: item.node.kind === 'project' && item.node.csprojUri.toString() === projectUri.toString());
						assert.ok(target);
						if (kind === 'project') { await provider.deleteProject(target); }
						else { await provider.deleteSolutionFolder(target); }

						const updatedRoots = await provider.getChildren();
						const updatedNodes = await provider.getChildren(updatedRoots[0]);
						const excluded = updatedNodes.find(item => item.node.kind === 'excludedProjects');
						assert.deepStrictEqual(excluded ? (await provider.getChildren(excluded))
							.map(item => item.node.kind === 'excludedProject' ? item.node.csprojUri.toString() : '') : [],
						deletePhysical ? [] : [projectUri.toString()], `${kind}, deletePhysical=${deletePhysical}`);
						assert.deepStrictEqual((await cache.getProjectUris()).map(uri => uri.toString()).sort(),
							(deletePhysical ? [siblingUri] : [projectUri, siblingUri]).map(uri => uri.toString()).sort());
						assert.strictEqual(await fs.readFile(siblingUri.fsPath, 'utf8'), '<Project />');
						if (!deletePhysical) {
							assert.ok(excluded);
							await provider.includeProject((await provider.getChildren(excluded))[0]);
							const includedRoots = await provider.getChildren();
							const includedNodes = await provider.getChildren(includedRoots[0]);
							for (let index = 0; index < includedNodes.length; index++) {
								if (includedNodes[index].node.kind === 'folder') {
									includedNodes.push(...await provider.getChildren(includedNodes[index]));
								}
							}
							const included = includedNodes
								.find(item => item.node.kind === 'project' && item.node.csprojUri.toString() === projectUri.toString());
							assert.ok(included?.node.kind === 'project' && included.node.existsOnDisk);
						}
					} finally { provider.dispose(); cache.dispose(); }
				}
			}
		} finally {
			CsprojCache.getInstance = originalCache;
			Object.defineProperty(vscode.window, 'showWarningMessage', { configurable: true, value: originalWarning });
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('rejects including a deleted project from a stale excluded project item without changing the solution', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'painkiller-stale-project-'));
		const solutionUri = vscode.Uri.file(path.join(directory, 'App.slnx'));
		const projectUri = vscode.Uri.file(path.join(directory, 'Missing.csproj'));
		const content = '<Solution>\n</Solution>\n';
		const provider = new CsprojProjectsTreeProvider(vscode.Uri.file(directory), undefined, async () => [solutionUri]);
		try {
			await fs.writeFile(solutionUri.fsPath, content);
			const staleItem = new CsprojProjectTreeItem({
				kind: 'excludedProject', label: 'Missing', solutionUri, csprojUri: projectUri,
			}, vscode.Uri.file(directory));
			await assert.rejects(provider.includeProject(staleItem),
				(error: unknown) => error instanceof vscode.FileSystemError && error.code === 'FileNotFound');
			assert.strictEqual(await fs.readFile(solutionUri.fsPath, 'utf8'), content);
		} finally {
			provider.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('moving a project with shared or nested projects preserves every physical project path', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'painkiller-project-move-'));
		const originalCache = CsprojCache.getInstance;
		const originalWarning = vscode.window.showWarningMessage;
		try {
			for (const siblingPath of ['B.csproj', 'Nested/B.csproj']) {
				const root = path.join(directory, siblingPath.startsWith('Nested') ? 'nested' : 'shared');
				const folder = path.join(root, 'Common');
				const projectUri = vscode.Uri.file(path.join(folder, 'A.csproj'));
				const siblingUri = vscode.Uri.file(path.join(folder, siblingPath));
				const solutionUri = vscode.Uri.file(path.join(root, 'App.slnx'));
				await fs.mkdir(path.dirname(siblingUri.fsPath), { recursive: true });
				await fs.writeFile(projectUri.fsPath, '<Project />');
				await fs.writeFile(siblingUri.fsPath, '<Project />');
				await fs.writeFile(solutionUri.fsPath, `<Solution><Folder Name="/Dest/" /><Project Path="Common/A.csproj" /><Project Path="Common/${siblingPath}" /></Solution>`);
				const cache = new CsprojCache(async () => [projectUri, siblingUri]);
				CsprojCache.getInstance = () => cache;
				const provider = new CsprojProjectsTreeProvider(vscode.Uri.file(root));
				let prompted = false;
				Object.defineProperty(vscode.window, 'showWarningMessage', { configurable: true, value: async (message: string) => {
					assert.ok(message.includes('Move it only inside the solution structure?'));
					prompted = true;
					return 'Move In Solution Only';
				} });
				try {
					const source = new CsprojProjectTreeItem({
						kind: 'project', label: 'A', folderUri: vscode.Uri.file(folder), csprojUri: projectUri, solutionUri,
						projectPath: 'Common/A.csproj', existsOnDisk: true,
						solutionProjectPaths: new Set(), isAspNet: false, isTest: false,
						isBlazor: false, isMaui: false,
					}, vscode.Uri.file(root));
					const targetFolder = vscode.Uri.file(path.join(root, 'Dest'));
					const target = new CsprojProjectTreeItem({
						kind: 'folder', label: 'Dest', createProjectUri: targetFolder,
						createFolderTarget: { solutionUri, parentGuid: 'Dest', physicalBaseUri: targetFolder },
						children: [],
					}, vscode.Uri.file(root));
					const transfer = new vscode.DataTransfer();
					provider.handleDrag([source], transfer);
					await provider.handleDrop(target, transfer);
					assert.ok(prompted);
					assert.strictEqual(await fs.readFile(projectUri.fsPath, 'utf8'), '<Project />');
					assert.strictEqual(await fs.readFile(siblingUri.fsPath, 'utf8'), '<Project />');
					const solution = await fs.readFile(solutionUri.fsPath, 'utf8');
					assert.ok(solution.includes('Path="Common/A.csproj"'));
					assert.ok(solution.includes(`Path="Common/${siblingPath}"`));
					await assert.rejects(fs.stat(path.join(root, 'Dest', 'Common')), { code: 'ENOENT' });
				} finally { provider.dispose(); cache.dispose(); }
			}
		} finally {
			CsprojCache.getInstance = originalCache;
			Object.defineProperty(vscode.window, 'showWarningMessage', { configurable: true, value: originalWarning });
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test('bounds recursive NuGet HTTP concurrency and coalesces identical metadata requests', async () => {
		const originalFetch = globalThis.fetch;
		let active = 0;
		let maximum = 0;
		const requests = new Map<string, number>();
		clearNugetCaches();
		try {
			globalThis.fetch = async input => {
				const url = String(input);
				requests.set(url, (requests.get(url) ?? 0) + 1);
				active++;
				maximum = Math.max(maximum, active);
				await new Promise<void>(resolve => setTimeout(resolve, 5));
				active--;
				if (url.endsWith('index.json')) {
					return new Response(JSON.stringify({ resources: [
						{ '@type': 'PackageBaseAddress/3.0.0', '@id': 'https://metadata.invalid/packages' },
					] }), { headers: { 'Content-Type': 'application/json' } });
				}
				const xml = url.includes('/root/') ? '<dependencies>' + Array.from({ length: 12 }, (_, i) =>
					`<dependency id="Child${i}" version="1.0.0" />`).join('') + '</dependencies>' : '<dependencies />';
				return new Response(xml);
			};
			const resolved = new Map(Array.from({ length: 12 }, (_, i) =>
				[`child${i}`, { id: `Child${i}`, resolvedVersion: '1.0.0' }]));
			const [first, second] = await Promise.all([
				getPackageDependencies('/nonexistent/painkiller/Root.csproj', 'Root', '1.0.0', resolved),
				getPackageDependencies('/nonexistent/painkiller/Root.csproj', 'Root', '1.0.0', resolved),
			]);
			assert.strictEqual(first.length, 12);
			assert.deepStrictEqual(second, first);
			assert.ok(maximum <= 4, `Maximum HTTP concurrency was ${maximum}`);
			assert.strictEqual(requests.get('https://metadata.invalid/packages/root/1.0.0/root.nuspec'), 1);
			assert.ok([...requests.values()].every(count => count === 1));
		} finally { globalThis.fetch = originalFetch; clearNugetCaches(); }
	});

	test('does not start dotnet during lazy command registration and runs CLI asynchronously', async () => {
		const originalExec = childProcess.execFile;
		const context = { subscriptions: [] as vscode.Disposable[] };
		let calls = 0;
		try {
			Object.defineProperty(childProcess, 'execFile', { configurable: true, value: (
				_file: string, args: string[], options: { signal: AbortSignal },
				callback: (error: Error | null, stdout: string, stderr: string) => void,
			) => {
				calls++;
				const stdout = args[0] === '--version' ? '8.0.100\n' :
					'Template Name  Short Name  Language  Tags\n--------------------------------------------\nConsole App  console  [C#]  Common/Console';
				const timer = setTimeout(() => callback(null, stdout, ''), 20);
				options.signal.addEventListener('abort', () => { clearTimeout(timer); callback(new Error('aborted'), '', ''); });
				return { stdout: undefined, stderr: undefined };
			} });
			registerLazyTemplateCommands(context);
			assert.strictEqual(calls, 0);
			let yielded = false;
			const pending = runDotnet(['--version'], os.tmpdir());
			setTimeout(() => { yielded = true; }, 0);
			assert.strictEqual((await pending).stdout.trim(), '8.0.100');
			assert.ok(yielded);
			const source = new vscode.CancellationTokenSource();
			const cancelled = runDotnet(['--version'], os.tmpdir(), source.token);
			setTimeout(() => source.cancel(), 5);
			await assert.rejects(cancelled, vscode.CancellationError);
			source.dispose();
			const before = calls;
			const [first, second] = await Promise.all([
				fetchDotnetTemplates(context, os.tmpdir()), fetchDotnetTemplates(context, os.tmpdir()),
			]);
			assert.strictEqual(calls - before, 2);
			assert.strictEqual(first, second);
			await fetchDotnetTemplates(context, path.join(os.tmpdir(), 'other-sdk-context'));
			assert.strictEqual(calls - before, 4);
		} finally {
			Object.defineProperty(childProcess, 'execFile', { configurable: true, value: originalExec });
			for (const disposable of context.subscriptions) { disposable.dispose(); }
		}
		assert.strictEqual(parseDotnetTemplateList('Template Name  Short Name  Language  Tags\n--------------------------------------------\nConsole App  console  [C#]  Common/Console')[0].shorthand, 'console');
	});
});

suite('Diagnostics scheduling regressions', () => {
	let directory: string;
	const selection: AnalyzerSelection = {
		wrongNamespace: false, wrongFilename: true,
		mixedLanguageIdentifiers: false, duplicateTypeName: true,
	};
	const originalSymbols = csharpLanguageService.getSymbols;
	const originalTypes = csharpLanguageService.getTypes;
	const originalFind = csharpLanguageService.findTypes;

	setup(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'painkiller-performance-')); });
	teardown(async () => {
		csharpLanguageService.getSymbols = originalSymbols;
		csharpLanguageService.getTypes = originalTypes;
		csharpLanguageService.findTypes = originalFind;
		clearDiagnosticsCache();
		await fs.rm(directory, { recursive: true, force: true });
	});

	function type(document: vscode.TextDocument, name = 'Book', partial = false): CSharpType {
		const range = new vscode.Range(0, 0, 0, document.lineAt(0).text.length);
		return { name, type: 'class', namespace: 'Library', nested: false, partial, public: true, internal: false,
			symbol: new vscode.DocumentSymbol(name, '', vscode.SymbolKind.Class, range, new vscode.Range(0, 13, 0, 17)) };
	}

	async function files(count: number): Promise<vscode.Uri[]> {
		return Promise.all(Array.from({ length: count }, async (_, i) => {
			const file = path.join(directory, `File${i}.cs`);
			await fs.writeFile(file, 'public class Book {}');
			return vscode.Uri.file(file);
		}));
	}

	test('limits solution analysis to four documents and uses no per-type workspace searches', async () => {
		let running = 0;
		let maximum = 0;
		let calls = 0;
		csharpLanguageService.getSymbols = async document => [type(document).symbol];
		csharpLanguageService.getTypes = async document => {
			calls++; running++; maximum = Math.max(maximum, running);
			await new Promise<void>(resolve => setTimeout(resolve, 10));
			running--;
			return [type(document)];
		};
		csharpLanguageService.findTypes = async () => { throw new Error('Unexpected workspace search'); };
		const collection = vscode.languages.createDiagnosticCollection('performance-test');
		try {
			const result = await runDiagnosticsInBatches(collection, await files(12), { overrides: selection, batchSize: 50 });
			assert.strictEqual(result.processed, 12);
			assert.ok(maximum <= 4);
			assert.strictEqual(calls, 12);
			let duplicates = 0;
			collection.forEach((_uri, diagnostics) => { duplicates += diagnostics.filter(d => d.code === DIAGNOSTIC_CODE_DUPLICATE_TYPE_NAME).length; });
			assert.strictEqual(duplicates, 12);
		} finally { collection.dispose(); }
	});

	test('coalesces concurrent analysis of the same document and analyzer selection', async () => {
		let calls = 0;
		csharpLanguageService.getSymbols = async document => {
			calls++;
			await new Promise<void>(resolve => setTimeout(resolve, 10));
			return [type(document).symbol];
		};
		csharpLanguageService.getTypes = async document => [type(document)];
		const collection = vscode.languages.createDiagnosticCollection('performance-test');
		try {
			const [uri] = await files(1);
			await Promise.all([
				runDiagnosticsForUri(uri, collection, selection),
				runDiagnosticsForUri(uri, collection, selection),
			]);
			assert.strictEqual(calls, 1);
		} finally { collection.dispose(); }
	});

	test('cancels an in-flight solution scan without starting the remaining documents', async () => {
		const gate = deferred<CSharpType[]>();
		const started = deferred<void>();
		const source = new vscode.CancellationTokenSource();
		let calls = 0;
		csharpLanguageService.getSymbols = async () => [];
		csharpLanguageService.getTypes = async (_document, token) => {
			if (++calls === 4) { started.resolve(); }
			return waitWithCancellation(gate.promise, token);
		};
		const collection = vscode.languages.createDiagnosticCollection('performance-test');
		try {
			const pending = runDiagnosticsInBatches(collection, await files(20), { overrides: selection, token: source.token });
			await started.promise;
			source.cancel();
			const result = await pending;
			assert.ok(result.cancelled);
			assert.strictEqual(calls, 4);
			assert.strictEqual(result.processed, 0);
		} finally { gate.resolve([]); source.dispose(); collection.dispose(); }
	});

	test('groups duplicates by project and excludes partial declarations from warnings', async () => {
		const documents = await Promise.all(Array.from({ length: 4 }, () =>
			vscode.workspace.openTextDocument({ language: 'plaintext', content: 'public class Book {}' })));
		const index: WorkspaceDuplicateIndex = new Map(documents.map((document, i) => [document.uri.toString(), {
			document, version: document.version, projectRoot: i === 3 ? '/other' : '/app',
			types: [type(document, 'Book', i === 2)],
		}]));
		const collection = vscode.languages.createDiagnosticCollection('performance-test');
		try {
			publishDuplicateTypes(index, collection);
			assert.strictEqual(collection.get(documents[0].uri)?.length, 1);
			assert.strictEqual(collection.get(documents[1].uri)?.length, 1);
			assert.strictEqual(collection.get(documents[2].uri)?.length, 0);
			assert.strictEqual(collection.get(documents[3].uri)?.length, 0);
		} finally { collection.dispose(); }
	});

	test('cancelling one solution scan does not cancel a concurrent scan of the same files', async () => {
		const gate = deferred<void>();
		const started = deferred<void>();
		const source = new vscode.CancellationTokenSource();
		let calls = 0;
		csharpLanguageService.getSymbols = async () => [];
		csharpLanguageService.getTypes = async (document, token) => {
			if (++calls === 4) { started.resolve(); }
			await waitWithCancellation(gate.promise, token);
			return [type(document)];
		};
		const collection = vscode.languages.createDiagnosticCollection('performance-test');
		try {
			const uris = await files(2);
			const first = runDiagnosticsInBatches(collection, uris, { overrides: selection, token: source.token });
			const second = runDiagnosticsInBatches(collection, uris, { overrides: selection });
			await started.promise;
			source.cancel();
			assert.ok((await first).cancelled);
			gate.resolve();
			assert.strictEqual((await second).processed, 2);
		} finally { gate.resolve(); source.dispose(); collection.dispose(); }
	});
});
