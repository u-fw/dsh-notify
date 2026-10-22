// Browser half of dsh-notify: the plugin's configuration page.
//
// It registers into `plugins.row.config` keyed by `<package>#<row id>`, which is
// the slot the Plugins page dispatches for one row of one bundle — the row gains a
// configure control that opens this page.
//
// Two rules shape everything below. First, this file may not require a Harness
// Client package: `dsh.client.inject` entries only order activation, and a plain-JS
// plugin has no type check, so a throwing component would blank the slot entry.
// The shared settings form was therefore reimplemented here from its behaviour, and
// the controls are hand-written. Second, styling uses only `--dsw-alias-*` theme
// tokens, which the host flips between light and dark, so nothing here is
// hard-coded per theme.
//
// Writes go straight to the scope on change rather than through a staged form: one
// control, one edit, one write, with the outcome shown inline. The Host is the only
// authority on whether a value was accepted, so the result is read back from the
// scope instead of predicted here.
window.__ModuleLoader__.load({
  id: 'dsh-notify',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /**
     * Slot key for this bundle's row: package name, then the row id its patch
     * declares. This is the one identifier the page cannot be told, because the
     * owner dispatches by it.
     */
    const SLOT_KEY = 'dsh-notify#dsh-notify'

    /**
     * The settings namespace, spelled as a literal because a client module cannot
     * import a Host module; `tools/lint.mjs` checks it against the Host half's copy.
     *
     * The Plugins row never needs it — the owner hands a form down — but the
     * main-page panel has no owner to do that, so it reads the entry's scope itself.
     */
    const SETTINGS_NS = 'dsh-notify'

    /** Sidebar row id, and the `main` key the shell selects for it. */
    const PANEL_ID = 'dsh-notify'

    /** Sidebar icon rail: one global panel entry per id. */
    const PANELLIST = 'sidebar.panellist'

    /** Central panel, keyed by the sidebar entry id the shell dispatches. */
    const MAIN = 'main'

    /** Dictionary namespace owned by this page. */
    const DICT = 'settings.dshNotify'

    /** Every sound Windows accepts for a toast, plus silence. */
    const SOUNDS = ['default', 'silent', 'im', 'mail', 'reminder', 'alarm']

    /** Categories whose sound is separately configurable. */
    const CATEGORIES = ['approval', 'question', 'error', 'account', 'idle', 'stall', 'workflow']

    /** The boolean gates, in page order. */
    const TOGGLES = [
      'notifyOnApproval',
      'notifyOnQuestion',
      'notifyOnError',
      'notifyOnAccount',
      'notifyOnIdle',
      'notifyOnStall',
      'notifyOnWorkflowEnd',
      'includeSubagents',
      'settleResolvedToasts',
      'quietWhenFocused',
    ]

    /** The numeric knobs, in page order. */
    const NUMBERS = [
      'minRunSeconds',
      'stallSeconds',
      'escalateAfterSeconds',
      'aggregateWindowSeconds',
      'progressAfterSeconds',
      'progressRefreshSeconds',
    ]

    /**
     * Page copy, in tables that are flattened before registration.
     *
     * `locale.translate` indexes a dictionary with the key as one literal property
     * name — it resolves no dotted path and no array index — so every string the
     * page asks for has to be registered under exactly one flat key. Nesting here
     * and flattening below keeps the tables readable without depending on that.
     */
    const SCALARS = {
      en: {
        title: 'Desktop notifications',
        summary: 'Approvals, questions, failures and stalled work as Windows toasts.',
        description: 'Which events interrupt you, how long they wait, and how they sound.',
        groupEvents: 'When to notify',
        groupTiming: 'Thresholds',
        groupSound: 'Sounds',
        groupBehaviour: 'Behaviour',
        unavailable: 'The Host is not serving this plugin\u2019s settings right now.',
        readOnly: 'This deployment stores settings read-only.',
        saveFailed: 'The Host did not accept that value.',
        reset: 'Reset to default',
        overridden: 'Overridden',
        close: 'Close',
        seconds: 's',
        soundsHint: 'Windows notification sounds only; a custom audio file is not supported by the platform.',
      },
      zh: {
        title: '桌面通知',
        summary: '授权、提问、报错与卡住的工作，以 Windows 通知提醒你。',
        description: '哪些事件打扰你、等多久、以及用什么声音。',
        groupEvents: '何时提醒',
        groupTiming: '阈值',
        groupSound: '音效',
        groupBehaviour: '行为',
        unavailable: '宿主当前没有提供本插件的设置。',
        readOnly: '本部署的设置是只读的。',
        saveFailed: '宿主没有接受这个值。',
        reset: '恢复默认',
        overridden: '已覆盖',
        close: '关闭',
        seconds: '秒',
        soundsHint: '只支持 Windows 内置通知音；平台不支持自定义音频文件。',
      },
    }

    /** Field copy: label then hint, per field name. */
    const FIELD_COPY = {
      en: {
        notifyOnApproval: ['Tool call waits for approval', 'A blocked tool call cannot continue without you.'],
        notifyOnQuestion: ['Question waits for your answer', 'A structured question is holding the turn open.'],
        notifyOnError: ['A turn or session failed', 'The message carries the error text.'],
        notifyOnAccount: ['The account needs attention', 'Sign-in required, or the session expired.'],
        notifyOnIdle: ['A long turn finished', 'Shorter turns stay silent; see the threshold below.'],
        notifyOnStall: ['A running turn stopped progressing', 'A hint only: one long tool call emits nothing observable.'],
        notifyOnWorkflowEnd: ['A workflow settled', ''],
        includeSubagents: ['Include subagent sessions', 'Off: only root agents raise completion toasts.'],
        settleResolvedToasts: ['Mark answered requests as settled', 'Re-draws the toast instead of leaving it asking for a decision you made.'],
        quietWhenFocused: ['Stay quiet while the DSH window is focused', 'A broken focus probe draws the toast rather than swallowing it.'],
        minRunSeconds: ['Minimum turn length', 'Turns shorter than this finish without a completion toast.'],
        stallSeconds: ['Silence before the stall hint', 'Raise it above your longest legitimate tool call.'],
        escalateAfterSeconds: ['Re-nudge an unanswered request', 'Zero disables it; the nudge re-draws the same toast, louder.'],
        aggregateWindowSeconds: ['Batch a burst for', 'Zero draws every notification immediately. Blocking requests never wait.'],
        progressAfterSeconds: ['Show progress after', 'Zero disables the progress toast entirely.'],
        progressRefreshSeconds: ['Refresh progress every', ''],
      },
      zh: {
        notifyOnApproval: ['工具调用等你授权', '被阻断的调用没有你就无法继续。'],
        notifyOnQuestion: ['提问等你回答', '有结构化问题正卡着这一轮。'],
        notifyOnError: ['回合或会话失败', '正文会带上错误内容。'],
        notifyOnAccount: ['账号需要处理', '需要登录，或登录已过期。'],
        notifyOnIdle: ['长任务跑完了', '短回合不会打扰；见下方阈值。'],
        notifyOnStall: ['运行中的回合没有进展', '只是提示：单次长工具调用不产生任何可观测活动。'],
        notifyOnWorkflowEnd: ['工作流已结束', ''],
        includeSubagents: ['包含子代理会话', '关闭时只有根代理会发完成通知。'],
        settleResolvedToasts: ['已答复的请求标记为已处理', '重画通知，而不是让它继续索要你已经做过的决定。'],
        quietWhenFocused: ['DSH 窗口在前台时不打扰', '焦点探测失效时会照常发通知，而不是吞掉。'],
        minRunSeconds: ['最短回合时长', '短于这个秒数的回合不报完成。'],
        stallSeconds: ['多久无进展就提示', '设得比最长正常工具调用更长。'],
        escalateAfterSeconds: ['未答复请求再提醒一次', '0 为关闭；再提醒会重画同一条通知，更醒目。'],
        aggregateWindowSeconds: ['突发合并窗口', '0 为逐条立即发送。阻断类永不等待。'],
        progressAfterSeconds: ['多久后显示进度', '0 为完全关闭进度通知。'],
        progressRefreshSeconds: ['进度刷新间隔', ''],
      },
    }

    /** Sound row labels, per category. */
    const SOUND_COPY = {
      en: {
        approval: 'Approval request', question: 'Question', error: 'Error', account: 'Account',
        idle: 'Turn finished', stall: 'No progress', workflow: 'Workflow finished',
      },
      zh: {
        approval: '授权请求', question: '提问', error: '报错', account: '账号',
        idle: '回合结束', stall: '无进展', workflow: '工作流结束',
      },
    }

    /** Flatten the tables into the two dictionaries the locale service stores. */
    function buildCopy() {
      const out = { en: {}, zh: {} }
      for (const locale of ['en', 'zh']) {
        Object.assign(out[locale], SCALARS[locale])
        for (const [field, pair] of Object.entries(FIELD_COPY[locale])) {
          out[locale][`${field}.label`] = pair[0]
          out[locale][`${field}.hint`] = pair[1]
        }
        for (const [category, text] of Object.entries(SOUND_COPY[locale])) {
          out[locale][`sound.${category}`] = text
        }
      }
      return out
    }

    /**
     * The Plugins page hands this entry a `ConfigPageForm`: exactly two members.
     *
     * `state` is a scope snapshot **value**, not a getter, and there is no
     * subscription — the page re-renders when the configuration observable moves and
     * recomputes `state` itself. Reading it through `getSnapshot`/`subscribe` (the
     * scope's own shape, one layer further down) throws, and a throwing component
     * blanks its slot entry with nothing but a console line to show for it.
     *
     * The snapshot carries the effective `value`, the `user` layer whose presence
     * marks a field overridden, whether the deployment is `writable`, and the
     * `revision` a write must quote so a stale one refuses rather than clobbers.
     */

    /** The state a page renders before any form is served. */
    const UNAVAILABLE = Object.freeze({ status: 'unavailable', writable: false, value: {}, user: {} })

    /** Rendered once per page; `dshn-` keeps every class inside this plugin. */
    const CSS = `
.dshn-root{display:flex;flex-direction:column;gap:18px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.dshn-lead{margin:0;color:var(--dsw-alias-label-secondary)}
.dshn-group{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dshn-group-title{padding:8px 12px;font-weight:600;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshn-row{display:flex;align-items:center;gap:16px;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l1)}
.dshn-row:first-of-type{border-top:none}
.dshn-text{flex:1 1 auto;min-width:0}
.dshn-label{display:flex;align-items:center;gap:6px}
.dshn-hint{color:var(--dsw-alias-label-secondary);font-size:12px}
.dshn-control{flex:0 0 auto;display:flex;align-items:center;gap:8px}
.dshn-badge{font-size:11px;padding:1px 6px;border-radius:999px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2)}
.dshn-reset{background:none;border:none;padding:0;font:inherit;font-size:12px;color:var(--dsw-alias-brand-primary);cursor:pointer}
.dshn-switch{position:relative;width:36px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;padding:0}
.dshn-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dshn-switch:disabled{opacity:.5;cursor:default}
.dshn-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:left .12s ease}
.dshn-switch[aria-checked="true"] .dshn-knob{left:18px}
.dshn-input,.dshn-select{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 8px;font:inherit;min-width:88px}
.dshn-input{width:88px}
.dshn-input:disabled,.dshn-select:disabled{opacity:.5}
.dshn-note{margin:0;color:var(--dsw-alias-label-secondary)}
.dshn-error{margin:0;color:var(--dsw-alias-state-error-primary)}
.dshn-unit{color:var(--dsw-alias-label-secondary);font-size:12px}
.dshn-panel{box-sizing:border-box;height:100%;overflow:auto;padding:20px clamp(16px,3vw,32px);color:var(--dsw-alias-label-primary)}
.dshn-panelHead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.dshn-panelTitle{font-size:16px;font-weight:600}
`

    /** One labelled control, with the override marker and its reset. */
    function Row(props) {
      const { t, field, label, hint, overridden, writable, onReset, children } = props
      return h('div', { className: 'dshn-row' },
        h('div', { className: 'dshn-text' },
          h('div', { className: 'dshn-label' },
            h('span', null, label),
            overridden ? h('span', { className: 'dshn-badge' }, t('overridden')) : null),
          hint ? h('div', { className: 'dshn-hint' }, hint) : null),
        h('div', { className: 'dshn-control' },
          children,
          overridden && writable
            ? h('button', { type: 'button', className: 'dshn-reset', onClick: () => onReset(field) }, t('reset'))
            : null))
    }

    /** A switch. `role="switch"` with `aria-checked` is the behaviour users rely on. */
    function Switch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked === true,
        'aria-label': props.label,
        disabled: props.disabled,
        className: 'dshn-switch',
        onClick: () => props.onChange(props.checked !== true),
      }, h('span', { className: 'dshn-knob' }))
    }

    /**
     * A number field that commits on blur or Enter.
     *
     * An empty field resets rather than writing nothing, so clearing the control is
     * the same gesture as pressing reset.
     */
    function NumberField(props) {
      const [text, setText] = React.useState('')
      const shown = props.value === undefined ? '' : String(props.value)
      const [editing, setEditing] = React.useState(false)
      const commit = () => {
        setEditing(false)
        const trimmed = text.trim()
        if (trimmed === '') {
          props.onReset(props.field)
          return
        }
        const parsed = Number(trimmed)
        if (!Number.isFinite(parsed)) {
          props.onInvalid()
          return
        }
        props.onChange(props.field, parsed)
      }
      return h('input', {
        type: 'text',
        inputMode: 'numeric',
        className: 'dshn-input',
        disabled: props.disabled,
        'aria-label': props.label,
        value: editing ? text : shown,
        onFocus: () => {
          setEditing(true)
          setText(shown)
        },
        onChange: (event) => setText(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            setEditing(false)
            event.currentTarget.blur()
          }
        },
      })
    }

    /** The page body. */
    function Page(props) {
      const { t, view, form } = props
      const [failed, setFailed] = React.useState(false)

      if (view === 'summary') return h('span', null, t('summary'))

      // Nothing to subscribe to: the owner re-renders this entry whenever the served
      // configuration moves, and hands a fresh `state` each time.
      const state = form?.state ?? UNAVAILABLE
      if (form === undefined || state.status !== 'ready') {
        return h('p', { className: 'dshn-note' }, t('unavailable'))
      }

      const disabled = state.writable !== true
      const value = state.value ?? {}
      const user = state.user ?? {}
      const sounds = value.sounds ?? {}
      const overridden = (field) => Object.hasOwn(user, field)

      const run = (promise) => {
        Promise.resolve(promise).then(
          (landed) => setFailed(landed === false),
          () => setFailed(true),
        )
      }
      const write = (field, next) => run(form.mutate([{ op: 'set', path: [field], value: next }], state.revision))
      const reset = (field) => run(form.mutate([{ op: 'unset', path: [field] }], state.revision))
      const label = (field) => t(`${field}.label`)
      const hint = (field) => t(`${field}.hint`)

      const toggleRow = (field) => h(Row, {
        key: field, t, field,
        label: label(field), hint: hint(field),
        overridden: overridden(field), writable: state.writable, onReset: reset,
      }, h(Switch, {
        label: label(field),
        checked: value[field] === true,
        disabled,
        onChange: (next) => write(field, next),
      }))

      const numberRow = (field) => h(Row, {
        key: field, t, field,
        label: label(field), hint: hint(field),
        overridden: overridden(field), writable: state.writable, onReset: reset,
      }, [
        h(NumberField, {
          key: 'input', field, label: label(field), disabled,
          value: value[field], onChange: write, onReset: reset, onInvalid: () => setFailed(true),
        }),
        h('span', { key: 'unit', className: 'dshn-unit' }, t('seconds')),
      ])

      const soundRow = (category) => h(Row, {
        key: category, t, field: 'sounds',
        label: t(`sound.${category}`), hint: '',
        overridden: overridden('sounds'), writable: state.writable, onReset: reset,
      }, h('select', {
        className: 'dshn-select',
        disabled,
        'aria-label': t(`sound.${category}`),
        value: sounds[category] ?? 'default',
        onChange: (event) => write('sounds', { ...sounds, [category]: event.target.value }),
      }, SOUNDS.map((sound) => h('option', { key: sound, value: sound }, sound))))

      return h('div', { className: 'dshn-root' },
        h('style', null, CSS),
        h('p', { className: 'dshn-lead' }, t('description')),
        disabled ? h('p', { className: 'dshn-note' }, t('readOnly')) : null,
        failed ? h('p', { className: 'dshn-error' }, t('saveFailed')) : null,
        h('section', { className: 'dshn-group' },
          h('div', { className: 'dshn-group-title' }, t('groupEvents')),
          TOGGLES.slice(0, 8).map(toggleRow)),
        h('section', { className: 'dshn-group' },
          h('div', { className: 'dshn-group-title' }, t('groupTiming')),
          NUMBERS.map(numberRow)),
        h('section', { className: 'dshn-group' },
          h('div', { className: 'dshn-group-title' }, t('groupSound')),
          CATEGORIES.map(soundRow),
          h('p', { className: 'dshn-hint', style: { padding: '0 12px 10px' } }, t('soundsHint'))),
        h('section', { className: 'dshn-group' },
          h('div', { className: 'dshn-group-title' }, t('groupBehaviour')),
          TOGGLES.slice(8).map(toggleRow)),
      )
    }

    /**
     * A stable snapshot store over a settings scope.
     *
     * `getSnapshot` must keep returning the same object until the scope notifies, or
     * `useSyncExternalStore` re-renders forever.
     *
     * @param scope - `ctx.configForms.get(namespace)`, or undefined when unserved.
     * @returns the store plus a disposer.
     */
    function scopeStore(scope) {
      const read = () => {
        const snapshot = scope?.getSnapshot()
        return snapshot === undefined ? UNAVAILABLE : snapshot
      }
      let value = read()
      const listeners = new Set()
      const unsubscribe = scope === undefined ? () => {} : scope.subscribe(() => {
        value = read()
        for (const listener of [...listeners]) listener()
      })
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        dispose() {
          unsubscribe()
          listeners.clear()
        },
      }
    }

    /**
     * The main-page panel: the same controls as the Plugins row, reachable without
     * opening Settings at all.
     *
     * The Plugins row is handed a `ConfigPageForm`; nothing is handed in here, so the
     * panel reads the entry's scope itself and adapts it to the shape {@link Page}
     * already renders.
     */
    function Panel(props) {
      const { t, scope, onClose } = props
      const store = React.useMemo(() => scopeStore(scope), [scope])
      React.useEffect(() => () => store.dispose(), [store])
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      const form = React.useMemo(() => ({
        state,
        mutate: (ops, revision) => scope.mutate(ops, revision),
      }), [state, scope])

      return h('div', { className: 'dshn-panel' },
        h('div', { className: 'dshn-panelHead' },
          h('span', { className: 'dshn-panelTitle' }, t('title')),
          onClose ? h('button', { type: 'button', className: 'dshn-reset', onClick: onClose }, t('close')) : null),
        h(Page, { t, view: 'page', form }))
    }

    /** Sidebar icon: a bell, matching the bundle artwork. */
    function PanelIcon({ size }) {
      const edge = typeof size === 'number' ? size : 18
      return h('svg', {
        width: edge,
        height: edge,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('path', { key: 'bell', d: 'M6 9a6 6 0 1 1 12 0c0 3 1 4.5 2 5.5H4C5 13.5 6 12 6 9Z' }),
      h('path', { key: 'clapper', d: 'M10 18a2 2 0 0 0 4 0' }))
    }

    /**
     * Required services (cordis fiber inject).
     *
     * `configForms` serves the main-page panel only: the Plugins row gets its form
     * handed down and never touches the scope.
     */
    const inject = ['slots', 'locale', 'configForms']

    /**
     * Mount the configuration wherever it is wanted: the row inside Plugins, and a
     * sidebar row with its own panel so the controls are one click away.
     *
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(DICT)
      ctx.effect(() => ctx.locale.register(DICT, buildCopy()), 'dsh-notify: dictionaries')

      ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: SLOT_KEY,
        label: () => t('title'),
        locale: DICT,
      }, Page)), 'dsh-notify: settings page')

      // The sidebar row and the panel it opens share one id: the shell's row button
      // calls `selectPanel(id)` and the layout refuses a key no `main` entry claims,
      // so the pair has to be registered together.
      const scope = typeof ctx.configForms?.get === 'function' ? ctx.configForms.get(SETTINGS_NS) : undefined
      ctx.effect(() => ctx.slots.inject(MAIN, () => ctx.slots.register({
        name: MAIN,
        key: PANEL_ID,
        locale: DICT,
        // `layout` is read optionally rather than injected: a missing service would
        // leave this fiber pending, and a close button must not be able to stall boot.
        inject: () => ({ scope, onClose: () => ctx.get('layout')?.selectPanel(null) }),
      }, Panel)), 'dsh-notify: main panel')

      ctx.effect(() => ctx.slots.inject(PANELLIST, () => ctx.slots.register({
        name: PANELLIST,
        id: PANEL_ID,
        order: 62,
        label: () => t('title'),
        locale: DICT,
      }, PanelIcon)), 'dsh-notify: sidebar row')
    }

    return { apply, inject }
  },
})
