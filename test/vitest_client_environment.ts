import type { Environment } from 'vitest/environments';

/**
 * A Node environment whose modules Vite transforms for the client.
 *
 * Svelte compiles runes for the server in Vitest's default `node` environment, where
 * `$effect` and `$effect.root` never run. Transforming for the client runs them, so a test
 * can drive `useQuery` without mounting a component or adding a DOM.
 */
export default {
	name: 'svelte-client',
	viteEnvironment: 'client',
	setup() {
		return { teardown() {} };
	}
} satisfies Environment;
