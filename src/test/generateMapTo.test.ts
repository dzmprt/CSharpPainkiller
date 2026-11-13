import * as assert from 'assert';
import * as vscode from 'vscode';
import { csharpLanguageService } from '../services/csharpLanguageService.js';
import {
	stripComments,
	detectPrimaryTypeName,
	parseTypeFields,
	buildMapToMethod,
	buildMapFromMethod,
	buildDtoMapFromMethod,
	generateMapFromForDocument,
	type MapFromMode,
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

		test('detects record struct name', () => {
			assert.strictEqual(
				detectPrimaryTypeName('public record struct TestRequest(string Name, int Field2, int[] Field3);'),
				'TestRequest'
			);
		});

		test('detects record class name', () => {
			assert.strictEqual(
				detectPrimaryTypeName('public record class TestRequest { public string Name { get; init; } }'),
				'TestRequest'
			);
		});

		test('returns undefined when no type found', () => {
			assert.strictEqual(detectPrimaryTypeName('namespace MyApp;'), undefined);
		});
	});

	suite('parseTypeFields', () => {
		test('excludes static members from both mappings and DTO constructors', () => {
			const fields = parseTypeFields([
				'public class Source {',
				'    public static int Count { get; set; }',
				'    public new static string Name { get; set; }',
				'    public static int Total;',
				'    public int Id { get; set; }',
				'}',
			].join('\n'), 'Source');
			assert.deepStrictEqual(fields.map(field => field.name), ['Id']);
			const target = [{ name: 'Count', typeName: 'int' }, { name: 'Id', typeName: 'int' }];
			for (const content of [
				buildMapToMethod('Source', 'Target', fields, target, '\n'),
				buildMapFromMethod('Source', 'Target', fields, target, '\n'),
				buildDtoMapFromMethod('SourceDto', 'Source', fields, fields, '\n'),
			]) {
				assert.ok(content.includes('Id = source.Id'));
				assert.ok(!content.includes('Count'));
			}
		});

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

		test('does not read write-only or non-public getters and handles accessor bodies', () => {
			const fields = parseTypeFields([
				'public class Source {',
				'    public string WriteOnly { set { Store(value); } }',
				'    public string Hidden { private get => ""; set { Store(value); } }',
				'    public int Value { get { return 1; } set { Store(value); } }',
				'    public string Protected { private protected get; set; }',
				'}',
			].join('\n'), 'Source');
			assert.deepStrictEqual(fields.map(field => [field.name, field.canRead, field.canWrite]), [
				['WriteOnly', false, true], ['Hidden', false, true], ['Value', true, true], ['Protected', false, true],
			]);
			const method = buildMapToMethod('Source', 'Target', fields, fields.map(field => ({ ...field, canWrite: true })), '\n');
			assert.ok(method.includes('Value = source.Value'));
			assert.ok(!method.includes('source.WriteOnly') && !method.includes('source.Hidden') && !method.includes('source.Protected'));
		});

		test('parses record struct primary constructor parameters', () => {
			const fields = parseTypeFields(
				'public record struct TestRequest(string Name, int Field2, int[] Field3);',
				'TestRequest'
			);
			assert.deepStrictEqual(fields.map(field => [field.name, field.typeName]), [
				['Name', 'string'],
				['Field2', 'int'],
				['Field3', 'int[]'],
			]);
		});

		test('parses properties from a record class body', () => {
			const fields = parseTypeFields(
				'public record class TestRequest { public string Name { get; init; } }',
				'TestRequest'
			);
			assert.deepStrictEqual(fields.map(field => [field.name, field.typeName]), [['Name', 'string']]);
		});

		test('parses init properties with an initializer', () => {
			const fields = parseTypeFields([
				'public class RequestDto',
				'{',
				'    public string Name { get; init; } = null!;',
				'}',
			].join('\n'), 'RequestDto');
			assert.deepStrictEqual(fields.map(field => [field.name, field.typeName]), [['Name', 'string']]);
		});
	});

	suite('buildMapToMethod', () => {
		test('preserves case-sensitive user types while resolving BCL aliases and collections', () => {
			const source = [
				{ name: 'Value', typeName: 'User' }, { name: 'Id', typeName: 'System.Int32' },
				{ name: 'Items', typeName: 'List<Int32>' }, { name: 'Custom', typeName: 'toString' },
			];
			const target = [
				{ name: 'Value', typeName: 'user' }, { name: 'Id', typeName: 'int' },
				{ name: 'Items', typeName: 'long[]' }, { name: 'Custom', typeName: 'Other' },
			];
			const method = buildMapToMethod('Source', 'Target', source, target, '\n');
			assert.ok(!method.includes('Value ='));
			assert.ok(!method.includes('Custom ='));
			assert.ok(method.includes('Id = source.Id'));
			assert.ok(method.includes('Items = source.Items.Select(x => (long)x).ToArray()'));
		});

		test('maps constructor parameters even when the target property has a different name', () => {
			const source = parseTypeFields('public class Source { public int Value { get; set; } }', 'Source');
			const target = parseTypeFields('public class Target { public int Result { get; } public Target(int value) { Result = value; } }', 'Target');
			const method = buildMapToMethod('Source', 'Target', source, target, '\n');
			const reverse = buildMapFromMethod('Target', 'Source', target, source, '\n');
			for (const generated of [method, reverse]) {
				assert.ok(generated.includes('new Target('));
				assert.ok(generated.includes('source.Value'));
				assert.ok(!generated.includes('default'));
			}
		});

		test('maps nullable references without Value and preserves null for nullable conversions', () => {
			const method = buildMapToMethod('Source', 'Target', [
				{ name: 'Name', typeName: 'string?' },
				{ name: 'Id', typeName: 'int?' },
				{ name: 'Tags', typeName: 'List<string>?' },
			], [
				{ name: 'Name', typeName: 'string' },
				{ name: 'Id', typeName: 'long?' },
				{ name: 'Tags', typeName: 'string[]?' },
			], '\n');
			assert.ok(!method.includes('.Value'));
			assert.ok(method.includes('source.Name ?? throw new global::System.InvalidOperationException'));
			assert.ok(method.includes('Id = source.Id is null ? (long?)null :'));
			assert.ok(method.includes('Tags = source.Tags is null ? (string[]?)null :'));
			assert.ok(method.includes('.ToArray()'));
		});

		test('uses required constructors and initializes writable properties', () => {
			const source = [{ name: 'Id', typeName: 'int' }, { name: 'Name', typeName: 'string' }];
			const target = Object.assign([
				{ name: 'Id', typeName: 'int', canWrite: false },
				{ name: 'Name', typeName: 'string', canWrite: true },
			], { constructors: [{ parameters: [{ name: 'id', typeName: 'int' }] }] });
			const method = buildMapToMethod('Source', 'Target', source, target, '\n');
			assert.ok(method.includes('return new Target('));
			assert.ok(method.includes('source.Id'));
			assert.ok(method.includes('Name = source.Name'));
			assert.ok(!method.includes('Id = source.Id'));
			const reverse = buildMapFromMethod('Target', 'Source', target, source, '\n', 'constructor');
			assert.ok(reverse.includes('public Target(Source source) : this('));
			assert.ok(reverse.includes('Name = source.Name;'));
		});

		test('maps all record struct primary constructor fields to a DTO', () => {
			const sourceFields = parseTypeFields(
				'public record struct TestRequest(string Name, int Field2, int[] Field3);',
				'TestRequest'
			);
			const targetFields = [
				{ name: 'Name', typeName: 'string' },
				{ name: 'Field2', typeName: 'int' },
				{ name: 'Field3', typeName: 'int[]' },
			];
			const method = buildMapToMethod('TestRequest', 'TestRequestDto', sourceFields, targetFields, '\n');
			assert.ok(method.includes('public static TestRequestDto MapToTestRequestDto(TestRequest source)'));
			assert.ok(method.includes('Name = source.Name'));
			assert.ok(method.includes('Field2 = source.Field2'));
			assert.ok(method.includes('Field3 = source.Field3'));
		});

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
		test('maps initialized init properties to a record struct constructor', () => {
			const sourceFields = parseTypeFields(
				'public record struct TestRequest(string Name, int Field2, int[] Field3);',
				'TestRequest'
			);
			const targetFields = parseTypeFields([
				'public class RequestDto',
				'{',
				'    public string Name { get; init; } = null!;',
				'    public int Field2 { get; init; } = 0;',
				'    public int[] Field3 { get; init; } = null!;',
				'}',
			].join('\n'), 'RequestDto');
			const method = buildMapFromMethod('TestRequest', 'RequestDto', sourceFields, targetFields, '\n');
			assert.ok(method.includes('new TestRequest('));
			assert.ok(method.includes('source.Name'));
			assert.ok(method.includes('source.Field2'));
			assert.ok(method.includes('source.Field3'));
			assert.strictEqual(sourceFields.constructors?.length, 1);
		});

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

	suite('Generate MapFrom command', () => {
		const eventMembers: [string, string, vscode.SymbolKind?][] = [
			['Number', 'public PhoneNumber Number { get; private set; }'],
			['Code', 'public string Code { get; private set; }'],
			['RegistrationCodeCreatedEvent', [
				'public RegistrationCodeCreatedEvent(PhoneNumber number, string code, DateTimeOffset now) : base(now)',
				'    {',
				'        Number = number;',
				'        Code = code;',
				'    }',
			].join('\n'), vscode.SymbolKind.Constructor],
		];
		const eventContent = [
			'using Domain.Values;',
			'namespace Domain.Events;',
			'public class RegistrationCodeCreatedEvent : BaseDomainEvent, INotification',
			'{',
			...eventMembers.map(([, declaration]) => `    ${declaration}`),
			'}',
		].join('\n');
		const emptyOutbox = 'namespace Persistence;\npublic class RegistrationCodeCreatedOutbox\n{\n}\n';

		async function generate(
			inputContent: string,
			inputMembers: [string, string, vscode.SymbolKind?][],
			mode: MapFromMode = 'constructor',
			destinationContent = emptyOutbox,
			destinationMembers: [string, string, vscode.SymbolKind?][] = [],
			expectedError?: RegExp
		): Promise<{ content: string; warnings: string[] }> {
			const input = await vscode.workspace.openTextDocument({ language: 'plaintext', content: inputContent });
			const destination = await vscode.workspace.openTextDocument({ language: 'plaintext', content: destinationContent });
			const originals = {
				symbols: csharpLanguageService.getSymbols,
				findTypes: csharpLanguageService.findTypes,
				input: vscode.window.showInputBox,
				warning: vscode.window.showWarningMessage,
				information: vscode.window.showInformationMessage,
			};
			const warnings: string[] = [];
			function symbols(
				document: vscode.TextDocument,
				typeName: string,
				members: [string, string, vscode.SymbolKind?][]
			): vscode.DocumentSymbol[] {
				const content = document.getText();
				function symbol(name: string, declaration: string, kind: vscode.SymbolKind): vscode.DocumentSymbol {
					const start = content.indexOf(declaration);
					assert.ok(start >= 0, `Missing declaration: ${declaration}`);
					const selection = content.indexOf(name, start);
					return new vscode.DocumentSymbol(name, '', kind,
						new vscode.Range(document.positionAt(start), document.positionAt(start + declaration.length)),
						new vscode.Range(document.positionAt(selection), document.positionAt(selection + name.length)));
				}
				const typeStart = content.indexOf('public class');
				const type = symbol(typeName, content.slice(typeStart).trimEnd(), vscode.SymbolKind.Class);
				type.children = members.map(([name, declaration, kind]) => symbol(name, declaration, kind ?? vscode.SymbolKind.Property));
				const namespace = content.match(/namespace ([\w.]+);/);
				if (!namespace) { return [type]; }
				const scope = symbol(namespace[1], content.slice(namespace.index), vscode.SymbolKind.Namespace);
				scope.children.push(type);
				return [scope];
			}
			try {
				csharpLanguageService.getSymbols = async document => document === input
					? symbols(input, 'RegistrationCodeCreatedEvent', inputMembers)
					: symbols(destination, 'RegistrationCodeCreatedOutbox', destinationMembers);
				csharpLanguageService.findTypes = async () => [new vscode.SymbolInformation(
					'RegistrationCodeCreatedEvent', vscode.SymbolKind.Class, '',
					new vscode.Location(input.uri, new vscode.Position(0, 0))
				)];
				Object.defineProperty(vscode.window, 'showInputBox', { configurable: true, value: async () => 'RegistrationCodeCreatedEvent' });
				Object.defineProperty(vscode.window, 'showWarningMessage', {
					configurable: true, value: async (message: string) => { warnings.push(message); },
				});
				Object.defineProperty(vscode.window, 'showInformationMessage', { configurable: true, value: async () => undefined });
				const command = generateMapFromForDocument(destination, 'RegistrationCodeCreatedOutbox', mode);
				if (expectedError) { await assert.rejects(command, expectedError); }
				else { await command; }
				return { content: destination.getText(), warnings };
			} finally {
				csharpLanguageService.getSymbols = originals.symbols;
				csharpLanguageService.findTypes = originals.findTypes;
				Object.defineProperty(vscode.window, 'showInputBox', { configurable: true, value: originals.input });
				Object.defineProperty(vscode.window, 'showWarningMessage', { configurable: true, value: originals.warning });
				Object.defineProperty(vscode.window, 'showInformationMessage', { configurable: true, value: originals.information });
			}
		}

		test('creates properties and a populated constructor in the empty outbox from the reported event', async () => {
			const { content, warnings } = await generate(eventContent, eventMembers);
			assert.deepStrictEqual(warnings, []);
			assert.ok(content.includes('using Domain.Values;'));
			assert.ok(content.includes('using Domain.Events;'));
			assert.ok(content.includes([
				'    public PhoneNumber Number { get; init; }',
				'    public string Code { get; init; }',
				'',
				'    public RegistrationCodeCreatedOutbox(RegistrationCodeCreatedEvent source)',
				'    {',
				'        Number = source.Number;',
				'        Code = source.Code;',
				'    }',
			].join('\n')));
			assert.ok(!content.includes(': this('));
		});

		test('creates a static mapping with nullable collections but excludes unreadable and static inputs', async () => {
			const members: [string, string, vscode.SymbolKind?][] = [
				['Codes', 'public List<string>? Codes { get; private set; }'],
				['Hidden', 'public string Hidden { private get; set; }'],
				['WriteOnly', 'public string WriteOnly { set {} }'],
				['Count', 'public static int Count { get; set; }'],
			];
			const input = [
				'namespace Domain.Events;',
				'using System.Collections.Generic;',
				'public class RegistrationCodeCreatedEvent',
				'{',
				...members.map(([, declaration]) => `    ${declaration}`),
				'}',
			].join('\r\n');
			const { content } = await generate(input, members, 'static', emptyOutbox.replace(/\n/g, '\r\n'));
			assert.ok(content.includes('using System.Collections.Generic;\r\n'));
			assert.ok(content.includes('public List<string>? Codes { get; init; }'));
			assert.ok(content.includes('public static RegistrationCodeCreatedOutbox MapFromRegistrationCodeCreatedEvent(RegistrationCodeCreatedEvent source)'));
			assert.ok(content.includes('Codes = source.Codes'));
			assert.ok(!/Hidden|WriteOnly|Count/.test(content));
			assert.ok(!/(?<!\r)\n/.test(content));
		});

		test('does not expand existing destination properties or duplicate its imports', async () => {
			const property = 'public string Code { get; init; }';
			const outbox = emptyOutbox.replace('{\n}', `{\n    ${property}\n}`);
			const { content } = await generate(eventContent, eventMembers, 'constructor', outbox, [['Code', property]]);
			assert.ok(content.includes('Code = source.Code;'));
			assert.ok(!content.includes('Number'));
			assert.strictEqual(content.split(property).length - 1, 1);
		});

		test('warns without editing an empty destination when no input members can be read', async () => {
			const property = 'public string Code { private get; set; }';
			const { content, warnings } = await generate(
				`public class RegistrationCodeCreatedEvent { ${property} }`, [['Code', property]]
			);
			assert.strictEqual(content, emptyOutbox);
			assert.ok(warnings.some(message => message.includes('No mappable public properties')));
		});

		test('rejects conflicting property type aliases without partially editing the destination', async () => {
			const input = eventContent.replace('using Domain.Values;', 'using PhoneNumber = Domain.Values.PhoneNumber;');
			const outbox = 'using PhoneNumber = Other.PhoneNumber;\n' + emptyOutbox;
			const { content } = await generate(input, eventMembers, 'constructor', outbox, [], /using alias "PhoneNumber"/);
			assert.strictEqual(content, outbox);
		});
	});

	suite('buildDtoMapFromMethod', () => {
		test('maps record struct primary constructor fields to DTO properties', () => {
			const sourceFields = parseTypeFields(
				'public record struct TestRequest(string Name, int Field2, int[] Field3);',
				'TestRequest'
			);
			const dtoFields = [
				{ name: 'Name', typeName: 'string' },
				{ name: 'Field2', typeName: 'int' },
				{ name: 'Field3', typeName: 'int[]' },
			];
			const method = buildDtoMapFromMethod('TestRequestDto', 'TestRequest', dtoFields, sourceFields, '\n');
			assert.ok(method.includes('public TestRequestDto(TestRequest source)'));
			assert.ok(method.includes('Name = source.Name;'));
			assert.ok(method.includes('Field2 = source.Field2;'));
			assert.ok(method.includes('Field3 = source.Field3;'));
		});

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
