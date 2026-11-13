import * as vscode from 'vscode';
import { adjustNamespaceForFile, prepareDocumentNamespaceAdjustment } from '../namespace/adjust.js';
import { applyNamespaceAdjustmentPlans } from '../namespace/refactor.js';
import { deriveNamespaceForFile } from '../namespace/compute.js';
import { preloadCsprojs, collectCsFiles } from '../utils/fileUtils.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { type NamespaceAdjustmentPlan } from '../types.js';

export async function adjustNamespaceForFolder(folderUri: vscode.Uri): Promise<number> {
	const csFiles = await collectCsFiles(folderUri);
	if (csFiles.length === 0) {
		vscode.window.showInformationMessage('No C# files found in the selected folder.');
		return 0;
	}
	try {
		const projectContext = await preloadCsprojs(folderUri);
		return await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Adjusting namespaces and references',
			cancellable: false,
		}, async progress => {
			const plans: NamespaceAdjustmentPlan[] = [];
			for (const uri of csFiles) {
				const namespace = await deriveNamespaceForFile(uri, folderUri, projectContext);
				const plan = await prepareDocumentNamespaceAdjustment(await vscode.workspace.openTextDocument(uri), namespace);
				if (plan) { plans.push(plan); }
				progress.report({ increment: 50 / csFiles.length });
			}
			const updated = await applyNamespaceAdjustmentPlans(plans);
			progress.report({ increment: 50 });
			vscode.window.showInformationMessage(plans.length
				? `Adjusted namespaces in ${plans.length} file(s). Updated references in ${updated} other file(s).`
				: `No namespace changes needed in ${csFiles.length} file(s).`);
			return plans.length;
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ErrorHandler.showError(`Namespace adjustment failed: ${message}`, message, error);
		return 0;
	}
}

export async function adjustNamespaceForSingleFile(fileUri: vscode.Uri): Promise<void> {
	const result = await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: 'Adjusting namespace and references',
		cancellable: false,
	}, () => adjustNamespaceForFile(fileUri));
	if (result.error) {
		ErrorHandler.showError(`Namespace adjustment failed: ${result.error}`, result.error);
		return;
	}
	vscode.window.showInformationMessage(result.adjusted
		? `Namespace adjusted in the file. Updated references in ${result.referencesUpdatedCount ?? 0} other file(s).`
		: 'No namespace change needed in the file.');
}
