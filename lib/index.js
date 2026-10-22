/**
 * dsh-notify -- Windows 11 native toast notifications for DeepSeek Harness.
 *
 * The gap this closes: work keeps running while the window is not focused, and a
 * turn that is blocked on an approval, has died on an error, or has simply
 * stopped producing progress looks exactly like a turn that is still thinking.
 * Each of those transitions becomes a Windows toast instead, and clicking one
 * brings the Harness window back to the front.
 *
 * Transport. Plugins run in the Host, which Electron starts as a plain Node
 * process (`ELECTRON_RUN_AS_NODE`), so `electron`'s own `Notification` API is out
 * of reach. Toasts are posted by Windows PowerShell through the WinRT projection
 * that ships with .NET Framework. PowerShell 7 is probed first and normally
 * loses: .NET Core dropped that projection, so `Windows.Data.Xml.Dom` and
 * `Windows.UI.Notifications` cannot be resolved there at all.
 *
 * Registration. A desktop app may only post toasts under an Application User
 * Model ID the shell knows about, which takes two halves: a Start Menu shortcut
 * carrying the AUMID, and `HKCU\Software\Classes\AppUserModelId\<appId>`. The
 * DeepSeek Harness installer writes the first; without the second,
 * `CreateToastNotifier` fails with 0x80073D54 "the process has no package
 * identity". This plugin writes the missing half once, idempotently, deriving
 * the icon from its own executable.
 *
 * @module dsh-notify
 */

import { spawn } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Cordis plugin name; must match the row's `id` in this bundle's patch. */
export const name = 'dsh-notify'

/** Every default the plugin reads from its row's `config`. */
const DEFAULTS = {
  enabled: true,
  /** AUMID the toast is posted under; the Desktop app ships this one. */
  appId: 'com.deepseek.dsh',
  /** Name Windows shows above the toast, and in Action Center. */
  displayName: 'DeepSeek Harness',
  /** Write the missing `HKCU\Software\Classes\AppUserModelId` half. */
  registerAppId: true,
  /** `auto` probes `pwsh` then Windows PowerShell; or name an executable. */
  shell: 'auto',
  /** Extra argv for the shell, before `-File`. */
  shellArgs: [],
  /**
   * URI opened when a toast body is clicked. `dsh://open` is the only value the
   * Desktop shell recognises (`lib/main.js`: `url === "dsh://open"`); on Windows
   * the URL is discarded entirely and the second instance focuses the primary
   * window, which is the same outcome.
   */
  openUri: 'dsh://open',
  /** Language of the built-in message text. */
  locale: 'zh',
  /** Notify while a turn waits for an approval decision. */
  notifyOnApproval: true,
  /** Notify while a turn waits for a structured question. */
  notifyOnQuestion: true,
  /** Notify when a turn or a session fails. */
  notifyOnError: true,
  /** Notify when the account needs attention (sign-in, expired session). */
  notifyOnAccount: true,
  /**
   * Notify when a turn that ran long enough finishes. Off by default: the
   * shipped policy only interrupts for work that is blocked on the user. Turn
   * it on to hear about long turns finishing.
   */
  notifyOnIdle: false,
  /**
   * Notify when a running turn stops showing progress. Off by default alongside
   * `notifyOnIdle`; the watchdog is registered whenever this is on.
   */
  notifyOnStall: false,
  /** Notify when a workflow run settles. */
  notifyOnWorkflowEnd: false,
  /** Also notify for subagent sessions rather than only root agents. */
  includeSubagents: false,
  /**
   * Re-draw a blocking request's toast as settled once it has been answered.
   * Action Center replaces a matching tag, so the question the user already
   * answered stops being advertised as pending.
   */
  settleResolvedToasts: true,
  /**
   * Seconds an unanswered blocking request waits before its toast is re-drawn
   * with a louder sound. Zero disables escalation, which is the shipped default:
   * a `long` toast already survives in Action Center until it is dealt with.
   */
  escalateAfterSeconds: 0,
  /** Sound the escalated redraw uses. */
  escalateSound: 'reminder',
  /**
   * Stay quiet while the Desktop window owns the foreground. The probe is proved
   * at activation and the gate fails open: a broken probe draws the toast.
   */
  quietWhenFocused: true,
  /**
   * Seconds a non-blocking burst is collected before one summary toast is drawn.
   * Zero, the shipped default, draws every notification immediately: batching
   * trades latency for quiet, and that is the user's call to make.
   */
  aggregateWindowSeconds: 0,
  /**
   * Seconds a running turn waits before a progress toast appears, and how often
   * that toast is refreshed with the elapsed time. Zero, the default, disables
   * both: a progress toast only makes sense if you want to be told work is
   * ongoing, and the stall hint already covers the opposite question.
   */
  progressAfterSeconds: 0,
  progressRefreshSeconds: 60,
  /** A turn shorter than this never produces a completion toast. */
  minRunSeconds: 20,
  /** Silence for this long on a running agent is reported as a stall hint. */
  stallSeconds: 240,
  /** How often the stall watchdog samples. */
  stallCheckSeconds: 15,
  /** Per-category sound: `default`, `silent`, `alarm`, `im`, `mail`, `reminder`. */
  sounds: {
    approval: 'default',
    question: 'default',
    error: 'default',
    account: 'default',
    idle: 'default',
    stall: 'default',
    workflow: 'default',
  },
  /** Per-category on-screen lifetime: `short` or `long`. */
  durations: {
    approval: 'long',
    question: 'long',
    error: 'long',
    account: 'long',
    idle: 'short',
    stall: 'long',
    workflow: 'short',
  },
  /** Concurrent toast processes; further toasts wait in a queue. */
  maxInFlight: 3,
  /** A toast process that outlives this is killed and reported as a failure. */
  timeoutMs: 15_000,
  /** Post one probe toast when the plugin activates, to prove the channel. */
  selfTest: false,
}

/**
 * Localized copy for every category. `{name}` placeholders are filled at post
 * time, and `units` renders the durations the progress toasts report.
 */
const MESSAGES = {
  zh: {
    approval: { title: 'DSH 需要你的授权', fallback: '有一个工具调用在等你的决定' },
    question: { title: 'DSH 需要你的选择', fallback: '有一个问题在等你回答', more: '（共 {count} 个问题）' },
    error: { title: 'DSH 出错了' },
    account: {
      title: 'DSH 账号需要处理',
      signInRequired: '模型请求需要先登录账号。',
      sessionExpired: '账号登录已过期，需要重新登录。',
    },
    idle: { title: 'DSH 已完成', body: '{label}：用时 {duration}，等待你的下一步。' },
    stall: { title: 'DSH 可能卡住了', body: '{label}：已 {duration} 没有新进展，可能仍在等模型或跑长命令。' },
    workflow: { title: 'DSH 工作流已结束', body: '{name}：{status}' },
    settled: {
      title: '已处理',
      approval: '授权请求已结束，无需再处理。',
      question: '问题已回答，无需再处理。',
    },
    escalated: {
      title: '仍未处理',
      approval: '授权请求',
      question: '提问',
      body: '{what}已等待 {duration}，仍未收到你的回应。',
    },
    aggregated: { body: '{count} 条新消息，最近一条：{body}' },
    progress: { title: 'DSH 正在工作', body: '{label}：已运行 {duration}', bar: '运行中' },
    progressDone: { title: 'DSH 已结束', body: '{label}：用时 {duration}' },
    command: {
      description: '控制 DSH 桌面通知',
      hint: 'mute [分钟] | unmute | status | test',
      usage: '用法：/notify mute [分钟] | unmute | status | test',
      muted: '通知已静音，{duration}后恢复。',
      mutedForever: '通知已静音，直到执行 /notify unmute。',
      unmuted: '通知已恢复。',
      testing: '已发出一条自检通知。',
      stateMuted: '静音中',
      stateLive: '正常',
    },
    selfTest: { title: 'DSH 通知已启用', body: '点击这条通知可以把 DSH 窗口切到前台。' },
    attribution: 'DeepSeek Harness',
    sessionPrefix: '会话',
    openApp: '打开 DSH',
    dismiss: '知道了',
    unknownError: '未知错误',
    units: { second: '秒', minute: '分', hour: '时' },
  },
  en: {
    approval: { title: 'DSH needs your approval', fallback: 'A tool call is waiting for your decision' },
    question: { title: 'DSH needs your answer', fallback: 'A question is waiting for your reply', more: ' (+{count} more)' },
    error: { title: 'DSH hit an error' },
    account: {
      title: 'DSH account needs attention',
      signInRequired: 'A model request needs you to sign in.',
      sessionExpired: 'The account session expired; sign in again.',
    },
    idle: { title: 'DSH finished', body: '{label}: ran for {duration}, waiting for your next step.' },
    stall: { title: 'DSH may be stuck', body: '{label}: no observable progress for {duration}.' },
    workflow: { title: 'DSH workflow finished', body: '{name}: {status}' },
    settled: {
      title: 'Answered',
      approval: 'The approval request is settled.',
      question: 'The question has been answered.',
    },
    escalated: {
      title: 'Still waiting',
      approval: 'The approval request',
      question: 'The question',
      body: '{what} has waited {duration} with no response from you.',
    },
    aggregated: { body: '{count} new messages; most recent: {body}' },
    progress: { title: 'DSH is working', body: '{label}: running for {duration}', bar: 'running' },
    progressDone: { title: 'DSH finished', body: '{label}: took {duration}' },
    command: {
      description: 'Control DSH desktop notifications',
      hint: 'mute [minutes] | unmute | status | test',
      usage: 'Usage: /notify mute [minutes] | unmute | status | test',
      muted: 'Muted; notifications resume in {duration}.',
      mutedForever: 'Muted until /notify unmute.',
      unmuted: 'Notifications resumed.',
      testing: 'Self-test notification sent.',
      stateMuted: 'muted',
      stateLive: 'live',
    },
    selfTest: { title: 'DSH notifications are on', body: 'Clicking this toast brings the DSH window forward.' },
    attribution: 'DeepSeek Harness',
    sessionPrefix: 'session',
    openApp: 'Open DSH',
    dismiss: 'Dismiss',
    unknownError: 'unknown error',
    units: { second: 's', minute: 'm', hour: 'h' },
  },
}

/** Why the Settings schema is missing, when it is. Reported once from `apply`. */
let configSchemaError

/**
 * The Settings schema for this row's `config`.
 *
 * DSH renders a form for a plugin whose `Config` is a Schemastery schema, and
 * projects it to the JSON Schema the Config inspect provider serves. The form is
 * desirable but not load-bearing, so the whole thing is guarded:
 * `@deepseek-ai/schemastery` ships inside the dsh installation, and a bundle
 * installed with `link:` lives outside it, where that bare import does not
 * resolve. Losing the load must cost the Settings form and nothing else.
 *
 * Every key `resolveConfig` reads is declared here on purpose: schemastery
 * returns only declared properties, so an undeclared knob would be silently
 * dropped from the user's patch instead of reaching the plugin.
 *
 * @returns the schema, or `undefined` when schemastery cannot be resolved.
 */
function buildConfigSchema() {
  try {
    // The CJS build assigns the schema factory to `module.exports` itself, so
    // `.default` is absent; the ESM build nests it. Accept either shape.
    const loaded = createRequire(import.meta.url)('@deepseek-ai/schemastery')
    const z = loaded.default ?? loaded
    return z.object({
      enabled: z.boolean().default(true).description('总开关。'),
      appId: z.string().default('com.deepseek.dsh').description('通知使用的应用标识（AUMID）。'),
      displayName: z.string().default('DeepSeek Harness').description('Windows 通知上显示的应用名。'),
      registerAppId: z.boolean().default(true).description('缺少时自动补写 AUMID 注册项。'),
      shell: z.string().default('auto').description('PowerShell 可执行文件；auto 为自动探测。'),
      shellArgs: z.array(z.string()).default([]).description('附加在 -File 之前的命令行参数。'),
      openUri: z.string().default('dsh://open').description('点击通知正文时打开的 URI。'),
      locale: z.union([z.const('zh'), z.const('en')]).default('zh').description('内置文案语言。'),
      // `.volatile()` is what makes a field editable from a Settings page: the
      // settings service projects only volatile fields into a form, and each one
      // is read live rather than frozen at activation. The matching live readers
      // are the VOLATILE_SPECS table; a field in one and not the other would either
      // promise an edit that never lands or freeze one that should.
      attribution: z.string().volatile().description('页脚文案；留空则显示会话上下文。'),
      iconUri: z.string().description('通知图标（file:// URI）；留空则用 DSH 自身可执行文件。'),

      notifyOnApproval: z.boolean().default(true).volatile().description('工具调用在等你授权。'),
      notifyOnQuestion: z.boolean().default(true).volatile().description('有问题在等你回答。'),
      notifyOnError: z.boolean().default(true).volatile().description('回合或会话报错。'),
      notifyOnAccount: z.boolean().default(true).volatile().description('账号需要登录或登录已过期。'),
      notifyOnIdle: z.boolean().default(false).volatile().description('耗时较长的回合跑完了。'),
      notifyOnStall: z.boolean().default(false).volatile().description('运行中的回合长时间没有进展。'),
      notifyOnWorkflowEnd: z.boolean().default(false).volatile().description('工作流结束。'),
      includeSubagents: z.boolean().default(false).volatile().description('子代理会话也发通知。'),
      settleResolvedToasts: z.boolean().default(true).volatile().description('授权/提问办完后把通知改写为「已处理」。'),
      escalateAfterSeconds: z.number().default(0).volatile().description('阻断请求多久没回应就再提醒一次（秒）；0 为关闭。'),
      escalateSound: z.string().default('reminder').volatile().description('升级提醒使用的提示音。'),
      quietWhenFocused: z.boolean().default(true).volatile().description('DSH 窗口在前台时不打扰。'),
      aggregateWindowSeconds: z.number().default(0).volatile().description('同类非阻断通知的合并窗口（秒）；0 为不合并。'),
      progressAfterSeconds: z.number().default(0).volatile().description('长任务运行多少秒后出现进度通知；0 为关闭。'),
      progressRefreshSeconds: z.number().default(60).volatile().description('进度通知的刷新间隔（秒）。'),

      // Static: decided at activation, so these are edited in cordis.patch.yml only.
      focusPid: z.number().description('前台判定所比较的进程号；留空则用宿主父进程。（需重载）'),
      stallCheckSeconds: z.number().default(15).description('看门狗采样间隔（秒）。（需重载）'),
      maxInFlight: z.number().default(3).description('并发的通知进程数上限。（需重载）'),
      timeoutMs: z.number().default(15_000).description('单条通知进程的超时（毫秒）。（需重载）'),
      selfTest: z.boolean().default(false).description('激活时发一条自检通知。（需重载）'),

      minRunSeconds: z.number().default(20).volatile().description('短于这个秒数的回合不报完成。'),
      stallSeconds: z.number().default(240).volatile().description('静默超过这个秒数就提示可能卡住。'),
      sounds: z.dict(z.string()).default({ ...DEFAULTS.sounds }).volatile().description('每类通知的提示音。'),
      durations: z.dict(z.string()).default({ ...DEFAULTS.durations }).volatile().description('每类通知的驻留时长。'),
    })
  } catch (error) {
    configSchemaError = error
    return undefined
  }
}

/** Settings schema for the row's `config`; absent when schemastery is unavailable. */
export const Config = buildConfigSchema()

/** Windows PowerShell, which always carries the .NET Framework WinRT projection. */
const WINDOWS_POWERSHELL = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

/** `reg.exe`, addressed absolutely so PATH cannot change what gets written. */
const REG_EXE = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')

/** Toast group every notification is filed under, and the handle a withdrawal uses. */
const TOAST_GROUP = 'dsh'

/**
 * Settings namespace the browser half edits: the plugin's own profile entry id.
 *
 * Spelled here rather than derived, because the client half cannot import a Host
 * module and must carry the same literal. `tools/lint.mjs` checks that this and the
 * browser half's copy agree.
 */
export const SETTINGS_NAMESPACE = 'dsh-notify'

/**
 * Windows caps both `ToastNotification.Tag` and `.Group` at 64 characters, and
 * setting a longer one throws *before* the toast is shown -- so an over-long tag
 * loses the notification, not merely its identity. Measured, not assumed: 64
 * succeeds and 65 fails for both properties.
 */
const TOAST_FIELD_LIMIT = 64

/** Two-letter category codes, so a tag stays readable in a diagnostic. */
const TAG_CODES = {
  approval: 'ap',
  question: 'qu',
  error: 'er',
  account: 'ac',
  idle: 'id',
  stall: 'st',
  workflow: 'wf',
  progress: 'pg',
  default: 'df',
}

/** 32-bit FNV-1a as eight lowercase hex characters. */
export function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Build a toast tag Windows accepts.
 *
 * The tag is what makes a redraw replace its predecessor, so it has to be stable
 * per notification and distinct across sessions -- while staying inside the
 * 64-character ceiling. A session id is 44 characters on its own, so the identity
 * is hashed rather than embedded: an 11-character tag is derived from the category
 * and session, which no session id can outgrow.
 *
 * @param category - the notification category, which supplies the readable prefix.
 * @param id - the session the notification belongs to, when it has one.
 * @returns a stable tag well under the platform limit.
 */
export function toastTag(category, id) {
  const code = TAG_CODES[category] ?? 'xx'
  return `${code}-${fnv1a(`${category}:${String(id ?? '')}`)}`
}

/** This file's directory, so the bundled renderer resolves beside the plugin. */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Append one line to the activation trace.
 *
 * The failure mode of a notification plugin is silence. When `apply` stops early
 * nothing notifies, nothing errors where a user can see it, the entry still reports
 * `active`, and its settings page still opens — so "it isn't notifying" has no visible
 * cause at all. The trace makes the difference readable:
 *
 * - no `apply start`              → the module never activated
 * - `apply start` but no `rest`   → activation stopped part-way, and the line names
 *                                   the milestone it reached
 * - `apply threw`                 → the throw, with its message
 * - `apply finished`              → it is live and quiet, which is a different thing
 *
 * It also records the first few listener invocations, so "events arrive but no toast"
 * is distinguishable from "no events arrive". Bounded, synchronous, and it can never
 * throw into the plugin.
 */
const TRACE_FILE = join(tmpdir(), 'dsh-notify-trace.log')
const TRACE_LIMIT = 4000
let traceBudget = 400

/** Record one activation milestone or listener hit. */
export function trace(line) {
  if (traceBudget <= 0) return
  traceBudget -= 1
  try {
    const size = existsSync(TRACE_FILE) ? statSync(TRACE_FILE).size : 0
    if (size > TRACE_LIMIT * 1024) return
    appendFileSync(TRACE_FILE, `${new Date().toISOString()} [${String(process.pid)}] ${line}\n`)
  } catch {
    /* tracing must never break the plugin */
  }
}

/**
 * One-line failure text for any thrown value.
 *
 * The pure helpers below are exported so `test/*.test.mjs` can drive them directly
 * instead of standing up a Host context for each case.
 */
export const errorText = (error) => (error instanceof Error ? error.message : String(error))

/** Collapse whitespace and bound a string for a toast line. */
export function clip(value, limit) {
  if (typeof value !== 'string') return undefined
  const flat = value.replace(/\s+/gu, ' ').trim()
  if (flat === '') return undefined
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** Substitute `{name}` placeholders in one message template. */
export function fill(template, vars) {
  if (typeof template !== 'string') return undefined
  return template.replace(/\{(\w+)\}/gu, (match, key) => (key in vars ? String(vars[key]) : match))
}

/** Project directory a session runs in -- the last path segment of its `cwd`. */
export function projectOf(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return undefined
  const parts = cwd.split(/[\\/]+/u).filter((part) => part.length > 0)
  const name = parts.at(-1)
  return name === undefined || name === '' ? undefined : clip(name, 40)
}

/**
 * Short, stable reference to one session, derived from its id.
 *
 * A raw session id is 44 characters of noise that reads like an error code, so
 * an unidentified session is named by an eight-character tail instead.
 */
export function shortId(id) {
  const raw = String(id ?? '')
  const stripped = raw.startsWith('session-') ? raw.slice('session-'.length) : raw
  return stripped === '' ? undefined : stripped.slice(0, 8)
}

/**
 * Name one session for a toast.
 *
 * A project directory plus a short session reference is what tells two
 * concurrent sessions apart; when the directory is not yet known the reference
 * carries the label alone, because a raw 44-character session id reads like an
 * error code rather than a name.
 *
 * @param project - the session's project directory name, when one is known.
 * @param id - the session id.
 * @param sessionPrefix - the locale's word for "session".
 * @returns the label, never empty.
 */
export function composeLabel(project, id, sessionPrefix) {
  const name = clip(project, 40)
  const short = shortId(id)
  if (name !== undefined && short !== undefined) return `${name} · ${short}`
  if (name !== undefined) return name
  if (short !== undefined) return `${sessionPrefix} ${short}`
  return 'DSH'
}

/**
 * Whole seconds as a compact duration in the active locale.
 *
 * @param ms - elapsed milliseconds.
 * @param units - `{ second, minute, hour }` from the locale's message table.
 * @returns text such as `45秒`, `3分 12秒`, or `1时 05分`-shaped equivalents.
 */
export function durationText(ms, units) {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000))
  if (seconds < 60) return `${String(seconds)}${units.second}`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const rest = seconds % 60
    return rest === 0 ? `${String(minutes)}${units.minute}` : `${String(minutes)}${units.minute} ${String(rest)}${units.second}`
  }
  const rest = minutes % 60
  const hours = Math.floor(minutes / 60)
  return rest === 0 ? `${String(hours)}${units.hour}` : `${String(hours)}${units.hour} ${String(rest)}${units.minute}`
}

/** Merge one config layer over the defaults, one level deep for the maps. */
/**
 * Accept a numeric knob only when it parses and clears its own floor.
 *
 * The floors differ on purpose: `minRunSeconds: 0` and `stallSeconds: 0` are
 * meaningful requests ("every turn", "never wait"), while a zero `maxInFlight`
 * or `timeoutMs` would wedge the queue. A single `> 0` guard for all of them
 * silently rewrote the legitimate zeros.
 */
function bounded(value, fallback, minimum) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback
}

/**
 * Fields a Settings page may change while the plugin is running, with the
 * normalization each one needs.
 *
 * These are the fields the schema declares `.volatile()`. A volatile field arrives
 * as a live value, and `{ ...DEFAULTS, ...input }` reads each one exactly once and
 * freezes it — silently defeating the volatility the schema declared, with no
 * error raised anywhere. Every key here is therefore redefined as an accessor that
 * re-reads the source on each access.
 *
 * A field belongs here only if the plugin reads it at *use* time. One captured at
 * registration (an interval's period, a gate decided at activation) cannot be
 * live, and marking it volatile would promise an edit that never lands.
 */
export const VOLATILE_SPECS = {
  notifyOnApproval: { kind: 'boolean' },
  notifyOnQuestion: { kind: 'boolean' },
  notifyOnError: { kind: 'boolean' },
  notifyOnAccount: { kind: 'boolean' },
  notifyOnIdle: { kind: 'boolean' },
  notifyOnStall: { kind: 'boolean' },
  notifyOnWorkflowEnd: { kind: 'boolean' },
  includeSubagents: { kind: 'boolean' },
  settleResolvedToasts: { kind: 'boolean' },
  quietWhenFocused: { kind: 'boolean' },
  minRunSeconds: { kind: 'number' },
  stallSeconds: { kind: 'number' },
  escalateAfterSeconds: { kind: 'number' },
  escalateSound: { kind: 'text', limit: 80 },
  aggregateWindowSeconds: { kind: 'number' },
  progressAfterSeconds: { kind: 'number' },
  progressRefreshSeconds: { kind: 'number', minimum: 5 },
  attribution: { kind: 'text', limit: 60 },
  sounds: { kind: 'dict' },
  durations: { kind: 'dict' },
}

/** Read one volatile field from the live source, normalized as the static path was. */
function readVolatile(key, spec, input) {
  const raw = input[key]
  if (raw === undefined) return spec.kind === 'dict' ? { ...DEFAULTS[key] } : DEFAULTS[key]
  if (spec.kind === 'boolean') return raw === true
  if (spec.kind === 'number') return bounded(raw, DEFAULTS[key], spec.minimum ?? 0)
  if (spec.kind === 'dict') {
    return { ...DEFAULTS[key], ...(typeof raw === 'object' && raw !== null ? raw : {}) }
  }
  return clip(raw, spec.limit ?? 120) ?? DEFAULTS[key]
}

export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const merged = { ...DEFAULTS, ...input }
  merged.messages = MESSAGES[merged.locale] ?? MESSAGES.zh
  merged.iconUri = clip(input.iconUri, 300)

  // Static knobs: decided at activation and never re-read, so a settings page
  // cannot honestly promise a live edit for them.
  merged.stallCheckSeconds = bounded(merged.stallCheckSeconds, DEFAULTS.stallCheckSeconds, 0)
  merged.maxInFlight = bounded(merged.maxInFlight, DEFAULTS.maxInFlight, 1)
  merged.timeoutMs = bounded(merged.timeoutMs, DEFAULTS.timeoutMs, 1)
  // Left undefined unless configured explicitly: the window-owning process is not
  // always this process's direct parent (a launcher can sit between them, which is how
  // the Desktop app came to spawn the Host), so `probeFocus` derives the whole
  // ancestry at activation instead of trusting one guessed pid.
  const requestedPid = Number(input.focusPid)
  merged.focusPid = Number.isSafeInteger(requestedPid) && requestedPid > 0 ? requestedPid : undefined

  // Volatile fields are installed last and as accessors, so no plain assignment
  // above can shadow one and freeze it.
  for (const [key, spec] of Object.entries(VOLATILE_SPECS)) {
    Object.defineProperty(merged, key, {
      enumerable: true,
      configurable: true,
      get: () => readVolatile(key, spec, input),
    })
  }
  return merged
}

/**
 * The icon worth advertising for the AUMID, or `undefined` when none is known.
 *
 * `process.execPath` is the Desktop application only when the Host runs under
 * Electron. Started from a CLI, or from the verification harness, it is a node
 * binary, and recording that would *downgrade* a correct registration. An unknown
 * icon is therefore preferred over a wrong one: Windows then keeps whatever the
 * Start Menu shortcut advertises, which is the real DeepSeek Harness icon.
 *
 * @param config - resolved plugin config.
 * @param execPath - the running host's executable; injectable so a test can
 *   drive both the trusted and the untrusted case without spawning anything.
 * @returns a `file://` URI, or `undefined` to leave the recorded icon alone.
 */
export function resolveIcon(config, execPath = process.execPath) {
  const explicit = clip(config.iconUri, 300)
  if (explicit !== undefined) return explicit
  const candidate = execPath
  // `isAbsolute` rejects the empty and relative cases together: `pathToFileURL`
  // would otherwise resolve either one against the working directory and
  // advertise the plugin's own folder as the toast icon.
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) return undefined
  if (/^node(?:\.exe)?$/iu.test(basename(candidate))) return undefined
  try {
    return pathToFileURL(candidate).href
  } catch {
    return undefined
  }
}

/** Read one `REG_SZ` value out of `reg query` output. */
export function regValue(output, name) {
  // `[ \t]` rather than `\s`: a `\s+` would let an empty value swallow the line
  // break and capture the next line's text instead of reporting "no value".
  const match = new RegExp(`^[ \\t]*${name}[ \\t]+REG_SZ[ \\t]+(.*)$`, 'mu').exec(output)
  const value = match?.[1]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/**
 * The AUMID registration half the installer omits, written through `reg.exe`.
 *
 * An activation with nothing to correct stays a pure read, so this runs on every
 * boot without churning the registry. The name is kept accurate whenever it
 * drifts; the icon is written only from a trustworthy source, which is what stops
 * a CLI or harness run from overwriting the Desktop app's icon with a node
 * binary. A key that is missing or misnamed is rebuilt outright.
 *
 * @param config - resolved plugin config.
 * @param log - the plugin's scoped logger.
 */
function ensureAppId(config, log) {
  if (process.platform !== 'win32' || config.registerAppId !== true) return
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${config.appId}`
  const icon = resolveIcon(config)

  const query = spawnSync(REG_EXE, ['query', key], { windowsHide: true, encoding: 'utf8' })
  const output = query.status === 0 && typeof query.stdout === 'string' ? query.stdout : undefined
  const named = output !== undefined && regValue(output, 'DisplayName') === config.displayName
  const recorded = output === undefined ? undefined : regValue(output, 'IconUri')
  if (named && (icon === undefined || recorded === icon)) return

  const writes = [['DisplayName', config.displayName]]
  if (icon !== undefined) writes.push(['IconUri', icon])
  for (const [flag, value] of writes) {
    const write = spawnSync(REG_EXE, ['add', key, '/v', flag, '/t', 'REG_SZ', '/d', value, '/f'], {
      windowsHide: true,
      encoding: 'utf8',
    })
    if (write.status !== 0) {
      const why = clip(write.stderr, 200) ?? errorText(write.error) ?? 'unknown failure'
      log('warn', `could not register AUMID ${config.appId} (${flag}): ${why}`)
      return
    }
  }
  const note = icon === undefined ? ' (icon left to the Start Menu shortcut)' : ''
  log('info', `registered toast identity ${config.appId} as "${config.displayName}"${note}`)
}

/**
 * Prove the foreground-window probe before trusting it to suppress anything.
 *
 * The gate fails in the dangerous direction when it is broken: a probe that always
 * answered "focused" would silently swallow every notification, which is the one
 * failure this plugin must never have. Proving the capability once keeps that
 * impossible -- an unusable probe simply leaves the gate off.
 *
 * @param config - resolved plugin config.
 * @param shell - the PowerShell that passed the toast probe.
 * @param log - the plugin's scoped logger.
 * @returns the pid to compare against, or `undefined` to always draw.
 */
function probeFocus(config, shell, log) {
  // An explicit `focusPid` is compared directly. Left unset -- the default -- the
  // ancestry is derived instead, because the window-owning process is not always the
  // Host's direct parent: a launcher can sit between them.
  const requested = config.focusPid
  const check = requested === undefined
    ? { pids: [], ancestorsOf: process.ppid }
    : { pids: [requested] }
  const payload = Buffer.from(JSON.stringify({ appId: config.appId, focusCheck: check }), 'utf8').toString('base64')
  const result = spawnSync(
    shell,
    [...config.shellArgs, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, 'toast.ps1'), '-PayloadB64', payload],
    { windowsHide: true, encoding: 'utf8', timeout: 20_000 },
  )
  if (result.status !== 0) {
    log('info', `focus gate off: probe exited ${String(result.status)} (${clip(result.stderr, 160) ?? 'no detail'})`)
    return undefined
  }
  try {
    const parsed = JSON.parse(String(result.stdout).trim())
    if (!(Number.isSafeInteger(parsed.foreground) && parsed.foreground > 0)) {
      log('info', 'focus gate off: the foreground probe returned nothing usable')
      return undefined
    }
    const candidates = requested === undefined
      ? (Array.isArray(parsed.ancestors) ? parsed.ancestors : []).filter((pid) => Number.isSafeInteger(pid) && pid > 0)
      : [requested]
    if (candidates.length === 0) {
      log('info', 'focus gate off: no parent ancestry to compare the foreground window against')
      return undefined
    }
    log('info', `focus gate on: suppressing while one of ${candidates.join('/')} owns the foreground window`)
    return candidates
  } catch {
    /* reported below */
  }
  log('info', 'focus gate off: the foreground probe returned nothing usable')
  return undefined
}

/**
 * Decide which PowerShell posts the toasts, by asking one to build a toast and
 * create a notifier without showing anything.
 *
 * @param config - resolved plugin config.
 * @param log - the plugin's scoped logger.
 * @returns the executable to use, or `undefined` when none can post toasts.
 */
function resolveShell(config, log) {
  if (process.platform !== 'win32') return undefined

  // Windows PowerShell is probed first because it is the one that works: .NET
  // Core dropped the WinRT projection, so `pwsh` normally cannot resolve
  // `Windows.Data.Xml.Dom.XmlDocument` at all. Trusting one successful probe
  // over the version number keeps a future PowerShell that regains the
  // projection from being locked out, and `shell: pwsh` still forces the try.
  const candidates = config.shell === 'auto' || config.shell === undefined || config.shell === ''
    ? [WINDOWS_POWERSHELL, 'pwsh']
    : [config.shell]
  const renderer = join(HERE, 'toast.ps1')
  if (!existsSync(renderer)) {
    log('error', `toast renderer is missing at ${renderer}`)
    return undefined
  }

  for (const candidate of candidates) {
    const probe = JSON.stringify({ appId: config.appId, title: 'probe', dryRun: true })
    const result = spawnSync(
      candidate,
      [...config.shellArgs, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', renderer, '-PayloadB64', Buffer.from(probe, 'utf8').toString('base64')],
      { windowsHide: true, encoding: 'utf8', timeout: 20_000 },
    )
    if (result.status === 0 && typeof result.stdout === 'string' && result.stdout.includes('ready')) {
      log('info', `posting toasts through ${candidate}`)
      return candidate
    }
    const why = clip(result.stderr, 200) ?? errorText(result.error) ?? `exit ${String(result.status)}`
    log('info', `toast probe failed under ${candidate}: ${why}`)
  }

  log('error', 'no PowerShell on this machine can post WinRT toasts; notifications are disabled')
  return undefined
}

/**
 * Build the notifier: the Windows-specific capability check, the toast queue, and
 * the token that keeps at most `maxInFlight` renderer processes alive.
 *
 * @param config - resolved plugin config.
 * @param log - the plugin's scoped logger.
 * @returns `{ post, report }`, where `post` accepts one toast description and
 *   `report` summarizes what the transport has done so far.
 */
function createNotifier(config, log) {
  const shell = resolveShell(config, log)
  const renderer = join(HERE, 'toast.ps1')
  // Probed even while the gate is off, so turning it on from Settings works without
  // a reload. The flag decides per draw whether the ancestry is applied at all.
  const focusPids = shell === undefined ? undefined : probeFocus(config, shell, log)
  const queue = []
  /** Tags currently being drawn, so a withdrawal can wait for the toast to exist. */
  const running = new Map()
  let inFlight = 0
  let shown = 0
  let failed = 0
  let lastFailure

  /**
   * Run the renderer once.
   *
   * @param payload - one toast description.
   * @returns whether the renderer exited successfully.
   */
  const run = (payload) => new Promise((resolve) => {
    const gated = focusPids !== undefined && config.quietWhenFocused === true
      ? { ...payload, skipWhenFocused: focusPids }
      : payload
    const encoded = Buffer.from(JSON.stringify(gated), 'utf8').toString('base64')
    const child = spawn(
      shell,
      [...config.shellArgs, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', renderer, '-PayloadB64', encoded],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stderr = ''
    let settled = false
    const finish = (ok, detail) => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      if (ok) shown += 1
      else {
        failed += 1
        lastFailure = detail
        // One line per distinct failure keeps a broken transport from filling the log.
        if (failed === 1 || failed % 25 === 0) log('warn', `toast failed (${String(failed)} so far): ${detail}`)
      }
      resolve(ok)
    }
    const guard = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* the process is already gone */
      }
      finish(false, 'renderer timed out')
    }, config.timeoutMs)
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => finish(false, errorText(error)))
    child.on('close', (code) => finish(code === 0, clip(stderr, 300) ?? `exit ${String(code)}`))
  })

  const pump = () => {
    while (inFlight < config.maxInFlight && queue.length > 0) {
      const next = queue.shift()
      inFlight += 1
      const attempt = run(next).finally(() => {
        inFlight -= 1
        running.delete(next.tag)
        pump()
      })
      running.set(next.tag, attempt)
    }
  }

  /**
   * Queue one toast.
   *
   * A toast whose tag is already waiting is replaced rather than queued: a burst
   * of errors from one session must collapse into one notification, and a later,
   * fresher line is the one worth showing.
   */
  const post = (toast) => {
    if (shell === undefined || config.enabled !== true) return
    const tag = toast.tag ?? toastTag('default', '')
    const entry = { ...toast, tag, group: toast.group ?? TOAST_GROUP }
    const waiting = queue.findIndex((queued) => queued.tag === tag)
    if (waiting === -1) queue.push(entry)
    else queue[waiting] = entry
    pump()
  }

  /**
   * Re-draw whichever toast is filed under a tag, after any in-flight draw of it
   * has finished. Two renders of one tag racing would let the older one land last.
   *
   * @param tag - the tag whose toast is being replaced.
   * @param entry - the replacement, carrying the same tag and group.
   */
  const redraw = (tag, entry) => {
    if (shell === undefined || config.enabled !== true) return
    const drawing = running.get(tag)
    if (drawing === undefined) post(entry)
    else void drawing.then(() => post(entry), () => post(entry))
  }

  /**
   * Retire a toast whose request has already been settled.
   *
   * A queued toast is simply dropped: it was never drawn, so there is nothing to
   * retire. One already drawn is re-drawn under the same tag and group, which is
   * the only mechanism an unpackaged process has -- Action Center replaces a
   * matching tag, while `ToastNotificationManager.History` is scoped to a package
   * identity this process does not have, so every `Remove` it offers fails.
   *
   * @param tag - the tag the original toast was posted under.
   * @param entry - the settled replacement.
   */
  const settle = (tag, entry) => {
    if (shell === undefined || config.enabled !== true) return
    const waiting = queue.findIndex((queued) => queued.tag === tag)
    if (waiting !== -1) {
      queue.splice(waiting, 1)
      return
    }
    redraw(tag, entry)
  }

  return {
    post,
    settle,
    redraw,
    available: shell !== undefined,
    report: () => ({
      shell: shell ?? null,
      shown,
      failed,
      queued: queue.length,
      inFlight,
      lastFailure: lastFailure ?? null,
    }),
  }
}

/**
 * Register the notification behaviour on the Host context.
 *
 * @param ctx - the plugin's Cordis context.
 * @param rawConfig - the row's `config` from `cordis.patch.yml`.
 */
export function apply(ctx, rawConfig) {
  trace(`apply start pid=${String(process.pid)} ppid=${String(process.ppid)} platform=${process.platform}`)
  try {
    applyInner(ctx, rawConfig)
    trace('apply finished: notifier and listeners are in place')
  } catch (error) {
    trace(`apply threw before finishing: ${errorText(error)}`)
    throw error
  }
}

/**
 * The activation body.
 *
 * Order matters: nothing that exists only for the settings page may run before the
 * listeners are registered. A settings declaration that throws aborts this function,
 * and an abort here leaves a plugin that reports `active`, opens its page, and
 * notifies nobody.
 *
 * @param ctx - the plugin's Cordis context.
 * @param rawConfig - the row's `config` from `cordis.patch.yml`.
 */
function applyInner(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  trace('config resolved')
  const messages = config.messages
  const log = (level, ...args) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-notify') : ctx.logger
      logger?.[level]?.(...args)
    } catch {
      /* logging must never break a notification */
    }
  }

  if (process.platform !== 'win32') {
    log('info', 'not a Windows host; dsh-notify stays inert')
    trace('inert: not a Windows host')
    return
  }

  log('info', Config === undefined
    ? `settings form unavailable (${errorText(configSchemaError)})`
    : `settings page available for entry ${SETTINGS_NAMESPACE}`)
  trace(`config schema ${Config === undefined ? 'unavailable' : 'built'}`)

  ensureAppId(config, log)
  trace('app id registration checked')
  const notifier = createNotifier(config, log)
  trace(`notifier ${notifier.available ? 'ready' : 'UNAVAILABLE (no toast transport)'}`)
  if (!notifier.available) return

  /**
   * Session context for a toast, so a notification raised by a background or
   * subagent session still says which session it was. Clicking a toast cannot
   * navigate to a session -- the Desktop shell's `second-instance` handler
   * discards the URI -- so the context has to travel on the toast itself.
   *
   * The map holds project directory names, learned from whatever the session
   * events carry; the session reference is derived from the id on demand.
   */
  const labels = new Map()
  const labelFor = (id) => composeLabel(labels.get(String(id ?? '')), id, messages.sessionPrefix)

  /** Learn one session's project directory; returns the id it was filed under. */
  const remember = (session) => {
    const id = session?.id ?? session?.header?.id
    if (id === undefined) return undefined
    const project = projectOf(session?.header?.cwd)
    if (project !== undefined) labels.set(String(id), project)
    return id
  }

  /** Toast buttons: bringing the Harness forward, and clearing the toast. */
  const actions = (blocking) => {
    const open = { content: messages.openApp, arguments: config.openUri, activationType: 'protocol' }
    const dismiss = { content: messages.dismiss, arguments: 'dismiss', activationType: 'system' }
    return blocking ? [open, dismiss] : [dismiss]
  }

  /**
   * Until when new notifications stay silent; `Infinity` until unmuted.
   *
   * A mute is a moment rather than a setting, which is why it is reachable from a
   * command instead of from the config: it has to start the instant a meeting does
   * and end when it ends.
   */
  let mutedUntil = 0
  const muted = () => mutedUntil > Date.now()

  /**
   * Handle `/notify`.
   *
   * @param rawInput - everything after the command name.
   * @returns a command result; `status` and `test` are also how a user checks the
   *   transport without waiting for a real event.
   */
  const handleCommand = (rawInput) => {
    const [action = 'status', argument] = String(rawInput ?? '').trim().split(/\s+/u)
    const reply = (text) => ({ kind: 'success', text })
    if (action === 'mute') {
      const minutes = argument === undefined ? 0 : Number(argument)
      if (!Number.isFinite(minutes) || minutes < 0) return { kind: 'error', text: messages.command.usage }
      mutedUntil = minutes === 0 ? Number.POSITIVE_INFINITY : Date.now() + minutes * 60_000
      return reply(minutes === 0
        ? messages.command.mutedForever
        : fill(messages.command.muted, { duration: formatDuration(minutes * 60_000) }))
    }
    if (action === 'unmute') {
      mutedUntil = 0
      return reply(messages.command.unmuted)
    }
    if (action === 'test') {
      notify('idle', {
        title: messages.selfTest.title,
        body: messages.selfTest.body,
        batch: false,
      })
      return reply(messages.command.testing)
    }
    if (action === 'status') {
      const remaining = Number.isFinite(mutedUntil) ? mutedUntil - Date.now() : Number.POSITIVE_INFINITY
      const state = muted()
        ? `${messages.command.stateMuted}${Number.isFinite(remaining) ? ` ${formatDuration(remaining)}` : ''}`
        : messages.command.stateLive
      return reply(`${state} · ${JSON.stringify(notifier.report())}`)
    }
    return { kind: 'error', text: messages.command.usage }
  }

  /**
   * Non-blocking notifications waiting out the aggregation window, by category.
   *
   * A burst of the same category usually has one cause, and five toasts describing
   * it are five interruptions. Batching draws one toast that names the count and
   * carries the freshest detail. An aggregated toast files under the category tag
   * rather than a session tag, so successive bursts replace one another instead of
   * stacking.
   */
  const buckets = new Map()

  /** Draw whatever a category has accumulated, if anything. */
  const flushBucket = (category) => {
    const bucket = buckets.get(category)
    if (bucket === undefined) return
    buckets.delete(category)
    const { count, entry } = bucket
    if (count === 1) {
      notifier.post(entry)
      return
    }
    notifier.post({
      ...entry,
      body: clip(
        fill(messages.aggregated.body, { count, body: entry.body ?? messages[category]?.fallback ?? '' }),
        240,
      ),
      tag: toastTag(category, ''),
    })
  }

  /**
   * Post one categorized notification.
   *
   * The footer carries the session context whenever a listener supplies one, so
   * every toast answers "which session is this?" without spending a body line.
   * An explicit `attribution` in the config outranks it.
   *
   * A non-blocking category may also be batched: see `buckets`. Blocking requests
   * never are -- something that needs an answer has to appear immediately.
   *
   * @param category - key into the sound, duration, and message tables.
   * @param fields - `title`, `body`, `label`, `tag`, `blocking`, plus `sound`,
   *   `duration`, `progress`, and `batch` overrides for callers whose urgency or
   *   lifetime differs from their category's.
   * @returns the tag this notification settles under.
   */
  const notify = (category, fields) => {
    const sound = fields.sound ?? config.sounds[category] ?? 'default'
    const duration = fields.duration ?? config.durations[category] ?? 'short'
    const tag = fields.tag ?? toastTag(category, '')
    const entry = {
      appId: config.appId,
      title: clip(fields.title, 120) ?? messages[category]?.title ?? 'DSH',
      body: clip(fields.body, 240) ?? messages[category]?.fallback,
      attribution: config.attribution ?? fields.label ?? messages.attribution,
      launch: config.openUri,
      duration,
      sound,
      buttons: actions(fields.blocking === true),
      tag,
      ...(fields.progress === undefined ? {} : { progress: fields.progress }),
    }

    // A mute silences new interruptions; it never blocks a redraw that corrects a
    // toast already on screen, which is why `settle` and `redraw` ignore it.
    if (muted()) return tag

    // A request that needs an answer now is never held back by the window.
    const batchable = fields.batch ?? (fields.blocking !== true)
    if (batchable && config.aggregateWindowSeconds > 0) {
      // Every notification refreshes the window, so a burst that keeps arriving
      // is summarised once it stops rather than repeatedly.
      const existing = buckets.get(category)
      if (existing !== undefined) clearTimeout(existing.timer)
      const timer = setTimeout(() => flushBucket(category), config.aggregateWindowSeconds * 1000)
      timer.unref?.()
      buckets.set(category, {
        count: (existing?.count ?? 0) + 1,
        // The freshest detail is the one worth showing; the count carries the rest.
        entry,
        timer,
      })
      return tag
    }

    notifier.post(entry)
    return tag
  }

  /**
   * Build the payload a blocking category re-draws under a given style.
   *
   * Approvals and questions differ only in copy, and "settled" and "escalated"
   * differ only in urgency, so one builder covers all four combinations and keeps
   * the tag that makes the redraw replace rather than accumulate.
   */
  const blockingEntry = (tag, category, label, style) => {
    const settled = style === 'settled'
    const what = category === 'question' ? messages.escalated.question : messages.escalated.approval
    const ask = category === 'question' ? messages.settled.question : messages.settled.approval
    return {
      appId: config.appId,
      title: settled ? messages.settled.title : messages.escalated.title,
      body: settled
        ? ask
        : fill(messages.escalated.body, { what, duration: formatDuration(config.escalateAfterSeconds * 1000) }),
      attribution: config.attribution ?? label ?? messages.attribution,
      launch: config.openUri,
      duration: settled ? 'short' : 'long',
      sound: settled ? 'silent' : config.escalateSound,
      buttons: actions(!settled),
      tag,
    }
  }

  /**
   * Wrap a waterfall delegation so the toast tracks the request's lifetime: an
   * unanswered request is nudged once after `escalateAfterSeconds`, and an
   * answered one is re-drawn as settled.
   *
   * `finally` rather than `then` on purpose: a rejected delegation must still
   * settle the notification, and the outcome value has to pass through untouched
   * either way. Nothing awaits the redraws.
   */
  const answered = (tag, category, label, next) => {
    const seconds = config.escalateAfterSeconds
    const timer = seconds > 0
      ? setTimeout(() => notifier.redraw(tag, blockingEntry(tag, category, label, 'escalated')), seconds * 1000)
      : undefined
    timer?.unref?.()
    return next().finally(() => {
      if (timer !== undefined) clearTimeout(timer)
      if (config.settleResolvedToasts) notifier.settle(tag, blockingEntry(tag, category, label, 'settled'))
    })
  }

  // ---- Blocking requests: the turn cannot continue without the user. ---------

  if (config.notifyOnApproval) {
    ctx.on('approval/request', (req, next) => {
      trace(`event approval/request tool=${String(req?.toolName)}`)
      const detail = req.displayReason?.zh ?? req.displayReason?.en ?? req.reason
      const label = labelFor(req.agent?.id)
      const tag = notify('approval', {
        title: messages.approval.title,
        body: detail ?? clip(req.toolName, 80) ?? messages.approval.fallback,
        label,
        tag: toastTag('approval', req.agent?.id),
        blocking: true,
      })
      // Not this listener's decision to make: delegation is mandatory.
      return answered(tag, 'approval', label, next)
    })
  }

  if (config.notifyOnQuestion) {
    ctx.on('user-questions/request', (request, next) => {
      trace(`event user-questions/request count=${String(request?.questions?.length ?? 0)}`)
      const first = Array.isArray(request?.questions) ? request.questions[0] : undefined
      const count = Array.isArray(request?.questions) ? request.questions.length : 0
      const extra = count > 1 ? fill(messages.question.more, { count }) ?? '' : ''
      const label = labelFor(request?.agent?.id)
      const tag = notify('question', {
        title: clip(first?.header, 60) ?? messages.question.title,
        body: `${clip(first?.question, 180) ?? messages.question.fallback}${extra}`,
        label,
        tag: toastTag('question', request?.agent?.id),
        blocking: true,
      })
      return answered(tag, 'question', label, next)
    })
  }

  // ---- Failures -------------------------------------------------------------

  if (config.notifyOnError) {
    ctx.on('agent/error', ({ agent, error }) => {
      notify('error', {
        title: messages.error.title,
        body: clip(errorText(error), 200) ?? messages.unknownError,
        label: labelFor(agent?.id),
        tag: toastTag('error', agent?.id),
      })
    })
    ctx.on('api-session/error', (sessionId, message) => {
      notify('error', {
        title: messages.error.title,
        body: clip(message, 200) ?? messages.unknownError,
        label: labelFor(sessionId),
        tag: toastTag('error', sessionId),
      })
    })
  }

  if (config.notifyOnAccount) {
    ctx.on('deepseek-account/model-sign-in-required', () => {
      notify('account', { title: messages.account.title, body: messages.account.signInRequired, tag: toastTag('account', '') })
    })
    ctx.on('deepseek-account/session-expired', () => {
      notify('account', { title: messages.account.title, body: messages.account.sessionExpired, tag: toastTag('account', '') })
    })
  }

  if (config.notifyOnWorkflowEnd) {
    ctx.on('workflow/end', (info, result) => {
      notify('workflow', {
        title: messages.workflow.title,
        body: fill(messages.workflow.body, {
          name: clip(info?.name ?? info?.runId, 60) ?? 'workflow',
          status: clip(result?.stopReason ?? result?.status, 40) ?? 'settled',
        }),
        tag: toastTag('workflow', ''),
      })
    })
  }

  // ---- Progress: is the work still moving? ----------------------------------

  /**
   * Per-agent progress bookkeeping.
   *
   * `status` mirrors `agent/status`; `lastActivityAt` is refreshed by anything
   * that proves the turn is alive; `runStartedAt` measures the run a completion
   * toast is gated on; `stalled` keeps one stall hint per silent stretch.
   */
  const agents = new Map()
  const stateOf = (id) => {
    const key = String(id)
    let state = agents.get(key)
    if (state === undefined) {
      state = {
        status: 'idle',
        lastActivityAt: Date.now(),
        runStartedAt: undefined,
        stalled: false,
        progressTimer: undefined,
        progressTick: undefined,
        progressShown: false,
      }
      agents.set(key, state)
    }
    return state
  }
  const touch = (id) => {
    const state = stateOf(id)
    state.lastActivityAt = Date.now()
    state.stalled = false
  }

  /** Whether a completion toast is wanted for this agent, given its ownership. */
  const wanted = (agent) => {
    if (config.includeSubagents) return true
    const registry = ctx.get('agents')
    if (registry === undefined || typeof registry.roots !== 'function') return true
    try {
      return registry.roots().some((root) => String(root?.id) === String(agent?.id))
    } catch {
      return true
    }
  }

  /** The module-level duration formatter bound to this activation's locale. */
  const formatDuration = (ms) => durationText(ms, messages.units)

  /**
   * A progress toast: one per session, refreshed under its own tag, silent.
   *
   * It carries an indeterminate `<progress>` bar because an agent turn has no
   * known completion fraction -- the honest signal is "still going", plus how
   * long it has been going.
   */
  const progressEntry = (id, elapsedMs, done) => {
    const label = labelFor(id)
    const elapsed = formatDuration(elapsedMs)
    return {
      appId: config.appId,
      title: done ? messages.progressDone.title : messages.progress.title,
      body: fill(done ? messages.progressDone.body : messages.progress.body, { label, duration: elapsed }),
      attribution: config.attribution ?? label,
      launch: config.openUri,
      duration: 'short',
      sound: 'silent',
      buttons: actions(false),
      tag: toastTag('progress', id),
      ...(done ? {} : { progress: { title: messages.progress.bar, status: elapsed } }),
    }
  }

  /** Stop a running turn's progress timers; the toast, if drawn, is left alone. */
  const clearProgress = (state) => {
    if (state.progressTimer !== undefined) clearTimeout(state.progressTimer)
    if (state.progressTick !== undefined) clearInterval(state.progressTick)
    state.progressTimer = undefined
    state.progressTick = undefined
  }

  /** Start reporting a turn's progress once it has run long enough to matter. */
  const armProgress = (id, state) => {
    clearProgress(state)
    if (!(config.progressAfterSeconds > 0)) return
    const tag = toastTag('progress', id)
    const draw = () => {
      if (muted()) return
      notifier.redraw(tag, progressEntry(id, Date.now() - state.runStartedAt, false))
    }
    state.progressTimer = setTimeout(() => {
      state.progressShown = true
      draw()
      // The refresh is also what makes the toast appear later: a draw suppressed
      // because the window was focused is retried on the next tick.
      state.progressTick = setInterval(draw, config.progressRefreshSeconds * 1000)
      state.progressTick.unref?.()
    }, config.progressAfterSeconds * 1000)
    state.progressTimer.unref?.()
  }

  /**
   * End a turn's progress report. A drawn toast cannot be deleted, only replaced,
   * so it is rewritten as finished rather than left claiming work is ongoing.
   */
  const retireProgress = (id, state, elapsedMs) => {
    const shown = state.progressShown === true
    clearProgress(state)
    state.progressShown = false
    if (shown) notifier.redraw(toastTag('progress', id), progressEntry(id, elapsedMs, true))
  }

  ctx.on('agent/created', ({ agent }) => {
    stateOf(agent?.id)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const state = agents.get(String(agent?.id))
    if (state !== undefined) clearProgress(state)
    agents.delete(String(agent?.id))
    labels.delete(String(agent?.id))
  })

  ctx.on('agent/status', ({ agent, status }) => {
    const state = stateOf(agent?.id)
    if (status === 'running') {
      state.status = 'running'
      state.runStartedAt = Date.now()
      state.lastActivityAt = Date.now()
      state.stalled = false
      armProgress(agent?.id, state)
      return
    }
    if (state.status !== 'running') {
      state.status = 'idle'
      return
    }
    const ran = state.runStartedAt === undefined ? 0 : Date.now() - state.runStartedAt
    state.status = 'idle'
    state.runStartedAt = undefined
    state.stalled = false
    retireProgress(agent?.id, state, ran)
    if (config.notifyOnIdle && ran >= config.minRunSeconds * 1000 && wanted(agent)) {
      const label = labelFor(agent?.id)
      notify('idle', {
        title: messages.idle.title,
        body: fill(messages.idle.body, { label, duration: formatDuration(ran) }),
        label,
        tag: toastTag('idle', agent?.id),
      })
    }
  })

  // Live tokens prove a model request is streaming; committed events prove a
  // step finished. A long tool call emits neither, which is what the stall hint
  // is allowed to report as "no observable progress" rather than as a failure.
  ctx.on('agent/assistant-stream', ({ agent }) => touch(agent?.id))
  // A session announcement is the earliest point its project directory is
  // knowable, so a request that arrives before any committed event still gets a
  // name on its toast.
  ctx.on('session/created', (session) => {
    remember(session)
  })
  ctx.on('session/event', (session) => {
    const id = remember(session)
    if (id !== undefined) touch(id)
  })

  if (config.notifyOnStall) {
    const period = Math.max(5, config.stallCheckSeconds) * 1000
    const timer = setInterval(() => {
      const now = Date.now()
      // Read per tick: `stallSeconds` is volatile, so a Settings edit applies to
      // the next sample rather than to the next restart.
      const threshold = config.stallSeconds * 1000
      for (const [id, state] of agents) {
        if (state.status !== 'running' || state.stalled) continue
        const silent = now - state.lastActivityAt
        if (silent < threshold) continue
        state.stalled = true
        const label = labelFor(id)
        notify('stall', {
          title: messages.stall.title,
          body: fill(messages.stall.body, { label, duration: formatDuration(silent) }),
          label,
          tag: toastTag('stall', id),
        })
      }
    }, period)
    timer.unref?.()
    ctx.effect(() => () => {
      clearInterval(timer)
    }, 'dsh-notify: stall watchdog')
  }

  // `/notify` is optional: a profile without the command registry keeps working,
  // and a name collision is reported rather than thrown.
  const commands = ctx.get('commands')
  if (commands !== undefined && typeof commands.register === 'function') {
    try {
      ctx.effect(() => commands.register({
        name: 'notify',
        description: messages.command.description,
        input: { hint: messages.command.hint },
        handler: ({ rawInput }) => handleCommand(rawInput),
      }), 'dsh-notify: /notify command')
    } catch (error) {
      log('warn', `could not register /notify: ${errorText(error)}`)
    }
  }

  // A pending aggregation window holds notifications that were never drawn, and
  // a running turn may hold a progress timer. Unloading drops the first rather
  // than drawing during teardown, and always clears both so an unloaded plugin
  // leaves no callback behind.
  ctx.effect(() => () => {
    for (const bucket of buckets.values()) clearTimeout(bucket.timer)
    buckets.clear()
    for (const state of agents.values()) clearProgress(state)
  }, 'dsh-notify: timers')

  if (config.selfTest) {
    const test = messages.selfTest
    setTimeout(() => {
      notify('idle', {
        title: test.title,
        body: `${test.body}（${JSON.stringify(notifier.report())}）`,
        tag: toastTag('idle', ''),
      })
    }, 1500).unref?.()
  }

  // Declared last, and guarded at both levels, because it exists only for the
  // Settings page: the Host's auto-generated form is switched off for this entry
  // since the browser half owns the page. Registering it through an optional child
  // keeps the plugin working in a profile that composes no Settings service at all.
  //
  // `ctx.inject` may run its callback later, so the inner guard is the one that
  // actually contains a failure. Both guards are load-bearing: an abort here would
  // leave every listener above already registered but the page policy undeclared,
  // which is the benign failure; the reverse order is not benign.
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['settings'], (child) => {
        try {
          child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
          trace('settings policy declared')
        } catch (error) {
          trace(`settings policy failed; notifications unaffected: ${errorText(error)}`)
        }
      })
    } catch (error) {
      trace(`settings declaration failed; notifications unaffected: ${errorText(error)}`)
    }
  }

  trace(`live: ${JSON.stringify(notifier.report())}`)
  log('info', `notifications active: ${JSON.stringify(notifier.report())}`)
}
