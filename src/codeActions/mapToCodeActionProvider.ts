import * as vscode from 'vscode';
import { getTypeNameAtPosition } from '../services/generateMapTo.js';

/**
 * Code action provider for C# refactorings when the cursor is on a type name.
 */
export class CSharpRefactorCodeActionProvider implements vscode.CodeActionProvider {
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
		const typeName = getTypeNameAtPosition(document, position);
		if (!typeName) {
			return [];
		}

		// Code action command arguments must be JSON-serializable — pass uri, not TextDocument.
		const docUri = document.uri;
		const actions: vscode.CodeAction[] = [];

		const mapTo = new vscode.CodeAction(
			'Generate MapTo method',
			vscode.CodeActionKind.RefactorRewrite
		);
		mapTo.command = {
			title: 'Generate MapTo method',
			command: 'csharppainkiller.generateMapTo',
			arguments: [docUri, typeName],
		};
		actions.push(mapTo);

		const mapFrom = new vscode.CodeAction(
			'Generate MapFrom method',
			vscode.CodeActionKind.RefactorRewrite
		);
		mapFrom.command = {
			title: 'Generate MapFrom method',
			command: 'csharppainkiller.generateMapFrom',
			arguments: [docUri, typeName],
		};
		actions.push(mapFrom);

		const generateDto = new vscode.CodeAction(
			'Generate DTO with MapFrom in DTO',
			vscode.CodeActionKind.RefactorRewrite
		);
		generateDto.command = {
			title: 'Generate DTO with MapFrom in DTO',
			command: 'csharppainkiller.generateDto',
			arguments: [docUri, typeName],
		};
		actions.push(generateDto);

		const generateValidator = new vscode.CodeAction(
			'Generate FluentValidation validator',
			vscode.CodeActionKind.RefactorRewrite
		);
		generateValidator.command = {
			title: 'Generate FluentValidation validator',
			command: 'csharppainkiller.generateFluentValidator',
			arguments: [docUri, typeName],
		};
		actions.push(generateValidator);

		return actions;
	}
}

/** @deprecated Use CSharpRefactorCodeActionProvider */
export class MapToCodeActionProvider extends CSharpRefactorCodeActionProvider {}
