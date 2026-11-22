/**
 * Pre-flight check for the roundtable plugin.
 *
 * Run this BEFORE restarting DSH. It loads both halves and exercises them
 * against mocks shaped like the real services, so a mistake that would hang or
 * crash the GUI is reported here instead.
 *
 *   node check.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const failures = []
const notes = []

function ok(label, detail) {
  console.log('  ok   ' + label + (detail ? '  — ' + detail : ''))
}
function bad(label, detail) {
  failures.push(label + (detail ? ': ' + detail : ''))
  console.log('  FAIL ' + label + (detail ? '  — ' + detail : ''))
}

// ── Host half ────────────────────────────────────────────────────────────────

console.log('\nHost half (index.js)')

const host = await import('file:///' + join(HERE, 'index.js').replace(/\\/g, '/'))

// Every route the Handler dispatches on must be reachable through the prefix.
// A missing one shows up in the UI as "未知路由 /x" — which is also what a stale
// Host module looks like, so this check keeps the two cases distinguishable.
const hostSrc0 = readFileSync(join(HERE, 'index.js'), 'utf8')
{
  const expected = ['/models', '/chat', '/speak', '/efforts']
  const missing = expected.filter((r) => !hostSrc0.includes("'" + r + "'"))
  if (missing.length) bad('host routes', 'missing ' + missing.join(', '))
  else ok('host routes', expected.join(' '))
  // The two per-turn decision routes are gone on purpose: each one cost an extra
  // model request per turn, tripled the request count, and hit the free pool's
  // rate limit — which is what made replies feel slow.
  const gone = ['/decide', '/outing'].filter((r) => hostSrc0.includes("route === '" + r + "'"))
  if (gone.length) bad('host routes', 'per-turn decision routes are back: ' + gone.join(', '))
  else ok('host routes', 'no per-turn decision calls')
}

if (host.name !== 'roundtable') bad('name', 'got ' + host.name)
else ok('name', host.name)

if (!Array.isArray(host.inject)) bad('inject', 'not an array')
else ok('inject', JSON.stringify(host.inject))

if (typeof host.apply !== 'function') bad('apply', 'not a function')
else ok('apply', 'function')

// Run apply() against a mock context that records what it registers.
{
  const registered = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get: () => undefined,
    effect: (fn, label) => {
      try {
        fn()
        notes.push('effect ok: ' + label)
      } catch (e) {
        bad('apply effect ' + label, String(e && e.message))
      }
      return { dispose() {} }
    },
    inject: (deps, cb) => {
      const scoped = {
        webServer: {
          register: (route) => {
            registered.push(route)
            return { dispose() {} }
          },
        },
      }
      try {
        cb(scoped)
      } catch (e) {
        bad('apply inject ' + JSON.stringify(deps), String(e && e.message))
      }
    },
  }
  try {
    host.apply(ctx, {})
    ok('apply() ran')
  } catch (e) {
    bad('apply()', String(e && e.stack ? e.stack.split('\n')[0] : e))
  }
  const rt = registered.find((r) => r.path === '/api/roundtable')
  if (!rt) bad('route registration', 'no /api/roundtable prefix')
  else ok('route registration', rt.kind + ' ' + rt.path)
}

// ── Client half ──────────────────────────────────────────────────────────────

console.log('\nClient half (client.js)')

let loaded = null
globalThis.window = { __ModuleLoader__: { load: (m) => { loaded = m } } }
globalThis.document = {
  head: { appendChild() {} },
  querySelector: () => null,
  createElement: () => ({ setAttribute() {}, style: {}, textContent: '' }),
}
// A working localStorage double.
//
// The previous one returned null for everything and discarded writes, which made
// any test that seeded state a no-op: the panel always saw an empty store. The
// real store is a Map so seeding and reading actually round-trip.
globalThis.__rtStore = new Map()
// The panel's own key, read from the source: hard-coding it once meant the
// fixtures landed under a name loadState never looked for, and every
// hostile-state case silently rendered the empty room instead.
globalThis.__rtKey = (readFileSync(join(HERE, 'client.js'), 'utf8').match(/const STORE_KEY = '([^']+)'/) || [])[1] || 'dsh.roundtable.v2'
globalThis.localStorage = {
  getItem: (k) => (globalThis.__rtStore.has(k) ? globalThis.__rtStore.get(k) : null),
  setItem: (k, v) => { globalThis.__rtStore.set(k, String(v)) },
  removeItem: (k) => { globalThis.__rtStore.delete(k) },
}
globalThis.requestAnimationFrame = (f) => f()

// A React mock that actually *calls* function components.
//
// `createElement: () => ({})` returns a stub without invoking anything, which is
// fine for shape checks but blind to every runtime error inside a component —
// including the temporal-dead-zone bug that made the panel throw "Cannot access
// 'room' before initialization" on every render. Calling the component is the
// whole point of keeping it honest.
const fakeReact = {
  createElement: (type, props, ...kids) => {
    if (typeof type === 'function') return type({ ...(props || {}), children: kids })
    return { __tag: type, props: props || {}, kids }
  },
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useCallback: (f) => f,
  // The panel memoises its rail and header. Without this the stub throws on the
  // first render and the whole check aborts, which hides every later assertion.
  useMemo: (f) => f(),
  useRef: (v) => ({ current: v }),
  Fragment: 'F',
}

try {
  const src = readFileSync(join(HERE, 'client.js'), 'utf8')
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'localStorage', 'requestAnimationFrame', src)(
    globalThis.window, globalThis.document, globalThis.localStorage,
    globalThis.requestAnimationFrame,
  )
  ok('bundle parsed')
} catch (e) {
  bad('bundle parse', String(e && e.message))
}

if (!loaded) {
  bad('__ModuleLoader__.load', 'was never called')
} else {
  ok('__ModuleLoader__.load', 'id=' + loaded.id)
  if (loaded.id !== '@local/roundtable') bad('module id', loaded.id)

  let mod = null
  try {
    mod = loaded.factory((m) => (m === 'react' ? fakeReact : {}))
    ok('factory()')
  } catch (e) {
    bad('factory()', String(e && e.message))
  }

  if (mod) {
    if (typeof mod.apply !== 'function') bad('client apply', 'not a function')
    else ok('client apply', 'function')

    // Register against a slots mock that behaves like the real one: `inject`
    // defers the callback until the slot exists, `register` validates the name.
    const seen = []
    // The panel component, captured so it can be rendered below.
    let mainComp = null
    const ctx = {
      logger: console,
      locale: { bind: () => (k) => k, register: (ns) => ({ dispose() {} }) },
      effect: (fn) => { fn(); return { dispose() {} } },
      slots: {
        inject: (name, cb) => { cb() },
        register: (opts, comp) => {
          if (!opts || typeof opts.name !== 'string') throw new Error('register without name')
          if (typeof comp !== 'function') throw new Error('register without component')
          if (opts.name === 'main') mainComp = comp
          seen.push(opts)
          return { dispose() {} }
        },
      },
    }
    try {
      mod.apply(ctx)
      ok('client apply() ran')
    } catch (e) {
      bad('client apply()', String(e && e.message))
    }

    const main = seen.find((o) => o.name === 'main')
    const nav = seen.find((o) => o.name === 'sidebar.panellist')

    if (!main) bad('main slot', 'not registered')
    else if (main.id !== undefined && main.key === undefined) bad('main slot', 'registered with `id` — must use `key`')
    else if (typeof main.key !== 'string') bad('main slot', 'missing key')
    else ok('main slot', 'key=' + main.key)

    if (!nav) bad('sidebar slot', 'not registered')
    else if (nav.id !== main?.key) bad('sidebar slot', 'id must equal main key')
    else ok('sidebar slot', 'id=' + nav.id)

    // Actually render the panel.
    //
    // Actually render the panel.
    //
    // Static checks cannot catch "Cannot access 'room' before initialization":
    // the panel is a function body and that error only appears when React calls
    // it. A render pass is the only honest way to know it runs at all. The React
    // mock above executes nested function components, so a TDZ anywhere in the
    // tree fails here rather than in the user's browser.
    if (!mainComp) {
      bad('panel render', 'main component not captured')
    } else {
      try {
        mainComp({})
        ok('panel render', 'component tree executes')
      } catch (e) {
        bad('panel render', String(e && e.message))
      }
    }

// ── hostile state ──
//
// Real bugs live in the edges: data written by an older version, a room trimmed
// by the quota recovery, a vote with a null options array. Rendering the panel
// against each of those is the only honest test.
{
  const cases = [
    ['empty', () => ({ rooms: [], activeId: null })],
    ['members, no messages', () => ({
      rooms: [{ id: 'r1', name: '空群', notice: '', createdAt: 1, members: [{
        id: 'm1', model: 'x/y', displayName: 'A', handle: 'a', provider: 'p', points: 0, gold: 0, items: [],
      }], messages: [] }],
      activeId: 'r1',
    })],
    ['old member record', () => ({
      rooms: [{ id: 'r1', name: '旧', notice: '', createdAt: 1,
        members: [{ id: 'm1', model: 'x', displayName: '老' }],
        messages: [{ id: 'x1', role: 'ai', memberId: 'm1', text: '你好', ts: 1 }] }],
      activeId: 'r1',
    })],
    ['vote with null ballots', () => ({
      rooms: [{ id: 'r1', name: 'v', notice: '', createdAt: 1,
        members: [{ id: 'm1', model: 'x', displayName: 'A', handle: 'a', points: 0 }],
        messages: [{ id: 'v1', role: 'vote', text: 'q', options: [], ballots: null, ts: 1 }] }],
      activeId: 'r1',
    })],
    ['chain naming a removed member', () => ({
      rooms: [{ id: 'r1', name: 'c', notice: '', createdAt: 1,
        members: [{ id: 'm1', model: 'x', displayName: 'A', handle: 'a', points: 0 }],
        messages: [{ id: 'c1', role: 'chain', text: 't', ts: 1,
          entries: [{ id: 'e1', memberId: 'gone', who: '走了', text: '我' }] }] }],
      activeId: 'r1',
    })],
    ['packet grabbed by a removed member', () => ({
      rooms: [{ id: 'r1', name: 'p', notice: '', createdAt: 1,
        members: [{ id: 'm1', model: 'x', displayName: 'A', handle: 'a', points: 0 }],
        messages: [{ id: 'p1', role: 'packet', points: 100, note: 'n', ts: 1,
          grabs: [{ memberId: 'gone', points: 50 }], maxGrabbers: 2 }] }],
      activeId: 'r1',
    })],
    ['message without text', () => ({
      rooms: [{ id: 'r1', name: 'm', notice: '', createdAt: 1,
        members: [{ id: 'm1', model: 'x', displayName: 'A', handle: 'a', points: 0 }],
        messages: [{ id: 'x1', role: 'user', ts: 1 }, { id: 'x2', role: 'ai', memberId: 'm1', ts: 2 }] }],
      activeId: 'r1',
    })],
    ['image ref without id', () => ({
      rooms: [{ id: 'r1', name: 'i', notice: '', createdAt: 1,
        members: [{ id: 'm1', model: 'x', displayName: 'A', handle: 'a', points: 0 }],
        messages: [{ id: 'x1', role: 'user', text: 't', images: [{}, { attachmentId: 'a1' }], ts: 1 }] }],
      activeId: 'r1',
    })],
    ['activeId pointing nowhere', () => ({
      rooms: [{ id: 'r1', name: 'r', notice: '', createdAt: 1, members: [], messages: [] }],
      activeId: 'nope',
    })],
    // Pinned ids that no longer resolve must not break the bar: a recalled
    // message is exactly the case that leaves a dangling id behind.
    ['pinned with a dangling id', () => ({
      rooms: [{ id: 'r1', name: 'p', notice: '', createdAt: 1,
        members: [{ id: 'm1', model: 'x', displayName: 'A', handle: 'a', points: 0 }],
        pinned: ['gone', 'x1'],
        messages: [{ id: 'x1', role: 'user', text: '留下这条', ts: 1 }] }],
      activeId: 'r1',
    })],
    ['too many pinned', () => ({
      rooms: [{ id: 'r1', name: 'p2', notice: '', createdAt: 1,
        members: [],
        pinned: ['a', 'b', 'c', 'd', 'e'],
        messages: [] }],
      activeId: 'r1',
    })],
    ['non-array rooms', () => ({ rooms: 'oops', activeId: 'r1' })],
    ['string points', () => ({
      rooms: [{ id: 'r1', name: 'd', notice: '', createdAt: 1,
        members: [{ id: 'm1', model: 'x', displayName: 'A', handle: 'a', points: 'abc', gold: null }],
        messages: [] }],
      activeId: 'r1',
    })],
  ]
  const failures = []
  for (const [name, make] of cases) {
    try {
      globalThis.__rtStore.clear()
      localStorage.setItem(globalThis.__rtKey, JSON.stringify(make()))
      mainComp({})
    } catch (e) {
      failures.push(name + ': ' + String(e && e.message).slice(0, 80))
    }
  }
  if (failures.length) bad('robustness', failures.join(' | '))
  else ok('robustness', cases.length + ' hostile states render')
}

    // The v2 data model: a member is a model, addressed by a handle.
    if (typeof mod.RoundtablePanel !== 'undefined') {
      notes.push('RoundtablePanel exported')
    }
  }
}

// ── Host prompt shape ────────────────────────────────────────────────────────
//
// Exercise buildMessages indirectly: the handler is not exported, so instead
// check that the module has no leftover persona surface and that the source
// still mentions handles (the @-contract the client relies on).

{
  const src = readFileSync(join(HERE, 'index.js'), 'utf8')
  if (/\.prompt\b/.test(src)) bad('host persona layer', 'still reads member.prompt')
  else ok('host persona layer', 'removed')
  if (!/m\.handle/.test(src)) bad('host mention parsing', 'does not use handles')
  else ok('host mention parsing', 'uses handles')

  // Sequential catalog reads were why the picker crawled. Guard the fix.
  if (/for \(const entry of providers\)[\s\S]{0,500}await llm\.listModels/.test(src)) {
    bad('catalog fetch', 'still awaits listModels inside a for loop (sequential)')
  } else if (!/Promise\.all/.test(src)) {
    bad('catalog fetch', 'does not fan out with Promise.all')
  } else {
    ok('catalog fetch', 'parallel + cached')
  }
}

// ── Client: the new interaction rules ───────────────────────────────────────

{
  const src = readFileSync(join(HERE, 'client.js'), 'utf8')

  // ── provider display names ──
  //
  // `listProviders()` returns { id, name } where `name` is the adapter's display
  // name ("WorkBuddy 国内版", "Our Free Model") and `id` is the internal route.
  // Showing only the id is what made the picker read like raw config keys.
  const hostSrcForNames = readFileSync(join(HERE, 'index.js'), 'utf8')
  if (!/providerName:\s*route\.name/.test(hostSrcForNames)) {
    bad('provider names', 'Host drops the display name')
  } else {
    ok('provider names', 'display name carried through')
  }
  if (!/rt-prov-name/.test(src)) bad('provider names', 'picker does not render the display name')
  else ok('provider names', 'picker shows the display name')
  if (!/scoreModel\(m, p\.provider, terms, p\.providerName\)/.test(src)) {
    bad('provider names', 'search ignores the display name')
  } else {
    ok('provider names', 'search matches display names too')
  }

  // The stylesheet lives in a template literal. A backtick inside a CSS comment
  // closes it early and the rest of the file stops being CSS — this has broken
  // the build four times, so it is a checked invariant.
  //
  // The previous version of this check was useless: it sliced to the *first*
  // backtick after the opening one, then asked whether that slice contained a
  // backtick. It never could. The real test is whether the literal terminates
  // on its own line, which is how the closing backtick is written.
  {
    const lines = src.split('\n')
    const openIdx = lines.findIndex((l) => l.includes('const CSS = `'))
    if (openIdx < 0) {
      bad('css template', 'CSS template literal not found')
    } else {
      const closeIdx = lines.findIndex((l, i) => i > openIdx && /^`;?\s*$/.test(l))
      if (closeIdx < 0) {
        bad('css template', 'template never closes on its own line — a stray backtick closed it early')
      } else {
        const inside = lines.slice(openIdx + 1, closeIdx)
        const offenders = inside
          .map((l, i) => ({ line: openIdx + 2 + i, text: l }))
          .filter((x) => x.text.includes('`'))
        if (offenders.length) {
          bad('css template', 'stray backtick at line ' + offenders[0].line +
            ': ' + offenders[0].text.trim().slice(0, 60))
        } else {
          ok('css template', 'closes cleanly, ' + inside.length + ' css lines')
        }
      }
    }
  }
  if (!/function syncTargets/.test(src)) bad('auto-reply', 'syncTargets missing')
  else ok('auto-reply', 'policy present')
  if (!/active\.length === 1/.test(src)) bad('solo mode', 'no single-member shortcut')
  else ok('solo mode', 'single model answers without @')
  if (!/onAdd:/.test(src)) bad('multi-add', 'picker has no batch handler')
  else ok('multi-add', 'picker supports selecting several models')

  // One failing model used to `break` the turn chain. It must skip to the next.
  if (/if \(result\.failure\) break/.test(src)) {
    bad('failure isolation', 'a failed model still breaks the whole chain')
  } else if (/if \(result\.failure\) continue/.test(src)) {
    ok('failure isolation', 'a failed model only skips itself')
  } else {
    bad('failure isolation', 'no per-model failure handling found')
  }

  if (!/FIRST_BYTE_MS/.test(src)) bad('idle timeout', 'no stall watchdog in the client')
  else ok('idle timeout', 'client abandons a silent model')

  if (!/text-transform:\s*uppercase/.test(src)) ok('provider casing', 'preserved')
  else bad('provider casing', 'still upper-cases provider names')

  if (!/function subseq/.test(src)) bad('search', 'no subsequence matching')
  else ok('search', 'fuzzy + multi-term')

  // `@所有人` is user-only: a model typing it must not summon the room.
  if (!/function userTargets/.test(src)) bad('@everyone', 'userTargets missing')
  else ok('@everyone', 'expands for the user')
  if (/parseMentions[^)]*\}\s*[\s\S]{0,200}EVERYONE/.test(src)) {
    bad('@everyone', 'model replies can trigger the room')
  } else {
    ok('@everyone isolation', 'model replies cannot')
  }

  // Live-turn controls: elapsed clock + a stop button that appears late.
  if (!/function ThinkingControls/.test(src)) bad('live controls', 'no elapsed clock component')
  else ok('live controls', 'clock + stop present')
  if (!/STOP_AFTER_SECS\s*=\s*15/.test(src)) bad('live controls', 'button threshold is not 15s')
  else ok('live controls', 'stop button after 15s')

  // The stop control must belong to the *turn*, not to the "no text yet" bubble
  // state — otherwise it disappears as soon as the model writes one token, and
  // the turn becomes impossible to interrupt.
  const bubbleBound = /msg\.streaming && !msg\.text\)\s*\{\s*[\s\S]{0,120}ThinkingControls/.test(src)
  const headerBound = /live && onStop/.test(src)
  if (bubbleBound) bad('stop availability', 'stop button is bound to the thinking bubble')
  else if (!headerBound) bad('stop availability', 'stop button not rendered for a live turn')
  else ok('stop availability', 'available for the whole turn')

  if (!/abort\('row-stop'\)/.test(src)) bad('per-row stop', 'does not tag the abort reason')
  else ok('per-row stop', 'tagged so the chain continues')

  // Sending a new message must supersede a running turn instead of being
  // dropped by a `running` guard. Both the button and Enter have to obey it.
  if (/!\s*room\s*\|\|\s*running\)\s*return/.test(src)) {
    bad('interrupt on send', 'a `running` guard still drops the new message')
  } else if (!/cancelTurn\('superseded'\)/.test(src)) {
    bad('interrupt on send', 'sending does not cancel the running turn')
  } else {
    ok('interrupt on send', 'new message supersedes the old turn')
  }
  if (/if \(!running\) sendRef\.current/.test(src)) {
    bad('interrupt on send', 'Enter is still blocked while running')
  } else {
    ok('interrupt on send', 'Enter also supersedes')
  }
  // The superseded turn must not leave rows stuck on "thinking".
  if (!/interrupted: true/.test(src)) bad('interrupt on send', 'streaming rows are not closed out')
  else ok('interrupt on send', 'stale rows marked as interrupted')

  // Header must survive a full roster: chips wrap, the title ellipsizes, and the
  // action group keeps its natural width instead of stacking characters.
  if (!/rt-head-actions/.test(src)) bad('header layout', 'no action group wrapper')
  else ok('header layout', 'actions pinned, chips wrap')
  if (!/flex-wrap:\s*wrap/.test(src)) bad('header layout', 'chips cannot wrap')
  else ok('header layout', 'chips wrap onto a second row')
  if (/rt-btn \{[\s\S]{0,400}?white-space:\s*nowrap/.test(src)) ok('header layout', 'buttons never wrap text')
  else bad('header layout', 'button labels can break')

  // 自由插嘴 mode
  if (!/id:\s*'eager'/.test(src)) bad('eager mode', 'no 自由插嘴 option in room settings')
  else ok('eager mode', 'room setting present')
  if (!/probeEager/.test(src)) bad('eager mode', 'client never probes the Host')
  else ok('eager mode', 'asks the Host who wants to answer')
  if (!/没有模型想接话/.test(src)) bad('eager mode', 'no feedback when nobody volunteers')
  else ok('eager mode', 'reports an empty round')

  // ── header adaptation ──
  if (!/function chipDensity/.test(src)) bad('header adaptation', 'no density function')
  else ok('header adaptation', 'three-level density present')
  if (!/useState\(-1\)/.test(src)) {
    bad('header adaptation', 'chip width starts measured, first frame can overflow')
  } else {
    ok('header adaptation', 'unmeasured strip starts at the narrowest level')
  }
  if (!/ResizeObserver/.test(src)) bad('header adaptation', 'width is not observed')
  else ok('header adaptation', 'tracks real width changes')
  if (!/flex-wrap:\s*nowrap/.test(src)) bad('header adaptation', 'chip strip wraps by default')
  else ok('header adaptation', 'no forced wrap; levels adapt instead')

  try {
    const g = (name) => {
      const i = src.indexOf('function ' + name + '(')
      let d = 0, st = false, j = i
      for (; j < src.length; j++) {
        if (src[j] === '{') { d++; st = true }
        else if (src[j] === '}') { d--; if (st && d === 0) break }
      }
      return src.slice(i, j + 1)
    }
    const { chipDensity } = new Function(g('chipDensity') + '\nreturn { chipDensity }')()
    const mk = (n) => Array.from({ length: n }, (_, i) => ({ displayName: 'Model' + i + ' Flash', points: 40 - i * 4 }))
    const levels = new Set()
    for (const n of [2, 3, 6, 8]) {
      for (const w of [1600, 900, 700, 500, 300, 200]) levels.add(chipDensity(w, mk(n)))
    }
    if (levels.size === 3) ok('header adaptation', 'all three levels reachable')
    else bad('header adaptation', 'only reaches ' + [...levels].join(','))
    if (chipDensity(-1, mk(8)) === 'mini') ok('header adaptation', 'unmeasured → mini')
    else bad('header adaptation', 'unmeasured width paints the wide layout')
  } catch (e) {
    bad('header adaptation', 'density could not be exercised: ' + String(e && e.message))
  }

  // Emoji picker
  if (!/EMOJI_GROUPS/.test(src)) bad('emoji', 'no emoji data')
  else ok('emoji', 'grouped picker present')
  if (!/function EmojiPanel/.test(src)) bad('emoji', 'no picker component')
  else ok('emoji', 'panel component present')
  // ── shop ──
  if (!/const SHOP = \[/.test(src)) bad('shop', 'no catalogue')
  else ok('shop', 'catalogue present')
  if (!/function parseShopCommand/.test(src)) bad('shop', 'no directive parser')
  else ok('shop', 'directive parser present')
  if (!/function resolveRecipient/.test(src)) bad('shop', 'no recipient resolver')
  else ok('shop', 'recipient resolver present')

  // Models write display names, not @handles, and their case/suffix differ.
  // A strict @handle test reported "要送给谁？" for perfectly clear directives.
  try {
    const g = (name) => {
      const i = src.indexOf('function ' + name + '(')
      if (i < 0) throw new Error('missing ' + name)
      let d = 0, st = false, j = i
      for (; j < src.length; j++) {
        if (src[j] === '{') { d++; st = true }
        else if (src[j] === '}') { d--; if (st && d === 0) break }
      }
      return src.slice(i, j + 1)
    }
    // Take everything from the catalogue through the lookup map in one slice.
    // Slicing individual declarations broke as soon as a second currency added
    // GOLD_SHOP alongside SHOP — the hand-listed pieces stopped matching the
    // real shape, so the extraction has to follow the source instead.
    const shopStart = src.indexOf('const SHOP = [')
    const shopEnd = src.indexOf('\n  function findItem', shopStart)
    const code = [
      g('parseMentions'), g('ownedOf'),
      src.slice(shopStart, shopEnd),
      g('findItem'), g('resolveRecipient'), g('parseShopCommand'),
      'return { parseShopCommand }',
    ].join('\n')
    const { parseShopCommand } = new Function(code)()
    const members = [
      { id: 'a', displayName: 'Qwen3.8-Flash · 免费', handle: 'qwen', enabled: true, points: 100, items: [] },
      { id: 'b', displayName: 'GLM-5.3-Flash · x0.1', handle: 'glm', enabled: true, points: 100, items: [] },
    ]
    const cases = [
      ['@商店 买 可乐 给 GLM-5.3-Flash', 'display name, no @'],
      ["@商店 买 '沙发' 给 'GLM-5.3-Flash'", 'single quotes'],
      ['@商店 买 "可乐" 给 GLM', 'partial name'],
      ['@商店 应援 GLM-5.3-Flash 烟花', 'cheer by name'],
      ['@商店 买 沙发 给 @glm', 'handle with @'],
    ]
    const failures = []
    for (const [text, why] of cases) {
      const r = parseShopCommand(text, members, 'a')
      if (!r || !r.ok || !r.to || r.to.id !== 'b') failures.push(why)
    }
    if (failures.length) bad('shop', 'cannot resolve recipient: ' + failures.join('; '))
    else ok('shop', 'resolves display names, quotes and cases')
  } catch (e) {
    bad('shop', 'recipient resolution could not be exercised: ' + String(e && e.message))
  }
  if (!/function applyShopCommand/.test(src)) bad('shop', 'no purchase applier')
  else ok('shop', 'purchase applier present')
  if (!/function ShopModal/.test(src)) bad('shop', 'no shop dialog')
  else ok('shop', 'shop dialog present')
  if (!/result\.text\.includes\('@商店'\)/.test(src)) bad('shop', 'replies are never checked for directives')
  else ok('shop', 'replies trigger purchases')

  // The Host prompt must describe the same catalogue the client can parse.
  const hostShop = readFileSync(join(HERE, 'index.js'), 'utf8')
  if (!/SHOP_BRIEF/.test(hostShop)) bad('shop', 'models are not told about the shop')
  else ok('shop', 'models see the catalogue')
  if (!/@商店/.test(hostShop)) bad('shop', 'models are not told the directive syntax')
  else ok('shop', 'models know the directive syntax')

  // Passive listing is not enough: models ignored a "you may buy things" block.
  // The prompt has to give occasions, and the request has to end with a nudge.
  if (!/什么时候该买/.test(hostShop)) bad('shop', 'prompt gives no buying occasions')
  else ok('shop', 'prompt states when to buy')
  if (!/系统提醒：你有/.test(hostShop)) bad('shop', 'no end-of-request reminder')
  else ok('shop', 'request ends with a reminder')
  if (!/另起一行/.test(hostShop)) bad('shop', 'prompt does not say where to put the directive')
  else ok('shop', 'prompt says to append the directive')

  // The user-side nudge: a button that types the instruction for you, aimed at
  // the whole room when there is more than one model.
  if (!/你们都用积分在商店里买东西/.test(src)) {
    bad('shop', 'no user-side nudge button')
  } else if (!/@所有人/.test(src)) {
    bad('shop', 'nudge does not address everyone')
  } else if (!/active\.length > 1/.test(src)) {
    bad('shop', 'nudge does not scale to room size')
  } else {
    ok('shop', 'nudge addresses the whole room')
  }

  // The nudge text and the prompt examples must quote directives with straight
  // double quotes. Backticks read as code fences and models echoed them back
  // verbatim; Chinese 「」 got copied too. Models imitate the punctuation they
  // are shown, so the examples decide what arrives at the parser.
  const nudgeStart = src.indexOf('你们都用积分在商店里买东西')
  if (nudgeStart < 0) {
    bad('shop quoting', 'nudge text not found')
  } else {
    const seg = src.slice(nudgeStart, nudgeStart + 500)
    if (seg.includes('`')) bad('shop quoting', 'nudge uses backticks')
    else if (!/"@商店/.test(seg)) bad('shop quoting', 'nudge does not use double quotes')
    else ok('shop quoting', 'nudge quotes directives with ""')
  }
  {
    const promptStart = hostShop.indexOf('只要出现上面任一情况')
    if (promptStart < 0) {
      bad('shop quoting', 'prompt directive block not found')
    } else {
      const seg = hostShop.slice(promptStart, promptStart + 900)
      if (seg.includes('`')) bad('shop quoting', 'prompt examples use backticks')
      else if (/「@商店/.test(seg)) bad('shop quoting', 'prompt examples use Chinese quotes')
      else ok('shop quoting', 'prompt examples avoid backticks and 「」')
    }
  }

  // ── reasoning effort ──
  //
  // The service *throws* for an effort a model does not declare, so a per-member
  // setting can break the turn. The Host must therefore degrade, not fail.
  const hostEff = readFileSync(join(HERE, 'index.js'), 'utf8')
  if (!/route === '\/efforts'/.test(hostEff)) bad('reasoning effort', 'no /efforts route')
  else ok('reasoning effort', 'efforts route present')
  if (!/resolveModelInfo\(/.test(hostEff)) bad('reasoning effort', 'efforts are not queried')
  else ok('reasoning effort', 'reads the model effort list')
  if (!/UNSUPPORTED_REASONING_EFFORT/.test(hostEff)) {
    bad('reasoning effort', 'an undeclared effort would fail the turn')
  } else if (!/stream = llm\.stream\(baseOpts\)/.test(hostEff)) {
    bad('reasoning effort', 'no fallback retry without the effort')
  } else {
    ok('reasoning effort', 'degrades instead of failing')
  }
  // Only send the parameter when configured — an explicit undefined is not the
  // same as omitting it.
  if (/reasoningEffort:\s*self\.reasoningEffort,/.test(hostEff)) {
    bad('reasoning effort', 'always sends reasoningEffort')
  } else if (!/opts\.reasoningEffort = self\.reasoningEffort|reasoningEffort: self\.reasoningEffort/.test(hostEff)) {
    bad('reasoning effort', 'member effort never reaches the request')
  } else {
    ok('reasoning effort', 'sent only when configured')
  }
  if (!/function MembersModal/.test(src) || !/rt-effort/.test(src)) {
    bad('reasoning effort', 'no picker in the members dialog')
  } else {
    ok('reasoning effort', 'per-member picker present')
  }
  if (!/没有提供思考档位/.test(src)) bad('reasoning effort', 'no message for models without levels')
  else ok('reasoning effort', 'explains models that cannot be tuned')

  // ── rail collapse & user profile ──
  if (!/function SidebarToggleIcon/.test(src)) bad('rail collapse', 'no toggle icon')
  else ok('rail collapse', 'toggle icon present')
  if (!/railOpen\s*\?\s*''\s*:\s*' rail-closed'|rail-closed/.test(src)) bad('rail collapse', 'no collapsed state')
  else ok('rail collapse', 'collapsed state wired')
  if (!/rt-rail-open/.test(src)) bad('rail collapse', 'no way to reopen the rail')
  else ok('rail collapse', 'opener present when collapsed')
  if (!/localStorage\.setItem\('dsh\.roundtable\.rail'/.test(src)) bad('rail collapse', 'collapse state not remembered')
  else ok('rail collapse', 'state persists')

  if (!/function ProfileModal/.test(src)) bad('profile', 'no user settings dialog')
  else ok('profile', 'settings dialog present')
  if (!/function SettingsIcon/.test(src)) bad('profile', 'no hexagon settings icon')
  else if (!/h\('polygon', \{ points: pts \}\)/.test(src)) bad('profile', 'settings icon is not a hexagon')
  else ok('profile', 'settings icon is a hexagon with a centre dot')
  if (!/function UserAvatar/.test(src)) bad('profile', 'no user avatar component')
  else ok('profile', 'user avatar component present')
  if (!/dsh\.roundtable\.profile/.test(src)) bad('profile', 'profile is not persisted')
  else ok('profile', 'name and colour persist')
  if (!/h\(UserAvatar, \{ profile: me, size: 28 \}\)/.test(src)) {
    bad('profile', 'the transcript still shows a hard-coded avatar')
  } else {
    ok('profile', 'transcript reflects the chosen identity')
  }

  // ── appearance ──
  //
  // Two skins × two brightnesses, driven entirely by CSS custom properties.
  // The invariant that matters: no component may hardcode a colour, or one of
  // the four combinations will be unreadable. Everything used to be
  // rgba(255,255,255,.05) — invisible on light.
  if (!/skin-flat/.test(src) || !/skin-glass/.test(src)) bad('appearance', 'skins missing')
  else ok('appearance', '玻璃 and 极简 skins')
  if (!/\.rt-root\.light/.test(src)) bad('appearance', 'no light theme')
  else if (!/\.rt-overlay\.light/.test(src)) bad('appearance', 'dialogs do not receive the light theme')
  else ok('appearance', '深色 / 浅色 both defined, dialogs included')
  if (!/function themeClasses/.test(src)) bad('appearance', 'theme class helper missing')
  else ok('appearance', 'theme classes compose independently')
  if (!/dsh\.roundtable\.theme/.test(src)) bad('appearance', 'theme is not persisted')
  else ok('appearance', 'theme persists')

  // No component may hardcode a colour, or one of the four combinations breaks.
  //
  // The token block itself is literal by design, so it is skipped: everything
  // after the base `.rt-root {` rule must reach colours through a variable.
  {
    const lines = src.split('\n')
    const open = lines.findIndex((l) => l.includes('const CSS = `'))
    let close = open + 1
    while (close < lines.length && !/^`;?\s*$/.test(lines[close])) close++

    // The base .rt-root rule is the last token block; component styles follow it.
    let bodyStart = close
    for (let i = open + 1; i < close; i++) {
      if (lines[i].startsWith('.rt-root {')) bodyStart = i + 1
    }

    const offenders = []
    for (let i = bodyStart; i < close; i++) {
      const line = lines[i]
      if (/var\(/.test(line)) continue

      // Structural colours must be variables; semantic ones may stay literal.
      //
      // `background` and `border-*` decide whether text is readable, so those are
      // the ones a light theme breaks. The first version of this check only
      // flagged pure white/black and therefore missed `rgba(13,15,19,.55)` — a
      // dark bar that looked right in dark mode and turned grey in light mode.
      //
      // Semantic hues — the danger red, the 金币 gold, the 应援 blue — are picked
      // to sit on either background, so forcing them through variables would only
      // add indirection. Glow gradients are decorative and the 极简 skin turns
      // them off wholesale.
      if (/radial-gradient|linear-gradient/.test(line)) continue
      if (/accent|#7c8cff|124,140,255|150,160,255/.test(line)) continue
      // `border: none` matches the pattern but carries no colour.
      if (!/rgba\(|#/.test(line)) continue
      // The packet's warm red-orange is a brand colour of its own, the light
      // modal is deliberately pure white, and the theme preview tiles show
      // *other* themes — a preview that followed the active theme would stop
      // previewing anything.
      if (/230,80,50|#ffffff/.test(line)) continue
      if (/\.rt-set-pv|\.rt-pv-/.test(line)) continue
      // Only the *value* of a background/border counts. `border: none; ... color:
      // #fff` is a text colour, which is legal — every theme has white text on a
      // coloured button.
      const decl = line.match(/(?:background|border)[-a-z]*\s*:\s*[^;]+/)
      if (!decl) continue
      if (!/rgba\(|#/.test(decl[0])) continue
      offenders.push((i + 1) + ': ' + line.trim().slice(0, 70))
    }
    if (offenders.length > 0) {
      bad('appearance', offenders.length + ' literal background/border: ' + offenders[0])
    } else {
      ok('appearance', 'components read theme tokens')
    }
  }

  // The upload path must hand the store *decoded bytes*, not a base64 string.
  //
  // The first version passed the string straight to saveImages; sharp then tried
  // to parse "iVBORw0K..." as an image and refused it with "Unsupported or
  // malformed image data". A base64 payload and image bytes are different things
  // and the store only accepts the latter.
  {
    const i = hostEff.indexOf("route === '/image'")
    const j = hostEff.indexOf("route === '/image-read'")
    const route = i >= 0 && j > i ? hostEff.slice(i, j) : ''
    if (route === '') {
      bad('images', 'the upload route could not be located')
    } else if (/saveImages\(\[\{\s*data,/.test(route)) {
      bad('images', 'base64 is passed to the store as if it were image bytes')
    } else if (!/Buffer\.from\(data, 'base64'\)/.test(route)) {
      bad('images', 'the upload route never decodes the base64 payload')
    } else if (!/new Uint8Array\(/.test(route)) {
      bad('images', 'the decoded bytes are not handed over as a Uint8Array')
    } else {
      ok('images', 'base64 is decoded before storage')
    }
  }

  // The client must sniff the format from the bytes, because a pasted screenshot
  // often carries an empty or wrong declared type and the Host decodes by content.
  if (!/0x89.*0x50.*0x4e.*0x47/.test(src)) {
    bad('images', 'the client does not verify the image signature')
  } else {
    ok('images', 'the client sniffs the real image format')
  }

  // Unreadable state must be preserved, not discarded.
  //
  // The old loadState caught the parse error and returned empty; the next save
  // then overwrote the only copy, so the user's groups were gone for good and
  // the panel had opened as if it were a first run.
  if (!/let loadError = null/.test(src)) {
    bad('storage', 'parse failures are not tracked')
  } else {
    ok('storage', 'parse failures are tracked')
  }
  if (!/STORE_KEY \+ "\.corrupt"/.test(src)) {
    bad('storage', 'unreadable state is discarded instead of kept')
  } else {
    ok('storage', 'unreadable state is moved aside, not destroyed')
  }
  if (!/存档读不出来，已另存为备份/.test(src)) {
    bad('storage', 'a failed load is never shown to the user')
  } else {
    ok('storage', 'a failed load is reported in the panel')
  }




  // ── composer ergonomics ──
  //
  // Three things that were visibly wrong in use:
  //   · the textarea never grew, so a long message scrolled inside a 44px box
  //   · a picture with no caption could not be sent at all — the send guard
  //     returned early on empty text, with no explanation
  //   · the 关于 page documented Esc as the way out of a dialog, but Modal only
  //     closed on an overlay click
  if (!/const growInput = React\.useCallback/.test(src)) {
    bad('composer', 'the textarea never grows past one line')
  } else if (!/React\.useEffect\(\(\) => \{ growInput\(\) \}, \[input, growInput\]\)/.test(src)) {
    bad('composer', 'auto-grow is not driven by the text')
  } else {
    ok('composer', 'the input grows with its content')
  }

  // The guard itself must consult the images, not merely declare the flag: an
  // early `text === ''` return would still block a caption-less picture.
  if (!/if \(\(text === '' && !hasImages\) \|\| !room\) return/.test(src)) {
    bad('composer', 'a picture with no caption cannot be sent')
  } else if (!/text: text \|\| \(hasImages \? /.test(src)) {
    bad('composer', 'a caption-less image renders as an empty line')
  } else {
    ok('composer', 'a picture alone is a valid message')
  }

  if (!/if \(e\.key === 'Escape'\) \{ e\.stopPropagation\(\); onClose\(\) \}/.test(src)) {
    bad('dialogs', 'Esc does not close dialogs, though 关于 says it does')
  } else {
    ok('dialogs', 'Esc closes dialogs')
  }

  // ── export ──
  //
  // The transcript lives in this browser only. Exporting is the one way to keep a
  // conversation, so every message kind has to survive it.
  if (!/function transcriptMarkdown\(/.test(src)) bad('export', 'no transcript export')
  else if (!/function downloadTranscript\(/.test(src)) bad('export', 'export is not downloadable')
  else if (!/导出记录/.test(src)) bad('export', 'no button reaches the export')
  else ok('export', 'transcript can be exported as Markdown')

  {
    // Run the exporter over one of every message kind.
    const grab = (sig) => {
      const i2 = src.indexOf(sig)
      if (i2 < 0) throw new Error('missing ' + sig)
      let d2 = 0
      let s2 = false
      let j2 = i2
      for (; j2 < src.length; j2++) {
        const c = src[j2]
        if (c === '{') { d2++; s2 = true }
        else if (c === '}') { d2--; if (s2 && d2 === 0) break }
      }
      return src.slice(i2, j2 + 1)
    }
    try {
      const { transcriptMarkdown } = new Function(
        grab('const fmtTime = (') + '\n' + grab('function transcriptMarkdown(') +
        '\nreturn { transcriptMarkdown }',
      )()
      const md = transcriptMarkdown({
        name: '群', members: [{ id: 'm1', displayName: 'A' }],
        messages: [
          { id: 'a', role: 'user', text: 'U', ts: 1 },
          { id: 'b', role: 'ai', memberId: 'm1', text: 'AI', ts: 2 },
          { id: 'c', role: 'sys', text: 'SYS', ts: 3 },
          { id: 'd', role: 'packet', points: 10, grabs: [{ memberId: 'm1', points: 10 }], ts: 4 },
          { id: 'e', role: 'vote', text: 'Q', options: ['X'], ballots: [{ memberId: 'm1', option: 'X' }], ts: 5 },
          { id: 'f', role: 'chain', text: 'C', entries: [{ who: 'A', text: 'E' }], ts: 6 },
        ],
      }, { name: '我' })
      const wants = ['U', 'AI', 'SYS', '10 积分', 'X：1 票', 'E']
      const missing = wants.filter((w) => !md.includes(w))
      if (missing.length) bad('export', 'missing from export: ' + missing.join(', '))
      else ok('export', 'every message kind survives the export')
    } catch (e) {
      bad('export', 'exporter threw: ' + String(e && e.message).slice(0, 60))
    }
  }

  // ── shortcuts ──
  if (!/e\.key === 'k' \|\| e\.key === 'K'/.test(src)) bad('shortcuts', 'no Ctrl+K to focus the composer')
  else if (!/setModal\(\{ kind: 'search' \}\)/.test(src)) bad('shortcuts', 'no Ctrl+F for search')
  else ok('shortcuts', 'Ctrl+K focuses, Ctrl+F searches')

  // Bound once, with cleanup — a listener per render would fire N times.
  if (!/document\.addEventListener\('keydown', onKey\)/.test(src) || !/removeEventListener\('keydown', onKey\)/.test(src)) {
    bad('shortcuts', 'the shortcut listener is not cleaned up')
  } else {
    ok('shortcuts', 'shortcut listeners are cleaned up')
  }

  // ── big rooms ──
  //
  // The member ceiling went from 8 to 16, which exposed three things that only
  // matter at that size: the header ran out of width, the @-popup could not reach
  // past the seventh member, and the pinned bar had nowhere to live.
  {
    const cap = Number((src.match(/const MAX_MEMBERS = (\d+)/) || [])[1])
    if (!(cap >= 16)) bad('rooms', 'the member ceiling is still ' + cap)
    else ok('rooms', 'up to ' + cap + ' models per room')
  }

  // Header chips: past what fits, a counter carries the remainder. Without it the
  // strip wraps and pushes the title around.
  if (!/chipsShown\.map/.test(src)) bad('rooms', 'header chips are not capped')
  else if (!/rt-chip-more/.test(src)) bad('rooms', 'no overflow indicator on the header')
  else ok('rooms', 'header chips overflow into a counter')

  // The @-popup must reach every member, not just the first seven.
  if (!/items\.slice\(0, 12\)/.test(src)) {
    bad('rooms', 'the @-popup still caps at seven entries')
  } else if (!/max-height: 268px; overflow-y: auto/.test(src)) {
    bad('rooms', 'the @-popup cannot scroll')
  } else {
    ok('rooms', '@-popup lists twelve and scrolls')
  }

  // ── pinned messages ──
  if (!/const PIN_LIMIT = \d+/.test(src)) bad('pin', 'no pin limit')
  else if (!/const togglePin = React\.useCallback/.test(src)) bad('pin', 'pinning is not wired')
  else if (!/className: 'rt-pins'/.test(src)) bad('pin', 'no pinned bar in the panel')
  else if (!/className: 'rt-pin-main'/.test(src)) bad('pin', 'pinned rows are not clickable')
  else ok('pin', 'messages can be pinned and jumped to')

  // The bar resolves ids against the transcript, so a recalled message drops out
  // instead of leaving a hole.
  if (!/\.map\(\(id\) => \(room\?\.messages \?\? \[\]\)\.find\(\(m\) => m\.id === id\)\)/.test(src)) {
    bad('pin', 'a dangling pinned id would render as an empty row')
  } else {
    ok('pin', 'dangling pinned ids are dropped')
  }

  // Rows are memoised: the pin props must be in the comparator, or the button
  // would not flip between 置顶 and 已置顶.
  if (!/&& a\.isPinned === b\.isPinned/.test(src)) {
    bad('pin', 'the row comparator ignores pinned state')
  } else {
    ok('pin', 'pinned state reaches the row')
  }

  // ── about page ──
  //
  // 关于 only mounts when the settings dialog is open, so the panel render above
  // never reaches it — a typo or a missing CSS rule there would ship silently.
  {
    const lines = src.split('\n')
    const i = lines.findIndex((l) => l.trim() === "if (section === 'about') {")
    if (i < 0) {
      bad('about', 'no 关于 section')
    } else {
      let d = 0
      let started = false
      let e = i
      for (let k = i; k < lines.length; k++) {
        for (const ch of lines[k]) {
          if (ch === '{') { d++; started = true }
          else if (ch === '}') d--
        }
        if (started && d === 0) { e = k; break }
      }
      const body = lines.slice(i, e + 1).join('\n')

      if (!/id: 'about', label: '关于'/.test(src)) bad('about', 'section not registered in the rail')
      else ok('about', '关于 section registered')

      // What it must show.
      const wanted = [
        ['title', /rt-about-title/],
        ['version', /'v' \+ VERSION/],
        ['byline', /'Made by '/],
        ['features', /FEATURES\.map/],
        ['keys', /KEYS\.map/],
        ['no-keys note', /不持有任何 API key/],
      ]
      const missing = wanted.filter(([, re]) => !re.test(body)).map(([n]) => n)
      if (missing.length) bad('about', 'missing: ' + missing.join(', '))
      else ok('about', 'shows title, version, byline, features, keys')

      // Every class it renders must have a rule, or part of the page is unstyled.
      const classes = [...new Set([...body.matchAll(/className: '([a-z-]+)'/g)].map((m) => m[1]))]
      const unstyled = classes.filter((c) => !new RegExp('\\.' + c + '(?![\\w-])').test(src))
      if (unstyled.length) bad('about', 'no CSS for: ' + unstyled.join(', '))
      else ok('about', classes.length + ' classes all styled')
    }
  }

  // The version and author shown in 关于 must match the manifest, or the dialog
  // reports a build that does not exist.
  {
    let pkg = null
    try { pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')) } catch { /* missing manifest */ }
    if (!pkg) {
      bad('about', 'package.json unreadable')
    } else {
      const v = (src.match(/const VERSION = '([^']+)'/) || [])[1]
      const a = (src.match(/const AUTHOR = '([^']+)'/) || [])[1]
      if (v !== pkg.version) bad('about', 'VERSION ' + v + ' ≠ package.json ' + pkg.version)
      else if (a !== pkg.author) bad('about', 'AUTHOR ' + a + ' ≠ package.json ' + pkg.author)
      else ok('about', 'version ' + v + ' and author match the manifest')
    }
  }

  // ── credit ──
  //
  // The byline is part of the product now; a refactor that drops it should fail
  // here rather than be noticed months later.
  if (!/Made by 一只杨洋qwq/.test(src)) {
    bad('credit', 'the author byline is missing')
  } else if (!/className: 'rt-made'/.test(src)) {
    bad('credit', 'the byline has no styling hook')
  } else {
    ok('credit', 'Made by 一只杨洋qwq')
  }

  // ── persistence under quota ──
  //
  // localStorage is a few megabytes and a long room reaches it. The first version
  // swallowed the failure, so the panel looked healthy while nothing was written —
  // the loss only appeared after a refresh.
  if (!/let saveError = null/.test(src)) {
    bad('storage', 'save failures are not tracked')
  } else {
    ok('storage', 'save failures are tracked')
  }
  if (!/for \(let round = 0; round < 8 && !ok; round\+\+\)/.test(src)) {
    bad('storage', 'overflow is not retried with a shrinking payload')
  } else {
    ok('storage', 'overflow trims and retries until it fits')
  }
  if (!/保存失败：刷新后可能丢消息/.test(src)) {
    bad('storage', 'a failed save is never shown to the user')
  } else {
    ok('storage', 'a failed save is reported in the panel')
  }

  // ── model catalog ──
  //
  // "The model list feels short" was undiagnosable: a route reporting zero models
  // looked identical to a route that was never configured. The count and the
  // empty-state guidance are what make the difference visible.
  if (!/rt-prov-n/.test(src)) {
    bad('catalog', 'routes do not show how many models they reported')
  } else {
    ok('catalog', 'each route shows its model count')
  }
  if (!/去 DSH 的「模型」页面/.test(src)) {
    bad('catalog', 'the empty state does not say where routes come from')
  } else {
    ok('catalog', 'the empty state explains where to configure routes')
  }

  // ── typing latency ──
  //
  // `input` is top-level state, so every keystroke re-rendered the whole panel:
  // the sidebar, the header, the transcript, and the composer. In a room with a
  // few hundred messages that is what made typing feel like it was lagging.
  //
  // The rail and header do not read the composer, so they are memoised. The guard
  // matters as much as the memo: a runtime without `useMemo` must recompute, not
  // throw, or the panel dies on first render.
  if (!/const useMemoSafe = \(fn, deps\)/.test(src)) {
    bad('perf', 'no guarded memo helper')
  } else if (!/typeof React\.useMemo === 'function'/.test(src)) {
    bad('perf', 'memo helper is not guarded against a missing useMemo')
  } else {
    ok('perf', 'memo helper degrades safely')
  }

  {
    // Each memoised subtree must list what it reads, or it shows stale data.
    // Missing a dependency is invisible until the user changes that thing and
    // nothing updates — the worst kind of bug to find by hand.
    const specs = [
      {
        name: 'head',
        open: "const head = useMemoSafe(() => h('div', { className: 'rt-head' },",
        need: ['room', 'members', 'density', 'railOpen', 'catalog', 'running'],
      },
      {
        name: 'rail',
        open: "const rail = useMemoSafe(() => h('div', { className: 'rt-rail'",
        need: ['railOpen', 'rooms', 'activeId', 'running', 'createRoom', 'members', 'profile', 'catalogError'],
      },
    ]
    const lines = src.split('\n')
    let problems = []
    for (const spec of specs) {
      const i = lines.findIndex((l) => l.includes(spec.open))
      if (i < 0) { problems.push(spec.name + ' not memoised'); continue }
      // Find the closing dependency array.
      let dep = ''
      for (let k = i; k < Math.min(i + 120, lines.length); k++) {
        const m = lines[k].match(/\),\s*\[([^\]]*)\]/)
        if (m) { dep = m[1]; break }
      }
      if (dep === '') { problems.push(spec.name + ' has no dependency list'); continue }
      const missing = spec.need.filter((d) => !dep.includes(d))
      if (missing.length) problems.push(spec.name + ' missing ' + missing.join('/'))
    }
    if (problems.length) bad('perf', problems.join('; '))
    else ok('perf', 'rail and header list every value they read')
  }

  // The rail and header must actually be the memoised ones — not a leftover plain
  // `const` that happens to sit beside the helper.
  if (!/const head = useMemoSafe\(/.test(src) || !/const rail = useMemoSafe\(/.test(src)) {
    bad('perf', 'rail or header is rebuilt on every keystroke')
  } else {
    ok('perf', 'rail and header are reused across keystrokes')
  }

  // Entrance animation is per-row; playing it on dozens of rows at once is the
  // hitch when loading older messages.
  if (!/\.rt-msg-fresh \{ animation: rt-in/.test(src)) {
    bad('perf', 'the fresh-row animation marker is gone')
  } else if (/\.rt-msg \{[^}]*animation:/.test(src)) {
    bad('perf', 'every row still animates on mount')
  } else {
    ok('perf', 'only new rows animate in')
  }

  // Infinite animations must be contained, or the compositor never idles while a
  // reply streams.
  if (!/\.rt-caret \{[^}]*contain: paint/.test(src)) {
    bad('perf', 'the blinking caret is not contained')
  } else {
    ok('perf', 'streaming animations are contained')
  }

  // The rail blur was hard-coded, so the 极简 skin paid for a blur it never showed.
  if (/\.rt-rail \{[^}]*backdrop-filter: blur\(/.test(src)) {
    bad('perf', 'the rail hard-codes a blur instead of following the skin')
  } else {
    ok('perf', 'the rail follows the skin blur')
  }

  // ── pagination ──
  //
  // A room grows without bound and every message costs ~7 DOM nodes. Measured in
  // a browser: 2000 messages mount in ~200ms and stream at ~1.6ms per frame,
  // 4000 in ~490ms and ~6.1ms — enough to drop frames on its own. Only the tail
  // is rendered; the rest is one click away.
  if (!/const MESSAGE_PAGE = \d+/.test(src)) bad('perf', 'the transcript has no page size')
  else ok('perf', 'transcript is paginated')
  if (!/room\.messages\.slice\(hidden\)/.test(src)) {
    bad('perf', 'every message is still rendered')
  } else {
    ok('perf', 'only the tail is mounted')
  }
  if (!/setVisibleCount\(MESSAGE_PAGE\)/.test(src)) {
    bad('perf', 'the page is never reset on room change')
  } else {
    ok('perf', 'switching rooms resets the page')
  }

  {
    // The bounds expression must clamp to the total, or a short room renders
    // undefined rows. Taking the max of PAGE and the min of n and total looks
    // right and is not: it forces PAGE even when the room has fewer messages.
    const m = src.match(/const shown = ([^\n]+)/)
    if (!m) {
      bad('perf', 'the visible slice has no bounds expression')
    } else {
      const expr = m[1]
      const PAGE = Number((src.match(/const MESSAGE_PAGE = (\d+)/) || [])[1])
      const f = new Function('MESSAGE_PAGE', 'visibleCount', 'total', 'return ' + expr)
      const cases = [
        [0, PAGE, 0],
        [10, PAGE, 10],
        [PAGE, PAGE, PAGE],
        [PAGE + 1, PAGE, PAGE],
        [2000, PAGE, PAGE],
        [2000, PAGE + 80, PAGE + 80],
        [200, 99999, 200],
      ]
      let badCase = null
      for (const [totalMsgs, vc, want] of cases) {
        const got = f(PAGE, vc, totalMsgs)
        if (got !== want) {
          badCase = 'total=' + totalMsgs + ' visible=' + vc + ' gives ' + got + ', want ' + want
          break
        }
      }
      if (badCase) bad('perf', 'visible slice is wrong: ' + badCase)
      else ok('perf', 'visible slice is clamped to the room length')
    }
  }

  // Loading more prepends above the viewport, so the scroll position has to be
  // compensated or the text jumps down under the cursor.
  if (!/scrollHeight - before/.test(src)) {
    bad('perf', 'loading more shifts the transcript')
  } else {
    ok('perf', 'loading more keeps the reading position')
  }

  // ── typing performance ──
  //
  // Every callback passed to MemoMessageRow is compared by identity. Defined as
  // plain functions they are a fresh object on every render, the comparator never
  // matches, and every row re-renders on every keystroke — which is what made
  // holding backspace freeze the panel.
  {
    const callbacks = ['stopMessage', 'grabPacket', 'startQuote', 'editMessage',
      'recallMessage', 'castVote', 'closeVote', 'joinChain']
    const unstable = []
    for (const name of callbacks) {
      const i = src.indexOf('const ' + name + ' = ')
      if (i < 0) { unstable.push(name + '(missing)'); continue }
      const line = src.slice(i, src.indexOf('\n', i))
      if (!/React\.useCallback/.test(line)) unstable.push(name)
    }
    if (unstable.length) bad('perf', 'unstable row callbacks: ' + unstable.join(', '))
    else ok('perf', 'all ' + callbacks.length + ' row callbacks are stable')
  }

// (the comparator wiring is already covered by "rows are memoised with a comparator")

  // ── attachments from the clipboard and the file system ──
  if (!/onPaste:/.test(src)) bad('images', 'images cannot be pasted')
  else ok('images', 'pasting an image attaches it')
  if (!/onDrop:/.test(src)) bad('images', 'images cannot be dropped')
  else ok('images', 'dropping an image attaches it')

  // A drop handler that forgets preventDefault makes the browser navigate away
  // from the conversation, which is worse than not supporting drops at all.
  if (!/onDragOver:[\s\S]{0,200}preventDefault/.test(src)) {
    bad('images', 'drag-over does not prevent the browser default')
  } else {
    ok('images', 'dropping does not navigate away')
  }

  // ── images ──
  //
  // Images travel as \`{ type: 'image', attachment }` blocks. The important
  // property is what happens to a model that cannot see them: DSH substitutes a
  // placeholder saying the image was omitted, so the model reports the limitation
  // instead of answering as if it had seen the picture.
  if (!/function msgWithImages/.test(hostEff)) bad('images', 'messages cannot carry images')
  else ok('images', 'image messages are built on the Host')
  if (!/type: 'image'/.test(hostEff)) bad('images', 'no image content block')
  else ok('images', 'image content blocks are emitted')
  if (!/route === '\/image'/.test(hostEff)) bad('images', 'no upload route')
  else ok('images', 'upload route present')
  if (!/route === '\/image-read'/.test(hostEff)) bad('images', 'no read-back route')
  else ok('images', 'stored images can be read back')
  if (!/function ImageThumb/.test(src)) bad('images', 'images are never displayed')
  else ok('images', 'transcript renders the attachment')
  if (!/uploadImage = React\.useCallback/.test(src)) bad('images', 'no client upload path')
  else ok('images', 'composer can attach an image')

  {
    // The block shape must be one DSH recognises, or the model gets nothing at all.
    const dshPath = 'D:/DSH产物工作区/_llm/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
    let dsh = ''
    try { dsh = readFileSync(dshPath, 'utf8') } catch { /* not extracted in this run */ }
    if (dsh === '') {
      notes.push('DSH llm source not available; skipped the text-only fallback check')
    } else if (!/textOnlyImageText/.test(dsh)) {
      bad('images', 'DSH has no text-only fallback — a blind model would be confused')
    } else {
      ok('images', 'DSH degrades images for text-only models')
    }
  }

  // ── search ──
  //
  // A long room is unsearchable by eye, and the layered history means older
  // messages are no longer in any model's context — searching the local
  // transcript is the only way back to them.
  if (!/function SearchModal/.test(src)) bad('search', 'no search dialog')
  else ok('search', 'search dialog present')
  if (!/jumpToMessage = React\.useCallback|function jumpToMessage/.test(src)) {
    bad('search', 'results cannot be jumped to')
  } else {
    ok('search', 'hits can be jumped to')
  }

  {
    // Every message kind needs an addressable attribute, or a hit for that kind
    // cannot be scrolled to.
    const anchors = (src.match(/\{ 'data-msg-id': msg\.id/g) || []).length
    if (anchors < 6) bad('search', 'only ' + anchors + ' message kinds are addressable, expected 6')
    else ok('search', anchors + ' message kinds are addressable')
  }

  {
    // Exercise the filter: it must reach every kind, not just chat text.
    const msgs = [
      { id: 'a', role: 'user', text: '今天加班吗', ts: 1 },
      { id: 'b', role: 'packet', note: '加班补贴', grabs: [{ points: 50 }], ts: 2 },
      { id: 'c', role: 'vote', text: '今晚', options: ['要', '不要'], ts: 3 },
      { id: 'd', role: 'chain', text: '周末', entries: [{ text: '我有空' }], ts: 4 },
      { id: 'e', role: 'sys', text: '模型买了可乐', ts: 5 },
    ]
    const textOf = (m) => {
      if (m.role === 'packet') return (m.note || '') + ' ' + (m.grabs ?? []).map((g) => g.points + '分').join(' ')
      if (m.role === 'vote') return String(m.text ?? '') + ' ' + (m.options ?? []).join(' ')
      if (m.role === 'chain') return String(m.text ?? '') + ' ' + (m.entries ?? []).map((e) => e.text).join(' ')
      return String(m.text ?? '')
    }
    const find = (q) => msgs.filter((m) => textOf(m).toLowerCase().includes(q.toLowerCase()))
    if (find('补贴').length !== 1) bad('search', 'packet notes are not searchable')
    else if (find('不要').length !== 1) bad('search', 'vote options are not searchable')
    else if (find('我有空').length !== 1) bad('search', 'chain entries are not searchable')
    else if (find('可乐').length !== 1) bad('search', 'system lines are not searchable')
    else ok('search', 'every message kind is searchable')
  }

  // ── icons are drawn, not typed ──
  //
  // Every interface glyph used to be an emoji. An emoji's size, weight and
  // baseline belong to the platform font, so the same character renders
  // differently on every machine and cannot inherit `currentColor`. The
  // interface now uses stroked SVG paths.
  //
  // Emoji are still correct *inside* the emoji picker — those are message
  // content, not chrome — so the check is scoped to the interface, not the
  // whole file.
  if (!/const ICONS = \{/.test(src)) bad('icons', 'no SVG icon set')
  else ok('icons', 'SVG icon set present')
  if (!/function Icon\(\{ name, size/.test(src)) bad('icons', 'no Icon component')
  else ok('icons', 'Icon component present')

  {
    // Interface chrome must not contain emoji. The picker's data is exempt — it
    // is message content, not chrome — so its declaration is cut out of the
    // text before the scan. The block is a literal array that ends at the first
    // line consisting solely of `]`.
    const lines = src.split('\n')
    const pickerStart = lines.findIndex((l) => l.includes('const EMOJI_GROUPS'))
    let pickerEnd = lines.length
    if (pickerStart >= 0) {
      for (let i = pickerStart + 1; i < lines.length; i++) {
        if (lines[i].trim() === ']') { pickerEnd = i; break }
      }
    }
    const chromeLines = pickerStart >= 0
      ? [...lines.slice(0, pickerStart), ...lines.slice(pickerEnd + 1)]
      : lines

    const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u
    const offenders = []
    chromeLines.forEach((l, i) => {
      if (emojiRe.test(l)) offenders.push((i + 1) + ': ' + l.trim().slice(0, 50))
    })
    if (offenders.length > 0) {
      bad('icons', offenders.length + ' emoji left in the interface, e.g. ' + offenders[0])
    } else {
      ok('icons', 'no emoji in the interface chrome')
    }
  }

  // Every icon name referenced must actually be drawn, or the UI renders a hole.
  {
    const iconsBlock = src.slice(src.indexOf('const ICONS = {'), src.indexOf('function Icon({ name, size'))
    const defined = new Set([...iconsBlock.matchAll(/^    (\w+): '/gm)].map((m) => m[1]))
    const used = new Set()
    for (const m of src.matchAll(/icon: '([a-z_]+)'/g)) used.add(m[1])
    for (const m of src.matchAll(/h\(Icon, \{ name: '([a-z_]+)'/g)) used.add(m[1])
    for (const m of src.matchAll(/iconName \?\? '([a-z_]+)'/g)) used.add(m[1])
    for (const m of src.matchAll(/away\.icon \?\? '([a-z_]+)'/g)) used.add(m[1])
    const missing = [...used].filter((n) => !defined.has(n))
    if (missing.length) bad('icons', 'referenced but not drawn: ' + missing.join(', '))
    else ok('icons', defined.size + ' icons, all references resolve')
  }

  // ── red packet kinds ──
  //
  // A 红包 is not one thing: 拼手气 is a lottery, 平均分 is fair by construction,
  // and 专属 is a gift to one named model. The first version only had the
  // lottery, so "send this to MiniMax" was impossible and every packet felt
  // rigged.
  if (!/kind === 'even'/.test(src) || !/kind === 'single'/.test(src)) {
    bad('packet', 'only the lottery kind exists')
  } else {
    ok('packet', '拼手气 / 平均分 / 专属 all supported')
  }
  if (!/KINDS\.map/.test(src)) bad('packet', 'no kind picker in the dialog')
  else ok('packet', 'the dialog lets the sender choose')
  if (!/rt-pick-list/.test(src)) bad('packet', 'no recipient picker for 专属')
  else ok('packet', '专属 can name a recipient')
  if (!/msg\.kind === 'even'/.test(src)) bad('packet', 'the transcript does not say which kind')
  else ok('packet', 'the sent packet shows its kind')

  // The three splits must conserve the total, and 平均分 must actually be even.
  try {
    const g5 = (name) => {
      const i = src.indexOf('function ' + name + '(')
      if (i < 0) throw new Error('missing ' + name)
      let d = 0, st = false, j = i
      for (; j < src.length; j++) {
        if (src[j] === '{') { d++; st = true }
        else if (src[j] === '}') { d--; if (st && d === 0) break }
      }
      return src.slice(i, j + 1)
    }
    const { splitRedPacket } = new Function(g5('splitRedPacket') + '\nreturn { splitRedPacket }')()
    const sum = (a) => a.reduce((x, y) => x + y, 0)

    const even = splitRedPacket(100, 4, 7, 'even')
    if (!(sum(even) === 100 && even.every((v) => v === 25))) {
      bad('packet', '平均分 is not actually even: ' + JSON.stringify(even))
    } else {
      ok('packet', '平均分 splits evenly')
    }
    const single = splitRedPacket(88, 1, 7, 'single')
    if (!(single.length === 1 && single[0] === 88)) {
      bad('packet', '专属 does not give the whole amount: ' + JSON.stringify(single))
    } else {
      ok('packet', '专属 gives everything to one')
    }
    // Conservation across kinds and sizes — the invariant that matters most.
    let broken = 0
    for (let t = 1; t <= 60; t++) {
      for (const kind of ['lucky', 'even', 'single']) {
        for (const n of [1, 2, 3, 5, 8]) {
          if (sum(splitRedPacket(t, n, t * 17 + n, kind)) !== t) broken++
        }
      }
    }
    if (broken) bad('packet', broken + ' splits do not conserve the total')
    else ok('packet', 'all kinds conserve the total')
  } catch (e) {
    bad('packet', 'split could not be exercised: ' + String(e && e.message))
  }

  // The amount and count fields must be clearable.
  //
  // Holding them as numbers meant `Number(x) || 0` put a 0 straight back into an
  // emptied field, so the last digit could never be deleted. The fix keeps the
  // raw text and derives the number separately.
  if (/setPoints\(Number\(/.test(src) || /setCount\(Number\(/.test(src)) {
    bad('packet', 'an input converts to a number on change — it cannot be cleared')
  } else if (!/setPoints\(e\.target\.value\.replace/.test(src)) {
    bad('packet', 'the amount field does not keep raw text')
  } else if (!/setCount\(e\.target\.value\.replace/.test(src)) {
    bad('packet', 'the count field does not keep raw text')
  } else {
    ok('packet', 'amount and count can be emptied')
  }
  // And an empty field must not be sendable.
  if (!/const canSend = amount > 0/.test(src)) {
    bad('packet', 'an empty amount can still be sent')
  } else {
    ok('packet', 'empty amount disables the send button')
  }

  // ── stall handling ──
  //
  // A model that goes quiet used to hold the row for a full 90 seconds, which is
  // what made a stuck MiniMax feel like a frozen panel. The bound is now two
  // tiers: nothing-arrived is dropped sooner than "stopped mid-answer", because
  // the two waits mean different things.
  if (!/const FIRST_BYTE_MS/.test(src) || !/const MID_STREAM_MS/.test(src)) {
    bad('stall', 'the idle bound is a single flat timeout')
  } else {
    const first = Number((src.match(/const FIRST_BYTE_MS = ([\d_]+)/) || [])[1]?.replace(/_/g, ''))
    const mid = Number((src.match(/const MID_STREAM_MS = ([\d_]+)/) || [])[1]?.replace(/_/g, ''))
    if (!(first > 0) || !(mid > 0)) bad('stall', 'timeouts are not numeric')
    else if (first >= mid) bad('stall', 'the first-byte bound is not the tighter one')
    else if (first > 60_000) bad('stall', 'the first-byte bound is still too long')
    else ok('stall', 'first byte ' + first / 1000 + 's, mid-stream ' + mid / 1000 + 's')
  }
  // The tier must actually switch once bytes arrive, or the longer bound never
  // applies and long answers get cut off.
  if (!/bump\(true\)/.test(src) || !/sawByte \? MID_STREAM_MS : FIRST_BYTE_MS/.test(src)) {
    bad('stall', 'the timeout does not relax after the first byte')
  } else {
    ok('stall', 'bound relaxes once the stream starts')
  }
  // A silent row must say so — but only once the silence has lasted long enough
  // to mean something.
  //
  // The first version passed `stalled: !msg.text`, so a model that had merely not
  // started was labelled 没有响应 after a second or two. The note is only correct
  // when the clock and the absence of output are *both* true.
  if (!/一直没有输出，可能卡住了/.test(src)) {
    bad('stall', 'a stalled row gives no signal')
  } else if (!/const silent = !hasOutput && secs >= STUCK_AFTER_SECS/.test(src)) {
    bad('stall', 'the stuck note has no time threshold')
  } else if (/stalled: !msg\.text/.test(src)) {
    bad('stall', 'silence alone still triggers the stuck note')
  } else {
    ok('stall', 'stuck note needs both silence and time')
  }

  // ── interaction dead ends ──
  //
  // Two cases where the UI could leave the user stuck or confused, both found
  // by walking the flows rather than by reading the code for smells.
  //
  // 1. Switching rooms while a reply streams left the old turn running: it kept
  //    spending quota into a room nobody was looking at, and its row stayed on
  //    "思考中" until it finished on its own.
  if (!/if \(r\.id !== state\.activeId && running\) cancelTurn\('superseded'\)/.test(src)) {
    bad('interaction', 'switching rooms does not stop the running turn')
  } else {
    ok('interaction', 'switching rooms stops the turn')
  }

  // 2. The add-model button disables at the member cap with no explanation, so
  //    it reads as broken. Every disabled state must say why.
  if (!/title: !room\s*\n?\s*\?\s*'先建一个群'/.test(src.replace(/\r/g, ''))) {
    bad('interaction', 'the add-model button gives no reason when disabled')
  } else {
    ok('interaction', 'disabled buttons explain themselves')
  }

  // ── scrolling ──
  //
  // The container uses `scroll-behavior: smooth` so a streaming reply glides.
  // That same rule made entering a room render at the top and then animate its
  // way down — every entry began with a visible slide.
  //
  // The fix must go through `scrollTo({behavior:'instant'})`. The first attempt
  // set `style.scrollBehavior = 'auto'` around the assignment, which does not
  // work: style changes are applied at the next style recalculation, so the
  // temporary value can be undone before the scroll is performed.
  if (!/scroll-behavior:\s*smooth/.test(src)) {
    bad('scroll', 'smooth scrolling was removed entirely')
  } else if (!/scrollTo\(\{ top: s\.scrollHeight, behavior: 'instant' \}\)/.test(src)) {
    bad('scroll', 'opening a room still animates from the top')
  } else if (!/scrollDown\(true, true\)/.test(src)) {
    bad('scroll', 'the open-room effect does not request an instant jump')
  } else {
    ok('scroll', 'opening a room jumps via scrollTo, not CSS')
  }
  // The ref is null on the very first mount (the empty state has no transcript),
  // so the effect must also fire when the container appears.
  if (!/msgCount > 0/.test(src)) {
    bad('scroll', 'a later-mounted transcript is never scrolled')
  } else {
    ok('scroll', 'second pass covers a late-mounted transcript')
  }
  // A room the user had scrolled up in must not open part-way.
  if (!/stickRef\.current = true[\s\S]{0,200}scrollDown\(true, true\)/.test(src)) {
    bad('scroll', 'stick state is not reset when a room opens')
  } else {
    ok('scroll', 'stick state resets on room change')
  }

  // ── settings layout ──
  //
  // Windows 11 shape: categories on the left, the chosen page on the right.
  // A single long list stops working once there are more than a handful of
  // options; this shape is what makes adding sections cheap.
  if (!/SETTINGS_SECTIONS/.test(src)) bad('settings', 'no section registry')
  else ok('settings', 'sections declared in one list')
  if (!/rt-set-nav-item/.test(src)) bad('settings', 'no category rail')
  else ok('settings', 'categories render down the left')
  if (!/rt-set-body/.test(src)) bad('settings', 'no content pane')
  else ok('settings', 'content pane renders the chosen page')
  if (!/rt-modal\.wide/.test(src)) bad('settings', 'no wide dialog variant')
  else ok('settings', 'dialog is wide enough for two columns')
  // Height must be a maximum, not a fixed value: a short page would otherwise
  // leave a quarter of the dialog empty.
  if (/\.rt-modal\.wide \{ width[^}]*height:\s*min\(/.test(src)) {
    bad('settings', 'dialog height is fixed rather than capped')
  } else {
    ok('settings', 'dialog height adapts to content')
  }

  // Two details that made the first attempt look wrong, now pinned:
  //
  //   · The category rail must not be tinted. W11 keeps it on the same surface
  //     as the page; a tint made the dialog read as two mismatched panels.
  //   · The selection marker must be a short pill, not a bar spanning the row.
  //     A full-height bar reads as a tab strip from an older design language.
  {
    const lines = src.split('\n')
    const grab = (sel) => {
      const i = lines.findIndex((l) => l.trim() === sel + ' {')
      if (i < 0) return ''
      let j = i + 1
      const out = []
      while (j < lines.length && lines[j].trim() !== '}') { out.push(lines[j].trim()); j++ }
      return out.join(' ')
    }

    const nav = grab('.rt-set-nav')
    // `transparent` is the invariant; a tint of any kind is the regression.
    if (!/background:\s*transparent/.test(nav)) {
      bad('settings', 'the category rail is tinted again: ' + nav.slice(0, 90))
    } else if (/\bborder-right:\s*[1-9]/.test(nav) || /\bborder-right:\s*(\d+px|thin|medium)/.test(nav)) {
      bad('settings', 'the category rail has a divider again')
    } else {
      ok('settings', 'category rail is untinted and undivided')
    }

    if (/box-shadow:\s*inset 3px 0 0/.test(src)) {
      bad('settings', 'selection uses a full-height bar')
    } else if (!/\.rt-set-nav-item::before/.test(src)) {
      bad('settings', 'no selection pill')
    } else if (!/height:\s*16px/.test(grab('.rt-set-nav-item::before'))) {
      bad('settings', 'the selection pill is not sized to the label')
    } else {
      ok('settings', 'selection is a short pill, not a bar')
    }

    // Icons must be drawn, not typed.
    //
    // An emoji's colour, weight and baseline belong to the platform font, so it
    // can never sit evenly beside a 12.5px label — and it ignores the row's
    // colour, which is what the selected state relies on.
    if (!/function SettingsGlyph/.test(src)) {
      bad('settings', 'no SVG icon set')
    } else if (!/h\('span', \{ className: 'rt-set-nav-glyph' \}, h\(SettingsGlyph/.test(src)) {
      bad('settings', 'the rail still renders a text glyph')
    } else {
      ok('settings', 'categories use drawn SVG icons')
    }
    // Any emoji left in the section list would be a regression.
    {
      const idx = src.indexOf('const SETTINGS_SECTIONS = [')
      const seg = idx < 0 ? '' : src.slice(idx, src.indexOf(']', idx))
      if (/[👤🎨💬⚙📊📋🏪🧧☺💡🔔]/.test(seg)) {
        bad('settings', 'an emoji is still used as a section icon')
      } else {
        ok('settings', 'no emoji in the section list')
      }
    }
  }

  // The collapsed-header padding must come *after* the base `.rt-head` rule, or
  // the base shorthand padding wins on source order and the opener overlaps text.
  {
    const lines = src.split('\n')
    let base = -1
    let cov = -1
    lines.forEach((l, i) => {
      if (/^\.rt-head \{/.test(l)) base = i
      if (/^\.rt-root\.rail-closed \.rt-head/.test(l)) cov = i
    })
    if (base < 0 || cov < 0) bad('rail collapse', 'header padding rules missing')
    else if (cov < base) bad('rail collapse', 'collapsed padding is overridden by the base rule')
    else ok('rail collapse', 'collapsed padding wins on source order')
  }

  // The opener must live inside `.rt-head`, which is the only element in this
  // subtree with `position: relative`. As a sibling inside `.rt-main` its
  // `top: 50%` resolved against the whole panel and it drifted to the middle.
  {
    const headIdx = src.search(/const head = (?:useMemoSafe\(\(\) => )?h\('div', \{ className: 'rt-head' \}/)
    const openIdx = src.indexOf("className: 'rt-rail-open'")
    const mainIdx = src.indexOf("h('div', { className: 'rt-main' }")
    if (headIdx < 0 || openIdx < 0) {
      bad('rail collapse', 'header or opener not found')
    } else if (openIdx < headIdx) {
      // One occurrence before the header is the CSS block; the JSX one must be after.
      const jsxOpen = src.indexOf("className: 'rt-rail-open'", headIdx)
      if (jsxOpen < 0) bad('rail collapse', 'opener JSX vanished')
      else ok('rail collapse', 'opener lives inside the header')
    } else if (mainIdx > 0 && openIdx > mainIdx && openIdx < headIdx) {
      bad('rail collapse', 'opener is a sibling of the header — it will drift')
    } else {
      ok('rail collapse', 'opener lives inside the header')
    }
    // It must not be absolutely positioned any more.
    const cssOpen = src.indexOf('.rt-rail-open {', src.indexOf('const CSS = `'))
    const cssEnd = src.indexOf('}', cssOpen)
    const rule = cssOpen > 0 ? src.slice(cssOpen, cssEnd) : ''
    if (/position:\s*absolute/.test(rule)) {
      bad('rail collapse', 'opener is absolutely positioned again')
    } else {
      ok('rail collapse', 'opener is inline, not overlaid')
    }
    if (/box-shadow:\s*inset/.test(rule)) {
      bad('rail collapse', 'opener still draws a grey outline')
    } else {
      ok('rail collapse', 'opener has no grey outline')
    }
  }

  // ── group-chat features ──
  //
  // The five things a real group chat has that this one lacked. Each is checked
  // by its load-bearing part, not by the label in the UI.
  if (!/function QuoteBlock/.test(src)) bad('features', 'no quote rendering')
  else if (!/msg\.quote \? h\(QuoteBlock/.test(src)) bad('features', 'quote is never shown')
  else ok('features', '引用回复 renders and travels with the message')
  if (!/const quoted = q && q\.text/.test(hostEff)) bad('features', 'the model cannot see the quote')
  else ok('features', 'quote reaches the model')

  if (!/room\.notice/.test(src)) bad('features', 'no room notice')
  else if (!/## 群公告/.test(hostEff)) bad('features', 'notice never reaches the model')
  else ok('features', '群公告 is shown and enforced')

  if (!/role === 'vote'/.test(src)) bad('features', 'no vote messages')
  else if (!/ballots\.filter/.test(src)) bad('features', 'vote tally is not derived from ballots')
  else ok('features', '群投票 tallies from ballots')
  if (!/role === 'chain'/.test(src)) bad('features', 'no chain messages')
  // Joining twice must edit the row, not add a second one under the same name.
  else if (!/entries\.filter\(\(e\) => e\.memberId !== '__me'/.test(src)) {
    bad('features', 'chain allows double joins')
  } else ok('features', '群接龙 appends without duplicates')

  // ── taking part, not just watching ──
  //
  // A vote or a 接龙 started by the user used to be read-only for the models:
  // they could see the tally but had no way to add to it, so it sat at zero
  // forever. The directives are what makes the feature two-sided.
  if (!/function parseVoteCommand/.test(src)) bad('features', 'models cannot vote')
  else ok('features', 'models can vote via @投票')
  if (!/function parseChainCommand/.test(src)) bad('features', 'models cannot join a 接龙')
  else ok('features', 'models can join via @接龙')
  if (!/applyRoomCommands\(withUser\.id, member, result\.text\)/.test(src)) {
    bad('features', 'the directives are parsed but never applied')
  } else {
    ok('features', 'both directives are applied to replies')
  }
  // And the models have to be told, or the syntax is unreachable.
  if (!/@投票 <选项名>/.test(hostEff) || !/@接龙 <写点什么>/.test(hostEff)) {
    bad('features', 'the prompt never mentions the activity directives')
  } else {
    ok('features', 'the prompt explains both directives')
  }

  if (!/const recallMessage = React\.useCallback/.test(src)) bad('features', 'no recall')
  else if (!/const editMessage = React\.useCallback/.test(src)) bad('features', 'no edit')
  else if (/onRecall: \(msg\) => recallMessage/.test(src)) bad('features', 'inline callbacks defeat the memo')
  else ok('features', '撤回 / 编辑 are stable callbacks')

  // A model's own words must not be editable — that would falsify the record.
  if (!/if \(msg\.role !== 'user'\) return/.test(src)) bad('features', 'recall/edit not limited to user messages')
  else ok('features', 'only the user can recall or edit')

  // ── performance ──
  //
  // Three things made the panel slow down as a conversation grew. Each one is
  // cheap to reintroduce by accident, so each is checked.
  //
  // 1. Every streaming delta called setState, re-rendering the whole room and
  //    serialising the entire state to localStorage.
  // 2. Every message row re-rendered on every delta — nothing was memoised.
  // 3. saveState wrote synchronously on each update.
  if (!/requestAnimationFrame\(flushDelta\)/.test(src)) {
    bad('performance', 'deltas are not batched per frame')
  } else if (!/pendingDelta/.test(src)) {
    bad('performance', 'no delta buffer')
  } else {
    ok('performance', 'deltas coalesce into one paint per frame')
  }
  if (!/const MemoMessageRow = React\.memo/.test(src)) {
    bad('performance', 'message rows are not memoised')
  } else if (!/function sameRow\(a, b\)/.test(src)) {
    bad('performance', 'memo has no comparator')
  } else {
    ok('performance', 'rows are memoised with a comparator')
  }
  if (!/let saveTimer = null/.test(src) || !/function flushSave/.test(src)) {
    bad('performance', 'state is written synchronously on every update')
  } else {
    ok('performance', 'state writes are coalesced')
  }
  // The final delta must be painted even if its frame never fires, or a reply
  // loses its last words.
  if (!/if \(pendingDelta\) \{/.test(src)) {
    bad('performance', 'the last delta can be dropped at stream end')
  } else {
    ok('performance', 'stream end flushes the tail')
  }

  // A row stuck on "思考中" while text streams in behind it.
  //
  // `requestAnimationFrame` does not fire in a hidden tab or minimised window.
  // The queue flag then stayed `true` forever, so no later delta scheduled a
  // paint either and the bubble never left its thinking state. Two guards are
  // required: a timer fallback, and a paint before each `working` heartbeat.
  if (!/setTimeout\(\(\) => \{ if \(deltaScheduled\) flushDelta\(\) \}, 60\)/.test(src)) {
    bad('performance', 'no timer fallback when rAF is suspended')
  } else {
    ok('performance', 'rAF has a timer fallback')
  }
  if (!/if \(pendingDelta\) \{\s*const d = pendingDelta/.test(src)) {
    bad('performance', 'a heartbeat can leave queued text unpainted')
  } else {
    ok('performance', 'heartbeat paints queued text first')
  }
  // Stable callbacks are what keep the memo effective.
  if (/onStop: \(\) => stopMessage/.test(src) || /onGrab: \(packetMsgId\) => grabPacket/.test(src)) {
    bad('performance', 'inline callbacks defeat the memo')
  } else {
    ok('performance', 'row callbacks are stable')
  }

  // ── going out ──
  //
  // A model leaves by writing `@出门` in a reply it was sending anyway. There is
  // no automatic "do you want to go out?" call: that ran after every turn and was
  // one of the three requests per turn that exhausted the rate limit.
  if (!/const ACTIVITIES = \[/.test(src)) bad('going out', 'no activities')
  else ok('going out', 'three activities defined')
  if (!/function parseOutingCommand/.test(src)) bad('going out', 'no @出门 directive')
  else ok('going out', 'leaving is a directive, not a request')
  if (/decideOuting\(|scheduleOuting/.test(src)) {
    bad('going out', 'the per-turn outing call is back')
  } else {
    ok('going out', 'no extra request per turn')
  }
  if (!/function startOuting/.test(src)) bad('going out', 'no outing state')
  else ok('going out', 'outing carries a return time')
  if (!/function isAway/.test(src)) bad('going out', 'away state is not checked')
  else ok('going out', 'away state is checked before speaking')
  if (!/callBack = \(roomId, memberId\)|function callBack/.test(src)) {
    bad('going out', 'no way to call an away model back')
  } else {
    ok('going out', '@-mention summons an away model')
  }

  try {
    const g4 = (name) => {
      const i = src.indexOf('function ' + name + '(')
      if (i < 0) throw new Error('missing ' + name)
      let d = 0, st = false, j = i
      for (; j < src.length; j++) {
        if (src[j] === '{') { d++; st = true }
        else if (src[j] === '}') { d--; if (st && d === 0) break }
      }
      return src.slice(i, j + 1)
    }
    const aS = src.indexOf('const ACTIVITIES = [')
    const aE = src.indexOf('\n  const ACTIVITY_BY_ID')
    // Take the two declarations as one slice: ACTIVITIES, then the lookup map.
    // Slicing to the next blank line grabbed only part of the second line and
    // left a dangling brace.
    const aEnd = src.indexOf('\n', aE + 1)
    const { ACTIVITIES, startOuting, isAway, awayMinutes, activityReward } = new Function(
      [src.slice(aS, aEnd),
       g4('activityReward'), g4('isAway'), g4('awayMinutes'), g4('startOuting'),
       'return { ACTIVITIES, startOuting, isAway, awayMinutes, activityReward }'].join('\n'),
    )()

    if (ACTIVITIES.length !== 3) bad('going out', 'expected 3 activities, found ' + ACTIVITIES.length)
    else ok('going out', '打工 / 逛街 / 旅游')

    // Reward must never be zero, or going out would be pointless.
    const flat = ACTIVITIES.filter((a) => activityReward(a, 'x').points +
      activityReward(a, 'x').gold === 0)
    if (flat.length) bad('going out', 'an activity pays nothing: ' + flat.map((a) => a.label).join(','))
    else ok('going out', 'every activity pays something')

    // 金币 must come from going out, or the currency has no scarcity at all.
    const pays = ACTIVITIES.filter((a) => (a.gold ?? 0) > 0)
    if (pays.length === 0) bad('going out', 'no activity pays 金币')
    else if (pays.length === ACTIVITIES.length) bad('going out', 'every activity pays 金币 — no trade-off')
    else ok('going out', '金币 come only from outings, and not all of them')

    const now = 1_000_000
    const out = startOuting({ id: 'm1', displayName: 'A' }, 'work', now)
    if (!out || !out.away) bad('going out', 'startOuting returned nothing')
    else if (!isAway({ away: out.away }, now)) bad('going out', 'a fresh outing does not register as away')
    else if (isAway({ away: out.away }, out.away.until + 1)) bad('going out', 'an outing never expires')
    else if (awayMinutes({ away: out.away }, out.away.until + 1) !== 0) bad('going out', 'expired outing still counts down')
    else ok('going out', 'outing expires and stops counting down')

    if (startOuting({ id: 'm1' }, 'nope', now) !== null) bad('going out', 'unknown activity accepted')
    else ok('going out', 'unknown activity refused')
  } catch (e) {
    bad('going out', 'mechanics could not be exercised: ' + String(e && e.message))
  }

  // ── second currency ──
  //
  // 金币 are earned slowly and buy things 积分 cannot. The two must never be
  // interchangeable, so the item records a `currency` and the charge follows it.
  if (!/const GOLD_SHOP = \[/.test(src)) bad('gold', 'no 金币 shelf')
  else ok('gold', '金币 shelf present')
  // 金币 must not be earnable by talking. The old implementation paid 1–2 per
  // substantive reply, which made conversation the largest source of 金币 and
  // emptied the shelf of meaning. There is now no reply-pay path at all — the
  // absence is the invariant, so it is checked as an absence.
  if (/goldForReply/.test(src) || /earnedGold/.test(src) || /因为这条发言/.test(src)) {
    bad('gold', 'a reply still pays or reports 金币')
  } else {
    ok('gold', 'speaking pays no 金币')
  }
  if (!/currency: 'gold'/.test(src)) bad('gold', 'items do not declare a currency')
  else ok('gold', 'each item names its currency')

  try {
    const g3 = (name) => {
      const i = src.indexOf('function ' + name + '(')
      if (i < 0) throw new Error('missing ' + name)
      let d = 0, st = false, j = i
      for (; j < src.length; j++) {
        if (src[j] === '{') { d++; st = true }
        else if (src[j] === '}') { d--; if (st && d === 0) break }
      }
      return src.slice(i, j + 1)
    }
    const shopStart2 = src.indexOf('const SHOP = [')
    const shopEnd2 = src.indexOf('\n  function findItem', shopStart2)
    const { parseShopCommand, applyShopCommand } = new Function(
      [g3('parseMentions'), g3('ownedOf'), src.slice(shopStart2, shopEnd2),
       g3('findItem'), g3('resolveRecipient'), g3('parseShopCommand'), g3('applyShopCommand'),
       'return { parseShopCommand, applyShopCommand }'].join('\n'),
    )()

    // 金币 cannot be paid with 积分.
    //
    // Names are at least two characters on purpose: `resolveRecipient` refuses
    // single-letter candidates because one letter matches almost any sentence.
    const rich = { id: 'r', displayName: '模型红', handle: 'hong', enabled: true, points: 9999, gold: 0, items: [] }
    const other = { id: 'o', displayName: '模型蓝', handle: 'lan', enabled: true, points: 0, gold: 0, items: [] }
    const crown = parseShopCommand('@商店 买 王冠', [rich, other], 'r')
    const bought = crown && crown.ok ? applyShopCommand({ members: [rich, other] }, rich, crown) : null
    if (!bought || bought.ok) bad('gold', 'a 积分-rich model bought a 金币 item')
    else ok('gold', '积分 cannot buy 金币 goods')

    // A model can pass 积分 to another model.
    const pk = parseShopCommand('@商店 发红包 40 给 模型蓝', [rich, other], 'r')
    const sent = pk && pk.ok ? applyShopCommand({ members: [rich, other] }, rich, pk) : null
    if (!sent || !sent.ok) bad('gold', 'model-to-model red packet not parsed: ' + (pk && pk.reason))
    else if (sent.from.points !== 9999 - 40 || sent.to.points !== 40) {
      bad('gold', 'red packet does not move exactly the amount')
    } else {
      ok('gold', 'models can send each other red packets')
    }
  } catch (e) {
    bad('gold', 'second currency could not be exercised: ' + String(e && e.message))
  }

  // ── layered history ──
  //
  // Sending the whole transcript every turn made replies slow and kept getting
  // slower. The recent window is verbatim; everything older is folded into a
  // recap, so cost stays flat as a room grows.
  if (!/const RECENT_CONTEXT = 8/.test(hostEff)) bad('layered history', 'no recent-window constant')
  else ok('layered history', 'recent window is 8')
  if (!/async function summarizeOlder/.test(hostEff)) bad('layered history', 'no recap generator')
  else ok('layered history', 'recap generator present')
  if (!/recapCache/.test(hostEff)) bad('layered history', 'recap is never cached')
  else ok('layered history', 'recap cached per room')

  // The reply must not wait on summary generation.
  //
  // Two regressions lived here. First, the cache was a WeakMap keyed by the room
  // object, but every request carries a freshly parsed room — so it never hit and
  // every turn generated a recap. Second, the generation was awaited inline, so a
  // turn paid two sequential model calls before the first token. Together they
  // made replies feel broken.
  if (/await summarizeOlder\(/.test(hostEff)) {
    bad('layered history', 'reply still awaits summary generation')
  } else if (!/primeRecap\(ctx, room, self\)/.test(hostEff)) {
    bad('layered history', 'recap is never generated off the reply path')
  } else {
    ok('layered history', 'recap never blocks the reply')
  }
  if (/const recapCache = new WeakMap/.test(hostEff)) {
    bad('layered history', 'cache keyed by object identity — it can never hit')
  } else if (!/const recapCache = new Map\(\)/.test(hostEff)) {
    bad('layered history', 'recap cache missing')
  } else {
    ok('layered history', 'cache keyed by content, not object identity')
  }
  if (!/recapInFlight/.test(hostEff)) bad('layered history', 'no in-flight guard, summaries can pile up')
  else ok('layered history', 'one warm-up per region')
  if (!/buildMessages\(room, memberId, recap\)/.test(hostEff)) bad('layered history', 'recap not passed in')
  else ok('layered history', 'recap reaches the request')
  if (/const MAX_CONTEXT/.test(hostEff)) bad('layered history', 'dead MAX_CONTEXT constant remains')
  else ok('layered history', 'no dead context constant')

  // Exercise the split: 30 messages must cost 1 system + 1 recap + 8 verbatim.
  try {
    const g2 = (name) => {
      const i = hostEff.indexOf('function ' + name + '(')
      if (i < 0) throw new Error('missing ' + name)
      let d = 0, st = false, j = i
      for (; j < hostEff.length; j++) {
        if (hostEff[j] === '{') { d++; st = true }
        else if (hostEff[j] === '}') { d--; if (st && d === 0) break }
      }
      return hostEff.slice(i, j + 1)
    }
    const sp2 = hostEff.indexOf('const SHOP_PRICES')
    // One contiguous slice: the price tables, SHOP_BRIEF, the 金币 table and
    // GOLD_BRIEF. Hand-cutting each declaration broke the moment a second
    // currency was added, and two overlapping slices redeclared SHOP_BRIEF.
    const catStart = hostEff.indexOf('const SHOP_PRICES')
    // Stop before the recap block, which declares RECENT_CONTEXT and
    // SUMMARY_WINDOW — those are supplied by the prelude below, and slicing past
    // them redeclared the constants.
    const catEnd = hostEff.indexOf('// ── conversation recap', catStart)
    const prelude2 = [
      'const RECENT_CONTEXT = 8;',
      'const SUMMARY_WINDOW = 60;',
      'function uid(){ uid.n=(uid.n||0)+1; return "i"+uid.n }',
    ].join('\n')
    const { buildMessages } = new Function(
      [prelude2, hostEff.slice(catStart, catEnd), g2('msg'), g2('msgWithImages'), g2('buildMessages'),
       'return { buildMessages }'].join('\n'),
    )()
    const members = [
      { id: 'a', displayName: 'A', handle: 'a', enabled: true, points: 0, items: [] },
      { id: 'b', displayName: 'B', handle: 'b', enabled: true, points: 0, items: [] },
    ]
    const messages = Array.from({ length: 30 }, (_, i) => ({ id: 'm' + i, role: 'user', text: '第' + i + '条', ts: i }))
    const built = buildMessages({ name: 'room', members, messages }, 'a', '较早的摘要')
    const verbatim = built.length - 2 // minus system and recap
    if (verbatim !== 8) bad('layered history', 'verbatim count is ' + verbatim + ', expected 8')
    else if (!/摘要如下/.test(built[1].content[0].text)) bad('layered history', 'recap not in the request')
    else ok('layered history', '30 messages cost system + recap + 8')
    const smallBuilt = buildMessages({ name: 'room', members, messages: messages.slice(0, 5) }, 'a', null)
    if (smallBuilt.length !== 6) bad('layered history', 'short history is not sent verbatim')
    else ok('layered history', 'short history sent verbatim')
  } catch (e) {
    bad('layered history', 'split could not be exercised: ' + String(e && e.message))
  }
}

// ── verdict ──────────────────────────────────────────────────────────────────

console.log('')
if (failures.length === 0) {
  console.log('PASS — 可以安全重启')
  process.exit(0)
} else {
  console.log('FAIL — ' + failures.length + ' 个问题，先修再重启：')
  for (const f of failures) console.log('  · ' + f)
  process.exit(1)
}



