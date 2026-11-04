import { getContext, setContext, untrack } from 'svelte';
import { BROWSER } from 'esm-env';
import { ConvexClient, type ConvexClientOptions, type MutationOptions } from 'convex/browser';
import {
	type FunctionReference,
	type FunctionArgs,
	type FunctionReturnType,
	getFunctionName
} from 'convex/server';
import type { Value } from 'convex/values';
import { argsKeyEqual, jsonEqualArgs, SKIP, type Skip } from './shared/args.js';
import { parseArgsWithSkip } from './internal/args.svelte.js';
import {
	getConvexClient,
	getSingletonClient,
	getSingletonOptions,
	getSingletonUrl,
	setSingleton,
	flushDeferredSubscriptions
} from './internal/singleton.js';
import { warnIgnoredOptions, withServerDisabled } from './internal/client_options.js';
import { isClientActive } from './internal/client_status.js';

const _contextKey = '$$_convexClient';

/** @internal Auth context key shared with adapter libraries. */
export const _authContextKey = '$$_convexAuth';

export const useConvexClient = (): ConvexClient => {
	const client = getContext(_contextKey) as ConvexClient | undefined;
	if (!client) {
		throw new Error(
			'No ConvexClient was found in Svelte context. Did you forget to call setupConvex() in a parent component?'
		);
	}
	return client;
};

export const setConvexClientContext = (client: ConvexClient): ConvexClient => {
	return setContext(_contextKey, client);
};

export const setupConvex = (url: string, options: ConvexClientOptions = {}): ConvexClient => {
	if (!url || typeof url !== 'string') {
		throw new Error('Expected string url property for setupConvex');
	}

	// Reuse the module-level singleton if initConvex() was called earlier
	// (e.g. from hooks.client.ts) or a previous mount created it. Only one
	// deployment per app is supported — fail loudly instead of silently
	// handing back a client for a different URL.
	const existing = getSingletonClient();
	if (existing && getSingletonUrl() !== url) {
		throw new Error(
			`setupConvex() was called with ${url}, but the Convex client is already initialized for ${getSingletonUrl()}. ` +
				'Only one deployment per app is supported. Call closeConvex() first to switch deployments.'
		);
	}
	if (existing) {
		warnIgnoredOptions('setupConvex', getSingletonOptions(), options);
	}
	const client = existing ?? new ConvexClient(url, withServerDisabled(options));
	if (!existing) {
		setSingleton(url, client, options);
	}

	setConvexClientContext(client);

	// Fallback: flush deferred subscriptions for apps that don't call setupAuth.
	// If setupAuth IS called (which flushes synchronously), this is a no-op.
	if (BROWSER) {
		queueMicrotask(() => flushDeferredSubscriptions());
	}

	// The client is app-scoped (shared by context hooks, SSR transport, and
	// detached queries), so it is intentionally NOT closed when this component
	// unmounts — that broke remounts and HMR. Use closeConvex() for explicit
	// teardown, e.g. in tests.
	return client;
};

export type UseQueryOptions<Query extends FunctionReference<'query'>> = {
	// Use this data and assume it is up to date (typically for SSR and hydration)
	initialData?: FunctionReturnType<Query>;
	// Instead of loading, render result from outdated args
	keepPreviousData?: boolean;
};

export type UseQueryReturn<Query extends FunctionReference<'query'>> =
	| { data: undefined; error: undefined; isLoading: true; isStale: false }
	| { data: undefined; error: Error; isLoading: false; isStale: boolean }
	| { data: FunctionReturnType<Query>; error: undefined; isLoading: false; isStale: boolean };

// Note that swapping out the current Convex client is not supported.
/**
 * Subscribe to a Convex query and return a reactive query result object.
 * Pass reactive args object or a closure returning args to update args reactively.
 *
 * Supports React-style `"skip"` to avoid subscribing:
 *   useQuery(api.users.get, () => (isAuthed ? {} : 'skip'))
 *
 * @param query - a FunctionReference like `api.dir1.dir2.filename.func`.
 * @param args - Arguments object / closure, or the string `"skip"` (or a closure returning it).
 * @param options - UseQueryOptions like `initialData` and `keepPreviousData`.
 * @returns an object containing data, isLoading, error, and isStale.
 */
export function useQuery<Query extends FunctionReference<'query'>>(
	query: Query,
	args?: FunctionArgs<Query> | 'skip' | (() => FunctionArgs<Query> | 'skip'),
	options?: UseQueryOptions<Query> | (() => UseQueryOptions<Query>)
): UseQueryReturn<Query>;
export function useQuery<Query extends FunctionReference<'query'>>(
	query: Query,
	args: FunctionArgs<Query> | 'skip' | (() => FunctionArgs<Query> | 'skip') = {},
	options: UseQueryOptions<Query> | (() => UseQueryOptions<Query>) = {}
): UseQueryReturn<Query> {
	const client = useConvexClient();
	if (typeof query === 'string') {
		throw new Error('Query must be a functionReference object, not a string');
	}

	const state: {
		result: FunctionReturnType<Query> | Error | undefined;
		// The last result we actually received, if this query has ever received one.
		lastResult: FunctionReturnType<Query> | Error | undefined;
		// The args (query key) of the last result that was received.
		argsForLastResult: FunctionArgs<Query> | Skip | undefined;
		// If the args have never changed, fine to use initialData if provided.
		haveArgsEverChanged: boolean;
		// Counts the answers received. An answer equal to the stored result (a primitive such
		// as a string) leaves `result` unchanged, so it alone would not recompute `syncResult`.
		updates: number;
	} = $state({
		result: parseOptions(options).initialData,
		lastResult: undefined,
		argsForLastResult: undefined,
		haveArgsEverChanged: false,
		updates: 0
	});

	// When args change we need to unsubscribe to the old query and subscribe
	// to the new one.
	$effect(() => {
		const argsObject = parseArgsWithSkip(args);

		// If skipped, don't create any subscription
		if (argsObject === SKIP) {
			// Clear transient result to mimic React: not loading, no data
			state.result = undefined;
			state.argsForLastResult = SKIP;
			return;
		}

		if (!isClientActive(client)) {
			return;
		}

		const unsubscribe = client.onUpdate(
			query,
			argsObject,
			(dataFromServer) => {
				const copy = structuredClone(dataFromServer);
				state.result = copy;
				state.argsForLastResult = argsObject;
				state.lastResult = copy;
				state.updates++;
			},
			(e: Error) => {
				state.result = e;
				state.updates++;
				state.argsForLastResult = argsObject;
				const copy = structuredClone(e);
				state.lastResult = copy;
			}
		);

		// Cleanup on args change/unmount
		return unsubscribe;
	});

	/*
	 ** staleness & args tracking **
	 * Are the args (the query key) the same as the last args we received a result for?
	 */
	const currentArgs = $derived(parseArgsWithSkip(args));
	const initialArgs = parseArgsWithSkip(args);

	const sameArgsAsLastResult = $derived(
		state.argsForLastResult !== undefined &&
			currentArgs !== SKIP &&
			state.argsForLastResult !== SKIP &&
			jsonEqualArgs(
				state.argsForLastResult as Record<string, Value>,
				currentArgs as Record<string, Value>
			)
	);

	const staleAllowed = $derived(!!(parseOptions(options).keepPreviousData && state.lastResult));
	const isSkipped = $derived(currentArgs === SKIP);

	// Once args change, move off of initialData.
	$effect(() => {
		if (!untrack(() => state.haveArgsEverChanged)) {
			const curr = parseArgsWithSkip(args);
			if (!argsKeyEqual(initialArgs, curr)) {
				state.haveArgsEverChanged = true;
				const opts = parseOptions(options);
				if (opts.initialData !== undefined) {
					state.argsForLastResult =
						initialArgs === SKIP
							? SKIP
							: ($state.snapshot(initialArgs as Record<string, unknown>) as Record<string, Value>);
					state.lastResult = opts.initialData;
				}
			}
		}
	});

	/*
	 ** compute sync result **
	 * Return value or undefined; never an error object.
	 */
	const syncResult: FunctionReturnType<Query> | undefined = $derived.by(() => {
		if (isSkipped) return undefined;

		const opts = parseOptions(options);
		if (opts.initialData && !state.haveArgsEverChanged) {
			return state.result;
		}

		let value;
		try {
			value = !isClientActive(client)
				? undefined
				: client.client.localQueryResult(
						getFunctionName(query),
						currentArgs as Record<string, Value>
					);
		} catch (e) {
			if (!(e instanceof Error)) {
				console.error('threw non-Error instance', e);
				throw e;
			}
			value = e;
		}
		// Touch the reactive answer count so every answer retriggers computations, also one
		// equal to the stored result
		void state.updates;
		return value;
	});

	const result = $derived.by(() => {
		return syncResult !== undefined ? syncResult : staleAllowed ? state.lastResult : undefined;
	});

	const isStale = $derived(
		!isSkipped &&
			syncResult === undefined &&
			staleAllowed &&
			!sameArgsAsLastResult &&
			result !== undefined
	);

	const data = $derived.by(() => {
		if (result instanceof Error) return undefined;
		return result;
	});

	const error = $derived.by(() => {
		if (result instanceof Error) return result;
		return undefined;
	});

	/*
	 ** public shape **
	 * This TypeScript cast promises data is not undefined if error and isLoading are checked first.
	 */
	return {
		get data() {
			return data;
		},
		get isLoading() {
			return isSkipped ? false : error === undefined && data === undefined;
		},
		get error() {
			return error;
		},
		get isStale() {
			return isSkipped ? false : isStale;
		}
	} as UseQueryReturn<Query>;
}

// options can be an object or a closure
function parseOptions<Query extends FunctionReference<'query'>>(
	options: UseQueryOptions<Query> | (() => UseQueryOptions<Query>)
): UseQueryOptions<Query> {
	if (typeof options === 'function') {
		options = options();
	}
	return $state.snapshot(options);
}

/* -------------------------------------------------------------------------- */
/*                         Auth: setupAuth / useAuth                          */
/* -------------------------------------------------------------------------- */

export type FetchAccessToken = (args: { forceRefreshToken: boolean }) => Promise<string | null>;

/**
 * Auth provider state returned by the reactive getter passed to `setupAuth`.
 * Mirrors React's `useAuth` hook shape used by `ConvexProviderWithAuth`.
 */
export type ConvexAuthProvider = {
	isLoading: boolean;
	isAuthenticated: boolean;
	fetchAccessToken: FetchAccessToken;
};

export type SetupAuthOptions = {
	/**
	 * Initial auth state from the server for SSR hydration.
	 * Seeds `isConvexAuthenticated` so the server render shows the correct
	 * content before any client-side `$effect` runs.
	 */
	initialState?: { isAuthenticated: boolean };
};

export type UseAuthReturn = {
	readonly isLoading: boolean;
	readonly isAuthenticated: boolean;
};

type AuthContext = {
	isLoading: boolean;
	isAuthenticated: boolean;
};

/**
 * Set up authentication for the Convex client.
 *
 * Accepts a **reactive getter** that returns the auth provider's current state
 * (`isLoading`, `isAuthenticated`, `fetchAccessToken`). This mirrors React's
 * `ConvexProviderWithAuth` pattern — when the provider state changes (sign-in,
 * sign-out, token refresh), the internal `$effect` re-runs and automatically
 * toggles between `client.setAuth()` and `client.clearAuth()`.
 *
 * Must be called in a component that has `setupConvex()` in its parent tree.
 *
 * Auth adapter libraries (e.g. `convex-better-auth-svelte`) call this
 * internally, so end users typically do not call it directly.
 *
 * @param authProvider - Reactive getter returning `{ isLoading, isAuthenticated, fetchAccessToken }`.
 * @param options - Optional `{ initialState }` for SSR hydration.
 */
export function setupAuth(
	authProvider: () => ConvexAuthProvider,
	options?: SetupAuthOptions
): void {
	const client = useConvexClient();

	// Convex backend confirmation state: null = unknown, true/false = confirmed.
	// Seeded from SSR initialState so the server render is correct.
	const hasInitialState = options?.initialState !== undefined;
	let isConvexAuthenticated: boolean | null = $state(
		hasInitialState ? (options!.initialState!.isAuthenticated ? true : false) : null
	);

	// Track whether the auth provider has ever reported !isLoading.
	// Used to preserve SSR initialState until the provider settles.
	let providerHasSettled = false;

	// Track the provider isAuthenticated value the $effect last processed.
	// Used by the isLoading getter to detect when the provider changed but
	// the effect hasn't caught up yet (e.g. goto() after signIn before
	// the effect runs).  NOT $state — reactivity comes from
	// isConvexAuthenticated, which always changes in the same effect run.
	let lastProcessedProviderAuth: boolean | undefined;

	// --- Synchronous auth setup for SSR hydration ---
	// When SSR confirmed authentication, call client.setAuth() immediately
	// (synchronously, during component initialization, before any $effect).
	// The ConvexClient's AuthenticationManager pauses the WebSocket during
	// token fetch. Without this, child useQuery $effects create subscriptions
	// on an unauthenticated WebSocket, receiving null for auth-gated queries
	// and overriding initialData — causing a flash of unauthenticated content.
	let initialSetAuthActive = false;
	if (BROWSER && hasInitialState && options.initialState?.isAuthenticated) {
		const { fetchAccessToken } = authProvider();
		initialSetAuthActive = true;
		client.setAuth(fetchAccessToken, (backendIsAuthenticated: boolean) => {
			isConvexAuthenticated = backendIsAuthenticated;
		});
	}

	// Flush subscriptions deferred by transport.decode (createDetachedQuery).
	// Must come AFTER client.setAuth() (if called) so the WebSocket is paused
	// before any subscription fires. For unauthenticated SSR or no initialState,
	// subscriptions fire immediately without auth (matching SSR behavior).
	if (BROWSER) {
		flushDeferredSubscriptions();
	}

	// --- Reactive effect: watches auth provider state, drives setAuth ---
	// IMPORTANT: reads of isConvexAuthenticated are wrapped in untrack() so
	// the effect only re-runs when authProvider() changes, NOT when the
	// backend callback updates isConvexAuthenticated. Without this, each
	// callback write → effect re-run → cleanup (clear auth) → re-setup →
	// callback → infinite loop, leaving queries without stable auth.
	$effect(() => {
		const {
			isLoading: providerLoading,
			isAuthenticated: providerAuth,
			fetchAccessToken
		} = authProvider();

		if (!providerLoading) {
			providerHasSettled = true;
		}

		// Snapshot current backend state without creating a dependency.
		const currentConvexAuth = untrack(() => isConvexAuthenticated);

		// Record what the effect is processing so the isLoading getter
		// can detect stale reads between provider change and effect run.
		lastProcessedProviderAuth = providerAuth;

		// --- Hydration guard ---
		// While the synchronous setAuth is active, it manages the WebSocket
		// and token.  Don't interfere: skip state transitions and avoid a
		// redundant client.setAuth() that would pause the socket (setConfig
		// calls _pauseSocket) and cause a flash of null query results.
		if (initialSetAuthActive) {
			if (providerAuth) {
				// Provider confirmed authentication — the sync setAuth already
				// established this on the same fetchAccessToken.  Hand over
				// lifecycle cleanup to the $effect without re-calling setAuth.
				initialSetAuthActive = false;
				return () => {
					client.setAuth(
						async () => null,
						() => {
							/* noop — cleanup only */
						}
					);
				};
			}
			// Provider not yet authenticated (still loading or briefly false).
			// The sync setAuth is handling the token fetch — don't override.
			return;
		}

		// Only reset to "unknown" if the provider has settled before
		// (going BACK to loading after having been settled).
		// This preserves the SSR initialState during first hydration.
		if (providerLoading && currentConvexAuth !== null && providerHasSettled) {
			isConvexAuthenticated = null;
		}

		// If the provider says not authenticated and not loading,
		// immediately reflect that (don't wait for Convex backend).
		// Skip only when already false (no-op).
		if (!providerLoading && !providerAuth && currentConvexAuth !== false) {
			isConvexAuthenticated = false;
		}

		// When the provider says authenticated, wire up client.setAuth
		// so the Convex backend can confirm the token.
		if (providerAuth) {
			// Transition from "not authenticated" to "loading" immediately
			// so consumers show a loading state while waiting for the backend
			// to confirm the token, rather than a flash of unauthenticated.
			if (currentConvexAuth === false) {
				isConvexAuthenticated = null;
			}

			let isThisEffectRelevant = true;

			client.setAuth(fetchAccessToken, (backendIsAuthenticated: boolean) => {
				if (isThisEffectRelevant) {
					isConvexAuthenticated = backendIsAuthenticated;
				}
			});

			return () => {
				isThisEffectRelevant = false;
				// Use setAuth with null-returning fetch instead of clearAuth().
				// clearAuth() bypasses the AuthenticationManager and doesn't
				// cancel pending refetch timers, which can leave the client stuck.
				client.setAuth(
					async () => null,
					() => {
						/* noop — we don't update state from a stale cleanup */
					}
				);
				// NOTE: we intentionally do NOT reset isConvexAuthenticated here.
				// The effect body handles all state transitions:
				//   - provider not-auth → isConvexAuthenticated = false (sync)
				//   - provider auth → setAuth callback updates on confirmation
				// Resetting here would cause a flash of unauthenticated state
				// when the effect re-runs (e.g. token refresh, navigation) because
				// the old value is cleared before the new setAuth confirms.
			};
		}
	});

	// --- Context: expose derived auth state to useAuth() consumers ---
	setContext<AuthContext>(_authContextKey, {
		get isLoading() {
			if (isConvexAuthenticated === null) return true;

			// Stale-detection: the provider now says "authenticated" but
			// the effect hasn't processed that yet (isConvexAuthenticated
			// is still false from the previous context).  This happens
			// when goto() runs synchronously after signIn — the session
			// atom has already fired but the $effect is still scheduled.
			if (isConvexAuthenticated === false && lastProcessedProviderAuth !== undefined) {
				const currentProviderAuth = untrack(() => authProvider().isAuthenticated);
				if (currentProviderAuth !== lastProcessedProviderAuth) {
					return true;
				}
			}

			return false;
		},
		get isAuthenticated() {
			// Read eagerly so that any consumer $effect always registers a
			// dependency on isConvexAuthenticated, even when providerAuth is
			// currently false.  Without this, the `&&` short-circuits the
			// reactive read and effects like useQuery never re-run when auth
			// is later confirmed by the Convex backend.
			const convexAuth = isConvexAuthenticated;

			// Before the provider has settled, trust the SSR initial state.
			// The provider starts as loading (e.g. Better Auth session pending),
			// but the server already confirmed auth status.
			if (!providerHasSettled && hasInitialState) {
				return convexAuth === true;
			}

			// Once the Convex backend has confirmed auth, trust it.
			// The provider may report transient not-authenticated states
			// (e.g. during SvelteKit client-side navigation) that would
			// cause a flash.  The setupAuth effect corrects the state
			// for real sign-outs (provider → loading reset → false).
			if (convexAuth === true) {
				return true;
			}

			// Backend hasn't confirmed yet — also require the provider.
			// untrack: reading authProvider() here is for the current value only,
			// we don't want this getter to create additional subscriptions.
			const providerAuth = untrack(() => authProvider().isAuthenticated);
			return providerAuth && (convexAuth ?? false);
		}
	});
}

/**
 * Read the current authentication state.
 *
 * Returns `{ isLoading, isAuthenticated }` reflecting whether the Convex
 * backend has confirmed the auth token provided via `setupAuth()`.
 *
 * Must be used in a component where `setupAuth()` has been called upstream.
 */
export function useAuth(): UseAuthReturn {
	const authContext = getContext<AuthContext | undefined>(_authContextKey);

	if (!authContext) {
		throw new Error(
			'useAuth() requires setupAuth() to be called in a parent component. ' +
				'If you are using an auth adapter (e.g. convex-better-auth-svelte), ' +
				'make sure its setup function is called before useAuth().'
		);
	}

	return {
		get isLoading() {
			return authContext.isLoading;
		},
		get isAuthenticated() {
			return authContext.isAuthenticated;
		}
	};
}

/* -------------------------------------------------------------------------- */
/*                      useMutation / useAction wrappers                      */
/* -------------------------------------------------------------------------- */

/**
 * Get a callable function for a Convex mutation.
 *
 * Uses the module-level singleton (`getConvexClient()`), so it works in
 * `.svelte` components **and** plain `.ts` / `.js` files — anywhere after
 * `setupConvex()` (or `initConvex()`) has been called.
 *
 * ```svelte
 * const sendMessage = useMutation(api.messages.send);
 * await sendMessage({ body: "hi" });
 *
 * // With optimistic update (at call site):
 * await sendMessage({ body: "hi" }, {
 *   optimisticUpdate: (store) => {
 *     store.setQuery(api.messages.list, { muteWords: [] }, [...]);
 *   }
 * });
 * ```
 *
 * @param mutation - A FunctionReference for the mutation to run.
 * @returns A function `(args, options?) => Promise<ReturnType>`.
 */
export function useMutation<Mutation extends FunctionReference<'mutation'>>(
	mutation: Mutation
): (
	args: FunctionArgs<Mutation>,
	options?: MutationOptions
) => Promise<FunctionReturnType<Mutation>> {
	return (args: FunctionArgs<Mutation>, options?: MutationOptions) =>
		getConvexClient().mutation(mutation, args, options);
}

/**
 * Get a callable function for a Convex action.
 *
 * Uses the module-level singleton (`getConvexClient()`), so it works in
 * `.svelte` components **and** plain `.ts` / `.js` files — anywhere after
 * `setupConvex()` (or `initConvex()`) has been called.
 *
 * ```svelte
 * const generateUrl = useAction(api.files.generateUploadUrl);
 * const url = await generateUrl({});
 * ```
 *
 * @param action - A FunctionReference for the action to run.
 * @returns A function `(args) => Promise<ReturnType>`.
 */
export function useAction<Action extends FunctionReference<'action'>>(
	action: Action
): (args: FunctionArgs<Action>) => Promise<FunctionReturnType<Action>> {
	return (args: FunctionArgs<Action>) => getConvexClient().action(action, args);
}
