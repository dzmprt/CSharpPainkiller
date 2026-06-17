import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	validateUri,
	isValidTypeName,
	coerceTypeName,
	capitalize,
	isBuiltinType,
	createHandlerName,
	normalizeRequestName,
} from '../utils/sharedUtilities.js';

suite('sharedUtilities', () => {
	suite('validateUri', () => {
		test('returns error when uri is undefined', () => {
			assert.strictEqual(validateUri(undefined), 'No file or folder selected.');
		});

		test('returns error for non-file scheme', () => {
			const uri = vscode.Uri.parse('untitled:Untitled-1');
			assert.strictEqual(validateUri(uri), 'Only local files and folders are supported.');
		});

		test('requires .cs extension when configured', () => {
			const uri = vscode.Uri.file('/tmp/readme.txt');
			assert.strictEqual(
				validateUri(uri, { requireCsFile: true }),
				'This command only works on .cs files.'
			);
		});

		test('returns undefined for valid .cs file', () => {
			const uri = vscode.Uri.file('/tmp/Book.cs');
			assert.strictEqual(validateUri(uri, { requireCsFile: true }), undefined);
		});
	});

	suite('isValidTypeName', () => {
		test('accepts valid identifiers', () => {
			assert.ok(isValidTypeName('Book'));
			assert.ok(isValidTypeName('_private'));
		});

		test('rejects invalid identifiers', () => {
			assert.ok(!isValidTypeName('1Book'));
			assert.ok(!isValidTypeName('book-name'));
		});
	});

	suite('coerceTypeName', () => {
		test('returns string for valid type names', () => {
			assert.strictEqual(coerceTypeName('Book'), 'Book');
		});

		test('returns undefined for invalid values', () => {
			assert.strictEqual(coerceTypeName(42), undefined);
			assert.strictEqual(coerceTypeName('bad-name'), undefined);
		});
	});

	suite('capitalize', () => {
		test('capitalizes first character', () => {
			assert.strictEqual(capitalize('book'), 'Book');
		});

		test('returns empty string unchanged', () => {
			assert.strictEqual(capitalize(''), '');
		});
	});

	suite('isBuiltinType', () => {
		test('recognizes built-in types', () => {
			assert.ok(isBuiltinType('int'));
			assert.ok(isBuiltinType('String'));
			assert.ok(isBuiltinType('Unit'));
		});

		test('returns false for custom types', () => {
			assert.ok(!isBuiltinType('Author'));
		});
	});

	suite('createHandlerName', () => {
		test('appends Handler suffix', () => {
			assert.strictEqual(createHandlerName('GetAuthorsQuery'), 'GetAuthorsQueryHandler');
		});

		test('does not double-append Handler', () => {
			assert.strictEqual(createHandlerName('GetAuthorsQueryHandler'), 'GetAuthorsQueryHandler');
		});
	});

	suite('normalizeRequestName', () => {
		test('keeps existing Request suffix', () => {
			assert.strictEqual(normalizeRequestName('GetAuthorsQuery'), 'GetAuthorsQuery');
		});

		test('adds Query suffix for get prefix', () => {
			assert.strictEqual(normalizeRequestName('GetAuthors'), 'GetAuthorsQuery');
		});

		test('adds Command suffix for create prefix', () => {
			assert.strictEqual(normalizeRequestName('CreateAuthor'), 'CreateAuthorCommand');
		});

		test('adds Request suffix for unknown prefix', () => {
			assert.strictEqual(normalizeRequestName('ProcessPayment'), 'ProcessPaymentRequest');
		});
	});
});
