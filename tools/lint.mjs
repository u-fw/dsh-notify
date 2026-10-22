// Consistency checks that a test suite cannot express.
//
// Three artifacts describe the same plugin -- the defaults in `lib/index.js`, the
// Settings schema built beside them, and the README table users read -- and they
// drift apart silently. This catches that drift, plus the packaging mistakes that
// only show up at install time.
//
//   node tools/lint.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Config, resolveConfig, SETTINGS_NAMESPACE, VOLATILE_SPECS } from '../lib/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail === undefined ? '' : `: ${detail}`}`)
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === undefined ? '' : `  — ${detail}`}`)
}

// ---- Manifest ---------------------------------------------------------------

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
for (const field of ['name', 'version', 'type', 'main', 'icon', 'meta']) {
  check(`package.json declares ${field}`, manifest[field] !== undefined)
}
check('the bundle points at its patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml')
check('the entry exists', readFileSync(join(root, manifest.main), 'utf8').length > 0)

// ---- Patch ------------------------------------------------------------------

const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
check('the patch inserts exactly one row', (patch.match(/^\s*-\s*id:/gmu) ?? []).length === 1, patch.match(/^\s*-\s*id:.*$/mu)?.[0]?.trim())
check('the row names this package', patch.includes(`name: ${manifest.name}`))

// ---- The three descriptions of the configuration ----------------------------

// A schemastery object schema exposes its declared properties as `dict`; the
// serialized form is a reference table, not a node tree, so it cannot be read back.
const declared = Object.keys(Config?.dict ?? {})
check('the Settings schema declares properties', declared.length > 0, `${String(declared.length)} keys`)

// Computed rather than declared: these are derived per activation, not read from
// the row, so they must NOT appear as schema properties.
const computed = new Set(['messages'])
const read = Object.keys(resolveConfig({})).filter((key) => !computed.has(key))

const undocumented = declared.filter((key) => !patch.includes(`${key}:`) && !readFileSync(join(root, 'README.md'), 'utf8').includes(`\`${key}\``))
check('every schema key appears in the README', undocumented.length === 0, undocumented.join(', '))

const undeclared = read.filter((key) => !declared.includes(key))
check('every key the plugin reads is declared in the schema', undeclared.length === 0, undeclared.join(', '))

// A volatile schema field is what a Settings page can edit; a live reader is what
// makes the edit take effect. Mismatched, one side silently does nothing: a
// declared-but-frozen field promises an edit that never lands, and a live reader
// without the declaration is never offered to the user.
const source = readFileSync(join(root, 'lib/index.js'), 'utf8')
const declaredVolatile = [...source.matchAll(/^\s+(\w+):\s*z\.[^\n]*?\.volatile\(\)/gmu)].map((match) => match[1])
const liveReaders = Object.keys(VOLATILE_SPECS)
check('the schema declares volatile fields', declaredVolatile.length > 0, declaredVolatile.join(', '))
check('every volatile field has a live reader',
  declaredVolatile.every((key) => liveReaders.includes(key)),
  declaredVolatile.filter((key) => !liveReaders.includes(key)).join(', '))
check('every live reader is declared volatile',
  liveReaders.every((key) => declaredVolatile.includes(key)),
  liveReaders.filter((key) => !declaredVolatile.includes(key)).join(', '))

// ---- Safety properties the platform enforces --------------------------------

check('the tag helper is imported where tags are built', readFileSync(join(root, 'lib/index.js'), 'utf8').includes('toastTag('))
check('the toast renderer ships beside the plugin', readFileSync(join(root, 'lib/toast.ps1'), 'utf8').includes('ToastNotificationManager'))

// ---- The browser half --------------------------------------------------------

const client = readFileSync(join(root, 'lib/client.js'), 'utf8')
check('the bundle declares a browser half', manifest.dsh?.client?.platform === 'web')
// Activation at boot rather than on first need: the Plugins page dispatches this
// page's slot by an arbitrary key, so nothing can know to wake the module first.
check('the browser half activates at boot', manifest.dsh?.client?.immediately === true)
check('the browser half is exported', manifest.exports['./client'] === './lib/client.js')

// A client module cannot import a Host module, so the row key is spelled twice:
// once here and once in the patch. If they drift, the owner dispatches a key nobody
// registered and the row silently gains no configure control.
const slotKey = /const SLOT_KEY = '([^']+)'/u.exec(client)?.[1]
const rowId = /^\s*-\s*id:\s*(\S+)/mu.exec(patch)?.[1]
check('the browser half targets this bundle\'s own row',
  slotKey === `${manifest.name}#${rowId}`, `key=${String(slotKey)} row=${String(rowId)}`)
// Code shape is judged with comments stripped: this file's own prose discusses these
// identifiers, and a check that cannot tell prose from code would fail on its own
// explanation.
const code = client.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')

check('the browser half registers into the row-configuration slot',
  code.includes("ctx.slots.inject('plugins.row.config'"))
// Two surfaces, two contracts: the Plugins row is handed a `ConfigPageForm` and must
// render from it, while the main-page panel has no owner and must read the scope.
check('the Plugins row renders from the owner-provided form',
  /function Page\(props\)\s*\{\s*const \{[^}]*\bform\b[^}]*\} = props/u.test(code)
    && /form\.mutate\(/u.test(code))
check('the main-page panel reads the configuration scope itself',
  /ctx\.configForms/u.test(code) && /SETTINGS_NS/u.test(code) && /scope\.mutate\(/u.test(code))

// A client module cannot import a Host module, so the namespace is spelled twice. If
// the copies drift, the panel reads a scope nobody serves and shows "unavailable".
const hostNamespace = SETTINGS_NAMESPACE
const clientNamespace = /const SETTINGS_NS = '([^']+)'/u.exec(code)?.[1]
check('both halves name the same settings namespace',
  clientNamespace !== undefined && clientNamespace === hostNamespace,
  `host=${hostNamespace} client=${String(clientNamespace)}`)

// The shell's sidebar button calls `selectPanel(id)` and the layout refuses a key no
// `main` entry claims, so a sidebar row without its panel is a broken click.
const panelId = /const PANEL_ID = '([^']+)'/u.exec(code)?.[1]
check('the sidebar row and its panel share one id',
  panelId !== undefined
    && code.includes('ctx.slots.inject(PANELLIST')
    && code.includes('ctx.slots.inject(MAIN')
    && /key: PANEL_ID/u.test(code)
    && /id: PANEL_ID/u.test(code),
  `PANEL_ID=${String(panelId)}`)

// Only theme tokens: a literal colour would ignore light/dark switching, which is
// the one styling rule a copied control is most likely to break.
const css = /const CSS = `([\s\S]*?)`/u.exec(client)?.[1] ?? ''
const literals = [...css.matchAll(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/giu)].map((match) => match[0])
check('the page styles use theme tokens only', literals.length === 0, literals.join(', '))
check('the page styles reference theme tokens', css.includes('--dsw-alias-'))

// `locale.translate` indexes a dictionary with the key as one literal property name,
// so a dotted path or an array index silently renders as the key itself. Every key
// the page asks for must therefore exist flat, and no call may look like a path.
const listOf = (name) => {
  const match = new RegExp(`const ${name} = \\[([^\\]]*)\\]`, 'u').exec(client)
  return match === null ? [] : [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1])
}
const fieldRows = [...listOf('TOGGLES'), ...listOf('NUMBERS')]
const copiedFields = (locale) => {
  const block = new RegExp(`\\b${locale}: \\{([\\s\\S]*?)\\n      \\}`, 'u').exec(
    /const FIELD_COPY = \{([\s\S]*?)\n    \}/u.exec(client)?.[1] ?? '',
  )
  return block === null ? [] : [...block[1].matchAll(/^\s{8}(\w+): \[/gmu)].map((entry) => entry[1])
}
for (const locale of ['en', 'zh']) {
  const missing = fieldRows.filter((field) => !copiedFields(locale).includes(field))
  check(`every control has ${locale} copy`, missing.length === 0, missing.join(', '))
}

const soundLabels = (locale) => {
  const block = new RegExp(`\\b${locale}: \\{([\\s\\S]*?)\\n      \\}`, 'u').exec(
    /const SOUND_COPY = \{([\s\S]*?)\n    \}/u.exec(client)?.[1] ?? '',
  )
  return block === null ? [] : [...block[1].matchAll(/(\w+): '/gu)].map((entry) => entry[1])
}
for (const locale of ['en', 'zh']) {
  const missing = listOf('CATEGORIES').filter((category) => !soundLabels(locale).includes(category))
  check(`every sound row has ${locale} copy`, missing.length === 0, missing.join(', '))
}

const pathLike = [...client.matchAll(/\bt\((['"`])([^'"`]*\.[0-9][^'"`]*)\1\)/gu)].map((match) => match[2])
check('no locale key is written as a path or index', pathLike.length === 0, pathLike.join(', '))

console.log(`\n${failures.length === 0 ? 'clean' : `${String(failures.length)} problem(s)`}`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(failures.length === 0 ? 0 : 1)
