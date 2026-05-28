import * as vscode from 'vscode';
import { spawnSync } from 'child_process';
import * as pathModule from 'path';
import * as fsModule from 'fs';

const path = pathModule;

// -------------------------------------------------------------------
// Helper: run dotnet command synchronously in the given directory (optional)
// -------------------------------------------------------------------
function runDotnetCommand(args: string[], cwd?: string): void {
	try {
		// Use spawnSync for better handling of arguments with special characters
		const result = spawnSync('dotnet', args, {
			cwd: cwd || process.cwd(),
			stdio: 'inherit',
			timeout: 120_000,
			shell: false
		});
		
		if (result.error) {
			const msg = result.error.message || String(result.error);
			vscode.window.showErrorMessage(`Failed to run dotnet ${args.join(' ')}: ${msg}`);
			throw result.error;
		}
		
		if (result.status !== 0) {
			const stderr = result.stderr?.toString() || '';
			const stdout = result.stdout?.toString() || '';
			const errorMsg = stderr || stdout || `Command exited with code ${result.status}`;
			vscode.window.showErrorMessage(`Failed to run dotnet ${args.join(' ')}: ${errorMsg}`);
			throw new Error(errorMsg);
		}
	} catch (error: unknown) {
		const msg = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`Failed to run dotnet ${args.join(' ')}: ${msg}`);
		throw error;
	}
}

// -------------------------------------------------------------------
// Helper: Find a solution file closest to the given URI, or in workspace root.
// -------------------------------------------------------------------
async function findSolutionFileNear(uri: vscode.Uri): Promise<vscode.Uri | null> {
	// Search from URI's directory up to workspace root
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) {
		return null;
	}

	const workspaceRootPath = workspaceFolders[0].uri.fsPath;
	let currentDir = uri.fsPath;

	// If URI is a file, start from its directory
	// Use try-catch because the directory might not exist yet (e.g., when creating a new project)
	try {
		const statType = await vscode.workspace.fs.stat(vscode.Uri.file(currentDir));
		if (statType.type === vscode.FileType.File) {
			currentDir = path.dirname(currentDir);
		}
	} catch {
		// Directory doesn't exist yet (e.g., new project being created) - proceed with currentDir
	}

	while (true) {
		try {
			const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(currentDir));
			// Look for .slnx first (newer format), then .sln
			for (const [name] of entries) {
				if (name.endsWith('.slnx') || name.endsWith('.sln')) {
					return vscode.Uri.file(path.join(currentDir, name));
				}
			}
		} catch {
			// Ignore errors when reading directories
		}

		if (currentDir === workspaceRootPath || currentDir === path.parse(currentDir).root) {
			break;
		}
		currentDir = path.dirname(currentDir);
	}

	return null;
}

// -------------------------------------------------------------------
// Helper: find a .csproj file closest to the given URI (or in workspace root)
// -------------------------------------------------------------------
async function findCsprojNear(uri: vscode.Uri): Promise<vscode.Uri | null> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) return null;

	const workspaceRootPath = workspaceFolders[0].uri.fsPath;
	let currentDir = uri.fsPath;

	// Use try-catch because the directory might not exist yet (e.g., when creating a new project)
	try {
		const statType = await vscode.workspace.fs.stat(vscode.Uri.file(currentDir));
		if (statType.type === vscode.FileType.File) {
			currentDir = path.dirname(currentDir);
		}
	} catch {
		// Directory doesn't exist yet (e.g., new project being created) - proceed with currentDir
	}

	while (true) {
		try {
			const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(currentDir));
			for (const [name] of entries) {
				if (name.endsWith('.csproj')) {
					return vscode.Uri.file(path.join(currentDir, name));
				}
			}
		} catch {
			// Ignore errors when reading directories
		}

		if (currentDir === workspaceRootPath || currentDir === path.parse(currentDir).root) {
			break;
		}
		currentDir = path.dirname(currentDir);
	}

	return null;
}

/**
 * Find a .csproj file for a given .cs file by searching from the file's directory up.
 */
async function findCsprojForFile(csFileUri: vscode.Uri): Promise<vscode.Uri | null> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) return null;

	let currentDir = path.dirname(csFileUri.fsPath);
	const workspaceRoot = workspaceFolders[0].uri.fsPath;

	while (true) {
		const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(currentDir));
		for (const [name, type] of entries) {
			if (name.endsWith('.csproj') && type === vscode.FileType.File) {
				return vscode.Uri.file(path.join(currentDir, name));
			}
		}

		if (currentDir === workspaceRoot) break;
		currentDir = path.dirname(currentDir);
	}

	return null;
}

// -------------------------------------------------------------------
// Helper: create project folder path relative to current working directory
// -------------------------------------------------------------------
function createProjectFolderPath(baseUri: vscode.Uri, projectName: string): vscode.Uri {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) {
		return vscode.Uri.file(path.join(baseUri.fsPath, projectName));
	}

	const workspaceFolder = workspaceFolders.find(wf => baseUri.fsPath.startsWith(wf.uri.fsPath));
	if (!workspaceFolder) {
		return vscode.Uri.file(path.join(baseUri.fsPath, projectName));
	}

	const relativeBase = path.relative(workspaceFolder.uri.fsPath, baseUri.fsPath);
	const projectFolderPath = path.join(workspaceFolder.uri.fsPath, relativeBase, projectName);
	return vscode.Uri.file(projectFolderPath);
}

// -------------------------------------------------------------------
// Helper: add project to a solution file (handles both .sln and .slnx)
// -------------------------------------------------------------------
async function addProjectToSolution(solutionUri: vscode.Uri, projectFolderUri: vscode.Uri, _projectName: string, slnDir: string): Promise<boolean> {
	const ext = path.basename(solutionUri.fsPath).endsWith('.slnx') ? '.slnx' : '.sln';

	try {
		if (ext === '.sln') {
			// For .sln files, use dotnet sln add command
			runDotnetCommand(['sln', path.basename(solutionUri.fsPath), 'add', projectFolderUri.fsPath], slnDir);
			return true;
		} else {
			// For .slnx files, we need to manually edit the XML
			const slnxUri = solutionUri;
			const slnxBuf = await vscode.workspace.fs.readFile(slnxUri);
			let slnxContent = Buffer.from(slnxBuf).toString('utf-8');

			// Extract the directory name from project path for the project reference
			const projectDirName = path.basename(projectFolderUri.fsPath);

			// Check if project already exists in solution
			if (slnxContent.includes(projectDirName)) {
				return true; // Already in solution
			}

			// Find <Projects> section and add the new project reference
			const projectsMatch = slnxContent.match(/(<Projects[^>]*>)([\s\S]*?)(<\/Projects>)/);
			if (projectsMatch) {
				const projectsSection = projectsMatch[0];
				const projectEntry = `\n    <Project Include="${projectFolderUri.fsPath}" />`;
				const newProjects = projectsSection.replace(/(<\/Projects>)/, `${projectEntry}\n$1`);
				slnxContent = slnxContent.replace(projectsMatch[0], newProjects);

				// Write updated content
				const edit = new vscode.WorkspaceEdit();
				const document = await vscode.workspace.openTextDocument(slnxUri);
				const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
				edit.replace(slnxUri, fullRange, slnxContent);
				await vscode.workspace.applyEdit(edit);
				await vscode.window.activeTextEditor?.document.save();
			}

			return true;
		}
	} catch (error) {
		console.error('Failed to add project to solution:', error);
		return false;
	}
}

// -------------------------------------------------------------------
// Generic project creation helper - used by all project type commands
// -------------------------------------------------------------------
interface ProjectTemplate {
	commandName: string;
	label: string;
}

const projectTemplates: Record<string, ProjectTemplate> = {
	console: { commandName: 'console', label: 'Console' },
	web: { commandName: 'web', label: 'ASP.NET Core Empty' },
	webapi: { commandName: 'webapi', label: 'Web API' },
	mvc: { commandName: 'mvc', label: 'MVC' },
	webapp: { commandName: 'webapp', label: 'Web App (Razor Pages)' },
	react: { commandName: 'react', label: 'React App' },
	angular: { commandName: 'angular', label: 'Angular App' },
	blazor: { commandName: 'blazor', label: 'Blazor Web App' },
	blazorwasm: { commandName: 'blazorwasm', label: 'Blazor WebAssembly Standalone' },
	blazorserver: { commandName: 'blazorserver', label: 'Blazor Server' },
	wpf: { commandName: 'wpf', label: 'WPF Application' },
	wpflib: { commandName: 'wpflib', label: 'WPF Class Library' },
	wpfcustomcontrollib: { commandName: 'wpfcustomcontrollib', label: 'WPF Custom Control Library' },
	wpfusercontrollib: { commandName: 'wpfusercontrollib', label: 'WPF User Control Library' },
	winforms: { commandName: 'winforms', label: 'WinForms Application' },
	winformslib: { commandName: 'winformslib', label: 'WinForms Class Library' },
	winformscontrollib: { commandName: 'winformscontrollib', label: 'WinForms User Control Library' },
	worker: { commandName: 'worker', label: 'Worker Service' },
	classlib: { commandName: 'classlib', label: 'Class Library' },
	razorclasslib: { commandName: 'razorclasslib', label: 'Razor Class Library' },
	maui: { commandName: 'mauilib', label: '.NET MAUI Class Library' },
	minimalapi: { commandName: 'minimalapi', label: '.NET Minimal API' },
	// Aspire templates
	'aspireapphost': { commandName: 'aspire-apphost', label: '.NET Aspire App Host' },
	'aspireemptyapp': { commandName: 'aspire', label: '.NET Aspire Empty App' },
	'aspireservicedefaults': { commandName: 'aspire-servicedefaults', label: '.NET Aspire Service Defaults' },
	'aspireapphostsinglefile': { commandName: 'aspire-apphost-singlefile', label: '.NET Aspire App Host (Single File)' },
	'aspirestarter': { commandName: 'aspire-starter', label: '.NET Aspire Starter Application' },
	'aspiretsstartester': { commandName: 'aspire-ts-cs-starter', label: '.NET Aspire TypeScript-C# Starter' },
	'aspiretestmstest': { commandName: 'aspire-mstest', label: '.NET Aspire Test Project (MSTest)' },
	'aspiretestnunit': { commandName: 'aspire-nunit', label: '.NET Aspire Test Project (NUnit)' },
	'aspiretestxunit': { commandName: 'aspire-xunit', label: '.NET Aspire Test Project (xUnit)' },
};

async function createProjectTemplate(
	key: string,
	uri?: vscode.Uri
): Promise<void> {
	const template = projectTemplates[key];
	if (!template) {
		vscode.window.showErrorMessage(`Unknown project type: ${key}`);
		return;
	}

	const baseUri = uri || vscode.window.activeTextEditor?.document.uri;
	if (!baseUri) {
		vscode.window.showErrorMessage(`CSharp Painkiller: Open a .cs file or select a folder in the explorer to create a ${template.label}.`);
		return;
	}

	const projectName = await vscode.window.showInputBox({
		prompt: `Enter ${template.label} project name`,
		placeHolder: `My${template.label}`,
		validateInput: (value) => {
			if (!value || value.trim() === '') return 'Project name is required';
			return null;
		}
	});

	if (!projectName) return;

	const projectFolder = createProjectFolderPath(baseUri, projectName);

	// Search for solution near baseUri (where creation was triggered), NOT near projectFolder
	// because projectFolder doesn't exist yet - it's the path where we're about to create the project
	const solution = await findSolutionFileNear(baseUri);

	// Ensure the parent directory exists before creating the project
	ensureDirectoryExists(path.dirname(projectFolder.fsPath));

	// Build the dotnet new command args
	// -o specifies the output directory (where the project will be created)
	// The full path includes the project name, so dotnet creates src/FolderName/TestProj
	// --name sets the namespace/assembly name inside the project files
	const newArgs = ['new', template.commandName, '-o', projectFolder.fsPath, '--name', projectName];

	try {
		if (solution) {
			const slnDir = path.dirname(solution.fsPath);

			// Create the project (dotnet new creates the output folder automatically via -o)
			runDotnetCommand(newArgs, slnDir);

			// Add to solution (handles both .sln and .slnx)
			const added = await addProjectToSolution(solution, projectFolder, projectName, slnDir);
			if (!added) {
				vscode.window.showWarningMessage(`Project created but failed to add to solution "${path.basename(solution.fsPath)}".`);
			}

			vscode.window.showInformationMessage(`Created ${template.label} project "${projectName}" and added to solution "${path.basename(solution.fsPath)}".`);
		} else {
			// No solution - just create the project
			runDotnetCommand(newArgs, path.dirname(projectFolder.fsPath));

			vscode.window.showInformationMessage(`Created ${template.label} project "${projectName}".`);
		}
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to create ${template.label} project: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// -------------------------------------------------------------------
// Helper: ensure a directory exists, creating it if necessary
// -------------------------------------------------------------------
function ensureDirectoryExists(dirPath: string): boolean {
	// Use Node.js fs module directly instead of VS Code's workspace.fs
	// because workspace.fs only works for files already in the workspace
	if (fsModule.existsSync(dirPath)) {
		const stat = fsModule.statSync(dirPath);
		return stat.isDirectory();
	}
	
	// Directory doesn't exist, create it along with any parent directories
	try {
		fsModule.mkdirSync(dirPath, { recursive: true });
		return true;
	} catch {
		return false;
	}
}

// -------------------------------------------------------------------
// Create Project commands - each delegates to createProjectTemplate()
// -------------------------------------------------------------------

export async function createConsoleProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('console', uri);
}

export async function createWebProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('web', uri);
}

export async function createWebApiProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('webapi', uri);
}

export async function createReactProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('react', uri);
}

export async function createAngularProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('angular', uri);
}

export async function createMvcProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('mvc', uri);
}

export async function createWebAppProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('webapp', uri);
}

export async function createBlazorProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('blazor', uri);
}

export async function createBlazorWebAssemblyProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('blazorwasm', uri);
}

export async function createBlazorServerProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('blazorserver', uri);
}

export async function createWpfProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('wpf', uri);
}

export async function createWpfLibraryProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('wpflib', uri);
}

export async function createWpfCustomControlProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('wpfcustomcontrollib', uri);
}

export async function createWpfUserControlProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('wpfusercontrollib', uri);
}

export async function createWinFormsProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('winforms', uri);
}

export async function createWinFormsLibraryProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('winformslib', uri);
}

export async function createWinFormsUserControlProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('winformscontrollib', uri);
}

export async function createWorkerProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('worker', uri);
}

export async function createClassLibraryProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('classlib', uri);
}

export async function createRazorClassLibraryProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('razorclasslib', uri);
}

export async function createMauiProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('maui', uri);
}

export async function createMinimalApiProject(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('minimalapi', uri);
}

// -------------------------------------------------------------------
// Aspire project creation commands
// -------------------------------------------------------------------

export async function createAspireAppHost(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('aspireapphost', uri);
}

export async function createAspireEmptyApp(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('aspireemptyapp', uri);
}

export async function createAspireServiceDefaults(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('aspireservicedefaults', uri);
}

export async function createAspireAppHostSingleFile(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('aspireapphostsinglefile', uri);
}

export async function createAspireStarter(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('aspirestarter', uri);
}

export async function createAspireTsCsStarter(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('aspiretsstartester', uri);
}

export async function createAspireMSTest(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('aspiretestmstest', uri);
}

export async function createAspireNUnit(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('aspiretestnunit', uri);
}

export async function createAspireXUnit(uri?: vscode.Uri): Promise<void> {
	await createProjectTemplate('aspiretestxunit', uri);
}

// -------------------------------------------------------------------
// Run / Build/Publish/Test commands - work on folders with .sln/.csproj files
// -------------------------------------------------------------------

/**
 * Determine the working directory and project argument for dotnet commands.
 * Priority: .sln/.slnx file > .csproj file > directory containing them
 */
async function resolveProjectContext(uri: vscode.Uri): Promise<{ cwd: string; projectArg?: string } | null> {
	const fileType = await getFileType(uri);

	if (fileType === 'directory') {
		// For directories, find solution or project file inside
		const soln = await findSolutionFileNear(uri);
		if (soln) {
			return { cwd: path.dirname(soln.fsPath), projectArg: soln.fsPath };
		}
		const csproj = await findCsprojNear(uri);
		if (csproj) {
			return { cwd: path.dirname(csproj.fsPath), projectArg: csproj.fsPath };
		}
		return { cwd: uri.fsPath }; // Run in the directory itself (will find default project)
	}

	const fileName = path.basename(uri.fsPath);

	if (fileName.endsWith('.sln') || fileName.endsWith('.slnx')) {
		return { cwd: uri.fsPath, projectArg: uri.fsPath };
	}

	if (fileName.endsWith('.csproj')) {
		return { cwd: uri.fsPath, projectArg: uri.fsPath };
	}

	if (fileName.endsWith('.cs')) {
		const csproj = await findCsprojForFile(uri);
		if (csproj) {
			return { cwd: path.dirname(csproj.fsPath), projectArg: csproj.fsPath };
		}
		return null;
	}

	// For any other file/directory, search for solution or project near it
	const nearbySoln = await findSolutionFileNear(uri);
	if (nearbySoln) {
		return { cwd: path.dirname(nearbySoln.fsPath), projectArg: nearbySoln.fsPath };
	}

	const nearbyCsproj = await findCsprojNear(uri);
	if (nearbyCsproj) {
		return { cwd: path.dirname(nearbyCsproj.fsPath), projectArg: nearbyCsproj.fsPath };
	}

	return null;
}

async function getFileType(uri: vscode.Uri): Promise<'file' | 'directory' | 'unknown'> {
	try {
		const stat = await vscode.workspace.fs.stat(uri);
		if (stat.type === vscode.FileType.Directory) return 'directory';
		if (stat.type === vscode.FileType.File) return 'file';
	} catch {
		// If stat fails, treat as unknown
	}
	return 'unknown';
}

function showProjectNotFoundError(): void {
	vscode.window.showErrorMessage(
		'CSharp Painkiller: Select a folder containing a .sln/.slnx/.csproj file, or select the solution/project file directly.'
	);
}

// -------------------------------------------------------------------
// Run commands
// -------------------------------------------------------------------

export async function dotnetRun(uri?: vscode.Uri): Promise<void> {
	const baseUri = resolveInputUri(uri);
	if (!baseUri) {
		showProjectNotFoundError();
		return;
	}

	const ctx = await resolveProjectContext(baseUri);
	if (!ctx) {
		showProjectNotFoundError();
		return;
	}

	try {
		runDotnetCommand(['run', ...(ctx.projectArg ? [ctx.projectArg] : [])], ctx.cwd);
	} catch {
		// runDotnetCommand already shows the error
	}
}

// -------------------------------------------------------------------
// Build command
// -------------------------------------------------------------------

export async function dotnetBuild(uri?: vscode.Uri): Promise<void> {
	const baseUri = resolveInputUri(uri);
	if (!baseUri) {
		showProjectNotFoundError();
		return;
	}

	const ctx = await resolveProjectContext(baseUri);
	if (!ctx) {
		showProjectNotFoundError();
		return;
	}

	try {
		runDotnetCommand(['build', ...(ctx.projectArg ? [ctx.projectArg] : [])], ctx.cwd);
	} catch {
		// runDotnetCommand already shows the error
	}
}

// -------------------------------------------------------------------
// Publish command
// -------------------------------------------------------------------

export async function dotnetPublish(uri?: vscode.Uri): Promise<void> {
	const baseUri = resolveInputUri(uri);
	if (!baseUri) {
		showProjectNotFoundError();
		return;
	}

	const ctx = await resolveProjectContext(baseUri);
	if (!ctx) {
		showProjectNotFoundError();
		return;
	}

	try {
		runDotnetCommand(['publish', ...(ctx.projectArg ? [ctx.projectArg] : [])], ctx.cwd);
	} catch {
		// runDotnetCommand already shows the error
	}
}

// -------------------------------------------------------------------
// Test command
// -------------------------------------------------------------------

export async function dotnetTest(uri?: vscode.Uri): Promise<void> {
	const baseUri = resolveInputUri(uri);
	if (!baseUri) {
		showProjectNotFoundError();
		return;
	}

	const ctx = await resolveProjectContext(baseUri);
	if (!ctx) {
		showProjectNotFoundError();
		return;
	}

	try {
		runDotnetCommand(['test', ...(ctx.projectArg ? ['--project', ctx.projectArg] : [])], ctx.cwd);
	} catch {
		// runDotnetCommand already shows the error
	}
}

// -------------------------------------------------------------------
// Restore command
// -------------------------------------------------------------------

export async function dotnetRestore(uri?: vscode.Uri): Promise<void> {
	const baseUri = resolveInputUri(uri);
	if (!baseUri) {
		showProjectNotFoundError();
		return;
	}

	const ctx = await resolveProjectContext(baseUri);
	if (!ctx) {
		showProjectNotFoundError();
		return;
	}

	try {
		runDotnetCommand(['restore', ...(ctx.projectArg ? ['--project', ctx.projectArg] : [])], ctx.cwd);
	} catch {
		// runDotnetCommand already shows the error
	}
}

// -------------------------------------------------------------------
// Clean command
// -------------------------------------------------------------------

export async function dotnetClean(uri?: vscode.Uri): Promise<void> {
	const baseUri = resolveInputUri(uri);
	if (!baseUri) {
		showProjectNotFoundError();
		return;
	}

	const ctx = await resolveProjectContext(baseUri);
	if (!ctx) {
		showProjectNotFoundError();
		return;
	}

	try {
		runDotnetCommand(['clean', '--configuration', 'Debug', ...(ctx.projectArg ? ['--project', ctx.projectArg] : [])], ctx.cwd);
	} catch {
		// runDotnetCommand already shows the error
	}
}

// -------------------------------------------------------------------
// Helper: resolve input URI from user selection or active editor
// -------------------------------------------------------------------
function resolveInputUri(uri?: vscode.Uri): vscode.Uri | null {
	if (uri) {
		return uri;
	}

	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor) {
		return activeEditor.document.uri;
	}

	// If no file is open, use the first workspace folder
	const wf = vscode.workspace.workspaceFolders?.[0];
	if (wf) {
		return wf.uri;
	}

	return null;
}

// -------------------------------------------------------------------
// Legacy aliases (kept for backwards compatibility)
// -------------------------------------------------------------------

export async function runCurrentFileProject(): Promise<void> {
	await dotnetRun();
}

export async function buildCurrentFileProject(): Promise<void> {
	await dotnetBuild();
}

export async function publishCurrentProject(): Promise<void> {
	await dotnetPublish();
}