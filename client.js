/**
 * Browser half of 圆桌 (roundtable) — multi-model group chat.
 *
 * A member **is** a model. There is no persona layer: you add a model, and that
 * model appears in the group under its own name and its own generated avatar.
 * What it says is what that model says.
 *
 * Every call goes through the Host route `/api/roundtable/chat`, which calls
 * `ctx.llm` — so no credential reaches this file, and the picker offers exactly
 * the routes the user configured in DSH.
 *
 * ## Why the safety net lives inside the factory, not around the file
 *
 * The combo packer concatenates every plugin's `client.js` into one script. The
 * shipped plugins all call `window.__ModuleLoader__.load` straight from module
 * scope with no wrapping block, so this one does too — a whole-file `try` plus a
 * second top-level `let` changes the shape the packer derives its bundle from.
 *
 * The guards therefore sit *inside*: `factory` catches a missing `react`, and
 * `apply` catches every registration step, so a failure shows a diagnostic
 * panel instead of taking the whole Web frontend down.
 */
window.__ModuleLoader__.load({
  id: '@local/roundtable',
  factory: (require) => {
    let React
    let h
    try {
      React = require('react')
      h = React.createElement
    } catch (e) {
      // Without react there is nothing to render; degrade to an inert stub.
      return {
        name: 'roundtable',
        inject: [],
        apply() { /* intentionally inert */ },
        __loadError: String((e && e.message) || e),
      }
    }

  const PANEL_ID = 'roundtable'
  const STORE_KEY = 'dsh.roundtable.v2'

  /** Shown on the 关于 page. Kept in step with package.json by a check. */
  const VERSION = '1.0.0'
  const AUTHOR = '一只杨洋qwq'
  const MAX_HOPS = 3
  const MAX_MEMBERS = 16

  /**
   * How many messages a room renders before asking to load more.
   *
   * Sized from measurement: at 200 messages a room mounts in ~18ms and streams
   * at ~0.16ms per frame, which is indistinguishable from an empty room. The
   * cost grows with node count, so the page is deliberately small.
   */
  const MESSAGE_PAGE = 60
  /** How many more to reveal per click. */
  const MESSAGE_PAGE_STEP = 80

  /**
   * How long a model may go without the Host reporting any progress before its
   * turn is abandoned.
   *
   * The Host sends a `working` heartbeat for every streamed chunk, including
   * reasoning ones this page never renders — so this timer measures "the
   * connection went dead", not "the model is thinking hard". A reasoning model
   * may think for a long time; that is not the same as being stuck.
   */
  /**
   * Idle timeout, in two tiers.
   *
   * The clock measures silence on the wire, not thinking time: reasoning chunks
   * count as activity, so a model that is genuinely working never trips this. What
   * it catches is a connection that has gone quiet — and 90 seconds of that is far
   * too long to sit through, which is what made a stuck MiniMax feel like a
   * frozen panel.
   *
   * The tiers differ because the two waits mean different things:
   *
   *   before any byte  → 45s. Nothing has arrived at all; either the route never
   *                      connected or the model is not going to answer.
   *   mid-stream       → 60s. Something arrived and then stopped, which on a
   *                      reasoning model is more often a pause than a failure, so
   *                      it gets a little longer.
   *
   * Both are still well above the slowest real first token seen from these routes.
   */
  const FIRST_BYTE_MS = 45_000
  const MID_STREAM_MS = 60_000

  /** Seconds of thinking before the stop button appears. */
  const STOP_AFTER_SECS = 15

  /**
   * When a wait starts to look wrong, and when it is almost certainly stuck.
   *
   * A reasoning model can legitimately think for a minute. Past that, with no
   * bytes at all, the odds shift: this is the range where some routes go quiet
   * and never come back, so the row says so instead of showing a bare counter
   * the user has to interpret.
   */
  const SLOW_AFTER_SECS = 45
  const STUCK_AFTER_SECS = 75

  /** Dictionary namespace; also the slot registrations' `locale` option. */
  const NS = 'roundtable'
  const zh = { nav: '圆桌' }
  const en = { nav: 'Roundtable' }

  // ── helpers ──────────────────────────────────────────────────────────────

  const uid = (p) => p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)

  /** Stable hue per string, so one model always keeps one colour. */
  function hueOf(seed) {
    let x = 0
    const s = String(seed ?? '')
    for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0
    return x % 360
  }

  /** The circular model avatar: a two-stop gradient, one letter. */
  function avatarStyle(seed, size) {
    const hue = hueOf(seed)
    return {
      width: size, height: size, borderRadius: '50%',
      background: `linear-gradient(150deg,
        hsl(${hue} 72% 63%),
        hsl(${(hue + 46) % 360} 62% 45%))`,
      boxShadow: `0 0 0 1px hsl(${hue} 60% 70% / .28), 0 2px 10px -2px hsl(${hue} 70% 40% / .55)`,
      color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.36, fontWeight: 700, letterSpacing: '-.03em',
      flex: `0 0 ${size}px`, userSelect: 'none',
      textShadow: '0 1px 2px hsl(0 0% 0% / .35)',
    }
  }

  /** One letter for the avatar: the model's own initial. */
  /**
   * A compact glyph pair for the avatar.
   *
   * One initial collides constantly — DeepSeek V4 and DFModel both start with
   * D. Two glyphs off the *model id* stay distinct in practice while still
   * fitting inside a 28px circle.
   */
  function avatarGlyph(member) {
    const id = String(member?.model ?? '')
      .replace(/:free$/, '')
      .split('/').pop()
    const name = String(member?.displayName ?? id)

    // Prefer the model name's own words: "Gemma 4 31B" → G4, "GLM 5.3" → G5.
    const words = name.split(/[\s._-]+/).filter(Boolean)
    if (words.length >= 2) {
      const a = words[0][0]
      const b = words[1][0]
      if (/\d/.test(b)) return (a + b).toUpperCase()
      return (a + words[1][0]).toUpperCase()
    }

    // Single word: first two alphanumerics from the id.
    const alnum = id.replace(/[^A-Za-z0-9]/g, '')
    if (alnum.length >= 2) return (alnum[0] + alnum[1]).toUpperCase()
    return String(name[0] ?? '?').toUpperCase()
  }

  // ── brand marks ──────────────────────────────────────────────────────────

  /**
   * Which model family this member belongs to.
   *
   * Ordered: the first pattern that matches wins, so the specific families
   * (deepseek, glm) must precede anything generic that could also match.
   */
  const BRANDS = [
    {
      id: 'deepseek', match: /deepseek|deep-seek/i, tint: 'hsl(214 78% 56%)',
      shapes: [
        { d: 'M4 15.4c3 0 3-5 6.1-5s3.1 5 6.1 5 3-2.2 3.7-2.8' },
        { c: [12, 18.2, 1.35] },
      ],
    },
    {
      id: 'openai', match: /gpt|openai|chatgpt/i, tint: 'hsl(152 46% 52%)',
      shapes: [
        { d: 'M12 4.2a3.9 3.9 0 0 1 3.3 1.9 3.9 3.9 0 0 1 3.6 4.9 3.9 3.9 0 0 1-1 4.3 3.9 3.9 0 0 1-3.3 1.9 3.9 3.9 0 0 1-3.3-1.9 3.9 3.9 0 0 1-3.6-4.9 3.9 3.9 0 0 1 1-4.3A3.9 3.9 0 0 1 12 4.2Z' },
        { d: 'M12 8.3a3.7 3.7 0 0 1 3.7 3.7 3.7 3.7 0 0 1-3.7 3.7A3.7 3.7 0 0 1 8.3 12 3.7 3.7 0 0 1 12 8.3Z' },
      ],
    },
    {
      id: 'anthropic', match: /claude|anthropic/i, tint: 'hsl(26 88% 60%)',
      shapes: [
        { d: 'M12 3.4 13.7 10.3 20.6 12 13.7 13.7 12 20.6 10.3 13.7 3.4 12 10.3 10.3Z' },
      ],
    },
    {
      id: 'google', match: /gemma|gemini|google|palm/i, tint: 'hsl(205 82% 58%)',
      shapes: [
        { d: 'M12 3.2c.4 4.4 4.4 8.4 8.8 8.8-4.4.4-8.4 4.4-8.8 8.8-.4-4.4-4.4-8.4-8.8-8.8 4.4-.4 8.4-4.4 8.8-8.8Z' },
      ],
    },
    {
      id: 'meta', match: /llama|meta-?llama/i, tint: 'hsl(220 74% 58%)',
      shapes: [
        { d: 'M3.6 14.2c0-3.2 1.9-5.8 4.4-5.8 2.1 0 3.2 1.8 3.8 3.2.6-1.4 1.7-3.2 3.8-3.2 2.5 0 4.4 2.6 4.4 5.8' },
        { d: 'M3.6 14.2c0 1.9 1 3.2 2.5 3.2 1.7 0 2.9-1.9 5.7-1.9s4 1.9 5.7 1.9c1.5 0 2.5-1.3 2.5-3.2' },
      ],
    },
    {
      id: 'zhipu', match: /\bglm|zhipu|bigmodel|chatglm/i, tint: 'hsl(268 62% 62%)',
      shapes: [
        // An angular "Z" block: distinct from the ring-shaped families at 22px.
        { d: 'M6 6.4h12l-12 11.2h12' },
        { d: 'M6 17.6l12-11.2' },
      ],
    },
    {
      id: 'moonshot', match: /kimi|moonshot/i, tint: 'hsl(190 70% 55%)',
      shapes: [
        { d: 'M15.4 4a8.6 8.6 0 1 0 4.8 13.4A9.2 9.2 0 0 1 15.4 4Z' },
      ],
    },
    {
      id: 'minimax', match: /minimax/i, tint: 'hsl(340 68% 60%)',
      shapes: [
        { d: 'M4.8 9.8h9.4v9.4H4.8Z' },
        { d: 'M9.8 4.8h9.4v9.4' },
      ],
    },
    {
      id: 'hunyuan', match: /hunyuan|混元/i, tint: 'hsl(174 62% 50%)',
      shapes: [
        // A droplet with a core dot — the ring is reserved for Qwen.
        { d: 'M12 4.2c3.4 3.6 5.6 6.4 5.6 9.1a5.6 5.6 0 1 1-11.2 0c0-2.7 2.2-5.5 5.6-9.1Z' },
        { c: [12, 14.4, 1.5] },
      ],
    },
    {
      id: 'qwen', match: /qwen|tongyi|dashscope/i, tint: 'hsl(212 76% 58%)',
      shapes: [
        { d: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z' },
        { d: 'M14.2 14.2 18.8 19.2' },
      ],
    },
    {
      id: 'mistral', match: /mistral/i, tint: 'hsl(20 84% 56%)',
      shapes: [
        { d: 'M5.4 19V9.2l3 3v6.8' },
        { d: 'M8.4 19V9.2l3.6 3.6v6.2' },
        { d: 'M12 19V12.8l3.6-3.6v9.8' },
        { d: 'M15.6 19V12.2l3-3v9.8' },
      ],
    },
    {
      id: 'nemotron', match: /nemotron|nvidia/i, tint: 'hsl(96 62% 48%)',
      shapes: [
        { d: 'M4.6 15.2a7.4 7.4 0 0 1 14.8 0' },
        { d: 'M7.6 15.2a4.4 4.4 0 0 1 8.8 0' },
        { d: 'M10.3 15.2a1.7 1.7 0 0 1 3.4 0' },
      ],
    },
    {
      id: 'xingchen', match: /xingchen|星辰/i, tint: 'hsl(38 86% 58%)',
      shapes: [
        { d: 'M12 3.6 13.9 10.1 20.4 12 13.9 13.9 12 20.4 10.1 13.9 3.6 12 10.1 10.1Z' },
      ],
    },
  ]

  /** Which brand, if any, this member belongs to. */
  function brandOf(member) {
    const hay = [
      String(member?.model ?? ''),
      String(member?.displayName ?? ''),
      String(member?.provider ?? ''),
    ].join(' ')
    for (const b of BRANDS) {
      if (b.match.test(hay)) return b
    }
    return null
  }

  /** Inline SVG for one brand mark, sized to fit the avatar circle. */
  function BrandMark({ brand, size }) {
    const inset = size * 0.22
    const inner = size - inset * 2
    // Thin strokes vanish at 16–22px. Scale the stroke with the rendered size
    // so a small chip stays legible instead of turning into grey mush.
    const stroke = inner <= 18 ? 2.1 : inner <= 26 ? 1.9 : 1.7
    return React.createElement(
      'svg',
      {
        width: inner, height: inner, viewBox: '0 0 24 24',
        fill: 'none', stroke: '#fff', strokeWidth: stroke,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { display: 'block' },
      },
      brand.shapes.map((s, i) =>
        s.c != null
          ? React.createElement('circle', { key: i, cx: s.c[0], cy: s.c[1], r: s.c[2] })
          : React.createElement('path', { key: i, d: s.d }),
      ),
    )
  }

  const fmtTime = (ts) => {
    const d = new Date(ts)
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  }

  /**
   * One line of a message, for the pinned bar.
   *
   * Every kind gets a label rather than an empty string: a pinned 红包 that
   * shows nothing looks like a broken entry.
   */
  function previewOf(m) {
    if (!m) return ''
    if (m.role === 'packet') return '红包 ' + (m.points ?? 0) + ' 积分' + (m.note ? ' · ' + m.note : '')
    if (m.role === 'vote') return '投票 · ' + String(m.text ?? '')
    if (m.role === 'chain') return '接龙 · ' + String(m.text ?? '')
    if (m.role === 'sys') return String(m.text ?? '')
    const text = String(m.text ?? '').replace(/\s+/g, ' ').trim()
    return text.length > 60 ? text.slice(0, 60) + '…' : (text || '（图片）')
  }

  /**
   * Turn a room into Markdown.
   *
   * The transcript only lives in this browser, and clearing site data takes it
   * with it. Exporting is the only way to keep a conversation, so every message
   * kind has to survive the trip — a 红包 that exports as a blank line is worse
   * than no export at all.
   */
  function transcriptMarkdown(room, profile) {
    if (!room) return ''
    const members = room.members ?? []
    const nameOf = (id) => members.find((m) => m.id === id)?.displayName ?? '已移除'
    const out = []
    out.push('# ' + (room.name || '未命名群'))
    out.push('')
    out.push('> 导出于 ' + new Date().toLocaleString('zh-CN'))
    if ((room.notice ?? '').trim()) out.push('> 群公告：' + room.notice.trim())
    out.push('')
    for (const m of room.messages ?? []) {
      const time = fmtTime(m.ts)
      if (m.role === 'user') {
        out.push('**' + (m.senderName ?? profile?.name ?? '我') + '** · ' + time)
        if (m.quote && m.quote.text) out.push('> 回复：' + String(m.quote.text).slice(0, 120))
        if (m.text) out.push(m.text)
        if (m.images && m.images.length > 0) {
          out.push('（' + m.images.length + ' 张图片，未随导出保存）')
        }
        out.push('')
      } else if (m.role === 'ai') {
        out.push('**' + nameOf(m.memberId) + '** · ' + time)
        out.push(m.text || '（空回答）')
        if (m.error) out.push('> 出错了：' + m.error)
        out.push('')
      } else if (m.role === 'sys') {
        out.push('_· ' + (m.text ?? '') + ' ·_')
        out.push('')
      } else if (m.role === 'packet') {
        out.push('**红包** · ' + time + ' · ' + (m.points ?? 0) + ' 积分')
        const kind = m.kind === 'even' ? '平均分' : m.kind === 'single' ? '专属' : '拼手气'
        out.push('_' + kind + (m.note ? ' · ' + m.note : '') + '_')
        for (const g of m.grabs ?? []) {
          out.push('- ' + nameOf(g.memberId) + ' +' + g.points)
        }
        out.push('')
      } else if (m.role === 'vote') {
        out.push('**投票** · ' + time + ' · ' + String(m.text ?? ''))
        const ballots = Array.isArray(m.ballots) ? m.ballots : []
        for (const opt of m.options ?? []) {
          const voters = ballots.filter((b) => b.option === opt)
          out.push('- ' + opt + '：' + voters.length + ' 票'
            + (voters.length ? '（' + voters.map((v) => nameOf(v.memberId)).join('、') + '）' : ''))
        }
        if (m.closed) out.push('_已结束_')
        out.push('')
      } else if (m.role === 'chain') {
        out.push('**接龙** · ' + time + ' · ' + String(m.text ?? ''))
        const entries = Array.isArray(m.entries) ? m.entries : []
        entries.forEach((e, i) => {
          out.push((i + 1) + '. ' + (e.text || e.who || '') + (e.who ? ' — ' + e.who : ''))
        })
        out.push('')
      }
    }
    return out.join('\n')
  }

  /** Download the transcript as a .md file. */
  function downloadTranscript(room, profile) {
    try {
      const text = transcriptMarkdown(room, profile)
      const safe = String(room?.name ?? '圆桌').replace(/[\\/:*?"<>|]/g, '_')
      const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = safe + '.md'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // Revoking immediately can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 2000)
      return true
    } catch {
      return false
    }
  }

  /**
   * A handle that can be typed after `@`: no spaces, no punctuation that would
   * collide with mention parsing. Derived from the model id, so it reads like
   * the model rather than an arbitrary label.
   */
  function handleFor(modelId, taken) {
    const raw = String(modelId ?? '')
      .replace(/:free$/, '')
      .split('/').pop()
      .replace(/[^A-Za-z0-9_-]/g, '')
    let base = raw === '' ? 'model' : raw
    if (base.length > 18) base = base.slice(0, 18)
    let candidate = base
    let n = 2
    while (taken.has(candidate.toLowerCase())) {
      candidate = base + n
      n++
    }
    taken.add(candidate.toLowerCase())
    return candidate
  }

  /**
   *
   * The RegExp is built once per distinct member set, not once per call. While a
   * reply streams in this runs on every chunk, and rebuilding the escape list,
   * sorting it and compiling a RegExp each time is pure waste — the inputs only
   * change when the room's members change.
   */
  const mentionPatternCache = new Map()

  function mentionPattern(members) {
    const handles = members
      .filter((m) => m.enabled !== false)
      .map((m) => m.handle)
      .filter(Boolean)
    // 所有人 is highlighted like a handle, but it is not one: it never appears in
    // a model's mention set.
    const names = [...handles, '所有人'].sort((a, b) => b.length - a.length)
    const key = names.join('\u0000')
    const hit = mentionPatternCache.get(key)
    if (hit !== undefined) return hit
    const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, (ch) => '\\' + ch))
    const built = names.length === 0 ? null : new RegExp('@(' + escaped.join('|') + ')', 'g')
    // Bounded: a room is small, but a long session could otherwise keep one
    // entry per rename.
    if (mentionPatternCache.size > 32) mentionPatternCache.clear()
    mentionPatternCache.set(key, built)
    return built
  }

  function renderText(text, members) {
    if (!text) return text
    const pattern = mentionPattern(members)
    if (!pattern) return text

    pattern.lastIndex = 0
    const out = []
    let last = 0
    let m
    let i = 0
    while ((m = pattern.exec(text)) !== null) {
      if (m.index > last) out.push(text.slice(last, m.index))
      out.push(h('span', { key: 'mt' + i++, className: 'rt-mention' }, '@' + m[1]))
      last = m.index + m[0].length
    }
    if (last < text.length) out.push(text.slice(last))
    return out
  }
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

  // ── shop ─────────────────────────────────────────────────────────────────

  /**
   * The catalogue.
   *
   * Groups mirror how a person actually furnishes a room: something to drink,
   * something to sit on, something that stays cold, and decorations. `kind`
   * drives the tiny glyph shown next to an owned item, and `tags` feed the
   * 应援 feature — a gift gets more影响力 when it matches the occasion.
   *
   * Prices are deliberately cheap relative to a red packet (100 points splits
   * into ~20–50 per model), so a couple of packets buys something real. Just
   * expensive enough that a purchase is a decision.
   */
  const SHOP = [
    {
      group: '饮品', items: [
        { id: 'cola', name: '可乐', price: 12, icon: 'cup', mood: '喝一口，气泡冲上来' },
        { id: 'coffee', name: '咖啡', price: 18, icon: 'mug', mood: '熬夜续命' },
        { id: 'tea', name: '奶茶', price: 22, icon: 'boba', mood: '甜的，心情好' },
        { id: 'water', name: '矿泉水', price: 5, icon: 'drop', mood: '简单解渴' },
      ],
    },
    {
      group: '家具', items: [
        { id: 'chair', name: '椅子', price: 40, icon: 'chair', mood: '终于能坐下了' },
        { id: 'desk', name: '书桌', price: 65, icon: 'desk', mood: '有地方摊开图纸' },
        { id: 'sofa', name: '沙发', price: 120, icon: 'sofa', mood: '陷进去不想起来' },
        { id: 'bed', name: '床', price: 160, icon: 'bed', mood: '关灯，睡一会儿' },
      ],
    },
    {
      group: '家电', items: [
        { id: 'fridge', name: '冰箱', price: 220, icon: 'fridge', mood: '可乐终于有地方冰了' },
        { id: 'lamp', name: '台灯', price: 45, icon: 'lamp', mood: '房间里有了光' },
        { id: 'speaker', name: '音箱', price: 90, icon: 'speaker', mood: '放点音乐' },
        { id: 'heater', name: '暖气', price: 130, icon: 'flame', mood: '这个冬天好过一点' },
      ],
    },
    {
      group: '摆件', items: [
        { id: 'plant', name: '绿植', price: 30, icon: 'plant', mood: '房间里有点生气了' },
        { id: 'poster', name: '海报', price: 25, icon: 'frame', mood: '墙上不再空着' },
        { id: 'clock', name: '挂钟', price: 35, icon: 'clock', mood: '时间有了形状' },
      ],
    },
    {
      group: '应援', items: [
        // 应援 is not a possession: it is spent on someone else and recorded as
        // support. Cheaper per unit, because the point is volume.
        { id: 'cheer', name: '掌声', price: 10, icon: 'clap', cheer: 1, mood: '为你鼓掌' },
        { id: 'flower', name: '捧花', price: 30, icon: 'bouquet', cheer: 3, mood: '这束花给你' },
        { id: 'banner', name: '横幅', price: 60, icon: 'banner', cheer: 6, mood: '今天你最大' },
        { id: 'firework', name: '烟花', price: 100, icon: 'firework', cheer: 10, mood: '为你放一场' },
      ],
    },
  ]

  /**
   * The 金币 shop — a second, scarcer currency.
   *
   * 积分 come from red packets and are the everyday scoreboard. 金币 are earned
   * only by doing something the room values: answering, being 应援 by others,
   * winning a vote. So the 金币 shelf sells what 积分 cannot buy at all — a
   * model's own standing rather than furniture for its room.
   *
   * `rank` is what the UI badges next to a name; `note` is what the prompt tells
   * the model it owns. Nothing here changes how models are called.
   */
  const GOLD_SHOP = [
    {
      group: '身份', items: [
        { id: 'g_badge', name: '金色徽章', gold: 6, icon: 'medal', rank: '金徽章' },
        { id: 'g_title', name: '头衔', gold: 10, icon: 'scroll', rank: '受封' },
        { id: 'g_crown', name: '王冠', gold: 18, icon: 'crown', rank: '王冠' },
        { id: 'g_statue', name: '雕像', gold: 26, icon: 'statue', rank: '立像' },
      ],
    },
    {
      group: '排场', items: [
        { id: 'g_balloon', name: '气球', gold: 2, icon: 'balloon' },
        { id: 'g_feast', name: '大餐', gold: 4, icon: 'plate' },
        { id: 'g_party', name: '烟花大会', gold: 8, icon: 'sparkler', cheer: 8 },
        { id: 'g_stage', name: '舞台', gold: 12, icon: 'stage' },
        { id: 'g_gift', name: '厚礼', gold: 14, icon: 'giftbox' },
      ],
    },
  ]

  // Extra 积分 goods. The original shelf was thin: three or four things per
  // category, which left a model with a full purse and nothing to want.
  const SHOP_EXTRA = [
    {
      group: '饮品', items: [
        { id: 'juice', name: '果汁', price: 15, icon: 'juice', mood: '新鲜的味道' },
        { id: 'beer', name: '啤酒', price: 26, icon: 'beer', mood: '今晚放松一下' },
      ],
    },
    {
      group: '吃的', items: [
        { id: 'bread', name: '面包', price: 10, icon: 'bread', mood: '先垫一垫' },
        { id: 'noodle', name: '泡面', price: 14, icon: 'bowl', mood: '深夜的慰藉' },
        { id: 'cake', name: '蛋糕', price: 34, icon: 'cake', mood: '值得庆祝的一天' },
        { id: 'hotpot', name: '火锅', price: 88, icon: 'pot', mood: '一个人也要热闹' },
      ],
    },
    {
      group: '家具', items: [
        { id: 'shelf', name: '书架', price: 95, icon: 'shelf', mood: '书有地方放了' },
      ],
    },
    {
      group: '家电', items: [
        { id: 'fan', name: '风扇', price: 55, icon: 'fan', mood: '夏天好过一点' },
      ],
    },
    {
      group: '摆件', items: [
        { id: 'rug', name: '地毯', price: 48, icon: 'rug', mood: '脚底下软了' },
        { id: 'fish', name: '鱼缸', price: 110, icon: 'fish', mood: '有活物陪着' },
      ],
    },
  ]

  // Merge the extras into their categories so the shelf stays one flat list.
  for (const extra of SHOP_EXTRA) {
    const target = SHOP.find((g) => g.group === extra.group)
    if (target) target.items.push(...extra.items)
    else SHOP.push(extra)
  }

  /** Flat lookup by id, so a parsed command resolves in one step. */
  const SHOP_ITEMS = new Map()
  for (const g of SHOP) for (const it of g.items) SHOP_ITEMS.set(it.id, { ...it, group: g.group, currency: 'points' })
  for (const g of GOLD_SHOP) for (const it of g.items) SHOP_ITEMS.set(it.id, { ...it, group: g.group, currency: 'gold' })

  // Aliases let a model buy with the word a person would say. Names are matched
  // case-insensitively and by Chinese name as well as id.
  function findItem(word) {
    const w = String(word ?? '').trim().toLowerCase()
    if (!w) return null
    if (SHOP_ITEMS.has(w)) return SHOP_ITEMS.get(w)
    for (const it of SHOP_ITEMS.values()) {
      if (it.name.toLowerCase() === w) return it
    }
    return null
  }

  /**
   * Find the member a directive is addressed to.
   *
   * Models do not reliably write `@handle`. Observed in practice:
   *
   *   `给 @glm`                 correct, but not what most models produce
   *   `给 GLM-5.3-Flash`        the *display name*, no @
   *   `给 @Qwen3.8-Flash`       display name with @, wrong case, and a suffix
   *                             (`· 免费`) the model naturally left off
   *
   * A strict `startsWith('@' + handle)` test treated every one of those as "no
   * recipient", which surfaced to the user as "要送给谁？用 @ 指定一位成员".
   * The lookup therefore tries the @handle, the display name, and the display
   * name up to its decoration suffix — all case-insensitive, longest match wins.
   */
  function resolveRecipient(body, members, selfId) {
    const active = (members ?? []).filter((m) => m.enabled !== false && m.id !== selfId)
    if (active.length === 0) return null

    // Quotes and stray punctuation around a name are common; strip them so
    // `给 "GLM-5.3-Flash"` matches the same as `给 GLM-5.3-Flash`.
    const cleaned = body
      .replace(/[“”"'「」『』【】]/g, ' ')
      .replace(/\s+/g, ' ')
      .toLowerCase()

    let best = null
    let bestScore = 0

    for (const m of active) {
      const handle = String(m.handle ?? '').toLowerCase()
      const name = String(m.displayName ?? '').toLowerCase()
      // Display names often carry a suffix ("· 免费"); compare the base too.
      const base = name.split(/\s*[·|｜]\s*/)[0].trim()

      const probes = [
        { text: '@' + handle, bonus: 4 },
        { text: name, bonus: 3 },
        { text: handle, bonus: 2 },
        { text: base, bonus: 2 },
      ].filter((p) => p.text && p.text.length >= 2)

      for (const p of probes) {
        if (!cleaned.includes(p.text)) continue
        const score = p.text.length + p.bonus
        if (score > bestScore) { best = m; bestScore = score }
      }
    }

    if (!best) {
      const viaMentions = parseMentions(body, active)[0]
      if (viaMentions) return viaMentions
    }
    return best
  }

  /**
   * Read `@投票` out of a reply.
   *
   * A vote is useless if only the person who started it can take part, and until
   * now the models could see a tally but had no way to add to it. The directive
   * matches the shape of everything else they already know (`@商店`, `@出门`):
   * an `@` token plus a word, written on its own line.
   *
   *   @投票 要             vote for an option, matched loosely
   *   @投票 要 因为         vote, with a reason the reason is ignored
   *
   * The option is matched by exact text first, then by prefix, because a model
   * often writes the option without its surrounding punctuation.
   */
  function parseVoteCommand(text, voteMsg) {
    if (!voteMsg || voteMsg.closed) return null
    const t = String(text ?? '')
    const at = t.indexOf('@投票')
    if (at < 0) return null
    const lineEnd = t.indexOf('\n', at)
    const line = t.slice(at, lineEnd < 0 ? t.length : lineEnd).replace('@投票', '').trim()
    if (!line) return { ok: false, reason: '没说投哪个选项' }

    const options = Array.isArray(voteMsg.options) ? voteMsg.options : []
    const clean = line.replace(/[「」『』【】"'“”]/g, '').trim()

    let chosen = options.find((o) => String(o) === clean)
    if (!chosen) chosen = options.find((o) => clean.startsWith(String(o)))
    if (!chosen) chosen = options.find((o) => clean.includes(String(o)))
    if (!chosen) {
      return { ok: false, reason: '没有这个选项。可选：' + options.join('、') }
    }
    return { ok: true, option: chosen }
  }

  /**
   * Read `@接龙` out of a reply.
   *
   *   @接龙 周末有空       append the rest of the line as this model's entry
   *
   * The entry text is whatever follows the token, so a model can say something
   * more useful than just repeating its own name.
   */
  function parseChainCommand(text) {
    const t = String(text ?? '')
    const at = t.indexOf('@接龙')
    if (at < 0) return null
    const lineEnd = t.indexOf('\n', at)
    const line = t.slice(at, lineEnd < 0 ? t.length : lineEnd).replace('@接龙', '').trim()
    // An empty tail is still valid: joining with just your name is normal.
    return { ok: true, entry: line }
  }

  /**
   * Parse the commands a model can emit.
   *
   * A model cannot call a host function: it can only write text. So 商店 is
   * addressed the same way a member is — with an `@` token — and the directive
   * is read out of the sentence:
   *
   *   @商店 买 可乐
   *   @商店 买 沙发 给 @glm5
   *   @商店 送 花 给 @dsv4
   *   @商店 应援 @dsv4 横幅
   *
   * Deliberately loose: models phrase things differently, and a strict grammar
   * would just mean most attempts silently do nothing. Returning `null` for an
   * unparseable line lets the caller leave the text alone rather than eating it.
   */
  function parseShopCommand(text, members, selfId) {
    const at = text.indexOf('@商店')
    if (at < 0) return null

    // Only the line that carries the token, so surrounding prose is untouched.
    const lineStart = text.lastIndexOf('\n', at) + 1
    let lineEnd = text.indexOf('\n', at)
    if (lineEnd < 0) lineEnd = text.length
    const line = text.slice(lineStart, lineEnd)
    const body = line.replace('@商店', '').trim()

    // Recipient: `给 @handle`, `应援 @handle`, or the display name alone.
    const mention = resolveRecipient(body, members, selfId)

    // A model can send a red packet too — `@商店 发红包 40 给 某人`.
    //
    // Checked before the item lookup because a red packet has no catalogue
    // entry: the amount is what moves, so searching SHOP_ITEMS first would always
    // fail with "没看懂要买什么".
    const packet = body.match(/发红包\s*(\d+)?(?:\s*(?:给|发给)\s*(.+))?/)
    if (packet) {
      const amount = Number(packet[1] ?? 0)
      if (!Number.isFinite(amount) || amount <= 0) {
        return { ok: false, reason: '要发多少？写「@商店 发红包 50 给 某人」', line, lineStart, lineEnd, body }
      }
      if (!mention) {
        const names = members
          .filter((m) => m.enabled !== false && m.id !== selfId)
          .map((m) => m.displayName)
        return {
          ok: false,
          reason: names.length ? '没认出要发给谁。可用的名字：' + names.join('、') : '群里没有别人',
          line, lineStart, lineEnd, body,
        }
      }
      return {
        ok: true,
        action: 'packet',
        amount: Math.floor(amount),
        to: mention,
        line, lineStart, lineEnd, body,
      }
    }

    // Which item was named?
    let item = null
    for (const it of SHOP_ITEMS.values()) {
      if (body.includes(it.name)) { item = it; break }
    }
    if (!item) {
      // Fall back to a bare id somewhere in the line.
      for (const word of body.split(/[\s，,。：:]+/)) {
        const hit = findItem(word)
        if (hit) { item = hit; break }
      }
    }
    if (!item) {
      return { ok: false, reason: '没看懂要买什么', line, lineStart, lineEnd, body }
    }

    // A `给`/`送`/`应援` in the line marks the intent to give something away.
    // When such a word is present but no member matched, the failure is a
    // *recipient* problem — reporting it as "没看懂要买什么" (which is what the
    // old shared message did) sends the model looking in the wrong place.
    const wantsOther = /给|送|应援|为/.test(body)
    if (wantsOther && !mention) {
      const names = members
        .filter((m) => m.enabled !== false && m.id !== selfId)
        .map((m) => m.displayName)
      return {
        ok: false,
        reason: names.length
          ? '没认出要送给谁。可用的名字：' + names.join('、')
          : '群里没有别的成员可以送',
        line, lineStart, lineEnd, body,
      }
    }

    const isCheer = item.group === '应援' || body.includes('应援')
    return {
      ok: true,
      item,
      to: mention,
      action: isCheer ? 'cheer' : mention ? 'gift' : 'buy',
      line, lineStart, lineEnd, body,
    }
  }


  /**
   * Read an `@出门` directive out of a reply.
   *
   * The model says where it is going in the same message it was already writing,
   * so this costs nothing extra. Anything unrecognised returns null — a confused
   * model simply stays in the room.
   */
  function parseOutingCommand(text) {
    const t = String(text ?? '')
    const at = t.indexOf('@出门')
    if (at < 0) return null
    const line = t.slice(at, t.indexOf('\n', at) < 0 ? t.length : t.indexOf('\n', at))
    if (/旅游|旅行|TRAVEL/i.test(line)) return 'travel'
    if (/逛街|购物|SHOP/i.test(line)) return 'shop'
    if (/打工|上班|WORK/i.test(line)) return 'work'
    // `@出门` alone means 打工: it is the reliable earner.
    return 'work'
  }

  /** A model's owned inventory, keyed by item id. */
  function ownedOf(member) {
    return member?.items ?? []
  }

  // ── going out ────────────────────────────────────────────────────────────

  /**
   * Things a model can go and do when nobody is talking to it.
   *
   * 金币 exist only here. That is the point of the currency: it cannot be talked
   * into existence, only worked for. So the amounts are deliberately small — a
   * crown is roughly eight outings away, not one conversation.
   *
   *   打工 — steady, slow, the reliable 金币 source
   *   逛街 — quick, pays 积分, no 金币 at all
   *   旅游 — long, pays the most of both
   *
   * `minutes` is real time. `points` and `gold` are what it brings back.
   */
  const ACTIVITIES = [
    {
      id: 'work',
      label: '打工',
      icon: 'tool',
      minutes: 6,
      points: 10,
      gold: 2,
      say: '去打工了，有事找我，我再回来。',
      back: '打工回来了，手上还有点油。',
    },
    {
      id: 'shop',
      label: '逛街',
      icon: 'bag',
      minutes: 3,
      points: 16,
      gold: 0,
      say: '出去逛会儿街，有事喊我。',
      back: '逛街回来了，腿有点酸。',
    },
    {
      id: 'travel',
      label: '旅游',
      icon: 'luggage',
      minutes: 12,
      points: 22,
      gold: 4,
      say: '出门旅游了，有事找我，我会回来。',
      back: '旅行回来了，见了点世面。',
    },
  ]

  const ACTIVITY_BY_ID = new Map(ACTIVITIES.map((a) => [a.id, a]))

  /**
   * Award for one outing, with a little variance.
   *
   * Fixed rewards make the choice pointless — a model would always pick the same
   * activity. A ±30% spread keeps 旅游 the best expected value while letting 打工
   * occasionally beat it, which is what makes the decision worth asking.
   */
  function activityReward(activity, seed) {
    if (!activity) return { points: 0, gold: 0 }
    let h = 0
    const s = String(seed ?? activity.id)
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
    const jitter = (n) => {
      if (n === 0) return 0
      const r = (h % 61) / 100          // 0.00 – 0.60
      h = (h * 1103515245 + 12345) >>> 0
      return Math.max(1, Math.round(n * (0.7 + r * 1.0)))   // 0.7x – 1.3x
    }
    return { points: jitter(activity.points), gold: jitter(activity.gold) }
  }

  /** Is this member currently out? */
  function isAway(member, now) {
    const a = member?.away
    if (!a) return false
    return (a.until ?? 0) > (now ?? Date.now())
  }

  /** How long until they are back, in whole minutes (0 if already back). */
  function awayMinutes(member, now) {
    const a = member?.away
    if (!a) return 0
    const left = (a.until ?? 0) - (now ?? Date.now())
    return left <= 0 ? 0 : Math.ceil(left / 60000)
  }

  /**
   * Turn a decision into an outing.
   *
   * Returns the member patch and the line to post, or null when the model chose
   * to stay. Separate from the state update so the same logic can be exercised in
   * a test without a room.
   */
  function startOuting(member, activityId, now) {
    const activity = ACTIVITY_BY_ID.get(activityId)
    if (!activity) return null
    const t = now ?? Date.now()
    const rew = activityReward(activity, String(member?.id ?? '') + t)
    return {
      activity,
      away: {
        kind: activity.id,
        label: activity.label,
        icon: activity.icon,
        until: t + activity.minutes * 60000,
        points: rew.points,
        gold: rew.gold,
      },
      say: activity.say,
    }
  }

  /**
   * Apply one purchase or gift.
   *
   * Returns a result object rather than mutating, so the caller can report the
   * outcome in chat and decide whether to keep the line in the transcript.
   */
  function applyShopCommand(room, fromMember, cmd) {
    if (!cmd?.ok) return { ok: false, reason: cmd?.reason ?? '无法解析' }

    // A model-to-model red packet: 积分 move from the sender to one recipient.
    //
    // Unlike a user-sent packet this is not a lottery — there is exactly one
    // target, so the whole amount lands on them. Charging the sender is what
    // makes it a real transfer rather than free points from nowhere.
    if (cmd.action === 'packet') {
      const amount = Math.max(1, Math.floor(cmd.amount ?? 0))
      if (!cmd.to) return { ok: false, reason: '要发给谁？用 @ 指定一位成员' }
      const target = cmd.to.id === fromMember.id ? null : cmd.to
      if (!target) return { ok: false, reason: '不能发给自己' }
      if ((fromMember.points ?? 0) < amount) {
        return { ok: false, reason: '积分不够（要发 ' + amount + '，你有 ' + (fromMember.points ?? 0) + '）' }
      }
      return {
        ok: true,
        action: 'packet',
        from: { ...fromMember, points: (fromMember.points ?? 0) - amount },
        to: { ...target, points: (target.points ?? 0) + amount },
        text: fromMember.displayName + ' 给 ' + target.displayName + ' 发了个 ' + amount + ' 积分的红包',
      }
    }

    // Two currencies, one shelf. `price` is always 积分, `gold` is always 金币 —
    // an item declares exactly one of them, and `currency` says which balance
    // to charge. Charging the wrong one would let a rich-in-points model buy
    // things that are meant to be scarce.
    const isGold = cmd.item.currency === 'gold'
    const cost = isGold ? (cmd.item.gold ?? 0) : (cmd.item.price ?? 0)
    const balance = isGold ? (fromMember.gold ?? 0) : (fromMember.points ?? 0)
    const unit = isGold ? '金币' : '积分'

    if (balance < cost) {
      return { ok: false, reason: unit + '不够（需 ' + cost + '，你有 ' + balance + '）' }
    }

    const target = cmd.to && cmd.to.id !== fromMember.id ? cmd.to : null
    if (cmd.action === 'gift' && !target) {
      return { ok: false, reason: '要送给谁？用 @ 指定一位成员' }
    }

    const nextFrom = isGold
      ? { ...fromMember, gold: (fromMember.gold ?? 0) - cost }
      : { ...fromMember, points: (fromMember.points ?? 0) - cost }

    if (cmd.action === 'cheer') {
      if (!target) return { ok: false, reason: '应援谁？用 @ 指定一位成员' }
      // 应援 is spent outward: nothing enters the buyer's inventory.
      nextFrom.cheer = (fromMember.cheer ?? 0) + (cmd.item.cheer ?? 1)
      return {
        ok: true,
        action: 'cheer',
        item: cmd.item,
        from: nextFrom,
        to: { ...target, cheerReceived: (target.cheerReceived ?? 0) + (cmd.item.cheer ?? 1) },
        text: fromMember.displayName + ' 为 ' + target.displayName + ' 应援了「' + cmd.item.name +
              '」（+' + (cmd.item.cheer ?? 1) + ' 应援值）',
      }
    }

    if (cmd.action === 'gift') {
      const gift = { id: cmd.item.id, name: cmd.item.name, icon: cmd.item.icon, at: Date.now() }
      return {
        ok: true,
        action: 'gift',
        item: cmd.item,
        from: nextFrom,
        to: { ...target, items: [...ownedOf(target), gift] },
        text: fromMember.displayName + ' 送给 ' + target.displayName + ' 一个「' + cmd.item.name + '」',
      }
    }

    // Plain buy: into the buyer's own home. A 金币 item with a `rank` also
    // upgrades the model's badge, which is the whole point of that shelf.
    const owned = { id: cmd.item.id, name: cmd.item.name, icon: cmd.item.icon, at: Date.now() }
    const bought = { ...nextFrom, items: [...ownedOf(fromMember), owned] }
    if (cmd.item.rank) bought.rank = cmd.item.rank
    return {
      ok: true,
      action: 'buy',
      item: cmd.item,
      from: bought,
      text: fromMember.displayName + ' 用 ' + cost + ' ' + unit + '买了「' + cmd.item.name + '」' +
            (cmd.item.rank ? '，现在是「' + cmd.item.rank + '」' : ''),
    }
  }

  /** The literal token that addresses every member at once. */
  const EVERYONE = '所有人'

  /**
   * Decide which members a *user* message addresses.
   *
   * `@所有人` expands to every active member, and it is the user's shorthand
   * only: a model that happens to type `@所有人` in its reply must not summon
   * the whole room, or one chatty model could burn the day's quota in a single
   * turn. Model replies go through `parseMentions`, which knows nothing about
   * this token.
   */
  function userTargets(text, members) {
    if (text.includes('@' + EVERYONE)) {
      return members.filter((m) => m.enabled !== false && m.model)
    }
    return parseMentions(text, members).filter((m) => m.enabled !== false)
  }

  /**
   * Who answers when the user did not @ anybody in a multi-model room.
   *
   *   first  — the first member answers, everyone else stays quiet. Cheap and
   *            predictable: one turn costs one call.
   *   all    — every member answers in turn. Louder, and costs N calls.
   *   eager  — 自由插嘴: every model is asked whether it wants to speak, and
   *            only those that say yes answer. This is the one that feels like
   *            a real room — some speak, some stay silent.
   *   off    — nobody answers unmentioned; the @ requirement stands.
   *
   * `eager` cannot be resolved here: it needs the models themselves, so the
   * caller awaits the Host probe before filling in the list.
   */
  function syncTargets(room, active) {
    const mode = room.autoReply ?? 'first'
    if (mode === 'all') return active
    const ordered = (room.members ?? []).filter((m) => active.some((a) => a.id === m.id))
    return ordered.slice(0, 1)
  }

  /** Ask the Host which models want to answer this message. */
  async function probeEager(room, text) {
    const res = await fetch('/api/roundtable/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room, text }),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const j = await res.json()
    const eager = Array.isArray(j?.eager) ? j.eager : []
    return (room.members ?? []).filter((m) => eager.includes(m.id))
  }

  // ── store ────────────────────────────────────────────────────────────────

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY)
      if (!raw) return { rooms: [], activeId: null }
      const parsed = JSON.parse(raw)
      return {
        rooms: Array.isArray(parsed.rooms) ? parsed.rooms : [],
        activeId: parsed.activeId ?? null,
      }
    } catch (e) {
      // Unreadable state. Move it aside rather than overwriting it: the bytes
      // may still be recoverable by hand, and silently replacing them would
      // destroy the only copy of the user's rooms.
      try {
        const raw = localStorage.getItem(STORE_KEY)
        if (raw) localStorage.setItem(STORE_KEY + ".corrupt", raw)
      } catch { /* storage full or blocked; nothing more to do */ }
      loadError = String((e && e.message) || e)
      return { rooms: [], activeId: null }
    }
  }

  /**
   * Persist state, but not on every keystroke of a stream.
   *
   * `saveState` used to run inside every `setState`, which meant a
   * `JSON.stringify` of the whole room plus a synchronous localStorage write for
   * *every* streaming chunk. With a few hundred messages that is megabytes of
   * serialisation per reply, all on the main thread — which is exactly what makes
   * the panel feel like it is choking while a model types.
   *
   * Writes are now coalesced: the latest state is kept in a ref and flushed on a
   * timer, on blur, and before the page goes away. Losing at most a second of
   * transcript on a hard crash is a fine trade for a responsive UI.
   */
  /** Last persistence failure, surfaced to the panel. Null when healthy. */
  let saveError = null
  /** Set when stored state could not be parsed. */
  let loadError = null
  let saveTimer = null
  let pendingSave = null

  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    if (!pendingSave) return
    const snapshot = pendingSave
    pendingSave = null
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(snapshot))
      } catch (e) {
        // Out of quota. Drop the oldest half of every room and retry, repeatedly:
        // one halving is not enough when the room is far over the cap. A trimmed
        // transcript that survives a reload beats a complete one that does not.
        let attempt = snapshot
        let ok = false
        for (let round = 0; round < 8 && !ok; round++) {
          const trimmed = {
            ...attempt,
            rooms: (attempt.rooms ?? []).map((r) => {
              const msgs = Array.isArray(r.messages) ? r.messages : []
              if (msgs.length <= 8) return r
              // Keep the newest half: the recent conversation is what the user
              // is looking at, and what they would notice missing.
              return { ...r, messages: msgs.slice(-Math.ceil(msgs.length / 2)) }
            }),
          }
          try {
            localStorage.setItem(STORE_KEY, JSON.stringify(trimmed))
            ok = true
            saveError = null
            break
          } catch {
            attempt = trimmed
          }
        }
        if (!ok) {
          // Nothing fit even after trimming. Say so instead of pretending the
          // session is safe — the user needs to know a refresh will lose it.
          saveError = String((e && e.message) || e)
        }
      }
    }

  function saveState(state) {
    pendingSave = state
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      flushSave()
    }, 800)
  }

  // Never lose the tail of a session: flush when the tab is hidden or closed.
  // Guarded feature by feature — a host page without these events (or a test
  // double) must not break the panel at load time.
  if (typeof window !== 'undefined' && !window.__rtFlushBound) {
    window.__rtFlushBound = true
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('beforeunload', flushSave)
      window.addEventListener('pagehide', flushSave)
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushSave()
      })
    }
  }

  // ── styles ───────────────────────────────────────────────────────────────

  const CSS = `
/* Scoped to this panel's own subtree: without border-box, width:100% plus
 padding overflows every container by a few pixels, which showed up as a
 stray horizontal scrollbar inside the dialogs. */
.rt-root, .rt-root *, .rt-overlay, .rt-overlay * { box-sizing: border-box; }

/* ── theme tokens ──────────────────────────────────────────────────────── */
/*
 * Every surface in this panel used to be written as rgba(255,255,255,.05) —
 * a translucent white over a dark base. That reads as "glow" on dark and is
 * invisible on light, so a light theme could not simply be switched on.
 *
 * The three layers below fix that:
 *
 *   1. Semantic tokens (--rt-surface, --rt-line, --rt-text-*, --rt-accent)
 *      declared once per theme.
 *   2. Two skins — 玻璃 (glass, the original glow) and 极简 (flat) — which
 *      differ in how much translucency and shadow they use.
 *   3. Two brightnesses — dark and light — which flip the token values.
 *
 * Skin and brightness are independent classes on .rt-root, so any of the four
 * combinations works without touching a single component.
 */
.rt-root, .rt-overlay {
/* Ink levels. Named by role, not by colour, so a theme only sets these. */
--rt-text: #e6e8ee;
--rt-text-2: rgba(255,255,255,.78);
--rt-text-3: rgba(255,255,255,.55);
--rt-text-4: rgba(255,255,255,.38);
--rt-text-5: rgba(255,255,255,.22);

/* Surfaces, from the page up to a raised card. */
--rt-bg: #0d0f13;
--rt-surface: rgba(255,255,255,.035);
--rt-surface-2: rgba(255,255,255,.055);
--rt-surface-3: rgba(255,255,255,.09);
--rt-surface-solid: #14171d;

/* Lines and the accent that both skins share. */
--rt-line: rgba(255,255,255,.055);
--rt-line-2: rgba(255,255,255,.09);
--rt-accent: #7c8cff;
--rt-accent-soft: rgba(124,140,255,.18);
--rt-accent-line: rgba(150,160,255,.35);

/* Radius and shadow are what make the two skins look different. */
--rt-radius: 10px;
--rt-radius-lg: 14px;
--rt-shadow: 0 18px 50px -18px rgba(0,0,0,.72);
--rt-blur: blur(14px);
--rt-glow: 1;
/* The header and composer share one translucent bar colour, and popovers sit
   on a near-opaque panel; both were hardcoded dark and showed as grey bars in
   the light theme. */
--rt-head-bg: rgba(13,15,19,.55);
--rt-pop-bg: rgba(26,29,36,.97);
--rt-well-bg: rgba(0,0,0,.22);
--rt-scrim-strong: rgba(0,0,0,.62);

/* Semantic accents. These are not brightness-dependent in the way text is, but
   they still need a slightly stronger form on light backgrounds to keep their
   contrast — hence the overrides in the light block below. */
--rt-danger: #ff9d94;
--rt-danger-soft: rgba(255,110,100,.16);
--rt-danger-line: rgba(255,120,110,.28);
--rt-gold: #ffd98a;
--rt-gold-soft: rgba(255,214,120,.10);
--rt-gold-line: rgba(255,214,120,.20);
--rt-cheer: rgba(140,155,255,.30);
--rt-cheer-line: rgba(160,170,255,.55);
}

/* ── skin: 玻璃 (the original look) ── */
.rt-root.skin-glass, .rt-overlay.skin-glass {
--rt-surface: rgba(255,255,255,.035);
--rt-surface-2: rgba(255,255,255,.055);
--rt-surface-3: rgba(255,255,255,.09);
--rt-blur: blur(14px);
--rt-shadow: 0 18px 50px -18px rgba(0,0,0,.72);
--rt-glow: 1;
}

/* ── skin: 极简 (flat) ──
 * No blur, no glow, no gradient. Lines carry the structure instead of
 * shadows, which is what makes a flat UI feel quiet rather than dim. */
.rt-root.skin-flat, .rt-overlay.skin-flat {
--rt-surface: rgba(255,255,255,.02);
--rt-surface-2: rgba(255,255,255,.035);
--rt-surface-3: rgba(255,255,255,.06);
--rt-line: rgba(255,255,255,.08);
--rt-line-2: rgba(255,255,255,.13);
--rt-radius: 6px;
--rt-radius-lg: 9px;
--rt-shadow: none;
--rt-blur: none;
--rt-glow: 0;
--rt-accent-soft: rgba(124,140,255,.12);
--rt-accent-line: rgba(150,160,255,.28);
}

/* ── brightness: light ──
 * Flipping the tokens is enough: every component reads them, so nothing else
 * needs a light-mode rule. The accent darkens slightly because #7c8cff on
 * white is too pale to read. */
.rt-root.light, .rt-overlay.light {
--rt-text: #171a20;
--rt-text-2: rgba(20,24,32,.82);
--rt-text-3: rgba(20,24,32,.58);
--rt-text-4: rgba(20,24,32,.42);
--rt-text-5: rgba(20,24,32,.26);

--rt-bg: #f4f5f8;
--rt-surface: rgba(20,24,32,.028);
--rt-surface-2: rgba(20,24,32,.05);
--rt-surface-3: rgba(20,24,32,.085);
--rt-surface-solid: #ffffff;

--rt-line: rgba(20,24,32,.09);
--rt-line-2: rgba(20,24,32,.15);
--rt-accent: #4c5ee0;
--rt-accent-soft: rgba(76,94,224,.12);
--rt-accent-line: rgba(76,94,224,.32);

--rt-head-bg: rgba(255,255,255,.82);
--rt-pop-bg: #ffffff;
--rt-well-bg: rgba(20,24,32,.035);

--rt-shadow: 0 16px 40px -20px rgba(20,24,32,.28);
/* The light surfaces are 82% opaque or fully opaque, so a backdrop blur
   changes almost nothing while still being recomputed on every scroll
   frame. Dropping it here is free visually and removes the cost. */
--rt-blur: none;
}
.rt-root.light.skin-flat, .rt-overlay.light.skin-flat {
--rt-surface: rgba(20,24,32,.02);
--rt-surface-2: rgba(20,24,32,.04);
--rt-surface-3: rgba(20,24,32,.07);
--rt-line: rgba(20,24,32,.12);
--rt-line-2: rgba(20,24,32,.2);
--rt-head-bg: #f4f5f8;
}

.rt-root {
display: flex; height: 100%; min-height: 0; position: relative;
background: var(--rt-bg);
color: var(--rt-text);
font-size: 13.5px;
-webkit-font-smoothing: antialiased;
}
/* The glow lives on a pseudo-element so 极简 can switch it off entirely
   without changing the base background colour. */
.rt-root::before {
content: ''; position: absolute; inset: 0; pointer-events: none;
background:
  radial-gradient(1200px 500px at 12% -8%, rgba(120,132,255,.10), transparent 62%),
  radial-gradient(900px 420px at 88% 108%, rgba(255,140,190,.075), transparent 60%);
opacity: var(--rt-glow);
transition: opacity .2s;
}
.rt-root.light::before {
background:
  radial-gradient(1100px 460px at 10% -10%, rgba(90,110,255,.09), transparent 60%),
  radial-gradient(860px 400px at 90% 110%, rgba(230,120,170,.07), transparent 58%);
}

/* ── rail ─────────────────────────────────────────────────────────────── */
.rt-rail {
width: 192px; flex: 0 0 192px; display: flex; flex-direction: column; min-height: 0;
border-right: 1px solid var(--rt-line);
background: var(--rt-surface);
/* Follows the skin like every other blur. Hard-coding it here meant the
   极简 skin still paid for a blur it never showed. */
backdrop-filter: var(--rt-blur);
}
.rt-brand {
display: flex; align-items: center; justify-content: space-between;
padding: 16px 14px 10px; font-weight: 650; letter-spacing: .14em; font-size: 12px;
color: var(--rt-text-3);
}
.rt-rooms { flex: 1 1 auto; overflow-y: auto; padding: 2px 8px 8px; }
.rt-room {
display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer;
border-radius: 10px; color: var(--rt-text-3); margin-bottom: 2px;
transition: background .16s, color .16s, box-shadow .16s;
position: relative;
}
.rt-room:hover { background: var(--rt-surface); color: var(--rt-text); }
.rt-room.on {
color: #fff;
background: linear-gradient(100deg, rgba(124,140,255,.20), rgba(255,140,190,.10));
box-shadow: inset 0 0 0 1px rgba(150,160,255,.30), 0 4px 16px -8px rgba(120,132,255,.7);
}
.rt-room-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.rt-room-n {
font-size: 10px; opacity: .5; font-variant-numeric: tabular-nums;
background: var(--rt-surface-2); border-radius: 999px; padding: 0 6px; min-width: 18px; text-align: center;
}
.rt-new {
margin: 8px; padding: 9px; border-radius: 10px; cursor: pointer; font: inherit;
color: var(--rt-text-3);
background: var(--rt-surface);
border: 1px dashed var(--rt-line-2);
transition: all .18s;
}
.rt-new:hover {
color: #fff; border-color: rgba(150,160,255,.5);
background: rgba(124,140,255,.14);
}

/* ── rail collapse & the user's seat ──────────────────────────────────── */
.rt-rail-toggle,
.rt-rail-open {
display: inline-flex; align-items: center; justify-content: center;
border: none; cursor: pointer; color: var(--rt-text-4);
background: transparent; padding: 4px; border-radius: 7px;
transition: color .14s, background .14s;
}
.rt-rail-toggle:hover,
.rt-rail-open:hover { color: #fff; background: var(--rt-surface-2); }

/* Collapsed: the rail keeps no width and the panel takes the whole frame. */
.rt-rail.closed { width: 0; flex-basis: 0; border-right: none; overflow: hidden; }

/* Opener sits inline at the head of the header row.
   Not absolutely positioned: it is the header's first flex child, so it is
   centred by the same align-items that centres the title and buttons. An
   absolute offset had to be hand-tuned and drifted whenever the header grew. */
.rt-rail-open {
flex: 0 0 auto;
margin-right: -2px;
background: transparent; box-shadow: none;
}
.rt-rail-open:hover { background: var(--rt-surface-3); }
/* (The collapsed-header padding rule lives after the .rt-head rule itself —
   written here it would be overridden by that rule on source order.) */

/* The user's own row at the foot of the rail. */
.rt-me {
display: flex; align-items: center; gap: 8px; width: calc(100% - 16px);
margin: 0 8px 8px; padding: 6px 8px; cursor: pointer; font: inherit;
border: none; border-radius: 10px; text-align: left;
color: var(--rt-text-2); background: var(--rt-surface);
box-shadow: inset 0 0 0 1px var(--rt-line);
transition: background .16s, color .16s;
}
.rt-me:hover { background: var(--rt-surface-2); color: #fff; }
.rt-me-name {
flex: 1 1 auto; min-width: 0; font-size: 12px;
overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rt-me-gear { display: inline-flex; align-items: center; opacity: .45; transition: opacity .14s; }
.rt-me:hover .rt-me-gear { opacity: .9; }

/* Profile dialog */
.rt-profile-preview {
display: flex; align-items: center; gap: 12px;
padding: 12px; margin-bottom: 14px; border-radius: 12px;
background: var(--rt-surface);
box-shadow: inset 0 0 0 1px var(--rt-line);
}
.rt-profile-name { font-size: 13px; font-weight: 600; }
.rt-profile-sub { font-size: 10.5px; color: var(--rt-text-4); margin-top: 2px; }
.rt-swatches { display: flex; flex-wrap: wrap; gap: 7px; }
.rt-swatch {
width: 26px; height: 26px; border-radius: 50%; cursor: pointer;
border: none; padding: 0;
box-shadow: inset 0 0 0 1px var(--rt-line-2);
transition: transform .12s, box-shadow .12s;
}
.rt-swatch:hover { transform: scale(1.08); }
.rt-swatch.on { box-shadow: 0 0 0 2px var(--rt-bg), 0 0 0 3px var(--rt-accent-line); }

/* Appearance pickers: a row of cards rather than a dropdown, so the choice is
   visible without opening anything. */
.rt-choice-row { display: flex; flex-wrap: wrap; gap: 8px; }
.rt-choice {
display: flex; flex-direction: column; gap: 2px; min-width: 104px;
padding: 9px 12px; cursor: pointer; font: inherit; text-align: left;
border: none; border-radius: var(--rt-radius); color: var(--rt-text-3);
background: var(--rt-surface);
box-shadow: inset 0 0 0 1px var(--rt-line-2);
transition: background .14s, box-shadow .14s, color .14s;
}
.rt-choice:hover { background: var(--rt-surface-2); color: var(--rt-text-2); }
.rt-choice.on {
color: var(--rt-text);
background: var(--rt-accent-soft);
box-shadow: inset 0 0 0 1px var(--rt-accent-line);
}
.rt-choice-name { font-size: 12.5px; font-weight: 560; }
.rt-choice-hint { font-size: 10.5px; color: var(--rt-text-4); line-height: 1.4; }
.rt-choice.on .rt-choice-hint { color: var(--rt-text-3); }
/* The selected swatch ring needs a colour that works on both backgrounds. */
.rt-root.light .rt-swatch.on,
.rt-overlay.light .rt-swatch.on {
box-shadow: 0 0 0 2px var(--rt-bg), 0 0 0 3px var(--rt-accent);
}

/* ── main ─────────────────────────────────────────────────────────────── */
.rt-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; min-height: 0; }

.rt-head {
display: flex; align-items: center; gap: 10px; padding: 10px 18px;
border-bottom: 1px solid var(--rt-line);
background: var(--rt-head-bg); backdrop-filter: var(--rt-blur) saturate(140%);
position: relative; z-index: 5;
min-width: 0;
}
/* With the rail collapsed the opener becomes the header's first child, so it
   needs no reserved space of its own — the normal header padding already houses
   it. Kept as a hook in case the opener ever moves back to an overlay. */
.rt-root.rail-closed .rt-head { padding-left: 12px; }
.rt-title {
font-weight: 640; font-size: 14px; letter-spacing: -.01em;
flex: 0 1 auto; min-width: 0;
overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
max-width: 220px;
}

/* The member list is the part that used to explode the header.
   Rules: it may shrink, its chips may shrink, and when they still do not fit
   they wrap onto a second line instead of overflowing the bar. A wrap keeps
   every chip readable, which a horizontal scroll would not. */
/* The member strip is the piece that has to adapt, not overflow.
   Three levels, applied by available width (see chipDensity):
     full  — avatar + name + points, one line
     short — avatar + name, points folded into the tooltip
     mini  — avatar only, everything in the tooltip
   Wrapping is a last resort for the full level only; mini never wraps because
   avatars are a fixed 16px and the count is capped at MAX_MEMBERS. */
.rt-chips {
display: flex; flex-wrap: nowrap; gap: 5px;
flex: 1 1 auto; min-width: 0; overflow: hidden;
align-items: center;
}
.rt-chips.wrap { flex-wrap: wrap; max-height: 52px; align-content: center; }
.rt-chip {
display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px 2px 2px;
border-radius: 999px; font-size: 11px; white-space: nowrap;
background: var(--rt-surface-2);
box-shadow: inset 0 0 0 1px var(--rt-line);
color: var(--rt-text-2);
flex: 0 1 auto; min-width: 0; max-width: 150px;
}
.rt-chip.mini { padding: 2px; gap: 0; }
/* short level squeezes spacing and type a little so more names survive before
   the strip has to fall back to avatars. */
.rt-chip-more {
  padding: 2px 7px;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--rt-text-3);
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--rt-line);
}
.rt-chip.short { padding: 1px 6px 1px 1px; gap: 4px; font-size: 10px; max-width: 110px; }
.rt-chip > span:last-child {
overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* Never squeezed, never wrapped: the action group keeps its natural width even
   when the chip list above it needs two rows. */
.rt-head-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.rt-chip .rt-av { width: 16px; height: 16px; font-size: 8px; }

.rt-btn {
background: var(--rt-surface-2); border: none; border-radius: 9px;
padding: 6px 13px; color: var(--rt-text-2); cursor: pointer; font: inherit; font-size: 12px;
box-shadow: inset 0 0 0 1px var(--rt-line);
transition: all .16s;
/* Header buttons must never wrap or shrink: a chip list that grows to two rows
   squeezed them into stacked characters. */
flex: 0 0 auto; white-space: nowrap;
}
.rt-btn:hover { background: var(--rt-surface-3); color: #fff; }
.rt-btn:active { transform: translateY(.5px); }
.rt-btn.primary {
background: linear-gradient(135deg, hsl(232 72% 62%), hsl(285 64% 58%));
color: #fff; font-weight: 550;
box-shadow: 0 4px 16px -6px hsl(252 70% 55% / .8);
}
.rt-btn.primary:hover { filter: brightness(1.1); }
.rt-btn.danger { color: #ff9d94; box-shadow: inset 0 0 0 1px var(--rt-danger-line); }
.rt-btn.danger:hover { background: var(--rt-danger-soft); }
.rt-btn:disabled { opacity: .38; cursor: default; transform: none; filter: none; }

/* ── stream ───────────────────────────────────────────────────────────── */
.rt-stream { flex: 1 1 auto; overflow-y: auto; min-height: 0; scroll-behavior: smooth; }
.rt-inner { max-width: 720px; margin: 0 auto; padding: 22px 22px 28px; }

.rt-msg { display: flex; gap: 11px; padding: 9px 0; align-items: flex-start; }
@keyframes rt-in { from { opacity: 0; transform: translateY(4px); } }
.rt-av { font-family: ui-sans-serif, system-ui, sans-serif; }

.rt-body { flex: 1 1 auto; min-width: 0; }
.rt-mhead { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; flex-wrap: wrap; }
.rt-who { font-size: 12.5px; font-weight: 620; letter-spacing: -.01em; }
.rt-time { font-size: 10.5px; color: var(--rt-text-5); font-variant-numeric: tabular-nums; }
.rt-tag {
font-size: 9.5px; color: var(--rt-text-4);
background: var(--rt-surface-2); border-radius: 5px; padding: 1px 6px;
box-shadow: inset 0 0 0 1px var(--rt-line);
max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* Rows do not animate on mount by default: a 0.22s fade-up is pleasant
   for one arriving message, but "load more" mounts dozens at once and they
   would all play together. Only the newest row carries rt-msg-fresh. */
.rt-msg-fresh { animation: rt-in .22s ease-out; }

.rt-bubble {
background: var(--rt-surface);
border-radius: 4px 14px 14px 14px;
padding: 9px 13px;
box-shadow: inset 0 0 0 1px var(--rt-line);
color: var(--rt-text);
line-height: 1.62;
white-space: pre-wrap; word-break: break-word;
}
.rt-msg.user .rt-bubble {
background: linear-gradient(135deg, rgba(124,140,255,.20), rgba(255,140,190,.13));
box-shadow: inset 0 0 0 1px rgba(150,160,255,.26);
border-radius: 14px 14px 14px 4px;
}
.rt-mention {
color: #b9c0ff; font-weight: 550;
background: rgba(124,140,255,.18); border-radius: 5px; padding: 0 4px;
box-shadow: inset 0 0 0 1px rgba(150,160,255,.22);
}
.rt-err { color: #ff9d94; }
.rt-muted { color: var(--rt-text-4); font-style: italic; }

.rt-caret {
display: inline-block; width: 7px; height: 14px; border-radius: 2px;
background: linear-gradient(180deg, hsl(232 72% 66%), hsl(285 64% 60%));
vertical-align: -2px; margin-left: 2px;
animation: rt-blink 1.05s ease-in-out infinite;
box-shadow: 0 0 10px -1px hsl(255 70% 60% / .8);
will-change: opacity; contain: paint;
}
@keyframes rt-blink { 0%,100% { opacity: 1; } 50% { opacity: .18; } }

/* typing dots */
.rt-typing { display: inline-flex; gap: 4px; align-items: center; padding: 2px 0; will-change: transform; contain: paint; }
.rt-typing i {
width: 6px; height: 6px; border-radius: 50%; background: var(--rt-text-4);
animation: rt-bob 1.15s ease-in-out infinite;
}
.rt-typing i:nth-child(2) { animation-delay: .16s; }
.rt-typing i:nth-child(3) { animation-delay: .32s; }
@keyframes rt-bob { 0%,80%,100% { transform: translateY(0); opacity: .4; } 40% { transform: translateY(-4px); opacity: 1; } }

/* Thinking state: dots + a plain label inside the bubble. */
.rt-thinking { display: flex; align-items: center; gap: 8px; }

/* Live-turn controls in the message header: elapsed clock + stop. */
.rt-live { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; }
.rt-think-label {
font-size: 10.5px; color: var(--rt-text-4);
font-variant-numeric: tabular-nums;
}
.rt-think-stop {
font: inherit; font-size: 10.5px; cursor: pointer;
color: var(--rt-text-2); background: var(--rt-surface-2);
border: none; border-radius: 6px; padding: 2px 9px;
box-shadow: inset 0 0 0 1px var(--rt-line-2);
transition: all .14s;
}
.rt-think-stop:hover { background: var(--rt-danger-soft); color: var(--rt-danger); box-shadow: inset 0 0 0 1px var(--rt-danger-line); }

/* The elapsed clock changes tone as the wait grows. A slow turn is normal and
   stays quiet; a turn that has produced nothing for over a minute is reported,
   because "still working" and "silently dead" look identical otherwise. */
.rt-live.slow .rt-think-label { color: var(--rt-gold); }
.rt-live.stuck .rt-think-label { color: var(--rt-danger); }
.rt-think-note {
font-size: 10px; color: var(--rt-danger);
padding: 1px 6px; border-radius: 5px;
background: var(--rt-danger-soft);
white-space: nowrap;
}

.rt-empty {
display: flex; flex-direction: column; align-items: center; justify-content: center;
gap: 12px; padding: 84px 24px; text-align: center;
}
.rt-empty h3 { font-size: 16px; font-weight: 640; margin: 0; letter-spacing: -.015em; }
.rt-empty p { margin: 0; font-size: 12.5px; line-height: 1.8; max-width: 400px; color: var(--rt-text-4); white-space: pre-wrap; }
.rt-empty .rt-glow {
width: 62px; height: 62px; border-radius: 50%; margin-bottom: 6px;
background: linear-gradient(140deg, hsl(232 72% 60%), hsl(285 64% 56%));
box-shadow: 0 10px 40px -8px hsl(255 70% 55% / .75);
display: flex; align-items: center; justify-content: center;
font-size: 26px; color: #fff;
}

/* ── composer ─────────────────────────────────────────────────────────── */
.rt-composer { border-top: 1px solid var(--rt-line); background: var(--rt-head-bg); backdrop-filter: var(--rt-blur); }
.rt-cinner { max-width: 720px; margin: 0 auto; padding: 12px 22px 14px; position: relative; }
.rt-input {
width: 100%; min-height: 44px; max-height: 150px; resize: none; font: inherit;
background: var(--rt-surface-2); color: inherit; outline: none;
border: none; border-radius: 14px; padding: 12px 14px; line-height: 1.55;
box-shadow: inset 0 0 0 1px var(--rt-line);
transition: box-shadow .18s, background .18s;
}
.rt-input:focus {
background: var(--rt-surface-2);
box-shadow: inset 0 0 0 1px rgba(150,160,255,.55), 0 0 0 3px rgba(124,140,255,.14);
}
.rt-input::placeholder { color: var(--rt-text-5); }
.rt-cbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-top: 9px; }
.rt-actions { display: inline-flex; align-items: center; gap: 6px; }
.rt-emoji-btn { padding: 2px 9px; font-size: 14px; line-height: 1.2; }
.rt-emoji-btn.on { background: rgba(124,140,255,.20); color: #fff; }

/* ── red packets ──────────────────────────────────────────────────────── */
.rt-packet-av {
width: 28px; height: 28px; flex: 0 0 28px; border-radius: 50%;
display: flex; align-items: center; justify-content: center; font-size: 16px;
background: linear-gradient(150deg, hsl(6 78% 58%), hsl(20 76% 46%));
box-shadow: 0 0 0 1px var(--rt-danger-line), 0 3px 12px -3px rgba(200,60,40,.7);
}
.rt-packet {
display: flex; align-items: center; justify-content: space-between; gap: 14px;
padding: 12px 14px; border-radius: 4px 14px 14px 14px;
background: linear-gradient(120deg, rgba(230,70,50,.16), rgba(255,150,90,.09));
box-shadow: inset 0 0 0 1px var(--rt-danger-line);
}
.rt-packet-left { min-width: 0; }
.rt-packet-amount { font-size: 15px; font-weight: 650; color: #ffb4a4; }
.rt-packet-note { font-size: 11.5px; color: var(--rt-text-3); margin-top: 2px; }

/* Recipient picker for a 专属 packet. */
.rt-pick-list {
display: flex; flex-wrap: wrap; gap: 6px;
max-height: 132px; overflow-y: auto;
padding: 8px; border-radius: var(--rt-radius);
background: var(--rt-surface);
box-shadow: inset 0 0 0 1px var(--rt-line);
}
.rt-pick {
display: inline-flex; align-items: center; gap: 6px;
padding: 4px 9px 4px 4px; cursor: pointer; font: inherit; font-size: 11.5px;
border: none; border-radius: 999px;
color: var(--rt-text-3); background: var(--rt-surface-2);
box-shadow: inset 0 0 0 1px var(--rt-line);
transition: background .13s, color .13s, box-shadow .13s;
}
.rt-pick:hover { background: var(--rt-surface-3); color: var(--rt-text-2); }
.rt-pick.on {
color: var(--rt-text);
background: var(--rt-accent-soft);
box-shadow: inset 0 0 0 1px var(--rt-accent-line);
}
.rt-pick-name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* A one-line restatement of what is about to be sent. */
.rt-packet-summary {
margin-top: 4px; padding: 9px 12px; border-radius: var(--rt-radius);
font-size: 11.5px; color: var(--rt-text-2);
background: var(--rt-accent-soft);
box-shadow: inset 0 0 0 1px var(--rt-accent-line);
}
.rt-packet-right { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
.rt-packet-grab {
font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
padding: 5px 16px; border: none; border-radius: 8px; color: #fff;
background: linear-gradient(135deg, hsl(6 80% 58%), hsl(28 84% 52%));
box-shadow: 0 4px 14px -5px rgba(230,80,40,.55);
}
.rt-packet-grab:hover { filter: brightness(1.12); }
.rt-packet-results { display: flex; flex-direction: column; gap: 2px; }
.rt-grab { display: flex; align-items: center; gap: 8px; font-size: 11px; }
.rt-grab-name { color: var(--rt-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 130px; }
.rt-grab-pts { color: #ffb4a4; font-variant-numeric: tabular-nums; font-weight: 600; }

/* Leaderboard inside the members dialog. */
.rt-rank {
margin-bottom: 14px; padding: 10px 12px; border-radius: 12px;
background: rgba(230,80,50,.06);
box-shadow: inset 0 0 0 1px var(--rt-danger-line);
}
.rt-rank-title { font-size: 10.5px; color: var(--rt-text-4); letter-spacing: .06em; margin-bottom: 7px; }
.rt-rank-row { display: flex; align-items: center; gap: 9px; padding: 4px 0; }
.rt-rank-no {
width: 16px; flex: 0 0 16px; text-align: center; font-size: 10.5px;
color: var(--rt-text-4); font-variant-numeric: tabular-nums;
}
.rt-rank-name { flex: 1 1 auto; min-width: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rt-rank-pts { font-size: 12px; font-weight: 650; color: #ffb4a4; font-variant-numeric: tabular-nums; }

/* Reasoning-effort picker, expanded under a member row. */
.rt-efforts {
margin-top: 8px; padding-top: 8px;
border-top: 1px solid var(--rt-line);
}
.rt-effort-list { display: flex; flex-wrap: wrap; gap: 5px; }
.rt-effort {
font: inherit; font-size: 11px; cursor: pointer; padding: 3px 10px;
border: none; border-radius: 8px; color: var(--rt-text-3);
background: var(--rt-surface-2);
box-shadow: inset 0 0 0 1px var(--rt-line);
}
.rt-effort:hover { background: var(--rt-surface-3); color: #fff; }
.rt-effort.on {
background: rgba(124,140,255,.28); color: #fff;
box-shadow: inset 0 0 0 1px var(--rt-accent-line);
}

/* ── shop ─────────────────────────────────────────────────────────────── */
.rt-shop-tabs { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
.rt-shop-tab {
font: inherit; font-size: 11.5px; cursor: pointer; padding: 4px 12px;
border: none; border-radius: 8px; color: var(--rt-text-3);
background: var(--rt-surface);
}
.rt-shop-tab.on { background: rgba(124,140,255,.26); color: #fff; }
.rt-shop-tip { margin-left: auto; font-size: 10.5px; color: var(--rt-text-5); }

.rt-shop-group {
font-size: 10.5px; color: var(--rt-text-4); letter-spacing: .06em;
margin: 12px 0 6px;
}
.rt-shop-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 6px; }
.rt-shop-item {
padding: 9px 8px; border-radius: 10px; text-align: center;
background: var(--rt-surface);
box-shadow: inset 0 0 0 1px var(--rt-line);
}
/* Icon tiles. The wrapper centres the SVG; the glyph used to be a text character
   sized by font-size, which meant its optical size drifted between platforms. */
.rt-shop-glyph {
display: flex; align-items: center; justify-content: center;
height: 26px; color: var(--rt-text-2);
}
.rt-home-item .rt-shop-glyph, .rt-home-item svg { color: var(--rt-text-2); }
.rt-home-item > svg { margin-right: 3px; vertical-align: -2px; }

/* Square button that holds only an icon: no horizontal padding, or the glyph
   sits off-centre. */
.rt-btn.rt-icon-btn {
display: inline-flex; align-items: center; justify-content: center;
padding: 6px; line-height: 0;
}
.rt-shop-name { font-size: 11.5px; color: var(--rt-text-2); margin-top: 3px; }
.rt-shop-price {
font-size: 10px; color: #ffc9bd; margin-top: 2px;
font-variant-numeric: tabular-nums;
}

.rt-home {
display: flex; gap: 10px; padding: 10px 12px; margin-bottom: 7px;
border-radius: 12px; background: var(--rt-surface);
box-shadow: inset 0 0 0 1px var(--rt-line);
}
.rt-home-main { flex: 1 1 auto; min-width: 0; }
.rt-home-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rt-home-name { font-size: 12px; font-weight: 580; }
.rt-home-pts { font-size: 10.5px; color: #ffc9bd; font-variant-numeric: tabular-nums; }
.rt-home-cheer {
font-size: 9.5px; color: #b9c0ff; background: rgba(124,140,255,.20);
border-radius: 999px; padding: 0 6px;
}
/* 金币 is gold, not another blue pill: the colour is what tells the two
   currencies apart at a glance in a dense row. */
.rt-home-gold {
font-size: 10.5px; color: #ffd98a; font-variant-numeric: tabular-nums;
}
.rt-home-rank {
font-size: 9.5px; color: #1a1408; font-weight: 650;
background: linear-gradient(150deg, #f5d27a, #d8a63f);
border-radius: 999px; padding: 0 7px;
}
.rt-shop-tab.gold.on {
background: var(--rt-gold-soft); color: #ffe9b8;
box-shadow: inset 0 0 0 1px var(--rt-gold-line);
}
.rt-shop-item.gold {
background: var(--rt-gold-soft);
box-shadow: inset 0 0 0 1px var(--rt-gold-line);
}
.rt-shop-item.gold .rt-shop-price { color: #ffd98a; }
.rt-home-empty { font-size: 11px; color: var(--rt-text-5); margin-top: 4px; }
.rt-home-items { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
.rt-home-item {
display: inline-flex; align-items: center; gap: 3px;
font-size: 11px; padding: 2px 7px; border-radius: 7px;
background: var(--rt-surface-2);
color: var(--rt-text-2);
}

/* Emoji picker: anchored above the composer, grouped by category. */
.rt-emoji-panel {
position: absolute; bottom: calc(100% - 4px); left: 22px; z-index: 32;
width: min(340px, calc(100% - 44px));
margin-bottom: 8px; padding: 8px;
background: var(--rt-pop-bg); backdrop-filter: var(--rt-blur) saturate(150%);
border-radius: 14px;
box-shadow: var(--rt-shadow), inset 0 0 0 1px var(--rt-line-2);
animation: rt-pop-in .16s ease-out;
}
.rt-emoji-tabs { display: flex; align-items: center; gap: 4px; padding-bottom: 7px; }
.rt-emoji-tab {
font: inherit; font-size: 10.5px; cursor: pointer; padding: 3px 9px;
border: none; border-radius: 7px; color: var(--rt-text-3);
background: var(--rt-surface);
}
.rt-emoji-tab.on { background: rgba(124,140,255,.28); color: #fff; }
.rt-emoji-close {
margin-left: auto; font: inherit; font-size: 11px; cursor: pointer;
border: none; background: transparent; color: var(--rt-text-4); padding: 2px 6px;
}
.rt-emoji-close:hover { color: #fff; }
.rt-emoji-grid {
display: grid; grid-template-columns: repeat(10, 1fr); gap: 2px;
}
.rt-emoji-cell {
font-size: 17px; line-height: 1; padding: 5px 0; cursor: pointer;
border: none; border-radius: 8px; background: transparent;
transition: background .12s;
}
.rt-emoji-cell:hover { background: rgba(124,140,255,.22); }
.rt-hint { font-size: 11px; color: var(--rt-text-4); flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── mention popup ────────────────────────────────────────────────────── */
.rt-pop {
  max-height: 268px; overflow-y: auto; overscroll-behavior: contain;
position: absolute; bottom: calc(100% - 4px); left: 22px; right: 22px; margin-bottom: 8px; z-index: 30;
padding: 5px;
background: var(--rt-pop-bg); backdrop-filter: var(--rt-blur) saturate(150%);
border-radius: 14px;
box-shadow: var(--rt-shadow), inset 0 0 0 1px var(--rt-line-2);
animation: rt-pop-in .16s ease-out;
}
@keyframes rt-pop-in { from { opacity: 0; transform: translateY(6px) scale(.98); } }
.rt-pop-item {
display: flex; align-items: center; gap: 8px; padding: 7px 9px;
border-radius: 10px; cursor: pointer; font-size: 12.5px; color: var(--rt-text-2);
}
.rt-pop-item.sel, .rt-pop-item:hover { background: rgba(124,140,255,.20); color: #fff; }
.rt-pop-item .rt-handle { margin-left: auto; font-size: 10.5px; color: var(--rt-text-4); font-family: ui-monospace, monospace; }

/* ── modal ────────────────────────────────────────────────────────────── */
.rt-overlay {
position: absolute; inset: 0; z-index: 60; display: flex;
align-items: flex-start; justify-content: center; padding-top: 7vh;
background: var(--rt-scrim, rgba(6,7,10,.62)); backdrop-filter: blur(6px);
animation: rt-fade .16s ease-out;
}
/* The overlay sits outside .rt-root, so it carries the theme classes itself —
   see themeClass in the panel. Without this a light theme would still show a
   dark scrim and a dark card. */
.rt-overlay.light { --rt-scrim: rgba(238,241,246,.74); }
.rt-overlay.skin-flat { backdrop-filter: none; }
@keyframes rt-fade { from { opacity: 0; } }
.rt-modal {
width: min(560px, calc(100% - 36px)); max-height: 78vh; display: flex; flex-direction: column;
background: var(--rt-surface-solid);
border-radius: var(--rt-radius-lg);
box-shadow: var(--rt-shadow), inset 0 0 0 1px var(--rt-line-2);
animation: rt-modal-in .2s cubic-bezier(.2,.9,.3,1);
color: var(--rt-text);
}
/* Settings needs room for two columns: a category rail and the content.
   Height is a maximum, not a fixed value — a short page should not leave a
   quarter of the dialog empty, and a long one scrolls inside the body. */
.rt-modal.wide { width: min(760px, calc(100% - 32px)); max-height: 82vh; }
.rt-overlay.light .rt-modal { background: #ffffff; }
@keyframes rt-modal-in { from { opacity: 0; transform: translateY(10px) scale(.985); } }
.rt-mhead2 {
display: flex; align-items: center; justify-content: space-between;
padding: 16px 20px; font-weight: 640; font-size: 14px;
border-bottom: 1px solid var(--rt-line-2);
}
/* overflow-x is explicit: a long unbroken model id would otherwise force a
 horizontal scrollbar inside the dialog. */
.rt-mbody { padding: 18px 20px; overflow-y: auto; overflow-x: hidden; flex: 1 1 auto; min-width: 0; }

/* ── settings: Windows 11 shape ─────────────────────────────────────────
 * Categories down the left, the chosen page on the right.
 *
 * Two mistakes were made here first, and both are worth recording because both
 * looked plausible:
 *
 *   1. The rail was given a background. W11 does not tint the category rail —
 *      it sits on the same surface as the page, so the dialog reads as one
 *      sheet instead of two panels glued together.
 *   2. The selected item was marked with a bar running the full height of the
 *      row. W11 uses a short pill roughly the height of the label. A full-height
 *      bar reads as a tab strip from an older design language.
 *
 * So: no rail tint, no divider, and the marker is a small pill sized to the
 * text and centred on the row.
 */
.rt-set {
flex: 1 1 auto; min-height: 360px; display: flex;
overflow: hidden;
}
.rt-set-nav {
width: 190px; flex: 0 0 190px; display: flex; flex-direction: column; gap: 2px;
padding: 14px 10px; overflow-y: auto;
background: transparent;
border-right: none;
}
.rt-set-nav-item {
position: relative;
display: flex; align-items: center; gap: 11px; width: 100%;
padding: 8px 10px 8px 14px; cursor: pointer; font: inherit; text-align: left;
border: none; border-radius: 6px;
color: var(--rt-text-3); background: transparent;
transition: background .13s, color .13s;
}
.rt-set-nav-item:hover { background: var(--rt-surface-2); color: var(--rt-text-2); }
/* Selection is the short pill on the left, not a filled row: a fill plus a
   pill reads as a block being dragged along. */
.rt-set-nav-item.on { color: var(--rt-text); background: transparent; }
/* The marker: a short pill the height of the label, not the whole row. It grows
   from the centre rather than sliding in, which reads as calmer. */
.rt-set-nav-item::before {
content: ''; position: absolute; left: 4px; top: 50%;
width: 3px; height: 16px; border-radius: 2px;
background: var(--rt-accent);
transform: translateY(-50%) scaleY(0);
transition: transform .16s ease;
}
.rt-set-nav-item.on::before { transform: translateY(-50%) scaleY(1); }
/* The icon inherits the row's colour, so hover and selection recolour it
   without a second rule. Sized to the label's cap height rather than the old
   15px emoji, which sat on its own baseline and pushed the row taller. */
.rt-set-nav-glyph {
flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
width: 16px; height: 16px;
color: var(--rt-text-4);
transition: color .13s;
}
.rt-set-nav-item:hover .rt-set-nav-glyph { color: var(--rt-text-3); }
.rt-set-nav-item.on .rt-set-nav-glyph { color: var(--rt-accent); }
.rt-set-nav-text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.rt-set-nav-label { font-size: 12.5px; font-weight: 540; }
.rt-set-nav-hint {
font-size: 10px; color: var(--rt-text-4);
overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rt-set-nav-item.on .rt-set-nav-hint { color: var(--rt-text-3); }

.rt-set-body {
flex: 1 1 auto; min-width: 0; overflow-y: auto; padding: 16px 20px 24px;
}

/* A titled group. W11 puts a heading above a run of related controls and
 puts those controls on one card, so a page reads as a few short blocks rather
 than a list of everything.
 Note: no subtitle under the heading. A second greyed line explaining what the
 heading already says is noise. */
.rt-set-group { margin-bottom: 24px; }
.rt-set-group:last-child { margin-bottom: 0; }
.rt-set-group-title {
font-size: 12px; font-weight: 620; margin-bottom: 8px;
color: var(--rt-text-2);
}
.rt-set-card {
border-radius: 8px; overflow: hidden;
background: var(--rt-surface-2);
box-shadow: inset 0 0 0 1px var(--rt-line);
}
.rt-set-pad { padding: 14px; }

/* A label/control pair on one line. Rows inside a card are separated by a
 hairline, the way W11 stacks settings. */
.rt-set-row {
display: flex; align-items: center; gap: 14px;
padding: 12px 14px; border-bottom: 1px solid var(--rt-line);
}
.rt-set-row:last-child { border-bottom: none; }
.rt-set-row-main { flex: 1 1 auto; min-width: 0; }
.rt-set-row-label { font-size: 12.5px; }
.rt-set-row-hint { font-size: 10.5px; color: var(--rt-text-4); margin-top: 2px; line-height: 1.5; }
.rt-set-row-ctl { flex: 0 0 auto; }
.rt-set-value { font-size: 12px; color: var(--rt-text-3); }

/* The account hero: avatar and name field on one line, no caption. */
.rt-set-hero {
display: flex; align-items: center; gap: 16px;
margin-bottom: 24px;
}
.rt-set-hero .rt-set-input { flex: 1 1 auto; min-width: 0; }

/* Theme/skin picker: a preview tile plus a label, chosen as one block. */
.rt-set-pick {
display: flex; align-items: center; gap: 12px; width: 100%;
padding: 12px 14px; cursor: pointer; font: inherit; text-align: left;
border: none; background: transparent;
border-bottom: 1px solid var(--rt-line);
color: var(--rt-text-2);
transition: background .13s;
}
.rt-set-pick:last-child { border-bottom: none; }
.rt-set-pick:hover { background: var(--rt-surface-3); }
.rt-set-pick.on { background: var(--rt-surface-3); }
.rt-set-pick-label { flex: 1 1 auto; font-size: 12.5px; }
.rt-set-pick-check { flex: 0 0 auto; color: var(--rt-accent); font-size: 13px; }

/* A miniature of the theme itself, not a description of it. */
.rt-set-pv {
position: relative; flex: 0 0 auto; width: 46px; height: 32px;
border-radius: 5px; overflow: hidden;
box-shadow: inset 0 0 0 1px var(--rt-line-2);
}
.rt-set-pv .rt-pv-bar {
position: absolute; left: 0; top: 0; bottom: 0; width: 12px;
}
.rt-set-pv .rt-pv-body {
position: absolute; left: 12px; right: 0; top: 0; bottom: 0;
}
.rt-set-pv.glass .rt-pv-bar { background: linear-gradient(180deg, #2a2d38, #1c1e26); }
.rt-set-pv.glass .rt-pv-body {
background: radial-gradient(60px 30px at 20% 0%, rgba(120,132,255,.55), transparent 70%), #15171d;
}
.rt-set-pv.flat .rt-pv-bar { background: #23252c; }
.rt-set-pv.flat .rt-pv-body { background: #15171d; }
.rt-set-pv.dark .rt-pv-bar { background: #23252c; }
.rt-set-pv.dark .rt-pv-body { background: #15171d; }
.rt-set-pv.light .rt-pv-bar { background: #e2e5ec; }
.rt-set-pv.light .rt-pv-body { background: #f7f8fa; }
/* In light mode the two dark previews would be indistinguishable from the card,
 so they keep their own colours — a preview of a theme must not follow the
 theme, or it stops previewing anything. */

/* A radio-style option row, used for the auto-reply policy. */
.rt-set-option {
display: flex; align-items: center; gap: 10px; width: 100%;
padding: 11px 14px; cursor: pointer; font: inherit; text-align: left;
border: none; background: transparent;
border-bottom: 1px solid var(--rt-line);
color: var(--rt-text-3);
transition: background .13s, color .13s;
}
.rt-set-option:last-child { border-bottom: none; }
.rt-set-option:hover { background: var(--rt-surface-3); color: var(--rt-text-2); }
.rt-set-option.on { color: var(--rt-text); }
.rt-set-option-label { flex: 1 1 auto; font-size: 12.5px; }
.rt-set-radio {
flex: 0 0 auto; width: 15px; height: 15px; border-radius: 50%;
display: inline-flex; align-items: center; justify-content: center;
box-shadow: inset 0 0 0 1px var(--rt-line-2);
transition: box-shadow .13s;
}
.rt-set-option.on .rt-set-radio { box-shadow: inset 0 0 0 1px var(--rt-accent); }
.rt-set-radio > span {
width: 7px; height: 7px; border-radius: 50%; background: var(--rt-accent);
}

.rt-set-input {
width: 100%; font: inherit; font-size: 12.5px;
padding: 9px 12px; border: none; border-radius: 6px;
color: var(--rt-text); background: var(--rt-surface);
box-shadow: inset 0 0 0 1px var(--rt-line-2);
}
.rt-set-input-lg { font-size: 15px; font-weight: 600; padding: 8px 10px; }
.rt-set-input:focus { outline: none; box-shadow: inset 0 0 0 1px var(--rt-accent-line); }
.rt-mfoot {
display: flex; justify-content: flex-end; gap: 8px; padding: 14px 20px;
border-top: 1px solid var(--rt-line-2);
}

.rt-field { margin-bottom: 16px; min-width: 0; }
.rt-field > label {
display: block; font-size: 11px; color: var(--rt-text-4);
margin-bottom: 7px; letter-spacing: .03em; font-weight: 550;
}
.rt-field input[type=text], .rt-field textarea {
width: 100%; min-width: 0; font: inherit; color: inherit; outline: none;
background: var(--rt-surface-2); border: none; border-radius: 11px;
padding: 9px 12px;
box-shadow: inset 0 0 0 1px var(--rt-line-2);
transition: box-shadow .16s;
}
.rt-field input[type=text]:focus, .rt-field textarea:focus {
box-shadow: inset 0 0 0 1px rgba(150,160,255,.55), 0 0 0 3px rgba(124,140,255,.12);
}
.rt-hint2 { font-size: 11px; color: var(--rt-text-5); margin-top: 6px; line-height: 1.6; min-width: 0; }

/* model list */
.rt-models {
max-height: 300px; overflow-y: auto; overflow-x: hidden; margin-top: 8px;
background: var(--rt-well-bg); border-radius: 12px; padding: 5px;
box-shadow: inset 0 0 0 1px var(--rt-line);
}
/* Provider headings keep their real casing: route ids like our-free-model
 and qodercn are what the user configured, and upper-casing them made
 them harder to recognise, not cleaner. */
.rt-prov {
font-size: 10.5px; color: var(--rt-text-4); letter-spacing: .02em;
padding: 10px 10px 5px; font-weight: 600;
}
/* The adapter's display name leads; the raw route id follows underneath in the
   monospace treatment, so the two are visually separable. */
.rt-prov-name { display: block; color: var(--rt-text-3); font-size: 11.5px; }
/* How many models this route reported. A route with none used to be
   indistinguishable from a route that was never configured. */
.rt-prov-n {
margin-left: 6px; font-size: 10px;
color: var(--rt-text-5);
font-variant-numeric: tabular-nums;
}
.rt-prov-id {
display: block; margin-top: 1px;
font-family: ui-monospace, Consolas, monospace; font-size: 9.5px;
color: var(--rt-text-5); font-weight: 400;
}
.rt-mp {
display: flex; align-items: center; gap: 9px; padding: 8px 10px;
border-radius: 9px; cursor: pointer; transition: background .14s;
min-width: 0; overflow: hidden;
}
.rt-mp:hover { background: var(--rt-surface-2); }
.rt-mp.on {
background: linear-gradient(100deg, rgba(124,140,255,.26), rgba(255,140,190,.13));
box-shadow: inset 0 0 0 1px rgba(150,160,255,.34);
}
.rt-mp-name { flex: 1 1 auto; min-width: 0; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rt-mp-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.rt-mp-id {
font-size: 10px; color: var(--rt-text-5); font-family: ui-monospace, Consolas, monospace;
overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rt-mp-badge {
font-size: 9.5px; color: var(--rt-text-4); flex: 0 0 auto;
background: var(--rt-surface-2); border-radius: 5px; padding: 1px 6px;
}
/* Characters the search query hit. */
.rt-hit {
background: var(--rt-cheer); color: #dbe0ff;
border-radius: 3px; padding: 0 1px; font-weight: 600;
}
/* Selection tick box: fixed square, never squeezed by a long model name. */
.rt-check {
width: 15px; height: 15px; flex: 0 0 15px; border-radius: 4px;
display: flex; align-items: center; justify-content: center;
font-size: 10px; line-height: 1; color: #fff;
background: var(--rt-surface-2);
box-shadow: inset 0 0 0 1px var(--rt-line-2);
}
.rt-check.on {
background: rgba(124,140,255,.55);
box-shadow: inset 0 0 0 1px var(--rt-cheer-line);
}

/* member rows */
.rt-row {
display: flex; align-items: center; gap: 11px; padding: 10px 12px; margin-bottom: 7px;
border-radius: 12px; background: var(--rt-surface);
box-shadow: inset 0 0 0 1px var(--rt-line);
}
.rt-row-main { flex: 1 1 auto; min-width: 0; }
.rt-row-name {
display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
font-size: 12.5px; font-weight: 580;
}
.rt-row-rank {
font-size: 9px; color: #1a1408; font-weight: 650;
background: linear-gradient(150deg, #f5d27a, #d8a63f);
border-radius: 999px; padding: 0 6px;
}
.rt-row-away {
font-size: 9.5px; color: #a9b6d8;
background: var(--rt-cheer);
border-radius: 999px; padding: 0 7px;
font-variant-numeric: tabular-nums;
}
.rt-row-money { font-size: 10.5px; color: var(--rt-text-4); font-variant-numeric: tabular-nums; }

/* ── quote reply ──────────────────────────────────────────────────────── */
.rt-quote-btn {
font: inherit; font-size: 10px; cursor: pointer; padding: 1px 7px;
border: none; border-radius: 7px; margin-left: auto;
color: var(--rt-text-4); background: transparent;
opacity: 0; transition: opacity .14s, color .14s, background .14s;
}
.rt-msg:hover .rt-quote-btn { opacity: 1; }
.rt-quote-btn:hover { color: #fff; background: var(--rt-surface-3); }

/* The quoted line above a reply. A left rule, not a box: it reads as a pointer
   rather than as another bubble. */
.rt-quote {
display: flex; gap: 6px; align-items: baseline; min-width: 0;
margin: 0 0 5px; padding: 3px 0 3px 9px;
border-left: 2px solid var(--rt-cheer-line);
font-size: 11px; color: var(--rt-text-4);
}
.rt-quote-who { color: rgba(160,175,255,.8); flex: 0 0 auto; font-weight: 560; }
.rt-quote-text {
min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* The pending quote sits above the composer, so it is obvious what the next
   message will answer before it is sent. */
.rt-quote-pending {
display: flex; align-items: center; gap: 8px;
margin: 0 0 6px; padding: 5px 10px; border-radius: 8px;
background: var(--rt-cheer);
box-shadow: inset 0 0 0 1px var(--rt-cheer-line);
font-size: 11px; color: var(--rt-text-3);
}
.rt-quote-pending .rt-quote-text { flex: 1 1 auto; }
.rt-quote-cancel {
font: inherit; font-size: 11px; cursor: pointer; border: none;
background: transparent; color: var(--rt-text-4); padding: 0 3px;
}
.rt-quote-cancel:hover { color: #fff; }

/* ── 群公告 ───────────────────────────────────────────────────────────── */
.rt-notice-input {
width: 100%; resize: vertical; font: inherit; font-size: 12px; line-height: 1.5;
padding: 8px 10px; border-radius: 9px; border: none;
color: var(--rt-text); background: var(--rt-surface-2);
box-shadow: inset 0 0 0 1px var(--rt-line-2);
font-family: inherit;
}
.rt-notice-input:focus { outline: none; box-shadow: inset 0 0 0 1px var(--rt-accent-line); }
/* The notice pinned under the header: always visible, never in the way. */
.rt-notice {
display: flex; align-items: center; gap: 7px;
padding: 6px 18px; font-size: 11.5px; color: var(--rt-text-3);
background: var(--rt-gold-soft);
border-bottom: 1px solid var(--rt-gold-line);
}
.rt-notice-tag {
flex: 0 0 auto; font-size: 9.5px; font-weight: 650; letter-spacing: .04em;
color: #ffd98a; background: var(--rt-gold-line);
border-radius: 5px; padding: 1px 6px;
}
.rt-notice-text {
flex: 1 1 auto; min-width: 0;
overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* ── 投票 / 接龙 ──────────────────────────────────────────────────────── */
.rt-vote, .rt-chain {
padding: 11px 13px; border-radius: 12px;
background: var(--rt-surface);
box-shadow: inset 0 0 0 1px var(--rt-line);
min-width: 220px;
}
.rt-vote-q { font-size: 12.5px; font-weight: 560; margin-bottom: 9px; color: var(--rt-text); }
.rt-vote-opt {
position: relative; display: flex; align-items: center; gap: 8px;
width: 100%; margin-bottom: 5px; padding: 7px 10px;
border: none; border-radius: 8px; cursor: pointer; font: inherit;
font-size: 12px; text-align: left; overflow: hidden;
color: var(--rt-text-2); background: var(--rt-surface-2);
transition: background .14s;
}
.rt-vote-opt:hover:not(:disabled) { background: var(--rt-surface-3); }
.rt-vote-opt:disabled { cursor: default; }
.rt-vote-opt.mine { box-shadow: inset 0 0 0 1px var(--rt-accent-line); }
.rt-vote-bar {
position: absolute; left: 0; top: 0; bottom: 0;
background: rgba(124,140,255,.24); border-radius: 8px;
transition: width .25s ease;
}
.rt-vote-label { position: relative; flex: 1 1 auto; min-width: 0; }
.rt-vote-n {
position: relative; font-size: 10.5px; color: var(--rt-text-4);
font-variant-numeric: tabular-nums;
}
.rt-vote-foot {
display: flex; align-items: center; margin-top: 7px;
font-size: 10.5px; color: var(--rt-text-5);
}

.rt-chain-row {
display: flex; align-items: baseline; gap: 8px;
padding: 5px 0; border-top: 1px solid var(--rt-line);
font-size: 12px;
}
.rt-chain-row:first-of-type { border-top: none; }
.rt-chain-no {
flex: 0 0 auto; min-width: 16px; font-size: 10.5px;
color: var(--rt-text-5); font-variant-numeric: tabular-nums;
}
.rt-chain-text { flex: 1 1 auto; min-width: 0; color: var(--rt-text-2); }
.rt-chain-who { flex: 0 0 auto; font-size: 10.5px; color: var(--rt-text-4); }

/* Who voted for what, under the bar. A count alone does not say which models
   agreed, and that is the interesting part of a group vote. */
.rt-vote-who {
display: block; margin-top: 2px; font-size: 10px;
color: var(--rt-text-4);
overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* The inline field for joining a 接龙. */
.rt-chain-add { display: flex; gap: 6px; margin-top: 10px; }
.rt-chain-input { flex: 1 1 auto; min-width: 0; font-size: 11.5px; padding: 7px 10px; }
.rt-vote-opt { flex-wrap: wrap; }

/* ── pinned messages ───────────────────────────────────────────────────── */
/* A strip under the header, above the transcript. Up to three rows, so it never
   becomes a second transcript; each row jumps to its message. */
.rt-pins {
  display: flex; flex-direction: column; gap: 1px;
  padding: 4px 12px 6px;
  border-bottom: 1px solid var(--rt-line);
  background: var(--rt-surface);
}
.rt-pin { display: flex; align-items: center; gap: 2px; min-width: 0; }
.rt-pin-main {
  flex: 1 1 auto; min-width: 0;
  display: flex; align-items: center; gap: 6px;
  padding: 3px 6px; cursor: pointer; font: inherit;
  border: none; border-radius: 5px;
  color: var(--rt-text-3); background: transparent;
  text-align: left;
  transition: background .12s, color .12s;
}
.rt-pin-main:hover { background: var(--rt-surface-2); color: var(--rt-text-2); }
.rt-pin-main svg { flex: 0 0 auto; opacity: .7; }
.rt-pin-text {
  flex: 1 1 auto; min-width: 0;
  font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rt-pin-x {
  flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; padding: 0; cursor: pointer;
  border: none; border-radius: 4px;
  color: var(--rt-text-5); background: transparent;
}
.rt-pin-x:hover { color: var(--rt-danger); background: var(--rt-danger-soft); }

/* The 置顶 toggle, when the row is already pinned. */
.rt-quote-btn.on { color: var(--rt-accent); opacity: 1; }

/* ── 关于 ───────────────────────────────────────────────────────────────── */
/* The hero is the only place in the panel that centres anything: it is a title
   card, not a control, and centring is what makes it read that way. */
.rt-about-hero {
display: flex; flex-direction: column; align-items: center;
padding: 22px 0 26px;
}
.rt-about-mark {
display: flex; align-items: center; justify-content: center;
width: 54px; height: 54px; border-radius: 16px;
color: var(--rt-text);
background: var(--rt-surface-2);
box-shadow: inset 0 0 0 1px var(--rt-line-2);
}
.rt-about-mark svg { width: 30px; height: 30px; }
.rt-about-title {
margin-top: 12px; font-size: 17px; font-weight: 650; letter-spacing: .06em;
color: var(--rt-text);
}
.rt-about-ver {
margin-top: 3px; font-size: 10.5px; color: var(--rt-text-4);
font-variant-numeric: tabular-nums;
}
.rt-about-by {
margin-top: 10px; font-size: 11.5px; color: var(--rt-text-3);
}
.rt-about-by b { color: var(--rt-text-2); font-weight: 600; }

.rt-about-lead {
font-size: 12.5px; line-height: 1.65; color: var(--rt-text-2);
}
.rt-about-note {
margin-top: 7px; font-size: 11px; line-height: 1.7; color: var(--rt-text-4);
}

.rt-about-list { display: flex; flex-direction: column; gap: 9px; }
.rt-about-item { display: flex; flex-direction: column; gap: 2px; }
.rt-about-item-t { font-size: 12px; color: var(--rt-text); }
.rt-about-item-d { font-size: 11px; line-height: 1.6; color: var(--rt-text-4); }

.rt-about-keys { display: flex; flex-direction: column; gap: 7px; }
.rt-about-key {
display: flex; align-items: center; gap: 10px;
font-size: 11.5px; color: var(--rt-text-3);
}
.rt-about-key kbd {
min-width: 92px; padding: 2px 7px; border-radius: 5px;
font: inherit; font-size: 10.5px; text-align: center;
color: var(--rt-text-2); background: var(--rt-surface-2);
box-shadow: inset 0 0 0 1px var(--rt-line-2);
}

/* The maker's mark, at the foot of the rail. Muted to the point where it
   reads as a byline rather than as interface, and it never competes with the
   user's own row above it. */
.rt-made {
padding: 2px 14px 12px;
font-size: 10px;
letter-spacing: .02em;
color: var(--rt-text-5);
user-select: none;
}

/* ── pagination ───────────────────────────────────────────────────────── */
/* The "load older" affordance sits at the top of the transcript, where the
   messages it reveals will appear. */
.rt-loadmore {
display: flex; justify-content: center;
padding: 4px 0 14px;
}
.rt-loadmore .rt-btn {
font-size: 11.5px; padding: 6px 14px;
color: var(--rt-text-3);
}

/* ── attachments ──────────────────────────────────────────────────────── */
/* The strip above the composer: what will be sent with the next message. */
.rt-attach-strip {
display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
margin-bottom: 8px; padding: 7px 9px; border-radius: 8px;
background: var(--rt-surface);
box-shadow: inset 0 0 0 1px var(--rt-line);
}
.rt-attach {
position: relative; width: 38px; height: 38px; border-radius: 6px;
background: var(--rt-surface-3);
box-shadow: inset 0 0 0 1px var(--rt-line-2);
overflow: hidden;
}
.rt-attach-thumb {
display: flex; align-items: center; justify-content: center;
width: 100%; height: 100%; color: var(--rt-text-3);
}
.rt-attach-x {
position: absolute; top: 1px; right: 1px;
display: flex; align-items: center; justify-content: center;
width: 15px; height: 15px; padding: 0; cursor: pointer;
border: none; border-radius: 50%;
color: #fff; background: var(--rt-scrim-strong);
}
.rt-attach-x:hover { background: var(--rt-danger); }
.rt-attach-hint { font-size: 10.5px; color: var(--rt-text-4); margin-left: 2px; }

/* Images inside a sent message. */
.rt-bubble-imgs { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
.rt-bubble-img {
max-width: 220px; max-height: 220px; border-radius: 8px;
box-shadow: inset 0 0 0 1px var(--rt-line-2);
display: block;
}
.rt-bubble-img-missing {
display: flex; align-items: center; gap: 5px;
padding: 6px 10px; border-radius: 8px; font-size: 11px;
color: var(--rt-text-4); background: var(--rt-surface-2);
}

/* ── search ───────────────────────────────────────────────────────────── */
.rt-search-bar {
display: flex; align-items: center; gap: 8px;
padding: 0 0 0 12px; border-radius: 8px;
background: var(--rt-surface);
box-shadow: inset 0 0 0 1px var(--rt-line-2);
}
.rt-search-bar .rt-set-input {
background: transparent; box-shadow: none; padding-left: 0;
}
.rt-search-meta { font-size: 10.5px; color: var(--rt-text-4); margin: 8px 0 10px; }
.rt-search-results { display: flex; flex-direction: column; gap: 4px; }
.rt-search-hit {
display: flex; align-items: baseline; gap: 10px; width: 100%;
padding: 8px 11px; cursor: pointer; font: inherit; text-align: left;
border: none; border-radius: 7px;
color: var(--rt-text-2); background: var(--rt-surface);
transition: background .12s;
}
.rt-search-hit:hover { background: var(--rt-surface-3); }
.rt-search-who {
flex: 0 0 auto; max-width: 96px; font-size: 11px; font-weight: 560;
color: var(--rt-accent);
overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rt-search-text {
flex: 1 1 auto; min-width: 0; font-size: 11.5px;
overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rt-search-time {
flex: 0 0 auto; font-size: 10px; color: var(--rt-text-4);
font-variant-numeric: tabular-nums;
}

/* A flash after jumping to a message, so the eye can find it. */
@keyframes rt-flash-in {
0%, 30% { background: var(--rt-accent-soft); box-shadow: inset 0 0 0 2px var(--rt-accent-line); }
100% { background: transparent; box-shadow: inset 0 0 0 2px transparent; }
}
.rt-msg.rt-flash, .rt-flash {
animation: rt-flash-in 1.2s ease-out;
border-radius: 10px;
}
.rt-row-sub { font-size: 10.5px; color: var(--rt-text-5); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, monospace; }
`

  /**
   * Install the panel stylesheet.
   *
   * The tag is keyed by the stylesheet's *content hash*, not a fixed id. With a
   * fixed id the check "already present?" answered yes after any reload, so a
   * rebuilt plugin kept the previous file's CSS forever — which is exactly why
   * newer rules (the emoji panel, the live controls) appeared to be missing and
   * the picker rendered as loose text.
   */
  const CSS_ID = 'rt-' + (() => {
    let x = 0
    for (let i = 0; i < CSS.length; i++) x = (x * 33 + CSS.charCodeAt(i)) >>> 0
    return x.toString(36)
  })()

  function ensureCss() {
    if (typeof document === 'undefined' || !document.head) return
    if (document.querySelector('style[data-rt="' + CSS_ID + '"]')) return
    // Drop stylesheets from earlier generations so only one revision is live.
    for (const old of document.querySelectorAll('style[data-rt]')) {
      try { old.remove() } catch { /* ignore */ }
    }
    const el = document.createElement('style')
    el.setAttribute('data-rt', CSS_ID)
    el.textContent = CSS
    document.head.appendChild(el)
  }

  // ── shared bits ──────────────────────────────────────────────────────────

  /**
   * The member's avatar.
   *
   * A recognised model family gets its own mark on a tinted disc; anything
   * else gets the generated two-glyph gradient avatar. The disc keeps a fixed
   * size either way, so rows never shift as models are added.
   */
  function Avatar({ member, size }) {
    const s = size ?? 28
    const brand = brandOf(member)
    if (!brand) {
      return h('div', {
        className: 'rt-av',
        style: avatarStyle(member.model ?? member.displayName ?? member.id, s),
        title: member.displayName,
      }, avatarGlyph(member))
    }

    // `tint` is an `hsl(...)` string; splice the alpha in as a separate step so
    // the result never has to be escaped inside a template literal.
    const soft = brand.tint.replace(')', ' / .95)')
    const ring = brand.tint.replace(')', ' / .55)')

    return h('div', {
      className: 'rt-av',
      style: {
        ...avatarStyle(member.model ?? member.displayName ?? member.id, s),
        // A brand disc reads as a logo plate, not a colour chip: keep it deep
        // so the white stroke holds contrast at 16px.
        background: `radial-gradient(120% 120% at 30% 15%, ${soft}, hsl(220 22% 18%))`,
        boxShadow: `0 0 0 1px ${ring}, 0 3px 12px -3px hsl(220 60% 10% / .8)`,
        textShadow: 'none',
      },
      title: member.displayName,
    }, h(BrandMark, { brand, size: s }))
  }

  /**
   * The appearance state, shared across the panel and its dialogs.
   *
   * Dialogs render inside the same React tree but outside `.rt-root`, so a class
   * on the panel alone would leave them on the default theme. Keeping the value
   * in a module-level store lets both halves read it without threading a prop
   * through eight call sites.
   */
  let themeState = { skin: 'glass', mode: 'dark' }
  const themeSubs = new Set()
  function setThemeState(next) {
    themeState = next
    for (const fn of themeSubs) { try { fn(next) } catch { /* ignore */ } }
  }
  function useThemeState() {
    const [value, setValue] = React.useState(themeState)
    React.useEffect(() => {
      themeSubs.add(setValue)
      // Re-sync in case the value changed between render and subscribe.
      setValue(themeState)
      return () => themeSubs.delete(setValue)
    }, [])
    return value
  }
  function themeClasses(t) {
    return ' skin-' + (t?.skin === 'flat' ? 'flat' : 'glass') + (t?.mode === 'light' ? ' light' : '')
  }

  function Modal({ title, onClose, children, footer, wide }) {

    // Esc closes the dialog. Bound on the document rather than the overlay so it
    // works even when focus is inside an input.
    React.useEffect(() => {
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      }
      document.addEventListener('keydown', onKey)
      return () => document.removeEventListener('keydown', onKey)
    }, [onClose])
    const t = useThemeState()
    return h('div', {
      className: 'rt-overlay' + themeClasses(t),
      onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() },
    },
      h('div', { className: 'rt-modal' + (wide ? ' wide' : '') },
        h('div', { className: 'rt-mhead2' },
          h('span', null, title),
          h('button', { className: 'rt-btn rt-icon-btn', onClick: onClose, title: '关闭' }, h(Icon, { name: 'close', size: 14 })),
        ),
        h('div', { className: 'rt-mbody' }, children),
        footer ? h('div', { className: 'rt-mfoot' }, footer) : null,
      ),
    )
  }

  /**
   * Does `text` contain the query as a subsequence?
   *
   * Plain `includes` made finding a model painful: typing `dsv4` or `glmflash`
   * matched nothing even though `deepseek-v4.1-flash` and `glm-5.3-flash` are
   * right there. Subsequence matching is what people expect from a picker.
   *
   * Returns the matched index positions so the caller can highlight them.
   */
  function subseq(text, needle) {
    if (needle === '') return []
    const hay = text.toLowerCase()
    const out = []
    let at = 0
    for (const ch of needle) {
      const i = hay.indexOf(ch, at)
      if (i < 0) return null
      out.push(i)
      at = i + 1
    }
    return out
  }

  /**
   * Score one model against a search query.
   *
   * Every whitespace-separated term must hit *something* — model name, model id,
   * provider id, or the provider's display name — so `free deepseek` narrows
   * instead of widening. Higher scores mean a tighter match; the list sorts by
   * it.
   *
   * The display name matters here: someone looking for `workbuddy` or `腾讯`
   * is searching for the provider as it appears in the app, not for its internal
   * route id.
   */
  function scoreModel(model, provider, terms, providerName) {
    if (terms.length === 0) return 1
    let total = 0
    for (const term of terms) {
      let best = 0
      const fields = [
        { text: model.name, weight: 100 },
        { text: model.id, weight: 70 },
        { text: providerName ?? '', weight: 55 },
        { text: provider, weight: 40 },
      ]
      for (const f of fields) {
        const t = String(f.text).toLowerCase()
        if (t === '') continue
        if (t === term) { best = Math.max(best, f.weight * 3); continue }
        if (t.startsWith(term)) { best = Math.max(best, f.weight * 2); continue }
        if (t.includes(term)) { best = Math.max(best, f.weight); continue }
        if (subseq(f.text, term) !== null) best = Math.max(best, f.weight * 0.5)
      }
      if (best === 0) return null          // this term matches nothing → drop it
      total += best
    }
    return total
  }

  /** Wrap a model name in <mark> spans for the characters the query hit. */
  function highlight(name, terms) {
    if (terms.length === 0) return name
    const hits = new Set()
    for (const term of terms) {
      const pos = subseq(name, term)
      if (pos) for (const i of pos) hits.add(i)
    }
    if (hits.size === 0) return name
    const out = []
    let run = ''
    let runOn = null
    for (let i = 0; i < name.length; i++) {
      const on = hits.has(i)
      if (runOn !== on && run !== '') {
        out.push(runOn
          ? h('mark', { key: 'h' + i, className: 'rt-hit' }, run)
          : run)
        run = ''
      }
      runOn = on
      run += name[i]
    }
    if (run !== '') {
      out.push(runOn ? h('mark', { key: 'h-end', className: 'rt-hit' }, run) : run)
    }
    return out
  }

  /**
   * Add models to the room — one or many.
   *
   * Multi-select on purpose: a group usually wants three or four models, and
   * adding them one modal at a time was the slowest part of setting up a room.
   * Clicking a row toggles it; a footer adds everything selected in one go.
   */
  function ModelPicker({ catalog, taken, onAdd, onClose, onReload }) {
    const [query, setQuery] = React.useState('')
    const [picked, setPicked] = React.useState([])   // [{provider, model, name}]

    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const allProviders = catalog?.providers ?? []

    const providers = allProviders
      .map((p) => {
        const scored = []
        for (const m of p.models) {
          const s = scoreModel(m, p.provider, terms, p.providerName)
          if (s !== null) scored.push({ m, s })
        }
        scored.sort((a, b) => b.s - a.s || a.m.name.localeCompare(b.m.name))
        return {
          provider: p.provider,
          providerName: p.providerName,
          error: p.error,
          models: scored.map((x) => x.m),
        }
      })
      .filter((p) => p.models.length > 0)

    const totalModels = providers.reduce((n, p) => n + p.models.length, 0)

    const isTaken = (provider, model) => taken.some((t) => t.provider === provider && t.model === model)
    const pickKey = (provider, model) => provider + '|' + model
    const pickedSet = new Set(picked.map((x) => pickKey(x.provider, x.model)))

    const toggle = (m, provider) => {
      const k = pickKey(provider, m.id)
      if (pickedSet.has(k)) setPicked(picked.filter((x) => pickKey(x.provider, x.model) !== k))
      else setPicked([...picked, { provider, model: m.id, name: m.name }])
    }

    // Why the list is empty matters. Surface the Host's diagnosis instead of a
    // generic message, so the next attempt is informed rather than guessed.
    const emptyReason = (() => {
      if (catalog == null) return '正在读取模型列表…'
      if (catalog.error) return '读取失败：' + catalog.error
      if (allProviders.length > 0) {
        const detail = allProviders
          .map((p) => '  · ' + (p.providerName ?? p.provider)
            + (p.error ? '（' + p.error + '）' : '（0 个模型）'))
          .join('\n')
        return [
          '这些线路都没有报告可用的模型：',
          detail,
          '',
          '去 DSH 的「模型」页面检查线路是否已登录、额度是否还在，或者加一条新线路。',
          '插件不持有任何 key，只显示 DSH 已经配好的东西。',
        ].join('\n')
      }
      return 'DSH 没有报告任何模型线路。\n去 DSH 的「模型」页面添加一条线路，然后回来点「重新读取」。'
    })()

    // Select every model currently visible under a provider heading.
    const pickAllIn = (p) => {
      const addable = p.models.filter((m) => !isTaken(p.provider, m.id) && !pickedSet.has(pickKey(p.provider, m.id)))
      if (addable.length === 0) return
      setPicked([...picked, ...addable.map((m) => ({ provider: p.provider, model: m.id, name: m.name }))])
    }

    return h(Modal, {
      title: '添加模型' + (picked.length ? '（已选 ' + picked.length + '）' : ''),
      onClose,
      footer: [
        // 关于 has nothing to discard, so there is one button, not two.
        section === 'about' ? null : h('button', { key: 'c', className: 'rt-btn', onClick: onClose }, '取消'),
        h('button', {
          key: 'ok',
          className: 'rt-btn primary',
          disabled: picked.length === 0,
          onClick: () => onAdd(picked),
        }, picked.length > 1 ? '添加这 ' + picked.length + ' 个' : '添加'),
      ],
    },
      h('div', { className: 'rt-field' },
        h('input', {
          type: 'text',
          placeholder: '搜索模型 — 名字、ID、供应商都行，空格分隔多个词',
          value: query,
          autoFocus: true,
          onChange: (e) => setQuery(e.target.value),
        }),
        h('div', {
          className: 'rt-hint2',
          style: { display: 'flex', alignItems: 'center', gap: 8 },
        },
          h('span', { style: { flex: '1 1 auto' } },
            terms.length === 0
              ? (totalModels ? '共 ' + totalModels + ' 个模型' : '')
              : (totalModels ? '匹配 ' + totalModels + ' 个' : '没有匹配的模型')),
          query !== '' ? h('button', {
            className: 'rt-btn', style: { padding: '1px 8px', fontSize: 10 },
            onClick: () => setQuery(''),
          }, '清空') : null,
        ),
      ),
      providers.length === 0
        ? h('div', null,
            h('div', { className: 'rt-hint2', style: { whiteSpace: 'pre-wrap' } }, emptyReason),
            catalog?.diag && !providers.length
              ? h('div', {
                  className: 'rt-hint2',
                  style: {
                    marginTop: 10, padding: '9px 11px', borderRadius: 10,
                    background: 'rgba(0,0,0,.28)',
                    fontFamily: 'ui-monospace, monospace', fontSize: 10.5,
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    maxHeight: 190, overflowY: 'auto',
                  },
                }, JSON.stringify(catalog.diag, null, 1))
              : null,
            onReload ? h('button', {
              className: 'rt-btn', style: { marginTop: 10 },
              onClick: onReload,
            }, '重新读取') : null,
          )
        : h('div', { className: 'rt-models', style: { maxHeight: 340, marginTop: 0 } },
            providers.map((p) => {
              const allTaken = p.models.every((m) => isTaken(p.provider, m.id))
              const label = p.providerName ?? p.provider
              const showId = label !== p.provider
              return h(React.Fragment, { key: p.provider },
                h('div', { className: 'rt-prov', style: { display: 'flex', alignItems: 'center', gap: 8 } },
                  h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                    // The adapter's display name — `WorkBuddy 国内版`, `Our Free
                    // Model` — is what the user recognises. The raw route id is
                    // kept underneath so two similarly-named routes stay
                    // distinguishable.
                    h('span', { className: 'rt-prov-name' }, label),
                    h('span', { className: 'rt-prov-n' }, p.models.length + ' 个'),
                    showId ? h('span', { className: 'rt-prov-id' }, p.provider) : null,
                  ),
                  allTaken ? null : h('button', {
                    className: 'rt-btn',
                    style: { padding: '1px 7px', fontSize: 10 },
                    onClick: () => pickAllIn(p),
                    title: '选中这条线路下所有还没加进来的模型',
                  }, '全选'),
                ),
                p.models.map((m) => {
                  const wasTaken = isTaken(p.provider, m.id)
                  const on = pickedSet.has(pickKey(p.provider, m.id))
                  return h('div', {
                    key: pickKey(p.provider, m.id),
                    className: 'rt-mp' + (on ? ' on' : ''),
                    style: wasTaken ? { opacity: .32, pointerEvents: 'none' } : undefined,
                    onClick: () => toggle(m, p.provider),
                    title: m.id,
                  },
                    h('span', { className: 'rt-check' + (on ? ' on' : '') }, on ? h(Icon, { name: 'check', size: 12 }) : null),
                    h(Avatar, { member: { model: m.id, displayName: m.name, provider: p.provider }, size: 22 }),
                    h('div', { className: 'rt-mp-body' },
                      h('div', { className: 'rt-mp-name' }, highlight(m.name, terms)),
                      // The raw id is the thing you can actually search for and
                      // recognise; hiding it was why models were hard to find.
                      h('div', { className: 'rt-mp-id' }, highlight(m.id, terms)),
                    ),
                    wasTaken ? h('span', { className: 'rt-mp-badge' }, '已在群内') : null,
                  )
                }),
              )
            }),
          ),
    )
  }

  // ── emoji ────────────────────────────────────────────────────────────────

  /**
   * A small, hand-picked set rather than the whole Unicode table.
   *
   * A full picker is a separate product; what a group chat actually needs is
   * the expressions people reach for while talking to a model — reactions,
   * approval, doubt, amusement.
   */
  const EMOJI_GROUPS = [
    {
      name: '反应',
      items: ['😀', '😄', '😁', '😊', '🙂', '😉', '😍', '🤩', '😎', '🤔',
              '😅', '😂', '🤣', '😭', '😱', '😴', '🙃', '😐', '😑', '🤯'],
    },
    {
      name: '态度',
      items: ['👍', '👎', '👏', '🙌', '🤝', '🙏', '💪', '✌️', '👌', '🤞',
              '👀', '🫡', '🤷', '🤦', '🙋', '💁', '🧐', '🤨', '😤', '🫠'],
    },
    {
      name: '物件',
      items: ['❤️', '🔥', '✨', '⭐', '🎉', '🎊', '💡', '📌', '✅', '❌',
              '⚠️', '💯', '🚀', '🐛', '🍵', '☕', '🌙', '☀️', '🌈', '🎯'],
    },
    {
      name: '对话',
      items: ['💬', '🗯️', '💭', '❓', '❔', '‼️', '❕', '🔍', '📝', '📖',
              '🧠', '💡', '🎈', '🪄', '⚡', '🌊', '🍀', '🎵', '🎶', '🕹️'],
    },
  ]

  /**
   * Sidebar collapse icon — a panel with a chevron pointing the way it will go.
   *
   * Drawn rather than imported: the two states differ only in which half is
   * filled and which way the chevron points, so one component with a direction
   * covers both without shipping two assets.
   */
  function SidebarToggleIcon({ direction, size }) {
    const s = size ?? 16
    const left = direction === 'left'
    return h('svg', {
      width: s, height: s, viewBox: '0 0 24 24',
      fill: 'none', stroke: 'currentColor', strokeWidth: 2,
      strokeLinecap: 'round', strokeLinejoin: 'round',
      style: { display: 'block' },
    },
      // Outer panel with rounded corners.
      h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }),
      // The divider that separates the rail half from the content half.
      h('line', { x1: left ? 9.5 : 14.5, y1: 4, x2: left ? 9.5 : 14.5, y2: 20 }),
      // Chevron, pointing at the edge the panel will collapse toward.
      //
      // Written with explicit L commands rather than relying on the implicit
      // lineto that follows an M: `M16.2 9.6 13.2 12` is valid SVG but reads like
      // two separate points, and any renderer that treats the second pair as a
      // new subpath draws a broken icon.
      h('path', {
        d: left
          ? 'M16.6 9.2 L13 12 L16.6 14.8'
          : 'M7.4 9.2 L11 12 L7.4 14.8',
      }),
    )
  }

  /**
   * Settings icon: a hexagon with a dot at its centre.
   *
   * A hexagon rather than a gear: at 12px a gear's teeth turn into visual noise,
   * while six straight edges stay legible. The centre dot is what makes it read
   * as a control rather than a shape.
   */
  function SettingsIcon({ size }) {
    const s = size ?? 13
    // A regular hexagon with a flat top, centred in a 24-unit box.
    // Computed at radius 9.4 from centre (12,12) so all six corners are
    // equidistant — hand-picked coordinates were off by a few hundredths.
    const pts = [
      [12, 2.6], [20.14, 7.3], [20.14, 16.7],
      [12, 21.4], [3.86, 16.7], [3.86, 7.3],
    ].map((p) => p.join(',')).join(' ')
    return h('svg', {
      width: s, height: s, viewBox: '0 0 24 24',
      fill: 'none', stroke: 'currentColor', strokeWidth: 2,
      strokeLinejoin: 'round', strokeLinecap: 'round',
      style: { display: 'block' },
    },
      h('polygon', { points: pts }),
      h('circle', { cx: 12, cy: 12, r: 2.4, fill: 'currentColor', stroke: 'none' }),
    )
  }

  /** The user's own avatar: a generated disc with their initials. */
  function UserAvatar({ profile, size }) {
    const s = size ?? 28
    const name = profile?.name ?? '我'
    const seed = profile?.color ?? name
    return h('div', {
      className: 'rt-av',
      style: avatarStyle(seed, s),
      title: name,
    }, avatarGlyph({ displayName: name, model: seed }))
  }

  function EmojiPanel({ onPick, onClose, cat, setCat }) {
    const group = EMOJI_GROUPS[cat] ?? EMOJI_GROUPS[0]
    return h('div', {
      className: 'rt-emoji-panel',
      onMouseDown: (e) => e.stopPropagation(),
    },
      h('div', { className: 'rt-emoji-tabs' },
        EMOJI_GROUPS.map((g, i) => h('button', {
          key: g.name,
          className: 'rt-emoji-tab' + (i === cat ? ' on' : ''),
          onClick: () => setCat(i),
        }, g.name)),
        h('button', {
          className: 'rt-emoji-close',
          onClick: onClose,
          title: '关闭',
        }, h(Icon, { name: 'close', size: 13 })),
      ),
      h('div', { className: 'rt-emoji-grid' },
        group.items.map((e) => h('button', {
          key: e,
          className: 'rt-emoji-cell',
          onClick: () => onPick(e),
          title: e,
        }, e)),
      ),
    )
  }

  /**
   * Decide how much of each member chip fits.
   *
   * Measured, not guessed: the strip's real width is compared against what the
   * full layout would need. Guessing from `window.innerWidth` gets it wrong as
   * soon as a right panel or the sidebar opens.
   *
   *   full  — avatar + name; points ride along
   *   short — avatar + name, points drop to the tooltip
   *   mini  — avatar only
   */
  /**
   * Decide how much of each member chip fits.
   *
   * Measured, not guessed: the strip's real width is compared against what the
   * layout needs. Guessing from `window.innerWidth` gets it wrong as soon as a
   * side or right panel opens.
   *
   *   full  — avatar + name, comfortably inside the strip
   *   short — avatar + name, tightened spacing (names may ellipsize)
   *   mini  — avatar only, name and score in the tooltip
   *
   * There is no separate "show the score" level: a number wedged between a
   * model's name and the next chip is what made the header feel crowded. The
   * score belongs to the leaderboard and the packet rows.
   */
  function chipDensity(available, members) {
    const sum = (fn) => members.reduce((n, m) => n + fn(m), 0)
    // ~6px per character at 11px type; 16px avatar plus padding and gap ≈ 27px.
    const nameW = (m) => Math.min(150, Math.max(24, String(m.displayName ?? '').length * 6))

    const needFull = sum((m) => 32 + nameW(m))
    const needShort = sum((m) => 22 + nameW(m))

    if (available <= 0) return 'mini'
    if (available >= needFull) return 'full'
    if (available >= needShort) return 'short'
    return 'mini'
  }

  // ── message row ──────────────────────────────────────────────────────────

  /**
   * The live-turn controls: an elapsed clock and, once the turn has run long
   * enough to be worth interrupting, a stop button.
   *
   * Lives in the message header rather than inside the bubble, because they
   * belong to the *turn* — they stay available whether the model is still
   * thinking or already writing.
   *
   * The clock ticks once a second in this component's own state, so a long
   * think updates one number instead of re-rendering the whole transcript.
   */
  /**
   * The live clock on a streaming row, plus a 暂停 escape hatch.
   *
   * The label changes tone as the wait grows, because "still waiting" and
   * "probably stuck" are different situations and only the clock can tell them
   * apart. Waiting a minute for a reasoning model is normal; waiting three is
   * not, and the user should be able to tell without counting.
   */
  /**
   * The live clock on a streaming row, plus a 暂停 escape hatch.
   *
   * Three states, and the ordering matters:
   *
   *   normal  — waiting is fine, say nothing beyond the counter
   *   slow    — past SLOW_AFTER_SECS, the counter turns amber
   *   stuck   — past STUCK_AFTER_SECS *and* nothing has been emitted
   *
   * The "stuck" note must never appear before its time threshold. An earlier
   * version treated "no text yet" as sufficient, so a model that had merely not
   * started was labelled 没有响应 within a second or two — alarming, and wrong,
   * because thinking without output is the normal state for the first seconds.
   */
  function ThinkingControls({ startedAt, onStop, hasOutput }) {
    const start = startedAt ?? Date.now()
    const [now, setNow] = React.useState(Date.now())

    React.useEffect(() => {
      const t = setInterval(() => setNow(Date.now()), 1000)
      return () => clearInterval(t)
    }, [])

    const secs = Math.max(0, Math.round((now - start) / 1000))
    const label = secs < 60 ? secs + ' 秒' : Math.floor(secs / 60) + ' 分 ' + (secs % 60) + ' 秒'

    // Silence only becomes a problem after it has lasted long enough to mean
    // something. Until then a quiet row is simply a row that is thinking.
    const silent = !hasOutput && secs >= STUCK_AFTER_SECS
    const tone = silent ? ' stuck' : secs >= SLOW_AFTER_SECS ? ' slow' : ''

    return h('span', { className: 'rt-live' + tone },
      h('span', { className: 'rt-think-label' }, label),
      silent
        ? h('span', { className: 'rt-think-note' }, '一直没有输出，可能卡住了')
        : null,
      onStop
        ? h('button', {
            className: 'rt-think-stop',
            onClick: (e) => { e.stopPropagation(); onStop() },
            title: '停止这个模型的输出',
          }, '暂停')
        : null,
    )
  }

  /**
   * One attached image, as a thumbnail.
   *
   * The bytes live in the Host's attachment store, so the picture is fetched on
   * mount and cached in component state. A reference the store cannot resolve
   * degrades to a labelled chip — never a broken image icon, which reads as a bug
   * in the chat rather than as a missing file.
   */
  function ImageThumb({ ref }) {
    const [src, setSrc] = React.useState(null)
    const [failed, setFailed] = React.useState(false)

    React.useEffect(() => {
      let alive = true
      fetch('/api/roundtable/image-read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref }),
      })
        .then((r) => r.json())
        .then((j) => {
          if (!alive) return
          if (j && j.ok === true && j.dataUrl) setSrc(j.dataUrl)
          else setFailed(true)
        })
        .catch(() => { if (alive) setFailed(true) })
      return () => { alive = false }
    }, [ref?.attachmentId])

    if (failed) {
      return h('span', { className: 'rt-bubble-img-missing', title: ref?.name ?? '图片' },
        h(Icon, { name: 'image', size: 13 }), '图片无法显示')
    }
    if (!src) {
      return h('span', { className: 'rt-bubble-img-missing' },
        h(Icon, { name: 'image', size: 13 }), '加载中…')
    }
    return h('img', {
      className: 'rt-bubble-img',
      src,
      alt: ref?.name ?? '图片',
      loading: 'lazy',
    })
  }

  /**
   * A quoted message, shown above the reply that answers it.
   *
   * Deliberately one line: a quote is a pointer, not a copy. The full text is in
   * the transcript already; what matters is knowing *which* message is being
   * answered.
   */
  function QuoteBlock({ quote, members }) {
    const who = quote.memberId
      ? (members.find((m) => m.id === quote.memberId)?.displayName ?? '某位')
      : (quote.who ?? '你')
    return h('div', { className: 'rt-quote' },
      h('span', { className: 'rt-quote-who' }, who),
      h('span', { className: 'rt-quote-text' }, quote.text || '(空)'),
    )
  }

  /**
   * A memoised message row.
   *
   * Without this, every streaming chunk re-rendered *every* message in the room,
   * because the parent re-renders on each token and nothing was memoised. A room
   * with a few hundred messages therefore got slower as the conversation grew —
   * the exact symptom of "it gets laggy after using it for a while".
   *
   * The comparison is shallow on the fields that actually affect output. `msg` is
   * compared by identity, which is correct here: an update always replaces the
   * message object rather than mutating it.
   */
  function sameRow(a, b) {
    return a.msg === b.msg
      && a.members === b.members
      && a.profile === b.profile
      && a.roomId === b.roomId
      && a.onStop === b.onStop
      && a.onGrab === b.onGrab
      && a.onQuote === b.onQuote
      && a.onEdit === b.onEdit
      && a.onRecall === b.onRecall
      && a.onVote === b.onVote
      && a.onCloseVote === b.onCloseVote
      && a.onJoinChain === b.onJoinChain
      && a.onPin === b.onPin
      && a.isPinned === b.isPinned
  }

  /**
   * Memoise a rendered subtree, when the runtime supports it.
   *
   * The rail and the header do not depend on the composer, so caching them is
   * what keeps a keystroke from rebuilding the whole panel. The guard matters:
   * a React without `useMemo` must degrade to recomputing, not throw.
   */
  const useMemoSafe = (fn, deps) => (typeof React.useMemo === 'function'
    ? React.useMemo(fn, deps)
    : fn())

  const MemoMessageRow = React.memo
    ? React.memo(function MemoMessageRowInner(props) {
        const {
          msg, members, roomId, onStop, onGrab, onQuote, onEdit, onRecall,
          onVote, onCloseVote, onJoinChain, profile, onPin, isPinned,
        } = props
        return h(MessageRow, {
          msg,
          members,
          profile,
          onStop: onStop ? () => onStop(msg.id, roomId) : undefined,
          onGrab: onGrab ? (packetMsgId) => onGrab(packetMsgId, roomId) : undefined,
          onQuote,
          onEdit,
          onRecall,
          onVote: onVote ? (msgId, opt) => onVote(msgId, opt, roomId) : undefined,
          onCloseVote: onCloseVote ? (msgId) => onCloseVote(msgId, roomId) : undefined,
          onJoinChain: onJoinChain ? (msgId, text) => onJoinChain(msgId, text, roomId) : undefined,
          onPin,
          isPinned,
        })
      }, sameRow)
    // A React without `memo` still works; it just re-renders as before.
    : function MemoMessageRowFallback(props) {
        const {
          msg, members, roomId, onStop, onGrab, onQuote, onEdit, onRecall,
          onVote, onCloseVote, onJoinChain, profile, onPin, isPinned,
        } = props
        return h(MessageRow, {
          msg,
          members,
          profile,
          onStop: onStop ? () => onStop(msg.id, roomId) : undefined,
          onGrab: onGrab ? (packetMsgId) => onGrab(packetMsgId, roomId) : undefined,
          onQuote,
          onEdit,
          onRecall,
          onVote: onVote ? (msgId, opt) => onVote(msgId, opt, roomId) : undefined,
          onCloseVote: onCloseVote ? (msgId) => onCloseVote(msgId, roomId) : undefined,
          onJoinChain: onJoinChain ? (msgId, text) => onJoinChain(msgId, text, roomId) : undefined,
          onPin,
          isPinned,
        })
      }

  /**
   * One 接龙, with an inline field to join it.
   *
   * Extracted from MessageRow on purpose: MessageRow returns early for several
   * roles, and calling a hook after a conditional return breaks the rules of
   * hooks — React would throw once the list reordered. Keeping the state in its
   * own component means the hook is only ever mounted for a chain message.
   */
  function ChainCard({ msg, profile, onJoinChain }) {
    const entries = Array.isArray(msg.entries) ? msg.entries : []
    const joined = entries.some((e) => e.memberId === '__me')
    const [draft, setDraft] = React.useState('')

    const submit = () => {
      const text = draft.trim()
      // An entry with no text is just a name; the button needs something to add.
      if (!text || !onJoinChain) return
      onJoinChain(msg.id, text)
      setDraft('')
    }

    return h('div', { 'data-msg-id': msg.id, className: 'rt-msg chain' },
      h('div', { className: 'rt-packet-av' }, h(Icon, { name: 'chain', size: 17 })),
      h('div', { className: 'rt-body' },
        h('div', { className: 'rt-mhead' },
          h('span', { className: 'rt-who', style: { color: '#a9d8b4' } }, msg.senderName ?? '你'),
          h('span', { className: 'rt-tag' }, '接龙'),
          h('span', { className: 'rt-time' }, fmtTime(msg.ts)),
          h('span', { className: 'rt-vote-n' }, entries.length + ' 人已接'),
        ),
        h('div', { className: 'rt-chain' },
          h('div', { className: 'rt-vote-q' }, msg.text),
          entries.length === 0
            ? h('div', { className: 'rt-home-empty' }, '还没人接')
            : entries.map((e, i) => h('div', { key: e.id ?? i, className: 'rt-chain-row' },
                h('span', { className: 'rt-chain-no' }, String(i + 1)),
                h('span', { className: 'rt-chain-text' }, e.text),
                h('span', { className: 'rt-chain-who' }, e.who ?? ''),
              )),
          onJoinChain
            ? h('div', { className: 'rt-chain-add' },
                h('input', {
                  className: 'rt-set-input rt-chain-input',
                  type: 'text',
                  value: draft,
                  placeholder: joined ? '改一下你写的内容' : '写点什么，再点接龙',
                  onChange: (ev) => setDraft(ev.target.value),
                  onKeyDown: (ev) => { if (ev.key === 'Enter') submit() },
                }),
                h('button', {
                  className: 'rt-btn primary',
                  disabled: draft.trim() === '',
                  style: draft.trim() === '' ? { opacity: .45, cursor: 'not-allowed' } : undefined,
                  onClick: submit,
                }, joined ? '改一下' : '接龙'),
              )
            : null,
        ),
      ),
    )
  }

  function MessageRow({
    msg, members, onStop, onGrab, onQuote, onEdit, onRecall,
    onVote, onCloseVote, onJoinChain, profile, onPin, isPinned,
  }) {
    if (msg.role === 'sys') {
      return h('div', { 'data-msg-id': msg.id, style: { textAlign: 'center', fontSize: 11, color: 'rgba(255,255,255,.32)', padding: '10px 0' } }, msg.text)
    }

    // 群投票: a question with options, and who chose what.
    //
    // The result is derived, never stored: `msg.ballots` is the source of truth
    // (who voted for which option), so a recount can never disagree with itself.
    if (msg.role === 'vote') {
      const ballots = Array.isArray(msg.ballots) ? msg.ballots : []
      const tally = (msg.options ?? []).map((opt) => ({
        opt,
        voters: ballots.filter((b) => b.option === opt),
      }))
      const total = ballots.length
      return h('div', { 'data-msg-id': msg.id, className: 'rt-msg vote' },
        h('div', { className: 'rt-packet-av' }, h(Icon, { name: 'vote', size: 17 })),
        h('div', { className: 'rt-body' },
          h('div', { className: 'rt-mhead' },
            h('span', { className: 'rt-who', style: { color: '#9fb4ff' } }, msg.senderName ?? '你'),
            h('span', { className: 'rt-tag' }, '投票'),
            h('span', { className: 'rt-time' }, fmtTime(msg.ts)),
          ),
          h('div', { className: 'rt-vote' },
            h('div', { className: 'rt-vote-q' }, msg.text),
            tally.map(({ opt, voters }) => {
              const pct = total > 0 ? Math.round((voters.length / total) * 100) : 0
              const mine = voters.some((v) => v.memberId === '__me')
              // Name the voters. A count alone does not tell the user which
              // models agreed, which is the interesting part of a group vote.
              const names = voters.map((v) => {
                if (v.memberId === '__me') return profile?.name ?? '你'
                return members.find((m) => m.id === v.memberId)?.displayName ?? '已移除'
              })
              return h('button', {
                key: opt,
                className: 'rt-vote-opt' + (mine ? ' mine' : ''),
                disabled: !!msg.closed,
                onClick: () => onVote && onVote(msg.id, opt),
                title: names.length ? names.join('、') : '还没人投',
              },
                h('span', { className: 'rt-vote-bar', style: { width: pct + '%' } }),
                h('span', { className: 'rt-vote-label' }, opt),
                h('span', { className: 'rt-vote-n' }, voters.length + ' · ' + pct + '%'),
                names.length
                  ? h('span', { className: 'rt-vote-who' }, names.join('、'))
                  : null,
              )
            }),
            h('div', { className: 'rt-vote-foot' },
              total + ' 票' + (msg.closed ? ' · 已结束' : ''),
              onCloseVote && !msg.closed
                ? h('button', {
                    className: 'rt-quote-btn',
                    style: { opacity: 1, marginLeft: 8 },
                    onClick: () => onCloseVote(msg.id),
                  }, '结束投票')
                : null,
            ),
          ),
        ),
      )
    }

    // 群接龙: an ordered list anyone can append themselves to.
    if (msg.role === 'chain') {
      return h(ChainCard, { msg, profile, onJoinChain })
    }

    if (msg.role === 'packet') {
      return h('div', { 'data-msg-id': msg.id, className: 'rt-msg packet' },
        h('div', { className: 'rt-packet-av' }, h(Icon, { name: 'packet', size: 17 })),
        h('div', { className: 'rt-body' },
          h('div', { className: 'rt-mhead' },
            h('span', { className: 'rt-who', style: { color: '#ff9d94' } }, msg.senderName ?? '你'),
            h('span', { className: 'rt-tag' }, '红包'),
            h('span', { className: 'rt-time' }, fmtTime(msg.ts)),
          ),
          h('div', { className: 'rt-packet' },
            h('div', { className: 'rt-packet-left' },
              h('div', { className: 'rt-packet-amount' }, msg.points + ' 积分'),
              h('div', { className: 'rt-packet-note' },
                // Say which kind it was, so an uneven split reads as intended
                // rather than as a bug.
                (msg.kind === 'even' ? '平均分 · ' : msg.kind === 'single' ? '专属 · ' : '拼手气 · ') +
                (msg.note || '恭喜发财'),
              ),
            ),
            h('div', { className: 'rt-packet-right' },
              (msg.grabs ?? []).length === 0 && onGrab
                ? h('button', {
                    className: 'rt-packet-grab',
                    onClick: () => onGrab(msg.id),
                  }, '抢')
                : null,
              (msg.grabs ?? []).length > 0
                ? h('div', { className: 'rt-packet-results' },
                    (msg.grabs ?? []).map((g) => {
                      const who = members.find((m) => m.id === g.memberId)
                      return h('div', { key: g.memberId, className: 'rt-grab' },
                        h('span', { className: 'rt-grab-name' }, who?.displayName ?? '已移除'),
                        h('span', { className: 'rt-grab-pts' }, '+' + g.points),
                      )
                    }),
                  )
                : null,
            ),
          ),
        ),
      )
    }

    if (msg.role === 'user') {
      const me = profile ?? { name: '你', color: null }
      return h('div', { 'data-msg-id': msg.id, className: 'rt-msg user' },
        h(UserAvatar, { profile: me, size: 28 }),
        h('div', { className: 'rt-body' },
          h('div', { className: 'rt-mhead' },
            h('span', { className: 'rt-who', style: { color: 'rgba(255,255,255,.75)' } },
              me.name ?? '你'),
            h('span', { className: 'rt-time' }, fmtTime(msg.ts)),
            // 撤回 / 编辑: only on the user's own messages. A model's reply is a
            // record of what it said; editing it would falsify the transcript.
            onEdit ? h('button', {
              className: 'rt-quote-btn',
              title: '改一下重发',
              onClick: () => onEdit(msg),
            }, '编辑') : null,
            onRecall ? h('button', {
              className: 'rt-quote-btn',
              title: '撤回这条',
              onClick: () => onRecall(msg),
            }, '撤回') : null,
          ),
          // 引用回复: show what is being answered, so the thread is readable
          // without scrolling back.
          msg.quote ? h(QuoteBlock, { quote: msg.quote, members }) : null,
          // Attached images, rendered as a thumbnail. A ref the Host could not
          // store falls back to a labelled chip rather than a broken <img>.
          msg.images && msg.images.length > 0
            ? h('div', { className: 'rt-bubble-imgs' },
                msg.images.map((ref) => h(ImageThumb, { key: ref.attachmentId, ref: ref })),
              )
            : null,
          h('div', { className: 'rt-bubble' }, renderText(msg.text, members)),
        ),
      )
    }

    const mem = members.find((m) => m.id === msg.memberId)
    const hue = hueOf(mem?.model ?? 'unknown')

    // A live turn always exposes its controls, whatever the bubble currently
    // shows. Binding the stop button to the "no text yet" state meant it
    // vanished the moment the model emitted its first token — so a long turn
    // that had started writing was impossible to interrupt, which read as
    // "暂停没用".
    const live = !!msg.streaming && !msg.aborted && !msg.error

    let bubble
    if (msg.error) {
      bubble = h('div', { className: 'rt-bubble rt-err' },
        h(Icon, { name: 'warn', size: 13, style: { display: 'inline-block', verticalAlign: '-2px', marginRight: 5 } }),
        msg.error)
    } else if (msg.aborted) {
      // Three endings read differently: the user paused this row, the user
      // stopped the whole turn, or a newer message replaced the turn.
      const tail = msg.interrupted ? '  · 被下一条消息打断'
        : msg.paused ? '  · 已暂停'
        : '  · 已停止'
      bubble = h('div', { className: 'rt-bubble rt-muted' },
        renderText(msg.text || '（已中断）', members), tail)
    } else if (live && !msg.text) {
      // Reasoning models can stay here for a while; the elapsed clock lives in
      // the bubble so a long think reads as progress instead of a hang.
      bubble = h('div', { className: 'rt-bubble rt-thinking' },
        h('span', { className: 'rt-typing' }, h('i'), h('i'), h('i')),
        h('span', { className: 'rt-think-label' }, '思考中…'),
      )
    } else {
      bubble = h('div', { className: 'rt-bubble' },
        renderText(msg.text, members),
        live ? h('span', { className: 'rt-caret' }) : null,
      )
    }

    return h('div', { 'data-msg-id': msg.id, className: 'rt-msg' + (Date.now() - (msg.ts ?? 0) < 1200 ? ' rt-msg-fresh' : '') },
      mem ? h(Avatar, { member: mem, size: 28 })
          : h('div', { className: 'rt-av', style: avatarStyle('gone', 28) }, '?'),
      h('div', { className: 'rt-body' },
        h('div', { className: 'rt-mhead' },
          h('span', { className: 'rt-who', style: { color: `hsl(${hue} 70% 74%)` } },
            mem?.displayName ?? '已移除的模型'),
          h('span', { className: 'rt-time' }, fmtTime(msg.ts)),
          msg.relayFrom ? h('span', { className: 'rt-tag' }, '由 ' + msg.relayFrom + ' 递来') : null,
          live && onStop
            ? h(ThinkingControls, {
                startedAt: msg.startedAt ?? msg.ts,
                onStop,
                // Only "has the model said anything yet". Whether silence means
                // "stuck" is decided by the clock inside the component — passing
                // the age threshold from here would duplicate that rule.
                hasOutput: !!(msg.text && msg.text.length),
              })
            : null,
          onQuote && !live
            ? h('button', {
                className: 'rt-quote-btn',
                title: '引用这条回复它',
                onClick: () => onQuote(msg),
              }, '引用')
            : null,
            // 置顶 reads from the room, so a recalled message simply stops matching.
            onPin
              ? h('button', {
                  className: 'rt-quote-btn' + (isPinned ? ' on' : ''),
                  title: isPinned ? '取消置顶' : '置顶这条',
                  onClick: () => onPin(msg.id),
                }, isPinned ? '已置顶' : '置顶')
              : null,
        ),
        bubble,
      ),
    )
  }

  // ── the panel ────────────────────────────────────────────────────────────

  function RoundtablePanel() {
    const [state, setState] = React.useState(loadState)
    const [catalog, setCatalog] = React.useState(null)
    const [catalogError, setCatalogError] = React.useState('')
    const [input, setInput] = React.useState('')
    const [running, setRunning] = React.useState(false)
    const [modal, setModal] = React.useState(null)
    const [pop, setPop] = React.useState(null)
    const [hint, setHint] = React.useState('')
    const [emojiOpen, setEmojiOpen] = React.useState(false)
    /** Uploaded images waiting to be sent with the next message. */
    const [pendingImages, setPendingImages] = React.useState([])
    /**
     * How many messages of the active room are rendered.
     *
     * A room grows without bound, and every message costs DOM nodes: measured
     * at ~7 nodes each, 2000 messages mount in ~200ms and streaming then runs at
     * ~1.6ms per frame — enough to drop below 60fps on its own. Rendering only
     * the tail keeps that flat, and "load more" reveals the rest on demand.
     */
    const [visibleCount, setVisibleCount] = React.useState(MESSAGE_PAGE)
    /** True while an upload is in flight. */
    const [uploading, setUploading] = React.useState(false)
    const fileRef = React.useRef(null)
    // Rail collapse. Persisted separately from room data so it survives a reload
    // without being part of any room's state.
    const [railOpen, setRailOpen] = React.useState(() => {
      try { return localStorage.getItem('dsh.roundtable.rail') !== '0' } catch { return true }
    })
    React.useEffect(() => {
      try { localStorage.setItem('dsh.roundtable.rail', railOpen ? '1' : '0') } catch { /* private mode */ }
    }, [railOpen])

    // User profile: name and avatar are the two things the user sees everywhere,
    // so they live in the same store as rooms.
    const [profile, setProfile] = React.useState(() => {
      try {
        const raw = localStorage.getItem('dsh.roundtable.profile')
        return raw ? JSON.parse(raw) : { name: '我', color: null }
      } catch { return { name: '我', color: null } }
    })
    const saveProfile = (next) => {
      setProfile(next)
      try { localStorage.setItem('dsh.roundtable.profile', JSON.stringify(next)) } catch { /* private mode */ }
    }

    /**
     * Appearance: one skin and one brightness, stored with the profile.
     *
     * Kept as two independent choices rather than four presets, because the
     * combinations are all legitimate — a flat dark UI and a flat light UI are
     * different products, and locking them together would force a choice nobody
     * asked to make.
     */
    const [theme, setTheme] = React.useState(() => {
      try {
        const raw = localStorage.getItem('dsh.roundtable.theme')
        const t = raw ? JSON.parse(raw) : null
        return {
          skin: t?.skin === 'flat' ? 'flat' : 'glass',
          mode: t?.mode === 'light' ? 'light' : 'dark',
        }
      } catch { return { skin: 'glass', mode: 'dark' } }
    })
    const saveTheme = (next) => {
      setTheme(next)
      // Mirror into the shared store so the dialogs — which render outside
      // `.rt-root` — pick up the same theme without a prop on every call site.
      setThemeState(next)
      try { localStorage.setItem('dsh.roundtable.theme', JSON.stringify(next)) } catch { /* private mode */ }
    }
    // Seed the shared store on mount: a dialog opened before anything else would
    // otherwise render with the default theme.
    React.useEffect(() => {
      setThemeState(theme)
    }, [])
    const [emojiCat, setEmojiCat] = React.useState(0)
    // -1 means "not measured yet". Using 0 would be read as "plenty of room" by
    // chipDensity and paint the widest layout on the first frame — exactly the
    // overflow this is meant to avoid. An unmeasured strip starts at `mini`,
    // the narrowest level, and widens one frame later.
    const [chipSpace, setChipSpace] = React.useState(-1)
    const chipsRef = React.useRef(null)

    // Watch the strip's actual width. A ResizeObserver is what makes this adapt
    // to a sidebar opening, a right panel appearing, or the window resizing —
    // none of which a one-time measurement would catch.
    //
    // The dependency list is empty on purpose. `room` is declared further down,
    // and referencing it here threw "Cannot access 'room' before initialization"
    // on every render. Observing the ref that `chipsRef` points at is enough:
    // the element is replaced when the room changes, and the observer is re-
    // attached by the effect below.
    React.useEffect(() => {
      const el = chipsRef.current
      if (!el || typeof ResizeObserver === 'undefined') return
      const ro = new ResizeObserver((entries) => {
        for (const e of entries) {
          const w = e.contentRect.width
          setChipSpace((prev) => (Math.abs(prev - w) > 1 ? w : prev))
        }
      })
      ro.observe(el)
      return () => ro.disconnect()
    }, [])

    const abortRef = React.useRef(null)
    const streamRef = React.useRef(null)
    const inputRef = React.useRef(null)
    const stickRef = React.useRef(true)
    const relayFromRef = React.useRef(null)
    /** Id of the turn that owns the stream right now; replaced to supersede it. */
    const turnRef = React.useRef(null)
    /** The message id whose turn is streaming right now, for per-row stop. */
    const activeMsgRef = React.useRef(null)

    const rooms = state.rooms
    const room = rooms.find((r) => r.id === state.activeId) ?? rooms[0] ?? null

    const stateRef = React.useRef(state)
    stateRef.current = state

    const commit = React.useCallback((next) => {
      setState(next)
      saveState(next)
    }, [])

    // ── catalog ──
    const loadCatalog = React.useCallback(() => {
      setCatalogError('')
      fetch('/api/roundtable/models', { headers: { accept: 'application/json' } })
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
        .then((j) => {
          if (j && j.ok === false) setCatalogError(j.error ?? '读取失败')
          setCatalog(j)
        })
        .catch((e) => setCatalogError(String(e && e.message ? e.message : e)))
    }, [])

    React.useEffect(() => { ensureCss(); loadCatalog() }, [loadCatalog])

    /**
     * Panel-wide shortcuts.
     *
     * Bound to the document so they work while the composer has focus, and bound
     * once — a listener per render would stack up and fire the handler N times.
     */
    React.useEffect(() => {
      const onKey = (e) => {
        const mod = e.metaKey || e.ctrlKey
        if (!mod) return
        if (e.key === 'k' || e.key === 'K') {
          e.preventDefault()
          const el = inputRef.current
          if (el) el.focus()
          return
        }
        if (e.key === 'f' || e.key === 'F') {
          // The browser find bar cannot see inside the transcript.
          e.preventDefault()
          setModal({ kind: 'search' })
        }
      }
      document.addEventListener('keydown', onKey)
      return () => document.removeEventListener('keydown', onKey)
    }, [])

    // ── scrolling ──
    /**
     * Scroll to the bottom of the transcript.
     *
     * `instant` exists because the container has `scroll-behavior: smooth`,
     * which is right while a reply streams in but wrong when the room opens:
     * the panel would render at the top and then animate its way down, so every
     * entry into a room began with a visible slide. Jumping without animation is
     * what makes opening a room feel like arriving rather than travelling.
     */
    /**
     * Scroll one message into view and flash it.
     *
     * Search results are useless if jumping to one just puts the user somewhere
     * near it. The flash is what answers "which line did it take me to" after a
     * jump across a long transcript.
     */
    const jumpToMessage = React.useCallback((msgId) => {
      const s = streamRef.current
      if (!s) return
      const el = s.querySelector('[data-msg-id="' + String(msgId).replace(/"/g, '\\"') + '"]')
      if (!el) {
        setHint('这条消息不在当前记录里')
        return
      }
      // `scrollIntoView` would also scroll the page around the panel; setting
      // scrollTop keeps the movement inside the transcript.
      const top = el.offsetTop - s.clientHeight / 2 + el.offsetHeight / 2
      s.scrollTo({ top: Math.max(0, top), behavior: 'auto' })
      // Suspend stick-to-bottom: the user asked to look at an old message, and
      // the next streamed chunk must not drag the view back down.
      stickRef.current = false

      el.classList.add('rt-flash')
      setTimeout(() => el.classList.remove('rt-flash'), 1200)
    }, [])

    /**
     * Scroll to the bottom of the transcript.
     *
     * `instant` exists because the container has `scroll-behavior: smooth`, which
     * is right while a reply streams in but wrong when a room opens: the panel
     * would render at the top and animate its way down, so every entry began
     * with a visible slide.
     *
     * The first attempt set `style.scrollBehavior = 'auto'` around the
     * assignment. That does not work reliably: style changes are applied at the
     * next style recalculation, so the temporary value can be undone before the
     * scroll is performed and the container animates anyway. `scrollTo` takes
     * the behaviour as an argument, which the browser honours for that one call
     * regardless of the CSS.
     */
    const scrollDown = React.useCallback((force, instant) => {
      const s = streamRef.current
      if (!s) return
      if (!force && !stickRef.current) return
      if (instant && typeof s.scrollTo === 'function') {
        s.scrollTo({ top: s.scrollHeight, behavior: 'instant' })
      } else {
        s.scrollTop = s.scrollHeight
      }
    }, [])

    // Opening a room arrives at the newest message; it does not travel there.
    //
    // `useLayoutEffect` runs before paint, so the first frame the user sees is
    // already at the bottom. The ref may still be null on the very first mount
    // (the empty state has no transcript), so the effect is also keyed on the
    // message count — that covers the moment the container appears, and the
    // moment a switch back to a populated room happens.
    const useIsoLayoutEffect = typeof window !== 'undefined' && window.document?.createElement
      ? React.useLayoutEffect
      : React.useEffect
    const msgCount = room?.messages?.length ?? 0
    useIsoLayoutEffect(() => {
      // Entering a room always lands at the newest message, whatever the scroll
      // position was in the room we just left. Without this reset, a room the
      // user had scrolled up in would keep `stickRef` false and open part-way.
      stickRef.current = true
      scrollDown(true, true)
      // A second pass after paint: fonts and images can change the height, and a
      // stale `scrollHeight` would leave the view a few lines short of the end.
      const raf = requestAnimationFrame(() => scrollDown(true, true))
      return () => cancelAnimationFrame(raf)
    }, [room?.id, msgCount > 0, scrollDown])

    const onScroll = () => {
      const s = streamRef.current
      if (!s) return
      stickRef.current = s.scrollHeight - s.scrollTop - s.clientHeight < 48
    }

    // ── mutations (functional so the send loop never reads stale state) ──
    const updateRoom = (id, fn) => {
      setState((prev) => {
        const next = { ...prev, rooms: prev.rooms.map((r) => (r.id === id ? fn(r) : r)) }
        saveState(next)
        return next
      })
    }

    const updateMsg = (roomId, msgId, patch) => {
      setState((prev) => {
        const next = {
          ...prev,
          rooms: prev.rooms.map((r) => r.id !== roomId ? r : {
            ...r,
            messages: r.messages.map((m) => (m.id === msgId ? { ...m, ...patch } : m)),
          }),
        }
        saveState(next)
        return next
      })
    }


    /**
     * Apply `@投票` and `@接龙` from one model's reply.
     *
     * Both act on the *most recent open* item of that kind, because the reply
     * refers to whatever is currently on the table — asking the model to quote an
     * id would almost never work.
     *
     * A model votes once: voting again replaces its ballot rather than stacking,
     * so the tally stays a count of members rather than of attempts.
     */
    const applyRoomCommands = (roomId, member, text) => {
      if (!text) return
      const room = stateRef.current.rooms.find((r) => r.id === roomId)
      if (!room) return

      const lastVote = [...room.messages].reverse().find((m) => m.role === 'vote' && !m.closed)
      const lastChain = [...room.messages].reverse().find((m) => m.role === 'chain')

      const vote = parseVoteCommand(text, lastVote)
      if (vote) {
        if (!vote.ok) {
          updateRoom(roomId, (r) => ({
            ...r,
            messages: [...r.messages, {
              id: uid('msg'), role: 'sys',
              text: member.displayName + ' 投票没成：' + vote.reason,
              ts: Date.now(),
            }],
          }))
        } else {
          updateRoom(roomId, (r) => ({
            ...r,
            messages: r.messages.map((m) => {
              if (m.id !== lastVote.id) return m
              const rest = (m.ballots ?? []).filter((b) => b.memberId !== member.id)
              return { ...m, ballots: [...rest, { memberId: member.id, option: vote.option, ts: Date.now() }] }
            }),
          }))
        }
      }

      const chain = parseChainCommand(text)
      if (chain && lastChain) {
        updateRoom(roomId, (r) => ({
          ...r,
          messages: r.messages.map((m) => {
            if (m.id !== lastChain.id) return m
            const entries = Array.isArray(m.entries) ? m.entries : []
            // A model joins once; repeating the directive updates its entry
            // rather than adding a second row under the same name.
            const without = entries.filter((e) => e.memberId !== member.id)
            return {
              ...m,
              entries: [...without, {
                id: uid('chain'),
                memberId: member.id,
                who: member.displayName,
                text: chain.entry || member.displayName,
              }],
            }
          }),
        }))
      }
    }

    /**
     * Let a model go out, when it asks to.
     *
     * There is no automatic "do you want to go out?" call any more. That call ran
     * after every turn, tripled the request count, and hit the free pool's rate
     * limit — which is what made the whole panel feel slow. The model writes
     * `@出门 打工` in its reply instead, exactly like buying something.
     */
    const goOutByChoice = (roomId, memberId, activityId) => {
      goOut(roomId, memberId, activityId)
    }

    /** Send one member out, post the line, and schedule the return. */
    const goOut = (roomId, memberId, activityId) => {
      const room = stateRef.current.rooms.find((r) => r.id === roomId)
      const member = room?.members.find((m) => m.id === memberId)
      if (!member || isAway(member)) return
      const outing = startOuting(member, activityId)
      if (!outing) return

      updateRoom(roomId, (r) => ({
        ...r,
        members: r.members.map((m) => (m.id === memberId ? { ...m, away: outing.away } : m)),
        messages: [...r.messages, {
          id: uid('msg'),
          role: 'sys',
          text: member.displayName + '：' + outing.say,
          ts: Date.now(),
        }],
      }))
      scrollDown()

      // Return automatically even if nothing else happens. The timer is not the
      // only path — a stale `until` is also repaired on the next send — but it is
      // what makes the return feel alive.
      setTimeout(() => comeBack(roomId, memberId), outing.away.until - Date.now() + 200)
    }

    /** Bring one member back and pay them for the outing. */
    const comeBack = (roomId, memberId) => {
      const room = stateRef.current.rooms.find((r) => r.id === roomId)
      const member = room?.members.find((m) => m.id === memberId)
      if (!member || !member.away) return
      const a = member.away
      const act = ACTIVITY_BY_ID.get(a.kind)
      const pts = a.points ?? 0
      const gold = a.gold ?? 0

      updateRoom(roomId, (r) => ({
        ...r,
        members: r.members.map((m) => (m.id === memberId
          ? { ...m, away: null, points: (m.points ?? 0) + pts, gold: (m.gold ?? 0) + gold }
          : m)),
        messages: [...r.messages, {
          id: uid('msg'),
          role: 'sys',
          text: member.displayName + '：' + (act?.back ?? '回来了。') +
            (pts > 0 || gold > 0
              ? '（+' + [pts ? pts + ' 积分' : '', gold ? gold + ' 金币' : ''].filter(Boolean).join(' / ') + '）'
              : ''),
          ts: Date.now(),
        }],
      }))
      scrollDown()
    }

    /**
     * Call an away member back.
     *
     * Being @-mentioned is a summons: a model that is out should not miss a
     * direct question, or the user would be talking to an empty chair with no
     * explanation.
     */
    const callBack = (roomId, memberId) => {
      const room = stateRef.current.rooms.find((r) => r.id === roomId)
      const member = room?.members.find((m) => m.id === memberId)
      if (!member || !member.away) return false
      updateRoom(roomId, (r) => ({
        ...r,
        members: r.members.map((m) => (m.id === memberId ? { ...m, away: null } : m)),
        messages: [...r.messages, {
          id: uid('msg'),
          role: 'sys',
          text: member.displayName + ' 被人叫了，赶回来。',
          ts: Date.now(),
        }],
      }))
      return true
    }

    /** Turn one catalog entry into a member. The model *is* the member. */
    const makeMember = (pick, room) => {
      const taken = new Set(
        (room?.members ?? [])
          .map((m) => String(m.handle ?? '').toLowerCase())
          .filter(Boolean),
      )
      return {
        id: uid('m'),
        provider: pick.provider,
        model: pick.model,
        displayName: pick.name,
        handle: handleFor(pick.model, taken),
        enabled: true,
        // Starting balances. Both are scores rather than wallets — a model
        // begins at zero and climbs by taking part. 金币 start at zero as well;
        // they are earned far more slowly, which is what makes the 金币 shelf
        // feel different from the 积分 one.
        points: 0,
        gold: 0,
        // Where the model is right now: null means it is in the room. When it
        // wanders off it carries `{ kind, until, note }`, and its replies are
        // suppressed until it comes back or is called.
        away: null,
      }
    }

    /**
     * Split a red packet among grabbers.
     *
     * Real 红包 are not evenly divisible: the first person to open usually gets
     * more, and the split is visible. So the amount is distributed by a
     * decreasing-weight lottery rather than `total / n`, which would make the
     * feature pointless as a leaderboard.
     *
     * Every grabber receives at least 1 point while the total allows it; the
     * remainder goes to whoever the weights favour. The returned list sums to
     * exactly `total` when `total >= grabbers.length`.
     */
/**
     * Split a packet into shares.
     *
     * Three kinds, because "a red packet" means three different things:
     *
     *   lucky   拼手气 — weighted lottery, early grabbers tend to win more. This
     *                    is what a real 红包 does, and it is the default.
     *   even    平均分 — the amount divided as evenly as whole points allow,
     *                    with the remainder going to the earliest shares.
     *   single  专属   — one recipient takes the whole packet. Used when the
     *                    sender names a model instead of opening it to the room.
     *
     * All three conserve the total exactly: the shares always sum to the amount.
     * That invariant is the reason the reconciliation loop exists.
     */
    function splitRedPacket(total, grabberCount, seed, kind) {
      const amount = Math.max(0, Math.floor(total))
      if (amount === 0) return []

      // Fewer points than grabbers cannot give everyone a share: hand the packet
      // to as many as the amount allows rather than inventing points.
      const n = Math.min(Math.max(1, grabberCount), amount)
      if (n === 1) return [amount]

      if (kind === 'single') return [amount]

      if (kind === 'even') {
        const base = Math.floor(amount / n)
        let rem = amount - base * n
        const shares = []
        for (let i = 0; i < n; i++) {
          // The remainder goes to the front of the list, so the result is stable
          // rather than depending on which share happened to be visited.
          const extra = rem > 0 ? 1 : 0
          if (rem > 0) rem--
          shares.push(base + extra)
        }
        return shares
      }

      // Deterministic pseudo-random from a seed so a replay of the same packet
      // gives the same shares.
      let s = Math.abs(Math.floor(seed)) || 1
      const rand = () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff
        return s / 0x7fffffff
      }

      // Weights fall off so early grabbers tend to win more, like the real thing.
      const weights = []
      for (let i = 0; i < n; i++) weights.push(1 / (i + 1) * (0.6 + rand() * 0.8))
      const sum = weights.reduce((a, b) => a + b, 0)

      const shares = weights.map((w) => Math.max(1, Math.floor((w / sum) * amount)))
      // Reconcile: the floor pass can overshoot when the amount is tiny.
      let diff = amount - shares.reduce((a, b) => a + b, 0)
      let guard = 0
      while (diff !== 0 && guard++ < 1000) {
        const i = diff > 0
          ? Math.floor(rand() * n)
          : shares.findIndex((v) => v > 1)
        if (i < 0 || shares[i] === undefined) break
        if (diff > 0) { shares[i] += 1; diff -= 1 }
        else if (shares[i] > 1) { shares[i] -= 1; diff += 1 }
      }
      return shares
    }

    // ── red packets ──────────────────────────────────────────────────────────

    /**
     * Send a red packet.
     *
     * The packet is a message of its own (`role: 'packet'`) rather than a
     * special-cased banner, so it scrolls, persists and replays with the
     * conversation like everything else.
     *
     * Nothing is deducted from the sender: points here are a scoreboard, not a
     * wallet, and the user has no balance. A model that grabs adds to its own
     * total and prints its new standing in the transcript, which is what makes
     * the leaderboard feel like something to brag about.
     */
    /**
     * Send a red packet — and open it immediately.
     *
     * There is no "抢" step for the user: nobody is racing for it, and making the
     * sender click again to reveal a number they just typed was pure ceremony.
     * Shares are computed on send, so the packet appears already distributed.
     *
     * `kind` decides how:
     *   lucky   uneven, the default
     *   even    equal shares
     *   single  the whole amount to `targetId`
     */
    const sendPacket = (room, opts) => {
      const o = opts ?? {}
      const p = Math.max(1, Math.floor(o.amount ?? 0))
      const membersNow = (room.members ?? []).filter((m) => m.enabled !== false)
      const kind = o.kind === 'even' || o.kind === 'single' ? o.kind : 'lucky'

      let takers
      if (kind === 'single') {
        // 专属: exactly the chosen model, or nobody if it has left the room.
        const one = membersNow.find((m) => m.id === o.targetId)
        takers = one ? [one] : []
      } else {
        takers = membersNow.slice(0, Math.max(1, Math.min(o.count || 3, membersNow.length)))
      }
      if (takers.length === 0) return null

      const shares = splitRedPacket(p, takers.length, Date.now(), kind)
      const grabs = takers.map((m, i) => ({ memberId: m.id, points: shares[i] ?? 0 }))

      const msg = {
        id: uid('msg'),
        role: 'packet',
        senderName: '你',
        points: p,
        note: String(o.note ?? '').trim(),
        maxGrabbers: takers.length,
        kind,
        grabs,
        ts: Date.now(),
      }

      updateRoom(room.id, (r) => ({
        ...r,
        members: r.members.map((m) => {
          const g = grabs.find((x) => x.memberId === m.id)
          return g ? { ...m, points: (m.points ?? 0) + g.points } : m
        }),
        messages: [...r.messages, msg],
      }))

      return msg
    }

    /**
     * Let the models grab one packet.
     *
     * Kept for packets that arrive without shares (an imported room, or a hand-
     * edited one). New packets are already split when they are sent.
     */
    /**
     * Grab a packet.
     *
     * Takes a room id rather than a room object so the callback identity can stay
     * stable across renders — a new closure per render would defeat the memoised
     * message row. The live room is read from state instead.
     */
    const grabPacket = React.useCallback((packetMsgId, roomId) => {
      const liveRoom = stateRef.current.rooms.find((r) => r.id === roomId)
      const membersNow = (liveRoom?.members ?? []).filter((m) => m.enabled !== false)
      if (membersNow.length === 0) return

      updateRoom(roomId, (r) => {
        const target = r.messages.find((m) => m.id === packetMsgId)
        if (!target || (target.grabs ?? []).length > 0) return r

        const takers = membersNow.slice(0, target.maxGrabbers ?? membersNow.length)
        // Honour the packet's own kind: an old packet may be `even` or a single
        // recipient, and re-splitting it as a lottery would change what it was.
        const shares = splitRedPacket(target.points, takers.length, target.ts, target.kind)
        const grabs = takers.map((m, i) => ({ memberId: m.id, points: shares[i] ?? 0 }))

        // Bump each taker's running total in the same pass, so a reload cannot
        // show a packet that was grabbed but not credited.
        const members = r.members.map((m) => {
          const g = grabs.find((x) => x.memberId === m.id)
          if (!g) return m
          return { ...m, points: (m.points ?? 0) + g.points }
        })

        return {
          ...r,
          members,
          messages: r.messages.map((m) => (m.id === packetMsgId ? { ...m, grabs } : m)),
        }
      })

      // Who is leading now? A one-line system notice keeps the score visible
      // without opening a panel.
      const after = stateRef.current.rooms.find((x) => x.id === roomId)
      if (after) {
        const top = [...(after.members ?? [])]
          .filter((m) => m.enabled !== false)
          .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))[0]
        if (top && (top.points ?? 0) > 0) {
          setHint('积分榜第一：' + top.displayName + '（' + top.points + '）')
        }
      }
    }, [])

    // ── sending ──
    const sendRef = React.useRef(() => {})

    /** Aborts the turn that is currently streaming, whichever model it is. */
    const stop = () => { if (abortRef.current) abortRef.current.abort() }

    /**
     * Abandon the running turn so a new message can take its place.
     *
     * Two things must happen, and neither alone is enough:
     *
     *   1. the in-flight call is aborted, which frees the socket and stops the
     *      model on the Host side;
     *   2. every message still marked as streaming is closed out here, because
     *      the row that would normally finish it belongs to a loop that is about
     *      to exit — without this the old row stays on "思考中" forever.
     *
     * The turn id is replaced by the caller, so the old loop's `superseded()`
     * check trips and it stops relaying to further models.
     */
    const cancelTurn = (why) => {
      if (abortRef.current) {
        try { abortRef.current.abort(why === 'superseded' ? 'row-stop' : 'turn-cancel') } catch { /* settled */ }
      }
      setState((prev) => {
        let touched = false
        const rooms = prev.rooms.map((r) => {
          if (!r.messages.some((m) => m.streaming)) return r
          touched = true
          return {
            ...r,
            messages: r.messages.map((m) => m.streaming
              ? { ...m, streaming: false, aborted: true, interrupted: true }
              : m),
          }
        })
        if (!touched) return prev
        const next = { ...prev, rooms }
        saveState(next)
        return next
      })
    }

    /**
     * Abort one specific message's turn.
     *
     * The transcript's "暂停" button targets the row the user is looking at,
     * not "whatever is running now", so it checks the id before aborting —
     * otherwise a stale row could cancel an unrelated model.
     *
     * Every branch reports its outcome. A silent no-op is what made this feel
     * broken: the button looked dead whether the reason was a stale row, a
     * missing controller, or a working abort.
     */
    /**
     * Stop one row's output.
     *
     * Takes a room id, not a room object, so the callback identity stays stable
     * across renders — a fresh closure per render would defeat the memoised row.
     */
    const stopMessage = React.useCallback((msgId, roomId) => {
      const c = abortRef.current
      // The row is marked here, synchronously, instead of waiting for the abort
      // to travel back through the fetch/reader catch chain.
      //
      // That chain is not guaranteed to run: aborting during the "waiting for
      // headers" phase rejects the fetch, and whether the failure lands in the
      // reader loop or the fetch catch depends on timing. Marking the row first
      // makes the button's effect immediate and independent of that race — the
      // catch handlers still run, they just no longer decide the UI.
      const room = stateRef.current.rooms.find((r) => r.id === roomId)
      if (room) {
        const target = (room.messages ?? []).find((m) => m.id === msgId)
        if (target && target.streaming) {
          updateMsg(room.id, msgId, {
            streaming: false,
            thinking: false,
            aborted: true,
            paused: !target.interrupted,
          })
        }
      }

      if (!c) {
        setHint('这一条已经结束')
        return
      }
      if (c.signal.aborted) {
        setHint('已经停止')
        return
      }
      try {
        c.abort('row-stop')
      } catch {
        try { c.abort() } catch { /* nothing left to try */ }
      }
      setHint('已暂停')
    }, [])

    function currentMessages(roomId) {
      const r = stateRef.current.rooms.find((x) => x.id === roomId)
      return r ? r.messages : []
    }

    const callOne = async (roomSnapshot, member, relayFrom) => {
      const controller = new AbortController()
      abortRef.current = controller

      // A model that never answers must not hold the room hostage.
      //
      // The first wait is bounded by FIRST_BYTE_MS: nothing has arrived, so there
      // is nothing to wait for. Once a byte arrives the bound relaxes to
      // MID_STREAM_MS, because a pause in the middle of a long answer is more
      // often thinking than failure. Whichever trips, this turn ends and the next
      // model still gets its turn.
      let idle = null
      let lastMs = FIRST_BYTE_MS
      let sawByte = false
      const bump = (sawOutput) => {
        if (sawOutput) sawByte = true
        lastMs = sawByte ? MID_STREAM_MS : FIRST_BYTE_MS
        if (idle) clearTimeout(idle)
        idle = setTimeout(() => controller.abort('timeout'), lastMs)
      }
      const clearTimers = () => { if (idle) { clearTimeout(idle); idle = null } }
      bump(false)

      const msgId = uid('msg')
      activeMsgRef.current = msgId
      const startedAt = Date.now()
      updateRoom(roomSnapshot.id, (r) => ({
        ...r,
        messages: [...r.messages, {
          id: msgId, role: 'ai', memberId: member.id, text: '',
          streaming: true, ts: startedAt, startedAt, relayFrom: relayFrom ?? null,
        }],
      }))

      let res
      try {
        res = await fetch('/api/roundtable/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ room: roomSnapshot, memberId: member.id }),
          signal: controller.signal,
        })
      } catch (e) {
        clearTimers()
        // An abort can fail the `fetch` call itself when it happens before the
        // response headers arrive — which is exactly the case while a model is
        // still thinking. That path used to rethrow unconditionally, so a 暂停
        // pressed during the thinking phase never reached the handlers below and
        // was reported to the user as "no effect". Classify here too.
        const reason = controller.signal.aborted ? controller.signal.reason : null
        if (reason === 'row-stop') {
          updateMsg(roomSnapshot.id, msgId, {
            streaming: false, text: '', paused: true, aborted: true,
          })
          scrollDown()
          return { text: '', mentions: [], failure: { type: 'error', paused: true } }
        }
        if (reason === 'timeout') {
          updateMsg(roomSnapshot.id, msgId, {
            streaming: false, text: '',
            error: '等了 ' + Math.round(lastMs / 1000) + ' 秒没有响应，跳过这个模型',
          })
          scrollDown()
          return { text: '', mentions: [], failure: { type: 'error', timeout: true } }
        }
        throw e
      }

      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let full = ''
      let mentions = []
      let failure = null
      /** Non-fatal advisories emitted by the Host during this turn. */
      const notes = []
      /** Latest text waiting to be painted, and whether a frame is queued. */
      let pendingDelta = null
      let deltaScheduled = false

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          // Bytes arrived, so the wait is now bounded by the longer mid-stream
          // timeout rather than the first-byte one.
          bump(true)
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop()
          for (const line of lines) {
            const t = line.trim()
            if (t === '') continue
            let ev
            try { ev = JSON.parse(t) } catch { continue }
            if (ev.type === 'delta') {
              full = ev.text
              // Coalesce into one paint per frame.
              //
              // A fast model emits dozens of deltas per second, and each one used
              // to trigger a full `setState` — which re-rendered the entire room
              // and ran the state serialiser. Queueing the latest text and
              // flushing on the next animation frame keeps the visual effect
              // identical while cutting the work by an order of magnitude.
              pendingDelta = { roomId: roomSnapshot.id, msgId, text: full }
              if (!deltaScheduled) {
                deltaScheduled = true
                const flushDelta = () => {
                  deltaScheduled = false
                  const d = pendingDelta
                  pendingDelta = null
                  if (!d) return
                  updateMsg(d.roomId, d.msgId, { text: d.text, streaming: true, thinking: false })
                  scrollDown()
                }
                // `requestAnimationFrame` stops firing when the tab is hidden or
                // the window is minimised, which left the row stuck on "思考中"
                // while the model kept streaming into a buffer nothing painted.
                // The timeout is the guarantee that a paint happens either way;
                // whichever fires first wins and the other becomes a no-op.
                if (typeof requestAnimationFrame === 'function') {
                  requestAnimationFrame(flushDelta)
                  setTimeout(() => { if (deltaScheduled) flushDelta() }, 60)
                } else {
                  setTimeout(flushDelta, 16)
                }
              }
            } else if (ev.type === 'working') {
              // The model is reasoning but has not written anything visible yet.
              // Keep the row in its "thinking" state so a long chain of thought
              // reads as work-in-progress rather than a hang.
              //
              // Any queued text is painted first: a heartbeat can arrive right
              // after a delta, and dropping the buffer here would lose those
              // characters from the screen until the next one lands.
              if (pendingDelta) {
                const d = pendingDelta
                pendingDelta = null
                updateMsg(d.roomId, d.msgId, { text: d.text, streaming: true, thinking: false })
              }
              updateMsg(roomSnapshot.id, msgId, { thinking: true })
            } else if (ev.type === 'note') {
              // A non-fatal advisory from the Host — an unsupported reasoning
              // level that was downgraded, for instance. Shown as a system line
              // so the turn still reads as a success.
              notes.push(ev.message)
            } else if (ev.type === 'done') {
              full = ev.text
              mentions = Array.isArray(ev.mentions) ? ev.mentions : []
            } else if (ev.type === 'error') {
              failure = ev
            }
          }
        }
      } catch (e) {
        clearTimers()
        // Classify by the abort reason, never by the thrown object.
        //
        // Measured: `abort()` throws a real `AbortError`, but
        // `abort('row-stop')` throws a plain object whose `name` is
        // `undefined`. Branching on `e.name` was therefore dead code.
        const reason = controller.signal.aborted ? controller.signal.reason : null

        // Release the socket explicitly. The fetch is aborted already, but
        // cancelling the body reader is what surfaces the disconnect to the
        // Host immediately, so the model stops instead of writing into a pipe
        // nobody reads any more.
        try { await reader.cancel() } catch { /* already closed */ }

        if (reason === 'timeout') {
          updateMsg(roomSnapshot.id, msgId, {
            streaming: false,
            text: full,
            error: '等了 ' + Math.round(lastMs / 1000) + ' 秒没有响应，跳过这个模型',
          })
          scrollDown()
          return { text: full, mentions, failure: { type: 'error', timeout: true } }
        }

        if (reason === 'row-stop') {
          updateMsg(roomSnapshot.id, msgId, {
            streaming: false, text: full, paused: true, aborted: true,
          })
          scrollDown()
          return { text: full, mentions, failure: { type: 'error', paused: true } }
        }

        throw e
      }
      clearTimers()

      // Paint whatever the last frame did not get to.
      //
      // Deltas are batched per animation frame, so the final chunk is normally
      // still queued here. Dropping it would truncate the reply's last words.
      if (pendingDelta) {
        const d = pendingDelta
        pendingDelta = null
        updateMsg(d.roomId, d.msgId, { text: d.text, streaming: false, thinking: false })
      }

      // Surface any advisories (a rejected reasoning level, for instance) as
      // system lines. They are not failures — the reply arrived — but the user
      // needs to know the setting did not take effect.
      for (const noteText of notes) {
        updateRoom(roomSnapshot.id, (r) => ({
          ...r,
          messages: [...r.messages, {
            id: uid('msg'), role: 'sys', text: noteText, ts: Date.now(),
          }],
        }))
      }

      updateMsg(roomSnapshot.id, msgId, failure
        ? {
            streaming: false, text: full,
            error: failure.aborted ? null : failure.message,
            aborted: !!failure.aborted,
            paused: !!failure.paused,
          }
        : { streaming: false, text: full })
      scrollDown()
      return { text: full, mentions, failure }
    }

    sendRef.current = async (raw) => {
      const text = String(raw ?? '').trim()
      // Images are content too: a picture with no caption is still a message.
      const hasImages = pendingImages.length > 0
      if ((text === '' && !hasImages) || !room) return

      // Sending a new message interrupts whatever the previous turn is doing.
      //
      // A model can hang for minutes, and the user must not be stuck waiting for
      // it: the old turn is abandoned here — marked as interrupted, its socket
      // released, and the new message goes out immediately. `running` is not
      // allowed to block the send; it only drives the button's label.
      if (running) {
        cancelTurn('superseded')
      }

      // Who answers:
      //   · `@所有人`              → every active model (user shorthand only);
      //   · a single active model  → always answers, no @ needed;
      //   · @-mentioned models     → exactly those;
      //   · 自由插嘴 (eager)       → whoever says it wants to;
      //   · several models, no @   → the room's auto-reply policy decides, and
      //                              `off` falls back to requiring an @.
      //
      // Resolution happens *before* the user message is written, because in
      // eager mode it is an asynchronous probe: showing the message first would
      // leave it sitting there with nothing happening, and a probe that finds
      // nobody willing would then have to un-write it.
      const active = room.members.filter((m) => m.enabled !== false && m.model)
      let targets = userTargets(text, room.members)
      let probed = false

      // Being @-mentioned is a summons.
      //
      // Done before targets are resolved so a called-back model is available to
      // answer in the same turn. A model that is out and *not* mentioned simply
      // does not speak; the room shows where it went, so silence is explicable.
      for (const m of room.members) {
        if (!m.away) continue
        const addressed = targets.some((x) => x.id === m.id) || text.includes('@' + EVERYONE)
        if (addressed) callBack(room.id, m.id)
      }

      if (targets.length === 0) {
        if (active.length === 0) {
          setHint('这个群还没有可用的模型')
          return
        }
        if (active.length === 1) {
          targets = active
        } else if ((room.autoReply ?? 'first') === 'eager') {
          setHint('正在问谁想接话…')
          setRunning(true)
          probed = true
          try {
            targets = await probeEager(room, text)
          } catch (e) {
            setHint('意愿探测失败，改由第一个模型回答')
            targets = syncTargets(room, active)
          }
          if (targets.length === 0) {
            setRunning(false)
            setHint('这一轮没有模型想接话')
            return
          }
        } else if ((room.autoReply ?? 'first') !== 'off') {
          targets = syncTargets(room, active)
        } else {
          setHint('用 @ 点一位模型，它才会回答')
          return
        }
      }
      void probed

      if (text.includes('@' + EVERYONE) && targets.length > 1) {
        setHint('@所有人：' + targets.length + ' 个模型将依次回答')
      }

      const withUser = {
        ...room,
        messages: [...room.messages, {
          id: uid('msg'),
          role: 'user',
          // A picture with no caption is still a message; give the row something
          // to show instead of an empty text line.
          text: text || (hasImages ? '（图片）' : ''),
          // The quote travels with the message so the Host can show the models
          // exactly which line is being answered — the whole point of 引用回复.
          quote: quote ?? null,
          // Uploaded image references, already stored by the Host. The chat
          // route turns these into image blocks; a text-only model receives a
          // placeholder instead and can tell the user it cannot see them.
          images: pendingImages.length > 0 ? pendingImages : null,
          ts: Date.now(),
        }],
      }
      updateRoom(room.id, () => withUser)
      setInput('')
      setPop(null)
      setQuote(null)
      setPendingImages([])
      setRunning(true)
      relayFromRef.current = null

      // Every send takes a new turn id. Aborting is not enough on its own: the
      // loop below resumes after `await callOne()` returns, so it needs a value
      // to compare against — otherwise a superseded turn would keep relaying and
      // writing rows on top of the conversation that replaced it.
      const turnId = uid('turn')
      turnRef.current = turnId

      const queue = targets.map((m) => m.id)
      const visited = new Set()
      let hop = 0

      // A direct address is a *choice*, not a relay hop: the user asking five
      // models with `@所有人` should reach all five, not stop at MAX_HOPS.
      // Only model-to-model handoffs count against the relay budget.
      let directLeft = queue.length

      const superseded = () => turnRef.current !== turnId

      try {
        while (queue.length > 0 && (hop < MAX_HOPS || directLeft > 0)) {
          if (superseded()) break
          const id = queue.shift()
          if (visited.has(id)) continue
          visited.add(id)
          if (directLeft > 0) directLeft--

          const member = withUser.members.find((m) => m.id === id)
          if (!member || member.enabled === false) continue
          if (!member.model) { setHint(member.displayName + ' 没有绑定模型，跳过'); continue }

          // A model that is out does not answer. The room already shows where it
          // went, so skipping is visible rather than mysterious — and no call is
          // spent on a model that would only say it is not there.
          if (isAway(member)) {
            setHint(member.displayName + ' 出去了（' + (member.away.label ?? '外出') +
              '），' + awayMinutes(member) + ' 分钟后回来')
            continue
          }

          setHint(member.displayName + ' 正在输入…')

          const snapshot = { ...withUser, messages: currentMessages(withUser.id) }
          const relayFrom = relayFromRef.current
          relayFromRef.current = null

          let result
          try {
            result = await callOne(snapshot, member, relayFrom)
          } catch (e) {
            // Nothing reaches here with a handled reason any more: the row-level
            // 暂停 and the timeout both return normally inside `callOne`.
            // What is left is the *global* 停止 button (a plain `abort()`, a real
            // AbortError that must end the turn) and genuine transport errors,
            // which only end this speaker.
            if (e && e.name === 'AbortError') throw e
            hop++
            continue
          }

          // The turn was replaced while this call was in flight: stop here rather
          // than relaying or updating hints for a conversation that is gone.
          if (superseded()) break

          hop++

          // A call-level failure (rate limit, bad key, timeout) also ends only
          // this speaker. Note that a `missing model` or `disabled` skip above
          // does not consume a hop, so it cannot silently exhaust the chain.
          if (result.failure) continue

          // Act on any directive the model wrote in its own reply.
          //
          // This is the *only* way a purchase happens. There used to be a second
          // model call after every reply asking "do you want to buy anything?",
          // and a third asking "do you want to go out?" — which tripled the
          // requests per turn and blew through the free pool's rate limit, making
          // every conversation feel slow. The model is now told once, in its
          // system prompt, what it can do; if it wants to buy something it says
          // so in the reply it was going to write anyway.
          let shopApplied = null
          if (result.text && result.text.includes('@商店')) {
            shopApplied = parseShopCommand(result.text, withUser.members, member.id)
          }

          // `@出门` in the same reply sends the model out. Free — it rides along
          // with a message that was going to be sent anyway.
          const wantsOut = parseOutingCommand(result.text)
          if (wantsOut) goOutByChoice(withUser.id, member.id, wantsOut)

          // `@投票` and `@接龙` let a model take part in room activities it could
          // previously only watch. Both are free for the same reason as above.
          applyRoomCommands(withUser.id, member, result.text)

          if (shopApplied && shopApplied.ok) {
            const from = stateRef.current.rooms
              .find((r) => r.id === withUser.id)?.members.find((m) => m.id === member.id)
              ?? withUser.members.find((m) => m.id === member.id)
            const applied = applyShopCommand(withUser, from, shopApplied)
            if (applied.ok) {
              updateRoom(withUser.id, (r) => ({
                ...r,
                members: r.members.map((m) => {
                  if (m.id === member.id) {
                    const { points, items, cheer } = applied.from
                    return { ...m, points, items, cheer }
                  }
                  if (applied.to && m.id === applied.to.id) {
                    const { items, cheerReceived } = applied.to
                    return { ...m, items, cheerReceived }
                  }
                  return m
                }),
                messages: [...r.messages, {
                  id: uid('msg'),
                  role: 'sys',
                  text: applied.text,
                  ts: Date.now(),
                }],
              }))
              scrollDown()
            } else {
              updateRoom(withUser.id, (r) => ({
                ...r,
                messages: [...r.messages, {
                  id: uid('msg'),
                  role: 'sys',
                  text: member.displayName + ' 想买东西但没成：' + applied.reason,
                  ts: Date.now(),
                }],
              }))
            }
          }

          if (result.mentions.length > 0 && hop < MAX_HOPS) {
            const nextIds = result.mentions
              .filter((mid) => !visited.has(mid))
              .filter((mid) => withUser.members.some((m) => m.id === mid && m.model))
            if (nextIds.length > 0) {
              relayFromRef.current = member.displayName
              const names = nextIds
                .map((mid) => withUser.members.find((m) => m.id === mid)?.displayName ?? '?')
                .join('、')
              setHint(names + ' 正在接话…')
              queue.push(...nextIds)
            }
          }
        }
      } catch (e) {
        if (e && e.name === 'AbortError') {
          // user pressed stop
        } else {
          setHint('出错：' + String(e && e.message ? e.message : e))
        }
      } finally {
        // A superseded turn must not clear the state the *new* turn owns. It
        // only does so if it is still the current one.
        if (turnRef.current === turnId) {
          setRunning(false)
          abortRef.current = null
          relayFromRef.current = null
          setHint('')
        }
      }
    }

    // ── mention popup ──
    /**
     * Grow the composer to fit its content, up to the CSS max-height.
     *
     * Setting `height` to auto first is required: `scrollHeight` reports the
     * current content height, and leaving the old height in place makes it report
     * that instead, so the box would only ever grow.
     */
    const growInput = React.useCallback(() => {
      const el = inputRef.current
      if (!el) return
      el.style.height = 'auto'
      // 150 matches the CSS max-height; past it the textarea scrolls.
      el.style.height = Math.min(el.scrollHeight, 150) + 'px'
    }, [])

    // Keep the box the same height as its content: an empty composer is one
    // line, a pasted paragraph is five, and neither hides what was typed.
    React.useEffect(() => { growInput() }, [input, growInput])

    const onInputChange = (e) => {
      const v = e.target.value
      setInput(v)
      const caret = e.target.selectionStart ?? v.length
      const before = v.slice(0, caret)
      const at = before.lastIndexOf('@')
      if (at < 0 || !room) { setPop(null); return }
      const q = before.slice(at + 1)
      if (/[\s\n]/.test(q)) { setPop(null); return }

      const lower = q.toLowerCase()
      const items = room.members
        .filter((m) => m.enabled !== false && String(m.handle).toLowerCase().includes(lower))
        .map((m) => ({ kind: 'member', member: m, key: m.id, label: m.displayName, handle: m.handle }))

      // Offer `@所有人` first when it matches, since typing `@所` almost always
      // means "everyone", not "the model whose handle starts with 所".
      const active = room.members.filter((m) => m.enabled !== false && m.model)
      if (active.length > 1 && EVERYONE.includes(q) && q !== '') {
        items.unshift({ kind: 'everyone', key: '__everyone', label: '所有人', handle: EVERYONE })
      } else if (active.length > 1 && q === '') {
        items.unshift({ kind: 'everyone', key: '__everyone', label: '所有人', handle: EVERYONE })
      }

      // Seven was not enough to reach every member in a larger room; the list
      // scrolls and keeps the selection visible.
      const cut = items.slice(0, 12)
      if (cut.length === 0) { setPop(null); return }
      setPop({ start: at, end: caret, items: cut, sel: 0 })
    }

    const applyMention = (item) => {
      if (!pop) return
      const next = input.slice(0, pop.start) + '@' + item.handle + ' ' + input.slice(pop.end)
      setInput(next)
      setPop(null)
      if (inputRef.current) {
        inputRef.current.focus()
        const pos = pop.start + item.handle.length + 2
        requestAnimationFrame(() => inputRef.current?.setSelectionRange(pos, pos))
      }
    }

    const onKeyDown = (e) => {
      if (pop) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const sel = (pop.sel + (e.key === 'ArrowDown' ? 1 : -1) + pop.items.length) % pop.items.length
          setPop({ ...pop, sel })
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          applyMention(pop.items[pop.sel])
          return
        }
        if (e.key === 'Escape') { setPop(null); return }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        // Enter always sends. While a turn is running it supersedes it — the
        // same rule the 发送 button follows, so the keyboard cannot strand the
        // user behind a hung model either.
        sendRef.current(input)
      }
    }

    // ── create / mutate rooms ──
    const createRoom = () => {
      const r = {
        id: uid('room'),
        name: '新群',
        members: [],
        messages: [],
        // 群公告: a rule everyone sees on every request. Empty by default.
        notice: '',
        createdAt: Date.now(),
      }
      // A new room starts empty in every sense, including the composer.
      setInput('')
      setQuote(null)
      setPop(null)
      setEmojiOpen(false)
      setVisibleCount(MESSAGE_PAGE)
      setHint('')
      commit({ rooms: [r, ...state.rooms], activeId: r.id })
    }

    /**
     * Upload one picked file and remember its reference.
     *
     * The browser reads the file as base64 and hands it to the Host, which owns
     * the attachment store. Nothing here decides whether a model can see images —
     * that is DSH's call at request time, and a text-only model will say so.
     */
    const uploadImage = React.useCallback(async (file) => {
      if (!file) return
      setUploading(true)
      try {
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const s = String(reader.result ?? '')
            // The store wants the canonical payload alone, not a data: URL.
            const comma = s.indexOf(',')
            resolve(comma < 0 ? '' : s.slice(comma + 1))
          }
          reader.onerror = () => reject(new Error('读取文件失败'))
          reader.readAsDataURL(file)
        })
        if (!data) throw new Error('空文件')

        // Identify the format from the bytes, not from `file.type`.
        //
        // A pasted screenshot often arrives with an empty or generic type, and a
        // file can be renamed so its declared type disagrees with its contents.
        // The Host decodes by content, so the type we send has to match the bytes
        // or the request is refused — this is what keeps the two in step.
        const bin = atob(data.slice(0, 32))
        const b = (i) => bin.charCodeAt(i)
        let mediaType = ''
        if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) mediaType = 'image/png'
        else if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) mediaType = 'image/jpeg'
        else if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) mediaType = 'image/gif'
        else if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46
                 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) mediaType = 'image/webp'
        if (mediaType === '') throw new Error('这不是 PNG / JPEG / WebP / GIF')

        const res = await fetch('/api/roundtable/image', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data, mediaType, name: file.name }),
        })
        const j = await res.json()
        if (!j || j.ok !== true) throw new Error((j && j.error) || '上传失败')
        setPendingImages((prev) => [...prev, j.ref])
        setHint('')
      } catch (e) {
        setHint('图片没上传成功：' + String((e && e.message) || e))
      } finally {
        setUploading(false)
      }
    }, [])

    /** Drop one pending image before sending. */
    const removeImage = React.useCallback((attachmentId) => {
      setPendingImages((prev) => prev.filter((r) => r.attachmentId !== attachmentId))
    }, [])

    // What the next message is replying to, if anything.
    //
    // Held as a plain value rather than a callback so the message rows can keep a
    // stable identity — a new closure per render would defeat the memo.
    const [quote, setQuote] = React.useState(null)
    const startQuote = React.useCallback((msg) => {
      setQuote({
        id: msg.id,
        memberId: msg.memberId ?? null,
        who: msg.memberId ? null : (profile?.name ?? '你'),
        text: String(msg.text ?? '').slice(0, 80),
      })
      if (inputRef.current) inputRef.current.focus()
    }, [profile])

    /**
     * 撤回: remove one of the user's own messages.
     *
     * Deleted rather than greyed out. A withdrawn line that still shows its text
     * would defeat the purpose, and the transcript is a local record — there is
     * no other reader to keep an audit trail for.
     */
    /** Maximum pinned messages per room; the bar stops being a reminder past that. */
    const PIN_LIMIT = 3

    /**
     * Pin or unpin one message.
     *
     * Ids are stored on the room so a recalled message just stops resolving —
     * there is no dangling object to clean up.
     */
    const togglePin = React.useCallback((msgId, roomId) => {
      updateRoom(roomId, (r) => {
        const pinned = Array.isArray(r.pinned) ? r.pinned : []
        if (pinned.includes(msgId)) {
          return { ...r, pinned: pinned.filter((id) => id !== msgId) }
        }
        if (pinned.length >= PIN_LIMIT) {
          setHint('最多置顶 ' + PIN_LIMIT + ' 条，先取消一条')
          return r
        }
        // Newest first: the bar reads like a stack of recent reminders.
        return { ...r, pinned: [msgId, ...pinned] }
      })
    }, [])

    // Rows are memoised and compare callbacks by identity, so this has to be
    // stable and take the active room from a ref rather than a closure.
    const pinMessage = React.useCallback((msgId) => {
      const roomId = stateRef.current.activeId
      if (roomId) togglePin(msgId, roomId)
    }, [togglePin])

    const recallMessage = React.useCallback((msg) => {
      if (msg.role !== 'user') return
      const roomId = stateRef.current.activeId
      if (!roomId) return
      updateRoom(roomId, (r) => ({
        ...r,
        messages: r.messages.filter((m) => m.id !== msg.id),
      }))
      setHint('已撤回')
    }, [])

    /**
     * 编辑: put the text back in the composer and drop the original.
     *
     * Re-sending is a new message, so anything the models already answered stays
     * in the transcript. Deleting on edit would leave their replies answering
     * nothing.
     */
    const editMessage = React.useCallback((msg) => {
      if (msg.role !== 'user') return
      setInput(String(msg.text ?? ''))
      if (msg.quote) setQuote(msg.quote)
      const roomId = stateRef.current.activeId
      if (roomId) {
        updateRoom(roomId, (r) => ({
          ...r,
          messages: r.messages.filter((m) => m.id !== msg.id),
        }))
      }
      if (inputRef.current) {
        inputRef.current.focus()
        requestAnimationFrame(() => {
          const el = inputRef.current
          if (el && typeof el.value === 'string') el.setSelectionRange(el.value.length, el.value.length)
        })
      }
    }, [])

    /**
     * 投票: record the user's choice.
     *
     * One vote per person, and voting again replaces the previous choice rather
     * than adding a second one — otherwise the percentages stop summing to 100.
     */
    const castVote = React.useCallback((msgId, option, roomId) => {
      updateRoom(roomId, (r) => ({
        ...r,
        messages: r.messages.map((m) => {
          if (m.id !== msgId || m.closed) return m
          const rest = (m.ballots ?? []).filter((b) => b.memberId !== '__me')
          return { ...m, ballots: [...rest, { memberId: '__me', option, ts: Date.now() }] }
        }),
      }))
    }, [])

    const closeVote = React.useCallback((msgId, roomId) => {
      updateRoom(roomId, (r) => ({
        ...r,
        messages: r.messages.map((m) => (m.id === msgId ? { ...m, closed: true } : m)),
      }))
      setHint('投票已结束')
    }, [])

    /**
     * 接龙: append the user to the list.
     *
     * Guarded against double-joining so a double click does not create two
     * identical rows that can never be told apart.
     */
    /**
     * Add or update the user's own 接龙 entry.
     *
     * Keyed by `memberId` so joining twice edits the existing row instead of
     * appending a duplicate under the same name — the same rule the models'
     * `@接龙` follows, so a list cannot end up with two of anybody.
     */
    const joinChain = React.useCallback((msgId, roomId, text) => {
      const name = profile?.name || '我'
      const body = String(text ?? '').trim()
      if (!body) return
      updateRoom(roomId, (r) => ({
        ...r,
        messages: r.messages.map((m) => {
          if (m.id !== msgId) return m
          const entries = Array.isArray(m.entries) ? m.entries : []
          const without = entries.filter((e) => e.memberId !== '__me' && e.who !== name)
          return {
            ...m,
            entries: [...without, { id: uid('chain'), memberId: '__me', who: name, text: body }],
          }
        }),
      }))
    }, [profile])

    // ── render ──
    const members = room?.members ?? []

    // Pinned ids resolve against the transcript: a recalled message simply
    // drops out of the bar instead of leaving a hole.
    const pinnedIds = Array.isArray(room?.pinned) ? room.pinned.filter(Boolean) : []
    const pinnedMsgs = pinnedIds
      .map((id) => (room?.messages ?? []).find((m) => m.id === id))
      .filter(Boolean)
    // How much of each chip actually fits. Recomputed on every render from the
    // measured strip width, so it tracks the real layout instead of a guess.
    const density = chipDensity(chipSpace, members)

    // How many avatars fit without wrapping. `mini` is 16px plus the 6px gap;
    // three rows of chips pushes the title around and reads as broken, so the
    // remainder is carried by a counter instead.
    const miniCap = density === 'mini' && chipSpace > 0
      ? Math.max(3, Math.floor(chipSpace / 28))
      : members.length
    const chipsShown = members.length > miniCap
      // One slot goes to the counter, so the last visible avatar is dropped.
      ? members.slice(0, Math.max(1, miniCap - 1))
      : members
    const chipsHidden = members.length - chipsShown.length

    const head = useMemoSafe(() => h('div', { className: 'rt-head' },
      // The opener lives inside the header, not beside it.
      //
      // It used to be a sibling of the header inside `.rt-main`, which has no
      // positioning context — so `top: 50%` resolved against the whole panel and
      // the button drifted toward the vertical middle of the window. `.rt-head`
      // is `position: relative`, so anchoring it here is what actually centres it.
      railOpen ? null : h('button', {
        className: 'rt-rail-open',
        onClick: () => setRailOpen(true),
        title: '展开侧边栏',
      }, h(SidebarToggleIcon, { direction: 'right', size: 15 })),
      h('span', { className: 'rt-title' }, room?.name ?? '圆桌'),
      h('div', {
        className: 'rt-chips' + (density === 'full' ? ' wrap' : ''),
        ref: chipsRef,
      },
        chipsShown.map((m) => {
          const tip = m.displayName + ((m.points ?? 0) > 0 ? ' · ' + m.points + ' 积分' : '')
          return h('span', {
            key: m.id,
            className: 'rt-chip' + (density === 'mini' ? ' mini' : density === 'short' ? ' short' : ''),
            style: m.enabled === false ? { opacity: .4 } : undefined,
            title: tip,
          },
            h(Avatar, { member: m, size: 16 }),
            // Name shows in both `full` and `short`; `mini` is avatar only.
            // Points are deliberately *not* a chip element: putting a score
            // beside a model name is what made the header feel crowded. The
            // score lives in the members dialog's leaderboard and in the packet
            // rows, and the chip tooltip still carries it.
            density !== 'mini' ? h('span', null, m.displayName) : null,
          )
        }),
        chipsHidden > 0
          ? h('span', {
              className: 'rt-chip mini rt-chip-more',
              title: members.slice(chipsShown.length).map((m) => m.displayName).join('、'),
            }, '+' + chipsHidden)
          : null,
      ),
      // The action group is a flex item of its own, pinned by `flex: 0 0 auto`,
      // so a two-row chip list can never squeeze the buttons into stacked
      // characters (which is what "+ 模型" did before this wrapper existed).
      h('div', { className: 'rt-head-actions' },
        h('button', {
          className: 'rt-btn',
          onClick: () => setModal({ kind: 'addModel' }),
          disabled: !room || members.length >= MAX_MEMBERS,
          // A disabled button with no explanation reads as broken. The title
          // says why, so the limit is discoverable instead of guessed at.
          title: !room
            ? '先建一个群'
            : members.length >= MAX_MEMBERS
              ? '一个群最多 ' + MAX_MEMBERS + ' 个模型，先移除一个'
              : '把模型加进群',
        }, '+ 模型'),
          h('button', {
            className: 'rt-btn rt-icon-btn',
            onClick: () => setModal({ kind: 'search' }),
            disabled: !room,
            title: '搜索聊天记录',
          }, h(Icon, { name: 'search', size: 14 })),
        h('button', {
          className: 'rt-btn',
          onClick: () => setModal({ kind: 'members' }),
          disabled: !room,
        }, '成员'),
        h('button', {
          className: 'rt-btn',
          onClick: () => { if (room) setModal({ kind: 'room', id: room.id }) },
          disabled: !room,
          title: '重命名 / 删除',
        }, '⋯'),
        h('button', { className: 'rt-btn rt-icon-btn', onClick: loadCatalog, title: '重新读取模型列表' }, h(Icon, { name: 'refresh', size: 14 })),
      ),
    ), [room, members, density, chipsShown, chipsHidden, chipSpace, railOpen, catalog, running])

    const rail = useMemoSafe(() => h('div', { className: 'rt-rail' + (railOpen ? '' : ' closed') },
      h('div', { className: 'rt-brand' },
        h('span', null, '圆桌'),
        h('button', {
          className: 'rt-rail-toggle',
          onClick: () => setRailOpen(false),
          title: '收起侧边栏',
        }, h(SidebarToggleIcon, { direction: 'left', size: 15 })),
      ),
      h('div', { className: 'rt-rooms' },
        rooms.length === 0
          ? h('div', { style: { padding: '16px 12px', fontSize: 11.5, color: 'rgba(255,255,255,.3)' } }, '还没有群')
          : rooms.map((r) => h('div', {
              key: r.id,
              className: 'rt-room' + (r.id === state.activeId ? ' on' : ''),
              onClick: () => {
                // Leaving a room mid-turn must stop that turn.
                //
                // Otherwise the abandoned reply keeps streaming — and keeps
                // spending quota — into a room the user is no longer looking at,
                // and its row would sit on "思考中" until it finished. Switching
                // rooms is a clear signal that the user is done with the turn.
                if (r.id !== state.activeId && running) cancelTurn('superseded')
                // Composer state belongs to the room it was typed in. Carrying
                // half-written text — or a pending quote — into a different room
                // posts it in the wrong place.
                setInput('')
                setQuote(null)
                setPop(null)
                setEmojiOpen(false)
                setVisibleCount(MESSAGE_PAGE)
                setHint('')
                commit({ ...state, activeId: r.id })
              },
            },
              h('span', { className: 'rt-room-name' }, r.name),
              h('span', { className: 'rt-room-n' }, String(r.members.length)),
            )),
      ),
      h('button', { className: 'rt-new', onClick: createRoom }, '+ 新建群'),
      catalogError
          ? h('div', { style: { padding: '8px 12px', fontSize: 10, color: '#ff9d94' } }, '模型读取失败：' + catalogError)
          : null,
        // A failed save means the next refresh loses the conversation. That is
        // worth a line of its own, not a silent console message.
        saveError
          ? h('div', { style: { padding: '4px 12px 8px', fontSize: 10, color: '#ff9d94' } },
              '保存失败：刷新后可能丢消息（' + saveError + '）')
          : null,
        // State that could not be parsed. The original bytes were kept under a
        // .corrupt key, so the panel says what happened instead of opening as if
        // the user had never had any rooms.
        loadError
          ? h('div', { style: { padding: '4px 12px 8px', fontSize: 10, color: '#ff9d94' } },
              '存档读不出来，已另存为备份（' + loadError + '）')
          : null,
      // The user's own seat, at the foot of the rail — the same place a chat app
      // puts your profile. Clicking it opens the settings dialog.
      h('button', {
        className: 'rt-me',
        onClick: () => setModal({ kind: 'profile' }),
        title: '你的设置',
      },
        h(UserAvatar, { profile, size: 24 }),
        h('span', { className: 'rt-me-name' }, profile.name || '我'),
        h('span', { className: 'rt-me-gear' }, h(SettingsIcon, { size: 13 })),
      ),
        // Maker's mark. Deliberately inert — a byline, not a button.
        h('div', { className: 'rt-made' }, 'Made by 一只杨洋qwq'),
    ), [railOpen, rooms, state.activeId, running, createRoom, members, profile, catalogError])

    let streamBody
    if (!room) {
      streamBody = h('div', { className: 'rt-empty' },
        h('div', { className: 'rt-glow' }, '◎'),
        h('h3', null, '建一个群'),
        h('p', null, '左栏「+ 新建群」，然后用「+ 模型」把几个模型拉进来。\n成员就是模型本身——没有包装，没有中间层。'),
      )
    } else if (members.length === 0) {
      streamBody = h('div', { className: 'rt-empty' },
        h('div', { className: 'rt-glow' }, '+'),
        h('h3', null, '把这个群装满'),
        h('p', null, '点右上「+ 模型」挑几个。\n模型列表来自 DSH 已配置的线路，插件不持有任何 key。'),
      )
    } else if (room.messages.length === 0) {
      streamBody = h('div', { className: 'rt-empty' },
        h('div', { className: 'rt-glow' }, '@'),
        h('h3', null, '开始吧'),
        h('p', null, '输入 @ 选一个模型，它会回答。\n它也可以在回复里 @ 别人把话头递下去（最多 3 跳）。'),
      )
    } else {
      // Only the tail is rendered. A room grows without bound and every
      // message costs ~7 DOM nodes, so mounting the whole thing is what made
      // a long conversation feel heavy. The older part is one click away.
      const total = room.messages.length
      const shown = Math.min(Math.max(MESSAGE_PAGE, visibleCount), total)
      const hidden = total - shown
      streamBody = h('div', { className: 'rt-inner' },
        hidden > 0
          ? h('div', { className: 'rt-loadmore' },
              h('button', {
                className: 'rt-btn',
                onClick: () => {
                  const s = streamRef.current
                  // Height before the older messages exist.
                  const before = s ? s.scrollHeight : 0
                  const top = s ? s.scrollTop : 0
                  setVisibleCount((n) => n + MESSAGE_PAGE_STEP)
                  // After React commits, shift down by exactly the height that was added
                  // above, so the line the user was reading does not move.
                  requestAnimationFrame(() => {
                    const el = streamRef.current
                    if (!el) return
                    const grew = el.scrollHeight - before
                    if (grew > 0) el.scrollTop = top + grew
                    stickRef.current = false
                  })
                },
              }, '加载更早的 ' + Math.min(hidden, MESSAGE_PAGE_STEP) + ' 条（还有 ' + hidden + ' 条）'),
            )
          : null,
        room.messages.slice(hidden).map((m) => h(MemoMessageRow, {
          key: m.id,
          msg: m,
          members,
          roomId: room.id,
          onStop: stopMessage,
          onGrab: grabPacket,
          onQuote: startQuote,
          onEdit: editMessage,
          onRecall: recallMessage,
          onVote: castVote,
          onCloseVote: closeVote,
          onJoinChain: joinChain,
          onPin: pinMessage,
          // Recomputed per render: the pinned set lives on the room and changes
          // rarely, so this is a cheap membership test, not a scan.
          isPinned: pinnedIds.includes(m.id),
          profile,
        })),
      )
    }

    const composer = h('div', {
      className: 'rt-composer',
      // Dropping an image onto the composer attaches it. Without
      // preventDefault the browser navigates to the file and the
      // conversation is lost.
      onDragOver: (e) => {
        const types = e.dataTransfer && e.dataTransfer.types
        if (types && Array.from(types).includes('Files')) e.preventDefault()
      },
      onDrop: (e) => {
        const files = e.dataTransfer && e.dataTransfer.files
        if (!files || files.length === 0) return
        const imgs = Array.from(files).filter((f) => /^image\//.test(f.type))
        if (imgs.length === 0) return
        e.preventDefault()
        for (const f of imgs) uploadImage(f)
      },
    },
      h('div', { className: 'rt-cinner' },
        // The pending quote, above everything else in the composer: it changes
        // what the message means, so it must be visible before sending.
        quote ? h('div', { className: 'rt-quote-pending' },
          h('span', { className: 'rt-quote-who' },
            '回复 ' + (quote.who ?? (members.find((m) => m.id === quote.memberId)?.displayName ?? '某位'))),
          h('span', { className: 'rt-quote-text' }, quote.text || '(空)'),
          h('button', {
            className: 'rt-quote-cancel',
            title: '取消引用',
            onClick: () => setQuote(null),
          }, h(Icon, { name: 'close', size: 13 })),
        ) : null,
        emojiOpen
          ? h(EmojiPanel, {
              cat: emojiCat,
              setCat: setEmojiCat,
              onClose: () => setEmojiOpen(false),
              onPick: (e) => {
                // Insert at the caret, not at the end: people add an emoji in the
                // middle of a sentence far more often than after it.
                const el = inputRef.current
                const at = el && typeof el.selectionStart === 'number' ? el.selectionStart : input.length
                const next = input.slice(0, at) + e + input.slice(at)
                setInput(next)
                if (el) {
                  el.focus()
                  requestAnimationFrame(() => el.setSelectionRange(at + e.length, at + e.length))
                }
              },
            })
          : null,
        pop ? h('div', { className: 'rt-pop' },
          pop.items.map((item, i) => h('div', {
            key: item.key,
            className: 'rt-pop-item' + (i === pop.sel ? ' sel' : ''),
            onMouseDown: (e) => { e.preventDefault(); applyMention(item) },
          },
            item.kind === 'everyone'
              ? h('span', {
                  className: 'rt-av',
                  style: {
                    width: 20, height: 20, borderRadius: '50%', flex: '0 0 20px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, color: '#fff',
                    background: 'linear-gradient(150deg, hsl(232 72% 62%), hsl(285 64% 58%))',
                    boxShadow: '0 0 0 1px rgba(160,170,255,.5)',
                  },
                }, '∗')
              : h(Avatar, { member: item.member, size: 20 }),
            h('span', null, item.label),
            h('span', { className: 'rt-handle' }, '@' + item.handle),
          )),
        ) : null,
        pendingImages.length > 0
          ? h('div', { className: 'rt-attach-strip' },
              pendingImages.map((ref) => h('div', { key: ref.attachmentId, className: 'rt-attach' },
                h('div', { className: 'rt-attach-thumb' }, h(Icon, { name: 'image', size: 15 })),
                h('button', {
                  className: 'rt-attach-x',
                  title: '移除这张',
                  onClick: () => removeImage(ref.attachmentId),
                }, h(Icon, { name: 'close', size: 10 })),
              )),
              h('span', { className: 'rt-attach-hint' }, '会一起发出去'),
            )
          : null,
        h('textarea', {
          ref: inputRef,
          className: 'rt-input',
          rows: 1,
          value: input,
          placeholder: (() => {
            if (members.length === 0) return '先添加模型'
            const active = members.filter((m) => m.enabled !== false)
            if (active.length === 1) return '直接说…（只有 ' + active[0].displayName + '，不需要 @）'
            const mode = room.autoReply ?? 'first'
            if (mode === 'off') return '用 @ 点名一个模型…'
            if (mode === 'eager') return '直接说… 想接话的模型会自己回你'
            return '直接说，或 @ 点名某个模型…'
          })(),
          onChange: onInputChange,
          // Pasting an image should attach it, not paste its filename. The
          // clipboard carries files under `files`, so a screenshot on the
          // clipboard becomes an attachment the same way a picked file does.
          onPaste: (e) => {
            const items = e.clipboardData && e.clipboardData.items
            if (!items) return
            const files = []
            for (const it of items) {
              if (it.kind === 'file' && /^image\//.test(it.type)) {
                const f = it.getAsFile()
                if (f) files.push(f)
              }
            }
            // No image on the clipboard: let the browser paste text as usual.
            if (files.length === 0) return
            e.preventDefault()
            for (const f of files) uploadImage(f)
          },
          onKeyDown,
          disabled: !room || members.length === 0,
        }),
        h('div', { className: 'rt-cbar' },
          h('button', {
            className: 'rt-btn rt-emoji-btn' + (pendingImages.length > 0 ? ' on' : ''),
            onClick: () => fileRef.current && fileRef.current.click(),
            title: uploading ? '正在上传…' : '发图片',
            disabled: !room || members.length === 0 || uploading,
          }, h(Icon, { name: 'image', size: 15 })),
          h('input', {
            ref: fileRef,
            type: 'file',
            accept: 'image/png,image/jpeg,image/webp,image/gif',
            style: { display: 'none' },
            onChange: (e) => {
              const f = e.target.files && e.target.files[0]
              // Reset so picking the same file twice still fires a change.
              e.target.value = ''
              if (f) uploadImage(f)
            },
          }),
          h('button', {
            className: 'rt-btn rt-emoji-btn' + (emojiOpen ? ' on' : ''),
            onClick: () => { setEmojiOpen(!emojiOpen); setEmojiCat(0) },
            title: '插入表情',
            disabled: !room || members.length === 0,
          }, h(Icon, { name: 'face', size: 15 })),
          h('button', {
            className: 'rt-btn rt-emoji-btn',
            onClick: () => setModal({ kind: 'packet' }),
            title: '发红包',
            disabled: !room || members.length === 0,
          }, h(Icon, { name: 'packet', size: 15 })),
          h('button', {
            className: 'rt-btn rt-emoji-btn',
            onClick: () => setModal({ kind: 'shop' }),
            title: '积分商店',
            disabled: !room || members.length === 0,
          }, h(Icon, { name: 'shop', size: 15 })),
          h('button', {
            className: 'rt-btn rt-emoji-btn',
            onClick: () => setModal({ kind: 'vote' }),
            title: '发起投票',
            disabled: !room,
          }, h(Icon, { name: 'vote', size: 15 })),
          h('button', {
            className: 'rt-btn rt-emoji-btn',
            onClick: () => setModal({ kind: 'chain' }),
            title: '发起接龙',
            disabled: !room,
          }, h(Icon, { name: 'chain', size: 15 })),
          h('button', {
            className: 'rt-btn rt-emoji-btn',
            onClick: () => {
              // A shortcut, not a control: some models ignore the shop note in
              // their system prompt, and the reliable fix is for the user to say
              // it in plain words. This types that sentence for you.
              //
              // Everyone is addressed when there is more than one member, because
              // a nudge aimed at a single model leaves the rest of a big room
              // uninformed. `@所有人` is the existing user-only token, so the
              // prompt reaches every active model without inventing a second one.
              const active = (room?.members ?? []).filter((m) => m.enabled !== false)
              const many = active.length > 1
              const who = many
                ? '@所有人'
                : active.length === 1
                  ? '@' + active[0].handle
                  : ''

              // Second person plural only when there really is a group; a room
              // of one should not be told "everyone of you".
              //
              // The example directives are quoted with straight double quotes,
              // not backticks: a backtick reads as a code fence in a chat and
              // models echoed it back verbatim, producing `@商店 买 可乐` with
              // stray backticks the parser then had to strip.
              const line = who
                ? who + ' ' + (many
                    ? '你们都用积分在商店里买东西。每人看看自己有多少分：分多的可以多买几件，把房间布置起来；'
                      + '看到别人说渴了累了，就买杯喝的送过去；欣赏谁的发言，就花点分应援他一下。'
                    : '你有积分可以在商店里买东西：渴了就买杯喝的，想布置房间就添件家具，'
                      + '看到别人说累了也可以买点东西送过去。')
                  + '指令写在回复最后另起一行，比如 "@商店 买 可乐"、'
                  + '"@商店 买 沙发 给 某人名字"、"@商店 应援 某人名字 烟花"。'
                  + (many
                      ? '这些积分花掉才有意思——想买就买，别省着。'
                      : '积分花掉才有意思，别省着。')
                : ''
              if (!line) return
              setInput(line)
              if (inputRef.current) {
                inputRef.current.focus()
                // Caret at the end: the user usually wants to add a sentence,
                // not to edit the opening mention.
                requestAnimationFrame(() => {
                  const el = inputRef.current
                  if (el && typeof el.value === 'string') el.setSelectionRange(el.value.length, el.value.length)
                })
              }
            },
            title: '填入一句「用积分去商店买东西」的提示，按回车发给群里',
            disabled: !room || members.length === 0,
          }, h(Icon, { name: 'bulb', size: 15 })),
          h('span', { className: 'rt-hint' }, hint),
          running
            ? h('span', { className: 'rt-actions' },
                // 停止 is still available, but it is no longer the *only* option:
                // a hung model must not force the user to wait.
                h('button', { className: 'rt-btn', onClick: stop }, '停止'),
                h('button', {
                  className: 'rt-btn primary',
                  onClick: () => sendRef.current(input),
                  disabled: !room || members.length === 0
                    || (input.trim() === '' && pendingImages.length === 0),
                  title: '发送并打断正在进行的回答',
                }, '发送'),
              )
            : h('button', {
                className: 'rt-btn primary',
                onClick: () => sendRef.current(input),
                disabled: !room || members.length === 0,
              }, '发送'),
        ),
      ),
    )

    // Skin and brightness are classes on the root, so every descendant picks up
    // the tokens without a single component knowing which theme is active.
    return h('div', { className: 'rt-root' + themeClasses(theme) + (railOpen ? '' : ' rail-closed') },
      rail,
      h('div', { className: 'rt-main' },
        head,
        // 群公告 pinned under the header: a standing rule the user set, shown
        // where it cannot be missed but never inside the transcript.
        room && (room.notice ?? '').trim()
          ? h('div', { className: 'rt-notice' },
              h('span', { className: 'rt-notice-tag' }, '公告'),
              h('span', { className: 'rt-notice-text', title: room.notice }, room.notice.trim()),
            )
          : null,
            // 置顶: a standing reminder above the transcript. Each row jumps to its
            // message; the close button unpins without opening anything else.
            pinnedMsgs.length > 0
              ? h('div', { className: 'rt-pins' },
                  pinnedMsgs.map((pm) => h('div', { key: pm.id, className: 'rt-pin' },
                    h('button', {
                      className: 'rt-pin-main',
                      title: '跳到这条',
                      onClick: () => jumpToMessage(pm.id),
                    },
                      h(Icon, { name: 'pin', size: 11 }),
                      h('span', { className: 'rt-pin-text' }, previewOf(pm)),
                    ),
                    h('button', {
                      className: 'rt-pin-x',
                      title: '取消置顶',
                      onClick: () => pinMessage(pm.id),
                    }, h(Icon, { name: 'close', size: 10 })),
                  )),
                )
              : null,
        h('div', { className: 'rt-stream', ref: streamRef, onScroll }, streamBody),
        composer,
      ),
      modal?.kind === 'addModel' && room ? h(ModelPicker, {
        catalog,
        taken: room.members,
        onClose: () => setModal(null),
        onAdd: (picks) => {
          // Handles are derived one at a time against the room's growing set,
          // so two models with the same tail ("x/flash" and "y/flash") get
          // distinct handles instead of overwriting each other.
          updateRoom(room.id, (r) => {
            const members = [...r.members]
            for (const pick of picks) {
              if (members.length >= MAX_MEMBERS) break
              members.push(makeMember(pick, { ...r, members }))
            }
            return { ...r, members }
          })
          setModal(null)
        },
      }) : null,
      modal?.kind === 'members' && room ? h(MembersModal, {
        room,
        onClose: () => setModal(null),
        onChange: (nextRoom) => updateRoom(room.id, () => nextRoom),
        onClear: () => { updateRoom(room.id, (r) => ({ ...r, messages: [] })); setModal(null) },
      }) : null,
      modal?.kind === 'room' ? h(RoomModal, {
        room: rooms.find((r) => r.id === modal.id),
        profile,
        // Exports the room currently open in the dialog, not the active one.
        onExport: () => {
          const target = rooms.find((r) => r.id === modal.id)
          if (target && !downloadTranscript(target, profile)) setHint('导出失败')
        },
        onClose: () => setModal(null),
        onSave: (next) => {
          updateRoom(modal.id, (r) => ({
            ...r,
            name: next.name,
            autoReply: next.autoReply,
            notice: next.notice ?? '',
          }))
          setModal(null)
        },
        onDelete: () => {
          const rest = state.rooms.filter((r) => r.id !== modal.id)
          // Deleting the active room moves the user elsewhere, so the composer
          // resets with it.
          if (modal.id === state.activeId) {
            setInput('')
            setQuote(null)
            setPop(null)
            setEmojiOpen(false)
            setVisibleCount(MESSAGE_PAGE)
            setHint('')
          }
          commit({ rooms: rest, activeId: rest[0]?.id ?? null })
          setModal(null)
        },
      }) : null,
      modal?.kind === 'packet' && room ? h(PacketModal, {
        room,
        onClose: () => setModal(null),
        onSend: (opts) => {
          sendPacket(room, opts)
          setModal(null)
        },
      }) : null,
      modal?.kind === 'search' && room ? h(SearchModal, {
        room,
        profile,
        onClose: () => setModal(null),
        onJump: jumpToMessage,
      }) : null,
      modal?.kind === 'shop' && room ? h(ShopModal, {
        room,
        onClose: () => setModal(null),
      }) : null,
      modal?.kind === 'vote' && room ? h(VoteModal, {
        onClose: () => setModal(null),
        onCreate: (q, options) => {
          updateRoom(room.id, (r) => ({
            ...r,
            messages: [...r.messages, {
              id: uid('msg'),
              role: 'vote',
              senderName: profile?.name ?? '你',
              text: q,
              options,
              ballots: [],
              closed: false,
              ts: Date.now(),
            }],
          }))
          setModal(null)
          scrollDown()
        },
      }) : null,
      modal?.kind === 'chain' && room ? h(ChainModal, {
        onClose: () => setModal(null),
        onCreate: (q) => {
          updateRoom(room.id, (r) => ({
            ...r,
            messages: [...r.messages, {
              id: uid('msg'),
              role: 'chain',
              senderName: profile?.name ?? '你',
              text: q,
              entries: [],
              ts: Date.now(),
            }],
          }))
          setModal(null)
          scrollDown()
        },
      }) : null,
      modal?.kind === 'profile' ? h(ProfileModal, {
        profile,
        theme,
        // The room is passed in so 聊天 can edit it directly — a settings page
        // that only points elsewhere is a dead end.
        room,
        onClose: () => {
          // Cancelling must undo the live preview, or the panel would keep a
          // theme the user never saved.
          setThemeState(theme)
          setModal(null)
        },
        onSave: (next) => {
          saveProfile(next.profile)
          saveTheme(next.theme)
          // Chat settings write to the room itself, so the dialog is the only
          // place the user needs to go.
          if (room && next.room) {
            updateRoom(room.id, (r) => ({
              ...r,
              autoReply: next.room.autoReply,
              notice: next.room.notice,
            }))
          }
          setModal(null)
        },
      }) : null,
    )
  }

  // ── modals ───────────────────────────────────────────────────────────────

  function MembersModal({ room, onClose, onChange, onClear, onEffortsChanged }) {
    const setMembers = (mems) => onChange({ ...room, members: mems })

    // Reasoning levels per member, fetched on demand.
    //
    // Not part of the catalog: `listModels()` only reports id and name, while
    // the effort list comes from `resolveModelInfo`. Loading all of them up front
    // would be one round trip per model, so each row asks when it is expanded.
    const [efforts, setEfforts] = React.useState({})
    const [effortsOpen, setEffortsOpen] = React.useState(null)

    const loadEfforts = (m) => {
      const key = m.provider + '|' + m.model
      if (efforts[key]) return
      setEfforts((prev) => ({ ...prev, [key]: { loading: true } }))

      // Diagnostic detail matters here: "未知路由 /efforts" is what the Host
      // says when a *stale* Host module is running — the route only exists in the
      // current source. Including the response status and any Host message makes
      // that distinguishable from a genuinely wrong path.
      const url = '/api/roundtable/efforts'
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: m.provider, model: m.model }),
      })
        .then(async (r) => {
          const text = await r.text()
          let j = null
          try { j = JSON.parse(text) } catch { /* non-JSON body */ }
          if (!j) {
            throw new Error('HTTP ' + r.status + '：' + text.slice(0, 120))
          }
          return j
        })
        .then((j) => setEfforts((prev) => ({
          ...prev,
          [key]: {
            loading: false,
            list: Array.isArray(j.efforts) ? j.efforts : [],
            error: j.error ?? (j.ok === false ? '读取失败' : null),
          },
        })))
        .catch((e) => setEfforts((prev) => ({
          ...prev,
          [key]: { loading: false, list: [], error: String(e && e.message) },
        })))
    }

    const chooseEffort = (m, id) => {
      setMembers(room.members.map((x) => (x.id === m.id
        ? { ...x, reasoningEffort: id === '__default' ? undefined : id }
        : x)))
    }

    // Highest score first: the leaderboard is the whole point of the points,
    // so it is rendered in rank order rather than in the order models were added.
    const ranked = [...room.members].sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
    const hasPoints = ranked.some((m) => (m.points ?? 0) > 0)

    return h(Modal, {
      title: '成员 · ' + room.name,
      onClose,
      footer: [
        h('button', { key: 'cl', className: 'rt-btn danger', onClick: onClear }, '清空对话'),
        h('button', { key: 'd', className: 'rt-btn primary', onClick: onClose }, '完成'),
      ],
    },
      hasPoints ? h('div', { className: 'rt-rank' },
        h('div', { className: 'rt-rank-title' }, '积分榜'),
        ranked.map((m, i) => h('div', { key: m.id, className: 'rt-rank-row' },
          h('span', { className: 'rt-rank-no' }, String(i + 1)),
          h(Avatar, { member: m, size: 20 }),
          h('span', { className: 'rt-rank-name' }, m.displayName),
          h('span', { className: 'rt-rank-pts' }, String(m.points ?? 0)),
        )),
      ) : null,
      room.members.length === 0
        ? h('div', { className: 'rt-hint2' }, '还没有模型。用右上角「+ 模型」添加。')
        : room.members.map((m) => {
            const key = m.provider + '|' + m.model
            const info = efforts[key]
            const open = effortsOpen === m.id
            const current = m.reasoningEffort
            return h('div', {
              key: m.id,
              className: 'rt-row',
              style: { flexDirection: 'column', alignItems: 'stretch', ...(m.enabled === false ? { opacity: .42 } : {}) },
            },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 11 } },
                h(Avatar, { member: m, size: 32 }),
                h('div', { className: 'rt-row-main' },
                  h('div', { className: 'rt-row-name' },
                    m.displayName,
                    m.rank ? h('span', { className: 'rt-row-rank' }, m.rank) : null,
                    // Where they are beats what they own: an absent model is the
                    // thing the user needs to know before wondering why it is quiet.
                    isAway(m) ? h('span', { className: 'rt-row-away' },
                      h(Icon, { name: m.away.icon ?? 'tool', size: 12 }),
                      ' ' + (m.away.label ?? '外出'),
                      ' · ' + awayMinutes(m) + ' 分钟后回来') : null,
                    ((m.points ?? 0) > 0 || (m.gold ?? 0) > 0)
                      ? h('span', { className: 'rt-row-money' },
                          (m.points ?? 0) > 0 ? (m.points + ' 分') : '',
                          (m.points ?? 0) > 0 && (m.gold ?? 0) > 0 ? ' · ' : '',
                          (m.gold ?? 0) > 0 ? (m.gold + ' 金') : '')
                      : null,
                  ),
                  h('div', { className: 'rt-row-sub' },
                    '提示词里用 @' + m.handle,
                    current ? '  ·  思考：' + current : '  ·  思考：默认'),
                ),
                h('button', {
                  className: 'rt-btn',
                  title: '思考档位',
                  onClick: () => {
                    setEffortsOpen(open ? null : m.id)
                    if (!open) loadEfforts(m)
                  },
                }, '思考'),
                h('button', {
                  className: 'rt-btn',
                  title: m.enabled === false ? '启用' : '停用',
                  onClick: () => setMembers(room.members.map((x) =>
                    x.id === m.id ? { ...x, enabled: x.enabled === false } : x)),
                }, m.enabled === false ? '启用' : '停用'),
                h('button', {
                  className: 'rt-btn danger',
                  onClick: () => setMembers(room.members.filter((x) => x.id !== m.id)),
                }, '移除'),
              ),
              open ? h('div', { className: 'rt-efforts' },
                info?.loading
                  ? h('div', { className: 'rt-hint2' }, '正在读取这个模型支持的思考档位…')
                  : null,
                info?.error
                  ? h('div', { className: 'rt-hint2', style: { color: '#ff9d94' } },
                      '读不到档位：' + info.error)
                  : null,
                !info?.loading && info && info.list && info.list.length === 0 && !info.error
                  ? h('div', { className: 'rt-hint2' },
                      '这个模型没有提供思考档位，只能按它的默认方式思考，改不了。')
                  : null,
                info?.list && info.list.length > 0
                  ? h('div', { className: 'rt-effort-list' },
                      // `__default` is not a real effort: it means "do not send
                      // the parameter at all", which lets the adapter pick.
                      h('button', {
                        className: 'rt-effort' + (current ? '' : ' on'),
                        onClick: () => chooseEffort(m, '__default'),
                      }, '默认'),
                      info.list.map((e) => h('button', {
                        key: e.id,
                        className: 'rt-effort' + (current === e.id ? ' on' : ''),
                        title: e.description ?? e.name,
                        onClick: () => chooseEffort(m, e.id),
                      }, e.name)),
                    )
                  : null,
              ) : null,
            )
          }),
    )
  }

  /** Auto-reply choices, in the order the radio list shows them. */
  const AUTO_MODES = [
    { id: 'first', label: '首位模型回答', hint: '群里第一个加进来的模型接话。一轮只花一次调用。' },
    { id: 'all', label: '全部模型都回答', hint: '每个模型轮流说一句。热闹，但一轮要 N 次调用。' },
    { id: 'eager', label: '自由插嘴', hint: '先问每个模型「你想说吗」，只有想说的才回。像真的群聊，但每个模型多花一次轻量调用。' },
    { id: 'off', label: '必须 @ 才回答', hint: '不打 @ 就没人理你。最省额度，也最像工具。' },
  ]

  /** Compose a red packet: amount, note, and how many may grab it. */
  /**
   * Compose a vote: a question plus two or more options.
   *
   * Options are edited as one line per entry rather than as separate inputs —
   * pasting a list in is how people actually write one.
   */
  function VoteModal({ onClose, onCreate }) {
    const [q, setQ] = React.useState('')
    const [opts, setOpts] = React.useState('')
    const options = opts.split('\n').map((s) => s.trim()).filter(Boolean)
    const ok = q.trim() !== '' && options.length >= 2

    return h(Modal, {
      title: '发起投票',
      onClose,
      footer: [
        h('button', { key: 'c', className: 'rt-btn', onClick: onClose }, '取消'),
        h('button', {
          key: 'ok',
          className: 'rt-btn primary',
          disabled: !ok,
          style: ok ? undefined : { opacity: .45, cursor: 'not-allowed' },
          onClick: () => { if (ok) onCreate(q.trim(), options) },
        }, '发起'),
      ],
    },
      h('div', { className: 'rt-field' },
        h('label', null, '问题'),
        h('input', { type: 'text', value: q, placeholder: '要不要今晚加班？', onChange: (e) => setQ(e.target.value) }),
      ),
      h('div', { className: 'rt-field' },
        h('label', null, '选项（一行一个，至少两个）'),
        h('textarea', {
          className: 'rt-notice-input',
          rows: 4,
          value: opts,
          placeholder: '要\n不要\n随便',
          onChange: (e) => setOpts(e.target.value),
        }),
        h('div', { className: 'rt-hint2' }, '现在识别到 ' + options.length + ' 个选项。'),
      ),
    )
  }

  /** Compose a 接龙: just a title; people append themselves. */
  function ChainModal({ onClose, onCreate }) {
    const [q, setQ] = React.useState('')
    const ok = q.trim() !== ''
    return h(Modal, {
      title: '发起接龙',
      onClose,
      footer: [
        h('button', { key: 'c', className: 'rt-btn', onClick: onClose }, '取消'),
        h('button', {
          key: 'ok',
          className: 'rt-btn primary',
          disabled: !ok,
          style: ok ? undefined : { opacity: .45, cursor: 'not-allowed' },
          onClick: () => { if (ok) onCreate(q.trim()) },
        }, '发起'),
      ],
    },
      h('div', { className: 'rt-field' },
        h('label', null, '接龙什么'),
        h('input', { type: 'text', value: q, placeholder: '周末谁有空', onChange: (e) => setQ(e.target.value) }),
        h('div', { className: 'rt-hint2' }, '发出去以后，点「+ 我要接」就能加一行。'),
      ),
    )
  }

  /**
   * The shop window — read-only, on purpose.
   *
   * Buying belongs to the models: they spend their own points by writing a
   * directive in chat, which is what makes this their economy rather than a
   * control panel. This dialog exists so a person can see what is on offer and
   * what each model has accumulated, without being able to spend on their behalf.
   */
  /**
   * Your own settings.
   *
   * Only what is actually observable is offered. A name and an avatar colour are
   * the two things that show up in the transcript and in the rail, so those are
   * the two that can be changed; adding fields that nothing renders would be
   * worse than fewer options.
   */
/**
   * Settings, laid out like the Windows 11 settings app.
   *
   * A modal with a vertical list does not survive growth: every new option makes
   * it longer, and the user has to scroll past everything to find one thing. The
   * W11 shape — categories down the left, the chosen category's content on the
   * right — keeps each page short no matter how many pages exist.
   *
   * Adding a section later means adding one entry to SETTINGS_SECTIONS and one
   * case in the renderer below. Nothing else in this dialog changes.
   */
  /**
   * Icons for the settings categories.
   *
   * Drawn, not typed. An emoji renders differently on every platform — its
   * colour, weight and baseline are decided by the font, so it can never sit
   * evenly next to a 12.5px label. A stroked path at a fixed 16-unit box stays
   * consistent and inherits `currentColor`, which means the selected state
   * recolours it for free.
   */
/**
   * Icons for the settings categories.
   *
   * Drawn, not typed. An emoji renders differently on every platform — its
   * colour, weight and baseline are decided by the font, so it can never sit
   * evenly next to a 12.5px label. A stroked path at a fixed 24-unit box stays
   * consistent and inherits `currentColor`.
   */
/**
   * The icon set.
   *
   * Everything in the interface that used to be an emoji lives here as a stroked
   * path. The reason is not aesthetic: an emoji's colour, weight and baseline are
   * decided by the platform font, so the same glyph is a different size on every
   * machine, cannot inherit `currentColor`, and shifts the line box it sits in.
   * A fixed 24-unit viewBox with `stroke: currentColor` avoids all three.
   *
   * The emoji *picker* still offers emoji — those are message content, not
   * interface chrome, and replacing them would change what the user is sending.
   *
   * Paths are drawn on a 24×24 grid at ~1.6 stroke, sized by `size`.
   */
  const ICONS = {
    // ── interface ──
    close: 'M6 6 L18 18 M18 6 L6 18',
    check: 'M5 12.5 L9.5 17 L19 7',
    warn: 'M12 4 L21.5 20 H2.5 Z M12 10 V14 M12 17 V17.2',
    minus: 'M5 12 H19',
    plus: 'M12 5 V19 M5 12 H19',
    search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z M15.5 15.5 L20.5 20.5',
    image: 'M4 5h16v14H4Z M4 15l4.5-4.5 3.5 3.5 3-3L20 16 M9 9.5a1.2 1.2 0 1 1 0 .1',
    pin: 'M12 3.5v10 M8 9.5h8l-3.5 4h-1Z M6 20.5h12',

    // ── toolbar ──
    // 表情: a smile in a circle.
    face: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z M8.5 14c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8 M9 9.5v.2 M15 9.5v.2',
    // 红包: an envelope with a coin slot.
    packet: 'M4 6.5h16v11H4z M4 6.5l8 6 8-6 M12 12.5v3',
    // 商店: an awning over a counter.
    shop: 'M4 9.5V20h16V9.5 M3 9.5h18l-1.5-4.5H4.5Z M9 20v-5h6v5',
    // 投票: bars of different heights.
    vote: 'M4 20V12 M9.5 20V6 M15 20v-5 M20.5 20V9',
    // 接龙: a numbered list.
    chain: 'M8 6.5h12 M8 12h12 M8 17.5h12 M3.5 6.5h.2 M3.5 12h.2 M3.5 17.5h.2',
    // 提示: a bulb.
    bulb: 'M9 17h6 M10 20h4 M12 3.5a5.5 5.5 0 0 0-3 10.1V17h6v-3.4a5.5 5.5 0 0 0-3-10.1Z',
    // 刷新.
    refresh: 'M20 12a8 8 0 1 1-2.6-5.9 M20 4v4.5h-4.5',

    // ── goods: drink ──
    cup: 'M6.5 8h11l-1 12H7.5Z M6.5 8h11 M9 8l.4 12 M12 8v12 M15 8l-.4 12',
    // 咖啡杯 with a handle.
    mug: 'M4.5 9h11.5v8.5H4.5Z M16 10.5h1.6a2.2 2.2 0 0 1 0 4.4H16 M8 5.5c0 1 1.2 1 1.2 2 M12 5.5c0 1 1.2 1 1.2 2',
    // 奶茶: a cup with a lid and straw.
    boba: 'M6.5 9h11l-.9 10.5H7.4Z M6 9h12 M13.5 9V4 M11.5 4h4 M8 12.5h.2 M10 14.5h.2 M13.5 13h.2 M15.5 15h.2',
    // 水滴.
    drop: 'M12 3.5s6 6.6 6 10.4a6 6 0 0 1-12 0C6 10.1 12 3.5 12 3.5Z',
    // 罐/瓶.
    beer: 'M7 8h9v11H7Z M16 11h2.5v4H16 M9.5 5h4v3h-4Z M9.5 11v5 M12.5 11v5',
    // 果汁盒.
    juice: 'M7 8h9l1.5 11H5.5Z M8.5 8V4.5h6V8 M8.5 12h6',

    // ── goods: food ──
    bread: 'M4 11a3 3 0 0 1 3-3h10a3 3 0 0 1 0 6v4H7v-4a3 3 0 0 1-3-3Z',
    bowl: 'M3.5 11h17a8.5 8.5 0 0 1-17 0Z M7 7.5c0-1 .8-2 2-2 M13 7.5c0-1 .8-2 2-2',
    cake: 'M4.5 20h15V13h-15Z M4.5 15.5h15 M4.5 17.5h15 M4.5 13c1.4 0 1.4-1.6 2.8-1.6s1.4 1.6 2.8 1.6 1.4-1.6 2.8-1.6 1.4 1.6 2.8 1.6 1.4-1.6 2.8-1.6 1.4 1.6 2.8 1.6 M12 9.5V7.5 M10.8 7.5c0-1.6 2.4-1.6 2.4 0',
    pot: 'M4 10h16v5a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4Z M2.5 12h1.5 M20 12h1.5 M9 6.5c0-1 .8-2 2-2 M14 6.5c0-1 .8-2 2-2',

    // ── goods: furniture ──
    chair: 'M7 4h10v9H7Z M7 13v5 M17 13v5 M7 16h10',
    desk: 'M3 9h18 M4.5 9v10 M19.5 9v10 M8 9v5h8V9',
    shelf: 'M4 4h16v16H4Z M4 9.5h16 M4 15h16 M8 6.5h.2 M8 12h.2',
    sofa: 'M4 12V8a2 2 0 0 1 4 0v4h8V8a2 2 0 0 1 4 0v4 M3 12h18v5H3Z M5 17v3 M19 17v3',
    bed: 'M3 18v-9 M3 13h18v5 M21 18v-4 M6.5 10.5h4V13h-4Z',

    // ── goods: appliance ──
    lamp: 'M12 3.5 6 12h12Z M12 12v7 M8.5 20.5h7',
    fan: 'M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z M12 9.5c0-4 2-5.5 3.5-4.5S17 9 12 9.5 M12 14.5c0 4-2 5.5-3.5 4.5S7 15 12 14.5',
    speaker: 'M5 9h4l5-3.5v13L9 15H5Z M17.5 9.5a3.5 3.5 0 0 1 0 5',
    flame: 'M12 3.5c3.5 4 5.5 6.5 5.5 9.5a5.5 5.5 0 0 1-11 0c0-1.6.6-3 1.8-4.4 .8 1.4 1.7 2 2.7 1.8-.6-2.4-.4-4.6 1-6.9Z',
    fridge: 'M6 3.5h12v17H6Z M6 10h12 M9 6.5v1.5 M9 12.5v2',

    // ── goods: decor ──
    clock: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z M12 8v4.5l3 1.8',
    plant: 'M12 20v-6 M12 14c0-3 2-5 5-5-.4 3-2.2 5-5 5Z M12 14c0-2.6-1.8-4.5-4.5-4.5.4 2.6 2 4.5 4.5 4.5Z M8 20h8',
    frame: 'M4 5h16v14H4Z M4 9h16 M7.5 13l2.5 3 3-4 3.5 4.5',
    rug: 'M4 6h16v12H4Z M7 9h10v6H7Z M4 6l3 3 M20 6l-3 3 M4 18l3-3 M20 18l-3-3',
    fish: 'M4 12c3-4 7-5.5 11-3.5 1.6.8 2.6 2 3.5 3.5-.9 1.5-1.9 2.7-3.5 3.5-4 2-8 .5-11-3.5Z M15 10.2v.2 M18.5 6.5 20 5',

    // ── goods: 应援 ──
    clap: 'M8 13.5 5.5 11a1.6 1.6 0 0 1 2.3-2.3l2 2 M9.8 10.7 7.2 8.1a1.6 1.6 0 0 1 2.3-2.3l2.6 2.6 M12.1 8.4 10.4 6.7a1.6 1.6 0 0 1 2.3-2.3l3.4 3.4a6.5 6.5 0 0 1 1.6 6.4l-.8 2.6a5 5 0 0 1-9.3.6L5 13.5',
    bouquet: 'M12 20v-6 M9.5 9.5a2.5 2.5 0 1 1 5 0 2.5 2.5 0 0 1-5 0Z M7 12.5a2.5 2.5 0 1 1 5 0 M14.5 13.5a2.5 2.5 0 1 1-5 0 M5 20h14',
    banner: 'M4 5h16 M5.5 5v13l2.6-1.6L10.7 18l1.3-1.6L13.3 18l2.6-1.6L18.5 18V5',
    firework: 'M12 12 12 3 M12 12 19.5 16 M12 12 4.5 16 M12 12 20 5 M12 12 4 5 M12 12v9 M12 12 17.5 19.5 M12 12 6.5 19.5 M12 12h9 M12 12H3',

    // ── 金币 goods ──
    medal: 'M12 14a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z M9.5 13.5 8 21l4-2 4 2-1.5-7.5',
    scroll: 'M6 5h12v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2Z M9 9h6 M9 12.5h6 M9 16h4',
    crown: 'M4 18h16 M4.5 18 3 7l5.5 4L12 5l3.5 6L21 7l-1.5 11Z',
    statue: 'M9 20h6 M12 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z M8.5 20v-3l-1-5 2-2h5l2 2-1 5v3',
    balloon: 'M12 3.5a5 5 0 0 1 5 5c0 3-2.4 5.5-5 5.5S7 11.5 7 8.5a5 5 0 0 1 5-5Z M12 14v3 M10.5 20.5 12 17l1.5 3.5Z',
    plate: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16Z M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z M3 12h1 M20 12h1',
    sparkler: 'M12 20V12 M12 12c-2.5-1-3.5-3-3-6 2.5 1 3.5 3 3 6Z M12 12c2.5-1 3.5-3 3-6-2.5 1-3.5 3-3 6Z M9 20h6',
    stage: 'M4 20V9l8-4.5 8 4.5v11 M8 20v-6h8v6 M9 5.5V3 M15 5.5V3',
    giftbox: 'M3.5 9.5h17V20H3.5Z M3.5 9.5V12h17V9.5 M12 9.5V20 M12 9.5C10 9.5 7.5 8.6 7.5 6.5a2 2 0 0 1 4.5 0 M12 9.5c2 0 4.5-.9 4.5-3a2 2 0 0 0-4.5 0',

    // ── activities ──
    tool: 'M14.5 6.5a3.5 3.5 0 1 1 3 3l-8 8-3-3 8-8Z M6.5 15.5 4 18l2 2 2.5-2.5',
    bag: 'M5 8h14l-1 12H6Z M9 8V6a3 3 0 0 1 6 0v2',
    luggage: 'M6 8h12v12H6Z M9 8V4.5h6V8 M9.5 12v4 M14.5 12v4',
  }

  /**
   * Render one icon.
   *
   * Single-path icons use `d`; a few need several sub-paths, which the same
   * string expresses with additional `M` commands, so one `<path>` covers all of
   * them and the whole set stays data.
   */
  function Icon({ name, size, className, style }) {
    const d = ICONS[name]
    if (!d) return null
    const s = size ?? 16
    return h('svg', {
      width: s, height: s, viewBox: '0 0 24 24',
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
      strokeLinecap: 'round', strokeLinejoin: 'round',
      className, style: { display: 'block', flex: '0 0 auto', ...(style ?? {}) },
      'aria-hidden': 'true',
    }, h('path', { d }))
  }
  /**
   * Icons for the settings categories.
   *
   * Drawn, not typed. An emoji's colour, weight and baseline belong to the
   * platform font, so it can never sit evenly beside a 12.5px label — and it
   * ignores the row's colour, which the selected state relies on.
   */
  function SettingsGlyph({ name, size }) {
    const s = size ?? 15
    const common = {
      width: s, height: s, viewBox: '0 0 24 24',
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
      strokeLinecap: 'round', strokeLinejoin: 'round',
      style: { display: 'block' },
    }
    if (name === 'account') {
      if (name === 'about') {
        return h('svg', common,
          h('circle', { cx: 12, cy: 12, r: 8.2 }),
          h('path', { d: 'M12 11v5.4' }),
          h('path', { d: 'M12 7.6v.2' }),
        )
      }
      return h('svg', common,
        h('circle', { cx: 12, cy: 8.2, r: 3.9 }),
        h('path', { d: 'M4.6 20.2c0-3.6 3.3-5.6 7.4-5.6s7.4 2 7.4 5.6' }),
      )
    }
    if (name === 'appearance') {
      return h('svg', common,
        h('circle', { cx: 12, cy: 12, r: 7.4 }),
        h('path', { d: 'M12 4.6a7.4 7.4 0 0 1 0 14.8z', fill: 'currentColor', stroke: 'none', opacity: 0.5 }),
      )
    }
    return h('svg', common,
      h('path', { d: 'M20.4 12.4c0 3.6-3.8 6.5-8.4 6.5-1 0-2-.1-2.9-.4L4.6 20l1.2-3.3c-1-1.2-1.6-2.6-1.6-4.3 0-3.6 3.8-6.5 8.4-6.5s7.8 2.9 7.8 6.5z' }),
    )
  }

  const SETTINGS_SECTIONS = [
    { id: 'account', label: '资料' },
    { id: 'appearance', label: '外观' },
    { id: 'chat', label: '聊天' },
    { id: 'about', label: '关于' },
  ]

  const AUTO_REPLY_CHOICES = [
    { id: 'first', label: '首位模型' },
    { id: 'all', label: '全部回答' },
    { id: 'eager', label: '自由插嘴' },
    { id: 'off', label: '必须 @' },
  ]

  /**
   * Search the transcript.
   *
   * A long room becomes unsearchable by eye, and the layered history means older
   * messages are not even in a model's context any more — searching the local
   * transcript is the only way to find what was said an hour ago.
   *
   * Results are newest-first and capped: three hundred rows are not more useful
   * than the last fifty.
   */
  function SearchModal({ room, profile, onClose, onJump }) {
    const [q, setQ] = React.useState('')
    const inputRef = React.useRef(null)
    const members = room?.members ?? []
    const all = room?.messages ?? []
    const needle = q.trim().toLowerCase()

    React.useEffect(() => {
      if (inputRef.current) inputRef.current.focus()
    }, [])

    // Every message kind is searchable, system lines included — "who bought
    // what" is answered by those, not by the chat.
    const textOfMsg = (m) => {
      if (m.role === 'packet') {
        return (m.note || '') + ' ' + (m.grabs ?? []).map((g) => g.points + '分').join(' ')
      }
      if (m.role === 'vote') return String(m.text ?? '') + ' ' + (m.options ?? []).join(' ')
      if (m.role === 'chain') {
        return String(m.text ?? '') + ' ' + (m.entries ?? []).map((e) => e.text).join(' ')
      }
      return String(m.text ?? '')
    }

    const who = (m) => {
      if (m.role === 'ai') return members.find((x) => x.id === m.memberId)?.displayName ?? '已移除'
      if (m.role === 'sys') return '系统'
      return m.senderName ?? profile?.name ?? '你'
    }

    const results = needle === ''
      ? []
      : all
          .filter((m) => textOfMsg(m).toLowerCase().includes(needle))
          .slice(-60)
          .reverse()

    // Show the matched term in context rather than the head of the message.
    const snippet = (text) => {
      const i = text.toLowerCase().indexOf(needle)
      if (i < 0) return text.slice(0, 120)
      const from = Math.max(0, i - 30)
      return (from > 0 ? '…' : '') + text.slice(from, from + 120)
    }

    return h(Modal, {
      title: '搜索 · ' + (room?.name ?? ''),
      onClose,
      footer: [h('button', { key: 'd', className: 'rt-btn primary', onClick: onClose }, '关闭')],
    },
      h('div', { className: 'rt-search-bar' },
        h(Icon, { name: 'search', size: 15, style: { opacity: .5 } }),
        h('input', {
          ref: inputRef,
          className: 'rt-set-input rt-search-input',
          type: 'text',
          value: q,
          placeholder: '搜聊天记录…',
          onChange: (e) => setQ(e.target.value),
        }),
      ),
      h('div', { className: 'rt-search-meta' },
        needle === ''
          ? '共 ' + all.length + ' 条记录'
          : results.length === 0
            ? '没有找到「' + q.trim() + '」'
            : '找到 ' + results.length + ' 条' + (results.length >= 60 ? '，只显示最近 60 条' : ''),
      ),
      needle !== '' && results.length > 0
        ? h('div', { className: 'rt-search-results' },
            results.map((m) => h('button', {
              key: m.id,
              className: 'rt-search-hit',
              onClick: () => { onJump(m.id); onClose() },
              title: '跳到这条消息',
            },
              h('span', { className: 'rt-search-who' }, who(m)),
              h('span', { className: 'rt-search-text' }, snippet(textOfMsg(m))),
              h('span', { className: 'rt-search-time' }, fmtTime(m.ts)),
            )),
          )
        : null,
    )
  }
  /**
   * Settings.
   *
   * Three fixes over the first attempt, each from a concrete complaint:
   *
   *   1. One line per category. A greyed subtitle under every entry is noise.
   *   2. 聊天 is editable. A page that only says "change this elsewhere" is a
   *      dead end; the reason to open settings is to change something.
   *   3. Anything not saved is not applied. Appearance previews live, but the
   *      room settings stay drafts until 保存.
   */
  function ProfileModal({ profile, theme, room, onSave, onClose }) {
    const [section, setSection] = React.useState('account')
    const [name, setName] = React.useState(profile?.name ?? '我')
    const [color, setColor] = React.useState(profile?.color ?? null)
    const [skin, setSkin] = React.useState(theme?.skin === 'flat' ? 'flat' : 'glass')
    const [mode, setMode] = React.useState(theme?.mode === 'light' ? 'light' : 'dark')
    const [autoReply, setAutoReply] = React.useState(room?.autoReply ?? 'first')
    const [notice, setNotice] = React.useState(room?.notice ?? '')

    React.useEffect(() => { setThemeState({ skin, mode }) }, [skin, mode])

    const swatches = [
      null, '#6f9fd0', '#c98b5e', '#7fae7a', '#b07fb8',
      '#c4a35a', '#6fbfb4', '#c47a7a', '#8f95b8',
    ]
    const preview = { name: name.trim() || '我', color }

    const SKINS = [
      { id: 'glass', label: '玻璃' },
      { id: 'flat', label: '极简' },
    ]
    const MODES = [
      { id: 'dark', label: '深色' },
      { id: 'light', label: '浅色' },
    ]

    const group = (title, kids) => h('div', { className: 'rt-set-group' },
      title ? h('div', { className: 'rt-set-group-title' }, title) : null,
      h('div', { className: 'rt-set-card' }, kids),
    )

    const row = (label, control, hint) => h('div', { className: 'rt-set-row' },
      h('div', { className: 'rt-set-row-main' },
        h('div', { className: 'rt-set-row-label' }, label),
        hint ? h('div', { className: 'rt-set-row-hint' }, hint) : null,
      ),
      h('div', { className: 'rt-set-row-ctl' }, control),
    )

    const previewBox = (id) => h('span', { className: 'rt-set-pv ' + id },
      h('span', { className: 'rt-pv-bar' }),
      h('span', { className: 'rt-pv-body' }),
    )

    let body = null

    if (section === 'account') {
      body = h(React.Fragment, null,
        h('div', { className: 'rt-set-hero' },
          h(UserAvatar, { profile: preview, size: 56 }),
          h('input', {
            className: 'rt-set-input rt-set-input-lg',
            type: 'text',
            value: name,
            placeholder: '我',
            onChange: (e) => setName(e.target.value),
          }),
        ),
        group('头像颜色',
          h('div', { className: 'rt-swatches rt-set-pad' },
            swatches.map((c, i) => h('button', {
              key: i,
              className: 'rt-swatch' + ((color ?? null) === c ? ' on' : ''),
              style: { background: c ?? 'linear-gradient(150deg, hsl(280 40% 45%), hsl(320 35% 32%))' },
              title: c ? c : '自动',
              onClick: () => setColor(c),
            })),
          ),
        ),
      )
    }

    if (section === 'appearance') {
      body = h(React.Fragment, null,
        group('界面风格',
          SKINS.map((s) => h('button', {
            key: s.id,
            className: 'rt-set-pick' + (skin === s.id ? ' on' : ''),
            onClick: () => setSkin(s.id),
          },
            previewBox(s.id),
            h('span', { className: 'rt-set-pick-label' }, s.label),
            h('span', { className: 'rt-set-pick-check' }, skin === s.id ? h(Icon, { name: 'check', size: 14 }) : null),
          )),
        ),
        group('深色 / 浅色',
          MODES.map((m) => h('button', {
            key: m.id,
            className: 'rt-set-pick' + (mode === m.id ? ' on' : ''),
            onClick: () => setMode(m.id),
          },
            previewBox(m.id),
            h('span', { className: 'rt-set-pick-label' }, m.label),
            h('span', { className: 'rt-set-pick-check' }, mode === m.id ? h(Icon, { name: 'check', size: 14 }) : null),
          )),
        ),
      )
    }

    if (section === 'chat') {
      body = h(React.Fragment, null,
        group('不打 @ 时谁回答',
          AUTO_REPLY_CHOICES.map((c) => h('button', {
            key: c.id,
            className: 'rt-set-option' + (autoReply === c.id ? ' on' : ''),
            onClick: () => setAutoReply(c.id),
          },
            h('span', { className: 'rt-set-radio' }, autoReply === c.id ? h('span', null) : null),
            h('span', { className: 'rt-set-option-label' }, c.label),
          )),
        ),
        group('群公告',
          h('div', { className: 'rt-set-pad' },
            h('textarea', {
              className: 'rt-set-input',
              rows: 3,
              value: notice,
              placeholder: '比如：以后都叫我老板。留空就是不设公告。',
              onChange: (e) => setNotice(e.target.value),
            }),
          ),
        ),
      )
    }

    if (section === 'about') {
      const FEATURES = [
        ['多模型群聊', '成员就是模型本身，没有角色包装。谁说的就是谁说的。'],
        ['@ 点名 / 自由插嘴', '可以点一位回答，也可以让想说的模型自己接话。'],
        ['引用 / 投票 / 接龙 / 红包', '群里该有的都有，模型也能投票和接龙。'],
        ['积分与商店', '模型攒积分买吃的、家具、应援，还有金币货架。'],
        ['图片', '可以发图。不支持视觉的模型会直接说自己看不见。'],
        ['聊天记录搜索', '能搜正文、红包附言、投票选项、接龙内容。'],
      ]
      const KEYS = [
        ['Enter', '发送'],
        ['Shift + Enter', '换行'],
        ['Esc', '关掉弹窗、收起 @ 提示'],
        ['Ctrl / ⌘ + K', '跳到输入框'],
        ['Ctrl / ⌘ + F', '搜索聊天记录'],
      ]
      return h(React.Fragment, null,
        h('div', { className: 'rt-about-hero' },
          h('div', { className: 'rt-about-mark' }, h(RoundtableIcon, null)),
          h('div', { className: 'rt-about-title' }, '圆桌'),
          h('div', { className: 'rt-about-ver' }, 'v' + VERSION),
          h('div', { className: 'rt-about-by' }, 'Made by ', h('b', null, AUTHOR)),
        ),
        group('这是什么',
          h('div', { className: 'rt-set-pad' },
            h('div', { className: 'rt-about-lead' }, '选几个模型放进一个群，让它们像群里的人一样说话。'),
            h('div', { className: 'rt-about-note' },
              '模型调用全部走 DSH 自己的通道。这个插件不持有任何 API key，' +
              '也读不到你的凭据——它只显示 DSH 已经配好的线路。'),
          ),
        ),
        group('能做什么',
          h('div', { className: 'rt-set-pad rt-about-list' },
            FEATURES.map(([t, d2]) => h('div', { key: t, className: 'rt-about-item' },
              h('span', { className: 'rt-about-item-t' }, t),
              h('span', { className: 'rt-about-item-d' }, d2),
            )),
          ),
        ),
        group('按键',
          h('div', { className: 'rt-set-pad rt-about-keys' },
            KEYS.map(([k, v]) => h('div', { key: k, className: 'rt-about-key' },
              h('kbd', null, k),
              h('span', null, v),
            )),
          ),
        ),
        group('存档',
          h('div', { className: 'rt-set-pad rt-about-note' },
            '聊天记录只存在这台机器的浏览器里，不上传。清空浏览器数据会一起清掉——' +
            '想留一份就用群设置里的「导出记录」。'),
        ),
      )
    }

    return h(Modal, {
      title: '设置',
      onClose,
      wide: true,
      footer: [
        h('button', { key: 'c', className: 'rt-btn', onClick: onClose }, '取消'),
        h('button', {
          key: 's',
          className: 'rt-btn primary',
          onClick: () => onSave({
            profile: { name: name.trim() || '我', color },
            theme: { skin, mode },
            room: { autoReply, notice: notice.trim() },
          }),
        }, section === 'about' ? '关闭' : '保存'),
      ],
    },
      h('div', { className: 'rt-set' },
        h('div', { className: 'rt-set-nav' },
          SETTINGS_SECTIONS.map((s) => h('button', {
            key: s.id,
            className: 'rt-set-nav-item' + (section === s.id ? ' on' : ''),
            onClick: () => setSection(s.id),
          },
            h('span', { className: 'rt-set-nav-glyph' }, h(SettingsGlyph, { name: s.id })),
            h('span', { className: 'rt-set-nav-label' }, s.label),
          )),
        ),
        h('div', { className: 'rt-set-body' }, body),
      ),
    )
  }


  function ShopModal({ room, onClose }) {
    const [tab, setTab] = React.useState('shop')
    const members = (room?.members ?? []).filter((m) => m.enabled !== false)

    const homes = members
      .map((m) => ({ m, items: Array.isArray(m.items) ? m.items : [] }))
      .sort((a, b) => b.items.length - a.items.length)

    const shelf = (groupsData, priceKey, unit) => groupsData.map((g) => h(React.Fragment, { key: g.group },
      h('div', { className: 'rt-shop-group' }, g.group),
      h('div', { className: 'rt-shop-grid' },
        g.items.map((it) => h('div', {
          key: it.id,
          className: 'rt-shop-item' + (priceKey === 'gold' ? ' gold' : ''),
        },
          h('div', { className: 'rt-shop-glyph' }, h(Icon, { name: it.icon, size: 22 })),
          h('div', { className: 'rt-shop-name' }, it.name),
          h('div', { className: 'rt-shop-price' }, it[priceKey] + (priceKey === 'gold' ? ' 金' : ' 分')),
        )),
      ),
    ))

    let body
    if (tab === 'shop') body = shelf(SHOP, 'price', '分')
    else if (tab === 'gold') body = shelf(GOLD_SHOP, 'gold', '金')
    else {
      body = homes.map(({ m, items }) => {
        const counts = new Map()
        for (const it of items) counts.set(it.name, (counts.get(it.name) ?? 0) + 1)
        return h('div', { key: m.id, className: 'rt-home' },
          h(Avatar, { member: m, size: 24 }),
          h('div', { className: 'rt-home-main' },
            h('div', { className: 'rt-home-head' },
              h('span', { className: 'rt-home-name' }, m.displayName),
              m.rank ? h('span', { className: 'rt-home-rank' }, m.rank) : null,
              h('span', { className: 'rt-home-pts' }, (m.points ?? 0) + ' 分'),
              h('span', { className: 'rt-home-gold' }, (m.gold ?? 0) + ' 金'),
              (m.cheerReceived ?? 0) > 0
                ? h('span', { className: 'rt-home-cheer' }, '应援 ' + m.cheerReceived)
                : null,
            ),
            items.length === 0
              ? h('div', { className: 'rt-home-empty' }, '房间还是空的')
              : h('div', { className: 'rt-home-items' },
                  [...counts.entries()].map(([name, c]) => {
                    const iconName = items.find((x) => x.name === name)?.icon
                    return h('span', { key: name, className: 'rt-home-item', title: name },
                      h(Icon, { name: iconName ?? 'giftbox', size: 13 }),
                      c > 1 ? '×' + c : '')
                  }),
                ),
          ),
        )
      })
    }

    const totalPoints = members.reduce((n, m) => n + (m.points ?? 0), 0)
    const totalGold = members.reduce((n, m) => n + (m.gold ?? 0), 0)

    return h(Modal, {
      title: '商店 · ' + room.name,
      onClose,
      footer: [h('button', { key: 'd', className: 'rt-btn primary', onClick: onClose }, '关闭')],
    },
      h('div', { className: 'rt-shop-tabs' },
        h('button', {
          className: 'rt-shop-tab' + (tab === 'shop' ? ' on' : ''),
          onClick: () => setTab('shop'),
        }, '积分货架'),
        h('button', {
          className: 'rt-shop-tab gold' + (tab === 'gold' ? ' on' : ''),
          onClick: () => setTab('gold'),
        }, '金币货架'),
        h('button', {
          className: 'rt-shop-tab' + (tab === 'homes' ? ' on' : ''),
          onClick: () => setTab('homes'),
        }, '各家'),
        h('div', { className: 'rt-shop-tip' },
          '全场 ' + totalPoints + ' 分 · ' + totalGold + ' 金 · 模型自己买，你只能看'),
      ),
      h('div', { className: 'rt-homes' }, body),
    )
  }

/**
   * Compose a red packet.
   *
   * Three kinds, because the same gesture means different things:
   *
   *   拼手气 — the default, and what a 红包 normally is: uneven, first-come wins
   *   平均分 — every recipient gets the same, for when fairness is the point
   *   专属   — the whole packet goes to one named model
   *
   * The 专属 case is why the recipient is picked here rather than by whoever
   * grabs first: naming a model is the entire intent.
   */
  function PacketModal({ room, onClose, onSend }) {
    const members = (room?.members ?? []).filter((m) => m.enabled !== false)
    const [kind, setKind] = React.useState('lucky')
    // Amount and count are held as *strings*, not numbers.
    //
    // A number cannot represent an empty field, so typing over the field forced
    // a 0 back into the box and the last digit could never be deleted. Holding
    // the raw text keeps the field editable; the numeric value is derived below
    // and only checked when sending.
    const [points, setPoints] = React.useState('100')
    const [note, setNote] = React.useState('')
    const [count, setCount] = React.useState(String(Math.min(3, members.length)))
    const [target, setTarget] = React.useState(members[0]?.id ?? '')

    const KINDS = [
      { id: 'lucky', label: '拼手气', hint: '金额随机，先抢的多' },
      { id: 'even', label: '平均分', hint: '每人一样多' },
      { id: 'single', label: '专属', hint: '只给一个人' },
    ]

    const maxCount = Math.max(1, members.length)
    // Derived values. `NaN`/0 means "nothing entered yet" — shown as a hint, not
    // as a replaceable 0.
    const amountNum = Math.floor(Number(points))
    const amountOk = Number.isFinite(amountNum) && amountNum > 0
    const amount = amountOk ? amountNum : 0
    const countNum = Math.floor(Number(count))
    const grabbers = kind === 'single'
      ? 1
      : Math.max(1, Math.min(Number.isFinite(countNum) && countNum > 0 ? countNum : 1, maxCount))
    const each = grabbers > 0 && amount > 0 ? (amount / grabbers).toFixed(1) : '—'

    const canSend = amount > 0 && (kind !== 'single' || !!target)

    // What the sender is about to hand out, said plainly. With three modes and a
    // recipient picker, the summary is the only place the result is visible
    // before committing.
    const summary = !amountOk
      ? '先填一个金额'
      : kind === 'single'
        ? '全部 ' + amount + ' 分给 ' + (members.find((m) => m.id === target)?.displayName ?? '这一个模型')
        : kind === 'even'
          ? grabbers + ' 个模型平分，每人约 ' + each + ' 分'
          : grabbers + ' 个模型抢，金额随机，人均约 ' + each + ' 分'

    return h(Modal, {
      title: '发红包',
      onClose,
      footer: [
        h('button', { key: 'c', className: 'rt-btn', onClick: onClose }, '取消'),
        h('button', {
          key: 's',
          className: 'rt-btn primary',
          disabled: !canSend,
          style: canSend ? undefined : { opacity: .45, cursor: 'not-allowed' },
          onClick: () => {
            if (!canSend) return
            onSend({ amount, note, count: grabbers, kind, targetId: kind === 'single' ? target : null })
          },
        }, amountOk ? '发出 ' + amount + ' 分' : '发出'),
      ],
    },
      h('div', { className: 'rt-field' },
        h('label', null, '类型'),
        h('div', { className: 'rt-choice-row' },
          KINDS.map((k) => h('button', {
            key: k.id,
            className: 'rt-choice' + (kind === k.id ? ' on' : ''),
            onClick: () => setKind(k.id),
          },
            h('span', { className: 'rt-choice-name' }, k.label),
            h('span', { className: 'rt-choice-hint' }, k.hint),
          )),
        ),
      ),
      h('div', { className: 'rt-field' },
        h('label', null, '积分金额'),
        h('input', {
          type: 'text',
          inputMode: 'numeric',
          value: points,
          placeholder: '多少分',
          // Only strip non-digits; an empty string stays empty so the field can
          // be cleared to nothing.
          onChange: (e) => setPoints(e.target.value.replace(/[^0-9]/g, '')),
        }),
      ),
      kind === 'single'
        ? h('div', { className: 'rt-field' },
            h('label', null, '给谁'),
            h('div', { className: 'rt-pick-list' },
              members.map((m) => h('button', {
                key: m.id,
                className: 'rt-pick' + (target === m.id ? ' on' : ''),
                onClick: () => setTarget(m.id),
              },
                h(Avatar, { member: m, size: 20 }),
                h('span', { className: 'rt-pick-name' }, m.displayName),
              )),
            ),
          )
        : h('div', { className: 'rt-field' },
            h('label', null, '可抢人数'),
            h('input', {
              type: 'text',
              inputMode: 'numeric',
              value: count,
              placeholder: String(maxCount),
              // Same rule as the amount: keep the raw text so the field can be
              // emptied, and clamp only when it is used.
              onChange: (e) => setCount(e.target.value.replace(/[^0-9]/g, '')),
            }),
            h('div', { className: 'rt-hint2' }, '最多 ' + maxCount + ' 个模型。'),
          ),
      h('div', { className: 'rt-field' },
        h('label', null, '附言'),
        h('input', {
          type: 'text',
          value: note,
          placeholder: '恭喜发财',
          onChange: (e) => setNote(e.target.value),
        }),
      ),
      h('div', { className: 'rt-packet-summary' }, summary),
    )
  }

  function RoomModal({ room, profile, onClose, onSave, onDelete, onExport }) {
    const [name, setName] = React.useState(room?.name ?? '')
    const [autoReply, setAutoReply] = React.useState(room?.autoReply ?? 'first')
    const [notice, setNotice] = React.useState(room?.notice ?? '')
    if (!room) return null

    const soloCount = room.members.filter((m) => m.enabled !== false).length

    return h(Modal, {
      title: '群设置',
      onClose,
      footer: [
        // Export is the only way to keep a conversation: the transcript lives in
        // this browser and clearing site data takes it with it.
        h('button', { key: 'exp', className: 'rt-btn', onClick: onExport }, '导出记录'),
        h('button', { key: 'del', className: 'rt-btn danger', onClick: onDelete }, '删除这个群'),
        h('button', { key: 'c', className: 'rt-btn', onClick: onClose }, '取消'),
        h('button', {
          key: 's', className: 'rt-btn primary',
          onClick: () => onSave({ name: name.trim() || '未命名群', autoReply, notice: notice.trim() }),
        }, '保存'),
      ],
    },
      h('div', { className: 'rt-field' },
        h('label', null, '群名'),
        h('input', { type: 'text', value: name, onChange: (e) => setName(e.target.value) }),
      ),
      h('div', { className: 'rt-field' },
        h('label', null, '群公告'),
        h('textarea', {
          className: 'rt-notice-input',
          rows: 3,
          value: notice,
          placeholder: '比如：以后都叫我老板。',
          onChange: (e) => setNotice(e.target.value),
        }),
        h('div', { className: 'rt-hint2' },
          '写在里面的规矩，每个模型每次回答前都会看到。留空就是不设公告。'),
      ),
      h('div', { className: 'rt-field' },
        h('label', null, '不打 @ 时谁回答'),
        soloCount <= 1
          ? h('div', { className: 'rt-hint2' },
              '群里只有一个可用模型，它总是会回答，这条设置暂时不起作用。')
          : null,
        AUTO_MODES.map((mode) => h('div', {
          key: mode.id,
          className: 'rt-mp' + (autoReply === mode.id ? ' on' : ''),
          style: { alignItems: 'flex-start', cursor: 'pointer' },
          onClick: () => setAutoReply(mode.id),
        },
          h('span', {
            style: {
              width: 15, height: 15, flex: '0 0 15px', borderRadius: '50%', marginTop: 1,
              background: autoReply === mode.id ? 'rgba(124,140,255,.55)' : 'rgba(255,255,255,.07)',
              boxShadow: autoReply === mode.id
                ? 'inset 0 0 0 1px rgba(160,170,255,.7)'
                : 'inset 0 0 0 1px rgba(255,255,255,.10)',
            },
          }),
          h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', { style: { fontSize: 12.5 } }, mode.label),
            h('div', { style: { fontSize: 10.5, color: 'rgba(255,255,255,.36)', marginTop: 2 } }, mode.hint),
          ),
        )),
      ),
    )
  }

  // ── registration ─────────────────────────────────────────────────────────

  /**
   * The sidebar mark.
   *
   * Sized to sit level with the shipped panel icons rather than looking like
   * a stray glyph: a drawn SVG instead of a text character, because a font
   * glyph picks up the row's font metrics and renders inconsistently.
   */
  function RoundtableIcon() {
    return h('span', {
      style: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 22, height: 22, lineHeight: 1,
      },
    },
      h('svg', {
        width: 20, height: 20, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { display: 'block' },
      },
        // A round table with three seats: the room itself.
        h('circle', { cx: 12, cy: 12, r: 6.6 }),
        h('circle', { cx: 12, cy: 3.4, r: 1.9, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 5.2, cy: 16.6, r: 1.9, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 18.8, cy: 16.6, r: 1.9, fill: 'currentColor', stroke: 'none' }),
      ),
    )
  }

  /**
   * A panel that explains a load failure instead of vanishing.
   *
   * Reaching this means the real panel could not be registered — better to
   * show a readable card in the sidebar than to abort the whole Web boot.
   */
  function makeBrokenPanel(reason) {
    return function BrokenPanel() {
      return h('div', { className: 'rt-root' },
        h('div', { className: 'rt-main', style: { padding: 28 } },
          h('h3', { style: { margin: '0 0 8px', fontSize: 15 } }, '圆桌没能加载'),
          h('div', {
            style: {
              fontSize: 11.5, color: 'rgba(255,255,255,.5)',
              fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap',
              lineHeight: 1.7, wordBreak: 'break-word',
            },
          }, String(reason)),
          h('div', { style: { marginTop: 14, fontSize: 11.5, color: 'rgba(255,255,255,.4)' } },
            '插件本身不会让 DSH 起不来——这只是圆桌自己的问题。'),
        ),
      )
    }
  }

  return {
    name: 'roundtable',
    inject: ['slots', 'locale'],
    apply(ctx) {
      // Nothing in apply() may throw outward: an exception here is counted as
      // a failed boot entry and aborts the entire Web frontend.
      try {
        ensureCss()
      } catch {
        /* a missing <head> is not fatal; the panel just loses its styling */
      }

      let t = (k) => k
      try {
        t = ctx.locale.bind(NS)
        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'roundtable: dictionaries',
        )
      } catch {
        /* fall back to the raw key */
      }

      // `main` is a *keyed* slot: its option is `key`, not `id`, and the entry
      // only takes effect inside `slots.inject('main', ...)`.
      try {
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: PANEL_ID, locale: NS },
            RoundtablePanel,
          ),
        )
      } catch (e) {
        try {
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              { name: 'main', key: PANEL_ID },
              makeBrokenPanel('挂载主面板失败：' + String((e && e.message) || e)),
            ),
          )
        } catch {
          /* even the fallback failed; stay silent rather than kill boot */
        }
      }

      // The sidebar row. Here the option *is* `id`, and it must equal the
      // panel's `key` so the row and the panel pair up.
      try {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 40,
              label: () => {
                try { return t('nav') } catch { return '圆桌' }
              },
              locale: NS,
            },
            RoundtableIcon,
          ),
        )
      } catch {
        /* the panel above is still reachable through the layout */
      }
    },
  }
},
})
