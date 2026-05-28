import * as vscode from 'vscode';

/**
 * LSP Client adapter for C# language services.
 * Uses VSCode's built-in language server protocol providers (document symbol provider,
 * hover provider, completion provider, etc.) which work with any C# language support.
 * No longer requires ms-dotnettools.csharp (C# DevKit) as a hard dependency.
 */
export class LSPClient {
	private static instance: LSPClient;
	private isInitialized: boolean = false;
	private initPromise: Promise<void> | null = null;

	private constructor() {}

	public static getInstance(): LSPClient {
		if (!LSPClient.instance) {
			LSPClient.instance = new LSPClient();
		}
		return LSPClient.instance;
	}

	/**
	 * Initialize LSP connection. Uses VSCode's built-in language server protocol providers
	 * which are available for C# files through basic language support.
	 */
	public async initialize(): Promise<void> {
		if (this.isInitialized) {
			return;
		}

		// Prevent multiple initialization attempts
		if (this.initPromise) {
			return this.initPromise;
		}

		this.initPromise = this.performInitialization();
		await this.initPromise;
		this.isInitialized = true;
	}

	private async performInitialization(): Promise<void> {
		// VSCode's built-in language server providers (documentSymbolProvider, hoverProvider, etc.)
		// are available for C# files through the basic C# language support.
		// No need to activate ms-dotnettools.csharp extension.
		console.log('LSP Client initialized successfully (using built-in VSCode language providers)');
	}

	/**
	 * Get document symbols using VSCode's built-in document symbol provider
	 */
	public async getDocumentSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[] | undefined> {
		try {
			// Ensure document is loaded
			await vscode.workspace.openTextDocument(uri);
			// Request symbols from VSCode's built-in providers
			const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
				'vscode.executeDocumentSymbolProvider',
				uri
			);
			return symbols;
		} catch (error) {
			console.error(`Error getting document symbols: ${error}`);
			return undefined;
		}
	}

	/**
	 * Get type information for a specific position using hover information
	 */
	public async getTypeAtPosition(uri: vscode.Uri, position: vscode.Position): Promise<string | null> {
		try {
			const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
				'vscode.executeHoverProvider',
				uri,
				position
			);

			if (hovers && hovers.length > 0) {
				const hover = hovers[0];
				return this.extractTypeFromHover(hover.contents);
			}
			return null;
		} catch (error) {
			console.error(`Error getting type at position: ${error}`);
			return null;
		}
	}

	/**
	 * Find all usages of a symbol
	 */
	public async findReferences(
		uri: vscode.Uri,
		position: vscode.Position,
		_includeDeclaration: boolean = false
	): Promise<vscode.Location[]> {
		try {
			const locations = await vscode.commands.executeCommand<vscode.Location[]>(
				'vscode.executeReferenceProvider',
				uri,
				position
			);
			return locations || [];
		} catch (error) {
			console.error(`Error finding references: ${error}`);
			return [];
		}
	}

	/**
	 * Get completion items at position
	 */
	public async getCompletions(uri: vscode.Uri, position: vscode.Position): Promise<vscode.CompletionItem[]> {
		try {
			const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
				'vscode.executeCompletionItemProvider',
				uri,
				position
			);
			return completions?.items || [];
		} catch (error) {
			console.error(`Error getting completions: ${error}`);
			return [];
		}
	}

	/**
	 * Get definition of a symbol
	 */
	public async getDefinition(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location | null> {
		try {
			const definitions = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[]>(
				'vscode.executeDefinitionProvider',
				uri,
				position
			);

			if (definitions && definitions.length > 0) {
				const def = definitions[0];
				if ('uri' in def) {
					return def as vscode.Location;
				}
				return null;
			}
			return null;
		} catch (error) {
			console.error(`Error getting definition: ${error}`);
			return null;
		}
	}

	/**
	 * Extract type name from hover content
	 */
	private extractTypeFromHover(contents: vscode.MarkdownString | vscode.MarkedString | Array<vscode.MarkdownString | vscode.MarkedString>): string | null {
		try {
			if (typeof contents === 'string') {
				const match = contents.match(/\(type\)\s+(.+)/);
				return match ? match[1].trim() : null;
			}

			if (Array.isArray(contents)) {
				for (const content of contents) {
					if (typeof content === 'string') {
						const match = content.match(/\(type\)\s+(.+)/);
						if (match) {
							return match[1].trim();
						}
					} else if (content instanceof vscode.MarkdownString) {
						const match = content.value.match(/\(type\)\s+(.+)/);
						if (match) {
							return match[1].trim();
						}
					}
				}
			}

			if (contents instanceof vscode.MarkdownString) {
				const match = contents.value.match(/\(type\)\s+(.+)/);
				if (match) {
					return match[1].trim();
				}
			}

			return null;
		} catch (error) {
			console.error(`Error extracting type from hover: ${error}`);
			return null;
		}
	}

	/**
	 * Format document
	 */
	public async formatDocument(uri: vscode.Uri): Promise<boolean> {
		try {
			const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
				'vscode.executeFormatDocumentProvider',
				uri
			);

			if (edits && edits.length > 0) {
				const edit = new vscode.WorkspaceEdit();
				edit.set(uri, edits);
				return await vscode.workspace.applyEdit(edit);
			}
			return false;
		} catch (error) {
			console.error(`Error formatting document: ${error}`);
			return false;
		}
	}

	/**
	 * Check if LSP is available
	 */
	public isAvailable(): boolean {
		return this.isInitialized;
	}
}
