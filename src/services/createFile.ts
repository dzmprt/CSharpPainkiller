import * as vscode from 'vscode';
import { type CType } from '../types.js';
import { getTemplate } from '../templates.js';
import { deriveNamespaceFromFolder } from '../namespace/compute.js';
import { resolveTargetFolder, writeAndOpen, capitalize } from '../utils/sharedUtilities.js';

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

	if (typeName === undefined || !typeName.trim()) {
		return undefined;
	}

	const trimmed = typeName.trim();
	return capitalize(trimmed.charAt(0).toUpperCase() + trimmed.slice(1));
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

	await writeAndOpen(targetFolder, `${sanitizedName}.cs`, content);
}