import { type CType, type TypeDefinition, type TypeExtractionResult, type TypeSearchResult } from '../types.js';
import { hasNonAsciiFast } from './contentHash.js';

// ============================================================================
// Namespace extraction (content-only, use LSP for file-based operations)
// ============================================================================

/**
 * Regular expression to match namespace declarations in C# files.
 * Supports file-scoped (namespace Foo;), block-scoped with brace on next line
 * (namespace Foo\n{) and block-scoped with brace on the same line (namespace Foo {).
 */
const NAMESPACE_REGEX = /^(\s*)namespace\s+([\w.]+)\s*(?:;|\{.*)?\s*(?:\/\/.*)?$/m;

/**
 * Strips a leading UTF-8 BOM character (U+FEFF) from a string, if present.
 * Many editors (including Visual Studio) save C# files with a BOM, which
 * breaks `^`-anchored regular expressions on the first line.
 */
function stripBom(content: string): string {
	return content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
}

/**
 * Extracts the namespace with its leading whitespace from file content.
 * Used internally for namespace replacement in adjustFileNamespace.
 */
export function extractFileNamespaceWithIndent(content: string): { namespace: string; indent: string } | undefined {
	const match = stripBom(content).match(NAMESPACE_REGEX);
	return match ? { namespace: match[2], indent: match[1] } : undefined;
}

/**
 * Extracts the namespace from file content.
 * INTERNAL USE ONLY - for working with file content strings.
 * For LSP-based namespace extraction from files, use CSharpParser service.
 */
export function extractFileNamespace(content: string): string | undefined {
	const match = stripBom(content).match(NAMESPACE_REGEX);
	return match ? match[2] : undefined;
}

/**
 * Extracts using directives from file content.
 * INTERNAL USE ONLY - for working with file content strings.
 * For LSP-based using extraction from files, use CSharpParser service.
 */
export function extractUsingDirectives(content: string): string[] {
	const usingRegex = /^using\s+([\w.]+)\s*;/gm;
	const namespaces: string[] = [];
	let match;
	while ((match = usingRegex.exec(stripBom(content))) !== null) {
		namespaces.push(match[1]);
	}
	return namespaces;
}

const TYPE_EXTRACTION_PATTERNS: { type: CType; regex: RegExp }[] = [
	{ type: 'record struct', regex: /\b(?:public|internal)\s+(?:[\w\s]*?)record\s+struct\s+([A-Za-z_][A-Za-z0-9_]*)/g },
	{ type: 'record', regex: /\b(?:public|internal)\s+(?:[\w\s]*?)record\s+(?!struct\b)([A-Za-z_][A-Za-z0-9_]*)/g },
	{ type: 'class', regex: /\b(?:public|internal)\s+(?:[\w\s]*?)class\s+([A-Za-z_][A-Za-z0-9_]*)/g },
	{ type: 'struct', regex: /\b(?:public|internal)\s+(?:[\w\s]*?)struct\s+([A-Za-z_][A-Za-z0-9_]*)/g },
	{ type: 'enum', regex: /\b(?:public|internal)\s+(?:[\w\s]*?)enum\s+([A-Za-z_][A-Za-z0-9_]*)/g },
	{ type: 'interface', regex: /\b(?:public|internal)\s+(?:[\w\s]*?)interface\s+([A-Za-z_][A-Za-z0-9_]*)/g },
];

function findMatchingBrace(content: string, openPos: number): number {
	let depth = 0;
	for (let i = openPos; i < content.length; i++) {
		if (content[i] === '{') {
			depth++;
		} else if (content[i] === '}') {
			depth--;
			if (depth === 0) {
				return i;
			}
		}
	}
	return -1;
}

function collectTypesFromBody(body: string, namespace: string): TypeDefinition[] {
	const types: TypeDefinition[] = [];
	const seen = new Set<string>();

	for (const { type, regex } of TYPE_EXTRACTION_PATTERNS) {
		regex.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = regex.exec(body)) !== null) {
			const name = match[1];
			if (seen.has(name)) {
				continue;
			}
			seen.add(name);
			types.push({ name, type, namespace });
		}
	}

	return types;
}

function extractBlockNamespaceBodies(content: string): { ns: string; body: string }[] {
	const results: { ns: string; body: string }[] = [];
	const nsStartRegex = /namespace\s+([\w.]+)\s*\{/g;
	let match: RegExpExecArray | null;

	while ((match = nsStartRegex.exec(content)) !== null) {
		const openBrace = match.index + match[0].length - 1;
		const closeBrace = findMatchingBrace(content, openBrace);
		if (closeBrace === -1) {
			continue;
		}
		results.push({
			ns: match[1],
			body: content.slice(openBrace + 1, closeBrace),
		});
		nsStartRegex.lastIndex = closeBrace + 1;
	}

	return results;
}

/**
 * Extracts type definitions from file content along with the namespace.
 * Used internally for analyzing partial types and file structure.
 * For LSP-based namespace/type extraction, use CSharpParser service.
 */
export function extractTypesFromContent(content: string): TypeExtractionResult {
	const types: TypeDefinition[] = [];

	// Strip UTF-8 BOM if present so that ^ anchors work correctly on the first line
	const normalised = stripBom(content);

	// Extract the current namespace from the file
	const namespaceMatch = normalised.match(/^(\s*)namespace\s+([\w.]+)\s*;/m);
	const oldNamespace = namespaceMatch ? namespaceMatch[2] : undefined;

	// First, try file-scoped namespace pattern: namespace X; followed by types
	const fileScopedMatch = normalised.match(/^namespace\s+([\w.]+)\s*;/m);
	if (fileScopedMatch) {
		types.push(...collectTypesFromBody(normalised, fileScopedMatch[1]));
	} else {
		for (const { ns, body } of extractBlockNamespaceBodies(normalised)) {
			types.push(...collectTypesFromBody(body, ns));
		}
	}

	return { types, oldNamespace };
}

// ============================================================================
// Type search by visibility for rename operations
// ============================================================================

/**
 * Searches for types with the specified visibility modifier.
 * Returns:
 * - Single type info if exactly one found
 * - 'ambiguous' if multiple types with same visibility found
 * - null if no types found
 */
// Optional extra modifiers between access modifier and type keyword:
// static, sealed, abstract, partial, readonly (any order, any count)
const EXTRA_MODS = '(?:(?:static|sealed|abstract|partial|readonly)\\s+)*';

export function searchTypesByVisibility(content: string, visibility: 'public' | 'internal'): TypeSearchResult {
	const matches: { name: string; type: CType }[] = [];

	if (visibility === 'public') {
		// Match public [extra-mods] [readonly] record struct first (most specific)
		const recordStructRegex = new RegExp(
			`public\\s+${EXTRA_MODS}(?:readonly\\s+)?record\\s+struct\\s+([A-Za-z_][A-Za-z0-9_]*)`, 'g'
		);
		let match;
		while ((match = recordStructRegex.exec(content)) !== null) {
			matches.push({ name: match[1], type: 'record struct' });
		}

		// Match other public types (class, record, struct, enum, interface)
		const typeRegex = new RegExp(
			`public\\s+${EXTRA_MODS}(?:(class|record(?!\\s+struct\\b)|struct|enum|interface))\\s+([A-Za-z_][A-Za-z0-9_]*)`, 'g'
		);
		while ((match = typeRegex.exec(content)) !== null) {
			matches.push({ name: match[2], type: match[1] as CType });
		}
	} else {
		// Match internal record struct first (most specific) to avoid misdetection
		// where the regex engine backtracks and captures 'struct' as the type name
		const internalRecordStructRegex = new RegExp(
			`(?<![a-zA-Z_])internal\\s+${EXTRA_MODS}(?:readonly\\s+)?record\\s+struct\\s+([A-Za-z_][A-Za-z0-9_]*)`, 'g'
		);
		let match;
		while ((match = internalRecordStructRegex.exec(content)) !== null) {
			matches.push({ name: match[1], type: 'record struct' });
		}

		// Search for other internal types (class, record, struct, enum, interface)
		const internalRegex = new RegExp(
			`(?<![a-zA-Z_])internal\\s+${EXTRA_MODS}(class|record(?!\\s+struct\\b)|struct|enum|interface)\\s+([A-Za-z_][A-Za-z0-9_]*)`, 'g'
		);
		while ((match = internalRegex.exec(content)) !== null) {
			matches.push({ name: match[2], type: match[1] as CType });
		}

		// If no internal types found, search for types without any access modifier
		if (matches.length === 0) {
			// Handle [readonly] record struct as a single compound type first
			const noModRecordStructRegex = /(?<![a-zA-Z_])(?:readonly\s+)?record\s+struct\s+([A-Za-z_][A-Za-z0-9_]*)/g;
			while ((match = noModRecordStructRegex.exec(content)) !== null) {
				const lineStart = content.lastIndexOf('\n', match.index - 1) + 1;
				const linePrefix = content.substring(lineStart, match.index).trim();
				// Skip if an access modifier precedes it
				if (!/^(public|internal|private|protected)\b/.test(linePrefix)) {
					matches.push({ name: match[1], type: 'record struct' });
				}
			}

			if (matches.length === 0) {
				// Match types without access modifiers (skip static, abstract, sealed, partial, readonly)
				// Exclude record struct already matched above
				const noModifierRegex = /(?<![a-zA-Z_])(class|record|struct|enum|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
				while ((match = noModifierRegex.exec(content)) !== null) {
					const typeKeyword = match[1];
					// Check that the type is not preceded by any modifier keywords
					const lineStart = content.lastIndexOf('\n', match.index - 1) + 1;
					const linePrefix = content.substring(lineStart, match.index).trim();
					// Skip if preceded by modifiers like static, abstract, sealed, partial, readonly
					const hasModifier = /^(static|abstract|sealed|partial|readonly)\s/.test(linePrefix);
					// Skip "struct" when the preceding word on the same line is "record" (already a record struct)
					if (typeKeyword === 'struct' && /\brecord\s*$/.test(linePrefix)) {
						continue;
					}
					if (!hasModifier) {
						matches.push({ name: match[2], type: typeKeyword as CType });
					}
				}
			}
		}
	}

	if (matches.length === 0) {
		return null;
	}

	if (matches.length === 1) {
		return matches[0];
	}

	return 'ambiguous';
}

/**
 * Gets the type name from file content with visibility priority.
 * First searches for public types, then falls back to internal/no-modifier.
 */
export function getPublicTypeName(content: string): TypeSearchResult {
	// First, try to find public types
	const publicResult = searchTypesByVisibility(content, 'public');
	if (publicResult !== null) {
		return publicResult;
	}

	// Fall back to internal/no-modifier types
	return searchTypesByVisibility(content, 'internal');
}

/**
 * Gets the expected file name type for diagnostics.
 * Rules (mirrors the logic of "Rename File By Type"):
 *   - Exactly one `public` type  → use it
 *   - Multiple `public` types    → ambiguous, skip check
 *   - No `public` types + exactly one explicit `internal` type → use it
 *   - No `public` types + multiple explicit `internal` types   → ambiguous, skip check
 *   - No `public` or explicit `internal` types                 → null, skip check
 *
 * Unlike getPublicTypeName this function does NOT fall back to types
 * that have no access modifier at all.
 */
export function getTypeNameForFileDiagnostic(content: string): TypeSearchResult {
	// 1. Check public types
	const publicResult = searchTypesByVisibility(content, 'public');
	if (publicResult !== null) {
		// Either a single public type or 'ambiguous' – both are the correct answer here
		return publicResult;
	}

	// 2. No public types – check only explicitly declared internal types (no fallback to unmodified)
	const internalMatches: { name: string; type: CType }[] = [];

	// Match internal record struct first to avoid the backtracking misdetection bug
	const internalRecordStructRegex2 = new RegExp(
		`(?<![a-zA-Z_])internal\\s+${EXTRA_MODS}(?:readonly\\s+)?record\\s+struct\\s+([A-Za-z_][A-Za-z0-9_]*)`, 'g'
	);
	let match;
	while ((match = internalRecordStructRegex2.exec(content)) !== null) {
		internalMatches.push({ name: match[1], type: 'record struct' });
	}

	const internalRegex = new RegExp(
		`(?<![a-zA-Z_])internal\\s+${EXTRA_MODS}(class|record(?!\\s+struct\\b)|struct|enum|interface)\\s+([A-Za-z_][A-Za-z0-9_]*)`, 'g'
	);
	while ((match = internalRegex.exec(content)) !== null) {
		internalMatches.push({ name: match[2], type: match[1] as CType });
	}

	if (internalMatches.length === 0) {
		return null;
	}
	if (internalMatches.length === 1) {
		return internalMatches[0];
	}
	return 'ambiguous';
}

// ============================================================================
// Utility helpers
// ============================================================================

/**
 * Checks if the file contains any partial type declarations (class, struct, or interface).
 */
export function hasPartialTypes(content: string): boolean {
	const partialTypeRegex = /\bpartial\s+(class|struct|interface)\s+\w+/g;
	return partialTypeRegex.test(content);
}

/**
 * Escapes special regex characters in a string.
 */
export function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extracts the type argument from a generic interface such as IRequest<T>.
 * Handles nested generics, e.g. IRequest<List<Author>> → List<Author>.
 */
export function extractGenericInterfaceArgument(content: string, interfaceName: string): string | undefined {
	const pattern = new RegExp(`\\b${escapeRegExp(interfaceName)}\\s*<`);
	const match = pattern.exec(content);
	if (!match) {
		return undefined;
	}

	const start = match.index + match[0].length;
	let depth = 1;
	let i = start;
	while (i < content.length && depth > 0) {
		const ch = content[i];
		if (ch === '<') {
			depth++;
		} else if (ch === '>') {
			depth--;
		}
		i++;
	}

	if (depth !== 0) {
		return undefined;
	}

	return content.slice(start, i - 1).trim();
}

// ============================================================================
// Mixed-language identifier detection (OPTIMIZED — v2)
// ============================================================================

/**
 * Non-Latin Unicode script ranges for fast code-point lookup.
 */
const NON_LATIN_RANGES: [number, number][] = [
	[0x0370, 0x06FF], // Greek + Arabic extended
	[0x0E00, 0x1FFF], // Thai + Lao + IPA ext
	[0x3040, 0x4DBF], // Hiragana + Katakana + CJK
	[0x10A0, 0x10FF], // Georgian
];

/**
 * Optimized non-Latin identifier detection.
 * 
 * Performance improvements (optimization #5):
 * - Direct code point comparison instead of regex per character
 * - Early exit on pure ASCII identifiers (fastest path)
 */
function isMixedOrNonLatinIdentifier(identifier: string): boolean {
	for (let i = 0; i < identifier.length; i++) {
		const code = identifier.charCodeAt(i);
		
		// ASCII fast path: letters, digits, underscore
		if ((code >= 0x30 && code <= 0x39) || // 0-9
			(code >= 0x41 && code <= 0x5A) || // A-Z
			(code >= 0x61 && code <= 0x7A) || // a-z
			code === 0x5F) { // _
			continue;
		}
		
		// Non-ASCII — check script ranges via direct comparison (no regex)
		for (let r = 0; r < NON_LATIN_RANGES.length; r++) {
			if (code >= NON_LATIN_RANGES[r][0] && code <= NON_LATIN_RANGES[r][1]) {
				return true; // Non-Latin script detected
			}
		}
		
		// Any other non-ASCII (extended Latin, etc.) is flagged
		if (code > 0x7F) {
			return true;
		}
	}
	return false;
}

export interface MixedLanguageOccurrence {
	/** The identifier text that triggered the warning */
	identifier: string;
	/** 0-based line index */
	line: number;
	/** 0-based start column */
	startChar: number;
	/** 0-based end column (exclusive) */
	endChar: number;
}

/**
 * Extracts all identifiers from C# source that use non-Latin or mixed-script characters.
 *
 * Scans:
 *  - namespace declarations
 *  - type declarations (class, struct, record, interface, enum)
 *  - member declarations (methods, properties, fields, events)
 *  - local variable declarations
 *  - parameter names
 *
 * Lines that are purely inside string/char literals or comments are skipped
 * via a simple heuristic (not a full parser – edge cases with verbatim/interpolated
 * strings across lines are acceptable false-negatives).
 */
export function findMixedLanguageIdentifiers(content: string): MixedLanguageOccurrence[] {
	const results: MixedLanguageOccurrence[] = [];
	const lines = content.split('\n');

	// Identifier regex: matches potential identifiers (including non-ASCII letters)
	const IDENTIFIER_RE = /[A-Za-z_\u00C0-\u024F\u0370-\u06FF\u0E00-\u1FFF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF][A-Za-z0-9_\u00C0-\u024F\u0370-\u06FF\u0E00-\u1FFF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]*/g;

	// C# keywords to skip (all Latin, won't be flagged but skip for clarity/speed)
	const CS_KEYWORDS = new Set([
		'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char',
		'checked', 'class', 'const', 'continue', 'decimal', 'default', 'delegate', 'do',
		'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false', 'finally',
		'fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit', 'in', 'int',
		'interface', 'internal', 'is', 'lock', 'long', 'namespace', 'new', 'null',
		'object', 'operator', 'out', 'override', 'params', 'private', 'protected',
		'public', 'readonly', 'record', 'ref', 'return', 'sbyte', 'sealed', 'short',
		'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch', 'this', 'throw',
		'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked', 'unsafe', 'ushort',
		'using', 'var', 'virtual', 'void', 'volatile', 'while', 'partial', 'async',
		'await', 'get', 'set', 'init', 'add', 'remove', 'value', 'when', 'yield',
		'from', 'where', 'select', 'group', 'into', 'orderby', 'join', 'let', 'on',
		'equals', 'by', 'ascending', 'descending', 'global', 'nameof', 'with',
	]);

	let inBlockComment = false;

	for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
		const originalLine = lines[lineIdx];

		// OPTIMIZATION: Quick pre-check — if line has no non-ASCII at all, skip all processing.
		// Avoids expensive string operations on purely ASCII lines (the common case).
		if (!hasNonAsciiFast(originalLine)) {
			continue; // No non-ASCII chars → no mixed-language identifiers possible
		}

		let line = originalLine;

		// Handle block comments spanning multiple lines
		if (inBlockComment) {
			const endIdx = line.indexOf('*/');
			if (endIdx === -1) {
				continue; // entire line is inside block comment
			}
			line = line.slice(endIdx + 2);
			inBlockComment = false;

			// Quick re-check after stripping comment tail
			if (!hasNonAsciiFast(line)) {
				continue;
			}
		}

		// Strip block comment fragments on this line (non-greedy)
		let stripped = '';
		let remaining = line;
		while (remaining.length > 0) {
			const bcStart = remaining.indexOf('/*');
			if (bcStart === -1) {
				stripped += remaining;
				break;
			}
			stripped += remaining.slice(0, bcStart);
			const bcEnd = remaining.indexOf('*/', bcStart + 2);
			if (bcEnd === -1) {
				inBlockComment = true;
				break;
			}
			remaining = remaining.slice(bcEnd + 2);
		}
		line = stripped;

		// Strip single-line comment
		const slCommentIdx = line.indexOf('//');
		if (slCommentIdx !== -1) {
			line = line.slice(0, slCommentIdx);
		}

		// Strip string literals to avoid flagging non-Latin text inside strings
		line = stripStringLiterals(line);

		// Only scan for identifiers if line has non-ASCII after stripping
		if (!hasNonAsciiFast(line)) {
			continue; // All non-ASCII was inside comments/strings
		}

		IDENTIFIER_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = IDENTIFIER_RE.exec(line)) !== null) {
			const ident = match[0];
			// Skip C# keywords (Latin only, but skip for clarity)
			if (CS_KEYWORDS.has(ident)) {
				continue;
			}
			if (isMixedOrNonLatinIdentifier(ident)) {
				results.push({
					identifier: ident,
					line: lineIdx,
					startChar: match.index,
					endChar: match.index + ident.length,
				});
			}
		}
	}

	return results;
}

/**
 * Optimized string literal stripper — single-pass instead of 4 chained .replace() calls.
 */
function stripStringLiterals(line: string): string {
	let result = '';
	let i = 0;
	const len = line.length;

	while (i < len) {
		const ch = line[i];

		if (ch === '"') {
			// Check for verbatim string @"..."
			if (i + 1 < len && line[i + 1] === '"') {
				i += 2; // skip @"
				while (i < len) {
					if (line[i] === '"' && i + 1 < len && line[i + 1] !== '"') {
						i++; // skip closing "
						break;
					}
					i++; // skip character (including doubled "")
				}
				continue;
			}

			// Check for interpolated string $"..." (treat as regular string)
			if (i > 0 && line[i - 1] === '$') {
				i++; // skip $
			}

			// Regular string "..." — skip contents
			i++; // skip opening "
			while (i < len) {
				if (line[i] === '\\') {
					i += 2; // skip escaped character
				} else if (line[i] === '"') {
					i++; // skip closing "
					break;
				} else {
					i++;
				}
			}
			continue;
		}

		if (ch === "'") {
			// Char literal — skip contents
			i++; // skip opening '
			while (i < len) {
				if (line[i] === '\\') {
					i += 2; // skip escaped character
				} else if (line[i] === "'") {
					i++; // skip closing '
					break;
				} else {
					i++;
				}
			}
			continue;
		}

		result += ch;
		i++;
	}

	return result;
}

/**
 * Sanitizes a namespace segment by removing invalid characters and capitalizing the first letter.
 */
export function sanitizeNamespaceSegment(segment: string): string {
	const cleaned = segment.replace(/[^a-zA-Z0-9._]/g, '');
	return cleaned.charAt(0).toUpperCase() + cleaned.slice(1) || 'MyNamespace';
}

/**
 * Normalizes a file/folder path by ensuring it starts with a single forward slash.
 */
export function normalizePath(filePath: string): string {
	return '/' + filePath.replace(/^\/+/, '');
}

// ============================================================================
// Mediator file type detection
// ============================================================================

/** Which mediator library is used in a file. */
export type MediatorLibrary = 'MediatR' | 'MitMediator';

/** What kind of mediator type the file declares. */
export type MediatorFileKind = 'request' | 'notification';

/**
 * Describes a mediator type found in a .cs file.
 */
export interface MediatorFileInfo {
	/** The declared class name (e.g. "GetAuthorsQuery") */
	className: string;
	/** What the class inherits from */
	kind: MediatorFileKind;
	/** Which library's namespace is imported */
	library: MediatorLibrary;
	/**
	 * For IRequest<T>: the return type string (e.g. "List<Author>").
	 * null for void IRequest / IRequest<Unit>.
	 */
	returnType: string | null;
}

/**
 * One class/record/struct declaration header found in a file: the type name, plus the
 * `[start, end)` range of its base-type list (from right after the name to the first
 * `where` constraint clause or opening `{`, whichever comes first). Scoping interface
 * lookups to this range — rather than the whole file — avoids false matches inside
 * `where TRequest : IRequest<TResponse>` generic constraints (a very common MediatR
 * `IPipelineBehavior<TRequest, TResponse>` pattern), which are NOT part of the base list.
 */
interface ClassDeclarationHeader {
	name: string;
	headerStart: number;
	headerEnd: number;
}

const CLASS_DECLARATION_REGEX = /(?:public|internal|sealed)\s+(?:sealed\s+)?(?:readonly\s+)?(?:record\s+struct|record|class|struct)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

function findClassDeclarationHeaders(content: string): ClassDeclarationHeader[] {
	const headers: ClassDeclarationHeader[] = [];
	const regex = new RegExp(CLASS_DECLARATION_REGEX);
	let match: RegExpExecArray | null;
	while ((match = regex.exec(content)) !== null) {
		const headerStart = match.index + match[0].length;
		const braceIndex = content.indexOf('{', headerStart);
		const searchEnd = braceIndex === -1 ? content.length : braceIndex;
		const whereMatch = /\bwhere\b/.exec(content.slice(headerStart, searchEnd));
		const headerEnd = whereMatch ? headerStart + whereMatch.index : searchEnd;
		headers.push({ name: match[1], headerStart, headerEnd });
	}
	return headers;
}

/**
 * Same balanced-bracket extraction as `extractGenericInterfaceArgument`, but only looks
 * for `interfaceName<` within `content.slice(rangeStart, rangeEnd)` (typically a single
 * class's base-type list from `findClassDeclarationHeaders`), not the whole file.
 */
function findInterfaceArgsInRange(
	content: string,
	interfaceName: string,
	rangeStart: number,
	rangeEnd: number
): string | undefined {
	const pattern = new RegExp(`\\b${escapeRegExp(interfaceName)}\\s*<`);
	const match = pattern.exec(content.slice(rangeStart, rangeEnd));
	if (!match) {
		return undefined;
	}

	const start = rangeStart + match.index + match[0].length;
	let depth = 1;
	let i = start;
	while (i < content.length && depth > 0) {
		const ch = content[i];
		if (ch === '<') {
			depth++;
		} else if (ch === '>') {
			depth--;
		}
		i++;
	}

	if (depth !== 0) {
		return undefined;
	}

	return content.slice(start, i - 1).trim();
}

/**
 * Inspects the content of a .cs file and returns mediator type information for the
 * first class/record/struct that implements `IRequest<T>`, `IRequest`, or
 * `INotification` (from MediatR or MitMediator) IN ITS OWN base-type list.
 *
 * Returns null if the file doesn't look like a mediator type file. Deliberately does
 * NOT match a type mentioned only in a `where` generic constraint clause (e.g. a
 * `IPipelineBehavior<TRequest, TResponse> where TRequest : IRequest<TResponse>` behavior
 * class is not itself a request).
 */
export function detectMediatorFile(content: string): MediatorFileInfo | null {
	// Determine library from using directives
	const hasMediatR    = /^\s*using\s+MediatR\s*;/m.test(content);
	const hasMitMediator = /^\s*using\s+MitMediator\s*;/m.test(content);

	if (!hasMediatR && !hasMitMediator) {
		return null;
	}
	const library: MediatorLibrary = hasMitMediator ? 'MitMediator' : 'MediatR';

	for (const header of findClassDeclarationHeaders(content)) {
		const headerSlice = content.slice(header.headerStart, header.headerEnd);

		// INotification (no generic)
		if (/\bINotification\b(?!\s*<)/.test(headerSlice)) {
			return { className: header.name, kind: 'notification', library, returnType: null };
		}

		// IRequest<T>
		const rt = findInterfaceArgsInRange(content, 'IRequest', header.headerStart, header.headerEnd);
		if (rt !== undefined) {
			// Unit means void
			const returnType = (rt === 'Unit') ? null : rt;
			return { className: header.name, kind: 'request', library, returnType };
		}

		// IRequest (void, no generic)
		if (/\bIRequest\b(?!\s*<)/.test(headerSlice)) {
			return { className: header.name, kind: 'request', library, returnType: null };
		}
	}

	return null;
}