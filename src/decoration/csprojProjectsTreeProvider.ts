import * as vscode from 'vscode';
import * as pathModule from 'path';
import { spawnSync } from 'child_process';
import { showAddPackagePicker, getLatestPackageVersion, getPackageDependencies, compareVersions, getProjectPackageUpdates, getProjectPackages, getProjectPackageVulnerabilities, type PackageDependencyInfo, type PackageInfo } from '../services/nugetCommands.js';

type CsprojTreeNode =
	| SolutionNode
	| FolderNode
	| ProjectNode
	| ReferenceGroupNode
	| PackageGroupNode
	| CentralPackageGroupNode
	| ProjectReferenceNode
	| PackageReferenceNode
	| CentralPackageReferenceNode
	| PackageDependencyNode
	| ExcludedProjectsNode
	| ExcludedProjectNode
	| VulnerablePackagesNode
	| VulnerablePackageNode;

interface CreateFolderTarget {
	solutionUri: vscode.Uri;
	parentGuid?: string;
	physicalBaseUri: vscode.Uri;
	solutionFolderPath?: string;
}

interface SolutionNode {
	kind: 'solution';
	label: string;
	solutionUri: vscode.Uri;
	createFolderTarget: CreateFolderTarget;
	children: CsprojTreeNode[];
}

interface FolderNode {
	kind: 'folder';
	label: string;
	createProjectUri: vscode.Uri;
	createFolderTarget?: CreateFolderTarget;
	deleteFolderTarget?: CreateFolderTarget;
	children: CsprojTreeNode[];
}

interface ProjectNode {
	kind: 'project';
	label: string;
	folderUri: vscode.Uri;
	csprojUri: vscode.Uri;
	solutionUri: vscode.Uri;
	projectPath: string;
	existsOnDisk: boolean;
	solutionProjectPaths: ReadonlySet<string>;
	isAspNet: boolean;
	isTest: boolean;
	virtualPath?: string;
	targetFramework?: string;
	languageVersion?: string;
}

interface ReferenceGroupNode {
	kind: 'referenceGroup';
	label: string;
	project: ProjectNode;
	children: ProjectReferenceNode[];
}

interface PackageGroupNode {
	kind: 'packageGroup';
	label: string;
	project: ProjectNode;
	children: PackageReferenceNode[];
}

interface CentralPackageGroupNode {
	kind: 'centralPackageGroup';
	label: string;
	solutionUri: vscode.Uri;
	centralPropsUri: vscode.Uri;
	representativeCsprojUri?: vscode.Uri;
	children: CentralPackageReferenceNode[];
}

interface ProjectReferenceNode {
	kind: 'projectReference';
	label: string;
	project: ProjectNode;
	referencePath: string;
	resolvedUri: vscode.Uri;
	existsOnDisk: boolean;
	includedInSolution: boolean;
}

interface PackageReferenceNode {
	kind: 'packageReference';
	label: string;
	version?: string;
	/** Latest available version found by "Check for Package Updates", if newer than `version`. */
	latestVersion?: string;
	/** Transitive dependencies declared by the installed version, if any (read-only display). */
	dependencies?: PackageDependencyNode[];
	project: ProjectNode;
}

interface CentralPackageReferenceNode {
	kind: 'centralPackageReference';
	label: string;
	version: string;
	latestVersion?: string;
	centralPropsUri: vscode.Uri;
	solutionUri: vscode.Uri;
	representativeCsprojUri?: vscode.Uri;
}

interface PackageDependencyNode {
	kind: 'packageDependency';
	label: string;
	version?: string;
	dependencies?: PackageDependencyNode[];
	project: ProjectNode;
	parentPackageId: string;
}

interface ExcludedProjectsNode {
	kind: 'excludedProjects';
	label: string;
	solutionUri: vscode.Uri;
	children: ExcludedProjectNode[];
}

interface ExcludedProjectNode {
	kind: 'excludedProject';
	label: string;
	solutionUri: vscode.Uri;
	csprojUri: vscode.Uri;
}

interface VulnerablePackagesNode {
	kind: 'vulnerablePackages';
	label: string;
	solutionUri: vscode.Uri;
	children: VulnerablePackageNode[];
}

interface VulnerablePackageNode {
	kind: 'vulnerablePackage';
	label: string;
	version?: string;
	severity: string;
	advisoryUrl?: string;
	projectLabels: string[];
}

interface SlnProjectEntry {
	guid: string;
	name: string;
	projectPath: string;
	isSolutionFolder: boolean;
	parentGuid?: string;
}

interface DraggedProjectPayload {
	label: string;
	folderFsPath: string;
	csprojFsPath: string;
	solutionFsPath: string;
	projectPath: string;
	isAspNet: boolean;
	isTest: boolean;
	virtualPath?: string;
}

const SOLUTION_FOLDER_TYPE_GUID = '2150e333-8fdc-42a3-9474-1a3956d46de8';
const PROJECT_TREE_DRAG_MIME = 'application/vnd.csharppainkiller.project';

/** Max concurrent NuGet lookups when checking many packages for updates at once. */
const PACKAGE_CHECK_CONCURRENCY = 4;
const WATCHER_REFRESH_DEBOUNCE_MS = 150;
const AUTO_CHECK_PACKAGES_SETTING = 'solutionStructure.autoCheckPackages';

/**
 * Runs `worker` over `items` with at most `limit` concurrent invocations in flight —
 * keeps a bulk "check all packages" scan from firing dozens/hundreds of simultaneous
 * HTTP requests against NuGet sources.
 */
async function runWithConcurrencyLimit<T>(
	items: readonly T[],
	limit: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	let cursor = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length) {
			const item = items[cursor++];
			await worker(item);
		}
	});
	await Promise.all(runners);
}

function createPackageDependencyNode(
	dependency: PackageDependencyInfo,
	project: ProjectNode,
	parentPackageId: string,
): PackageDependencyNode {
	return {
		kind: 'packageDependency',
		label: dependency.id,
		version: dependency.version,
		dependencies: dependency.dependencies?.map(child => createPackageDependencyNode(child, project, dependency.id)),
		project,
		parentPackageId,
	};
}

export function isAutomaticPackageCheckEnabled(
	config: Pick<vscode.WorkspaceConfiguration, 'get'> = vscode.workspace.getConfiguration('csharppainkiller'),
): boolean {
	return config.get<boolean>(AUTO_CHECK_PACKAGES_SETTING, true) ?? true;
}

export class CsprojProjectsTreeProvider implements vscode.TreeDataProvider<CsprojProjectTreeItem>, vscode.TreeDragAndDropController<CsprojProjectTreeItem>, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<CsprojProjectTreeItem | undefined>();
	private readonly watcher: vscode.FileSystemWatcher;
	private readonly solutionWatcher: vscode.FileSystemWatcher;
	private readonly workspaceDeleteWatcher: vscode.FileSystemWatcher;
	private treeView: vscode.TreeView<CsprojProjectTreeItem> | undefined;
	private initialPackageUpdateCheckScheduled = false;
	private initialPackageUpdateCheckTimer: ReturnType<typeof setTimeout> | undefined;
	private watcherRefreshTimer: ReturnType<typeof setTimeout> | undefined;

	/** Latest known available version per package, keyed by `csprojUri::packageId (lowercase)`. */
	private readonly packageUpdateCache = new Map<string, string>();

	/** Latest available version per central package, keyed by props file and package id. */
	private readonly centralPackageUpdateCache = new Map<string, string>();

	/** Installed/resolved package version per package, including central package management projects. */
	private readonly packageVersionCache = new Map<string, string>();

	/** Declared dependencies of the installed package version, keyed the same way as `packageUpdateCache`. */
	private readonly packageDependencyCache = new Map<string, PackageDependencyInfo[]>();

	/** Known vulnerable top-level packages per project, filled during NuGet package checks. */
	private readonly packageVulnerabilityCache = new Map<string, VulnerablePackageNode[]>();

	readonly onDidChangeTreeData = this.changeEmitter.event;
	readonly dragMimeTypes = [PROJECT_TREE_DRAG_MIME];
	readonly dropMimeTypes = [PROJECT_TREE_DRAG_MIME];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly onProjectFoldersChanged?: () => Promise<void> | void
	) {
		this.watcher = vscode.workspace.createFileSystemWatcher('**/*.csproj');
		this.watcher.onDidCreate(() => this.scheduleRefresh());
		this.watcher.onDidDelete(() => this.scheduleRefresh());
		this.watcher.onDidChange(() => this.scheduleRefresh());

		this.solutionWatcher = vscode.workspace.createFileSystemWatcher('**/*.{sln,slnx}');
		this.solutionWatcher.onDidCreate(() => this.scheduleRefresh());
		this.solutionWatcher.onDidDelete(() => this.scheduleRefresh());
		this.solutionWatcher.onDidChange(() => this.scheduleRefresh());

		this.workspaceDeleteWatcher = vscode.workspace.createFileSystemWatcher('**/*');
		this.workspaceDeleteWatcher.onDidDelete(() => this.scheduleRefresh());
	}

	refresh(): void {
		this.changeEmitter.fire(undefined);
	}

	private scheduleRefresh(): void {
		if (this.watcherRefreshTimer) {
			clearTimeout(this.watcherRefreshTimer);
		}

		this.watcherRefreshTimer = setTimeout(() => {
			this.watcherRefreshTimer = undefined;
			this.refresh();
		}, WATCHER_REFRESH_DEBOUNCE_MS);
	}

	bindTreeView(treeView: vscode.TreeView<CsprojProjectTreeItem>): void {
		this.treeView = treeView;
	}

	private packageCacheKey(csprojUri: vscode.Uri, packageId: string): string {
		return `${csprojUri.toString()}::${packageId.toLowerCase()}`;
	}

	private centralPackageCacheKey(centralPropsUri: vscode.Uri, packageId: string): string {
		return `${centralPropsUri.toString()}::${packageId.toLowerCase()}`;
	}

	getTreeItem(element: CsprojProjectTreeItem): vscode.TreeItem {
		return element;
	}

	async getParent(element: CsprojProjectTreeItem): Promise<CsprojProjectTreeItem | undefined> {
		const node = element.node;
		if (node.kind === 'referenceGroup' || node.kind === 'packageGroup') {
			return this.createTreeItem(node.project);
		}
		if (node.kind === 'centralPackageReference') {
			return this.createTreeItem({
				kind: 'centralPackageGroup',
				label: 'Central Packages',
				solutionUri: node.solutionUri,
				centralPropsUri: node.centralPropsUri,
				children: [],
			});
		}
		if (node.kind === 'packageReference') {
			return this.createTreeItem({ kind: 'packageGroup', label: 'Packages', project: node.project, children: [] });
		}
		if (node.kind === 'projectReference') {
			return this.createTreeItem({ kind: 'referenceGroup', label: 'Project References', project: node.project, children: [] });
		}

		const roots = await this.buildTree();
		const parent = findParentNode(roots, node);
		return parent ? this.createTreeItem(parent) : undefined;
	}

	handleDrag(source: readonly CsprojProjectTreeItem[], dataTransfer: vscode.DataTransfer): void {
		const projects = source
			.map(item => item.node)
			.filter((node): node is ProjectNode => node.kind === 'project');
		if (projects.length === 0) {
			return;
		}

		dataTransfer.set(PROJECT_TREE_DRAG_MIME, new vscode.DataTransferItem(JSON.stringify(projects.map(project => ({
			label: project.label,
			folderFsPath: project.folderUri.fsPath,
			csprojFsPath: project.csprojUri.fsPath,
			solutionFsPath: project.solutionUri.fsPath,
			projectPath: project.projectPath,
			isAspNet: project.isAspNet,
			isTest: project.isTest,
			virtualPath: project.virtualPath,
		} satisfies DraggedProjectPayload)))));
	}

	async handleDrop(target: CsprojProjectTreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
		if (!target) {
			return;
		}

		const transferItem = dataTransfer.get(PROJECT_TREE_DRAG_MIME);
		if (!transferItem) {
			return;
		}

		const raw = await transferItem.asString();
		const projects = parseDraggedProjects(raw);
		if (projects.length === 0) {
			return;
		}

		const sourceProject = projects[0];
		if (target.node.kind === 'project') {
			await this.addDraggedProjectReference(target.node, sourceProject);
			return;
		}

		if (target.node.kind === 'solution' || target.node.kind === 'folder') {
			await this.moveProjectToSolutionTarget(sourceProject, target);
		}
	}

	async getChildren(element?: CsprojProjectTreeItem): Promise<CsprojProjectTreeItem[]> {
		if (element) {
			if (element.node.kind === 'project') {
				const projectChildren = await this.getProjectChildren(element.node);
				return projectChildren.map(node => this.createTreeItem(node));
			}

			if (element.node.kind === 'packageReference') {
				return (element.node.dependencies ?? []).map(node => this.createTreeItem(node));
			}

			if (element.node.kind === 'packageDependency') {
				return (element.node.dependencies ?? []).map(node => this.createTreeItem(node));
			}

			return 'children' in element.node
				? element.node.children.map(node => this.createTreeItem(node))
				: [];
		}

		const nodes = await this.buildTree();
		this.scheduleInitialPackageUpdateCheck();
		return nodes.map(node => this.createTreeItem(node));
	}

	private scheduleInitialPackageUpdateCheck(): void {
		if (!isAutomaticPackageCheckEnabled()) {
			return;
		}
		if (this.initialPackageUpdateCheckScheduled) {
			return;
		}
		this.initialPackageUpdateCheckScheduled = true;

		this.initialPackageUpdateCheckTimer = setTimeout(() => {
			this.initialPackageUpdateCheckTimer = undefined;
			if (!isAutomaticPackageCheckEnabled()) {
				this.initialPackageUpdateCheckScheduled = false;
				return;
			}
			void this.checkAllProjectsForUpdates().catch(err => {
				console.warn('CSharp Painkiller: background NuGet update check failed', err);
			});
		}, 1500);
	}

	private createTreeItem(node: CsprojTreeNode): CsprojProjectTreeItem {
		return new CsprojProjectTreeItem(node, this.extensionUri);
	}

	private async getProjectChildren(project: ProjectNode): Promise<CsprojTreeNode[]> {
		if (!project.existsOnDisk) {
			return [];
		}

		const content = await readUtf8(project.csprojUri);
		const sourceProjectDir = pathModule.dirname(project.csprojUri.fsPath);
		const references = await Promise.all(parseProjectReferences(content)
			.map(async referencePath => {
				const resolvedPath = resolveProjectReferencePath(sourceProjectDir, referencePath);
				const resolvedUri = vscode.Uri.file(resolvedPath);
				const normalizedResolvedPath = normalizePath(resolvedPath);
				return {
				kind: 'projectReference' as const,
				label: getProjectReferenceDisplayName(referencePath),
				project,
				referencePath,
				resolvedUri,
				existsOnDisk: await pathExists(resolvedUri),
				includedInSolution: project.solutionProjectPaths.has(normalizedResolvedPath),
			};
			}));
		const packages = parsePackageReferences(content)
			.map(pkg => {
				const cacheKey = this.packageCacheKey(project.csprojUri, pkg.name);
				const dependencies = this.packageDependencyCache.get(cacheKey);
				return {
					kind: 'packageReference' as const,
					label: pkg.name,
					version: pkg.version ?? this.packageVersionCache.get(cacheKey),
					latestVersion: this.packageUpdateCache.get(cacheKey),
					dependencies: dependencies?.map(dep => createPackageDependencyNode(dep, project, pkg.name)),
					project,
				};
			});

		const children: CsprojTreeNode[] = [];
		children.push({ kind: 'referenceGroup', label: 'Project References', project, children: references });
		children.push({ kind: 'packageGroup', label: 'Packages', project, children: packages });
		return children;
	}

	async createSolutionFolder(item?: CsprojProjectTreeItem): Promise<void> {
		const target = await this.resolveCreateFolderTarget(item);
		if (!target) {
			vscode.window.showErrorMessage('CSharp Painkiller: Create solution folders from a .sln or .slnx node.');
			return;
		}
		if (!target.solutionUri.path.endsWith('.sln') && !target.solutionUri.path.endsWith('.slnx')) {
			vscode.window.showErrorMessage('CSharp Painkiller: Create solution folders from a .sln or .slnx node.');
			return;
		}

		const folderName = await vscode.window.showInputBox({
			prompt: 'Enter solution folder name',
			validateInput: value => {
				const trimmed = value.trim();
				if (!trimmed) {
					return 'Folder name is required';
				}
				if (/[\\/]/.test(trimmed)) {
					return 'Enter a single folder name without path separators';
				}
				if (/[{}"]/.test(trimmed)) {
					return 'Folder name cannot contain braces or quotes';
				}
				return null;
			},
		});
		if (!folderName) {
			return;
		}

		const trimmedName = folderName.trim();
		const content = await readUtf8(target.solutionUri);
		const updated = target.solutionUri.path.endsWith('.slnx')
			? addSlnxFolder(content, trimmedName, target.parentGuid)
			: addSlnFolder(content, trimmedName, target.parentGuid);
		await vscode.workspace.fs.writeFile(target.solutionUri, Buffer.from(updated, 'utf-8'));
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target.physicalBaseUri, trimmedName));
		await this.onProjectFoldersChanged?.();
		this.refresh();
	}

	async deleteSolutionFolder(item?: CsprojProjectTreeItem): Promise<void> {
		if (!item || item.node.kind !== 'folder' || !item.deleteFolderTarget?.parentGuid) {
			vscode.window.showErrorMessage('CSharp Painkiller: Select a solution folder to delete.');
			return;
		}

		const confirmation = await vscode.window.showWarningMessage(
			`Delete solution folder "${item.node.label}" from the solution?`,
			{ modal: true },
			'Delete'
		);
		if (confirmation !== 'Delete') {
			return;
		}

		const target = item.deleteFolderTarget;
		const folderGuid = target.parentGuid;
		if (!folderGuid) {
			return;
		}
		const deletePhysicalFolder = await this.shouldDeletePhysicalFolder(target.physicalBaseUri, item.node.label);
		if (deletePhysicalFolder === undefined) {
			return;
		}
		const content = await readUtf8(target.solutionUri);
		const updated = target.solutionUri.path.endsWith('.slnx')
			? removeSlnxFolder(content, folderGuid)
			: removeSlnFolder(content, folderGuid);
		await vscode.workspace.fs.writeFile(target.solutionUri, Buffer.from(updated, 'utf-8'));

		if (deletePhysicalFolder) {
			await vscode.workspace.fs.delete(target.physicalBaseUri, { recursive: true, useTrash: true });
		}
		this.refresh();
	}

	async excludeProject(item?: CsprojProjectTreeItem): Promise<void> {
		if (!item || item.node.kind !== 'project') {
			vscode.window.showErrorMessage('CSharp Painkiller: Select a project to exclude.');
			return;
		}

		const answer = await vscode.window.showWarningMessage(
			`Exclude project "${item.node.label}" from the solution?`,
			{ modal: true },
			'Exclude'
		);
		if (answer !== 'Exclude') {
			return;
		}

		await this.removeProjectFromSolution(item.node.solutionUri, item.node.projectPath);
		this.refresh();
	}

	async includeProject(item?: CsprojProjectTreeItem): Promise<void> {
		if (item?.node.kind === 'excludedProject') {
			await this.addProjectToSolution(item.node.solutionUri, item.node.csprojUri);
			this.refresh();
			return;
		}

		const solutionUri = this.resolveSolutionUriFromItem(item);
		if (!solutionUri) {
			vscode.window.showErrorMessage('CSharp Painkiller: Select a solution or solution folder.');
			return;
		}

		if (item?.node.kind === 'excludedProjects') {
			const pick = await vscode.window.showQuickPick(
				item.node.children.map(project => ({
					label: project.label,
					description: project.csprojUri.fsPath,
					project,
				})),
				{ placeHolder: 'Select project to include' }
			);
			if (!pick) {
				return;
			}
			await this.addProjectToSolution(solutionUri, pick.project.csprojUri);
			this.refresh();
			return;
		}

		const solutionDir = pathModule.dirname(solutionUri.fsPath);
		const content = await readUtf8(solutionUri);
		const includedPaths = new Set((solutionUri.path.endsWith('.slnx') ? parseSlnxProjects(content) : parseSlnProjects(content))
			.filter(entry => !entry.isSolutionFolder)
			.map(entry => normalizePath(pathModule.resolve(solutionDir, entry.projectPath))));
		const candidates = (await vscode.workspace.findFiles('**/*.csproj', '{**/bin/**,**/obj/**}'))
			.filter(uri => !includedPaths.has(normalizePath(uri.fsPath)));

		if (candidates.length === 0) {
			vscode.window.showInformationMessage('CSharp Painkiller: No excluded projects found.');
			return;
		}

		const pick = await vscode.window.showQuickPick(
			candidates.map(uri => ({
				label: pathModule.basename(uri.fsPath, pathModule.extname(uri.fsPath)),
				description: pathModule.relative(solutionDir, uri.fsPath).replace(/\\/g, '/'),
				uri,
			})),
			{ placeHolder: 'Select project to include' }
		);
		if (!pick) {
			return;
		}

		await this.addProjectToSolution(solutionUri, pick.uri);
		this.refresh();
	}

	async deleteProject(item?: CsprojProjectTreeItem): Promise<void> {
		if (!item || item.node.kind !== 'project') {
			vscode.window.showErrorMessage('CSharp Painkiller: Select a project to delete.');
			return;
		}

		const answer = await vscode.window.showWarningMessage(
			`Delete project "${item.node.label}" from the solution and delete all files in its folder?`,
			{ modal: true },
			'Delete Project'
		);
		if (answer !== 'Delete Project') {
			return;
		}

		await this.removeProjectFromSolution(item.node.solutionUri, item.node.projectPath);
		await vscode.workspace.fs.delete(item.node.folderUri, { recursive: true, useTrash: true });
		this.refresh();
	}

	async addProjectReference(item?: CsprojProjectTreeItem): Promise<void> {
		if (!item || item.node.kind !== 'referenceGroup') {
			vscode.window.showErrorMessage('CSharp Painkiller: Select Project References.');
			return;
		}
		const sourceProject = item.node.project;
		const sourceDir = pathModule.dirname(sourceProject.csprojUri.fsPath);

		// Read source .csproj upfront to filter out already-referenced projects
		const content = await readUtf8(sourceProject.csprojUri);
		const existingRefs = new Set(
			parseProjectReferences(content).map(ref =>
				normalizePath(
					pathModule.isAbsolute(ref)
						? ref
						: pathModule.resolve(sourceDir, ref.replace(/\\/g, '/'))
				)
			)
		);

		const allProjects = await vscode.workspace.findFiles('**/*.csproj', '{**/bin/**,**/obj/**}');

		// Step 1: exclude self and already-referenced projects
		const candidates = allProjects.filter(uri =>
			uri.toString() !== sourceProject.csprojUri.toString() &&
			!existingRefs.has(normalizePath(uri.fsPath))
		);

		// Step 2: exclude projects that already reference sourceProject (directly or transitively)
		// — adding source → candidate in that case would create a cycle
		const cycleChecks = await Promise.all(
			candidates.map(uri => wouldCreateCyclicReference(sourceProject.csprojUri.fsPath, uri.fsPath))
		);
		const projects = candidates.filter((_, i) => !cycleChecks[i]);

		if (projects.length === 0) {
			vscode.window.showInformationMessage('CSharp Painkiller: No projects available to reference.');
			return;
		}

		const pick = await vscode.window.showQuickPick(
			projects.map(uri => ({
				label: pathModule.basename(uri.fsPath, pathModule.extname(uri.fsPath)),
				description: pathModule.relative(sourceDir, uri.fsPath).replace(/\\/g, '/'),
				uri,
			})),
			{ placeHolder: `Add project reference to ${sourceProject.label}` }
		);
		if (!pick) {
			return;
		}

		const relativePath = pathModule.relative(sourceDir, pick.uri.fsPath).replace(/\\/g, '/');
		const updated = addProjectReferenceToCsproj(content, relativePath);
		await vscode.workspace.fs.writeFile(sourceProject.csprojUri, Buffer.from(updated, 'utf-8'));
		this.refresh();
	}

	private async addDraggedProjectReference(targetProject: ProjectNode, draggedProject: ProjectNode): Promise<void> {
		if (targetProject.csprojUri.toString() === draggedProject.csprojUri.toString()) {
			vscode.window.showInformationMessage('CSharp Painkiller: Cannot add a project reference to itself.');
			return;
		}

		const relativePath = pathModule.relative(pathModule.dirname(targetProject.csprojUri.fsPath), draggedProject.csprojUri.fsPath).replace(/\\/g, '/');
		const content = await readUtf8(targetProject.csprojUri);
		if (projectReferenceExists(content, pathModule.dirname(targetProject.csprojUri.fsPath), draggedProject.csprojUri.fsPath)) {
			vscode.window.showInformationMessage('CSharp Painkiller: Project reference already exists.');
			return;
		}

		if (await wouldCreateCyclicReference(targetProject.csprojUri.fsPath, draggedProject.csprojUri.fsPath)) {
			vscode.window.showErrorMessage(
				`CSharp Painkiller: Cannot add reference to "${draggedProject.label}" — it would create a circular project reference.`
			);
			return;
		}

		const answer = await vscode.window.showWarningMessage(
			`Add reference to "${draggedProject.label}" in "${targetProject.label}"?`,
			{ modal: true },
			'Confirm'
		);
		if (answer !== 'Confirm') {
			return;
		}

		const updated = addProjectReferenceToCsproj(content, relativePath);
		await vscode.workspace.fs.writeFile(targetProject.csprojUri, Buffer.from(updated, 'utf-8'));
		this.refresh();
	}

	private async moveProjectToSolutionTarget(sourceProject: ProjectNode, target: CsprojProjectTreeItem): Promise<void> {
		const targetSolutionUri = target.node.kind === 'solution'
			? target.node.solutionUri
			: target.createFolderTarget?.solutionUri;
		if (!targetSolutionUri || targetSolutionUri.toString() !== sourceProject.solutionUri.toString()) {
			vscode.window.showInformationMessage('CSharp Painkiller: Move projects only within the same solution.');
			return;
		}

		const targetFolderGuid = target.node.kind === 'folder' ? target.createFolderTarget?.parentGuid : undefined;
		const targetPhysicalBaseUri = target.node.kind === 'solution'
			? vscode.Uri.file(pathModule.dirname(target.node.solutionUri.fsPath))
			: target.createFolderTarget?.physicalBaseUri;
		if (!targetPhysicalBaseUri) {
			vscode.window.showInformationMessage('CSharp Painkiller: Could not resolve target folder path.');
			return;
		}

		const projectFolderName = pathModule.basename(sourceProject.folderUri.fsPath);
		const targetProjectFolderUri = vscode.Uri.file(pathModule.join(targetPhysicalBaseUri.fsPath, projectFolderName));
		const targetProjectUri = vscode.Uri.file(pathModule.join(targetProjectFolderUri.fsPath, pathModule.basename(sourceProject.csprojUri.fsPath)));
		const solutionDir = pathModule.dirname(sourceProject.solutionUri.fsPath);
		const targetProjectPath = pathModule.relative(solutionDir, targetProjectUri.fsPath).replace(/\\/g, '/');
		const shouldMovePhysically = normalizePath(sourceProject.folderUri.fsPath) !== normalizePath(targetProjectFolderUri.fsPath);

		if (shouldMovePhysically) {
			const canMovePhysically = await this.canMoveProjectFolderPhysically(sourceProject, targetPhysicalBaseUri, targetProjectFolderUri);
			if (!canMovePhysically) {
				const answer = await vscode.window.showWarningMessage(
					`Project "${sourceProject.label}" cannot be moved to the matching file-system folder. Move it only inside the solution structure?`,
					'Move In Solution Only',
					'Cancel'
				);
				if (answer !== 'Move In Solution Only') {
					return;
				}
				await this.updateProjectInSolution(sourceProject.solutionUri, sourceProject.projectPath, sourceProject.projectPath, targetFolderGuid);
				this.refresh();
				return;
			}

			const projectFiles = await vscode.workspace.findFiles('**/*.csproj', '{**/bin/**,**/obj/**}');
			await vscode.workspace.fs.createDirectory(targetPhysicalBaseUri);
			await vscode.workspace.fs.rename(sourceProject.folderUri, targetProjectFolderUri, { overwrite: false });
			await this.updateProjectReferencesAfterPhysicalMove(projectFiles, sourceProject.csprojUri, targetProjectUri);
			await this.updateProjectInSolution(sourceProject.solutionUri, sourceProject.projectPath, targetProjectPath, targetFolderGuid);
			await this.onProjectFoldersChanged?.();
			this.refresh();
			return;
		}

		await this.updateProjectInSolution(sourceProject.solutionUri, sourceProject.projectPath, targetProjectPath, targetFolderGuid);
		this.refresh();
	}

	private async updateProjectInSolution(solutionUri: vscode.Uri, oldProjectPath: string, newProjectPath: string, targetFolderGuid?: string): Promise<void> {
		const content = await readUtf8(solutionUri);
		const updated = solutionUri.path.endsWith('.slnx')
			? moveSlnxProject(content, oldProjectPath, newProjectPath, targetFolderGuid)
			: moveSlnProject(content, oldProjectPath, newProjectPath, targetFolderGuid);

		if (updated === content) {
			return;
		}

		await vscode.workspace.fs.writeFile(solutionUri, Buffer.from(updated, 'utf-8'));
	}

	private async canMoveProjectFolderPhysically(sourceProject: ProjectNode, targetPhysicalBaseUri: vscode.Uri, targetProjectFolderUri: vscode.Uri): Promise<boolean> {
		const sourceFolderPath = normalizePath(sourceProject.folderUri.fsPath);
		const targetBasePath = normalizePath(targetPhysicalBaseUri.fsPath);
		const targetFolderPath = normalizePath(targetProjectFolderUri.fsPath);

		if (targetFolderPath === sourceFolderPath || targetFolderPath.startsWith(`${sourceFolderPath}/`)) {
			return false;
		}
		if (await pathExists(targetProjectFolderUri)) {
			return false;
		}

		const projectFiles = await vscode.workspace.findFiles('**/*.csproj', '{**/bin/**,**/obj/**}');
		for (const projectFile of projectFiles) {
			const projectDir = normalizePath(pathModule.dirname(projectFile.fsPath));
			if (projectDir === sourceFolderPath) {
				continue;
			}
			if (targetBasePath === projectDir || targetBasePath.startsWith(`${projectDir}/`)) {
				return false;
			}
		}

		return true;
	}

	private async updateProjectReferencesAfterPhysicalMove(projectFiles: vscode.Uri[], oldProjectUri: vscode.Uri, newProjectUri: vscode.Uri): Promise<void> {
		const oldProjectPath = oldProjectUri.fsPath;
		const newProjectPath = newProjectUri.fsPath;
		const oldProjectDir = pathModule.dirname(oldProjectPath);
		const newProjectDir = pathModule.dirname(newProjectPath);

		for (const projectFile of projectFiles) {
			const projectUri = normalizePath(projectFile.fsPath) === normalizePath(oldProjectPath) ? newProjectUri : projectFile;
			const content = await readUtf8(projectUri);
			const updated = normalizePath(projectFile.fsPath) === normalizePath(oldProjectPath)
				? rewriteProjectReferencesForMovedProject(content, oldProjectDir, newProjectDir)
				: rewriteProjectReferencesToMovedProject(content, pathModule.dirname(projectFile.fsPath), oldProjectPath, newProjectPath);

			if (updated !== content) {
				await vscode.workspace.fs.writeFile(projectUri, Buffer.from(updated, 'utf-8'));
			}
		}
	}

	async addPackageReference(item?: CsprojProjectTreeItem): Promise<void> {
		const project = item?.node.kind === 'packageGroup'
			? item.node.project
			: item?.node.kind === 'project'
				? item.node
				: undefined;
		if (!project) {
			vscode.window.showErrorMessage('CSharp Painkiller: Select a project or its Packages group.');
			return;
		}

		const result = await showAddPackagePicker(project.csprojUri.fsPath);
		if (!result) {
			return;
		}

		const content = await readUtf8(project.csprojUri);
		const centralPackageVersionsUri = await findCentralPackageVersionsFile(pathModule.dirname(project.csprojUri.fsPath));
		let includeProjectVersion = true;
		let installedVersion = result.version;
		if (centralPackageVersionsUri) {
			const centralContent = await readUtf8(centralPackageVersionsUri);
			const centralVersion = getCentralPackageVersion(centralContent, result.id);
			if (!centralVersion) {
				const updatedCentralContent = addPackageVersionToProps(centralContent, result.id, result.version);
				if (updatedCentralContent !== centralContent) {
					await vscode.workspace.fs.writeFile(centralPackageVersionsUri, Buffer.from(updatedCentralContent, 'utf-8'));
				}
				includeProjectVersion = false;
			} else {
				includeProjectVersion = compareVersions(centralVersion, result.version) !== 0;
				if (!includeProjectVersion) {
					installedVersion = centralVersion;
				}
			}
		}

		const updated = addPackageReferenceToCsproj(content, result.id, includeProjectVersion ? result.version : undefined);
		await vscode.workspace.fs.writeFile(project.csprojUri, Buffer.from(updated, 'utf-8'));
		const packageCacheKey = this.packageCacheKey(project.csprojUri, result.id);
		this.packageUpdateCache.delete(packageCacheKey);
		this.packageVersionCache.set(packageCacheKey, installedVersion);
		this.packageDependencyCache.delete(packageCacheKey);
		this.packageVulnerabilityCache.delete(project.csprojUri.toString());
		this.refresh();

		// Immediately check whether a newer version of the just-installed package is
		// available and whether it has known vulnerabilities, so the tree reflects both
		// without requiring a separate manual "Check for Package Updates" run.
		void Promise.all([
			this.refreshPackageInfo(project.csprojUri, result.id, installedVersion),
			this.refreshProjectVulnerabilities(project.csprojUri),
		]).then(() => this.refresh());
	}

	/**
	 * Replaces an outdated package's `Version` with its latest available version.
	 */
	async updatePackageReference(item?: CsprojProjectTreeItem): Promise<void> {
		if (item?.node.kind === 'centralPackageReference') {
			await this.updateCentralPackageReference(item.node);
			return;
		}
		if (!item || item.node.kind !== 'packageReference' || !item.node.latestVersion) {
			vscode.window.showErrorMessage('CSharp Painkiller: Select an outdated package to update.');
			return;
		}

		const { project, label: packageId, latestVersion } = item.node;
		const updated = await updatePackageVersionForProject(project.csprojUri, packageId, latestVersion);
		if (!updated) {
			vscode.window.showErrorMessage(`CSharp Painkiller: Could not locate "${packageId}" in the project file.`);
			return;
		}

		const packageCacheKey = this.packageCacheKey(project.csprojUri, packageId);
		this.packageUpdateCache.delete(packageCacheKey);
		this.packageVersionCache.set(packageCacheKey, latestVersion);
		this.packageVulnerabilityCache.delete(project.csprojUri.toString());
		await this.cacheCentralPackageVersionForProjects(project, packageId, latestVersion);
		await this.refreshAndRevealPackageGroup(project);
		vscode.window.showInformationMessage(`CSharp Painkiller: Updated "${packageId}" to ${latestVersion}.`);

		// Re-check in the background — an even newer version may already exist, and the
		// dependency list can differ between versions.
		void this.refreshPackageInfo(project.csprojUri, packageId, latestVersion).then(() => this.refreshAndRevealPackageGroup(project));
	}

	/**
	 * Updates every outdated package reference in a project to its latest known version in
	 * one go. Only shown (via the "Packages" group's inline button) when at least one package
	 * in that project has a newer version cached — mirrors `updatePackageReference()` but
	 * applies all pending updates instead of a single package.
	 */
	async updateAllPackageReferences(item?: CsprojProjectTreeItem): Promise<void> {
		if (item?.node.kind === 'centralPackageGroup') {
			await this.updateAllCentralPackageReferences(item.node);
			return;
		}
		if (!item || item.node.kind !== 'packageGroup') {
			vscode.window.showErrorMessage('CSharp Painkiller: Select a project\'s Packages group to update all packages.');
			return;
		}

		const project = item.node.project;
		const outdated = item.node.children.filter(pkg => pkg.latestVersion && pkg.latestVersion !== pkg.version);
		if (outdated.length === 0) {
			vscode.window.showInformationMessage(`CSharp Painkiller: No package updates available in ${project.label}.`);
			return;
		}

		const updatedPackages: { packageId: string; version: string }[] = [];
		for (const pkg of outdated) {
			const updated = await updatePackageVersionForProject(project.csprojUri, pkg.label, pkg.latestVersion!);
			if (updated) {
				updatedPackages.push({ packageId: pkg.label, version: pkg.latestVersion! });
			}
		}

		if (updatedPackages.length === 0) {
			vscode.window.showErrorMessage(`CSharp Painkiller: Could not locate the outdated package(s) in ${project.label}'s project file.`);
			return;
		}

		for (const pkg of updatedPackages) {
			this.packageUpdateCache.delete(this.packageCacheKey(project.csprojUri, pkg.packageId));
			this.packageVersionCache.set(this.packageCacheKey(project.csprojUri, pkg.packageId), pkg.version);
			await this.cacheCentralPackageVersionForProjects(project, pkg.packageId, pkg.version);
		}
		this.packageVulnerabilityCache.delete(project.csprojUri.toString());
		await this.refreshAndRevealPackageGroup(project);
		vscode.window.showInformationMessage(`CSharp Painkiller: Updated ${updatedPackages.length} package(s) in ${project.label}.`);

		// Re-check all just-updated packages in the background — an even newer version may
		// already exist for some of them.
		void Promise.all(
			updatedPackages.map(pkg => this.refreshPackageInfo(project.csprojUri, pkg.packageId, pkg.version)),
		).then(() => this.refreshAndRevealPackageGroup(project));
	}

	private async updateCentralPackageReference(node: CentralPackageReferenceNode): Promise<void> {
		if (!node.latestVersion) {
			vscode.window.showErrorMessage('CSharp Painkiller: Select an outdated central package to update.');
			return;
		}

		const content = await readUtf8(node.centralPropsUri);
		const updated = updatePackageVersionInProps(content, node.label, node.latestVersion);
		if (updated === content) {
			vscode.window.showErrorMessage(`CSharp Painkiller: Could not locate "${node.label}" in Directory.Packages.props.`);
			return;
		}

		await vscode.workspace.fs.writeFile(node.centralPropsUri, Buffer.from(updated, 'utf-8'));
		const key = this.centralPackageCacheKey(node.centralPropsUri, node.label);
		this.centralPackageUpdateCache.delete(key);
		await this.cacheCentralPackageVersionForProjectsByProps(node.centralPropsUri, node.label, node.latestVersion);
		this.refresh();
		vscode.window.showInformationMessage(`CSharp Painkiller: Updated central package "${node.label}" to ${node.latestVersion}.`);
	}

	private async updateAllCentralPackageReferences(node: CentralPackageGroupNode): Promise<void> {
		const outdated = node.children.filter(packageNode => packageNode.latestVersion && packageNode.latestVersion !== packageNode.version);
		if (outdated.length === 0) {
			vscode.window.showInformationMessage('CSharp Painkiller: All central packages are up to date.');
			return;
		}

		let content = await readUtf8(node.centralPropsUri);
		const updatedPackages: { packageId: string; version: string }[] = [];
		for (const packageNode of outdated) {
			const updated = updatePackageVersionInProps(content, packageNode.label, packageNode.latestVersion!);
			if (updated !== content) {
				content = updated;
				updatedPackages.push({ packageId: packageNode.label, version: packageNode.latestVersion! });
			}
		}

		if (updatedPackages.length === 0) {
			vscode.window.showErrorMessage('CSharp Painkiller: Could not update the central package versions.');
			return;
		}

		await vscode.workspace.fs.writeFile(node.centralPropsUri, Buffer.from(content, 'utf-8'));
		for (const packageNode of updatedPackages) {
			this.centralPackageUpdateCache.delete(this.centralPackageCacheKey(node.centralPropsUri, packageNode.packageId));
			await this.cacheCentralPackageVersionForProjectsByProps(node.centralPropsUri, packageNode.packageId, packageNode.version);
		}
		this.refresh();
		vscode.window.showInformationMessage(`CSharp Painkiller: Updated ${updatedPackages.length} central package(s).`);
	}

	private async checkCentralPackageUpdatesForGroup(node: CentralPackageGroupNode): Promise<void> {
		if (!node.representativeCsprojUri) {
			vscode.window.showWarningMessage('CSharp Painkiller: No project is available to check central package sources.');
			return;
		}

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Checking central package updates',
				cancellable: false,
			},
			async progress => this.checkCentralPackageUpdates(node.centralPropsUri, node.representativeCsprojUri!, progress),
		);
		this.refresh();
	}

	private async checkCentralPackageUpdates(
		centralPropsUri: vscode.Uri,
		representativeCsprojUri: vscode.Uri,
		progress?: vscode.Progress<{ message?: string; increment?: number }>,
	): Promise<void> {
		const content = await readUtf8(centralPropsUri);
		const packages = parsePackageVersions(content);
		progress?.report({ message: `Checking 0/${packages.length}` });
		let done = 0;
		await runWithConcurrencyLimit(packages, PACKAGE_CHECK_CONCURRENCY, async packageVersion => {
			const key = this.centralPackageCacheKey(centralPropsUri, packageVersion.name);
			try {
				const latest = await getLatestPackageVersion(representativeCsprojUri.fsPath, packageVersion.name);
				if (latest && compareVersions(latest, packageVersion.version) > 0) {
					this.centralPackageUpdateCache.set(key, latest);
				} else {
					this.centralPackageUpdateCache.delete(key);
				}
			} catch {
				// Leave the previous result intact when sources are unavailable.
			}
			done++;
			progress?.report({ increment: (1 / packages.length) * 100, message: `Checking ${done}/${packages.length}` });
		});
	}

	/**
	 * Fetches the latest available (stable) version and the declared dependencies for a
	 * single installed package, updating the shared caches.
	 *
	 * `checkFailed` is `true` when the version check itself couldn't reach any configured
	 * NuGet source (e.g. no internet connection) — callers must treat that differently from
	 * "checked successfully, no update available" instead of silently reporting "up to date".
	 * On failure, any previously cached update/dependency info is left untouched rather than
	 * cleared, so a transient offline check doesn't erase a previously known update.
	 */
	private async refreshPackageInfo(
		csprojUri: vscode.Uri,
		packageId: string,
		installedVersion: string,
	): Promise<{ hasUpdate: boolean; checkFailed: boolean }> {
		const key = this.packageCacheKey(csprojUri, packageId);

		let latest: string | undefined;
		let checkFailed = false;
		try {
			latest = await getLatestPackageVersion(csprojUri.fsPath, packageId);
		} catch {
			checkFailed = true;
		}

		const dependencies = await getPackageDependencies(csprojUri.fsPath, packageId, installedVersion).catch(() => []);

		const hasUpdate = Boolean(latest && compareVersions(latest, installedVersion) > 0);
		if (hasUpdate) {
			this.packageUpdateCache.set(key, latest!);
		} else if (!checkFailed) {
			this.packageUpdateCache.delete(key);
		}

		if (dependencies.length > 0) {
			this.packageDependencyCache.set(key, dependencies);
		} else if (!checkFailed) {
			this.packageDependencyCache.delete(key);
		}

		return { hasUpdate, checkFailed };
	}

	private async refreshProjectVulnerabilities(csprojUri: vscode.Uri): Promise<boolean> {
		try {
			const vulnerabilities = await getProjectPackageVulnerabilities(csprojUri.fsPath);
			this.packageVulnerabilityCache.set(
				csprojUri.toString(),
				vulnerabilities.map(vulnerability => ({
					kind: 'vulnerablePackage' as const,
					label: vulnerability.id,
					version: vulnerability.version,
					severity: vulnerability.severity,
					advisoryUrl: vulnerability.advisoryUrl,
					projectLabels: [],
				})),
			);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Checks every installed package in the target project against its configured NuGet
	 * sources, and caches the latest available (stable) version and dependency list for
	 * each — shown in the tree as "current → latest" plus an expandable dependency list.
	 */
	async checkPackageUpdates(item?: CsprojProjectTreeItem): Promise<void> {
		if (item?.node.kind === 'centralPackageGroup') {
			await this.checkCentralPackageUpdatesForGroup(item.node);
			return;
		}
		const project = item?.node.kind === 'packageGroup'
			? item.node.project
			: item?.node.kind === 'project'
				? item.node
				: undefined;
		if (!project) {
			vscode.window.showErrorMessage('CSharp Painkiller: Select a project or its Packages group to check for updates.');
			return;
		}

		const result = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Checking for package updates — ${project.label}`,
				cancellable: false,
			},
			async progress => {
				progress.report({ message: 'Reading project packages...' });
				const content = await readUtf8(project.csprojUri);
				const packageRefs = parsePackageReferences(content);

				if (packageRefs.length === 0) {
					return { kind: 'empty' as const };
				}

				let updateCount = 0;
				let failedCount = 0;
				progress.report({ message: 'Checking configured NuGet sources...' });
				const [projectUpdates, projectPackages] = await Promise.all([
					getProjectPackageUpdates(project.csprojUri.fsPath).catch(() => undefined),
					getProjectPackages(project.csprojUri.fsPath).catch(() => undefined),
				]);
				await this.refreshProjectVulnerabilities(project.csprojUri);

				const packages = packageRefs.map(pkg => {
					const resolved = projectPackages?.get(pkg.name.toLowerCase());
					return {
						name: pkg.name,
						version: pkg.version ?? resolved?.resolvedVersion ?? resolved?.requestedVersion,
					};
				});

				let done = 0;
				await runWithConcurrencyLimit(packages, PACKAGE_CHECK_CONCURRENCY, async pkg => {
					const key = this.packageCacheKey(project.csprojUri, pkg.name);
					if (pkg.version) {
						this.packageVersionCache.set(key, pkg.version);
					} else {
						this.packageVersionCache.delete(key);
					}

					let hasUpdate = false;
					let checkFailed = false;
					if (projectUpdates) {
						const update = projectUpdates.get(pkg.name.toLowerCase());
						hasUpdate = Boolean(update && (!pkg.version || compareVersions(update.latestVersion, pkg.version) > 0));
						if (hasUpdate) {
							this.packageUpdateCache.set(key, update!.latestVersion);
						} else {
							this.packageUpdateCache.delete(key);
						}

						const dependencies = pkg.version
							? await getPackageDependencies(project.csprojUri.fsPath, pkg.name, pkg.version, projectPackages).catch(() => [])
							: [];
						if (dependencies.length > 0) {
							this.packageDependencyCache.set(key, dependencies);
						} else {
							this.packageDependencyCache.delete(key);
						}
					} else if (pkg.version) {
						({ hasUpdate, checkFailed } = await this.refreshPackageInfo(project.csprojUri, pkg.name, pkg.version));
					} else {
						checkFailed = true;
					}
					if (checkFailed) {
						failedCount++;
					} else if (hasUpdate) {
						updateCount++;
					}
					done++;
					progress.report({ increment: (1 / packages.length) * 100, message: `${done}/${packages.length}` });
				});
				return { kind: 'checked' as const, packagesLength: packages.length, updateCount, failedCount };
			},
		);

		this.refresh();

		if (result.kind === 'empty') {
			vscode.window.showInformationMessage(`CSharp Painkiller: ${project.label} has no NuGet package references.`);
			return;
		}

		if (result.failedCount === result.packagesLength) {
			vscode.window.showWarningMessage(
				`CSharp Painkiller: Could not check for package updates in ${project.label} — no configured NuGet source could be reached. Check your internet connection.`,
			);
			return;
		}

		if (result.failedCount > 0) {
			vscode.window.showWarningMessage(
				`CSharp Painkiller: Checked ${result.packagesLength - result.failedCount} of ${result.packagesLength} package(s) in ${project.label} ` +
				`(${result.failedCount} could not be reached). ` +
				(result.updateCount > 0 ? `${result.updateCount} update(s) available.` : 'No updates found among the checked packages.'),
			);
			return;
		}

		vscode.window.showInformationMessage(
			result.updateCount > 0
				? `CSharp Painkiller: ${result.updateCount} package update(s) available in ${project.label}.`
				: `CSharp Painkiller: All packages in ${project.label} are up to date.`,
		);
	}

	/**
	 * Checks every installed package across every project in the workspace for updates and
	 * dependency info. Runs silently in the background right after the Solution Structure
	 * view initializes — no completion message when everything checks out — but shows a
	 * warning if some (or all) packages couldn't be checked at all (e.g. no internet), so a
	 * failed check is never silently mistaken for "everything is up to date".
	 */
	async checkAllProjectsForUpdates(): Promise<void> {
		const checkResult = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Window,
				title: 'CSharp Painkiller: Checking for NuGet package updates…',
			},
			async progress => {
				progress.report({ message: 'Finding projects...' });
				const csprojFiles = await vscode.workspace.findFiles('**/*.csproj', '{**/bin/**,**/obj/**}');
				const projectTasks: { csprojUri: vscode.Uri; packages: { packageId: string; version?: string }[] }[] = [];
				let packageCount = 0;

				for (const csprojUri of csprojFiles) {
					try {
						const content = await readUtf8(csprojUri);
						const packages: { packageId: string; version?: string }[] = [];
						for (const pkg of parsePackageReferences(content)) {
							packages.push({ packageId: pkg.name, version: pkg.version });
						}
						if (packages.length > 0) {
							packageCount += packages.length;
							projectTasks.push({ csprojUri, packages });
						}
					} catch {
						// Skip unreadable project files.
					}
				}
				await this.checkAllCentralPackageUpdates(csprojFiles);

				if (packageCount === 0) {
					return { failedCount: 0, packageCount: 0 };
				}

				let failedCount = 0;
				let done = 0;
				const reportProjectDone = () => {
					done++;
					progress.report({ increment: (1 / projectTasks.length) * 100, message: `${done}/${projectTasks.length}` });
				};
				await runWithConcurrencyLimit(projectTasks, PACKAGE_CHECK_CONCURRENCY, async projectTask => {
					try {
						let projectUpdates: Map<string, { latestVersion: string }> | undefined;
						let projectPackages: Map<string, PackageInfo> | undefined;
						try {
							projectUpdates = await getProjectPackageUpdates(projectTask.csprojUri.fsPath);
						} catch {
							projectUpdates = undefined;
						}
						try {
							projectPackages = await getProjectPackages(projectTask.csprojUri.fsPath);
						} catch {
							projectPackages = undefined;
						}
						await this.refreshProjectVulnerabilities(projectTask.csprojUri);

						if (projectUpdates) {
							for (const pkg of projectTask.packages) {
								const key = this.packageCacheKey(projectTask.csprojUri, pkg.packageId);
								const resolved = projectPackages?.get(pkg.packageId.toLowerCase());
								const version = pkg.version ?? resolved?.resolvedVersion ?? resolved?.requestedVersion;
								if (version) {
									this.packageVersionCache.set(key, version);
								} else {
									this.packageVersionCache.delete(key);
								}

								const update = projectUpdates.get(pkg.packageId.toLowerCase());
								if (update && (!version || compareVersions(update.latestVersion, version) > 0)) {
									this.packageUpdateCache.set(key, update.latestVersion);
								} else {
									this.packageUpdateCache.delete(key);
								}

								const dependencies = version
									? await getPackageDependencies(projectTask.csprojUri.fsPath, pkg.packageId, version, projectPackages).catch(() => [])
									: [];
								if (dependencies.length > 0) {
									this.packageDependencyCache.set(key, dependencies);
								} else {
									this.packageDependencyCache.delete(key);
								}
							}
							return;
						}

						for (const pkg of projectTask.packages) {
							const resolved = projectPackages?.get(pkg.packageId.toLowerCase());
							const version = pkg.version ?? resolved?.resolvedVersion ?? resolved?.requestedVersion;
							if (!version) {
								failedCount++;
								continue;
							}

							this.packageVersionCache.set(this.packageCacheKey(projectTask.csprojUri, pkg.packageId), version);
							const { checkFailed } = await this.refreshPackageInfo(projectTask.csprojUri, pkg.packageId, version);
							if (checkFailed) {
								failedCount++;
							}
						}
					} finally {
						reportProjectDone();
					}
				});
			return { failedCount, packageCount };
		},
		);
		this.refresh();

		if (checkResult.failedCount > 0) {
			vscode.window.showWarningMessage(
				checkResult.failedCount === checkResult.packageCount
					? 'CSharp Painkiller: Could not check for NuGet package updates — no configured source could be reached. Check your internet connection.'
					: `CSharp Painkiller: Could not check ${checkResult.failedCount} of ${checkResult.packageCount} package(s) for updates (no configured source could be reached).`,
			);
		}
	}


	private async checkAllCentralPackageUpdates(csprojFiles: vscode.Uri[]): Promise<void> {
		const propsFiles = await vscode.workspace.findFiles('**/Directory.Packages.props', '{**/bin/**,**/obj/**}');
		await Promise.all(propsFiles.map(async centralPropsUri => {
			const representative = await this.findCentralPackageRepresentativeFromFiles(centralPropsUri, csprojFiles);
			if (representative) {
				await this.checkCentralPackageUpdates(centralPropsUri, representative);
			}
		}));
	}

	private async findCentralPackageRepresentativeFromFiles(
		centralPropsUri: vscode.Uri,
		csprojFiles: vscode.Uri[],
	): Promise<vscode.Uri | undefined> {
		for (const csprojUri of csprojFiles) {
			const projectCentralPropsUri = await findCentralPackageVersionsFile(pathModule.dirname(csprojUri.fsPath));
			if (projectCentralPropsUri && normalizePath(projectCentralPropsUri.fsPath) === normalizePath(centralPropsUri.fsPath)) {
				return csprojUri;
			}
		}
		return undefined;
	}

	async removePackageReference(item?: CsprojProjectTreeItem): Promise<void> {
		if (!item || item.node.kind !== 'packageReference') {
			vscode.window.showErrorMessage('CSharp Painkiller: Select a package reference to remove.');
			return;
		}

		const answer = await vscode.window.showWarningMessage(
			`Remove package "${item.node.label}"?`,
			{ modal: true },
			'Remove'
		);
		if (answer !== 'Remove') {
			return;
		}

		const content = await readUtf8(item.node.project.csprojUri);
		const updated = removePackageReferenceFromCsproj(content, item.node.label);
		await vscode.workspace.fs.writeFile(item.node.project.csprojUri, Buffer.from(updated, 'utf-8'));
		const key = this.packageCacheKey(item.node.project.csprojUri, item.node.label);
		this.packageUpdateCache.delete(key);
		this.packageVersionCache.delete(key);
		this.packageDependencyCache.delete(key);
		this.packageVulnerabilityCache.delete(item.node.project.csprojUri.toString());
		await this.removeUnusedCentralPackageVersion(item.node.project, item.node.label);
		await this.refreshAndRevealPackageGroup(item.node.project);
	}

	async openPackageVulnerability(item?: CsprojProjectTreeItem): Promise<void> {
		if (!item || item.node.kind !== 'vulnerablePackage' || !item.node.advisoryUrl) {
			vscode.window.showInformationMessage('CSharp Painkiller: No advisory URL is available for this vulnerability.');
			return;
		}

		await vscode.env.openExternal(vscode.Uri.parse(item.node.advisoryUrl));
	}

	private async refreshAndRevealPackageGroup(project: ProjectNode): Promise<void> {
		this.refresh();
		if (!this.treeView) {
			return;
		}

		await new Promise(resolve => setTimeout(resolve, 0));
		await this.treeView.reveal(
			this.createTreeItem({ kind: 'packageGroup', label: 'Packages', project, children: [] }),
			{ expand: true, focus: false, select: false },
		).then(undefined, err => console.warn('CSharp Painkiller: could not restore Packages tree expansion', err));
	}

	private async cacheCentralPackageVersionForProjects(
		updatedProject: ProjectNode,
		packageId: string,
		version: string,
	): Promise<void> {
		const centralPropsUri = await findCentralPackageVersionsFile(pathModule.dirname(updatedProject.csprojUri.fsPath));
		if (!centralPropsUri) {
			return;
		}
		await this.cacheCentralPackageVersionForProjectsByProps(centralPropsUri, packageId, version);
	}

	private async cacheCentralPackageVersionForProjectsByProps(
		centralPropsUri: vscode.Uri,
		packageId: string,
		version: string,
	): Promise<void> {

		const projectUris = await vscode.workspace.findFiles('**/*.csproj', '{**/bin/**,**/obj/**}');
		await Promise.all(projectUris.map(async projectUri => {
			const projectCentralPropsUri = await findCentralPackageVersionsFile(pathModule.dirname(projectUri.fsPath));
			if (!projectCentralPropsUri || normalizePath(projectCentralPropsUri.fsPath) !== normalizePath(centralPropsUri.fsPath)) {
				return;
			}

			const content = await readUtf8(projectUri);
			const packageReference = parsePackageReferences(content).find(reference => reference.name.toLowerCase() === packageId.toLowerCase());
			if (packageReference && !packageReference.version) {
				this.packageVersionCache.set(this.packageCacheKey(projectUri, packageId), version);
			}
		}));
	}

	private async removeUnusedCentralPackageVersion(project: ProjectNode, packageId: string): Promise<void> {
		const centralPropsUri = await findCentralPackageVersionsFile(pathModule.dirname(project.csprojUri.fsPath));
		if (!centralPropsUri) {
			return;
		}

		const projectUris = await vscode.workspace.findFiles('**/*.csproj', '{**/bin/**,**/obj/**}');
		const packageReferences = await Promise.all(projectUris.map(async projectUri => {
			const projectCentralPropsUri = await findCentralPackageVersionsFile(pathModule.dirname(projectUri.fsPath));
			if (!projectCentralPropsUri || normalizePath(projectCentralPropsUri.fsPath) !== normalizePath(centralPropsUri.fsPath)) {
				return false;
			}

			const content = await readUtf8(projectUri);
			return parsePackageReferences(content).some(reference => reference.name.toLowerCase() === packageId.toLowerCase());
		}));
		if (packageReferences.some(Boolean)) {
			return;
		}

		const content = await readUtf8(centralPropsUri);
		const updated = removePackageVersionFromProps(content, packageId);
		if (updated !== content) {
			await vscode.workspace.fs.writeFile(centralPropsUri, Buffer.from(updated, 'utf-8'));
		}
	}


	async removeProjectReference(item?: CsprojProjectTreeItem): Promise<void> {
		if (!item || item.node.kind !== 'projectReference') {
			vscode.window.showErrorMessage('CSharp Painkiller: Select a project reference.');
			return;
		}

		const answer = await vscode.window.showWarningMessage(
			`Remove reference to "${item.node.label}"?`,
			{ modal: true },
			'Remove Reference'
		);
		if (answer !== 'Remove Reference') {
			return;
		}

		const content = await readUtf8(item.node.project.csprojUri);
		const updated = removeProjectReferenceFromCsproj(content, item.node.referencePath);
		await vscode.workspace.fs.writeFile(item.node.project.csprojUri, Buffer.from(updated, 'utf-8'));
		this.refresh();
	}

	private async shouldDeletePhysicalFolder(folderUri: vscode.Uri, label: string): Promise<boolean | undefined> {
		try {
			const stat = await vscode.workspace.fs.stat(folderUri);
			if ((stat.type & vscode.FileType.Directory) !== vscode.FileType.Directory) {
				return false;
			}
		} catch {
			return false;
		}

		const entries = await vscode.workspace.fs.readDirectory(folderUri);
		if (entries.length > 0) {
			const answer = await vscode.window.showWarningMessage(
				`Physical folder "${label}" is not empty. Delete it too?`,
				{ modal: true },
				'Delete Physical Folder',
				'Keep Physical Folder'
			);
			if (answer === 'Keep Physical Folder') {
				return false;
			}
			if (answer !== 'Delete Physical Folder') {
				return undefined;
			}
		}

		return true;
	}

	private async resolveCreateFolderTarget(item?: CsprojProjectTreeItem): Promise<CreateFolderTarget | undefined> {
		if (item?.createFolderTarget) {
			return item.createFolderTarget;
		}

		const solutionFiles = await vscode.workspace.findFiles('**/*.{sln,slnx}', '{**/bin/**,**/obj/**}');
		if (solutionFiles.length === 0) {
			vscode.window.showErrorMessage('CSharp Painkiller: No .sln or .slnx file found.');
			return undefined;
		}

		const solutionUri = solutionFiles.length === 1
			? solutionFiles[0]
			: await vscode.window.showQuickPick(
				solutionFiles.map(uri => ({ label: pathModule.basename(uri.fsPath), description: uri.fsPath, uri })),
				{ placeHolder: 'Select solution for the new folder' }
			).then(pick => pick?.uri);

		if (!solutionUri) {
			return undefined;
		}

		return {
			solutionUri,
			physicalBaseUri: vscode.Uri.file(pathModule.dirname(solutionUri.fsPath)),
		};
	}

	private resolveSolutionUriFromItem(item?: CsprojProjectTreeItem): vscode.Uri | undefined {
		if (!item) {
			return undefined;
		}
		if (item.node.kind === 'solution') {
			return item.node.solutionUri;
		}
		if (item.node.kind === 'folder') {
			return item.createFolderTarget?.solutionUri;
		}
		if (item.node.kind === 'project') {
			return item.node.solutionUri;
		}
		if (item.node.kind === 'excludedProjects' || item.node.kind === 'excludedProject') {
			return item.node.solutionUri;
		}
		return undefined;
	}

	private async removeProjectFromSolution(solutionUri: vscode.Uri, projectPath: string): Promise<void> {
		const content = await readUtf8(solutionUri);
		const updated = solutionUri.path.endsWith('.slnx')
			? removeSlnxProject(content, projectPath)
			: removeSlnProject(content, projectPath);
		await vscode.workspace.fs.writeFile(solutionUri, Buffer.from(updated, 'utf-8'));
	}

	private async addProjectToSolution(solutionUri: vscode.Uri, projectUri: vscode.Uri): Promise<void> {
		const solutionDir = pathModule.dirname(solutionUri.fsPath);
		const relativeProjectPath = pathModule.relative(solutionDir, projectUri.fsPath).replace(/\\/g, '/');
		if (solutionUri.path.endsWith('.slnx')) {
			const content = await readUtf8(solutionUri);
			const ensured = ensureSlnxFolderPath(content, getProjectSolutionFolderPath(relativeProjectPath));
			const updated = addSlnxProject(ensured.content, relativeProjectPath, ensured.folderPath);
			await vscode.workspace.fs.writeFile(solutionUri, Buffer.from(updated, 'utf-8'));
			return;
		}

		const originalContent = await readUtf8(solutionUri);
		const result = spawnSync('dotnet', ['sln', solutionUri.fsPath, 'add', projectUri.fsPath], {
			cwd: solutionDir,
			timeout: 120_000,
			shell: false,
		});
		if (result.error || result.status !== 0) {
			throw result.error ?? new Error(result.stderr?.toString() || 'Failed to add project to solution');
		}
		const updatedContent = this.removeNewSlnCommentLines(originalContent, await readUtf8(solutionUri));
		const ensured = ensureSlnFolderPath(updatedContent, getProjectSolutionFolderPath(relativeProjectPath));
		const updated = ensured.folderGuid
			? moveSlnProjectToFolder(ensured.content, relativeProjectPath, ensured.folderGuid)
			: ensured.content;
		await vscode.workspace.fs.writeFile(solutionUri, Buffer.from(updated, 'utf-8'));
	}

	private removeNewSlnCommentLines(originalContent: string, updatedContent: string): string {
		const originalComments = new Set(originalContent.split(/\r?\n/).filter(line => /^\s*#/.test(line)));
		return updatedContent
			.split(/\r?\n/)
			.filter(line => !/^\s*#/.test(line) || originalComments.has(line))
			.join('\n');
	}

	private async buildTree(): Promise<CsprojTreeNode[]> {
		const csprojFiles = await vscode.workspace.findFiles('**/*.csproj', '{**/bin/**,**/obj/**}');
		const projectByPath = new Map(csprojFiles.map(uri => [normalizePath(uri.fsPath), uri]));
		const solutionFiles = await vscode.workspace.findFiles('**/*.{sln,slnx}', '{**/bin/**,**/obj/**}');

		if (solutionFiles.length === 0) {
			return [];
		}

		const usedProjectPaths = new Set<string>();
		const solutionNodes: CsprojTreeNode[] = [];
		for (const solutionUri of solutionFiles.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
			const solutionNode = await this.createSolutionNode(solutionUri, projectByPath, usedProjectPaths);
			sortTree(solutionNode.children);
			solutionNodes.push(solutionNode);
		}

		return solutionNodes;
	}

	private async createSolutionNode(
		solutionUri: vscode.Uri,
		projectByPath: Map<string, vscode.Uri>,
		usedProjectPaths: Set<string>
	): Promise<SolutionNode> {
		const solutionDir = pathModule.dirname(solutionUri.fsPath);
		const content = await readUtf8(solutionUri);
		const entries = solutionUri.path.endsWith('.slnx')
			? parseSlnxProjects(content)
			: parseSlnProjects(content);
		const children = await this.createSolutionChildren(entries, solutionUri, solutionDir, projectByPath, usedProjectPaths);
		const centralPackages = await this.createCentralPackageGroup(solutionUri, solutionDir, entries, projectByPath);
		if (centralPackages) {
			children.push(centralPackages);
		}
		const vulnerablePackages = this.createVulnerablePackagesNode(solutionUri, solutionDir, entries);
		if (vulnerablePackages.children.length > 0) {
			children.push(vulnerablePackages);
		}
		const excludedProjects = await this.createExcludedProjectsNode(solutionUri, solutionDir, entries);
		if (excludedProjects.children.length > 0) {
			children.push(excludedProjects);
		}

		return {
			kind: 'solution',
			label: pathModule.basename(solutionUri.fsPath),
			solutionUri,
			createFolderTarget: {
				solutionUri,
				physicalBaseUri: vscode.Uri.file(solutionDir),
			},
			children,
		};
	}

	private async createCentralPackageGroup(
		solutionUri: vscode.Uri,
		solutionDir: string,
		entries: SlnProjectEntry[],
		projectByPath: Map<string, vscode.Uri>,
	): Promise<CentralPackageGroupNode | undefined> {
		const centralPropsUri = await findCentralPackageVersionsFile(solutionDir);
		if (!centralPropsUri) {
			return undefined;
		}

		const content = await readUtf8(centralPropsUri);
		const representativeCsprojUri = await this.findCentralPackageRepresentativeProject(entries, solutionDir, projectByPath);
		const children = parsePackageVersions(content).map(packageVersion => {
			const key = this.centralPackageCacheKey(centralPropsUri, packageVersion.name);
			return {
				kind: 'centralPackageReference' as const,
				label: packageVersion.name,
				version: packageVersion.version,
				latestVersion: this.centralPackageUpdateCache.get(key),
				centralPropsUri,
				solutionUri,
				representativeCsprojUri,
			};
		});

		return {
			kind: 'centralPackageGroup',
			label: 'Central Packages',
			solutionUri,
			centralPropsUri,
			representativeCsprojUri,
			children,
		};
	}

	private async findCentralPackageRepresentativeProject(
		entries: SlnProjectEntry[],
		solutionDir: string,
		projectByPath: Map<string, vscode.Uri>,
	): Promise<vscode.Uri | undefined> {
		for (const entry of entries.filter(item => !item.isSolutionFolder)) {
			const absolutePath = normalizePath(pathModule.resolve(solutionDir, entry.projectPath));
			const projectUri = projectByPath.get(absolutePath);
			if (projectUri) {
				return projectUri;
			}
		}
		return undefined;
	}

	private createVulnerablePackagesNode(solutionUri: vscode.Uri, solutionDir: string, entries: SlnProjectEntry[]): VulnerablePackagesNode {
		const byPackage = new Map<string, VulnerablePackageNode>();
		for (const entry of entries.filter(item => !item.isSolutionFolder)) {
			const csprojUri = vscode.Uri.file(pathModule.resolve(solutionDir, entry.projectPath));
			const vulnerabilities = this.packageVulnerabilityCache.get(csprojUri.toString()) ?? [];
			for (const vulnerability of vulnerabilities) {
				const key = `${vulnerability.label.toLowerCase()}::${vulnerability.version ?? ''}::${vulnerability.severity.toLowerCase()}::${vulnerability.advisoryUrl ?? ''}`;
				const existing = byPackage.get(key);
				if (existing) {
					if (!existing.projectLabels.includes(entry.name)) {
						existing.projectLabels.push(entry.name);
					}
					continue;
				}

				byPackage.set(key, {
					...vulnerability,
					projectLabels: [entry.name],
				});
			}
		}

		const children = [...byPackage.values()]
			.sort((a, b) => compareVulnerabilitySeverity(b.severity, a.severity) || a.label.localeCompare(b.label));
		return {
			kind: 'vulnerablePackages',
			label: 'Vulnerable Packages',
			solutionUri,
			children,
		};
	}

	private async createExcludedProjectsNode(solutionUri: vscode.Uri, solutionDir: string, entries: SlnProjectEntry[]): Promise<ExcludedProjectsNode> {
		const includedPaths = new Set(entries
			.filter(entry => !entry.isSolutionFolder)
			.map(entry => normalizePath(pathModule.resolve(solutionDir, entry.projectPath))));
		const excludedProjects = (await vscode.workspace.findFiles('**/*.csproj', '{**/bin/**,**/obj/**}'))
			.filter(uri => !includedPaths.has(normalizePath(uri.fsPath)))
			.map(uri => ({
				kind: 'excludedProject' as const,
				label: pathModule.basename(uri.fsPath, pathModule.extname(uri.fsPath)),
				solutionUri,
				csprojUri: uri,
			}))
			.sort((a, b) => a.label.localeCompare(b.label));

		return {
			kind: 'excludedProjects',
			label: 'Excluded Projects',
			solutionUri,
			children: excludedProjects,
		};
	}

	private async createSolutionChildren(
		entries: SlnProjectEntry[],
		solutionUri: vscode.Uri,
		solutionDir: string,
		projectByPath: Map<string, vscode.Uri>,
		usedProjectPaths: Set<string>
	): Promise<CsprojTreeNode[]> {
		const foldersByGuid = new Map(entries
			.filter(entry => entry.isSolutionFolder)
			.map(entry => [entry.guid, entry]));
		const rootNodes: CsprojTreeNode[] = [];
		const folderNodes = new Map<string, FolderNode>();

		function getFolderPath(folder: SlnProjectEntry): string {
			const segments = [folder.name];
			let parentGuid = folder.parentGuid;
			while (parentGuid) {
				const parent = foldersByGuid.get(parentGuid);
				if (!parent) {
					break;
				}
				segments.unshift(parent.name);
				parentGuid = parent.parentGuid;
			}
			return pathModule.join(solutionDir, ...segments);
		}

		function getFolderNode(folder: SlnProjectEntry): FolderNode {
			const existing = folderNodes.get(folder.guid);
			if (existing) {
				return existing;
			}

			const folderUri = vscode.Uri.file(getFolderPath(folder));
			const node: FolderNode = {
				kind: 'folder',
				label: folder.name,
				createProjectUri: folderUri,
				createFolderTarget: {
					solutionUri,
					parentGuid: folder.guid,
					physicalBaseUri: folderUri,
					solutionFolderPath: getSolutionFolderPath(folder, [...foldersByGuid.values()]),
				},
				deleteFolderTarget: {
					solutionUri,
					parentGuid: folder.guid,
					physicalBaseUri: folderUri,
				},
				children: [],
			};
			folderNodes.set(folder.guid, node);

			if (folder.parentGuid && foldersByGuid.has(folder.parentGuid)) {
				getFolderNode(foldersByGuid.get(folder.parentGuid)!).children.push(node);
			} else {
				rootNodes.push(node);
			}

			return node;
		}

		for (const folder of foldersByGuid.values()) {
			getFolderNode(folder);
		}

		const solutionProjectPaths = new Set(entries
			.filter(item => !item.isSolutionFolder)
			.map(item => normalizePath(pathModule.resolve(solutionDir, item.projectPath))));

		for (const entry of entries.filter(item => !item.isSolutionFolder)) {
			const absoluteProjectPath = normalizePath(pathModule.resolve(solutionDir, entry.projectPath));
			const csprojUri = projectByPath.get(absoluteProjectPath) ?? vscode.Uri.file(pathModule.resolve(solutionDir, entry.projectPath));
			const existsOnDisk = await pathExists(csprojUri);

			usedProjectPaths.add(absoluteProjectPath);
			const projectNode = await this.createProjectNode(csprojUri, solutionUri, entry.projectPath, existsOnDisk, solutionProjectPaths, this.getVirtualPath(entry, foldersByGuid), entry.name);

			if (entry.parentGuid && foldersByGuid.has(entry.parentGuid)) {
				getFolderNode(foldersByGuid.get(entry.parentGuid)!).children.push(projectNode);
			} else {
				rootNodes.push(projectNode);
			}
		}

		sortTree(rootNodes);
		return rootNodes;
	}

	private getVirtualPath(entry: SlnProjectEntry, foldersByGuid: Map<string, SlnProjectEntry>): string | undefined {
		const segments = [entry.name];
		let parentGuid = entry.parentGuid;
		while (parentGuid) {
			const folder = foldersByGuid.get(parentGuid);
			if (!folder) {
				break;
			}
			segments.unshift(folder.name);
			parentGuid = folder.parentGuid;
		}

		return segments.length > 1 ? segments.join('/') : undefined;
	}

	private async createProjectNode(
		csprojUri: vscode.Uri,
		solutionUri: vscode.Uri,
		projectPath: string,
		existsOnDisk: boolean,
		solutionProjectPaths: ReadonlySet<string>,
		virtualPath?: string,
		displayName?: string
	): Promise<ProjectNode> {
		const folderPath = csprojUri.path.replace(/\/[^/]*$/, '');
		const folderUri = csprojUri.with({ path: folderPath });
		const label = displayName ?? folderPath.split('/').filter(Boolean).pop() ?? csprojUri.fsPath;

		const targetFramework = existsOnDisk ? await this.getTargetFramework(csprojUri) : undefined;

		return {
			kind: 'project',
			label,
			folderUri,
			csprojUri,
			solutionUri,
			projectPath,
			existsOnDisk,
			solutionProjectPaths,
			isAspNet: existsOnDisk ? await this.isAspNetProject(csprojUri) : false,
			isTest: existsOnDisk ? await this.isTestProject(csprojUri) : false,
			virtualPath,
			targetFramework,
			languageVersion: existsOnDisk ? await this.getLanguageVersion(csprojUri) : undefined,
		};
	}

	private async isAspNetProject(csprojUri: vscode.Uri): Promise<boolean> {
		try {
			const bytes = await vscode.workspace.fs.readFile(csprojUri);
			const content = Buffer.from(bytes).toString('utf-8');
			return /Microsoft\.NET\.Sdk\.Web|Microsoft\.AspNetCore/i.test(content);
		} catch {
			return false;
		}
	}

	private async isTestProject(csprojUri: vscode.Uri): Promise<boolean> {
		try {
			const bytes = await vscode.workspace.fs.readFile(csprojUri);
			const content = Buffer.from(bytes).toString('utf-8');
			return /<IsTestProject>\s*true\s*<\/IsTestProject>/i.test(content) ||
				/Microsoft\.NET\.Test\.Sdk|xunit|nunit|MSTest\.TestFramework|MSTest\.TestAdapter/i.test(content);
		} catch {
			return false;
		}
	}

	private async getTargetFramework(csprojUri: vscode.Uri): Promise<string | undefined> {
		try {
			const bytes = await vscode.workspace.fs.readFile(csprojUri);
			const content = Buffer.from(bytes).toString('utf-8');
			const single = content.match(/<TargetFramework>\s*([^<]+?)\s*<\/TargetFramework>/i);
			if (single) {
				return single[1].trim();
			}
			const multi = content.match(/<TargetFrameworks>\s*([^<]+?)\s*<\/TargetFrameworks>/i);
			if (multi) {
				return multi[1].trim().split(';')[0].trim();
			}
			return undefined;
		} catch {
			return undefined;
		}
	}

	private async getLanguageVersion(csprojUri: vscode.Uri): Promise<string | undefined> {
		try {
			const bytes = await vscode.workspace.fs.readFile(csprojUri);
			const content = Buffer.from(bytes).toString('utf-8');
			const explicitVersion = content.match(/<LangVersion>\s*([^<]+?)\s*<\/LangVersion>/i)?.[1]?.trim();
			return formatLanguageVersion(explicitVersion);
		} catch {
			return undefined;
		}
	}

	dispose(): void {
		if (this.initialPackageUpdateCheckTimer) {
			clearTimeout(this.initialPackageUpdateCheckTimer);
		}
		if (this.watcherRefreshTimer) {
			clearTimeout(this.watcherRefreshTimer);
		}
		this.watcher.dispose();
		this.solutionWatcher.dispose();
		this.workspaceDeleteWatcher.dispose();
		this.changeEmitter.dispose();
	}
}

export class CsprojProjectTreeItem extends vscode.TreeItem {
	public readonly createProjectUri?: vscode.Uri;
	public readonly createFolderTarget?: CreateFolderTarget;
	public readonly deleteFolderTarget?: CreateFolderTarget;

	constructor(public readonly node: CsprojTreeNode, extensionUri: vscode.Uri) {
		super(node.label, getCollapsibleState(node));

		this.id = getNodeId(node);
		this.contextValue = `csharppainkiller.${node.kind}`;

		if (node.kind === 'project') {
			const parts = [node.existsOnDisk ? node.targetFramework : 'missing on disk', node.languageVersion, node.virtualPath].filter(Boolean);
			this.description = parts.length > 0 ? parts.join(', ') : undefined;
			this.tooltip = `${node.virtualPath ? `Solution path: ${node.virtualPath}\n` : ''}${node.existsOnDisk ? node.csprojUri.fsPath : `Missing project file:\n${node.csprojUri.fsPath}`}`;
			if (!node.existsOnDisk) {
				this.contextValue = 'csharppainkiller.project.missing';
				this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
				return;
			}
			this.updateProjectIcon(extensionUri);
			this.command = {
				command: 'csharppainkiller.revealProjectFolder',
				title: 'Reveal Project Folder',
				arguments: [node.folderUri],
			};
			return;
		}

		if (node.kind === 'referenceGroup' || node.kind === 'packageGroup' || node.kind === 'centralPackageGroup') {
			const hasOutdatedPackage = node.kind === 'packageGroup'
				&& node.children.some(pkg => pkg.latestVersion && pkg.latestVersion !== pkg.version);
			const hasOutdatedCentralPackage = node.kind === 'centralPackageGroup'
				&& node.children.some(pkg => pkg.latestVersion && pkg.latestVersion !== pkg.version);
			const hasBrokenProjectReference = node.kind === 'referenceGroup'
				&& node.children.some(reference => !reference.existsOnDisk || !reference.includedInSolution);
			this.contextValue = hasBrokenProjectReference
				? 'csharppainkiller.referenceGroup.missing'
				: hasOutdatedPackage || hasOutdatedCentralPackage
				? `csharppainkiller.${node.kind}.outdated`
				: `csharppainkiller.${node.kind}`;
			this.iconPath = hasBrokenProjectReference
				? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'))
				: hasOutdatedPackage || hasOutdatedCentralPackage
				? new vscode.ThemeIcon('package', new vscode.ThemeColor('problemsWarningIcon.foreground'))
				: new vscode.ThemeIcon(node.kind === 'referenceGroup' ? 'references' : 'package');
			if (hasBrokenProjectReference) {
				this.tooltip = 'One or more project references are missing on disk or not included in the solution.';
			}
			if (hasOutdatedPackage) {
				this.tooltip = 'One or more packages have updates available.';
			}
			if (hasOutdatedCentralPackage) {
				this.tooltip = 'One or more central packages have updates available.';
			}
			return;
		}

		if (node.kind === 'projectReference') {
			const status = !node.existsOnDisk
				? 'missing on disk'
				: !node.includedInSolution ? 'not in solution' : undefined;
			this.contextValue = status
				? 'csharppainkiller.projectReference.missing'
				: 'csharppainkiller.projectReference';
			this.description = [status, pathModule.dirname(node.referencePath).replace(/\\/g, '/')].filter(Boolean).join(', ');
			this.tooltip = status
				? `${status}:\n${node.resolvedUri.fsPath}`
				: node.resolvedUri.fsPath;
			this.iconPath = status
				? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'))
				: new vscode.ThemeIcon('file-submodule');
			return;
		}

		if (node.kind === 'packageReference') {
			const hasUpdate = Boolean(node.latestVersion && node.latestVersion !== node.version);
			this.contextValue = hasUpdate
				? 'csharppainkiller.packageReference.outdated'
				: 'csharppainkiller.packageReference';
			this.description = hasUpdate ? `${node.version}  →  ${node.latestVersion}` : node.version;
			const depCount = node.dependencies?.length ?? 0;
			this.tooltip = [
				`Installed: ${node.version}`,
				hasUpdate ? `Latest available: ${node.latestVersion}` : undefined,
				depCount > 0 ? `Depends on ${depCount} package${depCount === 1 ? '' : 's'}` : undefined,
			].filter((line): line is string => Boolean(line)).join('\n');
			this.iconPath = hasUpdate
				? new vscode.ThemeIcon('package', new vscode.ThemeColor('problemsWarningIcon.foreground'))
				: new vscode.ThemeIcon('package');
			return;
		}

		if (node.kind === 'centralPackageReference') {
			const hasUpdate = Boolean(node.latestVersion && node.latestVersion !== node.version);
			this.contextValue = hasUpdate
				? 'csharppainkiller.centralPackageReference.outdated'
				: 'csharppainkiller.centralPackageReference';
			this.description = hasUpdate ? `${node.version}  →  ${node.latestVersion}` : node.version;
			this.tooltip = hasUpdate
				? `Central version: ${node.version}\nLatest available: ${node.latestVersion}`
				: `Central version: ${node.version}`;
			this.iconPath = hasUpdate
				? new vscode.ThemeIcon('package', new vscode.ThemeColor('problemsWarningIcon.foreground'))
				: new vscode.ThemeIcon('package');
			return;
		}

		if (node.kind === 'packageDependency') {
			this.contextValue = 'csharppainkiller.packageDependency';
			this.description = node.version;
			this.tooltip = `${node.label}${node.version ? ` ${node.version}` : ''}`;
			this.iconPath = new vscode.ThemeIcon('circle-small-filled');
			return;
		}

		if (node.kind === 'excludedProjects') {
			this.contextValue = 'csharppainkiller.excludedProjects';
			this.description = `${node.children.length}`;
			this.iconPath = new vscode.ThemeIcon('exclude');
			return;
		}

		if (node.kind === 'excludedProject') {
			this.contextValue = 'csharppainkiller.excludedProject';
			this.description = pathModule.relative(pathModule.dirname(node.solutionUri.fsPath), node.csprojUri.fsPath).replace(/\\/g, '/');
			this.iconPath = new vscode.ThemeIcon('circle-slash');
			return;
		}

		if (node.kind === 'vulnerablePackages') {
			this.contextValue = 'csharppainkiller.vulnerablePackages';
			this.description = `${node.children.length}`;
			this.tooltip = 'Known vulnerabilities found in packages referenced by this solution.';
			this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
			return;
		}

		if (node.kind === 'vulnerablePackage') {
			const isCritical = isCriticalVulnerability(node.severity);
			this.contextValue = 'csharppainkiller.vulnerablePackage';
			this.description = [node.version, node.severity].filter(Boolean).join(', ');
			this.tooltip = [
				`${node.label}${node.version ? ` ${node.version}` : ''}: ${node.severity} vulnerability`,
				node.projectLabels.length > 0 ? `Projects: ${node.projectLabels.join(', ')}` : undefined,
				node.advisoryUrl,
			].filter((line): line is string => Boolean(line)).join('\n');
			this.iconPath = new vscode.ThemeIcon(
				'warning',
				new vscode.ThemeColor(isCritical ? 'problemsErrorIcon.foreground' : 'problemsWarningIcon.foreground'),
			);
			return;
		}

		this.createProjectUri = node.kind === 'solution'
			? vscode.Uri.file(pathModule.dirname(node.solutionUri.fsPath))
			: node.createProjectUri;
		this.createFolderTarget = node.createFolderTarget;
		this.deleteFolderTarget = node.kind === 'folder' ? node.deleteFolderTarget : undefined;
		this.iconPath = node.kind === 'solution'
			? vscode.Uri.joinPath(extensionUri, 'icons', 'dotnetSolution.svg')
			: new vscode.ThemeIcon('folder');
		this.tooltip = node.kind === 'solution' ? node.solutionUri.fsPath : node.label;
	}

	updateProjectIcon(extensionUri: vscode.Uri): void {
		if (this.node.kind !== 'project') {
			return;
		}

		const iconName = this.node.isTest
			? 'dotnetTestsFolder.svg'
			: this.node.isAspNet
				? 'dotnetAspNetFolder.svg'
				: 'dotnetDefaultFolder.svg';
		this.iconPath = vscode.Uri.joinPath(extensionUri, 'icons', iconName);
	}
}

function getCollapsibleState(node: CsprojTreeNode): vscode.TreeItemCollapsibleState {
	if (node.kind === 'project' && !node.existsOnDisk) {
		return vscode.TreeItemCollapsibleState.None;
	}
	if (node.kind === 'project' || node.kind === 'referenceGroup' || node.kind === 'packageGroup' || node.kind === 'centralPackageGroup' || node.kind === 'excludedProjects' || node.kind === 'vulnerablePackages') {
		return vscode.TreeItemCollapsibleState.Collapsed;
	}
	if (node.kind === 'packageReference') {
		return node.dependencies && node.dependencies.length > 0
			? vscode.TreeItemCollapsibleState.Collapsed
			: vscode.TreeItemCollapsibleState.None;
	}
	if (node.kind === 'packageDependency') {
		return node.dependencies && node.dependencies.length > 0
			? vscode.TreeItemCollapsibleState.Collapsed
			: vscode.TreeItemCollapsibleState.None;
	}
	if (node.kind === 'projectReference' || node.kind === 'centralPackageReference' || node.kind === 'excludedProject' || node.kind === 'vulnerablePackage') {
		return vscode.TreeItemCollapsibleState.None;
	}
	return vscode.TreeItemCollapsibleState.Expanded;
}

function getNestedTreeNodes(node: CsprojTreeNode): CsprojTreeNode[] {
	if ('children' in node) {
		return node.children;
	}
	if (node.kind === 'packageReference' || node.kind === 'packageDependency') {
		return node.dependencies ?? [];
	}
	return [];
}

function findParentNode(nodes: readonly CsprojTreeNode[], target: CsprojTreeNode): CsprojTreeNode | undefined {
	const targetId = getNodeId(target);
	for (const node of nodes) {
		const children = getNestedTreeNodes(node);
		if (children.some(child => getNodeId(child) === targetId)) {
			return node;
		}
		const nested = findParentNode(children, target);
		if (nested) {
			return nested;
		}
	}
	return undefined;
}

function parseSlnProjects(content: string): SlnProjectEntry[] {
	const entries: SlnProjectEntry[] = [];
	const projectRegex = /^Project\("\{([^}]+)\}"\)\s*=\s*"([^"]+)",\s*"([^"]+)",\s*"\{([^}]+)\}"/gm;
	let match: RegExpExecArray | null;
	while ((match = projectRegex.exec(content)) !== null) {
		entries.push({
			guid: normalizeGuid(match[4]),
			name: match[2],
			projectPath: match[3].replace(/\\/g, '/'),
			isSolutionFolder: normalizeGuid(match[1]) === SOLUTION_FOLDER_TYPE_GUID,
		});
	}

	const nestedSection = content.match(/GlobalSection\(NestedProjects\)[\s\S]*?EndGlobalSection/);
	if (nestedSection) {
		const nestedRegex = /\{([^}]+)\}\s*=\s*\{([^}]+)\}/g;
		while ((match = nestedRegex.exec(nestedSection[0])) !== null) {
			const child = normalizeGuid(match[1]);
			const parent = normalizeGuid(match[2]);
			const entry = entries.find(item => item.guid === child);
			if (entry) {
				entry.parentGuid = parent;
			}
		}
	}

	return entries;
}

function parseSlnxProjects(content: string): SlnProjectEntry[] {
	const entries: SlnProjectEntry[] = [];
	const folderEntries = new Map<string, SlnProjectEntry>();
	const folderStack: string[] = [];
	const lineRegex = /<\s*(\/?)\s*(Folder|Project)\b([^>]*)>/gi;
	let match: RegExpExecArray | null;

	function ensureFolderPath(folderPath: string): string | undefined {
		const folders = normalizeSolutionFolderPath(folderPath).split('/').filter(Boolean);
		let parentGuid: string | undefined;
		let currentPath = '';
		for (const folder of folders) {
			currentPath = currentPath ? `${currentPath}/${folder}` : folder;
			if (!folderEntries.has(currentPath)) {
				folderEntries.set(currentPath, {
					guid: currentPath,
					name: folder,
					projectPath: folder,
					isSolutionFolder: true,
					parentGuid,
				});
			}
			parentGuid = currentPath;
		}
		return parentGuid;
	}

	while ((match = lineRegex.exec(content)) !== null) {
		const isClosing = match[1] === '/';
		const tagName = match[2];
		const rawAttrs = match[3];
		const attrs = parseAttributes(rawAttrs);
		const isSelfClosing = /\/\s*$/.test(rawAttrs);

		if (tagName === 'Folder') {
			if (isClosing) {
				folderStack.pop();
			} else {
				const folderName = attrs.get('Path') ?? attrs.get('Name');
				if (folderName) {
					const folderPath = normalizeSolutionFolderPath(
						attrs.has('Path') ? folderName : [...folderStack, folderName].join('/')
					);
					ensureFolderPath(folderPath);
					if (!isSelfClosing) {
						folderStack.push(folderPath);
					}
				}
			}
			continue;
		}

		const projectPath = attrs.get('Path') ?? attrs.get('File');
		if (!isClosing && projectPath) {
			const name = pathModule.basename(projectPath, pathModule.extname(projectPath));
			const explicitFolder = attrs.get('Folder') ?? attrs.get('SolutionFolder');
			const parentGuid = explicitFolder
				? ensureFolderPath(explicitFolder)
				: folderStack.length > 0 ? ensureFolderPath(folderStack[folderStack.length - 1]) : undefined;
			entries.push({
				guid: normalizeGuid(`${entries.length}`),
				name,
				projectPath: projectPath.replace(/\\/g, '/'),
				isSolutionFolder: false,
				parentGuid,
			});
		}
	}

	return [...folderEntries.values(), ...entries];
}

function parseAttributes(input: string): Map<string, string> {
	const attrs = new Map<string, string>();
	const attrRegex = /(\w+)\s*=\s*(["'])(.*?)\2/g;
	let match: RegExpExecArray | null;
	while ((match = attrRegex.exec(input)) !== null) {
		attrs.set(match[1], match[3]);
	}
	return attrs;
}

function addSlnFolder(content: string, folderName: string, parentGuid?: string): string {
	const folderGuid = createSlnGuid();
	const folderProject = [
		`Project("{${SOLUTION_FOLDER_TYPE_GUID.toUpperCase()}}") = "${folderName}", "${folderName}", "{${folderGuid}}"`,
		'EndProject',
		'',
	].join('\n');

	const globalIndex = content.indexOf('Global');
	let updated = globalIndex >= 0
		? `${content.slice(0, globalIndex)}${folderProject}${content.slice(globalIndex)}`
		: `${content.trimEnd()}\n${folderProject}`;

	if (!parentGuid) {
		return updated;
	}

	const nestedLine = `\t\t{${folderGuid}} = {${parentGuid.toUpperCase()}}\n`;
	const nestedMatch = updated.match(/GlobalSection\(NestedProjects\)\s*=\s*preSolution[\s\S]*?EndGlobalSection/);
	if (nestedMatch && nestedMatch.index !== undefined) {
		const insertIndex = nestedMatch.index + nestedMatch[0].lastIndexOf('EndGlobalSection');
		return `${updated.slice(0, insertIndex)}${nestedLine}${updated.slice(insertIndex)}`;
	}

	const endGlobalIndex = updated.lastIndexOf('EndGlobal');
	const nestedSection = [
		'\tGlobalSection(NestedProjects) = preSolution',
		nestedLine.trimEnd(),
		'\tEndGlobalSection',
	].join('\n');
	return endGlobalIndex >= 0
		? `${updated.slice(0, endGlobalIndex)}${nestedSection}\n${updated.slice(endGlobalIndex)}`
		: `${updated.trimEnd()}\nGlobal\n${nestedSection}\nEndGlobal\n`;
}

function ensureSlnFolderPath(content: string, folderPath: string | undefined): { content: string; folderGuid?: string } {
	const segments = normalizeSolutionFolderPath(folderPath ?? '').split('/').filter(Boolean);
	if (segments.length === 0) {
		return { content };
	}

	let updated = content;
	let entries = parseSlnProjects(updated);
	let parentGuid: string | undefined;
	let currentPath = '';

	for (const segment of segments) {
		currentPath = currentPath ? `${currentPath}/${segment}` : segment;
		const existing = entries
			.filter(entry => entry.isSolutionFolder)
			.find(entry => getSolutionFolderPath(entry, entries) === currentPath);
		if (existing) {
			parentGuid = existing.guid;
			continue;
		}

		updated = addSlnFolder(updated, segment, parentGuid);
		entries = parseSlnProjects(updated);
		parentGuid = entries
			.filter(entry => entry.isSolutionFolder)
			.find(entry => getSolutionFolderPath(entry, entries) === currentPath)?.guid;
	}

	return { content: updated, folderGuid: parentGuid };
}

function removeSlnFolder(content: string, folderGuid: string): string {
	const guid = folderGuid.toUpperCase();
	const entries = parseSlnProjects(content);
	const removedGuids = new Set<string>([guid]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const entry of entries) {
			if (entry.parentGuid && removedGuids.has(entry.parentGuid.toUpperCase()) && !removedGuids.has(entry.guid.toUpperCase())) {
				removedGuids.add(entry.guid.toUpperCase());
				changed = true;
			}
		}
	}

	const folderProjectRegex = new RegExp(
		'Project\\("\\{[^}]+\\}"\\)\\s*=\\s*"[^"]+",\\s*"[^"]+",\\s*"\\{([^}]+)\\}"\\r?\\nEndProject\\r?\\n?',
		'g'
	);
	let updated = content.replace(folderProjectRegex, (block, entryGuid: string) =>
		removedGuids.has(entryGuid.toUpperCase()) ? '' : block
	);

	updated = updated.replace(
		/GlobalSection\(NestedProjects\)\s*=\s*preSolution([\s\S]*?)EndGlobalSection/g,
		(_section, body: string) => {
			const rewrittenLines = body.split(/\r?\n/).filter(line => {
				const match = line.match(/\{([^}]+)\}\s*=\s*\{([^}]+)\}/);
				return !match
					|| (!removedGuids.has(match[1].toUpperCase()) && !removedGuids.has(match[2].toUpperCase()));
			});
			const meaningfulLines = rewrittenLines.filter(line => line.trim().length > 0);
			if (meaningfulLines.length === 0) {
				return '';
			}
			return `GlobalSection(NestedProjects) = preSolution${rewrittenLines.join('\n')}EndGlobalSection`;
		}
	);

	return updated;
}

function removeSlnProject(content: string, projectPath: string): string {
	const normalizedProjectPath = normalizeSolutionFolderPath(projectPath);
	const projectRegex = /^Project\("\{[^}]+\}"\)\s*=\s*"[^"]+",\s*"([^"]+)",\s*"\{([^}]+)\}"\r?\nEndProject\r?\n?/gm;
	let projectGuid: string | undefined;
	let updated = content.replace(projectRegex, (block, candidatePath: string, guid: string) => {
		if (normalizeSolutionFolderPath(candidatePath) !== normalizedProjectPath) {
			return block;
		}
		projectGuid = guid.toUpperCase();
		return '';
	});

	if (projectGuid) {
		updated = updated.replace(
			/GlobalSection\(NestedProjects\)\s*=\s*preSolution([\s\S]*?)EndGlobalSection/g,
			(_section, body: string) => {
				const lines = body.split(/\r?\n/).filter(line => !line.toUpperCase().includes(`{${projectGuid}}`));
				const meaningfulLines = lines.filter(line => line.trim().length > 0);
				return meaningfulLines.length > 0
					? `GlobalSection(NestedProjects) = preSolution${lines.join('\n')}EndGlobalSection`
					: '';
			}
		);
	}

	return updated;
}

function moveSlnProject(content: string, oldProjectPath: string, newProjectPath: string, folderGuid?: string): string {
	const withUpdatedPath = rewriteSlnProjectPath(content, oldProjectPath, newProjectPath);
	return moveSlnProjectToFolderOrRoot(withUpdatedPath, newProjectPath, folderGuid);
}

function rewriteSlnProjectPath(content: string, oldProjectPath: string, newProjectPath: string): string {
	const normalizedOldProjectPath = normalizeSolutionFolderPath(oldProjectPath);
	const projectRegex = /^(Project\("\{[^}]+\}"\)\s*=\s*"[^"]+",\s*")([^"]+)(",\s*"\{[^}]+\}")/gm;
	return content.replace(projectRegex, (line, prefix: string, candidatePath: string, suffix: string) => {
		if (normalizeSolutionFolderPath(candidatePath) !== normalizedOldProjectPath) {
			return line;
		}
		return `${prefix}${newProjectPath}${suffix}`;
	});
}

function moveSlnProjectToFolderOrRoot(content: string, projectPath: string, folderGuid?: string): string {
	const normalizedProjectPath = normalizeSolutionFolderPath(projectPath);
	const entries = parseSlnProjects(content);
	const project = entries.find(entry => !entry.isSolutionFolder && normalizeSolutionFolderPath(entry.projectPath) === normalizedProjectPath);
	if (!project) {
		return content;
	}

	return folderGuid
		? upsertNestedProject(content, project.guid, folderGuid)
		: removeNestedProject(content, project.guid);
}

function moveSlnProjectToFolder(content: string, projectPath: string, folderGuid: string): string {
	const normalizedProjectPath = normalizeSolutionFolderPath(projectPath);
	const entries = parseSlnProjects(content);
	const project = entries.find(entry => !entry.isSolutionFolder && normalizeSolutionFolderPath(entry.projectPath) === normalizedProjectPath);
	if (!project) {
		return content;
	}

	return upsertNestedProject(content, project.guid, folderGuid);
}

function removeNestedProject(content: string, childGuid: string): string {
	return content.replace(
		/GlobalSection\(NestedProjects\)\s*=\s*preSolution([\s\S]*?)EndGlobalSection/g,
		(_section, body: string) => {
			const childGuidUpper = childGuid.toUpperCase();
			const lines = body.split(/\r?\n/).filter(line => !line.toUpperCase().includes(`{${childGuidUpper}}`));
			const meaningfulLines = lines.filter(line => line.trim().length > 0);
			return meaningfulLines.length > 0
				? `GlobalSection(NestedProjects) = preSolution${lines.join('\n')}EndGlobalSection`
				: '';
		}
	);
}

function upsertNestedProject(content: string, childGuid: string, parentGuid: string): string {
	const nestedSectionRegex = /GlobalSection\(NestedProjects\)\s*=\s*preSolution[\s\S]*?EndGlobalSection/;
	const nestedSection = content.match(nestedSectionRegex);
	if (nestedSection?.index !== undefined) {
		const section = nestedSection[0];
		const lineEnding = section.includes('\r\n') ? '\r\n' : '\n';
		const mappingIndent = section.match(/^[ \t]*(?=\{[^}\r\n]+\}\s*=\s*\{[^}\r\n]+\})/m)?.[0] ?? '\t\t';
		const childMappingRegex = new RegExp(
			`^[ \\t]*\\{${escapeRegExp(childGuid)}\\}\\s*=\\s*\\{[^}]+\\}[ \\t]*(?:\\r?\\n|$)`,
			'gmi',
		);
		const withoutChildMapping = section.replace(childMappingRegex, '');
		const endMarker = 'EndGlobalSection';
		const endIndex = withoutChildMapping.lastIndexOf(endMarker);
		if (endIndex < 0) {
			return content;
		}

		const beforeEnd = withoutChildMapping.slice(0, endIndex);
		const separator = beforeEnd.endsWith('\n') ? '' : lineEnding;
		const nestedLine = `${mappingIndent}{${childGuid.toUpperCase()}} = {${parentGuid.toUpperCase()}}`;
		const updatedSection = `${beforeEnd}${separator}${nestedLine}${lineEnding}${withoutChildMapping.slice(endIndex)}`;
		return `${content.slice(0, nestedSection.index)}${updatedSection}${content.slice(nestedSection.index + section.length)}`;
	}

	const nestedLine = `\t\t{${childGuid.toUpperCase()}} = {${parentGuid.toUpperCase()}}`;
	const endGlobalIndex = content.lastIndexOf('EndGlobal');
	const section = [
		'\tGlobalSection(NestedProjects) = preSolution',
		nestedLine.trimEnd(),
		'\tEndGlobalSection',
	].join('\n');
	return endGlobalIndex >= 0
		? `${content.slice(0, endGlobalIndex)}${section}\n${content.slice(endGlobalIndex)}`
		: `${content.trimEnd()}\nGlobal\n${section}\nEndGlobal\n`;
}

function addSlnxFolder(content: string, folderName: string, parentPath?: string): string {
	let solutionFolderPath = folderName;
	if (parentPath) {
		const entries = parseSlnxProjects(content);
		const parent = entries.find(entry => entry.isSolutionFolder && entry.guid === parentPath);
		if (parent) {
			solutionFolderPath = `${getSolutionFolderPath(parent, entries)}/${folderName}`;
		}
	}

	const folderXml = `  <Folder Name="/${escapeXml(solutionFolderPath)}/" />\n`;
	const solutionCloseIndex = content.lastIndexOf('</Solution>');
	return solutionCloseIndex >= 0
		? `${content.slice(0, solutionCloseIndex)}${folderXml}${content.slice(solutionCloseIndex)}`
		: `${content.trimEnd()}\n${folderXml}\n`;
}

function ensureSlnxFolderPath(content: string, folderPath: string | undefined): { content: string; folderPath?: string } {
	const segments = normalizeSolutionFolderPath(folderPath ?? '').split('/').filter(Boolean);
	if (segments.length === 0) {
		return { content };
	}

	let updated = content;
	let currentPath = '';
	for (const segment of segments) {
		currentPath = currentPath ? `${currentPath}/${segment}` : segment;
		if (findSlnxFolderStart(updated, currentPath)) {
			continue;
		}
		updated = addSlnxFolder(updated, currentPath);
	}

	return { content: updated, folderPath: currentPath };
}

function addSlnxProject(content: string, relativeProjectPath: string, targetFolderPath?: string): string {
	if (content.includes(`Path="${relativeProjectPath}"`)) {
		return content;
	}

	const projectXml = `  <Project Path="${escapeXml(relativeProjectPath)}" />\n`;
	if (targetFolderPath) {
		const inserted = insertProjectIntoSlnxFolder(content, targetFolderPath, projectXml);
		if (inserted !== content) {
			return inserted;
		}
	}

	const solutionCloseIndex = content.lastIndexOf('</Solution>');
	return solutionCloseIndex >= 0
		? `${content.slice(0, solutionCloseIndex)}${projectXml}${content.slice(solutionCloseIndex)}`
		: `${content.trimEnd()}\n${projectXml}`;
}

function moveSlnxProject(content: string, oldProjectPath: string, newProjectPath: string, targetFolderPath?: string): string {
	const withoutProject = removeSlnxProject(content, oldProjectPath);
	return addSlnxProject(withoutProject, newProjectPath, targetFolderPath);
}

function insertProjectIntoSlnxFolder(content: string, targetFolderPath: string, projectXml: string): string {
	const folderStart = findSlnxFolderStart(content, targetFolderPath);
	if (!folderStart) {
		return content;
	}

	const folderIndent = getLineIndent(content, folderStart.index);
	const projectIndent = `${folderIndent}  `;
	const projectLine = projectXml.trim();
	const indentedProjectXml = `${projectIndent}${projectLine}\n`;

	if (folderStart.isSelfClosing) {
		const openTag = content.slice(folderStart.index, folderStart.end).replace(/\s*\/>$/, '>');
		const replacement = `${openTag.trim()}\n${indentedProjectXml}${folderIndent}</Folder>`;
		return `${content.slice(0, folderStart.index)}${replacement}${content.slice(folderStart.end)}`;
	}

	const close = findClosingSlnxFolder(content, folderStart.index);
	if (!close) {
		return content;
	}

	const closeLineStart = content.lastIndexOf('\n', close.index - 1) + 1;
	return `${content.slice(0, closeLineStart)}${indentedProjectXml}${folderIndent}${content.slice(close.index)}`;
}

function removeSlnxProject(content: string, projectPath: string): string {
	const normalizedProjectPath = normalizeSolutionFolderPath(projectPath);
	const projectRegex = /^\s*<Project\b[^>]*Path="([^"]+)"[^>]*\/>\r?\n?/gmi;
	return content.replace(projectRegex, (line, candidatePath: string) => {
		return normalizeSolutionFolderPath(candidatePath) === normalizedProjectPath ? '' : line;
	});
}

function removeSlnxFolder(content: string, folderPath: string): string {
	const normalizedFolderPath = normalizeSolutionFolderPath(folderPath);
	if (!normalizedFolderPath) {
		return content;
	}

	const folderRegex = /<\s*(\/?)\s*Folder\b([^>]*?)(\/?)>/gi;
	const folderStack: Array<{ path: string; start: number }> = [];
	const removals: Array<{ start: number; end: number }> = [];
	let match: RegExpExecArray | null;

	while ((match = folderRegex.exec(content)) !== null) {
		const isClosing = match[1] === '/';
		if (isClosing) {
			const folder = folderStack.pop();
			if (folder && isSolutionFolderDescendant(folder.path, normalizedFolderPath)) {
				removals.push({ start: folder.start, end: findLineEnd(content, match.index + match[0].length) });
			}
			continue;
		}

		const attrs = parseAttributes(match[2]);
		const value = attrs.get('Path') ?? attrs.get('Name');
		if (!value) {
			continue;
		}
		const isSelfClosing = match[3] === '/' || /\/\s*$/.test(match[2]);
		const folderPath = normalizeSolutionFolderPath(
			attrs.has('Path') ? value : [...folderStack.map(folder => folder.path), value].join('/')
		);
		if (isSelfClosing) {
			if (isSolutionFolderDescendant(folderPath, normalizedFolderPath)) {
				const lineStart = content.lastIndexOf('\n', match.index - 1) + 1;
				removals.push({ start: lineStart, end: findLineEnd(content, match.index + match[0].length) });
			}
			continue;
		}

		folderStack.push({ path: folderPath, start: content.lastIndexOf('\n', match.index - 1) + 1 });
	}

	if (removals.length > 0) {
		const distinctRemovals = removals
			.filter((removal, index, all) => all.findIndex(candidate => candidate.start === removal.start && candidate.end === removal.end) === index)
			.filter((removal, _, all) => !all.some(candidate => candidate !== removal && candidate.start <= removal.start && candidate.end >= removal.end));
		return removeExtraBlankLines(distinctRemovals
			.sort((a, b) => b.start - a.start)
			.reduce((updated, removal) => `${updated.slice(0, removal.start)}${updated.slice(removal.end)}`, content));
	}

	const folderStart = findSlnxFolderStart(content, normalizedFolderPath);
	if (!folderStart) {
		return content;
	}

	const lineStart = content.lastIndexOf('\n', folderStart.index - 1) + 1;
	if (folderStart.isSelfClosing) {
		const lineEnd = findLineEnd(content, folderStart.end);
		return `${content.slice(0, lineStart)}${content.slice(lineEnd)}`;
	}

	const close = findClosingSlnxFolder(content, folderStart.index);
	if (!close) {
		return content;
	}

	const innerContent = content.slice(folderStart.end, close.index);
	const closeLineEnd = findLineEnd(content, close.end);
	if (innerContent.trim().length === 0) {
		return `${content.slice(0, lineStart)}${content.slice(closeLineEnd)}`;
	}
	return removeExtraBlankLines(`${content.slice(0, lineStart)}${innerContent}${content.slice(closeLineEnd)}`);
}

function isSolutionFolderDescendant(folderPath: string, parentPath: string): boolean {
	return folderPath === parentPath || folderPath.startsWith(`${parentPath}/`);
}

function findSlnxFolderStart(content: string, normalizedFolderPath: string): { index: number; end: number; isSelfClosing: boolean } | undefined {
	const folderStack: string[] = [];
	const folderRegex = /<\s*(\/?)\s*Folder\b([^>]*?)(\/?)>/gi;
	let match: RegExpExecArray | null;
	while ((match = folderRegex.exec(content)) !== null) {
		const isClosing = match[1] === '/';
		const attrs = parseAttributes(match[2]);
		const isSelfClosing = match[3] === '/' || /\/\s*$/.test(match[2]);
		if (isClosing) {
			folderStack.pop();
			continue;
		}

		const value = attrs.get('Path') ?? attrs.get('Name');
		if (!value) {
			continue;
		}

		const folderPath = normalizeSolutionFolderPath(
			attrs.has('Path') ? value : [...folderStack, value].join('/')
		);
		if (folderPath === normalizedFolderPath) {
			return {
				index: match.index,
				end: match.index + match[0].length,
				isSelfClosing,
			};
		}

		if (!isSelfClosing) {
			folderStack.push(folderPath);
		}
	}
	return undefined;
}

function findClosingSlnxFolder(content: string, openIndex: number): { index: number; end: number } | undefined {
	const tagRegex = /<\s*(\/?)\s*Folder\b[^>]*(\/?)>/gi;
	tagRegex.lastIndex = openIndex;
	let depth = 0;
	let match: RegExpExecArray | null;
	while ((match = tagRegex.exec(content)) !== null) {
		const isClosing = match[1] === '/';
		const isSelfClosing = match[2] === '/';
		if (!isClosing && !isSelfClosing) {
			depth++;
		} else if (isClosing) {
			depth--;
			if (depth === 0) {
				return {
					index: match.index,
					end: match.index + match[0].length,
				};
			}
		}
	}
	return undefined;
}

function findLineEnd(content: string, start: number): number {
	const newlineIndex = content.indexOf('\n', start);
	return newlineIndex >= 0 ? newlineIndex + 1 : content.length;
}

function sortTree(nodes: CsprojTreeNode[]): void {
	nodes.sort((a, b) => {
		if (a.kind !== b.kind) {
			return getTreeSortRank(a) - getTreeSortRank(b);
		}
		return a.label.localeCompare(b.label);
	});

	for (const node of nodes) {
		const children = getNestedTreeNodes(node);
		if (children.length > 0) {
			sortTree(children);
		}
	}
}

function getTreeSortRank(node: CsprojTreeNode): number {
	switch (node.kind) {
		case 'vulnerablePackages':
			return 0;
		case 'folder':
			return 1;
		case 'project':
			return 2;
		case 'excludedProjects':
			return 3;
		default:
			return 4;
	}
}

function compareVulnerabilitySeverity(a: string, b: string): number {
	return vulnerabilitySeverityRank(a) - vulnerabilitySeverityRank(b);
}

function isCriticalVulnerability(severity: string): boolean {
	return severity.toLowerCase() === 'critical';
}

function vulnerabilitySeverityRank(severity: string): number {
	switch (severity.toLowerCase()) {
		case 'critical':
			return 4;
		case 'high':
			return 3;
		case 'moderate':
		case 'medium':
			return 2;
		case 'low':
			return 1;
		default:
			return 0;
	}
}

function getProjectSolutionFolderPath(relativeProjectPath: string): string | undefined {
	if (pathModule.isAbsolute(relativeProjectPath)) {
		return undefined;
	}

	const rawSegments = relativeProjectPath.replace(/\\/g, '/').split('/').filter(Boolean);
	if (rawSegments.some(segment => segment === '..')) {
		return undefined;
	}

	const projectDir = normalizeSolutionFolderPath(pathModule.dirname(relativeProjectPath));
	const projectName = pathModule.basename(relativeProjectPath, pathModule.extname(relativeProjectPath));
	const segments = projectDir.split('/').filter(Boolean);
	if (segments.length === 0) {
		return undefined;
	}

	if (segments[segments.length - 1] === projectName) {
		segments.pop();
	}

	return segments.length > 0 ? segments.join('/') : undefined;
}

function getSolutionFolderPath(folder: SlnProjectEntry, entries: SlnProjectEntry[]): string {
	const foldersByGuid = new Map(entries
		.filter(entry => entry.isSolutionFolder)
		.map(entry => [entry.guid, entry]));
	const segments = [folder.name];
	let parentGuid = folder.parentGuid;
	while (parentGuid) {
		const parent = foldersByGuid.get(parentGuid);
		if (!parent) {
			break;
		}
		segments.unshift(parent.name);
		parentGuid = parent.parentGuid;
	}
	return normalizeSolutionFolderPath(segments.join('/'));
}

/**
 * Returns true if adding the edge source → target would introduce a cycle
 * in the project reference graph.
 *
 * Performs a BFS from `targetProjectFsPath` following existing project references.
 * If `sourceProjectFsPath` is reachable from `targetProjectFsPath`, then the new
 * edge would close a cycle (target already depends on source).
 */
async function wouldCreateCyclicReference(
	sourceProjectFsPath: string,
	targetProjectFsPath: string
): Promise<boolean> {
	const normalizedSource = normalizePath(sourceProjectFsPath);
	const visited = new Set<string>();
	const queue: string[] = [normalizePath(targetProjectFsPath)];

	while (queue.length > 0) {
		const current = queue.shift()!;
		if (current === normalizedSource) {
			return true;
		}
		if (visited.has(current)) {
			continue;
		}
		visited.add(current);

		try {
			const content = await readUtf8(vscode.Uri.file(current));
			const dir = pathModule.dirname(current);
			for (const ref of parseProjectReferences(content)) {
				const normalized = ref.replace(/\\/g, '/');
				const absolute = normalizePath(
					pathModule.isAbsolute(normalized)
						? normalized
						: pathModule.resolve(dir, normalized)
				);
				if (!visited.has(absolute)) {
					queue.push(absolute);
				}
			}
		} catch {
			// Unreadable .csproj — skip and continue traversal
		}
	}

	return false;
}

function parseProjectReferences(content: string): string[] {
	const references: string[] = [];
	const regex = /<ProjectReference\b[^>]*Include="([^"]+)"[^>]*\/?>/gi;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(content)) !== null) {
		references.push(match[1]);
	}
	return references;
}

function projectReferenceExists(content: string, sourceProjectDir: string, targetProjectPath: string): boolean {
	const normalizedTargetProjectPath = normalizePath(targetProjectPath);
	return parseProjectReferences(content).some(referencePath => {
		const normalizedReferencePath = referencePath.replace(/\\/g, '/');
		const absoluteReferencePath = pathModule.isAbsolute(referencePath)
			? normalizedReferencePath
			: pathModule.resolve(sourceProjectDir, normalizedReferencePath);
		return normalizePath(absoluteReferencePath) === normalizedTargetProjectPath;
	});
}

function rewriteProjectReferencesForMovedProject(content: string, oldProjectDir: string, newProjectDir: string): string {
	return rewriteProjectReferenceIncludes(content, includePath => {
		const absoluteReferencePath = resolveProjectReferencePath(oldProjectDir, includePath);
		return pathModule.relative(newProjectDir, absoluteReferencePath).replace(/\\/g, '/');
	});
}

function rewriteProjectReferencesToMovedProject(content: string, sourceProjectDir: string, oldProjectPath: string, newProjectPath: string): string {
	const normalizedOldProjectPath = normalizePath(oldProjectPath);
	return rewriteProjectReferenceIncludes(content, includePath => {
		const absoluteReferencePath = resolveProjectReferencePath(sourceProjectDir, includePath);
		if (normalizePath(absoluteReferencePath) !== normalizedOldProjectPath) {
			return includePath;
		}
		return pathModule.relative(sourceProjectDir, newProjectPath).replace(/\\/g, '/');
	});
}

function rewriteProjectReferenceIncludes(content: string, rewrite: (includePath: string) => string): string {
	return content.replace(
		/(<ProjectReference\b[^>]*Include=")([^"]+)("[^>]*\/?>)/gi,
		(_match, prefix: string, includePath: string, suffix: string) => `${prefix}${escapeXml(rewrite(includePath))}${suffix}`
	);
}

function resolveProjectReferencePath(sourceProjectDir: string, referencePath: string): string {
	const normalizedReferencePath = referencePath.replace(/\\/g, '/');
	return pathModule.isAbsolute(normalizedReferencePath)
		? normalizedReferencePath
		: pathModule.resolve(sourceProjectDir, normalizedReferencePath);
}

function getProjectReferenceDisplayName(referencePath: string): string {
	const normalizedPath = referencePath.replace(/\\/g, '/');
	const fileName = normalizedPath.split('/').filter(Boolean).pop() ?? normalizedPath;
	return fileName.replace(/\.csproj$/i, '');
}

function formatLanguageVersion(version: string | undefined): string | undefined {
	if (!version) {
		return undefined;
	}

	return /^c#/i.test(version) ? version : `C# ${version}`;
}

export function parsePackageReferences(content: string): { name: string; version?: string }[] {
	const packages: { name: string; version?: string }[] = [];
	const regex = /<PackageReference\b([^>]*?)\/>|<PackageReference\b([^>]*?)>([\s\S]*?)<\/PackageReference>/gi;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(content)) !== null) {
		const attrs = parseAttributes(match[1] ?? match[2]);
		const name = attrs.get('Include') ?? attrs.get('Update');
		if (name) {
			const childVersion = match[3]?.match(/<Version>([^<]+)<\/Version>/i)?.[1]?.trim();
			packages.push({ name, version: attrs.get('Version') ?? childVersion });
		}
	}
	return packages;
}

export function addPackageReferenceToCsproj(content: string, packageId: string, version?: string): string {
	const versionAttribute = version ? ` Version="${escapeXml(version)}"` : '';
	const referenceXml = `  <ItemGroup>\n    <PackageReference Include="${escapeXml(packageId)}"${versionAttribute} />\n  </ItemGroup>\n`;
	const projectCloseIndex = content.lastIndexOf('</Project>');
	return projectCloseIndex >= 0
		? `${content.slice(0, projectCloseIndex)}${referenceXml}${content.slice(projectCloseIndex)}`
		: `${content.trimEnd()}\n${referenceXml}`;
}

function parsePackageVersions(content: string): { name: string; version: string }[] {
	const packages: { name: string; version: string }[] = [];
	const regex = /<PackageVersion\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageVersion>)/gi;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(content)) !== null) {
		const attributes = parseAttributes(match[1]);
		const name = attributes.get('Include') ?? attributes.get('Update');
		const version = attributes.get('Version') ?? match[2]?.match(/<Version>\s*([^<]+?)\s*<\/Version>/i)?.[1]?.trim();
		if (name && version) {
			packages.push({ name, version });
		}
	}
	return packages;
}

export function getCentralPackageVersion(content: string, packageId: string): string | undefined {
	const escapedId = escapeRegExp(packageId);
	const regex = new RegExp(`<PackageVersion\\b([^>]*\\b(?:Include|Update)=(['"])${escapedId}\\2[^>]*)>([\\s\\S]*?)<\\/PackageVersion>|<PackageVersion\\b([^>]*\\b(?:Include|Update)=(['"])${escapedId}\\5[^>]*)\\/>`, 'i');
	const match = content.match(regex);
	if (!match) {
		return undefined;
	}

	const attributes = match[1] ?? match[4] ?? '';
	const attributeVersion = attributes.match(/\bVersion\s*=\s*(['"])(.*?)\1/i)?.[2]?.trim();
	if (attributeVersion) {
		return attributeVersion;
	}

	return match[3]?.match(/<Version>\s*([^<]+?)\s*<\/Version>/i)?.[1]?.trim();
}

export function addPackageVersionToProps(content: string, packageId: string, version: string): string {
	const packageVersionXml = `    <PackageVersion Include="${escapeXml(packageId)}" Version="${escapeXml(version)}" />\n`;
	const itemGroupMatch = content.match(/<ItemGroup(?:\s[^>]*)?>[\s\S]*?<\/ItemGroup>/i);
	if (itemGroupMatch && itemGroupMatch.index !== undefined) {
		const closeIndex = content.indexOf('</ItemGroup>', itemGroupMatch.index);
		return `${content.slice(0, closeIndex)}${packageVersionXml}${content.slice(closeIndex)}`;
	}

	const projectCloseIndex = content.lastIndexOf('</Project>');
	const itemGroupXml = `  <ItemGroup>\n${packageVersionXml}  </ItemGroup>\n`;
	return projectCloseIndex >= 0
		? `${content.slice(0, projectCloseIndex)}${itemGroupXml}${content.slice(projectCloseIndex)}`
		: `${content.trimEnd()}\n${itemGroupXml}`;
}

export function removePackageVersionFromProps(content: string, packageId: string): string {
	const escapedId = escapeRegExp(packageId);
	const packageVersionRegex = new RegExp(
		`^[ \t]*<PackageVersion\\b[^>]*\\b(?:Include|Update)=(['"])${escapedId}\\1[^>]*/>[ \t]*\\r?\\n?` +
		`|^[ \t]*<PackageVersion\\b[^>]*\\b(?:Include|Update)=(['"])${escapedId}\\2[^>]*>[\\s\\S]*?<\\/PackageVersion>[ \t]*\\r?\\n?`,
		'gmi',
	);
	return content.replace(packageVersionRegex, '');
}

function removePackageReferenceFromCsproj(content: string, packageId: string): string {
	const escapedId = escapeRegExp(packageId);
	// Self-closing: <PackageReference Include="Id" ... />
	let updated = content.replace(
		new RegExp(`^[ \t]*<PackageReference\\b[^>]*\\b(?:Include|Update)=(["'])${escapedId}\\1[^>]*/>[ \t]*\\r?\\n?`, 'gmi'),
		''
	);
	// Multi-line: <PackageReference Include="Id">...</PackageReference>
	updated = updated.replace(
		new RegExp(`^[ \t]*<PackageReference\\b[^>]*\\b(?:Include|Update)=(["'])${escapedId}\\1[^>]*>[\\s\\S]*?</PackageReference>[ \t]*\\r?\\n?`, 'gmi'),
		''
	);
	updated = updated.replace(/<ItemGroup>\s*<\/ItemGroup>\r?\n?/g, '');
	return removeExtraBlankLines(updated);
}

async function updatePackageVersionForProject(csprojUri: vscode.Uri, packageId: string, newVersion: string): Promise<boolean> {
	const content = await readUtf8(csprojUri);
	if (!hasLocalPackageReferenceVersion(content, packageId)) {
		const centralPackageVersionsUri = await findCentralPackageVersionsFile(pathModule.dirname(csprojUri.fsPath));
		if (centralPackageVersionsUri) {
			const centralContent = await readUtf8(centralPackageVersionsUri);
			const updatedCentralContent = updatePackageVersionInProps(centralContent, packageId, newVersion);
			if (updatedCentralContent !== centralContent) {
				await vscode.workspace.fs.writeFile(centralPackageVersionsUri, Buffer.from(updatedCentralContent, 'utf-8'));
				return true;
			}
		}
	}

	const updated = updatePackageReferenceVersionInCsproj(content, packageId, newVersion);
	if (updated === content) {
		return false;
	}

	await vscode.workspace.fs.writeFile(csprojUri, Buffer.from(updated, 'utf-8'));
	return true;
}

async function findCentralPackageVersionsFile(startDir: string): Promise<vscode.Uri | undefined> {
	let dir = startDir;
	const visited = new Set<string>();
	while (dir && !visited.has(dir)) {
		visited.add(dir);
		const uri = vscode.Uri.file(pathModule.join(dir, 'Directory.Packages.props'));
		try {
			await vscode.workspace.fs.stat(uri);
			return uri;
		} catch {
			// Walk up to the next parent.
		}

		const parent = pathModule.dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	return undefined;
}

function hasLocalPackageReferenceVersion(content: string, packageId: string): boolean {
	const regex = /<PackageReference\b([^>]*?)\/>|<PackageReference\b([^>]*?)>([\s\S]*?)<\/PackageReference>/gi;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(content)) !== null) {
		const attrs = parseAttributes(match[1] ?? match[2]);
		const name = attrs.get('Include') ?? attrs.get('Update');
		if (name?.toLowerCase() === packageId.toLowerCase()) {
			return Boolean(attrs.get('Version') ?? match[3]?.match(/<Version>([^<]+)<\/Version>/i)?.[1]?.trim());
		}
	}
	return false;
}

function updatePackageVersionInProps(content: string, packageId: string, newVersion: string): string {
	const escapedId = escapeRegExp(packageId);
	const selfClosingRegex = new RegExp(`<PackageVersion\\b([^>]*\\b(?:Include|Update)=(['"])${escapedId}\\2[^>]*)\\/>`, 'i');
	let match = content.match(selfClosingRegex);
	if (match) {
		const originalTag = match[0];
		const updatedTag = /\bVersion\s*=\s*(['"])[^'"]*\1/i.test(originalTag)
			? originalTag.replace(/\bVersion\s*=\s*(['"])[^'"]*\1/i, (_versionAttr, quote: string) => `Version=${quote}${escapeXml(newVersion)}${quote}`)
			: originalTag.replace(/\s*\/>$/, ` Version="${escapeXml(newVersion)}" />`);
		const index = match.index ?? 0;
		return content.slice(0, index) + updatedTag + content.slice(index + originalTag.length);
	}

	const pairedRegex = new RegExp(`<PackageVersion\\b([^>]*\\b(?:Include|Update)=(['"])${escapedId}\\2[^>]*)>([\\s\\S]*?)<\\/PackageVersion>`, 'i');
	match = content.match(pairedRegex);
	if (!match) {
		return content;
	}

	const originalTag = match[0];
	const body = match[3];
	const updatedBody = /<Version>[^<]*<\/Version>/i.test(body)
		? body.replace(/<Version>[^<]*<\/Version>/i, `<Version>${escapeXml(newVersion)}</Version>`)
		: `${body}\n    <Version>${escapeXml(newVersion)}</Version>`;
	const updatedTag = originalTag.replace(body, updatedBody);
	const index = match.index ?? 0;
	return content.slice(0, index) + updatedTag + content.slice(index + originalTag.length);
}

/**
 * Replaces an existing `<PackageReference Include="packageId" ...>` version with `newVersion`,
 * supporting both `Version="..."` attributes and nested `<Version>...</Version>` elements.
 * Returns `content` unchanged if the package reference can't be found.
 */
export function updatePackageReferenceVersionInCsproj(content: string, packageId: string, newVersion: string): string {
	const escapedId = escapeRegExp(packageId);
	const pairedRegex = new RegExp(`<PackageReference\\b[^>]*\\b(?:Include|Update)=(["'])${escapedId}\\1[^>]*>([\\s\\S]*?)<\\/PackageReference>`, 'i');
	let match = content.match(pairedRegex);
	if (match) {
		const originalElement = match[0];
		const body = match[2];
		const updatedElement = /<Version>[^<]*<\/Version>/i.test(body)
			? originalElement.replace(/<Version>[^<]*<\/Version>/i, `<Version>${escapeXml(newVersion)}</Version>`)
			: updatePackageReferenceOpeningTag(originalElement, newVersion);
		const index = match.index ?? 0;
		return content.slice(0, index) + updatedElement + content.slice(index + originalElement.length);
	}

	const tagRegex = new RegExp(`<PackageReference\\b[^>]*\\b(?:Include|Update)=(["'])${escapedId}\\1[^>]*/>`, 'i');
	match = content.match(tagRegex);
	if (!match) {
		return content;
	}

	const originalTag = match[0];
	const updatedTag = updatePackageReferenceOpeningTag(originalTag, newVersion);
	const index = match.index ?? 0;
	return content.slice(0, index) + updatedTag + content.slice(index + originalTag.length);
}

function updatePackageReferenceOpeningTag(originalTag: string, newVersion: string): string {
	const updatedTag = /\bVersion\s*=\s*(["'])[^"']*\1/i.test(originalTag)
		? originalTag.replace(/\bVersion\s*=\s*(["'])[^"']*\1/i, (_versionAttr, quote: string) => `Version=${quote}${escapeXml(newVersion)}${quote}`)
		: originalTag.replace(/\b(Include|Update)\s*=\s*(["'])[^"']*\2/i, includeAttr => `${includeAttr} Version="${escapeXml(newVersion)}"`);
	return updatedTag;
}

function addProjectReferenceToCsproj(content: string, relativePath: string): string {
	const referenceXml = `  <ItemGroup>\n    <ProjectReference Include="${escapeXml(relativePath)}" />\n  </ItemGroup>\n`;
	const projectCloseIndex = content.lastIndexOf('</Project>');
	return projectCloseIndex >= 0
		? `${content.slice(0, projectCloseIndex)}${referenceXml}${content.slice(projectCloseIndex)}`
		: `${content.trimEnd()}\n${referenceXml}`;
}

function removeProjectReferenceFromCsproj(content: string, relativePath: string): string {
	const normalizedReferencePath = normalizeSolutionFolderPath(relativePath);
	const referenceRegex = /^\s*<ProjectReference\b[^>]*Include="([^"]+)"[^>]*\/>\r?\n?/gmi;
	let updated = content.replace(referenceRegex, (line, includePath: string) => {
		return normalizeSolutionFolderPath(includePath) === normalizedReferencePath ? '' : line;
	});
	updated = updated.replace(/<ItemGroup>\s*<\/ItemGroup>\r?\n?/g, '');
	return removeExtraBlankLines(updated);
}

function removeExtraBlankLines(content: string): string {
	return content.replace(/\n{3,}/g, '\n\n');
}

function getLineIndent(content: string, index: number): string {
	const lineStart = content.lastIndexOf('\n', index - 1) + 1;
	const linePrefix = content.slice(lineStart, index);
	return linePrefix.match(/^\s*/)?.[0] ?? '';
}

function getNodeId(node: CsprojTreeNode): string {
	if (node.kind === 'solution') {
		return node.solutionUri.toString();
	}
	if (node.kind === 'project') {
		return node.csprojUri.toString();
	}
	if (node.kind === 'referenceGroup' || node.kind === 'packageGroup') {
		return `${node.kind}:${node.project.csprojUri.toString()}`;
	}
	if (node.kind === 'centralPackageGroup') {
		return `${node.kind}:${node.centralPropsUri.toString()}`;
	}
	if ('children' in node) {
		return `${node.kind}:${node.label}:${node.children.map(getNodeId).join('|')}`;
	}
	if (node.kind === 'projectReference') {
		return `projectReference:${node.referencePath}`;
	}
	if (node.kind === 'excludedProject') {
		return `excludedProject:${node.csprojUri.toString()}`;
	}
	if (node.kind === 'packageReference') {
		return `packageReference:${node.project.csprojUri.toString()}:${node.label}:${node.version ?? ''}`;
	}
	if (node.kind === 'centralPackageReference') {
		return `centralPackageReference:${node.centralPropsUri.toString()}:${node.label}:${node.version}`;
	}
	if (node.kind === 'packageDependency') {
		return `packageDependency:${node.project.csprojUri.toString()}:${node.parentPackageId}:${node.label}:${node.version ?? ''}`;
	}
	if (node.kind === 'vulnerablePackage') {
		return `vulnerablePackage:${node.label}:${node.version ?? ''}:${node.severity}:${node.advisoryUrl ?? ''}`;
	}
	// exhaustive — TypeScript will error here if a new kind is added without handling
	const _exhaustive: never = node;
	return String(_exhaustive);
}

function parseDraggedProjects(raw: string): ProjectNode[] {
	try {
		const value = JSON.parse(raw);
		if (!Array.isArray(value)) {
			return [];
		}

		return value
			.filter(isDraggedProjectPayload)
			.map(project => ({
				kind: 'project' as const,
				label: project.label,
				folderUri: vscode.Uri.file(project.folderFsPath),
				csprojUri: vscode.Uri.file(project.csprojFsPath),
				solutionUri: vscode.Uri.file(project.solutionFsPath),
				projectPath: project.projectPath,
				existsOnDisk: true,
				solutionProjectPaths: new Set<string>(),
				isAspNet: project.isAspNet,
				isTest: project.isTest,
				virtualPath: project.virtualPath,
			}));
	} catch {
		return [];
	}
}

function isDraggedProjectPayload(value: unknown): value is DraggedProjectPayload {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const candidate = value as Partial<DraggedProjectPayload>;
	return typeof candidate.label === 'string' &&
		typeof candidate.folderFsPath === 'string' &&
		typeof candidate.csprojFsPath === 'string' &&
		typeof candidate.solutionFsPath === 'string' &&
		typeof candidate.projectPath === 'string' &&
		typeof candidate.isAspNet === 'boolean' &&
		typeof candidate.isTest === 'boolean' &&
		(candidate.virtualPath === undefined || typeof candidate.virtualPath === 'string');
}

function normalizeGuid(value: string): string {
	return value.toLowerCase();
}

function normalizePath(value: string): string {
	return pathModule.normalize(value).replace(/\\/g, '/').toLowerCase();
}

function normalizeSolutionFolderPath(value: string): string {
	return value
		.replace(/\\/g, '/')
		.split('/')
		.map(segment => segment.trim())
		.filter(Boolean)
		.join('/');
}

function createSlnGuid(): string {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, token => {
		const random = Math.floor(Math.random() * 16);
		const value = token === 'x' ? random : (random & 0x3) | 0x8;
		return value.toString(16);
	}).toUpperCase();
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readUtf8(uri: vscode.Uri): Promise<string> {
	const bytes = await vscode.workspace.fs.readFile(uri);
	return Buffer.from(bytes).toString('utf-8');
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}
