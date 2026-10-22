import type { PaginationStatus } from 'convex/browser';
import type { FunctionArgs, FunctionReference } from 'convex/server';
import type { Value } from 'convex/values';
import { useConvexClient } from './client.svelte.js';
import { SKIP } from './shared/args.js';
import { parseArgsWithSkip } from './internal/args.svelte.js';
import { isClientActive } from './internal/client_status.js';
import { subscribePaginated } from './shared/paginated_subscription.js';
import type {
	PageItem,
	PaginatedReturnType,
	UsePaginatedQueryOptions as BasePaginatedQueryOptions,
	UsePaginatedQueryReturn as BasePaginatedQueryReturn,
	WithoutPaginationOpts
} from './shared/types.js';
import {
	PaginatedQueryStateMachine,
	serializeArgsKey,
	type PaginatedQueryConfig
} from './shared/paginated_query_state.js';

export type UsePaginatedQueryOptions<Query extends FunctionReference<'query'>> =
	BasePaginatedQueryOptions & {
		/**
		 * Optional initial data for hydration/SSR.
		 */
		initialData?: PaginatedReturnType<PageItem<Query>>;
		/**
		 * Instead of clearing results when args change, keep previous page
		 * while loading the new one.
		 */
		keepPreviousData?: boolean;
	};

export type UsePaginatedQueryReturn<Query extends FunctionReference<'query'>> =
	BasePaginatedQueryReturn<Query> & {
		error: Error | undefined;
	};

/**
 * Subscribe to a paginated Convex query with automatic cursor management.
 *
 * This hook uses an imperative state machine (`PaginatedQueryStateMachine`) to handle:
 * - InvalidCursor error detection and automatic pagination reset
 * - "keep previous data" vs "clear on args change" behavior
 * - Initial data hydration for SSR
 *
 * The state machine is framework-agnostic and can be wrapped by React, Vue, Solid, etc.
 * This Svelte hook adds only Svelte-specific reactivity on top.
 *
 * @param query - A FunctionReference to a paginated query
 * @param args - Query arguments (without paginationOpts) or "skip"
 * @param options - Configuration including initialNumItems
 * @returns Reactive pagination state with results, status, loadMore, etc.
 */

export function usePaginatedQuery<Query extends FunctionReference<'query'>>(
	query: Query,
	args:
		| WithoutPaginationOpts<FunctionArgs<Query>>
		| 'skip'
		| (() => WithoutPaginationOpts<FunctionArgs<Query>> | 'skip') = {} as WithoutPaginationOpts<
		FunctionArgs<Query>
	>,
	options: UsePaginatedQueryOptions<Query> | (() => UsePaginatedQueryOptions<Query>)
): UsePaginatedQueryReturn<Query> {
	const client = useConvexClient();
	if (typeof query === 'string') {
		throw new Error('Query must be a functionReference object, not a string');
	}

	// Parse initial options to create the state machine
	const initialOpts = parsePaginatedOptions<Query>(options);

	// Create the framework-agnostic state machine
	const machineConfig: PaginatedQueryConfig<PageItem<Query>> = {
		initialNumItems: initialOpts.initialNumItems,
		initialData: initialOpts.initialData,
		keepPreviousData: initialOpts.keepPreviousData
	};
	const machine = new PaginatedQueryStateMachine<PageItem<Query>>(machineConfig);

	// Svelte-specific: reactive state that mirrors machine state
	// resetKey is tracked reactively to trigger effect re-runs on InvalidCursor
	const state = $state<{
		results: PageItem<Query>[];
		status: PaginationStatus;
		isLoading: boolean;
		error: Error | undefined;
		loadMore: (numItems: number) => boolean;
		resetKey: number;
	}>({
		...machine.getSnapshot()
	});

	// Subscribe to machine state changes and sync to Svelte reactive state
	$effect(() => {
		return machine.subscribe(() => {
			const snapshot = machine.getSnapshot();
			state.results = snapshot.results;
			state.status = snapshot.status;
			state.isLoading = snapshot.isLoading;
			state.error = snapshot.error;
			state.loadMore = snapshot.loadMore;
			state.resetKey = snapshot.resetKey;
		});
	});

	$effect(() => {
		// Read resetKey to create reactive dependency - triggers re-run on InvalidCursor reset
		void state.resetKey;

		// Parse current args (reactive read)
		const argsObject = parseArgsWithSkip(
			args as Record<string, Value> | 'skip' | (() => Record<string, Value> | 'skip')
		);
		const opts = parsePaginatedOptions<Query>(options);
		machine.updateConfig({
			initialNumItems: opts.initialNumItems,
			keepPreviousData: opts.keepPreviousData
		});

		// Notify machine of args change
		const argsKey =
			argsObject === SKIP ? null : serializeArgsKey(argsObject as Record<string, Value>);
		machine.onArgsChange(argsKey);

		// Handle disabled or closed client
		if (!isClientActive(client)) {
			return;
		}

		// Handle skip - no subscription needed
		if (argsObject === SKIP) {
			return;
		}

		// Subscribe; errors the client throws (e.g. for a failed page) reach the
		// machine like errors from onError, and cleanup is always returned.
		const unsubscribe = subscribePaginated(
			client,
			query,
			argsObject as FunctionArgs<Query>,
			opts.initialNumItems,
			(current) =>
				machine.onUpdate({
					results: current.results as PageItem<Query>[],
					status: current.status,
					loadMore: (numItems: number) => current.loadMore(numItems)
				}),
			// An InvalidCursor resets the machine (once), which changes resetKey
			// and re-runs this effect — unless resubscribing can't help. The
			// returned `true` releases the failed subscription right away.
			(error, retryable) => machine.onError(error, { allowReset: retryable })
		);

		return unsubscribe;
	});

	return {
		get results() {
			return state.results;
		},
		get status() {
			return state.status;
		},
		get isLoading() {
			return state.isLoading;
		},
		get error() {
			return state.error;
		},
		loadMore(numItems: number) {
			return state.loadMore(numItems);
		}
	} as UsePaginatedQueryReturn<Query>;
}

function parsePaginatedOptions<Query extends FunctionReference<'query'>>(
	options: UsePaginatedQueryOptions<Query> | (() => UsePaginatedQueryOptions<Query>)
): UsePaginatedQueryOptions<Query> {
	if (typeof options === 'function') {
		options = options();
	}
	const snapshot = $state.snapshot(options);
	if (typeof snapshot.initialNumItems !== 'number' || snapshot.initialNumItems < 0) {
		throw new Error(
			`\`options.initialNumItems\` must be a positive number. Received \`${snapshot.initialNumItems}\`.`
		);
	}
	// Cast needed because $state.snapshot returns Snapshot<T>, but for plain
	// Convex data the snapshot is structurally identical to the original type
	return snapshot as UsePaginatedQueryOptions<Query>;
}
