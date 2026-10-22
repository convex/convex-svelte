import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFunctionReference } from 'convex/server';
import { invalidCursor, sharedPaginatedClient } from '../test/shared-paginated-client.js';

// usePaginatedQuery with its effects running, on a client that shares one
// paginated query between hooks with the same query, args and page size.

const { current } = vi.hoisted(() => ({
	current: { client: undefined as unknown }
}));

vi.mock('./client.svelte.js', () => ({ useConvexClient: () => current.client }));

import { usePaginatedQuery } from './use_paginated_query.svelte.js';

const list = makeFunctionReference<'query'>('messages:paginatedList');

let convex: ReturnType<typeof sharedPaginatedClient>;
let stops: Array<() => void> = [];

beforeEach(() => {
	convex = sharedPaginatedClient();
	current.client = convex.client;
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	for (const stop of stops) stop();
	stops = [];
	vi.restoreAllMocks();
});

function mountHook() {
	let hook!: ReturnType<typeof usePaginatedQuery<typeof list>>;
	stops.push(
		$effect.root(() => {
			hook = usePaginatedQuery(list, {}, { initialNumItems: 2 });
		})
	);
	return hook;
}

/** Lets the effects that re-subscribe after a reset run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('usePaginatedQuery on a shared paginated query (#61)', () => {
	it.each([2, 3])('replaces the query once after an InvalidCursor, for %i hooks', async (count) => {
		const hooks = Array.from({ length: count }, mountHook);
		await settle();
		convex.deliver(['A', 'B']);
		expect(convex.counts).toEqual({ added: 1, removed: 0 });

		convex.fail(invalidCursor());
		await settle();

		// Every hook let go of the failed query before any resubscribed.
		expect(convex.counts).toEqual({ added: 2, removed: 1 });
		convex.deliver(['fresh']);
		for (const hook of hooks) {
			expect(hook.error).toBeUndefined();
			expect(hook.results).toEqual(['fresh']);
		}

		for (const stop of stops.splice(0)) stop();
		expect(convex.active()).toBe(0);
	});
});
