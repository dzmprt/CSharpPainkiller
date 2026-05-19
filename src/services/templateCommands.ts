import * as vscode from 'vscode';
import { deriveNamespaceFromFolder } from '../namespace/compute.js';
import { findTypeInWorkspace, findHandlerForMediator } from '../utils/typeSearch.js';
import { detectMediatorFile } from '../utils/contentParser.js';
import { getParentFolder } from '../utils/fileUtils.js';
import {
	normalizeControllerName,
	generateEmptyController,
	generateEfCrudController,
	generateEmptyMinimalApi,
	generateEfCrudMinimalApi,
} from './templates/aspnet.js';
import {
	parseReturnType,
	generateMediatRRequest,
	generateMediatRHandler,
	generateMediatRNotification,
	generateMediatRNotificationHandler,
	generateMediatREmptyPipelineBehavior,
	generateMediatRFluentValidationBehavior,
	generateMitMediatorRequest,
	generateMitMediatorHandler,
	generateMitMediatorNotification,
	generateMitMediatorNotificationHandler,
	generateMitMediatorEmptyPipelineBehavior,
	generateMitMediatorFluentValidationBehavior,
	extractIRequestReturnType,
} from './templates/cqrs.js';

// ============================================================================
// Shared utilities
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

/**
 * Prompts the user for a string. Returns undefined if cancelled or empty.
 * Unlike the strict version, also accepts empty string as "no value" signal
 * for optional inputs when `allowEmpty` is true.
 */
async function prompt(title: string, placeholder: string): Promise<string | undefined> {
	const value = await vscode.window.showInputBox({ title, placeHolder: placeholder });
	if (value === undefined || !value.trim()) {
		return undefined;
	}
	return value.trim();
}

/**
 * Like prompt, but pressing Enter on an empty input returns '' (empty string)
 * instead of undefined. Pressing Escape still returns undefined.
 */
async function promptOptional(title: string, placeholder: string): Promise<string | undefined> {
	const value = await vscode.window.showInputBox({
		title,
		placeHolder: placeholder,
		prompt: 'Leave empty for void (no return value)',
	});
	// undefined = Escape pressed
	if (value === undefined) {
		return undefined;
	}
	return value.trim();
}

/**
 * Reads the given .cs file, detects the mediator class name, then searches
 * the workspace for a handler by matching IRequestHandler<ClassName, ...> or
 * INotificationHandler<ClassName> in file contents.
 */
export async function goToHandlerForFile(fileUri?: vscode.Uri): Promise<void> {
	let uri = fileUri;
	if (!uri) {
		const editor = vscode.window.activeTextEditor;
		if (!editor || !editor.document.uri.path.endsWith('.cs')) {
			vscode.window.showErrorMessage('Open or select a .cs file first.');
			return;
		}
		uri = editor.document.uri;
	}

	let content: string;
	try {
		const buf = await vscode.workspace.fs.readFile(uri);
		content = Buffer.from(buf).toString('utf-8');
	} catch {
		vscode.window.showErrorMessage('Could not read the file.');
		return;
	}

	const info = detectMediatorFile(content);
	if (!info) {
		vscode.window.showErrorMessage(
			'This file does not contain a recognisable IRequest or INotification class.'
		);
		return;
	}

	let found: Awaited<ReturnType<typeof findHandlerForMediator>>;
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Searching for handler of '${info.className}'…` },
		async () => { found = await findHandlerForMediator(info.className, info.kind); }
	);

	if (!found!) {
		vscode.window.showInformationMessage(
			`No handler found for '${info.className}' in the workspace.`
		);
		return;
	}

	const doc = await vscode.workspace.openTextDocument(found.fileUri);
	await vscode.window.showTextDocument(doc, { preview: false });
}

// ============================================================================
// "Generate Handler" context menu command (right-click on .cs file)
// ============================================================================

/**
 * Reads the given .cs file, detects whether it contains an IRequest or
 * INotification class (MediatR or MitMediator), then generates the
 * corresponding Handler file in the same folder — without any prompts.
 */
export async function generateHandlerForFile(fileUri?: vscode.Uri): Promise<void> {
	// Resolve the file URI — may come from Explorer context menu or active editor
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

	let content: string;
	try {
		const buf = await vscode.workspace.fs.readFile(uri);
		content = Buffer.from(buf).toString('utf-8');
	} catch {
		vscode.window.showErrorMessage('Could not read the file.');
		return;
	}

	const info = detectMediatorFile(content);
	if (!info) {
		vscode.window.showErrorMessage(
			'This file does not contain a recognisable IRequest or INotification class.'
		);
		return;
	}

	const folder = getParentFolder(uri);
	const handlerName = `${info.className}Handler`;
	const namespace = await deriveNamespaceFromFolder(folder);

	// For request handlers we need the return type's namespace (if any)
	let returnedType: import('../utils/typeSearch.js').FoundType | undefined;
	if (info.kind === 'request' && info.returnType) {
		const { innerTypeName } = parseReturnType(info.returnType);
		if (innerTypeName && !isBuiltinType(innerTypeName) && innerTypeName !== 'Unit') {
			returnedType = await findTypeInWorkspace(innerTypeName) ?? undefined;
		}
	}

	const requestFoundType: import('../utils/typeSearch.js').FoundType = {
		name: info.className,
		namespace,
		fileUri: uri,
	};

	let handlerContent: string;

	if (info.library === 'MediatR') {
		if (info.kind === 'request') {
			const rt = info.returnType ?? 'Unit';
			handlerContent = generateMediatRHandler(handlerName, requestFoundType, rt, namespace, returnedType);
		} else {
			handlerContent = generateMediatRNotificationHandler(handlerName, requestFoundType, namespace);
		}
	} else {
		if (info.kind === 'request') {
			handlerContent = generateMitMediatorHandler(handlerName, requestFoundType, info.returnType, namespace, returnedType);
		} else {
			handlerContent = generateMitMediatorNotificationHandler(handlerName, requestFoundType, namespace);
		}
	}

	await writeAndOpen(folder, `${handlerName}.cs`, handlerContent);
}

// ============================================================================
// ASP.NET commands
// ============================================================================

export async function createEmptyController(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) {
		vscode.window.showErrorMessage('No target folder selected.');
		return;
	}
	const input = await prompt('Empty Controller', 'AuthorsController');
	if (!input) { return; }
	const baseName = normalizeControllerName(capitalize(input));
	const namespace = await deriveNamespaceFromFolder(folder);
	await writeAndOpen(folder, `${baseName}Controller.cs`, generateEmptyController(baseName, namespace));
}

export async function createEfCrudController(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) {
		vscode.window.showErrorMessage('No target folder selected.');
		return;
	}
	const entityInput = await prompt('Entity Class Name', 'Author');
	if (!entityInput) { return; }
	const entityName = capitalize(entityInput);
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Searching for class '${entityName}'…` },
		async () => {
			const found = await findTypeInWorkspace(entityName);
			if (!found) {
				vscode.window.showErrorMessage(`Class '${entityName}' not found in the workspace. The controller was not created.`);
				return;
			}
			const namespace = await deriveNamespaceFromFolder(folder);
			await writeAndOpen(folder, `${entityName}Controller.cs`, generateEfCrudController(entityName, found, namespace));
		}
	);
}

export async function createEmptyMinimalApi(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) {
		vscode.window.showErrorMessage('No target folder selected.');
		return;
	}
	const input = await prompt('Minimal API Resource Name', 'Authors');
	if (!input) { return; }
	const baseName = capitalize(input);
	const namespace = await deriveNamespaceFromFolder(folder);
	await writeAndOpen(folder, `${baseName}Api.cs`, generateEmptyMinimalApi(baseName, namespace));
}

export async function createEfCrudMinimalApi(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) {
		vscode.window.showErrorMessage('No target folder selected.');
		return;
	}
	const entityInput = await prompt('Entity Class Name', 'Author');
	if (!entityInput) { return; }
	const entityName = capitalize(entityInput);
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Searching for class '${entityName}'…` },
		async () => {
			const found = await findTypeInWorkspace(entityName);
			if (!found) {
				vscode.window.showErrorMessage(`Class '${entityName}' not found in the workspace. The Minimal API was not created.`);
				return;
			}
			const namespace = await deriveNamespaceFromFolder(folder);
			await writeAndOpen(folder, `${entityName}Api.cs`, generateEfCrudMinimalApi(entityName, found, namespace));
		}
	);
}

// ============================================================================
// Shared CQRS / mediator logic
// ============================================================================

/**
 * Resolves the return type info from user input:
 *  - Empty input → void (returnType=null, returnedType=null)
 *  - Primitive   → returnType set, returnedType=null (no workspace lookup)
 *  - Custom type → workspace search; if not found, use placeholder (no using)
 *
 * Returns null for the whole result only if Escape was pressed (undefined from promptOptional).
 */
async function resolveReturnType(returnTypeInput: string): Promise<{
	returnType: string | null;
	innerTypeName: string | null;
	returnedType: import('../utils/typeSearch.js').FoundType | null;
} | null> {
	// Empty → void
	if (!returnTypeInput) {
		return { returnType: null, innerTypeName: null, returnedType: null };
	}

	const { innerTypeName, returnType } = parseReturnType(returnTypeInput);

	if (isBuiltinType(innerTypeName)) {
		return { returnType, innerTypeName, returnedType: null };
	}

	let foundType: Awaited<ReturnType<typeof findTypeInWorkspace>> = undefined;
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Searching for type '${innerTypeName}'…` },
		async () => { foundType = await findTypeInWorkspace(innerTypeName); }
	);
	// Not found → use as-is, no using added
	return {
		returnType,
		innerTypeName,
		returnedType: foundType ?? null,
	};
}

/**
 * Builds the final request class name from user input and the entity name.
 *
 * @param input      - What the user actually typed (e.g. "Get", "Update", "GetApplicationUser")
 * @param entityName - Inner type name from the return type (e.g. "ApplicationUser"), or null for void
 *
 * Rules:
 *  - If `input` is a single known prefix verb ("Get", "Update", …) AND entityName is known,
 *    insert entityName between the prefix and the suffix:
 *    "Get"  + "ApplicationUser" → "GetApplicationUserQuery"
 *    "Update" + "ApplicationUser" → "UpdateApplicationUserCommand"
 *  - Otherwise just append the appropriate suffix to whatever was typed:
 *    "GetApplicationUser" → "GetApplicationUserQuery"
 *    "GetApplicationUserQuery" → "GetApplicationUserQuery" (already has suffix)
 */
function finalizeRequestName(input: string, entityName: string | null): string {
	const trimmed = capitalize(input.trim());
	const lc = trimmed.toLowerCase();
	const isKnownPrefix = QUERY_PREFIXES.has(lc) || COMMAND_PREFIXES.has(lc);

	if (isKnownPrefix && entityName) {
		return normalizeRequestName(trimmed + capitalize(entityName));
	}

	return normalizeRequestName(trimmed);
}

// ============================================================================
// MediatR commands
// ============================================================================

export async function createMediatRRequestAndHandler(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) {
		vscode.window.showErrorMessage('No target folder selected.');
		return;
	}

	const returnTypeInput = await promptOptional('Return Type (leave empty for void)', 'Author  or  List<Author>  or  Author[]');
	if (returnTypeInput === undefined) { return; }

	const resolved = await resolveReturnType(returnTypeInput);
	if (resolved === null) { return; }
	const { returnType, innerTypeName, returnedType } = resolved;

	const defaultName = finalizeRequestName('Get', innerTypeName);
	const requestNameInput = await prompt('Request Class Name', defaultName);
	if (!requestNameInput) { return; }
	const requestName = finalizeRequestName(requestNameInput, innerTypeName);

	const folderName = requestName.replace(/(Request|Query|Command)$/i, '') || requestName;
	const subfolderUri = vscode.Uri.joinPath(folder, folderName);
	await vscode.workspace.fs.createDirectory(subfolderUri);
	const namespace = await deriveNamespaceFromFolder(subfolderUri);

	const effectiveReturnedType = returnedType ?? (innerTypeName ? { name: innerTypeName, namespace: '', fileUri: vscode.Uri.file('') } : null);
	const requestContent = generateMediatRRequest(requestName, returnType, effectiveReturnedType, namespace);
	await writeAndOpen(subfolderUri, `${requestName}.cs`, requestContent);

	const handlerName = `${requestName}Handler`;
	const requestFoundType = { name: requestName, namespace, fileUri: vscode.Uri.joinPath(subfolderUri, `${requestName}.cs`) };
	const rt = returnType ?? 'Unit';
	const handlerContent = generateMediatRHandler(handlerName, requestFoundType, rt, namespace, returnedType ?? undefined);
	await writeAndOpen(subfolderUri, `${handlerName}.cs`, handlerContent);
}

export async function createMediatRRequest(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) {
		vscode.window.showErrorMessage('No target folder selected.');
		return;
	}

	const returnTypeInput = await promptOptional('Return Type (leave empty for void)', 'Author  or  List<Author>  or  Author[]');
	if (returnTypeInput === undefined) { return; }

	const resolved = await resolveReturnType(returnTypeInput);
	if (resolved === null) { return; }
	const { returnType, innerTypeName, returnedType } = resolved;

	const defaultName = finalizeRequestName('Get', innerTypeName);
	const requestNameInput = await prompt('Request Class Name', defaultName);
	if (!requestNameInput) { return; }
	const requestName = finalizeRequestName(requestNameInput, innerTypeName);
	const namespace = await deriveNamespaceFromFolder(folder);
	const effectiveReturnedType = returnedType ?? (innerTypeName ? { name: innerTypeName, namespace: '', fileUri: vscode.Uri.file('') } : null);
	const content = generateMediatRRequest(requestName, returnType, effectiveReturnedType, namespace);
	await writeAndOpen(folder, `${requestName}.cs`, content);
}

export async function createMediatRHandler(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) {
		vscode.window.showErrorMessage('No target folder selected.');
		return;
	}

	const requestInput = await prompt('IRequest Type to Handle', 'GetAuthorsQuery');
	if (!requestInput) { return; }
	const requestName = capitalize(requestInput);

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Searching for type '${requestName}'…` },
		async () => {
			const found = await findTypeInWorkspace(requestName);
			if (!found) {
				vscode.window.showErrorMessage(`Type '${requestName}' not found in the workspace. The Handler was not created.`);
				return;
			}

			let returnType: string | null = null;
			try {
				const buf = await vscode.workspace.fs.readFile(found.fileUri);
				returnType = extractIRequestReturnType(Buffer.from(buf).toString('utf-8')) ?? null;
			} catch { /* ignore */ }

			// returnType=null means void IRequest (no generic)
			const rt = returnType ?? 'Unit';
			const { innerTypeName } = returnType ? parseReturnType(returnType) : { innerTypeName: '' };
			const returnedType = innerTypeName && !isBuiltinType(innerTypeName) && innerTypeName !== 'Unit'
				? await findTypeInWorkspace(innerTypeName)
				: undefined;

			const handlerName = `${requestName}Handler`;
			const namespace = await deriveNamespaceFromFolder(folder);
			const content = generateMediatRHandler(handlerName, found, rt, namespace, returnedType ?? undefined);
			await writeAndOpen(folder, `${handlerName}.cs`, content);
		}
	);
}

// ============================================================================
// MitMediator commands
// ============================================================================

export async function createMitMediatorRequestAndHandler(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) {
		vscode.window.showErrorMessage('No target folder selected.');
		return;
	}

	const returnTypeInput = await promptOptional('Return Type (leave empty for void)', 'Author  or  List<Author>  or  Author[]');
	if (returnTypeInput === undefined) { return; }

	const resolved = await resolveReturnType(returnTypeInput);
	if (resolved === null) { return; }
	const { returnType, innerTypeName, returnedType } = resolved;

	const defaultName = finalizeRequestName('Get', innerTypeName);
	const requestNameInput = await prompt('Request Class Name', defaultName);
	if (!requestNameInput) { return; }
	const requestName = finalizeRequestName(requestNameInput, innerTypeName);

	const folderName = requestName.replace(/(Request|Query|Command)$/i, '') || requestName;
	const subfolderUri = vscode.Uri.joinPath(folder, folderName);
	await vscode.workspace.fs.createDirectory(subfolderUri);
	const namespace = await deriveNamespaceFromFolder(subfolderUri);

	const effectiveReturnedType = returnedType ?? (innerTypeName ? { name: innerTypeName, namespace: '', fileUri: vscode.Uri.file('') } : null);
	const requestContent = generateMitMediatorRequest(requestName, returnType, effectiveReturnedType, namespace);
	await writeAndOpen(subfolderUri, `${requestName}.cs`, requestContent);

	const handlerName = `${requestName}Handler`;
	const requestFoundType = { name: requestName, namespace, fileUri: vscode.Uri.joinPath(subfolderUri, `${requestName}.cs`) };
	const handlerContent = generateMitMediatorHandler(handlerName, requestFoundType, returnType, namespace, returnedType ?? undefined);
	await writeAndOpen(subfolderUri, `${handlerName}.cs`, handlerContent);
}

export async function createMitMediatorRequest(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) {
		vscode.window.showErrorMessage('No target folder selected.');
		return;
	}

	const returnTypeInput = await promptOptional('Return Type (leave empty for void)', 'Author  or  List<Author>  or  Author[]');
	if (returnTypeInput === undefined) { return; }

	const resolved = await resolveReturnType(returnTypeInput);
	if (resolved === null) { return; }
	const { returnType, innerTypeName, returnedType } = resolved;

	const defaultName = finalizeRequestName('Get', innerTypeName);
	const requestNameInput = await prompt('Request Class Name', defaultName);
	if (!requestNameInput) { return; }
	const requestName = finalizeRequestName(requestNameInput, innerTypeName);
	const namespace = await deriveNamespaceFromFolder(folder);
	const effectiveReturnedType = returnedType ?? (innerTypeName ? { name: innerTypeName, namespace: '', fileUri: vscode.Uri.file('') } : null);
	const content = generateMitMediatorRequest(requestName, returnType, effectiveReturnedType, namespace);
	await writeAndOpen(folder, `${requestName}.cs`, content);
}

export async function createMitMediatorHandler(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) {
		vscode.window.showErrorMessage('No target folder selected.');
		return;
	}

	const requestInput = await prompt('IRequest Type to Handle', 'GetAuthorsQuery');
	if (!requestInput) { return; }
	const requestName = capitalize(requestInput);

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Searching for type '${requestName}'…` },
		async () => {
			const found = await findTypeInWorkspace(requestName);
			if (!found) {
				vscode.window.showErrorMessage(`Type '${requestName}' not found in the workspace. The Handler was not created.`);
				return;
			}

			let returnType: string | null = null;
			try {
				const buf = await vscode.workspace.fs.readFile(found.fileUri);
				returnType = extractIRequestReturnType(Buffer.from(buf).toString('utf-8')) ?? null;
			} catch { /* ignore */ }

			// returnType=null means void IRequest
			const { innerTypeName } = returnType ? parseReturnType(returnType) : { innerTypeName: '' };
			const returnedType = innerTypeName && !isBuiltinType(innerTypeName)
				? await findTypeInWorkspace(innerTypeName)
				: undefined;

			const handlerName = `${requestName}Handler`;
			const namespace = await deriveNamespaceFromFolder(folder);
			const content = generateMitMediatorHandler(handlerName, found, returnType, namespace, returnedType ?? undefined);
			await writeAndOpen(folder, `${handlerName}.cs`, content);
		}
	);
}

// ============================================================================
// MediatR Notification commands
// ============================================================================

/** Creates a MediatR INotification class. */
export async function createMediatRNotification(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) { vscode.window.showErrorMessage('No target folder selected.'); return; }

	const input = await prompt('Notification Class Name', 'UserRegisteredNotification');
	if (!input) { return; }

	const name = capitalize(input);
	const namespace = await deriveNamespaceFromFolder(folder);
	await writeAndOpen(folder, `${name}.cs`, generateMediatRNotification(name, namespace));
}

/** Creates a MediatR INotificationHandler class (auto-name = NotificationName + Handler). */
export async function createMediatRNotificationHandler(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) { vscode.window.showErrorMessage('No target folder selected.'); return; }

	const input = await prompt('INotification Type to Handle', 'UserRegisteredNotification');
	if (!input) { return; }

	const notificationName = capitalize(input);
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Searching for '${notificationName}'…` },
		async () => {
			const found = await findTypeInWorkspace(notificationName);
			if (!found) {
				vscode.window.showErrorMessage(`Type '${notificationName}' not found. The handler was not created.`);
				return;
			}
			const handlerName = `${notificationName}Handler`;
			const namespace = await deriveNamespaceFromFolder(folder);
			await writeAndOpen(folder, `${handlerName}.cs`, generateMediatRNotificationHandler(handlerName, found, namespace));
		}
	);
}

/**
 * Creates a MediatR INotification + INotificationHandler pair inside a new subfolder.
 * Folder name = notification name without trailing "Notification" suffix.
 */
export async function createMediatRNotificationAndHandler(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) { vscode.window.showErrorMessage('No target folder selected.'); return; }

	const input = await prompt('Notification Class Name', 'UserRegisteredNotification');
	if (!input) { return; }

	const name = capitalize(input.replace(/Notification$/i, '')) + 'Notification';
	const folderName = name.replace(/Notification$/i, '') || name;

	const subfolderUri = vscode.Uri.joinPath(folder, folderName);
	await vscode.workspace.fs.createDirectory(subfolderUri);
	const namespace = await deriveNamespaceFromFolder(subfolderUri);

	await writeAndOpen(subfolderUri, `${name}.cs`, generateMediatRNotification(name, namespace));

	const handlerName = `${name}Handler`;
	const notifFoundType = { name, namespace, fileUri: vscode.Uri.joinPath(subfolderUri, `${name}.cs`) };
	await writeAndOpen(subfolderUri, `${handlerName}.cs`, generateMediatRNotificationHandler(handlerName, notifFoundType, namespace));
}

// ============================================================================
// MitMediator Notification commands
// ============================================================================

/** Creates a MitMediator INotification class. */
export async function createMitMediatorNotification(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) { vscode.window.showErrorMessage('No target folder selected.'); return; }

	const input = await prompt('Notification Class Name', 'UserRegisteredNotification');
	if (!input) { return; }

	const name = capitalize(input);
	const namespace = await deriveNamespaceFromFolder(folder);
	await writeAndOpen(folder, `${name}.cs`, generateMitMediatorNotification(name, namespace));
}

/** Creates a MitMediator INotificationHandler class (auto-name = NotificationName + Handler). */
export async function createMitMediatorNotificationHandler(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) { vscode.window.showErrorMessage('No target folder selected.'); return; }

	const input = await prompt('INotification Type to Handle', 'UserRegisteredNotification');
	if (!input) { return; }

	const notificationName = capitalize(input);
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Searching for '${notificationName}'…` },
		async () => {
			const found = await findTypeInWorkspace(notificationName);
			if (!found) {
				vscode.window.showErrorMessage(`Type '${notificationName}' not found. The handler was not created.`);
				return;
			}
			const handlerName = `${notificationName}Handler`;
			const namespace = await deriveNamespaceFromFolder(folder);
			await writeAndOpen(folder, `${handlerName}.cs`, generateMitMediatorNotificationHandler(handlerName, found, namespace));
		}
	);
}

/**
 * Creates a MitMediator INotification + INotificationHandler pair inside a new subfolder.
 * Folder name = notification name without trailing "Notification" suffix.
 */
export async function createMitMediatorNotificationAndHandler(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) { vscode.window.showErrorMessage('No target folder selected.'); return; }

	const input = await prompt('Notification Class Name', 'UserRegisteredNotification');
	if (!input) { return; }

	const name = capitalize(input.replace(/Notification$/i, '')) + 'Notification';
	const folderName = name.replace(/Notification$/i, '') || name;

	const subfolderUri = vscode.Uri.joinPath(folder, folderName);
	await vscode.workspace.fs.createDirectory(subfolderUri);
	const namespace = await deriveNamespaceFromFolder(subfolderUri);

	await writeAndOpen(subfolderUri, `${name}.cs`, generateMitMediatorNotification(name, namespace));

	const handlerName = `${name}Handler`;
	const notifFoundType = { name, namespace, fileUri: vscode.Uri.joinPath(subfolderUri, `${name}.cs`) };
	await writeAndOpen(subfolderUri, `${handlerName}.cs`, generateMitMediatorNotificationHandler(handlerName, notifFoundType, namespace));
}

// ============================================================================
// MediatR PipelineBehavior commands
// ============================================================================

/** Creates an empty MediatR IPipelineBehavior class. */
export async function createMediatREmptyPipelineBehavior(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) { vscode.window.showErrorMessage('No target folder selected.'); return; }

	const input = await prompt('Behavior Class Name', 'LoggingBehavior');
	if (!input) { return; }

	const name = capitalize(input);
	const namespace = await deriveNamespaceFromFolder(folder);
	await writeAndOpen(folder, `${name}.cs`, generateMediatREmptyPipelineBehavior(name, namespace));
}

/** Creates a MediatR FluentValidation IPipelineBehavior class. */
export async function createMediatRFluentValidationBehavior(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) { vscode.window.showErrorMessage('No target folder selected.'); return; }

	const name = 'FluentValidationPipelineBehavior';
	const namespace = await deriveNamespaceFromFolder(folder);
	await writeAndOpen(folder, `${name}.cs`, generateMediatRFluentValidationBehavior(name, namespace));
}

// ============================================================================
// MitMediator PipelineBehavior commands
// ============================================================================

/** Creates an empty MitMediator IPipelineBehavior class. */
export async function createMitMediatorEmptyPipelineBehavior(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) { vscode.window.showErrorMessage('No target folder selected.'); return; }

	const input = await prompt('Behavior Class Name', 'LoggingBehavior');
	if (!input) { return; }

	const name = capitalize(input);
	const namespace = await deriveNamespaceFromFolder(folder);
	await writeAndOpen(folder, `${name}.cs`, generateMitMediatorEmptyPipelineBehavior(name, namespace));
}

/** Creates a MitMediator FluentValidation IPipelineBehavior class. */
export async function createMitMediatorFluentValidationBehavior(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) { vscode.window.showErrorMessage('No target folder selected.'); return; }

	const name = 'FluentValidationPipelineBehavior';
	const namespace = await deriveNamespaceFromFolder(folder);
	await writeAndOpen(folder, `${name}.cs`, generateMitMediatorFluentValidationBehavior(name, namespace));
}

// ============================================================================
// Helpers
// ============================================================================

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function isBuiltinType(name: string): boolean {
	const builtins = new Set([
		'bool', 'byte', 'sbyte', 'char', 'decimal', 'double', 'float',
		'int', 'uint', 'long', 'ulong', 'short', 'ushort', 'object',
		'string', 'void', 'dynamic',
		'Boolean', 'Byte', 'SByte', 'Char', 'Decimal', 'Double', 'Single',
		'Int32', 'UInt32', 'Int64', 'UInt64', 'Int16', 'UInt16', 'Object',
		'String', 'Guid', 'DateTime', 'DateTimeOffset', 'TimeSpan',
		'Uri', 'Version', 'Type', 'Unit',
	]);
	return builtins.has(name);
}

const QUERY_PREFIXES = new Set(['get', 'load', 'download', 'fetch']);
const COMMAND_PREFIXES = new Set([
	'post', 'put', 'delete', 'add', 'create', 'remove', 'change',
	'update', 'edit', 'modify', 'import', 'upload', 'drop',
]);

/**
 * Ensures the request name ends with the appropriate suffix (Query / Command / Request).
 * If already ends with one of those suffixes — returns as-is.
 */
export function normalizeRequestName(name: string): string {
	if (/(?:Request|Query|Command)$/i.test(name)) {
		return name;
	}
	const firstWordMatch = name.match(/^([A-Z][a-z]*)/);
	const firstWord = (firstWordMatch ? firstWordMatch[1] : name).toLowerCase();

	let suffix: string;
	if (QUERY_PREFIXES.has(firstWord)) {
		suffix = 'Query';
	} else if (COMMAND_PREFIXES.has(firstWord)) {
		suffix = 'Command';
	} else {
		suffix = 'Request';
	}
	return name + suffix;
}
