/**
 * Shared types for CSharp Painkiller extension.
 * Consolidates type definitions from across the codebase.
 */

import * as vscode from 'vscode';

// ============================================================================
// C# type system
// ============================================================================

/**
 * C# type keywords supported by the extension.
 */
export type CType = 'class' | 'record' | 'struct' | 'enum' | 'interface' | 'record struct';

/**
 * Template parts for a C# type declaration.
 */
export type TemplateParts = { prefix: string; suffix: string };

// ============================================================================
// Project system types
// ============================================================================

/** Represents a discovered .csproj file with its directory path. */
export interface CsprojInfo {
	/** The directory path containing this .csproj file */
	dirPath: string;
}

/** Preloaded project information for a workspace folder. */
export interface ProjectContext {
	/** All .csproj files discovered in the workspace */
	csprojs: CsprojInfo[];
}

// ============================================================================
// Type extraction types
// ============================================================================

/** Represents a type definition extracted from a file. */
export interface TypeDefinition {
	/** The type name (e.g., "MyClass") */
	name: string;
	/** The type keyword (e.g., "class", "record", "interface") */
	type: CType;
	/** The namespace the type was originally in */
	namespace: string;
}

/** Result of extracting types from file content. */
export interface TypeExtractionResult {
	/** List of types found in the file */
	types: TypeDefinition[];
	/** The namespace the file was originally in (undefined if no namespace) */
	oldNamespace: string | undefined;
}

// ============================================================================
// Namespace adjustment types
// ============================================================================

/** Namespace change tracking for a file. */
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

/** Extended result for file adjustment that includes type information. */
export interface FileAdjustResultWithContext {
	uri: vscode.Uri;
	adjusted: boolean;
	oldNamespace?: string;
	newNamespace?: string;
	error?: string;
	/** Types that were in this file before adjustment */
	types?: TypeDefinition[];
}

/** Result of adding/removing using directives. */
export interface UsingDirectiveChangeResult {
	adjustedContent: string;
	wasAdded: boolean;
	wasRemoved: boolean;
}

/** Result of updating using directives for a file. */
export interface UsingDirectiveUpdateResult {
	uri: vscode.Uri;
	updated: boolean;
}

// ============================================================================
// Type search types
// ============================================================================

/** Result of searching for a type by visibility. */
export type TypeSearchResult = { name: string; type: CType } | 'ambiguous' | null;

/** Represents a found type during workspace search operations. */
export interface FoundType {
	/** The simple type name, e.g. "Author" */
	name: string;
	/** Namespace the type lives in, e.g. "MyApp.Models" */
	namespace: string;
	/** The file URI where the type was declared */
	fileUri: vscode.Uri;
}

// ============================================================================
// File operations types (shared across services)
// ============================================================================

/** Result of writing a file via the shared writeAndOpen utility. */
export interface WriteFileResult {
	/** The URI of the created/overwritten file */
	uri: vscode.Uri;
	/** Whether the operation succeeded */
	success: boolean;
	/** Error message if failed, or info message on success */
	message: string;
}

// ============================================================================
// Mediator / CQRS types (shared between services)
// ============================================================================

/** The kind of mediator type detected in a file. */
export type MediatorKind = 'request' | 'notification';

/** Which mediator library is used. */
export type MediatorLibrary = 'MediatR' | 'MitMediator';

/** Describes a mediator type found in a .cs file. */
export interface MediatorFileInfo {
	/** The declared class name (e.g. "GetAuthorsQuery") */
	className: string;
	/** What the class inherits from */
	kind: MediatorKind;
	/** Which library's namespace is imported */
	library: MediatorLibrary;
	/** For IRequest<T>: the return type string (e.g. "List<Author>"). null for void */
	returnType: string | null;
}

/** Configuration for a CQRS template library (MediatR or MitMediator). */
export interface CqrsTemplateConfig {
	/** Library name identifier */
	libraryName: 'MediatR' | 'MitMediator';

	/** Generates the request class content */
	generateRequest: (
		name: string,
		returnType: string | null,
		returnedType: { name: string; namespace: string; fileUri: vscode.Uri },
		namespace: string
	) => string;

	/** Generates the handler class content */
	generateHandler: (
		handlerName: string,
		requestType: { name: string; namespace: string; fileUri: vscode.Uri },
		returnType: string,
		namespace: string,
		returnedType?: { name: string; namespace: string; fileUri: vscode.Uri }
	) => string;

	/** Generates the notification class content */
	generateNotification: (name: string, namespace: string) => string;

	/** Generates the notification handler content */
	generateNotificationHandler: (
		handlerName: string,
		notifType: { name: string; namespace: string; fileUri: vscode.Uri },
		namespace: string
	) => string;

	/** Generates empty pipeline behavior content */
	generateEmptyPipelineBehavior: (name: string, namespace: string) => string;

	/** Generates FluentValidation pipeline behavior content */
	generateFluentValidationBehavior: (name: string, namespace: string) => string;

	/** Extracts the return type from IRequest<T> declaration in source */
	extractIRequestReturnType: (content: string) => string | null | undefined;

	/** Whether this library uses INotification pattern */
	supportsNotifications: boolean;
}

// ============================================================================
// Diagnostics types
// ============================================================================

/** Range information for mixed-language identifier occurrences. */
export interface MixedLanguageOccurrence {
	/** The identifier text that triggered the warning */
	identifier: string;
	/** 0-based line index */
	line: number;
	/** 0-based start column */
	startChar: number;
	/** 0-based end column (exclusive) */
	endChar: number;
}
