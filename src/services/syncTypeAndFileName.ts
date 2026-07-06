import * as vscode from 'vscode';
import { getFileNameFromUri, isPathExcluded } from '../utils/fileUtils.js';

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
const DECLARATION_REGEX = /\b(?:(?:public|internal|private|protected)\s+)?(?:(?:static|sealed|abstract|partial|readonly)\s+)*(?:(record)\s+(struct)\s+|(class|record|struct)\s+)([A-Za-z_][A-Za-z0-9_]*)/g;

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
		const kind = match[1] === 'record' && match[2] === 'struct'
			? 'record struct'
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

async function readUtf8(uri: vscode.Uri): Promise<string> {
	const bytes = await vscode.workspace.fs.readFile(uri);
	return Buffer.from(bytes).toString('utf-8');
}

async function renameTypeToFileName(uri: vscode.Uri): Promise<void> {
	if (!isCSharpFile(uri)) {
		return;
	}

	const newTypeName = getFileStem(uri);
	if (!isValidCSharpIdentifier(newTypeName)) {
		return;
	}

	const content = await readUtf8(uri);
	const updated = renameSingleTypeInContent(content, newTypeName);
	if (updated === null) {
		return;
	}

	await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf-8'));
}

async function renameFileToTypeName(document: vscode.TextDocument, previousTypeName: string | undefined): Promise<FileNameSyncResult | undefined> {
	if (!isCSharpFile(document.uri)) {
		return undefined;
	}

	const typeInfo = getSingleRenamableType(document.getText());
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

	await vscode.workspace.fs.rename(document.uri, newFileUri);
	vscode.window.showInformationMessage(`CSharp Painkiller: Renamed file to "${typeInfo.name}.cs".`);
	return { uri: newFileUri, typeName: typeInfo.name };
}

function isSyncEnabled(): boolean {
	return vscode.workspace.getConfiguration('csharppainkiller').get<boolean>('syncTypeAndFileName', true);
}

export function registerTypeAndFileNameSync(context: vscode.ExtensionContext): void {
	const knownTypeNames = new Map<string, string>();

	function rememberDocumentType(document: vscode.TextDocument): void {
		if (!isCSharpFile(document.uri)) {
			return;
		}

		const typeInfo = getSingleRenamableType(document.getText());
		if (typeInfo) {
			knownTypeNames.set(document.uri.toString(), typeInfo.name);
		} else {
			knownTypeNames.delete(document.uri.toString());
		}
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
			renameFileToTypeName(document, knownTypeNames.get(key))
				.then(result => {
					if (result) {
						knownTypeNames.delete(key);
						knownTypeNames.set(result.uri.toString(), result.typeName);
					} else {
						knownTypeNames.delete(key);
					}
				})
				.catch(error => {
					console.warn('Failed to sync C# file name from type name:', error);
				});
		}),
		vscode.workspace.onDidRenameFiles(event => {
			if (!isSyncEnabled()) {
				return;
			}
			for (const { oldUri, newUri } of event.files) {
				if (!isCSharpFile(oldUri) || !isCSharpFile(newUri)) {
					continue;
				}

				renameTypeToFileName(newUri)
					.then(() => {
						knownTypeNames.delete(oldUri.toString());
						return readUtf8(newUri);
					})
					.then(content => {
						const typeInfo = getSingleRenamableType(content);
						if (typeInfo) {
							knownTypeNames.set(newUri.toString(), typeInfo.name);
						}
					})
					.catch(error => {
						console.warn('Failed to sync C# type name from file name:', error);
					});
			}
		})
	);
}
