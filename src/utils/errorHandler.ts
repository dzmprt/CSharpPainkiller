import * as vscode from 'vscode';
import { OperationError } from './operationError.js';

/**
 * Error logger and handler for CSharp Painkiller
 */
export class ErrorHandler {
	/**
	 * Log an error with context
	 */
	public static logError(context: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		const stack = error instanceof Error ? error.stack : undefined;
		console.error(`[${context}] ${message}`, stack);
	}

	/**
	 * Log a warning with context
	 */
	public static logWarn(context: string, message: string, error?: unknown): void {
		if (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			console.warn(`[${context}] ${message}: ${errorMsg}`);
		} else {
			console.warn(`[${context}] ${message}`);
		}
	}

	/**
	 * Show error to user and log it
	 */
	public static showError(title: string, message: string, error?: unknown): void {
		const fullMessage = error instanceof Error ? `${message}: ${error.message}` : message;
		console.error(`[${title}] ${fullMessage}`);
		vscode.window.showErrorMessage(`CSharp Painkiller: ${title}`);
	}

	/**
	 * Show warning to user and log it
	 */
	public static showWarning(title: string, message: string): void {
		console.warn(`[${title}] ${message}`);
		vscode.window.showWarningMessage(`CSharp Painkiller: ${title}`);
	}

	/**
	 * Show info to user
	 */
	public static showInfo(title: string, message: string): void {
		console.log(`[${title}] ${message}`);
		vscode.window.showInformationMessage(`CSharp Painkiller: ${title}`);
	}

	/**
	 * Safely execute async operation with error handling
	 */
	public static async tryCatch<T>(
		operation: () => Promise<T>,
		context: string,
		defaultValue: T,
		showError: boolean = false
	): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			this.logError(context, error);
			if (showError && error instanceof Error) {
				vscode.window.showErrorMessage(`CSharp Painkiller: ${context} failed - ${error.message}`);
			}
			return defaultValue;
		}
	}

	/**
	 * Safely execute sync operation with error handling
	 */
	public static tryCatchSync<T>(
		operation: () => T,
		context: string,
		defaultValue: T,
		showError: boolean = false
	): T {
		try {
			return operation();
		} catch (error) {
			this.logError(context, error);
			if (showError && error instanceof Error) {
				vscode.window.showErrorMessage(`CSharp Painkiller: ${context} failed - ${error.message}`);
			}
			return defaultValue;
		}
	}

	/**
	 * Show operation error to user with context and suggestion
	 * Provides clear error message, reason, and how to fix it
	 */
	public static showOperationError(error: OperationError): void {
		const { context } = error;
		
		// Build title with operation and target
		let title = `${context.operation} failed`;
		if (context.target) {
			title += ` (${context.target})`;
		}

		// Build detailed message
		let message = context.reason || 'Unknown error occurred';
		if (context.suggestion) {
			message += `\n\nTry: ${context.suggestion}`;
		}

		// Log with full details
		console.error(`[${title}] ${message}`);
		if (context.details) {
			console.error('Details:', context.details);
		}

		// Show to user
		vscode.window.showErrorMessage(`CSharp Painkiller: ${title}`);
	}

	/**
	 * Show contextual error from exception
	 * Extracts reason from error message if available
	 */
	public static showContextualError(
		operation: string,
		reason: string,
		suggestion?: string,
		_target?: string
	): void {
		const message = `${operation} failed: ${reason}${suggestion ? `\n\nTry: ${suggestion}` : ''}`;
		console.error(`[${operation}] ${message}`);
		vscode.window.showErrorMessage(`CSharp Painkiller: ${operation} failed`);
	}
}
