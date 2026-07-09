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

// ============================================================================
// Canonical sort order — shared by the "Sort Usings" command and the
// unsorted-usings diagnostic, so both always agree on what "sorted" means.
// ============================================================================

/**
 * Determines the sort group for a using directive:
 * 0 = global usings, 1 = `System.*` namespace usings, 2 = other namespace usings,
 * 3 = static usings, 4 = alias usings.
 */
export function getUsingSortGroup(usingDirective: TopLevelUsingDirective): number {
	if (usingDirective.isGlobal) {
		return 0;
	}
	if (usingDirective.kind === 'namespace' && usingDirective.namespace.startsWith('System')) {
		return 1;
	}
	if (usingDirective.kind === 'namespace') {
		return 2;
	}
	if (usingDirective.kind === 'static') {
		return 3;
	}
	return 4;
}

/**
 * Compares two using directives using the canonical CSharp Painkiller sort order:
 * group (global → `System.*` → other namespaces → static → alias), then alphabetically
 * by namespace, then by alias.
 */
export function compareUsingDirectives(a: TopLevelUsingDirective, b: TopLevelUsingDirective): number {
	const groupDiff = getUsingSortGroup(a) - getUsingSortGroup(b);
	if (groupDiff !== 0) {
		return groupDiff;
	}
	const namespaceDiff = a.namespace.localeCompare(b.namespace);
	if (namespaceDiff !== 0) {
		return namespaceDiff;
	}
	return (a.alias ?? '').localeCompare(b.alias ?? '');
}

/**
 * Returns true if the given using directives are already in canonical sorted order
 * (this only checks ordering, not deduplication).
 */
export function isUsingOrderSorted(directives: TopLevelUsingDirective[]): boolean {
	for (let i = 1; i < directives.length; i++) {
		if (compareUsingDirectives(directives[i - 1], directives[i]) > 0) {
			return false;
		}
	}
	return true;
}
