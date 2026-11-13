import * as vscode from 'vscode';
import * as path from 'path';
import { getFileBaseNameFromUri } from '../utils/fileUtils.js';
import { csharpLanguageService } from './csharpLanguageService.js';
import {
	buildExtractedFileContent,
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

	const types = (await csharpLanguageService.getTypes(document)).filter(type => !type.nested);
	const selected = types.filter(type => type.name === typeName);
	const type = selected.length === 1 ? selected[0] : undefined;
	if (!type || types.length <= 1 || type.partial || typeName === getFileBaseNameFromUri(document.uri)) {
		vscode.window.showErrorMessage(
			`CSharp Painkiller: Cannot extract "${typeName}" — the file must contain multiple types, the file name must not match the type name, and the selected type must not be partial.`
		);
		return;
	}

	let start = document.offsetAt(type.symbol.range.start);
	let line = type.symbol.range.start.line;
	while (line > 0 && document.lineAt(line - 1).text.trim().startsWith('///')) {
		start = document.offsetAt(document.lineAt(--line).range.start);
	}
	const span = { start, end: document.offsetAt(type.symbol.range.end), text: content.slice(start, document.offsetAt(type.symbol.range.end)) };

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

	const fileContext = await csharpLanguageService.getTypeFileContext(document, type);
	const newFileContent = buildExtractedFileContent(content, span.text, type.namespace, fileContext);
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
