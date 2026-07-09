import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	isPathExcluded,
	findProjectRootForPath,
	getParentFolder,
	getFileNameFromUri,
} from '../utils/fileUtils.js';
import { fastContentHash, hasNonAsciiFast } from '../utils/contentHash.js';
import { getTemplate } from '../templates.js';
import {
	canExtractTypeFromFile,
	findTypeDeclarationSpan,
	buildExtractedFileContent,
	removeTypeFromContent,
	listExtractableTypes,
} from '../services/extractTypeToFileCore.js';

suite('utilities', () => {
	suite('fileUtils', () => {
		test('isPathExcluded detects bin and obj folders', () => {
			assert.ok(isPathExcluded('/workspace/MyApp/bin/Debug/Book.cs'));
			assert.ok(isPathExcluded('/workspace/MyApp/obj/Book.cs'));
			assert.ok(!isPathExcluded('/workspace/MyApp/src/Book.cs'));
		});

		test('findProjectRootForPath returns deepest matching csproj directory', () => {
			const csprojs = [
				{ dirPath: '/workspace/MyApp' },
				{ dirPath: '/workspace/MyApp/src/MyApp.Domain' },
			];
			const root = findProjectRootForPath('/workspace/MyApp/src/MyApp.Domain/Books/Book.cs', csprojs);
			assert.strictEqual(root, '/workspace/MyApp/src/MyApp.Domain');
		});

		test('getParentFolder returns parent directory uri', () => {
			const fileUri = vscode.Uri.file('/workspace/MyApp/Book.cs');
			assert.strictEqual(getParentFolder(fileUri).path, '/workspace/MyApp');
		});

		test('getFileNameFromUri extracts file name', () => {
			const uri = vscode.Uri.file('/workspace/MyApp/Book.cs');
			assert.strictEqual(getFileNameFromUri(uri), 'Book.cs');
		});
	});

	suite('contentHash', () => {
		test('fastContentHash is stable for same content', () => {
			assert.strictEqual(fastContentHash('hello'), fastContentHash('hello'));
		});

		test('fastContentHash changes for different content', () => {
			assert.notStrictEqual(fastContentHash('hello'), fastContentHash('world'));
		});

		test('fastContentHash returns 8-character hex string', () => {
			assert.match(fastContentHash('test'), /^[0-9a-f]{8}$/);
		});

		test('fastContentHash is sensitive to single-character changes', () => {
			assert.notStrictEqual(fastContentHash('namespace MyApp;'), fastContentHash('namespace MyApp '));
		});

		// Bug 4 regression: & 0xff caused chars sharing the same low byte to hash identically
		test('fastContentHash distinguishes Unicode chars with the same low byte', () => {
			// 'a' = U+0061, '\u0161' = U+0161 — same low byte (0x61), different chars
			assert.notStrictEqual(fastContentHash('a'), fastContentHash('\u0161'));
			// U+0041 ('A') vs U+0141 ('Ł') — same low byte (0x41)
			assert.notStrictEqual(fastContentHash('A'), fastContentHash('\u0141'));
		});

		test('hasNonAsciiFast detects non-ASCII characters', () => {
			assert.ok(hasNonAsciiFast('Книга'));
			assert.ok(!hasNonAsciiFast('Book'));
		});
	});

	suite('templates', () => {
		test('generates class template correctly', () => {
			const result = getTemplate('class', 'MyClass', 'MyApp.Models');
			assert.strictEqual(result, 'namespace MyApp.Models;\n\npublic class MyClass\n{\n}');
		});

		test('generates record template correctly', () => {
			const result = getTemplate('record', 'Person', 'MyApp.Domain');
			assert.strictEqual(result, 'namespace MyApp.Domain;\n\npublic record Person;');
		});

		test('generates interface template with provided name', () => {
			const result = getTemplate('interface', 'IMyService', 'MyApp.Services');
			assert.strictEqual(result, 'namespace MyApp.Services;\n\npublic interface IMyService\n{\n}');
		});

		test('generates record struct template correctly', () => {
			const result = getTemplate('record struct', 'Point', 'MyApp.Geometry');
			assert.strictEqual(result, 'namespace MyApp.Geometry;\n\npublic readonly record struct Point;');
		});

		test('generates struct and enum templates', () => {
			assert.ok(getTemplate('struct', 'Point', 'MyApp').includes('public struct Point'));
			assert.ok(getTemplate('enum', 'Status', 'MyApp').includes('public enum Status'));
		});
	});

	suite('extractTypeToFileCore', () => {
		const multiTypeContent = [
			'using System;',
			'namespace MyApp.Models;',
			'',
			'public class Alpha',
			'{',
			'}',
			'',
			'public class Beta',
			'{',
			'}',
		].join('\n');

		test('listExtractableTypes returns all types', () => {
			const types = listExtractableTypes(multiTypeContent);
			assert.deepStrictEqual(types.map(t => t.name), ['Alpha', 'Beta']);
		});

		test('allows extraction when file has multiple types', () => {
			assert.ok(canExtractTypeFromFile(multiTypeContent, 'Beta', 'Models'));
		});

		test('disallows extraction when file has a single type', () => {
			const content = 'namespace MyApp;\n\npublic class OnlyOne\n{\n}';
			assert.ok(!canExtractTypeFromFile(content, 'OnlyOne', 'OnlyOne'));
		});

		test('disallows extraction when file name matches type name', () => {
			assert.ok(!canExtractTypeFromFile(multiTypeContent, 'Beta', 'Beta'));
		});

		test('finds type declaration span', () => {
			const span = findTypeDeclarationSpan(multiTypeContent, 'Beta');
			assert.ok(span);
			assert.ok(span!.text.includes('public class Beta'));
		});

		test('builds extracted file with usings and namespace', () => {
			const span = findTypeDeclarationSpan(multiTypeContent, 'Beta');
			assert.ok(span);
			const extracted = buildExtractedFileContent(multiTypeContent, span!.text);
			assert.ok(extracted.includes('using System;'));
			assert.ok(extracted.includes('namespace MyApp.Models;'));
			assert.ok(extracted.includes('public class Beta'));
		});

		test('removes extracted type from source file', () => {
			const span = findTypeDeclarationSpan(multiTypeContent, 'Beta');
			assert.ok(span);
			const updated = removeTypeFromContent(multiTypeContent, span!);
			assert.ok(updated.includes('public class Alpha'));
			assert.ok(!updated.includes('public class Beta'));
		});
	});
});
