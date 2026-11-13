import * as vscode from 'vscode';

export function throwIfCancelled(token?: vscode.CancellationToken): void {
	if (token?.isCancellationRequested) { throw new vscode.CancellationError(); }
}

/** Cancels a consumer's wait without cancelling work shared by other consumers. */
export async function waitWithCancellation<T>(result: Promise<T>, token?: vscode.CancellationToken): Promise<T> {
	throwIfCancelled(token);
	if (!token) { return result; }
	let subscription: vscode.Disposable | undefined;
	try {
		return await Promise.race([
			result,
			new Promise<never>((_resolve, reject) => {
				subscription = token.onCancellationRequested(() => reject(new vscode.CancellationError()));
			}),
		]);
	} finally {
		subscription?.dispose();
	}
}

export class AsyncCache<K, V> {
	private readonly values = new Map<K, { value: V; expires: number }>();
	private readonly pending = new Map<K, Promise<V>>();

	constructor(private readonly capacity: number, private readonly ttlMs = Infinity) {
		if (!Number.isInteger(capacity) || capacity < 1 || ttlMs <= 0 || Number.isNaN(ttlMs)) {
			throw new Error('Cache capacity and lifetime must be positive.');
		}
	}

	get(key: K, load: () => Promise<V>): Promise<V> {
		const cached = this.values.get(key);
		if (cached && cached.expires > Date.now()) {
			this.values.delete(key);
			this.values.set(key, cached);
			return Promise.resolve(cached.value);
		}
		this.values.delete(key);
		const pending = this.pending.get(key);
		if (pending) { return pending; }
		const result = Promise.resolve().then(load);
		this.pending.set(key, result);
		result.then(value => {
			if (this.pending.get(key) !== result) { return; }
			this.pending.delete(key);
			this.values.set(key, { value, expires: Date.now() + this.ttlMs });
			while (this.values.size > this.capacity) {
				this.values.delete(this.values.keys().next().value!);
			}
		}, () => {
			if (this.pending.get(key) === result) { this.pending.delete(key); }
		});
		return result;
	}

	delete(key: K): void {
		this.values.delete(key);
		this.pending.delete(key);
	}

	clear(): void {
		this.values.clear();
		this.pending.clear();
	}
}

interface QueuedWork {
	start: () => void;
	priority: boolean;
}

export class WorkQueue {
	private running = 0;
	private readonly pending: QueuedWork[] = [];

	constructor(private readonly concurrency: number) {
		if (!Number.isInteger(concurrency) || concurrency < 1) {
			throw new Error('Work queue concurrency must be a positive integer.');
		}
	}

	run<T>(work: () => Promise<T>, token?: vscode.CancellationToken, priority = false): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (token?.isCancellationRequested) { reject(new vscode.CancellationError()); return; }
			let subscription: vscode.Disposable | undefined;
			const item: QueuedWork = {
				priority,
				start: () => {
					subscription?.dispose();
					this.running++;
					Promise.resolve().then(() => {
						throwIfCancelled(token);
						return work();
					}).then(resolve, reject).finally(() => {
						this.running--;
						this.drain();
					});
				},
			};
			subscription = token?.onCancellationRequested(() => {
				const index = this.pending.indexOf(item);
				if (index < 0) { return; }
				this.pending.splice(index, 1);
				subscription?.dispose();
				reject(new vscode.CancellationError());
			});
			this.pending.push(item);
			this.drain();
		});
	}

	private drain(): void {
		while (this.running < this.concurrency && this.pending.length > 0) {
			const priorityIndex = this.pending.findIndex(item => item.priority);
			this.pending.splice(priorityIndex < 0 ? 0 : priorityIndex, 1)[0].start();
		}
	}
}
