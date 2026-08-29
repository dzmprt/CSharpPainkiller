import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { migrateSolutionToSlnx } from '../services/migrateSolutionToSlnx.js';

suite('migrateSolutionToSlnx', () => {
	test('does nothing for a non-solution file', async () => {
		await assert.doesNotReject(
			migrateSolutionToSlnx(vscode.Uri.file(path.join(os.tmpdir(), 'project.cs')))
		);
	});

	test('does not overwrite an existing slnx file', async () => {
		const basePath = path.join(os.tmpdir(), `csharp-painkiller-${process.pid}-${Date.now()}`);
		const slnUri = vscode.Uri.file(`${basePath}.sln`);
		const slnxUri = vscode.Uri.file(`${basePath}.slnx`);

		try {
			await vscode.workspace.fs.writeFile(slnUri, new TextEncoder().encode('solution'));
			await vscode.workspace.fs.writeFile(slnxUri, new TextEncoder().encode('solutionx'));

			await migrateSolutionToSlnx(slnUri);

			await vscode.workspace.fs.stat(slnUri);
			const slnxContent = await vscode.workspace.fs.readFile(slnxUri);
			assert.strictEqual(new TextDecoder().decode(slnxContent), 'solutionx');
		} finally {
			await vscode.workspace.fs.delete(slnUri, { useTrash: false });
			await vscode.workspace.fs.delete(slnxUri, { useTrash: false });
		}
	});
});