/**
 * Node, but with modules transformed by Vite's client environment: Svelte
 * modules are compiled for the browser, so `$effect` runs in tests. The tests
 * using it need no DOM.
 */
import type { Environment } from 'vitest/environments';

export default {
	name: 'svelte-client',
	viteEnvironment: 'client',
	setup: () => ({ teardown: () => {} })
} satisfies Environment;
