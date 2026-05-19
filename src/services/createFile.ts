import * as vscode from 'vscode';
import { type CType } from '../types.js';
import { getTemplate } from '../templates.js';
import { deriveNamespaceFromFolder } from '../namespace/compute.js';

/**
 * Resolves the target folder for file creation.
 * Priority: provided folder URI -> active editor's workspace folder -> user input.
 */
async function resolveTargetFolder(folderUri?: vscode.Uri): Promise<vscode.Uri | undefined> {
	if (folderUri?.scheme === 'file') {
		return folderUri;
	}

	const editor = vscode.window.activeTextEditor;
	if (editor?.document.uri) {
		const wsFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
		if (wsFolder) {
			return wsFolder.uri;
		}
	}

	const selected = await vscode.window.showInputBox({
		placeHolder: 'Enter folder path (e.g., /path/to/project)',
		title: 'Select Target Folder',
	});

	return selected ? vscode.Uri.file(selected) : undefined;
}

/**
 * Prompts the user for a C# type name.
 */
async function promptTypeName(type: CType): Promise<string | undefined> {
	const placeholder = type === 'interface' ? 'MyInterface' : 'MyClass';
	const typeName = await vscode.window.showInputBox({
		placeHolder: placeholder,
		title: `Enter ${type} name`,
		prompt: `Enter the name for the new ${type}`,
	});

	// undefined means the user cancelled (Esc) — exit silently
	if (typeName === undefined) {
		return undefined;
	}

	// Empty string means the user confirmed without typing — exit silently
	if (!typeName.trim()) {
		return undefined;
	}

	const trimmed = typeName.trim();
	return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Creates a new C# file of the specified type in the given folder.
 * If no folder is provided, the user will be prompted to select one.
 */
export async function createCSharpFile(type: CType, folderUri?: vscode.Uri): Promise<void> {
	const targetFolder = await resolveTargetFolder(folderUri);
	if (!targetFolder) {
		return;
	}

	const sanitizedName = await promptTypeName(type);
	if (!sanitizedName) {
		return;
	}

	const namespaceName = await deriveNamespaceFromFolder(targetFolder);
	const content = getTemplate(type, sanitizedName, namespaceName);

	const fileName = `${sanitizedName}.cs`;
	const fileUri = vscode.Uri.joinPath(targetFolder, fileName);

	// Check if file already exists
	try {
		await vscode.workspace.fs.stat(fileUri);
		vscode.window.showErrorMessage(`File ${fileName} already exists.`);
		return;
	} catch {
		// File doesn't exist, proceed
	}

	const encoded = new TextEncoder().encode(content);
	await vscode.workspace.fs.writeFile(fileUri, encoded);

	const document = await vscode.workspace.openTextDocument(fileUri);
	await vscode.window.showTextDocument(document, { preview: false });
}