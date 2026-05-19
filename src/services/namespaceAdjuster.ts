import * as vscode from 'vscode';
import { type NamespaceChange } from '../types.js';
import { adjustNamespaceForFileWithContext, adjustNamespaceForFile } from '../namespace/adjust.js';
import { updateUsingDirectivesForNamespaceChanges } from '../namespace/usingDirectives.js';
import { preloadCsprojs, collectCsFiles, collectAllCsFilesInWorkspace } from '../utils/fileUtils.js';

/**
 * Adjusts namespaces for all .cs files in a folder.
 * Optimized version that preloads csproj information once and reuses it for all files.
 * Also updates using directives in dependent files when namespaces change.
 */
export async function adjustNamespaceForFolder(folderUri: vscode.Uri): Promise<number> {
	const csFiles = await collectCsFiles(folderUri);
	if (csFiles.length === 0) {
		vscode.window.showInformationMessage('No C# files found in the selected folder.');
		return 0;
	}

	// Preload csproj information once for all files (key optimization)
	const projectContext = await preloadCsprojs(folderUri);

	const total = csFiles.length;
	const batchSize = 10;
	let adjustedCount = 0;
	let processedCount = 0;

	// Track namespace changes for using directive updates
	const namespaceChanges: NamespaceChange[] = [];

	const { adjusted: finalAdjustedCount } = await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: 'Adjusting namespaces',
		cancellable: false,
	}, async (progress) => {
		for (let i = 0; i < csFiles.length; i += batchSize) {
			const batch = csFiles.slice(i, i + batchSize);
			const results = await Promise.all(
				batch.map(fileUri => adjustNamespaceForFileWithContext(fileUri, folderUri, projectContext))
			);

			for (const result of results) {
				if (result.adjusted) {
					adjustedCount++;
					// Track the namespace change for using directive updates
					if (result.oldNamespace && result.newNamespace && result.types) {
						namespaceChanges.push({
							fileUri: result.uri,
							oldNamespace: result.oldNamespace,
							newNamespace: result.newNamespace,
							types: result.types,
						});
					}
				}
				processedCount++;
			}

			progress.report({
				message: `(${processedCount} of ${total})`,
				increment: (batch.length / total) * 100,
			});
		}

		return { adjusted: adjustedCount };
	});

	// Update using directives in files that reference types from namespaces that changed
	// Collect ALL .cs files in the workspace for using directive updates
	const allCsFiles = await collectAllCsFilesInWorkspace();
	const { usingUpdatedCount } = await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: 'Adding using directives',
		cancellable: false,
	}, async (progress) => {
		const results = await updateUsingDirectivesForNamespaceChanges(allCsFiles, namespaceChanges);
		const usingResultsTotal = allCsFiles.length;
		let updated = 0;

		for (let i = 0; i < results.length; i++) {
			if (results[i].updated) {
				updated++;
			}
			progress.report({
				message: `(${i + 1} of ${usingResultsTotal})`,
				increment: (1 / usingResultsTotal) * 100,
			});
		}

		return { usingUpdatedCount: updated };
	});

	// Show summary
	const summaryParts: string[] = [];
	if (finalAdjustedCount > 0) {
		summaryParts.push(`Adjusted namespaces in ${finalAdjustedCount} file(s)`);
	}
	if (usingUpdatedCount > 0) {
		summaryParts.push(`Added using directives in ${usingUpdatedCount} file(s)`);
	}

	if (finalAdjustedCount > 0 || usingUpdatedCount > 0) {
		vscode.window.showInformationMessage(summaryParts.join(', '));
	} else {
		vscode.window.showInformationMessage(`All ${total} files already have correct namespaces.`);
	}

	return finalAdjustedCount;
}

/**
 * Adjusts namespace for a single file and updates using directives.
 * This is used when the user selects a single .cs file (not a folder).
 */
export async function adjustNamespaceForSingleFile(fileUri: vscode.Uri): Promise<void> {
	const wasAdjusted = await adjustNamespaceForFile(fileUri);
	if (wasAdjusted.adjusted) {
		let usingUpdatedCount = 0;
		// Update using directives in all other files in the workspace
		if (wasAdjusted.oldNamespace && wasAdjusted.newNamespace) {
			const allCsFiles = await collectAllCsFilesInWorkspace();
			const namespaceChanges: NamespaceChange[] = [{
				fileUri: fileUri,
				oldNamespace: wasAdjusted.oldNamespace,
				newNamespace: wasAdjusted.newNamespace,
				types: wasAdjusted.types || [],
			}];

			const results = await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: 'Updating using directives',
				cancellable: false,
			}, async (progress) => {
				const updateResults = await updateUsingDirectivesForNamespaceChanges(allCsFiles, namespaceChanges);
				const total = allCsFiles.length;

				for (let i = 0; i < updateResults.length; i++) {
					progress.report({
						message: `(${i + 1} of ${total})`,
						increment: (1 / total) * 100,
					});
				}

				return updateResults;
			});

			usingUpdatedCount = results.filter(r => r.updated).length;
		}

		if (usingUpdatedCount > 0) {
			vscode.window.showInformationMessage(`Namespace adjusted in file. Updated using directives in ${usingUpdatedCount} file(s).`);
		} else {
			vscode.window.showInformationMessage('Namespace adjusted in the file.');
		}
	} else {
		vscode.window.showInformationMessage('Namespace is already correct.');
	}
}
