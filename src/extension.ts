import * as vscode from 'vscode';
import { type CType } from './types.js';
import { createCSharpFile } from './services/createFile.js';
import { renameFileByType, renameFilesByTypeInFolder } from './services/renameFile.js';
import { adjustNamespaceForFolder, adjustNamespaceForSingleFile } from './services/namespaceAdjuster.js';
import { sortUsingsInFile, sortUsingsInFolder } from './services/sortUsings.js';
import { extractInterfaceFromFile } from './services/extractInterface.js';
import { uriIsDirectory, uriIsFile } from './utils/fileUtils.js';
import { detectMediatorFile } from './utils/contentParser.js';
import { ExtractTypeCodeActionProvider } from './codeActions/extractTypeCodeActionProvider.js';
import { extractTypeToFile } from './services/extractTypeToFile.js';
import { generateMapToForDocument, generateMapFromForDocument } from './services/generateMapTo.js';
import { generateDtoForDocument } from './services/generateDto.js';
import { generateFluentValidatorForDocument } from './services/generateFluentValidator.js';
import { registerTypeAndFileNameSync } from './services/syncTypeAndFileName.js';
import {
	createEmptyController,
	createEfCrudController,
	createEmptyMinimalApi,
	createEfCrudMinimalApi,
	generateHandlerForFile,
	goToHandlerForFile,
	createMediatRRequestAndHandler,
	createMediatRRequest,
	createMediatRHandler,
	createMediatRNotificationAndHandler,
	createMediatRNotification,
	createMediatRNotificationHandler,
	createMediatREmptyPipelineBehavior,
	createMediatRFluentValidationBehavior,
	createMitMediatorRequestAndHandler,
	createMitMediatorRequest,
	createMitMediatorHandler,
	createMitMediatorNotificationAndHandler,
	createMitMediatorNotification,
	createMitMediatorNotificationHandler,
	createMitMediatorEmptyPipelineBehavior,
	createMitMediatorFluentValidationBehavior,
} from './services/templateCommands.js';
import {
	createEfCoreConfigurationFromFolder,
	createEfCoreConfigurationFromFile,
	efCoreAddMigration,
	efCoreUpdateDatabase,
	efCoreListMigrations,
	efCoreScriptMigration,
	efCoreRemoveMigration,
} from './services/efCoreCommands.js';
import { validateUri as validateSharedUri, resolveCommandFileContext } from './utils/sharedUtilities.js';

import { CsprojCache } from './utils/csprojCache.js';
import { ProjectTypeIndex } from './utils/projectTypeIndex.js';
import { fetchDotnetTemplates, registerDynamicTemplateCommands } from './services/dotnetTemplates.js';
import { CsprojFolderDecorationProvider } from './decoration/csprojFolderDecorationProvider.js';
import { CsprojProjectsTreeProvider } from './decoration/csprojProjectsTreeProvider.js';
import { ParserCache } from './codeActions/parserCache.js';
import { runDiagnosticsForDocument, runDiagnosticsForOpenEditors, clearDiagnosticsCacheForUri, clearDiagnosticsCache } from './diagnostics/diagnosticsProvider.js';
import { scheduleDiagnosticsForDocumentChange, clearDebounceForDocument } from './diagnostics/scheduler.js';
import { CSharpDiagnosticsCodeActionProvider } from './diagnostics/codeActionProvider.js';
import { analyzeSolutionCommand } from './services/analyzeSolution.js';
import { migrateSolutionToCentralPackageManagement } from './services/migrateToCentralPackageManagement.js';

/**
 * List of all "Create" commands for C# types.
 */
const CREATE_COMMANDS: { id: string; type: CType }[] = [
	{ id: 'csharppainkiller.createClass', type: 'class' },
	{ id: 'csharppainkiller.createRecord', type: 'record' },
	{ id: 'csharppainkiller.createStruct', type: 'struct' },
	{ id: 'csharppainkiller.createEnum', type: 'enum' },
	{ id: 'csharppainkiller.createInterface', type: 'interface' },
	{ id: 'csharppainkiller.createRecordStruct', type: 'record struct' },
];

// Alias validateUri for backward compatibility with existing code
const validateUri = validateSharedUri;

/**
 * Activates the CSharp Painkiller extension.
 * Registers all commands, diagnostics, and event subscriptions.
 * Uses built-in VSCode language providers for C# analysis (C# DevKit optional).
 */
export async function activate(context: vscode.ExtensionContext) {
	console.log('CSharp Painkiller is starting...');
	await updateHasSolutionContext();
	const solutionContextWatcher = vscode.workspace.createFileSystemWatcher('**/*.{sln,slnx}');
	context.subscriptions.push(
		solutionContextWatcher,
		solutionContextWatcher.onDidCreate(() => updateHasSolutionContext()),
		solutionContextWatcher.onDidDelete(() => updateHasSolutionContext())
	);

		// -------------------------------------------------------------------------
	// Initialize CsprojCache — discover .csproj files once, then cache
	// -------------------------------------------------------------------------
	const csprojCache = CsprojCache.getInstance();
	await csprojCache.initialize(context);
	console.log('CsprojCache initialized');

	// -------------------------------------------------------------------------
	// Initialize ProjectTypeIndex — backs the cross-file diagnostics (request-without-
	// handler, duplicate-type-name). Scans the workspace in the background (not awaited)
	// so activation isn't delayed by a full .cs file scan on large solutions; kept fresh
	// afterwards via a file watcher and via live document updates from the diagnostics pipeline.
	// -------------------------------------------------------------------------
	void ProjectTypeIndex.getInstance().initialize(context);

	// -------------------------------------------------------------------------
	// Register file decoration provider for csproj folders
	// -------------------------------------------------------------------------
	const decorationProvider = new CsprojFolderDecorationProvider();
	await decorationProvider.initialize();
	const projectsTreeProvider = new CsprojProjectsTreeProvider(context.extensionUri, () => decorationProvider.refresh());
	const projectsTreeView = vscode.window.createTreeView('csharppainkiller.projects', {
		treeDataProvider: projectsTreeProvider,
		dragAndDropController: projectsTreeProvider,
		showCollapseAll: false,
	});
	projectsTreeProvider.bindTreeView(projectsTreeView);
	context.subscriptions.push(
		vscode.window.registerFileDecorationProvider(decorationProvider),
		projectsTreeView,
		projectsTreeProvider,
		vscode.commands.registerCommand('csharppainkiller.revealProjectFolder', async (uri: vscode.Uri) => {
			await vscode.commands.executeCommand('revealInExplorer', uri);
		}),
		vscode.commands.registerCommand('csharppainkiller.projects.createProject', async (item?: { createProjectUri?: vscode.Uri; createFolderTarget?: unknown }) => {
			const selectedItem = item ?? projectsTreeView.selection[0];
			await vscode.commands.executeCommand('csharppainkiller.dotnet.createProject', selectedItem?.createFolderTarget ?? selectedItem?.createProjectUri);
			await decorationProvider.refresh();
			projectsTreeProvider.refresh();
		}),
		vscode.commands.registerCommand('csharppainkiller.projects.createFolder', async (item) => {
			await projectsTreeProvider.createSolutionFolder(item ?? projectsTreeView.selection[0]);
		}),
		vscode.commands.registerCommand('csharppainkiller.projects.deleteFolder', async (item) => {
			await projectsTreeProvider.deleteSolutionFolder(item);
		}),
		vscode.commands.registerCommand('csharppainkiller.projects.excludeProject', async (item) => {
			await projectsTreeProvider.excludeProject(item);
		}),
		vscode.commands.registerCommand('csharppainkiller.projects.includeProject', async (item) => {
			await projectsTreeProvider.includeProject(item);
		}),
		vscode.commands.registerCommand('csharppainkiller.projects.deleteProject', async (item) => {
			await projectsTreeProvider.deleteProject(item);
		}),
		vscode.commands.registerCommand('csharppainkiller.projects.addProjectReference', async (item) => {
			await projectsTreeProvider.addProjectReference(item);
		}),
		vscode.commands.registerCommand('csharppainkiller.projects.removeProjectReference', async (item) => {
			await projectsTreeProvider.removeProjectReference(item);
		}),
		vscode.commands.registerCommand('csharppainkiller.projects.addPackageReference', async (item) => {
			await projectsTreeProvider.addPackageReference(item ?? projectsTreeView.selection[0]);
		}),
		vscode.commands.registerCommand('csharppainkiller.projects.removePackageReference', async (item) => {
			await projectsTreeProvider.removePackageReference(item ?? projectsTreeView.selection[0]);
		}),
		vscode.commands.registerCommand('csharppainkiller.projects.updatePackageReference', async (item) => {
			await projectsTreeProvider.updatePackageReference(item ?? projectsTreeView.selection[0]);
		}),
		vscode.commands.registerCommand('csharppainkiller.projects.updateAllPackageReferences', async (item) => {
			await projectsTreeProvider.updateAllPackageReferences(item ?? projectsTreeView.selection[0]);
		}),
		vscode.commands.registerCommand('csharppainkiller.projects.checkPackageUpdates', async (item) => {
			await projectsTreeProvider.checkPackageUpdates(item ?? projectsTreeView.selection[0]);
		}),
		vscode.commands.registerCommand('csharppainkiller.projects.openPackageVulnerability', async (item) => {
			await projectsTreeProvider.openPackageVulnerability(item ?? projectsTreeView.selection[0]);
		}),
		vscode.commands.registerCommand('csharppainkiller.projects.migrateToCentralPackageManagement', async (uri?: vscode.Uri) => {
			await migrateSolutionToCentralPackageManagement(uri);
		})
	);
	console.log('File decoration provider registered');

	const extractTypeCodeActionProvider = vscode.languages.registerCodeActionsProvider(
		{ language: 'csharp', scheme: 'file' },
		new ExtractTypeCodeActionProvider(),
		{ providedCodeActionKinds: ExtractTypeCodeActionProvider.providedCodeActionKinds }
	);
	context.subscriptions.push(extractTypeCodeActionProvider);

	const parserCache = ParserCache.getInstance();
	context.subscriptions.push(
		vscode.workspace.onDidChangeTextDocument(event => {
			if (event.document.languageId === 'csharp') {
				parserCache.clearAllCaches(event.document);
			}
		}),
		vscode.workspace.onDidCloseTextDocument(document => {
			if (document.languageId === 'csharp') {
				parserCache.clearAllCaches(document);
			}
		})
	);
	registerTypeAndFileNameSync(context);

	// -------------------------------------------------------------------------
	// Diagnostics: namespace-mismatch (and other opt-in) warnings.
	// Only analyzes files that are currently open in editors — never scans the
	// whole workspace — and edits are debounced + content-hash cached to keep
	// performance impact minimal.
	// -------------------------------------------------------------------------
	const diagnosticCollection = vscode.languages.createDiagnosticCollection('csharppainkiller');
	context.subscriptions.push(diagnosticCollection);

	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			{ language: 'csharp', scheme: 'file' },
			new CSharpDiagnosticsCodeActionProvider(),
			{ providedCodeActionKinds: CSharpDiagnosticsCodeActionProvider.providedCodeActionKinds }
		)
	);

	// Analyze .cs files already open in editors at startup (no workspace-wide scan).
	void runDiagnosticsForOpenEditors(diagnosticCollection);

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(document => {
			if (document.languageId === 'csharp' && document.uri.scheme === 'file') {
				void runDiagnosticsForDocument(document, diagnosticCollection);
			}
		}),
		vscode.workspace.onDidChangeTextDocument(event => {
			if (event.document.languageId === 'csharp' && event.document.uri.scheme === 'file') {
				scheduleDiagnosticsForDocumentChange(event.document, diagnosticCollection);
			}
		}),
		vscode.workspace.onDidCloseTextDocument(document => {
			if (document.languageId === 'csharp') {
				diagnosticCollection.delete(document.uri);
				clearDiagnosticsCacheForUri(document.uri);
				clearDebounceForDocument(document);
			}
		})
	);

	// Re-analyze open editors immediately when diagnostics settings change, instead of
	// waiting for the next edit (the cache key already includes the enabled flags, but
	// the Problems panel otherwise wouldn't refresh until something triggers re-analysis).
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(event => {
			if (
				event.affectsConfiguration('csharppainkiller.diagnostics') ||
				event.affectsConfiguration('csharppainkiller.diagnosticDebounceDelay')
			) {
				clearDiagnosticsCache();
				void runDiagnosticsForOpenEditors(diagnosticCollection);
			}
		})
	);

	// "Analyze Solution" — on-demand deep scan of every .cs file in the workspace, with a
	// picker to choose which analyzers to run for this one-off run (all enabled by default).
	context.subscriptions.push(
		vscode.commands.registerCommand('csharppainkiller.analyzeSolution', async () => {
			await analyzeSolutionCommand(diagnosticCollection);
		})
	);

	// Register MapTo command
	const generateMapToDisposable = vscode.commands.registerCommand(
		'csharppainkiller.generateMapTo',
		async (...args: unknown[]) => {
			const ctx = await resolveCommandFileContext(...args);
			if (!ctx) {
				vscode.window.showErrorMessage('CSharp Painkiller: Open a .cs file to generate a MapTo method.');
				return;
			}
			await generateMapToForDocument(ctx.document, ctx.typeName);
		}
	);
	context.subscriptions.push(generateMapToDisposable);

	// Register MapFrom command
	const generateMapFromDisposable = vscode.commands.registerCommand(
		'csharppainkiller.generateMapFrom',
		async (...args: unknown[]) => {
			const ctx = await resolveCommandFileContext(...args);
			if (!ctx) {
				vscode.window.showErrorMessage('CSharp Painkiller: Open a .cs file to generate a MapFrom method.');
				return;
			}
			await generateMapFromForDocument(ctx.document, ctx.typeName);
		}
	);
	context.subscriptions.push(generateMapFromDisposable);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.extractTypeToFile',
			async (...args: unknown[]) => {
				const ctx = await resolveCommandFileContext(...args);
				if (!ctx?.typeName) {
					vscode.window.showErrorMessage('CSharp Painkiller: Place the cursor on a type name to extract it to a file.');
					return;
				}
				await extractTypeToFile(ctx.document, ctx.typeName);
			}
		)
	);

	// Register Generate DTO command
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.generateDto',
			async (...args: unknown[]) => {
				const ctx = await resolveCommandFileContext(...args);
				if (!ctx) {
					vscode.window.showErrorMessage('CSharp Painkiller: Open a .cs file to generate a DTO.');
					return;
				}
				await generateDtoForDocument(ctx.document, ctx.typeName);
			}
		)
	);

	// Register FluentValidation validator command
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.generateFluentValidator',
			async (...args: unknown[]) => {
				const ctx = await resolveCommandFileContext(...args);
				if (!ctx) {
					vscode.window.showErrorMessage('CSharp Painkiller: Open a .cs file to generate a validator.');
					return;
				}
				await generateFluentValidatorForDocument(ctx.document, ctx.typeName);
			}
		)
	);


	// -------------------------------------------------------------------------
	// Mediator file context key
	// Sets `csharppainkiller.isMediatorFile` based on the active editor content,
	// so that "Generate Handler" and "Go To Handler" menu items are only shown
	// when a file containing IRequest / INotification is active.
	// -------------------------------------------------------------------------
	async function updateMediatorContext(uri: vscode.Uri | undefined): Promise<void> {
		if (!uri || !uri.path.endsWith('.cs') || uri.scheme !== 'file') {
			await vscode.commands.executeCommand('setContext', 'csharppainkiller.isMediatorFile', false);
			return;
		}
		try {
			const buf = await vscode.workspace.fs.readFile(uri);
			const content = Buffer.from(buf).toString('utf-8');
			const info = detectMediatorFile(content);
			await vscode.commands.executeCommand('setContext', 'csharppainkiller.isMediatorFile', info !== null);
		} catch {
			await vscode.commands.executeCommand('setContext', 'csharppainkiller.isMediatorFile', false);
		}
	}

	// Run on startup for the already-active editor
	updateMediatorContext(vscode.window.activeTextEditor?.document.uri).catch((error) => {
		console.warn('Failed to update mediator context on startup:', error);
	});

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(editor => {
			updateMediatorContext(editor?.document.uri).catch((error) => {
				console.warn('Failed to update mediator context on editor change:', error);
			});
		})
	);

	// Also refresh when a .cs file is saved (content may have changed)
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(doc => {
			if (doc.uri === vscode.window.activeTextEditor?.document.uri) {
				updateMediatorContext(doc.uri).catch((error) => {
					console.warn('Failed to update mediator context on save:', error);
				});
			}
		})
	);

	// -------------------------------------------------------------------------
	// "Create" commands (class, record, struct, etc.)
	// -------------------------------------------------------------------------
	for (const cmd of CREATE_COMMANDS) {
		const disposable = vscode.commands.registerCommand(cmd.id, async (uri?: vscode.Uri) => {
			await createCSharpFile(cmd.type, uri);
		});
		context.subscriptions.push(disposable);
	}

	// -------------------------------------------------------------------------
	// "Adjust Namespace" command
	// -------------------------------------------------------------------------
	const adjustNamespaceDisposable = vscode.commands.registerCommand(
		'csharppainkiller.adjustNamespace',
		async (uri?: vscode.Uri) => {
			const uriValue = uri;
			if (!uriValue) {
				vscode.window.showErrorMessage('No file or folder selected.');
				return;
			}

			if (await uriIsDirectory(uriValue)) {
				await adjustNamespaceForFolder(uriValue);
			} else if (await uriIsFile(uriValue)) {
				const fileError = validateUri(uriValue, { requireCsFile: true });
				if (fileError) {
					vscode.window.showErrorMessage(fileError);
					return;
				}
				await adjustNamespaceForSingleFile(uriValue);
			} else {
				vscode.window.showErrorMessage('Unsupported file type.');
			}
		}
	);

	// -------------------------------------------------------------------------
	// "Rename File By Type" command
	// -------------------------------------------------------------------------
	const renameFileByTypeDisposable = vscode.commands.registerCommand(
		'csharppainkiller.renameFileByType',
		async (uri?: vscode.Uri) => {
			const uriValue = uri;
			if (!uriValue) {
				vscode.window.showErrorMessage('No file or folder selected.');
				return;
			}

			if (await uriIsDirectory(uriValue)) {
				await renameFilesByTypeInFolder(uriValue);
			} else if (await uriIsFile(uriValue)) {
				const fileError = validateUri(uriValue, { requireCsFile: true });
				if (fileError) {
					vscode.window.showErrorMessage(fileError);
					return;
				}
				// For single file, open the renamed file; for folder batch, don't open
				const result = await renameFileByType(uriValue, true);
				vscode.window.showInformationMessage(result.message);
			} else {
				vscode.window.showErrorMessage('Unsupported file type.');
			}
		}
	);

	// -------------------------------------------------------------------------
	// "Sort Usings" command
	// -------------------------------------------------------------------------
	const sortUsingsDisposable = vscode.commands.registerCommand(
		'csharppainkiller.sortUsings',
		async (uri?: vscode.Uri) => {
			const uriValue = uri;
			if (!uriValue) {
				vscode.window.showErrorMessage('No file or folder selected.');
				return;
			}

			if (await uriIsDirectory(uriValue)) {
				await sortUsingsInFolder(uriValue);
			} else if (await uriIsFile(uriValue)) {
				const fileError = validateUri(uriValue, { requireCsFile: true });
				if (fileError) {
					vscode.window.showErrorMessage(fileError);
					return;
				}
				const result = await sortUsingsInFile(uriValue);
				vscode.window.showInformationMessage(result.message);
			} else {
				vscode.window.showErrorMessage('Unsupported file type.');
			}
		}
	);

	// -------------------------------------------------------------------------
	// "Extract Interface" command
	// -------------------------------------------------------------------------
	const extractInterfaceDisposable = vscode.commands.registerCommand(
		'csharppainkiller.extractInterface',
		async (uri?: vscode.Uri) => {
			const uriValue = uri;
			if (!uriValue) {
				vscode.window.showErrorMessage('No file or folder selected.');
				return;
			}

			if (!uriValue.path.endsWith('.cs')) {
				vscode.window.showErrorMessage('This command only works on .cs files.');
				return;
			}

			await extractInterfaceFromFile(uriValue);
		}
	);

	context.subscriptions.push(adjustNamespaceDisposable);
	context.subscriptions.push(renameFileByTypeDisposable);
	context.subscriptions.push(sortUsingsDisposable);
	context.subscriptions.push(extractInterfaceDisposable);

		// -------------------------------------------------------------------------
	// "C# Generate Handler" / "C# Go To Handler" context menu commands
	// -------------------------------------------------------------------------
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.generateHandlerForFile',
			(uri?: vscode.Uri) => generateHandlerForFile(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.goToHandlerForFile',
			(uri?: vscode.Uri) => goToHandlerForFile(uri)
		)
	);

	// -------------------------------------------------------------------------
	// "C# Templates > ASP.NET" commands
	// -------------------------------------------------------------------------
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.templates.aspnet.emptyController',
			(uri?: vscode.Uri) => createEmptyController(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.templates.aspnet.efCrudController',
			(uri?: vscode.Uri) => createEfCrudController(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.templates.aspnet.emptyMinimalApi',
			(uri?: vscode.Uri) => createEmptyMinimalApi(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.templates.aspnet.efCrudMinimalApi',
			(uri?: vscode.Uri) => createEfCrudMinimalApi(uri)
		)
	);

	// -------------------------------------------------------------------------
	// "C# EF Core" commands
	// -------------------------------------------------------------------------
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.efcore.createConfigurationFromFolder',
			(uri?: vscode.Uri) => createEfCoreConfigurationFromFolder(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.efcore.createConfigurationFromFile',
			(uri?: vscode.Uri) => createEfCoreConfigurationFromFile(uri)
		)
	);

	// -------------------------------------------------------------------------
	// "C# Entity Framework CMD" commands — dotnet ef CLI
	// -------------------------------------------------------------------------
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.efcore.cmd.addMigration',
			(uri?: vscode.Uri) => efCoreAddMigration(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.efcore.cmd.updateDatabase',
			(uri?: vscode.Uri) => efCoreUpdateDatabase(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.efcore.cmd.listMigrations',
			(uri?: vscode.Uri) => efCoreListMigrations(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.efcore.cmd.scriptMigration',
			(uri?: vscode.Uri) => efCoreScriptMigration(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.efcore.cmd.removeMigration',
			(uri?: vscode.Uri) => efCoreRemoveMigration(uri)
		)
	);

  // -------------------------------------------------------------------------
  // ".NET Project" commands — dynamically loaded from `dotnet new list`
  // -------------------------------------------------------------------------

  // Fetch templates and register dynamic commands at startup
  const dotnetTemplates = await fetchDotnetTemplates(context);

  // Register all dynamic template commands (including the unified createProject command)
  registerDynamicTemplateCommands(dotnetTemplates, context);

  // -------------------------------------------------------------------------
  // "C# Templates > MediatR" commands
  // -------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'csharppainkiller.templates.mediatr.createRequestAndHandler',
      (uri?: vscode.Uri) => createMediatRRequestAndHandler(uri)
    )
  );
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.templates.mediatr.createRequest',
			(uri?: vscode.Uri) => createMediatRRequest(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.templates.mediatr.createHandler',
			(uri?: vscode.Uri) => createMediatRHandler(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.templates.mediatr.createNotificationAndHandler',
			(uri?: vscode.Uri) => createMediatRNotificationAndHandler(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.templates.mediatr.createNotification',
			(uri?: vscode.Uri) => createMediatRNotification(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.templates.mediatr.createNotificationHandler',
			(uri?: vscode.Uri) => createMediatRNotificationHandler(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.templates.mediatr.createEmptyPipelineBehavior',
			(uri?: vscode.Uri) => createMediatREmptyPipelineBehavior(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.templates.mediatr.createFluentValidationBehavior',
			(uri?: vscode.Uri) => createMediatRFluentValidationBehavior(uri)
		)
	);

	// -------------------------------------------------------------------------
	// "C# Templates > MitMediator" commands
	// -------------------------------------------------------------------------
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.templates.mitmediator.createRequestAndHandler',
			(uri?: vscode.Uri) => createMitMediatorRequestAndHandler(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.templates.mitmediator.createRequest',
			(uri?: vscode.Uri) => createMitMediatorRequest(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.templates.mitmediator.createHandler',
			(uri?: vscode.Uri) => createMitMediatorHandler(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.templates.mitmediator.createNotificationAndHandler',
			(uri?: vscode.Uri) => createMitMediatorNotificationAndHandler(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.templates.mitmediator.createNotification',
			(uri?: vscode.Uri) => createMitMediatorNotification(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.templates.mitmediator.createNotificationHandler',
			(uri?: vscode.Uri) => createMitMediatorNotificationHandler(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.templates.mitmediator.createEmptyPipelineBehavior',
			(uri?: vscode.Uri) => createMitMediatorEmptyPipelineBehavior(uri)
		)
	);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'csharppainkiller.templates.mitmediator.createFluentValidationBehavior',
			(uri?: vscode.Uri) => createMitMediatorFluentValidationBehavior(uri)
		)
	);

	// -------------------------------------------------------------------------
	// Cleanup: dispose CsprojCache singleton on extension deactivation
	// -------------------------------------------------------------------------
	context.subscriptions.push({
		dispose: () => {
			csprojCache.dispose();
			decorationProvider.dispose();
		}
	});
}

async function updateHasSolutionContext(): Promise<void> {
	const solutionFiles = await vscode.workspace.findFiles('**/*.{sln,slnx}', '{**/bin/**,**/obj/**}');
	await vscode.commands.executeCommand('setContext', 'csharppainkiller.hasSolution', solutionFiles.length > 0);
}

export function deactivate() {
	// Dispose CsprojCache on extension deactivation
	CsprojCache.getInstance().dispose();
}
