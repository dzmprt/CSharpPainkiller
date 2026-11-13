import * as vscode from 'vscode';
import * as path from 'path';
import { csharpLanguageService } from './csharpLanguageService.js';
import { buildTypeFileContent, type TypeFileContext } from '../utils/usingBlock.js';
import { getPublicPropertyAccessors, parseGenericDeclaration, stripComments as maskNonCode } from '../utils/contentParser.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PropertySignature {
	name: string;
	type: string;
	hasGet: boolean;
	hasSet: boolean;
	hasInit: boolean;
}

interface MethodSignature {
	name: string;
	returnType: string;
	parameters: string;
	isAsync: boolean;
	typeParameters?: string;
	constraints?: string;
}

interface ExtractedMembers {
	className: string;
	typeParameters?: string;
	constraints?: string;
	properties: PropertySignature[];
	methods: MethodSignature[];
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Finds the index of the matching closing brace for the opening brace at `openPos`.
 */
function findMatchingBrace(content: string, openPos: number): number {
	let depth = 0;
	for (let i = openPos; i < content.length; i++) {
		if (content[i] === '{') { depth++; }
		else if (content[i] === '}') {
			depth--;
			if (depth === 0) { return i; }
		}
	}
	return -1;
}

/**
 * Extracts the body of the first public class in the file.
 * Returns { className, body } or undefined if none found.
 */
function extractClassBody(content: string): { className: string; body: string; header: string } | undefined {
	const stripped = maskNonCode(content);

	// Match: public [optional-mods] class ClassName [: BaseClass, IFoo]
	const classRegex = /\bpublic\s+(?:(?:static|sealed|abstract|partial)\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)\b[^{]*\{/g;

	let match: RegExpExecArray | null;
	while ((match = classRegex.exec(stripped)) !== null) {
		const rawName = match[1];
		const openBracePos = match.index + match[0].length - 1;
		const closeBracePos = findMatchingBrace(stripped, openBracePos);
		if (closeBracePos === -1) { continue; }
		const body = stripped.slice(openBracePos + 1, closeBracePos);
		return { className: rawName, body, header: stripped.slice(match.index, openBracePos) };
	}
	return undefined;
}

/**
 * Normalises whitespace runs to a single space and trims.
 */
function normaliseWs(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

/**
 * Extracts public properties from the class body.
 * Handles both auto-properties and expression-bodied ones.
 */
function extractPublicProperties(body: string): PropertySignature[] {
	const results: PropertySignature[] = [];
	const maskedBody = maskNonCode(body);

	// Match: public [mods] Type Name { [get;] [set;] }
	// Also handles expression-bodied: public Type Name => ...;
	const propRegex = /\bpublic\s+((?:(?:static|virtual|abstract|override|new|required)\s+)*)([^\s{;(]+(?:\s*<[^>]*>)?(?:\?|(?:\s*\[\s*\])+)?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\{([^}]*)\}|=>)/g;

	let match: RegExpExecArray | null;
	while ((match = propRegex.exec(maskedBody)) !== null) {
		const type = normaliseWs(match[2]);
		const name = match[3];
		let accessors = '';
		if (match[4] !== undefined) {
			const start = match.index + match[0].indexOf('{');
			const end = findMatchingBrace(maskedBody, start);
			if (end < 0) { continue; }
			accessors = maskedBody.slice(start + 1, end);
			propRegex.lastIndex = end + 1;
		}
		if (/\bstatic\b/.test(match[1])) { continue; }

		// Skip indexers
		if (name === 'this') { continue; }
		// Skip if looks like a method (has parentheses before brace)
		const before = body.slice(Math.max(0, match.index), match.index + match[0].indexOf(name) + name.length + 5);
		if (/\(/.test(before.slice(before.indexOf(name) + name.length))) { continue; }

		const parsed = getPublicPropertyAccessors(accessors);
		const hasGet = match[4] === undefined || parsed.hasGet;
		const { hasSet, hasInit } = parsed;

		// Skip write-only (very rare) or if name is a keyword
		if (!hasGet && !hasSet && !hasInit) { continue; }

		results.push({ name, type, hasGet, hasSet, hasInit });
	}

	return results;
}

/**
 * Extracts public methods from the class body.
 * Skips constructors and operators.
 */
function extractPublicMethods(body: string, className: string): MethodSignature[] {
	const results: MethodSignature[] = [];

	// Match: public [mods] [async] ReturnType MethodName([params]) [where ...]
	const methodRegex = /\bpublic\s+((?:(?:static|virtual|abstract|override|new|async|sealed)\s+)*)([^\s(]+(?:\s*<[^>]*>)?(?:\?)?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(<[^>]*>)?\s*\(([^)]*)\)/g;

	let match: RegExpExecArray | null;
	while ((match = methodRegex.exec(body)) !== null) {
		const mods = match[1];
		if (/\bstatic\b/.test(mods)) { continue; }
		const returnType = normaliseWs(match[2]);
		const name = match[3];
		const rawParams = normaliseWs(match[5]);
		const constraints = normaliseWs(maskNonCode(body.slice(methodRegex.lastIndex))
			.match(/^\s*(where\b[\s\S]*?)(?=\s*(?:=>|\{|;))/)?.[1] ?? '') || undefined;

		// Skip constructors (name === className), operators, property-like things
		if (name === className) { continue; }
		if (name === 'operator') { continue; }
		// Skip if returnType is "class" or "interface" etc. (false positive from nested type)
		if (/^(class|struct|enum|interface|delegate|event)$/.test(returnType)) { continue; }

		const isAsync = /\basync\b/.test(mods);

		// Normalise parameter list: keep type names only (strip defaults)
		const cleanedParams = rawParams
			.split(',')
			.map(p => {
				const trimmed = p.trim();
				if (!trimmed) { return ''; }
				// Remove default values
				return trimmed.replace(/\s*=\s*.+$/, '').trim();
			})
			.filter(Boolean)
			.join(', ');

		results.push({ name, returnType, parameters: cleanedParams, isAsync,
			typeParameters: match[4] ? normaliseWs(match[4]) : undefined, constraints });
	}

	return results;
}

/**
 * Extracts all public members (properties + methods) from a C# class.
 */
export function extractPublicMembers(content: string): ExtractedMembers | undefined {
	const classInfo = extractClassBody(content);
	if (!classInfo) { return undefined; }

	const { className, body, header } = classInfo;
	const properties = extractPublicProperties(body);
	const methods = extractPublicMethods(body, className);

	return { className, ...parseGenericDeclaration(header, className), properties, methods };
}

// ---------------------------------------------------------------------------
// Interface code generation
// ---------------------------------------------------------------------------

/**
 * Generates the interface file content.
 */
export function generateInterfaceContent(
	members: ExtractedMembers,
	interfaceName: string,
	namespaceName: string | undefined,
	eol: string,
	context?: TypeFileContext
): string {
	const lines: string[] = [];

	lines.push(`public interface ${interfaceName}${members.typeParameters ?? ''}`);
	if (members.constraints) { lines.push(`    ${members.constraints}`); }
	lines.push('{');

	// Properties
	for (const prop of members.properties) {
		const accessors = [prop.hasGet ? 'get;' : '', prop.hasSet ? 'set;' : '', prop.hasInit ? 'init;' : '']
			.filter(Boolean).join(' ');
		lines.push(`    ${prop.type} ${prop.name} { ${accessors} }`);
	}

	if (members.properties.length > 0 && members.methods.length > 0) {
		lines.push('');
	}

	// Methods
	for (const method of members.methods) {
		lines.push(`    ${method.returnType} ${method.name}${method.typeParameters ?? ''}(${method.parameters})${method.constraints ? ` ${method.constraints}` : ''};`);
	}

	lines.push('}');

	return buildTypeFileContent(lines.join(eol), context ?? {
		usings: [],
		namespaces: namespaceName ? [{ name: namespaceName, usings: [] }] : [],
	}, eol);
}

// ---------------------------------------------------------------------------
// Main command entry point
// ---------------------------------------------------------------------------

/**
 * Extracts an interface from the public members of the first public class in
 * the given .cs file and creates a new I<ClassName>.cs file next to it.
 */
export async function extractInterfaceFromFile(fileUri: vscode.Uri): Promise<void> {
	// Ensure it is a .cs file
	if (!fileUri.path.endsWith('.cs')) {
		vscode.window.showErrorMessage('This command only works on .cs files.');
		return;
	}

	// Extract members
	const document = await vscode.workspace.openTextDocument(fileUri);
	const type = (await csharpLanguageService.getTypes(document)).find(type => type.public && !type.nested && type.type === 'class');
	if (!type) {
		vscode.window.showErrorMessage('No public class found in the selected file.');
		return;
	}
	const content = document.getText();
	const members: ExtractedMembers = {
		className: type.name,
		...parseGenericDeclaration(csharpLanguageService.getHeader(document, type), type.name),
		properties: type.symbol.children.filter(symbol => symbol.kind === vscode.SymbolKind.Property)
			.flatMap(symbol => extractPublicProperties(document.getText(symbol.range))
				.filter(property => property.name === document.getText(symbol.selectionRange)).slice(0, 1)),
		methods: type.symbol.children.filter(symbol => symbol.kind === vscode.SymbolKind.Method)
			.flatMap(symbol => extractPublicMethods(document.getText(symbol.range), type.name)
				.filter(method => method.name === document.getText(symbol.selectionRange)).slice(0, 1)),
	};

	if (members.properties.length === 0 && members.methods.length === 0) {
		vscode.window.showWarningMessage(
			`Class "${members.className}" has no public properties or methods to extract.`
		);
		return;
	}

	// Propose the interface name
	const defaultInterfaceName = `I${members.className}`;
	const interfaceName = await vscode.window.showInputBox({
		prompt: 'Interface name',
		value: defaultInterfaceName,
		validateInput: v =>
			/^I[A-Za-z_][A-Za-z0-9_]*$/.test(v)
				? undefined
				: 'Interface name must start with "I" followed by a valid identifier',
	});

	if (!interfaceName) {
		return; // user cancelled
	}

	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	const namespaceName = type.namespace;
	const interfaceContent = generateInterfaceContent(members, interfaceName, namespaceName, eol,
		await csharpLanguageService.getTypeFileContext(document, type));

	// Determine output path: same directory as the source file
	const dir = path.posix.dirname(fileUri.path);
	const outPath = `${dir}/${interfaceName}.cs`;
	const outUri = fileUri.with({ path: outPath });

	// Check if file already exists
	try {
		await vscode.workspace.fs.stat(outUri);
		const overwrite = await vscode.window.showWarningMessage(
			`File "${interfaceName}.cs" already exists. Overwrite?`,
			'Overwrite',
			'Cancel'
		);
		if (overwrite !== 'Overwrite') { return; }
	} catch {
		// File doesn't exist – good
	}

	// Write interface file
	await vscode.workspace.fs.writeFile(outUri, Buffer.from(interfaceContent, 'utf-8'));

	// Open the new file
	const doc = await vscode.workspace.openTextDocument(outUri);
	await vscode.window.showTextDocument(doc, { preview: false });

	vscode.window.showInformationMessage(
		`Interface "${interfaceName}" extracted with ${members.properties.length} property/ies and ${members.methods.length} method(s).`
	);
}
