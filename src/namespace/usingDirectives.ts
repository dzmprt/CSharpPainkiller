import {
	type UsingDirectiveChangeResult,
} from '../types.js';
import { escapeRegExp } from '../utils/contentParser.js';

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
	// If the file's namespace matches the new namespace, remove redundant self-namespace usings
	if (fileNamespace === newNamespace) {
		return removeRedundantUsing(content, newNamespace);
	}

	// Check if the using directive already exists
	if (content.includes(`using ${newNamespace};`)) {
		return { adjustedContent: content, wasAdded: false, wasRemoved: false };
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
	if (typeNames.size === 0) {
		return new Set();
	}

	// Type names inside using/namespace lines are not usage of the type itself
	const searchableContent = content
		.split('\n')
		.filter(line => !/^\s*using\s+/.test(line) && !/^\s*namespace\s+/.test(line))
		.join('\n');

	const found = new Set<string>();
	for (const typeName of typeNames) {
		const escaped = escapeRegExp(typeName);
		const regex = new RegExp(`(?<![a-zA-Z0-9_])${escaped}(?![a-zA-Z0-9_])`);
		if (regex.test(searchableContent)) {
			found.add(typeName);
		}
	}
	return found;
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