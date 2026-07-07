import * as vscode from 'vscode';
import * as pathModule from 'path';

// ============================================================================
// Types
// ============================================================================

export interface NugetSource {
	name: string;
	url: string;
}

interface ServiceResource {
	'@type': string;
	'@id': string;
}

interface NugetSearchPackage {
	id: string;
	version: string;
	description?: string;
}

// ============================================================================
// Auth error
// ============================================================================

class AuthRequiredError extends Error {
	constructor(public readonly sourceUrl: string) {
		super(`Authentication required`);
		this.name = 'AuthRequiredError';
	}
}

// ============================================================================
// Service index cache
// ============================================================================

const serviceIndexCache = new Map<string, ServiceResource[]>();

// ============================================================================
// API helpers
// ============================================================================

async function fetchJson<T>(url: string): Promise<T> {
	const response = await fetch(url, {
		headers: { Accept: 'application/json' },
		signal: AbortSignal.timeout(15_000),
	});
	if (response.status === 401 || response.status === 403) {
		throw new AuthRequiredError(url);
	}
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} fetching ${url}`);
	}
	return response.json() as Promise<T>;
}

async function getServiceResources(sourceUrl: string): Promise<ServiceResource[]> {
	const cached = serviceIndexCache.get(sourceUrl);
	if (cached) {
		return cached;
	}
	const index = await fetchJson<{ resources: ServiceResource[] }>(sourceUrl);
	const resources = index.resources ?? [];
	serviceIndexCache.set(sourceUrl, resources);
	return resources;
}

async function getResourceUrl(sourceUrl: string, ...preferredTypes: string[]): Promise<string | undefined> {
	const resources = await getServiceResources(sourceUrl);
	for (const type of preferredTypes) {
		const found = resources.find(r => r['@type'] === type);
		if (found) {
			return found['@id'];
		}
	}
	// Prefix fallback
	for (const type of preferredTypes) {
		const prefix = type.split('/')[0];
		const found = resources.find(r => r['@type'].startsWith(prefix));
		if (found) {
			return found['@id'];
		}
	}
	return undefined;
}

async function searchPackages(
	sourceUrl: string,
	query: string,
	preRelease: boolean,
): Promise<NugetSearchPackage[]> {
	const searchUrl = await getResourceUrl(
		sourceUrl,
		'SearchQueryService/3.5.0',
		'SearchQueryService/3.0.0-rc',
		'SearchQueryService',
	);
	if (!searchUrl) {
		throw new Error('Source does not support package search');
	}
	const params = new URLSearchParams({
		q: query,
		prerelease: String(preRelease),
		take: '20',
		semVerLevel: '2.0.0',
	});
	const result = await fetchJson<{ data: NugetSearchPackage[] }>(`${searchUrl}?${params}`);
	return result.data ?? [];
}

async function getPackageVersions(
	sourceUrl: string,
	packageId: string,
	preRelease: boolean,
): Promise<string[]> {
	const baseUrl = await getResourceUrl(sourceUrl, 'PackageBaseAddress/3.0.0', 'PackageBaseAddress');
	if (!baseUrl) {
		return [];
	}
	const url = `${baseUrl.replace(/\/$/, '')}/${packageId.toLowerCase()}/index.json`;
	const result = await fetchJson<{ versions: string[] }>(url);
	const all = [...(result.versions ?? [])].reverse();
	return preRelease ? all : all.filter(v => !v.includes('-'));
}

// ============================================================================
// nuget.config parsing
// ============================================================================

function parseNugetConfig(content: string): { sources: NugetSource[]; disabled: Set<string> } {
	const sources: NugetSource[] = [];
	const disabled = new Set<string>();

	const sourcesBlock = content.match(/<packageSources>([\s\S]*?)<\/packageSources>/i)?.[1] ?? '';
	const addRegex = /<add\b[^>]*\bkey="([^"]+)"[^>]*\bvalue="([^"]+)"[^>]*\/?>/gi;
	let m: RegExpExecArray | null;
	while ((m = addRegex.exec(sourcesBlock)) !== null) {
		sources.push({ name: m[1], url: m[2] });
	}

	const disabledBlock = content.match(/<disabledPackageSources>([\s\S]*?)<\/disabledPackageSources>/i)?.[1] ?? '';
	const disabledRegex = /<add\b[^>]*\bkey="([^"]+)"[^>]*\bvalue="true"[^>]*\/?>/gi;
	while ((m = disabledRegex.exec(disabledBlock)) !== null) {
		disabled.add(m[1]);
	}

	return { sources, disabled };
}

const NUGET_ORG_DEFAULT: NugetSource = { name: 'nuget.org', url: 'https://api.nuget.org/v3/index.json' };

export async function getNugetSources(csprojFsPath: string): Promise<NugetSource[]> {
	const sources: NugetSource[] = [];
	const seenUrls = new Set<string>();

	const addSource = (s: NugetSource) => {
		if (!seenUrls.has(s.url.toLowerCase())) {
			seenUrls.add(s.url.toLowerCase());
			sources.push(s);
		}
	};

	// Walk up from the project directory to find nuget.config files
	let dir = pathModule.dirname(csprojFsPath);
	const visited = new Set<string>();
	while (dir && !visited.has(dir)) {
		visited.add(dir);
		for (const name of ['nuget.config', 'NuGet.Config', 'Nuget.Config']) {
			try {
				const uri = vscode.Uri.file(pathModule.join(dir, name));
				const bytes = await vscode.workspace.fs.readFile(uri);
				const content = Buffer.from(bytes).toString('utf-8');
				const { sources: fileSources, disabled } = parseNugetConfig(content);
				for (const s of fileSources) {
					if (!disabled.has(s.name)) {
						addSource(s);
					}
				}
				break;
			} catch {
				// not found, continue
			}
		}
		const parent = pathModule.dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}

	// Always include nuget.org if not already present via config
	if (!sources.some(s => s.url.toLowerCase().includes('nuget.org'))) {
		sources.unshift(NUGET_ORG_DEFAULT);
	}

	return sources.length > 0 ? sources : [NUGET_ORG_DEFAULT];
}

// ============================================================================
// UI buttons
// ============================================================================

const PRERELEASE_OFF_BUTTON: vscode.QuickInputButton = {
	iconPath: new vscode.ThemeIcon('eye-closed'),
	tooltip: 'Show pre-release packages',
};

const PRERELEASE_ON_BUTTON: vscode.QuickInputButton = {
	iconPath: new vscode.ThemeIcon('eye'),
	tooltip: 'Hide pre-release packages',
};

// ============================================================================
// Package search picker
// ============================================================================

export async function showAddPackagePicker(
	csprojFsPath: string,
): Promise<{ id: string; version: string } | undefined> {
	const sources = await getNugetSources(csprojFsPath);

	let selectedSource: NugetSource;
	if (sources.length === 1) {
		selectedSource = sources[0];
	} else {
		const sourcePick = await vscode.window.showQuickPick(
			sources.map(s => ({ label: s.name, description: s.url, source: s })),
			{ placeHolder: 'Select NuGet source', title: 'Add NuGet Package' },
		);
		if (!sourcePick) {
			return undefined;
		}
		selectedSource = sourcePick.source;
	}

	return showPackageSearchPicker(selectedSource);
}

function showPackageSearchPicker(
	source: NugetSource,
): Promise<{ id: string; version: string } | undefined> {
	return new Promise(resolve => {
		let preRelease = false;
		let debounceTimer: ReturnType<typeof setTimeout> | undefined;
		let accepted = false;

		const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { packageId?: string }>();
		qp.placeholder = 'Type a package name to search...';
		qp.title = `Add NuGet Package — ${source.name}`;
		qp.buttons = [PRERELEASE_OFF_BUTTON];
		qp.canSelectMany = false;
		qp.matchOnDescription = false;
		qp.matchOnDetail = false;
		qp.keepScrollPosition = true;

		const doSearch = (query: string) => {
			if (!query.trim()) {
				qp.items = [];
				qp.busy = false;
				return;
			}
			qp.busy = true;
			const currentQuery = query;

			searchPackages(source.url, currentQuery, preRelease)
				.then(packages => {
					if (qp.value !== currentQuery) {
						return; // stale result, discard
					}
					qp.items = packages.map(pkg => ({
						label: pkg.id,
						description: pkg.version,
						detail: pkg.description,
						packageId: pkg.id,
					}));
				})
				.catch((err: unknown) => {
					if (err instanceof AuthRequiredError) {
						accepted = true; // prevent onDidHide from double-resolving
						qp.dispose();
						vscode.window.showErrorMessage(
							`CSharp Painkiller: Authentication required for "${source.name}". ` +
							`Please configure credentials for this NuGet source ` +
							`(e.g. run \`dotnet nuget add source\` or set up credentials in nuget.config).`,
						);
						resolve(undefined);
						return;
					}
					vscode.window.showWarningMessage(
						`CSharp Painkiller: NuGet search failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				})
				.finally(() => {
					if (qp.value === currentQuery) {
						qp.busy = false;
					}
				});
		};

		qp.onDidChangeValue(value => {
			clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => doSearch(value), 350);
		});

		qp.onDidTriggerButton(() => {
			preRelease = !preRelease;
			qp.buttons = [preRelease ? PRERELEASE_ON_BUTTON : PRERELEASE_OFF_BUTTON];
			if (qp.value.trim()) {
				doSearch(qp.value);
			}
		});

		qp.onDidAccept(() => {
			const selected = qp.selectedItems[0];
			if (!selected?.packageId) {
				return;
			}
			const packageId = selected.packageId;
			const latestVersion = selected.description;
			accepted = true;
			clearTimeout(debounceTimer);
			qp.dispose();

			void showVersionPicker(source, packageId, preRelease, latestVersion)
				.then(version => resolve(version ? { id: packageId, version } : undefined));
		});

		qp.onDidHide(() => {
			clearTimeout(debounceTimer);
			if (!accepted) {
				resolve(undefined);
			}
			qp.dispose();
		});

		qp.show();
	});
}

// ============================================================================
// Version picker
// ============================================================================

function showVersionPicker(
	source: NugetSource,
	packageId: string,
	preRelease: boolean,
	latestVersion?: string,
): Promise<string | undefined> {
	return new Promise(resolve => {
		let accepted = false;
		const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
		qp.placeholder = 'Select a version';
		qp.title = `Select version for ${packageId}`;
		qp.busy = true;

		if (latestVersion) {
			qp.items = [{ label: latestVersion, description: '(latest stable)' }];
		}

		qp.show();

		getPackageVersions(source.url, packageId, preRelease)
			.then(versions => {
				if (versions.length > 0) {
					qp.items = versions.map((v, i) => ({
						label: v,
						description: i === 0 ? '(latest)' : undefined,
					}));
				} else if (!latestVersion) {
					// No versions found and no fallback — let user type manually
					qp.value = '';
				}
			})
			.catch((err: unknown) => {
				if (err instanceof AuthRequiredError) {
					accepted = true;
					qp.dispose();
					vscode.window.showErrorMessage(
						`CSharp Painkiller: Authentication required to fetch versions for "${packageId}".`,
					);
					resolve(undefined);
					return;
				}
				// Silently keep the fallback from search result
			})
			.finally(() => {
				qp.busy = false;
			});

		qp.onDidAccept(() => {
			const selected = qp.selectedItems[0];
			accepted = true;
			qp.dispose();
			resolve(selected?.label);
		});

		qp.onDidHide(() => {
			if (!accepted) {
				resolve(undefined);
			}
			qp.dispose();
		});
	});
}
