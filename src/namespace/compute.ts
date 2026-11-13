import * as vscode from 'vscode';
import { type CsprojInfo } from '../types.js';
import { findProjectRootForPath, findProjectDirectory } from '../utils/fileUtils.js';
import { sanitizeNamespaceSegment, normalizePath } from '../utils/contentParser.js';
import { CsprojCache } from '../utils/csprojCache.js';

// ============================================================================
// Core namespace computation (shared by all paths)
// ============================================================================

/**
 * Computes the namespace for a file based on its path relative to project root.
 * This is the core logic shared by both single-file and batch operations.
 *
 * @param fileFolderPath - The absolute path of the file's parent folder
 * @param targetFolderPath - The absolute path of the target folder (root of namespace computation)
 * @param csprojs - Optional preloaded .csproj information. If provided, used to find project root efficiently.
 * @param workspaceName - Fallback workspace name if no .csproj is found
 * @returns The computed namespace string
 */
export function computeNamespaceForFile(
	fileFolderPath: string,
	targetFolderPath: string,
	csprojs: CsprojInfo[] | undefined,
	workspaceName: string
): string {
	const normalizedFileFolder = normalizePath(fileFolderPath);
	const normalizedTargetFolder = normalizePath(targetFolderPath);

	// Find the project root using preloaded csproj info
	const projectRootPath = findProjectRootForPath(normalizedFileFolder, csprojs);

	if (!projectRootPath) {
		return fallbackNamespace(targetFolderPath, workspaceName);
	}

	const normalizedProjectRoot = normalizePath(projectRootPath);

	let relativePath = '';
	if (normalizedFileFolder.startsWith(normalizedProjectRoot)) {
		relativePath = normalizedFileFolder.slice(normalizedProjectRoot.length).replace(/^\/+/, '');
	} else {
		// File is outside project root, use target folder relative path
		if (normalizedTargetFolder.startsWith(normalizedProjectRoot)) {
			relativePath = normalizedTargetFolder.slice(normalizedProjectRoot.length).replace(/^\/+/, '');
		} else {
			return fallbackNamespace(targetFolderPath, workspaceName);
		}
	}

	const roots = new Set(csprojs?.filter(project => project.dirPath === projectRootPath)
		.map(project => project.rootNamespace).filter(namespace => namespace !== undefined));
	if (roots.size > 1) {
		throw new Error(`Projects in "${projectRootPath}" have different RootNamespace values; the file namespace is ambiguous.`);
	}
	return buildNamespaceFromPath(projectRootPath, relativePath, [...roots][0]);
}

/**
 * Derives the namespace for a folder (used when creating new files).
 */
export async function deriveNamespaceFromFolder(folderUri: vscode.Uri): Promise<string> {
	const projDirPath = await findProjectDirectory(folderUri);

	if (!projDirPath) {
		const wsFolder = vscode.workspace.getWorkspaceFolder(folderUri);
		if (wsFolder) {
			return sanitizeNamespaceSegment(wsFolder.name.replace(/\./g, '.'));
		}

		const segments = folderUri.path.split('/').filter(Boolean);
		const folderName = segments.pop() ?? 'MyNamespace';
		return sanitizeNamespaceSegment(folderName.replace(/\./g, '.'));
	}

	const normalizedProjDir = normalizePath(projDirPath);
	const normalizedFolderPath = normalizePath(folderUri.path);

	let relativePath = '';
	if (normalizedFolderPath.startsWith(normalizedProjDir)) {
		relativePath = normalizedFolderPath.slice(normalizedProjDir.length).replace(/^\/+/, '');
	} else if (normalizedProjDir.startsWith(normalizedFolderPath)) {
		// Folder IS the project root, relative path is empty
	} else {
		const segments = folderUri.path.split('/').filter(Boolean);
		const folderName = segments.pop() ?? 'MyNamespace';
		return sanitizeNamespaceSegment(folderName.replace(/\./g, '.'));
	}

	const cache = CsprojCache.getInstance();
	const projects = (await cache.getCsprojs()).filter(project => project.dirPath === projDirPath);
	const roots = new Set(await Promise.all(projects.map(project =>
		project.projectUri ? cache.getRootNamespace(project.projectUri) : Promise.resolve(project.rootNamespace))));
	if (roots.size > 1) {
		throw new Error(`Projects in "${projDirPath}" have different RootNamespace values; the file namespace is ambiguous.`);
	}
	return buildNamespaceFromPath(projDirPath, relativePath, [...roots][0]);
}

/**
 * Derives the namespace for a file based on its parent folder.
 * Used for single-file operations.
 */
export async function deriveNamespaceFromFile(fileUri: vscode.Uri): Promise<string> {
	const parentFolder = fileUri.with({ path: fileUri.path.substring(0, fileUri.path.lastIndexOf('/')) });
	return deriveNamespaceFromFolder(parentFolder);
}

/**
 * Derives the namespace for a single file using preloaded project context.
 * This is the optimized path for batch folder operations.
 */
export async function deriveNamespaceForFile(
	fileUri: vscode.Uri,
	targetFolderUri: vscode.Uri,
	projectContext: { csprojs: CsprojInfo[] }
): Promise<string> {
	const parentFolder = fileUri.with({ path: fileUri.path.substring(0, fileUri.path.lastIndexOf('/')) });
	const wsFolder = vscode.workspace.getWorkspaceFolder(targetFolderUri);
	const workspaceName = wsFolder?.name ?? 'MyNamespace';

	return computeNamespaceForFile(
		parentFolder.path,
		targetFolderUri.path,
		projectContext.csprojs,
		workspaceName
	);
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Fallback namespace computation when no project root is found.
 * Uses the target folder name or workspace name.
 */
function fallbackNamespace(targetFolderPath: string, workspaceName: string): string {
	const segments = targetFolderPath.split('/').filter(Boolean);
	const folderName = segments.pop() ?? workspaceName;
	return sanitizeNamespaceSegment(folderName.replace(/\./g, '.'));
}

/**
 * Builds a namespace string from a project root path and a relative sub-path.
 * Uses the evaluated project namespace when available.
 */
function buildNamespaceFromPath(projectRootPath: string, relativePath: string, rootNamespace?: string): string {
	const rootSegments = projectRootPath.split('/').filter(Boolean);
	const baseNamespace = rootNamespace ?? sanitizeNamespaceSegment(
		(rootSegments.pop() ?? 'MyNamespace').replace(/\./g, '.')
	);

	const pathSegments = relativePath.split('/').filter(Boolean);
	const cleanedSegments = pathSegments.map(seg =>
		sanitizeNamespaceSegment(seg.replace(/\./g, '.'))
	);

	return [baseNamespace, ...cleanedSegments].join('.');
}