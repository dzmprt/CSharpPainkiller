import * as vscode from 'vscode';
import { collectCsFiles } from '../utils/fileUtils.js';
import { type TopLevelUsingDirective, collectTopLevelUsingBlock, compareUsingDirectives } from '../utils/usingBlock.js';

function getDeduplicationKey(usingDirective: TopLevelUsingDirective): string {
	return [
		usingDirective.isGlobal ? 'global' : 'local',
		usingDirective.kind,
		usingDirective.alias ?? '',
		usingDirective.namespace,
	].join(':');
}

/**
 * Sorts and deduplicates using directives in the given file content.
 * Returns the updated content, or undefined if no changes were made.
 */
export function sortUsingsInContent(content: string): string | undefined {
	const usingBlock = collectTopLevelUsingBlock(content);
	if (!usingBlock) {
		return undefined;
	}

	const seen = new Set<string>();
	const unique = usingBlock.directives.filter(u => {
		const key = getDeduplicationKey(u);
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});

	const sorted = [...unique].sort(compareUsingDirectives);

	const sortedBlock = sorted.map(u => u.fullText).join(usingBlock.eol) + usingBlock.eol;
	const originalBlock = content.slice(usingBlock.start, usingBlock.end);
	if (sortedBlock === originalBlock) {
		return undefined;
	}

	return content.slice(0, usingBlock.start) + sortedBlock + content.slice(usingBlock.end);
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
