import * as vscode from 'vscode';
import * as pathModule from 'path';

export interface PackageReferenceVersion {
	name: string;
	version: string;
}

export interface MigrationPlan {
	centralVersions: Map<string, string>;
	projectUpdates: Map<string, string>;
	conflicts: string[];
}

const DIRECTORY_PACKAGES_PROPS = 'Directory.Packages.props';

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/'/g, '&apos;');
}

function parseAttributes(attributes: string): Map<string, string> {
	const result = new Map<string, string>();
	const regex = /([A-Za-z_:][\w:.-]*)\s*=\s*(["'])(.*?)\2/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(attributes)) !== null) {
		result.set(match[1], match[3]);
	}
	return result;
}

export function parseVersionedPackageReferences(content: string): PackageReferenceVersion[] {
	const packages: PackageReferenceVersion[] = [];
	const regex = /<PackageReference\b([^>]*?)(?:\/\>|>([\s\S]*?)<\/PackageReference>)/gi;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(content)) !== null) {
		const attributes = parseAttributes(match[1]);
		const name = attributes.get('Include') ?? attributes.get('Update');
		if (!name) {
			continue;
		}
		const childVersion = match[2]?.match(/<Version>\s*([^<]+?)\s*<\/Version>/i)?.[1];
		const version = attributes.get('Version') ?? childVersion;
		if (version) {
			packages.push({ name, version });
		}
	}
	return packages;
}

export function removePackageVersions(content: string, packageNames: ReadonlySet<string>): string {
	return content.replace(
		/<PackageReference\b([^>]*?)(?:\/\>|>([\s\S]*?)<\/PackageReference>)/gi,
		(fullMatch, attributes: string, body: string | undefined) => {
			const parsed = parseAttributes(attributes);
			const name = parsed.get('Include') ?? parsed.get('Update');
			if (!name || !packageNames.has(name)) {
				return fullMatch;
			}
			const withoutVersionAttribute = attributes.replace(/\s+Version\s*=\s*(["']).*?\1/gi, '');
			if (body === undefined) {
				return `<PackageReference${withoutVersionAttribute}/>`;
			}
			const withoutVersionElement = body.replace(/\s*<Version>\s*[^<]*<\/Version>\s*/gi, '\n');
			return `<PackageReference${withoutVersionAttribute}>${withoutVersionElement}</PackageReference>`;
		},
	);
}

function parseCentralVersions(content: string): Map<string, string> {
	const versions = new Map<string, string>();
	const regex = /<PackageVersion\b([^>]*?)(?:\/\>|>([\s\S]*?)<\/PackageVersion>)/gi;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(content)) !== null) {
		const attributes = parseAttributes(match[1]);
		const name = attributes.get('Include') ?? attributes.get('Update');
		const version = attributes.get('Version') ?? match[2]?.match(/([^<]+)/)?.[1]?.trim();
		if (name && version) {
			versions.set(name.toLowerCase(), version);
		}
	}
	return versions;
}

export function buildDirectoryPackagesProps(
	existingContent: string | undefined,
	versions: ReadonlyMap<string, string>,
): { content?: string; conflicts: string[] } {
	const existing = existingContent?.trim();
	const current = existing ? parseCentralVersions(existing) : new Map<string, string>();
	const conflicts: string[] = [];
	for (const [name, version] of versions) {
		const currentVersion = current.get(name.toLowerCase());
		if (currentVersion && currentVersion !== version) {
			conflicts.push(`${name}: ${currentVersion} vs ${version}`);
		}
	}
	if (conflicts.length > 0) {
		return { conflicts };
	}

	if (existing) {
		let result = existingContent!;
		if (/<ManagePackageVersionsCentrally>\s*false\s*<\/ManagePackageVersionsCentrally>/i.test(result)) {
			result = result.replace(
				/<ManagePackageVersionsCentrally>\s*false\s*<\/ManagePackageVersionsCentrally>/i,
				'<ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>',
			);
		} else if (!/<ManagePackageVersionsCentrally>\s*true\s*<\/ManagePackageVersionsCentrally>/i.test(result)) {
			const closeIndex = result.lastIndexOf('</Project>');
			const propertyGroup = '  <PropertyGroup>\n    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>\n  </PropertyGroup>\n';
			result = closeIndex >= 0
				? `${result.slice(0, closeIndex)}${propertyGroup}${result.slice(closeIndex)}`
				: `${result}\n${propertyGroup}`;
		}
		const missing = [...versions].filter(([name]) => !current.has(name.toLowerCase()));
		if (missing.length === 0) {
			return { content: result.endsWith('\n') ? result : `${result}\n`, conflicts };
		}
		const itemGroup = missing
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, version]) => `    <PackageVersion Include="${escapeXml(name)}" Version="${escapeXml(version)}" />`)
			.join('\n');
		const closeIndex = result.lastIndexOf('</Project>');
		result = closeIndex >= 0
			? `${result.slice(0, closeIndex)}  <ItemGroup>\n${itemGroup}\n  </ItemGroup>\n${result.slice(closeIndex)}`
			: `${result}\n  <ItemGroup>\n${itemGroup}\n  </ItemGroup>\n`;
		return { content: result.endsWith('\n') ? result : `${result}\n`, conflicts };
	}

	const entries = [...versions]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, version]) => `    <PackageVersion Include="${escapeXml(name)}" Version="${escapeXml(version)}" />`)
		.join('\n');
	return {
		content: `<Project>\n  <PropertyGroup>\n    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>\n  </PropertyGroup>\n  <ItemGroup>\n${entries}\n  </ItemGroup>\n</Project>\n`,
		conflicts,
	};
}

export function createMigrationPlan(
	projects: ReadonlyMap<string, string>,
	existingPropsContent?: string,
): MigrationPlan {
	const centralVersions = new Map<string, string>();
	const projectUpdates = new Map<string, string>();
	const conflicts: string[] = [];
	for (const [, content] of projects) {
		for (const reference of parseVersionedPackageReferences(content)) {
			const existingName = [...centralVersions.keys()].find(name => name.toLowerCase() === reference.name.toLowerCase());
			const previous = existingName ? centralVersions.get(existingName) : undefined;
			if (previous && previous !== reference.version) {
				conflicts.push(`${reference.name}: ${previous} vs ${reference.version}`);
			} else {
				centralVersions.set(existingName ?? reference.name, reference.version);
			}
		}
	}
	const props = buildDirectoryPackagesProps(existingPropsContent, centralVersions);
	conflicts.push(...props.conflicts);
	if (conflicts.length > 0) {
		return { centralVersions, projectUpdates, conflicts: [...new Set(conflicts)] };
	}
	for (const [projectPath, content] of projects) {
		const packageNames = new Set(parseVersionedPackageReferences(content).map(reference => reference.name));
		if (packageNames.size > 0) {
			projectUpdates.set(projectPath, removePackageVersions(content, packageNames));
		}
	}
	return { centralVersions, projectUpdates, conflicts: [] };
}

async function findSolutionRoot(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
	if (uri.fsPath.toLowerCase().endsWith('.sln') || uri.fsPath.toLowerCase().endsWith('.slnx')) {
		return vscode.Uri.file(pathModule.dirname(uri.fsPath));
	}
	const solutionFiles = [
		...(await vscode.workspace.findFiles(new vscode.RelativePattern(uri, '*.sln'))),
		...(await vscode.workspace.findFiles(new vscode.RelativePattern(uri, '*.slnx'))),
	];
	return solutionFiles.length > 0 ? uri : undefined;
}

export async function migrateSolutionToCentralPackageManagement(uri?: vscode.Uri): Promise<void> {
	if (!uri) {
		vscode.window.showErrorMessage('CSharp Painkiller: Select a solution root folder or a .sln/.slnx file.');
		return;
	}
	const root = await findSolutionRoot(uri);
	if (!root) {
		vscode.window.showErrorMessage('CSharp Painkiller: The selected folder does not contain a .sln or .slnx file.');
		return;
	}
	const projectUris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*.csproj'));
	if (projectUris.length === 0) {
		vscode.window.showInformationMessage('CSharp Painkiller: No projects found under the solution root.');
		return;
	}
	const projectContents = new Map<string, string>();
	for (const projectUri of projectUris) {
		projectContents.set(projectUri.fsPath, Buffer.from(await vscode.workspace.fs.readFile(projectUri)).toString('utf8'));
	}
	const propsUri = vscode.Uri.file(pathModule.join(root.fsPath, DIRECTORY_PACKAGES_PROPS));
	let existingProps: string | undefined;
	try {
		existingProps = Buffer.from(await vscode.workspace.fs.readFile(propsUri)).toString('utf8');
	} catch {
		// The file is created when central package management is first enabled.
	}
	const plan = createMigrationPlan(projectContents, existingProps);
	if (plan.conflicts.length > 0) {
		vscode.window.showErrorMessage(`CSharp Painkiller: Package version conflicts prevent migration: ${plan.conflicts.join('; ')}`);
		return;
	}
	if (plan.centralVersions.size === 0) {
		vscode.window.showInformationMessage('CSharp Painkiller: No versioned PackageReference entries found to migrate.');
		return;
	}
	const confirmation = await vscode.window.showInformationMessage(
		`Migrate ${plan.centralVersions.size} package version(s) from ${plan.projectUpdates.size} project(s) to ${DIRECTORY_PACKAGES_PROPS}?`,
		{ modal: true },
		'Migrate',
	);
	if (confirmation !== 'Migrate') {
		return;
	}
	const props = buildDirectoryPackagesProps(existingProps, plan.centralVersions).content!;
	await vscode.workspace.fs.writeFile(propsUri, Buffer.from(props, 'utf8'));
	for (const [projectPath, content] of plan.projectUpdates) {
		await vscode.workspace.fs.writeFile(vscode.Uri.file(projectPath), Buffer.from(content, 'utf8'));
	}
	vscode.window.showInformationMessage(`CSharp Painkiller: Migrated ${plan.centralVersions.size} package version(s) to ${DIRECTORY_PACKAGES_PROPS}.`);
}
