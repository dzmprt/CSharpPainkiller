import * as vscode from 'vscode';
import { collectCsFiles } from '../utils/fileUtils.js';

/**
 * Groups for sorting using directives.
 * Order: System.* → everything else (alphabetically)
 */
function getUsingGroup(ns: string): number {
	if (ns.startsWith('System')) { return 0; }
	return 1;
}

/**
 * Sorts and deduplicates using directives in the given file content.
 * Returns the updated content, or undefined if no changes were made.
 */
export function sortUsingsInContent(content: string): string | undefined {
	// Match the contiguous block(s) of using directives at the top of the file
	// (may be separated only by blank lines or single-line comments)
	const usingLineRegex = /^(using\s+[\w.]+\s*;[ \t]*(\/\/[^\n]*)?)(\r?\n|$)/gm;

	// Collect all using lines and their positions
	const usingLines: { line: string; ns: string; start: number; end: number }[] = [];

	let match: RegExpExecArray | null;
	while ((match = usingLineRegex.exec(content)) !== null) {
		const nsMatch = match[0].match(/^using\s+([\w.]+)\s*;/);
		if (nsMatch) {
			usingLines.push({
				line: match[0].replace(/\r?\n$/, ''),
				ns: nsMatch[1],
				start: match.index,
				end: match.index + match[0].length,
			});
		}
	}

	if (usingLines.length === 0) {
		return undefined;
	}

	// Detect the region from the first using to the last using
	const regionStart = usingLines[0].start;
	const regionEnd = usingLines[usingLines.length - 1].end;
	const eol = content.includes('\r\n') ? '\r\n' : '\n';

	// Deduplicate by namespace name
	const seen = new Set<string>();
	const unique = usingLines.filter(u => {
		if (seen.has(u.ns)) { return false; }
		seen.add(u.ns);
		return true;
	});

	if (unique.length === usingLines.length) {
		// Check if already sorted
		const sortedCopy = [...unique].sort((a, b) => {
			const ga = getUsingGroup(a.ns);
			const gb = getUsingGroup(b.ns);
			if (ga !== gb) { return ga - gb; }
			return a.ns.localeCompare(b.ns);
		});
		const alreadySorted = sortedCopy.every((u, i) => u.ns === unique[i].ns);
		if (alreadySorted) {
			return undefined; // nothing to do
		}
	}

	// Sort
	unique.sort((a, b) => {
		const ga = getUsingGroup(a.ns);
		const gb = getUsingGroup(b.ns);
		if (ga !== gb) { return ga - gb; }
		return a.ns.localeCompare(b.ns);
	});

	const sortedBlock = unique.map(u => u.line).join(eol) + eol;

	return content.slice(0, regionStart) + sortedBlock + content.slice(regionEnd);
}

/**
 * Sorts and deduplicates using directives in a single .cs file.
 */
export async function sortUsingsInFile(
	fileUri: vscode.Uri
): Promise<{ changed: boolean; message: string }> {
	try {
		const raw = await vscode.workspace.fs.readFile(fileUri);
		const content = Buffer.from(raw).toString('utf-8');

		const updated = sortUsingsInContent(content);
		if (updated === undefined) {
			return { changed: false, message: 'Using directives are already sorted.' };
		}

		await vscode.workspace.fs.writeFile(fileUri, Buffer.from(updated, 'utf-8'));
		return { changed: true, message: 'Using directives sorted and deduplicated.' };
	} catch (error) {
		return { changed: false, message: `Error: ${error}` };
	}
}

/**
 * Sorts and deduplicates using directives in all .cs files under a folder.
 */
export async function sortUsingsInFolder(folderUri: vscode.Uri): Promise<void> {
	const csFiles = await collectCsFiles(folderUri);

	if (csFiles.length === 0) {
		vscode.window.showInformationMessage('No C# files found in the selected folder.');
		return;
	}

	const total = csFiles.length;

	const { changedCount } = await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: 'Sorting using directives',
		cancellable: false,
	}, async (progress) => {
		let changed = 0;
		for (let i = 0; i < csFiles.length; i++) {
			const result = await sortUsingsInFile(csFiles[i]);
			if (result.changed) { changed++; }
			progress.report({
				message: `(${i + 1} of ${total})`,
				increment: (1 / total) * 100,
			});
		}
		return { changedCount: changed };
	});

	if (changedCount > 0) {
		vscode.window.showInformationMessage(`Sorted using directives in ${changedCount} file(s).`);
	} else {
		vscode.window.showInformationMessage('All files already have sorted using directives.');
	}
}
