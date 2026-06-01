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
