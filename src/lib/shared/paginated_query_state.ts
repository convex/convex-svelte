import type { PaginationStatus } from 'convex/browser';
import { convexToJson, type Value } from 'convex/values';
import type { PaginatedReturnType } from './types.js';

/**
 * Snapshot of paginated query state.
 *
 * This is the read-only view of state that frameworks expose to consumers.
 */
export type PaginatedQuerySnapshot<T> = {
	results: T[];
	status: PaginationStatus;
	isLoading: boolean;
	error: Error | undefined;
};

/**
 * Configuration for the paginated query state machine.
 */
export type PaginatedQueryConfig<T> = {
	/**
	 * Number of items to load in the first page.
	 */
	initialNumItems: number;

	/**
	 * Optional initial data for hydration/SSR.
	 */
	initialData?: PaginatedReturnType<T>;

	/**
	 * Instead of clearing results when args change, keep previous data while loading new.
	 * Default: false (clear on args change)
	 */
	keepPreviousData?: boolean;
};

/**
 * An update from the underlying subscription.
 *
 * Frameworks call `onUpdate` with this shape when new data arrives.
 */
export type PaginatedQueryUpdate<T> = {
	results: T[];
	status: PaginationStatus;
	loadMore: (numItems: number) => boolean;
};

/**
 * Internal state managed by the state machine.
 */
type InternalState<T> = {
	results: T[];
	status: PaginationStatus;
	isLoading: boolean;
	error: Error | undefined;
	loadMore: (numItems: number) => boolean;
	resetKey: number;
	argsKey: string | null;
	initialArgsKey: string | null;
	haveArgsEverChanged: boolean;
};

/**
 * Imperative state machine for paginated queries.
 *
 * This class centralizes the logic for:
 * - InvalidCursor error detection and pagination reset
 * - "keep previous data" vs "clear on args change" behavior
 * - Initial data hydration (ignore first empty loading snapshot)
 * - Status/isLoading derivation
 *
 * Framework-agnostic: React, Svelte, Vue, Solid can all wrap this.
 *
 * ## Usage
 *
 * ```ts
 * const machine = new PaginatedQueryStateMachine({ initialNumItems: 10 });
 *
 * // When args change
 * const needsReset = machine.onArgsChange(JSON.stringify(args));
 * if (needsReset) {
 *   // Resubscribe with fresh args
 * }
 *
 * // When subscription produces data
 * machine.onUpdate({ results, status, loadMore });
 *
 * // When subscription produces error
 * const handledInvalidCursor = machine.onError(error);
 * if (handledInvalidCursor) {
 *   // Resubscribe - state was reset
 * }
 *
 * // Get current state
 * const { results, status, isLoading, error } = machine.getSnapshot();
 *
 * // Subscribe to changes
 * const unsubscribe = machine.subscribe(() => {
 *   // Re-render or update framework state
 * });
 * ```
 */
export class PaginatedQueryStateMachine<T> {
	private state: InternalState<T>;
	private config: PaginatedQueryConfig<T>;
	private listeners = new Set<() => void>();
	/**
	 * A loadMore request received before the live subscription delivered a
	 * working loadMore function (e.g. SSR initialData shows `CanLoadMore`
	 * before the first server update). Flushed by `onUpdate`.
	 */
	private pendingLoadMoreNumItems: number | null = null;
	/**
	 * Whether the next InvalidCursor may reset pagination. Disarmed by a reset
	 * and re-armed by a real result, changed args or `reset()`: if the cursor
	 * keeps failing (e.g. another subscriber holds the failed query alive), the
	 * second InvalidCursor is surfaced as an error instead of resetting forever.
	 */
	private invalidCursorResetArmed = true;

	constructor(config: PaginatedQueryConfig<T>) {
		this.config = config;
		const hasInitialData = config.initialData !== undefined;

		this.state = {
			results: hasInitialData ? config.initialData!.page : [],
			status: hasInitialData
				? config.initialData!.isDone
					? 'Exhausted'
					: 'CanLoadMore'
				: 'LoadingFirstPage',
			isLoading: !hasInitialData,
			error: undefined,
			loadMore: () => false,
			resetKey: 0,
			argsKey: null,
			initialArgsKey: null,
			haveArgsEverChanged: false
		};
	}

	/**
	 * Get a snapshot of the current public state.
	 */
	getSnapshot(): PaginatedQuerySnapshot<T> & {
		loadMore: (numItems: number) => boolean;
		resetKey: number;
	} {
		return {
			results: this.state.results,
			status: this.state.status,
			isLoading: this.state.isLoading,
			error: this.state.error,
			loadMore: (numItems: number) => this.loadMore(numItems),
			resetKey: this.state.resetKey
		};
	}

	/**
	 * Request more results.
	 *
	 * If the live subscription has not delivered a working loadMore yet
	 * (e.g. rendering from SSR initialData), the request is queued and
	 * fires as soon as the subscription is ready.
	 *
	 * @returns `true` if more results will be loaded, `false` if not
	 * (already loading, exhausted, or skipped).
	 */
	loadMore(numItems: number): boolean {
		if (this.state.status !== 'CanLoadMore') {
			return false;
		}
		if (this.state.loadMore(numItems)) {
			return true;
		}
		// Status says CanLoadMore but the underlying subscription can't load
		// yet — it is still fetching its first page behind initialData.
		// Queue the request; onUpdate flushes it when the subscription is ready.
		this.pendingLoadMoreNumItems = numItems;
		this.state = {
			...this.state,
			status: 'LoadingMore',
			isLoading: this.computeIsLoading('LoadingMore')
		};
		this.notify();
		return true;
	}

	private flushPendingLoadMore(): void {
		if (this.pendingLoadMoreNumItems === null) return;
		if (this.state.status === 'Exhausted') {
			// Nothing more to load — drop the queued request.
			this.pendingLoadMoreNumItems = null;
			return;
		}
		if (this.state.status !== 'CanLoadMore') return;
		if (this.state.loadMore(this.pendingLoadMoreNumItems)) {
			this.pendingLoadMoreNumItems = null;
			this.state = {
				...this.state,
				status: 'LoadingMore',
				isLoading: this.computeIsLoading('LoadingMore')
			};
		}
	}

	/**
	 * Get the current reset key.
	 * Useful for frameworks to detect when to resubscribe.
	 */
	getResetKey(): number {
		return this.state.resetKey;
	}

	/**
	 * Subscribe to state changes.
	 * @returns Unsubscribe function
	 */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((listener) => listener());
	}

	/**
	 * Called when query args change.
	 *
	 * @param newArgsKey - Serialized args (e.g. JSON.stringify(args)), or null for "skip"
	 * @returns Object with:
	 *   - `changed`: whether the args actually changed
	 *   - `needsResubscribe`: whether the framework should create a new subscription
	 */
	onArgsChange(newArgsKey: string | null): {
		changed: boolean;
		needsResubscribe: boolean;
	} {
		// Initialize initial args key on first call
		if (this.state.initialArgsKey === null && newArgsKey !== null) {
			this.state.initialArgsKey = newArgsKey;
		}

		const changed = this.state.argsKey !== newArgsKey;
		if (!changed) {
			return { changed: false, needsResubscribe: false };
		}

		this.state.argsKey = newArgsKey;
		// A queued loadMore belongs to the previous args — drop it.
		this.pendingLoadMoreNumItems = null;
		this.invalidCursorResetArmed = true;

		// Track when args change from initial
		if (!this.state.haveArgsEverChanged && this.state.initialArgsKey !== newArgsKey) {
			this.state.haveArgsEverChanged = true;
		}

		// Handle skip
		if (newArgsKey === null) {
			this.state = {
				...this.state,
				results: [],
				status: 'LoadingFirstPage',
				isLoading: false, // skip = not loading, just empty
				error: undefined,
				loadMore: () => false
			};
			this.notify();
			return { changed: true, needsResubscribe: false };
		}

		// Decide: clear or keep previous data
		const shouldKeep = this.config.keepPreviousData && this.state.results.length > 0;

		if (!shouldKeep && !this.isUsingInitialData()) {
			this.state = {
				...this.state,
				results: [],
				status: 'LoadingFirstPage',
				isLoading: true,
				error: undefined
			};
		} else {
			// Keep previous data, but mark as loading — except for the initial
			// args of SSR initialData, which is current, not previous, data
			// (marking it loading would flash a loading state on hydration).
			this.state = {
				...this.state,
				isLoading: !this.isUsingInitialData(),
				error: undefined
			};
		}

		this.notify();
		return { changed: true, needsResubscribe: true };
	}

	/**
	 * Called when the subscription produces new data.
	 *
	 * Handles the hydration guard: if using initialData, ignores the first
	 * "empty loading" snapshot to keep SSR-rendered content visible.
	 */
	onUpdate(update: PaginatedQueryUpdate<T>): void {
		// A page arrived: the cursor works again. The empty loading snapshot right
		// after a reset must not re-arm, or a persistent InvalidCursor loops.
		if (update.status !== 'LoadingFirstPage') this.invalidCursorResetArmed = true;

		// Hydration guard: if using initial data, ignore empty loading snapshots
		// This keeps SSR-rendered content visible until real data arrives.
		// Checked before keepPreviousData: SSR data is not "previous" data, and
		// marking it as loading would flash a loading state after hydration.
		if (
			this.isUsingInitialData() &&
			update.results.length === 0 &&
			update.status === 'LoadingFirstPage'
		) {
			// Just update loadMore so it can be called, but don't clear results
			this.state = {
				...this.state,
				loadMore: update.loadMore,
				isLoading: false
			};
			this.notify();
			return;
		}

		if (
			this.config.keepPreviousData &&
			this.state.results.length > 0 &&
			update.results.length === 0 &&
			update.status === 'LoadingFirstPage'
		) {
			this.state = {
				...this.state,
				status: update.status,
				isLoading: true,
				error: undefined,
				loadMore: update.loadMore
			};
			this.notify();
			return;
		}

		this.state = {
			...this.state,
			results: update.results,
			status: update.status,
			isLoading: this.computeIsLoading(update.status),
			error: undefined,
			loadMore: update.loadMore
		};
		this.flushPendingLoadMore();
		this.notify();
	}

	/**
	 * Called when the subscription produces an error.
	 *
	 * Detects InvalidCursor errors and triggers a pagination reset.
	 *
	 * @param options.allowReset - `false` surfaces even an InvalidCursor as the
	 * error, e.g. when resubscribing can't help.
	 * @returns `true` if we detected and handled an InvalidCursor (framework should resubscribe)
	 */
	onError(error: Error, options: { allowReset?: boolean } = {}): boolean {
		const allowReset = options.allowReset ?? true;
		if (allowReset && this.isInvalidCursorError(error) && this.invalidCursorResetArmed) {
			this.invalidCursorResetArmed = false;
			console.warn('PaginatedQueryStateMachine: InvalidCursor detected, resetting:', error.message);
			this.pendingLoadMoreNumItems = null;
			this.state = {
				...this.state,
				results: [],
				status: 'LoadingFirstPage',
				isLoading: true,
				error: undefined,
				resetKey: this.state.resetKey + 1
			};
			this.notify();
			return true;
		}

		this.state = {
			...this.state,
			error,
			isLoading: false
		};
		this.notify();
		return false;
	}

	/**
	 * Manually reset pagination state.
	 *
	 * Useful for programmatic resets (e.g. pull-to-refresh).
	 */
	reset(): void {
		this.pendingLoadMoreNumItems = null;
		this.invalidCursorResetArmed = true;
		this.state = {
			...this.state,
			results: [],
			status: 'LoadingFirstPage',
			isLoading: true,
			error: undefined,
			resetKey: this.state.resetKey + 1
		};
		this.notify();
	}

	/**
	 * Check if we're still using initial data (haven't changed args from initial).
	 *
	 * Public so frameworks can use this for their own hydration logic.
	 */
	isUsingInitialData(): boolean {
		return this.config.initialData !== undefined && !this.state.haveArgsEverChanged;
	}

	/**
	 * Get the config this machine was created with.
	 */
	getConfig(): Readonly<PaginatedQueryConfig<T>> {
		return this.config;
	}

	/**
	 * Update runtime options that may be provided reactively by framework wrappers.
	 */
	updateConfig(config: Partial<PaginatedQueryConfig<T>>): void {
		// A different page size subscribes to a different query, so it gets its
		// own InvalidCursor reset. Wrappers call this on every run, so an
		// unchanged size must not re-arm, or a persistent InvalidCursor loops.
		if (
			config.initialNumItems !== undefined &&
			config.initialNumItems !== this.config.initialNumItems
		) {
			this.invalidCursorResetArmed = true;
		}
		this.config = {
			...this.config,
			...config
		};
	}

	private computeIsLoading(status: PaginationStatus): boolean {
		// While using initialData, never show loading state
		if (this.isUsingInitialData()) {
			return false;
		}
		return status === 'LoadingFirstPage' || status === 'LoadingMore';
	}

	private isInvalidCursorError(error: Error): boolean {
		// Check message for InvalidCursor
		if (error.message.includes('InvalidCursor')) {
			return true;
		}

		// Check for ConvexError with paginationError (structured error format)
		if ('data' in error) {
			const { data } = error as Error & { data: unknown };
			if (
				typeof data === 'object' &&
				data !== null &&
				'isConvexSystemError' in data &&
				'paginationError' in data &&
				(data as Record<string, unknown>).isConvexSystemError === true &&
				(data as Record<string, unknown>).paginationError === 'InvalidCursor'
			) {
				return true;
			}
		}

		return false;
	}
}

/**
 * Serialize args to a stable key for comparison.
 *
 * @param args - Query args object or null for skip
 * @returns Serialized string or null
 */
export function serializeArgsKey(args: Record<string, Value> | null): string | null {
	if (args === null) return null;
	return JSON.stringify(convexToJson(args));
}
