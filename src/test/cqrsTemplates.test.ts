import * as assert from 'assert';
import {
	parseReturnType,
	extractIRequestReturnType,
	generateMediatRRequest,
	generateMediatRHandler,
	generateMediatRNotification,
	generateMediatRNotificationHandler,
	generateMitMediatorRequest,
	generateMitMediatorHandler,
	generateMitMediatorNotification,
	generateMediatREmptyPipelineBehavior,
	generateMediatRFluentValidationBehavior,
} from '../services/templates/cqrs.js';

suite('cqrsTemplates', () => {
	suite('parseReturnType', () => {
		test('parses plain type', () => {
			assert.deepStrictEqual(parseReturnType('Author'), {
				innerTypeName: 'Author',
				returnType: 'Author',
			});
		});

		test('parses List<T>', () => {
			assert.deepStrictEqual(parseReturnType('List<Author>'), {
				innerTypeName: 'Author',
				returnType: 'List<Author>',
			});
		});

		test('parses array syntax', () => {
			assert.deepStrictEqual(parseReturnType('Author[]'), {
				innerTypeName: 'Author',
				returnType: 'Author[]',
			});
		});
	});

	suite('extractIRequestReturnType', () => {
		test('extractIRequestReturnType extracts nested generic return type', () => {
			const content = 'public class Query : IRequest<List<Author>> { }';
			assert.strictEqual(extractIRequestReturnType(content), 'List<Author>');
		});

		test('extracts generic return type', () => {
			const content = 'public class Query : IRequest<Author> { }';
			assert.strictEqual(extractIRequestReturnType(content), 'Author');
		});

		test('returns undefined when not found', () => {
			assert.strictEqual(extractIRequestReturnType('public class Query : IRequest { }'), undefined);
		});
	});

	const returnedType = {
		name: 'Author',
		namespace: 'MyApp.Domain',
		fileUri: undefined as never,
	};

	suite('MediatR generators', () => {
		test('generateMediatRRequest with return type', () => {
			const content = generateMediatRRequest('GetAuthorsQuery', 'List<Author>', returnedType, 'MyApp.Application');
			assert.ok(content.includes('public sealed class GetAuthorsQuery : IRequest<List<Author>>'));
			assert.ok(content.includes('using MediatR;'));
			assert.ok(content.includes('using MyApp.Domain;'));
		});

		test('generateMediatRRequest void uses Unit', () => {
			const content = generateMediatRRequest('DeleteAuthorCommand', null, null, 'MyApp.Application');
			assert.ok(content.includes('IRequest<Unit>'));
		});

		test('generateMediatRHandler', () => {
			const requestType = { name: 'GetAuthorsQuery', namespace: 'MyApp.Application', fileUri: undefined as never };
			const content = generateMediatRHandler(
				'GetAuthorsQueryHandler',
				requestType,
				'List<Author>',
				'MyApp.Application',
				returnedType
			);
			assert.ok(content.includes('IRequestHandler<GetAuthorsQuery, List<Author>>'));
		});

		test('generateMediatRNotification', () => {
			const content = generateMediatRNotification('UserRegisteredNotification', 'MyApp.Application');
			assert.ok(content.includes(': INotification'));
		});

		test('generateMediatRNotificationHandler', () => {
			const notifType = { name: 'UserRegisteredNotification', namespace: 'MyApp.Application', fileUri: undefined as never };
			const content = generateMediatRNotificationHandler('UserRegisteredNotificationHandler', notifType, 'MyApp.Application');
			assert.ok(content.includes('INotificationHandler<UserRegisteredNotification>'));
		});

		test('generateMediatREmptyPipelineBehavior', () => {
			const content = generateMediatREmptyPipelineBehavior('LoggingBehavior', 'MyApp.Application');
			assert.ok(content.includes('IPipelineBehavior<'));
		});

		test('generateMediatRFluentValidationBehavior', () => {
			const content = generateMediatRFluentValidationBehavior('ValidationBehavior', 'MyApp.Application');
			assert.ok(content.includes('IValidator<TRequest>'));
		});
	});

	suite('MitMediator generators', () => {
		test('generateMitMediatorRequest', () => {
			const content = generateMitMediatorRequest('GetAuthorsQuery', 'List<Author>', returnedType, 'MyApp.Application');
			assert.ok(content.includes('using MitMediator;'));
			assert.ok(content.includes('IRequest<List<Author>>'));
		});

		test('generateMitMediatorHandler uses ValueTask for typed requests', () => {
			const requestType = { name: 'GetAuthorsQuery', namespace: 'MyApp.Application', fileUri: undefined as never };
			const content = generateMitMediatorHandler(
				'GetAuthorsQueryHandler',
				requestType,
				'List<Author>',
				'MyApp.Application',
				returnedType
			);
			assert.ok(content.includes('ValueTask<List<Author>> HandleAsync'));
		});

		test('generateMitMediatorHandler uses ValueTask<Unit> for void requests', () => {
			const requestType = { name: 'DeleteAuthorCommand', namespace: 'MyApp.Application', fileUri: undefined as never };
			const content = generateMitMediatorHandler(
				'DeleteAuthorCommandHandler',
				requestType,
				null,
				'MyApp.Application'
			);
			assert.ok(content.includes('IRequestHandler<DeleteAuthorCommand>'));
			assert.ok(!content.includes('IRequestHandler<DeleteAuthorCommand, Unit>'));
			assert.ok(content.includes('ValueTask<Unit> HandleAsync'));
		});

		test('generateMitMediatorNotification', () => {
			const content = generateMitMediatorNotification('UserRegisteredNotification', 'MyApp.Application');
			assert.ok(content.includes(': INotification'));
			assert.ok(content.includes('using MitMediator;'));
		});
	});
});
