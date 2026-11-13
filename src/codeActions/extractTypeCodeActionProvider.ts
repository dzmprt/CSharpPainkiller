import * as vscode from 'vscode';
import { csharpLanguageService } from '../services/csharpLanguageService.js';
import { getFileBaseNameFromUri } from '../utils/fileUtils.js';

/**
 * Offers "Extract type to file" when the cursor is on a type name, the file
 * contains more than one type declaration, and the file name does not match
 * the type name.
 */
export class ExtractTypeCodeActionProvider implements vscode.CodeActionProvider {
	public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

	async provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
		_context: vscode.CodeActionContext,
		token: vscode.CancellationToken
	): Promise<vscode.CodeAction[]> {
		if (!document.uri.path.endsWith('.cs')) {
			return [];
		}

		const position = range instanceof vscode.Selection ? range.active : range.start;
		const types = (await csharpLanguageService.getTypes(document, token)).filter(type => !type.nested);
		const type = types.find(type => type.symbol.selectionRange.contains(position));
		if (!type) {
			return [];
		}

		const typeName = type.name;
		if (types.length <= 1 || type.partial || typeName === getFileBaseNameFromUri(document.uri)) {
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
