import { type CType, type TemplateParts } from './types.js';

/**
 * Template configurations for each C# type.
 * Maps type keywords to their prefix and suffix for code generation.
 */
const typeTemplates: Record<CType, TemplateParts> = {
	class: { prefix: 'public class', suffix: '\n{\n}' },
	record: { prefix: 'public record', suffix: ';' },
	struct: { prefix: 'public struct', suffix: '\n{\n}' },
	enum: { prefix: 'public enum', suffix: '\n{\n}' },
	interface: { prefix: 'public interface', suffix: '\n{\n}' },
	'record struct': { prefix: 'public readonly record struct', suffix: ';' },
};

/**
 * Generates the full C# file content for a type declaration.
 *
 * @param type - The C# type keyword
 * @param name - The type name (e.g., "MyClass")
 * @param namespaceName - The namespace to declare
 * @returns The complete file content as a string
 */
export function getTemplate(type: CType, name: string, namespaceName: string): string {
	const template = typeTemplates[type];
	return `namespace ${namespaceName};\n\n${template.prefix} ${name}${template.suffix}`;
}