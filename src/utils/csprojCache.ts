import * as vscode from 'vscode';
import * as pathModule from 'path';
import { type CsprojInfo } from '../types.js';
import { AsyncCache } from './asyncWork.js';
import { ErrorHandler } from './errorHandler.js';
import { runDotnet } from './dotnetCli.js';

export class CsprojCache implements vscode.Disposable {
	private static instance: CsprojCache | null = null;
	private csprojs: CsprojInfo[] = [];
	private projectUris: vscode.Uri[] = [];
	private resolvedRoots = new Map<string, string | undefined>();
	private readonly discovery = new AsyncCache<string, vscode.Uri[]>(1);
	private readonly content = new AsyncCache<string, string>(2000);
	private readonly references = new AsyncCache<string, string[]>(2000);
	private readonly namespaces = new AsyncCache<string, string>(2000);
	private readonly changeEmitter = new vscode.EventEmitter<{ uri?: vscode.Uri; structureChanged: boolean }>();
	private readonly subscriptions: vscode.Disposable[] = [];
	private initialized = false;
	private generation = 0;

	readonly onDidChange = this.changeEmitter.event;
	get version(): number { return this.generation; }

	constructor(private readonly discoverProjects = () =>
		vscode.workspace.findFiles('**/*.csproj', '{**/bin/**,**/obj/**,**/.dotnet/**}'),
		private readonly evaluateRootNamespace = async (uri: vscode.Uri): Promise<string> => {
			if (!vscode.workspace.isTrusted) { throw new Error('Trust the workspace before evaluating MSBuild project properties.'); }
			const result = await runDotnet(['msbuild', uri.fsPath, '-nologo', '-getProperty:RootNamespace'], pathModule.dirname(uri.fsPath));
			return result.stdout.trim();
		},
	) {}

	static getInstance(): CsprojCache {
		return CsprojCache.instance ??= new CsprojCache();
	}

	async initialize(context: Pick<vscode.ExtensionContext, 'subscriptions'>): Promise<void> {
		if (this.initialized) { return; }
		this.initialized = true;
		const watcher = vscode.workspace.createFileSystemWatcher('**/*.csproj');
		const namespaceWatcher = vscode.workspace.createFileSystemWatcher('**/*.{props,targets}');
		this.subscriptions.push(
			watcher,
			watcher.onDidCreate(uri => this.invalidate(uri, true)),
			watcher.onDidDelete(uri => this.invalidate(uri, true)),
			watcher.onDidChange(uri => this.invalidate(uri)),
			namespaceWatcher,
			namespaceWatcher.onDidCreate(() => this.invalidateNamespaces()),
			namespaceWatcher.onDidDelete(() => this.invalidateNamespaces()),
			namespaceWatcher.onDidChange(() => this.invalidateNamespaces()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.invalidate()),
			vscode.workspace.onDidChangeTextDocument(event => {
				if (event.document.uri.path.endsWith('.csproj')) { this.invalidate(event.document.uri); }
				else if (/\.(props|targets)$/.test(event.document.uri.path)) { this.invalidateNamespaces(); }
			}),
			vscode.workspace.onDidCloseTextDocument(document => {
				if (document.uri.path.endsWith('.csproj')) { this.invalidate(document.uri); }
				else if (/\.(props|targets)$/.test(document.uri.path)) { this.invalidateNamespaces(); }
			}),
		);
		context.subscriptions.push(this);
		await this.getCsprojs();
	}

	invalidate(uri?: vscode.Uri, structureChanged = false): void {
		this.generation++;
		this.references.clear();
		this.namespaces.clear();
		if (uri) {
			this.content.delete(uri.toString());
		} else {
			this.content.clear();
		}
		if (!uri || structureChanged) {
			this.discovery.clear();
			this.csprojs = [];
			this.projectUris = [];
			this.resolvedRoots.clear();
		}
		this.changeEmitter.fire({ uri, structureChanged: !uri || structureChanged });
	}

	private invalidateNamespaces(): void {
		this.generation++;
		this.namespaces.clear();
		this.changeEmitter.fire({ structureChanged: false });
	}

	async getProjectUris(): Promise<vscode.Uri[]> {
		const generation = this.generation;
		const uris = await this.discovery.get('workspace', async () => {
			try {
				return await this.discoverProjects();
			} catch (error) {
				ErrorHandler.logError('Discovering C# projects', error);
				throw error;
			}
		});
		if (generation !== this.generation) { return this.getProjectUris(); }
		if (this.projectUris !== uris) {
			this.projectUris = uris;
			this.csprojs = uris.map(uri => ({ dirPath: uri.path.replace(/\/[^/]*$/, ''), projectUri: uri }))
				.sort((a, b) => b.dirPath.length - a.dirPath.length);
			this.resolvedRoots.clear();
		}
		return uris;
	}

	async getCsprojs(): Promise<CsprojInfo[]> {
		await this.getProjectUris();
		return this.csprojs;
	}

	getProjectContent(uri: vscode.Uri): Promise<string> {
		return this.content.get(uri.toString(), async () => {
			const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
			return document ? document.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
		});
	}

	async getRootNamespace(uri: vscode.Uri): Promise<string> {
		const generation = this.generation;
		const namespace = await this.namespaces.get(uri.toString(), async () => {
			const modified = vscode.workspace.textDocuments.find(document => document.isDirty &&
				(document.uri.toString() === uri.toString() || /\.(props|targets)$/.test(document.uri.path)));
			if (modified) { throw new Error(`Save "${modified.uri.fsPath}" before evaluating the project namespace.`); }
			const evaluated = (await this.evaluateRootNamespace(uri)).trim();
			const result = evaluated || pathModule.basename(uri.fsPath, '.csproj');
			if (!/^@?[\p{L}_][\p{L}\p{N}_]*(?:\.@?[\p{L}_][\p{L}\p{N}_]*)*$/u.test(result)) {
				throw new Error(`MSBuild returned an invalid RootNamespace "${result}" for "${uri.fsPath}".`);
			}
			return result;
		});
		if (generation !== this.generation) { return this.getRootNamespace(uri); }
		return namespace;
	}

	getReferencedProjectOrder(projectUri: vscode.Uri): Promise<string[]> {
		return this.references.get(projectUri.toString(), async () => {
			const projects = await this.getProjectUris();
			const byPath = new Map(projects.map(uri => [uri.path, uri]));
			const queue = [projectUri];
			const visited = new Set([projectUri.path]);
			for (let i = 0; i < queue.length; i++) {
				const current = queue[i];
				const content = await this.getProjectContent(current);
				const regex = /<ProjectReference\b[^>]*Include="([^"]+)"[^>]*\/?>(?:\s*<\/ProjectReference>)?/gi;
				for (const match of content.matchAll(regex)) {
					const relative = match[1].replace(/\\/g, '/');
					const target = pathModule.isAbsolute(relative)
						? current.scheme === 'file' ? vscode.Uri.file(relative) : current.with({ path: relative })
						: vscode.Uri.joinPath(current, '..', relative);
					const referenced = byPath.get(target.path);
					if (referenced && !visited.has(target.path)) {
						visited.add(target.path);
						queue.push(referenced);
					}
				}
			}
			return queue.map(uri => pathModule.dirname(uri.fsPath));
		});
	}

	findProjectRootForPath(filePath: string): string | undefined {
		if (this.resolvedRoots.has(filePath)) { return this.resolvedRoots.get(filePath); }
		const normalized = '/' + filePath.replace(/^\/+/, '');
		const root = this.csprojs.find(project =>
			normalized === project.dirPath || normalized.startsWith(project.dirPath + '/'))?.dirPath;
		this.resolvedRoots.set(filePath, root);
		if (this.resolvedRoots.size > 2000) { this.resolvedRoots.delete(this.resolvedRoots.keys().next().value!); }
		return root;
	}

	getCsprojArray(): CsprojInfo[] { return this.csprojs; }
	clearResolvedRoots(): void { this.resolvedRoots.clear(); }

	dispose(): void {
		for (const subscription of this.subscriptions.splice(0)) { subscription.dispose(); }
		this.initialized = false;
		this.invalidate();
		this.changeEmitter.dispose();
		if (CsprojCache.instance === this) { CsprojCache.instance = null; }
	}
}
