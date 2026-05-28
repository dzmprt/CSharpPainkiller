import * as vscode from 'vscode';
import { type CsprojInfo, type ProjectContext } from '../types.js';

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
 */
export async function findProjectDirectory(folderUri: vscode.Uri): Promise<string | undefined> {
	const wsFolder = vscode.workspace.getWorkspaceFolder(folderUri);
	if (!wsFolder) {
		return undefined;
	}

	const exclusionPattern = '{**/bin/**,**/obj/**}';
	const csprojFiles = await vscode.workspace.findFiles('**/*.csproj', exclusionPattern);
	if (csprojFiles.length === 0) {
		return undefined;
	}

	const targetPath = '/' + folderUri.path.replace(/^\/+/, '');

	const containingCsprojs = csprojFiles
		.map(uri => ({
			uri,
			dirPath: uri.path.replace(/\/[^/]*$/, ''),
		}))
		.filter(({ dirPath }) => {
			const normalized = '/' + dirPath.replace(/^\/+/, '');
			return targetPath === normalized || targetPath.startsWith(normalized + '/');
		});

	if (containingCsprojs.length === 0) {
		return undefined;
	}

	containingCsprojs.sort((a, b) => b.dirPath.split('/').length - a.dirPath.split('/').length);
	return containingCsprojs[0].dirPath;
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