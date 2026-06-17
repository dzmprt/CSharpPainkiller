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
	parseReturnType as parseCqrsReturnType,
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
	extractIRequestReturnType as extractCqrsIRequestReturnType,
} from './templates/cqrs.js';

// ============================================================================
// Shared imports — eliminates ~200 lines of duplicated code
// ============================================================================
import {
	writeAndOpen as writeSharedFile,
	resolveTargetFolder as resolveTargetFolderShared,
	capitalize,
	isBuiltinType,
	normalizeRequestName as normalizeSharedRequestName,
	CqrsTemplateConfig,
	createCqrsRequestAndHandler as createSharedCqrsRequestAndHandler,
	createCqrsNotificationAndHandler as createSharedCqrsNotificationAndHandler,
	createCqrsPipelineBehavior as createSharedCqrsPipelineBehavior,
} from '../utils/sharedUtilities.js';

// Re-export writeAndOpen with matching signature for backward compatibility
async function writeAndOpen(folderUri: vscode.Uri, fileName: string, content: string): Promise<boolean> {
	const result = await writeSharedFile(folderUri, fileName, content);
	return result.success;
}

// ============================================================================
// Template configs — single source of truth for MediatR/MitMediator
// ============================================================================

const MEDIATR_CONFIG: CqrsTemplateConfig = {
	libraryName: 'MediatR',
	generateRequest: generateMediatRRequest,
	generateHandler: generateMediatRHandler,
	generateNotification: generateMediatRNotification,
	generateNotificationHandler: generateMediatRNotificationHandler,
	generateEmptyPipelineBehavior: generateMediatREmptyPipelineBehavior,
	generateFluentValidationBehavior: generateMediatRFluentValidationBehavior,
	extractIRequestReturnType: extractCqrsIRequestReturnType,
	supportsNotifications: true,
};

const MITMEDIATOR_CONFIG: CqrsTemplateConfig = {
	libraryName: 'MitMediator',
	generateRequest: generateMitMediatorRequest,
	generateHandler: generateMitMediatorHandler,
	generateNotification: generateMitMediatorNotification,
	generateNotificationHandler: generateMitMediatorNotificationHandler,
	generateEmptyPipelineBehavior: generateMitMediatorEmptyPipelineBehavior,
	generateFluentValidationBehavior: generateMitMediatorFluentValidationBehavior,
	extractIRequestReturnType: extractCqrsIRequestReturnType,
	supportsNotifications: true,
};

// ============================================================================
// Shared return type resolution — used by CQRS commands
// ============================================================================

async function resolveReturnType(returnTypeInput: string): Promise<{
	returnType: string | null;
	innerTypeName: string | null;
	returnedType: import('../utils/typeSearch.js').FoundType | null;
} | null> {
	if (!returnTypeInput) {
		return { returnType: null, innerTypeName: null, returnedType: null };
	}

	const { innerTypeName } = parseCqrsReturnType(returnTypeInput);
	const returnType = returnTypeInput;

	if (isBuiltinType(innerTypeName)) {
		return { returnType, innerTypeName, returnedType: null };
	}

	let foundType: Awaited<ReturnType<typeof findTypeInWorkspace>> = undefined;
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Searching for type '${innerTypeName}'…` },
		async () => { foundType = await findTypeInWorkspace(innerTypeName); }
	);

	return { returnType, innerTypeName, returnedType: foundType ?? null };
}

async function finalizeRequestName(input: string, entityName: string | null): Promise<string> {
	const trimmed = capitalize(input.trim());
	const lc = trimmed.toLowerCase();

	const QUERY_PREFIXES = new Set<string>(['get', 'load', 'download', 'fetch']);
	const COMMAND_PREFIXES = new Set<string>([
		'post', 'put', 'delete', 'add', 'create', 'remove', 'change',
		'update', 'edit', 'modify', 'import', 'upload', 'drop',
	]);

	const isKnownPrefix = QUERY_PREFIXES.has(lc) || COMMAND_PREFIXES.has(lc);

	if (isKnownPrefix && entityName) {
		return normalizeSharedRequestName(trimmed + capitalize(entityName));
	}

	if (/(?:Request|Query|Command)$/i.test(trimmed)) {
		return trimmed;
	}

	const firstWordMatch = trimmed.match(/^([A-Z][a-z]*)/);
	const firstWord = (firstWordMatch ? firstWordMatch[1] : trimmed).toLowerCase();

	let suffix: string;
	if (QUERY_PREFIXES.has(firstWord)) {
		suffix = 'Query';
	} else if (COMMAND_PREFIXES.has(firstWord)) {
		suffix = 'Command';
	} else {
		suffix = 'Request';
	}

	return trimmed + suffix;
}

// ============================================================================
// Utility: resolve target folder — falls back to shared version without prompt
// ============================================================================

async function resolveTargetFolder(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
	const result = await resolveTargetFolderShared(uri);
	if (result) {
		return result;
	}

	// Fallback: ask user for path (original createFile.ts behavior)
	const selected = await vscode.window.showInputBox({
		placeHolder: 'Enter folder path (e.g., /path/to/project)',
		title: 'Select Target Folder',
	});
	return selected ? vscode.Uri.file(selected) : undefined;
}

// ============================================================================
// Utility: prompt helpers — backward compatible wrappers
// ============================================================================

async function prompt(title: string, placeholder: string): Promise<string | undefined> {
	const value = await vscode.window.showInputBox({ title, placeHolder: placeholder });
	if (value === undefined || !value.trim()) {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

async function promptOptional(title: string, placeholder: string): Promise<string | undefined> {
	const value = await vscode.window.showInputBox({
		title,
		placeHolder: placeholder,
		prompt: 'Leave empty for void (no return value)',
	});
	if (value === undefined) {
		return undefined;
	}
	return value.trim();
}

// ============================================================================
// "Go To Handler" context menu command
// ============================================================================

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

export async function generateHandlerForFile(fileUri?: vscode.Uri): Promise<void> {
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

	let returnedType: import('../utils/typeSearch.js').FoundType | undefined;
	if (info.kind === 'request' && info.returnType) {
		const { innerTypeName } = parseCqrsReturnType(info.returnType);
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
// ASP.NET commands — no duplication needed
// ============================================================================

export async function createEmptyController(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) {
		vscode.window.showErrorMessage('No target folder selected.');
		return;
	}
	const input = await prompt('Empty Controller', 'AuthorsController');
	if (!input) { return; }
	const baseName = normalizeControllerName(input);
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
	const entityName = entityInput;
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
	const baseName = input;
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
	const entityName = entityInput;
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
// MediatR commands — using shared factories where possible
// ============================================================================

export async function createMediatRRequestAndHandler(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) {
		vscode.window.showErrorMessage('No target folder selected.');
		return;
	}
	await createSharedCqrsRequestAndHandler(folder, MEDIATR_CONFIG);
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

	const defaultName = (await finalizeRequestName('Get', innerTypeName)).trim();
	const requestNameInput = await vscode.window.showInputBox({
		title: 'Request Class Name',
		placeHolder: defaultName,
	});

	if (!requestNameInput?.trim()) { return; }

	const requestName = (await finalizeRequestName(requestNameInput, innerTypeName)).trim();
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

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Searching for type '${requestInput}'…` },
		async () => {
			const found = await findTypeInWorkspace(requestInput);
			if (!found) {
				vscode.window.showErrorMessage(`Type '${requestInput}' not found in the workspace. The Handler was not created.`);
				return;
			}

			let returnType: string | null = null;
			try {
				const buf = await vscode.workspace.fs.readFile(found.fileUri);
				returnType = extractCqrsIRequestReturnType(Buffer.from(buf).toString('utf-8')) ?? null;
			} catch { /* ignore */ }

			const rt = returnType ?? 'Unit';
			let returnedType: import('../utils/typeSearch.js').FoundType | undefined;
			if (returnType) {
				const { innerTypeName } = parseCqrsReturnType(returnType);
				if (innerTypeName && !isBuiltinType(innerTypeName) && innerTypeName !== 'Unit') {
					returnedType = await findTypeInWorkspace(innerTypeName);
				}
			}

			const handlerName = `${requestInput}Handler`;
			const namespace = await deriveNamespaceFromFolder(folder);
			const content = generateMediatRHandler(handlerName, found, rt, namespace, returnedType);
			await writeAndOpen(folder, `${handlerName}.cs`, content);
		}
	);
}

// ============================================================================
// MitMediator commands — using shared factories where possible
// ============================================================================

export async function createMitMediatorRequestAndHandler(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) {
		vscode.window.showErrorMessage('No target folder selected.');
		return;
	}
	await createSharedCqrsRequestAndHandler(folder, MITMEDIATOR_CONFIG);
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

	const defaultName = (await finalizeRequestName('Get', innerTypeName)).trim();
	const requestNameInput = await vscode.window.showInputBox({
		title: 'Request Class Name',
		placeHolder: defaultName,
	});

	if (!requestNameInput?.trim()) { return; }

	const requestName = (await finalizeRequestName(requestNameInput, innerTypeName)).trim();
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

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Searching for type '${requestInput}'…` },
		async () => {
			const found = await findTypeInWorkspace(requestInput);
			if (!found) {
				vscode.window.showErrorMessage(`Type '${requestInput}' not found in the workspace. The Handler was not created.`);
				return;
			}

			let returnType: string | null = null;
			try {
				const buf = await vscode.workspace.fs.readFile(found.fileUri);
				returnType = extractCqrsIRequestReturnType(Buffer.from(buf).toString('utf-8')) ?? null;
			} catch { /* ignore */ }

			let returnedType: import('../utils/typeSearch.js').FoundType | undefined;
			if (returnType) {
				const { innerTypeName } = parseCqrsReturnType(returnType);
				if (innerTypeName && !isBuiltinType(innerTypeName) && innerTypeName !== 'Unit') {
					returnedType = await findTypeInWorkspace(innerTypeName);
				}
			}

			const handlerName = `${requestInput}Handler`;
			const namespace = await deriveNamespaceFromFolder(folder);
			const rt = returnType === 'Unit' ? null : returnType;
			const content = generateMitMediatorHandler(handlerName, found, rt, namespace, returnedType);
			await writeAndOpen(folder, `${handlerName}.cs`, content);
		}
	);
}

// ============================================================================
// MediatR Notification commands — using shared factories
// ============================================================================

export async function createMediatRNotification(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) { vscode.window.showErrorMessage('No target folder selected.'); return; }

	const input = await prompt('Notification Class Name', 'UserRegisteredNotification');
	if (!input) { return; }

	const name = capitalize(input);
const namespace = await deriveNamespaceFromFolder(folder);
	await writeAndOpen(folder, `${name}.cs`, generateMediatRNotification(name, namespace));
}

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

export async function createMediatRNotificationAndHandler(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) { vscode.window.showErrorMessage('No target folder selected.'); return; }

	await createSharedCqrsNotificationAndHandler(folder, MEDIATR_CONFIG);
}

// ============================================================================
// MitMediator Notification commands — using shared factories
// ============================================================================

export async function createMitMediatorNotification(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) { vscode.window.showErrorMessage('No target folder selected.'); return; }

	const input = await prompt('Notification Class Name', 'UserRegisteredNotification');
	if (!input) { return; }

	const name = capitalize(input);
const namespace = await deriveNamespaceFromFolder(folder);
	await writeAndOpen(folder, `${name}.cs`, generateMitMediatorNotification(name, namespace));
}

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

export async function createMitMediatorNotificationAndHandler(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) { vscode.window.showErrorMessage('No target folder selected.'); return; }

	await createSharedCqrsNotificationAndHandler(folder, MITMEDIATOR_CONFIG);
}

// ============================================================================
// PipelineBehavior commands — using shared factory
// ============================================================================

export async function createMediatREmptyPipelineBehavior(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) { vscode.window.showErrorMessage('No target folder selected.'); return; }

	await createSharedCqrsPipelineBehavior(folder, MEDIATR_CONFIG);
}

export async function createMediatRFluentValidationBehavior(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) { vscode.window.showErrorMessage('No target folder selected.'); return; }

	await createSharedCqrsPipelineBehavior(folder, MEDIATR_CONFIG, true);
}

export async function createMitMediatorEmptyPipelineBehavior(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) { vscode.window.showErrorMessage('No target folder selected.'); return; }

	await createSharedCqrsPipelineBehavior(folder, MITMEDIATOR_CONFIG);
}

export async function createMitMediatorFluentValidationBehavior(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) { vscode.window.showErrorMessage('No target folder selected.'); return; }

	await createSharedCqrsPipelineBehavior(folder, MITMEDIATOR_CONFIG, true);
}

// ============================================================================
// Export normalizeRequestName for backward compatibility (used by other modules)
// ============================================================================

export { normalizeRequestName } from '../utils/sharedUtilities.js';