import { describe, expect, it } from 'vitest';
import { PaginatedQueryStateMachine } from './paginated_query_state.js';

describe('PaginatedQueryStateMachine keepPreviousData', () => {
	it('keeps previous results while a new args subscription is loading first page', () => {
		const loadMore = () => false;
		const machine = new PaginatedQueryStateMachine<string>({
			initialNumItems: 3,
			keepPreviousData: true
		});

		machine.onArgsChange(JSON.stringify({ searchWords: ['lo'] }));
		machine.onUpdate({
			results: ['lorem', 'hello'],
			status: 'CanLoadMore',
			loadMore
		});

		machine.onArgsChange(JSON.stringify({ searchWords: ['lor'] }));
		machine.onUpdate({
			results: [],
			status: 'LoadingFirstPage',
			loadMore
		});

		expect(machine.getSnapshot()).toMatchObject({
			results: ['lorem', 'hello'],
			status: 'LoadingFirstPage',
			isLoading: true,
			error: undefined
		});
	});

	it('clears previous results when the new args resolve to an empty page', () => {
		const loadMore = () => false;
		const machine = new PaginatedQueryStateMachine<string>({
			initialNumItems: 3,
			keepPreviousData: true
		});

		machine.onArgsChange(JSON.stringify({ searchWords: ['lo'] }));
		machine.onUpdate({
			results: ['lorem', 'hello'],
			status: 'CanLoadMore',
			loadMore
		});

		machine.onArgsChange(JSON.stringify({ searchWords: ['xyz'] }));
		machine.onUpdate({
			results: [],
			status: 'Exhausted',
			loadMore
		});

		expect(machine.getSnapshot()).toMatchObject({
			results: [],
			status: 'Exhausted',
			isLoading: false,
			error: undefined
		});
	});

	it.each([true, false])(
		'does not mark SSR initialData as loading when the initial args are set (keepPreviousData: %s)',
		(keepPreviousData) => {
			const machine = new PaginatedQueryStateMachine<string>({
				initialNumItems: 3,
				keepPreviousData,
				initialData: { page: ['a', 'b', 'c'], isDone: false, continueCursor: 'cursor-1' }
			});

			machine.onArgsChange(JSON.stringify({}));

			expect(machine.getSnapshot()).toMatchObject({
				results: ['a', 'b', 'c'],
				status: 'CanLoadMore',
				isLoading: false
			});
		}
	);

	it('keeps SSR initialData visible (not loading) on the first empty snapshot', () => {
		// Detached (convexLoadPaginated) queries use keepPreviousData: the SSR
		// page must not be treated as "previous" data and flash a loading state.
		const machine = new PaginatedQueryStateMachine<string>({
			initialNumItems: 3,
			keepPreviousData: true,
			initialData: { page: ['a', 'b', 'c'], isDone: false, continueCursor: 'cursor-1' }
		});
		machine.onArgsChange(JSON.stringify({}));

		machine.onUpdate({ results: [], status: 'LoadingFirstPage', loadMore: () => false });

		expect(machine.getSnapshot()).toMatchObject({
			results: ['a', 'b', 'c'],
			status: 'CanLoadMore',
			isLoading: false
		});
	});

	it('still keeps previous data as loading once args changed (initialData no longer applies)', () => {
		const machine = new PaginatedQueryStateMachine<string>({
			initialNumItems: 3,
			keepPreviousData: true,
			initialData: { page: ['a', 'b', 'c'], isDone: false, continueCursor: 'cursor-1' }
		});
		machine.onArgsChange(JSON.stringify({ search: '' }));
		machine.onArgsChange(JSON.stringify({ search: 'x' }));

		machine.onUpdate({ results: [], status: 'LoadingFirstPage', loadMore: () => false });

		expect(machine.getSnapshot()).toMatchObject({
			results: ['a', 'b', 'c'],
			status: 'LoadingFirstPage',
			isLoading: true
		});
	});

	it('queues loadMore called before the live subscription is ready', () => {
		// SSR initialData reports CanLoadMore immediately, but the underlying
		// subscription has no working loadMore until its first server update.
		const machine = new PaginatedQueryStateMachine<string>({
			initialNumItems: 3,
			initialData: { page: ['a', 'b', 'c'], isDone: false, continueCursor: 'cursor-1' }
		});
		machine.onArgsChange(JSON.stringify({}));

		expect(machine.getSnapshot().status).toBe('CanLoadMore');

		// Click "load more" before the subscription delivered anything.
		expect(machine.loadMore(3)).toBe(true);
		// The request is accepted (queued), and further clicks are no-ops.
		expect(machine.getSnapshot().status).toBe('LoadingMore');
		expect(machine.loadMore(3)).toBe(false);

		// The subscription delivers its first page; the queued request fires.
		const loadMoreCalls: number[] = [];
		machine.onUpdate({
			results: ['a', 'b', 'c'],
			status: 'CanLoadMore',
			loadMore: (numItems) => {
				loadMoreCalls.push(numItems);
				return true;
			}
		});

		expect(loadMoreCalls).toEqual([3]);
		expect(machine.getSnapshot().status).toBe('LoadingMore');

		// The grown result set arrives; the queue must not fire again.
		machine.onUpdate({
			results: ['a', 'b', 'c', 'd', 'e', 'f'],
			status: 'CanLoadMore',
			loadMore: (numItems) => {
				loadMoreCalls.push(numItems);
				return true;
			}
		});
		expect(loadMoreCalls).toEqual([3]);
		expect(machine.getSnapshot().results).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
	});

	it('drops a queued loadMore when the live first page is exhausted', () => {
		const machine = new PaginatedQueryStateMachine<string>({
			initialNumItems: 3,
			initialData: { page: ['a', 'b', 'c'], isDone: false, continueCursor: 'cursor-1' }
		});
		machine.onArgsChange(JSON.stringify({}));
		expect(machine.loadMore(3)).toBe(true);

		const loadMoreCalls: number[] = [];
		machine.onUpdate({
			results: ['a', 'b', 'c'],
			status: 'Exhausted',
			loadMore: (numItems) => {
				loadMoreCalls.push(numItems);
				return true;
			}
		});

		expect(loadMoreCalls).toEqual([]);
		expect(machine.getSnapshot().status).toBe('Exhausted');
	});

	it('drops a queued loadMore when args change', () => {
		const machine = new PaginatedQueryStateMachine<string>({
			initialNumItems: 3,
			initialData: { page: ['a', 'b', 'c'], isDone: false, continueCursor: 'cursor-1' }
		});
		machine.onArgsChange(JSON.stringify({ search: '' }));
		expect(machine.loadMore(3)).toBe(true);

		machine.onArgsChange(JSON.stringify({ search: 'new' }));

		const loadMoreCalls: number[] = [];
		machine.onUpdate({
			results: ['x'],
			status: 'CanLoadMore',
			loadMore: (numItems) => {
				loadMoreCalls.push(numItems);
				return true;
			}
		});

		expect(loadMoreCalls).toEqual([]);
	});

	it('uses the latest keepPreviousData option when args change', () => {
		const loadMore = () => false;
		const machine = new PaginatedQueryStateMachine<string>({
			initialNumItems: 3,
			keepPreviousData: true
		});

		machine.onArgsChange(JSON.stringify({ searchWords: ['lo'] }));
		machine.onUpdate({
			results: ['lorem', 'hello'],
			status: 'CanLoadMore',
			loadMore
		});

		machine.updateConfig({ keepPreviousData: false });
		machine.onArgsChange(JSON.stringify({ searchWords: ['lor'] }));

		expect(machine.getSnapshot()).toMatchObject({
			results: [],
			status: 'LoadingFirstPage',
			isLoading: true,
			error: undefined
		});
	});
});

describe('PaginatedQueryStateMachine InvalidCursor reset limit (#61)', () => {
	const invalidCursor = () => new Error('InvalidCursor: the cursor is no longer valid');
	const loadMore = () => false;

	function machineWithArgs() {
		const machine = new PaginatedQueryStateMachine<string>({ initialNumItems: 3 });
		machine.onArgsChange('{}');
		return machine;
	}

	it('resets once, then surfaces a repeated InvalidCursor as the error', () => {
		const machine = machineWithArgs();

		expect(machine.onError(invalidCursor())).toBe(true);
		const afterReset = machine.getSnapshot();
		expect(afterReset).toMatchObject({ status: 'LoadingFirstPage', error: undefined });

		// The resubscription only reports its empty loading snapshot, then fails again.
		machine.onUpdate({ results: [], status: 'LoadingFirstPage', loadMore });
		expect(machine.onError(invalidCursor())).toBe(false);

		expect(machine.getSnapshot()).toMatchObject({
			isLoading: false,
			resetKey: afterReset.resetKey
		});
		expect(machine.getSnapshot().error?.message).toContain('InvalidCursor');
	});

	it('surfaces an InvalidCursor without resetting when allowReset is false', () => {
		const machine = machineWithArgs();
		const before = machine.getSnapshot().resetKey;

		expect(machine.onError(invalidCursor(), { allowReset: false })).toBe(false);

		expect(machine.getSnapshot().resetKey).toBe(before);
		expect(machine.getSnapshot().error?.message).toContain('InvalidCursor');
	});

	it('allows another reset once a page arrived', () => {
		const machine = machineWithArgs();
		machine.onError(invalidCursor());

		machine.onUpdate({ results: ['a'], status: 'CanLoadMore', loadMore });

		expect(machine.onError(invalidCursor())).toBe(true);
	});

	it('allows another reset after the args changed or after reset()', () => {
		const machine = machineWithArgs();
		machine.onError(invalidCursor());
		machine.onArgsChange('{"other":true}');
		expect(machine.onError(invalidCursor())).toBe(true);

		machine.reset();
		expect(machine.onError(invalidCursor())).toBe(true);
	});

	it('allows another reset after the page size changed, not for the same size', () => {
		const machine = machineWithArgs();
		machine.onError(invalidCursor());

		// Wrappers pass the page size on every run.
		machine.updateConfig({ initialNumItems: 3 });
		expect(machine.onError(invalidCursor())).toBe(false);

		machine.updateConfig({ initialNumItems: 5 });
		expect(machine.onError(invalidCursor())).toBe(true);
	});
});
