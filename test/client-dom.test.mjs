// Drive the settings page in a real DOM and assert what it writes.
//
// `test/client.test.mjs` proves the page renders; this proves it *edits*. That is
// the half the objective actually turns on — "changes land through the right
// mechanism" — and a control that renders perfectly while writing nothing looks
// identical from the outside.
//
// The scope's contract is small and exact: `mutate(ops, revision)` where revision is
// the one read at the time of the edit, so a stale write refuses rather than
// clobbers. Every assertion below checks the op shape and that revision, not merely
// that something was called.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document
// `navigator` is a getter-only global on modern Node, and Node's own is enough for
// React's feature checks — only `window` and `document` have to come from jsdom.
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// The module table the browser would provide, attached before the page loads.
let definition
dom.window.__ModuleLoader__ = {
  load(loaded) {
    definition = loaded
  },
}

const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
// React 18.3 moved `act` onto the React namespace; the react-dom re-export is
// deprecated and warns on every call.
const { act } = React

const clientRequire = (name) => {
  if (name === 'react') return React
  throw new Error(`the page required an unexpected module: ${name}`)
}

await import('../lib/client.js')
const mod = definition.factory(clientRequire)

// ---- Stand-ins ---------------------------------------------------------------

const dictionaries = new Map()
const registrations = []
const ctx = {
  effect: (factory) => {
    factory()
    return () => {}
  },
  locale: {
    bind: (ns) => (key) => dictionaries.get(ns)?.en?.[key] ?? key,
    register: (ns, copy) => {
      dictionaries.set(ns, copy)
      return () => {}
    },
  },
  slots: {
    inject: (_name, callback) => {
      callback()
      return () => {}
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

mod.apply(ctx)
const page = registrations[0]
const t = (key) => dictionaries.get(page.options.locale).en[key] ?? key

/**
 * The `ConfigPageForm` the Plugins page hands an entry.
 *
 * `state` is replaced by the test's `push` to act as the Host accepting a value. The
 * page has nothing to subscribe to, so it re-renders only when it is rendered again
 * — exactly as the real owner does when the served configuration moves.
 */
function makeForm(initial) {
  const calls = []
  const form = {
    state: { status: 'ready', writable: true, revision: 1, value: {}, user: {}, ...initial },
    landed: true,
    calls,
    mutate(ops, revision) {
      calls.push({ ops, revision })
      return Promise.resolve(form.landed)
    },
    /** Act as the Host: publish a new effective value for the next render. */
    push(next) {
      form.state = { ...form.state, ...next }
    },
  }
  return form
}

const mount = async (form) => {
  const container = dom.window.document.createElement('div')
  dom.window.document.body.append(container)
  const root = createRoot(container)
  const render = async () => {
    await act(async () => {
      root.render(React.createElement(page.component, { view: 'page', form, t }))
    })
  }
  await render()
  return { container, root, render }
}

const click = async (node) => {
  await act(async () => {
    node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}

/** Set a controlled input's value the way React notices. */
const type = async (input, text) => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setter.call(input, text)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}

/** React maps `onBlur` to the native `focusout`. */
const blur = async (input) => {
  await act(async () => {
    input.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }))
  })
}

const switchFor = (container, label) => container.querySelector(`[role="switch"][aria-label="${label}"]`)
const inputFor = (container, label) => container.querySelector(`input[aria-label="${label}"]`)
const selectFor = (container, label) => container.querySelector(`select[aria-label="${label}"]`)

// ---- Writes ------------------------------------------------------------------

test('flipping a switch writes that one field with the revision it read', async () => {
  const form = makeForm({ value: { notifyOnIdle: false } })
  const { container } = await mount(form)

  const toggle = switchFor(container, 'A long turn finished')
  assert.ok(toggle, 'the switch for notifyOnIdle is missing')
  assert.equal(toggle.getAttribute('aria-checked'), 'false')

  await click(toggle)

  assert.deepEqual(form.calls, [{
    ops: [{ op: 'set', path: ['notifyOnIdle'], value: true }],
    revision: 1,
  }])
})

test('a committed number writes a number, and an emptied one resets', async () => {
  const form = makeForm({ value: { minRunSeconds: 20 }, user: { minRunSeconds: 20 } })
  const { container } = await mount(form)

  const input = inputFor(container, 'Minimum turn length')
  assert.ok(input, 'the number field for minRunSeconds is missing')

  await type(input, '45')
  await blur(input)
  assert.deepEqual(form.calls[0], {
    ops: [{ op: 'set', path: ['minRunSeconds'], value: 45 }],
    revision: 1,
  })

  form.calls.length = 0
  await type(input, '')
  await blur(input)
  assert.deepEqual(form.calls[0], {
    ops: [{ op: 'unset', path: ['minRunSeconds'] }],
    revision: 1,
  })
})

test('a rejected number is never written', async () => {
  const form = makeForm({ value: { minRunSeconds: 20 } })
  const { container } = await mount(form)

  const input = inputFor(container, 'Minimum turn length')
  await type(input, 'soon')
  await blur(input)

  assert.deepEqual(form.calls, [])
  // The control falls back to the served value rather than holding the bad draft.
  assert.equal(input.value, '20')
})

test('choosing a sound rewrites the whole map, because that is what the field is', async () => {
  const form = makeForm({ value: { sounds: { error: 'im', idle: 'silent' } } })
  const { container } = await mount(form)

  const select = selectFor(container, 'Error')
  assert.ok(select, 'the sound select for the error category is missing')

  await act(async () => {
    select.value = 'alarm'
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })

  assert.deepEqual(form.calls[0]?.ops, [{
    op: 'set',
    path: ['sounds'],
    value: { error: 'alarm', idle: 'silent' },
  }])
})

test('resetting an overridden field unsets exactly it', async () => {
  const form = makeForm({ value: { notifyOnIdle: true }, user: { notifyOnIdle: true } })
  const { container } = await mount(form)

  const reset = [...container.querySelectorAll('button')]
    .find((node) => node.textContent === 'Reset to default')
  assert.ok(reset, 'an overridden field offers no reset')

  await click(reset)
  assert.deepEqual(form.calls[0]?.ops, [{ op: 'unset', path: ['notifyOnIdle'] }])
})

test('a refused write is reported instead of silently lost', async () => {
  const form = makeForm({ value: { notifyOnIdle: false } })
  form.landed = false
  const { container } = await mount(form)

  await click(switchFor(container, 'A long turn finished'))

  assert.match(container.textContent, /did not accept/u)
})

test('the page follows the Host when it publishes a new value', async () => {
  const form = makeForm({ value: { notifyOnIdle: false } })
  const { container, render } = await mount(form)

  // The page has nothing to subscribe to: the owner re-renders it with fresh state.
  form.push({ value: { notifyOnIdle: true }, user: { notifyOnIdle: true } })
  await render()

  assert.equal(switchFor(container, 'A long turn finished').getAttribute('aria-checked'), 'true')
  assert.match(container.textContent, /Overridden/u)
})

test('a read-only deployment writes nothing', async () => {
  const form = makeForm({ writable: false, value: { notifyOnIdle: false } })
  const { container } = await mount(form)

  const toggle = switchFor(container, 'A long turn finished')
  assert.equal(toggle.disabled, true)
  await click(toggle)
  assert.deepEqual(form.calls, [])
})
