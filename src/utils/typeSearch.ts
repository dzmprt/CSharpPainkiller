import * as vscode from 'vscode';
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

/**
 * Searches all .cs files in the workspace for a type with the given name.
 * Returns the first match found or undefined if none exists.
 *
 * Supports class, struct, record, record struct, enum, interface.
 */
export async function findTypeInWorkspace(typeName: string): Promise<FoundType | undefined> {
	const files = await vscode.workspace.findFiles('**/*.cs', '{**/bin/**,**/obj/**}');

	for (const uri of files) {
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
	kind: 'request' | 'notification'
): Promise<FoundType | undefined> {
	const files = await vscode.workspace.findFiles('**/*.cs', '{**/bin/**,**/obj/**}');

	// Build a pattern that matches IRequestHandler<ClassName or INotificationHandler<ClassName
	// Allow optional whitespace around the angle brackets.
	const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const iface = kind === 'request'
		? `IRequestHandler\\s*<\\s*${escaped}\\s*[,>]`
		: `INotificationHandler\\s*<\\s*${escaped}\\s*>`;
	const re = new RegExp(iface);

	for (const uri of files) {
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

	return undefined;
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
