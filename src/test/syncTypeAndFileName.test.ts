import * as assert from 'assert';
import {
	getSingleRenamableType,
	isValidCSharpIdentifier,
	renameSingleTypeInContent,
} from '../services/syncTypeAndFileName.js';

suite('syncTypeAndFileName', () => {
	suite('getSingleRenamableType', () => {
		test('finds a single class', () => {
			const content = 'namespace MyApp;\n\npublic sealed class Book { }';
			assert.deepStrictEqual(getSingleRenamableType(content), {
				name: 'Book',
				kind: 'class',
				nameStart: content.indexOf('Book'),
				nameEnd: content.indexOf('Book') + 'Book'.length,
			});
		});

		test('finds a single record struct', () => {
			const content = 'namespace MyApp;\n\npublic readonly record struct Point;';
			const result = getSingleRenamableType(content);
			assert.strictEqual(result?.name, 'Point');
			assert.strictEqual(result?.kind, 'record struct');
		});

		test('returns null when multiple renamable types exist', () => {
			const content = [
				'namespace MyApp;',
				'',
				'public class Book { }',
				'public record Author;',
			].join('\n');
			assert.strictEqual(getSingleRenamableType(content), null);
		});

		test('ignores type-looking text in comments and strings', () => {
			const content = [
				'namespace MyApp;',
				'',
				'// public class CommentedOut { }',
				'public class Book',
				'{',
				'    private const string Sample = "public record Fake;";',
				'}',
			].join('\n');
			const result = getSingleRenamableType(content);
			assert.strictEqual(result?.name, 'Book');
			assert.strictEqual(result?.kind, 'class');
		});
	});

	suite('renameSingleTypeInContent', () => {
		test('renames the only class to the file name', () => {
			const content = 'namespace MyApp;\n\npublic class OldName { }';
			assert.strictEqual(
				renameSingleTypeInContent(content, 'NewName'),
				'namespace MyApp;\n\npublic class NewName { }'
			);
		});

		test('renames the only record to the file name', () => {
			const content = 'namespace MyApp;\n\npublic record OldName;';
			assert.strictEqual(
				renameSingleTypeInContent(content, 'NewName'),
				'namespace MyApp;\n\npublic record NewName;'
			);
		});

		test('does not rename when the new name is not a C# identifier', () => {
			const content = 'namespace MyApp;\n\npublic class OldName { }';
			assert.strictEqual(renameSingleTypeInContent(content, 'New-Name'), null);
		});
	});

	suite('isValidCSharpIdentifier', () => {
		test('accepts ASCII C# identifiers', () => {
			assert.ok(isValidCSharpIdentifier('_Book42'));
		});

		test('rejects file stems with separators', () => {
			assert.ok(!isValidCSharpIdentifier('Book.Designer'));
		});
	});
});
