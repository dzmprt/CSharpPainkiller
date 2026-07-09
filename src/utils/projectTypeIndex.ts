import * as vscode from 'vscode';
import { isPathExcluded } from './fileUtils.js';
import { extractTypesFromContent } from './contentParser.js';
import { CsprojCache } from './csprojCache.js';

/**
 * Per-project name → file index, e.g. `typeIndex.get(projectKey).get('Order')` is the set
 * of files (URI strings) that declare a type named "Order" within that project.
 */
type NameIndex = Map<string, Map<string, Set<string>>>;

interface FileContribution {
	projectKey: string;
	typeNames: string[];
}

function addToIndex(index: NameIndex, projectKey: string, name: string, fileKey: string): void {
	let byName = index.get(projectKey);
	if (!byName) {
		byName = new Map();
		index.set(projectKey, byName);
	}
	let files = byName.get(name);
	if (!files) {
		files = new Set();
		byName.set(name, files);
	}
	files.add(fileKey);
}

function removeFromIndex(index: NameIndex, projectKey: string, name: string, fileKey: string): void {
	const files = index.get(projectKey)?.get(name);
	if (!files) {
		return;
	}
	files.delete(fileKey);
	if (files.size === 0) {
		index.get(projectKey)?.delete(name);
	}
}

/**
 * Lightweight, incrementally-updated index of type declarations across the workspace,
 * scoped per project (via `CsprojCache`). Backs the "duplicate type name" diagnostic
 * (same type name declared in more than one file of the same project).
 *
 * Built once at startup via a full workspace scan, then kept fresh via a `**\/*.cs`
 * file watcher (for files not currently open) AND via `updateFileContent()` (called
 * from the diagnostics pipeline whenever an open file is (re-)analyzed, so unsaved
 * edits are reflected immediately without waiting for a save).
 */
export class ProjectTypeIndex {
	private static instance: ProjectTypeIndex | null = null;

	private initialized = false;
	private watcher: vscode.FileSystemWatcher | null = null;
	private initializePromise: Promise<void> | null = null;

	private readonly fileContributions = new Map<string, FileContribution>();
	private readonly typeIndex: NameIndex = new Map();

	/** Serializes updates so concurrent file events can't interleave and corrupt the index. */
	private updateQueue: Promise<void> = Promise.resolve();

	static getInstance(): ProjectTypeIndex {
		if (!ProjectTypeIndex.instance) {
			ProjectTypeIndex.instance = new ProjectTypeIndex();
		}
		return ProjectTypeIndex.instance;
	}

	/** Performs the initial full-workspace scan and starts watching for changes. */
	async initialize(context: vscode.ExtensionContext): Promise<void> {
		if (this.initialized) {
			return this.initializePromise ?? Promise.resolve();
		}
		this.initialized = true;
		this.initializePromise = this.initializeCore(context);
		return this.initializePromise;
	}

	async waitUntilInitialized(): Promise<void> {
		await (this.initializePromise ?? Promise.resolve());
		await this.updateQueue;
	}

	private async initializeCore(context: vscode.ExtensionContext): Promise<void> {
		const files = await vscode.workspace.findFiles('**/*.cs', '{**/bin/**,**/obj/**}');
		await Promise.all(files.map(uri => this.refreshFromDisk(uri)));

		this.watcher = vscode.workspace.createFileSystemWatcher('**/*.cs');
		context.subscriptions.push(this.watcher);
		this.watcher.onDidCreate(uri => this.enqueue(() => this.refreshFromDisk(uri)));
		this.watcher.onDidChange(uri => this.enqueue(() => this.refreshFromDisk(uri)));
		this.watcher.onDidDelete(uri => this.enqueue(() => Promise.resolve(this.removeFile(uri))));
	}

	/**
	 * Updates the index for a single file from already-loaded content (no disk I/O) —
	 * used by the diagnostics pipeline so an open, unsaved file's latest edits are
	 * reflected immediately rather than only after a save + file-watcher event.
	 */
	updateFileContent(uri: vscode.Uri, content: string): void {
		if (isPathExcluded(uri.path)) {
			return;
		}
		this.applyContribution(uri, content);
	}

	/** True if some OTHER file within the same project also declares a type named `typeName`. */
	hasDuplicateTypeInProject(uri: vscode.Uri, typeName: string): boolean {
		const projectKey = this.projectKeyFor(uri);
		const files = this.typeIndex.get(projectKey)?.get(typeName);
		if (!files) {
			return false;
		}
		const selfKey = uri.toString();
		for (const fileKey of files) {
			if (fileKey !== selfKey) {
				return true;
			}
		}
		return false;
	}

	private projectKeyFor(uri: vscode.Uri): string {
		return CsprojCache.getInstance().findProjectRootForPath(uri.path) ?? '';
	}

	private enqueue(task: () => Promise<void>): Promise<void> {
		this.updateQueue = this.updateQueue.then(task, task);
		return this.updateQueue;
	}

	private async refreshFromDisk(uri: vscode.Uri): Promise<void> {
		if (isPathExcluded(uri.path)) {
			return;
		}
		let content: string;
		try {
			const buf = await vscode.workspace.fs.readFile(uri);
			content = Buffer.from(buf).toString('utf-8');
		} catch {
			this.removeFile(uri);
			return;
		}
		this.applyContribution(uri, content);
	}

	private applyContribution(uri: vscode.Uri, content: string): void {
		const key = uri.toString();
		this.clearContribution(key);

		const projectKey = this.projectKeyFor(uri);
		const typeNames = extractTypesFromContent(content).types.map(t => t.name);

		this.fileContributions.set(key, { projectKey, typeNames });

		for (const name of typeNames) {
			addToIndex(this.typeIndex, projectKey, name, key);
		}
	}

	private removeFile(uri: vscode.Uri): void {
		const key = uri.toString();
		this.clearContribution(key);
		this.fileContributions.delete(key);
	}

	private clearContribution(key: string): void {
		const prev = this.fileContributions.get(key);
		if (!prev) {
			return;
		}
		for (const name of prev.typeNames) {
			removeFromIndex(this.typeIndex, prev.projectKey, name, key);
		}
	}
}
