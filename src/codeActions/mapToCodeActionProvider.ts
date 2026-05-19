import * as vscode from 'vscode';
import { getTypeNameAtPosition } from '../services/generateMapTo.js';

/**
 * Code action provider that offers "Generate MapTo method" and
 * "Generate MapFrom method" when the cursor is on a class / struct / record name.
 */
export class MapToCodeActionProvider implements vscode.CodeActionProvider {
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

		const position = range instanceof vscode.Selection ? range.active : range.start;
		if (!getTypeNameAtPosition(document, position)) {
			return [];
		}

		const mapTo = new vscode.CodeAction(
			'Generate MapTo method (CSharp Painkiller)',
			vscode.CodeActionKind.RefactorRewrite
		);
		mapTo.command = {
			title: 'Generate MapTo method',
			command: 'csharppainkiller.generateMapTo',
			arguments: [document],
		};

		const mapFrom = new vscode.CodeAction(
			'Generate MapFrom method (CSharp Painkiller)',
			vscode.CodeActionKind.RefactorRewrite
		);
		mapFrom.command = {
			title: 'Generate MapFrom method',
			command: 'csharppainkiller.generateMapFrom',
			arguments: [document],
		};

		return [mapTo, mapFrom];
	}
}
