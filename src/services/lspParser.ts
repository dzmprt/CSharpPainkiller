import * as vscode from 'vscode';
import { LSPClient } from './lspClient';

/**
 * Type information from LSP
 */
export interface TypeInfo {
	name: string;
	kind: 'class' | 'record' | 'struct' | 'interface' | 'enum' | 'delegate' | 'unknown';
	properties: PropertyInfo[];
	methods: MethodInfo[];
	namespace?: string;
	baseTypes?: string[];
	isAbstract?: boolean;
	isGeneric?: boolean;
}

export interface PropertyInfo {
	name: string;
	type: string;
	isInitOnly?: boolean;
	isReadOnly?: boolean;
	isNullable?: boolean;
	attributes?: string[];
	defaultValue?: string;
}

export interface MethodInfo {
	name: string;
	returnType: string;
	parameters: ParameterInfo[];
	isAsync?: boolean;
	isPublic?: boolean;
}

export interface ParameterInfo {
	name: string;
	type: string;
	hasDefaultValue?: boolean;
	isNullable?: boolean;
}

/**
 * LSP-based C# parser - uses Language Server for reliable parsing
 */
export class LSPParser {
	private lspClient: LSPClient;

	constructor() {
		this.lspClient = LSPClient.getInstance();
	}

	/**
	 * Ensure LSP is initialized
	 */
	public async ensureInitialized(): Promise<void> {
		await this.lspClient.initialize();
	}

	/**
	 * Extract all types from a file
	 */
	public async extractTypesFromFile(uri: vscode.Uri): Promise<TypeInfo[]> {
		try {
			const document = await vscode.workspace.openTextDocument(uri);
			const symbols = await this.lspClient.getDocumentSymbols(uri);

			if (!symbols) {
				console.warn(`No symbols found for ${uri.fsPath}`);
				return [];
			}

			const types: TypeInfo[] = [];
			const topLevelSymbols = Array.isArray(symbols) ? symbols : [];

			for (const symbol of topLevelSymbols) {
				if (this.isTypeSymbol(symbol)) {
					const typeInfo = await this.symbolToTypeInfo(document, symbol);
					if (typeInfo) {
						types.push(typeInfo);
					}
				}
			}

			return types;
		} catch (error) {
			console.error(`Error extracting types from file: ${error}`);
			return [];
		}
	}

	/**
	 * Get main type in file (usually first one)
	 */
	public async getMainTypeInFile(uri: vscode.Uri): Promise<TypeInfo | null> {
		try {
			const types = await this.extractTypesFromFile(uri);
			return types.length > 0 ? types[0] : null;
		} catch (error) {
			console.error(`Error getting main type: ${error}`);
			return null;
		}
	}

	/**
	 * Extract namespace from file
	 */
	public async extractNamespace(uri: vscode.Uri): Promise<string | null> {
		try {
			const document = await vscode.workspace.openTextDocument(uri);
			const text = document.getText();

			// Match namespace declaration (file-scoped or block-scoped)
			const fileScopedMatch = text.match(/^\s*namespace\s+([\w.]+)\s*;/m);
			if (fileScopedMatch) {
				return fileScopedMatch[1];
			}

			const blockScopedMatch = text.match(/^\s*namespace\s+([\w.]+)\s*\{/m);
			if (blockScopedMatch) {
				return blockScopedMatch[1];
			}

			return null;
		} catch (error) {
			console.error(`Error extracting namespace: ${error}`);
			return null;
		}
	}

	/**
	 * Extract using directives from file
	 */
	public async extractUsings(uri: vscode.Uri): Promise<string[]> {
		try {
			const document = await vscode.workspace.openTextDocument(uri);
			const text = document.getText();

			const usings: string[] = [];
			const usingRegex = /^using\s+(?:static\s+)?([^;=]+);/gm;

			let match;
			while ((match = usingRegex.exec(text)) !== null) {
				const usingName = match[1].trim();
				if (usingName && !usings.includes(usingName)) {
					usings.push(usingName);
				}
			}

			return usings;
		} catch (error) {
			console.error(`Error extracting usings: ${error}`);
			return [];
		}
	}

	/**
	 * Get properties of a type suitable for mapping
	 */
	public async getPublicProperties(uri: vscode.Uri, typeName?: string): Promise<PropertyInfo[]> {
		try {
			const typeInfo = typeName 
				? await this.findTypeByName(uri, typeName)
				: await this.getMainTypeInFile(uri);

			if (!typeInfo) {
				return [];
			}

			// Filter to public, non-readonly properties with getters and setters
			return typeInfo.properties.filter(p => !p.isReadOnly && p.type && p.name);
		} catch (error) {
			console.error(`Error getting public properties: ${error}`);
			return [];
		}
	}

	/**
	 * Find a specific type by name in workspace
	 */
	public async findTypeByName(uri: vscode.Uri, typeName: string): Promise<TypeInfo | null> {
		try {
			const types = await this.extractTypesFromFile(uri);
			return types.find(t => t.name === typeName) || null;
		} catch (error) {
			console.error(`Error finding type by name: ${error}`);
			return null;
		}
	}

	/**
	 * Check if symbol is a type declaration
	 */
	private isTypeSymbol(symbol: any): boolean {
		const typeKinds = [
			vscode.SymbolKind.Class,
			vscode.SymbolKind.Struct,
			vscode.SymbolKind.Interface,
			vscode.SymbolKind.Enum,
			vscode.SymbolKind.TypeParameter,
		];
		return typeKinds.includes(symbol.kind);
	}

	/**
	 * Convert LSP symbol to TypeInfo
	 */
	private async symbolToTypeInfo(document: vscode.TextDocument, symbol: any): Promise<TypeInfo | null> {
		try {
			const namespace = await this.extractNamespace(document.uri);
			const kind = this.mapSymbolKindToTypeKind(symbol.kind);

			if (kind === 'unknown') {
				return null;
			}

			const typeInfo: TypeInfo = {
				name: symbol.name,
				kind,
				namespace: namespace || undefined,
				properties: await this.extractPropertiesFromSymbol(document, symbol),
				methods: this.extractMethodsFromSymbol(symbol),
			};

			return typeInfo;
		} catch (error) {
			console.error(`Error converting symbol to type info: ${error}`);
			return null;
		}
	}

	/**
	 * Map VSCode SymbolKind to our TypeKind
	 */
	private mapSymbolKindToTypeKind(
		kind: vscode.SymbolKind
	): 'class' | 'record' | 'struct' | 'interface' | 'enum' | 'delegate' | 'unknown' {
		switch (kind) {
			case vscode.SymbolKind.Class:
				return 'class';
			case vscode.SymbolKind.Struct:
				return 'struct';
			case vscode.SymbolKind.Interface:
				return 'interface';
			case vscode.SymbolKind.Enum:
				return 'enum';
			default:
				return 'unknown';
		}
	}

	/**
	 * Extract properties from type symbol
	 */
	private async extractPropertiesFromSymbol(document: vscode.TextDocument, symbol: any): Promise<PropertyInfo[]> {
		try {
			const properties: PropertyInfo[] = [];

			if (!symbol.children || !Array.isArray(symbol.children)) {
				return properties;
			}

			for (const child of symbol.children) {
				if (child.kind === vscode.SymbolKind.Property || child.kind === vscode.SymbolKind.Field) {
					const propInfo = this.symbolToPropertyInfo(document, child);
					if (propInfo) {
						properties.push(propInfo);
					}
				}
			}

			return properties;
		} catch (error) {
			console.error(`Error extracting properties: ${error}`);
			return [];
		}
	}

	/**
	 * Convert symbol to PropertyInfo
	 */
	private symbolToPropertyInfo(document: vscode.TextDocument, symbol: any): PropertyInfo | null {
		try {
			const range = symbol.location?.range || symbol.range;
			if (!range) {
				return null;
			}

			const text = document.getText(range);

			// Parse property attributes (simplified)
			const isInitOnly = text.includes('init');
			const isReadOnly = text.includes('readonly');
			const isNullable = text.includes('?') && !text.includes('??');

			// Extract type (simplified - get word after type keyword or property name)
			const typeMatch = text.match(/:\s*(\w+(?:\s*<[^>]+>)?)\s*[{;=]/);
			const type = typeMatch ? typeMatch[1].trim() : 'object';

			return {
				name: symbol.name,
				type: type,
				isInitOnly,
				isReadOnly,
				isNullable,
			};
		} catch (error) {
			console.error(`Error converting symbol to property info: ${error}`);
			return null;
		}
	}

	/**
	 * Extract methods from type symbol
	 */
	private extractMethodsFromSymbol(symbol: any): MethodInfo[] {
		try {
			const methods: MethodInfo[] = [];

			if (!symbol.children || !Array.isArray(symbol.children)) {
				return methods;
			}

			for (const child of symbol.children) {
				if (child.kind === vscode.SymbolKind.Method || child.kind === vscode.SymbolKind.Function) {
					const methodInfo = this.symbolToMethodInfo(child);
					if (methodInfo) {
						methods.push(methodInfo);
					}
				}
			}

			return methods;
		} catch (error) {
			console.error(`Error extracting methods: ${error}`);
			return [];
		}
	}

	/**
	 * Convert symbol to MethodInfo
	 */
	private symbolToMethodInfo(symbol: any): MethodInfo | null {
		try {
			// For now, return minimal method info
			return {
				name: symbol.name,
				returnType: 'void',
				parameters: [],
				isPublic: true,
			};
		} catch (error) {
			console.error(`Error converting symbol to method info: ${error}`);
			return null;
		}
	}
}
