import * as vscode from 'vscode';
import * as pathModule from 'path';
import { isPathExcluded } from './fileUtils.js';

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
	const files = await vscode.workspace.findFiles('**/*.cs', '{**/bin/**,**/obj/**}');
	const searchBuckets = await buildSearchBuckets(files, options?.contextUri);

	for (const bucket of searchBuckets) {
		for (const uri of bucket) {
			if (isPathExcluded(uri.path)) {
				continue;
			}

			let content: string;
			try {
				const buf = await vscode.workspace.fs.readFile(uri);
				content = Buffer.from(buf).toString('utf-8');
			} catch {
				continue;
			}

			const ns = extractNamespaceFromContent(content);
			if (typeExistsInContent(content, typeName)) {
				return {
					name: typeName,
					namespace: ns ?? '',
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
	const files = await vscode.workspace.findFiles('**/*.cs', '{**/bin/**,**/obj/**}');
	const searchBuckets = await buildSearchBuckets(files, options?.contextUri);

	// Build a pattern that matches IRequestHandler<ClassName or INotificationHandler<ClassName
	// Allow optional whitespace around the angle brackets.
	const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const iface = kind === 'request'
		? `IRequestHandler\\s*<\\s*${escaped}\\s*[,>]`
		: `INotificationHandler\\s*<\\s*${escaped}\\s*>`;
	const re = new RegExp(iface);

	for (const bucket of searchBuckets) {
		for (const uri of bucket) {
			if (isPathExcluded(uri.path)) {
				continue;
			}

			let content: string;
			try {
				const buf = await vscode.workspace.fs.readFile(uri);
				content = Buffer.from(buf).toString('utf-8');
			} catch {
				continue;
			}

			if (!re.test(content)) {
				continue;
			}

			// Extract the handler class name from the file
			const classMatch = content.match(
				/(?:public|internal|sealed)\s+(?:sealed\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/
			);
			const name = classMatch ? classMatch[1] : className + 'Handler';
			const ns = extractNamespaceFromContent(content) ?? '';

			return { name, namespace: ns, fileUri: uri };
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

	const allowedProjectOrder = await computeReferencedProjectOrder(contextProjectDir, projectMap);
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
	const csprojUris = await vscode.workspace.findFiles('**/*.csproj', '{**/bin/**,**/obj/**}');
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

function parseProjectReferences(content: string): string[] {
	const references: string[] = [];
	const regex = /<ProjectReference\b[^>]*Include="([^"]+)"[^>]*\/?>(?:\s*<\/ProjectReference>)?/gi;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(content)) !== null) {
		references.push(match[1]);
	}
	return references;
}

async function computeReferencedProjectOrder(
	contextProjectDir: string,
	projectMap: ReadonlyMap<string, vscode.Uri>
): Promise<string[]> {
	const order: string[] = [contextProjectDir];
	const visited = new Set<string>([contextProjectDir]);
	const queue: string[] = [contextProjectDir];

	while (queue.length > 0) {
		const currentDir = queue.shift();
		if (!currentDir) {
			continue;
		}
		const csprojUri = projectMap.get(currentDir);
		if (!csprojUri) {
			continue;
		}

		let content: string;
		try {
			const bytes = await vscode.workspace.fs.readFile(csprojUri);
			content = Buffer.from(bytes).toString('utf-8');
		} catch {
			continue;
		}

		for (const referencePath of parseProjectReferences(content)) {
			const normalizedReferencePath = referencePath.replace(/\\/g, '/');
			const absoluteReferencePath = pathModule.isAbsolute(normalizedReferencePath)
				? normalizedReferencePath
				: pathModule.resolve(currentDir, normalizedReferencePath);
			const referencedProjectDir = normalizeFsPath(pathModule.dirname(absoluteReferencePath));
			if (!projectMap.has(referencedProjectDir) || visited.has(referencedProjectDir)) {
				continue;
			}
			visited.add(referencedProjectDir);
			order.push(referencedProjectDir);
			queue.push(referencedProjectDir);
		}
	}

	return order;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extracts the namespace from file content (file-scoped or block-scoped).
 */
function extractNamespaceFromContent(content: string): string | undefined {
	const match = content.match(/^\s*namespace\s+([\w.]+)\s*(?:;|\{)/m);
	return match ? match[1] : undefined;
}

/**
 * Returns true if a type (class/struct/record/enum/interface) with the exact
 * given name is declared anywhere in the content.
 */
function typeExistsInContent(content: string, typeName: string): boolean {
	// Match:  [access-mod] [extra-mods] (class|struct|record|enum|interface) TypeName
	// or readonly record struct TypeName
	const escaped = typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const re = new RegExp(
		`(?:^|\\s)(?:readonly\\s+)?(?:record\\s+struct|class|struct|record|enum|interface)\\s+${escaped}(?:[\\s<{(;]|$)`,
		'm'
	);
	return re.test(content);
}
