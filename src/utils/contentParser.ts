import { type CType, type TypeDefinition, type TypeExtractionResult, type TypeSearchResult } from '../types.js';

// ============================================================================
// Namespace extraction
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
 * Extracts the namespace from file content.
 */
export function extractFileNamespace(content: string): string | undefined {
	const match = stripBom(content).match(NAMESPACE_REGEX);
	return match ? match[2] : undefined;
}

/**
 * Extracts the namespace with its leading whitespace from file content.
 */
export function extractFileNamespaceWithIndent(content: string): { namespace: string; indent: string } | undefined {
	const match = stripBom(content).match(NAMESPACE_REGEX);
	return match ? { namespace: match[2], indent: match[1] } : undefined;
}

// ============================================================================
// Using directive extraction
// ============================================================================

/**
 * Extracts all using directives from file content.
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

// ============================================================================
// Type extraction from file content
// ============================================================================

/**
 * Extracts type definitions from file content along with the namespace.
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
		// File-scoped namespace - extract types that follow
		const typeRegex = /(?<![a-zA-Z_])(public|internal)?\s*(readonly\s+record\s+struct\s+)?(class|record|struct|enum|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
		let match;
		while ((match = typeRegex.exec(normalised)) !== null) {
			const isRecordStruct = match[2] !== undefined;
			if (isRecordStruct) {
				types.push({ name: match[4], type: 'record struct', namespace: fileScopedMatch[1] });
			} else {
				types.push({ name: match[4], type: match[3] as CType, namespace: fileScopedMatch[1] });
			}
		}
	} else {
		// Block-scoped namespace - extract types within each namespace block
		const namespaceBlockRegex = /namespace\s+([\w.]+)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
		let nsMatch;
		while ((nsMatch = namespaceBlockRegex.exec(normalised)) !== null) {
			const ns = nsMatch[1];
			const body = nsMatch[2];

			// Find types within this namespace block
			const typeRegex = /(?<![a-zA-Z_])(public|internal)?\s*(readonly\s+record\s+struct\s+)?(class|record|struct|enum|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
			let typeMatch;
			while ((typeMatch = typeRegex.exec(body)) !== null) {
				const isRecordStruct = typeMatch[2] !== undefined;
				if (isRecordStruct) {
					types.push({ name: typeMatch[4], type: 'record struct', namespace: ns });
				} else {
					types.push({ name: typeMatch[4], type: typeMatch[3] as CType, namespace: ns });
				}
			}
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
		if (matches.length === 0) {
			const typeRegex = new RegExp(
				`public\\s+${EXTRA_MODS}(?:(?:readonly\\s+)?record\\s+struct|(class|record|struct|enum|interface))\\s+([A-Za-z_][A-Za-z0-9_]*)`, 'g'
			);
			while ((match = typeRegex.exec(content)) !== null) {
				// match[1] is the simple keyword (undefined when "record struct" matched)
				if (match[1] !== undefined) {
					matches.push({ name: match[2], type: match[1] as CType });
				}
			}
		}
	} else {
		// Search for internal types (explicit "internal" keyword)
		const internalRegex = new RegExp(
			`(?<![a-zA-Z_])internal\\s+${EXTRA_MODS}((?:readonly\\s+)?record\\s+struct\\s+)?(class|record|struct|enum|interface)\\s+([A-Za-z_][A-Za-z0-9_]*)`, 'g'
		);
		let match;
		while ((match = internalRegex.exec(content)) !== null) {
			const typeName = match[3];
			const isRecordStruct = match[1] !== undefined;
			if (isRecordStruct) {
				matches.push({ name: typeName, type: 'record struct' });
			} else {
				matches.push({ name: typeName, type: match[2] as CType });
			}
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
	const internalRegex = new RegExp(
		`(?<![a-zA-Z_])internal\\s+${EXTRA_MODS}((?:readonly\\s+)?record\\s+struct\\s+)?(class|record|struct|enum|interface)\\s+([A-Za-z_][A-Za-z0-9_]*)`, 'g'
	);
	let match;
	while ((match = internalRegex.exec(content)) !== null) {
		const isRecordStruct = match[1] !== undefined;
		internalMatches.push({
			name: match[3],
			type: isRecordStruct ? 'record struct' : match[2] as CType,
		});
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

// ============================================================================
// Mixed-language identifier detection
// ============================================================================

/**
 * Unicode script ranges used to detect identifier scripts.
 * Only ranges relevant for programming identifiers are included.
 */
const SCRIPT_RANGES: { name: string; regex: RegExp }[] = [
	{ name: 'latin',     regex: /[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]/ },
	{ name: 'cyrillic',  regex: /[\u0400-\u04FF\u0500-\u052F]/ },
	{ name: 'greek',     regex: /[\u0370-\u03FF\u1F00-\u1FFF]/ },
	{ name: 'armenian',  regex: /[\u0530-\u058F]/ },
	{ name: 'georgian',  regex: /[\u10A0-\u10FF]/ },
	{ name: 'arabic',    regex: /[\u0600-\u06FF]/ },
	{ name: 'hebrew',    regex: /[\u0590-\u05FF]/ },
	{ name: 'thai',      regex: /[\u0E00-\u0E7F]/ },
	{ name: 'chinese',   regex: /[\u4E00-\u9FFF\u3400-\u4DBF]/ },
	{ name: 'japanese',  regex: /[\u3040-\u309F\u30A0-\u30FF]/ },
	{ name: 'korean',    regex: /[\uAC00-\uD7AF\u1100-\u11FF]/ },
];

/**
 * Returns the set of scripts found in a single identifier string.
 */
function getIdentifierScripts(identifier: string): Set<string> {
	const found = new Set<string>();
	for (const ch of identifier) {
		for (const { name, regex } of SCRIPT_RANGES) {
			if (regex.test(ch)) {
				found.add(name);
				break;
			}
		}
	}
	return found;
}

/**
 * Returns true if the identifier contains characters from more than one script,
 * or if it contains any non-Latin, non-digit, non-underscore characters
 * (i.e., identifiers that are not pure ASCII / Latin).
 *
 * Both conditions are "mixed-language":
 *   - "МойКласс"          → pure Cyrillic, not mixed → flagged (non-Latin script)
 *   - "MyМетод"           → Latin + Cyrillic → flagged (mixed scripts)
 *   - "MyClass"           → pure Latin → OK
 *   - "_myVar123"         → pure Latin + digits/underscore → OK
 */
function isMixedOrNonLatinIdentifier(identifier: string): boolean {
	const scripts = getIdentifierScripts(identifier);
	// Pure Latin (or no letters at all) → OK
	if (scripts.size === 0 || (scripts.size === 1 && scripts.has('latin'))) {
		return false;
	}
	// Contains any non-Latin script (even pure Cyrillic, Greek, etc.) → flag it
	return true;
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

	// A C# identifier: starts with letter or underscore, then letters/digits/underscores.
	// We extend the character class to include any Unicode letter (\p{L} not available in
	// all JS engines without 'u' flag – use a broad range instead).
	// This regex matches every token that looks like an identifier.
	// We then post-filter with isMixedOrNonLatinIdentifier.
	const IDENTIFIER_RE = /[A-Za-z_\u00C0-\u024F\u0370-\u04FF\u0500-\u052F\u0530-\u05FF\u0590-\u06FF\u0E00-\u0E7F\u1E00-\u1EFF\u1F00-\u1FFF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF][A-Za-z0-9_\u00C0-\u024F\u0370-\u04FF\u0500-\u052F\u0530-\u05FF\u0590-\u06FF\u0E00-\u0E7F\u1E00-\u1EFF\u1F00-\u1FFF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]*/g;

	// C# keywords to skip (they are always Latin so won't be flagged, but skip for clarity)
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
		let line = lines[lineIdx];

		// Handle block comments spanning multiple lines
		if (inBlockComment) {
			const endIdx = line.indexOf('*/');
			if (endIdx === -1) {
				continue; // entire line is inside block comment
			}
			line = line.slice(endIdx + 2);
			inBlockComment = false;
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
				// Block comment started but not closed on this line
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

		// Strip string literals (regular and verbatim) to avoid flagging
		// non-Latin text inside strings.
		// This is a simplified removal – handles most common cases.
		line = stripStringLiterals(line);

		// Now scan for identifiers
		IDENTIFIER_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = IDENTIFIER_RE.exec(line)) !== null) {
			const ident = match[0];
			// Skip pure C# keywords (Latin only, won't be flagged anyway, but skip to be safe)
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
 * Replaces string literal contents with spaces so that non-Latin characters
 * inside strings are not flagged as identifier issues.
 *
 * Handles:
 *  - Regular string literals:  "..."
 *  - Char literals:            '.'
 *  - Verbatim strings:         @"..." (single-line portion only)
 *  - Interpolated strings:     $"..." (strips inner parts)
 *
 * Does NOT handle multi-line verbatim strings (acceptable limitation).
 */
function stripStringLiterals(line: string): string {
	// Replace content of string and char literals with spaces.
	// We use a regex that matches quoted content including escape sequences.
	return line
		// Verbatim strings @"..."
		.replace(/@"(?:[^"]|"")*"/g, (m) => ' '.repeat(m.length))
		// Interpolated strings $"..." (simplified – treats as regular string)
		.replace(/\$"(?:[^"\\]|\\.)*"/g, (m) => ' '.repeat(m.length))
		// Regular strings "..."
		.replace(/"(?:[^"\\]|\\.)*"/g, (m) => ' '.repeat(m.length))
		// Char literals '.'
		.replace(/'(?:[^'\\]|\\.)'/g, (m) => ' '.repeat(m.length));
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
 * Inspects the content of a .cs file and returns mediator type information
 * if the file contains exactly one class that implements IRequest<T>, IRequest,
 * or INotification (from MediatR or MitMediator).
 *
 * Returns null if the file doesn't look like a mediator type file.
 */
export function detectMediatorFile(content: string): MediatorFileInfo | null {
	// Determine library from using directives
	const hasMediatR    = /^\s*using\s+MediatR\s*;/m.test(content);
	const hasMitMediator = /^\s*using\s+MitMediator\s*;/m.test(content);

	if (!hasMediatR && !hasMitMediator) {
		return null;
	}
	const library: MediatorLibrary = hasMitMediator ? 'MitMediator' : 'MediatR';

	// Extract class name — look for the first public/internal/sealed class/struct/record declaration
	const classMatch = content.match(
		/(?:public|internal|sealed)\s+(?:sealed\s+)?(?:readonly\s+)?(?:record\s+struct|record|class|struct)\s+([A-Za-z_][A-Za-z0-9_]*)/
	);
	if (!classMatch) {
		return null;
	}
	const className = classMatch[1];

	// INotification (no generic)
	if (/\bINotification\b(?!\s*<)/.test(content)) {
		return { className, kind: 'notification', library, returnType: null };
	}

	// IRequest<T>
	const requestGenericMatch = content.match(/\bIRequest<([^>]+)>/);
	if (requestGenericMatch) {
		const rt = requestGenericMatch[1].trim();
		// Unit means void
		const returnType = (rt === 'Unit') ? null : rt;
		return { className, kind: 'request', library, returnType };
	}

	// IRequest (void, no generic)
	if (/\bIRequest\b(?!\s*<)/.test(content)) {
		return { className, kind: 'request', library, returnType: null };
	}

	return null;
}