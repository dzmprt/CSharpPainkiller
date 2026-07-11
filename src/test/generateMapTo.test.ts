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

		test('tracks accessor visibility', () => {
			const fields = parseTypeFields([
				'public class Author',
				'{',
				'    public int Id { private get; set; }',
				'    public string Name { get; private set; }',
				'}',
			].join('\n'), 'Author');
			assert.strictEqual(fields[0].canRead, false);
			assert.strictEqual(fields[0].canWrite, true);
			assert.strictEqual(fields[1].canRead, true);
			assert.strictEqual(fields[1].canWrite, false);
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
			assert.ok(method.includes('\n                Id = source.Id'));
			assert.ok(method.includes('\n                Name = source.Name'));
		});

		test('does not read a source property with a private getter', () => {
			const sourceFields = [
				{ name: 'Secret', typeName: 'string', canRead: false },
				{ name: 'Name', typeName: 'string', canRead: true },
			];
			const targetFields = [
				{ name: 'Secret', typeName: 'string', canWrite: true },
				{ name: 'Name', typeName: 'string', canWrite: true },
			];
			const method = buildMapToMethod('Author', 'AuthorDto', sourceFields, targetFields, '\n');
			assert.ok(!method.includes('Secret = source.Secret'));
			assert.ok(method.includes('Name = source.Name'));
		});

		test('maps into a property with a private getter', () => {
			const sourceFields = [{ name: 'Name', typeName: 'string', canRead: true }];
			const targetFields = [{ name: 'Name', typeName: 'string', canRead: false, canWrite: true }];
			const method = buildMapToMethod('Author', 'AuthorDto', sourceFields, targetFields, '\n');
			assert.ok(method.includes('Name = source.Name'));
		});

		test('uses the constructor with the most mapped parameters', () => {
			const sourceFields = [
				{ name: 'Id', typeName: 'int', canRead: true },
				{ name: 'Name', typeName: 'string', canRead: true },
				{ name: 'Tags', typeName: 'IEnumerable<string>', canRead: true },
			];
			const targetFields = Object.assign([
				{ name: 'Id', typeName: 'int', canWrite: false },
				{ name: 'Name', typeName: 'string', canWrite: false },
				{ name: 'Tags', typeName: 'IEnumerable<string>', canWrite: false },
			], {
				constructors: [
					{ parameters: [{ name: 'id', typeName: 'int' }, { name: 'missing', typeName: 'IEnumerable<string>' }, { name: 'name', typeName: 'string' }] },
					{ parameters: [{ name: 'id', typeName: 'int' }, { name: 'name', typeName: 'string' }] },
				],
			});
			const method = buildMapToMethod('Author', 'AuthorDto', sourceFields, targetFields, '\n');
			assert.ok(method.includes('return new AuthorDto('));
			assert.ok(method.includes('source.Id'));
			assert.ok(method.includes('source.Name'));
			assert.ok(!method.includes('source.Tags'));
			assert.ok(method.includes('new List<string>()'));
			assert.ok(method.includes('\n            source.Id,'));
			assert.ok(!method.includes('\n        source.Id,'));
		});

		test('uses a constructor with one mapped parameter', () => {
			const sourceFields = [{ name: 'Id', typeName: 'int', canRead: true }];
			const targetFields = Object.assign([
				{ name: 'Id', typeName: 'int', canWrite: false },
			], {
				constructors: [{ parameters: [{ name: 'id', typeName: 'int' }] }],
			});
			const method = buildMapToMethod('Author', 'AuthorDto', sourceFields, targetFields, '\n');
			assert.ok(method.includes('return new AuthorDto('));
			assert.ok(method.includes('source.Id'));
			assert.ok(!method.includes('Id = source.Id'));
		});

		test('generates an instance method when requested', () => {
			const sourceFields = parseTypeFields(sampleClass, 'Author');
			const targetFields = [{ name: 'Name', typeName: 'string' }];
			const method = buildMapToMethod('Author', 'AuthorDto', sourceFields, targetFields, '\n', 'instance');
			assert.ok(method.includes('public AuthorDto MapToAuthorDto()'));
			assert.ok(method.includes('Name = this.Name'));
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

		test('uses readable input fields and the source constructor', () => {
			const sourceFields = Object.assign([
				{ name: 'Id', typeName: 'int', canWrite: false },
				{ name: 'Name', typeName: 'string', canWrite: false },
				{ name: 'Secret', typeName: 'string', canWrite: false },
			], {
				constructors: [{
					parameters: [
						{ name: 'id', typeName: 'int' },
						{ name: 'name', typeName: 'string' },
						{ name: 'secret', typeName: 'string' },
					],
				}],
			});
			const targetFields = [
				{ name: 'Id', typeName: 'int', canRead: true },
				{ name: 'Name', typeName: 'string', canRead: true },
				{ name: 'Secret', typeName: 'string', canRead: false },
			];
			const method = buildMapFromMethod('Author', 'AuthorDto', sourceFields, targetFields, '\n');
			assert.ok(method.includes('return new Author('));
			assert.ok(method.includes('source.Id'));
			assert.ok(method.includes('source.Name'));
			assert.ok(!method.includes('source.Secret'));
			assert.ok(method.includes('null'));
		});

		test('generates a constructor when requested', () => {
			const sourceFields = parseTypeFields(sampleClass, 'Author');
			const targetFields = [
				{ name: 'Id', typeName: 'int', canRead: true },
				{ name: 'Name', typeName: 'string', canRead: true },
			];
			const method = buildMapFromMethod('Author', 'AuthorDto', sourceFields, targetFields, '\n', 'constructor');
			assert.ok(method.includes('public Author(AuthorDto source)'));
			assert.ok(method.includes('Id = source.Id;'));
			assert.ok(method.includes('Name = source.Name;'));
			assert.ok(!method.includes('Id = source.Id,'));
			assert.ok(method.includes('\n        Id = source.Id;'));
			assert.ok(!method.includes('\n            Id = source.Id;'));
		});
	});

	suite('buildDtoMapFromMethod', () => {
		test('generates a DTO constructor with mapped properties', () => {
			const sourceFields = parseTypeFields(sampleClass, 'Author');
			const dtoFields = [
				{ name: 'Id', typeName: 'int' },
				{ name: 'Name', typeName: 'string' },
			];
			const method = buildDtoMapFromMethod('AuthorDto', 'Author', dtoFields, sourceFields, '\n');
			assert.ok(method.includes('public AuthorDto(Author source)'));
			assert.ok(method.includes('\n        Id = source.Id;'));
			assert.ok(method.includes('\n        Name = source.Name;'));
			assert.ok(!method.includes('\n            Id = source.Id;'));
			assert.ok(!method.includes('static'));
		});

		test('maps source get-only properties to DTO init properties', () => {
			const sourceFields = [
				{ name: 'Id', typeName: 'int', canRead: true, canWrite: false },
				{ name: 'Name', typeName: 'string', canRead: true, canWrite: false },
			];
			const dtoFields = [...sourceFields];
			const method = buildDtoMapFromMethod('AuthorDto', 'Author', dtoFields, sourceFields, '\n');
			assert.ok(method.includes('Id = source.Id;'));
			assert.ok(method.includes('Name = source.Name;'));
		});
	});
});
