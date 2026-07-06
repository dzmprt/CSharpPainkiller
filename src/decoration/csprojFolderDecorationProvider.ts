import * as vscode from 'vscode';
import { CsprojCache } from '../utils/csprojCache.js';

/**
 * Provides file decorations for folders containing .csproj files.
 * Adds a best-effort Explorer decoration. VS Code can still let diagnostics
 * or SCM decorations take precedence for the same folder.
 */
export class CsprojFolderDecorationProvider implements vscode.FileDecorationProvider {
	private disposable: vscode.Disposable | null = null;
	private csprojFolders = new Set<string>();
	private updateEmitter = new vscode.EventEmitter<vscode.Uri>();

	readonly onDidChangeFileDecorations = this.updateEmitter.event;

	/**
	 * Initialize the decoration provider.
	 * Loads initial csproj folders and sets up watchers for changes.
	 */
	async initialize(): Promise<void> {
		await this.refresh();

		// Listen for csproj file changes to update decorations
		const csprojWatcher = vscode.workspace.createFileSystemWatcher('**/*.csproj');
		this.disposable = csprojWatcher;

		csprojWatcher.onDidCreate(() => this.refresh());
		csprojWatcher.onDidDelete(() => this.refresh());
		csprojWatcher.onDidChange(() => {
			// Don't need to refresh on change, only creation/deletion affects structure
		});
	}

	async refresh(): Promise<void> {
		CsprojCache.getInstance().invalidate();
		await this.refreshCsprojFolders();
	}

	/**
	 * Refresh the set of folders containing .csproj files.
	 */
	private async refreshCsprojFolders(): Promise<void> {
		const cache = CsprojCache.getInstance();
		const csprojs = await cache.getCsprojs();

		const previousFolders = this.csprojFolders;
		const newFolders = new Set<string>();
		for (const csproj of csprojs) {
			newFolders.add(csproj.dirPath);
		}

		this.csprojFolders = newFolders;

		const changedFolders = new Set([...previousFolders, ...newFolders]);
		for (const folderPath of changedFolders) {
			this.updateEmitter.fire(vscode.Uri.file(folderPath));
		}
	}

	/**
	 * Provide file decoration for a given URI.
	 * Returns a decoration for folders containing .csproj files.
	 */
	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | null {
		// Only decorate if the URI is a directory containing .csproj files
		const normalizedPath = '/' + uri.path.replace(/^\/+/, '');

		if (this.csprojFolders.has(normalizedPath)) {
			return {
				badge: 'C#',
				color: new vscode.ThemeColor('charts.purple'),
				tooltip: 'C# Project Folder (.csproj)',
				propagate: false, // Don't propagate to parent folders
			};
		}

		return null;
	}

	/**
	 * Clean up resources.
	 */
	dispose(): void {
		this.disposable?.dispose();
		this.updateEmitter.dispose();
	}
}
