import * as vscode from 'vscode';
import * as path from 'path';
import { extractFileNamespace } from '../utils/contentParser.js';
import { findTypeInWorkspace } from '../utils/typeSearch.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FieldInfo {
	name: string;
	typeName: string;
}

// ---------------------------------------------------------------------------
// C# type compatibility helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Type normalisation
// ---------------------------------------------------------------------------

/** Canonical alias map: System type names and BCL aliases → C# keyword. */
const TYPE_ALIASES: Record<string, string> = {
	'system.string':  'string',
	'system.int32':   'int',
	'system.int64':   'long',
	'system.int16':   'short',
	'system.uint32':  'uint',
	'system.uint64':  'ulong',
	'system.uint16':  'ushort',
	'system.single':  'float',
	'system.double':  'double',
	'system.decimal': 'decimal',
	'system.boolean': 'bool',
	'system.byte':    'byte',
	'system.sbyte':   'sbyte',
	'system.char':    'char',
	'system.object':  'object',
	'int32':   'int',
	'int64':   'long',
	'int16':   'short',
	'uint32':  'uint',
	'uint64':  'ulong',
	'uint16':  'ushort',
	'single':  'float',
	'boolean': 'bool',
};

/**
 * Normalises a C# type name to a canonical lowercase form.
 * Strips whitespace, resolves BCL aliases, lowercases.
 * Does NOT strip trailing `?` — nullable is kept as-is so callers can detect it.
 */
function normaliseType(t: string): string {
	const clean = t.replace(/\s+/g, '').toLowerCase();
	return TYPE_ALIASES[clean] ?? clean;
}

/** Returns true if the normalised type name ends with `?`. */
function isNullable(n: string): boolean { return n.endsWith('?'); }

/** Strips trailing `?` from a normalised type name. */
function unwrapNullable(n: string): string { return n.endsWith('?') ? n.slice(0, -1) : n; }

// ---------------------------------------------------------------------------
// Scalar conversion (no collections, no nullable wrapper)
// ---------------------------------------------------------------------------

const INTEGERS = new Set(['byte', 'sbyte', 'short', 'ushort', 'int', 'uint', 'long', 'ulong']);
const FLOATS   = new Set(['float', 'double', 'decimal']);
const NUMERIC  = new Set([...INTEGERS, ...FLOATS]);

/**
 * Returns a conversion expression for `expr` from scalar (non-nullable,
 * non-collection) `src` to `tgt`, or null if not possible.
 * `srcOrig` / `tgtOrig` are the original (pre-normalisation) type strings,
 * used to preserve casing in generated parse calls.
 */
function buildScalarConversion(
	expr: string,
	src: string,
	tgt: string,
	tgtOrig: string
): string | null {
	if (src === tgt) { return expr; }

	const srcIsNumeric = NUMERIC.has(src);
	const tgtIsNumeric = NUMERIC.has(tgt);

	// numeric ↔ numeric  (explicit cast covers both widening and narrowing)
	if (srcIsNumeric && tgtIsNumeric) {
		// Widening (e.g. int → long) does not need a cast in C# but emitting one
		// always is safe and explicit.
		return `(${tgtOrig})${expr}`;
	}

	// numeric / bool / char → string
	if ((srcIsNumeric || src === 'bool' || src === 'char') && tgt === 'string') {
		return `${expr}.ToString()`;
	}

	// string → numeric
	if (src === 'string' && tgtIsNumeric) {
		return `${tgtOrig}.Parse(${expr})`;
	}

	// string → bool
	if (src === 'string' && tgt === 'bool') {
		return `bool.Parse(${expr})`;
	}

	// bool → numeric  (too lossy — skip)
	// numeric → bool  (too lossy — skip)

	return null;
}

// ---------------------------------------------------------------------------
// Collection detection helpers
// ---------------------------------------------------------------------------

const LIST_LIKE_RE  = /^(?:list|ienumerable|ilist|icollection|ireadonlylist|ireadonlycollection)<(.+)>$/;
const ARRAY_RE      = /^(.+)\[\]$/;

interface CollectionInfo {
	/** Normalised element type. */
	elemNorm: string;
	/** Original element type string (for code gen). */
	elemOrig: string;
	kind: 'array' | 'list' | 'enumerable';
}

function detectCollection(norm: string, orig: string): CollectionInfo | null {
	const arrayMatch = norm.match(ARRAY_RE);
	if (arrayMatch) {
		const elemNorm = arrayMatch[1];
		// Recover original element type by stripping trailing []
		const elemOrig = orig.replace(/\s+/g, '').endsWith('[]')
			? orig.replace(/\s+/g, '').slice(0, -2)
			: elemNorm;
		return { elemNorm, elemOrig, kind: 'array' };
	}

	const listMatch = norm.match(LIST_LIKE_RE);
	if (listMatch) {
		const elemNorm = listMatch[1];
		// Recover original element type from orig<...>
		const origMatch = orig.replace(/\s+/g, '').match(/^[^<]+<(.+)>$/);
		const elemOrig  = origMatch ? origMatch[1] : elemNorm;
		const kind: CollectionInfo['kind'] = norm.startsWith('list<') ? 'list' : 'enumerable';
		return { elemNorm, elemOrig, kind };
	}

	return null;
}

// ---------------------------------------------------------------------------
// Main conversion builder
// ---------------------------------------------------------------------------

/**
 * Returns a C# expression that converts `expr` (of type `srcType`) to
 * `tgtType`, or null if the conversion is not supported.
 *
 * Handles:
 *  - Same type                          → direct
 *  - T  → T?   or  T? → T              → direct / .Value
 *  - T? → U  (unwraps nullable first)  → (expr).Value converted to U
 *  - numeric ↔ numeric                 → explicit cast
 *  - numeric/bool/char → string         → .ToString()
 *  - string → numeric/bool              → Type.Parse(...)
 *  - Collection<T> → Collection<U>      → .Select(x => <convert x>).ToList/ToArray()
 *                                         (only when elem types are convertible)
 *  - Collection<T> → T[]               → .ToArray() / .Select(...).ToArray()
 *  - Collection<T> → List<T>           → .ToList()  / .Select(...).ToList()
 */
function buildConversion(expr: string, srcType: string, tgtType: string): string | null {
	const srcNorm = normaliseType(srcType);
	const tgtNorm = normaliseType(tgtType);

	// ── Identical (after normalisation) ──────────────────────────────────────
	if (srcNorm === tgtNorm) { return expr; }

	// ── Nullable handling ─────────────────────────────────────────────────────
	const srcIsNullable = isNullable(srcNorm);
	const tgtIsNullable = isNullable(tgtNorm);
	const srcBase = unwrapNullable(srcNorm);
	const tgtBase = unwrapNullable(tgtNorm);

	// T → T?  (e.g. int → int?)
	if (!srcIsNullable && tgtIsNullable && srcBase === tgtBase) {
		return expr;
	}

	// T? → T  (e.g. int? → int)
	if (srcIsNullable && !tgtIsNullable && srcBase === tgtBase) {
		return `${expr}.Value`;
	}

	// T? → U  or  T? → U?  — unwrap source nullable, then convert
	if (srcIsNullable) {
		// Recover original base type for tgtOrig (strip ? from original string)
		const srcBaseOrig = srcType.replace(/\s+/g, '').endsWith('?')
			? srcType.replace(/\s+/g, '').slice(0, -1)
			: srcType;
		const innerExpr = `${expr}.Value`;
		const innerConv = buildConversion(innerExpr, srcBaseOrig, tgtType);
		return innerConv;
	}

	// T → U?  — convert T → U, result is implicitly assignable to U?
	if (!srcIsNullable && tgtIsNullable) {
		const tgtBaseOrig = tgtType.replace(/\s+/g, '').endsWith('?')
			? tgtType.replace(/\s+/g, '').slice(0, -1)
			: tgtType;
		return buildConversion(expr, srcType, tgtBaseOrig);
	}

	// ── Collection handling ───────────────────────────────────────────────────
	const srcCol = detectCollection(srcNorm, srcType.replace(/\s+/g, ''));
	const tgtCol = detectCollection(tgtNorm, tgtType.replace(/\s+/g, ''));

	if (srcCol !== null && tgtCol !== null) {
		const elemConv = buildConversion('x', srcCol.elemOrig, tgtCol.elemOrig);

		let pipeline: string;
		if (elemConv === null) {
			// Element types are incompatible — skip
			return null;
		} else if (elemConv === 'x') {
			// Element types are identical — no Select needed
			pipeline = expr;
		} else {
			// Element types need conversion — wrap in .Select()
			pipeline = `${expr}.Select(x => ${elemConv})`;
		}

		if (tgtCol.kind === 'array') {
			return `${pipeline}.ToArray()`;
		} else {
			// list / enumerable target → materialise as List<T>
			return `${pipeline}.ToList()`;
		}
	}

	// ── Scalar conversion ─────────────────────────────────────────────────────
	return buildScalarConversion(expr, srcNorm, tgtNorm, tgtType.replace(/\s+/g, ''));
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Removes comments and string literals from C# source while keeping all
 * character offsets intact (every removed character is replaced with a space,
 * newlines are preserved). This ensures that char-offset → line/col conversions
 * via vscode.TextDocument.positionAt() remain valid.
 */
function stripComments(content: string): string {
	let result = '';
	let i = 0;
	const len = content.length;

	while (i < len) {
		// Block comment /* ... */
		if (content[i] === '/' && i + 1 < len && content[i + 1] === '*') {
			const start = i;
			i += 2;
			while (i < len && !(content[i - 1] === '*' && content[i] === '/')) {
				i++;
			}
			i++; // skip closing '/'
			for (let j = start; j < i; j++) {
				result += content[j] === '\n' ? '\n' : ' ';
			}
			continue;
		}

		// Single-line comment // ...
		if (content[i] === '/' && i + 1 < len && content[i + 1] === '/') {
			const start = i;
			while (i < len && content[i] !== '\n') { i++; }
			for (let j = start; j < i; j++) { result += ' '; }
			continue;
		}

		// Verbatim string @"..." (must come before regular string check)
		if (content[i] === '@' && i + 1 < len && content[i + 1] === '"') {
			const start = i;
			i += 2;
			while (i < len) {
				if (content[i] === '"' && i + 1 < len && content[i + 1] === '"') {
					i += 2; // escaped "" inside verbatim
				} else if (content[i] === '"') {
					i++;
					break;
				} else {
					i++;
				}
			}
			for (let j = start; j < i; j++) {
				result += content[j] === '\n' ? '\n' : ' ';
			}
			continue;
		}

		// Regular string literal "..."
		if (content[i] === '"') {
			const start = i;
			i++; // skip opening quote
			while (i < len && content[i] !== '"') {
				if (content[i] === '\\') { i++; } // escape sequence — skip next char too
				i++;
			}
			i++; // skip closing quote
			for (let j = start; j < i; j++) {
				result += content[j] === '\n' ? '\n' : ' ';
			}
			continue;
		}

		result += content[i];
		i++;
	}

	return result;
}

function findMatchingBrace(content: string, openPos: number): number {
	let depth = 0;
	for (let i = openPos; i < content.length; i++) {
		if (content[i] === '{') { depth++; }
		else if (content[i] === '}') {
			depth--;
			if (depth === 0) { return i; }
		}
	}
	return -1;
}

function extractTypeBody(content: string, typeName: string): string | undefined {
	const stripped = stripComments(content);
	const escaped  = escapeRe(typeName);

	const typeRegex = new RegExp(
		`(?:public|internal|private|protected)?\\s*(?:static|sealed|abstract|partial|readonly)*\\s*(?:class|struct|record)\\s+${escaped}(?:\\s*<[^>]*>)?\\s*(?::[^{]*)?\\{`,
		'g'
	);

	let match: RegExpExecArray | null;
	while ((match = typeRegex.exec(stripped)) !== null) {
		const openBrace  = match.index + match[0].length - 1;
		const closeBrace = findMatchingBrace(stripped, openBrace);
		if (closeBrace === -1) { continue; }
		return stripped.slice(openBrace + 1, closeBrace);
	}

	return undefined;
}

function extractFields(typeBody: string, rawContent: string, typeName: string): FieldInfo[] {
	const results: FieldInfo[] = [];

	const propRegex =
		/\bpublic\s+(?:required\s+)?(?:readonly\s+)?(?:static\s+)?(?:override\s+)?(?:virtual\s+)?(?:new\s+)?([\w<>\[\]?,.\s]+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\{[^}]*\}|;)/g;

	let m: RegExpExecArray | null;
	while ((m = propRegex.exec(typeBody)) !== null) {
		const rawType = m[1].trim();
		const name    = m[2].trim();

		if (/^(class|struct|record|enum|interface|delegate|event|void|operator)$/.test(rawType)) { continue; }
		if (/^(if|else|return|new|this|base|var|null|true|false)$/.test(name)) { continue; }

		results.push({ name, typeName: rawType });
	}

	// Primary constructor parameters for records
	const stripped     = stripComments(rawContent);
	const escaped      = escapeRe(typeName);
	const recordCtorRe = new RegExp(`\\brecord\\b(?:\\s+struct)?\\s+${escaped}\\s*\\(([^)]*)\\)`, 'm');
	const recordMatch  = recordCtorRe.exec(stripped);
	if (recordMatch) {
		const paramRegex = /([\w<>\[\]?,.\s]+?)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*[^,)]+)?(?:,|$)/g;
		let pm: RegExpExecArray | null;
		while ((pm = paramRegex.exec(recordMatch[1])) !== null) {
			const rawType = pm[1].trim();
			const name    = pm[2].trim();
			if (!rawType || /^(class|struct|record|enum|interface)$/.test(rawType)) { continue; }
			if (!results.some(r => r.name === name)) {
				results.push({ name, typeName: rawType });
			}
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

function buildAssignmentLines(
	sourceFields: FieldInfo[],
	targetFields: FieldInfo[],
	sourcePrefix: string,
	innerIndent: string
): string[] {
	const targetMap = new Map<string, FieldInfo>();
	for (const tf of targetFields) {
		targetMap.set(tf.name.toLowerCase(), tf);
	}

	const lines: string[] = [];
	for (const sf of sourceFields) {
		const tf = targetMap.get(sf.name.toLowerCase());
		if (!tf) { continue; }
		const conv = buildConversion(`${sourcePrefix}${sf.name}`, sf.typeName, tf.typeName);
		if (conv === null) { continue; }
		lines.push(`${innerIndent}    ${tf.name} = ${conv},`);
	}

	// Remove trailing comma from last assignment
	if (lines.length > 0) {
		lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, '');
	}

	return lines;
}

function buildMapToMethod(
	sourceTypeName: string,
	targetTypeName: string,
	sourceFields: FieldInfo[],
	targetFields: FieldInfo[],
	eol: string
): string {
	const i1 = '    ';
	const i2 = '        ';
	const assignments = buildAssignmentLines(sourceFields, targetFields, 'source.', i2);
	return [
		`${i1}public ${targetTypeName} MapTo(${sourceTypeName} source)`,
		`${i1}{`,
		`${i2}return new ${targetTypeName}`,
		`${i2}{`,
		...assignments,
		`${i2}};`,
		`${i1}}`,
	].join(eol);
}

function buildMapFromMethod(
	sourceTypeName: string,
	targetTypeName: string,
	sourceFields: FieldInfo[],
	targetFields: FieldInfo[],
	eol: string
): string {
	const i1 = '    ';
	const i2 = '        ';
	// MapFrom builds sourceType from targetType — target fields are the inputs
	const assignments = buildAssignmentLines(targetFields, sourceFields, 'source.', i2);
	return [
		`${i1}public static ${sourceTypeName} MapFrom(${targetTypeName} source)`,
		`${i1}{`,
		`${i2}return new ${sourceTypeName}`,
		`${i2}{`,
		...assignments,
		`${i2}};`,
		`${i1}}`,
	].join(eol);
}

// ---------------------------------------------------------------------------
// Shared resolution logic
// ---------------------------------------------------------------------------

interface MappingContext {
	sourceTypeName: string;
	sourceFields: FieldInfo[];
	targetTypeName: string;
	targetFields: FieldInfo[];
	targetNamespace: string;
	eol: string;
	document: vscode.TextDocument;
	insertionPosition: vscode.Position;
}

async function resolveMappingContext(document: vscode.TextDocument): Promise<MappingContext | undefined> {
	const content = document.getText();
	const eol = content.includes('\r\n') ? '\r\n' : '\n';

	// 1. Source type
	const sourceTypeName = detectPrimaryTypeName(content);
	if (!sourceTypeName) {
		vscode.window.showErrorMessage('CSharp Painkiller: Cannot find a class, struct, or record in the current file.');
		return undefined;
	}

	// 2. Ask for target type
	const input = await vscode.window.showInputBox({
		prompt: `Enter the target type name to map with ${sourceTypeName}`,
		placeHolder: 'e.g. UserDto',
		validateInput: v =>
			(!v || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim()))
				? 'Enter a valid C# type name'
				: undefined,
	});
	if (!input) { return undefined; }

	const targetTypeName = input.trim();

	// 3. Find target type in workspace
	const foundType = await findTypeInWorkspace(targetTypeName);
	if (!foundType) {
		vscode.window.showErrorMessage(
			`CSharp Painkiller: Type "${targetTypeName}" not found in the workspace.`
		);
		return undefined;
	}

	// 4. Parse fields
	const sourceFields = parseTypeFields(content, sourceTypeName);

	let targetContent: string;
	try {
		const buf = await vscode.workspace.fs.readFile(foundType.fileUri);
		targetContent = Buffer.from(buf).toString('utf-8');
	} catch {
		vscode.window.showErrorMessage(
			`CSharp Painkiller: Cannot read file for type "${targetTypeName}".`
		);
		return undefined;
	}
	const targetFields = parseTypeFields(targetContent, targetTypeName);

	// 5. Insertion point: beginning of the line containing the type's closing brace
	const insertionPosition = findInsertionPosition(document, sourceTypeName);
	if (!insertionPosition) {
		vscode.window.showErrorMessage(
			`CSharp Painkiller: Cannot determine insertion point in "${path.basename(document.uri.path)}".`
		);
		return undefined;
	}

	return {
		sourceTypeName,
		sourceFields,
		targetTypeName,
		targetFields,
		targetNamespace: foundType.namespace,
		eol,
		document,
		insertionPosition,
	};
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Generates `public TargetType MapTo(SourceType source)` at the end of the
 * class body in the current document.
 */
export async function generateMapToForDocument(document: vscode.TextDocument): Promise<void> {
	const ctx = await resolveMappingContext(document);
	if (!ctx) { return; }

	const { sourceTypeName, targetTypeName, sourceFields, targetFields, targetNamespace, eol, insertionPosition } = ctx;

	// Duplicate check
	const existingRe = new RegExp(`public\\s+${escapeRe(targetTypeName)}\\s+MapTo\\s*\\(`, 'm');
	if (existingRe.test(document.getText())) {
		vscode.window.showWarningMessage(
			`CSharp Painkiller: MapTo(${targetTypeName}) already exists in ${sourceTypeName}.`
		);
		return;
	}

	const methodText = buildMapToMethod(sourceTypeName, targetTypeName, sourceFields, targetFields, eol);
	await applyMethodInsert(document, insertionPosition, methodText, targetNamespace, eol);

	vscode.window.showInformationMessage(
		`CSharp Painkiller: Generated MapTo(${targetTypeName}) in ${sourceTypeName}.`
	);
}

/**
 * Generates `public static SourceType MapFrom(TargetType source)` at the end
 * of the class body in the current document.
 */
export async function generateMapFromForDocument(document: vscode.TextDocument): Promise<void> {
	const ctx = await resolveMappingContext(document);
	if (!ctx) { return; }

	const { sourceTypeName, targetTypeName, sourceFields, targetFields, targetNamespace, eol, insertionPosition } = ctx;

	// Duplicate check
	const existingRe = new RegExp(`public\\s+static\\s+${escapeRe(sourceTypeName)}\\s+MapFrom\\s*\\(`, 'm');
	if (existingRe.test(document.getText())) {
		vscode.window.showWarningMessage(
			`CSharp Painkiller: MapFrom(${targetTypeName}) already exists in ${sourceTypeName}.`
		);
		return;
	}

	const methodText = buildMapFromMethod(sourceTypeName, targetTypeName, sourceFields, targetFields, eol);
	await applyMethodInsert(document, insertionPosition, methodText, targetNamespace, eol);

	vscode.window.showInformationMessage(
		`CSharp Painkiller: Generated MapFrom(${targetTypeName}) in ${sourceTypeName}.`
	);
}

// ---------------------------------------------------------------------------
// Edit helpers
// ---------------------------------------------------------------------------

/**
 * Inserts `methodText` before the closing brace of the type, and adds a
 * `using` directive for `targetNamespace` if it is not yet imported.
 *
 * The insertion point is the start of the line that contains `}`, so the
 * method is placed entirely before the brace without splitting any existing line.
 */
async function applyMethodInsert(
	document: vscode.TextDocument,
	insertionPosition: vscode.Position,
	methodText: string,
	targetNamespace: string,
	eol: string
): Promise<void> {
	const content = document.getText();
	const fileNs  = extractFileNamespace(content) ?? '';
	const edit    = new vscode.WorkspaceEdit();

	// Using directive
	if (targetNamespace && targetNamespace !== fileNs) {
		const alreadyHasUsing = new RegExp(`^using\\s+${escapeRe(targetNamespace)}\\s*;`, 'm').test(content);
		if (!alreadyHasUsing) {
			edit.insert(document.uri, findUsingInsertPosition(document), `using ${targetNamespace};${eol}`);
		}
	}

	// Method goes on its own line(s) before the closing brace.
	// insertionPosition is column 0 of the `}` line, so appending eol after
	// the method leaves the `}` on the next line as expected.
	edit.insert(document.uri, insertionPosition, methodText + eol);

	await vscode.workspace.applyEdit(edit);

	// Scroll to the inserted method
	const editor = vscode.window.visibleTextEditors.find(
		e => e.document.uri.toString() === document.uri.toString()
	);
	if (editor) {
		editor.revealRange(new vscode.Range(insertionPosition, insertionPosition));
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectPrimaryTypeName(content: string): string | undefined {
	const stripped = stripComments(content);
	const publicMatch = stripped.match(
		/\bpublic\s+(?:(?:static|sealed|abstract|partial|readonly)\s+)*(?:class|struct|record)\s+([A-Za-z_][A-Za-z0-9_]*)/
	);
	if (publicMatch) { return publicMatch[1]; }
	return stripped.match(/\b(?:class|struct|record)\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
}

function parseTypeFields(content: string, typeName: string): FieldInfo[] {
	const body = extractTypeBody(content, typeName);
	if (body === undefined) { return []; }
	return extractFields(body, content, typeName);
}

/**
 * Returns the position of column 0 on the line that holds the closing `}` of
 * the named type. Inserting at this position places new code entirely before
 * the `}` without splitting any existing source line.
 */
function findInsertionPosition(
	document: vscode.TextDocument,
	typeName: string
): vscode.Position | undefined {
	const content  = document.getText();
	const stripped = stripComments(content);
	const escaped  = escapeRe(typeName);

	const typeRegex = new RegExp(
		`(?:public|internal|private|protected)?\\s*(?:static|sealed|abstract|partial|readonly)*\\s*(?:class|struct|record)\\s+${escaped}(?:\\s*<[^>]*>)?\\s*(?::[^{]*)?\\{`,
		'g'
	);

	let match: RegExpExecArray | null;
	while ((match = typeRegex.exec(stripped)) !== null) {
		const openBrace  = match.index + match[0].length - 1;
		const closeBrace = findMatchingBrace(stripped, openBrace);
		if (closeBrace === -1) { continue; }

		// Column 0 of the line containing `}` — insert goes before it
		const closingLine = document.positionAt(closeBrace).line;
		return new vscode.Position(closingLine, 0);
	}

	return undefined;
}

/**
 * Returns the position right after the last `using` line in the document,
 * or (0, 0) if there are none.
 */
function findUsingInsertPosition(document: vscode.TextDocument): vscode.Position {
	let lastUsingLine = -1;

	for (let i = 0; i < document.lineCount; i++) {
		const text = document.lineAt(i).text.trim();
		if (/^using\s+/.test(text)) {
			lastUsingLine = i;
		} else if (lastUsingLine !== -1 && text !== '') {
			break;
		}
	}

	return lastUsingLine === -1
		? new vscode.Position(0, 0)
		: new vscode.Position(lastUsingLine + 1, 0);
}

/**
 * Returns the type name if the cursor is positioned on a class/struct/record
 * declaration name, otherwise undefined.
 */
export function getTypeNameAtPosition(
	document: vscode.TextDocument,
	position: vscode.Position
): string | undefined {
	const content  = document.getText();
	const stripped = stripComments(content);

	const re = /\b(?:class|struct|record)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
	let match: RegExpExecArray | null;

	while ((match = re.exec(stripped)) !== null) {
		const nameStart = match.index + match[0].indexOf(match[1]);
		const nameEnd   = nameStart + match[1].length;

		const startPos = document.positionAt(nameStart);
		const endPos   = document.positionAt(nameEnd);

		if (
			position.line >= startPos.line && position.line <= endPos.line &&
			(position.line !== startPos.line || position.character >= startPos.character) &&
			(position.line !== endPos.line   || position.character <= endPos.character)
		) {
			return match[1];
		}
	}

	return undefined;
}
