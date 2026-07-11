import * as vscode from 'vscode';
import { extractFileNamespace } from '../utils/contentParser.js';
import { coerceTypeName } from '../utils/sharedUtilities.js';
import { detectPrimaryTypeName, parseTypeFields } from './generateMapTo.js';
import { findTypeInWorkspaceWithOptions } from '../utils/typeSearch.js';
import { type ParsedProperty } from './templates/efcore.js';

const PRIMITIVE_TYPES = new Set([
	'string', 'String', 'int', 'Int32', 'long', 'Int64', 'short', 'Int16',
	'byte', 'Byte', 'sbyte', 'SByte', 'uint', 'UInt32', 'ulong', 'UInt64',
	'ushort', 'UInt16', 'float', 'Single', 'double', 'Double', 'decimal', 'Decimal',
	'bool', 'Boolean', 'char', 'Char', 'object', 'Object',
	'DateTime', 'DateTimeOffset', 'TimeSpan', 'Guid',
]);

const NUMERIC_TYPES = new Set([
	'int', 'Int32', 'long', 'Int64', 'short', 'Int16', 'byte', 'Byte', 'sbyte', 'SByte',
	'uint', 'UInt32', 'ulong', 'UInt64', 'ushort', 'UInt16',
	'float', 'Single', 'double', 'Double', 'decimal', 'Decimal',
]);

const DATE_TYPES = new Set(['DateTime', 'DateTimeOffset', 'TimeSpan']);

function toParsedProperties(fields: ReturnType<typeof parseTypeFields>): ParsedProperty[] {
	return fields.map(f => {
		const trimmed = f.typeName.replace(/\s+/g, '');
		const isNullable = trimmed.endsWith('?');
		const type = isNullable ? trimmed.slice(0, -1) : trimmed;
		return { name: f.name, type, isNullable };
	});
}

interface CollectionInfo {
	elementType: string;
}

function parseCollectionType(type: string): CollectionInfo | null {
	const trimmed = type.replace(/\s+/g, '');
	const arrayMatch = trimmed.match(/^(.+)\[\]$/);
	if (arrayMatch) {
		return { elementType: arrayMatch[1] };
	}

	const genericMatch = trimmed.match(/^(?:IEnumerable|ICollection|IList|IReadOnlyCollection|IReadOnlyList|List|HashSet)<(.+)>$/);
	if (genericMatch) {
		return { elementType: genericMatch[1] };
	}

	return null;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectEnumNamesFromContent(content: string): Set<string> {
	const enums = new Set<string>();
	const re = /\benum\s+([A-Za-z_][A-Za-z0-9_]*)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(content)) !== null) {
		enums.add(match[1]);
	}
	return enums;
}

function isEnumDeclarationInContent(content: string, typeName: string): boolean {
	const escaped = escapeRe(typeName);
	return new RegExp(`\\benum\\s+${escaped}(?:\\s*<[^>]*>)?\\s*(?:\\{|;)`, 'm').test(content);
}

function unwrapTypeName(type: string): string {
	return type.replace(/\?$/, '').replace(/\s+/g, '').trim();
}

function collectReferencedTypes(properties: ParsedProperty[]): Set<string> {
	const types = new Set<string>();
	for (const prop of properties) {
		types.add(unwrapTypeName(prop.type));
		const collection = parseCollectionType(unwrapTypeName(prop.type));
		if (collection) {
			types.add(unwrapTypeName(collection.elementType));
		}
	}
	return types;
}

async function resolveEnumTypes(content: string, properties: ParsedProperty[], contextUri: vscode.Uri): Promise<Set<string>> {
	const enumTypes = collectEnumNamesFromContent(content);

	for (const typeName of collectReferencedTypes(properties)) {
		if (!typeName || enumTypes.has(typeName) || PRIMITIVE_TYPES.has(typeName)) {
			continue;
		}

		const found = await findTypeInWorkspaceWithOptions(typeName, { contextUri });
		if (!found) {
			continue;
		}

		try {
			const buf = await vscode.workspace.fs.readFile(found.fileUri);
			const fileContent = Buffer.from(buf).toString('utf-8');
			if (isEnumDeclarationInContent(fileContent, typeName)) {
				enumTypes.add(typeName);
			}
		} catch {
			// Skip unreadable files
		}
	}

	return enumTypes;
}

function appendChildRulesStub(lines: string[], chainIndent: string): void {
	lines.push(`${chainIndent}.ChildRules(item =>`);
	lines.push(`${chainIndent}{`);
	lines.push(`${chainIndent}});`);
}

function buildPropertyRules(prop: ParsedProperty, enumTypes: Set<string>): string[] {
	const base = prop.type.replace(/\?$/, '').trim();
	const lines: string[] = [];
	const chainIndent = '            ';

	const collection = parseCollectionType(base);
	if (collection) {
		lines.push(`        RuleForEach(x => x.${prop.name})`);
		if (!prop.isNullable) {
			lines.push(`${chainIndent}.NotNull()`);
		}
		lines.push(`${chainIndent}.NotEmpty()`);
		appendChildRulesStub(lines, chainIndent);
		return lines;
	}

	lines.push(`        RuleFor(x => x.${prop.name})`);

	if (base === 'string' || base === 'String') {
		if (!prop.isNullable) {
			lines.push(`${chainIndent}.NotEmpty()`);
		}
		lines.push(`${chainIndent}.MaximumLength(256);`);
		return lines;
	}

	if (NUMERIC_TYPES.has(base)) {
		if (!prop.isNullable) {
			lines.push(`${chainIndent}.GreaterThan(0);`);
		} else {
			lines.push(`${chainIndent}.GreaterThan(0).When(x => x.${prop.name}.HasValue);`);
		}
		return lines;
	}

	if (base === 'bool' || base === 'Boolean') {
		lines.push(`${chainIndent}.NotNull();`);
		return lines;
	}

	if (DATE_TYPES.has(base)) {
		if (!prop.isNullable) {
			lines.push(`${chainIndent}.NotEmpty();`);
		}
		return lines;
	}

	if (base === 'Guid') {
		if (!prop.isNullable) {
			lines.push(`${chainIndent}.NotEqual(Guid.Empty);`);
		}
		return lines;
	}

	if (enumTypes.has(base)) {
		lines.push(`${chainIndent}.IsInEnum();`);
		return lines;
	}

	// Complex object type — only null check
	if (!prop.isNullable) {
		lines.push(`${chainIndent}.NotNull();`);
	}
	return lines;
}

export function generateFluentValidatorContent(
	typeName: string,
	properties: ParsedProperty[],
	namespace: string | undefined,
	eol: string,
	enumTypes: Set<string>
): string {
	const validatorName = `${typeName}Validator`;
	const ruleBlocks = properties.map(prop => buildPropertyRules(prop, enumTypes));
	const rulesBody = ruleBlocks
		.map(block => block.join(eol))
		.filter(block => block.length > 0)
		.join(eol + eol);
	const rulesSection = rulesBody.length > 0 ? rulesBody + eol : '';

	const lines: string[] = [
		'using FluentValidation;',
		'',
	];

	if (namespace) {
		lines.push(`namespace ${namespace};`, '');
	}

	lines.push(
		`public class ${validatorName} : AbstractValidator<${typeName}>`,
		'{',
		`    public ${validatorName}()`,
		'    {',
		rulesSection + '    }',
		'}'
	);

	return lines.join(eol);
}

/**
 * Generates a FluentValidation AbstractValidator for the type in the document.
 */
export async function generateFluentValidatorForDocument(
	document: vscode.TextDocument,
	typeName?: string
): Promise<void> {
	const content = document.getText();
	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	const resolvedType = coerceTypeName(typeName) ?? detectPrimaryTypeName(content);

	if (!resolvedType) {
		vscode.window.showErrorMessage('CSharp Painkiller: Cannot find a type to validate in the current file.');
		return;
	}

	const properties = toParsedProperties(parseTypeFields(content, resolvedType));
	if (properties.length === 0) {
		vscode.window.showWarningMessage(
			`CSharp Painkiller: No public properties found on ${resolvedType}.`
		);
		return;
	}

	const validatorName = `${resolvedType}Validator`;
	const outUri = vscode.Uri.joinPath(document.uri, '..', `${validatorName}.cs`);

	try {
		await vscode.workspace.fs.stat(outUri);
		vscode.window.showErrorMessage(`CSharp Painkiller: File "${validatorName}.cs" already exists.`);
		return;
	} catch {
		// File doesn't exist — proceed
	}

	const namespace = extractFileNamespace(content);
	const enumTypes = await resolveEnumTypes(content, properties, document.uri);
	const validatorContent = generateFluentValidatorContent(
		resolvedType,
		properties,
		namespace,
		eol,
		enumTypes
	);

	await vscode.workspace.fs.writeFile(outUri, Buffer.from(validatorContent + eol, 'utf-8'));
	const doc = await vscode.workspace.openTextDocument(outUri);
	await vscode.window.showTextDocument(doc, { preview: false });

	vscode.window.showInformationMessage(
		`CSharp Painkiller: Generated ${validatorName} with ${properties.length} rule(s).`
	);
}
