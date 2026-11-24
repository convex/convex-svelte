---
'convex-svelte': patch
---

**`useQuery` no longer stays loading when an answer equals the previous result** ([#72](https://github.com/convex/convex-svelte/issues/72)) - when the args changed and the new answer was the same primitive as before (a number, string, boolean or `null`, for example a count that stays `25` for a new search), `isLoading` stayed `true` and `data` stayed `undefined`. The same happened when `initialData` turned `undefined` before the first live answer and that answer equaled it. `useQuery` now recomputes on every answer the client delivers.
