import * as vscode from 'vscode';
import * as pathModule from 'path';
import { isPathExcluded } from './fileUtils.js';
import { csharpLanguageService } from '../services/csharpLanguageService.js';
import { CsprojCache } from './csprojCache.js';

// ============================================================================
// Type search result
// ============================================================================

export interface FoundType {
	/** The simple type name, e.g. "Author" */
	name: string;
	/** Namespace the type lives in, e.g. "MyApp.Models" */
	namespace: string;
	/** The file URI where the type was declared */
	fileUri: vscode.Uri;
}

interface SearchOptions {
	/**
	 * File/folder URI that defines the project search scope.
	 * Search order: current project -> referenced projects (transitively).
	 */
	contextUri?: vscode.Uri;
}

/**
 * Searches all .cs files in the workspace for a type with the given name.
 * Returns the first match found or undefined if none exists.
 *
 * Supports class, struct, record, record struct, enum, interface.
 */
export async function findTypeInWorkspace(typeName: string): Promise<FoundType | undefined> {
	return findTypeInWorkspaceWithOptions(typeName);
}

export async function findTypeInWorkspaceWithOptions(
	typeName: string,
	options?: SearchOptions
): Promise<FoundType | undefined> {
	const candidates = await csharpLanguageService.findTypes(typeName);
	const files = candidates.map(symbol => symbol.location.uri);
	const searchBuckets = await buildSearchBuckets(files, options?.contextUri);

	for (const bucket of searchBuckets) {
		for (const uri of bucket) {
			if (isPathExcluded(uri.path)) {
				continue;
			}

			const document = await vscode.workspace.openTextDocument(uri);
			const type = (await csharpLanguageService.getTypes(document)).find(type => type.name === typeName);
			if (type) {
				return {
					name: typeName,
					namespace: type.namespace,
					fileUri: uri,
				};
			}
		}
	}

	return undefined;
}

/**
 * Searches all .cs files for a handler that implements
 * IRequestHandler<RequestClassName, ...> or INotificationHandler<NotificationClassName>.
 *
 * This is more reliable than searching by class name because the handler class
 * can be named anything — the interface declaration is the canonical link.
 */
export async function findHandlerForMediator(
	className: string,
	kind: 'request' | 'notification',
	options?: SearchOptions
): Promise<FoundType | undefined> {
	const request = await findTypeInWorkspaceWithOptions(className, options);
	if (!request) { return undefined; }
	const document = await vscode.workspace.openTextDocument(request.fileUri);
	const requestType = (await csharpLanguageService.getTypes(document)).find(type => type.name === className);
	if (!requestType) { return undefined; }
	const references = await csharpLanguageService.request<vscode.Location[]>(
		'vscode.executeReferenceProvider', request.fileUri, requestType.symbol.selectionRange.start
	);
	const files = [...new Map(references.map(location => [location.uri.toString(), location.uri])).values()];
	// References already identify this request semantically, including handlers in
	// consuming projects which aren't referenced by the request's own project.
	const searchBuckets = [files];

	const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const iface = kind === 'request'
		? `^(?:(?:global::)?[\\w.]+\\.)?IRequestHandler\\s*<\\s*(?:[\\w.]+\\.)?${escaped}\\s*[,>]`
		: `^(?:(?:global::)?[\\w.]+\\.)?INotificationHandler\\s*<\\s*(?:[\\w.]+\\.)?${escaped}\\s*>`;
	const re = new RegExp(iface);

	for (const bucket of searchBuckets) {
		for (const uri of bucket) {
			if (isPathExcluded(uri.path)) {
				continue;
			}

			const handlerDocument = await vscode.workspace.openTextDocument(uri);
			for (const type of await csharpLanguageService.getTypes(handlerDocument)) {
				if (!type.nested && csharpLanguageService.getBaseTypes(handlerDocument, type).some(base => re.test(base.text))) {
					return { name: type.name, namespace: type.namespace, fileUri: uri };
				}
			}
		}
	}

	return undefined;
}

async function buildSearchBuckets(
	files: readonly vscode.Uri[],
	contextUri?: vscode.Uri
): Promise<vscode.Uri[][]> {
	if (!contextUri) {
		return [Array.from(files)];
	}

	const projectMap = await loadProjectMap();
	if (projectMap.size === 0) {
		return [Array.from(files)];
	}

	const projectDirs = Array.from(projectMap.keys())
		.sort((a, b) => b.length - a.length);
	const contextProjectDir = projectDirForPath(contextUri.fsPath, projectDirs);
	if (!contextProjectDir) {
		return [Array.from(files)];
	}

	const allowedProjectOrder = (await CsprojCache.getInstance().getReferencedProjectOrder(projectMap.get(contextProjectDir)!))
		.map(normalizeFsPath);
	const allowedProjects = new Set(allowedProjectOrder);
	const byProject = new Map<string, vscode.Uri[]>();

	for (const uri of files) {
		const projectDir = projectDirForPath(uri.fsPath, projectDirs);
		if (!projectDir || !allowedProjects.has(projectDir)) {
			continue;
		}
		const list = byProject.get(projectDir);
		if (list) {
			list.push(uri);
		} else {
			byProject.set(projectDir, [uri]);
		}
	}

	return allowedProjectOrder.map(projectDir => byProject.get(projectDir) ?? []);
}

async function loadProjectMap(): Promise<Map<string, vscode.Uri>> {
	const csprojUris = await CsprojCache.getInstance().getProjectUris();
	const projectMap = new Map<string, vscode.Uri>();
	for (const uri of csprojUris) {
		projectMap.set(normalizeFsPath(pathModule.dirname(uri.fsPath)), uri);
	}
	return projectMap;
}

function normalizeFsPath(fsPath: string): string {
	return pathModule.normalize(fsPath);
}

function projectDirForPath(filePath: string, sortedProjectDirs: readonly string[]): string | undefined {
	const normalizedPath = normalizeFsPath(filePath);
	for (const projectDir of sortedProjectDirs) {
		if (normalizedPath === projectDir || normalizedPath.startsWith(projectDir + pathModule.sep)) {
			return projectDir;
		}
	}
	return undefined;
}

