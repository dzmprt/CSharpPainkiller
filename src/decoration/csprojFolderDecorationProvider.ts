import * as vscode from 'vscode';
import { CsprojCache } from '../utils/csprojCache.js';

/**
 * Provides file decorations for folders containing .csproj files.
 * Decorates project folders with a purple badge to visually distinguish them
 * in the file explorer without interfering with git or error decorations.
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
		await this.refreshCsprojFolders();

		// Listen for csproj file changes to update decorations
		const csprojWatcher = vscode.workspace.createFileSystemWatcher('**/*.csproj');
		this.disposable = csprojWatcher;

		csprojWatcher.onDidCreate(() => this.refreshCsprojFolders());
		csprojWatcher.onDidDelete(() => this.refreshCsprojFolders());
		csprojWatcher.onDidChange(() => {
			// Don't need to refresh on change, only creation/deletion affects structure
		});
	}

	/**
	 * Refresh the set of folders containing .csproj files.
	 */
	private async refreshCsprojFolders(): Promise<void> {
		const cache = CsprojCache.getInstance();
		const csprojs = await cache.getCsprojs();

		const newFolders = new Set<string>();
		for (const csproj of csprojs) {
			newFolders.add(csproj.dirPath);
		}

		this.csprojFolders = newFolders;

		// Notify VS Code that decorations have changed for all folders
		// We use a workspace root URI as a general refresh signal
		if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
			this.updateEmitter.fire(vscode.workspace.workspaceFolders[0].uri);
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
				badge: '◇',
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
