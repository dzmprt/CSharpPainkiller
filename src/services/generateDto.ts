import * as vscode from 'vscode';
import * as path from 'path';
import { csharpLanguageService } from './csharpLanguageService.js';
import { coerceTypeName } from '../utils/sharedUtilities.js';
import { buildTypeFileContent, type TypeFileContext } from '../utils/usingBlock.js';
import { parseGenericDeclaration, type GenericDeclaration } from '../utils/contentParser.js';
import {
	buildDtoMapFromMethod,
	buildMappingProperties,
	parseDocumentTypeFields,
	type FieldInfo,
} from './generateMapTo.js';

export function buildDtoContent(
	dtoTypeName: string,
	sourceTypeName: string,
	fields: FieldInfo[],
	context: TypeFileContext,
	eol: string,
	generics: GenericDeclaration = {}
): string {
	const lines: string[] = [];

	lines.push(`public class ${dtoTypeName}${generics.typeParameters ?? ''}`);
	if (generics.constraints) { lines.push(`    ${generics.constraints}`); }
	lines.push('{');
	lines.push(buildMappingProperties(fields, eol));
	if (fields.length > 0) {
		lines.push('');
	}
	lines.push(buildDtoMapFromMethod(dtoTypeName, `${sourceTypeName}${generics.typeParameters ?? ''}`, fields, fields, eol));
	lines.push('}');

	return buildTypeFileContent(lines.join(eol), context, eol);
}

/**
 * Generates a DTO class with matching public properties and a
 * constructor that maps from the source type.
 */
export async function generateDtoForDocument(
	document: vscode.TextDocument,
	sourceTypeName?: string
): Promise<void> {
	const content = document.getText();
	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	const resolvedSource = coerceTypeName(sourceTypeName) ?? (await csharpLanguageService.getPrimaryType(document))?.name;

	if (!resolvedSource) {
		vscode.window.showErrorMessage('CSharp Painkiller: Cannot find a class, struct, or record in the current file.');
		return;
	}

	const defaultDtoName = `${resolvedSource}Dto`;
	const dtoName = await vscode.window.showInputBox({
		prompt: `Enter DTO name for ${resolvedSource}`,
		value: defaultDtoName,
		validateInput: v =>
			(!v || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.trim()))
				? 'Enter a valid C# type name'
				: undefined,
	});
	if (!dtoName) { return; }

	const trimmedDtoName = dtoName.trim();
	const dir = path.posix.dirname(document.uri.path);
	const outPath = `${dir}/${trimmedDtoName}.cs`;
	const outUri = document.uri.with({ path: outPath });

	try {
		await vscode.workspace.fs.stat(outUri);
		vscode.window.showErrorMessage(`CSharp Painkiller: File "${trimmedDtoName}.cs" already exists.`);
		return;
	} catch {
		// File doesn't exist — proceed
	}

	const sourceFields = await parseDocumentTypeFields(document, resolvedSource);
	if (sourceFields.length === 0) {
		vscode.window.showWarningMessage(
			`CSharp Painkiller: No mappable public properties found on ${resolvedSource}.`
		);
		return;
	}

	const type = (await csharpLanguageService.getTypes(document)).find(type => type.name === resolvedSource);
	if (!type) { throw new Error(`Cannot resolve source type "${resolvedSource}".`); }
	const dtoContent = buildDtoContent(
		trimmedDtoName,
		resolvedSource,
		sourceFields,
		await csharpLanguageService.getTypeFileContext(document, type),
		eol,
		parseGenericDeclaration(csharpLanguageService.getHeader(document, type), type.name)
	);

	await vscode.workspace.fs.writeFile(outUri, Buffer.from(dtoContent, 'utf-8'));
	const doc = await vscode.workspace.openTextDocument(outUri);
	await vscode.window.showTextDocument(doc, { preview: false });

	vscode.window.showInformationMessage(
		`CSharp Painkiller: Generated ${trimmedDtoName} with MapFrom${resolvedSource}.`
	);
}

/**
 * Triggered from the Explorer context menu on a .cs file.
 */
export async function generateDtoForFile(fileUri: vscode.Uri): Promise<void> {
	const doc = await vscode.workspace.openTextDocument(fileUri);
	await generateDtoForDocument(doc);
}
