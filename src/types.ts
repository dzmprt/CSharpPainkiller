import * as vscode from 'vscode';

/**
 * C# type keywords supported by the extension.
 */
export type CType = 'class' | 'record' | 'struct' | 'enum' | 'interface' | 'record struct';

/**
 * Represents a discovered .csproj file with its directory path.
 */
export interface CsprojInfo {
	/** The directory path containing this .csproj file */
	dirPath: string;
}

/**
 * Preloaded project information for a workspace folder.
 * Caches all .csproj paths to avoid repeated filesystem searches.
 */
export interface ProjectContext {
	/** All .csproj files discovered in the workspace */
	csprojs: CsprojInfo[];
}

/**
 * Represents a type definition extracted from a file.
 */
export interface TypeDefinition {
	/** The type name (e.g., "MyClass") */
	name: string;
	/** The type keyword (e.g., "class", "record", "interface") */
	type: CType;
	/** The namespace the type was originally in */
	namespace: string;
}

/**
 * Result of extracting types from file content.
 */
export interface TypeExtractionResult {
	/** List of types found in the file */
	types: TypeDefinition[];
	/** The namespace the file was originally in (undefined if no namespace) */
	oldNamespace: string | undefined;
}

/**
 * Result of adjusting a single file's namespace.
 */
export interface FileAdjustResult {
	uri: vscode.Uri;
	adjusted: boolean;
	oldNamespace?: string;
	newNamespace?: string;
	error?: string;
}

/**
 * Namespace change tracking for a file.
 */
export interface NamespaceChange {
	/** The file URI that was changed */
	fileUri: vscode.Uri;
	/** The old namespace value */
	oldNamespace: string;
	/** The new namespace value */
	newNamespace: string;
	/** Types that were in this file (with their names) */
	types: TypeDefinition[];
}

/**
 * Extended result for file adjustment that includes type information.
 */
export interface FileAdjustResultWithContext extends FileAdjustResult {
	/** Types that were in this file before adjustment */
	types?: TypeDefinition[];
}

/**
 * Result of adding/removing using directives.
 */
export interface UsingDirectiveChangeResult {
	adjustedContent: string;
	wasAdded: boolean;
	wasRemoved: boolean;
}

/**
 * Result of updating using directives for a file.
 */
export interface UsingDirectiveUpdateResult {
	uri: vscode.Uri;
	updated: boolean;
}

/**
 * Result of searching for a type by visibility.
 */
export type TypeSearchResult = { name: string; type: CType } | 'ambiguous' | null;

/**
 * Template parts for a C# type declaration.
 */
export type TemplateParts = { prefix: string; suffix: string };