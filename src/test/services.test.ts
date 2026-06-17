import * as assert from 'assert';
import { sortUsingsInContent } from '../services/sortUsings.js';
import { removeUnusedUsingsFromContent } from '../services/removeUnusedUsings.js';
import { extractPublicMembers } from '../services/extractInterface.js';
import {
	parsePublicProperties,
	generateEfCoreEntityTypeConfiguration,
} from '../services/templates/efcore.js';
import {
	normalizeControllerName,
	generateEmptyController,
} from '../services/templates/aspnet.js';
import { generateFluentValidatorContent } from '../services/generateFluentValidator.js';
import {
	capitalize,
	toPascalCase,
	toCamelCase,
	sanitizeIdentifier,
	formatNamespace,
	generateXmlDoc,
} from '../services/templates/shared/helpers.js';

suite('services', () => {
	suite('sortUsingsInContent', () => {
		test('sorts System usings first', () => {
			const content = [
				'using MyApp.Domain;',
				'using System.Linq;',
				'using System;',
				'namespace MyApp;',
			].join('\n');
			const sorted = sortUsingsInContent(content);
			assert.ok(sorted);
			const lines = sorted!.split('\n').slice(0, 3);
			assert.strictEqual(lines[0], 'using System;');
			assert.strictEqual(lines[1], 'using System.Linq;');
			assert.strictEqual(lines[2], 'using MyApp.Domain;');
		});

		test('deduplicates usings', () => {
			const content = [
				'using System;',
				'using System;',
				'namespace MyApp;',
			].join('\n');
			const sorted = sortUsingsInContent(content);
			assert.ok(sorted);
			assert.strictEqual((sorted!.match(/^using System;/gm) ?? []).length, 1);
		});

		test('returns undefined when already sorted', () => {
			const content = [
				'using System;',
				'using System.Linq;',
				'namespace MyApp;',
			].join('\n');
			assert.strictEqual(sortUsingsInContent(content), undefined);
		});

		test('does not rewrite using directives inside namespace body', () => {
			const content = [
				'using MyApp.Domain;',
				'using System;',
				'',
				'namespace MyApp',
				'{',
				'    using Nested;',
				'    public class Book { }',
				'}',
			].join('\n');

			const sorted = sortUsingsInContent(content);

			assert.ok(sorted);
			assert.ok(sorted!.includes('    using Nested;'));
			assert.ok(sorted!.includes('public class Book { }'));
		});
	});

	suite('removeUnusedUsingsFromContent', () => {
		test('removes unused using directives', () => {
			const content = [
				'using MyApp.Domain;',
				'using System.IO;',
				'namespace MyApp;',
				'public class Handler { private readonly DomainService _service; }',
			].join('\n');
			const updated = removeUnusedUsingsFromContent(content);
			assert.ok(updated);
			assert.ok(updated!.includes('using MyApp.Domain;'));
			assert.ok(!updated!.includes('using System.IO;'));
		});

		test('returns undefined when all usings are used', () => {
			const content = [
				'using MyApp.Domain;',
				'namespace MyApp;',
				'public class Handler { private readonly DomainService _service; }',
			].join('\n');
			assert.strictEqual(removeUnusedUsingsFromContent(content), undefined);
		});

		test('does not remove code before a nested using directive', () => {
			const content = [
				'using System.IO;',
				'',
				'namespace MyApp',
				'{',
				'    public class Book { }',
				'    using Nested;',
				'}',
			].join('\n');

			const updated = removeUnusedUsingsFromContent(content);

			assert.ok(updated);
			assert.ok(updated!.includes('public class Book { }'));
			assert.ok(updated!.includes('    using Nested;'));
		});
	});

	suite('extractPublicMembers', () => {
		test('extracts public properties and methods', () => {
			const content = [
				'namespace MyApp;',
				'public class BookService',
				'{',
				'    public string Title { get; set; }',
				'    public async Task SaveAsync() { }',
				'}',
			].join('\n');
			const members = extractPublicMembers(content);
			assert.ok(members);
			assert.strictEqual(members!.className, 'BookService');
			assert.strictEqual(members!.properties.length, 1);
			assert.strictEqual(members!.properties[0].name, 'Title');
			assert.strictEqual(members!.methods.length, 1);
			assert.strictEqual(members!.methods[0].name, 'SaveAsync');
			assert.ok(members!.methods[0].isAsync);
		});

		test('returns undefined when no public class exists', () => {
			assert.strictEqual(extractPublicMembers('namespace MyApp;'), undefined);
		});
	});

	suite('efcore templates', () => {
		test('parsePublicProperties parses nullable and non-nullable properties', () => {
			const content = [
				'public class Book',
				'{',
				'    public int Id { get; set; }',
				'    public string? Title { get; set; }',
				'    public string Author { get; init; }',
				'}',
			].join('\n');
			const props = parsePublicProperties(content);
			assert.strictEqual(props.length, 3);
			assert.strictEqual(props[0].name, 'Id');
			assert.strictEqual(props[1].isNullable, true);
			assert.strictEqual(props[2].type, 'string');
		});

		test('generateEfCoreEntityTypeConfiguration configures key and properties', () => {
			const entity = {
				name: 'Book',
				namespace: 'MyApp.Domain',
				fileUri: undefined as never,
			};
			const props = parsePublicProperties([
				'public class Book',
				'{',
				'    public int Id { get; set; }',
				'    public string Title { get; set; }',
				'}',
			].join('\n'));
			const content = generateEfCoreEntityTypeConfiguration(entity, props, 'MyApp.Infrastructure');
			assert.ok(content.includes('builder.HasKey(e => e.Id);'));
			assert.ok(content.includes('builder.Property(e => e.Title)'));
			assert.ok(content.includes('.IsRequired()'));
			assert.ok(content.includes('.HasMaxLength(256)'));
		});
	});

	suite('aspnet templates', () => {
		test('normalizeControllerName strips Controller suffix', () => {
			assert.strictEqual(normalizeControllerName('AuthorsController'), 'Authors');
			assert.strictEqual(normalizeControllerName('Authors'), 'Authors');
		});

		test('generateEmptyController creates ApiController', () => {
			const content = generateEmptyController('Authors', 'MyApp.Api');
			assert.ok(content.includes('public class AuthorsController : ControllerBase'));
			assert.ok(content.includes('[ApiController]'));
		});
	});

	suite('generateFluentValidatorContent', () => {
		test('generates validator with string rules', () => {
			const content = generateFluentValidatorContent(
				'Book',
				[{ name: 'Title', type: 'string', isNullable: false }],
				'MyApp.Validators',
				'\n',
				new Set<string>()
			);
			assert.ok(content.includes('public class BookValidator : AbstractValidator<Book>'));
			assert.ok(content.includes('RuleFor(x => x.Title)'));
			assert.ok(content.includes('.NotEmpty()'));
			assert.ok(content.includes('.MaximumLength(256);'));
		});
	});

	suite('template shared helpers', () => {
		test('capitalize', () => {
			assert.strictEqual(capitalize('book'), 'Book');
		});

		test('toPascalCase', () => {
			assert.strictEqual(toPascalCase('my class'), 'MyClass');
		});

		test('toCamelCase', () => {
			assert.strictEqual(toCamelCase('MyClass'), 'myClass');
		});

		test('sanitizeIdentifier', () => {
			assert.strictEqual(sanitizeIdentifier('123-name'), '_123name');
			assert.strictEqual(sanitizeIdentifier(''), 'GeneratedClass');
		});

		test('formatNamespace', () => {
			assert.strictEqual(formatNamespace('my-app/domain'), 'Myapp.Domain');
		});

		test('generateXmlDoc', () => {
			assert.ok(generateXmlDoc('Summary text.').includes('/// Summary text.'));
		});
	});
});
