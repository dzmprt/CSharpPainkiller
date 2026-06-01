import * as vscode from 'vscode';
import { deriveNamespaceFromFolder } from '../namespace/compute.js';
import { findTypeInWorkspace } from '../utils/typeSearch.js';
import { getParentFolder } from '../utils/fileUtils.js';
import { extractTypesFromContent } from '../utils/contentParser.js';
import {
	parsePublicProperties,
	generateEfCoreEntityTypeConfiguration,
} from './templates/efcore.js';

// ============================================================================
// Helpers
// ============================================================================

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

// ============================================================================
// Shared helpers
// ============================================================================

async function resolveTargetFolder(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
	if (uri?.scheme === 'file') {
		return uri;
	}
	const editor = vscode.window.activeTextEditor;
	if (editor) {
		const wsFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
		if (wsFolder) {
			return wsFolder.uri;
		}
	}
	return undefined;
}

async function writeAndOpen(
	folderUri: vscode.Uri,
	fileName: string,
	content: string
): Promise<boolean> {
	const fileUri = vscode.Uri.joinPath(folderUri, fileName);
	try {
		await vscode.workspace.fs.stat(fileUri);
		vscode.window.showErrorMessage(`File '${fileName}' already exists.`);
		return false;
	} catch {
		// File doesn't exist — proceed
	}
	const encoded = new TextEncoder().encode(content);
	await vscode.workspace.fs.writeFile(fileUri, encoded);
	const doc = await vscode.workspace.openTextDocument(fileUri);
	await vscode.window.showTextDocument(doc, { preview: false });
	return true;
}

async function readProperties(fileUri: vscode.Uri): Promise<ReturnType<typeof parsePublicProperties>> {
	try {
		const buf = await vscode.workspace.fs.readFile(fileUri);
		return parsePublicProperties(Buffer.from(buf).toString('utf-8'));
	} catch {
		return [];
	}
}

// ============================================================================
// EF Core commands
// ============================================================================

/**
 * Triggered from a **folder** in the Explorer.
 * Prompts the user for an entity class name, searches the workspace for it,
 * then generates `<EntityName>Configuration.cs` in the selected folder.
 */
export async function createEfCoreConfigurationFromFolder(folderUri?: vscode.Uri): Promise<void> {
	const folder = await resolveTargetFolder(folderUri);
	if (!folder) {
		vscode.window.showErrorMessage('No target folder selected.');
		return;
	}

	const input = await vscode.window.showInputBox({
		title: 'Entity Class Name',
		placeHolder: 'Author',
	});
	if (!input?.trim()) { return; }

	const entityName = capitalize(input.trim());

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Searching for class '${entityName}'…` },
		async () => {
			const found = await findTypeInWorkspace(entityName);
			if (!found) {
				vscode.window.showErrorMessage(
					`Class '${entityName}' not found in the workspace. The configuration was not created.`
				);
				return;
			}

			const properties = await readProperties(found.fileUri);
			const namespace = await deriveNamespaceFromFolder(folder);
			const content = generateEfCoreEntityTypeConfiguration(found, properties, namespace);
			await writeAndOpen(folder, `${entityName}Configuration.cs`, content);
		}
	);
}

/**
 * Triggered by right-clicking a **.cs file** in the Explorer (or using the
 * active editor). Reads the entity class directly from that file — no prompt
 * needed for the class name.
 *
 * The generated configuration file is written into the **same folder** as the
 * selected entity file.
 */
export async function createEfCoreConfigurationFromFile(fileUri?: vscode.Uri): Promise<void> {
	// Resolve the .cs file URI
	let uri = fileUri;
	if (!uri) {
		const editor = vscode.window.activeTextEditor;
		if (!editor || !editor.document.uri.path.endsWith('.cs')) {
			vscode.window.showErrorMessage('Open or select a .cs file first.');
			return;
		}
		uri = editor.document.uri;
	}

	if (!uri.path.endsWith('.cs')) {
		vscode.window.showErrorMessage('This command only works on .cs files.');
		return;
	}

	let fileContent: string;
	try {
		const buf = await vscode.workspace.fs.readFile(uri);
		fileContent = Buffer.from(buf).toString('utf-8');
	} catch {
		vscode.window.showErrorMessage('Could not read the file.');
		return;
	}

	// Extract the primary public class name from the file
	const extraction = extractTypesFromContent(fileContent);
	const publicClass = extraction.types.find(t => t.type === 'class');
	if (!publicClass) {
		vscode.window.showErrorMessage('No class found in this file.');
		return;
	}

	const entityName = publicClass.name;
	const entityNamespace = publicClass.namespace ?? extraction.oldNamespace ?? '';

	const properties = parsePublicProperties(fileContent);
	const folder = getParentFolder(uri);
	const namespace = await deriveNamespaceFromFolder(folder);

	const found = { name: entityName, namespace: entityNamespace, fileUri: uri };
	const content = generateEfCoreEntityTypeConfiguration(found, properties, namespace);
	await writeAndOpen(folder, `${entityName}Configuration.cs`, content);
}

// ============================================================================
// EF Core CLI commands
// ============================================================================

const EXCLUSION = '{**/bin/**,**/obj/**}';

/**
 * Finds all .csproj files in the workspace. */
async function findAllCsprojs(): Promise<vscode.Uri[]> {
	return vscode.workspace.findFiles('**/*.csproj', EXCLUSION);
}

/**
 * Creates a vscode.Uri for the parent directory of a .csproj file URI. */
function getCsprojParentDir(csprojUri: vscode.Uri): vscode.Uri {
	const dirPath = csprojUri.path.replace(/\/[^/]*$/, '');
	return vscode.Uri.parse(dirPath);
}

/**
 * Normalizes a URI to always be a directory. If it points to a .csproj file,
 * returns its parent folder instead. When triggered from the explorer context
 * menu on a .csproj file, VSCode passes the file URI — this helper resolves
 * it to a proper folder Uri that can be used as cwd for the terminal and for
 * path prefix matching in `getCsprojsInFolder`. */
async function normalizeToProjectFolder(uri: vscode.Uri): Promise<vscode.Uri> {
	// If the URI is a .csproj file, return its parent directory.
	if (uri.path.endsWith('.csproj')) {
		return getCsprojParentDir(uri);
	}
	// If the URI already ends with '/' it is a directory.
	if (uri.path.endsWith('/')) {
		return uri;
	}
	// VSCode explorer context-menu URIs for folders do NOT end with '/' — but they
	// are still directories.  Try fs.stat to distinguish a real file from a folder
	// without trailing slash, but fall through (returning the URI as-is) if stat
	// fails because it is commonly rejected in extension sandbox contexts.
	try {
		const st = await vscode.workspace.fs.stat(uri);
		if ((st.type & vscode.FileType.Directory) === vscode.FileType.Directory) {
			return uri; // confirmed directory
		}
		// stat says it's a file — find its containing folder as that is what we need.
		return vscode.Uri.parse(uri.path.replace(/\/[^/]*$/, ''));
	} catch {
		// stat failed (common in extension sandbox) — assume directory.
		return uri;
	}
}

/**
 * Finds the project root directory for a given URI.
 * Looks up the .csproj file that contains/is parent of the given path.
 */
async function findProjectRootFolder(uri: vscode.Uri): Promise<vscode.Uri | null> {
	// Strip the filename to get the directory part
	const targetDir = uri.path.replace(/\/[^/]*$/, '');

	const csprojs = await findAllCsprojs();

	// Normalize for comparison
	const normalizedTarget = '/' + targetDir.replace(/^\/+/, '');

	// Find the csproj whose directory matches or is a parent of the target (deepest first)
	const matched = csprojs
		.map((csprojUri) => ({
			csprojUri,
			dirPath: '/' + csprojUri.path.replace(/\/[^/]*$/, '').replace(/^\/+/, ''),
		}))
		.filter(({ dirPath }) => normalizedTarget === dirPath || normalizedTarget.startsWith(dirPath + '/'))
		.sort((a, b) => b.dirPath.split('/').length - a.dirPath.split('/').length);

	if (matched.length > 0) {
		return getCsprojParentDir(matched[0].csprojUri);
	}

	return null;
}

/**
 * Gets .csproj files that reside directly inside (or under) the given project folder.
 */
async function getCsprojsInFolder(projectFolder: vscode.Uri): Promise<vscode.Uri[]> {
	const normalizedFolder = '/' + projectFolder.path.replace(/^\/+/, '');

	const csprojs = await findAllCsprojs();
	return csprojs.filter((csprojUri) => {
		const normalizedCsproj = '/' + csprojUri.path.replace(/^\/+/, '');
		return (
			normalizedCsproj === normalizedFolder ||
			normalizedCsproj.startsWith(normalizedFolder + '/')
		);
	});
}

/**
 * Checks if a project root folder contains EntityFrameworkCore as a dependency.
 */
async function isEfCoreProject(projectFolder: vscode.Uri): Promise<boolean> {
	const csprojs = await getCsprojsInFolder(projectFolder);

	for (const csprojUri of csprojs) {
		try {
			const buf = await vscode.workspace.fs.readFile(csprojUri);
			const content = Buffer.from(buf).toString('utf-8');

			// Check for common EF Core package references
			if (
				content.includes('Microsoft.EntityFrameworkCore') ||
				content.includes('Npgsql.EntityFrameworkCore.PostgreSQL') ||
				content.includes('Pomelo.EntityFrameworkCore.MySql') ||
				content.includes('Microsoft.EntityFrameworkCore.SqlServer') ||
				content.includes('Microsoft.EntityFrameworkCore.Sqlite') ||
				content.includes('Npgsql')
			) {
				return true;
			}
		} catch {
			continue;
		}
	}

	return false;
}

/**
 * Runs a dotnet ef command in the project folder. */
async function runEfCoreCommand(
	command: string,
	projectFolder: vscode.Uri,
	additionalArgs: string[] = []
): Promise<void> {
	const args = [command, ...additionalArgs];

	// Find the .csproj file in the project folder
	const csprojs = await getCsprojsInFolder(projectFolder);

	if (csprojs.length === 0) {
		vscode.window.showErrorMessage('Entity Framework CMD: No .csproj file found in the selected folder.');
		return;
	}

	const csprojPath = '/' + csprojs[0].path.replace(/^\/+/, '');
	const fullArgs = [...args, `-p "${csprojPath}"`];

	// If a startup project is needed (e.g., for migrations), also pass -s
	const normalizedFolder = '/' + projectFolder.path.replace(/^\/+/, '');

	const allCsprojs = await findAllCsprojs();
	const startupCandidates = allCsprojs.filter((csprojUri) => {
		const csprojDir = '/' + csprojUri.path.replace(/\/[^/]*$/, '').replace(/^\/+/, '');
		const csprojParent = csprojDir.substring(0, csprojDir.lastIndexOf('/'));
		return csprojParent === normalizedFolder && '/' + csprojUri.path.replace(/^\/+/, '') !== csprojPath;
	});

	if (startupCandidates.length > 0) {
		const startupPath = '/' + startupCandidates[0].path.replace(/^\/+/, '');
		fullArgs.push(`-s ${startupPath}`);
	}

	// Ensure cwd is always a directory — strip .csproj suffix if present (belt & suspenders)
	let cwdPath = projectFolder.fsPath;
	if (cwdPath.endsWith('.csproj')) {
		cwdPath = cwdPath.replace(/\/[^/]*$/, '');
	}

	const terminal = vscode.window.createTerminal({
		name: `Entity Framework CMD — ${command.replace(/\s+/g, ' ')}`,
		cwd: cwdPath,
	});

	terminal.show();
	const dotnetCommand = `dotnet ${fullArgs.join(' ')}`;
	terminal.sendText(dotnetCommand);

	vscode.window.showInformationMessage(`Entity Framework CMD: Running "dotnet ${fullArgs.join(' ')}" in terminal.`);
}

/**
 * Generates a SQL script for migrations via interactive wizard.
 * Steps:
 *   1. Range type — all migrations, incremental (to latest), or specific pair
 *   2. If specific pair — enter from / to migration names
 *   3. Idempotent vs incremental script type
 *   4. Output — console (terminal) or file
 *   5. If file — ask for filename, write the script output to it
 */
export async function efCoreScriptMigration(projectFolder?: vscode.Uri): Promise<void> {
	let folder = projectFolder;

	if (!folder) {
		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document.uri.scheme === 'file') {
			const found = await findProjectRootFolder(editor.document.uri);
			if (found) {
				folder = found;
			}
		}
	}

	if (!folder) {
		vscode.window.showErrorMessage('Entity Framework CMD: No project folder selected.');
		return;
	}

	folder = await normalizeToProjectFolder(folder);

	const isEf = await isEfCoreProject(folder);
	if (!isEf) {
		vscode.window.showErrorMessage('Entity Framework CMD: The selected project does not appear to have EF Core installed.');
		return;
	}

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Generating migration script…' },
		async () => {
			const args = await buildScriptMigrationArgs(folder);
			if (!args) {
				return; // cancelled or failed
			}

			// Check output mode: file vs console
			const outputMode = await vscode.window.showQuickPick(
				[
					{ label: 'Console', description: 'Output to terminal', id: 'console' },
					{ label: 'File', description: 'Save to .sql file', id: 'file' },
				],
				{ placeHolder: 'Select output mode:' }
			);

			if (!outputMode) {
				return; // cancelled
			}

			const cwdPath = folder.fsPath.endsWith('.csproj') ? folder.fsPath.replace(/\/[^/]*$/, '') : folder.fsPath;

			if (outputMode.id === 'file') {
				const fileName = await vscode.window.showInputBox({
					title: 'EF Core Script Migration',
					placeHolder: 'migration.sql',
					prompt: 'Enter the output file name.',
				});

				if (!fileName?.trim()) {
					return;
				}

				const fullArgs = ['ef', 'migrations', 'script'];
				fullArgs.push(...args, '-o', fileName.trim());

				const terminal = vscode.window.createTerminal({
					name: `EF Core Script — ${fileName.trim()}`,
					cwd: cwdPath,
				});

				terminal.show();
				const escapedArgs = fullArgs.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ');
				terminal.sendText(`dotnet ${escapedArgs}`);

				vscode.window.showInformationMessage(
					`Entity Framework CMD: Script saved to ${fileName.trim()} (check the terminal for output).`
				);
			} else {
				const fullArgs = ['ef', 'migrations', 'script'];
				fullArgs.push(...args);

				const terminal = vscode.window.createTerminal({
					name: `EF Core Script — ${fullArgs.join(' ')}`,
					cwd: cwdPath,
				});

				terminal.show();
				const escapedArgs = fullArgs.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ');
				terminal.sendText(`dotnet ${escapedArgs}`);

				vscode.window.showInformationMessage('Entity Framework CMD: Migration script output shown in terminal.');
			}
		}
	);
}

/**
 * Interactive wizard to build --from, --to, and --idempotent arguments for 'ef migrations script'.
 * Returns an array of CLI argument strings (without the command itself). */
async function buildScriptMigrationArgs(_projectFolder: vscode.Uri): Promise<string[]> {
	// Step 1: Choose range type
	const rangeType = await vscode.window.showQuickPick(
		[
			{ label: 'All Migrations', description: 'Generate script for all migrations (from empty to latest)', id: 'all' },
			{ label: 'Incremental', description: 'Script between two specific migrations', id: 'range' },
			{ label: 'To Latest', description: 'Script from empty to the latest migration', id: 'latest' },
		],
		{ placeHolder: 'Select migration range:' }
	);

	if (!rangeType) {
		return []; // cancelled
	}

	const args: string[] = [];

	if (rangeType.id === 'all' || rangeType.id === 'latest') {
		// No --from / --to needed; only idempotent option
	} else if (rangeType.id === 'range') {
		const fromName = await vscode.window.showInputBox({
			title: 'EF Core Script Migration',
			placeHolder: 'InitialCreate',
			prompt: 'Enter the "from" migration name (or __Initial to start from empty).',
		});

		if (!fromName?.trim()) {
			return []; // cancelled
		}
		args.push('--from', fromName.trim());

		const toName = await vscode.window.showInputBox({
			title: 'EF Core Script Migration',
			placeHolder: '20240101000000_AddUsers',
			prompt: 'Enter the "to" migration name.',
		});

		if (!toName?.trim()) {
			return []; // cancelled
		}
		args.push('--to', toName.trim());
	}

	// Step 3: Idempotent vs incremental
	const idempotent = await vscode.window.showQuickPick(
		[
			{ label: 'Idempotent', description: 'Generates a script that can be applied to any database state (--idempotent)', id: true },
			{ label: 'Incremental', description: 'Generates script only for the selected migrations (--no-idempotent)', id: false },
		],
		{ placeHolder: 'Script type:' }
	);

	if (!idempotent) {
		return []; // cancelled
	}

	if (idempotent.id === true) {
		args.push('--idempotent');
	}

	return args;
}

// ============================================================================
// EF Core CLI commands — exported helpers
// ============================================================================

/**
 * Creates a new migration. */
export async function efCoreAddMigration(projectFolder?: vscode.Uri): Promise<void> {
	let folder = projectFolder;

	if (!folder) {
		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document.uri.scheme === 'file') {
			const found = await findProjectRootFolder(editor.document.uri);
			if (found) {
				folder = found;
			}
		}
	}

	if (!folder) {
		vscode.window.showErrorMessage('Entity Framework CMD: No project folder selected.');
		return;
	}

	folder = await normalizeToProjectFolder(folder);

	const isEf = await isEfCoreProject(folder);
	if (!isEf) {
		vscode.window.showErrorMessage('Entity Framework CMD: The selected project does not appear to have EF Core installed.');
		return;
	}

	const migrationName = await vscode.window.showInputBox({
		title: 'EF Core Add Migration',
		placeHolder: 'MigrationName',
		prompt: 'Enter a name for the migration.',
	});

	if (!migrationName?.trim()) {
		return;
	}

	vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Adding migration '${migrationName}'…` },
		async () => {
			await runEfCoreCommand('ef migrations add', folder, [migrationName.trim()]);
		}
	);
}

/**
 * Updates the database to the latest migration. */
export async function efCoreUpdateDatabase(projectFolder?: vscode.Uri): Promise<void> {
	let folder = projectFolder;

	if (!folder) {
		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document.uri.scheme === 'file') {
			const found = await findProjectRootFolder(editor.document.uri);
			if (found) {
				folder = found;
			}
		}
	}

	if (!folder) {
		vscode.window.showErrorMessage('Entity Framework CMD: No project folder selected.');
		return;
	}

	folder = await normalizeToProjectFolder(folder);

	const isEf = await isEfCoreProject(folder);
	if (!isEf) {
		vscode.window.showErrorMessage('Entity Framework CMD: The selected project does not appear to have EF Core installed.');
		return;
	}

	vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Updating database…' },
		async () => {
			await runEfCoreCommand('ef database update', folder);
		}
	);
}

/**
 * Lists all migrations. */
export async function efCoreListMigrations(projectFolder?: vscode.Uri): Promise<void> {
	let folder = projectFolder;

	if (!folder) {
		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document.uri.scheme === 'file') {
			const found = await findProjectRootFolder(editor.document.uri);
			if (found) {
				folder = found;
			}
		}
	}

	if (!folder) {
		vscode.window.showErrorMessage('Entity Framework CMD: No project folder selected.');
		return;
	}

	folder = await normalizeToProjectFolder(folder);

	const isEf = await isEfCoreProject(folder);
	if (!isEf) {
		vscode.window.showErrorMessage('Entity Framework CMD: The selected project does not appear to have EF Core installed.');
		return;
	}

	vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Listing migrations…' },
		async () => {
			await runEfCoreCommand('ef migrations list', folder);
		}
	);
}

/**
 * Removes the last migration. */
export async function efCoreRemoveMigration(projectFolder?: vscode.Uri): Promise<void> {
	let folder = projectFolder;

	if (!folder) {
		const editor = vscode.window.activeTextEditor;
		if (editor && editor.document.uri.scheme === 'file') {
			const found = await findProjectRootFolder(editor.document.uri);
			if (found) {
				folder = found;
			}
		}
	}

	if (!folder) {
		vscode.window.showErrorMessage('Entity Framework CMD: No project folder selected.');
		return;
	}

	folder = await normalizeToProjectFolder(folder);

	const isEf = await isEfCoreProject(folder);
	if (!isEf) {
		vscode.window.showErrorMessage('Entity Framework CMD: The selected project does not appear to have EF Core installed.');
		return;
	}

	vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Removing last migration…' },
		async () => {
			await runEfCoreCommand('ef migrations remove', folder);
		}
	);
}
