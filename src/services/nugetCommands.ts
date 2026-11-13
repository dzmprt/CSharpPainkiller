import * as vscode from 'vscode';
import * as pathModule from 'path';
import { AsyncCache, WorkQueue, waitWithCancellation, throwIfCancelled } from '../utils/asyncWork.js';
import { runDotnet } from '../utils/dotnetCli.js';
import { CsprojCache } from '../utils/csprojCache.js';
import { ErrorHandler } from '../utils/errorHandler.js';

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

const serviceIndexCache = new AsyncCache<string, ServiceResource[]>(100, 5 * 60_000);
const versionsCache = new AsyncCache<string, string[]>(1000, 5 * 60_000);
const nuspecCache = new AsyncCache<string, PackageDependencyInfo[] | undefined>(2000, 5 * 60_000);
const sourcesCache = new AsyncCache<string, NugetSource[]>(200, 30_000);
const packageListCache = new AsyncCache<string, DotnetPackageListJson>(200, 30_000);
const assetsCache = new AsyncCache<string, ProjectAssets | undefined>(200, 30_000);
const httpQueue = new WorkQueue(4);

export function clearNugetCaches(): void {
	serviceIndexCache.clear();
	versionsCache.clear();
	nuspecCache.clear();
	sourcesCache.clear();
	packageListCache.clear();
	assetsCache.clear();
}

export function registerNugetCache(context: Pick<vscode.ExtensionContext, 'subscriptions'>): void {
	const watcher = vscode.workspace.createFileSystemWatcher('**/{nuget.config,NuGet.Config,Nuget.Config,Directory.Packages.props,project.assets.json}');
	context.subscriptions.push(watcher,
		watcher.onDidCreate(clearNugetCaches), watcher.onDidChange(clearNugetCaches), watcher.onDidDelete(clearNugetCaches),
		CsprojCache.getInstance().onDidChange(clearNugetCaches), { dispose: clearNugetCaches });
}

// ============================================================================
// API helpers
// ============================================================================

async function fetchJson<T>(url: string): Promise<T> {
	return httpQueue.run(async () => {
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
	});
}

async function getServiceResources(sourceUrl: string): Promise<ServiceResource[]> {
	return serviceIndexCache.get(sourceUrl, async () => {
	const index = await fetchJson<{ resources: ServiceResource[] }>(sourceUrl);
	const resources = index.resources ?? [];
	return resources;
	});
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
	const versions = await versionsCache.get(url, async () =>
		(await fetchJson<{ versions: string[] }>(url)).versions ?? []
	);
	const all = [...versions].reverse();
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
	token?: vscode.CancellationToken,
	checkProject = true,
): Promise<string | undefined> {
	throwIfCancelled(token);
	if (!preRelease && checkProject) {
		try {
			const update = (await getProjectPackageUpdates(csprojFsPath, token)).get(packageId.toLowerCase());
			if (update?.latestVersion) {
				return update.latestVersion;
			}
		} catch (error) {
			throwIfCancelled(token);
			ErrorHandler.logWarn('NuGet updates', 'Project listing failed; trying configured sources', error);
			// Fall back to direct source probing below for older SDKs or unsupported output.
		}
	}

	const sources = await waitWithCancellation(getNugetSources(csprojFsPath), token);
	if (sources.length === 0) { throw new Error('No enabled NuGet sources are configured. Check nuget.config.'); }

	let anySourceReachable = false;
	const candidates = await waitWithCancellation(Promise.all(
		sources.map(async source => {
			try {
				const versions = await getPackageVersions(source.url, packageId, preRelease);
				anySourceReachable = true;
				return versions[0]; // getPackageVersions returns descending order.
			} catch {
				return undefined;
			}
		}),
	), token);

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
export async function getProjectPackageUpdates(csprojFsPath: string, token?: vscode.CancellationToken): Promise<Map<string, PackageUpdateInfo>> {
	throwIfCancelled(token);
	const parsed = await waitWithCancellation(runDotnetPackageList(csprojFsPath, '--outdated'), token);
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

export async function getProjectPackages(csprojFsPath: string, token?: vscode.CancellationToken): Promise<Map<string, PackageInfo>> {
	throwIfCancelled(token);
	const parsed = await waitWithCancellation(runDotnetPackageList(csprojFsPath, '--include-transitive'), token);
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

export async function getProjectPackageVulnerabilities(csprojFsPath: string, token?: vscode.CancellationToken): Promise<PackageVulnerabilityInfo[]> {
	throwIfCancelled(token);
	const parsed = await waitWithCancellation(runDotnetPackageList(csprojFsPath, '--vulnerable', '--include-transitive'), token);
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
	return packageListCache.get(JSON.stringify([csprojFsPath, ...extraArgs]), async () => {
		const { stdout } = await runDotnet(['list', csprojFsPath, 'package', ...extraArgs, '--format', 'json'],
			pathModule.dirname(csprojFsPath));
		const jsonStart = stdout.indexOf('{');
		if (jsonStart < 0) { throw new Error('dotnet list package did not return JSON output.'); }
		return JSON.parse(stdout.slice(jsonStart)) as DotnetPackageListJson;
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

export interface ProjectAssets {
	targets?: Record<string, Record<string, { type?: string; dependencies?: Record<string, string> }>>;
}

export function getDependenciesFromAssets(
	assets: ProjectAssets, packageId: string, version: string,
): PackageDependencyInfo[] | undefined {
	let found = false;
	const merged = new Map<string, PackageDependencyInfo>();
	const merge = (previous: PackageDependencyInfo[], current: PackageDependencyInfo[]): PackageDependencyInfo[] => {
		const entries = new Map(previous.map(dependency => [`${dependency.id.toLowerCase()}/${dependency.version}`, dependency]));
		for (const dependency of current) {
			const key = `${dependency.id.toLowerCase()}/${dependency.version}`;
			const old = entries.get(key);
			if (old?.dependencies && dependency.dependencies) {
				dependency.dependencies = merge(old.dependencies, dependency.dependencies);
			} else if (old?.dependencies) {
				dependency.dependencies = old.dependencies;
			}
			entries.set(key, dependency);
		}
		return [...entries.values()];
	};
	for (const target of Object.values(assets.targets ?? {})) {
		const root = Object.keys(target).find(key => key.toLowerCase() === `${packageId}/${version}`.toLowerCase());
		if (!root) { continue; }
		found = true;
		const entries = new Map(Object.entries(target).map(([key, value]) => {
			const separator = key.lastIndexOf('/');
			return [key.slice(0, separator).toLowerCase(), { id: key.slice(0, separator), version: key.slice(separator + 1), value }];
		}));
		const visit = (key: string, ancestors: ReadonlySet<string>): PackageDependencyInfo[] =>
			Object.entries(target[key].dependencies ?? {}).map(([id, requestedVersion]) => {
				const resolved = entries.get(id.toLowerCase());
				const dependency: PackageDependencyInfo = { id, version: resolved?.version ?? requestedVersion };
				if (resolved && !ancestors.has(id.toLowerCase())) {
					const children = visit(`${resolved.id}/${resolved.version}`, new Set([...ancestors, id.toLowerCase()]));
					if (children.length > 0) { dependency.dependencies = children; }
				}
				return dependency;
			});
		for (const dependency of visit(root, new Set([packageId.toLowerCase()]))) {
			// Keep distinct resolved versions when a multi-targeted project resolves differently.
			const key = `${dependency.id.toLowerCase()}/${dependency.version}`;
			const old = merged.get(key);
			merged.set(key, merge(old ? [old] : [], [dependency])[0]);
		}
	}
	return found ? [...merged.values()] : undefined;
}

async function readProjectAssets(csprojFsPath: string): Promise<ProjectAssets | undefined> {
	const uri = vscode.Uri.file(pathModule.join(pathModule.dirname(csprojFsPath), 'obj', 'project.assets.json'));
	return assetsCache.get(uri.toString(), async () => {
		try {
			return JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')) as ProjectAssets;
		} catch (error) {
			if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') { return undefined; }
			ErrorHandler.logWarn('NuGet dependencies', 'Could not read project.assets.json; trying package metadata', error);
			throw error;
		}
	});
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
	token?: vscode.CancellationToken,
): Promise<PackageDependencyInfo[]> {
	throwIfCancelled(token);
	const assets = await waitWithCancellation(readProjectAssets(csprojFsPath).catch(() => undefined), token);
	if (assets) {
		const local = getDependenciesFromAssets(assets, packageId, version);
		if (local !== undefined) { return local; }
	}
	const sources = await waitWithCancellation(getNugetSources(csprojFsPath), token);
	const packageVersions = resolvedPackages ?? await getProjectPackages(csprojFsPath, token).catch(error => {
		throwIfCancelled(token);
		ErrorHandler.logWarn('NuGet dependencies', 'Could not resolve installed package versions', error);
		return new Map<string, PackageInfo>();
	});
	return waitWithCancellation(getPackageDependenciesRecursive(sources, packageVersions, packageId, version,
		new Set([packageId.toLowerCase()]), token), token);
}

async function getPackageDependenciesRecursive(
	sources: readonly NugetSource[],
	resolvedPackages: ReadonlyMap<string, PackageInfo>,
	packageId: string,
	version: string,
	visited: ReadonlySet<string>,
	token?: vscode.CancellationToken,
): Promise<PackageDependencyInfo[]> {
	throwIfCancelled(token);
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
			token,
		);

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
	let failures = 0;
	for (const source of sources) {
		try {
			const dependencies = await fetchNuspecDependencies(source.url, packageId, version);
			if (dependencies !== undefined) {
				return dependencies;
			}
		} catch (error) {
			failures++;
			ErrorHandler.logWarn('NuGet dependencies', `Could not read ${packageId} metadata from ${source.name}`, error);
		}
	}
	if (sources.length > 0 && failures === sources.length) {
		throw new Error(`Could not reach any configured source to load dependencies for "${packageId}".`);
	}
	return [];
}

async function fetchNuspecDependencies(
	sourceUrl: string,
	packageId: string,
	version: string,
): Promise<PackageDependencyInfo[] | undefined> {
	const baseUrl = await getResourceUrl(sourceUrl, 'PackageBaseAddress/3.0.0', 'PackageBaseAddress');
	if (!baseUrl) {
		return undefined;
	}
	const lowerId = packageId.toLowerCase();
	const lowerVersion = version.toLowerCase();
	const url = `${baseUrl.replace(/\/$/, '')}/${lowerId}/${lowerVersion}/${lowerId}.nuspec`;

	const dependencies = await nuspecCache.get(url, () => httpQueue.run(async () => {
		const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
		if (response.status === 404) { return undefined; }
		if (!response.ok) { throw new Error(`HTTP ${response.status} fetching ${url}`); }
		return parseNuspecDependencies(await response.text());
	}));
	return dependencies;
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

type NugetConfigEntry = { action: 'clear' } | { action: 'remove'; key: string } | { action: 'add'; key: string; value: string };

function parseNugetConfigSection(content: string, section: string): NugetConfigEntry[] {
	const masked = content.replace(/<!--[\s\S]*?-->/g, '');
	const body = masked.match(new RegExp(`<${section}\\b[^>]*>([\\s\\S]*?)<\\/${section}>`, 'i'))?.[1] ?? '';
	const entries: NugetConfigEntry[] = [];
	for (const match of body.matchAll(/<(add|remove|clear)\b([^>]*?)\/?>/gi)) {
		const action = match[1].toLowerCase();
		if (action === 'clear') { entries.push({ action }); continue; }
		const attributes = new Map<string, string>();
		for (const attribute of match[2].matchAll(/(\w+)\s*=\s*(["'])(.*?)\2/g)) {
			attributes.set(attribute[1], attribute[3]
				.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
		}
		const key = attributes.get('key');
		if (!key) { throw new Error(`Invalid ${section} entry: key is required.`); }
		if (action === 'remove') { entries.push({ action, key }); continue; }
		const value = attributes.get('value');
		if (value === undefined) { throw new Error(`Invalid ${section} entry "${key}": value is required.`); }
		entries.push({ action: 'add', key, value });
	}
	return entries;
}

const NUGET_ORG_DEFAULT: NugetSource = { name: 'nuget.org', url: 'https://api.nuget.org/v3/index.json' };

export async function getNugetSources(csprojFsPath: string): Promise<NugetSource[]> {
	return sourcesCache.get(pathModule.dirname(csprojFsPath), () => discoverNugetSources(csprojFsPath));
}

async function discoverNugetSources(csprojFsPath: string): Promise<NugetSource[]> {
	const configs: string[] = [];

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
				configs.push(content);
				break;
			} catch (error) {
				if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') { throw error; }
			}
		}
		const parent = pathModule.dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}

	const sources = new Map<string, NugetSource>([[NUGET_ORG_DEFAULT.name, NUGET_ORG_DEFAULT]]);
	const disabled = new Map<string, boolean>();
	for (const config of configs.reverse()) {
		for (const entry of parseNugetConfigSection(config, 'packageSources')) {
			if (entry.action === 'clear') { sources.clear(); }
			else if (entry.action === 'remove') { sources.delete(entry.key.toLowerCase()); }
			else { sources.set(entry.key.toLowerCase(), { name: entry.key, url: entry.value }); }
		}
		for (const entry of parseNugetConfigSection(config, 'disabledPackageSources')) {
			if (entry.action === 'clear') { disabled.clear(); }
			else if (entry.action === 'remove') { disabled.delete(entry.key.toLowerCase()); }
			else {
				if (!/^(true|false)$/i.test(entry.value)) { throw new Error(`Invalid disabledPackageSources value for "${entry.key}".`); }
				disabled.set(entry.key.toLowerCase(), entry.value.toLowerCase() === 'true');
			}
		}
	}
	return [...sources].filter(([name]) => !disabled.get(name)).map(([, source]) => source);
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

async function getCentralPackageVersions(csprojFsPath: string): Promise<Map<string, string>> {
	const versions = new Map<string, string>();
	let directory = pathModule.dirname(csprojFsPath);
	const visited = new Set<string>();

	while (directory && !visited.has(directory)) {
		visited.add(directory);
		const propsUri = vscode.Uri.file(pathModule.join(directory, 'Directory.Packages.props'));
		try {
			const content = Buffer.from(await vscode.workspace.fs.readFile(propsUri)).toString('utf-8');
			const regex = /<PackageVersion\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageVersion>)/gi;
			let match: RegExpExecArray | null;
			while ((match = regex.exec(content)) !== null) {
				const include = match[1].match(/\b(?:Include|Update)\s*=\s*(['"])(.*?)\1/i)?.[2]?.trim();
				const version = match[1].match(/\bVersion\s*=\s*(['"])(.*?)\1/i)?.[2]?.trim()
					?? match[2]?.match(/<Version>\s*([^<]+?)\s*<\/Version>/i)?.[1]?.trim();
				if (include && version) {
					versions.set(include.toLowerCase(), version);
				}
			}
			return versions;
		} catch {
			// Walk up to the next parent project directory.
		}

		const parent = pathModule.dirname(directory);
		if (parent === directory) {
			break;
		}
		directory = parent;
	}

	return versions;
}

// ============================================================================
// Package search picker
// ============================================================================

export async function showAddPackagePicker(
	csprojFsPath: string,
): Promise<{ id: string; version: string } | undefined> {
	const sources = await getNugetSources(csprojFsPath);
	if (sources.length === 0) {
		vscode.window.showErrorMessage('CSharp Painkiller: No enabled NuGet sources are configured. Check nuget.config.');
		return undefined;
	}
	const centralPackageVersions = await getCentralPackageVersions(csprojFsPath);

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

	return showPackageSearchPicker(selectedSource, centralPackageVersions);
}

function showPackageSearchPicker(
	source: NugetSource,
	centralPackageVersions: ReadonlyMap<string, string>,
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
						description: centralPackageVersions.get(pkg.id.toLowerCase()) ?? pkg.version,
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
			const centralVersion = centralPackageVersions.get(packageId.toLowerCase());
			const latestVersion = centralVersion ?? selected.description;
			accepted = true;
			clearTimeout(debounceTimer);
			qp.dispose();

			void showVersionPicker(source, packageId, preRelease, latestVersion, centralVersion)
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
	centralVersion?: string,
): Promise<string | undefined> {
	return new Promise(resolve => {
		let preRelease = initialPreRelease;
		let accepted = false;
		const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
		qp.placeholder = 'Select a version';
		qp.title = `Select version for ${packageId}`;
		qp.buttons = centralVersion ? [] : [preRelease ? PRERELEASE_ON_BUTTON : PRERELEASE_OFF_BUTTON];
		qp.busy = true;

		if (centralVersion) {
			qp.items = [{ label: centralVersion, description: '(Directory.Packages.props)' }];
		} else if (latestVersion) {
			qp.items = [{ label: latestVersion, description: '(latest stable)' }];
		}

		const loadVersions = () => {
			if (centralVersion) {
				qp.busy = false;
				return;
			}
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
