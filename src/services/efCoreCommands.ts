import * as vscode from 'vscode';
import { deriveNamespaceFromFolder } from '../namespace/compute.js';
import { findTypeInWorkspace } from '../utils/typeSearch.js';
import { getParentFolder } from '../utils/fileUtils.js';
import { extractTypesFromContent } from '../utils/contentParser.js';
import {
	parsePublicProperties,
	generateEfCoreEntityTypeConfiguration,
} from './templates/efcore.js';

// ============================================================================
// Shared helpers
// ============================================================================

async function resolveTargetFolder(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
	if (uri?.scheme === 'file') {
		return uri;
	}
	const editor = vscode.window.activeTextEditor;
	if (editor) {
		const wsFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
		if (wsFolder) {
			return wsFolder.uri;
		}
	}
	return undefined;
}

async function writeAndOpen(
	folderUri: vscode.Uri,
	fileName: string,
	content: string
): Promise<boolean> {
	const fileUri = vscode.Uri.joinPath(folderUri, fileName);
	try {
		await vscode.workspace.fs.stat(fileUri);
		vscode.window.showErrorMessage(`File '${fileName}' already exists.`);
		return false;
	} catch {
		// File doesn't exist — proceed
	}
	const encoded = new TextEncoder().encode(content);
	await vscode.workspace.fs.writeFile(fileUri, encoded);
	const doc = await vscode.workspace.openTextDocument(fileUri);
	await vscode.window.showTextDocument(doc, { preview: false });
	return true;
}

async function readProperties(fileUri: vscode.Uri): Promise<ReturnType<typeof parsePublicProperties>> {
	try {
		const buf = await vscode.workspace.fs.readFile(fileUri);
		return parsePublicProperties(Buffer.from(buf).toString('utf-8'));
	} catch {
		return [];
	}
}

// ============================================================================
// EF Core commands
// ============================================================================

/**
 * Triggered from a **folder** in the Explorer.
 * Prompts the user for an entity class name, searches the workspace for it,
 * then generates `<EntityName>Configuration.cs` in the selected folder.
 */
export async function createEfCoreConfigurationFromFolder(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) {
		vscode.window.showErrorMessage('No target folder selected.');
		return;
	}

	const input = await vscode.window.showInputBox({
		title: 'Entity Class Name',
		placeHolder: 'Author',
	});
	if (!input?.trim()) { return; }

	const entityName = capitalize(input.trim());

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Searching for class '${entityName}'…` },
		async () => {
			const found = await findTypeInWorkspace(entityName);
			if (!found) {
				vscode.window.showErrorMessage(
					`Class '${entityName}' not found in the workspace. The configuration was not created.`
				);
				return;
			}

			const properties = await readProperties(found.fileUri);
			const namespace = await deriveNamespaceFromFolder(folder);
			const content = generateEfCoreEntityTypeConfiguration(found, properties, namespace);
			await writeAndOpen(folder, `${entityName}Configuration.cs`, content);
		}
	);
}

/**
 * Triggered by right-clicking a **.cs file** in the Explorer (or using the
 * active editor). Reads the entity class directly from that file — no prompt
 * needed for the class name.
 *
 * The generated configuration file is written into the **same folder** as the
 * selected entity file.
 */
export async function createEfCoreConfigurationFromFile(fileUri?: vscode.Uri): Promise<void> {
	// Resolve the .cs file URI
	let uri = fileUri;
	if (!uri) {
		const editor = vscode.window.activeTextEditor;
		if (!editor || !editor.document.uri.path.endsWith('.cs')) {
			vscode.window.showErrorMessage('Open or select a .cs file first.');
			return;
		}
		uri = editor.document.uri;
	}

	if (!uri.path.endsWith('.cs')) {
		vscode.window.showErrorMessage('This command only works on .cs files.');
		return;
	}

	let fileContent: string;
	try {
		const buf = await vscode.workspace.fs.readFile(uri);
		fileContent = Buffer.from(buf).toString('utf-8');
	} catch {
		vscode.window.showErrorMessage('Could not read the file.');
		return;
	}

	// Extract the primary public class name from the file
	const extraction = extractTypesFromContent(fileContent);
	const publicClass = extraction.types.find(t => t.type === 'class');
	if (!publicClass) {
		vscode.window.showErrorMessage('No class found in this file.');
		return;
	}

	const entityName = publicClass.name;
	const entityNamespace = publicClass.namespace ?? extraction.oldNamespace ?? '';

	const properties = parsePublicProperties(fileContent);
	const folder = getParentFolder(uri);
	const namespace = await deriveNamespaceFromFolder(folder);

	const found = { name: entityName, namespace: entityNamespace, fileUri: uri };
	const content = generateEfCoreEntityTypeConfiguration(found, properties, namespace);
	await writeAndOpen(folder, `${entityName}Configuration.cs`, content);
}

// ============================================================================
// Helpers
// ============================================================================

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}
