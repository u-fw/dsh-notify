// Drive the plugin's real code against a fake Host context and inspect the
// toasts it produces.
//
// This is the verification harness for `lib/index.js`: it exercises the shell
// probe, the AUMID lookup, the session labelling, every event listener, the
// completion gate, and the stall watchdog without installing anything into a
// profile.
//
// It intercepts `child_process.spawn` before the plugin binds it, so it sees the
// exact payload each toast would render. That makes the assertions real: the
// body, the footer label, the buttons, and the launch URI are all checked, not
// merely "it did not throw".
//
//   node tools/verify-live.mjs          live: real toasts, clearly labelled
//   node tools/verify-live.mjs --dry    no toasts; full payload assertions
//
// Every live toast carries the attribution footer "dsh-notify 自检 · 非真实故障",
// because a self-test that looks exactly like a production failure is worse than
// no self-test. The `--dry` run leaves the footer free so the session labelling
// can be asserted against it.
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

/** `--dry` keeps the harness off your desktop while still checking every payload. */
const dry = process.argv.includes('--dry')

// Patch the renderer launch before the plugin module binds `spawn`. A builtin's
// ESM named exports are snapshotted when the namespace is first created, which
// the dynamic import below defers until after this assignment.
const require = createRequire(import.meta.url)
const childProcess = require('node:child_process')
const realSpawn = childProcess.spawn
const posted = []

childProcess.spawn = (command, args, options) => {
  const index = Array.isArray(args) ? args.indexOf('-PayloadB64') : -1
  if (index !== -1) posted.push(JSON.parse(Buffer.from(args[index + 1], 'base64').toString('utf8')))
  if (!dry) return realSpawn(command, args, options)
  // A dry run still drives the queue, the tag coalescing, and the payload build;
  // it only replaces the process that would draw the toast.
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => {}
  setImmediate(() => child.emit('close', 0))
  return child
}

const { apply, name, toastTag } = await import('../lib/index.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const listeners = new Map()
const effects = []
const logLines = []
const results = []

function check(label, ok, detail) {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}

const record = (level) => (...args) => {
  const line = args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')
  logLines.push(`${level}: ${line}`)
  console.log(`  [${level}] ${line}`)
}
const logger = Object.assign(() => ({ info: record('info'), warn: record('warn'), error: record('error') }), {
  info: record('info'),
  warn: record('warn'),
  error: record('error'),
})

// A context with exactly the surface `apply` touches. `commands` is faked so the
// `/notify` handler can be driven directly, and `inject` is faked so the Settings
// policy declaration is observable; every other lookup stays absent.
const registered = []
const settingsPolicies = []
const ctx = {
  on(event, handler) {
    listeners.set(event, [...(listeners.get(event) ?? []), handler])
    return () => {}
  },
  effect(factory, label) {
    effects.push({ label, dispose: factory() })
    return () => {}
  },
  inject(services, callback) {
    settingsPolicies.push({ services })
    callback({
      effect: (factory) => {
        effects.push({ label: `child of ${services.join(',')}`, dispose: factory() })
        return () => {}
      },
      settings: {
        configure: (policy, fiber) => {
          settingsPolicies.push({ policy, fiber })
          return () => {}
        },
      },
    })
    return () => {}
  },
  get(name) {
    if (name !== 'commands') return undefined
    return {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    }
  },
  logger,
}

const emit = async (event, ...args) => {
  const outcomes = []
  for (const handler of listeners.get(event) ?? []) outcomes.push(await handler(...args))
  return outcomes
}

// A session that resolves to a project directory, and one that never will.
const PROJECT = 'C:\\Users\\Dawn\\Documents\\deepseek-harness\\default-workspace'
const knownId = 'session-97217b96-1a9a-4bac-8be1-19a4560ada5c'
const unknownId = 'session-verify-0001'
const known = { id: knownId, header: { cwd: PROJECT } }
const knownAgent = { id: knownId }

console.log(`plugin name: ${name}`)
console.log(dry
  ? '*** DRY RUN — no toast is posted; every payload is still asserted ***'
  : '*** LIVE RUN — real toasts appear, each labelled as a self-test ***')
console.log('--- apply ---')
// Completion and stall reporting are opt-in, so the harness turns them on
// explicitly rather than relying on the shipped policy. A live run relabels the
// footer so its toasts cannot be mistaken for real events.
apply(ctx, {
  ...(dry ? {} : { attribution: 'dsh-notify 自检 · 非真实故障' }),
  minRunSeconds: 0,
  notifyOnIdle: true,
  notifyOnStall: true,
  stallSeconds: 1,
  stallCheckSeconds: 5,
  // Short enough to be observable here; the shipped default is off.
  escalateAfterSeconds: 0.4,
})

check('apply() registered listeners', listeners.size > 0, [...listeners.keys()].join(', '))
// The auto-generated form is switched off because the browser half owns the page;
// without this the Host and the page would both render configuration.
check('the plugin declares it ships its own settings page',
  settingsPolicies.some((entry) => entry.policy?.auto === false),
  JSON.stringify(settingsPolicies.filter((entry) => entry.policy !== undefined)))
check('every required listener is present',
  ['approval/request', 'user-questions/request', 'agent/error', 'api-session/error', 'agent/status',
    'agent/assistant-stream', 'session/created', 'session/event']
    .every((event) => listeners.has(event)))
check('a shell passed the WinRT probe',
  logLines.some((line) => line.includes('posting toasts through')),
  logLines.find((line) => line.includes('posting toasts through')) ?? 'no probe success recorded')

console.log('\n--- blocking requests ---')
// The session announcement is what teaches the plugin the project directory.
await emit('session/created', known)

let delegated = false
await emit('approval/request', { agent: knownAgent, toolName: 'pwsh', reason: '沙箱内的写操作需要你的批准' }, async () => {
  delegated = true
  return 'unavailable'
})
check('approval/request still delegates to next()', delegated)

let answered = false
await emit(
  'user-questions/request',
  { agent: knownAgent, questions: [{ id: 'q1', header: '选择部署方式', question: '要发布到哪个环境？' }] },
  async () => {
    answered = true
    return { answers: [] }
  },
)
check('user-questions/request still delegates to next()', answered)

console.log('\n--- escalation: a blocking request nobody answers ---')
const slowAgent = { id: 'session-97330000-aaaa' }
await emit('session/created', { id: slowAgent.id, header: { cwd: PROJECT } })
await emit(
  'approval/request',
  { agent: slowAgent, toolName: 'pwsh', reason: '这条请求要等 1.5 秒才被回答' },
  async () => {
    await sleep(1500)
    return 'allowed-once'
  },
)

console.log('\n--- failures ---')
await emit('agent/error', { agent: knownAgent, turn: 3, step: 2, error: new Error('模型请求失败：连接被重置') })
await emit('api-session/error', unknownId, '供给方返回 429')

console.log('\n--- completion ---')
await emit('agent/status', { agent: knownAgent, status: 'running' })
await sleep(60)
await emit('agent/status', { agent: knownAgent, status: 'idle' })

console.log('\n--- stall watchdog (running again, expect a hint within ~6s) ---')
await emit('agent/status', { agent: knownAgent, status: 'running' })
check('stall watchdog registered as an effect',
  effects.some((entry) => entry.label.includes('stall watchdog')))
await sleep(7000)

for (const entry of effects) entry.dispose?.()
await sleep(600)

// ---- Payload assertions ----------------------------------------------------

console.log(`\n--- ${String(posted.length)} payloads captured ---`)
// Locate a payload by the tag the plugin itself derives, so the harness and the
// implementation cannot disagree about how a notification is identified.
const tagged = (category, id) => posted.find((toast) => toast.tag === toastTag(category, id))

// A live run deliberately overrides the footer so its toasts cannot be mistaken
// for real events. That override outranks the session label, so the labelling is
// asserted only in a dry run, and a live run asserts the override instead.
const SELF_TEST_FOOTER = 'dsh-notify 自检 · 非真实故障'
const footer = (sessionLabel) => (dry ? sessionLabel : SELF_TEST_FOOTER)

if (posted.length === 0) {
  check('spawn interception captured payloads', false, 'the plugin never reached the renderer')
} else {
  check('spawn interception captured payloads', true)

  const approval = tagged('approval', knownId)
  check('approval toast: title', approval?.title === 'DSH 需要你的授权', approval?.title)
  check('approval toast: body is the request reason', approval?.body === '沙箱内的写操作需要你的批准', approval?.body)
  check(dry ? 'approval toast: labelled with project and short id' : 'approval toast: self-test footer wins',
    approval?.attribution === footer('default-workspace · 97217b96'), approval?.attribution)
  check('approval toast: two buttons and the dsh: launch',
    approval?.buttons?.length === 2 && approval?.launch === 'dsh://open',
    `buttons=${String(approval?.buttons?.length)} launch=${String(approval?.launch)}`)

  const question = tagged('question', knownId)
  check('question toast: title is the question header', question?.title === '选择部署方式', question?.title)
  check(dry ? 'question toast: labelled' : 'question toast: self-test footer wins',
    question?.attribution === footer('default-workspace · 97217b96'), question?.attribution)

  const knownError = tagged('error', knownId)
  check('known-session error: body is the message alone',
    knownError?.body === '模型请求失败：连接被重置', knownError?.body)
  check(dry ? 'known-session error: footer names the project' : 'known-session error: self-test footer wins',
    knownError?.attribution === footer('default-workspace · 97217b96'), knownError?.attribution)

  const unknownError = tagged('error', unknownId)
  check(dry ? 'unknown-session error: footer uses a session reference, not a raw id' : 'unknown-session error: self-test footer wins',
    unknownError?.attribution === footer('会话 verify-0'), unknownError?.attribution)
  check('unknown-session error: the raw id never reaches the body',
    !String(unknownError?.body ?? '').includes(unknownId), unknownError?.body)

  const idle = tagged('idle', knownId)
  check('completion toast: body names the label and the duration',
    typeof idle?.body === 'string' && idle.body.includes('default-workspace · 97217b96') && idle.body.includes('0秒'),
    idle?.body)

  const stall = tagged('stall', knownId)
  check('stall toast: body names the label and the silence',
    typeof stall?.body === 'string' && stall.body.includes('default-workspace · 97217b96') && stall.body.includes('没有新进展'),
    stall?.body)

  // A blanket guard: no toast may leak a full session id into visible text.
  const leaky = posted.filter((toast) => `${String(toast.body ?? '')}${String(toast.attribution ?? '')}`.includes(knownId))
  check('no toast leaks a full session id', leaky.length === 0,
    leaky.map((toast) => toast.tag).join(', '))

  // Once a blocking request is answered its toast must stop advertising it. The
  // retirement is a redraw under the same tag, which Action Center replaces; an
  // unpackaged process cannot remove a toast, so a second payload per tag is the
  // observable shape of the mechanism working.
  const firstSeen = new Map()
  const redraws = []
  for (const toast of posted) {
    if (firstSeen.has(toast.tag)) redraws.push(toast)
    else firstSeen.set(toast.tag, toast)
  }
  const redrawnTags = redraws.map((toast) => toast.tag)
  const settledRedraws = redraws.filter((toast) => toast.title === '已处理')
  const escalatedRedraws = redraws.filter((toast) => toast.title === '仍未处理')
  check('answering an approval re-draws its toast as settled',
    redrawnTags.includes(approval?.tag), redrawnTags.join(', ') || 'no redraws captured')
  check('answering a question re-draws its toast as settled',
    redrawnTags.includes(question?.tag), redrawnTags.join(', '))
  check('the settled toast is silent and brief',
    settledRedraws.length >= 2 && settledRedraws.every((toast) => toast.sound === 'silent' && toast.duration === 'short'),
    settledRedraws.map((toast) => `${String(toast.sound)}/${String(toast.duration)}`).join(', '))
  check('an unanswered blocking request escalates exactly once, louder and longer',
    escalatedRedraws.length === 1
      && escalatedRedraws[0].sound === 'reminder'
      && escalatedRedraws[0].duration === 'long'
      && escalatedRedraws[0].tag === toastTag('approval', slowAgent.id),
    `${String(escalatedRedraws.length)} escalated: ${escalatedRedraws.map((toast) => `${String(toast.sound)}/${String(toast.duration)}`).join(', ')}`)
  check('non-blocking toasts are never redrawn',
    !redrawnTags.includes(idle?.tag) && !redrawnTags.includes(knownError?.tag) && !redrawnTags.includes(stall?.tag),
    redrawnTags.join(', '))

  // Windows rejects a tag or group over 64 characters by throwing before the
  // toast is shown, so an over-long one loses the notification entirely. Only a
  // live run used to catch that; this makes a dry run catch it too.
  const overlong = posted.filter((toast) => String(toast.tag ?? '').length > 64 || String(toast.group ?? '').length > 64)
  check('every tag and group fits the 64-character platform ceiling',
    overlong.length === 0 && posted.every((toast) => typeof toast.tag === 'string' && toast.tag.length > 0),
    overlong.length === 0
      ? `longest tag ${String(Math.max(...posted.map((toast) => String(toast.tag ?? '').length)))} chars`
      : overlong.map((toast) => `${toast.tag} (${String(String(toast.tag).length)})`).join(', '))

  // The focus gate is all-or-nothing on purpose: gating some payloads and not
  // others would mean the probe's outcome leaked into per-category behaviour.
  const gated = new Set(posted.map((toast) => toast.skipWhenFocused !== undefined))
  check('the focus gate is applied to every toast or to none',
    gated.size === 1,
    [...gated].length === 1 && [...gated][0] === true
      ? `gated on pid ${String(posted[0]?.skipWhenFocused)}`
      : 'not gated (probe unavailable)')
}

// The AUMID registration is the one piece of state this plugin writes outside
// its own directory, and the harness is the worst possible author for it: its
// own `process.execPath` is a node binary. A run from here must never record
// node as the toast icon, which is the shape of the regression that downgraded a
// correct registration once already.
if (process.platform === 'win32') {
  const reg = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
  const queried = childProcess.spawnSync(
    reg,
    ['query', 'HKCU\\Software\\Classes\\AppUserModelId\\com.deepseek.dsh', '/v', 'IconUri'],
    { encoding: 'utf8' },
  )
  const line = queried.status === 0 ? queried.stdout.trim().split(/\r?\n/).at(-1) : ''
  const icon = line.split(/\s{2,}/u).at(-1) ?? ''
  check('a node-binary run never records node as the toast icon',
    !/node(?:\.exe)?$/iu.test(icon),
    icon === '' || icon === line ? 'no IconUri recorded' : icon)
}

// ---- Burst aggregation, on its own activation -------------------------------
//
// Batching has to be measured on a separate activation: switching it on above
// would collapse the two error toasts the earlier assertions depend on. A second
// context also proves the plugin holds no state outside its own closure.

console.log('\n--- burst aggregation, second activation ---')
const burstListeners = new Map()
const burstEffects = []
const burstCtx = {
  on(event, handler) {
    burstListeners.set(event, [...(burstListeners.get(event) ?? []), handler])
    return () => {}
  },
  effect(factory, label) {
    burstEffects.push({ label, dispose: factory() })
    return () => {}
  },
  get() {
    return undefined
  },
  logger,
}
apply(burstCtx, {
  aggregateWindowSeconds: 0.4,
  quietWhenFocused: false,
  notifyOnIdle: false,
  notifyOnStall: false,
  progressAfterSeconds: 0.3,
  progressRefreshSeconds: 30,
})
const burstEmit = async (event, ...args) => {
  for (const handler of burstListeners.get(event) ?? []) await handler(...args)
}

await burstEmit('session/created', { id: knownId, header: { cwd: PROJECT } })
const beforeBurst = posted.length
for (const round of [1, 2, 3]) {
  await burstEmit('agent/error', { agent: { id: `session-burst-${String(round)}` }, error: new Error(`连环错误 ${String(round)}`) })
}
await sleep(900)
const burstToasts = posted.slice(beforeBurst)
check('three errors inside one window become a single toast',
  burstToasts.length === 1 && String(burstToasts[0].body).includes('3 条新消息'),
  `${String(burstToasts.length)} toast(s): ${burstToasts.map((toast) => String(toast.body)).join(' | ')}`)
check('the aggregated toast carries the freshest detail and the category tag',
  String(burstToasts[0]?.body).includes('连环错误 3') && burstToasts[0]?.tag === toastTag('error', ''),
  `${String(burstToasts[0]?.tag)}: ${String(burstToasts[0]?.body)}`)

const beforeBlocking = posted.length
await burstEmit(
  'approval/request',
  { agent: { id: knownId }, toolName: 'pwsh', reason: '同一窗口内的阻断请求' },
  async () => 'unavailable',
)
check('a blocking request is never held back by the window',
  posted.length > beforeBlocking && posted[beforeBlocking]?.tag === toastTag('approval', knownId),
  posted[beforeBlocking]?.tag)

const beforeProgress = posted.length
await burstEmit('agent/status', { agent: { id: knownId }, status: 'running' })
await sleep(900)
const firstProgress = posted.slice(beforeProgress).filter((toast) => toast.tag === toastTag('progress', knownId))
check('a long-running turn reports progress, silently and with a bar',
  firstProgress.length === 1
    && firstProgress[0].progress !== undefined
    && firstProgress[0].sound === 'silent'
    && String(firstProgress[0].body).includes('已运行'),
  firstProgress.map((toast) => `${String(toast.title)}/${String(toast.sound)}/${JSON.stringify(toast.progress)}`).join(' | '))

await burstEmit('agent/status', { agent: { id: knownId }, status: 'idle' })
await sleep(400)
const progressLife = posted.filter((toast) => toast.tag === toastTag('progress', knownId))
check('the progress toast is rewritten as finished rather than left claiming work',
  progressLife.length >= 2
    && progressLife.at(-1).progress === undefined
    && progressLife.at(-1).title === 'DSH 已结束',
  progressLife.map((toast) => String(toast.title)).join(' -> '))
for (const entry of burstEffects) entry.dispose?.()

// ---- The `/notify` command --------------------------------------------------

console.log('\n--- /notify command ---')
const command = registered[0]
check('/notify is registered with the host', command?.name === 'notify', command?.description)

const muteReply = command.handler({ rawInput: 'mute 30' })
const postedBeforeMute = posted.length
await emit('agent/error', { agent: { id: 'session-muted' }, error: new Error('静音期间不应出现') })
check('/notify mute silences new notifications',
  muteReply.kind === 'success' && posted.length === postedBeforeMute,
  `${String(muteReply.text)} | ${String(posted.length - postedBeforeMute)} toast(s) drawn while muted`)

const statusReply = command.handler({ rawInput: 'status' })
check('/notify status reports the muted state and the transport',
  statusReply.kind === 'success' && String(statusReply.text).includes('静音') && String(statusReply.text).includes('shell'),
  statusReply.text)

const unmuteReply = command.handler({ rawInput: 'unmute' })
const postedBeforeUnmute = posted.length
await emit('agent/error', { agent: { id: 'session-muted' }, error: new Error('恢复后应出现') })
check('/notify unmute restores notifications',
  unmuteReply.kind === 'success' && posted.length > postedBeforeUnmute,
  `${String(unmuteReply.text)} | ${String(posted.length - postedBeforeUnmute)} toast(s) after unmute`)

check('/notify rejects an unknown subcommand with usage',
  command.handler({ rawInput: 'nonsense' }).kind === 'error')

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
console.log(`${posted.length} toasts ${dry ? 'composed (dry run, nothing shown)' : 'posted'}`)
process.exit(failed.length === 0 ? 0 : 1)
