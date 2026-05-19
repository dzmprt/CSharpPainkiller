// ============================================================================
// EF Core template generators
// ============================================================================

import { type FoundType } from '../../utils/typeSearch.js';

/**
 * Represents a parsed public auto-property from a C# class.
 */
export interface ParsedProperty {
	name: string;
	/** C# type name without the trailing '?' */
	type: string;
	/** True when the property was declared as nullable (e.g. `string?`) */
	isNullable: boolean;
}

/**
 * Parses public auto-properties from C# class content.
 *
 * Handles patterns like:
 *   public string  Name  { get; set; }
 *   public string? Name  { get; set; }
 *   public int     Age   { get; set; }
 *   public int?    Age   { get; set; }
 *   public int     Age   { get; init; }
 */
export function parsePublicProperties(content: string): ParsedProperty[] {
	const results: ParsedProperty[] = [];
	// Group 1 = type (without ?), Group 2 = optional '?', Group 3 = property name
	const propRegex = /public\s+([\w<>[\],\s]+?)\s*(\?)?\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{\s*get\s*[;{]/g;
	let match: RegExpExecArray | null;
	while ((match = propRegex.exec(content)) !== null) {
		const rawType = match[1].trim();
		const nullable = match[2] === '?';
		const name = match[3];
		if (name === 'this') { continue; } // skip indexers
		results.push({ name, type: rawType, isNullable: nullable });
	}
	return results;
}

/**
 * Generates an EF Core `IEntityTypeConfiguration<EntityType>` implementation.
 *
 * Rules applied inside `Configure`:
 * - Property named `Id` or `<EntityName>Id` → `builder.HasKey`
 * - Every other public property → `builder.Property`
 *   - Non-nullable → `.IsRequired()`
 *   - `string` / `String` type → `.HasMaxLength(256)`
 *
 * @param entity      - Entity class info (name + namespace) found in the workspace
 * @param properties  - Public properties parsed from the entity file
 * @param namespace   - Target namespace for the generated configuration file
 */
export function generateEfCoreEntityTypeConfiguration(
	entity: FoundType,
	properties: ParsedProperty[],
	namespace: string
): string {
	const entityName = entity.name;
	const entityNamespace = entity.namespace;
	const className = `${entityName}Configuration`;

	const idNames = new Set(['Id', `${entityName}Id`]);
	const keyProp = properties.find(p => idNames.has(p.name));
	const nonKeyProps = properties.filter(p => !idNames.has(p.name));

	const configLines: string[] = [];

	if (keyProp) {
		configLines.push(`        builder.HasKey(e => e.${keyProp.name});`);
	}

	for (const prop of nonKeyProps) {
		let chain = `        builder.Property(e => e.${prop.name})`;
		if (!prop.isNullable) {
			chain += `\n            .IsRequired()`;
		}
		if (prop.type === 'string' || prop.type === 'String') {
			chain += `\n            .HasMaxLength(256)`;
		}
		chain += ';';
		configLines.push(chain);
	}

	const configBody = configLines.length > 0
		? configLines.join('\n\n') + '\n'
		: '';

	const usings = buildUsings(namespace, [
		'Microsoft.EntityFrameworkCore',
		'Microsoft.EntityFrameworkCore.Metadata.Builders',
		...(entityNamespace && entityNamespace !== namespace ? [entityNamespace] : []),
	]);

	return `${usings}
namespace ${namespace};

public class ${className} : IEntityTypeConfiguration<${entityName}>
{
    public void Configure(EntityTypeBuilder<${entityName}> builder)
    {
${configBody}    }
}
`;
}

// ============================================================================
// Internal helpers
// ============================================================================

function buildUsings(targetNamespace: string, namespaces: string[]): string {
	const unique = [...new Set(namespaces)].filter(ns => ns !== targetNamespace);
	if (unique.length === 0) {
		return '';
	}
	return unique.map(ns => `using ${ns};`).join('\n') + '\n';
}
