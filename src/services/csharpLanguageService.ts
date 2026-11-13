import * as vscode from 'vscode';
import { type CType } from '../types.js';
import { ErrorHandler } from '../utils/errorHandler.js';
import { isPathExcluded } from '../utils/fileUtils.js';
import { extractGenericInterfaceArgument, stripComments, type MediatorFileInfo } from '../utils/contentParser.js';
import { waitWithCancellation } from '../utils/asyncWork.js';
import { type TypeFileContext } from '../utils/usingBlock.js';

export interface CSharpType {
	name: string;
	type: CType;
	namespace: string;
	symbol: vscode.DocumentSymbol;
	nested: boolean;
	partial: boolean;
	public: boolean;
	internal: boolean;
}

interface BaseTypeDeclaration {
	text: string;
	range: vscode.Range;
}

const TYPE_KINDS = new Set([
	vscode.SymbolKind.Class, vscode.SymbolKind.Struct,
	vscode.SymbolKind.Interface, vscode.SymbolKind.Enum,
]);
const REQUEST_TIMEOUT_MS = 30000;

interface CSharpExtensionApi {
	isLimitedActivation: boolean;
	initializationFinished(): Promise<void>;
}

async function ensureCSharpExtension(): Promise<void> {
	const extension = vscode.extensions.getExtension<CSharpExtensionApi>('ms-dotnettools.csharp');
	if (!extension) {
		throw new Error('Microsoft C# (ms-dotnettools.csharp) must be installed and enabled.');
	}
	const api = extension.isActive ? extension.exports : await extension.activate();
	if (!api || api.isLimitedActivation || typeof api.initializationFinished !== 'function') {
		throw new Error('Microsoft C# language services are unavailable. Trust the workspace and check the C# extension.');
	}
	await api.initializationFinished();
}

function throwIfCancelled(token?: vscode.CancellationToken): void {
	if (token?.isCancellationRequested) {
		throw new vscode.CancellationError();
	}
}

/**
 * Uses the C# extension's providers, never a second language client or a source-file index.
 * In-flight requests are shared, but only results for the current document version survive.
 */
export class CSharpLanguageService implements vscode.Disposable {
	private flatNamespaces = new WeakMap<vscode.DocumentSymbol, string>();
	private documents = new WeakMap<vscode.TextDocument, {
		version: number;
		result: Promise<vscode.DocumentSymbol[]>;
	}>();

	constructor(private readonly ensureReady: () => Promise<void> = ensureCSharpExtension) {}

	dispose(): void {
		this.documents = new WeakMap();
		this.flatNamespaces = new WeakMap();
	}

	invalidate(document: vscode.TextDocument): void {
		this.documents.delete(document);
	}

	private async execute<T>(command: string, operation: () => Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				(async () => {
					await this.ensureReady();
					return operation();
				})(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error(`C# language service timed out (${command}). Check the C# Output channel.`)), REQUEST_TIMEOUT_MS);
				}),
			]);
		} catch (error) {
			ErrorHandler.logError('C# language service', error);
			throw error;
		} finally {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		}
	}

	async request<T>(command: string, ...args: unknown[]): Promise<T> {
		return this.execute(command, async () => {
			const result = await vscode.commands.executeCommand<T>(command, ...args);
			if (result === undefined || result === null) {
				throw new Error(`C# language service is not ready (${command}). Wait for the C# project to load and try again.`);
			}
			return result;
		});
	}

	async getSymbols(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<vscode.DocumentSymbol[]> {
		throwIfCancelled(token);
		const version = document.version;
		let entry = this.documents.get(document);
		if (!entry || entry.version !== version) {
			const result = this.execute('vscode.executeDocumentSymbolProvider', async () => {
				// VS Code returns undefined when a registered provider finds no symbols.
				const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
					'vscode.executeDocumentSymbolProvider', document.uri
				);
				return this.normalizeSymbols(document, symbols ?? []);
			});
			entry = { version, result };
			this.documents.set(document, entry);
			result.catch(() => {
				if (this.documents.get(document) === entry) {
					this.documents.delete(document);
				}
			});
		}
		const symbols = await waitWithCancellation(entry.result, token);
		throwIfCancelled(token);
		if (document.version !== version) {
			throw new vscode.CancellationError();
		}
		return symbols;
	}

	private normalizeSymbols(
		document: vscode.TextDocument,
		symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[]
	): vscode.DocumentSymbol[] {
		const hierarchical = symbols.filter((symbol): symbol is vscode.DocumentSymbol =>
			'selectionRange' in symbol && !symbol.selectionRange.isEqual(symbol.range))
			.map(symbol => {
				const normalized = new vscode.DocumentSymbol(symbol.name, symbol.detail, symbol.kind, symbol.range, symbol.selectionRange);
				normalized.children = this.normalizeSymbols(document, symbol.children);
				return normalized;
			});
		const flat = symbols.filter(symbol => !('selectionRange' in symbol) || symbol.selectionRange.isEqual(symbol.range))
			.filter(symbol => !('location' in symbol) || symbol.location.uri.toString() === document.uri.toString())
			.map(symbol => {
				const range = 'selectionRange' in symbol ? symbol.range : symbol.location.range;
				const source = document.getText(range);
				const name = symbol.name.replace(/<.*$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				const keyword = symbol.kind === vscode.SymbolKind.Namespace ? 'namespace' : '(?:class|struct|record|interface|enum)';
				const declaration = new RegExp(`\\b${keyword}\\s+(@?${name})(?![\\p{L}\\p{N}_])`, 'u').exec(source);
				const offset = declaration ? document.offsetAt(range.start) + declaration.index + declaration[0].lastIndexOf(declaration[1]) : undefined;
				const selection = offset === undefined || !declaration ? range : new vscode.Range(
					document.positionAt(offset), document.positionAt(offset + declaration[1].length)
				);
				const normalized = new vscode.DocumentSymbol(symbol.name, '', symbol.kind, range, selection);
				if ('children' in symbol) { normalized.children = this.normalizeSymbols(document, symbol.children); }
				if ('containerName' in symbol) { this.flatNamespaces.set(normalized, symbol.containerName); }
				return normalized;
			});
		const roots: vscode.DocumentSymbol[] = [...hierarchical];
		for (const symbol of flat) {
			const parents = flat.filter(candidate => candidate !== symbol &&
				candidate.range.contains(symbol.range) && !candidate.range.isEqual(symbol.range));
			const parent = parents.find(candidate => !parents.some(other =>
				other !== candidate && candidate.range.contains(other.range)));
			if (parent) {
				parent.children.push(symbol);
			} else {
				roots.push(symbol);
			}
		}
		return roots.sort((a, b) => a.range.start.compareTo(b.range.start));
	}

	async getTypes(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<CSharpType[]> {
		const types: CSharpType[] = [];
		const visit = (symbols: readonly vscode.DocumentSymbol[], namespace: string, nested: boolean): void => {
			for (const symbol of symbols) {
				let childNamespace = namespace;
				if (symbol.kind === vscode.SymbolKind.Namespace) {
					childNamespace = namespace ? `${namespace}.${symbol.name}` : symbol.name;
				}
				let childNested = nested;
				if (TYPE_KINDS.has(symbol.kind)) {
					const masked = stripComments(document.getText(new vscode.Range(symbol.range.start, symbol.selectionRange.start)));
					const prefix = masked.slice(masked.lastIndexOf(']') + 1);
					const keyword = prefix.match(/\b(record\s+struct|record\s+class|record|class|struct|interface|enum)\s*$/)?.[1];
					const kind: CType | undefined = keyword === 'record class' ? 'record'
						: keyword === 'record struct' ? 'record struct'
							: keyword === 'record' || keyword === 'class' || keyword === 'struct' ||
								keyword === 'interface' || keyword === 'enum' ? keyword : undefined;
					if (kind) {
						const name = document.getText(symbol.selectionRange).match(/^@?[\p{L}_][\p{L}\p{N}_]*/u)?.[0];
						if (name) {
							types.push({
								name, type: kind, namespace: namespace || this.flatNamespaces.get(symbol) || '', symbol, nested,
								partial: /\bpartial\b/.test(prefix),
								public: /\bpublic\b/.test(prefix),
								internal: /\binternal\b/.test(prefix),
							});
						}
					}
					childNested = true;
				}
				visit(symbol.children, childNamespace, childNested);
			}
		};
		visit(await this.getSymbols(document, token), '', false);
		return types.sort((a, b) => a.symbol.range.start.compareTo(b.symbol.range.start));
	}

	async getPrimaryType(document: vscode.TextDocument): Promise<CSharpType | undefined> {
		const types = (await this.getTypes(document)).filter(type => !type.nested &&
			type.type !== 'enum' && type.type !== 'interface');
		return types.find(type => type.public) ?? types[0];
	}

	async getTypeFileContext(document: vscode.TextDocument, type: CSharpType): Promise<TypeFileContext> {
		const version = document.version;
		const allScopes: vscode.DocumentSymbol[] = [];
		const collect = (symbols: readonly vscode.DocumentSymbol[]): void => {
			for (const symbol of symbols) {
				if (symbol.kind !== vscode.SymbolKind.Namespace) { continue; }
				allScopes.push(symbol);
				collect(symbol.children);
			}
		};
		collect(await this.getSymbols(document));
		const scopes = allScopes.filter(scope => scope.range.contains(type.symbol.selectionRange.start));
		const types = await this.getTypes(document);
		const context: TypeFileContext = {
			usings: [],
			namespaces: scopes.map(scope => ({ name: scope.name, usings: [] })),
		};
		if (scopes.length === 0 && type.namespace) {
			context.namespaces.push({ name: type.namespace, usings: [] });
		}
		const content = document.getText();
		const masked = stripComments(content);
		const identifier = '@?[\\p{L}_][\\p{L}\\p{N}_]*';
		const namespaceName = new RegExp(`^(?:global::)?${identifier}(?:\\.${identifier})*$`, 'u');
		const pattern = new RegExp(`\\b(global\\s+)?using\\s+(static\\s+)?(?:(${identifier})\\s*=\\s*)?([^;]+);|\\bextern\\s+alias\\s+${identifier}\\s*;`, 'gu');
		for (const match of masked.matchAll(pattern)) {
			if (match[1] || (match[4] && !match[2] && !match[3] && !namespaceName.test(match[4].replace(/\s+/g, '')))) { continue; }
			const position = document.positionAt(match.index);
			if (types.some(candidate => candidate.symbol.range.contains(position))) { continue; }
			const scope = allScopes.filter(candidate => candidate.range.contains(position)).at(-1);
			const index = scope ? scopes.indexOf(scope) : -1;
			if (scope && index < 0) { continue; }
			const using = content.slice(match.index, match.index + match[0].length).trim();
			(index < 0 ? context.usings : context.namespaces[index].usings).push(using);
		}
		if (document.version !== version) { throw new vscode.CancellationError(); }
		return context;
	}

	async getTypeAtPosition(document: vscode.TextDocument, position: vscode.Position, token?: vscode.CancellationToken): Promise<CSharpType | undefined> {
		return (await this.getTypes(document, token)).find(type => type.symbol.selectionRange.contains(position));
	}

	async getIdentifierRanges(document: vscode.TextDocument, kinds?: readonly string[], token?: vscode.CancellationToken): Promise<vscode.Range[]> {
		throwIfCancelled(token);
		const version = document.version;
		const legend = await waitWithCancellation(this.request<vscode.SemanticTokensLegend>('vscode.provideDocumentSemanticTokensLegend', document.uri), token);
		const tokens = await waitWithCancellation(this.request<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', document.uri), token);
		if (document.version !== version) { throw new vscode.CancellationError(); }
		const identifierKinds = new Set(kinds ?? [
			'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter',
			'parameter', 'variable', 'property', 'enumMember', 'event', 'function', 'method',
		]);
		const ranges: vscode.Range[] = [];
		let line = 0;
		let character = 0;
		for (let i = 0; i < tokens.data.length; i += 5) {
			const deltaLine = tokens.data[i];
			line += deltaLine;
			character = deltaLine === 0 ? character + tokens.data[i + 1] : tokens.data[i + 1];
			if (identifierKinds.has(legend.tokenTypes[tokens.data[i + 3]])) {
				ranges.push(new vscode.Range(line, character, line, character + tokens.data[i + 2]));
			}
		}
		return ranges;
	}

	getHeader(document: vscode.TextDocument, type: CSharpType): string {
		return document.getText(this.getDeclarationHeaderRange(document, type.symbol)).trim();
	}

	getDeclarationHeaderRange(document: vscode.TextDocument, symbol: vscode.DocumentSymbol): vscode.Range {
		// Braces in primary-constructor arguments/attributes aren't the type body.
		let depth = 0;
		let quote = '';
		let blockComment = false;
		for (let line = symbol.selectionRange.end.line; line <= symbol.range.end.line; line++) {
			const text = document.lineAt(line).text;
			const start = line === symbol.selectionRange.end.line ? symbol.selectionRange.end.character : 0;
			const end = line === symbol.range.end.line ? symbol.range.end.character : text.length;
			for (let i = start; i < end; i++) {
				const ch = text[i];
				if (blockComment) {
					if (ch === '*' && text[i + 1] === '/') { blockComment = false; i++; }
				} else if (quote) {
					if (ch === '\\') { i++; }
					else if (ch === quote) { quote = ''; }
				} else if (ch === '/' && text[i + 1] === '/') {
					break;
				} else if (ch === '/' && text[i + 1] === '*') {
					blockComment = true;
					i++;
				} else if (ch === '"' || ch === "'") {
					quote = ch;
				} else if (ch === '(' || ch === '[') {
					depth++;
				} else if (ch === ')' || ch === ']') {
					depth--;
				} else if (depth === 0 && (ch === '{' || ch === ';')) {
					return new vscode.Range(symbol.range.start, new vscode.Position(line, i));
				}
			}
		}
		return symbol.range;
	}

	getBaseTypes(document: vscode.TextDocument, type: CSharpType): BaseTypeDeclaration[] {
		const rawPrefix = document.getText(new vscode.Range(type.symbol.range.start, type.symbol.selectionRange.end));
		const prefix = rawPrefix.trimStart();
		const suffix = stripComments(this.getHeader(document, type)).slice(prefix.length);
		const suffixOffset = document.offsetAt(type.symbol.range.start) + rawPrefix.length;
		let depth = 0;
		let start = -1;
		const bases: BaseTypeDeclaration[] = [];
		const addBase = (end: number): void => {
			const raw = suffix.slice(start, end);
			const text = raw.trim();
			if (!text) { return; }
			const offset = suffixOffset + start + raw.length - raw.trimStart().length;
			bases.push({ text, range: new vscode.Range(document.positionAt(offset), document.positionAt(offset + text.length)) });
		};
		for (let i = 0; i < suffix.length; i++) {
			const ch = suffix[i];
			if (ch === '(' || ch === '[' || ch === '<') { depth++; }
			else if (ch === ')' || ch === ']' || ch === '>') { depth--; }
			else if (depth === 0 && start < 0 && ch === ':') { start = i + 1; }
			else if (depth === 0 && start >= 0 && ch === ',') {
				addBase(i);
				start = i + 1;
			} else if (depth === 0 && /\s/.test(suffix[i - 1] ?? '') && /^where\b/.test(suffix.slice(i))) {
				if (start >= 0) { addBase(i); }
				return bases;
			}
		}
		if (start >= 0) { addBase(suffix.length); }
		return bases;
	}

	async getMediatorInfo(document: vscode.TextDocument, typeName?: string): Promise<MediatorFileInfo | null> {
		const version = document.version;
		for (const type of await this.getTypes(document)) {
			if (type.nested || type.type === 'interface' || type.type === 'enum' || (typeName && type.name !== typeName)) { continue; }
			for (const base of this.getBaseTypes(document, type)) {
				const interfaceName = base.text.split('<')[0].replace(/\s+/g, '').split(/\.|::/).pop();
				if (interfaceName !== 'IRequest' && interfaceName !== 'INotification') { continue; }
				const position = document.positionAt(document.offsetAt(base.range.start) + base.text.indexOf(interfaceName));
				const definitions = await this.request<(vscode.Location | vscode.LocationLink)[]>(
					'vscode.executeDefinitionProvider', document.uri, position
				);
				let library: MediatorFileInfo['library'] | undefined;
				for (const definition of definitions) {
					const uri = 'targetUri' in definition ? definition.targetUri : definition.uri;
					const range = 'targetUri' in definition ? definition.targetSelectionRange ?? definition.targetRange : definition.range;
					const targetDocument = await vscode.workspace.openTextDocument(uri);
					const target = (await this.getTypes(targetDocument)).find(candidate => candidate.symbol.range.contains(range.start));
					if (target?.namespace === 'MediatR' || target?.namespace === 'MitMediator') {
						library = target.namespace;
						break;
					}
				}
				if (document.version !== version) { throw new vscode.CancellationError(); }
				if (!library) { continue; }
				if (interfaceName === 'INotification') {
					return { className: type.name, kind: 'notification', library, returnType: null };
				}
				const argument = extractGenericInterfaceArgument(base.text, 'IRequest');
				return { className: type.name, kind: 'request', library, returnType: argument === 'Unit' ? null : argument ?? null };
			}
		}
		return null;
	}

	async findTypes(name: string): Promise<vscode.SymbolInformation[]> {
		const symbols = await this.request<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', name);
		return symbols.filter(symbol => TYPE_KINDS.has(symbol.kind) &&
			symbol.name.replace(/<.*$/, '') === name &&
			symbol.location.uri.scheme === 'file' && symbol.location.uri.path.endsWith('.cs') &&
			!isPathExcluded(symbol.location.uri.path));
	}

	async getRenameEdit(document: vscode.TextDocument, type: CSharpType, newName: string, token?: vscode.CancellationToken): Promise<vscode.WorkspaceEdit> {
		throwIfCancelled(token);
		const version = document.version;
		const edit = await this.request<vscode.WorkspaceEdit>(
			'vscode.executeDocumentRenameProvider', document.uri, type.symbol.selectionRange.start, newName
		);
		throwIfCancelled(token);
		if (document.version !== version || document.isClosed) {
			throw new Error('The C# document changed while preparing the rename. Try again.');
		}
		if (edit.size === 0) {
			throw new Error(`The C# language service did not produce a rename for "${type.name}".`);
		}
		return edit;
	}
}

export const csharpLanguageService = new CSharpLanguageService();
