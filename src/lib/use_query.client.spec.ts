import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Value } from 'convex/values';

// ---------------------------------------------------------------------------
// Tests for useQuery against a fake ConvexClient that the tests answer by hand.
//
// An answer equal to the stored result (a primitive such as `25`) leaves
// `state.result` unchanged, so it must still make useQuery read the client's
// cache again (issue #72).
// ---------------------------------------------------------------------------

const fake = vi.hoisted(() => {
	type Listener = { args: Record<string, Value>; onAnswer: (value: Value) => void };
	const listeners = new Set<Listener>();
	const cache = new Map<string, Value>();
	const key = (args: Record<string, Value>) => JSON.stringify(args);

	const client = {
		closed: false,
		disabled: false,
		onUpdate(_query: unknown, args: Record<string, Value>, onAnswer: (value: Value) => void) {
			const listener = { args, onAnswer };
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		client: {
			localQueryResult: (_name: string, args: Record<string, Value>) => cache.get(key(args))
		}
	};

	return {
		client,
		/** Deliver an answer the way ConvexClient does: cache it, then call the listeners. */
		answer(args: Record<string, Value>, value: Value) {
			cache.set(key(args), value);
			for (const listener of listeners) {
				if (key(listener.args) === key(args)) listener.onAnswer(value);
			}
		},
		reset() {
			listeners.clear();
			cache.clear();
		}
	};
});

vi.mock('svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('svelte')>()),
	getContext: () => fake.client
}));

const { flushSync } = await import('svelte');
const { runUseQuery } = await import('./use_query.spec.svelte.js');

describe('useQuery with an answer equal to the stored result', () => {
	let destroy: (() => void) | undefined;

	afterEach(() => {
		destroy?.();
		destroy = undefined;
		fake.reset();
	});

	it.each([25, null, true, 'owner'])(
		'shows the answer %j for new args when it equals the previous answer',
		(value) => {
			const query = runUseQuery({ search: '' });
			destroy = query.destroy;
			flushSync();
			fake.answer({ search: '' }, value);
			flushSync();
			expect(query.result.data).toBe(value);

			query.input.search = 'x';
			flushSync();
			expect(query.result.isLoading).toBe(true);

			fake.answer({ search: 'x' }, value);
			flushSync();
			expect(query.result.isLoading).toBe(false);
			expect(query.result.data).toBe(value);
		}
	);

	it('shows the first answer when initialData turned undefined and the answer equals it', () => {
		const query = runUseQuery({ search: '', initialData: 'owner' });
		destroy = query.destroy;
		flushSync();
		expect(query.result.data).toBe('owner');

		query.input.initialData = undefined;
		flushSync();
		expect(query.result.isLoading).toBe(true);

		fake.answer({ search: '' }, 'owner');
		flushSync();
		expect(query.result.isLoading).toBe(false);
		expect(query.result.data).toBe('owner');
	});
});
