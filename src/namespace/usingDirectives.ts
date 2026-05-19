import * as vscode from 'vscode';
import {
	type UsingDirectiveChangeResult,
	type UsingDirectiveUpdateResult,
	type NamespaceChange,
} from '../types.js';
import { extractUsingDirectives, extractFileNamespace, escapeRegExp } from '../utils/contentParser.js';

// ============================================================================
// Using directive manipulation
// ============================================================================

/**
 * Adds a using directive for the new namespace in files that reference types from it.
 * Also removes redundant using directives if the file's namespace matches the new namespace.
 */
export function addUsingForNewNamespace(
	content: string,
	newNamespace: string,
	fileNamespace: string | undefined
): UsingDirectiveChangeResult {
	// Check if the using directive already exists
	if (content.includes(`using ${newNamespace};`)) {
		return { adjustedContent: content, wasAdded: false, wasRemoved: false };
	}

	// If the file's namespace matches the new namespace, remove the redundant using directives
	if (fileNamespace === newNamespace) {
		return removeRedundantUsing(content, newNamespace);
	}

	const lines = content.split('\n');
	let i = 0;

	// Skip initial blank lines (if any)
	while (i < lines.length && lines[i].trim() === '') {
		i++;
	}

	// Find the end of using statements
	let lastUsingEnd = i;
	while (i < lines.length) {
		const trimmedLine = lines[i].trim();
		if (/^using\s+/.test(trimmedLine)) {
			i++;
			lastUsingEnd = i;
			// Skip blank lines between usings
			while (i < lines.length && lines[i].trim() === '') {
				i++;
			}
		} else {
			break;
		}
	}

	// Insert the new using directive after existing usings
	const beforeUsing = lines.slice(0, lastUsingEnd).join('\n');
	const afterUsing = lines.slice(i).join('\n');
	const adjustedContent = `${beforeUsing}\nusing ${newNamespace};\n${afterUsing ? '\n' + afterUsing : ''}`;

	return { adjustedContent, wasAdded: true, wasRemoved: false };
}

/**
 * Checks if a file content references any of the given type names.
 * Returns the set of type names found in the content.
 */
export function findTypeReferencesInContent(content: string, typeNames: Set<string>): Set<string> {
	const found = new Set<string>();
	for (const typeName of typeNames) {
		const escaped = escapeRegExp(typeName);
		const regex = new RegExp(`(?<![a-zA-Z0-9_])${escaped}(?![a-zA-Z0-9_])`);
		if (regex.test(content)) {
			found.add(typeName);
		}
	}
	return found;
}

// ============================================================================
// Batch using directive update
// ============================================================================

/**
 * Updates using directives in files that reference types from changed namespaces.
 * For each file, checks:
 * 1. If any using directive matches an old namespace from a namespace change
 * 2. If the file content references any type names that moved to a new namespace
 * and adds corresponding using directives for the new namespaces.
 */
export async function updateUsingDirectivesForNamespaceChanges(
	csFiles: vscode.Uri[],
	namespaceChanges: NamespaceChange[]
): Promise<UsingDirectiveUpdateResult[]> {
	if (namespaceChanges.length === 0) {
		return [];
	}

	const results: UsingDirectiveUpdateResult[] = [];

	// Build a map of oldNamespace -> newNamespace for quick lookup
	const namespaceChangeMap = new Map<string, string>();
	// Build a map of typeName -> newNamespace for type reference lookup
	const typeToNewNamespaceMap = new Map<string, string>();
	// Collect all type names that changed namespaces
	const allChangedTypeNames = new Set<string>();

	// Collect the set of old namespaces that were renamed
	const changedOldNamespaces = new Set<string>();

	for (const change of namespaceChanges) {
		namespaceChangeMap.set(change.oldNamespace, change.newNamespace);
		changedOldNamespaces.add(change.oldNamespace);

		if (change.types) {
			for (const type of change.types) {
				typeToNewNamespaceMap.set(type.name, change.newNamespace);
				allChangedTypeNames.add(type.name);
			}
		}
	}

	// If no types were tracked, fall back to using-directive-only matching
	const hasTypeTracking = allChangedTypeNames.size > 0;

	// Pre-scan all files to determine which old namespaces now have zero remaining files
	// (orphaned namespaces). Old using directives should only be removed for those.
	const namespaceFileCount = new Map<string, number>();
	for (const fileUri of csFiles) {
		try {
			const buf = await vscode.workspace.fs.readFile(fileUri);
			const ns = extractFileNamespace(Buffer.from(buf).toString('utf-8'));
			if (ns) {
				namespaceFileCount.set(ns, (namespaceFileCount.get(ns) ?? 0) + 1);
			}
		} catch {
			// skip unreadable files
		}
	}
	// Old namespaces that have zero remaining files after all renames
	const orphanedOldNamespaces = new Set(
		[...changedOldNamespaces].filter(ns => (namespaceFileCount.get(ns) ?? 0) === 0)
	);

	for (const fileUri of csFiles) {
		try {
			const existingContent = await vscode.workspace.fs.readFile(fileUri);
			let content = Buffer.from(existingContent).toString('utf-8');
			let fileModified = false;

			// Skip files that had their namespace changed
			const isChangedFile = namespaceChanges.some(change => fileUri.toString() === change.fileUri.toString());
			if (isChangedFile) {
				results.push({ uri: fileUri, updated: false });
				continue;
			}

			// Extract the file's current namespace
			const fileNamespace = extractFileNamespace(content);

			// Track which new namespaces we need to add to this file
			const namespacesToAdd = new Set<string>();
			// Track which old using directives need to be removed
			const oldNamespacesToRemove = new Set<string>();

			// Check 1: using directive matching - if file has using OldNs, remove it and add using NewNs
			// NOTE: Old using is only removed if the old namespace is now orphaned (no files left in solution)
			const usingNamespaces = extractUsingDirectives(content);
			for (const usingNs of usingNamespaces) {
				const newNamespace = namespaceChangeMap.get(usingNs);
				if (newNamespace) {
					namespacesToAdd.add(newNamespace);
					if (orphanedOldNamespaces.has(usingNs)) {
						oldNamespacesToRemove.add(usingNs);
					}
				}
			}

			// Check 2: type reference scanning - if file references types that moved, add using
			if (hasTypeTracking) {
				const referencedTypes = findTypeReferencesInContent(content, allChangedTypeNames);
				for (const typeName of referencedTypes) {
					const newNamespace = typeToNewNamespaceMap.get(typeName);
					if (newNamespace) {
						namespacesToAdd.add(newNamespace);
					}
				}
			}

			// Step 1: Remove old/stale using directives that are no longer relevant
			for (const oldNamespace of oldNamespacesToRemove) {
				const result = removeUsingDirective(content, oldNamespace);
				if (result.wasRemoved) {
					content = result.adjustedContent;
					fileModified = true;
				}
			}

			// Step 2: Add using directives for all new namespaces that are needed
			for (const newNamespace of namespacesToAdd) {
				const result = addUsingForNewNamespace(content, newNamespace, fileNamespace);
				if (result.wasAdded || result.wasRemoved) {
					content = result.adjustedContent;
					fileModified = true;
				}
			}

			// Only write if we actually modified something in this file
			if (fileModified) {
				await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf-8'));
			}

			results.push({ uri: fileUri, updated: fileModified });
		} catch {
			// Skip files that can't be read
			results.push({ uri: fileUri, updated: false });
		}
	}

	return results;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Removes a using directive by namespace name from the file content.
 * Handles cleanup of trailing blank lines after the removed directive.
 *
 * @param content - The file content
 * @param namespaceToRemove - The namespace of the using directive to remove (e.g. "MyNamespace")
 * @returns The result indicating whether a using directive was removed
 */
export function removeUsingDirective(
	content: string,
	namespaceToRemove: string
): UsingDirectiveChangeResult {
	const lines = content.split('\n');
	let foundUsingToRemove = -1;

	// Find the using directive for namespaceToRemove (search all lines, not just consecutive usings)
	for (let i = 0; i < lines.length; i++) {
		const trimmedLine = lines[i].trim();
		if (/^using\s+/.test(trimmedLine)) {
			const usingMatch = trimmedLine.match(/^using\s+([\w.]+)\s*;/);
			if (usingMatch && usingMatch[1] === namespaceToRemove) {
				foundUsingToRemove = i;
				break;
			}
		}
	}

	if (foundUsingToRemove >= 0) {
		// Remove the using directive and any trailing blank line
		const newLines = lines.filter((line, idx) => {
			if (idx === foundUsingToRemove) {
				return false;
			}
			// Also remove blank line after the removed using (if next non-empty line is not another using)
			if (idx === foundUsingToRemove + 1 && line.trim() === '') {
				// Check if there are more using directives after this blank line
				let hasMoreUsings = false;
				for (let j = idx + 1; j < lines.length; j++) {
					if (lines[j].trim() === '') {
						continue;
					}
					if (/^using\s+/.test(lines[j].trim())) {
						hasMoreUsings = true;
					}
					break;
				}
				if (!hasMoreUsings) {
					return false;
				}
			}
			return true;
		});
		return { adjustedContent: newLines.join('\n'), wasAdded: false, wasRemoved: true };
	}

	return { adjustedContent: content, wasAdded: false, wasRemoved: false };
}

/**
 * Removes a redundant using directive that matches the file's own namespace.
 * Delegates to the generic removeUsingDirective function.
 */
function removeRedundantUsing(
	content: string,
	newNamespace: string
): UsingDirectiveChangeResult {
	return removeUsingDirective(content, newNamespace);
}