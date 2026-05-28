/**
 * MitMediator template generators
 * Includes requests, handlers, notifications, and pipeline behaviors
 *
 * Re-exports from main cqrs.ts for organization
 */

export {
	generateMitMediatorRequest,
	generateMitMediatorHandler,
	generateMitMediatorNotification,
	generateMitMediatorNotificationHandler,
	generateMitMediatorEmptyPipelineBehavior,
	generateMitMediatorFluentValidationBehavior,
} from '../cqrs.js';
