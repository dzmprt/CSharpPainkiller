import * as assert from 'assert';
import {
	stripComments,
	detectPrimaryTypeName,
	parseTypeFields,
	buildMapToMethod,
	buildMapFromMethod,
	buildDtoMapFromMethod,
} from '../services/generateMapTo.js';

suite('generateMapTo', () => {
	const sampleClass = [
		'namespace MyApp.Domain;',
		'public class Author',
		'{',
		'    public int Id { get; set; }',
		'    public string Name { get; set; }',
		'}',
	].join('\n');

	suite('stripComments', () => {
		test('removes comments while preserving length', () => {
			const content = 'public class Book // comment\n{\n}';
			const stripped = stripComments(content);
			assert.strictEqual(stripped.length, content.length);
			assert.ok(!stripped.includes('comment'));
			assert.ok(stripped.includes('public class Book'));
		});

		test('removes block comments', () => {
			const content = 'public class Book /* hidden */ { }';
			const stripped = stripComments(content);
			assert.ok(!stripped.includes('hidden'));
		});
	});

	suite('detectPrimaryTypeName', () => {
		test('detects public class name', () => {
			assert.strictEqual(detectPrimaryTypeName(sampleClass), 'Author');
		});

		test('returns undefined when no type found', () => {
			assert.strictEqual(detectPrimaryTypeName('namespace MyApp;'), undefined);
		});
	});

	suite('parseTypeFields', () => {
		test('parses public properties', () => {
			const fields = parseTypeFields(sampleClass, 'Author');
			assert.strictEqual(fields.length, 2);
			assert.deepStrictEqual(fields.map(f => f.name), ['Id', 'Name']);
		});
	});

	suite('buildMapToMethod', () => {
		test('generates mapping method with matching fields', () => {
			const sourceFields = parseTypeFields(sampleClass, 'Author');
			const targetFields = [
				{ name: 'Id', typeName: 'int' },
				{ name: 'Name', typeName: 'string' },
			];
			const method = buildMapToMethod('Author', 'AuthorDto', sourceFields, targetFields, '\n');
			assert.ok(method.includes('public static AuthorDto MapToAuthorDto(Author source)'));
			assert.ok(method.includes('Id = source.Id'));
			assert.ok(method.includes('Name = source.Name'));
		});
	});

	suite('buildMapFromMethod', () => {
		test('generates reverse mapping method', () => {
			const sourceFields = parseTypeFields(sampleClass, 'Author');
			const targetFields = [
				{ name: 'Id', typeName: 'int' },
				{ name: 'Name', typeName: 'string' },
			];
			const method = buildMapFromMethod('Author', 'AuthorDto', sourceFields, targetFields, '\n');
			assert.ok(method.includes('public static Author MapFromAuthorDto(AuthorDto source)'));
		});
	});

	suite('buildDtoMapFromMethod', () => {
		test('generates DTO MapFrom method', () => {
			const sourceFields = parseTypeFields(sampleClass, 'Author');
			const dtoFields = [
				{ name: 'Id', typeName: 'int' },
				{ name: 'Name', typeName: 'string' },
			];
			const method = buildDtoMapFromMethod('AuthorDto', 'Author', dtoFields, sourceFields, '\n');
			assert.ok(method.includes('public static AuthorDto MapFromAuthor(Author source)'));
		});
	});
});
