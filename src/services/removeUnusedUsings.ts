import * as vscode from 'vscode';
import { collectCsFiles } from '../utils/fileUtils.js';
import { collectTopLevelUsingBlock } from '../utils/usingBlock.js';

/**
 * Extracts the last segment of a namespace for simple symbol matching.
 * E.g. "System.Collections.Generic" → "Generic"
 */
function lastSegment(ns: string): string {
	const parts = ns.split('.');
	return parts[parts.length - 1];
}

/**
 * Heuristically determines which using directives are unused in the given content.
 *
 * Strategy:
 * 1. Strip string literals, comments, and the using block itself from the body.
 * 2. For each `using X.Y.Z;`, check if any of the last two segments (Z, Y) appear
 *    as a word in the remaining code body.
 *
 * This is intentionally conservative: if there is ANY match, the directive is kept.
 * It will produce false negatives (keeping some unused ones) but avoids removing
 * directives that are actually needed.
 */
export function removeUnusedUsingsFromContent(content: string): string | undefined {
	const usingBlock = collectTopLevelUsingBlock(content);
	if (!usingBlock) {
		return undefined;
	}

	let body = content.slice(usingBlock.end);

	// Strip single-line and multi-line string literals to avoid false positives
	// (e.g. "System.IO" in a string)
	body = body.replace(/"(?:[^"\\]|\\.)*"/g, '""');
	body = body.replace(/@"(?:[^"]|"")*"/g, '""');
	// Strip comments
	body = body.replace(/\/\/[^\n]*/g, '');
	body = body.replace(/\/\*[\s\S]*?\*\//g, '');

	const toRemove = new Set<number>();

	for (let i = 0; i < usingBlock.directives.length; i++) {
		const usingDirective = usingBlock.directives[i];
		if (usingDirective.isGlobal || usingDirective.kind !== 'namespace') {
			continue;
		}

		// Check full namespace usage (e.g. "System.IO.File" written explicitly)
		const fullNsEscaped = usingDirective.namespace.replace(/\./g, '\\.');
		if (new RegExp(`\\b${fullNsEscaped}\\b`).test(body)) {
			continue; // referenced explicitly, keep it
		}

		// Check segments: last segment and second-to-last segment
		const segments = usingDirective.namespace.split('.');
		const last = lastSegment(usingDirective.namespace);
		const secondLast = segments.length >= 2 ? segments[segments.length - 2] : null;

		const lastUsed = new RegExp(`\\b${last}\\b`).test(body);
		const secondLastUsed = secondLast ? new RegExp(`\\b${secondLast}\\b`).test(body) : false;

		if (!lastUsed && !secondLastUsed) {
			toRemove.add(i);
		}
	}

	if (toRemove.size === 0) {
		return undefined;
	}

	// Reconstruct content without the removed using lines
	const keptUsings = usingBlock.directives
		.filter((_, i) => !toRemove.has(i))
		.map(u => u.fullText);

	const keptBlock = keptUsings.length > 0
		? keptUsings.join(usingBlock.eol) + usingBlock.eol
		: '';

	return content.slice(0, usingBlock.start) + keptBlock + content.slice(usingBlock.end);
}

/**
 * Removes unused using directives from a single .cs file.
 */
export async function removeUnusedUsingsInFile(
	fileUri: vscode.Uri
): Promise<{ changed: boolean; removed: number; message: string }> {
	try {
		const raw = await vscode.workspace.fs.readFile(fileUri);
		const content = Buffer.from(raw).toString('utf-8');

		const updated = removeUnusedUsingsFromContent(content);
		if (updated === undefined) {
			return { changed: false, removed: 0, message: 'No unused using directives found.' };
		}

		// Count how many were removed
		const originalCount = (content.match(/^using\s+[\w.]+\s*;/gm) ?? []).length;
		const newCount = (updated.match(/^using\s+[\w.]+\s*;/gm) ?? []).length;
		const removed = originalCount - newCount;

		await vscode.workspace.fs.writeFile(fileUri, Buffer.from(updated, 'utf-8'));
		return {
			changed: true,
			removed,
			message: `Removed ${removed} unused using directive(s).`,
		};
	} catch (error) {
		return { changed: false, removed: 0, message: `Error: ${error}` };
	}
}

/**
 * Removes unused using directives from all .cs files under a folder.
 */
export async function removeUnusedUsingsInFolder(folderUri: vscode.Uri): Promise<void> {
	const csFiles = await collectCsFiles(folderUri);

	if (csFiles.length === 0) {
		vscode.window.showInformationMessage('No C# files found in the selected folder.');
		return;
	}

	const total = csFiles.length;

	const { changedCount, removedTotal } = await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: 'Removing unused using directives',
		cancellable: false,
	}, async (progress) => {
		let changed = 0;
		let removedSum = 0;
		for (let i = 0; i < csFiles.length; i++) {
			const result = await removeUnusedUsingsInFile(csFiles[i]);
			if (result.changed) {
				changed++;
				removedSum += result.removed;
			}
			progress.report({
				message: `(${i + 1} of ${total})`,
				increment: (1 / total) * 100,
			});
		}
		return { changedCount: changed, removedTotal: removedSum };
	});

	if (changedCount > 0) {
		vscode.window.showInformationMessage(
			`Removed ${removedTotal} unused using directive(s) across ${changedCount} file(s).`
		);
	} else {
		vscode.window.showInformationMessage('No unused using directives found.');
	}
}
