const NOON_BASE = 'https://teacher.noonacademy.com';
const SCHEDULE_URL = `${NOON_BASE}/dashboard/schedule`;
const CLASSROOM_URL = id => `${NOON_BASE}/classroom/${id}`;
const SEED_URL = `${NOON_BASE}/__noon_checker_seed`;
const SESSIONS_API_PART = '/school/schedules/sessions';
const SESSION_KEY = 'persist:root';
const PKT_OFFSET_MS = 5 * 3600 * 1000;
const SAVE_SESSION_EVERY_MS = 15 * 60 * 1000;
const PANEL_WAIT_SECONDS = 45;

const DEFAULT_ALIASES = {
  'g.yaseen': 'Gulshan Yaseen',
  'muhafiz twn': 'Muhafiz Town',
  'naeem twn': 'Naeem Town',
  'thokar': 'Thokar Niaz Baig',
};

const STATE_RANK = { joined: 3, camera_off: 2, not_joined: 1 };
const EXIT_SELECTOR = '[data-testid="exitClass"], [aria-label="action-exit-class"]';
const FORBIDDEN_TEXT = /exit|leave|end|setting|bug|report|mic|camera|mute/i;
const FORBIDDEN_ATTR = /exit|leave|setting|bug|report|mic|camera|mute|video|audio/i;
const JOIN_TEXT = /^\s*join(\s+(live|now|class|the class))?\s*$/i;
const SIGN_IN_PATH = /welcome|login|log-in|sign-?in|signup|auth/i;

const JS_READ_PANEL = `(() => {
  const HDR = /^(.+?)\\s*\\((\\d+)\\)\\s*$/;
  const rows = [...document.querySelectorAll('div[style*="position: absolute"][style*="width: 310px"]')]
    .map(r => ({ el: r, top: parseFloat(r.style.top || '0') }))
    .sort((a, b) => a.top - b.top);
  const rooms = [];
  let cur = null;
  for (const { el, top } of rows) {
    const texts = [...el.querySelectorAll('div[dir="auto"]')].map(d => (d.innerText || '').trim()).filter(Boolean);
    const first = texts[0] || '';
    if (HDR.test(first) && !/^view\\s+\\d+/i.test(first)) {
      const m = first.match(HDR);
      cur = { title: m[1].trim(), count: parseInt(m[2], 10), top, video: false, camOff: false, notJoined: false, tile: false };
      rooms.push(cur);
      continue;
    }
    if (!cur) continue;
    const all = texts.join(' | ');
    if (/presenter hasn.t joined/i.test(all)) cur.notJoined = true;
    if (el.querySelector('[id^="agora-video-player"], video')) cur.video = true;
    const paths = [...el.querySelectorAll('svg path')].map(p => p.getAttribute('d') || '');
    if (paths.some(d => d.startsWith('M10.66 6H14'))) cur.camOff = true;
    if (!texts.length && el.querySelector('svg, img')) cur.tile = true;
  }
  const parent = rows.length ? rows[0].el.parentElement : null;
  return {
    rooms,
    listHeight: parent ? parseFloat(parent.style.height || '0') : 0,
    maxTop: rows.length ? rows[rows.length - 1].top : 0,
    hasExit: !!document.querySelector('${EXIT_SELECTOR.replace(/'/g, "\\'")}'),
  };
})()`;

const JS_SCROLL_PANEL = toTop => {
  const r = document.querySelector('div[style*="position: absolute"][style*="width: 310px"]');
  if (!r) return false;
  let s = r.parentElement;
  while (s && s !== document.body) {
    const o = getComputedStyle(s).overflowY;
    if (/(auto|scroll)/.test(o) && s.scrollHeight > s.clientHeight + 5) break;
    s = s.parentElement;
  }
  if (!s || s === document.body) return false;
  if (toTop) { s.scrollTop = 0; return true; }
  const before = s.scrollTop;
  s.scrollTop = before + s.clientHeight * 0.8;
  return s.scrollTop > before;
};

const BLOCK_MEDIA = () => {
  const deny = () => Promise.reject(new DOMException('Camera and microphone are blocked', 'NotAllowedError'));
  try {
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = deny;
      navigator.mediaDevices.getDisplayMedia = deny;
    }
  } catch {}
};

export const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

export function parseRoomTitle(title) {
  const m = /^(.+?)\s*-\s*R(?:oom)?\s*(\d+)\s*$/i.exec(String(title ?? '').trim());
  return m ? [m[1].trim(), Number(m[2])] : [null, null];
}

export function roomState(r) {
  if (r.notJoined) return 'not_joined';
  if (r.video) return 'joined';
  if (r.camOff || r.tile) return 'camera_off';
  return 'unknown';
}

export function campusName(noonName, aliases) {
  const n = norm(noonName);
  const map = Object.fromEntries(Object.entries(aliases || {}).map(([k, v]) => [norm(k), v]));
  return map[n] || String(noonName).replace(/\s+/g, ' ').trim();
}

export function buildItems(panelRooms, aliases) {
  const best = new Map();
  for (const r of panelRooms || []) {
    const [noonCampus, room] = parseRoomTitle(r.title);
    if (noonCampus === null) continue;
    const state = roomState(r);
    if (!(state in STATE_RANK)) continue;
    const campus = campusName(noonCampus, aliases);
    const key = `${norm(campus)}|${room}`;
    const prev = best.get(key);
    if (!prev || STATE_RANK[state] > STATE_RANK[prev.state]) best.set(key, { campus_name: campus, room, state });
  }
  return [...best.values()].sort((a, b) => a.campus_name.localeCompare(b.campus_name) || a.room - b.room);
}

export function liveSessions(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.sessions) ? data.sessions : [];
  const out = [];
  const seen = new Set();
  for (const s of list) {
    if (String(s?.courseSessionStatus ?? s?.status ?? '').toLowerCase() !== 'live') continue;
    const id = s.courseSessionId;
    if (!id || seen.has(String(id))) continue;
    seen.add(String(id));
    out.push({ id: String(id), courseId: s.courseId ?? s.course?.courseId ?? '', name: s.courseSessionName || s.course?.courseName || '' });
  }
  return out;
}

export function deadlineFrom(env, startMs = Date.now()) {
  const limits = [];
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(env.RUN_UNTIL_PKT || '').trim());
  if (m) {
    const pkNow = new Date(startMs + PKT_OFFSET_MS);
    const pkMidnightUtc = Date.UTC(pkNow.getUTCFullYear(), pkNow.getUTCMonth(), pkNow.getUTCDate()) - PKT_OFFSET_MS;
    limits.push(pkMidnightUtc + (Number(m[1]) * 60 + Number(m[2])) * 60000);
  }
  const mins = Number(env.MAX_MINUTES);
  if (Number.isFinite(mins) && mins > 0) limits.push(startMs + mins * 60000);
  if (!limits.length) limits.push(startMs + 30 * 60000);
  return Math.min(...limits);
}

export const isSignInUrl = url => {
  try {
    const u = new URL(url);
    return u.origin !== NOON_BASE || SIGN_IN_PATH.test(u.pathname);
  } catch { return true; }
};

export function looksLikeSession(value) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 200000) return false;
  try {
    const root = JSON.parse(value);
    return !!root && typeof root === 'object' && typeof root.connection === 'string' && /tokens/.test(root.connection);
  } catch { return false; }
}

const pkt = (ms = Date.now()) => new Date(ms + PKT_OFFSET_MS).toISOString().slice(11, 19);
const log = msg => console.log(`[${pkt()} PKT] ${msg}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeFunctionClient(url, token) {
  return async function call(action, payload = {}, tries = 3) {
    let lastErr;
    for (let i = 1; i <= tries; i++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-monitor-token': token },
          body: JSON.stringify({ action, ...payload }),
          signal: AbortSignal.timeout(30000),
        });
        const json = await res.json().catch(() => ({}));
        if (res.status === 401) throw Object.assign(new Error('Edge Function said 401 (CLASS_MONITOR_TOKEN does not match)'), { fatal: true });
        if (!res.ok) throw new Error(`Edge Function ${action} -> HTTP ${res.status} ${json?.message || ''}`.trim());
        return json;
      } catch (e) {
        lastErr = e;
        if (e.fatal) throw e;
        await sleep(2000 * i);
      }
    }
    throw lastErr;
  };
}

class Checker {
  constructor(env, call) {
    this.env = env;
    this.call = call;
    this.aliases = { ...DEFAULT_ALIASES, ...parseAliases(env.CAMPUS_ALIASES) };
    this.checkMs = Math.max(20, Number(env.CHECK_SECONDS) || 60) * 1000;
    this.deadline = deadlineFrom(env);
    this.logRooms = env.LOG_ROOMS === '1';
    this.lastSaved = '';
    this.lastSaveAt = 0;
  }

  async start() {
    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({
      headless: true,
      args: ['--use-fake-device-for-media-stream', '--mute-audio', '--no-first-run', '--disable-notifications',
        '--autoplay-policy=no-user-gesture-required'],
    });
    try {
      const cdp = await this.browser.newBrowserCDPSession();
      for (const name of ['camera', 'microphone']) {
        await cdp.send('Browser.setPermission', { permission: { name }, setting: 'denied', origin: NOON_BASE });
      }
    } catch (e) {
      log(`note: could not set camera/microphone to denied via the browser (${e.message}); the page-level block still applies`);
    }
    this.ctx = await this.browser.newContext({ permissions: [], viewport: { width: 1600, height: 1000 }, locale: 'en-US', timezoneId: 'Asia/Karachi' });
    await this.ctx.addInitScript(BLOCK_MEDIA);
    await this.ctx.route(SEED_URL, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>seed</title>' }));
    this.page = await this.ctx.newPage();
  }

  async seed(session) {
    await this.page.goto(SEED_URL, { waitUntil: 'domcontentloaded' });
    await this.page.evaluate(([k, v]) => { localStorage.clear(); localStorage.setItem(k, v); }, [SESSION_KEY, session]);
  }

  async loadSchedule() {
    let resolveData;
    const got = new Promise(r => { resolveData = r; });
    const onResponse = async res => {
      if (!res.url().includes(SESSIONS_API_PART) || res.request().method() !== 'GET' || res.status() !== 200) return;
      try { resolveData(await res.json()); } catch {}
    };
    this.page.on('response', onResponse);
    try {
      if (this.page.url().startsWith(SCHEDULE_URL)) await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      else await this.page.goto(SCHEDULE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        const data = await Promise.race([got, sleep(1000).then(() => undefined)]);
        if (data !== undefined) return { data };
        if (isSignInUrl(this.page.url())) {
          await sleep(3000);
          if (isSignInUrl(this.page.url())) return { signedOut: true };
        }
      }
      return { signedOut: isSignInUrl(this.page.url()) };
    } finally {
      this.page.off('response', onResponse);
    }
  }

  async signIn() {
    let stored = null;
    try {
      const r = await this.call('get_session');
      stored = typeof r?.session === 'string' && r.session ? r.session : null;
      log(`saved session from Supabase: ${stored ? `present (${stored.length} chars)` : 'none'}`);
    } catch (e) {
      if (e.fatal) throw e;
      log(`could not read the saved session (${e.message})`);
    }
    const fromSecret = String(this.env.NOON_SESSION || '').trim() || null;
    const candidates = [['saved', stored], ['NOON_SESSION secret', fromSecret]]
      .filter(([, v], i, arr) => v && arr.findIndex(([, w]) => w === v) === i);
    if (!candidates.length) return { ok: false, reason: 'No session: the NOON_SESSION secret is empty and nothing is saved in Supabase.' };
    for (const [label, value] of candidates) {
      if (!looksLikeSession(value)) { log(`${label} session does not look like a Noon session (wrong text copied?) - skipped`); continue; }
      await this.seed(value);
      const r = await this.loadSchedule();
      if (r.data !== undefined) {
        log(`signed in with the ${label} session`);
        await this.saveSession(true);
        return { ok: true, data: r.data };
      }
      log(`${label} session did not open the schedule (${r.signedOut ? 'sent to the sign-in page' : 'schedule did not load'})`);
      if (!r.signedOut) return { ok: false, reason: 'The schedule page did not load (Noon may be down). Will try again next run.', transient: true };
    }
    return { ok: false, reason: 'SESSION EXPIRED: Noon sent the checker to the sign-in page. Copy a fresh session into the NOON_SESSION secret (README step e).' };
  }

  async saveSession(force = false) {
    if (!force && Date.now() - this.lastSaveAt < SAVE_SESSION_EVERY_MS) return;
    try {
      const page = this.page && !this.page.isClosed() ? this.page : null;
      if (!page || isSignInUrl(page.url())) return;
      const value = await page.evaluate(k => localStorage.getItem(k), SESSION_KEY);
      if (!looksLikeSession(value)) { log('session save skipped: page has no valid session'); return; }
      this.lastSaveAt = Date.now();
      if (value === this.lastSaved) return;
      await this.call('put_session', { session: value });
      this.lastSaved = value;
      log(`session saved to Supabase (${value.length} chars)`);
    } catch (e) {
      if (e.fatal) throw e;
      log(`session save failed (${e.message}) - will retry`);
    }
  }

  async safeJoin(pg) {
    if (await pg.locator(EXIT_SELECTOR).count()) return false;
    const btn = pg.locator('button, [role="button"], div[tabindex="0"]').filter({ hasText: JOIN_TEXT }).first();
    if (!(await btn.count())) return false;
    const info = await btn.evaluate(el => ({
      text: (el.innerText || '').trim(),
      attrs: [el.getAttribute('data-testid'), el.getAttribute('aria-label'), el.id, el.getAttribute('title')].filter(Boolean).join(' '),
      exitInside: !!el.querySelector('[data-testid="exitClass"], [aria-label="action-exit-class"]'),
    })).catch(() => null);
    if (!info || !JOIN_TEXT.test(info.text) || FORBIDDEN_TEXT.test(info.text.replace(/^\s*join\s*/i, '')) || FORBIDDEN_ATTR.test(info.attrs) || info.exitInside) return false;
    if (await pg.locator(EXIT_SELECTOR).count()) return false;
    await btn.click({ timeout: 3000 }).catch(() => {});
    log(`    clicked Join ("${info.text}")`);
    return true;
  }

  async readFull(pg, info) {
    if (info.listHeight <= info.maxTop + 400) return info.rooms;
    const byTop = new Map();
    const merge = rooms => {
      for (const r of rooms) {
        const old = byTop.get(r.top);
        if (!old) { byTop.set(r.top, r); continue; }
        for (const k of ['video', 'camOff', 'notJoined', 'tile']) old[k] = old[k] || r[k];
      }
    };
    merge(info.rooms);
    await pg.evaluate(JS_SCROLL_PANEL, true);
    for (let i = 0; i < 200; i++) {
      await sleep(250);
      merge((await pg.evaluate(JS_READ_PANEL)).rooms);
      if (!(await pg.evaluate(JS_SCROLL_PANEL, false))) break;
    }
    await pg.evaluate(JS_SCROLL_PANEL, true);
    return [...byTop.keys()].sort((a, b) => a - b).map(t => byTop.get(t));
  }

  async readClass(session) {
    const pg = await this.ctx.newPage();
    try {
      await pg.goto(CLASSROOM_URL(session.id), { waitUntil: 'domcontentloaded', timeout: 60000 });
      let joined = false;
      for (let i = 0; i < PANEL_WAIT_SECONDS; i++) {
        if (isSignInUrl(pg.url())) throw Object.assign(new Error('sent to the sign-in page'), { signedOut: true });
        const info = await pg.evaluate(JS_READ_PANEL);
        if (info.rooms.length) return await this.readFull(pg, info);
        if (!info.hasExit && !joined) {
          joined = await this.safeJoin(pg);
          if (joined) { await sleep(4000); continue; }
        }
        await sleep(1000);
      }
      throw new Error('participants list not found');
    } finally {
      await pg.close().catch(() => {});
    }
  }

  async cycle() {
    const r = await this.loadSchedule();
    if (r.signedOut) return { signedOut: true };
    if (r.data === undefined) { log('schedule did not load this time - will retry'); return {}; }
    const live = liveSessions(r.data);
    if (!live.length) { log('no live classes right now'); return {}; }
    log(`live classes: ${live.length} (${live.map(s => `${s.name} [${s.id}]`).join(', ')})`);
    const all = [];
    for (const s of live) {
      if (Date.now() > this.deadline) break;
      let rooms = null;
      for (let attempt = 1; attempt <= 2 && rooms === null; attempt++) {
        try {
          rooms = await this.readClass(s);
        } catch (e) {
          if (e.signedOut) return { signedOut: true };
          log(`  ${s.name} [${s.id}] attempt ${attempt}: ${e.message}`);
        }
      }
      if (rooms === null) continue;
      const items = buildItems(rooms, this.aliases);
      const counts = items.reduce((c, it) => ({ ...c, [it.state]: (c[it.state] || 0) + 1 }), {});
      log(`  ${s.name} [${s.id}]: ${rooms.length} rooms in panel -> joined ${counts.joined || 0}, camera off ${counts.camera_off || 0}, not joined ${counts.not_joined || 0}`);
      if (this.logRooms) for (const it of items) log(`    ${it.campus_name} R${it.room}: ${it.state}`);
      all.push(...items);
    }
    const items = buildItems(all.map(it => ({ title: `${it.campus_name}-R${it.room}`, ...stateFlags(it.state) })), {});
    if (!items.length) return {};
    for (let i = 0; i < items.length; i += 300) {
      try {
        const out = await this.call('ingest', { items: items.slice(i, i + 300) });
        log(`sent ${Math.min(300, items.length - i)} rooms: written ${out.written}, unchanged ${out.unchanged}, rejected ${out.rejected}`);
        if (out.rejected && out.rejected_items?.length) log(`  rejected: ${out.rejected_items.map(x => `${x.cohort_code} (${x.reason})`).join(', ')}`);
      } catch (e) {
        if (e.fatal) throw e;
        log(`send failed: ${e.message}`);
      }
    }
    return {};
  }

  async markExpired(expired) {
    try { await this.call('session_status', { expired }); } catch (e) { log(`could not record session status (${e.message})`); }
  }

  async run() {
    log(`running until ${pkt(this.deadline)} PKT, a check every ${this.checkMs / 1000}s`);
    await this.start();
    const first = await this.signIn();
    if (!first.ok) {
      log(first.reason);
      if (!first.transient) await this.markExpired(true);
      return 1;
    }
    await this.markExpired(false);
    while (Date.now() < this.deadline) {
      const t0 = Date.now();
      let res = {};
      try {
        res = await this.cycle();
      } catch (e) {
        if (e.fatal) { log(e.message); return 1; }
        log(`check failed: ${e.message}`);
      }
      if (res.signedOut) {
        log('SESSION EXPIRED during the run: Noon sent the checker to the sign-in page. Redo README step e.');
        await this.markExpired(true);
        return 1;
      }
      await this.saveSession();
      const wait = this.checkMs - (Date.now() - t0);
      if (wait > 0 && Date.now() + wait < this.deadline) await sleep(wait);
      else if (wait > 0) break;
    }
    log('deadline reached');
    return 0;
  }

  async stop() {
    await this.saveSession(true).catch(() => {});
    await this.browser?.close().catch(() => {});
  }
}

function stateFlags(state) {
  return { video: state === 'joined', camOff: state === 'camera_off', notJoined: state === 'not_joined' };
}

function parseAliases(text) {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    log('CAMPUS_ALIASES is not valid JSON - ignored');
    return {};
  }
}

function selftest() {
  let fails = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fails++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
  };
  const R = (title, k = {}) => ({ title, video: false, camOff: false, notJoined: false, tile: false, ...k });

  console.log('Room titles:');
  check("'Kahna 2-R4'", parseRoomTitle('Kahna 2-R4'), ['Kahna 2', 4]);
  check("'Shadiwal Sawan - Room 5'", parseRoomTitle('Shadiwal Sawan - Room 5'), ['Shadiwal Sawan', 5]);
  check("'Kahna 2 - R3'", parseRoomTitle('Kahna 2 - R3'), ['Kahna 2', 3]);
  check("'Noon' is not a room", parseRoomTitle('Noon'), [null, null]);

  console.log('Room states:');
  check('camera on', roomState(R('A-R1', { video: true })), 'joined');
  check('camera off icon', roomState(R('A-R1', { camOff: true })), 'camera_off');
  check('empty tile', roomState(R('A-R1', { tile: true })), 'camera_off');
  check("presenter hasn't joined", roomState(R('A-R1', { notJoined: true })), 'not_joined');
  check('nothing readable', roomState(R('A-R1')), 'unknown');

  console.log('Campus aliases:');
  check("'G.Yaseen' -> Gulshan Yaseen", campusName('G.Yaseen', DEFAULT_ALIASES), 'Gulshan Yaseen');
  check("'Thokar' -> Thokar Niaz Baig", campusName('Thokar', DEFAULT_ALIASES), 'Thokar Niaz Baig');
  check("'Kahna  2' kept (spaces tidied)", campusName('Kahna  2', DEFAULT_ALIASES), 'Kahna 2');

  console.log('Items sent to the app:');
  const fullOk = [R('Kahna 2-R3', { video: true }), R('Khurrianwala-R2', { video: true }), R('Gulshan Yaseen-R8', { video: true }),
    R('Kamahan-R1', { video: true }), R('Kamahan-R2', { video: true })];
  check('all rooms connected', buildItems(fullOk, DEFAULT_ALIASES), [
    { campus_name: 'Gulshan Yaseen', room: 8, state: 'joined' }, { campus_name: 'Kahna 2', room: 3, state: 'joined' },
    { campus_name: 'Kamahan', room: 1, state: 'joined' }, { campus_name: 'Kamahan', room: 2, state: 'joined' },
    { campus_name: 'Khurrianwala', room: 2, state: 'joined' }]);
  const p2 = fullOk.map(x => (x.title === 'Khurrianwala-R2' ? R('Khurrianwala-R2', { notJoined: true }) : x));
  check("presenter hasn't joined -> not_joined", buildItems(p2, DEFAULT_ALIASES).find(i => i.campus_name === 'Khurrianwala'),
    { campus_name: 'Khurrianwala', room: 2, state: 'not_joined' });
  const p4 = fullOk.map(x => (x.title === 'Kamahan-R2' ? R('Kamahan-R2', { camOff: true }) : x));
  check('camera off -> camera_off', buildItems(p4, DEFAULT_ALIASES).find(i => i.room === 2 && i.campus_name === 'Kamahan'),
    { campus_name: 'Kamahan', room: 2, state: 'camera_off' });
  check("old style 'Kahna 2 - R3' merges with 'Kahna 2-R3'", buildItems([R('Kahna 2-R3', { notJoined: true }), R('Kahna 2 - R3', { video: true })], {}),
    [{ campus_name: 'Kahna 2', room: 3, state: 'joined' }]);
  check("alias duplicate 'G.Yaseen-R8' keeps best state", buildItems([R('Gulshan Yaseen-R8', { camOff: true }), R('G.Yaseen-R8', { video: true })], DEFAULT_ALIASES),
    [{ campus_name: 'Gulshan Yaseen', room: 8, state: 'joined' }]);
  check('unknown campus passed on (server decides)', buildItems([R('Mars Town-R1', { video: true })], DEFAULT_ALIASES),
    [{ campus_name: 'Mars Town', room: 1, state: 'joined' }]);
  check('untitled and unreadable rows skipped', buildItems([R('Noon', { video: true }), R('Kamahan-R7')], DEFAULT_ALIASES), []);
  check('same room number at two campuses kept apart', buildItems([R('Kamahan-R2', { notJoined: true }), R('Khurrianwala-R2', { video: true })], {}),
    [{ campus_name: 'Kamahan', room: 2, state: 'not_joined' }, { campus_name: 'Khurrianwala', room: 2, state: 'joined' }]);

  console.log('Schedule:');
  const sched = [
    { courseSessionId: 98042, courseId: 15018, courseSessionStatus: 'live', courseSessionName: 'D3-Grade 7 (new)' },
    { courseSessionId: 98043, courseId: 16955, courseSessionStatus: 'ended', courseSessionName: 'D2-Grade 7' },
    { courseSessionId: 98042, courseId: 15018, courseSessionStatus: 'LIVE', courseSessionName: 'dup' },
    { courseSessionId: null, courseSessionStatus: 'live' },
  ];
  check('only live sessions, no duplicates', liveSessions(sched), [{ id: '98042', courseId: 15018, name: 'D3-Grade 7 (new)' }]);
  check('wrapped in {data:[...]}', liveSessions({ data: sched }).length, 1);

  console.log('Run deadline:');
  const start = Date.UTC(2026, 9, 28, 2, 20);
  check('RUN_UNTIL_PKT 12:50 -> 07:50 UTC', new Date(deadlineFrom({ RUN_UNTIL_PKT: '12:50' }, start)).toISOString(), '2026-10-28T07:50:00.000Z');
  check('MAX_MINUTES 20 wins when earlier', new Date(deadlineFrom({ RUN_UNTIL_PKT: '12:50', MAX_MINUTES: '20' }, start)).toISOString(), '2026-10-28T02:40:00.000Z');
  check('nothing set -> 30 minutes', deadlineFrom({}, start) - start, 30 * 60000);

  console.log('Sign-in and session checks:');
  check('schedule page is signed in', isSignInUrl(SCHEDULE_URL), false);
  check('welcome page is signed out', isSignInUrl(`${NOON_BASE}/welcome`), true);
  check('Google page is signed out', isSignInUrl('https://accounts.google.com/o/oauth2'), true);
  check('session shape accepted', looksLikeSession(JSON.stringify({ connection: JSON.stringify({ deviceId: 'x', tokens: {} }), _persist: '{}' })), true);
  check('random text rejected', looksLikeSession('hello world, this is not it'), false);

  console.log('Join safety:');
  check("'Join' allowed", JOIN_TEXT.test('Join'), true);
  check("'Join LIVE' allowed", JOIN_TEXT.test('Join LIVE'), true);
  check("'Exit class' refused", JOIN_TEXT.test('Exit class'), false);
  check("'Join audio' refused", JOIN_TEXT.test('Join audio'), false);
  check('exit test id refused', FORBIDDEN_ATTR.test('exitClass'), true);
  check('mic label refused', FORBIDDEN_ATTR.test('action-toggle-mic'), true);

  console.log(`\nRESULT: ${fails ? `${fails} FAILED` : 'ALL PASSED'}`);
  return fails ? 1 : 0;
}

async function main() {
  if (process.argv.includes('--selftest')) process.exit(selftest());
  const url = String(process.env.CHECKER_FUNCTION_URL || '').trim();
  const token = String(process.env.CLASS_MONITOR_TOKEN || '').trim();
  if (!url || !token) {
    log('Missing CHECKER_FUNCTION_URL or CLASS_MONITOR_TOKEN (GitHub Secrets).');
    process.exit(2);
  }
  const checker = new Checker(process.env, makeFunctionClient(url, token));
  let stopping = false;
  const onSignal = async sig => {
    if (stopping) return;
    stopping = true;
    log(`${sig} received - saving the session and stopping`);
    await checker.stop();
    process.exit(0);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  let code = 1;
  try {
    code = await checker.run();
  } catch (e) {
    log(`stopped with an error: ${e.message}`);
  } finally {
    if (!stopping) await checker.stop();
  }
  process.exit(code);
}

main();
