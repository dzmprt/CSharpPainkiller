import * as vscode from 'vscode';
import * as pathModule from 'path';
import { spawnSync } from 'child_process';
import { showAddPackagePicker } from '../services/nugetCommands.js';

type CsprojTreeNode =
	| SolutionNode
	| FolderNode
	| ProjectNode
	| ReferenceGroupNode
	| PackageGroupNode
	| ProjectReferenceNode
	| PackageReferenceNode
	| ExcludedProjectsNode
	| ExcludedProjectNode;

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
	isAspNet: boolean;
	isTest: boolean;
	virtualPath?: string;
	targetFramework?: string;
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

interface ProjectReferenceNode {
	kind: 'projectReference';
	label: string;
	project: ProjectNode;
	referencePath: string;
}

interface PackageReferenceNode {
	kind: 'packageReference';
	label: string;
	version?: string;
	project: ProjectNode;
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

export class CsprojProjectsTreeProvider implements vscode.TreeDataProvider<CsprojProjectTreeItem>, vscode.TreeDragAndDropController<CsprojProjectTreeItem>, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<CsprojProjectTreeItem | undefined>();
	private readonly watcher: vscode.FileSystemWatcher;
	private readonly solutionWatcher: vscode.FileSystemWatcher;

	readonly onDidChangeTreeData = this.changeEmitter.event;
	readonly dragMimeTypes = [PROJECT_TREE_DRAG_MIME];
	readonly dropMimeTypes = [PROJECT_TREE_DRAG_MIME];

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly onProjectFoldersChanged?: () => Promise<void> | void
	) {
		this.watcher = vscode.workspace.createFileSystemWatcher('**/*.csproj');
		this.watcher.onDidCreate(() => this.refresh());
		this.watcher.onDidDelete(() => this.refresh());
		this.watcher.onDidChange(() => this.refresh());

		this.solutionWatcher = vscode.workspace.createFileSystemWatcher('**/*.{sln,slnx}');
		this.solutionWatcher.onDidCreate(() => this.refresh());
		this.solutionWatcher.onDidDelete(() => this.refresh());
		this.solutionWatcher.onDidChange(() => this.refresh());
	}

	refresh(): void {
		this.changeEmitter.fire(undefined);
	}

	getTreeItem(element: CsprojProjectTreeItem): vscode.TreeItem {
		return element;
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

			return 'children' in element.node
				? element.node.children.map(node => this.createTreeItem(node))
				: [];
		}

		const nodes = await this.buildTree();
		return nodes.map(node => this.createTreeItem(node));
	}

	private createTreeItem(node: CsprojTreeNode): CsprojProjectTreeItem {
		return new CsprojProjectTreeItem(node, this.extensionUri);
	}

	private async getProjectChildren(project: ProjectNode): Promise<CsprojTreeNode[]> {
		const content = await readUtf8(project.csprojUri);
		const references = parseProjectReferences(content)
			.map(referencePath => ({
				kind: 'projectReference' as const,
				label: getProjectReferenceDisplayName(referencePath),
				project,
				referencePath,
			}));
		const packages = parsePackageReferences(content)
			.map(pkg => ({
				kind: 'packageReference' as const,
				label: pkg.name,
				version: pkg.version,
				project,
			}));

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
		const content = await readUtf8(target.solutionUri);
		const updated = target.solutionUri.path.endsWith('.slnx')
			? removeSlnxFolder(content, folderGuid)
			: removeSlnFolder(content, folderGuid);
		await vscode.workspace.fs.writeFile(target.solutionUri, Buffer.from(updated, 'utf-8'));

		await this.deletePhysicalFolderIfNeeded(target.physicalBaseUri, item.node.label);
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
		const updated = addPackageReferenceToCsproj(content, result.id, result.version);
		await vscode.workspace.fs.writeFile(project.csprojUri, Buffer.from(updated, 'utf-8'));
		this.refresh();
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
		this.refresh();
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

	private async deletePhysicalFolderIfNeeded(folderUri: vscode.Uri, label: string): Promise<void> {
		try {
			const stat = await vscode.workspace.fs.stat(folderUri);
			if ((stat.type & vscode.FileType.Directory) !== vscode.FileType.Directory) {
				return;
			}
		} catch {
			return;
		}

		const entries = await vscode.workspace.fs.readDirectory(folderUri);
		if (entries.length > 0) {
			const answer = await vscode.window.showWarningMessage(
				`Physical folder "${label}" is not empty. Delete it too?`,
				{ modal: true },
				'Delete Physical Folder'
			);
			if (answer !== 'Delete Physical Folder') {
				return;
			}
		}

		await vscode.workspace.fs.delete(folderUri, { recursive: true, useTrash: true });
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

		const result = spawnSync('dotnet', ['sln', solutionUri.fsPath, 'add', projectUri.fsPath], {
			cwd: solutionDir,
			timeout: 120_000,
			shell: false,
		});
		if (result.error || result.status !== 0) {
			throw result.error ?? new Error(result.stderr?.toString() || 'Failed to add project to solution');
		}
		const updatedContent = await readUtf8(solutionUri);
		const ensured = ensureSlnFolderPath(updatedContent, getProjectSolutionFolderPath(relativeProjectPath));
		const updated = ensured.folderGuid
			? moveSlnProjectToFolder(ensured.content, relativeProjectPath, ensured.folderGuid)
			: ensured.content;
		await vscode.workspace.fs.writeFile(solutionUri, Buffer.from(updated, 'utf-8'));
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

		for (const entry of entries.filter(item => !item.isSolutionFolder)) {
			const absoluteProjectPath = normalizePath(pathModule.resolve(solutionDir, entry.projectPath));
			const csprojUri = projectByPath.get(absoluteProjectPath);
			if (!csprojUri) {
				continue;
			}

			usedProjectPaths.add(absoluteProjectPath);
			const projectNode = await this.createProjectNode(csprojUri, solutionUri, entry.projectPath, this.getVirtualPath(entry, foldersByGuid), entry.name);

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
		virtualPath?: string,
		displayName?: string
	): Promise<ProjectNode> {
		const folderPath = csprojUri.path.replace(/\/[^/]*$/, '');
		const folderUri = csprojUri.with({ path: folderPath });
		const label = displayName ?? folderPath.split('/').filter(Boolean).pop() ?? csprojUri.fsPath;

		return {
			kind: 'project',
			label,
			folderUri,
			csprojUri,
			solutionUri,
			projectPath,
			isAspNet: await this.isAspNetProject(csprojUri),
			isTest: await this.isTestProject(csprojUri),
			virtualPath,
			targetFramework: await this.getTargetFramework(csprojUri),
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

	dispose(): void {
		this.watcher.dispose();
		this.solutionWatcher.dispose();
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
			const parts = [node.targetFramework, node.virtualPath].filter(Boolean);
			this.description = parts.length > 0 ? parts.join(', ') : undefined;
			this.tooltip = `${node.virtualPath ? `Solution path: ${node.virtualPath}\n` : ''}${node.csprojUri.fsPath}`;
			this.updateProjectIcon(extensionUri);
			this.command = {
				command: 'csharppainkiller.revealProjectFolder',
				title: 'Reveal Project Folder',
				arguments: [node.folderUri],
			};
			return;
		}

		if (node.kind === 'referenceGroup' || node.kind === 'packageGroup') {
			this.contextValue = `csharppainkiller.${node.kind}`;
			this.iconPath = new vscode.ThemeIcon(node.kind === 'referenceGroup' ? 'references' : 'package');
			return;
		}

		if (node.kind === 'projectReference') {
			this.contextValue = 'csharppainkiller.projectReference';
			this.description = pathModule.dirname(node.referencePath).replace(/\\/g, '/');
			this.iconPath = new vscode.ThemeIcon('file-submodule');
			return;
		}

		if (node.kind === 'packageReference') {
			this.contextValue = 'csharppainkiller.packageReference';
			this.description = node.version;
			this.iconPath = new vscode.ThemeIcon('package');
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
	if (node.kind === 'project' || node.kind === 'referenceGroup' || node.kind === 'packageGroup' || node.kind === 'excludedProjects') {
		return vscode.TreeItemCollapsibleState.Collapsed;
	}
	if (node.kind === 'projectReference' || node.kind === 'packageReference' || node.kind === 'excludedProject') {
		return vscode.TreeItemCollapsibleState.None;
	}
	return vscode.TreeItemCollapsibleState.Expanded;
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
	const attrRegex = /(\w+)\s*=\s*"([^"]*)"/g;
	let match: RegExpExecArray | null;
	while ((match = attrRegex.exec(input)) !== null) {
		attrs.set(match[1], match[2]);
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
	const folderProjectRegex = new RegExp(
		`Project\\("\\{${escapeRegExp(SOLUTION_FOLDER_TYPE_GUID.toUpperCase())}\\}"\\)\\s*=\\s*"[^"]+",\\s*"[^"]+",\\s*"\\{${escapeRegExp(guid)}\\}"\\r?\\nEndProject\\r?\\n?`,
		'g'
	);
	let updated = content.replace(folderProjectRegex, '');

	const parentGuid = findSlnParentGuid(updated, guid);
	updated = updated.replace(
		/GlobalSection\(NestedProjects\)\s*=\s*preSolution([\s\S]*?)EndGlobalSection/g,
		(_section, body: string) => {
			const lines = body.split(/\r?\n/);
			const rewrittenLines = lines
				.map(line => rewriteNestedProjectLine(line, guid, parentGuid))
				.filter((line): line is string => line !== null);
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
	const nestedLine = `\t\t{${childGuid.toUpperCase()}} = {${parentGuid.toUpperCase()}}\n`;
	const nestedSection = content.match(/GlobalSection\(NestedProjects\)\s*=\s*preSolution[\s\S]*?EndGlobalSection/);
	if (nestedSection?.index !== undefined) {
		const childRegex = new RegExp(`\\t*\\s*\\{${escapeRegExp(childGuid)}\\}\\s*=\\s*\\{[^}]+\\}\\r?\\n?`, 'i');
		let updated = content.replace(childRegex, '');
		const updatedSection = updated.match(/GlobalSection\(NestedProjects\)\s*=\s*preSolution[\s\S]*?EndGlobalSection/);
		if (updatedSection?.index !== undefined) {
			const insertIndex = updatedSection.index + updatedSection[0].lastIndexOf('EndGlobalSection');
			updated = `${updated.slice(0, insertIndex)}${nestedLine}${updated.slice(insertIndex)}`;
		}
		return updated;
	}

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

function findSlnParentGuid(content: string, folderGuid: string): string | undefined {
	const nestedMatch = content.match(/GlobalSection\(NestedProjects\)\s*=\s*preSolution[\s\S]*?EndGlobalSection/);
	if (!nestedMatch) {
		return undefined;
	}

	const parentRegex = new RegExp(`\\{${escapeRegExp(folderGuid)}\\}\\s*=\\s*\\{([^}]+)\\}`, 'i');
	const parentMatch = parentRegex.exec(nestedMatch[0]);
	return parentMatch?.[1]?.toUpperCase();
}

function rewriteNestedProjectLine(line: string, folderGuid: string, parentGuid: string | undefined): string | null {
	const match = line.match(/(\{([^}]+)\}\s*=\s*)\{([^}]+)\}/);
	if (!match) {
		return line;
	}

	const childGuid = match[2].toUpperCase();
	const currentParentGuid = match[3].toUpperCase();
	if (childGuid === folderGuid) {
		return null;
	}
	if (currentParentGuid !== folderGuid) {
		return line;
	}
	if (!parentGuid) {
		return null;
	}
	return line.replace(/\{[^}]+\}\s*$/, `{${parentGuid}}`);
}

function addSlnxFolder(content: string, folderName: string, parentPath?: string): string {
	if (parentPath) {
		const inserted = insertFolderIntoSlnxFolder(content, parentPath, folderName);
		if (inserted !== content) {
			return inserted;
		}
	}

	const folderXml = `  <Folder Name="${escapeXml(folderName)}" />\n`;
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
		const parentPath = currentPath || undefined;
		currentPath = currentPath ? `${currentPath}/${segment}` : segment;
		if (findSlnxFolderStart(updated, currentPath)) {
			continue;
		}
		updated = addSlnxFolder(updated, segment, parentPath);
	}

	return { content: updated, folderPath: currentPath };
}

function insertFolderIntoSlnxFolder(content: string, targetFolderPath: string, folderName: string): string {
	const folderStart = findSlnxFolderStart(content, targetFolderPath);
	if (!folderStart) {
		return content;
	}

	const indent = getLineIndent(content, folderStart.index);
	const childIndent = `${indent}  `;
	const folderXml = `${childIndent}<Folder Name="${escapeXml(folderName)}" />\n`;

	if (folderStart.isSelfClosing) {
		const openTag = content.slice(folderStart.index, folderStart.end).replace(/\s*\/>$/, '>');
		const replacement = `${openTag}\n${folderXml}${indent}</Folder>`;
		return `${content.slice(0, folderStart.index)}${replacement}${content.slice(folderStart.end)}`;
	}

	const close = findClosingSlnxFolder(content, folderStart.index);
	if (!close) {
		return content;
	}

	return `${content.slice(0, close.index)}${folderXml}${content.slice(close.index)}`;
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

	const indent = getLineIndent(content, folderStart.index);
	const childIndent = `${indent}  `;
	const indentedProjectXml = projectXml.replace(/^  /, childIndent);

	if (folderStart.isSelfClosing) {
		const openTag = content.slice(folderStart.index, folderStart.end).replace(/\s*\/>$/, '>');
		const replacement = `${openTag}\n${indentedProjectXml}${indent}</Folder>`;
		return `${content.slice(0, folderStart.index)}${replacement}${content.slice(folderStart.end)}`;
	}

	const close = findClosingSlnxFolder(content, folderStart.index);
	if (!close) {
		return content;
	}

	return `${content.slice(0, close.index)}${indentedProjectXml}${content.slice(close.index)}`;
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
			return a.kind === 'folder' ? -1 : 1;
		}
		return a.label.localeCompare(b.label);
	});

	for (const node of nodes) {
		if ('children' in node) {
			sortTree(node.children);
		}
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

function parsePackageReferences(content: string): { name: string; version?: string }[] {
	const packages: { name: string; version?: string }[] = [];
	const regex = /<PackageReference\b([^>]*)\/?>/gi;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(content)) !== null) {
		const attrs = parseAttributes(match[1]);
		const name = attrs.get('Include') ?? attrs.get('Update');
		if (name) {
			packages.push({ name, version: attrs.get('Version') });
		}
	}
	return packages;
}

function addPackageReferenceToCsproj(content: string, packageId: string, version: string): string {
	const referenceXml = `  <ItemGroup>\n    <PackageReference Include="${escapeXml(packageId)}" Version="${escapeXml(version)}" />\n  </ItemGroup>\n`;
	const projectCloseIndex = content.lastIndexOf('</Project>');
	return projectCloseIndex >= 0
		? `${content.slice(0, projectCloseIndex)}${referenceXml}${content.slice(projectCloseIndex)}`
		: `${content.trimEnd()}\n${referenceXml}`;
}

function removePackageReferenceFromCsproj(content: string, packageId: string): string {
	const escapedId = escapeRegExp(packageId);
	// Self-closing: <PackageReference Include="Id" ... />
	let updated = content.replace(
		new RegExp(`^[ \\t]*<PackageReference\\b[^>]*\\bInclude="${escapedId}"[^>]*/>[ \\t]*\\r?\\n?`, 'gmi'),
		''
	);
	// Multi-line: <PackageReference Include="Id">...</PackageReference>
	updated = updated.replace(
		new RegExp(`^[ \\t]*<PackageReference\\b[^>]*\\bInclude="${escapedId}"[^>]*>[\\s\\S]*?</PackageReference>[ \\t]*\\r?\\n?`, 'gmi'),
		''
	);
	updated = updated.replace(/<ItemGroup>\s*<\/ItemGroup>\r?\n?/g, '');
	return removeExtraBlankLines(updated);
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
