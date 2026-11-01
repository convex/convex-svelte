import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName, makeFunctionReference } from 'convex/server';
import * as devalue from 'devalue';
import { invalidCursor, sharedPaginatedClient } from '../../test/shared-paginated-client.js';

// ---------------------------------------------------------------------------
// Detached paginated queries (createDetachedPaginatedQuery, convexLoadPaginated)
// on a client that shares one paginated query between subscribers with the
// same query, args and page size (#61). After an InvalidCursor, all of them
// must release the failed query before any of them subscribes again.
// ---------------------------------------------------------------------------

const { current } = vi.hoisted(() => {
	// convexLoadPaginated takes its browser path when a document exists.
	globalThis.document = {} as Document;
	return { current: { client: undefined as unknown } };
});

vi.mock('../internal/singleton.js', () => ({
	getConvexClient: () => current.client,
	deferSubscription: (fn: () => void) => fn(),
	isInitialHydration: () => false,
	onCloseConvex: () => {},
	getConvexUrl: () => 'https://test.convex.cloud',
	_getServerToken: () => undefined
}));

// The real module needs SvelteKit's `$app/state`; reader tracking is a no-op here.
vi.mock('./route-data.svelte.js', async () => {
	const { RouteQuery } = await import('./query-lifecycle.js');
	return {
		createRouteQuery: (
			handle: ConstructorParameters<typeof RouteQuery>[0],
			keepAlive: boolean,
			key: string
		) => ({
			query: new RouteQuery(handle, keepAlive, key),
			track: () => {}
		})
	};
});

import { openDetachedPaginatedQuery } from './paginated-query-detached.svelte.js';
import {
	ConvexLoadPaginatedResult,
	convexLoadPaginated,
	decodeConvexLoadPaginated,
	encodeConvexLoadPaginated
} from './transport.svelte.js';
import { _resetQueryLifecycle } from './query-lifecycle.js';

const list = makeFunctionReference<'query'>('messages:paginatedList');

let convex: ReturnType<typeof sharedPaginatedClient>;

beforeEach(() => {
	convex = sharedPaginatedClient();
	current.client = convex.client;
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	_resetQueryLifecycle();
	vi.restoreAllMocks();
});

/** Lets the queued resubscriptions run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('detached paginated queries sharing a failed query', () => {
	it('replace it once, and loads waiting for their first page keep waiting', async () => {
		const opened = [1, 2].map(() =>
			openDetachedPaginatedQuery(list, {}, { initialNumItems: 2, immediate: true })
		);
		const loaded = Promise.allSettled(opened.map(({ firstValue }) => firstValue));

		convex.fail(invalidCursor());
		await settle();

		expect(convex.counts).toEqual({ added: 2, removed: 1 });
		convex.deliver(['fresh']);
		expect((await loaded).map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled']);
		for (const { result } of opened) {
			expect(result.error).toBeUndefined();
			expect(result.results).toEqual(['fresh']);
		}

		for (const { result } of opened) result.dispose();
		expect(convex.active()).toBe(0);
	});

	it('recover through convexLoadPaginated after the first page', async () => {
		const loads = [1, 2].map(() => convexLoadPaginated(list, {}, { initialNumItems: 2 }));
		convex.deliver(['A', 'B']);
		const results = await Promise.all(loads);

		convex.fail(invalidCursor());
		await settle();

		expect(convex.counts).toEqual({ added: 2, removed: 1 });
		convex.deliver(['fresh']);
		for (const result of results) {
			expect(result.error).toBeUndefined();
			expect(result.results).toEqual(['fresh']);
		}
	});

	it('recover after decoding server-rendered first pages', async () => {
		// The server's result for one convexLoadPaginated, through the transport
		// encoder and SvelteKit's serializer.
		const firstPage = { page: ['A', 'B'], isDone: false, continueCursor: 'c1' };
		const serialized = devalue.stringify(
			encodeConvexLoadPaginated(
				new ConvexLoadPaginatedResult(getFunctionName(list), {}, 2, firstPage)
			)
		);
		const decoded = [1, 2].map(() => decodeConvexLoadPaginated(devalue.parse(serialized)));
		convex.deliver(['A', 'B']);
		for (const result of decoded) expect(result.results).toEqual(['A', 'B']);
		expect(convex.counts).toEqual({ added: 1, removed: 0 });

		convex.fail(invalidCursor());
		await settle();

		expect(convex.counts).toEqual({ added: 2, removed: 1 });
		convex.deliver(['fresh']);
		for (const result of decoded) {
			expect(result.error).toBeUndefined();
			expect(result.results).toEqual(['fresh']);
		}

		for (const result of decoded) result.dispose();
		expect(convex.counts).toEqual({ added: 2, removed: 2 });
		expect(convex.active()).toBe(0);
	});
});
