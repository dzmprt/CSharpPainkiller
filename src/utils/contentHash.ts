/**
 * Fast FNV-1a 32-bit hash for content-based caching.
 * Used to detect when file content actually changed since last analysis,
 * avoiding redundant regex processing on unchanged files.
 */

/**
 * FNV-1a 32-bit hash implementation.
 * Much faster than MD5/SHA and sufficient for cache validation.
 * Returns a hexadecimal string suitable as a Map key.
 */
export function fastContentHash(content: string): string {
	let hash = 0x811c9dc5; // FNV offset basis (32-bit)

	for (let i = 0; i < content.length; i++) {
		// XOR with character code (only need lower 8 bits for speed)
		hash ^= content.charCodeAt(i) & 0xff;

		// FNV prime: multiply by 2^24 + 2^8 + 0x93 (little-endian optimized)
		hash = ((hash << 5) + hash) ^ (hash >>> 27); // equivalent to hash * 31
		hash |= 0; // ensure signed 32-bit
	}

	// Convert to unsigned hex string (8 chars)
	return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Incremental hash that can be updated line-by-line.
 * Useful for partial re-analysis when only some lines change.
 */
export function incrementalHash(lines: string[]): string {
	let hash = 0x811c9dc5;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		for (let j = 0; j < line.length; j++) {
			hash ^= line.charCodeAt(j) & 0xff;
			hash = ((hash << 5) + hash) ^ (hash >>> 27);
			hash |= 0;
		}
		// Mix in line separator implicitly via different iteration order
		hash ^= 0x1f;
	}

	return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Compare two content strings to find changed line ranges.
 * Returns array of [startLine, endLine] ranges that differ.
 * Uses a simple line-by-line comparison with O(n) complexity.
 */
export function findChangedLines(
	oldContent: string | undefined,
	newContent: string
): { hasChanges: boolean; changedRanges: Array<[number, number]> } {
	if (!oldContent) {
		return { hasChanges: true, changedRanges: [[0, 0]] }; // everything is "new"
	}

	const oldLines = oldContent.split('\n');
	const newLines = newContent.split('\n');

	if (oldLines.length !== newLines.length) {
		return { hasChanges: true, changedRanges: [[0, 0]] }; // full re-analysis
	}

	const changedRanges: Array<[number, number]> = [];
	let inRange = false;
	let rangeStart = -1;

	for (let i = 0; i < newLines.length; i++) {
		const changed = oldLines[i] !== newLines[i];
		if (changed && !inRange) {
			inRange = true;
			rangeStart = i;
		} else if (!changed && inRange) {
			inRange = false;
			changedRanges.push([rangeStart, i - 1]);
		}
	}

	if (inRange) {
		changedRanges.push([rangeStart, newLines.length - 1]);
	}

	return {
		hasChanges: changedRanges.length > 0,
		changedRanges,
	};
}

/**
 * Check if a string contains any non-ASCII character (fast path).
 * Returns true if ANY byte > 127 exists.
 */
export function hasNonAsciiFast(str: string): boolean {
	for (let i = 0; i < str.length; i++) {
		if (str.charCodeAt(i) > 127) {
			return true;
		}
	}
	return false;
}

/**
 * Check a single character if it's non-ASCII.
 */
export function isCharNonAscii(charCode: number): boolean {
	return charCode > 127;
}

/**
 * Get the hash of a single line (for incremental analysis).
 */
export function hashLine(line: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < line.length; i++) {
		hash ^= line.charCodeAt(i) & 0xff;
		hash = ((hash << 5) + hash) ^ (hash >>> 27);
		hash |= 0;
	}
	return hash;
}