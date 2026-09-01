/* Lightware — reorder engine + file writers for the warehouse app.
 *
 * PURE: no DOM, no fetch. Loaded by reorder.html as a classic script AND by
 * the node parity test (require) — the same bytes run in both, which is what
 * makes the test honest.
 *
 * The demand rule is the SHIPPED one (reorder_report.mjs, Aug 31 2026), which
 * itself imports replenish.js's velocityOf. It is mirrored here verbatim
 * because the warehouse page has no bundler — keep the three in sync:
 *   order-portal/src/replenish.js  →  reorder_report.mjs  →  this file.
 *
 * ⚠ WHY THE 13 DROPPED + 9 SEASONAL CODES ARE HARDCODED: reorder_settings has
 * RLS enabled with NO read policy — only the sync's service key can see it,
 * the browser cannot. Those two lists are Phase-0 OWNER DECISIONS (Jul 2026),
 * verified identical to the live table on Sep 1 2026. If a code is ever added
 * to or removed from that list in Supabase, mirror it here.
 */
const RO = (() => {
  // ───────────────────────── owner decisions (fixed) ─────────────────────────
  const DROPPED = new Set(['34011006', '34012002', '340306002', '340310001', '340310005',
    '340401014', '340401015', '340501002', '340501004', '341101002', '341101003',
    '341101007', '341101008'])
  const SEASONAL = new Set(['340802001', '340802002', '340802003', '340802004',
    '340802005', '340802007', '340802009', '340802010', '340802011'])

  // Phase-0 owner-approved parameters, unchanged so this page agrees with the
  // phone dashboard's traffic lights: order when cover ≤ 7 months, top up to 12.
  const LEAD = 5, BUFFER = 2, ROP = LEAD + BUFFER, TARGET = 12
  const WINDOW_DAYS = 365          // one full seasonal cycle — so NO ×1.5 summer factor

  const ORIGIN = {
    'Megaman': 'الصين', 'Orvibo': 'الصين', 'Dahua': 'الصين', 'Energetic': 'الصين',
    'Lightware': 'الصين', 'اكسسوارات': 'الصين', 'اكسسوارات مغناطيس': 'الصين',
    'ديمر': 'الصين', 'كبل': 'الصين', 'اقفال ذكية': 'الصين', 'برايز مكتبية': 'الصين',
    'Bticino': 'إيطاليا', 'Legrand': 'فرنسا', 'Simon Urmet': 'إيطاليا',
    'LEDs C4': 'إسبانيا', 'Panasonic + Urmet (انترفونات)': 'إيطاليا / اليابان', 'Orak': 'تركيا',
  }

  // ───────────────────────── velocity (mirror of replenish.js) ─────────────────────────
  const SPIKE_MULT = 5, SPIKE_FLOOR = 10, MIN_LINES = 5
  const median = (xs) => {
    if (!xs.length) return 0
    const s = [...xs].sort((a, b) => a - b)
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  }
  const spikeThreshold = (saleQtys) => Math.max(SPIKE_MULT * median(saleQtys), SPIKE_FLOOR)
  // a sale line larger than the threshold is a project spike, not sell-through;
  // under MIN_LINES lines a big quantity has not EARNED being normal
  function velocityOf({ sold = [], ret = [] }, windowDays = WINDOW_DAYS) {
    const th = sold.length < MIN_LINES ? SPIKE_FLOOR : spikeThreshold(sold)
    const lines = sold.filter((q) => q <= th)
    const consumer = lines.reduce((a, q) => a + q, 0)
    const spikeQty = sold.filter((q) => q > th).reduce((a, q) => a + q, 0)
    const returns = ret.filter((q) => q <= th).reduce((a, q) => a + q, 0)
    const net = Math.max(0, consumer - returns)
    return { ads: net / windowDays, soldQty: consumer, spikeQty, retQty: returns, n: lines.length, th }
  }

  const isSale = (k) => !!k && k.startsWith('مبيع') && !k.includes('مرتجع')
  const isRet = (k) => !!k && k.includes('مرتجع') && k.includes('مبيع')

  // bills → per-code sale/return line lists inside the trailing window.
  // `today` is an ISO date; the window is [today−365d, ∞) exactly like the
  // report (no upper bound — a mistyped future date still counts as a sale).
  function foldBills(bills, today) {
    const from = new Date(Date.parse(today + 'T00:00:00Z') - WINDOW_DAYS * 86400000).toISOString().slice(0, 10)
    const per = {}
    for (const b of bills || []) {
      const k = b.kind || '', d = (b.date || '').slice(0, 10)
      if (!d || d < from) continue
      const sale = isSale(k), ret = isRet(k)
      if (!sale && !ret) continue
      for (const it of (b.items || [])) {
        const c = it.code, q = Math.abs(Number(it.qty) || 0)
        if (!c || !(q > 0)) continue
        const v = per[c] || (per[c] = { sold: [], ret: [], last: '' })
        if (sale) { v.sold.push(q); if (d > v.last) v.last = d }
        else v.ret.push(q)
      }
    }
    return { per, from }
  }

  const roundOrder = (n) => {
    const c = Math.ceil(n)
    if (c >= 200) return Math.round(c / 50) * 50
    if (c >= 50) return Math.round(c / 10) * 10
    if (c >= 20) return Math.round(c / 5) * 5
    return c
  }
  const r2 = (x) => Math.round(x * 100) / 100

  // ───────────────────────── the plan ─────────────────────────
  // items: dashboard_items rows (code,name,latin_name,unit,qty,brand,cost,tracked)
  // per:   foldBills().per
  // Returns { rows, projects, brands, dropped } — rows are the standing reorder
  // list (identical to reorder_report.mjs), projects the «مواد المشاريع» list.
  function computePlan(items, per) {
    const rows = [], projects = []
    let dropped = 0
    const onList = new Set()
    for (const i of items) {
      const code = i.code
      if (DROPPED.has(code)) { dropped++; continue }
      const v = per[code]
      if (!v) continue
      const vel = velocityOf({ sold: v.sold, ret: v.ret }, WINDOW_DAYS)
      const demand = vel.ads * 30.44
      const qty = Number(i.qty) || 0
      const cost = i.cost == null || i.cost === '' ? null : Number(i.cost)
      // «جديدة عاللستة»: no stored reorder setting. dashboard_items.tracked is
      // the sync's own copy of settings.tracked (692 == 692 live), and the 13
      // dropped codes never reach this line — so tracked ⟺ has a setting.
      const hasSetting = !!i.tracked
      if (demand > 0) {
        const cover = qty / demand
        if (cover <= ROP) {
          const need = TARGET * demand - qty
          if (need > 0) {
            const suggest = roundOrder(need)
            rows.push({
              code, name: i.name || '', ref: i.latin_name || '', brand: i.brand || '—',
              unit: i.unit || '', qty, demand: r2(demand), cover: Math.round(cover * 10) / 10,
              suggest, cost,
              value: cost == null ? null : r2(suggest * cost),
              flow: cost == null ? null : r2(demand * cost),
              urgency: qty <= 0 ? 'نفد' : cover <= LEAD ? 'حرج' : 'قريب',
              sold12: Math.round(vel.soldQty), projectQty: Math.round(vel.spikeQty),
              bills: v.sold.length, last: v.last,
              seasonal: SEASONAL.has(code), newToList: !hasSetting,
              origin: ORIGIN[i.brand] || '—',
            })
            onList.add(code)
          }
        }
      }
      // project-capable items we could NOT serve a repeat of (the Aug-31 rule):
      // spikes only, ≥20 units of them in the year, stock below the biggest one
      const big = v.sold.filter((q) => q > vel.th)
      if (big.length) {
        const pv = big.reduce((a, q) => a + q, 0)
        const biggest = Math.max(...big)
        if (pv >= 20 && qty < biggest) {
          projects.push({
            code, name: i.name || '', ref: i.latin_name || '', brand: i.brand || '—',
            unit: i.unit || '', qty, projectQty: Math.round(pv), biggest: Math.round(biggest),
            projects: big.length, cost, last: v.last, origin: ORIGIN[i.brand] || '—',
            // one repeat of the biggest project from stock — the default when added
            suggest: roundOrder(biggest - qty),
          })
        }
      }
    }
    for (const p of projects) p.onOrderList = onList.has(p.code)
    const U = { 'نفد': 0, 'حرج': 1, 'قريب': 2 }
    rows.sort((a, b) => a.brand.localeCompare(b.brand, 'ar') || U[a.urgency] - U[b.urgency] || (b.flow || 0) - (a.flow || 0))
    projects.sort((a, b) => (b.biggest * (b.cost || 0)) - (a.biggest * (a.cost || 0)))
    return { rows, projects, brands: brandAgg(rows), dropped }
  }

  function brandAgg(rows) {
    const bb = {}
    for (const r of rows) {
      const b = bb[r.brand] || (bb[r.brand] = { n: 0, units: 0, val: 0, out: 0, crit: 0, soon: 0, origin: r.origin, nocost: 0 })
      b.n++; b.units += r.qtyOrder != null ? r.qtyOrder : r.suggest; b.val += r.value || 0
      if (r.value == null) b.nocost++
      b[r.urgency === 'نفد' ? 'out' : r.urgency === 'حرج' ? 'crit' : 'soon']++
    }
    return bb
  }

  // Arabic count agreement — 1 singular, 2 dual, else plural
  const billWord = (n) => n === 1 ? 'فاتورة وحدة' : n === 2 ? 'فاتورتين' : `${n} فواتير`
  function noteFor(r) {
    const note = []
    if (r.isProject) note.push('مشروع')
    if (r.newToList) note.push('جديدة عاللستة')
    if (r.seasonal) note.push('موسمي')
    if (r.bills != null && r.bills < 5 && !r.isProject) note.push(`مبيع نادر (${billWord(r.bills)})`)
    if (r.projectQty > 0 && !r.isProject) note.push(`+ مشاريع ${r.projectQty}`)
    if (r.cost == null) note.push('ما في كلفة مسجّلة')
    return note.join(' · ')
  }

  // ───────────────────────── ZIP writer ─────────────────────────
  const CRC_T = (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
      t[n] = c >>> 0
    }
    return t
  })()
  function crc32(u8) {
    let c = 0xFFFFFFFF
    for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8)
    return (c ^ 0xFFFFFFFF) >>> 0
  }
  async function deflateRaw(u8) {
    if (typeof CompressionStream === 'undefined') return null
    try {
      const cs = new CompressionStream('deflate-raw')
      const w = cs.writable.getWriter(); w.write(u8); w.close()
      const buf = await new Response(cs.readable).arrayBuffer()
      return new Uint8Array(buf)
    } catch (e) { return null }
  }
  function dosTime(d) {
    return { t: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF,
             d: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF }
  }
  // files: [{name, data: Uint8Array}] → Uint8Array. UTF-8 names (bit 11).
  // deflate when the platform has CompressionStream, STORE otherwise — either
  // way the archive is valid.
  async function zip(files, when = new Date()) {
    const enc = new TextEncoder()
    const { t, d } = dosTime(when)
    const locals = [], centrals = []
    let off = 0
    for (const f of files) {
      const name = enc.encode(f.name)
      const raw = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data)
      const crc = crc32(raw)
      let comp = await deflateRaw(raw), method = 8
      if (!comp || comp.length >= raw.length) { comp = raw; method = 0 }
      const lh = new DataView(new ArrayBuffer(30))
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true)
      lh.setUint16(8, method, true); lh.setUint16(10, t, true); lh.setUint16(12, d, true)
      lh.setUint32(14, crc, true); lh.setUint32(18, comp.length, true); lh.setUint32(22, raw.length, true)
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true)
      const ch = new DataView(new ArrayBuffer(46))
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true)
      ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true); ch.setUint16(12, t, true); ch.setUint16(14, d, true)
      ch.setUint32(16, crc, true); ch.setUint32(20, comp.length, true); ch.setUint32(24, raw.length, true)
      ch.setUint16(28, name.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true)
      ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, off, true)
      locals.push(new Uint8Array(lh.buffer), name, comp)
      centrals.push(new Uint8Array(ch.buffer), name)
      off += 30 + name.length + comp.length
    }
    const cdSize = centrals.reduce((s, u) => s + u.length, 0)
    const eocd = new DataView(new ArrayBuffer(22))
    eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(8, files.length, true); eocd.setUint16(10, files.length, true)
    eocd.setUint32(12, cdSize, true); eocd.setUint32(16, off, true); eocd.setUint16(20, 0, true)
    const parts = [...locals, ...centrals, new Uint8Array(eocd.buffer)]
    const out = new Uint8Array(parts.reduce((s, u) => s + u.length, 0))
    let p = 0
    for (const u of parts) { out.set(u, p); p += u.length }
    return out
  }

  // ───────────────────────── XLSX writer ─────────────────────────
  // A minimal but real OOXML writer: inline strings (no sharedStrings part),
  // formulas recalculated on open, RTL sheet views, merged cells, freeze
  // panes, autofilter, column widths and a style table built from the cell
  // descriptors actually used. Opens in Excel, Numbers and LibreOffice.
  //
  // cell := null | string | number
  //       | { v: string|number, s: style }      value with style
  //       | { f: 'G3*H3', s: style, n: fmt }   formula with style
  // style := { b?, color?, size?, fill?, align:'c'|'r'|'l', wrap?, box?, fmt? }
  const XML = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const colL = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26 } return s }
  const NUMFMTS = { '#,##0': 3, '0.0': 164, '#,##0.0': 165, '$#,##0': 166, '$#,##0.00': 167 }
  const CUSTOM_FMTS = { 164: '0.0', 165: '#,##0.0', 166: '"$"#,##0', 167: '"$"#,##0.00' }

  function buildStyles(styles) {
    const fonts = [], fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'], xfs = []
    const fontIdx = new Map(), fillIdx = new Map()
    const font = (s) => {
      const k = `${s.b ? 1 : 0}|${s.color || '1C1813'}|${s.size || 11}|${s.it ? 1 : 0}`
      if (!fontIdx.has(k)) {
        fontIdx.set(k, fonts.length)
        fonts.push(`<font>${s.b ? '<b/>' : ''}${s.it ? '<i/>' : ''}<sz val="${s.size || 11}"/><color rgb="FF${s.color || '1C1813'}"/><name val="Arial"/><family val="2"/></font>`)
      }
      return fontIdx.get(k)
    }
    const fill = (c) => {
      if (!c) return 0
      if (!fillIdx.has(c)) { fillIdx.set(c, fills.length); fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/><bgColor indexed="64"/></patternFill></fill>`) }
      return fillIdx.get(c)
    }
    // borders: 0 none, 1 thin box, 2 bottom only
    const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>',
      '<border><left style="thin"><color rgb="FFD3C7AC"/></left><right style="thin"><color rgb="FFD3C7AC"/></right><top style="thin"><color rgb="FFD3C7AC"/></top><bottom style="thin"><color rgb="FFD3C7AC"/></bottom><diagonal/></border>',
      '<border><left/><right/><top/><bottom style="thin"><color rgb="FFD3C7AC"/></bottom><diagonal/></border>']
    xfs.push('<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>')
    font({})
    const xfIdx = new Map([['{}', 0]])
    const xfOf = (s) => {
      const key = JSON.stringify(s)
      if (xfIdx.has(key)) return xfIdx.get(key)
      const fo = font(s), fi = fill(s.fill), bo = s.box ? 1 : s.bottom ? 2 : 0
      const nf = s.fmt ? (NUMFMTS[s.fmt] ?? 0) : 0
      const al = `<alignment horizontal="${s.align === 'c' ? 'center' : s.align === 'l' ? 'left' : 'right'}" vertical="center"${s.wrap ? ' wrapText="1"' : ''}/>`
      const id = xfs.length
      xfs.push(`<xf numFmtId="${nf}" fontId="${fo}" fillId="${fi}" borderId="${bo}" xfId="0" applyFont="1" applyFill="${fi ? 1 : 0}" applyBorder="${bo ? 1 : 0}" applyAlignment="1"${nf ? ' applyNumberFormat="1"' : ''}>${al}</xf>`)
      xfIdx.set(key, id)
      return id
    }
    for (const s of styles) xfOf(s)
    const nfx = Object.entries(CUSTOM_FMTS).map(([id, c]) => `<numFmt numFmtId="${id}" formatCode="${XML(c)}"/>`).join('')
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="${Object.keys(CUSTOM_FMTS).length}">${nfx}</numFmts>
<fonts count="${fonts.length}">${fonts.join('')}</fonts>
<fills count="${fills.length}">${fills.join('')}</fills>
<borders count="${borders.length}">${borders.join('')}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`
    return { xml, xfOf }
  }

  function sheetXml(sh, xfOf) {
    const rows = sh.rows || []
    const maxC = Math.max(1, ...rows.map((r) => (r || []).length), ...(sh.cols || []).map((_, i) => i + 1))
    const dim = `A1:${colL(maxC)}${Math.max(1, rows.length)}`
    let cols = ''
    if (sh.cols) cols = '<cols>' + sh.cols.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>'
    let pane = ''
    if (sh.freeze) {
      const m = /^([A-Z]+)(\d+)$/.exec(sh.freeze)
      const r = Number(m[2]) - 1
      pane = `<pane ySplit="${r}" topLeftCell="A${r + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/>`
    }
    const data = rows.map((r, ri) => {
      if (!r) return ''
      const h = sh.heights && sh.heights[ri + 1] ? ` ht="${sh.heights[ri + 1]}" customHeight="1"` : ''
      const cells = r.map((c, ci) => {
        if (c == null || c === '') return ''
        const ref = `${colL(ci + 1)}${ri + 1}`
        const obj = (typeof c === 'object') ? c : { v: c }
        const s = obj.s ? ` s="${xfOf(obj.s)}"` : ''
        if (obj.f != null) return `<c r="${ref}"${s}><f>${XML(obj.f)}</f></c>`
        if (typeof obj.v === 'number') return `<c r="${ref}"${s}><v>${obj.v}</v></c>`
        return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${XML(obj.v)}</t></is></c>`
      }).join('')
      return `<row r="${ri + 1}"${h}>${cells}</row>`
    }).join('')
    const merges = (sh.merges || []).length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''
    const filter = sh.filter ? `<autoFilter ref="${sh.filter}"/>` : ''
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="${dim}"/>
<sheetViews><sheetView${sh.rtl === false ? '' : ' rightToLeft="1"'} showGridLines="0" workbookViewId="0"${sh === undefined ? '' : ''}>${pane}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="16"/>${cols}<sheetData>${data}</sheetData>${filter}${merges}
<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>
<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>
</worksheet>`
  }

  // sheets: [{name, rtl, cols, rows, merges, freeze, filter, heights}] → Uint8Array (.xlsx)
  async function xlsx(sheets) {
    const enc = new TextEncoder()
    // collect every style used so the table is exact
    const styles = []
    for (const sh of sheets) for (const r of sh.rows || []) for (const c of r || []) if (c && typeof c === 'object' && c.s) styles.push(c.s)
    const { xml: stylesXml, xfOf } = buildStyles(styles)
    const files = []
    const safe = (n) => n.replace(/[\\/?*[\]:]/g, '-').slice(0, 31)
    files.push({ name: '[Content_Types].xml', data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`) })
    files.push({ name: '_rels/.rels', data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) })
    files.push({ name: 'xl/workbook.xml', data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="14000"/></bookViews>
<sheets>${sheets.map((s, i) => `<sheet name="${XML(safe(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
<calcPr calcId="191029" fullCalcOnLoad="1"/>
</workbook>`) })
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`) })
    files.push({ name: 'xl/styles.xml', data: enc.encode(stylesXml) })
    sheets.forEach((sh, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(sh, xfOf)) }))
    return zip(files)
  }

  // ───────────────────────── the workbook layouts ─────────────────────────
  // Palette — the house amber/ink, readable in print (same as reorder_report_xlsx.py)
  const C = { INK: '1C1813', AMBER: 'E8870B', AMBER_BG: 'FBE9CE', CREAM: 'F6F1E7', GREY: '6B6152',
    RED_BG: 'F6D5CE', RED_TX: '9E2B14', ORG_BG: 'FBE0C4', ORG_TX: '8A5A00', YEL_BG: 'FFF4CC', YEL_TX: '7A6314',
    INPUT_BG: 'FFF9D6', WHITE: 'FFFFFF', HIS: '7A6314' }
  const URG = { 'نفد': [C.RED_BG, C.RED_TX], 'حرج': [C.ORG_BG, C.ORG_TX], 'قريب': [C.YEL_BG, C.YEL_TX] }
  const S = {
    title: { b: true, size: 14, color: C.WHITE, fill: C.INK, align: 'r' },
    hdr: { b: true, size: 10, color: C.WHITE, fill: C.AMBER, align: 'c', wrap: true, box: true },
    hdrHis: { b: true, size: 10, color: C.WHITE, fill: C.HIS, align: 'c', wrap: true, box: true },
    cen: { align: 'c', box: true }, rgt: { align: 'r', box: true },
    int: { align: 'c', box: true, fmt: '#,##0' }, intB: { b: true, align: 'c', box: true, fmt: '#,##0' },
    d1: { align: 'c', box: true, fmt: '#,##0.0' }, d1b: { align: 'c', box: true, fmt: '0.0' },
    usd2: { align: 'c', box: true, fmt: '$#,##0.00' }, usd: { align: 'c', box: true, fmt: '$#,##0' },
    his: { b: true, align: 'c', box: true, fmt: '#,##0', fill: C.INPUT_BG },
    note: { size: 9, color: C.GREY, align: 'r', box: true, wrap: true },
    totL: { b: true, size: 12, align: 'r', fill: C.AMBER_BG, box: true },
    totN: { b: true, size: 12, align: 'c', fill: C.AMBER_BG, box: true, fmt: '#,##0' },
    totU: { b: true, size: 12, align: 'c', fill: C.AMBER_BG, box: true, fmt: '$#,##0' },
    totX: { fill: C.AMBER_BG, box: true, align: 'c' },
  }
  const urgStyle = (u) => ({ b: true, color: URG[u][1], fill: URG[u][0], align: 'c', box: true })

  // one brand's order sheet. lines carry qtyOrder (the human's final quantity)
  const BRAND_HDR = ['الرمز', 'المادة', 'الموجود', 'بيمشي بالشهر', 'بيكفي (شهر)', 'الحالة', 'نطلب', 'سعر الحبة $', 'الإجمالي $', 'كميتك', 'ملاحظة']
  const BRAND_W = [12, 46, 9, 12, 11, 9, 10, 12, 12, 11, 30]
  function brandSheet(brand, lines, origin) {
    const rows = []
    rows.push([{ v: `${brand}   —   ${origin || '—'}`, s: S.title }])
    rows.push(BRAND_HDR.map((h, i) => ({ v: h, s: i === 9 ? S.hdrHis : S.hdr })))
    let r = 3
    for (const it of lines) {
      const hasCost = it.cost != null
      rows.push([
        { v: it.code, s: S.cen }, { v: it.name, s: S.rgt },
        { v: it.qty, s: S.int },
        it.demand != null ? { v: it.demand, s: S.d1 } : { v: '—', s: S.cen },
        it.cover != null ? { v: it.cover, s: S.d1b } : { v: '—', s: S.cen },
        it.urgency ? { v: it.urgency, s: urgStyle(it.urgency) } : { v: 'مشروع', s: { b: true, color: C.HIS, fill: C.CREAM, align: 'c', box: true } },
        { v: it.suggest, s: S.intB },
        hasCost ? { v: it.cost, s: S.usd2 } : { v: '—', s: S.cen },
        hasCost ? { f: `J${r}*H${r}`, s: S.usd } : { v: '—', s: S.cen },
        { v: it.qtyOrder != null ? it.qtyOrder : it.suggest, s: S.his },
        { v: noteFor(it), s: S.note },
      ])
      r++
    }
    const last = r - 1
    rows.push(['', { v: 'الإجمالي', s: S.totL }, { v: '', s: S.totX }, { v: '', s: S.totX }, { v: '', s: S.totX }, { v: '', s: S.totX },
      { f: `SUM(G3:G${last})`, s: S.totN }, { v: '', s: S.totX }, { f: `SUM(I3:I${last})`, s: S.totU },
      { f: `SUM(J3:J${last})`, s: S.totN }, { v: '', s: S.totX }])
    return { name: brand, rtl: true, cols: BRAND_W, rows, merges: ['A1:K1'], freeze: 'A3',
      filter: `A2:K${last}`, heights: { 1: 26, 2: 30 }, _last: last, _tot: r }
  }

  // the decision page — headline box, legend, brand table with LIVE links to
  // every brand sheet, and the how-it-was-computed notes.
  // ⚠ The summary must NOT sum a brand sheet's own totals row: each brand's
  // data occupies rows 3..N+2 and its totals row is N+3, addressed directly.
  function summarySheet(brandSheets, meta) {
    const rows = []
    const cols = [26, 14, 10, 12, 15, 11, 11, 13]
    const merges = []
    const heights = {}
    const push = (r, h) => { rows.push(r); if (h) heights[rows.length] = h; return rows.length }
    let r
    r = push([{ v: 'LIGHTWARE.', s: { b: true, size: 20, align: 'l' } }], 30); merges.push(`A${r}:H${r}`)
    r = push([{ v: 'طلبية إعادة التوريد — حسب الماركة', s: { b: true, size: 16, align: 'r' } }], 26); merges.push(`A${r}:H${r}`)
    r = push([{ v: meta.subtitle, s: { size: 10, color: C.GREY, align: 'r' } }]); merges.push(`A${r}:H${r}`)
    push([])
    r = push([{ v: 'الخلاصة', s: { b: true, size: 13, color: C.WHITE, fill: C.INK, align: 'r' } }], 22); merges.push(`A${r}:H${r}`)
    const hs = { b: true, size: 10, color: C.GREY, fill: C.AMBER_BG, align: 'c' }
    r = push([{ v: 'عدد المواد المطلوبة', s: hs }, { v: '', s: hs }, { v: 'إجمالي الكمية', s: hs }, { v: '', s: hs },
      { v: 'قيمة الطلبية (كلفة)', s: hs }, { v: '', s: hs }, { v: 'مواد نافدة تماماً', s: hs }, { v: '', s: hs }])
    merges.push(`A${r}:B${r}`, `C${r}:D${r}`, `E${r}:F${r}`, `G${r}:H${r}`)
    const BIG = rows.length + 1
    push([], 34); merges.push(`A${BIG}:B${BIG}`, `C${BIG}:D${BIG}`, `E${BIG}:F${BIG}`, `G${BIG}:H${BIG}`)
    push([])
    r = push([{ v: 'شو يعني كل لون', s: { b: true, size: 12, align: 'r' } }]); merges.push(`A${r}:H${r}`)
    for (const [label, desc] of [['نفد', 'ما ضل ولا حبة — كل طلب عليها اليوم بيروح لغيرنا'],
      ['حرج', 'الموجود بيخلص قبل ما توصل الطلبية الجديدة'],
      ['قريب', 'بيكفي شوي بعد — منحطها بنفس الطلبية لتوفير الشحن']]) {
      r = push([{ v: label, s: urgStyle(label) }, { v: desc, s: { align: 'r' } }]); merges.push(`B${r}:H${r}`)
    }
    push([])
    r = push([{ v: 'الطلبية حسب الماركة', s: { b: true, size: 12, align: 'r' } }]); merges.push(`A${r}:H${r}`)
    push(['الماركة', 'من وين', 'عدد المواد', 'الكمية', 'القيمة $', 'نفد', 'حرج', 'قريب'].map((h) => ({ v: h, s: S.hdr })), 20)
    const first = rows.length + 1
    for (const sh of brandSheets) {
      const q = `'${sh.name.replace(/'/g, "''")}'`
      const last = sh._last, tr = sh._tot
      push([{ v: sh.name, s: { b: true, align: 'r', box: true } }, { v: sh._origin || '—', s: S.cen },
        { f: `COUNTA(${q}!A3:A${last})`, s: S.cen }, { f: `${q}!J${tr}`, s: S.int }, { f: `${q}!I${tr}`, s: S.usd },
        { f: `COUNTIF(${q}!F3:F${last},"نفد")`, s: S.cen }, { f: `COUNTIF(${q}!F3:F${last},"حرج")`, s: S.cen },
        { f: `COUNTIF(${q}!F3:F${last},"قريب")`, s: S.cen }])
    }
    const lastB = rows.length
    const tot = push([{ v: 'الإجمالي', s: S.totL }, { v: '', s: S.totX },
      { f: `SUM(C${first}:C${lastB})`, s: S.totN }, { f: `SUM(D${first}:D${lastB})`, s: S.totN }, { f: `SUM(E${first}:E${lastB})`, s: S.totU },
      { f: `SUM(F${first}:F${lastB})`, s: S.totN }, { f: `SUM(G${first}:G${lastB})`, s: S.totN }, { f: `SUM(H${first}:H${lastB})`, s: S.totN }])
    // headline numbers now that the table exists
    const big = { b: true, size: 18, align: 'c', fill: C.CREAM }
    rows[BIG - 1] = [{ f: `C${tot}`, s: big }, { v: '', s: big }, { f: `D${tot}`, s: { ...big, fmt: '#,##0' } }, { v: '', s: big },
      { f: `E${tot}`, s: { ...big, fmt: '$#,##0' } }, { v: '', s: big }, { f: `F${tot}`, s: big }, { v: '', s: big }]
    push([])
    r = push([{ v: 'كيف انحسبت الكميات', s: { b: true, size: 12, align: 'r' } }]); merges.push(`A${r}:H${r}`)
    for (const n of [
      'بيمشي بالشهر = وسطي المبيع الفعلي بآخر ١٢ شهر — من فواتير الأمين، مو تقدير.',
      'استثنينا مبيعات المشاريع الكبيرة من الوسطي، لأنها ما بتتكرر كل شهر. البنود المعلّمة «مشروع» انضافت بقرار لتغطية تكرار مشروع.',
      'منطلب لما يضل عنا أقل من ٧ شهور (٥ شهور وصول + ٢ احتياط) — ومنكفّي لـ ١٢ شهر. نفس القاعدة يلي عالشاشة.',
      'المواد يلي قررت توقفها (١٣ مادة) مشطوبة نهائياً — ما رح تلاقيها هون.',
      '«نطلب» = الكمية المحسوبة · «كميتك» = الكمية النهائية يلي انحطّت من شاشة الطلبية. الإجمالي بيتبع «كميتك».',
      'الأسعار كلفة بالدولار من الأمين (الوسطي)، للتقدير فقط — السعر النهائي من المورّد.',
    ]) { r = push([{ v: '•  ' + n, s: { size: 10.5, align: 'r', wrap: true } }], 18); merges.push(`A${r}:H${r}`) }
    return { name: 'ابدأ من هون', rtl: true, cols, rows, merges, heights, freeze: 'A2' }
  }

  // draft lines grouped by brand, money-first — the order every export uses
  function groupByBrand(lines) {
    const g = {}
    for (const l of lines) (g[l.brand] || (g[l.brand] = [])).push(l)
    const U = { 'نفد': 0, 'حرج': 1, 'قريب': 2 }
    for (const b in g) g[b].sort((a, z) => (U[a.urgency] ?? 3) - (U[z.urgency] ?? 3) || (z.flow || 0) - (a.flow || 0))
    return Object.entries(g).map(([brand, ls]) => ({
      brand, origin: ORIGIN[brand] || '—', lines: ls,
      units: ls.reduce((s, l) => s + (l.qtyOrder != null ? l.qtyOrder : l.suggest), 0),
      val: ls.reduce((s, l) => s + (l.cost == null ? 0 : (l.qtyOrder != null ? l.qtyOrder : l.suggest) * l.cost), 0),
      nocost: ls.filter((l) => l.cost == null).length,
    })).sort((a, b) => b.val - a.val)
  }

  // ONE workbook for one brand (the clean per-brand order file)
  async function brandWorkbook(group) {
    const sh = brandSheet(group.brand, group.lines, group.origin)
    return xlsx([sh])
  }
  // the full workbook: decision page + every brand in the draft
  async function fullWorkbook(groups, meta) {
    const sheets = groups.map((g) => { const s = brandSheet(g.brand, g.lines, g.origin); s._origin = g.origin; return s })
    return xlsx([summarySheet(sheets, meta), ...sheets])
  }

  // ───────────────────────── PDF pack (house writer, statement.js) ─────────────────────────
  // jpegs: ArrayBuffer[] (one A4 page each, any pixel size) → Uint8Array
  function packPdf(jpegs, dims) {
    const enc = new TextEncoder()
    const parts = [], offsets = []
    let pos = 0
    const push = (data) => { const b = typeof data === 'string' ? enc.encode(data) : new Uint8Array(data); parts.push(b); pos += b.length }
    const obj = (body) => { offsets.push(pos); push(`${offsets.length} 0 obj\n${body}\nendobj\n`) }
    push('%PDF-1.4\n')
    const n = jpegs.length
    const pageId = (i) => 3 + i * 3
    obj('<< /Type /Catalog /Pages 2 0 R >>')
    obj(`<< /Type /Pages /Kids [${Array.from({ length: n }, (_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${n} >>`)
    const W = 595.28, H = 841.89
    for (let i = 0; i < n; i++) {
      const content = `q ${W} 0 0 ${H} 0 0 cm /Im${i} Do Q`
      obj(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${pageId(i) + 1} 0 R /Resources << /XObject << /Im${i} ${pageId(i) + 2} 0 R >> >> >>`)
      obj(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
      offsets.push(pos)
      push(`${offsets.length} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${dims[i].w} /Height ${dims[i].h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegs[i].byteLength} >>\nstream\n`)
      push(jpegs[i]); push('\nendstream\nendobj\n')
    }
    const xrefPos = pos
    let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`
    for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`
    push(xref)
    push(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`)
    const out = new Uint8Array(pos)
    let p = 0
    for (const u of parts) { out.set(u, p); p += u.length }
    return out
  }

  return { DROPPED, SEASONAL, LEAD, BUFFER, ROP, TARGET, WINDOW_DAYS, ORIGIN,
    velocityOf, foldBills, computePlan, brandAgg, roundOrder, noteFor, billWord,
    crc32, zip, xlsx, brandSheet, summarySheet, groupByBrand, brandWorkbook, fullWorkbook, packPdf }
})()
if (typeof module !== 'undefined' && module.exports) module.exports = RO
