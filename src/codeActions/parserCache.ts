import * as vscode from 'vscode';
import { detectMediatorFile } from '../utils/contentParser.js';

/**
 * Cache for code actions parsing results.
 * Prevents repeated full-document content scanning in provideCodeActions().
 * Uses WeakMap for documents and regular Map for type name cache.
 */
export class ParserCache {
	private static instance: ParserCache | null = null;

	/** Cache mediator detection results per document. */
	private mediatorCache = new WeakMap<vscode.TextDocument, boolean>();

	/** Tracks the number of entries in mediatorCache (WeakMap has no size). */
	private mediatorCacheKeyList: vscode.TextDocument[] = [];

	/** Cache type name at position results. Key: line*10000+char, Value: identifier or null. */
	private typeNameCache = new Map<vscode.TextDocument, Map<number, string | null>>();

	/** Maximum entries in type name cache per document. */
	private static readonly MAX_TYPE_NAME_CACHE_SIZE = 500;

	/** Get the singleton instance. */
	static getInstance(): ParserCache {
		if (!ParserCache.instance) {
			ParserCache.instance = new ParserCache();
		}
		return ParserCache.instance;
	}

	/**
	 * Check if file contains mediator types, using cached result.
	 */
	isMediatorFile(document: vscode.TextDocument): boolean {
		const cached = this.mediatorCache.get(document);

		if (cached !== undefined) {
			return cached;
		}

		const content = document.getText();
		const result = detectMediatorFile(content) !== null;

		if (!this.mediatorCache.has(document)) {
			this.mediatorCacheKeyList.push(document);
		}
		this.mediatorCache.set(document, result);

		return result;
	}

	/** Clear mediator cache for a document (e.g., on save). */
	clearMediatorCache(document: vscode.TextDocument): void {
		this.mediatorCache.delete(document);
		const idx = this.mediatorCacheKeyList.indexOf(document);
		if (idx >= 0) {
			this.mediatorCacheKeyList.splice(idx, 1);
		}
	}

	/**
	 * Get or compute type name at a specific position.
	 * Position is converted to a numeric key for caching.
	 */
	getTypeNameAt(
		document: vscode.TextDocument,
		line: number,
		character: number
	): string | null {
		let typeMap = this.typeNameCache.get(document);
		if (!typeMap) {
			typeMap = new Map<number, string | null>();
			this.typeNameCache.set(document, typeMap);
		}

		// eslint-disable-next-line no-param-reassign
		typeMap = this.typeNameCache.get(document)!;

		// Limit cache size
		if (typeMap.size >= ParserCache.MAX_TYPE_NAME_CACHE_SIZE) {
			const entries = Array.from(typeMap.entries());
			typeMap.clear();
			// Keep the newest half
			const half = Math.floor(entries.length / 2);
			for (let i = half; i < entries.length; i++) {
				typeMap.set(entries[i][0], entries[i][1]);
			}
		}

		const posKey = line * 10000 + character;
		const cached = typeMap.get(posKey);

		if (cached !== undefined) {
			return cached;
		}

		// Compute: extract identifier at position
		const lineEnd = document.lineAt(line).range.end.character;
		const text = document.getText(new vscode.Range(line, 0, line, lineEnd));

		// Extended identifier pattern including Unicode letters
		const IDENTIFIER_RE = /[A-Za-z_\u00C0-\u024F\u0370-\u04FF\u0500-\u052F\u0530-\u05FF\u0590-\u06FF\u0E00-\u0E7F\u1E00-\u1EFF\u1F00-\u1FFF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF][A-Za-z0-9_\u00C0-\u024F\u0370-\u04FF\u0500-\u052F\u0530-\u05FF\u0590-\u06FF\u0E00-\u0E7F\u1E00-\u1EFF\u1F00-\u1FFF\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]*/g;

		let match: RegExpExecArray | null;
		while ((match = IDENTIFIER_RE.exec(text)) !== null) {
			const startIdx = match.index;
			const endIdx = match.index + match[0].length;

			// Check if position falls within this identifier
			if (character >= startIdx && character <= endIdx) {
				typeMap.set(posKey, match[0]);
				return match[0];
			}
		}

		typeMap.set(posKey, null);
		return null;
	}

	/** Clear all type name caches for a document. */
	clearTypeNameCache(document: vscode.TextDocument): void {
		this.typeNameCache.delete(document);
	}

	/** Clear all caches for a document. */
	clearAllCaches(document: vscode.TextDocument): void {
		this.mediatorCache.delete(document);
		const idx = this.mediatorCacheKeyList.indexOf(document);
		if (idx >= 0) {
			this.mediatorCacheKeyList.splice(idx, 1);
		}
		this.typeNameCache.delete(document);
	}

	/** Clear all caches globally. */
	clearAll(): void {
		this.mediatorCache = new WeakMap<vscode.TextDocument, boolean>();
		this.mediatorCacheKeyList = [];
		this.typeNameCache = new Map<vscode.TextDocument, Map<number, string | null>>();
	}

	/** Get cache sizes for debugging. */
	getStats(): { mediatorCount: number; typeNameDocCount: number } {
		return {
			mediatorCount: this.mediatorCacheKeyList.length,
			typeNameDocCount: this.typeNameCache.size,
		};
	}
}