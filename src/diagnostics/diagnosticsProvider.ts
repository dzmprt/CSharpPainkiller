import * as vscode from 'vscode';

// ============================================================================
// Diagnostic codes
// ============================================================================

export const DIAGNOSTIC_SOURCE = 'CSharp Painkiller';

export const DIAGNOSTIC_CODE_NAMESPACE = 'wrong-namespace';
export const DIAGNOSTIC_CODE_FILENAME = 'wrong-filename';
export const DIAGNOSTIC_CODE_MIXED_LANGUAGE = 'mixed-language-identifier';
export const DIAGNOSTIC_CODE_DUPLICATE_TYPE_NAME = 'duplicate-type-name';

// ============================================================================
// Scheduler import — handles batch processing and debounce optimization
// ============================================================================
import { runDiagnosticsInBatches } from './scheduler.js';

// ============================================================================
// Content parser and namespace utilities (static imports)
// ============================================================================
import { findMixedLanguageIdentifiers } from '../utils/contentParser.js';
import { deriveNamespaceFromFile } from '../namespace/compute.js';
import { isPathExcluded } from '../utils/fileUtils.js';
import { csharpLanguageService, type CSharpType } from '../services/csharpLanguageService.js';
import { CsprojCache } from '../utils/csprojCache.js';
import { ErrorHandler } from '../utils/errorHandler.js';

// ============================================================================
// Optimization #4: Content-based caching — avoids redundant analysis
// ============================================================================
import { fastContentHash } from '../utils/contentHash.js';
import { WorkQueue, throwIfCancelled } from '../utils/asyncWork.js';

const analysisQueue = new WorkQueue(4);
interface AnalysisJob {
	uri: string;
	workspace: boolean;
	source: vscode.CancellationTokenSource;
	result: Promise<void>;
}
const jobs = new Set<AnalysisJob>();
const pendingByCollection = new WeakMap<vscode.DiagnosticCollection, Map<string, AnalysisJob>>();
const workspaceAnalysisUris = new Map<string, number>();
const workspaceRunIds = new WeakMap<WorkspaceDuplicateIndex, number>();
let nextWorkspaceRunId = 0;

export type WorkspaceDuplicateIndex = Map<string, {
	document: vscode.TextDocument;
	version: number;
	projectRoot: string | undefined;
	types: CSharpType[];
}>;

export function markWorkspaceAnalysis(uri: vscode.Uri, active: boolean): void {
	const key = uri.toString();
	if (active) {
		for (const job of jobs) { if (job.uri === key && !job.workspace) { job.source.cancel(); } }
	}
	const count = (workspaceAnalysisUris.get(key) ?? 0) + (active ? 1 : -1);
	if (count > 0) { workspaceAnalysisUris.set(key, count); } else { workspaceAnalysisUris.delete(key); }
}

function enqueueAnalysis(
	document: vscode.TextDocument, collection: vscode.DiagnosticCollection,
	overrides?: AnalyzerSelection, isWorkspaceAnalysis = false,
	token?: vscode.CancellationToken, duplicates?: WorkspaceDuplicateIndex,
): Promise<void> {
	throwIfCancelled(token);
	let pending = pendingByCollection.get(collection);
	if (!pending) { pending = new Map(); pendingByCollection.set(collection, pending); }
	const config = vscode.workspace.getConfiguration('csharppainkiller.diagnostics');
	let runId = 0;
	if (duplicates) {
		runId = workspaceRunIds.get(duplicates) ?? ++nextWorkspaceRunId;
		workspaceRunIds.set(duplicates, runId);
	}
	const key = `${document.uri}::${document.version}::${CsprojCache.getInstance().version}::${isWorkspaceAnalysis}::${runId}::` +
		JSON.stringify(overrides ?? ['wrongNamespace', 'wrongFilename', 'mixedLanguageIdentifiers']
			.map(analyzer => config.get(analyzer, true)));
	const previous = pending.get(key);
	if (previous && !previous.source.token.isCancellationRequested) { return previous.result; }
	const source = new vscode.CancellationTokenSource();
	const cancellation = token?.onCancellationRequested(() => source.cancel());
	const result = analysisQueue.run(() => runUnifiedAnalysis(document, collection, overrides, isWorkspaceAnalysis,
		source.token, duplicates), source.token, vscode.window.activeTextEditor?.document === document);
	const job: AnalysisJob = { uri: document.uri.toString(), workspace: isWorkspaceAnalysis, source, result };
	pending.set(key, job);
	jobs.add(job);
	const cleanup = () => {
		if (pending.get(key) === job) { pending.delete(key); }
		jobs.delete(job);
		cancellation?.dispose();
		source.dispose();
	};
	result.then(cleanup, cleanup);
	return result;
}

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
	analysisCache.delete(uri.toString());
	analysisCache.set(uri.toString(), { hash, diagnostics });
	if (analysisCache.size > 2000) { analysisCache.delete(analysisCache.keys().next().value!); }
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
	readonly document: vscode.TextDocument;
	types: CSharpType[];
	symbols: vscode.DocumentSymbol[];
	readonly diagnostics: vscode.Diagnostic[];
	/** Whether namespace diagnostic is enabled. */
	namespaceEnabled: boolean;
	/** Whether filename diagnostic is enabled. */
	filenameEnabled: boolean;
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
	mixedLanguageIdentifiers: boolean;
	duplicateTypeName: boolean;
}

/**
 * Creates a new analysis context for unified single-pass processing.
 * (Optimization #1: all diagnostics are collected in ONE pass over the file.)
 * When `overrides` is provided, it takes precedence over the persisted settings.
 */
function createAnalysisContext(
	document: vscode.TextDocument,
	overrides?: AnalyzerSelection,
	isWorkspaceAnalysis = false
): AnalysisContext {
	return {
		uri: document.uri,
		content: document.getText(),
		document,
		types: [],
		symbols: [],
		diagnostics: [],
		namespaceEnabled: overrides ? overrides.wrongNamespace : isAnalyzerEnabled('wrongNamespace'),
		filenameEnabled: overrides ? overrides.wrongFilename : isAnalyzerEnabled('wrongFilename'),
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
	if (document.uri.scheme !== 'file' || isPathExcluded(document.uri.path)) {
		return;
	}
	if (workspaceAnalysisUris.has(document.uri.toString())) { return; }

	const timer = performance.now();
	try {
		await enqueueAnalysis(document, collection);
	} catch (error) {
		if (error instanceof vscode.CancellationError) { return; }
		collection.delete(document.uri);
		clearCacheForUri(document.uri);
		ErrorHandler.logError('Analyzing C# document', error);
	}
	logTiming('analyzeCsFile (open doc)', performance.now() - timer);
}

/**
 * Runs diagnostics on a file URI (used when files change on disk without being open).
 */
export async function runDiagnosticsForUri(
	uri: vscode.Uri,
	collection: vscode.DiagnosticCollection,
	overrides?: AnalyzerSelection,
	isWorkspaceAnalysis = false,
	token?: vscode.CancellationToken,
	duplicates?: WorkspaceDuplicateIndex,
): Promise<void> {
	if (!uri.path.endsWith('.cs')) {
		return;
	}
	if (uri.scheme !== 'file' || isPathExcluded(uri.path)) {
		return;
	}

	const timer = performance.now();
	throwIfCancelled(token);
	const document = await vscode.workspace.openTextDocument(uri);
	throwIfCancelled(token);
	await enqueueAnalysis(document, collection, overrides, isWorkspaceAnalysis, token, duplicates);
	logTiming('analyzeCsFile (URI)', performance.now() - timer);
}

/**
 * Runs diagnostics on all .cs files currently open in the editor.
 */
export async function runDiagnosticsForOpenEditors(
	collection: vscode.DiagnosticCollection
): Promise<void> {
	const promises = vscode.workspace.textDocuments
		.filter(doc => doc.uri.scheme === 'file' && doc.uri.path.endsWith('.cs') && !isPathExcluded(doc.uri.path))
		.map(doc => runDiagnosticsForDocument(doc, collection));
	await Promise.all(promises);
}

/** Options controlling a solution-wide diagnostics run. */
export interface WorkspaceAnalysisOptions {
	/** Which analyzers to run; defaults to the persisted settings when omitted. */
	overrides?: AnalyzerSelection;
	/** Allows the caller to cancel queued work and in-flight analyzer waits. */
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
 * Uses a shared worker queue to limit peak memory usage on large projects.
 * Supports an explicit analyzer selection, cancellation, and progress reporting —
 * used by the "Analyze Solution" command for an on-demand deep scan (as opposed to
 * the lightweight open-files-only live diagnostics).
 */
export async function runDiagnosticsForWorkspace(
	collection: vscode.DiagnosticCollection,
	options?: WorkspaceAnalysisOptions
): Promise<WorkspaceAnalysisResult> {
	const files = await vscode.workspace.findFiles('**/*.cs', '{**/bin/**,**/obj/**,**/.dotnet/**}', undefined, options?.token);
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
// Content is read from live TextDocuments, including unsaved changes.
// ============================================================================

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
	document: vscode.TextDocument,
	collection: vscode.DiagnosticCollection,
	overrides?: AnalyzerSelection,
	isWorkspaceAnalysis = false,
	token?: vscode.CancellationToken,
	duplicates?: WorkspaceDuplicateIndex,
): Promise<void> {
	// ── Create unified analysis context (Optimization #1) — also reads enabled-analyzer settings ──
	const ctx = createAnalysisContext(document, overrides, isWorkspaceAnalysis);
	const { uri, content } = ctx;
	const version = document.version;
	const projectVersion = CsprojCache.getInstance().version;
	throwIfCancelled(token);

	// ── Compute cache key from BOTH content and enabled-analyzer flags (Optimization #4) ──
	// Including the flags ensures toggling a `csharppainkiller.diagnostics.*` setting invalidates
	// stale cache entries even when the file content itself hasn't changed.
	const contentHash = fastContentHash(
		`${content}\u0000${ctx.namespaceEnabled}${ctx.filenameEnabled}${ctx.mixedLanguageEnabled}` +
		`${ctx.duplicateTypeNameEnabled}::${projectVersion}`
	);

	// ── Optimization #4: Cache check — skip analysis if content+settings unchanged ──
	const cachedDiagnostics = getCachedDiagnostics(uri, contentHash);
	if (cachedDiagnostics !== null && !ctx.duplicateTypeNameEnabled) {
		collection.set(uri, cachedDiagnostics);
		return; // Cache hit — diagnostics returned instantly.
	}

	if (ctx.namespaceEnabled || ctx.filenameEnabled || ctx.duplicateTypeNameEnabled) {
		ctx.symbols = await csharpLanguageService.getSymbols(document, token);
		ctx.types = await csharpLanguageService.getTypes(document, token);
	}

	// ── Single-pass: run all enabled diagnostics on the unified context ──
	// Namespace analysis must be awaited since it calls deriveNamespaceFromFile (async).
	if (ctx.namespaceEnabled) {
		const t0 = performance.now();
		await analyzeNamespaceUnified(ctx);
		throwIfCancelled(token);
		logTiming('  namespace', performance.now() - t0);
	}

	if (ctx.filenameEnabled) {
		const t0 = performance.now();
		analyzeFileNameUnified(ctx);
		logTiming('  filename', performance.now() - t0);
	}

	if (ctx.mixedLanguageEnabled) {
		const t0 = performance.now();
		await analyzeMixedLanguageUnified(ctx, token);
		logTiming('  mixed-lang', performance.now() - t0);
	}

	if (ctx.duplicateTypeNameEnabled) {
		const t0 = performance.now();
		if (duplicates) {
			const projects = CsprojCache.getInstance();
			await projects.getCsprojs();
			duplicates.set(uri.toString(), { document, version,
				projectRoot: projects.findProjectRootForPath(uri.path), types: ctx.types });
		} else {
			await analyzeDuplicateTypeNameUnified(ctx);
		}
		logTiming('  duplicate-type-name', performance.now() - t0);
	}

	const diagnostics = ctx.diagnostics;

	// ── Optimization #4: Store in cache for next analysis pass ──
	throwIfCancelled(token);
	if (document.version !== version || document.isClosed || projectVersion !== CsprojCache.getInstance().version) {
		throw new vscode.CancellationError();
	}
	if (!ctx.duplicateTypeNameEnabled) {
		storeCachedDiagnostics(uri, contentHash, diagnostics);
	}

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
	const uri = ctx.uri;

	const namespaceSymbol = ctx.symbols.find(symbol => symbol.kind === vscode.SymbolKind.Namespace);
	const actualNamespace = namespaceSymbol?.name ?? ctx.types[0]?.namespace;
	if (!actualNamespace) {
		return;
	}

	const expectedNamespace = await deriveNamespaceFromFile(uri);

	if (actualNamespace === expectedNamespace) {
		return;
	}

	const range = namespaceSymbol?.selectionRange ?? ctx.types[0].symbol.selectionRange;
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
	const uri = ctx.uri;

	const pathSegments = uri.path.split('/');
	const fileName = pathSegments[pathSegments.length - 1] ?? '';
	if (!fileName.endsWith('.cs')) {
		return;
	}
	const fileBaseName = fileName.slice(0, -3);

	const types = ctx.types.filter(type => !type.nested);
	if (types.some(type => type.partial)) {
		return;
	}

	const publicTypes = types.filter(type => type.public);
	const candidates = publicTypes.length > 0 ? publicTypes : types.filter(type => type.internal);
	if (candidates.length !== 1) {
		return;
	}
	const typeInfo = candidates[0];

	if (fileBaseName === typeInfo.name) {
		return;
	}

	const range = typeInfo.symbol.selectionRange;
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
 * Mixed-language identifier analysis (unified — uses AnalysisContext.content).
 */
async function analyzeMixedLanguageUnified(ctx: AnalysisContext, token?: vscode.CancellationToken): Promise<void> {
	for (const range of await csharpLanguageService.getIdentifierRanges(ctx.document, undefined, token)) {
		const identifier = ctx.document.getText(range);
		if (findMixedLanguageIdentifiers(identifier).length === 0) { continue; }
		const diagnostic = new vscode.Diagnostic(
			range,
			`Identifier '${identifier}' contains non-Latin or mixed-script characters. Use Latin letters for identifiers.`,
			vscode.DiagnosticSeverity.Warning
		);
		diagnostic.source = DIAGNOSTIC_SOURCE;
		diagnostic.code = DIAGNOSTIC_CODE_MIXED_LANGUAGE;
		ctx.diagnostics.push(diagnostic);
	}
}

export function publishDuplicateTypes(index: WorkspaceDuplicateIndex, collection: vscode.DiagnosticCollection): void {
	const groups = new Map<string, Map<string, Array<{ document: vscode.TextDocument; type: CSharpType }>>>();
	for (const entry of index.values()) {
		if (entry.document.isClosed || entry.document.version !== entry.version) { continue; }
		for (const type of entry.types) {
			if (type.nested) { continue; }
			const key = JSON.stringify([entry.projectRoot, type.name]);
			let files = groups.get(key);
			if (!files) { files = new Map(); groups.set(key, files); }
			const uri = entry.document.uri.toString();
			const declarations = files.get(uri) ?? [];
			declarations.push({ document: entry.document, type });
			files.set(uri, declarations);
		}
	}
	const additions = new Map<string, vscode.Diagnostic[]>();
	for (const files of groups.values()) {
		if (files.size < 2) { continue; }
		for (const [uri, declarations] of files) {
			for (const { type } of declarations) {
				if (type.partial) { continue; }
				const diagnostic = new vscode.Diagnostic(type.symbol.selectionRange,
					`Type '${type.name}' is also declared in another file within this project.`, vscode.DiagnosticSeverity.Warning);
				diagnostic.source = DIAGNOSTIC_SOURCE;
				diagnostic.code = DIAGNOSTIC_CODE_DUPLICATE_TYPE_NAME;
				const diagnostics = additions.get(uri) ?? [];
				diagnostics.push(diagnostic);
				additions.set(uri, diagnostics);
			}
		}
	}
	for (const [uri, entry] of index) {
		if (entry.document.isClosed || entry.document.version !== entry.version) { continue; }
		collection.set(entry.document.uri, [
			...(collection.get(entry.document.uri) ?? []).filter(diagnostic => diagnostic.code !== DIAGNOSTIC_CODE_DUPLICATE_TYPE_NAME),
			...(additions.get(uri) ?? []),
		]);
	}
}

/**
 * Duplicate-type-name analysis using the C# server's workspace index.
 * Flags each type declared in this file that is also declared in another file within
 * the same project (scoped per-project, so identically-named types in different
 * projects of the same solution are not flagged).
 */
async function analyzeDuplicateTypeNameUnified(ctx: AnalysisContext): Promise<void> {
	if (ctx.types.length === 0) {
		return;
	}

	const projects = CsprojCache.getInstance();
	await projects.getCsprojs();
	const projectRoot = projects.findProjectRootForPath(ctx.uri.path);
	for (const type of ctx.types) {
		if (type.nested || type.partial) { continue; }
		const matches = await csharpLanguageService.findTypes(type.name);
		if (!matches.some(symbol => symbol.location.uri.toString() !== ctx.uri.toString() &&
			projects.findProjectRootForPath(symbol.location.uri.path) === projectRoot)) {
			continue;
		}

		const range = type.symbol.selectionRange;
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

/**
 * Clear the entire analysis cache (call on extension deactivate or settings change).
 */
export function clearDiagnosticsCache(): void {
	analysisCache.clear();
	for (const job of jobs) { job.source.cancel(); }
}

/**
 * Clear diagnostics cache for a specific URI.
 */
export function clearDiagnosticsCacheForUri(uri: vscode.Uri): void {
	analysisCache.delete(uri.toString());
	for (const job of jobs) { if (job.uri === uri.toString()) { job.source.cancel(); } }
}
