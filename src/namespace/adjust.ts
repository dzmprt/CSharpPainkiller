import * as vscode from 'vscode';
import { type FileAdjustResultWithContext } from '../types.js';
import { extractTypesFromContent, extractFileNamespaceWithIndent, hasPartialTypes } from '../utils/contentParser.js';
import { deriveNamespaceFromFile, deriveNamespaceForFile } from './compute.js';
import { removeUsingDirective } from './usingDirectives.js';

// ============================================================================
// Namespace adjustment in file content
// ============================================================================

/**
 * Checks if the given filename is Program.cs (case-insensitive).
 */
function isProgramCs(uriPath: string): boolean {
	const fileName = uriPath.split('/').pop()?.toLowerCase();
	return fileName === 'program.cs';
}

/**
 * Adjusts the namespace declaration in a file's content.
 * Supports both file-scoped and block-scoped namespace syntax.
 * Always uses file-scoped namespaces (namespace Name;) as the output format.
 * Removes all old namespace declarations (both block and file-scoped).
 * 
 * For Program.cs files: if there was no existing namespace, do NOT add a new one
 * (to support .NET 6+ minimal API style files that intentionally have no namespace).
 *
 * @param content - The full file content
 * @param uriPath - The URI path of the file (used to detect Program.cs)
 * @param newNamespace - The new namespace to set
 * @param skipPartialTypes - If true, files with partial type declarations are skipped
 * @returns The adjusted content and whether it was modified
 */
export function adjustFileNamespace(
	content: string,
	uriPath: string,
	newNamespace: string,
	skipPartialTypes: boolean = false
): { adjustedContent: string; wasAdjusted: boolean; oldNamespace: string | undefined } {
	// Skip namespace adjustment for files with partial types when requested
	if (skipPartialTypes && hasPartialTypes(content)) {
		const match = extractFileNamespaceWithIndent(content);
		const oldNamespace = match ? match.namespace : undefined;
		return { adjustedContent: content, wasAdjusted: false, oldNamespace };
	}

	// Check if this is a Program.cs file (done early since it's just filename-based)
	const isProgram = isProgramCs(uriPath);

	// Strip UTF-8 BOM if present — it confuses all regex anchors (^) and whitespace matches
	const hasBom = content.startsWith('\uFEFF');
	let workingContent = hasBom ? content.slice(1) : content;

	// Normalize CRLF → LF so that all regexes work correctly regardless of line endings.
	// We'll restore CRLF at the end if the original file used it.
	const hasCrlf = workingContent.includes('\r\n');
	if (hasCrlf) {
		workingContent = workingContent.replace(/\r\n/g, '\n');
	}

	// First, check for any existing namespace (block-scoped or file-scoped)
	const blockMatch = detectBlockNamespace(workingContent);
	const fileScopedMatch = workingContent.match(/^(\s*)namespace\s+([\w.]+)\s*;\s*(?:\/\/.*)?$/m);

	// Determine the old namespace from whichever exists
	let oldNamespace: string | undefined;
	if (blockMatch) {
		oldNamespace = blockMatch.name;
	} else if (fileScopedMatch) {
		oldNamespace = fileScopedMatch[2];
	}

	// If old namespace matches new namespace exactly, no change needed
	if (oldNamespace === newNamespace) {
		return { adjustedContent: content, wasAdjusted: false, oldNamespace };
	}

	// For Program.cs files: if there was no existing namespace, don't add one
	// This supports .NET 6+ minimal API style files that intentionally have no namespace
	if (isProgram && !oldNamespace) {
		return { adjustedContent: content, wasAdjusted: false, oldNamespace };
	}

	// Strategy: ALWAYS remove ALL existing namespaces completely (for non-Program.cs or Program.cs with namespace),
	// then add the new one
	// This is the most reliable way to ensure no duplicates (file-scoped + block-scoped coexisting)
	
	// Remove all namespaces (both file-scoped and block-scoped)
	workingContent = removeAllNamespaceDeclarations(workingContent);
	
	// Now insert the new namespace at the top
	const result = insertNamespaceAtTop(workingContent, newNamespace);

	if (!result.wasAdjusted) {
		return { ...result, oldNamespace };
	}

	let finalContent = normalizeSpacingAroundNamespace(result.adjustedContent);

	// Restore CRLF line endings if the original file used them
	if (hasCrlf) {
		finalContent = finalContent.replace(/\n/g, '\r\n');
	}

	// Re-attach the BOM if the original file had one
	if (hasBom) {
		finalContent = '\uFEFF' + finalContent;
	}

	return { adjustedContent: finalContent, wasAdjusted: true, oldNamespace };
}

// ============================================================================
// Single-file namespace adjustment
// ============================================================================

/**
 * Adjusts namespace for a single file using the legacy (non-batch) path.
 */
export async function adjustNamespaceForFile(
	fileUri: vscode.Uri,
	_targetFolderUri?: vscode.Uri,
	_projectContext?: { csprojs: import('../types.js').CsprojInfo[] }
): Promise<FileAdjustResultWithContext> {
	try {
		const existingContent = await vscode.workspace.fs.readFile(fileUri);
		const content = Buffer.from(existingContent).toString('utf-8');

		// Extract types from original content before namespace change
		const extractionResult = extractTypesFromContent(content);

		const newNamespace = await deriveNamespaceFromFile(fileUri);
		const { adjustedContent, wasAdjusted, oldNamespace } = adjustFileNamespace(content, fileUri.path, newNamespace, true);

		if (!wasAdjusted) {
			return { uri: fileUri, adjusted: false };
		}

		await vscode.workspace.fs.writeFile(fileUri, Buffer.from(adjustedContent, 'utf-8'));
		return {
			uri: fileUri,
			adjusted: true,
			oldNamespace: oldNamespace !== newNamespace ? oldNamespace : undefined,
			newNamespace: wasAdjusted ? newNamespace : undefined,
			types: extractionResult.types,
		};
	} catch (error) {
		return { uri: fileUri, adjusted: false, error: `${fileUri.fsPath}: ${error}` };
	}
}

/**
 * This is the optimized path for batch folder operations.
 */
export async function adjustNamespaceForFileWithContext(
	fileUri: vscode.Uri,
	targetFolderUri: vscode.Uri,
	projectContext: { csprojs: import('../types.js').CsprojInfo[] }
): Promise<FileAdjustResultWithContext> {
	try {
		const existingContent = await vscode.workspace.fs.readFile(fileUri);
		const content = Buffer.from(existingContent).toString('utf-8');

		// Extract types from original content before namespace change
		const extractionResult = extractTypesFromContent(content);

		const newNamespace = await deriveNamespaceForFile(fileUri, targetFolderUri, projectContext);
		const { adjustedContent, wasAdjusted, oldNamespace } = adjustFileNamespace(content, fileUri.path, newNamespace, true);

		if (!wasAdjusted) {
			return { uri: fileUri, adjusted: false };
		}

		await vscode.workspace.fs.writeFile(fileUri, Buffer.from(adjustedContent, 'utf-8'));
		return {
			uri: fileUri,
			adjusted: true,
			oldNamespace: oldNamespace !== newNamespace ? oldNamespace : undefined,
			newNamespace: wasAdjusted ? newNamespace : undefined,
			types: extractionResult.types,
		};
	} catch (error) {
		return { uri: fileUri, adjusted: false, error: `${fileUri.fsPath}: ${error}` };
	}
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Ensures exactly one blank line between the last using directive and the
 * namespace declaration. Handles both too many and too few blank lines.
 * If there are no using directives above the namespace, spacing is left as-is
 * (no blank line is inserted at the very top of the file).
 */
function normalizeSpacingAroundNamespace(content: string): string {
	const lines = content.split('\n');

	// Find the namespace line index
	const nsLineIndex = lines.findIndex(l => /^\s*namespace\s+[\w.]/.test(l));
	if (nsLineIndex <= 0) {
		// Namespace is the very first line or not found — nothing to normalize
		return content;
	}

	// Find the last using directive above the namespace
	let lastUsingIndex = -1;
	for (let i = nsLineIndex - 1; i >= 0; i--) {
		if (/^using\s+/.test(lines[i].trim())) {
			lastUsingIndex = i;
			break;
		}
		// Stop searching if we hit a non-blank, non-using line above namespace
		if (lines[i].trim() !== '') {
			break;
		}
	}

	if (lastUsingIndex === -1) {
		// No using above the namespace — leave spacing untouched
		return content;
	}

	// Remove all blank lines between lastUsingIndex and nsLineIndex
	const before = lines.slice(0, lastUsingIndex + 1);
	const after = lines.slice(nsLineIndex);

	// Reassemble with exactly one blank line between last using and namespace
	return [...before, '', ...after].join('\n');
}

/**
 * Removes ALL namespace declarations (both block-scoped and file-scoped) from the content.
 * Preserves all code that was inside the namespace blocks (dedented).
 * Returns the content with namespaces removed.
 */
function removeAllNamespaceDeclarations(content: string): string {
	// Remove file-scoped namespaces first. This also fixes files that were
	// previously adjusted incorrectly and now contain both:
	//   namespace New.Name;
	//   namespace Old.Name { ... }
	content = removeFileScopedNamespaceDeclarations(content);

	// First, try to remove any block-scoped namespaces
	const nsRegex = /^(?:\uFEFF)?([ \t]*)namespace\s+([\w.]+)[ \t]*(?:\{[ \t]*)?$/gm;
	let nsMatch: RegExpExecArray | null;
	const blocks: BlockNamespaceInfo[] = [];

	nsRegex.lastIndex = 0;
	while ((nsMatch = nsRegex.exec(content)) !== null) {
		const braces = findNamespaceBraces(content, nsMatch);
		if (braces) {
			blocks.push({
				name: nsMatch[2],
				keywordStart: nsMatch.index,
				indent: nsMatch[1],
				braceOpen: braces.braceOpen,
				braceClose: braces.braceClose,
			});
		}
	}

	// If we found block namespaces, extract and dedent their content
	if (blocks.length > 0) {
		const beforeFirst = content.slice(0, blocks[0].keywordStart).replace(/[\r\n\s]+$/, '');
		const bodySegments: string[] = [];

		for (let idx = 0; idx < blocks.length; idx++) {
			const block = blocks[idx];

			// Code between previous block's closing brace and this block's keyword
			if (idx > 0) {
				const prevClose = blocks[idx - 1].braceClose;
				const gap = content.slice(prevClose + 1, block.keywordStart).trim();
				if (gap) {
					bodySegments.push(gap);
				}
			}

			// The body of this namespace block (between braces, exclusive)
			const bodyRaw = content.slice(block.braceOpen + 1, block.braceClose);
			const bodyLines = bodyRaw.split('\n');
			const dedented = dedentLines(bodyLines);

			// Trim leading/trailing blank lines
			let start = 0;
			let end = dedented.length - 1;
			while (start <= end && dedented[start].trim() === '') { start++; }
			while (end >= start && dedented[end].trim() === '') { end--; }

			if (start <= end) {
				bodySegments.push(dedented.slice(start, end + 1).join('\n'));
			}
		}

		// Code after the last closing brace (outside all namespace blocks)
		const lastBlock = blocks[blocks.length - 1];
		const afterLast = content.slice(lastBlock.braceClose + 1).trim();
		if (afterLast) {
			bodySegments.push(afterLast);
		}

		const body = bodySegments.join('\n\n');

		if (beforeFirst) {
			return `${beforeFirst}\n\n${body}\n`;
		}
		return body;
	}

	// No namespaces found - return as is. File-scoped namespaces were already
	// removed above, so this is either namespace-free content or original content.
	return content;
}

/**
 * Removes all file-scoped namespace declarations from content.
 */
function removeFileScopedNamespaceDeclarations(content: string): string {
	const fileScopedRegex = /^(?:\uFEFF)?[ \t]*namespace\s+[\w.]+\s*;[ \t]*(?:\/\/.*)?(?:\n|$)/gm;
	return content.replace(fileScopedRegex, '');
}

/**
 * Inserts a namespace declaration at the top of the file content,
 * taking into account existing using statements.
 */
function insertNamespaceAtTop(
	content: string,
	newNamespace: string
): { adjustedContent: string; wasAdjusted: boolean; oldNamespace: string | undefined } {
	const lines = content.split('\n');
	let i = 0;

	// Skip initial blank lines (if any)
	while (i < lines.length && lines[i].trim() === '') {
		i++;
	}

	// Process using statements (with possible blank lines between them)
	let lastUsingEnd = 0; // Where the using block ends (0 means no usings found yet)
	while (i < lines.length) {
		const trimmedLine = lines[i].trim();
		if (/^using\s+/.test(trimmedLine)) {
			i++; // Move past this using line
			lastUsingEnd = i;
			// Skip blank lines after this using statement (they separate usings)
			while (i < lines.length && lines[i].trim() === '') {
				i++;
			}
		} else {
			break;
		}
	}

	if (lastUsingEnd > 0) {
		// Has using statements - insert namespace after them with one blank line separator
		const beforeUsing = lines.slice(0, lastUsingEnd).join('\n');
		const afterUsing = lines.slice(i).join('\n');
		let adjustedContent = `${beforeUsing}\n\nnamespace ${newNamespace};\n${afterUsing ? '\n' + afterUsing : ''}`;

		// Remove redundant using directive that matches the new namespace
		const removeResult = removeUsingDirective(adjustedContent, newNamespace);
		if (removeResult.wasRemoved) {
			adjustedContent = removeResult.adjustedContent;
		}

		return {
			adjustedContent,
			wasAdjusted: true,
			oldNamespace: undefined,
		};
	}

	// No using statements - insert namespace at the very top without leading blank line
	// Strip any leading blank lines from content so there's no extra whitespace
	const trimmedContent = content.replace(/^[\r\n]+/, '');
	let adjustedContent = trimmedContent ? `namespace ${newNamespace};\n\n${trimmedContent}` : `namespace ${newNamespace};\n`;

	// Remove redundant using directive that matches the new namespace
	const removeResult = removeUsingDirective(adjustedContent, newNamespace);
	if (removeResult.wasRemoved) {
		adjustedContent = removeResult.adjustedContent;
	}

	return { adjustedContent, wasAdjusted: true, oldNamespace: undefined };
}

// ============================================================================
// Block namespace detection and conversion
// ============================================================================

interface BlockNamespaceInfo {
	/** The namespace name */
	name: string;
	/** Index of the first character of the "namespace" keyword in content */
	keywordStart: number;
	/** Index of the opening brace { */
	braceOpen: number;
	/** Index of the closing brace } that ends the namespace block */
	braceClose: number;
	/** Leading whitespace/newlines before "namespace" */
	indent: string;
}

/**
 * Finds the opening brace for a namespace match and the matching closing brace.
 * Returns null if no brace found or braces are unbalanced.
 */
function findNamespaceBraces(
	content: string,
	nsMatch: RegExpExecArray
): { braceOpen: number; braceClose: number } | null {
	// The "{" may be on the same line as "namespace" or on the next line.
	// First check if the regex match itself already contains the opening brace
	// (e.g. "namespace Foo {" — brace captured on same line).
	const braceInMatch = nsMatch[0].indexOf('{');
	let braceOpen: number;
	if (braceInMatch !== -1) {
		// Brace was on the same line as the namespace keyword
		braceOpen = nsMatch.index + braceInMatch;
	} else {
		// Brace is on a subsequent line — search from the end of the matched line
		const afterMatchEnd = nsMatch.index + nsMatch[0].length;
		braceOpen = content.indexOf('{', afterMatchEnd);
		if (braceOpen === -1) {
			return null;
		}
	}

	// Find the matching closing brace by counting depth
	let depth = 1;
	let i = braceOpen + 1;
	while (i < content.length && depth > 0) {
		if (content[i] === '{') { depth++; }
		else if (content[i] === '}') { depth--; }
		i++;
	}
	if (depth !== 0) {
		return null;
	}
	return { braceOpen, braceClose: i - 1 };
}

/**
 * Detects whether the file contains any block-scoped namespace declarations.
 * Returns info about the first one found, or null if none exist.
 */
function detectBlockNamespace(content: string): BlockNamespaceInfo | null {
	// Match "namespace Foo.Bar" not followed by ";" — brace may be on same line or next line
	const nsRegex = /^(?:\uFEFF)?([ \t]*)namespace\s+([\w.]+)[ \t]*(?:\{[ \t]*)?$/m;
	const nsMatch = nsRegex.exec(content);
	if (!nsMatch) {
		return null;
	}

	const braces = findNamespaceBraces(content, nsMatch);
	if (!braces) {
		return null;
	}

	return {
		name: nsMatch[2],
		keywordStart: nsMatch.index,
		indent: nsMatch[1],
		braceOpen: braces.braceOpen,
		braceClose: braces.braceClose,
	};
}

/**
 * Removes one level of indentation from a block of lines.
 * The indent level is detected from the first non-empty line.
 */
function dedentLines(lines: string[]): string[] {
	let innerIndent = '';
	for (const line of lines) {
		if (line.trim() !== '') {
			const m = line.match(/^(\s+)/);
			innerIndent = m ? m[1] : '';
			break;
		}
	}
	if (!innerIndent) {
		return lines;
	}
	return lines.map(line =>
		line.startsWith(innerIndent) ? line.slice(innerIndent.length) : line
	);
}

/**
 * Converts all block-scoped namespaces in the file to a single file-scoped
 * namespace declaration, preserving all code.
 *
 * Rules:
 * - All namespace blocks have their braces removed and their bodies dedented.
 * - Code outside any namespace block (but below the usings) is kept as-is.
 * - A single `namespace NewName;` line replaces all namespace declarations.
 * - Also removes any file-scoped namespace declarations (namespace Name;).
 *
 * Note: This function is kept for reference but is superseded by removeAllNamespaceDeclarations().
 *
 * Before:
 *   using System;
 *
 *   namespace Old.Name
 *   {
 *       public class Foo { }
 *   }
 *
 *   internal class Bar { }
 *
 * After:
 *   using System;
 *
 *   namespace New.Name;
 *
 *   public class Foo { }
 *
 *   internal class Bar { }
 */
// Unused function - kept for reference, superseded by removeAllNamespaceDeclarations()
// @ts-ignore - Intentionally unused function kept for reference
function _convertBlockToFileScoped(
	content: string,
	_firstBlock: BlockNamespaceInfo,
	_newNamespace: string
): string {
	// Find ALL block-scoped namespace declarations in the file
	const nsRegex = /^([ \t]*)namespace\s+([\w.]+)[ \t]*(?:\{[ \t]*)?$/gm;
	const blocks: BlockNamespaceInfo[] = [];
	let nsMatch: RegExpExecArray | null;

	while ((nsMatch = nsRegex.exec(content)) !== null) {
		const braces = findNamespaceBraces(content, nsMatch);
		if (braces) {
			blocks.push({
				name: nsMatch[2],
				keywordStart: nsMatch.index,
				indent: nsMatch[1],
				braceOpen: braces.braceOpen,
				braceClose: braces.braceClose,
			});
		}
	}

	if (blocks.length === 0) {
		// No block namespaces found; just replace any file-scoped namespace if it exists
		const fileScopedRegex = /^(\s*)namespace\s+([\w.]+)\s*;\s*(?:\/\/.*)?$/m;
		if (fileScopedRegex.test(content)) {
			return content.replace(fileScopedRegex, `namespace ${_newNamespace};`);
		}
		// Fallback — should not happen if called correctly
		return content;
	}

	// Split the content into segments:
	// - "before" (usings etc.) — everything before the first namespace keyword
	// - for each namespace block: its body (dedented)
	// - "between" segments: code between consecutive namespace blocks (rare, keep as-is)
	// - "after": code after the last closing brace
	const beforeFirst = content.slice(0, blocks[0].keywordStart).replace(/[\r\n\s]+$/, '');

	const bodySegments: string[] = [];

	for (let idx = 0; idx < blocks.length; idx++) {
		const block = blocks[idx];

		// Code between previous block's closing brace and this block's keyword
		if (idx > 0) {
			const prevClose = blocks[idx - 1].braceClose;
			const gap = content.slice(prevClose + 1, block.keywordStart).trim();
			if (gap) {
				bodySegments.push(gap);
			}
		}

		// The body of this namespace block (between braces, exclusive)
		const bodyRaw = content.slice(block.braceOpen + 1, block.braceClose);
		const bodyLines = bodyRaw.split('\n');
		const dedented = dedentLines(bodyLines);

		// Trim leading/trailing blank lines
		let start = 0;
		let end = dedented.length - 1;
		while (start <= end && dedented[start].trim() === '') { start++; }
		while (end >= start && dedented[end].trim() === '') { end--; }

		if (start <= end) {
			bodySegments.push(dedented.slice(start, end + 1).join('\n'));
		}
	}

	// Code after the last closing brace (outside all namespace blocks)
	const lastBlock = blocks[blocks.length - 1];
	const afterLast = content.slice(lastBlock.braceClose + 1).trim();
	if (afterLast) {
		bodySegments.push(afterLast);
	}

	const body = bodySegments.join('\n\n');
	const namespaceLine = `${blocks[0].indent}namespace ${_newNamespace};`;

	if (beforeFirst) {
		return `${beforeFirst}\n\n${namespaceLine}\n\n${body}\n`;
	}
	return `${namespaceLine}\n\n${body}\n`;
}