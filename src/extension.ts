import * as vscode from 'vscode';
import { type CType } from './types.js';
import { createCSharpFile } from './services/createFile.js';
import { renameFileByType, renameFilesByTypeInFolder } from './services/renameFile.js';
import { adjustNamespaceForFolder, adjustNamespaceForSingleFile } from './services/namespaceAdjuster.js';
import { sortUsingsInFile, sortUsingsInFolder } from './services/sortUsings.js';
import { extractInterfaceFromFile } from './services/extractInterface.js';
import { uriIsDirectory, uriIsFile } from './utils/fileUtils.js';
import { detectMediatorFile } from './utils/contentParser.js';
import {
	runDiagnosticsForDocument,
	runDiagnosticsForUri,
	runDiagnosticsForWorkspace,
} from './diagnostics/diagnosticsProvider.js';
import { CSharpDiagnosticsCodeActionProvider } from './diagnostics/codeActionProvider.js';
import { MapToCodeActionProvider } from './codeActions/mapToCodeActionProvider.js';
import { GoToHandlerCodeActionProvider } from './codeActions/goToHandlerCodeActionProvider.js';
import { generateMapToForDocument, generateMapFromForDocument } from './services/generateMapTo.js';
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
} from './services/efCoreCommands.js';

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

/**
 * Validates the selected URI and returns appropriate error messages.
 */
function validateUri(uri: vscode.Uri | undefined, requireCsFile: boolean = false): string | undefined {
	if (!uri) {
		return 'No file or folder selected.';
	}

	if (uri.scheme !== 'file') {
		return 'Only local files and folders are supported.';
	}

	if (requireCsFile && !uri.path.endsWith('.cs')) {
		return 'This command only works on .cs files.';
	}

	return undefined;
}

/**
 * Activates the CSharp Painkiller extension.
 * Registers all commands, diagnostics, and event subscriptions.
 */
export function activate(context: vscode.ExtensionContext) {
	// -------------------------------------------------------------------------
	// Diagnostics setup
	// -------------------------------------------------------------------------
	const diagnosticCollection = vscode.languages.createDiagnosticCollection('csharppainkiller');
	context.subscriptions.push(diagnosticCollection);

	// Register Code Action provider for quick fixes
	const codeActionProvider = vscode.languages.registerCodeActionsProvider(
		{ language: 'csharp', scheme: 'file' },
		new CSharpDiagnosticsCodeActionProvider(),
		{ providedCodeActionKinds: CSharpDiagnosticsCodeActionProvider.providedCodeActionKinds }
	);
	context.subscriptions.push(codeActionProvider);

	// Register Code Action provider for MapTo generation
	const mapToCodeActionProvider = vscode.languages.registerCodeActionsProvider(
		{ language: 'csharp', scheme: 'file' },
		new MapToCodeActionProvider(),
		{ providedCodeActionKinds: MapToCodeActionProvider.providedCodeActionKinds }
	);
	context.subscriptions.push(mapToCodeActionProvider);

	// Register Code Action provider for Go to Handler
	const goToHandlerCodeActionProvider = vscode.languages.registerCodeActionsProvider(
		{ language: 'csharp', scheme: 'file' },
		new GoToHandlerCodeActionProvider(),
		{ providedCodeActionKinds: GoToHandlerCodeActionProvider.providedCodeActionKinds }
	);
	context.subscriptions.push(goToHandlerCodeActionProvider);

	// Register MapTo command
	const generateMapToDisposable = vscode.commands.registerCommand(
		'csharppainkiller.generateMapTo',
		async (document?: vscode.TextDocument) => {
			const doc = document ?? vscode.window.activeTextEditor?.document;
			if (!doc || !doc.uri.path.endsWith('.cs')) {
				vscode.window.showErrorMessage('CSharp Painkiller: Open a .cs file to generate a MapTo method.');
				return;
			}
			await generateMapToForDocument(doc);
		}
	);
	context.subscriptions.push(generateMapToDisposable);

	// Register MapFrom command
	const generateMapFromDisposable = vscode.commands.registerCommand(
		'csharppainkiller.generateMapFrom',
		async (document?: vscode.TextDocument) => {
			const doc = document ?? vscode.window.activeTextEditor?.document;
			if (!doc || !doc.uri.path.endsWith('.cs')) {
				vscode.window.showErrorMessage('CSharp Painkiller: Open a .cs file to generate a MapFrom method.');
				return;
			}
			await generateMapFromForDocument(doc);
		}
	);
	context.subscriptions.push(generateMapFromDisposable);

	// Run diagnostics on all open editors at startup and scan workspace
	runDiagnosticsForWorkspace(diagnosticCollection).catch(() => { /* ignore startup errors */ });

	// Re-run diagnostics when a document is opened or its content changes (on save)
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(doc => {
			runDiagnosticsForDocument(doc, diagnosticCollection).catch(() => { });
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(doc => {
			runDiagnosticsForDocument(doc, diagnosticCollection).catch(() => { });
		})
	);

	// FileSystemWatcher catches changes made outside VS Code (terminal, git, external tools).
	// onDidDeleteFiles / onDidRenameFiles only fire for operations done inside VS Code Explorer.
	const watcher = vscode.workspace.createFileSystemWatcher('**/*.cs');
	context.subscriptions.push(watcher);

	// File created on disk → analyse it
	watcher.onDidCreate(uri => {
		runDiagnosticsForUri(uri, diagnosticCollection).catch(() => { });
	});

	// File changed on disk → re-analyse
	watcher.onDidChange(uri => {
		runDiagnosticsForUri(uri, diagnosticCollection).catch(() => { });
	});

	// File deleted on disk → remove its diagnostics
	watcher.onDidDelete(uri => {
		diagnosticCollection.delete(uri);
	});

	// Also handle renames/deletes done via VS Code Explorer (fired before watcher sees them)
	context.subscriptions.push(
		vscode.workspace.onDidDeleteFiles(event => {
			for (const uri of event.files) {
				diagnosticCollection.delete(uri);
			}
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidRenameFiles(event => {
			for (const { oldUri, newUri } of event.files) {
				diagnosticCollection.delete(oldUri);
				runDiagnosticsForUri(newUri, diagnosticCollection).catch(() => { });
			}
		})
	);

	context.subscriptions.push(
		vscode.workspace.onDidCreateFiles(event => {
			for (const uri of event.files) {
				runDiagnosticsForUri(uri, diagnosticCollection).catch(() => { });
			}
		})
	);

	// Re-run workspace diagnostics when the user changes analyzer settings
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('csharppainkiller.diagnostics')) {
				runDiagnosticsForWorkspace(diagnosticCollection).catch(() => { });
			}
		})
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
	updateMediatorContext(vscode.window.activeTextEditor?.document.uri).catch(() => { });

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(editor => {
			updateMediatorContext(editor?.document.uri).catch(() => { });
		})
	);

	// Also refresh when a .cs file is saved (content may have changed)
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(doc => {
			if (doc.uri === vscode.window.activeTextEditor?.document.uri) {
				updateMediatorContext(doc.uri).catch(() => { });
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
			const error = validateUri(uri);
			if (error) {
				vscode.window.showErrorMessage(error);
				return;
			}

			const uriValue = uri!;

			if (await uriIsDirectory(uriValue)) {
				await adjustNamespaceForFolder(uriValue);
			} else if (await uriIsFile(uriValue)) {
				const fileError = validateUri(uriValue, true);
				if (fileError) {
					vscode.window.showErrorMessage(fileError);
					return;
				}
				await adjustNamespaceForSingleFile(uriValue);

				// After fixing namespace, refresh diagnostics for this file
				runDiagnosticsForUri(uriValue, diagnosticCollection).catch(() => { });
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
			const error = validateUri(uri);
			if (error) {
				vscode.window.showErrorMessage(error);
				return;
			}

			const uriValue = uri!;

			if (await uriIsDirectory(uriValue)) {
				await renameFilesByTypeInFolder(uriValue);
			} else if (await uriIsFile(uriValue)) {
				const fileError = validateUri(uriValue, true);
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
			const error = validateUri(uri);
			if (error) {
				vscode.window.showErrorMessage(error);
				return;
			}

			const uriValue = uri!;

			if (await uriIsDirectory(uriValue)) {
				await sortUsingsInFolder(uriValue);
			} else if (await uriIsFile(uriValue)) {
				const fileError = validateUri(uriValue, true);
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
			const error = validateUri(uri, true);
			if (error) {
				vscode.window.showErrorMessage(error);
				return;
			}

			await extractInterfaceFromFile(uri!);
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
}

/**
 * Deactivates the extension.
 */
export function deactivate() {
	// Cleanup if needed
}
