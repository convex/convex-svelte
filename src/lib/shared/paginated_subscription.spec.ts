import { describe, expect, it, vi } from 'vitest';
import { makeFunctionReference } from 'convex/server';
import { subscribePaginated } from './paginated_subscription.js';

// The Convex client can throw instead of calling onError (convex/convex-js#193):
// from getCurrentValue() for a failed page, and from onPaginatedUpdate_experimental()
// itself. Those errors must reach onError, and a cleanup must always come back.

const ref = makeFunctionReference<'query'>('messages:paginatedList');
const page = { results: [1], status: 'CanLoadMore' as const, loadMore: () => true };

function clientWith(
	impl: (onUpdate: () => void, onError: (e: Error) => void) => ReturnType<typeof vi.fn>
) {
	return {
		onPaginatedUpdate_experimental: vi.fn(
			(_q: unknown, _a: unknown, _o: unknown, onUpdate: () => void, onError: (e: Error) => void) =>
				impl(onUpdate, onError)
		)
	} as never;
}

describe('subscribePaginated', () => {
	it('reports a failed cached page instead of throwing, and still returns a cleanup', () => {
		const unsubscribe = Object.assign(vi.fn(), {
			getCurrentValue: () => {
				throw new Error('page failed');
			}
		});
		const onSnapshot = vi.fn();
		const onError = vi.fn();

		const cleanup = subscribePaginated(
			clientWith(() => unsubscribe),
			ref,
			{},
			10,
			onSnapshot,
			onError
		);

		expect(onError).toHaveBeenCalledWith(new Error('page failed'), true);
		expect(onSnapshot).not.toHaveBeenCalled();
		cleanup();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it('reports an error thrown by onPaginatedUpdate_experimental itself, as not retryable', () => {
		const onError = vi.fn();
		const client = {
			onPaginatedUpdate_experimental: vi.fn(() => {
				throw new Error('failed page held by another subscriber');
			})
		} as never;

		const cleanup = subscribePaginated(client, ref, {}, 10, vi.fn(), onError);

		// Not retryable: the client registered the subscription before throwing and
		// shares it per args, so a retry would fail the same way (convex-js#193).
		expect(onError).toHaveBeenCalledWith(
			new Error('failed page held by another subscriber'),
			false
		);
		expect(() => cleanup()).not.toThrow();
	});

	it('reports a failed page that getCurrentValue() throws inside the update callback', () => {
		let fail = false;
		let notify = () => {};
		const unsubscribe = Object.assign(vi.fn(), {
			getCurrentValue: () => {
				if (fail) throw new Error('page failed');
				return undefined;
			}
		});
		const onError = vi.fn();
		subscribePaginated(
			clientWith((onUpdate) => {
				notify = onUpdate;
				return unsubscribe;
			}),
			ref,
			{},
			10,
			vi.fn(),
			onError
		);

		fail = true;
		notify();

		expect(onError).toHaveBeenCalledWith(new Error('page failed'), true);
	});

	it('delivers a snapshot the client reports synchronously while subscribing, once', () => {
		const unsubscribe = Object.assign(vi.fn(), { getCurrentValue: () => page });
		const onSnapshot = vi.fn();

		subscribePaginated(
			clientWith((onUpdate) => {
				onUpdate(); // before the subscription is returned
				return unsubscribe;
			}),
			ref,
			{},
			10,
			onSnapshot,
			vi.fn()
		);

		expect(onSnapshot).toHaveBeenCalledOnce();
		expect(onSnapshot).toHaveBeenCalledWith(page);
	});

	it('does not read the value after the client reported an error synchronously', () => {
		const getCurrentValue = vi.fn(() => page);
		const onError = vi.fn();

		subscribePaginated(
			clientWith((_onUpdate, reportError) => {
				reportError(new Error('boom'));
				return Object.assign(vi.fn(), { getCurrentValue });
			}),
			ref,
			{},
			10,
			vi.fn(),
			onError
		);

		expect(onError).toHaveBeenCalledOnce();
		expect(getCurrentValue).not.toHaveBeenCalled();
	});
});

// onError returns true when it accepted a reset. Clients share one paginated
// query per args, so the subscription must be released right away: a
// subscriber still holding the failed query hands it to the next one.
describe('subscribePaginated after an accepted reset', () => {
	it('releases at once, and only once', () => {
		let reportError: (error: Error) => void = () => {};
		let notify = () => {};
		const unsubscribe = Object.assign(vi.fn(), { getCurrentValue: () => page });
		const onSnapshot = vi.fn();
		const onError = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
		const cleanup = subscribePaginated(
			clientWith((onUpdate, reportClientError) => {
				notify = onUpdate;
				reportError = reportClientError;
				return unsubscribe;
			}),
			ref,
			{},
			10,
			onSnapshot,
			onError
		);
		onSnapshot.mockClear();

		reportError(new Error('boom')); // not a reset: keep the subscription
		expect(unsubscribe).not.toHaveBeenCalled();
		reportError(new Error('InvalidCursor'));
		expect(unsubscribe).toHaveBeenCalledOnce();

		// Callbacks of the released subscription are ignored.
		notify();
		reportError(new Error('InvalidCursor'));
		cleanup();
		expect(onSnapshot).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledTimes(2);
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it('releases once the client returned the subscription, when it reported the error while subscribing', () => {
		const getCurrentValue = vi.fn(() => page);
		const unsubscribe = Object.assign(vi.fn(), { getCurrentValue });
		const onError = vi.fn(() => true);

		const cleanup = subscribePaginated(
			clientWith((_onUpdate, reportError) => {
				reportError(new Error('InvalidCursor'));
				expect(unsubscribe).not.toHaveBeenCalled();
				return unsubscribe;
			}),
			ref,
			{},
			10,
			vi.fn(),
			onError
		);

		expect(onError).toHaveBeenCalledOnce();
		expect(unsubscribe).toHaveBeenCalledOnce();
		expect(getCurrentValue).not.toHaveBeenCalled();
		expect(() => cleanup()).not.toThrow();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it('releases when the cached value of a shared query has failed', () => {
		const unsubscribe = Object.assign(vi.fn(), {
			getCurrentValue: () => {
				throw new Error('InvalidCursor');
			}
		});
		const onError = vi.fn(() => true);

		const cleanup = subscribePaginated(
			clientWith(() => unsubscribe),
			ref,
			{},
			10,
			vi.fn(),
			onError
		);

		expect(onError).toHaveBeenCalledWith(new Error('InvalidCursor'), true);
		expect(unsubscribe).toHaveBeenCalledOnce();
		cleanup();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});
});
