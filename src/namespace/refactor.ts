import * as vscode from 'vscode';
import { type NamespaceAdjustmentPlan } from '../types.js';
import { csharpLanguageService, type CSharpType } from '../services/csharpLanguageService.js';
import { stripComments } from '../utils/contentParser.js';
import { ErrorHandler } from '../utils/errorHandler.js';

interface Scope {
	range: vscode.Range;
	namespace: string;
	originalNamespace: string;
	insertion: vscode.Position;
	fileScoped: boolean;
}

interface Import {
	range: vscode.Range;
	targetRange: vscode.Range;
	target: string;
	alias?: string;
	static: boolean;
	global: boolean;
	scope?: Scope;
}

interface Snapshot {
	document: vscode.TextDocument;
	version: number;
	content: string;
	masked: string;
	scopes: Scope[];
	imports: Import[];
	edits: vscode.TextEdit[];
}

interface TypeReference {
	range: vscode.Range;
	type: CSharpType;
	declarationUri: vscode.Uri;
	extension: boolean;
}

const identifier = '@?[\\p{L}_][\\p{L}\\p{N}_]*';
const qualifiedName = new RegExp(`^(?:global::)?${identifier}(?:\\.${identifier})*$`, 'u');
const prefixPattern = new RegExp(`(?:(?:global|${identifier})\\s*::\\s*)?${identifier}(?:\\s*\\.\\s*${identifier})*\\s*\\.\\s*$`, 'u');

function identity(uri: vscode.Uri, type: CSharpType): string {
	return `${uri.toString()}:${type.symbol.selectionRange.start.line}:${type.symbol.selectionRange.start.character}`;
}

function scopeAt(snapshot: Snapshot, position: vscode.Position): Scope | undefined {
	return snapshot.scopes.filter(scope => scope.range.contains(position))
		.sort((a, b) => b.range.start.compareTo(a.range.start))[0];
}

function covers(importScope: Scope | undefined, referenceScope: Scope | undefined): boolean {
	return !importScope || (!!referenceScope && importScope.range.contains(referenceScope.range));
}

function visible(namespace: string, scopeNamespace: string): boolean {
	return !namespace || namespace === scopeNamespace || scopeNamespace.startsWith(`${namespace}.`);
}

async function ensureSnapshotDocument(snapshot: Snapshot): Promise<void> {
	if (snapshot.document.version !== snapshot.version) {
		throw new Error(`"${snapshot.document.uri.fsPath}" changed while preparing namespace references. Try again.`);
	}
	if (!snapshot.document.isClosed) { return; }

	// Large batches can evict unchanged models; reopening also resets their version.
	const document = await vscode.workspace.openTextDocument(snapshot.document.uri);
	if (document.getText() !== snapshot.content) {
		throw new Error(`"${snapshot.document.uri.fsPath}" changed while preparing namespace references. Try again.`);
	}
	snapshot.document = document;
	snapshot.version = document.version;
}

async function snapshotDocument(document: vscode.TextDocument, plan?: NamespaceAdjustmentPlan): Promise<Snapshot> {
	const snapshot: Snapshot = {
		document, version: document.version, content: document.getText(), masked: stripComments(document.getText()),
		scopes: [], imports: [], edits: plan ? [...plan.edits] : [],
	};
	await ensureSnapshotDocument(snapshot);
	document = snapshot.document;
	const collect = (symbols: readonly vscode.DocumentSymbol[], prefix: string): void => {
		for (const symbol of symbols) {
			if (symbol.kind !== vscode.SymbolKind.Namespace) { continue; }
			const namespace = prefix ? `${prefix}.${symbol.name}` : symbol.name;
			const header = csharpLanguageService.getDeclarationHeaderRange(document, symbol);
			const insertion = document.positionAt(document.offsetAt(header.end) + 1);
			snapshot.scopes.push({
				range: symbol.range, namespace: plan?.newNamespace ?? namespace, originalNamespace: namespace,
				insertion, fileScoped: !!plan || document.getText(new vscode.Range(header.end, insertion)) === ';',
			});
			collect(symbol.children, namespace);
		}
	};
	collect(await csharpLanguageService.getSymbols(document), '');
	const types = await csharpLanguageService.getTypes(document);
	const pattern = new RegExp(`\\b(global\\s+)?using\\s+(static\\s+)?(?:(${identifier})\\s*=\\s*)?([^;]+);`, 'gu');
	for (const match of snapshot.masked.matchAll(pattern)) {
		const target = match[4].trim().replace(/\s+/g, '');
		if (!match[3] && !qualifiedName.test(target)) { continue; }
		const start = match.index + match[0].indexOf(match[4]) + match[4].length - match[4].trimStart().length;
		const end = match.index + match[0].lastIndexOf(';');
		const range = new vscode.Range(document.positionAt(match.index), document.positionAt(match.index + match[0].length));
		if (types.some(type => type.symbol.range.contains(range.start))) { continue; }
		snapshot.imports.push({
			range, targetRange: new vscode.Range(document.positionAt(start), document.positionAt(end)),
			target: target.replace(/^global::/, ''), alias: match[3], static: !!match[2], global: !!match[1],
			scope: scopeAt(snapshot, range.start),
		});
	}
	return snapshot;
}

function isExtension(document: vscode.TextDocument, type: CSharpType, position: vscode.Position): boolean {
	const method = type.symbol.children.find(symbol => symbol.kind === vscode.SymbolKind.Method && symbol.range.contains(position));
	if (!method) { return false; }
	const header = stripComments(csharpLanguageService.getHeader(document, { ...type, symbol: method }));
	return /\bstatic\b/.test(header) && /\(\s*this\b/.test(header);
}

async function resolveReferences(snapshot: Snapshot): Promise<TypeReference[]> {
	await ensureSnapshotDocument(snapshot);
	const ranges = await csharpLanguageService.getIdentifierRanges(snapshot.document, ['type', 'class', 'struct', 'enum', 'interface', 'method']);
	const references: TypeReference[] = [];
	for (let i = 0; i < ranges.length; i += 12) {
		await Promise.all(ranges.slice(i, i + 12).map(async range => {
			const definitions = await csharpLanguageService.request<(vscode.Location | vscode.LocationLink)[]>(
				'vscode.executeDefinitionProvider', snapshot.document.uri, range.start
			);
			for (const definition of definitions) {
				const uri = 'targetUri' in definition ? definition.targetUri : definition.uri;
				const selection = 'targetUri' in definition ? definition.targetSelectionRange ?? definition.targetRange : definition.range;
				const document = await vscode.workspace.openTextDocument(uri);
				const types = await csharpLanguageService.getTypes(document);
				const type = types.filter(candidate => candidate.symbol.range.contains(selection.start))
					.sort((a, b) => b.symbol.range.start.compareTo(a.symbol.range.start))[0];
				if (!type) { continue; }
				const extension = isExtension(document, type, selection.start);
				if (type.symbol.selectionRange.contains(selection.start) || extension) {
					references.push({ range, type, declarationUri: uri, extension });
				}
			}
		}));
	}
	return references;
}

function importAt(snapshot: Snapshot, range: vscode.Range): Import | undefined {
	return snapshot.imports.find(directive => directive.range.contains(range));
}

function qualifier(snapshot: Snapshot, reference: TypeReference): { range: vscode.Range; text: string } | undefined {
	const end = snapshot.document.offsetAt(reference.range.start);
	const match = prefixPattern.exec(snapshot.content.slice(0, end)) ?? prefixPattern.exec(snapshot.masked.slice(0, end));
	return match ? {
		range: new vscode.Range(snapshot.document.positionAt(match.index), reference.range.start),
		text: match[0].replace(/\s+/g, ''),
	} : undefined;
}

function needsImport(snapshot: Snapshot, reference: TypeReference, imports: readonly Import[] = snapshot.imports): boolean {
	if (importAt(snapshot, reference.range)) { return false; }
	const prefix = qualifier(snapshot, reference);
	if (reference.extension) {
		if (prefix?.text.endsWith(`${reference.type.name}.`) || imports.some(directive => directive.static &&
			directive.target === `${reference.type.namespace}.${reference.type.name}` &&
			covers(directive.scope, scopeAt(snapshot, reference.range.start)))) { return false; }
		return true;
	}
	if (prefix) { return false; }
	const name = snapshot.document.getText(reference.range).replace(/^@/, '');
	const typeName = reference.type.name.replace(/^@/, '');
	// Semantic references also report type-alias usages, which need no namespace import.
	return name === typeName || (typeName.endsWith('Attribute') && name === typeName.slice(0, -9));
}

function applyEdits(snapshot: Snapshot): string {
	const edits = snapshot.edits.map(edit => ({
		start: snapshot.document.offsetAt(edit.range.start), end: snapshot.document.offsetAt(edit.range.end), text: edit.newText,
	})).filter((edit, index, all) => !all.slice(0, index).some(other =>
		other.start === edit.start && other.end === edit.end && other.text === edit.text))
		.sort((a, b) => b.start - a.start || b.end - a.end);
	let content = snapshot.content;
	let previous = content.length + 1;
	for (const edit of edits) {
		if (edit.end > previous) { throw new Error(`Overlapping namespace edits in "${snapshot.document.uri.fsPath}".`); }
		content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
		previous = edit.start;
	}
	return content;
}

/** Prepare every reference/import edit before applying one undoable workspace transaction. */
export async function applyNamespaceAdjustmentPlans(plans: NamespaceAdjustmentPlan[]): Promise<number> {
	if (plans.length === 0) { return 0; }
	const moved = new Map<string, NamespaceAdjustmentPlan>();
	const snapshots = new Map<string, Snapshot>();
	const referencesByFile = new Map<string, TypeReference[]>();
	const globalImports: { snapshot: Snapshot; directive: Import }[] = [];
	const survivingNamespaces = new Set<string>();
	for (const plan of plans) {
		if (plan.document.version !== plan.version) { throw new Error('A C# document changed while preparing namespace edits. Try again.'); }
		snapshots.set(plan.document.uri.toString(), await snapshotDocument(plan.document, plan));
		for (const type of plan.types) { moved.set(identity(plan.document.uri, type), plan); }
	}

	// Namespace references are used only to locate global imports and aliases, never to select consumers.
	for (const plan of plans) {
		const collectNamespaces = (symbols: readonly vscode.DocumentSymbol[]): vscode.DocumentSymbol[] =>
			symbols.flatMap(symbol => symbol.kind === vscode.SymbolKind.Namespace ? [symbol, ...collectNamespaces(symbol.children)] : []);
		for (const symbol of collectNamespaces(await csharpLanguageService.getSymbols(plan.document))) {
			const header = csharpLanguageService.getDeclarationHeaderRange(plan.document, symbol);
			const segments = [...stripComments(plan.document.getText(header)).matchAll(new RegExp(identifier, 'gu'))];
			const last = segments[segments.length - 1];
			if (!last) { throw new Error(`Cannot resolve the namespace declaration "${symbol.name}".`); }
			const position = plan.document.positionAt(plan.document.offsetAt(header.start) + last.index);
			const locations = await csharpLanguageService.request<vscode.Location[]>(
				'vscode.executeReferenceProvider', plan.document.uri, position
			);
			for (const location of locations) {
				const key = location.uri.toString();
				const snapshot = snapshots.get(key) ?? await snapshotDocument(await vscode.workspace.openTextDocument(location.uri));
				const movingPlan = plans.find(candidate => candidate.document.uri.toString() === key);
				for (const scope of snapshot.scopes) {
					survivingNamespaces.add(movingPlan?.newNamespace ?? scope.originalNamespace);
				}
				const directive = importAt(snapshot, location.range);
				if (!directive || !plan.types.some(type => type.namespace === directive.target)) { continue; }
				snapshots.set(key, snapshot);
				if (directive.global && !globalImports.some(entry => entry.snapshot.document.uri.toString() === key && entry.directive.range.isEqual(directive.range))) {
					globalImports.push({ snapshot, directive });
				}
			}
		}
	}

	// Namespace references include imports of unrelated types; only query moved types and extension methods.
	for (const plan of plans) {
		for (const type of plan.types) {
			const symbols = [type.symbol, ...type.symbol.children.filter(symbol =>
				symbol.kind === vscode.SymbolKind.Method && isExtension(plan.document, type, symbol.selectionRange.start))];
			for (const symbol of symbols) {
				const locations = await csharpLanguageService.request<vscode.Location[]>(
					'vscode.executeReferenceProvider', plan.document.uri, symbol.selectionRange.start
				);
				for (const location of locations) {
					if (location.uri.toString() === plan.document.uri.toString() && symbol.selectionRange.contains(location.range)) { continue; }
					const key = location.uri.toString();
					if (!snapshots.has(key)) {
						const document = await vscode.workspace.openTextDocument(location.uri);
						if (document.languageId !== 'csharp') { throw new Error(`Cannot safely update a non-C# reference in "${location.uri.fsPath}".`); }
						snapshots.set(key, await snapshotDocument(document));
					}
					const references = referencesByFile.get(key) ?? [];
					if (!references.some(reference => reference.range.isEqual(location.range) && reference.extension === (symbol !== type.symbol))) {
						references.push({ range: location.range, type, declarationUri: plan.document.uri, extension: symbol !== type.symbol });
					}
					referencesByFile.set(key, references);
				}
			}
		}
	}

	for (const snapshot of snapshots.values()) {
		for (const directive of snapshot.imports.filter(directive => directive.global)) {
			if (!globalImports.some(entry => entry.snapshot.document.uri.toString() === snapshot.document.uri.toString() &&
				entry.directive.range.isEqual(directive.range))) { globalImports.push({ snapshot, directive }); }
		}
	}

	for (const [key, snapshot] of snapshots) {
		const resolved = await resolveReferences(snapshot);
		const required = new Map<Scope | undefined, Set<string>>();
		const changedImports = new Set<Import>();
		const removedImports = new Set<Import>();
		const imports = [...snapshot.imports, ...globalImports.filter(entry => entry.snapshot !== snapshot).map(entry => entry.directive)];
		const conflicts = new Map<string, boolean>();
		const hasConflict = async (namespace: string, scope: Scope | undefined): Promise<boolean> => {
			const key = `${namespace}:${scope?.range.start.line ?? -1}`;
			if (conflicts.has(key)) { return conflicts.get(key)!; }
			for (const reference of resolved) {
				if (!needsImport(snapshot, reference) || reference.extension ||
					!covers(scope, scopeAt(snapshot, reference.range.start))) { continue; }
				const destination = moved.get(identity(reference.declarationUri, reference.type))?.newNamespace ?? reference.type.namespace;
				if (destination === namespace) { continue; }
				const matches = await csharpLanguageService.findTypes(reference.type.name);
				for (const match of matches) {
					const document = await vscode.workspace.openTextDocument(match.location.uri);
					if ((await csharpLanguageService.getTypes(document)).some(type =>
						type.name === reference.type.name && type.namespace === namespace)) {
						conflicts.set(key, true);
						return true;
					}
				}
				if (plans.some(plan => plan.newNamespace === namespace && plan.types.some(type => type.name === reference.type.name))) {
					conflicts.set(key, true);
					return true;
				}
			}
			conflicts.set(key, false);
			return false;
		};
		const requireImport = (namespace: string, scope: Scope | undefined): void => {
			if (visible(namespace, scope?.namespace ?? '')) { return; }
			const imports = required.get(scope) ?? new Set<string>();
			imports.add(namespace);
			required.set(scope, imports);
		};
		const uses = referencesByFile.get(key) ?? [];
		for (const reference of uses) {
			const plan = moved.get(identity(reference.declarationUri, reference.type));
			if (!plan || plan.newNamespace === reference.type.namespace) { continue; }
			const directive = importAt(snapshot, reference.range);
			const prefix = qualifier(snapshot, reference);
			if (prefix && !reference.extension) {
				const namespace = reference.type.namespace;
				const scope = scopeAt(snapshot, reference.range.start);
				const alias = imports.find(candidate => candidate.alias && prefix.text.startsWith(`${candidate.alias}.`) &&
					covers(candidate.scope, scope));
				const normalized = prefix.text.replace(/^global::/, '');
				const relative = normalized.replace(/\.$/, '');
				const oldPrefix = alias?.target === namespace ? `${alias.alias}.`
					: namespace.endsWith(`.${relative}`) ? normalized : `${namespace}.`;
				if (normalized.startsWith(oldPrefix)) {
					const raw = snapshot.document.getText(prefix.range);
					const parts = oldPrefix.replace(/\.$/, '').split('.');
					const match = new RegExp(`^(?:global\\s*::\\s*)?${parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*\\.\\s*')}\\s*\\.`, 'u').exec(raw);
					if (!match) { throw new Error(`Cannot safely update the qualifier in "${snapshot.document.uri.fsPath}".`); }
					snapshot.edits.push(vscode.TextEdit.replace(
						new vscode.Range(prefix.range.start, snapshot.document.positionAt(snapshot.document.offsetAt(prefix.range.start) + match[0].length)),
						`global::${plan.newNamespace}.`
					));
					continue;
				}
			}
			if (directive || !needsImport(snapshot, reference, imports)) { continue; }
			const scope = scopeAt(snapshot, reference.range.start);
			if (await hasConflict(plan.newNamespace, scope)) {
				if (reference.extension) {
					throw new Error(`Moving an extension method would introduce an ambiguous import in "${snapshot.document.uri.fsPath}". No changes were applied.`);
				}
				snapshot.edits.push(vscode.TextEdit.insert(reference.range.start, `global::${plan.newNamespace}.`));
			} else {
				requireImport(plan.newNamespace, scope);
			}
			for (const candidate of snapshot.imports) {
				if (!candidate.alias && !candidate.static && !candidate.global && candidate.target === reference.type.namespace && covers(candidate.scope, scope)) {
					changedImports.add(candidate);
				}
			}
		}

		// A moved file may itself rely on types left behind in its former namespace.
		if (plans.some(plan => plan.document.uri.toString() === key)) {
			for (const reference of resolved) {
				if (!moved.has(identity(reference.declarationUri, reference.type)) && needsImport(snapshot, reference, imports)) {
					const scope = scopeAt(snapshot, reference.range.start);
					if (visible(reference.type.namespace, scope?.originalNamespace ?? '')) {
						requireImport(reference.type.namespace, scope);
					}
				}
			}
		}
		for (const directive of snapshot.imports.filter(directive => !directive.static && !removedImports.has(directive))) {
			if (!plans.some(plan => plan.types.some(type => type.namespace === directive.target))) { continue; }
			const remains = [...survivingNamespaces].some(namespace => visible(directive.target, namespace)) ||
				resolved.some(reference => !moved.has(identity(reference.declarationUri, reference.type)) &&
					visible(directive.target, reference.type.namespace));
			if (!remains) { snapshot.edits.push(vscode.TextEdit.delete(directive.range)); removedImports.add(directive); }
		}

		for (const directive of changedImports) {
			const stillNeeded = resolved.some(reference =>
				!moved.has(identity(reference.declarationUri, reference.type)) && reference.type.namespace === directive.target &&
				needsImport(snapshot, reference, imports) && covers(directive.scope, scopeAt(snapshot, reference.range.start)));
			if (!stillNeeded) {
				snapshot.edits.push(vscode.TextEdit.delete(directive.range));
				removedImports.add(directive);
			}
		}
		for (const [scope, namespaces] of required) {
			const additions = [...namespaces].filter(namespace => !imports.some(directive =>
				!removedImports.has(directive) && !directive.alias && !directive.static && directive.target === namespace && covers(directive.scope, scope)));
			if (!additions.length) { continue; }
			const eol = snapshot.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
			// File-scoped declarations (including converted blocks) use file-level imports.
			const importScope = scope?.fileScoped ? undefined : scope;
			const lastImport = snapshot.imports.filter(directive => directive.scope === importScope).at(-1);
			let insertion = importScope?.insertion ?? snapshot.document.positionAt(snapshot.content.startsWith('\uFEFF') ? 1 : 0);
			let prefix = importScope ? eol : '';
			let suffix = importScope && snapshot.content.slice(snapshot.document.offsetAt(insertion)).startsWith(eol) ? '' : eol;
			if (lastImport && !/^[ \t]*#(?:if|elif|else|endif)\b/m.test(snapshot.masked.slice(
				snapshot.document.offsetAt(insertion), snapshot.document.offsetAt(lastImport.range.start)
			))) {
				insertion = lastImport.range.end;
				prefix = eol;
				suffix = eol;
				const line = snapshot.document.lineAt(insertion.line);
				const trailing = snapshot.document.getText(new vscode.Range(insertion, line.range.end));
				if (/^(?:[ \t]|\/\*.*?\*\/)*(?:\/\/.*)?$/.test(trailing)) {
					insertion = line.rangeIncludingLineBreak.end;
					prefix = insertion.isEqual(line.range.end) ? eol : '';
					suffix = prefix ? '' : eol;
				}
			}
			const text = additions.sort().map(namespace => `using ${namespace};`).join(eol);
			snapshot.edits.push(vscode.TextEdit.insert(insertion, `${prefix}${text}${suffix}`));
		}
	}

	for (const snapshot of snapshots.values()) { await ensureSnapshotDocument(snapshot); }

	const edit = new vscode.WorkspaceEdit();
	let consumers = 0;
	for (const [key, snapshot] of snapshots) {
		if (snapshot.document.version !== snapshot.version) {
			throw new Error(`"${snapshot.document.uri.fsPath}" changed while preparing namespace references. Try again.`);
		}
		const content = applyEdits(snapshot);
		if (content === snapshot.content) { continue; }
		edit.replace(snapshot.document.uri, new vscode.Range(snapshot.document.positionAt(0), snapshot.document.positionAt(snapshot.content.length)), content);
		if (!plans.some(plan => plan.document.uri.toString() === key)) { consumers++; }
	}
	if (!await vscode.workspace.applyEdit(edit)) {
		ErrorHandler.logError('Namespace refactoring', 'VS Code rejected the workspace edit.');
		throw new Error('VS Code could not apply namespace and reference edits.');
	}
	return consumers;
}
