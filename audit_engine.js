// audit_engine.js — the pure engine behind «الجرد» on warehouse.lightwaresy.com.
//
// ⚠ MOVED HERE FROM THE PORTAL, 9 Sep 2026 (Samir): «our warehouse employees have
// very low digital literacy and struggle with standard mobile interfaces». The
// counting, mapping and exception work belongs to the people who walk the racks,
// and they use the warehouse app — not the sales portal, which is a dense
// four-tab document tool built for Qusay and Amr. The RULES below are a faithful
// port of the portal's audit-core.js (43/43 node tests, 8 Sep); what changed is
// the interface around them, not the arithmetic. audit-harness/ re-runs those same
// tests against THIS file, so the port is a measured claim rather than a promise.
//
// ⚠ THE PIN SECTION IS GONE, DELIBERATELY. The portal's per-profile PIN gated the
// profile switcher; that whole idea is retired (Samir, same instruction) and the
// portal's switcher is one tap again. Attribution on this page is the warehouse
// login itself: every count row carries the signed-in user's id and display name.
//
// No imports, so node can load it as-is (module.exports tail, the reorder_engine
// pattern) and the browser can load it with a plain <script src>.
//
// THE BLIND-COUNT RULE, unchanged and load-bearing: the counter never sees the
// expected figure. A count that can see the answer anchors on the screen, not on
// the shelf, and the whole exercise measures nothing. `countList()` therefore
// returns NO quantity, and the page must never render one on a counting screen.
const AU = (() => {
  const COUNT_SQL_FILE = 'system_core/sql/phase29_stock_counts.sql'
  const TABLE_MISSING = /find the table|does not exist|schema cache|PGRST205/i
  const EPS = 0.005                         // numeric noise floor (metres of strip)
  const ABC_SHARE = { A: 0.80, B: 0.95 }    // cumulative value share
  const STALE_DAYS = { A: 30, B: 90, C: 365 }
  const DRAFT_KEY = (uid) => `lw_wh_audit_draft_v1_${uid}`

  // ── digits (both families — the Sep-1 lesson: Number('٥') is NaN → 0) ──
  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩'
  const toWestern = (s) => String(s ?? '').replace(/[٠-٩]/g, (d) => AR_DIGITS.indexOf(d))
  function numOf(s) {
    const t = toWestern(s).trim().replace(/,/g, '')
    if (t === '') return null
    const v = Number(t)
    return Number.isFinite(v) ? v : null
  }
  const r3 = (n) => Math.round(Number(n || 0) * 1000) / 1000

  // ── stores ──
  // «بيت …» = a private residence. Stock there is unauditable by construction:
  // nobody can count it, so nobody can be cleared of a shortfall in it. The rule
  // is the WORD, not a hand list — a «بيت فلان» created tomorrow is flagged on
  // day one. ⚠ «طارق طيار» / «منير» / «الشام» are people and places, not homes.
  const isHomeStore = (name) => /^بيت( |$)/.test(String(name || '').trim())

  const stockAt = (item, store) => Number(item?.stock_by_store?.[store] ?? 0)

  // every store the catalogue actually mentions ∪ the static list — the list
  // drifts (صحنايا appeared unannounced in Aug), so the data wins
  function storesSeen(items, staticNames) {
    const set = new Set(staticNames || [])
    for (const it of items || []) for (const k of Object.keys(it?.stock_by_store || {})) set.add(k)
    return [...set]
  }

  // which stores THIS viewer may count/map. Three cases, and the null one matters:
  //   branch = null   → a MANAGER (no staff_roles row, the house default) — everything
  //   branch = spoke  → that branch's own warehouses, and nothing else
  //   branch = hub    → everything no ACTIVE spoke owns
  // RLS is the real boundary either way (app_sees_store, phase26); this only decides
  // which buttons are worth drawing.
  function visibleStores({ branch, branches, allStores }) {
    const all = allStores || []
    if (!branch) return all
    if (branch.kind !== 'hub') {
      const own = new Set(branch.stores || [])
      return all.filter((s) => own.has(s))
    }
    const owned = new Set((branches || []).filter((b) => b.active && b.kind !== 'hub')
      .flatMap((b) => b.stores || []))
    return all.filter((s) => !owned.has(s))
  }

  // ── movements since the sync ──
  // `stock_by_store` is the hourly mirror of Al-Ameen; anything that left through
  // the portal AFTER that stamp is not in it yet. Same timestamp guard as the
  // Ledger's baseline merge: done + processed BEFORE the sync ⇒ Al-Ameen has it.
  // Direction per kind — sale/consign out of `store`; return INTO `store`; a نقلة
  // leaves `store` and arrives at `customer` (the Jul-26 destination convention).
  // External EXT- lines exist nowhere in stock and are skipped.
  // ⚠ Branch transfers (the `transfers` table) are branch-level, not store-level,
  // and are deliberately NOT folded here.
  // Returns Map code → net OUT (positive = fewer on the shelf than the mirror says).
  function pendingMovements(slips, store, syncedAt) {
    const m = new Map()
    const add = (code, q) => { if (code) m.set(code, r3((m.get(code) || 0) + q)) }
    for (const w of slips || []) {
      if (!w || w.status === 'voided' || w.kind === 'quote') continue
      if (w.status === 'done' && syncedAt && w.processed_at && w.processed_at <= syncedAt) continue
      const items = Array.isArray(w.items) ? w.items : []
      if (w.kind === 'transfer') {
        if (w.store === store) for (const it of items) add(it.code, +Number(it.qty || 0))
        if (w.customer === store) for (const it of items) add(it.code, -Number(it.qty || 0))
        continue
      }
      if (w.store !== store) continue
      const sign = w.kind === 'return' ? -1 : 1
      for (const it of items) {
        if (!it?.code || String(it.code).startsWith('EXT-')) continue
        add(it.code, sign * Number(it.qty || 0))
      }
    }
    return m
  }

  // live slips naming NO store cannot be attributed to any shelf — counted, never guessed
  function unattributedSlips(slips, syncedAt) {
    let n = 0
    for (const w of slips || []) {
      if (!w || w.status === 'voided' || w.kind === 'quote' || w.kind === 'transfer') continue
      if (w.status === 'done' && syncedAt && w.processed_at && w.processed_at <= syncedAt) continue
      if (!w.store) n++
    }
    return n
  }

  function expectedAt(item, store, pending) {
    const synced_qty = r3(stockAt(item, store))
    const pending_out = r3(pending?.get(item?.code) || 0)
    return { synced_qty, pending_out, expected: r3(synced_qty - pending_out) }
  }

  function varianceOf(expected, counted, recount) {
    const final = recount != null ? recount : counted
    return r3(Number(final) - Number(expected))
  }
  const isOff = (v) => Math.abs(Number(v || 0)) > EPS

  // ── ABC by value on hand (qty × avg cost). A = top 80% of value, B next 15%.
  // Items with no cost cannot be valued and land in C rather than being guessed. ──
  function abcClassify(items) {
    const rows = (items || []).map((i) => ({
      code: i.code,
      v: Math.max(0, Number(i.qty || 0)) * (Number(i.cost) > 0 ? Number(i.cost) : 0),
    }))
    const total = rows.reduce((s, r) => s + r.v, 0)
    rows.sort((a, b) => b.v - a.v)
    const cls = new Map()
    let cum = 0
    for (const r of rows) {
      if (!(r.v > 0) || !(total > 0)) { cls.set(r.code, 'C'); continue }
      const before = cum / total
      cum += r.v
      cls.set(r.code, before < ABC_SHARE.A ? 'A' : before < ABC_SHARE.B ? 'B' : 'C')
    }
    return cls
  }

  // ── shelf labels («رف 3 — ط 2», Submit.jsx's canonical form) ──
  const rackOf = (loc) => (toWestern(loc || '').match(/رف\s*(\d+)/) || [])[1] || ''
  const levelOf = (loc) => (toWestern(loc || '').match(/ط\s*(\d+)/) || [])[1] || ''
  const composeLoc = (rack, level) => {
    const r = toWestern(rack || '').replace(/\D/g, '')
    const l = toWestern(level || '').replace(/\D/g, '')
    if (!r) return ''
    return l ? `رف ${r} — ط ${l}` : `رف ${r}`
  }
  const rackKey = (loc) => { const r = rackOf(loc); return r ? Number(r) : 1e9 }
  const locAt = (locs, code, store) => (locs?.get(code) || []).find((l) => l.store === store) || null

  function racksAt(items, locs, store) {
    const set = new Set()
    for (const it of items || []) { const l = locAt(locs, it.code, store); const r = rackOf(l?.loc); if (r) set.add(r) }
    return [...set].sort((a, b) => Number(a) - Number(b))
  }

  // ── the count list: WHO to walk past. ⚠ NO QUANTITY, by rule (see header). ──
  // scope: {kind:'store'} | {kind:'rack', rack} | {kind:'brand', brand} | {kind:'abc', cls:'A'}
  function countList(items, store, locs, scope, abc) {
    const out = []
    for (const it of items || []) {
      const s = stockAt(it, store)
      const l = locAt(locs, it.code, store)
      let inScope = false
      if (scope.kind === 'store') inScope = s > 0 || !!l
      else if (scope.kind === 'rack') inScope = !!l && rackOf(l.loc) === String(scope.rack)
      else if (scope.kind === 'brand') inScope = (s > 0 || !!l) && it.brand === scope.brand
      else if (scope.kind === 'abc') inScope = s > 0 && (abc?.get(it.code) || 'C') === scope.cls
      if (!inScope) continue
      out.push({ code: it.code, name: it.name, latin_name: it.latin_name, unit: it.unit,
                 image_url: it.image_url || null, loc: l?.loc || '', cls: abc?.get(it.code) || 'C' })
    }
    out.sort((a, b) => (rackKey(a.loc) - rackKey(b.loc)) ||
                       String(a.name || '').localeCompare(String(b.name || ''), 'ar'))
    return out
  }

  function brandsAt(items, store) {
    const m = new Map()
    for (const it of items || []) if (stockAt(it, store) > 0 && it.brand) m.set(it.brand, (m.get(it.brand) || 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([brand, n]) => ({ brand, n }))
  }

  // items in this store that carry stock but no shelf label — the mapping queue.
  // Quantities ARE shown while mapping: mapping is not blind, and seeing «عندك 12»
  // is how someone confirms they are standing in front of the right box.
  function unmappedList(items, locs, store) {
    const out = []
    for (const it of items || []) {
      const q = stockAt(it, store)
      if (!(q > 0)) continue
      if (locAt(locs, it.code, store)) continue
      out.push({ code: it.code, name: it.name, latin_name: it.latin_name, unit: it.unit,
                 image_url: it.image_url || null, qty: r3(q) })
    }
    return out.sort((a, b) => b.qty - a.qty)
  }

  // ── exceptions (management) ──
  function negativeStock(items) {
    return (items || []).filter((i) => Number(i.qty) < -0.001)
      .sort((a, b) => Number(a.qty) - Number(b.qty))
      .map((i) => ({ code: i.code, name: i.name, brand: i.brand, qty: r3(i.qty) }))
  }

  function unmappedByStore(items, locs, stores) {
    const out = []
    for (const s of stores || []) {
      let n = 0, withStock = 0
      for (const it of items || []) {
        if (!(stockAt(it, s) > 0)) continue
        withStock++
        if (!locAt(locs, it.code, s)) n++
      }
      if (withStock) out.push({ store: s, n, withStock, home: isHomeStore(s) })
    }
    return out.sort((a, b) => b.n - a.n)
  }

  // stock parked in private homes — the unauditable location class. Valued at avg
  // cost; `partial` says the figure is a floor (some line had no cost), never a guess.
  function homeStock(items, stores) {
    const out = []
    for (const s of (stores || []).filter(isHomeStore)) {
      let n = 0, value = 0, missing = 0
      for (const it of items || []) {
        const q = stockAt(it, s); if (!(q > 0)) continue
        n++
        if (Number(it.cost) > 0) value += q * Number(it.cost); else missing++
      }
      if (n) out.push({ store: s, items: n, value: Math.round(value), partial: missing > 0, missing })
    }
    return out.sort((a, b) => b.value - a.value)
  }

  // last CLOSED count per store, and how stale that is. Never-counted stores carry
  // last=null — the honest state, printed as such, never as «0 days».
  function storeStaleness(sessions, stores, items, now = new Date()) {
    const last = new Map()
    for (const s of sessions || []) {
      if (s.status !== 'closed' || !s.closed_at) continue
      const prev = last.get(s.store)
      if (!prev || s.closed_at > prev) last.set(s.store, s.closed_at)
    }
    const out = []
    for (const st of stores || []) {
      const hasStock = (items || []).some((i) => stockAt(i, st) > 0)
      const l = last.get(st) || null
      const days = l ? Math.floor((now - new Date(l)) / 86400000) : null
      out.push({ store: st, last: l, days, hasStock, home: isHomeStore(st),
                 stale: hasStock && !isHomeStore(st) && (days == null || days > STALE_DAYS.A) })
    }
    return out.sort((a, b) => (b.stale - a.stale) || ((b.days ?? 1e9) - (a.days ?? 1e9)))
  }

  const openVariances = (rows) => (rows || []).filter((r) => isOff(r.variance) && !r.resolution)
  const daysAgo = (iso, now = new Date()) => iso ? Math.floor((now - new Date(iso)) / 86400000) : null

  // ── the rows a count session writes ──
  // Pure so the harness can check the arithmetic without a network: the page
  // fetches server-fresh stock at SAVE time (never at screen load — the Aug-9
  // cashbox lesson, where a second device with pre-count state re-reported a
  // shortage) and hands the result here.
  function buildCountRows({ sessionId, store, entries, byCode, pending, uid, authorName }) {
    return entries.map((e) => {
      const item = byCode.get(e.code) || { code: e.code, stock_by_store: {} }
      const x = expectedAt(item, store, pending)
      return {
        session_id: sessionId, code: e.code, store,
        synced_qty: x.synced_qty, pending_out: x.pending_out, expected: x.expected,
        counted: r3(e.counted), variance: varianceOf(x.expected, e.counted, null),
        counted_by: uid, counted_by_name: authorName, loc: e.loc || null,
      }
    })
  }

  const scopeKey = (s) => s.kind === 'rack' ? `rack:${s.rack}`
    : s.kind === 'brand' ? `brand:${s.brand}`
    : s.kind === 'abc' ? `abc:${s.cls}` : 'store'

  return { COUNT_SQL_FILE, TABLE_MISSING, EPS, ABC_SHARE, STALE_DAYS, DRAFT_KEY,
    toWestern, numOf, r3, isHomeStore, stockAt, storesSeen, visibleStores,
    pendingMovements, unattributedSlips, expectedAt, varianceOf, isOff, abcClassify,
    rackOf, levelOf, composeLoc, locAt, racksAt, countList, brandsAt, unmappedList,
    negativeStock, unmappedByStore, homeStock, storeStaleness, openVariances, daysAgo,
    buildCountRows, scopeKey }
})()
if (typeof module !== 'undefined' && module.exports) module.exports = AU
