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

export type RelatedPropertiesByType = Readonly<Record<string, ParsedProperty[]>>;

const scalarTypes = new Set([
	'bool', 'byte', 'sbyte', 'short', 'ushort', 'int', 'uint', 'long', 'ulong',
	'float', 'double', 'decimal', 'char', 'string', 'object', 'DateTime',
	'DateTimeOffset', 'DateOnly', 'TimeOnly', 'TimeSpan', 'Guid', 'byte[]',
	'bool?', 'byte?', 'sbyte?', 'short?', 'ushort?', 'int?', 'uint?', 'long?',
	'ulong?', 'float?', 'double?', 'decimal?', 'char?', 'DateTime?',
	'DateTimeOffset?', 'DateOnly?', 'TimeOnly?', 'TimeSpan?', 'Guid?',
]);

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
	const propRegex = /public\s+(?:(?:virtual|static|required|new)\s+)*([\w<>[\],\s]+?)\s*(\?)?\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{\s*get\s*[;{]/g;
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
 * - Scalar public properties → `builder.Property`
 *   - Non-nullable → `.IsRequired()`
 *   - `string` / `String` type → `.HasMaxLength(256)`
 * - Reference navigations → `HasOne().WithMany()` with an explicit or shadow foreign key
 * - Shared-key reference navigations → `HasOne().WithOne()`
 * - Collection navigations → `HasMany().WithMany()`
 *
 * @param entity      - Entity class info (name + namespace) found in the workspace
 * @param properties  - Public properties parsed from the entity file
 * @param namespace   - Target namespace for the generated configuration file
 */
export function generateEfCoreEntityTypeConfiguration(
	entity: FoundType,
	properties: ParsedProperty[],
	namespace: string,
	relatedPropertiesByType: RelatedPropertiesByType = {}
): string {
	const entityName = entity.name;
	const entityNamespace = entity.namespace;
	const className = `${entityName}Configuration`;

	const idNames = new Set(['Id', `${entityName}Id`]);
	const keyProp = properties.find(p => idNames.has(p.name));
	const nonKeyProps = properties.filter(p => !idNames.has(p.name) && !isNavigation(p));
	const navigationProps = properties.filter(p => !idNames.has(p.name) && isNavigation(p));

	const configLines: string[] = [];

	if (keyProp) {
		configLines.push(`        builder.HasKey(e => e.${keyProp.name});`);
	} else {
		configLines.push('        builder.HasKey(e => ...);');
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

	for (const navigation of navigationProps) {
		const collectionType = getCollectionElementType(navigation.type);
		if (collectionType) {
			const relatedProperties = relatedPropertiesByType[collectionType];
			const inverseCandidates = findInverseNavigations(relatedProperties, entityName);
			const inverse = inverseCandidates.length === 1 ? inverseCandidates[0] : undefined;
			let inverseChain: string;
			if (inverse) {
				inverseChain = inverse.isCollection
					? `.WithMany(e => e.${inverse.name})`
					: `.WithOne(e => e.${inverse.name})`;
			} else if (inverseCandidates.length > 0 && inverseCandidates.every(candidate => !candidate.isCollection)) {
				inverseChain = '.WithOne()';
			} else if (inverseCandidates.length === 0 && relatedProperties) {
				inverseChain = '.WithMany()';
			} else {
				inverseChain = '.WithMany(e => e.__INVERSE_NAVIGATION_REQUIRED__)';
			}
			let foreignKeyChain = '';
			if (inverse && !inverse.isCollection) {
				const foreignKeyName = findForeignKeyName(
					{ name: inverse.name, type: entityName, isNullable: inverse.isNullable },
					relatedProperties ?? []
				);
				foreignKeyChain = foreignKeyName
					? `\n            .HasForeignKey(e => e.${foreignKeyName})`
					: `\n            .HasForeignKey("${entityName}Id")`;
			}
			configLines.push(
				`        builder.HasMany(e => e.${navigation.name})\n` +
				`            ${inverseChain}${foreignKeyChain};`
			);
			continue;
		}

		const foreignKeyName = findForeignKeyName(navigation, properties);
		const relatedProperties = relatedPropertiesByType[navigation.type];
		const inverseCandidates = findInverseNavigations(relatedProperties, entityName);
		const inverse = inverseCandidates.length === 1 ? inverseCandidates[0] : undefined;
		let chain = `        builder.HasOne(e => e.${navigation.name})`;
		const inverseReference = inverse && !inverse.isCollection ? inverse : undefined;
		const relatedForeignKeyName = inverseReference && relatedProperties
			? findForeignKeyName(
				{ name: inverseReference.name, type: entityName, isNullable: inverseReference.isNullable },
				relatedProperties
			)
			: undefined;
		if (inverseReference && !foreignKeyName && relatedForeignKeyName) {
			chain += `\n            .WithOne(e => e.${inverseReference.name})\n            .HasForeignKey<${navigation.type}>(e => e.${relatedForeignKeyName});`;
		} else if (inverseReference && !foreignKeyName && !relatedForeignKeyName && relatedProperties) {
			chain += `\n            .WithOne(e => e.${inverseReference.name})\n            .HasForeignKey<${navigation.type}>("${entityName}Id");`;
		} else if (inverseReference && foreignKeyName) {
			chain += `\n            .WithOne(e => e.${inverseReference.name})\n            .HasForeignKey(e => e.${foreignKeyName});`;
		} else {
			chain += `\n            ${inverse && inverse.isCollection ? `.WithMany(e => e.${inverse.name})` : '.WithMany()'}`;
			if (foreignKeyName) {
				chain += `\n            .HasForeignKey(e => e.${foreignKeyName});`;
			} else {
				chain += `\n            .HasForeignKey("${navigation.name}Id");`;
			}
		}
		if (!navigation.isNullable) {
			chain = chain.replace(/;$/, '\n            .IsRequired();');
		}
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

function isNavigation(property: ParsedProperty): boolean {
	const collectionElementType = getCollectionElementType(property.type);
	if (collectionElementType) {
		return !scalarTypes.has(collectionElementType);
	}
	return !scalarTypes.has(property.type);
}

function findInverseNavigations(
	relatedProperties: ParsedProperty[] | undefined,
	entityName: string
): { name: string; isCollection: boolean; isNullable: boolean }[] {
	if (!relatedProperties) {
		return [];
	}

	return relatedProperties
		.filter(property => getNavigationTargetType(property) === entityName)
		.map(property => ({
			name: property.name,
			isCollection: getCollectionElementType(property.type) !== undefined,
			isNullable: property.isNullable,
		}));
}

export function getNavigationTargetType(property: ParsedProperty): string | undefined {
	const collectionElementType = getCollectionElementType(property.type);
	if (collectionElementType) {
		return scalarTypes.has(collectionElementType) ? undefined : collectionElementType;
	}
	return scalarTypes.has(property.type) ? undefined : property.type;
}

function getCollectionElementType(type: string): string | undefined {
	const collectionMatch = /^(?:ICollection|IEnumerable|IList|IReadOnlyCollection|IReadOnlyList|List|HashSet)<\s*(.+?)\s*>$/.exec(type);
	if (collectionMatch) {
		return collectionMatch[1];
	}
	if (type.endsWith('[]')) {
		return type.slice(0, -2);
	}
	return undefined;
}

function findForeignKeyName(navigation: ParsedProperty, properties: ParsedProperty[]): string | undefined {
	const relatedType = navigation.type;
	const candidates = [`${navigation.name}Id`, `${relatedType}Id`];
	return candidates.find(candidate => properties.some(property => property.name === candidate));
}
