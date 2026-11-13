import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { WorkQueue, throwIfCancelled } from './asyncWork.js';

const queue = new WorkQueue(2);
let output: vscode.OutputChannel | undefined;
let lifetime = new vscode.CancellationTokenSource();

export function registerDotnetCli(context: Pick<vscode.ExtensionContext, 'subscriptions'>): void {
	if (lifetime.token.isCancellationRequested) { lifetime = new vscode.CancellationTokenSource(); }
	context.subscriptions.push({ dispose: () => {
		lifetime.cancel();
		lifetime.dispose();
		output?.dispose();
		output = undefined;
	} });
}

export function runDotnet(
	args: readonly string[],
	cwd: string,
	token?: vscode.CancellationToken,
	timeout = 120_000,
): Promise<{ stdout: string; stderr: string }> {
	const source = new vscode.CancellationTokenSource();
	const cancellation = token?.onCancellationRequested(() => source.cancel());
	const shutdown = lifetime.token.onCancellationRequested(() => source.cancel());
	if (token?.isCancellationRequested || lifetime.token.isCancellationRequested) { source.cancel(); }
	return queue.run(() => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		throwIfCancelled(source.token);
		output ??= vscode.window.createOutputChannel('CSharp Painkiller .NET');
		output.appendLine(`> dotnet ${args.join(' ')} (${cwd})`);
		const controller = new AbortController();
		const subscription = source.token.onCancellationRequested(() => controller.abort());
		const child = execFile('dotnet', [...args], {
			cwd, encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024,
			signal: controller.signal, shell: false,
		}, (error, stdout, stderr) => {
			subscription?.dispose();
			if (source.token.isCancellationRequested) {
				reject(new vscode.CancellationError());
			} else if (error) {
				output?.appendLine(error.message);
				reject(new Error((stderr || stdout || error.message).trim()));
			} else {
				resolve({ stdout, stderr });
			}
		});
		child.stdout?.on('data', (chunk: Buffer | string) => output?.append(chunk.toString()));
		child.stderr?.on('data', (chunk: Buffer | string) => output?.append(chunk.toString()));
	}), source.token).finally(() => { cancellation?.dispose(); shutdown.dispose(); source.dispose(); });
}
