---
'convex-svelte': patch
---

Fix `useQuery` staying in its loading state when `initialData` turns `undefined` before the first live answer and that answer equals the initial value (a primitive such as a string or number). The query now recomputes on every answer the client delivers.
