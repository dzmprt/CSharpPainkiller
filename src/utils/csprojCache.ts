import * as vscode from 'vscode';
import { type CsprojInfo } from '../types.js';

/**
 * Singleton cache for csproj discovery results.
 * Prevents repeated workspace.findFiles calls for .csproj files on every file analysis.
 * Cache is invalidated when .csproj files change.
 */
export class CsprojCache {
	private static instance: CsprojCache | null = null;

	private csprojs: CsprojInfo[] = [];
	private resolvedRoots = new Map<string, string | undefined>(); // filePath -> csprojDirPath
	private initialized = false;
	private watcher: vscode.FileSystemWatcher | null = null;

	/** Get the singleton instance. */
	static getInstance(): CsprojCache {
		if (!CsprojCache.instance) {
			CsprojCache.instance = new CsprojCache();
		}
		return CsprojCache.instance;
	}

	/** Initialize cache by discovering all .csproj files in workspace. */
	async initialize(context: vscode.ExtensionContext): Promise<void> {
		if (this.initialized) {
			return;
		}

		await this.refreshCsprojs();
		this.initialized = true;

		// Watch for .csproj file changes to invalidate cache
		this.watcher = vscode.workspace.createFileSystemWatcher('**/*.csproj');
		context.subscriptions.push(this.watcher);

		this.watcher.onDidCreate(() => this.invalidate());
		this.watcher.onDidDelete(() => this.invalidate());
		this.watcher.onDidChange(() => this.invalidate());

		// Also invalidate on workspace configuration changes
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(() => this.invalidate())
		);
	}

	/** Refresh csproj list from workspace. */
	private async refreshCsprojs(): Promise<void> {
		const exclusionPattern = '{**/bin/**,**/obj/**}';
		try {
			const csprojFiles = await vscode.workspace.findFiles('**/*.csproj', exclusionPattern);
			this.csprojs = csprojFiles.map(uri => ({
				dirPath: uri.path.replace(/\/[^/]*$/, ''),
			}));
			// Sort by depth (deepest first) for faster lookup
			this.csprojs.sort((a, b) => b.dirPath.split('/').length - a.dirPath.split('/').length);
			// Clear resolved roots cache when csprojs list changes
			this.resolvedRoots.clear();
		} catch {
			this.csprojs = [];
			this.resolvedRoots.clear();
		}
	}

	/** Invalidate entire cache. */
	invalidate(): void {
		this.initialized = false;
		this.csprojs = [];
		this.resolvedRoots.clear();
	}

	/** Get all cached csproj info, initializing if needed. */
	async getCsprojs(): Promise<CsprojInfo[]> {
		if (!this.initialized || this.csprojs.length === 0) {
			await this.refreshCsprojs();
			this.initialized = true;
		}
		return this.csprojs;
	}

	/**
	 * Find the project root directory for a given file path.
	 * Uses cached results when available.
	 */
	findProjectRootForPath(filePath: string): string | undefined {
		// Check cache first
		const cached = this.resolvedRoots.get(filePath);
		if (cached !== undefined) {
			return cached;
		}

		const normalized = '/' + filePath.replace(/^\/+/, '');

		// Use cached csprojs sorted by depth (deepest first)
		for (const csproj of this.csprojs) {
			const normalizedCsproj = '/' + csproj.dirPath.replace(/^\/+/, '');
			if (normalized === normalizedCsproj || normalized.startsWith(normalizedCsproj + '/')) {
				this.resolvedRoots.set(filePath, csproj.dirPath);
				return csproj.dirPath;
			}
		}

		this.resolvedRoots.set(filePath, undefined);
		return undefined;
	}

	/** Get the underlying csproj array for backward compatibility. */
	getCsprojArray(): CsprojInfo[] {
		return this.csprojs;
	}

	/** Clear the resolved roots cache (e.g., when file paths change). */
	clearResolvedRoots(): void {
		this.resolvedRoots.clear();
	}

	/** Dispose watcher and clear cache. */
	dispose(): void {
		this.watcher?.dispose();
		this.watcher = null;
		this.invalidate();
	}
}