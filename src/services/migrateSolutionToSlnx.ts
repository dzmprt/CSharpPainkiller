import { execFile } from 'child_process';
import * as pathModule from 'path';
import * as vscode from 'vscode';

function runDotnetSolutionMigration(solutionPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile(
			'dotnet',
			['sln', solutionPath, 'migrate'],
			{ cwd: pathModule.dirname(solutionPath), windowsHide: true },
			(error, _stdout, stderr) => {
				if (error) {
					const details = stderr.trim();
					reject(new Error(details || error.message));
					return;
				}
				resolve();
			},
		);
	});
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

/** Migrates the selected legacy .sln file to a sibling .slnx file. */
export async function migrateSolutionToSlnx(uri?: vscode.Uri): Promise<void> {
	if (!uri || !uri.fsPath.toLowerCase().endsWith('.sln')) {
		vscode.window.showErrorMessage('CSharp Painkiller: Select a .sln file.');
		return;
	}

	const slnxUri = vscode.Uri.file(`${uri.fsPath.slice(0, -'.sln'.length)}.slnx`);
	if (await fileExists(slnxUri)) {
		vscode.window.showErrorMessage(`CSharp Painkiller: ${pathModule.basename(slnxUri.fsPath)} already exists.`);
		return;
	}

	const confirmation = await vscode.window.showInformationMessage(
		`Migrate ${pathModule.basename(uri.fsPath)} to ${pathModule.basename(slnxUri.fsPath)}?`,
		{ modal: true },
		'Migrate',
	);
	if (confirmation !== 'Migrate') {
		return;
	}

	const openDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
	if (openDocument?.isDirty && !(await openDocument.save())) {
		vscode.window.showErrorMessage('CSharp Painkiller: Could not save the .sln file before migration.');
		return;
	}

	try {
		await runDotnetSolutionMigration(uri.fsPath);
		const deleteConfirmation = await vscode.window.showWarningMessage(
			`Delete the old ${pathModule.basename(uri.fsPath)} file?`,
			{ modal: true },
			'Delete',
			'Keep',
		);
		if (deleteConfirmation === 'Delete') {
			await vscode.workspace.fs.delete(uri);
			vscode.window.showInformationMessage(`CSharp Painkiller: Migrated to ${pathModule.basename(slnxUri.fsPath)} and deleted the old .sln file.`);
		} else {
			vscode.window.showInformationMessage(`CSharp Painkiller: Migrated to ${pathModule.basename(slnxUri.fsPath)}. The old .sln file was kept.`);
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`CSharp Painkiller: Migration completed partially. The old .sln file may still exist. ${message}`);
	}
}
