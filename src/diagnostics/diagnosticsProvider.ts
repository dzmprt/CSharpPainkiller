import * as vscode from 'vscode';

// ============================================================================
// Diagnostic codes
// ============================================================================

export const DIAGNOSTIC_SOURCE = 'CSharp Painkiller';

export const DIAGNOSTIC_CODE_NAMESPACE = 'wrong-namespace';
export const DIAGNOSTIC_CODE_FILENAME = 'wrong-filename';
export const DIAGNOSTIC_CODE_UNSORTED_USINGS = 'unsorted-usings';
export const DIAGNOSTIC_CODE_MIXED_LANGUAGE = 'mixed-language-identifier';

// ============================================================================
// Scheduler import — handles batch processing and debounce optimization
// ============================================================================
import { runDiagnosticsInBatches } from './scheduler.js';

// ============================================================================
// Content parser and namespace utilities (static imports)
// ============================================================================
import { extractFileNamespace, getTypeNameForFileDiagnostic, hasPartialTypes, findMixedLanguageIdentifiers } from '../utils/contentParser.js';
import { deriveNamespaceFromFile } from '../namespace/compute.js';
import { isPathExcluded } from '../utils/fileUtils.js';

// ============================================================================
// Optimization #4: Content-based caching — avoids redundant analysis
// ============================================================================
import { fastContentHash } from '../utils/contentHash.js';

/** Cache entry: hash of file content + precomputed diagnostics array. */
interface DiagnosticCacheEntry {
	hash: string;
	diagnostics: vscode.Diagnostic[];
}

/** Global cache keyed by URI → last analyzed content hash and result. */
const analysisCache = new Map<string, DiagnosticCacheEntry>();

/**
 * Get cached diagnostics for a file if the content hash matches.
 */
function getCachedDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] | null {
	const entry = analysisCache.get(uri.toString());
	if (entry) {
		return entry.diagnostics; // Cache hit — return precomputed diagnostics instantly.
	}
	return null;
}

/**
 * Store computed diagnostics in the content-based cache.
 */
function storeCachedDiagnostics(uri: vscode.Uri, hash: string, diagnostics: vscode.Diagnostic[]): void {
	analysisCache.set(uri.toString(), { hash, diagnostics });
}

/**
 * Clear cache for a specific URI (e.g., on file close).
 */
function clearCacheForUri(uri: vscode.Uri): void {
	analysisCache.delete(uri.toString());
}

// ============================================================================
// Optimization #10: Timing/telemetry — measures each analyzer's duration
// ============================================================================

/** Enable debug timing logging (set via vscode window telemetry or env). */
const DEBUG_TIMING = process.env.NODE_ENV === 'development';

function logTiming(label: string, elapsedMs: number): void {
	if (DEBUG_TIMING) {
		console.debug(`[CSharp Painkiller] ${label}: ${elapsedMs.toFixed(2)}ms`);
	}
}

// ============================================================================
// Optimization #1: Unified single-pass analyzer
// ============================================================================

/** Shared state cached during a single analysis pass. */
interface AnalysisContext {
	readonly uri: vscode.Uri;
	readonly content: string;
	readonly diagnostics: vscode.Diagnostic[];
	/** Whether namespace diagnostic is enabled. */
	namespaceEnabled: boolean;
	/** Whether filename diagnostic is enabled. */
	filenameEnabled: boolean;
	/** whether using sort diagnostic is enabled. */
	unsortedUsingsEnabled: boolean;
	/** Whether mixed-language diagnostic is enabled. */
	mixedLanguageEnabled: boolean;
}

/**
 * Creates a new analysis context for unified single-pass processing.
 * (Optimization #1: all diagnostics are collected in ONE pass over the file.)
 */
function createAnalysisContext(
	uri: vscode.Uri,
	content: string
): AnalysisContext {
	return {
		uri,
		content,
		diagnostics: [],
		namespaceEnabled: isAnalyzerEnabled('wrongNamespace'),
		filenameEnabled: isAnalyzerEnabled('wrongFilename'),
		unsortedUsingsEnabled: isAnalyzerEnabled('unsortedUsings'),
		mixedLanguageEnabled: isAnalyzerEnabled('mixedLanguageIdentifiers'),
	};
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

	const timer = performance.now();
	await analyzeCsFileFromDocument(document, collection);
	logTiming('analyzeCsFile (open doc)', performance.now() - timer);
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

	const timer = performance.now();
	await analyzeCsFile(uri, collection);
	logTiming('analyzeCsFile (URI)', performance.now() - timer);
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
 * Runs diagnostics for all .cs files in the workspace using batch processing.
 * Processes files in batches to limit peak memory usage on large projects.
 */
export async function runDiagnosticsForWorkspace(
	collection: vscode.DiagnosticCollection
): Promise<void> {
	const files = await vscode.workspace.findFiles('**/*.cs', '{**/bin/**,**/obj/**}');
	await runDiagnosticsInBatches(collection, files);
}

// ============================================================================
// Optimization #2: Read content from already-open TextDocument instead of disk.
// ============================================================================

/**
 * Analyzes a file from an already-open TextDocument (avoids disk I/O).
 */
async function analyzeCsFileFromDocument(
	document: vscode.TextDocument,
	collection: vscode.DiagnosticCollection
): Promise<void> {
	const uri = document.uri;

	// Skip excluded paths (bin, obj)
	if (isPathExcluded(uri.path)) {
		collection.delete(uri);
		clearCacheForUri(uri);
		return;
	}

	const content = document.getText(); // ← Free memory access, no disk I/O!
	await runUnifiedAnalysis(uri, content, collection);
}

/**
 * Analyzes a file by reading from disk (fallback for closed files).
 */
async function analyzeCsFile(
	uri: vscode.Uri,
	collection: vscode.DiagnosticCollection
): Promise<void> {
	// Skip excluded paths (bin, obj)
	if (isPathExcluded(uri.path)) {
		collection.delete(uri);
		clearCacheForUri(uri);
		return;
	}

	let content: string;
	try {
		const buf = await vscode.workspace.fs.readFile(uri);
		content = Buffer.from(buf).toString('utf-8');
	} catch {
		collection.delete(uri);
		clearCacheForUri(uri);
		return;
	}

	await runUnifiedAnalysis(uri, content, collection);
}

// ============================================================================
// Unified single-pass analysis (Optimization #1) + Caching (Optimization #4)
// ============================================================================

/**
 * Runs unified single-pass analysis on a .cs file.
 * 
 * This function:
 * - Checks the content-based cache (Optimization #4) — skips analysis entirely if file unchanged
 * - Runs all enabled diagnostics in a SINGLE pass over the content (Optimization #1)
 * - Stores results in cache for next time (Optimization #4)
 */
async function runUnifiedAnalysis(
	uri: vscode.Uri,
	content: string,
	collection: vscode.DiagnosticCollection
): Promise<void> {
	// ── Optimization #4: Cache check — skip analysis if content unchanged ──
	const cachedDiagnostics = getCachedDiagnostics(uri);
	if (cachedDiagnostics !== null) {
		collection.set(uri, cachedDiagnostics);
		return; // Cache hit — diagnostics returned instantly.
	}

	// ── Compute content hash for cache storage (Optimization #4) ──
	const contentHash = fastContentHash(content);

	// ── Create unified analysis context (Optimization #1) ──
	const ctx = createAnalysisContext(uri, content);

	// ── Single-pass: run all enabled diagnostics on the unified context ──
	// Namespace analysis must be awaited since it calls deriveNamespaceFromFile (async).
	if (ctx.namespaceEnabled) {
		const t0 = performance.now();
		await analyzeNamespaceUnified(ctx);
		logTiming('  namespace', performance.now() - t0);
	}

	if (ctx.filenameEnabled) {
		const t0 = performance.now();
		analyzeFileNameUnified(ctx);
		logTiming('  filename', performance.now() - t0);
	}

	if (ctx.unsortedUsingsEnabled) {
		const t0 = performance.now();
		analyzeUsingSortingUnified(ctx);
		logTiming('  usings', performance.now() - t0);
	}

	if (ctx.mixedLanguageEnabled) {
		const t0 = performance.now();
		analyzeMixedLanguageUnified(ctx);
		logTiming('  mixed-lang', performance.now() - t0);
	}

	const diagnostics = ctx.diagnostics;

	// ── Optimization #4: Store in cache for next analysis pass ──
	storeCachedDiagnostics(uri, contentHash, diagnostics);

	collection.set(uri, diagnostics);
}

// ============================================================================
// Unified diagnostic analyzers (Optimization #1 — all operate on AnalysisContext)
// ============================================================================

/**
 * Namespace analysis (unified — uses AnalysisContext.content).
 * NOTE: deriveNamespaceFromFile is async, so this function must be async.
 */
async function analyzeNamespaceUnified(ctx: AnalysisContext): Promise<void> {
	const content = ctx.content;
	const uri = ctx.uri;

	const actualNamespace = extractFileNamespace(content);
	if (!actualNamespace) {
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

	ctx.diagnostics.push(diagnostic);
}

/**
 * Filename analysis (unified — uses AnalysisContext.content).
 */
function analyzeFileNameUnified(ctx: AnalysisContext): void {
	const content = ctx.content;
	const uri = ctx.uri;

	const pathSegments = uri.path.split('/');
	const fileName = pathSegments[pathSegments.length - 1] ?? '';
	if (!fileName.endsWith('.cs')) {
		return;
	}
	const fileBaseName = fileName.slice(0, -3);

	if (hasPartialTypes(content)) {
		return;
	}

	const typeInfo = getTypeNameForFileDiagnostic(content);

	if (typeInfo === null || typeInfo === 'ambiguous') {
		return;
	}

	if (fileBaseName === typeInfo.name) {
		return;
	}

	const lines = content.split('\n');
	let lineIndex = 0;
	let charStart = 0;
	let charEnd = fileBaseName.length;

	const typePattern = typeInfo.type === 'record struct'
		? '(?:readonly\\s+)?record\\s+struct'
		: typeInfo.type;
	const escapedName = escapeRegExp(typeInfo.name);
	const extraMods = '(?:(?:static|sealed|abstract|partial|readonly)\\s+)*';

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

	ctx.diagnostics.push(diagnostic);
}

/**
 * Using sort analysis (unified — uses AnalysisContext.content).
 */
function analyzeUsingSortingUnified(ctx: AnalysisContext): void {
	const content = ctx.content;

	// Fast path: extract only the using lines and compare them in order.
	const lines = content.split('\n');
	const usingLines: { lineIndex: number; namespace: string }[] = [];

	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^using\s+([\w.]+)\s*;$/);
		if (m) {
			usingLines.push({ lineIndex: i, namespace: m[1] });
		}
	}

	// If fewer than 2 usings, they are always sorted.
	if (usingLines.length < 2) {
		return;
	}

	// Check if using lines are in alphabetical order by namespace.
	let isSorted = true;
	for (let i = 1; i < usingLines.length; i++) {
		if (usingLines[i].namespace.localeCompare(usingLines[i - 1].namespace) < 0) {
			isSorted = false;
			break;
		}
	}

	if (isSorted) {
		return;
	}

	// Report on the first unsorted using line.
	const firstUnsorted = usingLines[0];
	const lineText = lines[firstUnsorted.lineIndex];

	const range = new vscode.Range(firstUnsorted.lineIndex, 0, firstUnsorted.lineIndex, lineText.trimEnd().length);
	const diagnostic = new vscode.Diagnostic(
		range,
		'Using directives are not sorted.',
		vscode.DiagnosticSeverity.Warning
	);
	diagnostic.source = DIAGNOSTIC_SOURCE;
	diagnostic.code = DIAGNOSTIC_CODE_UNSORTED_USINGS;

	ctx.diagnostics.push(diagnostic);
}

/**
 * Mixed-language identifier analysis (unified — uses AnalysisContext.content).
 */
function analyzeMixedLanguageUnified(ctx: AnalysisContext): void {
	const content = ctx.content;

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
		ctx.diagnostics.push(diagnostic);
	}
}

// ============================================================================
// Helper functions (kept here for single-file operations)
// ============================================================================

function isAnalyzerEnabled(key: string): boolean {
	const config = vscode.workspace.getConfiguration('csharppainkiller.diagnostics');
	return config.get<boolean>(key, true);
}

function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Clear the entire analysis cache (call on extension deactivate or settings change).
 */
export function clearDiagnosticsCache(): void {
	analysisCache.clear();
}

/**
 * Clear diagnostics cache for a specific URI.
 */
export function clearDiagnosticsCacheForUri(uri: vscode.Uri): void {
	analysisCache.delete(uri.toString());
}