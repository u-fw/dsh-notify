import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The renderer's own tests.
 *
 * `lib/toast.ps1` carries every platform limit this plugin has to respect — the tag
 * ceiling, the payload contract, the focus ancestry walk — and until now it was only
 * covered indirectly, through payloads the Host happened to compose. These tests drive
 * the script the same way the Host does and read what it answers.
 *
 * `dryRun` builds a toast and a notifier without showing anything, so the suite stays
 * silent. Nothing here posts a real notification.
 */

const SCRIPT = fileURLToPath(new URL('../lib/toast.ps1', import.meta.url))
const POWERSHELL = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)
const windows = process.platform === 'win32'

/** Run the renderer with one payload, exactly as the Host does. */
const run = (payload) => {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const encoded = Buffer.from(text, 'utf8').toString('base64')
  const result = spawnSync(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-PayloadB64', encoded],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
  )
  return {
    status: result.status,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim(),
  }
}

test('the renderer reports readiness without drawing anything', { skip: !windows }, () => {
  const out = run({ appId: 'com.deepseek.dsh', title: 'probe', dryRun: true })
  assert.equal(out.status, 0, out.stderr)
  assert.equal(out.stdout, 'ready')
})

test('the focus probe answers with the foreground, the ancestry and the policy', { skip: !windows }, () => {
  const out = run({ appId: 'com.deepseek.dsh', focusCheck: { pids: [process.pid], ancestorsOf: process.pid } })
  assert.equal(out.status, 0, out.stderr)

  const parsed = JSON.parse(out.stdout)
  assert.equal(Number.isInteger(parsed.foreground), true)
  assert.equal(Array.isArray(parsed.matches), true)
  assert.equal(parsed.matches.length, 1)
  // The chain always contains the starting pid, and walking up cannot overflow it.
  assert.equal(Array.isArray(parsed.ancestors), true)
  assert.equal(parsed.ancestors[0], process.pid)
  assert.ok(parsed.ancestors.every((pid) => Number.isInteger(pid) && pid > 0))

  // The shell's own notification policy travels with the same answer; `null` means
  // Windows recorded nothing, which must stay distinguishable from "off".
  assert.equal(typeof parsed.notifications, 'object')
  assert.ok('global' in parsed.notifications)
  assert.ok('app' in parsed.notifications)
})

test('a payload with no title fails instead of drawing an empty toast', { skip: !windows }, () => {
  const out = run({ appId: 'com.deepseek.dsh' })
  assert.notEqual(out.status, 0)
  assert.match(out.stderr, /title is required/u)
})

test('a payload that is not JSON is refused', { skip: !windows }, () => {
  const out = run('{ this is not json')
  assert.notEqual(out.status, 0)
})
