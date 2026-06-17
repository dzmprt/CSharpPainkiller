import * as assert from 'assert';
import { computeNamespaceForFile } from '../namespace/compute.js';
import { adjustFileNamespace } from '../namespace/adjust.js';
import {
	addUsingForNewNamespace,
	findTypeReferencesInContent,
	removeUsingDirective,
} from '../namespace/usingDirectives.js';

suite('namespace', () => {
	suite('computeNamespaceForFile', () => {
		const csprojs = [{ dirPath: '/workspace/MyApp/src/MyApp.Domain' }];

		test('builds namespace from project root and relative path', () => {
			const ns = computeNamespaceForFile(
				'/workspace/MyApp/src/MyApp.Domain/Books',
				'/workspace/MyApp/src/MyApp.Domain',
				csprojs,
				'workspace'
			);
			assert.strictEqual(ns, 'MyApp.Domain.Books');
		});

		test('uses fallback when project root is missing', () => {
			const ns = computeNamespaceForFile(
				'/tmp/other/Books',
				'/tmp/other/Books',
				undefined,
				'Fallback'
			);
			assert.strictEqual(ns, 'Books');
		});
	});

	suite('adjustFileNamespace', () => {
		test('replaces block namespace without usings at file start', () => {
			const content = 'namespace Books.Domain.Test\n{\n\tpublic class Book\n\t{\n\t}\n}';
			const result = adjustFileNamespace(content, 'test/Books/Book.cs', 'Books.Domain');

			assert.ok(result.wasAdjusted);
			assert.strictEqual(result.oldNamespace, 'Books.Domain.Test');
			assert.strictEqual(result.adjustedContent, 'namespace Books.Domain;\n\npublic class Book\n{\n}');
		});

		test('replaces block namespace when file has BOM', () => {
			const content = '\uFEFFnamespace Books.Domain.Test\n{\n\tpublic class Book\n\t{\n\t}\n}';
			const result = adjustFileNamespace(content, 'test/Books/Book.cs', 'Books.Domain');

			assert.ok(result.wasAdjusted);
			assert.strictEqual(result.oldNamespace, 'Books.Domain.Test');
			assert.strictEqual(result.adjustedContent, '\uFEFFnamespace Books.Domain;\n\npublic class Book\n{\n}');
		});
	});

	suite('usingDirectives', () => {
		test('finds type usage in file body', () => {
			const content = [
				'using Old.Namespace;',
				'namespace MyApp;',
				'public class Handler {',
				'    private readonly Book _book;',
				'}',
			].join('\n');

			const found = findTypeReferencesInContent(content, new Set(['Book']));
			assert.deepStrictEqual([...found], ['Book']);
		});

		test('does not treat type name in using directive as usage', () => {
			const content = [
				'using Old.Namespace.Book;',
				'namespace MyApp;',
				'public class Handler {',
				'}',
			].join('\n');

			const found = findTypeReferencesInContent(content, new Set(['Book']));
			assert.strictEqual(found.size, 0);
		});

		test('addUsingForNewNamespace inserts using directive', () => {
			const content = [
				'using System;',
				'namespace MyApp.Old;',
				'public class Handler { private readonly Book _book; }',
			].join('\n');
			const result = addUsingForNewNamespace(content, 'MyApp.Domain', 'MyApp.Old');
			assert.ok(result.wasAdded);
			assert.ok(result.adjustedContent.includes('using MyApp.Domain;'));
		});

		test('addUsingForNewNamespace removes redundant using when namespaces match', () => {
			const content = [
				'using MyApp.Domain;',
				'namespace MyApp.Domain;',
				'public class Book { }',
			].join('\n');
			const result = addUsingForNewNamespace(content, 'MyApp.Domain', 'MyApp.Domain');
			assert.ok(result.wasRemoved);
			assert.ok(!result.adjustedContent.includes('using MyApp.Domain;'));
		});

		test('removeUsingDirective removes matching using', () => {
			const content = [
				'using System;',
				'using System.IO;',
				'namespace MyApp;',
			].join('\n');
			const result = removeUsingDirective(content, 'System.IO');
			assert.ok(result.wasRemoved);
			assert.ok(!result.adjustedContent.includes('using System.IO;'));
		});
	});
});
