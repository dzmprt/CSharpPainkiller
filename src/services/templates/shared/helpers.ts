/**
 * Shared template helpers and utilities
 */

/**
 * Capitalize a string (first character uppercase)
 */
export function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Convert camelCase to PascalCase
 */
export function toPascalCase(s: string): string {
	return s.replace(/(?:^\w|[A-Z]|\b\w)/g, (word) => word.toUpperCase()).replace(/\s+/g, '');
}

/**
 * Convert string to camelCase
 */
export function toCamelCase(s: string): string {
	return s.replace(/(?:^\w|[A-Z]|\b\w)/g, (word, index) => (index === 0 ? word.toLowerCase() : word.toUpperCase())).replace(/\s+/g, '');
}

/**
 * Sanitize identifier to be valid C# name
 */
export function sanitizeIdentifier(name: string): string {
	// Replace invalid characters with empty string
	let sanitized = name.replace(/[^a-zA-Z0-9_]/g, '');

	// Ensure starts with letter or underscore
	if (sanitized && /^\d/.test(sanitized)) {
		sanitized = '_' + sanitized;
	}

	return sanitized || 'GeneratedClass';
}

/**
 * Format namespace from folder path
 */
export function formatNamespace(namespace: string): string {
	return namespace
		.split('/')
		.map((part) => capitalize(part.replace(/[^a-zA-Z0-9]/g, '')))
		.filter((part) => part.length > 0)
		.join('.');
}

/**
 * Generate XML documentation comment
 */
export function generateXmlDoc(summary: string): string {
	return `/// <summary>\n/// ${summary}\n/// </summary>`;
}
