import * as vscode from 'vscode';
import * as path from 'path';
import { csharpLanguageService } from './csharpLanguageService.js';
import { coerceTypeName } from '../utils/sharedUtilities.js';
import { findTypeInWorkspaceWithOptions } from '../utils/typeSearch.js';
import { getPublicPropertyAccessors, stripComments } from '../utils/contentParser.js';

export { stripComments } from '../utils/contentParser.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FieldInfo {
	name: string;
	typeName: string;
	canRead?: boolean;
	canWrite?: boolean;
}

export interface ConstructorInfo {
	parameters: FieldInfo[];
}

export type ParsedFields = FieldInfo[] & { constructors?: ConstructorInfo[] };

export type MapToMode = 'static' | 'instance';
export type MapFromMode = 'static' | 'constructor';

// ---------------------------------------------------------------------------
// C# type compatibility helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Type normalisation
// ---------------------------------------------------------------------------

/** Canonical alias map: System type names and BCL aliases → C# keyword. */
const TYPE_ALIASES: Record<string, string> = {
	'System.String':  'string', String: 'string',
	'System.Int32':   'int', Int32: 'int',
	'System.Int64':   'long', Int64: 'long',
	'System.Int16':   'short', Int16: 'short',
	'System.UInt32':  'uint', UInt32: 'uint',
	'System.UInt64':  'ulong', UInt64: 'ulong',
	'System.UInt16':  'ushort', UInt16: 'ushort',
	'System.Single':  'float', Single: 'float',
	'System.Double':  'double', Double: 'double',
	'System.Decimal': 'decimal', Decimal: 'decimal',
	'System.Boolean': 'bool', Boolean: 'bool',
	'System.Byte':    'byte', Byte: 'byte',
	'System.SByte':   'sbyte', SByte: 'sbyte',
	'System.Char':    'char', Char: 'char',
	'System.Object':  'object', Object: 'object',
};

/**
 * Strips whitespace and resolves BCL aliases without changing identifier casing.
 * Does NOT strip trailing `?` — nullable is kept as-is so callers can detect it.
 */
function normaliseType(t: string): string {
	const clean = t.replace(/\s+/g, '');
	return Object.hasOwn(TYPE_ALIASES, clean) ? TYPE_ALIASES[clean] : clean;
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

const LIST_LIKE_RE  = /^(?:List|IEnumerable|IList|ICollection|IReadOnlyList|IReadOnlyCollection)<(.+)>$/;
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
		const kind: CollectionInfo['kind'] = norm.startsWith('List<') ? 'list' : 'enumerable';
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
 *  - Nullable targets preserve null; non-nullable targets reject null.
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

	if (srcIsNullable) {
		const srcBaseOrig = srcType.replace(/\s+/g, '').slice(0, -1);
		const tgtBaseOrig = tgtIsNullable ? tgtType.replace(/\s+/g, '').slice(0, -1) : tgtType;
		const nonNull = `(${expr} ?? throw new global::System.InvalidOperationException("Cannot map a null value to a non-nullable target."))`;
		const conversion = buildConversion(nonNull, srcBaseOrig, tgtBaseOrig);
		if (conversion === null) { return null; }
		return tgtIsNullable ? `${expr} is null ? (${tgtType})null : ${conversion}` : conversion;
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
		`(?:public|internal|private|protected)?\\s*(?:static|sealed|abstract|partial|readonly)*\\s*(?:class|struct|record(?:\\s+(?:struct|class))?)\\s+${escaped}(?:\\s*<[^>]*>)?(?:\\s*\\([^)]*\\))?\\s*(?::[^{]*)?\\{`,
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

function extractFields(typeBody: string, rawContent: string, typeName: string): ParsedFields {
	const results: ParsedFields = [];

	const propRegex =
		/\bpublic\s+((?:(?:required|readonly|static|override|virtual|new|sealed)\s+)*)([\w<>\[\]?,.\s]+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\{[^}]*\}(?:\s*=\s*[^;{}]*)?|=>[^;]*;|(?:\s*=\s*[^;{}]*)?;)/g;

	let m: RegExpExecArray | null;
	while ((m = propRegex.exec(typeBody)) !== null) {
		if (/\bstatic\b/.test(m[1])) { continue; }
		const rawType = m[2].trim();
		const name    = m[3].trim();

		if (/^(class|struct|record|enum|interface|delegate|event|void|operator)$/.test(rawType)) { continue; }
		if (/^(if|else|return|new|this|base|var|null|true|false)$/.test(name)) { continue; }

		let canRead = true;
		let canWrite = false;
		const brace = m[0].indexOf('{');
		if (brace >= 0) {
			const start = m.index + brace;
			const end = findMatchingBrace(typeBody, start);
			if (end < 0) { continue; }
			const accessors = getPublicPropertyAccessors(typeBody.slice(start + 1, end));
			canRead = accessors.hasGet;
			canWrite = accessors.hasSet || accessors.hasInit;
			propRegex.lastIndex = end + 1;
		}
		results.push({
			name,
			typeName: rawType,
			canRead,
			canWrite,
		});
	}

	// Primary constructor parameters for records
	const stripped     = stripComments(rawContent);
	const escaped      = escapeRe(typeName);
	const recordCtorRe = new RegExp(`\\brecord\\b(?:\\s+(?:struct|class))?\\s+${escaped}(?:\\s*<[^>]*>)?\\s*\\(([^)]*)\\)`, 'm');
	const recordMatch  = recordCtorRe.exec(stripped);
	if (recordMatch) {
		const paramRegex = /([\w<>\[\]?,.\s]+?)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*[^,)]+)?(?:,|$)/g;
		let pm: RegExpExecArray | null;
		while ((pm = paramRegex.exec(recordMatch[1])) !== null) {
			const rawType = pm[1].trim();
			const name    = pm[2].trim();
			if (!rawType || /^(class|struct|record|enum|interface)$/.test(rawType)) { continue; }
			if (!results.some(r => r.name === name)) {
				results.push({ name, typeName: rawType, canRead: true, canWrite: false });
			}
		}
	}

	const constructors: ConstructorInfo[] = [];
	const ctorRegex = new RegExp(`\\bpublic\\s+${escapeRe(typeName)}\\s*\\(([^)]*)\\)`, 'g');
	let ctorMatch: RegExpExecArray | null;
	while ((ctorMatch = ctorRegex.exec(stripped)) !== null) {
		const parameters: FieldInfo[] = [];
		const paramRegex = /([\w<>\[\]?,.\s]+?)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*[^,)]+)?(?:,|$)/g;
		let paramMatch: RegExpExecArray | null;
		while ((paramMatch = paramRegex.exec(ctorMatch[1])) !== null) {
			const parameterType = paramMatch[1].trim();
			if (parameterType) {
				parameters.push({ name: paramMatch[2].trim(), typeName: parameterType });
			}
		}
		constructors.push({ parameters });
	}
	if (recordMatch) {
		const parameters: FieldInfo[] = [];
		const paramRegex = /([\w<>\[\]?,.\s]+?)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*[^,)]+)?(?:,|$)/g;
		let paramMatch: RegExpExecArray | null;
		while ((paramMatch = paramRegex.exec(recordMatch[1])) !== null) {
			const parameterType = paramMatch[1].trim();
			if (parameterType) {
				parameters.push({ name: paramMatch[2].trim(), typeName: parameterType });
			}
		}
		constructors.push({ parameters });
	}

	results.constructors = constructors;

	return results;
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

export function buildMappingProperties(fields: FieldInfo[], eol: string): string {
	return fields
		.filter(field => field.canRead !== false)
		.map(field => `    public ${field.typeName} ${field.name} { get; init; }`)
		.join(eol);
}

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
		if (sf.canRead === false) { continue; }
		const tf = targetMap.get(sf.name.toLowerCase());
		if (!tf) { continue; }
		if (tf.canWrite === false) { continue; }
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

function defaultConstructorArgument(typeName: string): string {
	const compactType = typeName.replace(/\s+/g, '');
	const collection = detectCollection(normaliseType(typeName), compactType);
	if (collection) {
		const elementType = collection.elemOrig;
		return collection.kind === 'array' ? `Array.Empty<${elementType}>()` : `new List<${elementType}>()`;
	}
	if (typeName.trim().endsWith('?') || /^(string|object|[A-Z_][\w.]*)$/.test(typeName.trim())) {
		return 'null';
	}
	return 'default';
}

function buildConstructorExpression(
	targetTypeName: string,
	sourceFields: FieldInfo[],
	targetFields: FieldInfo[],
	indent: string,
	sourcePrefix = 'source.',
	argumentIndent = indent
): string[] | undefined {
	const args = buildConstructorArguments(sourceFields, targetFields, sourcePrefix);
	if (!args) { return undefined; }
	const assignments = buildAssignmentLines(sourceFields, targetFields, sourcePrefix, indent);
	return [
		`${indent}return new ${targetTypeName}(`,
		...args.map((arg, index) => `${argumentIndent}${arg}${index === args.length - 1 ? '' : ','}`),
		...(assignments.length > 0
			? [`${indent})`, `${indent}{`, ...assignments, `${indent}};`]
			: [`${indent});`]),
	];
}

function buildConstructorArguments(
	sourceFields: FieldInfo[],
	targetFields: FieldInfo[],
	sourcePrefix: string
): string[] | undefined {
	const constructors = (targetFields as ParsedFields).constructors ?? [];
	if (constructors.length === 0 ||
		(targetFields.some(field => field.canWrite !== false) && constructors.some(ctor => ctor.parameters.length === 0))) {
		return undefined;
	}

	const sourceMap = new Map(sourceFields.filter(field => field.canRead !== false).map(field => [field.name.toLowerCase(), field]));
	let best: ConstructorInfo | undefined;
	let bestMatches = -1;
	for (const constructor of constructors) {
		const matches = constructor.parameters.filter(parameter => sourceMap.has(parameter.name.toLowerCase())).length;
		if (matches > bestMatches) {
			best = constructor;
			bestMatches = matches;
		}
	}
	if (!best) { return undefined; }

	return best.parameters.map(parameter => {
		const sourceField = sourceMap.get(parameter.name.toLowerCase());
		if (sourceField) {
			return buildConversion(`${sourcePrefix}${sourceField.name}`, sourceField.typeName, parameter.typeName)
				?? defaultConstructorArgument(parameter.typeName);
		}
		return defaultConstructorArgument(parameter.typeName);
	});
}

export function buildMapToMethod(
	sourceTypeName: string,
	targetTypeName: string,
	sourceFields: FieldInfo[],
	targetFields: FieldInfo[],
	eol: string,
	mode: MapToMode = 'static'
): string {
	const i1 = '    ';
	const i2 = '        ';
	const methodName = `MapTo${targetTypeName}`;
	const sourcePrefix = mode === 'instance' ? 'this.' : 'source.';
	const signature = mode === 'instance'
		? `${i1}public ${targetTypeName} ${methodName}()`
		: `${i1}public static ${targetTypeName} ${methodName}(${sourceTypeName} source)`;
	const constructor = buildConstructorExpression(targetTypeName, sourceFields, targetFields, i2, sourcePrefix, i2 + i1);
	if (constructor) {
		return [signature, `${i1}{`, ...constructor, `${i1}}`].join(eol);
	}
	const assignments = buildAssignmentLines(sourceFields, targetFields, sourcePrefix, i2 + i1);
	return [
		signature,
		`${i1}{`,
		`${i2}return new ${targetTypeName}`,
		`${i2}{`,
		...assignments,
		`${i2}};`,
		`${i1}}`,
	].join(eol);
}

export function buildMapFromMethod(
	sourceTypeName: string,
	targetTypeName: string,
	sourceFields: FieldInfo[],
	targetFields: FieldInfo[],
	eol: string,
	mode: MapFromMode = 'static'
): string {
	const i1 = '    ';
	const i2 = '        ';
	const methodName = `MapFrom${targetTypeName}`;
	const constructor = buildConstructorExpression(sourceTypeName, targetFields, sourceFields, i2);
	if (mode === 'constructor') {
		const assignments = buildAssignmentLines(targetFields, sourceFields, 'source.', i1)
			.map(line => line.endsWith(',') ? line.slice(0, -1) + ';' : line + ';');
		const constructorArgs = buildConstructorArguments(targetFields, sourceFields, 'source.');
		if (constructorArgs) {
			return [
				`${i1}public ${sourceTypeName}(${targetTypeName} source) : this(`,
				...constructorArgs.map((arg, index) => `${i2}${arg}${index === constructorArgs.length - 1 ? '' : ','}`),
				`${i1})`,
				`${i1}{`,
				...assignments,
				`${i1}}`,
			].join(eol);
		}
		return [
			`${i1}public ${sourceTypeName}(${targetTypeName} source)`,
			`${i1}{`,
			...assignments,
			`${i1}}`,
		].join(eol);
	}
	if (constructor) {
		return [`${i1}public static ${sourceTypeName} ${methodName}(${targetTypeName} source)`, `${i1}{`, ...constructor, `${i1}}`].join(eol);
	}
	// MapFrom builds sourceType from targetType — target fields are the inputs
	const assignments = buildAssignmentLines(targetFields, sourceFields, 'source.', i2);
	return [
		`${i1}public static ${sourceTypeName} ${methodName}(${targetTypeName} source)`,
		`${i1}{`,
		`${i2}return new ${sourceTypeName}`,
		`${i2}{`,
		...assignments,
		`${i2}};`,
		`${i1}}`,
	].join(eol);
}

/**
 * Builds a DTO constructor that maps from the source entity.
 */
export function buildDtoMapFromMethod(
	dtoTypeName: string,
	sourceTypeName: string,
	dtoFields: FieldInfo[],
	sourceFields: FieldInfo[],
	eol: string
): string {
	const i1 = '    ';
	const writableDtoFields = dtoFields
		.filter(field => field.canRead !== false)
		.map(field => ({ ...field, canWrite: true }));
	const assignments = buildAssignmentLines(sourceFields, writableDtoFields, 'source.', i1)
		.map(line => line.endsWith(',') ? line.slice(0, -1) + ';' : line + ';');
	return [
		`${i1}public ${dtoTypeName}(${sourceTypeName} source)`,
		`${i1}{`,
		...assignments,
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
	targetDocument: vscode.TextDocument;
	eol: string;
	document: vscode.TextDocument;
	insertionPosition: vscode.Position;
}

async function resolveMappingContext(
	document: vscode.TextDocument,
	explicitSourceTypeName?: string
): Promise<MappingContext | undefined> {
	const content = document.getText();
	const eol = content.includes('\r\n') ? '\r\n' : '\n';

	// 1. Source type
	const sourceTypeName = coerceTypeName(explicitSourceTypeName) ?? (await csharpLanguageService.getPrimaryType(document))?.name;
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
	const foundType = await findTypeInWorkspaceWithOptions(targetTypeName, { contextUri: document.uri });
	if (!foundType) {
		vscode.window.showErrorMessage(
			`CSharp Painkiller: Type "${targetTypeName}" not found in the workspace.`
		);
		return undefined;
	}

	// 4. Parse fields
	const sourceFields = await parseDocumentTypeFields(document, sourceTypeName);
	const targetDocument = await vscode.workspace.openTextDocument(foundType.fileUri);
	const targetFields = await parseDocumentTypeFields(targetDocument, targetTypeName);

	// 5. Insertion point: beginning of the line containing the type's closing brace
	const insertionPosition = await findInsertionPosition(document, sourceTypeName);
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
		targetDocument,
		eol,
		document,
		insertionPosition,
	};
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Generates `public static TargetType MapToTargetType(SourceType source)` at the
 * end of the class body in the current document.
 */
export async function generateMapToForDocument(
	document: vscode.TextDocument,
	sourceTypeName?: string,
	mode?: MapToMode
): Promise<void> {
	const ctx = await resolveMappingContext(document, sourceTypeName);
	if (!ctx) { return; }
	const selectedMode = mode ?? (await vscode.window.showQuickPick([
		{ label: 'Static method', value: 'static' as const },
		{ label: 'Instance method', value: 'instance' as const },
	], { placeHolder: 'Choose MapTo generation style' }))?.value;
	if (!selectedMode) { return; }

	const { sourceTypeName: srcName, targetTypeName, sourceFields, targetFields, targetNamespace, eol, insertionPosition } = ctx;

	// Duplicate check
	const existingRe = new RegExp(`\\bMapTo${escapeRe(targetTypeName)}\\s*\\(`, 'm');
	if (existingRe.test(document.getText())) {
		vscode.window.showWarningMessage(
			`CSharp Painkiller: MapTo${targetTypeName} already exists in ${srcName}.`
		);
		return;
	}

	const methodText = buildMapToMethod(srcName, targetTypeName, sourceFields, targetFields, eol, selectedMode);
	await applyMethodInsert(document, insertionPosition, methodText, targetNamespace, eol);

	vscode.window.showInformationMessage(
		`CSharp Painkiller: Generated MapTo${targetTypeName} in ${srcName}.`
	);
}

/**
 * Generates `public static SourceType MapFromTargetType(TargetType source)` at the
 * end of the class body in the current document.
 */
export async function generateMapFromForDocument(
	document: vscode.TextDocument,
	sourceTypeName?: string,
	mode?: MapFromMode
): Promise<void> {
	const ctx = await resolveMappingContext(document, sourceTypeName);
	if (!ctx) { return; }
	const selectedMode = mode ?? (await vscode.window.showQuickPick([
		{ label: 'Static method', value: 'static' as const },
		{ label: 'Constructor', value: 'constructor' as const },
	], { placeHolder: 'Choose MapFrom generation style' }))?.value;
	if (!selectedMode) { return; }

	const { sourceTypeName: srcName, targetTypeName, sourceFields, targetFields, targetNamespace, eol, insertionPosition } = ctx;

	// Duplicate check
	const existingRe = new RegExp(`\\bMapFrom${escapeRe(targetTypeName)}\\s*\\(`, 'm');
	if (existingRe.test(document.getText())) {
		vscode.window.showWarningMessage(
			`CSharp Painkiller: MapFrom${targetTypeName} already exists in ${srcName}.`
		);
		return;
	}

	let mappingFields = sourceFields;
	let properties = '';
	let additionalUsings: string[] = [];
	if (sourceFields.length === 0) {
		const destinationType = (await csharpLanguageService.getTypes(document)).find(type => type.name === srcName);
		if (!destinationType) { throw new Error(`Cannot resolve mapping destination type "${srcName}".`); }
		if (destinationType.symbol.children.length === 0) {
			const readableFields = targetFields.filter(field => field.canRead !== false);
			if (readableFields.length === 0) {
				vscode.window.showWarningMessage(
					`CSharp Painkiller: No mappable public properties found on ${targetTypeName}.`
				);
				return;
			}
			mappingFields = readableFields.map(field => ({ ...field, canWrite: true }));
			properties = buildMappingProperties(mappingFields, eol) + eol + eol;
			const inputType = (await csharpLanguageService.getTypes(ctx.targetDocument)).find(type => type.name === targetTypeName);
			if (!inputType) { throw new Error(`Cannot resolve mapping input type "${targetTypeName}".`); }
			const context = await csharpLanguageService.getTypeFileContext(ctx.targetDocument, inputType);
			additionalUsings = [...context.usings, ...context.namespaces.flatMap(namespace => namespace.usings)];
		}
	}

	const methodText = buildMapFromMethod(srcName, targetTypeName, mappingFields, targetFields, eol, selectedMode);
	await applyMethodInsert(document, insertionPosition, properties + methodText, targetNamespace, eol, additionalUsings);

	vscode.window.showInformationMessage(
		`CSharp Painkiller: Generated MapFrom${targetTypeName} in ${srcName}.`
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
	eol: string,
	additionalUsings: string[] = []
): Promise<void> {
	const content = document.getText();
	const fileNs = (await csharpLanguageService.getTypes(document))[0]?.namespace ?? '';
	const edit    = new vscode.WorkspaceEdit();
	const insertionOffset = document.offsetAt(insertionPosition);
	const isBodylessDeclaration = document.getText().charAt(insertionOffset) === ';';

	// Using directive
	if (targetNamespace && targetNamespace !== fileNs) {
		const alreadyHasUsing = new RegExp(`^using\\s+${escapeRe(targetNamespace)}\\s*;`, 'm').test(content);
		if (!alreadyHasUsing) {
			edit.insert(document.uri, findUsingInsertPosition(document), `using ${targetNamespace};${eol}`);
		}
	}

	if (additionalUsings.length > 0) {
		const type = (await csharpLanguageService.getTypes(document)).find(type => type.symbol.range.contains(insertionPosition));
		if (!type) { throw new Error('Cannot resolve the type receiving the generated mapping properties.'); }
		const context = await csharpLanguageService.getTypeFileContext(document, type);
		const normalize = (using: string): string => using.replace(/\s+/g, '');
		const existing = new Set([
			...context.usings,
			...context.namespaces.flatMap(namespace => namespace.usings),
			...(targetNamespace ? [`using ${targetNamespace};`] : []),
		].map(normalize));
		const missing: string[] = [];
		for (const using of additionalUsings) {
			const normalized = normalize(using);
			if (existing.has(normalized)) { continue; }
			const alias = normalized.match(/^using(@?[\p{L}_][\p{L}\p{N}_]*)=/u)?.[1];
			if (alias && [...existing].some(directive => directive.startsWith(`using${alias}=`))) {
				throw new Error(`Cannot generate mapping properties: using alias "${alias}" has a different definition in the destination.`);
			}
			existing.add(normalized);
			missing.push(using);
		}
		if (missing.length > 0) {
			edit.insert(document.uri, findUsingInsertPosition(document), missing.join(eol) + eol);
		}
	}

	if (isBodylessDeclaration) {
		edit.replace(
			document.uri,
			new vscode.Range(insertionPosition, document.positionAt(insertionOffset + 1)),
			`{${eol}${methodText}${eol}}`
		);
	} else {
		// Method goes on its own line(s) before the closing brace.
	// insertionPosition is column 0 of the `}` line, so appending eol after
	// the method leaves the `}` on the next line as expected.
		const previousLine = insertionPosition.line > 0
			? document.lineAt(insertionPosition.line - 1).text
			: '';
		const separator = previousLine.trim() ? eol : '';
		edit.insert(document.uri, insertionPosition, separator + methodText + eol);
	}

	if (!await vscode.workspace.applyEdit(edit)) {
		throw new Error('VS Code could not insert the generated mapping method.');
	}

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

export function detectPrimaryTypeName(content: string): string | undefined {
	const stripped = stripComments(content);
	const publicMatch = stripped.match(
		/\bpublic\s+(?:(?:static|sealed|abstract|partial|readonly)\s+)*(?:class|struct|record(?:\s+(?:struct|class))?)\s+([A-Za-z_][A-Za-z0-9_]*)/
	);
	if (publicMatch) { return publicMatch[1]; }
	return stripped.match(/\b(?:class|struct|record(?:\s+(?:struct|class))?)\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
}

export function parseTypeFields(content: string, typeName: string): ParsedFields {
	const body = extractTypeBody(content, typeName);
	return extractFields(body ?? '', content, typeName);
}

export async function parseDocumentTypeFields(document: vscode.TextDocument, typeName: string): Promise<ParsedFields> {
	const matches = (await csharpLanguageService.getTypes(document)).filter(type => type.name === typeName);
	if (matches.length !== 1) {
		throw new Error(`Cannot uniquely resolve type "${typeName}" in the C# document.`);
	}
	const type = matches[0];
	const fields = extractFields('', csharpLanguageService.getHeader(document, type), typeName);
	for (const symbol of type.symbol.children) {
		const source = stripComments(document.getText(symbol.range));
		const name = document.getText(symbol.selectionRange);
		if (symbol.kind === vscode.SymbolKind.Property || symbol.kind === vscode.SymbolKind.Field) {
			const parsed = extractFields(source, '', typeName).find(field => field.name === name);
			if (parsed && !fields.some(field => field.name === parsed.name)) { fields.push(parsed); }
		} else if (symbol.kind === vscode.SymbolKind.Constructor || (symbol.kind === vscode.SymbolKind.Method && name === typeName)) {
			fields.constructors?.push(...(extractFields('', source, typeName).constructors ?? []));
		}
	}
	return fields;
}

/**
 * Returns the position of column 0 on the line that holds the closing `}` of
 * the named type. Inserting at this position places new code entirely before
 * the `}` without splitting any existing source line.
 */
async function findInsertionPosition(
	document: vscode.TextDocument,
	typeName: string
): Promise<vscode.Position | undefined> {
	const type = (await csharpLanguageService.getTypes(document)).find(type => type.name === typeName);
	if (!type) { return undefined; }
	const end = document.offsetAt(type.symbol.range.end) - 1;
	const last = document.getText(new vscode.Range(document.positionAt(end), type.symbol.range.end));
	if (last !== '}' && last !== ';') { return undefined; }
	const position = document.positionAt(end);
	if (last === ';' || document.lineAt(position.line).text.slice(0, position.character).trim()) {
		return position;
	}
	return new vscode.Position(position.line, 0);
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
export async function getTypeNameAtPosition(
	document: vscode.TextDocument,
	position: vscode.Position
): Promise<string | undefined> {
	return (await csharpLanguageService.getTypeAtPosition(document, position))?.name;
}
