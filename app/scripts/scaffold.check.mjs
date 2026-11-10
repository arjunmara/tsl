// Runs the Story 1.1 edge cases: layer rule and Cloudflare build guard. `npm run check` after `npm run build`.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { ESLint } from 'eslint'
import { createServer, loadConfigFromFile } from 'vite'

const envFiles = readdirSync('.').filter((f) => f.startsWith('.env'))
if (envFiles.length) throw new Error(`remove ${envFiles.join(', ')} from app/: local env files change what these checks see`)
if (!existsSync('dist/sw.js')) throw new Error('dist/sw.js is missing: run npm run build first')

const eslint = new ESLint()
async function lint(file, code) {
  const [r] = await eslint.lintText(code, { filePath: file })
  return r.messages.filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message)
}
const below = 'ui imports nothing below it'
const supa = 'only domain and outbox import Supabase'

for (const imp of ['../features/a', '../domain/env', '../outbox/q', '@supabase/supabase-js']) {
  const msgs = await lint('src/ui/x.ts', `import '${imp}'\n`)
  assert.ok(msgs.some((m) => m.includes(imp) && m.includes(below)), `ui -> ${imp} must fail: ${msgs}`)
}
assert.ok((await lint('src/features/a/x.ts', "import '@supabase/supabase-js'\n")).some((m) => m.includes(supa)))
assert.deepEqual(await lint('src/features/a/x.ts', "import '../../ui/b'\n"), [])
assert.deepEqual(await lint('src/domain/x.ts', "import '@supabase/supabase-js'\n"), [])
assert.deepEqual(await lint('src/outbox/x.ts', "import '@supabase/supabase-js'\n"), [])
assert.ok((await lint('src/features/a/x.ts', "import '../../outbox/q'\n")).some((m) => m.includes('features write through domain')))
const above = 'domain and outbox import nothing above them'
for (const [file, imp] of [['src/domain/x.ts', '../features/a'], ['src/domain/x.ts', '../ui/b'], ['src/outbox/x.ts', '../ui/b']]) {
  const msgs = await lint(file, `import '${imp}'\n`)
  assert.ok(msgs.some((m) => m.includes(imp) && m.includes(above)), `${file} -> ${imp} must fail: ${msgs}`)
}
assert.deepEqual(await lint('src/domain/x.ts', "import './other'\n"), [])
const sample = 'the sample page imports only ui'
for (const imp of ['../domain/env', '../features/a', '../outbox/q', '@supabase/supabase-js']) {
  const msgs = await lint('src/sample/x.tsx', `import '${imp}'\n`)
  assert.ok(msgs.some((m) => m.includes(imp) && m.includes(sample)), `sample -> ${imp} must fail: ${msgs}`)
}
assert.deepEqual(await lint('src/sample/x.tsx', "import '../ui/b'\n"), [])

// Build guard: on Cloudflare Pages a missing variable fails the config; elsewhere it loads.
const env = { command: 'build', mode: 'production' }
const guarded = ['CF_PAGES', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_TURNSTILE_SITE_KEY']
for (const k of guarded) delete process.env[k]
assert.ok(await loadConfigFromFile(env, 'vite.config.ts', '.', 'silent'))
process.env.CF_PAGES = '1'
await assert.rejects(loadConfigFromFile(env, 'vite.config.ts', '.', 'silent'), /VITE_SUPABASE_URL/)
process.env.VITE_SUPABASE_URL = 'https://abc.supabase.co'
await assert.rejects(loadConfigFromFile(env, 'vite.config.ts', '.', 'silent'), /VITE_SUPABASE_PUBLISHABLE_KEY/)
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'x'
await assert.rejects(loadConfigFromFile(env, 'vite.config.ts', '.', 'silent'), /VITE_TURNSTILE_SITE_KEY/)
process.env.VITE_TURNSTILE_SITE_KEY = 'x'
assert.ok(await loadConfigFromFile(env, 'vite.config.ts', '.', 'silent'))
process.env.VITE_SUPABASE_URL = 'not a url'
await assert.rejects(loadConfigFromFile(env, 'vite.config.ts', '.', 'silent'), /valid URL/)
for (const k of guarded) delete process.env[k]

// Database ref shown by the shell.
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
try {
  const { refFromUrl } = await server.ssrLoadModule('/src/domain/env.ts')
  assert.equal(refFromUrl(''), null)
  assert.equal(refFromUrl('not a url'), null)
  assert.equal(refFromUrl('https://abc.supabase.co'), 'abc')
} finally {
  await server.close()
}

// registerType 'prompt': the new worker waits for SKIP_WAITING and never claims clients (AD-25).
const sw = readFileSync('dist/sw.js', 'utf8')
assert.ok(sw.includes('SKIP_WAITING'))
assert.ok(!sw.includes('clientsClaim'))
console.log('ok')
