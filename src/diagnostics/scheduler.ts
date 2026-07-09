import * as vscode from 'vscode';
import { runDiagnosticsForUri, runDiagnosticsForDocument, type AnalyzerSelection } from './diagnosticsProvider.js';

// ============================================================================
// Configuration
// ============================================================================

/** Default batch size for parallel file analysis. */
const DEFAULT_BATCH_SIZE = 50;

/** Default debounce delay in milliseconds for file watcher events. */
const DEFAULT_DEBOUNCE_DELAY = 500;

/** Maximum number of URIs to keep in the debounce queue. */
const MAX_QUEUE_SIZE = 10000;

/** Options for a batched, potentially cancellable diagnostics run over many files. */
export interface BatchAnalysisOptions {
	batchSize?: number;
	overrides?: AnalyzerSelection;
	token?: vscode.CancellationToken;
	onProgress?: (processed: number, total: number) => void;
}

/**
 * Runs diagnostics on all .cs files in the workspace using batch processing.
 * Processes files in batches to limit peak memory usage, and can be cancelled
 * between batches via `options.token` (checked before each batch starts).
 */
export async function runDiagnosticsInBatches(
	collection: vscode.DiagnosticCollection,
	files: vscode.Uri[],
	options?: BatchAnalysisOptions
): Promise<{ processed: number; cancelled: boolean }> {
	const config = vscode.workspace.getConfiguration('csharppainkiller');
	const size = options?.batchSize ?? config.get<number>('diagnosticBatchSize', DEFAULT_BATCH_SIZE);

	let processed = 0;

	for (let i = 0; i < files.length; i += size) {
		if (options?.token?.isCancellationRequested) {
			return { processed, cancelled: true };
		}

		const batch = files.slice(i, i + size);

		// Use static import — avoids repeated dynamic import() overhead.
		await Promise.all(batch.map(uri => runDiagnosticsForUri(uri, collection, options?.overrides)));

		processed += batch.length;
		options?.onProgress?.(processed, files.length);

		// Brief yield to allow GC and reduce peak memory pressure.
		if (i + size < files.length) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
	}

	return { processed, cancelled: false };
}

// ============================================================================
// Debounced file watcher handler
// ============================================================================

/** Internal debounce timer handle. */
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Queue of URIs waiting to be processed. */
const pendingUris: Set<string> = new Set();

/** The diagnostic collection being updated. */
let activeCollection: vscode.DiagnosticCollection | null = null;

/**
 * Schedules diagnostics for a file URI using debounce.
 * Multiple rapid events for different files are coalesced into a single batch analysis.
 */
export function scheduleDiagnosticsForUriChange(
	uri: vscode.Uri,
	collection: vscode.DiagnosticCollection
): void {
	// Initialize shared state on first call
	if (activeCollection === null) {
		activeCollection = collection;
	}

	const key = uri.toString();

	// Guard against unbounded queue growth
	if (!pendingUris.has(key) && pendingUris.size >= MAX_QUEUE_SIZE) {
		return; // Queue is full, skip this URI
	}

	pendingUris.add(key);

	// Get current debounce delay from settings
	const config = vscode.workspace.getConfiguration('csharppainkiller');
	const delay = config.get<number>('diagnosticDebounceDelay', DEFAULT_DEBOUNCE_DELAY);

	// Reset existing debounce timer
	if (debounceTimer !== null) {
		clearTimeout(debounceTimer);
	}

	// Schedule batch processing after debounce delay
	debounceTimer = setTimeout(() => {
		const urisToProcess = [...pendingUris]
			.map(s => vscode.Uri.parse(s))
			.filter(uri => uri.path.endsWith('.cs') && uri.scheme === 'file');

		pendingUris.clear();
		debounceTimer = null;

		if (urisToProcess.length === 0) {
			return;
		}

		// Process batched URIs concurrently (they're few, so Promise.all is fine)
		Promise.all(
			urisToProcess.map(uri => runDiagnosticsForUri(uri, activeCollection!))
		).catch(err => {
			console.error('Diagnostics batch processing error:', err);
		});
	}, delay);
}

/**
 * Clears any pending debounce timer and resets the queue.
 */
export function clearPendingDiagnostics(): void {
	if (debounceTimer !== null) {
		clearTimeout(debounceTimer);
		debounceTimer = null;
	}
	pendingUris.clear();
}

// ============================================================================
// Debounced open-document analysis (edits to already-open editors)
// ============================================================================

/** Per-document debounce timers, keyed by URI string. */
const documentDebounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

/**
 * Schedules re-analysis of an open document after edits, debounced so that
 * rapid keystrokes only trigger a single analysis pass. Reads content from
 * the live document buffer (not disk), so unsaved changes are reflected.
 */
export function scheduleDiagnosticsForDocumentChange(
	document: vscode.TextDocument,
	collection: vscode.DiagnosticCollection
): void {
	const key = document.uri.toString();

	const existing = documentDebounceTimers.get(key);
	if (existing !== undefined) {
		clearTimeout(existing);
	}

	const config = vscode.workspace.getConfiguration('csharppainkiller');
	const delay = config.get<number>('diagnosticDebounceDelay', DEFAULT_DEBOUNCE_DELAY);

	const timer = setTimeout(() => {
		documentDebounceTimers.delete(key);
		runDiagnosticsForDocument(document, collection).catch(err => {
			console.error('Diagnostics document analysis error:', err);
		});
	}, delay);

	documentDebounceTimers.set(key, timer);
}

/**
 * Cancels any pending debounced analysis for a document (e.g. on close).
 */
export function clearDebounceForDocument(document: vscode.TextDocument): void {
	const key = document.uri.toString();
	const timer = documentDebounceTimers.get(key);
	if (timer !== undefined) {
		clearTimeout(timer);
		documentDebounceTimers.delete(key);
	}
}
