// 2024년 이후 "시총 기준 미달 → 회복" 사례를 모은다.
// 1) KIND 공식 공시: 시총 미달 관리종목 해제, 지정우려(경고) 후 미지정
// 2) 추정: 공시가 없는 구간(코스피 전체, 코스닥 2025년 이전)은 수정주가 × 현재 주식수로 시총을 추정해 찾는다.
// KIND는 요청이 많으면 IP를 막으므로 하나씩 천천히 보내고, 받은 결과는 data/kind-cache.json 에 쌓는다.
import fs from 'node:fs';
import path from 'node:path';

const KIND = 'https://kind.krx.co.kr';
const UA = { 'User-Agent': 'Mozilla/5.0 (delisting-watch)' };
const START = '2024-01-01';
const KIND_GAP_MS = 700;      // KIND 요청 간격
const MAX_RELATED_FETCH = 80; // 한 번 실행에 새로 받을 "관련 공시" 검색 수
const KIND_BUDGET_MS = 8 * 60e3; // KIND 요청에 쓸 수 있는 총 시간
let kindSpent = 0;

// 시점별 기준 (억원). m: 0=코스피, 1=코스닥
export function mcapLimitAt(date, m) {
  if (date < '2026-01-01') return [50, 40][m];
  if (date < '2026-07-01') return [200, 150][m];
  if (date < '2027-01-01') return [300, 200][m];
  return [500, 300][m];
}
export function revLimitAt(date, m) {
  const y = +date.slice(0, 4);
  if (y <= 2026) return [50, 30][m];
  if (y === 2027) return [100, 50][m];
  if (y === 2028) return [200, 75][m];
  return [300, 100][m];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const ymd = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const decodeHtml = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');

// ---------- KIND (천천히, 하나씩) ----------
let cookie = '';
let kindBlocked = false;
let lastKind = 0;
async function kindFetch(url, opts = {}) {
  if (kindBlocked) throw new Error('KIND blocked');
  if (kindSpent > KIND_BUDGET_MS) { kindBlocked = true; throw new Error('KIND 시간 예산 초과'); }
  const wait = lastKind + KIND_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastKind = Date.now();
  const t0 = Date.now();
  try {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000), ...opts, headers: { ...UA, ...(cookie ? { Cookie: cookie } : {}), ...(opts.headers || {}) } });
  if (r.status === 403) { kindBlocked = true; throw new Error('KIND 403'); }
  if (!r.ok) throw new Error('KIND ' + r.status);
  return r;
  } finally { kindSpent += Date.now() - t0 + Math.max(0, wait); }
}
async function kindSession() {
  const r = await kindFetch(`${KIND}/disclosure/details.do?method=searchDetailsMain`);
  cookie = r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
}
async function kindSearch({ reportNm = '', corp = '', from, to }) {
  const rows = [];
  for (let page = 1; page < 60; page++) {
    const q = new URLSearchParams({
      method: 'searchDetailsSub', forward: 'details_sub', currentPageSize: '100', pageIndex: String(page),
      orderMode: '0', orderStat: 'D', reportNm, reportNmTemp: reportNm, searchCorpName: corp,
      fromDate: from, toDate: to, searchCodeType: '', repIsuSrtCd: '', isurCd: '', AKCKwdCode: '',
    });
    const t = await (await kindFetch(`${KIND}/disclosure/details.do`, {
      method: 'POST', body: q,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', Referer: `${KIND}/disclosure/details.do?method=searchDetailsMain` },
    })).text();
    let n = 0;
    for (const tr of t.split(/<tr[\s>]/).slice(1)) {
      const rcp = tr.match(/openDisclsViewer\('(\d+)'/)?.[1];
      if (!rcp) continue;
      n++;
      const tds = tr.split(/<td/);
      rows.push({
        dt: (tr.match(/(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}/) || [])[1],
        mk: tr.match(/alt='(유가증권|코스닥|코넥스)'/)?.[1] || '',
        nm: decodeHtml(tds[3]?.match(/title='([^']*)'/)?.[1]?.trim() || ''),
        delisted: /alt='상장폐지'/.test(tds[3] || ''),
        title: decodeHtml(tds[4]?.match(/title='([^']*)'/)?.[1] || ''),
        rcp,
      });
    }
    if (n < 100) break;
  }
  return rows;
}
async function kindBody(rcp) {
  const v = await (await kindFetch(`${KIND}/common/disclsviewer.do?method=search&acptno=${rcp}&docno=&viewerhost=&viewerport=`)).text();
  const doc = v.match(/value=["'](\d{14})\|/)?.[1];
  if (!doc) throw new Error('KIND 본문 없음 ' + rcp);
  const c = await (await kindFetch(`${KIND}/common/disclsviewer.do?method=searchContents&docNo=${doc}`)).text();
  const p = c.match(/setPath\('[^']*','([^']+)'/)?.[1];
  if (!p) throw new Error('KIND 본문 경로 없음 ' + rcp);
  const buf = Buffer.from(await (await kindFetch(p)).arrayBuffer());
  let h = new TextDecoder('utf-8').decode(buf);
  if (h.includes('�')) h = new TextDecoder('euc-kr').decode(buf);
  return decodeHtml(h.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// ---------- Naver ----------
async function retry(fn) {
  for (let i = 0; i < 4; i++) {
    try { return await fn(); } catch (e) { if (i === 3) throw e; await sleep(1000 * (i + 1)); }
  }
}
async function dailyChart(code, from) {
  const end = today().replace(/-/g, '') + '2359';
  const j = await retry(async () => {
    const r = await fetch(`https://api.stock.naver.com/chart/domestic/item/${code}/day?startDateTime=${from.replace(/-/g, '')}0000&endDateTime=${end}`, { headers: UA, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('naver ' + r.status);
    return r.json();
  });
  return (j || []).map(x => [ymd(x.localDate), x.closePrice]);
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

const RELATED = /유상증자|무상증자|전환사채|신주인수권|교환사채|최대주주|경영권|자기주식|주식소각|합병|분할|공급계약|단일판매|주식병합|감자|양수도|양수결정|양도결정|타법인주식/;

// ---------- 캐시 ----------
function loadCache(root) {
  const f = path.join(root, 'data', 'kind-cache.json');
  let c = { events: {}, reason: {}, related: {}, kindOk: null };
  if (fs.existsSync(f)) c = { ...c, ...JSON.parse(fs.readFileSync(f, 'utf8')) };
  const seed = path.join(root, 'data', 'kind-seed.json');
  if (fs.existsSync(seed)) {
    for (const [d, m, nm, x, t, rcp] of JSON.parse(fs.readFileSync(seed, 'utf8')))
      c.events[rcp] ||= { d, m, nm, x, t };
  }
  return { c, save: () => fs.writeFileSync(f, JSON.stringify(c)) };
}

/**
 * @param {object} p
 * @param {string} p.root  repo root
 * @param {Record<string, any[]>} p.lists  naver marketValue lists by market
 * @param {(code:string)=>Promise<object>} p.details  {sector,big,pbr,hi,lo,years,fin}
 */
export async function buildHistory({ root, lists, details }) {
  const T = today();
  const { c: cache, save } = loadCache(root);

  // 1) KIND에서 새 공시 받기 (실패하면 캐시만 사용)
  try {
    await kindSession();
    const from = cache.kindOk ? addDays(cache.kindOk, -7) : START;
    const rows = await kindSearch({ reportNm: '관리종목', from, to: T });
    console.log('KIND 관리종목 공시', rows.length, 'from', from);
    for (const r of rows) {
      if (/우선주|종류주식|ETF|SPAC/.test(r.title) || cache.events[r.rcp]) continue;
      const m = r.mk === '유가증권' ? 0 : 1;
      let t = null;
      if (/시가총액/.test(r.title)) t = /해제/.test(r.title) ? 'R' : /우려/.test(r.title) ? 'W' : 'D';
      else if (/^관리종목지정(해제)?$/.test(r.title)) {
        if (!(r.rcp in cache.reason)) {
          const body = await kindBody(r.rcp);
          if (!body) throw new Error('빈 본문 ' + r.rcp);
          cache.reason[r.rcp] = /지정사유\s*-\s*시가총액 미달/.test(body) ? 'D'
            : /해제사유[^4]*시가총액/.test(body) ? 'R' : '';
        }
        t = cache.reason[r.rcp] || null;
      }
      if (t) cache.events[r.rcp] = { d: r.dt, m, nm: r.nm, x: r.delisted ? 1 : 0, t };
    }
    // 상장폐지 표시는 나중에 붙으므로 최근 목록 기준으로 갱신
    for (const r of rows) if (cache.events[r.rcp] && r.delisted) cache.events[r.rcp].x = 1;
    cache.kindOk = T;
  } catch (e) {
    console.error('KIND 조회 실패, 캐시 사용:', e.message);
  }
  save();

  // 종목명 → 현재 상장 종목
  const byName = {}, byCode = {};
  for (const [mk, arr] of Object.entries(lists)) for (const s of arr) {
    if (s.stockEndType === 'stock' && s.itemCode.endsWith('0')) {
      byName[s.stockName] = { ...s, market: mk };
      byCode[s.itemCode] = { ...s, market: mk };
    }
  }

  const groups = {};
  for (const [rcp, e] of Object.entries(cache.events)) (groups[e.nm] ||= []).push({ ...e, rcp });

  const cases = {};
  for (const [nm, es] of Object.entries(groups)) {
    const s = byName[nm];
    if (!s || es.some(e => e.x)) continue; // 상장폐지되었거나 현재 목록에 없음
    es.sort((a, b) => (a.d < b.d ? -1 : 1));
    const eps = [];
    for (const w of es.filter(e => e.t === 'W')) {
      const desig = es.find(e => e.t === 'D' && e.d > w.d && e.d <= addDays(w.d, 14));
      if (!desig && w.d <= addDays(T, -10)) eps.push({ kind: 'warn', d: w.d });
    }
    for (const r of es.filter(e => e.t === 'R')) eps.push({ kind: 'release', d: r.d });
    if (!eps.length) continue;
    eps.sort((a, b) => (a.d < b.d ? -1 : 1));
    const lastD = [...es].reverse().find(e => e.t === 'D');
    const lastR = [...es].reverse().find(e => e.t === 'R');
    const lastW = [...es].reverse().find(e => e.t === 'W');
    let status = 'ok';
    if (lastD && (!lastR || lastR.d < lastD.d)) status = 'designated';
    else if (lastW && lastW.d > addDays(T, -10)) status = 'warned';
    cases[s.itemCode] = {
      c: s.itemCode, n: nm, m: s.market === 'KOSPI' ? 0 : 1, src: 'kind', status, eps,
      ev: es.map(e => ({ d: e.d, t: e.t, rcp: e.rcp })),
    };
  }
  console.log('공식 회복 사례', Object.keys(cases).length);

  // 2) 추정: 코스피 전 기간, 코스닥 2025년까지
  const universe = [];
  for (const [mk, arr] of Object.entries(lists)) for (const s of arr) {
    if (s.stockEndType !== 'stock' || !s.itemCode.endsWith('0') || /스팩|클래스|리츠/.test(s.stockName)) continue;
    if (+s.marketValueRaw > 3e11) continue;
    universe.push({ s, m: mk === 'KOSPI' ? 0 : 1 });
  }
  const charts = {};
  await pool(universe, 6, async ({ s, m }) => {
    const ch = await dailyChart(s.itemCode, START).catch(() => []);
    if (ch.length < 20) return;
    charts[s.itemCode] = ch;
    if (cases[s.itemCode]) return;
    const officialD = (groups[s.stockName] || []).filter(e => e.t === 'D').map(e => e.d);
    const shares = +s.marketValueRaw / +s.closePriceRaw;
    const eps = [];
    let run = [];
    for (let i = 0; i < ch.length; i++) {
      const [d, c] = ch[i];
      const covered = m === 1 && d >= '2026-01-01'; // 코스닥 2026년은 공식 경고 공시로 판단
      const below = !covered && (c * shares) / 1e8 < mcapLimitAt(d, m);
      if (below) { run.push(d); continue; }
      // 10~29거래일 미달 후 회복. 30일 이상이면 원래 지정됐어야 하므로 추정 오류로 보고 버린다.
      if (run.length >= 10 && run.length < 30) {
        const from = run[0], to = run[run.length - 1];
        const desig = officialD.some(x => x >= from && x <= addDays(to, 20));
        if (!desig) eps.push({ kind: 'est', from, to, d: d, days: run.length });
      }
      run = [];
    }
    if (eps.length) cases[s.itemCode] = { c: s.itemCode, n: s.stockName, m, src: 'est', status: 'ok', eps, ev: [] };
  });
  // 공식 지정 기록이 있는 종목은 추정 사례에서 상태 표시
  for (const c of Object.values(cases)) {
    if (c.src !== 'est') continue;
    const g = groups[c.n] || [];
    const lastD = [...g].sort((a, b) => (a.d < b.d ? -1 : 1)).reverse().find(e => e.t === 'D');
    if (lastD) { c.status = 'designated'; c.ev = g.map(e => ({ d: e.d, t: e.t, rcp: e.rcp })); }
  }
  console.log('전체 사례(추정 포함)', Object.keys(cases).length);

  // 3) 재무, 차트, 관련 공시 + 매출 기준 확인
  const out = [];
  let relFetched = 0;
  const list = Object.values(cases);
  await pool(list, 4, async (c) => {
    const s = byCode[c.c];
    const det = await details(c.c);
    const first = c.src === 'kind' ? c.ev[0].d : c.eps[0].from;
    const lastEp = c.eps[c.eps.length - 1];
    const recDate = lastEp.d;
    const yr = +first.slice(0, 4) - 1; // 당시 직전 회계연도
    const yi = det.years.findIndex(k => +k.slice(0, 4) === yr);
    const revAt = yi >= 0 ? det.fin['매출액']?.[yi] : null;
    if (revAt == null || revAt < revLimitAt(first, c.m)) return;
    const ch = charts[c.c] || await dailyChart(c.c, START).catch(() => []);
    const fromIdx = Math.max(0, ch.findIndex(([d]) => d >= addDays(first, -150)));
    const series = ch.slice(fromIdx);
    c.revAt = revAt; c.revYear = String(yr); c.first = first; c.recDate = recDate;
    c._s = s; c._det = det; c._series = series;
    out.push(c);
  });

  // 관련 공시: 캐시 우선, 없으면 KIND에서 천천히
  for (const c of out.sort((a, b) => (a.src === 'kind' ? -1 : 1))) {
    const key = `${c.c}|${c.first}|${c.recDate}`;
    if (!cache.related[key] && !kindBlocked && relFetched < MAX_RELATED_FETCH) {
      try {
        if (!cookie) await kindSession();
        const rel = await kindSearch({ corp: c.n, from: addDays(c.first, -60), to: addDays(c.recDate, 30) });
        cache.related[key] = rel.filter(r => r.nm === c.n && RELATED.test(r.title) && !/관리종목/.test(r.title))
          .slice(0, 15).map(r => ({ d: r.dt, title: r.title, rcp: r.rcp }));
        relFetched++;
      } catch (e) { console.error('관련 공시 실패', c.n, e.message); }
    }
    c.related = cache.related[key] || null;
  }
  save();

  const result = out.map(c => {
    const { _s: s, _det: det, _series: series } = c;
    const priceAt = d => { let p = null; for (const [x, v] of series) { if (x <= d) p = v; else break; } return p; };
    const after = (d, n) => { const i = series.findIndex(([x]) => x > d); return i < 0 ? null : series[Math.min(series.length - 1, i + n - 1)][1]; };
    const lastEp = c.eps[c.eps.length - 1];
    const base = lastEp.kind === 'est' ? priceAt(lastEp.to) : priceAt(lastEp.d);
    const later = after(lastEp.d, 10);
    return {
      c: c.c, n: c.n, m: c.m, src: c.src, status: c.status, eps: c.eps, ev: c.ev,
      sec: det.sector, b: det.big, first: c.first, recDate: c.recDate,
      thr: mcapLimitAt(c.first, c.m), revYear: c.revYear, revAt: c.revAt,
      p: +s.closePriceRaw, ch: +s.fluctuationsRatio, mc: Math.round(+s.marketValueRaw / 1e7) / 10,
      shares: +s.marketValueRaw / +s.closePriceRaw,
      y: det.years.map(k => k.slice(0, 4) + '.' + k.slice(4)),
      rv: det.fin['매출액'] || [], op: det.fin['영업이익'] || [], ni: det.fin['당기순이익'] || [],
      db: (det.fin['부채비율'] || []).at(-1) ?? null, pbr: det.pbr, hi: det.hi, lo: det.lo,
      st: s.tradeStopType?.name !== 'TRADING' ? 1 : 0,
      move: base && later ? Math.round((later / base - 1) * 1000) / 10 : null,
      chart: { d: series.map(x => +x[0].replace(/-/g, '')), c: series.map(x => x[1]) },
      related: c.related,
    };
  });
  result.sort((a, b) => (a.recDate < b.recDate ? 1 : -1));
  console.log('최종 사례', result.length, '관련공시 새로 받음', relFetched, kindBlocked ? '(KIND 차단됨)' : '');
  return { asOf: new Date().toISOString(), kindOk: cache.kindOk, cases: result };
}
