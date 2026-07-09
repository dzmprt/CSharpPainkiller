import * as vscode from 'vscode';
import { getTypeNameAtPosition } from '../services/generateMapTo.js';
import { canExtractTypeFromFile } from '../services/extractTypeToFileCore.js';
import { getFileBaseNameFromUri } from '../utils/fileUtils.js';

/**
 * Offers "Extract type to file" when the cursor is on a type name, the file
 * contains more than one type declaration, and the file name does not match
 * the type name.
 */
export class ExtractTypeCodeActionProvider implements vscode.CodeActionProvider {
	public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

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
		const typeName = getTypeNameAtPosition(document, position);
		if (!typeName) {
			return [];
		}

		if (!canExtractTypeFromFile(document.getText(), typeName, getFileBaseNameFromUri(document.uri))) {
			return [];
		}

		const action = new vscode.CodeAction(
			`Extract '${typeName}' to file`,
			vscode.CodeActionKind.QuickFix
		);
		action.command = {
			title: `Extract '${typeName}' to file`,
			command: 'csharppainkiller.extractTypeToFile',
			arguments: [document.uri, typeName],
		};

		return [action];
	}
}
