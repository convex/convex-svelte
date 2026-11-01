/**
 * createDetachedPaginatedQuery — live paginated Convex subscription without component context.
 *
 * Used by `transport.decode` for paginated SSR results and `convexLoadPaginated()` on
 * client-side navigation. Route-scoped queries are released once the current route no
 * longer uses them — see `query-lifecycle.ts`. Manually scoped queries live until
 * `dispose()` is called or the ConvexClient is closed.
 *
 * Unlike `usePaginatedQuery` (which requires Svelte component context for `useConvexClient`),
 * this uses the module-level singleton via `getConvexClient()`.
 */
import type { PaginationStatus } from 'convex/browser';
import type { FunctionReference, FunctionArgs } from 'convex/server';
import { getFunctionName } from 'convex/server';
import type { Value } from 'convex/values';
import { getConvexClient, deferSubscription } from '../internal/singleton.js';
import { isClientActive } from '../internal/client_status.js';
import type { PageItem, PaginatedReturnType, WithoutPaginationOpts } from '../shared/types.js';
import {
	PaginatedQueryStateMachine,
	serializeArgsKey,
	type PaginatedQueryConfig
} from '../shared/paginated_query_state.js';
import { markRouteQuery, type SubscriptionHandle } from './query-lifecycle.js';
import { paginatedQueryKey } from './query-key.js';
import { createRouteQuery } from './route-data.svelte.js';
import { subscribePaginated, type PaginatedSnapshot } from '../shared/paginated_subscription.js';
import type { DetachedQueryOptions } from './query-detached.svelte.js';

export type DetachedPaginatedQueryResult<Query extends FunctionReference<'query'>> = {
	readonly results: PageItem<Query>[];
	readonly status: PaginationStatus;
	readonly isLoading: boolean;
	readonly error: Error | undefined;
	loadMore(numItems: number): boolean;
	/** Stop the live subscription permanently. Safe to call multiple times. */
	dispose(): void;
};

/**
 * Create a live paginated Convex subscription without component context.
 * Uses `$state` (compiles to raw signals — works outside components).
 *
 * @param query - A FunctionReference to a paginated query.
 * @param args - Query arguments (without paginationOpts).
 * @param options - Configuration: `initialNumItems`, optional `initialData`, and the
 * subscription lifecycle (`scope`, `keepAlive`, see {@link DetachedQueryOptions}).
 */
export function createDetachedPaginatedQuery<Query extends FunctionReference<'query'>>(
	query: Query,
	args: WithoutPaginationOpts<FunctionArgs<Query>>,
	options: {
		initialNumItems: number;
		initialData?: PaginatedReturnType<PageItem<Query>>;
	} & DetachedQueryOptions
): DetachedPaginatedQueryResult<Query> {
	return openDetachedPaginatedQuery(query, args, options).result;
}

/**
 * Like {@link createDetachedPaginatedQuery}, plus the pieces `convexLoadPaginated`
 * needs to get its first page from the live subscription instead of a separate
 * one-shot query. See `openDetachedQuery` for `immediate` and `firstValue`.
 * @internal
 */
export function openDetachedPaginatedQuery<Query extends FunctionReference<'query'>>(
	query: Query,
	args: WithoutPaginationOpts<FunctionArgs<Query>>,
	options: {
		initialNumItems: number;
		initialData?: PaginatedReturnType<PageItem<Query>>;
	} & DetachedQueryOptions & { immediate?: boolean }
): { result: DetachedPaginatedQueryResult<Query>; firstValue: Promise<void> } {
	const client = getConvexClient();

	// Create the framework-agnostic state machine
	const machineConfig: PaginatedQueryConfig<PageItem<Query>> = {
		initialNumItems: options.initialNumItems,
		initialData: options.initialData,
		keepPreviousData: true
	};
	const machine = new PaginatedQueryStateMachine<PageItem<Query>>(machineConfig);

	// Svelte reactive state mirroring machine state
	const snapshot = machine.getSnapshot();
	let results: PageItem<Query>[] = $state(snapshot.results);
	let status: PaginationStatus = $state(snapshot.status);
	let isLoading: boolean = $state(snapshot.isLoading);
	let error: Error | undefined = $state(snapshot.error);
	let loadMoreFn: (numItems: number) => boolean = $state(snapshot.loadMore);

	// Sync machine snapshot → $state variables so Svelte signals fire on
	// every machine mutation (updates, errors, queued loadMore requests).
	// The machine is owned by this result object, so the listener is never
	// removed — it is garbage-collected together with the result.
	function syncState(): void {
		const s = machine.getSnapshot();
		results = s.results;
		status = s.status;
		isLoading = s.isLoading;
		error = s.error;
		loadMoreFn = s.loadMore;
	}
	machine.subscribe(syncState);

	let settleFirstValue: ((error?: Error) => void) | undefined;
	const firstValue = new Promise<void>((resolve, reject) => {
		settleFirstValue = (e) => {
			settleFirstValue = undefined;
			if (e) reject(e);
			else resolve();
		};
	});
	// Only convexLoadPaginated awaits it; don't report rejections nobody listens to.
	firstValue.catch(() => {});

	let unsubscribe: (() => void) | undefined;
	let wanted = false;
	let immediate = options.immediate ?? false;
	// Incremented on every close. Convex identifies a paginated query by its
	// args, so a loadMore callback from a closed subscription would otherwise
	// throw or load pages into a newer subscription with the same args.
	let generation = 0;

	const subscribe = () => {
		// Skip if closed again before a deferred subscribe ran, or already open.
		if (!wanted || unsubscribe || !isClientActive(client)) return;
		const subscriptionGeneration = generation;
		const loadMoreWhileOpen = (loadMore: (numItems: number) => boolean) => (numItems: number) =>
			subscriptionGeneration === generation && loadMore(numItems);
		// Convex reports `LoadingFirstPage` (with no results) until the first
		// page arrived — only then is there a first value to hand to the load.
		const onSnapshot = (current: PaginatedSnapshot) => {
			machine.onUpdate({
				results: current.results as PageItem<Query>[],
				status: current.status,
				loadMore: loadMoreWhileOpen(current.loadMore)
			});
			if (current.status !== 'LoadingFirstPage') settleFirstValue?.();
		};
		const onError = (e: Error, retryable: boolean) => {
			if (subscriptionGeneration !== generation) return false;
			if (machine.onError(e, { allowReset: retryable })) {
				// InvalidCursor: the machine reset pagination (once). Start over with
				// a fresh subscription; a load keeps waiting for its first page.
				// Returning true releases the failed one at once, before any
				// subscriber sharing it subscribes again.
				queueMicrotask(restart);
				return true;
			}
			settleFirstValue?.(e);
			return false;
		};

		unsubscribe = subscribePaginated(
			client,
			query,
			args as FunctionArgs<Query>,
			options.initialNumItems,
			onSnapshot,
			onError
		);
	};

	/** Replace the subscription with a fresh one, e.g. after an InvalidCursor reset. */
	const restart = () => {
		if (!wanted || !unsubscribe) return;
		generation += 1;
		unsubscribe();
		unsubscribe = undefined;
		subscribe();
	};

	const handle: SubscriptionHandle = {
		open() {
			// Disabled (SSR) or closed clients never subscribe. Checked before
			// queueing: the server never flushes the deferred queue.
			if (!isClientActive(client)) return;
			wanted = true;
			if (immediate) {
				immediate = false;
				subscribe();
				return;
			}
			// Defer subscription until setupAuth (or setupConvex for no-auth apps)
			// calls flushDeferredSubscriptions(). See query-detached.svelte.ts.
			deferSubscription(subscribe);
		},
		close() {
			wanted = false;
			generation += 1;
			settleFirstValue?.(new Error('The query was disposed before its first result.'));
			unsubscribe?.();
			unsubscribe = undefined;
		}
	};

	if (isClientActive(client)) {
		// Notify machine of initial args
		const argsKey = serializeArgsKey(args as Record<string, Value>);
		machine.onArgsChange(argsKey);
	} else if (options.immediate) {
		settleFirstValue?.(new Error('The ConvexClient is disabled or closed.'));
	}

	let disposed = false;
	const createResult = (
		track: () => void,
		dispose: () => void
	): DetachedPaginatedQueryResult<Query> => ({
		get results() {
			track();
			return results;
		},
		get status() {
			track();
			return status;
		},
		get isLoading() {
			track();
			return isLoading;
		},
		get error() {
			track();
			return error;
		},
		loadMore(numItems: number) {
			// While merely released, the machine queues the request for the
			// next subscription. A disposed query (also via closeConvex()) or a
			// closed client has none — never queue.
			return !disposed && isClientActive(client) && loadMoreFn(numItems);
		},
		dispose() {
			disposed = true;
			dispose();
		}
	});

	// Inactive clients never subscribe, so they need no route lifecycle (or its timers).
	if (options.scope !== 'route' || !isClientActive(client)) {
		handle.open();
		const result = createResult(
			() => {},
			() => handle.close()
		);
		return { result, firstValue };
	}

	const route = createRouteQuery(
		handle,
		options.keepAlive ?? true,
		paginatedQueryKey(getFunctionName(query), args, options.initialNumItems)
	);
	if (options.immediate) route.query.holdWhile(firstValue);
	const result = markRouteQuery(
		createResult(route.track, () => route.query.dispose()),
		route.query
	);
	return { result, firstValue };
}
