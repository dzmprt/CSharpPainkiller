import * as vscode from 'vscode';
import * as path from 'path';
import { extractFileNamespace } from '../utils/contentParser.js';
import { coerceTypeName } from '../utils/sharedUtilities.js';
import {
	buildDtoMapFromMethod,
	detectPrimaryTypeName,
	parseTypeFields,
	type FieldInfo,
} from './generateMapTo.js';

function buildDtoProperties(fields: FieldInfo[], eol: string): string {
	const i1 = '    ';
	return fields
		.filter(f => f.canRead !== false)
		.map(f => `${i1}public ${f.typeName} ${f.name} { get; init; }`)
		.join(eol);
}

function buildDtoContent(
	dtoTypeName: string,
	sourceTypeName: string,
	namespace: string | undefined,
	sourceNamespace: string | undefined,
	fields: FieldInfo[],
	eol: string
): string {
	const lines: string[] = [];

	if (sourceNamespace && sourceNamespace !== namespace) {
		lines.push(`using ${sourceNamespace};`);
	}

	if (namespace) {
		lines.push(`namespace ${namespace};`);
		lines.push('');
	}

	lines.push(`public class ${dtoTypeName}`);
	lines.push('{');
	lines.push(buildDtoProperties(fields, eol));
	if (fields.length > 0) {
		lines.push('');
	}
	lines.push(buildDtoMapFromMethod(dtoTypeName, sourceTypeName, fields, fields, eol));
	lines.push('}');

	return lines.join(eol);
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
	const resolvedSource = coerceTypeName(sourceTypeName) ?? detectPrimaryTypeName(content);

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

	const sourceFields = parseTypeFields(content, resolvedSource);
	if (sourceFields.length === 0) {
		vscode.window.showWarningMessage(
			`CSharp Painkiller: No mappable public properties found on ${resolvedSource}.`
		);
		return;
	}

	const namespace = extractFileNamespace(content);
	const dtoContent = buildDtoContent(
		trimmedDtoName,
		resolvedSource,
		namespace,
		namespace,
		sourceFields,
		eol
	);

	await vscode.workspace.fs.writeFile(outUri, Buffer.from(dtoContent + eol, 'utf-8'));
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
	let content: string;
	try {
		const buf = await vscode.workspace.fs.readFile(fileUri);
		content = Buffer.from(buf).toString('utf-8');
	} catch {
		vscode.window.showErrorMessage('CSharp Painkiller: Cannot read the selected file.');
		return;
	}

	const doc = await vscode.workspace.openTextDocument(fileUri);
	await generateDtoForDocument(doc, detectPrimaryTypeName(content));
}
