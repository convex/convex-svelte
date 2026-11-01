/**
 * A stand-in for `ConvexClient.onPaginatedUpdate_experimental` that shares one
 * paginated query between all subscribers with the same query, args and page
 * size, as the real client does. The shared query, and so its failure, lives
 * until its last subscriber released it; only then does a new subscriber get
 * a fresh query. `added` and `removed` count the queries it subscribed to and
 * released, i.e. the `Add` and `Remove` the real client sends to the server.
 */
import type { ConvexClient } from 'convex/browser';
import { getFunctionName } from 'convex/server';
import type { PaginatedSnapshot } from '../lib/shared/paginated_subscription.js';

type Listener = { onUpdate: () => void; onError: (error: Error) => void };
type SharedQuery = { listeners: Set<Listener>; value: PaginatedSnapshot | Error };

export function sharedPaginatedClient() {
	const queries = new Map<string, SharedQuery>();
	const counts = { added: 0, removed: 0 };

	const add = (key: string) => {
		const entry: SharedQuery = {
			listeners: new Set(),
			value: { results: [], status: 'LoadingFirstPage', loadMore: () => false }
		};
		queries.set(key, entry);
		counts.added += 1;
		return entry;
	};

	const subscribe: ConvexClient['onPaginatedUpdate_experimental'] = (
		query,
		args,
		{ initialNumItems },
		onUpdate,
		onError
	) => {
		const key = JSON.stringify([getFunctionName(query), args, initialNumItems]);
		const entry = queries.get(key) ?? add(key);
		const listener: Listener = {
			// Typed as a `PaginationResult`, but the client passes what
			// getCurrentValue() returns. subscribePaginated reads the latter.
			onUpdate: () => onUpdate(entry.value as never),
			onError: (error) => onError?.(error)
		};
		entry.listeners.add(listener);

		const unsubscribe = () => {
			if (!entry.listeners.delete(listener) || entry.listeners.size > 0) return;
			queries.delete(key);
			counts.removed += 1;
		};
		return Object.assign(unsubscribe, {
			unsubscribe,
			getCurrentValue: () => {
				if (entry.value instanceof Error) throw entry.value;
				return entry.value;
			},
			getQueryLogs: () => undefined
		}) as ReturnType<ConvexClient['onPaginatedUpdate_experimental']>;
	};

	return {
		client: { closed: false, disabled: false, onPaginatedUpdate_experimental: subscribe },
		counts,
		/** Number of shared queries currently subscribed. */
		active: () => queries.size,
		/** A first page for every subscribed query. */
		deliver(results: unknown[]) {
			for (const shared of queries.values()) {
				shared.value = { results, status: 'CanLoadMore', loadMore: () => true };
				for (const listener of shared.listeners) listener.onUpdate();
			}
		},
		/** Fails every subscribed query, reported to each of its subscribers. */
		fail(error: Error) {
			for (const shared of queries.values()) {
				shared.value = error;
				for (const listener of shared.listeners) listener.onError(error);
			}
		}
	};
}

export const invalidCursor = () =>
	new Error('InvalidCursor: Tried to run a query starting from a cursor from a different query.');
