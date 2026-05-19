import * as vscode from 'vscode';
import { getPublicTypeName, hasPartialTypes } from '../utils/contentParser.js';
import { collectCsFiles, getFileNameFromUri } from '../utils/fileUtils.js';

/**
 * Renames a single file based on its C# type name.
 */
export async function renameFileByType(
	fileUri: vscode.Uri,
	openFile: boolean = false
): Promise<{ success: boolean; message: string }> {
	try {
		const existingContent = await vscode.workspace.fs.readFile(fileUri);
		const content = Buffer.from(existingContent).toString('utf-8');

		const currentFileName = getFileNameFromUri(fileUri);

		if (hasPartialTypes(content)) {
			return {
				success: true,
				message: `File ${currentFileName} contains partial types and was skipped.`,
			};
		}

		const typeInfo = getPublicTypeName(content);

		if (typeInfo === null) {
			return {
				success: false,
				message: `No type found in file ${currentFileName}. Cannot determine filename.`,
			};
		}

		if (typeInfo === 'ambiguous') {
			return {
				success: false,
				message: `Multiple types found in file ${currentFileName}. Cannot determine which name to use for the file.`,
			};
		}

		const ext = '.cs';

		// Check if filename already matches the type name
		if (currentFileName === `${typeInfo.name}${ext}`) {
			return {
				success: true,
				message: `File name already matches type name "${typeInfo.name}".`,
			};
		}

		// Get the parent folder
		const parentFolder = fileUri.with({ path: fileUri.path.substring(0, fileUri.path.lastIndexOf('/')) });
		const newFileName = `${typeInfo.name}${ext}`;
		const newFileUri = vscode.Uri.joinPath(parentFolder, newFileName);

		// Check if target file already exists
		try {
			await vscode.workspace.fs.stat(newFileUri);
			return {
				success: false,
				message: `File ${newFileName} already exists in the target location.`,
			};
		} catch {
			// Target file doesn't exist, proceed with rename
		}

		// Write content to new location
		await vscode.workspace.fs.writeFile(newFileUri, existingContent);

		// Delete the old file
		await vscode.workspace.fs.delete(fileUri);

		// Open the new file only if requested (single file mode)
		if (openFile) {
			const document = await vscode.workspace.openTextDocument(newFileUri);
			await vscode.window.showTextDocument(document, { preview: false });
		}

		return {
			success: true,
			message: `Renamed file from "${currentFileName}" to "${newFileName}".`,
		};
	} catch (error) {
		return {
			success: false,
			message: `Error renaming file: ${error}`,
		};
	}
}

/**
 * Renames all .cs files in a folder based on their C# type names.
 */
export async function renameFilesByTypeInFolder(folderUri: vscode.Uri): Promise<void> {
	const csFiles = await collectCsFiles(folderUri);

	if (csFiles.length === 0) {
		vscode.window.showInformationMessage('No C# files found in the selected folder.');
		return;
	}

	const total = csFiles.length;

	const { counts } = await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: 'Renaming files by type',
		cancellable: false,
	}, async (progress) => {
		let successCount = 0;
		let skippedCount = 0;
		let errorCount = 0;

		for (let i = 0; i < csFiles.length; i++) {
			const fileUri = csFiles[i];
			// In folder mode, do NOT open files after rename
			const result = await renameFileByType(fileUri, false);

			if (result.success) {
				if (result.message.includes('already matches')) {
					skippedCount++;
				} else {
					successCount++;
				}
			} else {
				errorCount++;
			}

			progress.report({
				message: `(${i + 1} of ${total})`,
				increment: (1 / total) * 100,
			});
		}

		return { counts: { successCount, skippedCount, errorCount } };
	});

	// Show summary after progress completes
	const summaryParts = [];
	if (counts.successCount > 0) {
		summaryParts.push(`Renamed ${counts.successCount} file(s)`);
	}
	if (counts.skippedCount > 0) {
		summaryParts.push(`Skipped ${counts.skippedCount} file(s) with matching names`);
	}
	if (counts.errorCount > 0) {
		summaryParts.push(`Failed for ${counts.errorCount} file(s)`);
	}

	if (summaryParts.length > 0) {
		vscode.window.showInformationMessage(summaryParts.join(', '));
	} else {
		vscode.window.showInformationMessage('No files were processed.');
	}
}