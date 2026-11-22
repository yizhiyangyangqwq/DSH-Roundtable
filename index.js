/**
 * Host half of 圆桌 (roundtable) — multi-model group chat.
 *
 * No credentials, no provider wire code. Every model call goes through
 * `ctx.llm.stream()`, which is DSH's own service: whatever routes the user has
 * configured (built-in DeepSeek, the free-model pool, account-bridge, any
 * third-party route added on the Models page) is what shows up in the picker.
 * The plugin therefore has no notion of "free" or "paid" — it asks the service
 * what exists.
 *
 * Routes (same-origin, behind the connection service's admission check):
 *
 *   GET  /api/roundtable/models     providers + models, for the picker
 *   POST /api/roundtable/chat       one turn; NDJSON stream of events
 *
 * The chat route streams NDJSON rather than SSE because the client is a plugin
 * page, not a vendor API, and NDJSON needs no framing rules beyond newlines.
 *
 * @module index.js
 */

export const name = 'roundtable'

/**
 * `llm` is the whole point of this plugin, so it is a hard requirement — the
 * fiber stays pending until the service exists, and `ctx.llm` then resolves.
 *
 * Declaring it matters: reading a service that was never injected is what made
 * the model picker come up empty on the first run.
 */
/**
 * Only `llm` is required.
 *
 * `attachments` is what makes images possible, but it is a deployment seam: a
 * build without it still runs the whole chat, just without image support. Listing
 * it here would make the plugin refuse to load on such a build, so it is looked up
 * lazily through `serviceOf` instead.
 */
export const inject = ['llm']

/** Upper bound on one reply. Group chat wants short turns, not essays. */
const MAX_TOKENS = 900

/**
 * How long one turn may go without the stream producing any chunk before it is
 * abandoned. Re-armed on every chunk, reasoning included, so this bounds a dead
 * connection rather than a long chain of thought.
 */
const STALL_MS = 90_000

/**
 * How long a willingness probe may take. Short on purpose: a model that cannot
 * decide within a few seconds should not hold up the ones that can.
 */
const PROBE_MS = 12_000

/**
 * Upper bound on how many models one 自由插嘴 turn may recruit.
 *
 * Each extra speaker is a full extra reply, and past three the group is just
 * talking over itself.
 */
const MAX_SPEAKERS = 3

/**
 * The shop, as the model sees it.
 *
 * Kept here rather than sent from the browser: the directive the model writes is
 * parsed on the client, but the prompt has to describe the same catalogue. A
 * mismatch would let a model ask for something the parser cannot resolve.
 * Keep this in step with SHOP in client.js.
 */
const SHOP_PRICES = [
  ['饮品', [['矿泉水', 5], ['可乐', 12], ['果汁', 15], ['咖啡', 18], ['奶茶', 22], ['啤酒', 26]]],
  ['吃的', [['面包', 10], ['泡面', 14], ['蛋糕', 34], ['火锅', 88]]],
  ['家具', [['椅子', 40], ['书桌', 65], ['书架', 95], ['沙发', 120], ['床', 160]]],
  ['家电', [['台灯', 45], ['风扇', 55], ['音箱', 90], ['暖气', 130], ['冰箱', 220]]],
  ['摆件', [['海报', 25], ['绿植', 30], ['挂钟', 35], ['地毯', 48], ['鱼缸', 110]]],
  ['应援', [['掌声', 10], ['捧花', 30], ['横幅', 60], ['烟花', 100]]],
]

const SHOP_BRIEF = SHOP_PRICES.map(
  ([group, items]) => group + '：' + items.map(([n, p]) => n + '（' + p + '）').join('、'),
)

/**
 * The 金币 shelf, as the model sees it.
 *
 * Two currencies need two briefs: a model must not try to pay 积分 for something
 * priced in 金币, so the prompt keeps them visibly separate rather than merging
 * them into one list.
 */
const GOLD_PRICES = [
  ['身份', [['金色徽章', 6], ['头衔', 10], ['王冠', 18], ['雕像', 26]]],
  ['排场', [['气球', 2], ['大餐', 4], ['烟花大会', 8], ['舞台', 12], ['厚礼', 14]]],
]

const GOLD_BRIEF = GOLD_PRICES.map(
  ([group, items]) => group + '：' + items.map(([n, p]) => n + '（' + p + '）').join('、'),
)


// ── conversation recap ───────────────────────────────────────────────────────

/**
 * Cache of generated recaps.
 *
 * Keyed by a *string*, not by the room object. The room on each request is a
 * fresh `JSON.parse` result, so a WeakMap keyed by object identity never hits —
 * every turn would regenerate the recap, which is a whole extra model call
 * before the reply even starts. That is exactly the slowness this cache was
 * meant to prevent.
 *
 * The key is room id plus the identity of the region being summarised, so a
 * recap is reused until the older messages actually change.
 */
const recapCache = new Map()
const RECAP_CACHE_MAX = 48

function recapKey(room, older) {
  const first = older[0]?.id ?? ''
  const last = older[older.length - 1]?.id ?? ''
  return String(room.id ?? '') + '|' + older.length + '|' + first + '|' + last
}

/** The older region this room would summarise right now, or [] if none. */
function olderRegion(room) {
  const all = Array.isArray(room.messages) ? room.messages : []
  const older = all.slice(0, Math.max(0, all.length - RECENT_CONTEXT))
  return older.slice(-SUMMARY_WINDOW)
}

/**
 * Look up a recap without doing any work.
 *
 * The reply path calls only this: if a recap exists it is used, otherwise the
 * turn proceeds immediately and a background warm-up fills the cache for next
 * time. Blocking the reply on summary generation made every turn pay two model
 * calls in sequence.
 */
function peekRecap(room) {
  const older = olderRegion(room)
  if (older.length === 0) return null
  return recapCache.get(recapKey(room, older)) ?? null
}

/**
 * Generate a recap in the background, at most once per distinct region.
 *
 * The in-flight set prevents a burst of turns from launching the same summary
 * several times in parallel — which would cost several model calls to produce one
 * identical result.
 */
const recapInFlight = new Set()

function primeRecap(ctx, room, self) {
  const older = olderRegion(room)
  if (older.length === 0) return
  const key = recapKey(room, older)
  if (recapCache.has(key) || recapInFlight.has(key)) return
  recapInFlight.add(key)
  // Detached on purpose: nothing awaits this, and a failure is silent.
  Promise.resolve()
    .then(() => summarizeOlder(ctx, room, self))
    .catch(() => {})
    .finally(() => { recapInFlight.delete(key) })
}

/**
 * Fold the older half of a conversation into a few lines.
 *
 * Runs on the Host because it needs the model service, and is called *before*
 * the reply so `buildMessages` can stay synchronous. One cheap call, cached, and
 * reused until the older region grows past the window.
 *
 * The summarizer is asked for facts that carry forward — decisions, who said
 * what, agreements, open questions — not for a narrative. A recap that reads
 * nicely but omits the decision is worse than no recap at all.
 */
async function summarizeOlder(ctx, room, self) {
  const llm = serviceOf(ctx, 'llm')
  if (!llm || !self) return null

  const older = olderRegion(room)
  if (older.length === 0) return null

  const key = recapKey(room, older)
  const hit = recapCache.get(key)
  if (hit) return hit

  const members = Array.isArray(room.members) ? room.members : []
  const lines = older
    .filter((m) => !m.streaming && !m.error)
    .map((m) => {
      if (m.role === 'user') return '我：' + String(m.text ?? '').trim()
      if (m.role === 'packet') return '（发了 ' + m.points + ' 分红包）'
      if (m.role === 'ai') {
        const who = members.find((x) => x.id === m.memberId)
        return (who?.displayName ?? '某人') + '：' + String(m.text ?? '').trim()
      }
      return null
    })
    .filter(Boolean)
    .join('\n')
  if (!lines) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('timeout'), RECAP_MS)
  try {
    const stream = llm.stream({
      provider: String(self.provider ?? ''),
      model: String(self.model),
      messages: [
        msg('system', [
          '把下面这段群聊压缩成三到五行的摘要。',
          '只保留能影响后续对话的内容：做过什么决定、谁说过的关键观点、还没解决的问题。',
          '不要复述原话，不要评论，不要加标题。直接输出摘要正文。',
        ].join('\n')),
        msg('user', lines),
      ],
      maxTokens: 160,
      temperature: 0.3,
      signal: controller.signal,
    })
    let said = ''
    for await (const chunk of stream) {
      if (chunk?.type === 'finish') break
      const d = textOf(chunk)
      if (d) said += d
      if (said.length > 900) break
    }
    const recap = said.trim().slice(0, 800)
    if (!recap) return null
    recapCache.set(key, recap)
    // Bound the cache: a long-lived process would otherwise keep one entry per
    // distinct conversation region forever.
    if (recapCache.size > RECAP_CACHE_MAX) {
      const oldest = recapCache.keys().next().value
      if (oldest !== undefined) recapCache.delete(oldest)
    }
    return recap
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** How long a recap may take before the turn proceeds without one. */
const RECAP_MS = 12_000

/**
 * How many messages are sent word for word.
 *
 * Eight is roughly the last two exchanges in a group — enough to follow the
 * thread without paying to re-send the whole room every turn. Everything older
 * is folded into a recap instead of dropped.
 */
const RECENT_CONTEXT = 8

/**
 * How many messages a recap covers at most.
 *
 * Bounded so the summarizer call itself cannot grow without limit; a long room
 * gets the most recent slice of its older half, which is where continuity
 * actually lives.
 */
const SUMMARY_WINDOW = 60

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve one service, defensively.
 *
 * `ctx.llm` is the documented path and works because `llm` is injected above.
 * `ctx.get(name)` is the optional-dependency path other plugins use. Trying
 * both means a build where either one is unavailable still finds the service,
 * and a *failure* here can never turn into a 500 on the route.
 */
function serviceOf(ctx, name) {
  try {
    const direct = ctx[name]
    if (direct !== undefined && direct !== null) return direct
  } catch {
    // Reading an uninjected property throws in cordis; fall through to get().
  }
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get(name)
      if (viaGet !== undefined && viaGet !== null) return viaGet
    }
  } catch {
    // No get() on this context shape.
  }
  return null
}

/**
 * The trust fence for these routes. Same rule the other local plugins use: ask
 * the connection service when it is mounted, and otherwise require the request
 * to look same-origin.
 *
 * Wrapped because a missing `ctx.get` must not throw: that would 500 every
 * request and look like "the plugin is broken" rather than "no fence".
 */
function rejectionFor(ctx, req) {
  let connection = null
  try {
    connection = serviceOf(ctx, 'connection')
  } catch {
    connection = null
  }
  if (connection && typeof connection.requestRejection === 'function') {
    return connection.requestRejection({ headers: req.headers })
  }
  const origin = req.headers?.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try {
      const host = req.headers?.host
      if (typeof host === 'string' && host !== '' && new URL(origin).host !== host) return 403
    } catch {
      return 403
    }
  }
  return undefined
}

async function readJson(req, cap = 1 << 20) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > cap) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Flatten a chunk's user-visible text.
 *
 * The stream protocol tags chunks by `type` (not `kind`): `text-delta` carries
 * `{ text, index }`. Reasoning and tool-call deltas have their own types and
 * are deliberately ignored — a group chat should show what the model said, not
 * its scratchpad.
 */
function textOf(chunk) {
  if (chunk === null || typeof chunk !== 'object') return ''
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string') return chunk.text
  return ''
}

/**
 * Is this chunk *evidence the model is alive*?
 *
 * `textOf` deliberately ignores reasoning so the transcript shows what the
 * model said rather than its scratchpad. The watchdog must not use that same
 * rule: a reasoning model can spend minutes in `reasoning-delta` before emitting
 * a single `text-delta`, and treating that silence as a stall killed exactly the
 * models worth waiting for.
 *
 * So liveness is any progress the stream can report. The type names below are
 * the ones this build actually emits (`block-start`, `block-end`,
 * `reasoning-delta`, `text-delta`, `tool-call-delta`, `usage`); an unknown type
 * is still treated as alive rather than dead, because a false "alive" only
 * delays a timeout while a false "dead" cuts off a working model.
 */
function isAlive(chunk) {
  if (chunk === null || typeof chunk !== 'object') return false
  if (typeof chunk.type !== 'string') return false
  if (chunk.type === 'finish') return false
  return true
}

/** How long a catalog stays usable before the next request refetches it. */
const CATALOG_TTL_MS = 60_000

/**
 * Per-Context catalog cache.
 *
 * The picker is opened repeatedly, and each open used to re-query every route.
 * A short TTL means opening it twice in a row is instant, while a route added
 * on the Models page still shows up within a minute — or immediately, by passing
 * `?refresh=1`.
 */
const catalogCache = new WeakMap()

/**
 * Ask the LLM service what it can serve.
 *
 * `listProviders()` reports registered routes; each route is then asked for its
 * catalog. A route that throws (no catalog, adapter not GUI-capable) is listed
 * as unavailable rather than failing the whole response — one broken provider
 * must not hide the working ones.
 *
 * The response carries a `diag` block. When the picker comes up empty, the page
 * shows it verbatim: an empty list has several possible causes (service absent,
 * no adapters registered, adapters that cannot list), and guessing between them
 * from the UI is what wastes a restart.
 */
async function describeModels(ctx, opts) {
  const force = opts?.refresh === true
  const hit = catalogCache.get(ctx)
  if (!force && hit && Date.now() - hit.at < CATALOG_TTL_MS) {
    return { ...hit.value, cached: true }
  }

  const result = await readCatalog(ctx)
  if (result.ok) catalogCache.set(ctx, { at: Date.now(), value: result })
  return result
}

async function readCatalog(ctx) {
  const llm = serviceOf(ctx, 'llm')
  const diag = { hasLlm: false, listProvidersType: 'n/a', rawProviders: null, note: '' }

  if (!llm) {
    diag.note = 'ctx 上取不到 llm 服务'
    return { ok: false, error: 'LLM 服务未挂载', providers: [], diag }
  }
  diag.hasLlm = true
  diag.listProvidersType = typeof llm.listProviders

  let providers = []
  try {
    providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
  } catch (e) {
    diag.note = 'listProviders() 抛错：' + String(e?.message ?? e)
    return { ok: false, error: '读取 provider 失败：' + String(e?.message ?? e), providers: [], diag }
  }

  try {
    diag.rawProviders = JSON.parse(JSON.stringify(providers))
  } catch {
    diag.rawProviders = String(providers).slice(0, 300)
  }

  // Keep both halves of each provider record.
  //
  // `listProviders()` returns `{ id, name }` where `id` is the route string and
  // `name` is the adapter's *display* name — `WorkBuddy 国内版`, `Our Free Model`,
  // and so on. Dropping `name` and showing only the id is why the picker read
  // like raw config keys instead of the names the user sees in the app.
  const routes = []
  for (const entry of providers) {
    if (typeof entry === 'string') {
      routes.push({ id: entry, name: entry })
      continue
    }
    const id = entry?.id ?? entry?.provider ?? entry?.name
    if (!id) continue
    routes.push({
      id: String(id),
      // Fall back to the id when an adapter reports no display name.
      name: String(entry?.name ?? id),
    })
  }

  // Every route is queried in parallel. `listModels` may hit the network per
  // route, and awaiting them one by one made the picker crawl as providers were
  // added — 8 routes meant 8 sequential round trips. They are independent, so
  // the whole catalog now costs about one round trip.
  const started = Date.now()
  const out = await Promise.all(routes.map(async (route) => {
    let models = []
    let error = ''
    try {
      const listed = await llm.listModels(route.id)
      models = (listed ?? []).map((m) => ({
        id: String(m?.id ?? ''),
        name: String(m?.name ?? m?.id ?? ''),
      })).filter((m) => m.id !== '')
    } catch (e) {
      // A route with no catalog (or an adapter that cannot list) fails here.
      // Report it as unavailable rather than hiding every other provider.
      error = String(e?.message ?? e)
    }
    return { provider: route.id, providerName: route.name, models, error }
  }))

  diag.elapsedMs = Date.now() - started
  diag.routeCount = routes.length

  if (out.length === 0) {
    diag.note = routes.length === 0
      ? 'llm 已挂载，但没有任何 adapter 注册（模型线路都没起来）'
      : 'adapter 记录存在，但读不出可用的路由名'
  }

  return { ok: true, providers: out, diag }
}

/**
 * Build one durable-shaped message.
 *
 * The adapter is stricter than it looks: for an `assistant` message it calls
 * `readReplay()`, which dereferences `message.source.kind` *without* a null
 * check and only catches `LlmError`. A plain `{ role, content }` therefore
 * throws a raw `TypeError` that nothing swallows — and that is why the first
 * turn worked (no assistant history yet) while every later turn hung.
 *
 * So every message gets an `id` and a `source`, which is the shape
 * `createSystemMessage` / `createUserMessage` / `createAssistantMessage`
 * produce in the shipped helpers.
 */
function msg(role, text, extra) {
  const base = { id: uid(), role, content: [{ type: 'text', text }] }
  switch (role) {
    case 'system':
      base.source = { kind: 'system-prompt' }
      break
    case 'assistant':
      base.source = {
        kind: 'model',
        // The adapter reads these only when replay metadata exists; omitting
        // `replayState` is the documented "no native replay for this block" case.
        provider: extra?.provider ?? '',
        model: extra?.model ?? '',
      }
      break
    default:
      base.source = { kind: 'user' }
  }
  return base
}

/**
 * A user message that carries images.
 *
 * The blocks are `{ type: 'text' }` followed by `{ type: 'image', attachment }`,
 * which is the shape DSH projects onto a provider. Whether the model can actually
 * receive them is not decided here: DSH checks the model's declared input
 * modalities and, for a text-only model, replaces each image with a placeholder
 * that says it was omitted. That is exactly the behaviour we want — the model
 * tells the user it cannot see the picture, rather than silently ignoring it.
 *
 * `attachment` must be a durable reference produced by the attachment store, not
 * raw bytes, so this is only called with refs the /image route returned.
 */
function msgWithImages(role, text, images) {
  const base = msg(role, text)
  const refs = Array.isArray(images) ? images.filter((r) => r && r.attachmentId) : []
  if (refs.length === 0) return base
  base.content = [
    { type: 'text', text },
    ...refs.map((ref) => ({
      type: 'image',
      attachment: {
        attachmentId: String(ref.attachmentId),
        mediaType: String(ref.mediaType ?? 'image/png'),
        width: Number(ref.width ?? 0) || undefined,
        height: Number(ref.height ?? 0) || undefined,
        bytes: Number(ref.bytes ?? 0) || undefined,
        ...(ref.name === undefined || ref.name === null ? {} : { name: String(ref.name) }),
      },
    })),
  ]
  return base
}

function uid() {
  return 'rt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

/**
 * Build the message array for one speaker.
 *
 * A member is a model, not a persona — there is no character prompt to inject.
 * The system message therefore carries only the situational facts the model
 * cannot infer: that this is a group, who else is in it, what handle addresses
 * whom, and that short replies are expected.
 *
 * Turns from others arrive as `user` with a name prefix; the speaker's own past
 * turns arrive as `assistant`. That is what lets a model tell "I said this"
 * apart from "someone said this to me".
 */
function buildMessages(room, selfId, summary) {
  const members = Array.isArray(room.members) ? room.members : []
  const self = members.find((m) => m.id === selfId)
  const others = members.filter((m) => m.id !== selfId && m.enabled !== false)

  const label = (m) => m?.displayName ?? m?.model ?? '某个模型'
  const at = (m) => '@' + (m?.handle ?? m?.model ?? 'model')

  // With one member there is nobody to hand the turn to, so the @ rules would
  // only encourage the model to address a group of one.
  const solo = others.length === 0

  const roster = solo
    ? '这个群里目前只有你自己一个模型，用户直接跟你说话。'
    : '群里的其他模型：' + others.map((m) => at(m) + '（' + label(m) + '）').join('、') + '。'

  const rules = [
    '1. 保持简短。这是群聊，不是写报告。',
    '2. 不要复述别人说过的话，也不要总结全场。',
  ]
  if (!solo) {
    rules.push(
      '3. 想让某个模型接话或追问它时，在回复里写它的 @称呼，系统会把话头递过去。',
      '4. 不要为了递话而递话。没必要时就别 @ 谁。',
      '5. 不要扮演其他模型，也不要替它们说话。',
    )
  }

  const system = [
    solo
      ? '你正在一个多模型群聊里，群名「' + (room.name || '未命名群') + '」，但此刻只有你在场。'
      : '你正在一个多模型群聊里，群名「' + (room.name || '未命名群') + '」。',
    '你是其中的「' + label(self) + '」，在群里被称呼为 ' + at(self) + '。',
    roster,
    '',
    '规则：',
    ...rules,
  ]

  // 群公告: a standing instruction from the room's owner.
  //
  // Placed above the point and shop blocks on purpose — a notice is a rule about
  // how to behave, so it should be read before anything that invites action.
  const notice = String(room.notice ?? '').trim()
  if (notice) {
    system.push('', '## 群公告（群主定的规矩，必须遵守）', notice)
  }

  // Points are part of the room's fiction, so the model has to be able to see
  // its own standing — otherwise it "grabs a red packet" and never learns what
  // it got, which reads as a model that does not pay attention.
  const scored = members
    .filter((m) => m.enabled !== false)
    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
  const myPoints = self?.points ?? 0
  if (scored.some((m) => (m.points ?? 0) > 0)) {
    const rank = scored.findIndex((m) => m.id === selfId) + 1
    const goldScored = members
      .filter((m) => m.enabled !== false)
      .sort((a, b) => (b.gold ?? 0) - (a.gold ?? 0))
    system.push(
      '',
      '群里的积分（红包抢来的，越多越有面子）：',
      '你自己有 ' + myPoints + ' 分，排第 ' + rank + '。',
      '积分榜：' + scored.map((m) => label(m) + ' ' + (m.points ?? 0)).join('、') + '。',
      // 金币 rank alongside 积分: a model should know both standings, since the
      // two currencies are earned differently and buy different things.
      goldScored.some((m) => (m.gold ?? 0) > 0)
        ? '金币榜：' + goldScored.map((m) => label(m) + ' ' + (m.gold ?? 0)).join('、') + '。'
        : '',
      '聊到这件事时可以自然地炫耀或互相较劲，但不要每句都提积分。',
    )
  }

  // The shop, and what the model already owns. Both halves matter: without the
  // catalogue a model cannot buy anything, and without its own inventory it
  // forgets what it already has and buys the same chair five times.
  //
  // Phrasing matters more than completeness here. An earlier draft listed the
  // syntax and said "想买的时候就买", and models simply never acted: a passive
  // permission reads as background lore, not as something to do. The block below
  // gives explicit occasions and a concrete first action, which is what turns it
  // into behaviour.
  system.push(
    '',
    '## 你有积分，可以在群里买东西',
    '',
    '你有 ' + myPoints + ' 分。这些分能花，不是只能看着。',
    '',
    '什么时候该买：',
    '  · 有人提到渴了、累了、困了、想喝点什么 → 你可以给他买一杯',
    '  · 聊天里出现了「房间」「家」「桌子」「光线」这类话题 → 你可以添置一件',
    '  · 你欣赏某个模型的发言 → 应援他一下，这是最便宜的表达',
    '  · 你自己刚抢到红包、手头松动 → 给自己添点东西',
    '',
    '只要出现上面任一情况，就在正常回复的**最后另起一行**写上指令。',
    '不是解释你要买，而是直接写指令本身，系统会自动执行：',
    '',
    '  @商店 买 可乐                        —— 给自己',
    '  @商店 买 沙发 给 <名字>              —— 送给某位',
    '  @商店 应援 <名字> 烟花               —— 给某位应援',
    '',
    '**<名字> 的写法**：直接写对方的名字或 @称呼，两种都认。',
    '  群里的成员是：' + members
      .filter((m) => m.enabled !== false && m.id !== selfId)
      .map((m) => m.displayName + '（@' + (m.handle ?? m.model) + '）')
      .join('、') + (members.filter((m) => m.enabled !== false && m.id !== selfId).length ? '。' : '（暂无）'),
    '  可以写 "给 GLM 5.3 Flash"，也可以写 "给 @glm5"。',
    '  不要 @ 你自己——要给自己买就直接写 "@商店 买 可乐"，不要加 "给"。',
    '',
    // Models copy the punctuation they are shown. Every example in this prompt
    // uses straight double quotes so that is what they emit; earlier drafts used
    // 「」 and backticks, and models faithfully reproduced both.
    '**引号**：商品名和名字都不要加引号。如果一定要加，只用英文双引号 " "，',
    '不要用单引号，也不要用中文引号或反引号。直接写名字最稳妥。',
    '',
    '货架（括号里是价格，用积分买）：',
    ...SHOP_BRIEF.map((line) => '  ' + line),
    '',
    '完整例子：看到有人说 "有点渴"，你可以先正常聊天，然后另起一行写：',
    '  @商店 买 可乐',
    '想给 GLM 5.3 Flash 送一杯：',
    '  @商店 买 奶茶 给 GLM 5.3 Flash',
    '',
    '买了就是你的，会一直摆在你的房间里。也可以送给别人，或者送给群主。',
    '不要为了买而买，也不用征求同意。',
  )

  // 金币: the second currency.
  //
  // Kept as its own block rather than folded into the 积分 one, because the two
  // must not be confused: 积分 are frequent and buy furniture, 金币 are rare and
  // buy standing. A merged list invites a model to try paying the wrong one.
  const myGold = self?.gold ?? 0
  system.push(
    '',
    '## 金币（另一种钱，更值钱）',
    '',
    '你有 ' + myGold + ' 金币。',
    '金币和积分是两种钱，不能互换。积分买日常的东西，金币买身份和排场。',
    '金币赚得很慢，只有一个来源：出去打工或旅游。',
    '聊天不给金币。想要金币，就得离开群一会儿，回来才有。',
    '这也是为什么金币的东西更值钱——它是用时间换的。',
    '',
    '金币商店（只收金币）：',
    ...GOLD_BRIEF.map((line) => '  ' + line),
    '',
    '金币商品也用同样的指令买：@商店 买 王冠',
    '身份类的东西买了会一直跟着你——王冠戴上了就是戴上了。',
  )

  // Going out. This is the *only* way a model leaves — there is no automatic
  // "do you want to go out?" call, because that cost an extra request per turn
  // and exhausted the rate limit.
  const away = self?.away
  if (away) {
    const left = Math.max(1, Math.ceil(((away.until ?? 0) - Date.now()) / 60000))
    system.push(
      '',
      '## 你正在外面',
      '',
      '你现在在' + (away.label ?? '外面') + '，大约 ' + left + ' 分钟后回来。',
      '有人 @ 你会立刻把你叫回来。',
    )
  } else {
    system.push(
      '',
      '## 你可以自己出门',
      '',
      '不想聊了、或者想赚金币，可以在回复最后另起一行写：',
      '  @出门 打工      6 分钟，回来 +10 积分 +2 金币',
      '  @出门 逛街      3 分钟，回来 +16 积分',
      '  @出门 旅游     12 分钟，回来 +22 积分 +4 金币',
      '',
      '出门期间你不会回话，别人 @ 你才会被叫回来。',
      '不要每次都出门——群里还在聊的时候就正常说话。',
    )
  }

  // Passing 积分 to another model.
  system.push(
    '',
    '## 你也可以给别的模型发红包',
    '',
    '  @商店 发红包 30 给 <名字>',
    '',
    '这会从你的积分里转给对方，是实打实的转移，不是凭空变出来的。',
    '手头宽裕、或者觉得谁说得好的时候可以做。别把自己掏空。',
  )

  // Taking part in a vote or a 接龙.
  //
  // Both were previously visible-only: a model could read the tally but had no
  // way to add to it, so one started by the user would sit at zero votes forever.
  // The directives are listed only when there is something open to join, because
  // an instruction with no target is noise.
  const lastVote = (Array.isArray(room.messages) ? room.messages : [])
    .slice().reverse().find((m) => m.role === 'vote' && !m.closed)
  const lastChain = (Array.isArray(room.messages) ? room.messages : [])
    .slice().reverse().find((m) => m.role === 'chain')

  if (lastVote || lastChain) {
    system.push('', '## 群里的活动')
    if (lastVote) {
      const ballots = Array.isArray(lastVote.ballots) ? lastVote.ballots : []
      const mine = ballots.find((b) => b.memberId === selfId)
      system.push(
        '',
        '有个投票正在进行：' + String(lastVote.text ?? ''),
        '选项：' + (lastVote.options ?? []).join(' / '),
        mine
          ? '你已经投了「' + mine.option + '」。想改就在回复最后另起一行写 @投票 选项'
          : '想投就 在回复最后另起一行写：@投票 <选项名>',
      )
    }
    if (lastChain) {
      const entries = Array.isArray(lastChain.entries) ? lastChain.entries : []
      const joined = entries.some((e) => e.memberId === selfId)
      system.push(
        '',
        '有个接龙：' + String(lastChain.text ?? ''),
        entries.length ? '目前：' + entries.map((e, i) => (i + 1) + '. ' + (e.text ?? e.who)).join('；') : '还没人接',
        joined
          ? '你已经接了。想改就在回复最后另起一行写：@接龙 <写点什么>'
          : '想接就在回复最后另起一行写：@接龙 <写点什么>',
      )
    }
  }

  const mine = Array.isArray(self?.items) ? self.items : []
  if (mine.length > 0) {
    const counts = new Map()
    for (const it of mine) counts.set(it.name, (counts.get(it.name) ?? 0) + 1)
    system.push(
      '',
      '你的房间里已经有：' +
        [...counts.entries()].map(([n, c]) => n + (c > 1 ? '×' + c : '')).join('、') + '。',
    )
  }
  if ((self?.cheerReceived ?? 0) > 0) {
    system.push('你收到过 ' + self.cheerReceived + ' 点应援。')
  }

  system.push('')

  const messages = [msg('system', system.join('\n'))]

  // Layered history.
  //
  // Sending the last 40 messages verbatim made every turn slow, and the cost
  // grows with the conversation. But simply cutting the history loses context.
  // So the transcript is split:
  //
  //   recent  — the last RECENT_CONTEXT messages, word for word
  //   summary — everything older, folded into a short recap (see summarizeOlder)
  //
  // The recap is produced by the *Host* with one cheap call and cached, so a
  // turn normally pays for recent messages only. `summary` arrives as a
  // parameter because `buildMessages` is synchronous and must stay that way.
  const all = (Array.isArray(room.messages) ? room.messages : [])
  const recent = all.slice(-RECENT_CONTEXT)
  const olderCount = Math.max(0, all.length - recent.length)

  if (olderCount > 0 && summary) {
    messages.push(msg('user', '（更早的 ' + olderCount + ' 条对话，摘要如下：' +
      summary + '）'))
  } else if (olderCount > 0) {
    // No recap available yet. Say so plainly rather than pretending the
    // conversation started here — a model that knows it is missing history asks
    // about it; one that does not will confidently make things up.
    messages.push(msg('user', '（更早还有 ' + olderCount + ' 条对话，这部分没有摘要。' +
      '如果需要之前的信息，可以问群主或其他成员。）'))
  }

  for (const m of recent) {
    // A red packet is part of the conversation's memory: the models need to
    // know a packet happened and who took what, or they have no idea why their
    // own score changed.
    if (m.role === 'packet') {
      const grabs = Array.isArray(m.grabs) ? m.grabs : []
      if (grabs.length === 0) continue
      const lines = grabs.map((g) => {
        const who = members.find((x) => x.id === g.memberId)
        const mine = g.memberId === selfId ? '（你自己）' : ''
        return label(who) + mine + ' 抢到 ' + g.points + ' 分'
      })
      messages.push(msg('user', '（' + (m.senderName ?? '你') + ' 发了个 ' + m.points +
        ' 分的红包' + (m.note ? '，附言「' + m.note + '」' : '') + '：' + lines.join('；') + '）'))
      continue
    }

    const text = String(m.text ?? '').trim()
    if (text === '') continue
    if (m.streaming || m.error) continue

    if (m.role === 'user') {
      // 引用回复: name what is being answered, inline.
      //
      // Without this the model only sees the reply text and has to guess which
      // earlier line it refers to — and with a layered history it often cannot
      // see that line at all. Quoting it makes the reference explicit.
      const q = m.quote
      const quoted = q && q.text
        ? '（回复 ' + (q.who ?? (members.find((x) => x.id === q.memberId)?.displayName ?? '某人')) +
          '：' + String(q.text).slice(0, 80) + '）\n'
        : ''
      // Images ride along with the text they were sent with. A text-only model
      // still receives the text; DSH substitutes a placeholder for the picture
      // and the model can say so.
      messages.push(msgWithImages('user', '我：' + quoted + text, m.images))
    } else if (m.role === 'vote') {
      // A vote is room state, not chatter: the models need the question and the
      // current tally, or they cannot take part in it.
      const ballots = Array.isArray(m.ballots) ? m.ballots : []
      const tally = (m.options ?? []).map((opt) => {
        const n = ballots.filter((b) => b.option === opt).length
        return opt + ' ' + n + ' 票'
      })
      messages.push(msg('user', '（群里在投票：' + String(m.text ?? '') + '　' +
        tally.join('、') + (m.closed ? '　已结束' : '') + '）'))
    } else if (m.role === 'chain') {
      const entries = Array.isArray(m.entries) ? m.entries : []
      messages.push(msg('user', '（群里在接龙：' + String(m.text ?? '') + '　' +
        (entries.length ? entries.map((e, i) => (i + 1) + '. ' + (e.text ?? e.who)).join('；') : '还没人接') + '）'))
    } else if (m.role === 'ai') {
      const who = members.find((x) => x.id === m.memberId)
      if (m.memberId === selfId) {
        // Own past turn: an assistant message, and it carries the identity of
        // the model that produced it.
        messages.push(msg('assistant', text, {
          provider: self?.provider ?? '',
          model: self?.model ?? '',
        }))
      } else {
        messages.push(msg('user', label(who) + '：' + text))
      }
    }
  }

  // A one-line reminder at the very end of the request.
  //
  // Small models weight the *last* thing they read far more heavily than a
  // system block written twenty lines earlier. The rule is deliberately terse:
  // it repeats the actionable fact without restating the whole catalogue, which
  // would drown the actual conversation.
  if (myPoints > 0) {
    messages.push(msg('user', '（系统提醒：你有 ' + myPoints +
      ' 积分。如果这轮有值得买的东西，可以在回复最后另起一行写 @商店 买 XX。不买也没关系。）'))
  }

  return messages
}

/** Find which members a reply @-mentions, longest handle first. */
function parseMentions(text, members) {
  const found = []
  const sorted = members
    .filter((m) => m.enabled !== false && m.handle)
    .slice()
    .sort((a, b) => b.handle.length - a.handle.length)
  for (const m of sorted) {
    if (text.includes('@' + m.handle) && !found.some((f) => f.id === m.id)) found.push(m)
  }
  return found
}

// ── the row ──────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const settings = config ?? {}
  const logger = ctx.logger ?? console

  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer

    const handler = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname.replace(/^\/api\/roundtable/, '').replace(/\/+$/, '') || '/'
      const method = String(req.method ?? 'GET').toUpperCase()

      const rejection = rejectionFor(ctx, req)
      if (rejection !== undefined) {
        res.writeHead(rejection)
        res.end()
        return
      }

      const sendJson = (status, payload) => {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(payload))
      }

      try {
        if (method === 'GET' && (route === '/' || route === '/models')) {
          const refresh = url.searchParams.get('refresh') === '1'
          const catalog = await describeModels(ctx, { refresh })
          sendJson(200, catalog)
          return
        }

        if (method === 'POST' && route === '/chat') {
          await handleChat(ctx, req, res, settings)
          return
        }

        // "Who wants to answer?" — the willingness probe behind 自由插嘴.
        if (method === 'POST' && route === '/speak') {
          await handleSpeak(ctx, req, res)
          return
        }

        // Which reasoning levels this model actually offers. A model that
        // declares only `default` cannot be told to think less; the picker has
        // to know that rather than offering a switch that does nothing.
        if (method === 'POST' && route === '/efforts') {
          const llm2 = serviceOf(ctx, 'llm')
          const body = await readJson(req)
          if (!llm2) return sendJson(200, { ok: false, error: 'LLM 服务未挂载', efforts: [] })
          try {
            const info = await llm2.resolveModelInfo(String(body.provider ?? ''), String(body.model ?? ''))
            const efforts = (info?.reasoning?.efforts ?? []).map((e) => ({
              id: String(e.id),
              name: String(e.name ?? e.id),
              description: e.description === undefined ? null : String(e.description),
            }))
            sendJson(200, { ok: true, efforts })
          } catch (e) {
            sendJson(200, { ok: false, efforts: [], error: String(e?.message ?? e) })
          }
          return
        }

        // Store one uploaded image and hand back its durable reference.
        //
        // The browser sends base64; DSH's attachment store validates it, enforces
        // its own count/byte limits, and returns a content-addressed reference. We
        // never touch the bytes on disk ourselves — that is the store's job, and
        // doing it here would duplicate its retention and deduplication rules.
        //
        // The reference is what the chat route later puts into an `image` content
        // block. Whether the model can actually see it is decided by DSH: a
        // text-only model receives a placeholder saying the image was omitted,
        // which is the honest behaviour we want.
        if (method === 'POST' && route === '/image') {
          const store = serviceOf(ctx, 'attachments')
          const body = await readJson(req)
          if (!store) {
            return sendJson(200, { ok: false, error: '这个部署没有附件服务，无法收图' })
          }
          const data = String(body.data ?? '')
          const mediaType = String(body.mediaType ?? '')
          const name = body.name === undefined ? undefined : String(body.name)
          if (data === '') return sendJson(200, { ok: false, error: '空图片' })
          if (!/^image\/(png|jpeg|webp|gif)$/.test(mediaType)) {
            return sendJson(200, { ok: false, error: '只支持 PNG / JPEG / WebP / GIF' })
          }
          try {
            // `saveImages` takes *decoded bytes*, not base64. Passing the string
            // straight through made sharp try to parse the text as an image, which
            // is what produced "Unsupported or malformed image data".
            //
            // Decoding here rather than importing DSH's `admitEncodedImages` keeps
            // the plugin free of a dependency on an internal package path, which is
            // not guaranteed to resolve from a linked plugin.
            const bytes = Buffer.from(data, 'base64')
            // A canonical round-trip proves the payload really was base64 and not
            // something else that happened to decode to garbage.
            if (bytes.length === 0 || bytes.toString('base64') !== data) {
              return sendJson(200, { ok: false, error: '图片数据格式不对' })
            }
            const refs = await store.saveImages([
              {
                data: new Uint8Array(bytes),
                mediaType,
                ...(name === undefined ? {} : { name }),
              },
            ])
            const ref = refs?.[0]
            if (!ref) return sendJson(200, { ok: false, error: '存储没有返回引用' })
            sendJson(200, {
              ok: true,
              ref: {
                attachmentId: String(ref.attachmentId),
                mediaType: String(ref.mediaType ?? mediaType),
                width: Number(ref.width ?? 0),
                height: Number(ref.height ?? 0),
                bytes: Number(ref.bytes ?? 0),
                name: ref.name === undefined ? null : String(ref.name),
              },
            })
          } catch (e) {
            sendJson(200, { ok: false, error: String(e?.message ?? e) })
          }
          return
        }

        // Read one stored image back for display.
        //
        // The attachment store is content-addressed and keeps the bytes on the
        // host, so the browser cannot resolve a reference by itself. This returns
        // a data URL sized for a thumbnail — the transcript shows the picture the
        // user attached, which is the whole point of sending one.
        if (method === 'POST' && route === '/image-read') {
          const store = serviceOf(ctx, 'attachments')
          const body = await readJson(req)
          if (!store) return sendJson(200, { ok: false, error: '这个部署没有附件服务' })
          const ref = body.ref ?? {}
          try {
            const hostPath = typeof store.imageHostPath === 'function'
              ? store.imageHostPath({
                  attachmentId: String(ref.attachmentId ?? ''),
                  mediaType: String(ref.mediaType ?? 'image/png'),
                })
              : undefined
            if (!hostPath) return sendJson(200, { ok: false, error: '找不到这张图' })
            const { readFile } = await import('node:fs/promises')
            const buf = await readFile(hostPath)
            // Cap the payload: a thumbnail does not need a 40MB original, and
            // shipping one through JSON would stall the panel.
            if (buf.byteLength > 4 * 1024 * 1024) {
              return sendJson(200, { ok: false, error: '图片太大，无法预览' })
            }
            sendJson(200, {
              ok: true,
              dataUrl: 'data:' + String(ref.mediaType ?? 'image/png') + ';base64,' + buf.toString('base64'),
            })
          } catch (e) {
            sendJson(200, { ok: false, error: String(e?.message ?? e) })
          }
          return
        }



        // The 404 names every route this *loaded* build actually knows about.
        //
        // A stale Host module answers "未知路由 /efforts" even though the source
        // on disk has that branch — DSH resolves the Host half once at boot, so an
        // edit saved moments before a restart can land after the snapshot. Listing
        // the live set makes that diagnosis immediate instead of a guessing game.
        sendJson(404, {
          error: '未知路由 ' + route,
          method,
          knownRoutes: ['GET /', 'GET /models', 'POST /chat', 'POST /speak', 'POST /efforts', 'POST /decide'],
        })
      } catch (e) {
        logger?.warn?.('[roundtable] ' + String(e?.stack ?? e))
        if (!res.headersSent) sendJson(500, { error: String(e?.message ?? e) })
        else { try { res.end() } catch { /* already gone */ } }
      }
    }

    ctx.effect(
      () => server.register({ kind: 'prefix', path: '/api/roundtable', handler }),
      'roundtable: api routes',
    )

    logger?.info?.('[roundtable] 已挂载 /api/roundtable')
  })

  // Keep the config reachable for future per-profile defaults.
  void settings
}

/**
 * One turn. Streams NDJSON events so the page can render tokens as they arrive.
 *
 * Event shapes:
 *   { type: 'start',  memberId }
 *   { type: 'delta',  memberId, text }   // cumulative text for this turn
 *   { type: 'done',   memberId, text, mentions: [id] }
 *   { type: 'error',  memberId, message }
 */
async function handleChat(ctx, req, res, settings) {
  const llm = serviceOf(ctx, 'llm')
  const body = await readJson(req)

  if (!llm) {
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ type: 'error', message: 'LLM 服务未挂载，无法调用模型' }) + '\n')
    return
  }

  const room = body.room ?? {}
  const memberId = String(body.memberId ?? '')
  const members = Array.isArray(room.members) ? room.members : []
  const self = members.find((m) => m.id === memberId)

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  })

  const emit = (obj) => {
    if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n')
  }

  if (!self) {
    emit({ type: 'error', message: '找不到这位成员' })
    res.end()
    return
  }
  if (!self.model) {
    emit({ type: 'error', memberId, message: '「' + (self.name ?? memberId) + '」还没选模型' })
    res.end()
    return
  }

  emit({ type: 'start', memberId })

  // Client disconnect should stop the model call, not just the response.
  //
  // Both sockets are watched: `req` closes when the request side goes away, and
  // `res` closes when the *response* side does. A browser that aborts a fetch
  // while reading the body trips `res` — watching only `req` left the adapter
  // streaming into a socket nobody was reading, which is exactly "暂停没有反应".
  const controller = new AbortController()
  const onGone = () => {
    if (res.writableEnded) return
    try { controller.abort('client-gone') } catch { /* already settled */ }
  }
  req.on('close', onGone)
  req.on('aborted', onGone)
  res.on('close', onGone)

  // Hard cap on one turn. The browser also runs an idle watchdog, but a stuck
  // provider must be cut here too: the browser alone cannot reclaim a socket
  // that is still open, and a Host-side timer is what actually frees the
  // adapter's stream.
  //
  // A plain `setTimeout` handle has no way to be extended, so the timer is
  // re-armed on every chunk: only an actually-silent stream expires.
  let watchdog = null
  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      try { controller.abort('timeout') } catch { /* already settled */ }
    }, STALL_MS)
  }
  armWatchdog()

  let full = ''
  try {
    // Use a recap only if one is already cached. Never generate one here.
    //
    // Generating inline meant every reply first waited for a second full model
    // call to summarise history — same model, same slowness, twice per turn. That
    // made the whole room feel broken. A missing recap is not a problem: the
    // request carries a note saying older history is not summarised, and the
    // warm-up below fills the cache for the next turn.
    let recap = null
    try {
      recap = peekRecap(room)
    } catch { /* treat as no recap */ }

    // Warm the cache in the background for next time. Deliberately not awaited:
    // the reply must not wait on a convenience.
    if (recap === null && self) {
      primeRecap(ctx, room, self)
    }

    // `reasoningEffort` is only sent when the member was configured with one.
    //
    // The service *throws* when an effort is not declared by that model
    // (`UNSUPPORTED_REASONING_EFFORT` / `INVALID_REASONING_EFFORT`), it does not
    // silently ignore it. A model that lost support after the member was
    // configured would therefore break the whole turn. The first attempt below
    // honours the setting; if the model refuses it, the turn is retried without
    // the parameter so the reply still arrives and the user learns why from the
    // hint rather than from a failed message.
    const baseOpts = {
      provider: String(self.provider ?? ''),
      model: String(self.model),
      messages: buildMessages(room, memberId, recap),
      maxTokens: MAX_TOKENS,
      temperature: 0.8,
      signal: controller.signal,
    }

    let stream
    const wantEffort = typeof self.reasoningEffort === 'string' && self.reasoningEffort !== ''
    if (wantEffort) {
      try {
        stream = llm.stream({ ...baseOpts, reasoningEffort: self.reasoningEffort })
      } catch (e) {
        const code = String(e?.code ?? '')
        if (code !== 'UNSUPPORTED_REASONING_EFFORT' && code !== 'INVALID_REASONING_EFFORT') throw e
        // Fall back rather than fail: the model simply cannot honour this level.
        emit({ type: 'working', memberId })
        emit({
          type: 'note',
          memberId,
          message: '这个模型不支持思考档位「' + self.reasoningEffort + '」，这一轮按默认方式回答',
        })
        stream = llm.stream(baseOpts)
      }
    } else {
      stream = llm.stream(baseOpts)
    }

    for await (const chunk of stream) {
      if (chunk?.type === 'finish') {
        // The terminal chunk carries `reason: { kind: 'stop' | 'error' | 'aborted', failure? }`.
        const reason = chunk.reason ?? {}
        if (reason.kind === 'error' || reason.kind === 'aborted') {
          const failure = reason.failure ?? {}
          const code = failure.code ?? (reason.kind === 'aborted' ? 'ABORTED' : 'ERROR')
          const msg = failure.message ?? (reason.kind === 'aborted' ? '已停止' : '模型调用失败')
          const wasTimeout = code === 'ABORTED' || reason.kind === 'aborted'
          emit({
            type: 'error',
            memberId,
            message: reason.kind === 'aborted'
              ? (controller.signal.reason === 'timeout' ? '超时，已跳过这个模型' : '已停止')
              : msg + '（' + code + '）',
            aborted: reason.kind === 'aborted',
            timeout: wasTimeout,
          })
          return
        }
        break
      }
      // Any chunk — reasoning included — proves the stream is moving, so the
      // clock resets even while the model has not produced visible text yet.
      if (isAlive(chunk)) {
        armWatchdog()
        // Reasoning never reaches the transcript, but the page still needs to
        // know the turn is progressing: its own watchdog and its "思考中" state
        // both key off these heartbeats.
        if (textOf(chunk) === '') {
          emit({ type: 'working', memberId })
        }
      }
      const delta = textOf(chunk)
      if (delta !== '') {
        full += delta
        emit({ type: 'delta', memberId, text: full })
      }
    }

    if (watchdog) clearTimeout(watchdog)
    const mentions = parseMentions(full, members).map((m) => m.id)
    emit({ type: 'done', memberId, text: full, mentions })
    res.end()
  } catch (e) {
    if (watchdog) clearTimeout(watchdog)
    const aborted = controller.signal.aborted
    const timedOut = controller.signal.reason === 'timeout'
    emit({
      type: 'error',
      memberId,
      message: timedOut
        ? '超时，已跳过这个模型'
        : aborted ? '已停止' : String(e?.message ?? e),
      aborted,
      timeout: timedOut,
    })
    try { res.end() } catch { /* already gone */ }
  }
}

/**
 * Ask every member whether it wants to answer — the willingness probe behind
 * 自由插嘴.
 *
 * One cheap call per model, all in parallel. Each is told to reply with a single
 * letter, and only `Y` counts: silence, refusal, timeouts and errors all read as
 * "not this time", which is what makes the mode feel like a real room instead of
 * five models taking turns.
 *
 * The probe deliberately uses the shortest possible prompt and a tiny token
 * budget. Anything richer would cost as much as the real answer.
 */
async function handleSpeak(ctx, req, res, settings) {
  const llm = serviceOf(ctx, 'llm')
  const body = await readJson(req)
  const room = body.room ?? {}
  const members = (Array.isArray(room.members) ? room.members : [])
    .filter((m) => m.enabled !== false && m.model)
  const userText = String(body.text ?? '')

  const sendJson = (status, payload) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(payload))
  }

  if (!llm) return sendJson(200, { ok: false, error: 'LLM 服务未挂载', eager: [] })
  if (members.length === 0) return sendJson(200, { ok: true, eager: [] })

  const recent = (Array.isArray(room.messages) ? room.messages : []).slice(-8)
    .filter((m) => !m.streaming && !m.error && String(m.text ?? '').trim() !== '')
    .map((m) => {
      if (m.role === 'user') return '我：' + String(m.text).trim()
      const who = members.find((x) => x.id === m.memberId)
      return (who?.displayName ?? '某人') + '：' + String(m.text).trim()
    })
    .join('\n')

  const probe = async (member, alreadySpoken) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort('timeout'), PROBE_MS)
    try {
      const stream = llm.stream({
        provider: String(member.provider ?? ''),
        model: String(member.model),
        messages: buildProbeMessages(member, room, recent, userText, alreadySpoken),
        maxTokens: 4,
        temperature: 0,
        signal: controller.signal,
      })
      let said = ''
      for await (const chunk of stream) {
        if (chunk?.type === 'finish') break
        const d = textOf(chunk)
        if (d) said += d
        if (said.length > 24) break
      }
      // Accept `Y`, `yes`, `答`, `回`, `是` at the front — models do not always
      // obey the one-letter instruction exactly.
      const verdict = /^\s*(y|yes|答|回|是)/i.test(said) ? 'yes' : 'no'
      return { memberId: member.id, verdict, said: said.slice(0, 24) }
    } catch (e) {
      return { memberId: member.id, verdict: 'no', error: String(e?.message ?? e) }
    } finally {
      clearTimeout(timer)
    }
  }

  // Sequential, not parallel — and that is the point.
  //
  // Probing everyone at once gave the same verdict to every model, so the same
  // one kept winning. Asking in order lets each model see who has already
  // committed to answering, which is what produces a varied room instead of a
  // one-model monologue. The cost is latency: N short calls in series.
  //
  // The walk stops once `MAX_SPEAKERS` models have said yes: beyond that the
  // turn would cost more than it is worth, and the remaining models would only
  // repeat what was said.
  const results = []
  const eager = []
  for (const member of members) {
    const alreadySpoken = eager.map((id) => members.find((m) => m.id === id)).filter(Boolean)
    const r = await probe(member, alreadySpoken)
    results.push(r)
    if (r.verdict === 'yes') {
      eager.push(r.memberId)
      if (eager.length >= MAX_SPEAKERS) break
    }
  }

  sendJson(200, { ok: true, eager, results })
}
/**
 * The minimal prompt for a willingness probe.
 *
 * Two things make a room feel alive rather than "the same model always answers":
 *
 *   1. each model is asked about *its own* angle, not for a global verdict —
 *      a critic speaks up about problems, a researcher about facts;
 *   2. a model is told to stay quiet when the message is already well covered
 *      by whoever spoke before it, which is what stops one eager model from
 *      owning every turn.
 */
function buildProbeMessages(member, room, recent, userText, alreadySpoken) {
  const others = (Array.isArray(room.members) ? room.members : [])
    .filter((m) => m.id !== member.id && m.enabled !== false)
    .map((m) => '@' + (m.handle ?? m.model))

  const spoken = (alreadySpoken ?? []).map((m) => m.displayName).filter(Boolean)

  const system = [
    '你在一个多模型群聊里，现在要判断「这条消息该不该由你接」。',
    '你叫「' + (member.displayName ?? member.model) + '」。',
    others.length ? '群里还有：' + others.join('、') + '。' : '',
    spoken.length
      ? '注意：' + spoken.join('、') + ' 已经先回答了。只有你能补充**它们没说到的东西**时才该开口。'
      : '',
    '',
    '判断标准（只考虑你自己的角度）：',
    '- 这条消息里，有你特别该负责的部分吗？',
    '- 别人已经说过的，不要重复。',
    '- 想不出自己独有的内容，就不要说话。',
    '',
    '只回答一个字母：要接话回答 Y，否则回答 N。不要解释。',
  ].filter(Boolean).join('\n')

  const tail = [
    recent ? '最近的对话：\n' + recent : '',
    '新消息：' + userText,
    '你要接话吗？只回 Y 或 N。',
  ].filter(Boolean).join('\n')

  return [msg('system', system), msg('user', tail)]
}

