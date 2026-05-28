/**
 * Context information for an operation error
 */
export interface ErrorContext {
	/** Operation name (e.g., "create-file", "rename", "adjust-namespace") */
	operation: string;
	/** Target file or folder name */
	target?: string;
	/** Reason why the operation failed */
	reason?: string;
	/** Suggestion for how to fix the issue */
	suggestion?: string;
	/** Additional context details */
	details?: Record<string, unknown>;
}

/**
 * Represents an operation error with contextual information
 * Designed to provide users with clear error messages and solutions
 */
export class OperationError extends Error {
	public readonly code: string;
	public readonly context: ErrorContext;

	constructor(code: string, context: ErrorContext) {
		super(`${context.operation} failed: ${context.reason || 'Unknown error'}`);
		this.code = code;
		this.context = context;
		Object.setPrototypeOf(this, OperationError.prototype);
	}
}
