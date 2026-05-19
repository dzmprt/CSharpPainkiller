import * as assert from 'assert';
import { sanitizeNamespaceSegment, escapeRegExp, hasPartialTypes } from '../utils/contentParser.js';
import { getTemplate } from '../templates.js';

suite('CSharp Painkiller Tests', () => {
	// ============================================================================
	// Template generation tests
	// ============================================================================

	suite('Template Generation', () => {
		test('generates class template correctly', () => {
			const result = getTemplate('class', 'MyClass', 'MyApp.Models');
			assert.strictEqual(result, 'namespace MyApp.Models;\n\npublic class MyClass\n{\n}');
		});

		test('generates record template correctly', () => {
			const result = getTemplate('record', 'Person', 'MyApp.Domain');
			assert.strictEqual(result, 'namespace MyApp.Domain;\n\npublic record Person;');
		});

		test('generates interface template with I prefix', () => {
			const result = getTemplate('interface', 'MyService', 'MyApp.Services');
			assert.strictEqual(result, 'namespace MyApp.Services;\n\npublic interface IMyService\n{\n}');
		});

		test('generates record struct template correctly', () => {
			const result = getTemplate('record struct', 'Point', 'MyApp.Geometry');
			assert.strictEqual(result, 'namespace MyApp.Geometry;\n\npublic readonly record struct Point;');
		});
	});

	// ============================================================================
	// Namespace sanitization tests
	// ============================================================================

	suite('Namespace Sanitization', () => {
		test('sanitizes simple segment', () => {
			assert.strictEqual(sanitizeNamespaceSegment('models'), 'Models');
		});

		test('sanitizes segment with invalid characters', () => {
			assert.strictEqual(sanitizeNamespaceSegment('my-models'), 'MyModels');
		});

		test('handles dots correctly', () => {
			assert.strictEqual(sanitizeNamespaceSegment('my.models'), 'My.Models');
		});

		test('returns fallback for empty segment', () => {
			assert.strictEqual(sanitizeNamespaceSegment(''), 'MyNamespace');
		});
	});

	// ============================================================================
	// escapeRegExp tests
	// ============================================================================

	suite('escapeRegExp', () => {
		test('escapes special regex characters', () => {
			assert.strictEqual(escapeRegExp('My.Class'), 'My\\.Class');
			assert.strictEqual(escapeRegExp('Test[1]'), 'Test\\[1\\]');
		});

		test('leaves normal strings unchanged', () => {
			assert.strictEqual(escapeRegExp('MyClass'), 'MyClass');
		});
	});

	// ============================================================================
	// hasPartialTypes tests
	// ============================================================================

	suite('hasPartialTypes', () => {
		test('detects partial class', () => {
			const content = 'public partial class MyClass { }';
			assert.ok(hasPartialTypes(content));
		});

		test('returns false for non-partial types', () => {
			const content = 'public class MyClass { }';
			assert.ok(!hasPartialTypes(content));
		});

		test('returns false for empty content', () => {
			assert.ok(!hasPartialTypes(''));
		});
	});
});
