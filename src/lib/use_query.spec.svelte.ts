// Runes helpers for use_query.client.spec.ts. They live in a `.svelte.ts` module because the
// spec mocks `svelte`, which fails in a module the Svelte compiler transforms.
import { makeFunctionReference } from 'convex/server';
import type { Value } from 'convex/values';
import { useQuery, type UseQueryReturn } from './client.svelte.js';

export const countQuery = makeFunctionReference<'query', { search: string }, Value>('jobs:count');

type CountQuery = typeof countQuery;

/**
 * Run `useQuery` in an effect root with reactive args and `initialData`.
 *
 * Change `input` to change them, read `result` to read the query, and call `destroy` to
 * unsubscribe.
 */
export function runUseQuery(initial: { search: string; initialData?: Value }) {
	const input = $state(initial);
	let result: UseQueryReturn<CountQuery> | undefined;
	const destroy = $effect.root(() => {
		result = useQuery(
			countQuery,
			() => ({ search: input.search }),
			() => ({ initialData: input.initialData })
		);
	});
	return {
		input,
		get result(): UseQueryReturn<CountQuery> {
			if (!result) throw new Error('useQuery did not run');
			return result;
		},
		destroy
	};
}
