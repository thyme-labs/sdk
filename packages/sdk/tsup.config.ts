import { defineConfig } from 'tsup'

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/archive-reader.ts',
		'src/lifecycle.ts',
	],
	format: ['esm'],
	dts: true,
	clean: true,
	sourcemap: true,
	minify: false,
	external: ['viem', 'zod', 'node:crypto'],
})
