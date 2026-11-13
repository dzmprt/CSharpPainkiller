import * as vscode from 'vscode';
import {
	runDiagnosticsForUri, runDiagnosticsForDocument, publishDuplicateTypes,
	markWorkspaceAnalysis, type AnalyzerSelection, type WorkspaceDuplicateIndex,
} from './diagnosticsProvider.js';

export interface BatchAnalysisOptions {
	batchSize?: number;
	overrides?: AnalyzerSelection;
	token?: vscode.CancellationToken;
	onProgress?: (processed: number, total: number) => void;
}

export async function runDiagnosticsInBatches(
	collection: vscode.DiagnosticCollection,
	files: vscode.Uri[],
	options?: BatchAnalysisOptions,
): Promise<{ processed: number; cancelled: boolean }> {
	const requested = options?.batchSize ??
		vscode.workspace.getConfiguration('csharppainkiller').get<number>('diagnosticBatchSize', 4);
	if (!Number.isInteger(requested) || requested < 1) { throw new Error('Diagnostic batch size must be a positive integer.'); }
	const size = Math.min(requested, 4);
	const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
	const ordered = [...files].sort((a, b) => Number(b.toString() === activeUri) - Number(a.toString() === activeUri));
	const duplicates: WorkspaceDuplicateIndex = new Map();
	let cursor = 0;
	let processed = 0;
	let cancelled = false;
	const runners = Array.from({ length: Math.min(size, files.length) }, async () => {
		while (cursor < ordered.length && !cancelled) {
			if (options?.token?.isCancellationRequested) { cancelled = true; break; }
			const uri = ordered[cursor++];
			markWorkspaceAnalysis(uri, true);
			try {
				await runDiagnosticsForUri(uri, collection, options?.overrides, true, options?.token, duplicates);
				processed++;
				options?.onProgress?.(processed, files.length);
			} catch (error) {
				if (!(error instanceof vscode.CancellationError)) { throw error; }
				if (options?.token?.isCancellationRequested) { cancelled = true; }
			} finally {
				markWorkspaceAnalysis(uri, false);
			}
			await new Promise<void>(resolve => setTimeout(resolve, 0));
		}
	});
	// Drain all workers before returning, including when one worker fails.
	const results = await Promise.allSettled(runners);
	const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
	if (failure) { throw failure.reason; }
	cancelled ||= options?.token?.isCancellationRequested ?? false;
	if (!cancelled) { publishDuplicateTypes(duplicates, collection); }
	return { processed, cancelled };
}

const documentDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleDiagnosticsForDocumentChange(
	document: vscode.TextDocument, collection: vscode.DiagnosticCollection,
): void {
	clearDebounceForDocument(document);
	const delay = vscode.workspace.getConfiguration('csharppainkiller').get<number>('diagnosticDebounceDelay', 1000);
	documentDebounceTimers.set(document.uri.toString(), setTimeout(() => {
		documentDebounceTimers.delete(document.uri.toString());
		void runDiagnosticsForDocument(document, collection);
	}, delay));
}

export function scheduleDiagnosticsForUriChange(uri: vscode.Uri, collection: vscode.DiagnosticCollection): void {
	const key = uri.toString();
	const existing = documentDebounceTimers.get(key);
	if (existing) { clearTimeout(existing); }
	const delay = vscode.workspace.getConfiguration('csharppainkiller').get<number>('diagnosticDebounceDelay', 1000);
	documentDebounceTimers.set(key, setTimeout(() => {
		documentDebounceTimers.delete(key);
		void runDiagnosticsForUri(uri, collection).catch(error => console.error('Diagnostics analysis failed:', error));
	}, delay));
}

export function clearDebounceForDocument(document: vscode.TextDocument): void {
	const key = document.uri.toString();
	const timer = documentDebounceTimers.get(key);
	if (timer) { clearTimeout(timer); documentDebounceTimers.delete(key); }
}

export function clearPendingDiagnostics(): void {
	for (const timer of documentDebounceTimers.values()) { clearTimeout(timer); }
	documentDebounceTimers.clear();
}
