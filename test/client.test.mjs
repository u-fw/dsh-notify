// Render the browser half in Node against a stand-in module loader and a fake
// settings form.
//
// This is as close to the connected page as a machine without browser control can
// get, and it targets exactly what has been unverifiable so far: that the module
// registers under the right slot key, that the page renders without throwing (a
// throwing component blanks its slot entry), and that every string it asks the
// locale service for actually resolves — `translate` echoes an unknown key back,
// so an unresolved label shows up as the key itself.
//
//   node --test
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---- A stand-in for the browser module table ---------------------------------

let definition
globalThis.window = {
  __ModuleLoader__: {
    load(loaded) {
      definition = loaded
    },
  },
}

/** The page may require `react` and nothing else; anything else would be a rule break. */
const required = []
const clientRequire = (name) => {
  required.push(name)
  if (name === 'react') return React
  throw new Error(`the page required an unexpected module: ${name}`)
}

await import('../lib/client.js')

const mod = definition.factory(clientRequire)

// ---- A stand-in for the consumer context -------------------------------------

const dictionaries = new Map()
const registrations = []
const injectedSlots = []
const servedNamespaces = []
const askedServices = []
const effects = []
let active = 'en'

const translate = (ns, key) => dictionaries.get(ns)?.[active]?.[key] ?? key

const ctx = {
  effect(factory, label) {
    effects.push({ label, dispose: factory() })
    return () => {}
  },
  locale: {
    // Bound before the dictionary is registered, exactly as the real service is:
    // the closure resolves lazily, so registration order does not matter.
    bind: (ns) => (key) => translate(ns, key),
    register(ns, copy) {
      dictionaries.set(ns, copy)
      return () => {}
    },
  },
  slots: {
    inject(name, callback) {
      injectedSlots.push(name)
      callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  // The main-page panel reads its own scope; the Plugins row never touches this.
  configForms: {
    get(namespace) {
      servedNamespaces.push(namespace)
      return undefined
    },
  },
  get(name) {
    askedServices.push(name)
    return undefined
  },
}

mod.apply(ctx)
const page = registrations[0]
const t = (key) => translate(page.options.locale, key)

/**
 * The `ConfigPageForm` the Plugins page hands an entry: a state value and a write.
 *
 * Deliberately *not* the scope underneath it — the page unwraps the scope to
 * `{ state, mutate }` before passing it on, and reading through the scope's own
 * `getSnapshot`/`subscribe` throws, which blanks the slot entry.
 */
const formWith = (snapshot, calls) => ({
  state: { status: 'ready', writable: true, revision: 7, ...snapshot },
  mutate: (ops, revision) => {
    calls?.push({ ops, revision })
    return Promise.resolve(true)
  },
})

const render = (props) => renderToStaticMarkup(React.createElement(page.component, { t, ...props }))

// ---- Module shape ------------------------------------------------------------

test('the module registers under its package id', () => {
  assert.equal(definition.id, 'dsh-notify')
})

test('the page injects only the services it uses', () => {
  // `configForms` serves the main-page panel only: that panel has no owner handing it
  // a form, so it resolves the entry's scope itself.
  assert.deepEqual(mod.inject, ['slots', 'locale', 'configForms'])
  assert.deepEqual(required, ['react'])
})

test('the page claims this bundle\'s own row', () => {
  assert.equal(page.options.name, 'plugins.row.config')
  assert.equal(page.options.key, 'dsh-notify#dsh-notify')
  assert.equal(page.options.locale, 'settings.dshNotify')
  assert.equal(page.options.label(), 'Desktop notifications')
})

// ---- Rendering ---------------------------------------------------------------

test('the summary view renders one line, not the form', () => {
  const html = render({ view: 'summary' })
  assert.match(html, /Windows toasts/u)
  assert.doesNotMatch(html, /dshn-switch/u)
})

test('an unserved form renders the unavailable line instead of crashing', () => {
  const html = render({ view: 'page', form: undefined })
  assert.match(html, /not serving this plugin/u)
})

test('the page renders every control with its current values', () => {
  const html = render({
    view: 'page',
    form: formWith({
      value: { notifyOnApproval: true, notifyOnIdle: false, minRunSeconds: 30, sounds: { error: 'alarm' } },
      user: { minRunSeconds: 30 },
    }),
  })

  assert.match(html, /Tool call waits for approval/u)
  assert.match(html, /role="switch"/u)
  assert.match(html, /aria-checked="true"/u)
  assert.match(html, /aria-checked="false"/u)
  assert.match(html, /value="30"/u)
  for (const sound of ['default', 'silent', 'im', 'mail', 'reminder', 'alarm']) {
    assert.match(html, new RegExp(`>${sound}</option>`, 'u'))
  }
  // One select per category, plus the six entry toggles, six numbers and two more
  // toggles: the page is complete rather than partially rendered.
  assert.equal((html.match(/<select/gu) ?? []).length, 7)
  assert.equal((html.match(/role="switch"/gu) ?? []).length, 10)
  assert.equal((html.match(/type="text"/gu) ?? []).length, 6)
})

test('an overridden field is marked and offers a reset', () => {
  const html = render({
    view: 'page',
    form: formWith({ value: { minRunSeconds: 30 }, user: { minRunSeconds: 30 } }),
  })
  assert.match(html, /Overridden/u)
  assert.match(html, /Reset to default/u)
})

test('a read-only deployment disables every control', () => {
  const html = render({
    view: 'page',
    form: formWith({ writable: false, value: {}, user: {} }),
  })
  assert.match(html, /read-only/u)
  assert.doesNotMatch(html, /aria-checked="true"/u)
  assert.equal((html.match(/disabled=""/gu) ?? []).length > 0, true)
})

test('every string resolves in both locales', () => {
  // `translate` returns the key itself when a dictionary lacks it, so a dotted or
  // nested key that never got flattened shows up here as the key in the markup.
  for (const locale of ['en', 'zh']) {
    active = locale
    const html = render({
      view: 'page',
      form: formWith({ value: {}, user: { minRunSeconds: 0 } }),
    })
    assert.doesNotMatch(html, /\.label|\.hint/u, `${locale} left a locale key unresolved`)
    assert.doesNotMatch(html, /dshn-(?:row|group)">[a-z]+\.[a-z]/u, `${locale} echoed a key`)
    // The title is the one string every locale must carry.
    assert.equal(page.options.label().length > 0, true)
  }
  active = 'en'
})

test('the page styles are emitted with the markup', () => {
  const html = render({ view: 'page', form: formWith({ value: {}, user: {} }) })
  assert.match(html, /<style>/u)
  assert.match(html, /--dsw-alias-brand-primary/u)
})

// ---- The main-page surfaces -------------------------------------------------

/** A settings scope, the shape `ctx.configForms.get` returns. */
const scopeWith = (snapshot) => ({
  getSnapshot: () => ({ status: 'ready', writable: true, revision: 3, value: {}, user: {}, ...snapshot }),
  subscribe: () => () => {},
  mutate: () => Promise.resolve(true),
})

test('the sidebar row and its panel are registered together', () => {
  // The shell's row button calls `selectPanel(id)` and the layout refuses a key that
  // no `main` entry claims, so one without the other is a broken click.
  assert.deepEqual(injectedSlots, ['plugins.row.config', 'main', 'sidebar.panellist'])

  const row = registrations[0].options
  const panel = registrations[1].options
  const icon = registrations[2].options

  assert.equal(row.name, 'plugins.row.config')
  assert.equal(panel.name, 'main')
  assert.equal(panel.key, 'dsh-notify')
  assert.equal(icon.name, 'sidebar.panellist')
  assert.equal(icon.id, 'dsh-notify')
  // The panel reads this entry's scope; the drift lint checks the same literal.
  assert.deepEqual(servedNamespaces, ['dsh-notify'])
})

test('the main-page panel renders the same controls without an owner-supplied form', () => {
  const Panel = registrations[1].component
  const html = renderToStaticMarkup(React.createElement(Panel, {
    t,
    scope: scopeWith({ value: { notifyOnApproval: true, minRunSeconds: 25 }, user: {} }),
    onClose: () => {},
  }))

  assert.match(html, /dshn-panelTitle/u)
  assert.match(html, /Desktop notifications/u)
  assert.match(html, /Close/u)
  assert.match(html, /Tool call waits for approval/u)
  assert.match(html, /value="25"/u)
  assert.equal((html.match(/role="switch"/gu) ?? []).length, 10)
})

test('the main-page panel reports an unserved namespace instead of crashing', () => {
  const Panel = registrations[1].component
  const html = renderToStaticMarkup(React.createElement(Panel, { t, scope: undefined, onClose: () => {} }))
  assert.match(html, /not serving this plugin/u)
})

test('the sidebar icon is a self-contained svg', () => {
  const Icon = registrations[2].component
  const html = renderToStaticMarkup(React.createElement(Icon, { size: 20 }))
  assert.match(html, /^<svg/u)
  assert.match(html, /width="20"/u)
  assert.match(html, /currentColor/u)
})
