export type UsingDirectiveKind = 'namespace' | 'static' | 'alias';

export interface TopLevelUsingDirective {
	fullText: string;
	namespace: string;
	alias?: string;
	kind: UsingDirectiveKind;
	isGlobal: boolean;
	start: number;
	end: number;
}

export interface TopLevelUsingBlock {
	directives: TopLevelUsingDirective[];
	start: number;
	end: number;
	eol: string;
}

export interface TypeFileContext {
	usings: string[];
	namespaces: { name: string; usings: string[] }[];
}

export function buildTypeFileContent(typeDeclaration: string, context: TypeFileContext, eol: string): string {
	const lines = [...context.usings];
	if (lines.length > 0) { lines.push(''); }
	if (context.namespaces.length === 1) {
		const namespace = context.namespaces[0];
		lines.push(`namespace ${namespace.name};`, '');
		if (namespace.usings.length > 0) { lines.push(...namespace.usings, ''); }
		lines.push(...typeDeclaration.trimEnd().split(/\r?\n/));
	} else {
		let indent = '';
		for (const namespace of context.namespaces) {
			lines.push(`${indent}namespace ${namespace.name}`, `${indent}{`);
			indent += '    ';
			if (namespace.usings.length > 0) {
				lines.push(...namespace.usings.map(using => `${indent}${using}`), '');
			}
		}
		lines.push(...typeDeclaration.trimEnd().split(/\r?\n/).map(line => line ? `${indent}${line}` : ''));
		for (let i = context.namespaces.length - 1; i >= 0; i--) {
			indent = indent.slice(0, -4);
			lines.push(`${indent}}`);
		}
	}
	return lines.join(eol) + eol;
}

const USING_DIRECTIVE_REGEX = /^\s*(global\s+)?using\s+(?:(static)\s+)?(?:(?<alias>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*)?(?<namespace>[\w.]+)\s*;[ \t]*(?:\/\/.*)?$/;

function isBlank(line: string): boolean {
	return line.trim() === '';
}

function parseUsingLine(line: string): Omit<TopLevelUsingDirective, 'fullText' | 'start' | 'end'> | undefined {
	const normalizedLine = line.replace(/^\uFEFF/, '');
	const match = normalizedLine.match(USING_DIRECTIVE_REGEX);
	if (!match?.groups) {
		return undefined;
	}

	const alias = match.groups.alias;
	return {
		namespace: match.groups.namespace,
		alias,
		kind: alias ? 'alias' : match[2] ? 'static' : 'namespace',
		isGlobal: Boolean(match[1]),
	};
}
/**
 * Collects only the leading using block. This deliberately stops before the
 * namespace/type body so refactor commands never rewrite nested using blocks.
 */
export function collectTopLevelUsingBlock(content: string): TopLevelUsingBlock | undefined {
	const eol = content.includes('\r\n') ? '\r\n' : '\n';
	const directives: TopLevelUsingDirective[] = [];
	const lineRegex = /(.*?)(\r\n|\n|$)/g;
	let match: RegExpExecArray | null;

	while ((match = lineRegex.exec(content)) !== null) {
		const line = match[1];
		const newline = match[2];
		const start = match.index;
		const end = start + line.length + newline.length;

		if (line === '' && newline === '') {
			break;
		}

		const parsed = parseUsingLine(line);
		if (parsed) {
			directives.push({
				...parsed,
				fullText: line,
				start,
				end,
			});
			continue;
		}

		if (directives.length === 0 && isBlank(line)) {
			continue;
		}

		break;
	}

	if (directives.length === 0) {
		return undefined;
	}

	return {
		directives,
		start: directives[0].start,
		end: directives[directives.length - 1].end,
		eol,
	};
}
