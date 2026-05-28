import * as vscode from 'vscode';
import { LSPParser } from './lspParser.js';
import { ErrorHandler } from '../utils/errorHandler.js';

/**
 * Service adapter for accessing C# parsing via LSP.
 * Uses VSCode's built-in language server protocol providers which work with basic C# support.
 * LSP is optional - falls back gracefully when not available.
 */
export class CSharpParser {
	private lspParser: LSPParser | null;
	private isInitialized: boolean = false;

	constructor(lspParser: LSPParser | null) {
		this.lspParser = lspParser;
	}

	/**
	 * Check if LSP parser is available for use
	 */
	public isAvailable(): boolean {
		return this.lspParser !== null;
	}

	/**
	 * Ensure LSP is initialized (only if available)
	 */
	public async ensureInitialized(): Promise<void> {
		if (!this.isInitialized && this.lspParser) {
			await this.lspParser.ensureInitialized();
			this.isInitialized = true;
		}
	}

	/**
	 * Get namespace from file using LSP (optional - returns undefined if LSP not available)
	 */
	public async getNamespace(uri: vscode.Uri): Promise<string | undefined> {
		if (!this.lspParser) {
			return undefined;
		}
		await this.ensureInitialized();
		try {
			const ns = await this.lspParser.extractNamespace(uri);
			return ns || undefined;
		} catch (error) {
			ErrorHandler.logError('CSharpParser.getNamespace', error);
			throw new Error(`Failed to extract namespace from ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Get using directives from file using LSP (optional - returns empty array if LSP not available)
	 */
	public async getUsings(uri: vscode.Uri): Promise<string[]> {
		if (!this.lspParser) {
			return [];
		}
		await this.ensureInitialized();
		try {
			const usings = await this.lspParser.extractUsings(uri);
			return usings || [];
		} catch (error) {
			ErrorHandler.logError('CSharpParser.getUsings', error);
			throw new Error(`Failed to extract usings from ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Extract types from file using LSP (optional - returns empty array if LSP not available)
	 */
	public async getTypes(uri: vscode.Uri) {
		if (!this.lspParser) {
			return { types: [], namespace: undefined };
		}
		await this.ensureInitialized();
		try {
			const types = await this.lspParser.extractTypesFromFile(uri);
			const namespace = await this.lspParser.extractNamespace(uri);
			return {
				types: types || [],
				namespace: namespace || undefined,
			};
		} catch (error) {
			ErrorHandler.logError('CSharpParser.getTypes', error);
			throw new Error(`Failed to extract types from ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Get main type from file using LSP (optional - returns null if LSP not available)
	 */
	public async getMainType(uri: vscode.Uri) {
		if (!this.lspParser) {
			return null;
		}
		await this.ensureInitialized();
		try {
			return await this.lspParser.getMainTypeInFile(uri);
		} catch (error) {
			ErrorHandler.logError('CSharpParser.getMainType', error);
			throw new Error(`Failed to get main type from ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Get public properties for MapTo/MapFrom generation using LSP (optional - returns empty array if LSP not available)
	 */
	public async getPublicProperties(uri: vscode.Uri, typeName?: string) {
		if (!this.lspParser) {
			return [];
		}
		await this.ensureInitialized();
		try {
			return await this.lspParser.getPublicProperties(uri, typeName);
		} catch (error) {
			ErrorHandler.logError('CSharpParser.getPublicProperties', error);
			throw new Error(`Failed to extract properties from ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Check if LSP is available
	 */
	public isLSPAvailable(): boolean {
		return this.lspParser !== null;
	}
}
