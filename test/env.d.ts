// file: test/env.d.ts
// description: Cloudflare test environment typing augmentation
// reference: internal

declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {}
}
