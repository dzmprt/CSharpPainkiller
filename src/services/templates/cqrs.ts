import { type FoundType } from '../../utils/typeSearch.js';
import { extractGenericInterfaceArgument } from '../../utils/contentParser.js';

// ============================================================================
// Return-type parsing
// ============================================================================

/**
 * Parses a return-type string entered by the user.
 * Supports: "TypeName", "List<TypeName>", "TypeName[]".
 *
 * Returns:
 *  - `innerTypeName` — the simple type name to search for (e.g. "Author")
 *  - `returnType`    — the full C# return type string (e.g. "List<Author>")
 */
export function parseReturnType(input: string): { innerTypeName: string; returnType: string } {
	const trimmed = input.trim();

	// List<TypeName>
	const listMatch = trimmed.match(/^List<([A-Za-z_][A-Za-z0-9_]*)>$/);
	if (listMatch) {
		return { innerTypeName: listMatch[1], returnType: trimmed };
	}

	// TypeName[]
	const arrayMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\[\]$/);
	if (arrayMatch) {
		return { innerTypeName: arrayMatch[1], returnType: trimmed };
	}

	// Plain TypeName
	const plainMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
	if (plainMatch) {
		return { innerTypeName: plainMatch[1], returnType: trimmed };
	}

	// Fall back — treat whole input as type name (validation will fail later)
	return { innerTypeName: trimmed, returnType: trimmed };
}

// ============================================================================
// IRequest<T> return type extraction
// ============================================================================

/**
 * Extracts the T from `IRequest<T>` in a file's content.
 * Returns undefined if not found (e.g. void IRequest without generic).
 */
export function extractIRequestReturnType(content: string): string | undefined {
	return extractGenericInterfaceArgument(content, 'IRequest');
}

// ============================================================================
// MediatR template generators
// ============================================================================

/**
 * Generates an IRequest class file for MediatR.
 *
 * When returnType is empty/null, generates IRequest<Unit> (void-style).
 */
export function generateMediatRRequest(
	requestName: string,
	returnType: string | null,
	returnedType: FoundType | null,
	namespace: string
): string {
	const isVoid = !returnType;
	const rt = isVoid ? 'Unit' : returnType;

	const libUsings = ['MediatR'];
	const entityUsings = (!isVoid && returnedType?.namespace && returnedType.namespace !== namespace)
		? [returnedType.namespace]
		: [];

	const usings = buildSortedUsings(namespace, libUsings, entityUsings);

	return `${usings}namespace ${namespace};

public sealed class ${requestName} : IRequest<${rt}>
{
}
`;
}

/**
 * Generates an IRequestHandler class file for MediatR.
 *
 * When returnType is "Unit" (void), generates handler returning Unit.Value.
 */
export function generateMediatRHandler(
	handlerName: string,
	requestType: FoundType,
	returnType: string | null,
	namespace: string,
	returnedType?: FoundType
): string {
	const requestName = requestType.name;
	const rt = returnType ?? 'Unit';
	const isVoid = rt === 'Unit';

	const libUsings = ['MediatR'];
	const entityUsings: string[] = [];
	if (requestType.namespace && requestType.namespace !== namespace) {
		entityUsings.push(requestType.namespace);
	}
	if (
		returnedType?.namespace &&
		returnedType.namespace !== namespace &&
		returnedType.namespace !== requestType.namespace
	) {
		entityUsings.push(returnedType.namespace);
	}

	const usings = buildSortedUsings(namespace, libUsings, entityUsings);

	const body = isVoid
		? `throw new NotImplementedException();
        return Unit.Value;`
		: 'throw new NotImplementedException();';

	const taskReturn = isVoid ? 'Task<Unit>' : `Task<${rt}>`;

	return `${usings}namespace ${namespace};

public sealed class ${handlerName} : IRequestHandler<${requestName}, ${rt}>
{
    public async ${taskReturn} Handle(${requestName} request, CancellationToken cancellationToken)
    {
        ${body}
    }
}
`;
}

// ============================================================================
// MitMediator template generators
// ============================================================================
// MitMediator uses the same IRequest<T>/IRequestHandler<,> interfaces as MediatR,
// but the handler method is HandleAsync and returns ValueTask<T>.
// For void requests: IRequest (no generic), handler returns ValueTask<Unit>.

/**
 * Generates an IRequest class file for MitMediator.
 *
 * When returnType is empty/null, generates IRequest (void-style, no generic).
 */
export function generateMitMediatorRequest(
	requestName: string,
	returnType: string | null,
	returnedType: FoundType | null,
	namespace: string
): string {
	const isVoid = !returnType;

	const libUsings = ['MitMediator'];
	const entityUsings = (!isVoid && returnedType?.namespace && returnedType.namespace !== namespace)
		? [returnedType.namespace]
		: [];

	const usings = buildSortedUsings(namespace, libUsings, entityUsings);

	const iface = isVoid ? 'IRequest' : `IRequest<${returnType}>`;

	return `${usings}namespace ${namespace};

public sealed class ${requestName} : ${iface}
{
}
`;
}

/**
 * Generates an IRequestHandler class file for MitMediator.
 * Uses ValueTask<T> and HandleAsync.
 *
 * When returnType is null/empty (void), generates IRequestHandler<TRequest>
 * with ValueTask<Unit> HandleAsync(...).
 */
export function generateMitMediatorHandler(
	handlerName: string,
	requestType: FoundType,
	returnType: string | null,
	namespace: string,
	returnedType?: FoundType
): string {
	const requestName = requestType.name;
	const isVoid = !returnType;

	const libUsings = ['MitMediator'];
	const entityUsings: string[] = [];
	if (requestType.namespace && requestType.namespace !== namespace) {
		entityUsings.push(requestType.namespace);
	}
	if (
		!isVoid &&
		returnedType?.namespace &&
		returnedType.namespace !== namespace &&
		returnedType.namespace !== requestType.namespace
	) {
		entityUsings.push(returnedType.namespace);
	}

	const usings = buildSortedUsings(namespace, libUsings, entityUsings);

	if (isVoid) {
		return `${usings}namespace ${namespace};

public sealed class ${handlerName} : IRequestHandler<${requestName}>
{
    public async ValueTask<Unit> HandleAsync(${requestName} request, CancellationToken cancellationToken)
    {
        throw new NotImplementedException();
        return Unit.Value;
    }
}
`;
	}

	return `${usings}namespace ${namespace};

public sealed class ${handlerName} : IRequestHandler<${requestName}, ${returnType}>
{
    public async ValueTask<${returnType}> HandleAsync(${requestName} request, CancellationToken cancellationToken)
    {
        throw new NotImplementedException();
    }
}
`;
}

// ============================================================================
// MediatR Notification generators
// ============================================================================

/**
 * Generates an INotification class file for MediatR.
 */
export function generateMediatRNotification(
	notificationName: string,
	namespace: string
): string {
	const usings = buildSortedUsings(namespace, ['MediatR'], []);
	return `${usings}namespace ${namespace};

public sealed class ${notificationName} : INotification
{
}
`;
}

/**
 * Generates an INotificationHandler class file for MediatR.
 */
export function generateMediatRNotificationHandler(
	handlerName: string,
	notificationType: FoundType,
	namespace: string
): string {
	const entityUsings: string[] = [];
	if (notificationType.namespace && notificationType.namespace !== namespace) {
		entityUsings.push(notificationType.namespace);
	}
	const usings = buildSortedUsings(namespace, ['MediatR'], entityUsings);
	return `${usings}namespace ${namespace};

public sealed class ${handlerName} : INotificationHandler<${notificationType.name}>
{
    public async Task Handle(${notificationType.name} notification, CancellationToken cancellationToken)
    {
        throw new NotImplementedException();
    }
}
`;
}

// ============================================================================
// MitMediator Notification generators
// ============================================================================

/**
 * Generates an INotification class file for MitMediator.
 */
export function generateMitMediatorNotification(
	notificationName: string,
	namespace: string
): string {
	const usings = buildSortedUsings(namespace, ['MitMediator'], []);
	return `${usings}namespace ${namespace};

public sealed class ${notificationName} : INotification
{
}
`;
}

/**
 * Generates an INotificationHandler class file for MitMediator.
 * Uses ValueTask and HandleAsync.
 */
export function generateMitMediatorNotificationHandler(
	handlerName: string,
	notificationType: FoundType,
	namespace: string
): string {
	const entityUsings: string[] = [];
	if (notificationType.namespace && notificationType.namespace !== namespace) {
		entityUsings.push(notificationType.namespace);
	}
	const usings = buildSortedUsings(namespace, ['MitMediator'], entityUsings);
	return `${usings}namespace ${namespace};

public sealed class ${handlerName} : INotificationHandler<${notificationType.name}>
{
    public async ValueTask HandleAsync(${notificationType.name} notification, CancellationToken cancellationToken)
    {
        throw new NotImplementedException();
    }
}
`;
}

// ============================================================================
// MediatR PipelineBehavior generators
// ============================================================================

/**
 * Generates an empty IPipelineBehavior class for MediatR.
 * Uses Task<TResponse> and RequestHandlerDelegate<TResponse>.
 */
export function generateMediatREmptyPipelineBehavior(
	className: string,
	namespace: string
): string {
	const usings = buildSortedUsings(namespace, ['MediatR'], []);
	return `${usings}namespace ${namespace};

public class ${className}<TRequest, TResponse> : IPipelineBehavior<TRequest, TResponse>
    where TRequest : IRequest<TResponse>
{
    public async Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken cancellationToken)
    {
        // Before
        var response = await next();
        // After
        return response;
    }
}
`;
}

/**
 * Generates a FluentValidation IPipelineBehavior class for MediatR.
 * Uses Task<TResponse> and RequestHandlerDelegate<TResponse>.
 */
export function generateMediatRFluentValidationBehavior(
	className: string,
	namespace: string
): string {
	const usings = buildSortedUsings(namespace, ['FluentValidation', 'MediatR'], []);
	return `${usings}namespace ${namespace};

public class ${className}<TRequest, TResponse> : IPipelineBehavior<TRequest, TResponse>
    where TRequest : IRequest<TResponse>
{
    private readonly IEnumerable<IValidator<TRequest>> _validators;

    public ${className}(IEnumerable<IValidator<TRequest>> validators)
    {
        _validators = validators;
    }

    public async Task<TResponse> Handle(
        TRequest request,
        RequestHandlerDelegate<TResponse> next,
        CancellationToken cancellationToken)
    {
        var context = new ValidationContext<TRequest>(request);
        var failures = _validators
            .Select(v => v.Validate(context))
            .SelectMany(result => result.Errors)
            .Where(f => f != null)
            .ToList();

        if (failures.Count != 0) throw new ValidationException(failures);

        return await next();
    }
}
`;
}

// ============================================================================
// MitMediator PipelineBehavior generators
// ============================================================================

/**
 * Generates an empty IPipelineBehavior class for MitMediator.
 * Uses ValueTask<TResponse> and IRequestHandlerNext<TRequest, TResponse>.
 */
export function generateMitMediatorEmptyPipelineBehavior(
	className: string,
	namespace: string
): string {
	const usings = buildSortedUsings(namespace, ['MitMediator'], []);
	return `${usings}namespace ${namespace};

public class ${className}<TRequest, TResponse> : IPipelineBehavior<TRequest, TResponse>
    where TRequest : IRequest<TResponse>
{
    public async ValueTask<TResponse> HandleAsync(
        TRequest request,
        IRequestHandlerNext<TRequest, TResponse> next,
        CancellationToken cancellationToken)
    {
        // Before
        var response = await next.InvokeAsync(request, cancellationToken);
        // After
        return response;
    }
}
`;
}

/**
 * Generates a FluentValidation IPipelineBehavior class for MitMediator.
 * Uses ValueTask<TResponse> and IRequestHandlerNext<TRequest, TResponse>.
 */
export function generateMitMediatorFluentValidationBehavior(
	className: string,
	namespace: string
): string {
	const usings = buildSortedUsings(namespace, ['FluentValidation', 'MitMediator'], []);
	return `${usings}namespace ${namespace};

public class ${className}<TRequest, TResponse> : IPipelineBehavior<TRequest, TResponse>
    where TRequest : IRequest<TResponse>
{
    private readonly IEnumerable<IValidator<TRequest>> _validators;

    public ${className}(IEnumerable<IValidator<TRequest>> validators)
    {
        _validators = validators;
    }

    public ValueTask<TResponse> HandleAsync(
        TRequest request,
        IRequestHandlerNext<TRequest, TResponse> next,
        CancellationToken cancellationToken)
    {
        var context = new ValidationContext<TRequest>(request);
        var failures = _validators
            .Select(v => v.Validate(context))
            .SelectMany(result => result.Errors)
            .Where(f => f != null)
            .ToList();

        if (failures.Count != 0) throw new ValidationException(failures);

        return next.InvokeAsync(request, cancellationToken);
    }
}
`;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Builds a sorted using-directive block.
 *
 * Order:
 *  1. Library namespaces (MediatR, MitMediator, Microsoft.*, System.*)
 *  2. Entity/domain namespaces (user project namespaces)
 *
 * Within each group namespaces are sorted alphabetically.
 * The target namespace itself is always excluded.
 */
function buildSortedUsings(
	targetNamespace: string,
	libNamespaces: string[],
	entityNamespaces: string[]
): string {
	const filterOut = (ns: string) => ns && ns !== targetNamespace;

	const libs = [...new Set(libNamespaces.filter(filterOut))].sort();
	const entities = [...new Set(entityNamespaces.filter(filterOut))].sort();

	const all = [...libs, ...entities];
	if (all.length === 0) {
		return '';
	}
	return all.map(ns => `using ${ns};`).join('\n') + '\n\n';
}
