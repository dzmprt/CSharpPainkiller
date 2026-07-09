import * as vscode from 'vscode';
import { type CsprojInfo, type ProjectContext } from '../types.js';
import { CsprojCache } from './csprojCache.js';

// ============================================================================
// Path segments excluded from C# file operations
// ============================================================================

/**
 * Path segments that should be excluded from C# file operations.
 * These are standard .NET build output directories.
 */
const EXCLUDED_PATH_SEGMENTS = new Set(['bin', 'obj']);

/**
 * Checks if a file path is inside an excluded directory (bin, obj, etc.).
 */
export function isPathExcluded(filePath: string): boolean {
	const pathSegments = filePath.split('/').filter(Boolean);
	return pathSegments.some(segment => EXCLUDED_PATH_SEGMENTS.has(segment));
}

// ============================================================================
// File collection
// ============================================================================

/**
 * Collects all .cs files within the target folder.
 * Excludes files in bin and obj directories (standard .NET build output folders).
 */
export async function collectCsFiles(folderUri: vscode.Uri): Promise<vscode.Uri[]> {
	const pattern = '**/*.cs';
	const exclusionPattern = '{**/bin/**,**/obj/**}';
	const files = await vscode.workspace.findFiles(pattern, exclusionPattern);

	// Filter to only include files within the target folder and exclude bin/obj
	const normalizedFolderPath = '/' + folderUri.path.replace(/^\/+/, '');
	// Ensure exact folder match by appending trailing slash to avoid matching similar folder names
	const folderPrefix = normalizedFolderPath + '/';
	return files.filter(uri => {
		const normalizedFilePath = '/' + uri.path.replace(/^\/+/, '');
		// Must be within the target folder (exact match)
		if (!normalizedFilePath.startsWith(folderPrefix)) {
			return false;
		}
		// Exclude files in bin/obj directories
		return !isPathExcluded(normalizedFilePath);
	});
}

/**
 * Collects all .cs files in the entire workspace.
 * Excludes files in bin and obj directories (standard .NET build output folders).
 */
export async function collectAllCsFilesInWorkspace(): Promise<vscode.Uri[]> {
	const pattern = '**/*.cs';
	const exclusionPattern = '{**/bin/**,**/obj/**}';
	const files = await vscode.workspace.findFiles(pattern, exclusionPattern);

	// Exclude files in bin/obj directories
	return files.filter(uri => {
		const normalizedFilePath = '/' + uri.path.replace(/^\/+/, '');
		return !isPathExcluded(normalizedFilePath);
	});
}

// ============================================================================
// .csproj discovery
// ============================================================================

/**
 * Finds the project root directory for a given file path using preloaded csproj info.
 * Returns the closest (deepest) .csproj directory that contains the file.
 */
export function findProjectRootForPath(
	filePath: string,
	csprojs: CsprojInfo[] | undefined
): string | undefined {
	if (!csprojs || csprojs.length === 0) {
		return undefined;
	}

	// Sort by depth (deepest first) to find the closest .csproj
	const sorted = [...csprojs].sort((a, b) => b.dirPath.split('/').length - a.dirPath.split('/').length);

	for (const csproj of sorted) {
		const normalized = '/' + csproj.dirPath.replace(/^\/+/, '');
		if (filePath === normalized || filePath.startsWith(normalized + '/')) {
			return csproj.dirPath;
		}
	}

	return undefined;
}

/**
 * Preloads all .csproj paths for a given workspace folder.
 * This is called once per folder operation to avoid repeated searches.
 */
export async function preloadCsprojs(_folderUri: vscode.Uri): Promise<ProjectContext> {
	const exclusionPattern = '{**/bin/**,**/obj/**}';
	const csprojFiles = await vscode.workspace.findFiles('**/*.csproj', exclusionPattern);

	const csprojs: CsprojInfo[] = csprojFiles.map(uri => ({
		dirPath: uri.path.replace(/\/[^/]*$/, ''),
	}));

	return { csprojs };
}

/**
 * Finds the project directory containing the given folder.
 * Used for single-file operations and new file creation.
 *
 * Uses the shared `CsprojCache` instead of a fresh `workspace.findFiles` scan on every
 * call — this function is on the hot path of the (debounced, per-keystroke) namespace
 * diagnostic, so re-scanning the whole workspace's disk here on every edit would be a
 * significant performance problem for large workspaces.
 */
export async function findProjectDirectory(folderUri: vscode.Uri): Promise<string | undefined> {
	const wsFolder = vscode.workspace.getWorkspaceFolder(folderUri);
	if (!wsFolder) {
		return undefined;
	}

	const csprojs = await CsprojCache.getInstance().getCsprojs();
	if (csprojs.length === 0) {
		return undefined;
	}

	return findProjectRootForPath(folderUri.path, csprojs);
}

// ============================================================================
// URI helpers
// ============================================================================

/**
 * Gets the parent folder URI for a given file URI.
 */
export function getParentFolder(fileUri: vscode.Uri): vscode.Uri {
	return fileUri.with({ path: fileUri.path.substring(0, fileUri.path.lastIndexOf('/')) });
}

/**
 * Extracts filename from a vscode.Uri.
 */
export function getFileNameFromUri(uri: vscode.Uri): string {
	const pathSegments = uri.path.split('/').filter(Boolean);
	return pathSegments[pathSegments.length - 1] ?? uri.fsPath;
}

/**
 * Extracts the file base name (without .cs extension) from a vscode.Uri.
 */
export function getFileBaseNameFromUri(uri: vscode.Uri): string {
	const fileName = getFileNameFromUri(uri);
	return fileName.endsWith('.cs') ? fileName.slice(0, -3) : fileName;
}

/**
 * Checks if a URI is a directory.
 */
export async function uriIsDirectory(uri: vscode.Uri): Promise<boolean> {
	const stat = await vscode.workspace.fs.stat(uri);
	return (stat.type & vscode.FileType.Directory) === vscode.FileType.Directory;
}

/**
 * Checks if a URI is a file.
 */
export async function uriIsFile(uri: vscode.Uri): Promise<boolean> {
	const stat = await vscode.workspace.fs.stat(uri);
	return (stat.type & vscode.FileType.File) === vscode.FileType.File;
}