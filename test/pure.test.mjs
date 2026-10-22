// Unit tests for the pure logic dsh-notify depends on.
//
// Every case here is either a rule the plugin must not break or a bug that was
// actually found in the field: the `minRunSeconds: 0` floor that silently
// rewrote a legitimate zero, and the icon resolution that once recorded a node
// binary as the toast icon.
//
//   node --test test/
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  clip,
  composeLabel,
  durationText,
  errorText,
  fill,
  fnv1a,
  projectOf,
  regValue,
  resolveConfig,
  resolveIcon,
  shortId,
  toastTag,
} from '../lib/index.js'

test('toastTag stays inside the platform ceiling Windows enforces', () => {
  // Regression: a tag built from the raw session id was ~70 characters, and
  // setting it threw before the toast was shown, losing the notification.
  const sessionId = 'session-97217b96-1a9a-4bac-8be1-19a4560ada5c'
  for (const category of ['approval', 'question', 'error', 'account', 'idle', 'stall', 'workflow', 'default']) {
    const tag = toastTag(category, sessionId)
    assert.ok(tag.length <= 64, `${category} tag is ${String(tag.length)} characters`)
    assert.ok(tag.length > 0)
  }
})

test('toastTag is stable per notification and distinct across sessions', () => {
  const a = toastTag('approval', 'session-aaaa')
  assert.equal(a, toastTag('approval', 'session-aaaa'))
  assert.notEqual(a, toastTag('approval', 'session-bbbb'))
  assert.notEqual(a, toastTag('question', 'session-aaaa'))
  assert.notEqual(toastTag('account', ''), toastTag('workflow', ''))
})

test('fnv1a is deterministic and bounded', () => {
  assert.equal(fnv1a(''), '811c9dc5')
  assert.equal(fnv1a('dsh'), fnv1a('dsh'))
  assert.match(fnv1a('anything at all'), /^[0-9a-f]{8}$/)
})

const ZH = { second: '秒', minute: '分', hour: '时' }
const EN = { second: 's', minute: 'm', hour: 'h' }

test('clip collapses whitespace, trims, and bounds', () => {
  assert.equal(clip('  a\n\t b  ', 40), 'a b')
  assert.equal(clip('abcdef', 4), 'abc…')
  assert.equal(clip('abcd', 4), 'abcd')
  assert.equal(clip('   ', 10), undefined)
  assert.equal(clip(undefined, 10), undefined)
  assert.equal(clip(42, 10), undefined)
})

test('errorText renders any thrown value as one line', () => {
  assert.equal(errorText(new Error('boom')), 'boom')
  assert.equal(errorText('plain'), 'plain')
  assert.equal(errorText(undefined), 'undefined')
})

test('projectOf reads the last path segment on both separators', () => {
  assert.equal(projectOf('C:\\Users\\Dawn\\Documents\\deepseek-harness\\default-workspace'), 'default-workspace')
  assert.equal(projectOf('/home/dawn/projects/dsh-notify'), 'dsh-notify')
  assert.equal(projectOf('C:\\work\\trailing\\'), 'trailing')
  assert.equal(projectOf(''), undefined)
  assert.equal(projectOf('/'), undefined)
  assert.equal(projectOf(undefined), undefined)
})

test('shortId strips the session prefix and bounds the reference', () => {
  assert.equal(shortId('session-97217b96-1a9a-4bac-8be1-19a4560ada5c'), '97217b96')
  assert.equal(shortId('session-verify-0001'), 'verify-0')
  assert.equal(shortId('abcdefghijkl'), 'abcdefgh')
  assert.equal(shortId(''), undefined)
  assert.equal(shortId(undefined), undefined)
})

test('composeLabel degrades from project plus reference to a bare name', () => {
  assert.equal(composeLabel('default-workspace', 'session-97217b96-1a9a', '会话'), 'default-workspace · 97217b96')
  assert.equal(composeLabel('default-workspace', undefined, '会话'), 'default-workspace')
  assert.equal(composeLabel(undefined, 'session-verify-0001', '会话'), '会话 verify-0')
  assert.equal(composeLabel(undefined, undefined, '会话'), 'DSH')
  assert.equal(composeLabel(undefined, 'session-verify-0001', 'session'), 'session verify-0')
})

test('fill substitutes declared placeholders and leaves the rest', () => {
  assert.equal(fill('{a} and {b}', { a: 1, b: 'x' }), '1 and x')
  assert.equal(fill('{a} and {gone}', { a: 1 }), '1 and {gone}')
  assert.equal(fill(undefined, { a: 1 }), undefined)
})

test('durationText formats in the active locale', () => {
  assert.equal(durationText(0, ZH), '0秒')
  assert.equal(durationText(45_000, ZH), '45秒')
  assert.equal(durationText(60_000, ZH), '1分')
  assert.equal(durationText(192_000, ZH), '3分 12秒')
  assert.equal(durationText(3_600_000, ZH), '1时')
  assert.equal(durationText(192_000, EN), '3m 12s')
  assert.equal(durationText(-5, ZH), '0秒')
})

test('resolveConfig honours legitimate zero floors', () => {
  // Regression: a single `> 0` guard silently rewrote these to their defaults,
  // so "notify on every turn" and "never wait before the stall hint" were
  // impossible to configure.
  const config = resolveConfig({ minRunSeconds: 0, stallSeconds: 0 })
  assert.equal(config.minRunSeconds, 0)
  assert.equal(config.stallSeconds, 0)
})

test('resolveConfig rejects floors that would wedge the queue', () => {
  const config = resolveConfig({ maxInFlight: 0, timeoutMs: 0 })
  assert.equal(config.maxInFlight, 3)
  assert.equal(config.timeoutMs, 15_000)
  assert.equal(resolveConfig({ maxInFlight: 'lots' }).maxInFlight, 3)
})

test('resolveConfig ships the quiet policy and fills messages', () => {
  const config = resolveConfig({})
  assert.equal(config.notifyOnApproval, true)
  assert.equal(config.notifyOnQuestion, true)
  assert.equal(config.notifyOnError, true)
  assert.equal(config.notifyOnIdle, false)
  assert.equal(config.notifyOnStall, false)
  assert.equal(config.messages.units.second, '秒')
  assert.equal(resolveConfig({ locale: 'en' }).messages.units.second, 's')
  assert.equal(resolveConfig({ locale: 'nope' }).messages.units.second, '秒')
  // The footer default stays undefined so the session context can claim it.
  assert.equal(config.attribution, undefined)
  assert.equal(resolveConfig({ attribution: '  X  ' }).attribution, 'X')
})

test('resolveConfig resolves a focus pid only from a usable value', () => {
  // Unset is both the default and the interesting case: the window-owning process is
  // not reliably this process's parent, so the ancestry is derived at activation
  // instead. Anything unusable must leave the gate off rather than compare nonsense.
  assert.equal(resolveConfig({}).focusPid, undefined)
  assert.equal(resolveConfig({ focusPid: 4242 }).focusPid, 4242)
  assert.equal(resolveConfig({ focusPid: 0 }).focusPid, undefined)
  assert.equal(resolveConfig({ focusPid: -1 }).focusPid, undefined)
  assert.equal(resolveConfig({ focusPid: 'x' }).focusPid, undefined)
  assert.equal(resolveConfig({ quietWhenFocused: false }).quietWhenFocused, false)
  assert.equal(resolveConfig({}).quietWhenFocused, true)
})

test('resolveConfig leaves escalation off unless asked', () => {
  assert.equal(resolveConfig({}).escalateAfterSeconds, 0)
  assert.equal(resolveConfig({ escalateAfterSeconds: 90 }).escalateAfterSeconds, 90)
  assert.equal(resolveConfig({ escalateAfterSeconds: -5 }).escalateAfterSeconds, 0)
})

test('resolveConfig keeps volatile fields live instead of freezing them', () => {
  // The trap this guards: `{ ...DEFAULTS, ...input }` reads every property exactly
  // once. A volatile field that loses its accessor still returns the right value at
  // activation, so nothing looks wrong until a Settings edit silently never lands.
  const source = { notifyOnIdle: false, minRunSeconds: 20, sounds: { error: 'im' } }
  const config = resolveConfig(source)
  assert.equal(config.notifyOnIdle, false)
  assert.equal(config.minRunSeconds, 20)
  assert.equal(config.sounds.error, 'im')

  source.notifyOnIdle = true
  source.minRunSeconds = 0
  source.sounds = { error: 'alarm' }

  assert.equal(config.notifyOnIdle, true)
  assert.equal(config.minRunSeconds, 0)
  assert.equal(config.sounds.error, 'alarm')
  // Defaults still fill the gaps, recomputed on each read rather than copied.
  assert.equal(config.sounds.approval, 'default')
})

test('resolveConfig re-normalizes volatile values on every read', () => {
  const source = { minRunSeconds: -5, progressRefreshSeconds: 1, attribution: '   spaced   ' }
  const config = resolveConfig(source)
  assert.equal(config.minRunSeconds, 20)
  assert.equal(config.progressRefreshSeconds, 60)
  assert.equal(config.attribution, 'spaced')

  source.minRunSeconds = 7
  source.progressRefreshSeconds = 90
  assert.equal(config.minRunSeconds, 7)
  assert.equal(config.progressRefreshSeconds, 90)
})

test('static fields stay frozen, which is why they are not declared volatile', () => {
  const source = { maxInFlight: 2, stallCheckSeconds: 5 }
  const config = resolveConfig(source)
  assert.equal(config.maxInFlight, 2)
  source.maxInFlight = 9
  assert.equal(config.maxInFlight, 2)
})

test('resolveConfig merges the per-category maps instead of replacing them', () => {
  const config = resolveConfig({ sounds: { error: 'alarm' } })
  assert.equal(config.sounds.error, 'alarm')
  assert.equal(config.sounds.approval, 'default')
})

test('resolveIcon never records a node binary as the toast icon', () => {
  // Regression: the machine that runs a CLI or the harness has `process.execPath`
  // set to node, and recording it downgraded a correct registration.
  assert.equal(resolveIcon({}, 'D:\\Dev\\Node.js\\node.exe'), undefined)
  assert.equal(resolveIcon({}, '/usr/bin/node'), undefined)
  assert.equal(resolveIcon({}, ''), undefined)
  // A relative path would resolve against the working directory and advertise
  // the plugin's own folder as the toast icon.
  assert.equal(resolveIcon({}, 'DeepSeek Harness.exe'), undefined)
})

test('resolveIcon derives a file URI from a real application path', () => {
  const icon = resolveIcon({}, 'D:\\DeepSeek-Harness\\DeepSeek Harness.exe')
  assert.equal(icon, 'file:///D:/DeepSeek-Harness/DeepSeek%20Harness.exe')
})

test('resolveIcon lets an explicit iconUri win over everything', () => {
  assert.equal(
    resolveIcon({ iconUri: 'file:///pinned.ico' }, 'D:\\Dev\\Node.js\\node.exe'),
    'file:///pinned.ico',
  )
})

test('regValue reads one REG_SZ out of reg query output', () => {
  const output = [
    '',
    'HKEY_CURRENT_USER\\Software\\Classes\\AppUserModelId\\com.deepseek.dsh',
    '    DisplayName    REG_SZ    DeepSeek Harness',
    '    IconUri    REG_SZ    file:///D:/DeepSeek-Harness/DeepSeek%20Harness.exe',
    '',
  ].join('\r\n')
  assert.equal(regValue(output, 'DisplayName'), 'DeepSeek Harness')
  assert.equal(regValue(output, 'IconUri'), 'file:///D:/DeepSeek-Harness/DeepSeek%20Harness.exe')
  assert.equal(regValue(output, 'Missing'), undefined)
})

test('regValue reports an empty value rather than the next line', () => {
  const output = '    IconUri    REG_SZ    \r\n    DisplayName    REG_SZ    DeepSeek Harness\r\n'
  assert.equal(regValue(output, 'IconUri'), undefined)
  assert.equal(regValue(output, 'DisplayName'), 'DeepSeek Harness')
})

test('regValue tolerates values that contain spaces', () => {
  const output = '    DisplayName    REG_SZ    DeepSeek  Harness \r\n'
  assert.equal(regValue(output, 'DisplayName'), 'DeepSeek  Harness')
})
