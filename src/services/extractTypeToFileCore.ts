import {
	escapeRegExp,
	extractFileNamespace,
} from '../utils/contentParser.js';
import { type CType } from '../types.js';

export interface TypeDeclarationSpan {
	start: number;
	end: number;
	text: string;
}

interface ExtractableType {
	name: string;
	type: CType;
}

const TYPE_LISTING_PATTERNS: { type: CType; regex: RegExp }[] = [
	{ type: 'record struct', regex: /\b(?:readonly\s+)?record\s+struct\s+([A-Za-z_][A-Za-z0-9_]*)/g },
	{ type: 'record', regex: /\b(?:readonly\s+)?record\s+(?!struct\b)([A-Za-z_][A-Za-z0-9_]*)/g },
	{ type: 'class', regex: /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/g },
	{ type: 'struct', regex: /(?<!record\s)\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)/g },
	{ type: 'enum', regex: /\benum\s+([A-Za-z_][A-Za-z0-9_]*)/g },
	{ type: 'interface', regex: /\binterface\s+([A-Za-z_][A-Za-z0-9_]*)/g },
];

export function listExtractableTypes(content: string): ExtractableType[] {
	const types: ExtractableType[] = [];
	for (const { type, regex } of TYPE_LISTING_PATTERNS) {
		regex.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = regex.exec(content)) !== null) {
			const name = match[1];
			if (!types.some(existing => existing.name === name)) {
				types.push({ name, type });
			}
		}
	}
	return types;
}

function skipWhitespace(content: string, pos: number): number {
	while (pos < content.length && /\s/.test(content[pos]) && content[pos] !== '\n' && content[pos] !== '\r') {
		pos++;
	}
	return pos;
}

function skipAllWhitespace(content: string, pos: number): number {
	while (pos < content.length && /\s/.test(content[pos])) {
		pos++;
	}
	return pos;
}

function findMatchingChar(content: string, openPos: number, openChar: string, closeChar: string): number {
	let depth = 0;
	for (let i = openPos; i < content.length; i++) {
		if (content[i] === openChar) {
			depth++;
		} else if (content[i] === closeChar) {
			depth--;
			if (depth === 0) {
				return i + 1;
			}
		}
	}
	return -1;
}

function findMatchingBrace(content: string, openPos: number): number {
	return findMatchingChar(content, openPos, '{', '}');
}

function extendStartForLeadingElements(content: string, start: number): number {
	let lineStart = content.lastIndexOf('\n', start - 1) + 1;
	while (lineStart > 0) {
		const prevLineEnd = lineStart - 1;
		if (prevLineEnd < 0) {
			break;
		}
		const prevLineStart = content.lastIndexOf('\n', prevLineEnd - 1) + 1;
		const trimmed = content.slice(prevLineStart, prevLineEnd).trim();
		if (trimmed === '') {
			break;
		}
		if (trimmed.startsWith('///') || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
			start = prevLineStart;
			lineStart = prevLineStart;
			continue;
		}
		break;
	}
	return start;
}

function skipGenericsAndConstraints(content: string, pos: number): number {
	pos = skipWhitespace(content, pos);

	if (content[pos] === '<') {
		const afterGeneric = findMatchingChar(content, pos, '<', '>');
		if (afterGeneric === -1) {
			return pos;
		}
		pos = skipWhitespace(content, afterGeneric);
	}

	if (content[pos] === '(') {
		const afterParams = findMatchingChar(content, pos, '(', ')');
		if (afterParams === -1) {
			return pos;
		}
		pos = skipWhitespace(content, afterParams);
	}

	if (content[pos] === ':') {
		pos++;
		while (pos < content.length) {
			pos = skipAllWhitespace(content, pos);
			if (content[pos] === '{' || content[pos] === ';') {
				break;
			}
			pos++;
		}
	}

	while (/^\s*where\b/.test(content.slice(pos))) {
		const nextLine = content.indexOf('\n', pos);
		if (nextLine === -1) {
			pos = content.length;
			break;
		}
		pos = nextLine + 1;
	}

	return pos;
}

function findDeclarationEnd(content: string, pos: number): number {
	pos = skipAllWhitespace(content, pos);

	if (pos >= content.length) {
		return -1;
	}

	if (content[pos] === ';') {
		return pos + 1;
	}

	if (content[pos] === '{') {
		const closeBrace = findMatchingBrace(content, pos);
		return closeBrace === -1 ? -1 : closeBrace;
	}

	return -1;
}

function buildKeywordPattern(typeName: string, type: CType): string {
	const escaped = escapeRegExp(typeName);
	switch (type) {
		case 'record struct':
			return `(?:readonly\\s+)?record\\s+struct\\s+${escaped}`;
		case 'record':
			return `(?:readonly\\s+)?record\\s+${escaped}`;
		default:
			return `${type}\\s+${escaped}`;
	}
}

export function findTypeDeclarationSpan(content: string, typeName: string): TypeDeclarationSpan | undefined {
	const typeDef = listExtractableTypes(content).find(t => t.name === typeName);
	if (!typeDef) {
		return undefined;
	}

	const keywordPattern = buildKeywordPattern(typeName, typeDef.type);
	const re = new RegExp(
		`(?:^|[\\n\\r])(\\s*(?:\\[[^\\]]*\\]\\s*)*)` +
		`((?:public|internal|private|protected)\\s+)?` +
		`(?:(?:static|sealed|abstract|partial|readonly|new)\\s+)*` +
		`${keywordPattern}\\b`,
		'gm'
	);

	let match: RegExpExecArray | null;
	while ((match = re.exec(content)) !== null) {
		let start = match.index;
		if (content[start] === '\n' || content[start] === '\r') {
			start++;
		}
		start = extendStartForLeadingElements(content, start);

		let pos = match.index + match[0].length;
		pos = skipGenericsAndConstraints(content, pos);
		const end = findDeclarationEnd(content, pos);
		if (end === -1) {
			continue;
		}

		return { start, end, text: content.slice(start, end) };
	}

	return undefined;
}

export function canExtractTypeFromFile(content: string, typeName: string, fileBaseName: string): boolean {
	const types = listExtractableTypes(content);
	if (types.length <= 1) {
		return false;
	}
	if (fileBaseName === typeName) {
		return false;
	}
	if (!types.some(t => t.name === typeName)) {
		return false;
	}

	const span = findTypeDeclarationSpan(content, typeName);
	if (!span) {
		return false;
	}

	return !/\bpartial\b/.test(span.text);
}

function extractUsingLines(content: string): string[] {
	const lines = content.split('\n');
	const usings: string[] = [];
	for (const line of lines) {
		if (/^using\s+[\w.]+\s*;/.test(line)) {
			usings.push(line.trimEnd());
		} else if (line.trim() !== '' && !line.trim().startsWith('//')) {
			break;
		}
	}
	return usings;
}

function dedentOneLevel(text: string): string {
	const lines = text.split('\n');
	const indents = lines
		.filter(line => line.trim().length > 0)
		.map(line => line.match(/^(\s+)/)?.[1]?.length ?? 0);
	if (indents.length === 0) {
		return text.trimEnd();
	}

	const minIndent = Math.min(...indents);
	if (minIndent === 0) {
		return text.trimEnd();
	}

	return lines
		.map(line => (line.length >= minIndent ? line.slice(minIndent) : line))
		.join('\n')
		.trimEnd();
}

function normalizeExtractedTypeText(text: string): string {
	const lines = text.split('\n');

	while (lines.length > 0 && lines[0].trim() === '') {
		lines.shift();
	}

	let lastDocLineIndex = -1;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (trimmed.startsWith('///')) {
			lastDocLineIndex = i;
		} else if (trimmed !== '') {
			break;
		}
	}

	if (lastDocLineIndex >= 0) {
		const normalized = [...lines.slice(0, lastDocLineIndex + 1)];
		let nextIndex = lastDocLineIndex + 1;
		while (nextIndex < lines.length && lines[nextIndex].trim() === '') {
			nextIndex++;
		}
		normalized.push(...lines.slice(nextIndex));
		return dedentOneLevel(normalized.join('\n').trimEnd());
	}

	return dedentOneLevel(lines.join('\n').trimEnd());
}

export function buildExtractedFileContent(sourceContent: string, typeDeclaration: string): string {
	const eol = sourceContent.includes('\r\n') ? '\r\n' : '\n';
	const usings = extractUsingLines(sourceContent);
	const namespace = extractFileNamespace(sourceContent);
	const typeText = normalizeExtractedTypeText(typeDeclaration);

	const parts: string[] = [];
	if (usings.length > 0) {
		parts.push(...usings);
		parts.push('');
	}
	if (namespace) {
		parts.push(`namespace ${namespace};`);
		parts.push('');
	}
	parts.push(typeText);
	parts.push('');

	return parts.join(eol);
}

export function removeTypeFromContent(content: string, span: TypeDeclarationSpan): string {
	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	const before = content.slice(0, span.start).replace(/[\r\n]+$/, '');
	const after = content.slice(span.end).replace(/^[\r\n]+/, '');

	if (before.length > 0 && after.length > 0) {
		return `${before}${eol}${eol}${after}`;
	}

	return `${before}${before.length > 0 ? eol : ''}${after}`;
}
