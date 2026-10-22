# dsh-notify

English | [中文](README.zh.md)

Windows 11 native toast notifications for DeepSeek Harness.

Work keeps running while you are looking at something else. A turn that is
blocked on an approval, has died on an error, or has quietly stopped making
progress looks exactly like a turn that is still thinking. This plugin turns each
of those transitions into a Windows toast, and clicking a toast brings the DSH
window back to the front.

| Situation | Toast |
|---|---|
| A tool call waits for your approval | **DSH 需要你的授权** — the tool and its reason, with *打开 DSH* / *知道了* buttons |
| DSH asks you a structured question | **DSH 需要你的选择** — the question header and the question itself |
| A turn or a session fails | **DSH 出错了** — the error text |
| The account needs a sign-in | **DSH 账号需要处理** |
| A turn that ran longer than `minRunSeconds` finishes | **DSH 已完成** — how long it took |
| A running turn shows no progress for `stallSeconds` | **DSH 可能卡住了** — how long it has been silent |

Approvals and questions use a long-lived toast that stays in Action Center, so a
request you missed is still there when you come back.

The copy above is the shipped default (`locale: zh`). Set `locale: en` for English
toast text; the table is only illustrating which events raise a toast, not a required
language.

## Shipped policy: only what needs you

The defaults interrupt you for exactly one class of event — **work that is
blocked on you**: an approval, a question, an account that needs a sign-in, or a
failure. The last two rows of the table above are implemented and tested but
**off by default**:

```yaml
notifyOnIdle: false    # a long turn finished
notifyOnStall: false   # a running turn stopped showing progress
```

Turn both on if you would rather hear that a long turn *completed*, or that it
went quiet:

```yaml
notifyOnIdle: true
notifyOnStall: true
minRunSeconds: 20      # shorter turns stay silent
stallSeconds: 240      # silence before the "may be stuck" hint
```

A blocking toast can also be nudged once if nobody answers it:

```yaml
escalateAfterSeconds: 90   # 0 disables it, which is the default
```

The nudge re-draws the same toast with a `reminder` sound and a "仍未处理" title,
so Action Center still holds exactly one entry for that request rather than
accumulating reminders.

## Commands

```
/notify mute [分钟]   # 静音；不带分钟数则直到 unmute
/notify unmute
/notify status        # 静音状态 + 传输统计
/notify test          # 立刻发一条自检通知
```

A mute is a moment rather than a setting, which is why it is a command instead of
a config key: it has to start the instant a meeting does and end when it ends. A
mute stops new interruptions; it never blocks the redraw that retires a toast you
already answered, because leaving a stale one on screen is worse than the
interruption it would have caused.

`/notify test` and `/notify status` are also how you check the transport without
waiting for a real event to occur.

## Batching and progress

Two opt-in behaviours change *when* you are told things, so both are off by
default — the shipped policy is to tell you the moment something needs you.

```yaml
aggregateWindowSeconds: 20   # a burst becomes one toast naming the count
progressAfterSeconds: 120    # a long turn announces that it is still running
progressRefreshSeconds: 60   # ... and keeps the elapsed time current
```

A burst summarises into the category's tag, so successive bursts replace one
another instead of stacking, and the summary carries the freshest detail plus the
count. **Blocking requests never enter the window**: something that needs an
answer appears immediately, however many arrive at once.

The progress toast carries an indeterminate bar, because an agent turn has no
known completion fraction — the honest signal is "still going", plus how long.
It is silent, refreshes under its own tag, and is rewritten as *finished* when the
turn ends rather than being left claiming work is ongoing. Because the focus gate
applies to it too, a refresh suppressed while you were watching is retried on the
next tick, so the toast appears by the time you look away.

## Staying quiet while you are watching

A toast is suppressed while the DSH window owns the foreground, because a
notification about the thing already on your screen is noise. The check is asked
of Win32 directly (`GetForegroundWindow` + `GetWindowThreadProcessId`) by the same
PowerShell process that would draw the toast, so it costs no extra spawn.

It is built to fail **open**. A probe that answered "focused" to everything would
silently swallow every notification, which is the one failure this plugin must
never have, so the capability is proved once at activation: if the probe cannot
name a foreground pid, the gate is switched off and every toast is drawn
unconditionally. The plugin logs `focus gate on` or `focus gate off` with the
reason, and the probe is testable in both directions without drawing anything:

```powershell
# reports the foreground pid and whether each given pid matches it
$payload = @{ focusCheck = @{ pids = @(1234, 999999) } } | ConvertTo-Json -Compress
```

Set `quietWhenFocused: false` to be notified regardless of focus, or `focusPid` to
compare against something other than the Host's parent process.

## Action Center behaviour

An approval or question toast is re-drawn as **已处理 / Answered** once it has
been answered. An entry that keeps asking for a decision you already made is worse
than no entry at all.

The redraw is the only mechanism available. `ToastNotificationManager.History` is
scoped to the calling process's package identity, and the Host has none: from here
`GetHistory` reports an empty history and every `Remove` fails with
`0x80070490 Element not found`. That was established by probe rather than inferred
from the API surface — post a tagged toast, wait, then query the matching group.
What an unpackaged process *can* do is post a toast whose tag and group Action Center
already holds, which replaces it. So a settled request is retired by being re-drawn,
silent and brief, rather than by being deleted.

Two consequences worth knowing: the settled toast briefly re-appears as a banner,
and an **unanswered** toast is never removed — it stays until you act on it or
dismiss it. Set `settleResolvedToasts: false` to leave the original in place.

There is deliberately **no notification-history feature**. Reading or clearing
Action Center needs `ToastNotificationManager.History`, which is scoped to the
calling process's package identity; from an unpackaged Host `GetHistory` reports
nothing and `Remove` fails with `0x80070490`. Action Center itself is the history,
and a blocking toast uses `duration: long` precisely so it is still there when you
come back.

A tag is derived rather than embedded, because Windows caps both `Tag` and `Group`
at 64 characters and setting a longer one throws *before* the toast is shown — an
over-long tag loses the notification, not merely its identity. A session id is 44
characters on its own, so a tag is an 11-character `<category>-<hash>` pair: stable
per notification, distinct across sessions, and unable to outgrow the ceiling.

## What clicking a toast does

The toast body opens `openUri`, and the Desktop shell resolves that to exactly
one thing: **raising the primary window** — restored if minimized, recreated if it
was destroyed. It does **not** navigate to the session that raised the toast. The
shell wires `second-instance` to a zero-argument callback, so the command line
carrying the URI is discarded, and the only URI it recognises anywhere is
`dsh://open`. A toast raised by a background or subagent session therefore brings
you back to DSH, not to that session.

Landing on the exact session would need the Desktop shell to accept a
session-bearing deep link. No Host plugin can do it: the click arrives from
Windows, not from the renderer, so there is nothing for a plugin to intercept.

### Which session is asking

Because a click cannot navigate, every toast names its session in the footer:
`<project directory> · <first 8 characters of the session id>` — for example
`default-workspace · 97217b96`. A session whose project directory is not yet
known is named `会话 <id tail>` instead, so a raw 44-character session id never
reaches a toast. Windows already prints the application name above the toast from
the AUMID registration, which is why the footer is spent on this rather than
repeating it.

Set `attribution` to override the footer with fixed text.

## Install

The bundle installs into the current profile and survives restart:

```
plugin_manager  action: install_bundle  target: <this directory>
```

Then confirm the row is live:

```
cordis_inspect_query  provider: Config  method: listConfigs  input: { name: "dsh-notify" }
```

## The Windows registration it performs

A desktop application may only post toasts under an Application User Model ID the
shell recognises, and that takes two halves:

1. a Start Menu shortcut carrying the AUMID — **the DeepSeek Harness installer
   already writes this** (`com.deepseek.dsh`, visible as the shortcut's
   `System.AppUserModel.ID`), and
2. `HKCU\Software\Classes\AppUserModelId\com.deepseek.dsh` — **which nothing
   writes**, and without which `CreateToastNotifier` fails with
   `0x80073D54: The process has no package identity`.

On activation the plugin writes the missing half if it is absent, so the toast
carries the DeepSeek Harness name. The write is skipped whenever the recorded
values already agree, and it is per-user only.

The icon it records comes from `process.execPath`, which is the Desktop
application only when the Host runs under Electron. Started from a CLI, or from
`tools/verify-live.mjs`, that path is a node binary; the plugin then records no
icon at all rather than a wrong one, and Windows keeps using whatever the Start
Menu shortcut advertises. Set `iconUri` to pin it explicitly.

To undo the registration:

```powershell
Remove-Item 'HKCU:\Software\Classes\AppUserModelId\com.deepseek.dsh' -Recurse
```

Set `registerAppId: false` to opt out of the write entirely (toasts will then
fail unless you registered the AUMID yourself).

## Why Windows PowerShell, and not PowerShell 7

The plugin probes Windows PowerShell first and only then `pwsh`, on purpose:

- **PowerShell 7** runs on .NET (Core), which dropped the built-in WinRT type
  projection. `Windows.Data.Xml.Dom.XmlDocument` and `Windows.UI.Notifications.*`
  cannot be resolved there at all, so the toast cannot even be built.
- **Windows PowerShell 5.1** runs on .NET Framework, whose WinRT projection ships
  in the box. This is the PowerShell that can post a toast.

`shell: auto` runs the probe at activation and logs which one won. Point
`shell:` at an absolute `pwsh.exe` or `powershell.exe` to choose explicitly; a
probe that fails leaves the plugin inert with a logged reason rather than a
silently broken notifier.

## Settings

The plugin ships its own Settings page, contributed by a browser half. It appears in
**two places**, so the controls are reachable without opening Settings while the
Plugins row still carries its own configure entry:

- a **sidebar icon** (`sidebar.panellist`) that opens a **main-page panel** (`main`,
  keyed `dsh-notify`) — the same pairing the token-ledger plugin uses; and
- the **`plugins.row.config`** row inside Plugins, keyed `dsh-notify#dsh-notify`, the
  seat the Plugins page dispatches for one row of one bundle.

The two surfaces consume different contracts, which matters before editing either. The
Plugins row is *handed* a `ConfigPageForm` — `{ state, mutate }`, a state value and a
write — while the main-page panel has no owner, so it resolves the entry's scope
itself (`ctx.configForms.get`) and adapts it to the shape the row expects. Both render
the same component. `npm run lint` checks that the sidebar row and its panel share one
id (the shell refuses a key no `main` entry claims) and that both halves spell the
same settings namespace.

A `Config` schema alone does not produce a form. `dsh-settings` documents that
*forms expose only volatile fields*, that ordinary configuration stays file-only, and
that the auto-generated form has *no shipped client that consumes it*. Three things
make this page real:

- **`.volatile()` on the editable fields.** Only those are projected into a form.
  The matching live readers are the `VOLATILE_SPECS` table; `npm run lint` checks
  the two agree in both directions, because a declared-but-frozen field promises an
  edit that never lands and a live reader without the declaration is never offered.
- **`configure({ auto: false }, ctx.fiber)`**, declared through an optional
  `ctx.inject(['settings'], …)` child, so the Host does not also try to generate a
  page and the plugin still runs in a profile with no Settings service.
- **The browser half** (`lib/client.js` + the manifest's `dsh.client`), which owns
  the controls. It may not require a Harness Client package — the shared settings
  form was reimplemented from its behaviour instead — and it styles with
  `--dsw-alias-*` theme tokens only, which `npm run lint` also enforces.

Writes are immediate: one control, one edit, one `scope.mutate` carrying the
`revision` it read, so a stale write refuses rather than clobbers. The Host is the
only authority on acceptance, so the outcome is read back from the scope.

Fields the plugin reads at *use* time are editable live. Fields decided at
activation — `focusPid`, `stallCheckSeconds`, `maxInFlight`, `timeoutMs`,
`selfTest` — are marked **（需重载）** in the page and stay file-only, because
promising a live edit for them would be a lie.

Two things it depends on:

- **A restart is needed the first time**, and after any change to the Host half: the
  Host caches an ES module generation, so toggling the bundle re-applies the row's
  `config` but does not re-import the code. The browser half loads on a page
  refresh — the client-plugin HMR receiver only reloads it without one while
  `pnpm run dev:web` is running.
- **`@deepseek-ai/schemastery` resolving from this directory.** DSH's own copy
  lives inside the installation, which a `link:`-installed bundle cannot reach:
  Node resolves a linked package from its real path, and neither the profile's
  `node_modules` nor the installation is on that path. The package is therefore a
  real dependency, installed here. It is safe to hold a second copy in the
  process — schemastery registers its internals under `Symbol.for("schemastery")`
  and `globalThis.__schemastery_*`, which are process-global by design. If the
  import ever fails, the plugin logs `settings page unavailable` and keeps
  notifying: the page is never load-bearing.

## Configuration

Every key is optional. Edit them on the Settings page, or directly in the row's
`config` in `cordis.patch.yml` — the file remains the only way to set the
activation-time fields.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `appId` | `com.deepseek.dsh` | AUMID the toast posts under. |
| `displayName` | `DeepSeek Harness` | Name Windows shows above the toast. |
| `registerAppId` | `true` | Write the missing AUMID registry half. |
| `shell` | `auto` | `auto`, or an explicit PowerShell executable. |
| `shellArgs` | `[]` | Extra argv placed before `-File`. |
| `openUri` | `dsh://open` | Opened when a toast body is clicked. |
| `locale` | `zh` | Built-in message language: `zh` or `en`. |
| `attribution` | session context | Footer line under the body. Defaults to `<project> · <short session id>`; `tools/verify-live.mjs` relabels it so self-test toasts are unmistakable. |
| `iconUri` | DSH executable | Icon the AUMID advertises, as a `file://` URI. |
| `settleResolvedToasts` | `true` | Re-draw an answered approval/question toast as settled. |
| `escalateAfterSeconds` | `0` | Re-draw a blocking toast louder after this long unanswered. Off by default. |
| `escalateSound` | `reminder` | Sound the escalated redraw uses. |
| `quietWhenFocused` | `true` | Stay silent while the DSH window owns the foreground. |
| `focusPid` | the Host's parent | Process the focus gate compares against. |
| `aggregateWindowSeconds` | `0` | Collect a non-blocking burst this long into one summary toast. |
| `progressAfterSeconds` | `0` | Show a progress toast once a turn has run this long. |
| `progressRefreshSeconds` | `60` | How often that toast is refreshed. |
| `notifyOnApproval` | `true` | Approval requests. |
| `notifyOnQuestion` | `true` | Structured questions. |
| `notifyOnError` | `true` | `agent/error` and `api-session/error`. |
| `notifyOnAccount` | `true` | Sign-in required, session expired. |
| `notifyOnIdle` | `false` | A turn that ran long enough finished. Opt-in. |
| `notifyOnStall` | `false` | A running turn stopped showing progress. Opt-in. |
| `notifyOnWorkflowEnd` | `false` | A workflow run settled. |
| `includeSubagents` | `false` | Also notify for subagent sessions. |
| `minRunSeconds` | `20` | Shorter turns finish without a toast. |
| `stallSeconds` | `240` | Silence on a running turn before the stall hint. |
| `stallCheckSeconds` | `15` | Watchdog sampling period. |
| `sounds` | per category | `default`, `silent`, `alarm`, `im`, `mail`, `reminder`. |
| `durations` | per category | `short` or `long`. |
| `maxInFlight` | `3` | Concurrent toast processes; the rest queue. |
| `timeoutMs` | `15000` | A toast process outliving this is killed. |
| `selfTest` | `false` | Post one probe toast on activation. |

## What counts as progress

Only relevant while `notifyOnStall` is on. The watchdog treats three things as
proof that a turn is alive: live assistant tokens (`agent/assistant-stream`),
committed session events (`session/event`), and status transitions. A single long
tool call emits none of them, so the hint is worded as *no observable progress*
rather than as a failure. Raise `stallSeconds` above your longest legitimate tool
call or model wait to keep it quiet.

## Verifying a change

| Layer | Command | What it proves |
|---|---|---|
| Unit | `npm test` | Pure logic (`test/pure.test.mjs`): tags, labels, durations, config floors, live volatility, registry parsing |
| Render | `npm test` | The browser half renders (`test/client.test.mjs`): the module registers under its slot key, the page renders in real React without throwing, and every string resolves in both locales |
| Writes | `npm test` | The browser half edits (`test/client-dom.test.mjs`): in a real DOM, a control writes the op the scope expects — `{op:'set',path:[field],value}` or `{op:'unset'}` — carrying the revision it read, refusing an invalid draft, and reporting a write the Host declined |
| Consistency | `npm run lint` | The defaults, the settings schema, the volatile declarations, and the table above all describe the same keys; the page's styles use theme tokens only |
| Payloads | `npm run verify:dry` | Every listener fires and every toast is composed — with nothing shown |
| Delivery | `npm run verify:live` | The same through real PowerShell and Windows; every toast is labelled a self-test |

`npm run check` runs syntax, unit, render, lint, and dry payloads together. Live
delivery is deliberately separate, because it puts toasts on your desktop on
purpose.

The render layer exists because a machine without browser control cannot open the
page, and a component that throws blanks its slot entry with nothing but a console
line to show for it. It loads `lib/client.js` against a stand-in module loader,
drives the registered component through `react-dom/server`, and asserts the control
count, the values, the read-only state, and that no locale key is echoed back —
`translate` returns the key itself when a dictionary lacks it, so an unflattened key
would show up in the markup. Rendering this way needs `getServerSnapshot`, which the
component supplies.

The write layer is separate because rendering and editing fail independently: a
control that writes nothing looks identical from the outside. It mounts the page in
jsdom, dispatches real events, and asserts the *op* — shape, path, value, and the
`revision` read at edit time — rather than that a callback fired. It also covers the
two silent failure modes: an invalid draft must not be written at all, and a write
the Host declined must surface rather than disappear.

Two classes of defect appear only in the live layer: a tag over the 64-character
platform ceiling, and the resulting `Tag`-setting exception that loses the toast
outright. Dry mode replaces the renderer process, so anything Windows itself rejects
stays invisible to it — which is why the payload layer also asserts the platform's own
limits (`every tag and group fits the 64-character ceiling`).

## Troubleshooting

- **No toast at all.** Check Windows *Settings → System → Notifications*: notifications
  must be enabled, and Focus Assist must not be filtering them. Then read the
  activation trace below: it separates "never activated" from "activated and quiet".
- **`0x80073D54` in the log.** The AUMID registration is missing and
  `registerAppId` is `false`, or the Start Menu shortcut half is gone. Re-run the
  DeepSeek Harness installer if the shortcut is missing.
- **A toast appears but the click does nothing.** The click relies on the `dsh:`
  protocol handler installed by the Desktop app; check
  `HKCU\Software\Classes\dsh\shell\open\command`. Note that the shell deliberately
  does nothing while the app has not yet entered a workspace.
- **Too many notifications.** The shipped default is already the quiet policy;
  if you turned on `notifyOnIdle` or `notifyOnStall`, raise `minRunSeconds` or
  `stallSeconds`, or turn them back off.

## Why is it not notifying?

The failure mode of a notification plugin is silence, so activation is traced to
`%TEMP%\dsh-notify-trace.log` (`$TMPDIR` elsewhere). The trace is bounded, synchronous,
and cannot throw into the plugin.

| Last trace line | Meaning |
|---|---|
| none at all | the module never activated |
| stops before `apply finished` | activation stopped part-way; the last line names the milestone |
| `apply threw before finishing:` | the throw, with its message |
| `apply finished` but no `event …` lines | it is live and quiet — no matching event has arrived |
| `event user-questions/request` with no toast | the listener fires and the transport is dropping it |

Delete the file to start a clean record; it is not recreated until the next activation.

## License

MIT — see [LICENSE](LICENSE). The plugin is an independent bundle: it ships no
DeepSeek Harness code and depends only on `@deepseek-ai/schemastery`, which it resolves
from its own directory.
