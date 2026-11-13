import * as vscode from 'vscode';
import { getFileNameFromUri, isPathExcluded } from '../utils/fileUtils.js';
import { csharpLanguageService, type CSharpType } from './csharpLanguageService.js';
import { ErrorHandler } from '../utils/errorHandler.js';

type RenamableTypeKind = 'class' | 'record' | 'struct' | 'record struct';

export interface RenamableTypeDeclaration {
	name: string;
	kind: RenamableTypeKind;
	nameStart: number;
	nameEnd: number;
}

interface FileNameSyncResult {
	uri: vscode.Uri;
	typeName: string;
}

const CSHARP_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DECLARATION_REGEX = /\b(?:(?:public|internal|private|protected)\s+)?(?:(?:static|sealed|abstract|partial|readonly)\s+)*(?:(record)\s+(struct|class)\s+|(class|record|struct)\s+)([A-Za-z_][A-Za-z0-9_]*)/g;

function maskNonCode(content: string): string {
	const chars = content.split('');
	let i = 0;

	function maskRange(start: number, end: number): void {
		for (let j = start; j < end; j++) {
			if (chars[j] !== '\n' && chars[j] !== '\r') {
				chars[j] = ' ';
			}
		}
	}

	while (i < chars.length) {
		const current = chars[i];
		const next = chars[i + 1];

		if (current === '/' && next === '/') {
			const start = i;
			i += 2;
			while (i < chars.length && chars[i] !== '\n' && chars[i] !== '\r') {
				i++;
			}
			maskRange(start, i);
			continue;
		}

		if (current === '/' && next === '*') {
			const start = i;
			i += 2;
			while (i < chars.length && !(chars[i] === '*' && chars[i + 1] === '/')) {
				i++;
			}
			i = Math.min(i + 2, chars.length);
			maskRange(start, i);
			continue;
		}

		if (current === '@' && next === '"') {
			const start = i;
			i += 2;
			while (i < chars.length) {
				if (chars[i] === '"' && chars[i + 1] === '"') {
					i += 2;
					continue;
				}
				if (chars[i] === '"') {
					i++;
					break;
				}
				i++;
			}
			maskRange(start, i);
			continue;
		}

		if (current === '"' || current === '\'') {
			const quote = current;
			const start = i;
			i++;
			while (i < chars.length) {
				if (chars[i] === '\\') {
					i += 2;
					continue;
				}
				if (chars[i] === quote) {
					i++;
					break;
				}
				i++;
			}
			maskRange(start, i);
			continue;
		}

		i++;
	}

	return chars.join('');
}

function getFileStem(uri: vscode.Uri): string {
	const fileName = getFileNameFromUri(uri);
	return fileName.endsWith('.cs') ? fileName.slice(0, -3) : fileName;
}

function isCSharpFile(uri: vscode.Uri): boolean {
	return uri.scheme === 'file' && uri.path.endsWith('.cs') && !isPathExcluded(uri.path);
}

function getSiblingUri(fileUri: vscode.Uri, newFileName: string): vscode.Uri {
	const parentPath = fileUri.path.substring(0, fileUri.path.lastIndexOf('/'));
	return fileUri.with({ path: `${parentPath}/${newFileName}` });
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

export function isValidCSharpIdentifier(value: string): boolean {
	return CSHARP_IDENTIFIER_REGEX.test(value);
}

export function getSingleRenamableType(content: string): RenamableTypeDeclaration | null {
	const matches: RenamableTypeDeclaration[] = [];
	const codeOnlyContent = maskNonCode(content);

	DECLARATION_REGEX.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = DECLARATION_REGEX.exec(codeOnlyContent)) !== null) {
		const name = match[4];
		const nameStart = match.index + match[0].lastIndexOf(name);
		const kind = match[1] === 'record'
			? match[2] === 'struct' ? 'record struct' : 'record'
			: match[3] as RenamableTypeKind;

		matches.push({
			name,
			kind,
			nameStart,
			nameEnd: nameStart + name.length,
		});
	}

	return matches.length === 1 ? matches[0] : null;
}

export function renameSingleTypeInContent(content: string, newName: string): string | null {
	if (!isValidCSharpIdentifier(newName)) {
		return null;
	}

	const typeInfo = getSingleRenamableType(content);
	if (!typeInfo || typeInfo.name === newName) {
		return null;
	}

	return `${content.slice(0, typeInfo.nameStart)}${newName}${content.slice(typeInfo.nameEnd)}`;
}

export async function getSingleRenamableTypeForDocument(document: vscode.TextDocument): Promise<CSharpType | undefined> {
	const types = (await csharpLanguageService.getTypes(document)).filter(type =>
		type.type === 'class' || type.type === 'record' || type.type === 'struct' || type.type === 'record struct');
	return types.length === 1 ? types[0] : undefined;
}

async function renameFileToTypeName(document: vscode.TextDocument, previousTypeName: string | undefined): Promise<FileNameSyncResult | undefined> {
	if (!isCSharpFile(document.uri)) {
		return undefined;
	}

	const typeInfo = await getSingleRenamableTypeForDocument(document);
	if (!typeInfo) {
		return undefined;
	}

	if (previousTypeName === undefined) {
		return { uri: document.uri, typeName: typeInfo.name };
	}

	if (previousTypeName === typeInfo.name) {
		return { uri: document.uri, typeName: typeInfo.name };
	}

	const currentFileStem = getFileStem(document.uri);
	if (currentFileStem === typeInfo.name) {
		return { uri: document.uri, typeName: typeInfo.name };
	}

	const newFileUri = getSiblingUri(document.uri, `${typeInfo.name}.cs`);
	if (await fileExists(newFileUri)) {
		vscode.window.showWarningMessage(`CSharp Painkiller: Cannot rename file to "${typeInfo.name}.cs" because it already exists.`);
		return { uri: document.uri, typeName: typeInfo.name };
	}

	const edit = new vscode.WorkspaceEdit();
	edit.renameFile(document.uri, newFileUri, { overwrite: false });
	if (!await vscode.workspace.applyEdit(edit)) {
		throw new Error(`Could not rename the C# file to "${typeInfo.name}.cs".`);
	}
	vscode.window.showInformationMessage(`CSharp Painkiller: Renamed file to "${typeInfo.name}.cs".`);
	return { uri: newFileUri, typeName: typeInfo.name };
}

function isSyncEnabled(): boolean {
	return vscode.workspace.getConfiguration('csharppainkiller').get<boolean>('syncTypeAndFileName', true);
}

export function registerTypeAndFileNameSync(context: vscode.ExtensionContext): void {
	const knownTypeNames = new Map<string, Promise<string | undefined>>();
	const syncingFiles = new Set<string>();

	function rememberDocumentType(document: vscode.TextDocument): void {
		if (!isCSharpFile(document.uri)) {
			return;
		}

		const name = getSingleRenamableTypeForDocument(document).then(type => type?.name);
		const key = document.uri.toString();
		knownTypeNames.set(key, name);
		name.catch(error => {
			if (knownTypeNames.get(key) === name) { knownTypeNames.delete(key); }
			if (error instanceof vscode.CancellationError) { return; }
			ErrorHandler.logError('Remembering C# type name', error);
		});
	}

	for (const document of vscode.workspace.textDocuments) {
		rememberDocumentType(document);
	}

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(rememberDocumentType),
		vscode.workspace.onDidSaveTextDocument(document => {
			if (!isSyncEnabled()) {
				return;
			}
			const key = document.uri.toString();
			const previous = knownTypeNames.get(key);
			syncingFiles.add(key);
			Promise.resolve(previous).then(name => renameFileToTypeName(document, name))
				.then(result => {
					if (result) {
						knownTypeNames.delete(key);
						knownTypeNames.set(result.uri.toString(), Promise.resolve(result.typeName));
					} else {
						knownTypeNames.delete(key);
					}
				})
				.catch(error => {
					ErrorHandler.logError('Syncing C# file name', error);
					void vscode.window.showErrorMessage(`CSharp Painkiller: File name synchronization failed: ${error instanceof Error ? error.message : String(error)}`);
				})
				.finally(() => syncingFiles.delete(key));
		}),
		vscode.workspace.onWillRenameFiles(event => {
			if (!isSyncEnabled()) {
				return;
			}
			event.waitUntil((async () => {
				const combined = new vscode.WorkspaceEdit();
				const byUri = new Map<string, { uri: vscode.Uri; edits: vscode.TextEdit[] }>();
				for (const { oldUri, newUri } of event.files) {
					if (!isCSharpFile(oldUri) || !isCSharpFile(newUri) || syncingFiles.has(oldUri.toString())) {
						continue;
					}
					const newName = getFileStem(newUri);
					if (!isValidCSharpIdentifier(newName)) { continue; }
					const document = await vscode.workspace.openTextDocument(oldUri);
					const type = await getSingleRenamableTypeForDocument(document);
					if (!type || type.name === newName) { continue; }
					const edit = await csharpLanguageService.getRenameEdit(document, type, newName, event.token);
					for (const [uri, edits] of edit.entries()) {
						const key = uri.toString();
						const existing = byUri.get(key) ?? { uri, edits: [] };
						existing.edits.push(...edits);
						byUri.set(key, existing);
					}
				}
				for (const { uri, edits } of byUri.values()) { combined.set(uri, edits); }
				return combined;
			})().catch(error => {
				ErrorHandler.logError('Syncing C# type name', error);
				void vscode.window.showErrorMessage(`CSharp Painkiller: Type name synchronization failed: ${error instanceof Error ? error.message : String(error)}`);
				throw error;
			}));
		}),
		vscode.workspace.onDidRenameFiles(event => {
			for (const { oldUri, newUri } of event.files) {
				knownTypeNames.delete(oldUri.toString());
				const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === newUri.toString());
				if (document) { rememberDocumentType(document); }
			}
		}),
		vscode.workspace.onDidCloseTextDocument(document => {
			knownTypeNames.delete(document.uri.toString());
		})
	);
}
