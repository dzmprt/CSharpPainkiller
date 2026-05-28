/**
 * Shared constants for CSharp Painkiller extension.
 */

// ============================================================================
// File extensions and patterns
// ============================================================================

/** C# file extension */
export const CS_EXTENSION = '.cs';

/** .NET project system extension */
export const CSPROJ_EXTENSION = '.csproj';

/** Path segments excluded from file operations (standard .NET build output) */
export const EXCLUDED_PATH_SEGMENTS = new Set<string>(['bin', 'obj']);

/** Glob pattern for C# files */
export const CS_FILES_PATTERN = '**/*.cs';

/** Glob pattern excluding bin/obj directories */
export const CS_FILES_EXCLUDE_PATTERN = '{**/bin/**,**/obj/**}';

// ============================================================================
// C# type names
// ============================================================================

/** Suffix for handler classes */
export const HANDLER_SUFFIX = 'Handler';

/** Suffix for notification types */
export const NOTIFICATION_SUFFIX = 'Notification';

/** Suffix for query request types */
export const QUERY_SUFFIX = 'Query';

/** Suffix for command request types */
export const COMMAND_SUFFIX = 'Command';

/** Default suffix when no verb pattern is detected */
export const REQUEST_SUFFIX = 'Request';

// ============================================================================
// Request verb prefixes (determines Query vs Command suffix)
// ============================================================================

/** HTTP-verb prefixes that indicate a Query */
export const QUERY_PREFIXES = new Set<string>(['get', 'load', 'download', 'fetch']);

/** HTTP-verb prefixes that indicate a Command */
export const COMMAND_PREFIXES = new Set<string>([
	'post', 'put', 'delete', 'add', 'create', 'remove', 'change',
	'update', 'edit', 'modify', 'import', 'upload', 'drop',
]);

// ============================================================================
// Built-in C# types (avoid workspace lookup for these)
// ============================================================================

export const BUILTIN_TYPES = new Set<string>([
	'bool', 'byte', 'sbyte', 'char', 'decimal', 'double', 'float',
	'int', 'uint', 'long', 'ulong', 'short', 'ushort', 'object',
	'string', 'void', 'dynamic',
	'Boolean', 'Byte', 'SByte', 'Char', 'Decimal', 'Double', 'Single',
	'Int32', 'UInt32', 'Int64', 'UInt64', 'Int16', 'UInt16', 'Object',
	'String', 'Guid', 'DateTime', 'DateTimeOffset', 'TimeSpan',
	'Uri', 'Version', 'Type', 'Unit',
]);

// ============================================================================
// Mediator library identifiers
// ============================================================================

/** MediatR library using directive namespace */
export const MEDIATR_NAMESPACE = 'MediatR';

/** MitMediator library using directive namespace */
export const MITMEDIATOR_NAMESPACE = 'MitMediator';

// ============================================================================
// VS Code command IDs (mirrors package.json for programmatic access)
// ============================================================================

export const COMMAND_IDS = {
	noop: 'csharppainkiller.noop',
	createClass: 'csharppainkiller.createClass',
	createRecord: 'csharppainkiller.createRecord',
	createStruct: 'csharppainkiller.createStruct',
	createEnum: 'csharppainkiller.createEnum',
	createInterface: 'csharppainkiller.createInterface',
	createRecordStruct: 'csharppainkiller.createRecordStruct',
	adjustNamespace: 'csharppainkiller.adjustNamespace',
	renameFileByType: 'csharppainkiller.renameFileByType',
	sortUsings: 'csharppainkiller.sortUsings',
	extractInterface: 'csharppainkiller.extractInterface',
	generateMapTo: 'csharppainkiller.generateMapTo',
	generateMapFrom: 'csharppainkiller.generateMapFrom',
	generateHandlerForFile: 'csharppainkiller.generateHandlerForFile',
	goToHandlerForFile: 'csharppainkiller.goToHandlerForFile',

	// Submenu IDs
	submenus: {
		create: 'csharppainkiller.create',
		refactor: 'csharppainkiller.refactor',
		templates: 'csharppainkiller.templates',
	},

	// Context keys
	contextKeys: {
		isMediatorFile: 'csharppainkiller.isMediatorFile',
	},

	// ASP.NET templates
	aspnet: {
		emptyController: 'csharppainkiller.templates.aspnet.emptyController',
		efCrudController: 'csharppainkiller.templates.aspnet.efCrudController',
		emptyMinimalApi: 'csharppainkiller.templates.aspnet.emptyMinimalApi',
		efCrudMinimalApi: 'csharppainkiller.templates.aspnet.efCrudMinimalApi',
	},

	// MediatR templates
	mediatr: {
		createRequestAndHandler: 'csharppainkiller.templates.mediatr.createRequestAndHandler',
		createRequest: 'csharppainkiller.templates.mediatr.createRequest',
		createHandler: 'csharppainkiller.templates.mediatr.createHandler',
		createNotificationAndHandler: 'csharppainkiller.templates.mediatr.createNotificationAndHandler',
		createNotification: 'csharppainkiller.templates.mediatr.createNotification',
		createNotificationHandler: 'csharppainkiller.templates.mediatr.createNotificationHandler',
		createEmptyPipelineBehavior: 'csharppainkiller.templates.mediatr.createEmptyPipelineBehavior',
		createFluentValidationBehavior: 'csharppainkiller.templates.mediatr.createFluentValidationBehavior',
	},

	// MitMediator templates
	mItmediator: {
		createRequestAndHandler: 'csharppainkiller.templates.mitmediator.createRequestAndHandler',
		createRequest: 'csharppainkiller.templates.mitmediator.createRequest',
		createHandler: 'csharppainkiller.templates.mitmediator.createHandler',
		createNotificationAndHandler: 'csharppainkiller.templates.mitmediator.createNotificationAndHandler',
		createNotification: 'csharppainkiller.templates.mitmediator.createNotification',
		createNotificationHandler: 'csharppainkiller.templates.mitmediator.createNotificationHandler',
		createEmptyPipelineBehavior: 'csharppainkiller.templates.mitmediator.createEmptyPipelineBehavior',
		createFluentValidationBehavior: 'csharppainkiller.templates.mitmediator.createFluentValidationBehavior',
	},

	// EF Core
	efcore: {
		createConfigurationFromFolder: 'csharppainkiller.efcore.createConfigurationFromFolder',
		createConfigurationFromFile: 'csharppainkiller.efcore.createConfigurationFromFile',
	},
} as const;

// ============================================================================
// Diagnostic setting keys
// ============================================================================

export const DIAGNOSTIC_SETTINGS = {
	wrongNamespace: 'csharppainkiller.diagnostics.wrongNamespace',
	wrongFilename: 'csharppainkiller.diagnostics.wrongFilename',
	unsortedUsings: 'csharppainkiller.diagnostics.unsortedUsings',
	mixedLanguageIdentifiers: 'csharppainkiller.diagnostics.mixedLanguageIdentifiers',
} as const;

// ============================================================================
// Extension metadata
// ============================================================================

/** Display name of the extension */
export const EXTENSION_DISPLAY_NAME = 'CSharp Painkiller';

/** Error message prefix for console logging */
export const LOG_PREFIX = `[${EXTENSION_DISPLAY_NAME}]`;

/** Default debounce delay for diagnostic runs (ms) */
export const DIAGNOSTICS_DEBOUNCE_MS = 300;

/** VS Code minimum version requirement */
export const MIN_VSCODE_VERSION = '1.92.0';