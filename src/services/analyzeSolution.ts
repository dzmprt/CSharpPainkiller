import * as vscode from 'vscode';
import {
	runDiagnosticsForWorkspace,
	type AnalyzerSelection,
} from '../diagnostics/diagnosticsProvider.js';

/**
 * A single analyzer entry offered in the "Analyze Solution" picker.
 */
interface AnalyzerQuickPickItem extends vscode.QuickPickItem {
	key: keyof AnalyzerSelection;
}

const ANALYZER_ITEMS: AnalyzerQuickPickItem[] = [
	{
		key: 'wrongNamespace',
		label: '$(symbol-namespace) Namespace mismatch',
		description: "Namespace doesn't match the file's location in the project",
	},
	{
		key: 'wrongFilename',
		label: '$(file) Filename mismatch',
		description: "File name doesn't match the type it declares",
	},
	{
		key: 'unsortedUsings',
		label: '$(list-ordered) Unsorted usings',
		description: 'using directives are not sorted alphabetically',
	},
	{
		key: 'mixedLanguageIdentifiers',
		label: '$(globe) Mixed-language identifiers',
		description: 'Identifiers mix non-Latin and Latin characters',
	},
	{
		key: 'duplicateTypeName',
		label: '$(copy) Duplicate type name',
		description: 'Same type name declared in more than one file within the project',
	},
];

/**
 * Shows a multi-select picker for choosing which analyzers to run, with all
 * analyzers selected by default. Confirms either via the "Analyze" button, or
 * by pressing Enter (accept). Returns `undefined` if the user cancels (Escape /
 * closing the picker without confirming).
 */
async function pickAnalyzersToRun(): Promise<AnalyzerSelection | undefined> {
	const quickPick = vscode.window.createQuickPick<AnalyzerQuickPickItem>();
	quickPick.title = 'Analyze Solution';
	quickPick.placeholder = 'Select analyzers to run, then press Enter or click Analyze';
	quickPick.canSelectMany = true;
	quickPick.items = ANALYZER_ITEMS;
	quickPick.selectedItems = ANALYZER_ITEMS; // All analyzers enabled by default.
	quickPick.buttons = [
		{ iconPath: new vscode.ThemeIcon('play'), tooltip: 'Analyze' },
	];

	return await new Promise<AnalyzerSelection | undefined>(resolve => {
		let resolved = false;

		const confirm = () => {
			if (resolved) {
				return;
			}
			resolved = true;
			const selectedKeys = new Set(quickPick.selectedItems.map(item => item.key));
			resolve({
				wrongNamespace: selectedKeys.has('wrongNamespace'),
				wrongFilename: selectedKeys.has('wrongFilename'),
				unsortedUsings: selectedKeys.has('unsortedUsings'),
				mixedLanguageIdentifiers: selectedKeys.has('mixedLanguageIdentifiers'),
				duplicateTypeName: selectedKeys.has('duplicateTypeName'),
			});
			quickPick.hide();
		};

		quickPick.onDidAccept(confirm);
		quickPick.onDidTriggerButton(confirm);
		quickPick.onDidHide(() => {
			if (!resolved) {
				resolved = true;
				resolve(undefined); // Cancelled.
			}
			quickPick.dispose();
		});

		quickPick.show();
	});
}

/**
 * Entry point for the "Analyze Solution" command. Prompts the user to pick which
 * analyzers to run (all selected by default), then performs a one-off, cancellable,
 * progress-reported scan of every `.cs` file in the workspace (excluding bin/obj).
 *
 * Unlike the always-on per-open-file diagnostics, this is an explicit, on-demand deep
 * scan — it does not read or modify the persisted `csharppainkiller.diagnostics.*`
 * settings; the picker selection only applies to this single run.
 */
export async function analyzeSolutionCommand(
	diagnosticCollection: vscode.DiagnosticCollection
): Promise<void> {
	const selection = await pickAnalyzersToRun();
	if (!selection) {
		return; // User cancelled.
	}

	if (
		!selection.wrongNamespace &&
		!selection.wrongFilename &&
		!selection.unsortedUsings &&
		!selection.mixedLanguageIdentifiers &&
		!selection.duplicateTypeName
	) {
		vscode.window.showInformationMessage('CSharp Painkiller: No analyzers selected — nothing to do.');
		return;
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'CSharp Painkiller: Analyzing solution',
			cancellable: true,
		},
		async (progress, token) => {
			let lastProcessed = 0;

			const result = await runDiagnosticsForWorkspace(diagnosticCollection, {
				overrides: selection,
				token,
				onProgress: (processed, total) => {
					const increment = total > 0 ? ((processed - lastProcessed) / total) * 100 : 0;
					lastProcessed = processed;
					progress.report({ increment, message: `${processed}/${total} files` });
				},
			});

			if (result.cancelled) {
				vscode.window.showWarningMessage(
					`CSharp Painkiller: Analysis cancelled after ${result.processed} of ${result.total} file(s).`
				);
				return;
			}

			vscode.window.showInformationMessage(
				`CSharp Painkiller: Analyzed ${result.processed} file(s), found ${result.diagnosticCount} issue(s).`
			);
		}
	);
}
