import { sveltekit } from '@sveltejs/kit/vite';
import { configDefaults, defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';

// `*.client.spec.ts` files run against Svelte's client build, with runes compiled for the
// client, so `$effect` runs without mounting a component
const clientSpecs = 'src/**/*.client.spec.ts';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	test: {
		projects: [
			{
				extends: true,
				test: {
					name: 'server',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: [...configDefaults.exclude, clientSpecs]
				}
			},
			{
				extends: true,
				test: {
					name: 'client',
					include: [clientSpecs],
					environment: './test/vitest_client_environment.ts'
				},
				resolve: { conditions: ['browser'] }
			}
		]
	}
});
