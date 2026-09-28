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
      // an abandoned walk closes its session with nothing saved — that is not a
      // count, and must not make a warehouse read «counted today» (round-2 A10)
      if (s.items != null && Number(s.items) === 0) continue
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

  // ═══════════════════════════ STACK WAREHOUSES (phase33, 28 Sep 2026) ═══════════
  // A floor-stacked warehouse numbers its stacks 1..N across the whole floor
  // (Samir: the flattest hierarchy there is). One stack holds one SKU; the
  // accessory stacks hold a few; one SKU may fill two stacks. Al-Ameen knows
  // quantity per WAREHOUSE, never per stack — so a count is always per SKU
  // (every stack it sits on, summed), and the stack is where you stand.
  //
  // THE MODEL (phase33_stack_warehouse.sql says it in full; this is the same
  // arithmetic, and adj-parity.mjs holds the portal's copy to it):
  //   gap      = counted − (mirror − live slips)          one per count row
  //   the NEWEST eligible count per (store, code) is the truth about the gap
  //   to_post  = gap − Σ posts recorded after that count's mirror stamp
  //   working  = mirror − live slips + (gap − Σ posts the mirror has absorbed)
  // Nothing chains: an older count never adds to a newer one.
  const STACKS_SQL_FILE = 'system_core/sql/phase33_stack_warehouse.sql'
  const STACKS_MISSING = /warehouse_maps|stack_items|warehouse_stacks|cycle_days|stock_positions|stock_ledger|pick_lists|stack_flags|stock_adjust_posts|mirror_at|adj_open|recount_stacks|held_why|resolution_kind/
  const DUE_DEFAULT = { A: 14, B: 30, C: 60 }
  const DAY_MS = 86400000

  // the business day in Damascus — the day key of the cycle queue
  function damascusDay(d = new Date()) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Damascus',
        year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
    } catch { return new Date(d.getTime() + 3 * 3600000).toISOString().slice(0, 10) }
  }
  const dayNum = (iso) => Math.floor(Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z') / DAY_MS)

  // stack_items rows → both directions, for ONE warehouse
  function stackIndex(rows, store) {
    const byStack = new Map(), byCode = new Map()
    for (const r of rows || []) {
      if (store && r.store !== store) continue
      const n = Number(r.stack_no)
      if (!byStack.has(n)) byStack.set(n, [])
      byStack.get(n).push(r.code)
      if (!byCode.has(r.code)) byCode.set(r.code, [])
      byCode.get(r.code).push(n)
    }
    for (const l of byCode.values()) l.sort((a, b) => a - b)
    return { byStack, byCode }
  }

  // ── pending movements: the NEEDS_PRICE fix + the printed pick list ──
  // ⚠ A slip Qusay flagged «ناقص تسعير» (flag_reason NEEDS_PRICE) has ALREADY
  // been typed into Al-Ameen — the flag is only about its price. It used to be
  // subtracted from expected a second time (found by the phase33 review: live
  // slips #77, #103, #201 would each have opened a false surplus). It is now
  // treated exactly like a done slip: pending until the sync that absorbed it.
  // ════ ENGINE MIRROR BEGIN — order-portal/src/picking.js carries this block verbatim (adj-parity.mjs) ════
  const r0 = (n) => Math.abs(Number(n || 0)) <= EPS
  const absorbed = (w, syncedAt) =>
    (w.status === 'done' || (w.status === 'flagged' && w.flag_reason === 'NEEDS_PRICE'))
    && !!syncedAt && !!w.processed_at && w.processed_at <= syncedAt
  const liveSlip = (w, syncedAt) => !!w && w.status !== 'voided' && w.kind !== 'quote' && !absorbed(w, syncedAt)
  const outbound = (w) => w.kind === 'sale' || w.kind === 'consign' || w.kind === 'transfer'
  // the Jul-26 store rule for one live slip: sale/consign out of `store`, a
  // return INTO it, a نقلة out of `store` and into `customer`; EXT- lines skipped
  function storeRule(w, store, add) {
    const items = Array.isArray(w.items) ? w.items : []
    if (w.kind === 'transfer') {
      if (w.store === store) for (const it of items) add(it.code, +Number(it.qty || 0))
      if (w.customer === store) for (const it of items) add(it.code, -Number(it.qty || 0))
      return
    }
    if (w.store !== store) return
    const sign = w.kind === 'return' ? -1 : 1
    for (const it of items) {
      if (!it?.code || String(it.code).startsWith('EXT-')) continue
      add(it.code, sign * Number(it.qty || 0))
    }
  }
  function pendingMovementsPicked(slips, store, syncedAt, picks, exceptId) {
    const m = new Map()
    const add = (code, q) => { if (code) m.set(code, r3((m.get(code) || 0) + q)) }
    for (const w of slips || []) {
      if (!w || (exceptId && w.id === exceptId)) continue
      if (!liveSlip(w, syncedAt)) continue
      const plan = picks?.get?.(w.id)
      if (plan && outbound(w)) {
        for (const p of plan) if (p.store === store && !String(p.code).startsWith('EXT-')) add(p.code, Number(p.qty || 0))
        if (w.kind === 'transfer' && w.customer === store)
          for (const it of w.items || []) add(it.code, -Number(it.qty || 0))
        continue
      }
      storeRule(w, store, add)
    }
    return m
  }
  function remainingGaps(positions, posts, mirrorAt) {
    const byKey = new Map()
    for (const p of posts || []) {
      const k = `${p.store}|${p.code}`
      if (!byKey.has(k)) byKey.set(k, [])
      byKey.get(k).push(p)
    }
    const m = new Map()
    for (const r of positions || []) {
      const k = `${r.store}|${r.code}`
      const since = r.mirror_at || r.counted_at
      let absorbedSum = 0
      for (const p of byKey.get(k) || []) {
        if (p.posted_at > since && mirrorAt && p.posted_at <= mirrorAt) absorbedSum += Number(p.amount || 0)
      }
      const rem = r3(Number(r.gap || 0) - absorbedSum)
      if (!r0(rem)) m.set(k, rem)
    }
    return m
  }
  // ════ ENGINE MIRROR END ════
  function unattributedPicked(slips, syncedAt, picks) {
    let n = 0
    for (const w of slips || []) {
      if (!liveSlip(w, syncedAt) || w.kind === 'transfer') continue
      if (!w.store && !(picks?.get?.(w.id) && outbound(w))) n++
    }
    return n
  }
  // what could explain a difference: every live slip that touches this code and
  // might have left THIS warehouse (its plan or its store says so, or it names
  // no warehouse at all), and every dispatched-but-untyped branch transfer
  // carrying it out of a hub warehouse. A difference found while any of these
  // is in flight is HELD — nobody can tell a loss from an untyped sale.
  function inflightFor(slips, transfers, store, code, syncedAt, picks, isHubStore) {
    const why = []
    for (const w of slips || []) {
      if (!liveSlip(w, syncedAt)) continue
      if (!(w.items || []).some((it) => it.code === code)) continue
      const plan = picks?.get?.(w.id)
      const touches = plan && outbound(w) ? plan.some((p) => p.code === code && p.store === store)
        : (!w.store || w.store === store || (w.kind === 'transfer' && w.customer === store))
      if (touches) why.push(`سند ${w.no ?? '?'}`)
    }
    if (isHubStore) for (const t of transfers || []) {
      if (t.status !== 'dispatched' || t.posted_at) continue
      if ((t.items_sent || t.items || []).some((it) => it.code === code)) why.push(`إرسالية ${t.no ?? '?'}`)
    }
    return why
  }

  // ── positions: the newest eligible count per (store, code) — the stock_positions
  // view. remainingGaps (above, mirrored) turns them + the posts into the gap the
  // WORKING quantity still carries: posts the mirror has not absorbed yet are
  // still part of the gap, absorbed ones are already in the mirror.
  const remAt = (rem, store, code) => r3(rem?.get?.(`${store}|${code}`) || 0)

  // expected for a NEW count = mirror − live slips + the gap the newest count left
  function expectedWithGap(item, store, pending, rem) {
    const x = expectedAt(item, store, pending)
    const adj_open = remAt(rem, store, item?.code)
    return { ...x, adj_open, expected: r3(x.expected + adj_open) }
  }
  // the working quantity of one item in one warehouse (what picking can rely on)
  function workingQty(item, store, pending, rem) {
    return expectedWithGap(item, store, pending, rem).expected
  }

  // ── the count list for stacks: one (stack, SKU) per screen, in stack order.
  // ⚠ NO QUANTITY, same rule as countList(). A stack with no code (the display
  // stands) has nothing of ours on it to verify and never appears.
  function stackCountList(items, byStack, stackNos, stackRows) {
    const byCode = new Map((items || []).map((i) => [i.code, i]))
    const rowOf = new Map((stackRows || []).map((r) => [Number(r.stack_no), r]))
    const out = []
    for (const n of [...new Set((stackNos || []).map(Number))].sort((a, b) => a - b)) {
      const codes = byStack.get(n) || []
      codes.forEach((code, i) => {
        const it = byCode.get(code) || { code }
        out.push({ key: `${n}|${code}`, stack: n, code, name: it.name, latin_name: it.latin_name,
                   unit: it.unit, image_url: it.image_url || null, zone: rowOf.get(n)?.zone || '',
                   part: codes.length > 1 ? [i + 1, codes.length] : null })
      })
    }
    return out
  }

  // every stack an SKU sits on in this warehouse — the set a count must cover
  const stacksOfCode = (byCode, code) => byCode?.get?.(code) || []

  // (stack, SKU) answers → one entry per SKU, once EVERY stack it sits on in
  // this warehouse has an answer (0 is an answer, a skip is not). Half a total
  // compared with Al-Ameen's whole-warehouse figure is a false shortage.
  // vals: {`${stack}|${code}`: {q, e}}
  function stackEntryFor(code, vals, byCode) {
    const need = stacksOfCode(byCode, code)
    if (!need.length) return null
    const stacks = {}
    for (const n of need) {
      const v = vals[`${n}|${code}`]
      if (!v || v.q == null || !Number.isFinite(Number(v.q))) return null
      stacks[n] = v.e ? { q: r3(v.q), e: v.e } : { q: r3(v.q) }
    }
    const counted = r3(need.reduce((s, n) => s + Number(stacks[n].q), 0))
    return { code, counted, stacks, loc: `كومة ${need.join(' · ')}` }
  }

  function buildStackCountRow({ sessionId, store, entry, item, pending, rem, mirrorAt, uid, authorName, held }) {
    const x = expectedWithGap(item || { code: entry.code, stock_by_store: {} }, store, pending, rem)
    return {
      session_id: sessionId, code: entry.code, store,
      synced_qty: x.synced_qty, pending_out: x.pending_out, adj_open: x.adj_open, expected: x.expected,
      counted: r3(entry.counted), variance: varianceOf(x.expected, entry.counted, null),
      counted_by: uid, counted_by_name: authorName, loc: entry.loc || null,
      stacks: entry.stacks, mirror_at: mirrorAt || null,
      ...(held && held.length ? { held: true, held_why: held.join('، ') } : {}),
    }
  }

  // ── the keypad's arithmetic: «17×48+5». Staff count cartons and rolls; the
  // device multiplies, and the expression is kept so a slip shows in the ledger.
  function evalCount(expr) {
    const t = toWestern(expr || '').replace(/[x*]/gi, '×').replace(/\s+/g, '')
    if (!t) return null
    if (!/^[0-9.×+]+$/.test(t) || /[×+]{2}|^[×+]|[×+]$/.test(t)) return null
    let sum = 0
    for (const term of t.split('+')) {
      let prod = 1
      for (const f of term.split('×')) {
        if (!/^\d+(\.\d+)?$|^\d*\.\d+$/.test(f)) return null
        prod *= Number(f)
      }
      sum += prod
    }
    return Number.isFinite(sum) ? r3(sum) : null
  }

  // ── the daily cycle queue ──
  // ABC per WAREHOUSE over its stacked codes (qty there × cost) — the global
  // class made 107 of 117 stacks «A» and the rotation meaningless (review
  // finding). Due after due_days[class]. Units are stack GROUPS (stacks joined
  // by a shared code). Left out: stacks with no code; stacks a picker is still
  // working (an open printed sheet whose slip is not typed); stacks flagged
  // «المادة مو هون» until an approver resolves it. First in: a picker's «لقيت
  // أقل» flag, then negative working stock, then the most overdue for its class.
  function storeAbc(items, store, codes) {
    const want = new Set(codes)
    return abcClassify((items || []).filter((i) => want.has(i.code))
      .map((i) => ({ code: i.code, qty: stockAt(i, store), cost: i.cost })))
  }
  function stackGroups(byStack) {
    const parent = new Map()
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x) } return x }
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb)) }
    const firstOf = new Map()
    for (const [n, codes] of byStack) {
      if (!codes.length) continue
      parent.set(n, n)
      for (const c of codes) { if (firstOf.has(c)) union(n, firstOf.get(c)); else firstOf.set(c, n) }
    }
    const groups = new Map()
    for (const n of parent.keys()) { const r = find(n); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(n) }
    return [...groups.values()].map((g) => g.sort((a, b) => a - b))
  }
  // recountCodes: codes whose last count found a difference and was never
  // recounted (the tablet died, the walk was abandoned) — they come back first
  function cycleSelect({ byStack, lastByCode, baselineAt, abc, workingOf, today, perDay, due,
                         busyStacks, notHere, shortStacks, recountCodes }) {
    const t = dayNum(today)
    const base = baselineAt ? dayNum(baselineAt) : null
    const D = { ...DUE_DEFAULT, ...(due || {}) }
    const rank = { A: 0, B: 1, C: 2 }
    const units = stackGroups(byStack).map((stacks) => {
      const codes = [...new Set(stacks.flatMap((n) => byStack.get(n) || []))]
      let oldest = Infinity, neg = false, cls = 'C'
      for (const c of codes) {
        const l = lastByCode?.get?.(c)
        let d = l ? dayNum(l) : null
        if (base != null && (d == null || d < base)) d = base
        oldest = Math.min(oldest, d == null ? -Infinity : d)
        const k = abc?.get?.(c) || 'C'
        if (rank[k] < rank[cls]) cls = k
        if (workingOf && Number(workingOf(c)) < -EPS) neg = true
      }
      const age = oldest === -Infinity ? Infinity : t - oldest
      const short = stacks.some((n) => shortStacks?.has?.(n)) || codes.some((c) => recountCodes?.has?.(c))
      const skip = stacks.some((n) => busyStacks?.has?.(n) || notHere?.has?.(n))
      return { stacks, codes, cls, neg, short, skip, age, ratio: age / D[cls] }
    }).filter((u) => !u.skip)
    units.sort((a, b) => (b.short - a.short) || (b.neg - a.neg) || (b.ratio - a.ratio) || (a.stacks[0] - b.stacks[0]))
    const pick = [], reasons = {}
    for (const u of units) {
      if (pick.length >= perDay) break
      for (const n of u.stacks) {
        pick.push(n)
        reasons[n] = u.codes.some((c) => recountCodes?.has?.(c)) ? 'recount'
          : u.short ? 'short' : u.neg ? 'neg' : u.age === Infinity ? 'never' : `due:${u.age}`
      }
    }
    return { stacks: pick.sort((a, b) => a - b), reasons }
  }
  // can cycle_per_day keep every class on time? stacks/day needed on a 6-day week
  function cycleCapacity(byStack, abc, due, perDay) {
    const D = { ...DUE_DEFAULT, ...(due || {}) }
    const rank = { A: 0, B: 1, C: 2 }
    let need = 0
    for (const g of stackGroups(byStack)) {
      let cls = 'C'
      for (const n of g) for (const c of byStack.get(n) || []) { const k = abc?.get?.(c) || 'C'; if (rank[k] < rank[cls]) cls = k }
      need += g.length / D[cls]
    }
    need = Math.round(need * 7 / 6 * 10) / 10
    return { need, perDay, ok: need <= perDay }
  }

  // latest FINAL count per code in one warehouse (any scope)
  function lastCountedByCode(rows, store) {
    const m = new Map()
    for (const r of rows || []) {
      if (r.store !== store || !r.counted_at) continue
      // a verification is a FINAL, trusted count: a first pass that matched, or a
      // completed recount that was neither held nor ruled a miscount
      const final = !isOff(r.variance) || (r.recount != null && !r.held && r.resolution_kind !== 'miscount')
      if (!final) continue
      if (!m.has(r.code) || r.counted_at > m.get(r.code)) m.set(r.code, r.counted_at)
    }
    return m
  }

  // the ledger, summarised for approvers (rows: stock_ledger view)
  function ledgerSummary(rows) {
    const s = { to_approve: 0, to_post: 0, held: 0, unverified: 0, settled: 0, void: 0, superseded: 0,
                loss: 0, surplus: 0, lossN: 0, surplusN: 0, unvalued: 0 }
    for (const r of rows || []) {
      if (r.state === 'clean') continue
      if (s[r.state] != null) s[r.state]++
      if (!['to_approve', 'to_post', 'settled'].includes(r.state)) continue
      // ONE basis per state (round-2 A12): an open row is worth what it will
      // still move (to_post, when the view supplies it); a settled row is worth
      // what WAS moved — its gap. By variance, a loss carried through a
      // confirming count (variance 0, gap −10) vanished from «نقص» the moment
      // Qusay posted it, while the same loss posted directly stayed.
      const v = Number(r.state === 'settled' ? (r.gap ?? r.variance ?? 0)
        : (r.to_post != null ? r.to_post : (r.variance || 0)))
      if (r0(v)) continue
      if (!(Number(r.cost) > 0)) s.unvalued++
      const val = v * (Number(r.cost) > 0 ? Number(r.cost) : 0)
      if (v < 0) { s.loss += val; s.lossN++ } else { s.surplus += val; s.surplusN++ }
    }
    s.loss = Math.round(s.loss * 100) / 100
    s.surplus = Math.round(s.surplus * 100) / 100
    return s
  }

  const scopeKey = (s) => s.kind === 'cycle' ? `cycle:${s.day}`
    : s.kind === 'baseline' ? 'baseline'
    : s.kind === 'stack' ? `stack:${s.stack}`
    : s.kind === 'zone' ? `zone:${s.zone}`
    : s.kind === 'rack' ? `rack:${s.rack}`
    : s.kind === 'brand' ? `brand:${s.brand}`
    : s.kind === 'abc' ? `abc:${s.cls}` : 'store'

  return { COUNT_SQL_FILE, TABLE_MISSING, EPS, ABC_SHARE, STALE_DAYS, DRAFT_KEY,
    toWestern, numOf, r3, isHomeStore, stockAt, storesSeen, visibleStores,
    pendingMovements, unattributedSlips, expectedAt, varianceOf, isOff, abcClassify,
    rackOf, levelOf, composeLoc, locAt, racksAt, countList, brandsAt, unmappedList,
    negativeStock, unmappedByStore, homeStock, storeStaleness, openVariances, daysAgo,
    buildCountRows, scopeKey,
    STACKS_SQL_FILE, STACKS_MISSING, DUE_DEFAULT, damascusDay, dayNum, stackIndex,
    pendingMovementsPicked, unattributedPicked, inflightFor, remainingGaps, remAt, expectedWithGap,
    workingQty, stackCountList, stacksOfCode, stackEntryFor, buildStackCountRow, evalCount, storeAbc,
    stackGroups, cycleSelect, cycleCapacity, lastCountedByCode, ledgerSummary }
})()
if (typeof module !== 'undefined' && module.exports) module.exports = AU
