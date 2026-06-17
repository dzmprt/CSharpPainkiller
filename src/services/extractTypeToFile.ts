import * as vscode from 'vscode';
import * as path from 'path';
import {
	buildExtractedFileContent,
	canExtractTypeFromFile,
	findTypeDeclarationSpan,
	removeTypeFromContent,
} from './extractTypeToFileCore.js';

export {
	buildExtractedFileContent,
	canExtractTypeFromFile,
	findTypeDeclarationSpan,
	removeTypeFromContent,
	type TypeDeclarationSpan,
} from './extractTypeToFileCore.js';

export async function extractTypeToFile(document: vscode.TextDocument, typeName: string): Promise<void> {
	const content = document.getText();

	if (!canExtractTypeFromFile(content, typeName)) {
		vscode.window.showErrorMessage(
			`CSharp Painkiller: Cannot extract "${typeName}" — the file must contain multiple types and the selected type must not be partial.`
		);
		return;
	}

	const span = findTypeDeclarationSpan(content, typeName);
	if (!span) {
		vscode.window.showErrorMessage(`CSharp Painkiller: Could not locate type "${typeName}" in the file.`);
		return;
	}

	const dir = path.posix.dirname(document.uri.path);
	const newFilePath = `${dir}/${typeName}.cs`;
	const newUri = document.uri.with({ path: newFilePath });

	try {
		await vscode.workspace.fs.stat(newUri);
		vscode.window.showErrorMessage(`CSharp Painkiller: File "${typeName}.cs" already exists.`);
		return;
	} catch {
		// File does not exist — proceed.
	}

	const newFileContent = buildExtractedFileContent(content, span.text);
	const updatedContent = removeTypeFromContent(content, span);

	const edit = new vscode.WorkspaceEdit();
	edit.createFile(newUri, { overwrite: false, ignoreIfExists: false });
	edit.insert(newUri, new vscode.Position(0, 0), newFileContent);

	const fullRange = new vscode.Range(
		document.positionAt(0),
		document.positionAt(content.length)
	);
	edit.replace(document.uri, fullRange, updatedContent);

	const applied = await vscode.workspace.applyEdit(edit);
	if (!applied) {
		vscode.window.showErrorMessage(`CSharp Painkiller: Failed to extract "${typeName}" to a new file.`);
		return;
	}

	const newDoc = await vscode.workspace.openTextDocument(newUri);
	await vscode.window.showTextDocument(newDoc, { preview: false });

	vscode.window.showInformationMessage(`Extracted "${typeName}" to ${typeName}.cs.`);
}
