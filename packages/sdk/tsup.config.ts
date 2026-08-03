import { defineConfig } from 'tsup'

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/archive-reader.ts',
		'src/lifecycle.ts',
		'src/schema-extractor.ts',
		'src/task-runtime.ts',
	],
	format: ['esm'],
	dts: true,
	clean: true,
	sourcemap: true,
	minify: false,
	external: ['viem', 'zod', 'node:crypto'],
})
