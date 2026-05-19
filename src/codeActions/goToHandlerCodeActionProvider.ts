import * as vscode from 'vscode';
import { getTypeNameAtPosition } from '../services/generateMapTo.js';
import { detectMediatorFile } from '../utils/contentParser.js';

/**
 * Code action provider that offers "Go to Handler" when the cursor is on a
 * class that implements IRequest<T>, IRequest, or INotification
 * (from MediatR or MitMediator).
 */
export class GoToHandlerCodeActionProvider implements vscode.CodeActionProvider {
	public static readonly providedCodeActionKinds = [vscode.CodeActionKind.RefactorRewrite];

	provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
		_context: vscode.CodeActionContext,
		_token: vscode.CancellationToken
	): vscode.CodeAction[] {
		if (!document.uri.path.endsWith('.cs')) {
			return [];
		}

		const content = document.getText();

		// Only offer the action when this file contains a mediator type
		if (!detectMediatorFile(content)) {
			return [];
		}

		// Only show the action when the cursor is on the class name
		const position = range instanceof vscode.Selection ? range.active : range.start;
		if (!getTypeNameAtPosition(document, position)) {
			return [];
		}

		const action = new vscode.CodeAction(
			'Go to Handler (CSharp Painkiller)',
			vscode.CodeActionKind.RefactorRewrite
		);
		action.command = {
			title: 'Go to Handler',
			command: 'csharppainkiller.goToHandlerForFile',
			arguments: [document.uri],
		};

		return [action];
	}
}
