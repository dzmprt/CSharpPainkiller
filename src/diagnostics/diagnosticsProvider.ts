import * as vscode from 'vscode';

// ============================================================================
// Diagnostic codes
// ============================================================================

export const DIAGNOSTIC_SOURCE = 'CSharp Painkiller';

export const DIAGNOSTIC_CODE_NAMESPACE = 'wrong-namespace';
export const DIAGNOSTIC_CODE_FILENAME = 'wrong-filename';
export const DIAGNOSTIC_CODE_UNSORTED_USINGS = 'unsorted-usings';
export const DIAGNOSTIC_CODE_MIXED_LANGUAGE = 'mixed-language-identifier';
export const DIAGNOSTIC_CODE_DUPLICATE_TYPE_NAME = 'duplicate-type-name';

// ============================================================================
// Scheduler import — handles batch processing and debounce optimization
// ============================================================================
import { runDiagnosticsInBatches } from './scheduler.js';

// ============================================================================
// Content parser and namespace utilities (static imports)
// ============================================================================
import {
	extractFileNamespace,
	getTypeNameForFileDiagnostic,
	hasPartialTypes,
	findMixedLanguageIdentifiers,
	extractTypesFromContent,
} from '../utils/contentParser.js';
import { deriveNamespaceFromFile } from '../namespace/compute.js';
import { isPathExcluded } from '../utils/fileUtils.js';
import { collectTopLevelUsingBlock, isUsingOrderSorted } from '../utils/usingBlock.js';
import { ProjectTypeIndex } from '../utils/projectTypeIndex.js';

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
 * Returns null on a miss (no entry, or the file content/analyzer settings changed
 * since the entry was stored) so callers know to re-analyze.
 */
function getCachedDiagnostics(uri: vscode.Uri, hash: string): vscode.Diagnostic[] | null {
	const entry = analysisCache.get(uri.toString());
	if (entry && entry.hash === hash) {
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
	/** Whether the duplicate-type-name diagnostic is enabled. */
	duplicateTypeNameEnabled: boolean;
}

/**
 * Explicit per-analyzer enable/disable selection. Used to override the persisted
 * `csharppainkiller.diagnostics.*` settings for a single one-off run (e.g. the
 * "Analyze Solution" command), without mutating the user's actual configuration.
 */
export interface AnalyzerSelection {
	wrongNamespace: boolean;
	wrongFilename: boolean;
	unsortedUsings: boolean;
	mixedLanguageIdentifiers: boolean;
	duplicateTypeName: boolean;
}

/**
 * Creates a new analysis context for unified single-pass processing.
 * (Optimization #1: all diagnostics are collected in ONE pass over the file.)
 * When `overrides` is provided, it takes precedence over the persisted settings.
 */
function createAnalysisContext(
	uri: vscode.Uri,
	content: string,
	overrides?: AnalyzerSelection,
	isWorkspaceAnalysis = false
): AnalysisContext {
	return {
		uri,
		content,
		diagnostics: [],
		namespaceEnabled: overrides ? overrides.wrongNamespace : isAnalyzerEnabled('wrongNamespace'),
		filenameEnabled: overrides ? overrides.wrongFilename : isAnalyzerEnabled('wrongFilename'),
		unsortedUsingsEnabled: overrides ? overrides.unsortedUsings : isAnalyzerEnabled('unsortedUsings'),
		mixedLanguageEnabled: overrides ? overrides.mixedLanguageIdentifiers : isAnalyzerEnabled('mixedLanguageIdentifiers'),
		duplicateTypeNameEnabled: isWorkspaceAnalysis && (overrides ? overrides.duplicateTypeName : isAnalyzerEnabled('duplicateTypeName')),
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
	collection: vscode.DiagnosticCollection,
	overrides?: AnalyzerSelection,
	isWorkspaceAnalysis = false
): Promise<void> {
	if (!uri.path.endsWith('.cs')) {
		return;
	}
	if (uri.scheme !== 'file') {
		return;
	}

	const timer = performance.now();
	await analyzeCsFile(uri, collection, overrides, isWorkspaceAnalysis);
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

/** Options controlling a solution-wide diagnostics run. */
export interface WorkspaceAnalysisOptions {
	/** Which analyzers to run; defaults to the persisted settings when omitted. */
	overrides?: AnalyzerSelection;
	/** Allows the caller (e.g. a progress notification) to cancel the scan between batches. */
	token?: vscode.CancellationToken;
	/** Invoked after each batch with the running total of processed/total files. */
	onProgress?: (processed: number, total: number) => void;
}

/** Result summary of a solution-wide diagnostics run. */
export interface WorkspaceAnalysisResult {
	processed: number;
	total: number;
	cancelled: boolean;
	diagnosticCount: number;
}

/**
 * Runs diagnostics for all .cs files in the workspace using batch processing.
 * Processes files in batches to limit peak memory usage on large projects.
 * Supports an explicit analyzer selection, cancellation, and progress reporting —
 * used by the "Analyze Solution" command for an on-demand deep scan (as opposed to
 * the lightweight open-files-only live diagnostics).
 */
export async function runDiagnosticsForWorkspace(
	collection: vscode.DiagnosticCollection,
	options?: WorkspaceAnalysisOptions
): Promise<WorkspaceAnalysisResult> {
	const files = await vscode.workspace.findFiles('**/*.cs', '{**/bin/**,**/obj/**}');
	const { processed, cancelled } = await runDiagnosticsInBatches(collection, files, {
		overrides: options?.overrides,
		token: options?.token,
		onProgress: options?.onProgress,
	});

	let diagnosticCount = 0;
	collection.forEach((_uri, diagnostics) => {
		diagnosticCount += diagnostics.length;
	});

	return { processed, total: files.length, cancelled, diagnosticCount };
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
	collection: vscode.DiagnosticCollection,
	overrides?: AnalyzerSelection,
	isWorkspaceAnalysis = false
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

	await runUnifiedAnalysis(uri, content, collection, overrides, isWorkspaceAnalysis);
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
	collection: vscode.DiagnosticCollection,
	overrides?: AnalyzerSelection,
	isWorkspaceAnalysis = false
): Promise<void> {
	// ── Create unified analysis context (Optimization #1) — also reads enabled-analyzer settings ──
	const ctx = createAnalysisContext(uri, content, overrides, isWorkspaceAnalysis);

	// ── Compute cache key from BOTH content and enabled-analyzer flags (Optimization #4) ──
	// Including the flags ensures toggling a `csharppainkiller.diagnostics.*` setting invalidates
	// stale cache entries even when the file content itself hasn't changed.
	const contentHash = fastContentHash(
		`${content}\u0000${ctx.namespaceEnabled}${ctx.filenameEnabled}${ctx.unsortedUsingsEnabled}${ctx.mixedLanguageEnabled}` +
		`${ctx.duplicateTypeNameEnabled}`
	);

	// ── Optimization #4: Cache check — skip analysis if content+settings unchanged ──
	const cachedDiagnostics = getCachedDiagnostics(uri, contentHash);
	if (cachedDiagnostics !== null) {
		collection.set(uri, cachedDiagnostics);
		return; // Cache hit — diagnostics returned instantly.
	}

	// ── Keep the cross-file project index fresh with this file's latest content BEFORE
	// running the duplicate-type-name analyzer that depends on it, so unsaved edits are
	// reflected without waiting for a save + file-watcher event. Cheap (sync, no I/O) —
	// only runs on a cache miss, i.e. only when this file's content actually changed.
	if (isWorkspaceAnalysis && ctx.duplicateTypeNameEnabled) {
		const projectTypeIndex = ProjectTypeIndex.getInstance();
		await projectTypeIndex.waitUntilInitialized();
		projectTypeIndex.updateFileContent(uri, content);
	}

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

	if (ctx.duplicateTypeNameEnabled) {
		const t0 = performance.now();
		analyzeDuplicateTypeNameUnified(ctx);
		logTiming('  duplicate-type-name', performance.now() - t0);
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
 * Uses the same canonical order as the "Sort Usings" command (global → System.* →
 * other namespaces → static → alias, then alphabetically) so the diagnostic never
 * disagrees with what the quick fix actually produces.
 */
function analyzeUsingSortingUnified(ctx: AnalysisContext): void {
	const content = ctx.content;

	const usingBlock = collectTopLevelUsingBlock(content);
	if (!usingBlock || usingBlock.directives.length < 2) {
		return; // No using block, or fewer than 2 directives — always considered sorted.
	}

	if (isUsingOrderSorted(usingBlock.directives)) {
		return;
	}

	// Report on the first using directive in the block — that's where a user would
	// look first to fix the ordering.
	const first = usingBlock.directives[0];
	const lineIndex = content.slice(0, first.start).split('\n').length - 1;

	const range = new vscode.Range(lineIndex, 0, lineIndex, first.fullText.trimEnd().length);
	const diagnostic = new vscode.Diagnostic(
		range,
		'Using directives are not sorted (expected order: System.* first, then other namespaces alphabetically).',
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

/**
 * Finds the line/column range of a `class`/`record`/`struct` declaration's name in
 * `content`, falling back to line 0 / the full name length if not found (keeps the
 * diagnostic range best-effort rather than failing outright).
 */
function findTypeDeclarationRange(content: string, typeName: string): vscode.Range {
	const lines = content.split('\n');
	const escapedName = escapeRegExp(typeName);
	const declarationRegex = new RegExp(`\\b(?:class|record|struct)\\s+(${escapedName})\\b`);

	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(declarationRegex);
		if (match && match.index !== undefined) {
			const charStart = lines[i].indexOf(typeName, match.index);
			if (charStart >= 0) {
				return new vscode.Range(i, charStart, i, charStart + typeName.length);
			}
		}
	}

	return new vscode.Range(0, 0, 0, typeName.length);
}

/**
 * Duplicate-type-name analysis (unified — cross-file via `ProjectTypeIndex`).
 * Flags each type declared in this file that is also declared in another file within
 * the same project (scoped per-project, so identically-named types in different
 * projects of the same solution are not flagged).
 */
function analyzeDuplicateTypeNameUnified(ctx: AnalysisContext): void {
	const { types } = extractTypesFromContent(ctx.content);
	if (types.length === 0) {
		return;
	}

	const index = ProjectTypeIndex.getInstance();
	for (const type of types) {
		if (!index.hasDuplicateTypeInProject(ctx.uri, type.name)) {
			continue;
		}

		const range = findTypeDeclarationRange(ctx.content, type.name);
		const diagnostic = new vscode.Diagnostic(
			range,
			`Type '${type.name}' is also declared in another file within this project.`,
			vscode.DiagnosticSeverity.Warning
		);
		diagnostic.source = DIAGNOSTIC_SOURCE;
		diagnostic.code = DIAGNOSTIC_CODE_DUPLICATE_TYPE_NAME;
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