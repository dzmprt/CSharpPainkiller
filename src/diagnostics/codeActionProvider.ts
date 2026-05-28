import * as vscode from 'vscode';
import { DIAGNOSTIC_SOURCE, DIAGNOSTIC_CODE_NAMESPACE, DIAGNOSTIC_CODE_UNSORTED_USINGS } from './diagnosticsProvider.js';

/**
 * Provides quick fix actions for CSharp Painkiller diagnostics.
 *
 * Currently supports:
 * - Fixing wrong namespace via the existing `csharppainkiller.adjustNamespace` command.
 * - Fixing unsorted using directives via the existing `csharppainkiller.sortUsings` command.
 */
export class CSharpDiagnosticsCodeActionProvider implements vscode.CodeActionProvider {
	public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

	provideCodeActions(
		document: vscode.TextDocument,
		_range: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext,
		_token: vscode.CancellationToken
	): vscode.CodeAction[] {
		const actions: vscode.CodeAction[] = [];

		for (const diagnostic of context.diagnostics) {
			if (diagnostic.source !== DIAGNOSTIC_SOURCE) {
				continue;
			}

			if (diagnostic.code === DIAGNOSTIC_CODE_NAMESPACE) {
				const action = this.createFixNamespaceAction(document, diagnostic);
				if (action) {
					actions.push(action);
				}
			}

			if (diagnostic.code === DIAGNOSTIC_CODE_UNSORTED_USINGS) {
				const action = this.createSortUsingsAction(document, diagnostic);
				if (action) {
					actions.push(action);
				}
			}
		}

		return actions;
	}

	private createFixNamespaceAction(
		document: vscode.TextDocument,
		diagnostic: vscode.Diagnostic
	): vscode.CodeAction | undefined {
		const action = new vscode.CodeAction(
			'Fix namespace',
			vscode.CodeActionKind.QuickFix
		);
		action.diagnostics = [diagnostic];
		action.isPreferred = true;

		// Reuse the existing adjustNamespace command passing the file URI
		action.command = {
			title: 'Fix namespace',
			command: 'csharppainkiller.adjustNamespace',
			arguments: [document.uri],
		};

		return action;
	}

	private createSortUsingsAction(
		document: vscode.TextDocument,
		diagnostic: vscode.Diagnostic
	): vscode.CodeAction | undefined {
		const action = new vscode.CodeAction(
			'Sort using directives',
			vscode.CodeActionKind.QuickFix
		);
		action.diagnostics = [diagnostic];
		action.isPreferred = true;

		// Reuse the existing sortUsings command passing the file URI
		action.command = {
			title: 'Sort usings',
			command: 'csharppainkiller.sortUsings',
			arguments: [document.uri],
		};

		return action;
	}
}
