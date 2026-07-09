import * as vscode from 'vscode';
import * as pathModule from 'path';
import { execFile } from 'child_process';

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

export interface PackageUpdateInfo {
	id: string;
	requestedVersion?: string;
	resolvedVersion?: string;
	latestVersion: string;
}

export interface PackageInfo {
	id: string;
	requestedVersion?: string;
	resolvedVersion?: string;
}

export interface PackageVulnerabilityInfo {
	id: string;
	version?: string;
	severity: string;
	advisoryUrl?: string;
}

interface DotnetPackageListJson {
	projects?: Array<{
		frameworks?: Array<{
			topLevelPackages?: DotnetPackageListPackage[];
			transitivePackages?: DotnetPackageListPackage[];
		}>;
	}>;
}

interface DotnetPackageListPackage {
	id?: string;
	requestedVersion?: string;
	resolvedVersion?: string;
	latestVersion?: string;
	vulnerabilities?: DotnetPackageListVulnerability[];
}

interface DotnetPackageListVulnerability {
	severity?: string;
	advisoryUrl?: string;
	advisoryURL?: string;
	advisoryurl?: string;
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
// Version comparison and update checks
// ============================================================================

/**
 * Compares two (Nu)SemVer-ish version strings for ordering purposes.
 * Returns a positive number if `a` > `b`, negative if `a` < `b`, 0 if equal.
 * A release version is always considered greater than a prerelease of the
 * same core version (e.g. `1.0.0` > `1.0.0-beta`).
 */
export function compareVersions(a: string, b: string): number {
	const parse = (version: string) => {
		const [core, ...prereleaseParts] = version.split('+')[0].split('-');
		const prerelease = prereleaseParts.join('-');
		const segments = core.split('.').map(part => Number.parseInt(part, 10) || 0);
		return { segments, prerelease };
	};

	const pa = parse(a);
	const pb = parse(b);

	const length = Math.max(pa.segments.length, pb.segments.length);
	for (let i = 0; i < length; i++) {
		const diff = (pa.segments[i] ?? 0) - (pb.segments[i] ?? 0);
		if (diff !== 0) {
			return diff;
		}
	}

	if (!pa.prerelease && pb.prerelease) {
		return 1;
	}
	if (pa.prerelease && !pb.prerelease) {
		return -1;
	}
	return pa.prerelease.localeCompare(pb.prerelease);
}

/**
 * Finds the latest version of an already-installed package available across all
 * NuGet sources configured for the project.
 *
 * Throws if EVERY configured source failed to respond (e.g. no internet connection,
 * all sources require auth, DNS failure, etc.) — this is distinct from "checked
 * successfully and there's simply no newer version", so callers can tell the two
 * apart and avoid reporting a failed check as "up to date". Returns `undefined` only
 * when at least one source was reachable but the package/version genuinely couldn't
 * be resolved there.
 *
 * Defaults to stable (non-prerelease) releases only, matching the "latest release
 * version" the update check is meant to surface.
 */
export async function getLatestPackageVersion(
	csprojFsPath: string,
	packageId: string,
	preRelease = false,
): Promise<string | undefined> {
	if (!preRelease) {
		try {
			return (await getProjectPackageUpdates(csprojFsPath)).get(packageId.toLowerCase())?.latestVersion;
		} catch {
			// Fall back to direct source probing below for older SDKs or unsupported output.
		}
	}

	const sources = await getNugetSources(csprojFsPath);

	let anySourceReachable = false;
	const candidates = await Promise.all(
		sources.map(async source => {
			try {
				const versions = await getPackageVersions(source.url, packageId, preRelease);
				anySourceReachable = true;
				return versions[0]; // getPackageVersions returns descending order.
			} catch {
				return undefined;
			}
		}),
	);

	if (!anySourceReachable) {
		throw new Error(`Could not reach any configured NuGet source to check "${packageId}" for updates.`);
	}

	let latest: string | undefined;
	for (const candidate of candidates) {
		if (candidate && (!latest || compareVersions(candidate, latest) > 0)) {
			latest = candidate;
		}
	}
	return latest;
}

/**
 * Uses the .NET SDK's NuGet restore/listing pipeline to find outdated top-level
 * packages. This respects all active NuGet.config files, multiple sources,
 * credentials, source mappings, and non-nuget.org feeds better than direct HTTP
 * probing can.
 */
export async function getProjectPackageUpdates(csprojFsPath: string): Promise<Map<string, PackageUpdateInfo>> {
	const parsed = await runDotnetPackageList(csprojFsPath, '--outdated');
	const updates = new Map<string, PackageUpdateInfo>();

	for (const project of parsed.projects ?? []) {
		for (const framework of project.frameworks ?? []) {
			for (const pkg of framework.topLevelPackages ?? []) {
				if (!pkg.id || !pkg.latestVersion) {
					continue;
				}

				const key = pkg.id.toLowerCase();
				const current = updates.get(key);
				if (!current || compareVersions(pkg.latestVersion, current.latestVersion) > 0) {
					updates.set(key, {
						id: pkg.id,
						requestedVersion: pkg.requestedVersion,
						resolvedVersion: pkg.resolvedVersion,
						latestVersion: pkg.latestVersion,
					});
				}
			}
		}
	}

	return updates;
}

export async function getProjectPackages(csprojFsPath: string): Promise<Map<string, PackageInfo>> {
	const parsed = await runDotnetPackageList(csprojFsPath, '--include-transitive');
	return collectProjectPackages(parsed);
}

export function collectProjectPackages(parsed: DotnetPackageListJson): Map<string, PackageInfo> {
	const packages = new Map<string, PackageInfo>();

	for (const project of parsed.projects ?? []) {
		for (const framework of project.frameworks ?? []) {
			for (const pkg of [...(framework.topLevelPackages ?? []), ...(framework.transitivePackages ?? [])]) {
				if (!pkg.id) {
					continue;
				}

				const key = pkg.id.toLowerCase();
				const current = packages.get(key);
				if (!current || compareVersions(pkg.resolvedVersion ?? pkg.requestedVersion ?? '0', current.resolvedVersion ?? current.requestedVersion ?? '0') > 0) {
					packages.set(key, {
						id: pkg.id,
						requestedVersion: pkg.requestedVersion,
						resolvedVersion: pkg.resolvedVersion,
					});
				}
			}
		}
	}

	return packages;
}

export async function getProjectPackageVulnerabilities(csprojFsPath: string): Promise<PackageVulnerabilityInfo[]> {
	const parsed = await runDotnetPackageList(csprojFsPath, '--vulnerable', '--include-transitive');
	return collectPackageVulnerabilities(parsed);
}

export function collectPackageVulnerabilities(parsed: DotnetPackageListJson): PackageVulnerabilityInfo[] {
	const vulnerabilities = new Map<string, PackageVulnerabilityInfo>();

	for (const project of parsed.projects ?? []) {
		for (const framework of project.frameworks ?? []) {
			for (const pkg of [...(framework.topLevelPackages ?? []), ...(framework.transitivePackages ?? [])]) {
				if (!pkg.id || !pkg.vulnerabilities) {
					continue;
				}

				for (const vulnerability of pkg.vulnerabilities) {
					const severity = vulnerability.severity?.trim();
					if (!severity) {
						continue;
					}

					const advisoryUrl = (vulnerability.advisoryUrl ?? vulnerability.advisoryURL ?? vulnerability.advisoryurl)?.trim();
					const key = `${pkg.id.toLowerCase()}::${pkg.resolvedVersion ?? pkg.requestedVersion ?? ''}::${severity.toLowerCase()}::${advisoryUrl ?? ''}`;
					vulnerabilities.set(key, {
						id: pkg.id,
						version: pkg.resolvedVersion ?? pkg.requestedVersion,
						severity,
						advisoryUrl,
					});
				}
			}
		}
	}

	return [...vulnerabilities.values()];
}

function runDotnetPackageList(csprojFsPath: string, ...extraArgs: string[]): Promise<DotnetPackageListJson> {
	return new Promise((resolve, reject) => {
		execFile(
			'dotnet',
			['list', csprojFsPath, 'package', ...extraArgs, '--format', 'json'],
			{
				cwd: pathModule.dirname(csprojFsPath),
				encoding: 'utf8',
				maxBuffer: 1024 * 1024 * 10,
			},
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error((stderr || stdout || error.message || 'dotnet list package failed').trim()));
					return;
				}

				const jsonStart = stdout.indexOf('{');
				if (jsonStart < 0) {
					reject(new Error('dotnet list package did not return JSON output.'));
					return;
				}

				try {
					resolve(JSON.parse(stdout.slice(jsonStart)) as DotnetPackageListJson);
				} catch (parseError) {
					reject(parseError);
				}
			},
		);
	});
}

// ============================================================================
// Package dependency listing (read-only — used to show a package's own
// dependencies in the Solution Structure tree, not for dependency resolution)
// ============================================================================

export interface PackageDependencyInfo {
	id: string;
	/** Version or version-range string as declared in the .nuspec (informational only). */
	version?: string;
	dependencies?: PackageDependencyInfo[];
}

/**
 * Finds the dependencies declared by a specific installed package version, by reading
 * its `.nuspec` from the "package content" (flat container) resource. Tries each
 * configured source in turn and returns the first non-empty result. Returns an empty
 * array if the package/version can't be found anywhere, or on any failure — this is a
 * best-effort, purely informational lookup.
 */
export async function getPackageDependencies(
	csprojFsPath: string,
	packageId: string,
	version: string,
	resolvedPackages?: ReadonlyMap<string, PackageInfo>,
): Promise<PackageDependencyInfo[]> {
	const sources = await getNugetSources(csprojFsPath);
	const packageVersions = resolvedPackages ?? await getProjectPackages(csprojFsPath).catch(() => new Map<string, PackageInfo>());
	return getPackageDependenciesRecursive(sources, packageVersions, packageId, version, new Set([packageId.toLowerCase()]));
}

async function getPackageDependenciesRecursive(
	sources: readonly NugetSource[],
	resolvedPackages: ReadonlyMap<string, PackageInfo>,
	packageId: string,
	version: string,
	visited: ReadonlySet<string>,
): Promise<PackageDependencyInfo[]> {
	const dependencies = await getDirectPackageDependencies(sources, packageId, version);
	return Promise.all(dependencies.map(async dependency => {
		const key = dependency.id.toLowerCase();
		if (visited.has(key)) {
			return dependency;
		}

		const resolvedVersion = resolvedPackages.get(key)?.resolvedVersion;
		if (!resolvedVersion) {
			return dependency;
		}

		const childDependencies = await getPackageDependenciesRecursive(
			sources,
			resolvedPackages,
			dependency.id,
			resolvedVersion,
			new Set([...visited, key]),
		).catch(() => []);

		return childDependencies.length > 0
			? { ...dependency, dependencies: childDependencies }
			: dependency;
	}));
}

async function getDirectPackageDependencies(
	sources: readonly NugetSource[],
	packageId: string,
	version: string,
): Promise<PackageDependencyInfo[]> {
	for (const source of sources) {
		try {
			const dependencies = await fetchNuspecDependencies(source.url, packageId, version);
			if (dependencies.length > 0) {
				return dependencies;
			}
		} catch {
			// Try the next source.
		}
	}
	return [];
}

async function fetchNuspecDependencies(
	sourceUrl: string,
	packageId: string,
	version: string,
): Promise<PackageDependencyInfo[]> {
	const baseUrl = await getResourceUrl(sourceUrl, 'PackageBaseAddress/3.0.0', 'PackageBaseAddress');
	if (!baseUrl) {
		return [];
	}
	const lowerId = packageId.toLowerCase();
	const lowerVersion = version.toLowerCase();
	const url = `${baseUrl.replace(/\/$/, '')}/${lowerId}/${lowerVersion}/${lowerId}.nuspec`;

	const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
	if (!response.ok) {
		return []; // Missing nuspec / auth issues / etc. — best-effort, not fatal.
	}
	const xml = await response.text();
	return parseNuspecDependencies(xml);
}

/**
 * Extracts the flattened, deduplicated set of `<dependency>` entries from a .nuspec XML
 * document, across all target-framework `<group>` blocks. Intentionally simple
 * (regex-based, matching the rest of this file's XML handling) since the result is
 * purely informational (read-only display), not used for dependency resolution.
 */
function parseNuspecDependencies(xml: string): PackageDependencyInfo[] {
	const seen = new Map<string, PackageDependencyInfo>();
	const dependencyRegex = /<dependency\b([^>]*)\/?>/gi;
	let match: RegExpExecArray | null;
	while ((match = dependencyRegex.exec(xml)) !== null) {
		const attrs = match[1];
		const idMatch = attrs.match(/\bid="([^"]+)"/i);
		if (!idMatch) {
			continue;
		}
		const key = idMatch[1].toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		const versionMatch = attrs.match(/\bversion="([^"]+)"/i);
		seen.set(key, { id: idMatch[1], version: versionMatch?.[1] });
	}
	return [...seen.values()];
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
	initialPreRelease: boolean,
	latestVersion?: string,
): Promise<string | undefined> {
	return new Promise(resolve => {
		let preRelease = initialPreRelease;
		let accepted = false;
		const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
		qp.placeholder = 'Select a version';
		qp.title = `Select version for ${packageId}`;
		qp.buttons = [preRelease ? PRERELEASE_ON_BUTTON : PRERELEASE_OFF_BUTTON];
		qp.busy = true;

		if (latestVersion) {
			qp.items = [{ label: latestVersion, description: '(latest stable)' }];
		}

		const loadVersions = () => {
			qp.busy = true;
			getPackageVersions(source.url, packageId, preRelease)
				.then(versions => {
					if (versions.length > 0) {
						qp.items = versions.map((v, i) => ({
							label: v,
							description: i === 0 ? '(latest)' : undefined,
						}));
					} else if (!latestVersion) {
						// No versions found and no fallback — let user type manually
						qp.items = [];
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
					// Silently keep whatever is currently shown (e.g. fallback from search result)
				})
				.finally(() => {
					qp.busy = false;
				});
		};

		qp.onDidTriggerButton(() => {
			preRelease = !preRelease;
			qp.buttons = [preRelease ? PRERELEASE_ON_BUTTON : PRERELEASE_OFF_BUTTON];
			loadVersions();
		});

		qp.show();
		loadVersions();

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
