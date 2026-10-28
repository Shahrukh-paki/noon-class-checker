type Row = Record<string, unknown>;
type DenoLike = {
  env: { get(key: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): unknown;
};

const deno = (globalThis as unknown as { Deno: DenoLike }).Deno;

const AUTO_STATES = ["joined", "not_joined", "camera_off"];
const AUTO_REWRITE_MS = 4 * 60 * 1000;
const MAX_ITEMS = 300;
const MAX_BODY_BYTES = 120_000;
const MAX_SESSION_CHARS = 100_000;
const TOKEN_CACHE_MS = 60_000;
const TT_GRADES = new Set(["AF", "KG", "1", "2", "3", "4", "5T1", "5T2", "6", "7T1", "7T2", "NF"]);
const SESSION_KINDS = new Set(["lecture", "quran"]);
const CODE_SHIFT_GRADE = /-S(\d+)-G([A-Z0-9]+)-R/i;
const STATE_ROW = "noon_checker_state?id=eq.1";

const SUPABASE_URL = (deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const SERVICE_KEY = deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fail = (status: number, message: string) => json(status, { success: false, message });
const enc = encodeURIComponent;
const quoted = (values: string[]) => values.map((v) => `"${v.replace(/["\\]/g, "")}"`).join(",");

class DbError extends Error {
  constructor(public status: number, public body: string) {
    super(`database ${status}: ${body.slice(0, 200)}`);
  }
}

async function sb(path: string, init: { method?: string; body?: unknown; prefer?: string } = {}): Promise<Row[]> {
  const headers: Record<string, string> = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
  };
  if (init.prefer) headers.Prefer = init.prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (!res.ok) throw new DbError(res.status, text);
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

let archivedColumn: boolean | null = null;
async function activeCohorts(pathAndQuery: string): Promise<Row[]> {
  if (archivedColumn !== false) {
    try {
      const rows = await sb(`${pathAndQuery}&archived=is.false`);
      archivedColumn = true;
      return rows;
    } catch (e) {
      if (!(e instanceof DbError) || !/42703|archived/.test(e.body)) throw e;
      archivedColumn = false;
    }
  }
  return sb(pathAndQuery);
}

const cohortTable = (campus: string) => (campus.trim().toUpperCase().startsWith("NSSE") ? "nsse_cohorts" : "cohorts");

const pkToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const ttGrade = (g: unknown) => String(g ?? "").trim().toUpperCase();

function classOf(c: Row): { shift: number; grade: string } | null {
  const m = CODE_SHIFT_GRADE.exec(String(c.cohort_code ?? ""));
  const own = c.shift == null || c.shift === "" ? NaN : Number(c.shift);
  const shift = Number.isInteger(own) ? own : m ? Number(m[1]) : NaN;
  const grade = [ttGrade(c.grade), m ? ttGrade(m[2]) : ""].find((g) => TT_GRADES.has(g) || g === "8") ?? "";
  return Number.isInteger(shift) && grade ? { shift, grade } : null;
}

async function timetableNow(): Promise<((c: Row) => number | null) | null> {
  const slots = await sb("rpc/lectures_at", { method: "POST", body: { p_ts: new Date().toISOString() } });
  const closed = new Set(slots.filter((s) => s.grade === "*").map((s) => Number(s.shift)));
  const live = slots.filter((s) => SESSION_KINDS.has(String(s.kind)) && s.grade !== "*" && !closed.has(Number(s.shift)));
  const keys = new Set(live.map((s) => `${Number(s.shift)}|${ttGrade(s.grade)}`));
  const listed = new Set(slots.filter((s) => s.grade !== "*").map((s) => `${Number(s.shift)}|${ttGrade(s.grade)}`));
  const liveShifts = new Set(live.map((s) => Number(s.shift)));
  return (c: Row) => {
    const k = classOf(c);
    if (!k) return null;
    if (!TT_GRADES.has(k.grade)) return 0;
    const key = `${k.shift}|${k.grade}`;
    if (keys.has(key)) return 1;
    return !listed.has(key) && liveShifts.has(k.shift) ? 1 : 0;
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

let tokenHashCache: { value: string; at: number } | null = null;
async function expectedTokenHash(): Promise<string> {
  if (tokenHashCache && Date.now() - tokenHashCache.at < TOKEN_CACHE_MS) return tokenHashCache.value;
  const [row] = await sb(`${STATE_ROW}&select=token_hash`);
  const value = String(row?.token_hash ?? "").trim().toLowerCase();
  tokenHashCache = { value, at: Date.now() };
  return value;
}

async function tokenOk(given: string | null): Promise<boolean> {
  const expected = await expectedTokenHash();
  if (!/^[0-9a-f]{64}$/.test(expected) || !given) return false;
  return sameText(await sha256Hex(given), expected);
}

async function saveState(fields: Row) {
  await sb("noon_checker_state?on_conflict=id", {
    method: "POST",
    body: { id: 1, ...fields },
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}

type Item = { campus_name: string; cohort_code: string; state: string };
type Rejected = { cohort_code: string; reason: string };

async function resolveRoom(campus: string, room: string, grade: string, cache: Map<string, Row[]>, inSession: () => Promise<((c: Row) => number | null) | null>) {
  const key = `${campus.toLowerCase()}|${room}`;
  if (!cache.has(key)) {
    const table = cohortTable(campus);
    const base = `${table}?select=campus_name,cohort_code,shift,grade,room&room=eq.${enc(room)}`;
    let rows = await activeCohorts(`${base}&campus_name=eq.${enc(campus)}`);
    if (!rows.length && !/[*%_\\,()]/.test(campus)) rows = await activeCohorts(`${base}&campus_name=ilike.${enc(campus)}`);
    cache.set(key, rows);
  }
  let options = (cache.get(key) ?? []).filter((c) => c && c.cohort_code);
  if (grade) options = options.filter((c) => ttGrade(c.grade) === grade);
  if (options.length > 1) {
    const tt = await inSession();
    if (tt) options = options.filter((c) => tt(c) === 1);
  }
  return options;
}

async function ingest(body: Row) {
  const items = Array.isArray(body.items) ? (body.items as Row[]) : null;
  if (!items) return fail(400, "items is required");
  if (items.length > MAX_ITEMS) return fail(400, `At most ${MAX_ITEMS} items per request`);
  const today = pkToday();
  const seenAt = new Date();
  const clean: Item[] = [];
  const rejected: Rejected[] = [];
  const cache = new Map<string, Row[]>();
  let tt: ((c: Row) => number | null) | null | undefined;
  const inSession = async () => {
    if (tt === undefined) tt = await timetableNow().catch(() => null);
    return tt;
  };

  for (const it of items) {
    const campus = String(it?.campus_name ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    let code = String(it?.cohort_code ?? "").trim().slice(0, 120);
    const state = String(it?.state ?? "");
    const room = String(it?.room ?? "").trim();
    const grade = ttGrade(it?.grade);
    if (!campus || (!code && !/^\d{1,3}$/.test(room)) || !AUTO_STATES.includes(state)) {
      rejected.push({ cohort_code: code || `${campus} R${room}`, reason: "invalid" });
      continue;
    }
    let campusName = campus;
    if (!code) {
      const options = await resolveRoom(campus, room, grade, cache, inSession);
      if (options.length !== 1) {
        rejected.push({ cohort_code: `${campus} R${room}`, reason: options.length ? "ambiguous_room" : "no_class_in_session" });
        continue;
      }
      code = String(options[0].cohort_code);
      campusName = String(options[0].campus_name ?? campus);
    }
    clean.push({ campus_name: campusName, cohort_code: code, state });
  }

  const valid = new Set<string>();
  for (const campus of [...new Set(clean.map((c) => c.campus_name))]) {
    const codes = clean.filter((c) => c.campus_name === campus).map((c) => c.cohort_code);
    const rows = await sb(`${cohortTable(campus)}?select=cohort_code&campus_name=eq.${enc(campus)}&cohort_code=in.(${enc(quoted(codes))})`);
    for (const r of rows) valid.add(`${campus}|${r.cohort_code}`);
  }
  const known = new Map<string, Item>();
  for (const c of clean) {
    const key = `${c.campus_name}|${c.cohort_code}`;
    if (!valid.has(key)) rejected.push({ cohort_code: c.cohort_code, reason: "unknown_room" });
    else if (!known.has(key) || c.state === "joined") known.set(key, c);
  }

  let unchanged = 0;
  const toWrite: Row[] = [];
  if (known.size) {
    const campuses = [...new Set([...known.values()].map((k) => k.campus_name))];
    const existing = await sb(`class_connection_auto?select=campus_name,cohort_code,state,seen_at&status_date=eq.${today}&campus_name=in.(${enc(quoted(campuses))})&limit=5000`);
    const have = new Map(existing.map((e) => [`${e.campus_name}|${e.cohort_code}`, e]));
    for (const [key, c] of known) {
      const prev = have.get(key);
      if (prev && prev.state === c.state && seenAt.getTime() - new Date(String(prev.seen_at)).getTime() < AUTO_REWRITE_MS) {
        unchanged++;
        continue;
      }
      toWrite.push({ ...c, lecture_start: null, status_date: today, seen_at: seenAt.toISOString(), source: "noon_checker" });
    }
    if (toWrite.length) {
      await sb("class_connection_auto?on_conflict=campus_name,cohort_code,status_date", {
        method: "POST",
        body: toWrite,
        prefer: "resolution=merge-duplicates,return=minimal",
      });
    }
  }
  const result = { received: items.length, written: toWrite.length, unchanged, rejected: rejected.length };
  await saveState({ last_run_at: seenAt.toISOString(), last_result: result }).catch(() => {});
  return json(200, { success: true, ...result, rejected_items: rejected.slice(0, 20) });
}

async function getSession() {
  const [row] = await sb(`${STATE_ROW}&select=session,session_updated_at,expired,expired_at`);
  return json(200, {
    success: true,
    session: row?.session ?? null,
    session_updated_at: row?.session_updated_at ?? null,
    expired: row?.expired ?? false,
  });
}

async function putSession(body: Row) {
  const session = body.session;
  if (typeof session !== "string" || session.length < 20 || session.length > MAX_SESSION_CHARS) return fail(400, "session must be text");
  try {
    const root = JSON.parse(session);
    if (!root || typeof root !== "object" || typeof root.connection !== "string") return fail(400, "session is not a Noon session");
  } catch {
    return fail(400, "session is not a Noon session");
  }
  await saveState({ session, session_updated_at: new Date().toISOString(), expired: false, expired_at: null });
  return json(200, { success: true });
}

async function sessionStatus(body: Row) {
  if (typeof body.expired !== "boolean") return fail(400, "expired must be true or false");
  const now = new Date().toISOString();
  await saveState(body.expired ? { expired: true, expired_at: now, last_run_at: now } : { expired: false, last_run_at: now });
  return json(200, { success: true });
}

deno.serve(async (req: Request) => {
  if (req.method !== "POST") return fail(405, "POST only");
  if (!SUPABASE_URL || !SERVICE_KEY) return fail(500, "Function is missing its Supabase settings");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return fail(413, "Body too large");
  try {
    if (!(await tokenOk(req.headers.get("x-monitor-token")))) return fail(401, "Not allowed");
  } catch {
    return fail(503, "Could not check the token. Try again.");
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return fail(413, "Body too large");
  let body: Row;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(400, "Body must be a JSON object");
    body = parsed as Row;
  } catch {
    return fail(400, "Body must be JSON");
  }
  try {
    switch (body.action) {
      case "ingest":
        return await ingest(body);
      case "get_session":
        return await getSession();
      case "put_session":
        return await putSession(body);
      case "session_status":
        return await sessionStatus(body);
      default:
        return fail(400, "Unknown action");
    }
  } catch (e) {
    console.error(`action ${String(body.action)} failed: ${e instanceof DbError ? e.status : "error"}`);
    return fail(500, "Server error");
  }
});
