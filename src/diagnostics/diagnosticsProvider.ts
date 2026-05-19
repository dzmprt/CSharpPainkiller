import * as vscode from 'vscode';
import { extractFileNamespace, getTypeNameForFileDiagnostic, hasPartialTypes, findMixedLanguageIdentifiers } from '../utils/contentParser.js';
import { deriveNamespaceFromFile } from '../namespace/compute.js';
import { isPathExcluded } from '../utils/fileUtils.js';
import { sortUsingsInContent } from '../services/sortUsings.js';

// ============================================================================
// Diagnostic codes
// ============================================================================

export const DIAGNOSTIC_SOURCE = 'CSharp Painkiller';

export const DIAGNOSTIC_CODE_NAMESPACE = 'wrong-namespace';
export const DIAGNOSTIC_CODE_FILENAME = 'wrong-filename';
export const DIAGNOSTIC_CODE_UNSORTED_USINGS = 'unsorted-usings';
export const DIAGNOSTIC_CODE_MIXED_LANGUAGE = 'mixed-language-identifier';

// ============================================================================
// Configuration helpers
// ============================================================================

function isAnalyzerEnabled(key: string): boolean {
	const config = vscode.workspace.getConfiguration('csharppainkiller.diagnostics');
	return config.get<boolean>(key, true);
}

// ============================================================================
// Diagnostics provider
// ============================================================================

/**
 * Analyzes a single .cs file and returns diagnostics.
 */
async function analyzeCsFile(
	uri: vscode.Uri,
	collection: vscode.DiagnosticCollection
): Promise<void> {
	// Skip excluded paths (bin, obj)
	if (isPathExcluded(uri.path)) {
		collection.delete(uri);
		return;
	}

	let content: string;
	try {
		const buf = await vscode.workspace.fs.readFile(uri);
		content = Buffer.from(buf).toString('utf-8');
	} catch {
		collection.delete(uri);
		return;
	}

	const diagnostics: vscode.Diagnostic[] = [];

	// --- Analysis 1: namespace matches file path ---
	if (isAnalyzerEnabled('wrongNamespace')) {
		await analyzeNamespace(uri, content, diagnostics);
	}

	// --- Analysis 2: filename matches public/internal type ---
	if (isAnalyzerEnabled('wrongFilename')) {
		analyzeFileName(uri, content, diagnostics);
	}

	// --- Analysis 3: using directives are sorted ---
	if (isAnalyzerEnabled('unsortedUsings')) {
		analyzeUsingSorting(uri, content, diagnostics);
	}

	// --- Analysis 4: identifiers use mixed/non-Latin scripts ---
	if (isAnalyzerEnabled('mixedLanguageIdentifiers')) {
		analyzeMixedLanguageIdentifiers(content, diagnostics);
	}

	collection.set(uri, diagnostics);
}

/**
 * Checks that the namespace in the file matches the expected namespace
 * derived from the file's path relative to the .csproj.
 */
async function analyzeNamespace(
	uri: vscode.Uri,
	content: string,
	diagnostics: vscode.Diagnostic[]
): Promise<void> {
	const actualNamespace = extractFileNamespace(content);
	if (!actualNamespace) {
		// No namespace declaration – skip
		return;
	}

	let expectedNamespace: string;
	try {
		expectedNamespace = await deriveNamespaceFromFile(uri);
	} catch {
		return;
	}

	if (actualNamespace === expectedNamespace) {
		return;
	}

	// Find the position of the namespace declaration in the file
	const lines = content.split('\n');
	let lineIndex = 0;
	let charStart = 0;
	let charEnd = 0;
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(/^(\s*)namespace\s+([\w.]+)/);
		if (match) {
			lineIndex = i;
			charStart = match[1].length + 'namespace '.length;
			charEnd = charStart + match[2].length;
			break;
		}
	}

	const range = new vscode.Range(lineIndex, charStart, lineIndex, charEnd);
	const diagnostic = new vscode.Diagnostic(
		range,
		`Namespace '${actualNamespace}' does not match expected '${expectedNamespace}' based on file path.`,
		vscode.DiagnosticSeverity.Warning
	);
	diagnostic.source = DIAGNOSTIC_SOURCE;
	diagnostic.code = DIAGNOSTIC_CODE_NAMESPACE;

	diagnostics.push(diagnostic);
}

/**
 * Checks that the filename (without extension) matches the public or internal type name.
 */
function analyzeFileName(
	uri: vscode.Uri,
	content: string,
	diagnostics: vscode.Diagnostic[]
): void {
	const pathSegments = uri.path.split('/');
	const fileName = pathSegments[pathSegments.length - 1] ?? '';
	if (!fileName.endsWith('.cs')) {
		return;
	}
	const fileBaseName = fileName.slice(0, -3); // remove .cs

	// Skip files with partial types — they intentionally split one type across multiple files
	if (hasPartialTypes(content)) {
		return;
	}

	const typeInfo = getTypeNameForFileDiagnostic(content);

	if (typeInfo === null || typeInfo === 'ambiguous') {
		// Can't determine which type should match
		return;
	}

	if (fileBaseName === typeInfo.name) {
		return;
	}

	// Point to the first line of the file as the diagnostic location (or find the type declaration)
	const lines = content.split('\n');
	let lineIndex = 0;
	let charStart = 0;
	let charEnd = fileBaseName.length;

	// Try to find the type declaration line.
	// Search for the specific access modifier + type keyword + name combination,
	// so that we always point to the correct declaration even when multiple types
	// with different visibilities are present in the file.
	// For "record struct" the keyword pattern covers both "record struct" and
	// "readonly record struct".
	const typePattern = typeInfo.type === 'record struct'
		? '(?:readonly\\s+)?record\\s+struct'
		: typeInfo.type;
	const escapedName = escapeRegExp(typeInfo.name);
	// Extra modifiers that may appear between access modifier and type keyword
	const extraMods = '(?:(?:static|sealed|abstract|partial|readonly)\\s+)*';

	// Try public first, then internal (mirrors getTypeNameForFileDiagnostic priority).
	const candidatePatterns = [
		new RegExp(`public\\s+${extraMods}${typePattern}\\s+(${escapedName})(?![a-zA-Z0-9_])`),
		new RegExp(`internal\\s+${extraMods}${typePattern}\\s+(${escapedName})(?![a-zA-Z0-9_])`),
	];

	for (let i = 0; i < lines.length; i++) {
		let found = false;
		for (const re of candidatePatterns) {
			const match = lines[i].match(re);
			if (match && match[1]) {
				lineIndex = i;
				const nameStart = lines[i].indexOf(typeInfo.name, match.index ?? 0);
				charStart = nameStart >= 0 ? nameStart : 0;
				charEnd = charStart + typeInfo.name.length;
				found = true;
				break;
			}
		}
		if (found) {
			break;
		}
	}

	const range = new vscode.Range(lineIndex, charStart, lineIndex, charEnd);
	const diagnostic = new vscode.Diagnostic(
		range,
		`File name '${fileName}' does not match type name '${typeInfo.name}'. Expected file name: '${typeInfo.name}.cs'.`,
		vscode.DiagnosticSeverity.Warning
	);
	diagnostic.source = DIAGNOSTIC_SOURCE;
	diagnostic.code = DIAGNOSTIC_CODE_FILENAME;

	diagnostics.push(diagnostic);
}

/**
 * Checks that using directives are sorted (System.* → Microsoft.* → other, alphabetically within groups).
 * Uses the same logic as the "Sort Usings" command to determine whether sorting is needed.
 */
function analyzeUsingSorting(
	uri: vscode.Uri,
	content: string,
	diagnostics: vscode.Diagnostic[]
): void {
	// sortUsingsInContent returns undefined if no changes are needed (already sorted / no usings)
	const sorted = sortUsingsInContent(content);
	if (sorted === undefined) {
		return;
	}

	// Find the first using directive line to attach the diagnostic
	const lines = content.split('\n');
	let firstUsingLine = 0;
	let firstUsingStart = 0;
	let firstUsingEnd = 0;
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^(using\s+)([\w.]+)\s*;/);
		if (m) {
			firstUsingLine = i;
			firstUsingStart = 0;
			firstUsingEnd = lines[i].trimEnd().length;
			break;
		}
	}

	const range = new vscode.Range(firstUsingLine, firstUsingStart, firstUsingLine, firstUsingEnd);
	const diagnostic = new vscode.Diagnostic(
		range,
		'Using directives are not sorted.',
		vscode.DiagnosticSeverity.Warning
	);
	diagnostic.source = DIAGNOSTIC_SOURCE;
	diagnostic.code = DIAGNOSTIC_CODE_UNSORTED_USINGS;

	// Attach the URI so the quick-fix can reference it
	(diagnostic as vscode.Diagnostic & { _uri?: vscode.Uri })._uri = uri;

	diagnostics.push(diagnostic);
}

/**
 * Checks that all identifiers in the file use a single script (no mixing of
 * Latin with Cyrillic, Greek, Arabic, etc.).
 * Flags identifiers that contain non-Latin or mixed-script characters.
 */
function analyzeMixedLanguageIdentifiers(
	content: string,
	diagnostics: vscode.Diagnostic[]
): void {
	const occurrences = findMixedLanguageIdentifiers(content);
	for (const occ of occurrences) {
		const range = new vscode.Range(occ.line, occ.startChar, occ.line, occ.endChar);
		const diagnostic = new vscode.Diagnostic(
			range,
			`Identifier '${occ.identifier}' contains non-Latin or mixed-script characters. Use Latin letters for identifiers.`,
			vscode.DiagnosticSeverity.Warning
		);
		diagnostic.source = DIAGNOSTIC_SOURCE;
		diagnostic.code = DIAGNOSTIC_CODE_MIXED_LANGUAGE;
		diagnostics.push(diagnostic);
	}
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Runs diagnostics on the given document if it is a .cs file.
 */
export async function runDiagnosticsForDocument(
	document: vscode.TextDocument,
	collection: vscode.DiagnosticCollection
): Promise<void> {
	if (document.languageId !== 'csharp' && !document.uri.path.endsWith('.cs')) {
		return;
	}
	if (document.uri.scheme !== 'file') {
		return;
	}
	await analyzeCsFile(document.uri, collection);
}

/**
 * Runs diagnostics on a file URI (used when files change on disk without being open).
 */
export async function runDiagnosticsForUri(
	uri: vscode.Uri,
	collection: vscode.DiagnosticCollection
): Promise<void> {
	if (!uri.path.endsWith('.cs')) {
		return;
	}
	if (uri.scheme !== 'file') {
		return;
	}
	await analyzeCsFile(uri, collection);
}

/**
 * Runs diagnostics on all .cs files currently open in the editor.
 */
export async function runDiagnosticsForOpenEditors(
	collection: vscode.DiagnosticCollection
): Promise<void> {
	const promises = vscode.workspace.textDocuments
		.filter(doc => doc.uri.scheme === 'file' && doc.uri.path.endsWith('.cs'))
		.map(doc => analyzeCsFile(doc.uri, collection));
	await Promise.all(promises);
}

/**
 * Runs diagnostics for all .cs files in the workspace.
 * Called on activation to populate initial diagnostics.
 */
export async function runDiagnosticsForWorkspace(
	collection: vscode.DiagnosticCollection
): Promise<void> {
	const files = await vscode.workspace.findFiles('**/*.cs', '{**/bin/**,**/obj/**}');
	const promises = files.map(uri => analyzeCsFile(uri, collection));
	await Promise.all(promises);
}

// ============================================================================
// Helpers
// ============================================================================

function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
