# Contributing

Thanks for looking. This is a small, single-purpose plugin: it raises Windows toasts
for the DeepSeek Harness events that block work. Changes that widen that purpose need a
stronger case than changes that make it more reliable.

## Requirements

- **Windows 10 or 11.** The plugin is Windows-only by construction, not by preference:
  it posts toasts through the WinRT projection in Windows PowerShell, reads the
  foreground window through `user32.dll`, and writes one user-scoped registry key. The
  unit and render tests also assume Windows paths, so they fail on POSIX on purpose.
- **Node.js 22.15 or newer**, matching the engine the Harness itself requires.
- **PowerShell 5.1** (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`).
  PowerShell 7 is probed first and normally skipped — .NET Core dropped the WinRT
  projection, so it cannot build a toast at all.

## Getting started

```powershell
git clone https://github.com/u-fw/dsh-notify.git
cd dsh-notify
pnpm install          # React and jsdom are dev-only, for the render and DOM tests
npm run check         # syntax + unit + lint + dry payloads
```

## What the checks prove

Each layer answers a different question, and passing one says nothing about the next:

| Command | Question it answers |
|---|---|
| `npm test` | Does the pure logic behave, and does the browser half render and write? |
| `npm run lint` | Do the defaults, the settings schema, the live readers, and the README table still describe the same keys? |
| `npm run verify:dry` | Does every listener fire and compose the right payload — without showing anything? |
| `npm run verify:live` | Does a real toast actually appear on Windows? |

**`verify:live` puts real notifications on your desktop.** Every one of them carries the
footer `dsh-notify 自检 · 非真实故障` so it cannot be mistaken for a production event, and
it uses a fake session id (`session-verify-0001`) that no real log contains. Use
`verify:dry` while iterating; reach for the live pass only when the change touches the
renderer, the AUMID registration, or the tag derivation.

`npm run check` deliberately stops at the dry layer. Live delivery is a separate,
intentional act.

## Expectations for a change

- **Explain non-obvious constraints in the comment, not the commit message.** Several
  behaviours here exist because the platform forced them — the 64-character tag
  ceiling, the inability to remove a toast without a package identity, the WinRT
  projection gap. A future reader needs those reasons next to the code.
- **Prefer a measurement to an assumption.** The `README` documents which claims were
  established by probe. If you make a platform claim, show the probe or the source you
  read it from.
- **Keep a failure visible.** This plugin's failure mode is silence: it can report
  `active`, open its settings page, and notify nobody. Anything that can fail quietly
  should either be guarded or traced via `trace()`.
- **Do not require a Harness Client package from the browser half.** `dsh.client.inject`
  entries only order activation. A plain-JS plugin has no type check, and a throwing
  component blanks its slot entry, so the shared settings form is reimplemented here
  from its behaviour. Style with `--dsw-alias-*` theme tokens only; `npm run lint`
  enforces that no literal colour sneaks in.
- **Update the README when behaviour changes.** The configuration table, the verification
  table, and the troubleshooting section are part of the contract.

## Submitting

1. Run `npm run check` and make sure it is clean.
2. Add a test for the behaviour you changed. `test/pure.test.mjs` for logic,
   `test/client.test.mjs` for rendering, `test/client-dom.test.mjs` for writes.
3. Keep the commit message about the change, not the session that produced it.
4. Open a pull request describing the problem, not just the diff.

## Scope

In scope: correctness and clarity of the existing surfaces — toast content, when a toast
fires, the settings page, diagnostics.

Out of scope for this repository: other operating systems, a notification history
(the platform does not expose one to an unpackaged process), and per-session navigation
on click (the Desktop shell discards the URI; see the README).

## License

Contributions are accepted under the MIT license this project already uses; see
[LICENSE](LICENSE).
