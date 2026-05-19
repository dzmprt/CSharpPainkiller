import * as vscode from 'vscode';
import * as path from 'path';
import { extractFileNamespace } from '../utils/contentParser.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PropertySignature {
	name: string;
	type: string;
	hasGet: boolean;
	hasSet: boolean;
}

interface MethodSignature {
	name: string;
	returnType: string;
	parameters: string;
	isAsync: boolean;
}

interface ExtractedMembers {
	className: string;
	properties: PropertySignature[];
	methods: MethodSignature[];
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Removes single-line and multi-line comments from content.
 */
function stripComments(content: string): string {
	// Multi-line comments first
	content = content.replace(/\/\*[\s\S]*?\*\//g, ' ');
	// Single-line comments
	content = content.replace(/\/\/[^\n]*/g, '');
	return content;
}

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
function extractClassBody(content: string): { className: string; body: string } | undefined {
	const stripped = stripComments(content);

	// Match: public [optional-mods] class ClassName [: BaseClass, IFoo]
	const classRegex = /\bpublic\s+(?:(?:static|sealed|abstract|partial)\s+)*class\s+([A-Za-z_][A-Za-z0-9_<>,\s]*?)\s*(?:<[^>]*>)?\s*(?::[^{]*)?\{/g;

	let match: RegExpExecArray | null;
	while ((match = classRegex.exec(stripped)) !== null) {
		// Extract the raw class name (without generic parameters)
		const rawName = match[1].trim().replace(/<.*$/, '');
		const openBracePos = match.index + match[0].length - 1;
		const closeBracePos = findMatchingBrace(stripped, openBracePos);
		if (closeBracePos === -1) { continue; }
		const body = stripped.slice(openBracePos + 1, closeBracePos);
		return { className: rawName, body };
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

	// Match: public [mods] Type Name { [get;] [set;] }
	// Also handles expression-bodied: public Type Name => ...;
	const propRegex = /\bpublic\s+(?:(?:static|virtual|abstract|override|new|required)\s+)*([^\s{;(]+(?:\s*<[^>]*>)?(?:\?|(?:\s*\[\s*\])+)?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\{([^}]*)\}|=>)/g;

	let match: RegExpExecArray | null;
	while ((match = propRegex.exec(body)) !== null) {
		const type = normaliseWs(match[1]);
		const name = match[2];
		const accessors = match[3] ?? ''; // undefined for expression-bodied → treat as get-only

		// Skip indexers
		if (name === 'this') { continue; }
		// Skip if looks like a method (has parentheses before brace)
		const before = body.slice(Math.max(0, match.index), match.index + match[0].indexOf(name) + name.length + 5);
		if (/\(/.test(before.slice(before.indexOf(name) + name.length))) { continue; }

		const hasGet = accessors === '' || /\bget\b/.test(accessors);
		const hasSet = /\bset\b|\binit\b/.test(accessors);

		// Skip write-only (very rare) or if name is a keyword
		if (!hasGet && !hasSet) { continue; }

		results.push({ name, type, hasGet: true, hasSet });
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
	const methodRegex = /\bpublic\s+((?:(?:static|virtual|abstract|override|new|async|sealed)\s+)*)([^\s(]+(?:\s*<[^>]*>)?(?:\?)?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*)?\s*\(([^)]*)\)/g;

	let match: RegExpExecArray | null;
	while ((match = methodRegex.exec(body)) !== null) {
		const mods = match[1];
		const returnType = normaliseWs(match[2]);
		const name = match[3];
		const rawParams = normaliseWs(match[4]);

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

		results.push({ name, returnType, parameters: cleanedParams, isAsync });
	}

	return results;
}

/**
 * Extracts all public members (properties + methods) from a C# class.
 */
export function extractPublicMembers(content: string): ExtractedMembers | undefined {
	const classInfo = extractClassBody(content);
	if (!classInfo) { return undefined; }

	const { className, body } = classInfo;
	const properties = extractPublicProperties(body);
	const methods = extractPublicMethods(body, className);

	return { className, properties, methods };
}

// ---------------------------------------------------------------------------
// Interface code generation
// ---------------------------------------------------------------------------

/**
 * Generates the interface file content.
 */
function generateInterfaceContent(
	members: ExtractedMembers,
	interfaceName: string,
	namespaceName: string | undefined,
	eol: string
): string {
	const lines: string[] = [];

	if (namespaceName) {
		lines.push(`namespace ${namespaceName};`);
		lines.push('');
	}

	lines.push(`public interface ${interfaceName}`);
	lines.push('{');

	// Properties
	for (const prop of members.properties) {
		const accessors = prop.hasGet && prop.hasSet
			? 'get; set;'
			: prop.hasGet
				? 'get;'
				: 'set;';
		lines.push(`    ${prop.type} ${prop.name} { ${accessors} }`);
	}

	if (members.properties.length > 0 && members.methods.length > 0) {
		lines.push('');
	}

	// Methods
	for (const method of members.methods) {
		// In the interface, async methods drop the Task wrapper in the signature only
		// when returning void → use Task instead
		let returnType = method.returnType;
		if (method.isAsync && returnType === 'void') {
			returnType = 'Task';
		}
		lines.push(`    ${returnType} ${method.name}(${method.parameters});`);
	}

	lines.push('}');

	return lines.join(eol);
}

// ---------------------------------------------------------------------------
// Main command entry point
// ---------------------------------------------------------------------------

/**
 * Extracts an interface from the public members of the first public class in
 * the given .cs file and creates a new I<ClassName>.cs file next to it.
 */
export async function extractInterfaceFromFile(fileUri: vscode.Uri): Promise<void> {
	// Read file
	let content: string;
	try {
		const raw = await vscode.workspace.fs.readFile(fileUri);
		content = Buffer.from(raw).toString('utf-8');
	} catch {
		vscode.window.showErrorMessage('Cannot read the selected file.');
		return;
	}

	// Ensure it is a .cs file
	if (!fileUri.path.endsWith('.cs')) {
		vscode.window.showErrorMessage('This command only works on .cs files.');
		return;
	}

	// Extract members
	const members = extractPublicMembers(content);
	if (!members) {
		vscode.window.showErrorMessage('No public class found in the selected file.');
		return;
	}

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
	const namespaceName = extractFileNamespace(content);
	const interfaceContent = generateInterfaceContent(members, interfaceName, namespaceName, eol);

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
	await vscode.workspace.fs.writeFile(outUri, Buffer.from(interfaceContent + eol, 'utf-8'));

	// Open the new file
	const doc = await vscode.workspace.openTextDocument(outUri);
	await vscode.window.showTextDocument(doc, { preview: false });

	vscode.window.showInformationMessage(
		`Interface "${interfaceName}" extracted with ${members.properties.length} property/ies and ${members.methods.length} method(s).`
	);
}
