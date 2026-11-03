# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A **Recommended configuration** section in both READMEs, for the case the shipped
  policy leaves half-served: a long turn you walked away from. It names the smallest set
  of changes, the tradeoff behind each value, and the fact that a value set in the panel
  shadows the shipped default from then on.
- `skipped` in the transport report: toasts the focus gate suppressed, counted apart from
  `shown` and `failed` because they are neither. `delivery skipped-focused` joins the
  trace beside the other delivery decisions.
- A harness scenario that drives the focus-suppressed path, so the accounting cannot
  silently regress.

### Fixed

- A draw the focus gate suppressed exits 0 without drawing, and was being counted as
  shown. The report could therefore claim notifications that were deliberately skipped —
  the same class of confusion as a healthy-looking plugin that notifies nobody.

## [0.1.0] — 2026-11-03

First release. Windows 11 toast notifications for the DeepSeek Harness events that block
work, plus opt-in completion and stalled-progress hints.

### Added

- Toasts for approvals, questions, errors and account problems; opt-in completion,
  stalled-progress and workflow-end notifications.
- A title-bar-free footer naming the session that raised each toast
  (`<project> · <short id>`), because a click cannot navigate to it.
- Blocking toasts that stay in Action Center, are re-drawn as settled once answered, and
  can be nudged once with `escalateAfterSeconds`.
- `/notify mute | unmute | status | test`, and a silent self-test whose toasts are marked
  so they cannot be mistaken for a real event.
- A sidebar panel and a Plugins-row page over one shared component, backed by
  `.volatile()` settings that apply without a restart.
- A foreground-window gate proved at activation from the Host's process ancestry, failing
  open so it can never swallow a notification.
- Progress toasts with an indeterminate bar, and an aggregation window for bursts.
- An activation trace at `%TEMP%\dsh-notify-trace.log` recording every milestone, each
  listener entry, the raw configuration flags beside the flags actually in force, and
  every delivery decision (queued, dropped-settled, cooldown, spawn outcome).
- A notification-policy probe: the shell's global and per-app switch is read at activation
  and reported by `/notify status`, so "the system is muting this" is distinguishable from
  "the plugin never posted".
- `repeatGuardSeconds` so a failing turn cannot flash a banner on every retry.
- A distinct title for plan-review questions.
- Script-level tests for `lib/toast.ps1`, covering the readiness probe, the focus/policy
  answer, a missing title and a malformed payload.

### Fixed

- Volatile configuration was compared against its value instead of read through its
  reference, so every boolean read `false` and every number fell back to its default. The
  plugin looked correctly configured while registering no listener at all.
- The blocking-request observers are registered ahead of the answering listener: a
  waterfall ends when any listener claims the request, so an observer behind the browser
  UI never ran.
- The settings declaration moved behind listener registration, so a failure in it can no
  longer abort activation.
- Observation never fails the request it observes: both waterfall observers fall back to
  plain delegation and record the failure in the trace.
- The focus gate compares the foreground window against the process ancestry rather than
  assuming the parent owns the window, which stopped matching when a launcher began
  sitting between them.
- A toast tag is derived (`<category>-<hash>`) instead of built from a session id: Windows
  caps `Tag` and `Group` at 64 characters and throws before showing the toast.
- Stalled progress is suppressed while a tool call is in flight, counted from `tool/call`
  and `tool/result`, so a long command no longer looks stuck.

### Known limitations

- **Windows only.** The renderer needs the WinRT projection in Windows PowerShell 5.1;
  PowerShell 7 cannot build a toast because .NET Core dropped that projection.
- **No notification history.** `ToastNotificationManager.History` is scoped to a package
  identity and an unpackaged process has none. Action Center is the history.
- **A click cannot open the session that raised the toast.** The Desktop shell parses
  `dsh://` URIs into one action — raise the primary window — and discards the rest, so the
  session travels in the toast footer instead.
- **An instantly resolved request leaves no toast.** A request answered before the renderer
  starts is dropped rather than drawn, which is why auto-rejected approvals are silent.

[0.1.0]: https://github.com/u-fw/dsh-notify/releases/tag/v0.1.0
