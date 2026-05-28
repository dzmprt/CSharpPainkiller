import * as vscode from 'vscode';
import { ParserCache } from './parserCache.js';

/**
 * Code action provider that offers "Go to Handler" when the cursor is on a
 * class that implements IRequest<T>, IRequest, or INotification
 * (from MediatR or MitMediator).
 * Uses ParserCache to avoid redundant document scanning.
 */
export class GoToHandlerCodeActionProvider implements vscode.CodeActionProvider {
	public static readonly providedCodeActionKinds = [vscode.CodeActionKind.RefactorRewrite];
	private static parserCache = ParserCache.getInstance();

	provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
		_context: vscode.CodeActionContext,
		_token: vscode.CancellationToken
	): vscode.CodeAction[] {
		if (!document.uri.path.endsWith('.cs')) {
			return [];
		}

		// Use cached mediator detection instead of scanning full content every time
		if (!GoToHandlerCodeActionProvider.parserCache.isMediatorFile(document)) {
			return [];
		}

		// Use cached type name extraction at the cursor position
		const position = range instanceof vscode.Selection ? range.active : range.start;
		if (!GoToHandlerCodeActionProvider.parserCache.getTypeNameAt(document, position.line, position.character)) {
			return [];
		}

		const action = new vscode.CodeAction(
			'Go to Handler',
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