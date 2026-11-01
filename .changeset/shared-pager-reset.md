---
'convex-svelte': patch
---

### Fixes

- **Paginated queries sharing a query recover from `InvalidCursor`** ([#61](https://github.com/convex/convex-svelte/issues/61)) - the Convex client shares one paginated query between subscribers with the same query, args and page size. After an `InvalidCursor`, each `usePaginatedQuery`, `convexLoadPaginated` or `createDetachedPaginatedQuery` released the failed query only when it resubscribed, so with two or more of them the first one got the failed query back and showed the error. They now release it as soon as they reset, and one fresh query replaces it.
- **A changed `initialNumItems` allows another `InvalidCursor` reset** - a different page size subscribes to a different query, so it gets its own reset, like changed args.
