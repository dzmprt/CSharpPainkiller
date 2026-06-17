/**
 * Shared utility functions used across the extension.
 * Consolidates duplicated code from createFile.ts, templateCommands.ts, and other services.
 */

import * as vscode from 'vscode';
import { CS_EXTENSION, HANDLER_SUFFIX } from '../constants.js';


// ============================================================================
// Shared file operations (replaces duplicated writeAndOpen patterns)
// ============================================================================

export interface WriteFileResult {
	/** The URI of the created/overwritten file */
	uri: vscode.Uri;
	/** Whether the operation succeeded */
	success: boolean;
	/** Error message if failed, or info message on success */
	message: string;
}

/**
 * Writes content to a new file in the specified folder and opens it.
 * Returns undefined if the file already exists or an error occurs.
 * This is a shared implementation that replaces duplicated writeAndOpen patterns
 * found in createFile.ts, templateCommands.ts, and other services.
 */
export async function writeAndOpen(
	folderUri: vscode.Uri,
	fileName: string,
	content: string
): Promise<WriteFileResult> {
	const fileUri = vscode.Uri.joinPath(folderUri, fileName);

	try {
		await vscode.workspace.fs.stat(fileUri);
		return { uri: fileUri, success: false, message: `File '${fileName}' already exists.` };
	} catch {
		// File doesn't exist — proceed to write
	}

	try {
		const encoded = new TextEncoder().encode(content);
		await vscode.workspace.fs.writeFile(fileUri, encoded);
		const doc = await vscode.workspace.openTextDocument(fileUri);
		await vscode.window.showTextDocument(doc, { preview: false });
		return { uri: fileUri, success: true, message: `Created ${fileName}.` };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return { uri: fileUri, success: false, message: `Failed to create '${fileName}': ${msg}` };
	}
}

// Shared target folder resolution (replaces duplicated resolveTargetFolder)
// ============================================================================

/**
 * Resolves the target folder for file creation or operations.
 * Priority: provided URI -> active editor's workspace folder.
 */
export async function resolveTargetFolder(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
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

// ============================================================================
// Shared URI validation utilities
// ============================================================================

/**
 * Validates a VS Code URI for file operations.
 * Returns an error message string if validation fails, or undefined if valid.
 */
export function validateUri(
	uri: vscode.Uri | undefined,
	options?: { requireCsFile?: boolean; customMessage?: string }
): string | undefined {
	const { requireCsFile = false, customMessage = 'No file or folder selected.' } = options ?? {};

	if (!uri) {
		return customMessage;
	}

	if (uri.scheme !== 'file') {
		return 'Only local files and folders are supported.';
	}

	if (requireCsFile && !uri.path.endsWith(CS_EXTENSION)) {
		return 'This command only works on .cs files.';
	}

	return undefined;
}

function toFileUri(arg: object): vscode.Uri | undefined {
	const u = arg as { scheme?: string; path?: string; fsPath?: string };
	if (u.scheme !== 'file') {
		return undefined;
	}
	if (u.fsPath) {
		return vscode.Uri.file(u.fsPath);
	}
	if (u.path) {
		return vscode.Uri.file(u.path);
	}
	return undefined;
}

/**
 * Resolves a TextDocument from a VS Code command argument.
 * Code actions must pass `document.uri` (not the TextDocument itself) because
 * command arguments are JSON-serialized.
 */
export async function openDocumentFromCommandArg(
	arg?: vscode.Uri | vscode.TextDocument | string
): Promise<vscode.TextDocument | undefined> {
	if (!arg) {
		return vscode.window.activeTextEditor?.document;
	}

	if (typeof arg === 'string') {
		return vscode.workspace.openTextDocument(vscode.Uri.parse(arg));
	}

	if ('lineCount' in arg && typeof arg.getText === 'function') {
		return arg;
	}

	if (arg instanceof vscode.Uri) {
		return vscode.workspace.openTextDocument(arg);
	}

	if (typeof arg === 'object') {
		const fileUri = toFileUri(arg);
		if (fileUri) {
			return vscode.workspace.openTextDocument(fileUri);
		}
	}

	return undefined;
}

/** Returns true when the value looks like a C# type identifier. */
export function isValidTypeName(value: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

/** Coerces an unknown command argument to a type name, ignoring URIs and other values. */
export function coerceTypeName(value: unknown): string | undefined {
	return typeof value === 'string' && isValidTypeName(value) ? value : undefined;
}

function reviveFileUri(arg: unknown): vscode.Uri | undefined {
	if (!arg || typeof arg !== 'object') {
		return undefined;
	}

	if ('lineCount' in arg && typeof (arg as vscode.TextDocument).getText === 'function') {
		return (arg as vscode.TextDocument).uri;
	}

	if (arg instanceof vscode.Uri) {
		return arg;
	}

	return toFileUri(arg);
}

export interface CommandFileContext {
	document: vscode.TextDocument;
	typeName?: string;
}

/**
 * Resolves the target .cs document and optional type name from command arguments.
 * Handles explorer context menu (URI), code actions (URI + type name), and
 * command palette (active editor).
 */
export async function resolveCommandFileContext(
	...args: unknown[]
): Promise<CommandFileContext | undefined> {
	let fileUri: vscode.Uri | undefined;
	let typeName: string | undefined;

	for (const arg of args) {
		const name = coerceTypeName(arg);
		if (name) {
			typeName = name;
			continue;
		}

		const revived = reviveFileUri(arg);
		if (revived) {
			fileUri = revived;
		}
	}

	if (fileUri) {
		return {
			document: await vscode.workspace.openTextDocument(fileUri),
			typeName,
		};
	}

	const editorDoc = vscode.window.activeTextEditor?.document;
	if (editorDoc?.uri.path.endsWith('.cs')) {
		return { document: editorDoc, typeName };
	}

	return undefined;
}

// ============================================================================
// Shared string helpers
// ============================================================================

/** Capitalizes the first character of a string. */
export function capitalize(s: string): string {
	if (!s) {
		return s;
	}
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Checks if a type name is a built-in C# type. */
export function isBuiltinType(name: string): boolean {
	// Import from constants at runtime to avoid circular dependency issues
	const builtinTypes = new Set<string>([
		'bool', 'byte', 'sbyte', 'char', 'decimal', 'double', 'float',
		'int', 'uint', 'long', 'ulong', 'short', 'ushort', 'object',
		'string', 'void', 'dynamic',
		'Boolean', 'Byte', 'SByte', 'Char', 'Decimal', 'Double', 'Single',
		'Int32', 'UInt32', 'Int64', 'UInt64', 'Int16', 'UInt16', 'Object',
		'String', 'Guid', 'DateTime', 'DateTimeOffset', 'TimeSpan',
		'Uri', 'Version', 'Type', 'Unit',
	]);
	return builtinTypes.has(name);
}

// ============================================================================
// Shared mediator utilities (replaces duplicated logic)
// ============================================================================

/**
 * Creates the handler class name for a given mediator type.
 */
export function createHandlerName(className: string): string {
	// Don't double-append "Handler" if it's already there
	if (className.endsWith(HANDLER_SUFFIX)) {
		return className;
	}
	return `${className}${HANDLER_SUFFIX}`;
}

// ============================================================================
// Shared CQRS template configuration (fixes MediatR/MitMediator duplication)
// ============================================================================

/**
 * Configuration for a CQRS template library (MediatR or MitMediator).
 * Used by the generic CQRS command factory to eliminate ~40% of templateCommands.ts.
 */
export interface CqrsTemplateConfig {
	/** Library name identifier */
	libraryName: 'MediatR' | 'MitMediator';

	/** Generates the request class content */
	generateRequest: (name: string, returnType: string | null, returnedType: { name: string; namespace: string; fileUri: vscode.Uri }, namespace: string) => string;

	/** Generates the handler class content */
	generateHandler: (
		handlerName: string,
		requestType: { name: string; namespace: string; fileUri: vscode.Uri },
		returnType: string | null,
		namespace: string,
		returnedType?: { name: string; namespace: string; fileUri: vscode.Uri }
	) => string;

	/** Generates the notification class content */
	generateNotification: (name: string, namespace: string) => string;

	/** Generates the notification handler content */
	generateNotificationHandler: (handlerName: string, notifType: { name: string; namespace: string; fileUri: vscode.Uri }, namespace: string) => string;

	/** Generates empty pipeline behavior content */
	generateEmptyPipelineBehavior: (name: string, namespace: string) => string;

	/** Generates FluentValidation pipeline behavior content */
	generateFluentValidationBehavior: (name: string, namespace: string) => string;

	/** Extracts the return type from IRequest<T> declaration in source */
	extractIRequestReturnType: (content: string) => string | null | undefined;

	/** Whether this library uses INotification vs IRequest<Unit> pattern */
	supportsNotifications: boolean;
}

export function normalizeRequestName(name: string): string {
	if (/(?:Request|Query|Command)$/i.test(name)) {
		return name;
	}

	const queryPrefixes = new Set<string>(['get', 'load', 'download', 'fetch']);
	const commandPrefixes = new Set<string>([
		'post', 'put', 'delete', 'add', 'create', 'remove', 'change',
		'update', 'edit', 'modify', 'import', 'upload', 'drop',
	]);

	const firstWordMatch = name.match(/^([A-Z][a-z]*)/);
	const firstWord = (firstWordMatch ? firstWordMatch[1] : name).toLowerCase();

	let suffix: string;
	if (queryPrefixes.has(firstWord)) {
		suffix = 'Query';
	} else if (commandPrefixes.has(firstWord)) {
		suffix = 'Command';
	} else {
		suffix = 'Request';
	}

	return name + suffix;
}

/**
 * Shared factory for CQRS request+handler pair creation.
 * This replaces the duplicated createMediatRRequestAndHandler and
 * createMitMediatorRequestAndHandler functions.
 */
export async function createCqrsRequestAndHandler(
	folder: vscode.Uri,
	config: CqrsTemplateConfig,
	promptPrefix: string = ''
): Promise<void> {
	const returnTypeInput = await promptOptional(
		'Return Type (leave empty for void)',
		promptPrefix ? `${promptPrefix}  or  List<Author>  or  Author[]` : 'Author  or  List<Author>  or  Author[]'
	);

	if (returnTypeInput === undefined) {
		return;
	}

	const resolved = await resolveReturnType(returnTypeInput);
	if (resolved === null) {
		return;
	}

	const { returnType, innerTypeName, returnedType } = resolved;

	const defaultName = finalizeRequestName('Get', innerTypeName);
	const requestNameInput = await vscode.window.showInputBox({
		title: 'Request Class Name',
		placeHolder: defaultName,
	});

	if (!requestNameInput?.trim()) {
		return;
	}

	const requestName = finalizeRequestName(requestNameInput, innerTypeName);

	const folderName = requestName.replace(/(Request|Query|Command)$/i, '') || requestName;
	const subfolderUri = vscode.Uri.joinPath(folder, folderName);
	await vscode.workspace.fs.createDirectory(subfolderUri);

	const namespace = await deriveNamespaceFromFolder(subfolderUri);

	const effectiveReturnedType: { name: string; namespace: string; fileUri: vscode.Uri } =
		returnedType ?? (innerTypeName ? { name: innerTypeName, namespace: '', fileUri: vscode.Uri.file('') } : { name: '', namespace: '', fileUri: vscode.Uri.file('') });

	const requestContent = config.generateRequest(requestName, returnType, effectiveReturnedType, namespace);
	await writeAndOpen(subfolderUri, `${requestName}.cs`, requestContent);

	const handlerName = createHandlerName(requestName);
	const requestFoundType = { name: requestName, namespace, fileUri: vscode.Uri.joinPath(subfolderUri, `${requestName}.cs`) };

	const rt = returnType ?? (config.libraryName === 'MediatR' ? 'Unit' : null);
	const handlerContent = config.generateHandler(handlerName, requestFoundType, rt, namespace, returnedType ?? undefined);
	await writeAndOpen(subfolderUri, `${handlerName}.cs`, handlerContent);
}

// ============================================================================
// Shared notification factory (fixes MediatR/MitMediator duplication)
// ============================================================================

/**
 * Shared factory for CQRS notification+handler pair creation.
 */
export async function createCqrsNotificationAndHandler(
	folder: vscode.Uri,
	config: CqrsTemplateConfig,
	promptPrefix: string = ''
): Promise<void> {
	const input = await prompt('Notification/Command Class Name', promptPrefix || 'UserRegistered');
	if (!input) { return; }

	const name = capitalize(input.replace(/Notification$/i, '')) + 'Notification';
	const folderName = name.replace(/Notification$/i, '') || name;

	const subfolderUri = vscode.Uri.joinPath(folder, folderName);
	await vscode.workspace.fs.createDirectory(subfolderUri);
	const namespace = await deriveNamespaceFromFolder(subfolderUri);

	await writeAndOpen(subfolderUri, `${name}.cs`, config.generateNotification(name, namespace));

	const handlerName = `${name}Handler`;
	const notifFoundType = { name, namespace, fileUri: vscode.Uri.joinPath(subfolderUri, `${name}.cs`) };
	await writeAndOpen(subfolderUri, `${handlerName}.cs`, config.generateNotificationHandler(handlerName, notifFoundType, namespace));
}

/**
 * Shared factory for CQRS empty pipeline behavior creation.
 */
export async function createCqrsPipelineBehavior(
	folder: vscode.Uri,
	config: CqrsTemplateConfig,
	usePredefinedName: boolean = false,
	predefinedName: string = 'FluentValidationPipelineBehavior'
): Promise<void> {
	const folderName = await prompt('Behavior Class Name', usePredefinedName ? predefinedName : 'LoggingBehavior');
	if (!folderName) { return; }

	const name = usePredefinedName ? predefinedName : capitalize(folderName);
	const namespace = await deriveNamespaceFromFolder(folder);

	const content = usePredefinedName
		? config.generateFluentValidationBehavior(name, namespace)
		: config.generateEmptyPipelineBehavior(name, namespace);

	await writeAndOpen(folder, `${name}.cs`, content);
}

// ============================================================================
// Helper functions for CQRS factory
// ============================================================================

async function prompt(title: string, placeholder: string): Promise<string | undefined> {
	const value = await vscode.window.showInputBox({ title, placeHolder: placeholder });
	if (value === undefined || !value.trim()) {
		return undefined;
	}
	return value.trim();
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

interface ResolvedReturnType {
	returnType: string | null;
	innerTypeName: string | null;
	returnedType: { name: string; namespace: string; fileUri: vscode.Uri } | null;
}

async function resolveReturnType(returnTypeInput: string): Promise<ResolvedReturnType | null> {
	if (!returnTypeInput) {
		return { returnType: null, innerTypeName: null, returnedType: null };
	}

	const { innerTypeName, returnType } = parseReturnType(returnTypeInput);

	if (isBuiltinType(innerTypeName)) {
		return { returnType, innerTypeName, returnedType: null };
	}

	let foundType: Awaited<ReturnType<typeof import('./typeSearch.js').findTypeInWorkspace>> = undefined;
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Searching for type '${innerTypeName}'…` },
		async () => { foundType = await import('./typeSearch.js').then(m => m.findTypeInWorkspace(innerTypeName)); }
	);

	return {
		returnType,
		innerTypeName,
		returnedType: foundType ?? null,
	};
}

function finalizeRequestName(input: string, entityName: string | null): string {
	const trimmed = capitalize(input.trim());
	const lc = trimmed.toLowerCase();

	const queryPrefixes = new Set<string>(['get', 'load', 'download', 'fetch']);
	const commandPrefixes = new Set<string>([
		'post', 'put', 'delete', 'add', 'create', 'remove', 'change',
		'update', 'edit', 'modify', 'import', 'upload', 'drop',
	]);

	const isKnownPrefix = queryPrefixes.has(lc) || commandPrefixes.has(lc);

	if (isKnownPrefix && entityName) {
		return normalizeRequestName(trimmed + capitalize(entityName));
	}

	return normalizeRequestName(trimmed);
}

function parseReturnType(returnTypeStr: string): { innerTypeName: string; returnType: string } {
	const genericMatch = returnTypeStr.match(/^(.+)<(.+)>$/);
	if (genericMatch) {
		return { innerTypeName: genericMatch[2].trim(), returnType: returnTypeStr };
	}

	const arrayMatch = returnTypeStr.match(/^(.+)\[\]$/);
	if (arrayMatch) {
		return { innerTypeName: arrayMatch[1].trim(), returnType: returnTypeStr };
	}

	return { innerTypeName: returnTypeStr.trim(), returnType: returnTypeStr };
}

/**
 * Placeholder for deriveNamespaceFromFolder — imported at runtime.
 * This avoids circular dependency issues with namespace/compute.ts.
 */
async function deriveNamespaceFromFolder(folderUri: vscode.Uri): Promise<string> {
	const { deriveNamespaceFromFolder: actual } = await import('../namespace/compute.js');
	return actual(folderUri);
}