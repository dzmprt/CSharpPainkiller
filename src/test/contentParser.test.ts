import * as assert from 'assert';
import {
	extractFileNamespace,
	extractFileNamespaceWithIndent,
	extractUsingDirectives,
	extractTypesFromContent,
	searchTypesByVisibility,
	getPublicTypeName,
	getTypeNameForFileDiagnostic,
	hasPartialTypes,
	escapeRegExp,
	findMixedLanguageIdentifiers,
	sanitizeNamespaceSegment,
	normalizePath,
	detectMediatorFile,
	extractGenericInterfaceArgument,
} from '../utils/contentParser.js';

suite('contentParser', () => {
	suite('extractFileNamespace', () => {
		test('file-scoped namespace', () => {
			const content = 'namespace MyApp.Models;\n\npublic class Book { }';
			assert.strictEqual(extractFileNamespace(content), 'MyApp.Models');
		});

		test('block-scoped namespace', () => {
			const content = 'namespace MyApp.Models\n{\n    public class Book { }\n}';
			assert.strictEqual(extractFileNamespace(content), 'MyApp.Models');
		});

		test('handles BOM', () => {
			const content = '\uFEFFnamespace MyApp;\n\npublic class Book { }';
			assert.strictEqual(extractFileNamespace(content), 'MyApp');
		});

		test('returns undefined when missing', () => {
			assert.strictEqual(extractFileNamespace('public class Book { }'), undefined);
		});
	});

	suite('extractFileNamespaceWithIndent', () => {
		test('returns namespace and indent', () => {
			const content = '\tnamespace MyApp;\n\npublic class Book { }';
			const result = extractFileNamespaceWithIndent(content);
			assert.deepStrictEqual(result, { namespace: 'MyApp', indent: '\t' });
		});
	});

	suite('extractUsingDirectives', () => {
		test('collects using directives', () => {
			const content = [
				'using System;',
				'using System.Collections.Generic;',
				'namespace MyApp;',
				'public class Book { }',
			].join('\n');
			assert.deepStrictEqual(extractUsingDirectives(content), [
				'System',
				'System.Collections.Generic',
			]);
		});
	});

	suite('extractTypesFromContent', () => {
		test('extracts types from file-scoped namespace', () => {
			const content = 'namespace MyApp;\n\npublic class Alpha { }\npublic record Beta;';
			const result = extractTypesFromContent(content);
			assert.strictEqual(result.oldNamespace, 'MyApp');
			assert.strictEqual(result.types.length, 2);
			assert.deepStrictEqual(
				result.types.map(t => t.name).sort(),
				['Alpha', 'Beta']
			);
		});

		test('extracts record struct type', () => {
			const content = 'namespace MyApp;\n\npublic readonly record struct Point;';
			const result = extractTypesFromContent(content);
			assert.strictEqual(result.oldNamespace, 'MyApp');
			assert.deepStrictEqual(result.types, [{ name: 'Point', type: 'record struct', namespace: 'MyApp' }]);
		});

		test('extracts types from block-scoped namespace with nested braces', () => {
			const content = [
				'namespace MyApp',
				'{',
				'    public class Book',
				'    {',
				'        public void Save() { }',
				'    }',
				'}',
			].join('\n');
			const result = extractTypesFromContent(content);
			assert.deepStrictEqual(result.types, [{ name: 'Book', type: 'class', namespace: 'MyApp' }]);
		});
	});

	suite('searchTypesByVisibility', () => {
		test('finds single public type', () => {
			const content = 'namespace MyApp;\n\npublic class Book { }';
			const result = searchTypesByVisibility(content, 'public');
			assert.deepStrictEqual(result, { name: 'Book', type: 'class' });
		});

		test('returns ambiguous for multiple public types', () => {
			const content = 'namespace MyApp;\n\npublic class A { }\npublic class B { }';
			assert.strictEqual(searchTypesByVisibility(content, 'public'), 'ambiguous');
		});

		test('finds internal type', () => {
			const content = 'namespace MyApp;\n\ninternal class Hidden { }';
			const result = searchTypesByVisibility(content, 'internal');
			assert.deepStrictEqual(result, { name: 'Hidden', type: 'class' });
		});

		test('returns ambiguous when public record struct and class coexist', () => {
			const content = 'namespace MyApp;\n\npublic readonly record struct Point;\npublic class Book { }';
			assert.strictEqual(searchTypesByVisibility(content, 'public'), 'ambiguous');
		});

		test('returns null when no types found', () => {
			assert.strictEqual(searchTypesByVisibility('namespace MyApp;', 'public'), null);
		});

		// Bug 3 regression: internal record struct was misdetected as type=record, name=struct
		test('correctly detects internal record struct — name is not "struct"', () => {
			const content = 'namespace MyApp;\n\ninternal record struct MyPoint { }';
			const result = searchTypesByVisibility(content, 'internal');
			assert.notStrictEqual(result, 'ambiguous');
			assert.ok(result !== null && result !== 'ambiguous');
			assert.strictEqual(result.name, 'MyPoint');
			assert.strictEqual(result.type, 'record struct');
		});

		test('correctly detects internal readonly record struct', () => {
			const content = 'namespace MyApp;\n\ninternal readonly record struct Point;';
			const result = searchTypesByVisibility(content, 'internal');
			assert.ok(result !== null && result !== 'ambiguous');
			assert.strictEqual(result.name, 'Point');
			assert.strictEqual(result.type, 'record struct');
		});

		test('internal record struct does not shadow internal record', () => {
			const content = 'namespace MyApp;\n\ninternal record MyEvent;';
			const result = searchTypesByVisibility(content, 'internal');
			assert.ok(result !== null && result !== 'ambiguous');
			assert.strictEqual(result.name, 'MyEvent');
			assert.strictEqual(result.type, 'record');
		});

		test('ambiguous when internal record struct and internal class coexist', () => {
			const content = 'namespace MyApp;\n\ninternal record struct Point;\ninternal class Helper { }';
			assert.strictEqual(searchTypesByVisibility(content, 'internal'), 'ambiguous');
		});
	});

	suite('getPublicTypeName', () => {
		test('prefers public over internal', () => {
			const content = 'namespace MyApp;\n\ninternal class Hidden { }\npublic class Visible { }';
			const result = getPublicTypeName(content);
			assert.deepStrictEqual(result, { name: 'Visible', type: 'class' });
		});
	});

	suite('getTypeNameForFileDiagnostic', () => {
		test('ignores types without access modifier', () => {
			const content = 'namespace MyApp;\n\nclass Hidden { }';
			assert.strictEqual(getTypeNameForFileDiagnostic(content), null);
		});

		test('uses internal type when no public types exist', () => {
			const content = 'namespace MyApp;\n\ninternal class Hidden { }';
			const result = getTypeNameForFileDiagnostic(content);
			assert.deepStrictEqual(result, { name: 'Hidden', type: 'class' });
		});

		// Bug 3 regression: internal record struct must produce correct type name
		test('correctly identifies internal record struct for filename diagnostic', () => {
			const content = 'namespace MyApp;\n\ninternal record struct Coordinate;';
			const result = getTypeNameForFileDiagnostic(content);
			assert.ok(result !== null && result !== 'ambiguous');
			assert.strictEqual(result.name, 'Coordinate');
			assert.strictEqual(result.type, 'record struct');
		});

		test('correctly identifies internal readonly record struct for filename diagnostic', () => {
			const content = 'namespace MyApp;\n\ninternal readonly record struct Vector3;';
			const result = getTypeNameForFileDiagnostic(content);
			assert.ok(result !== null && result !== 'ambiguous');
			assert.strictEqual(result.name, 'Vector3');
			assert.strictEqual(result.type, 'record struct');
		});
	});

	suite('hasPartialTypes', () => {
		test('detects partial class', () => {
			assert.ok(hasPartialTypes('public partial class MyClass { }'));
		});

		test('returns false for non-partial types', () => {
			assert.ok(!hasPartialTypes('public class MyClass { }'));
		});
	});

	suite('escapeRegExp', () => {
		test('escapes special characters', () => {
			assert.strictEqual(escapeRegExp('My.Class'), 'My\\.Class');
		});
	});

	suite('findMixedLanguageIdentifiers', () => {
		test('detects Cyrillic identifiers', () => {
			const content = 'namespace MyApp;\n\npublic class Книга { }';
			const results = findMixedLanguageIdentifiers(content);
			assert.strictEqual(results.length, 1);
			assert.strictEqual(results[0].identifier, 'Книга');
		});

		test('ignores identifiers inside string literals', () => {
			const content = 'namespace MyApp;\n\npublic class Book { string x = "Книга"; }';
			assert.strictEqual(findMixedLanguageIdentifiers(content).length, 0);
		});
	});

	suite('sanitizeNamespaceSegment', () => {
		test('sanitizes simple segment', () => {
			assert.strictEqual(sanitizeNamespaceSegment('models'), 'Models');
		});

		test('returns fallback for empty segment', () => {
			assert.strictEqual(sanitizeNamespaceSegment(''), 'MyNamespace');
		});
	});

	suite('normalizePath', () => {
		test('ensures leading slash', () => {
			assert.strictEqual(normalizePath('src/MyApp'), '/src/MyApp');
			assert.strictEqual(normalizePath('/src/MyApp'), '/src/MyApp');
		});
	});

	suite('extractGenericInterfaceArgument', () => {
		test('extracts nested generic return type', () => {
			const content = 'public class Query : IRequest<List<Author>> { }';
			assert.strictEqual(extractGenericInterfaceArgument(content, 'IRequest'), 'List<Author>');
		});
	});

	suite('detectMediatorFile', () => {
		test('detects MediatR request with return type', () => {
			const content = [
				'using MediatR;',
				'namespace MyApp;',
				'public sealed class GetAuthorsQuery : IRequest<List<Author>> { }',
			].join('\n');
			const info = detectMediatorFile(content);
			assert.ok(info);
			assert.strictEqual(info!.className, 'GetAuthorsQuery');
			assert.strictEqual(info!.kind, 'request');
			assert.strictEqual(info!.library, 'MediatR');
			assert.strictEqual(info!.returnType, 'List<Author>');
		});

		test('detects MitMediator notification', () => {
			const content = [
				'using MitMediator;',
				'namespace MyApp;',
				'public sealed class UserRegisteredNotification : INotification { }',
			].join('\n');
			const info = detectMediatorFile(content);
			assert.ok(info);
			assert.strictEqual(info!.kind, 'notification');
			assert.strictEqual(info!.library, 'MitMediator');
		});

		test('returns null for non-mediator file', () => {
			assert.strictEqual(detectMediatorFile('namespace MyApp;\npublic class Book { }'), null);
		});
	});
});
