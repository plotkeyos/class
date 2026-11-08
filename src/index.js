import { gradeRecording, graderConnected, graderTimeoutSeconds } from "./grader.js";

// ---------------------------------------------------------------------------
// Database schema (created and updated automatically on first request)
// ---------------------------------------------------------------------------

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS levels (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     sort_order INTEGER NOT NULL DEFAULT 0,
     active INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS students (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     level_id INTEGER,
     active INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL)`,
  // One row per school day: the material, which parts are on, the shared quiz,
  // and which sources each level reads.
  `CREATE TABLE IF NOT EXISTS days (
     date TEXT PRIMARY KEY,
     gemara TEXT, rashi TEXT, tosfos TEXT,
     parts TEXT,
     questions TEXT,
     level_sources TEXT,
     updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS retries (
     student_id INTEGER NOT NULL,
     date TEXT NOT NULL,
     extra INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (student_id, date))`,
  // One row per student per try. Everything the student saw is copied in,
  // so later edits to the day don't change old results.
  `CREATE TABLE IF NOT EXISTS attempts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     student_id INTEGER NOT NULL,
     student_name TEXT,
     date TEXT NOT NULL,
     level_id INTEGER,
     level_name TEXT,
     parts TEXT,
     sources TEXT,
     reading_parts TEXT,
     reading_text TEXT,
     quiz TEXT,
     submitted_at TEXT NOT NULL,
     recorded_at TEXT,
     audio_key TEXT,
     audio_type TEXT,
     audio_deleted INTEGER NOT NULL DEFAULT 0,
     duration_sec REAL,
     grading_status TEXT NOT NULL DEFAULT 'waiting',
     grading_note TEXT,
     ai_feedback TEXT,
     ai_score REAL,
     graded_at TEXT,
     rating_inside INTEGER,
     rating_outside INTEGER,
     hasmada INTEGER,
     ratings_at TEXT,
     quiz_answers TEXT,
     quiz_correct INTEGER,
     quiz_total INTEGER,
     quiz_percent INTEGER,
     quiz_at TEXT,
     completed_at TEXT,
     manual_feedback TEXT,
     manual_score REAL,
     manual_at TEXT,
     reading_id INTEGER,
     source_type TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_date ON attempts(date)`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_student_date ON attempts(student_id, date)`,
];

// Columns added after the first version. Databases created by the first
// version get them added automatically.
const ADDED_COLUMNS = {
  days: [["parts", "TEXT"], ["questions", "TEXT"], ["level_sources", "TEXT"]],
  attempts: [
    ["parts", "TEXT"], ["sources", "TEXT"], ["reading_parts", "TEXT"], ["recorded_at", "TEXT"],
    ["rating_inside", "INTEGER"], ["rating_outside", "INTEGER"], ["hasmada", "INTEGER"], ["ratings_at", "TEXT"],
    ["quiz_percent", "INTEGER"], ["completed_at", "TEXT"],
  ],
};

async function migrate(env) {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    const have = new Set(results.map((r) => r.name));
    for (const [name, type] of columns) {
      if (have.has(name)) continue;
      try {
        await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run();
      } catch (err) {
        if (!String(err && err.message).includes("duplicate column")) throw err;
      }
      if (table === "attempts" && name === "completed_at") {
        // Results saved by the first version count as finished.
        await env.DB.prepare(
          `UPDATE attempts SET
             completed_at = COALESCE(quiz_at, submitted_at),
             recorded_at = COALESCE(recorded_at, submitted_at),
             parts = COALESCE(parts, '{"reading":true,"ratings":false,"quiz":true}'),
             sources = COALESCE(sources, json_array(COALESCE(source_type, 'gemara'))),
             quiz_percent = CASE WHEN quiz_total > 0 THEN CAST(ROUND(quiz_correct * 100.0 / quiz_total) AS INTEGER) END
           WHERE completed_at IS NULL`
        ).run();
      }
    }
  }
}

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)))
      .then(() => migrate(env))
      .catch((err) => {
        schemaReady = null;
        throw err;
      });
  }
  return schemaReady;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RECORDING_SECONDS = 180;
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const RECORDING_KEEP_DAYS = 7;
const TEACHER_SESSION_HOURS = 12;
const DEVICE_SESSION_DAYS = 365;
const SOURCE_TYPES = ["gemara", "rashi", "tosfos"];
const DEFAULT_PARTS = { reading: true, ratings: true, quiz: true };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "The request wasn’t valid JSON.");
  }
}

function toId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function requireId(value, what = "id") {
  const n = toId(value);
  if (!n) throw new HttpError(400, `Missing or invalid ${what}.`);
  return n;
}

function cleanText(value, max = 20000) {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim().slice(0, max) : "";
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function isDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function dateInZone(tz, when = new Date()) {
  const zone = tz && validTimeZone(tz) ? tz : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(when);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function getSetting(env, key) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

async function setSetting(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, value).run();
}

async function getSigningKey(env) {
  let key = await getSetting(env, "signing_key");
  if (!key) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const fresh = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('signing_key', ?)").bind(fresh).run();
    key = await getSetting(env, "signing_key");
  }
  return key;
}

// ---------------------------------------------------------------------------
// Signed cookies (teacher session + unlocked iPads)
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(str) {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

async function fingerprint(value) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(`gemara-reader:${value}`));
  return b64url(new Uint8Array(digest)).slice(0, 22);
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function makeToken(env, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(await getSigningKey(env), body)}`;
}

async function readToken(env, token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = await hmac(await getSigningKey(env), body);
  if (!safeEqual(expected, sig)) return null;
  const payload = parseJson(fromB64url(body), null);
  if (!payload || (payload.exp && payload.exp < Date.now())) return null;
  return payload;
}

function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function cookieHeader(url, name, value, maxAgeSeconds) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function normalizeCode(code) {
  return String(code || "").trim().toLowerCase();
}

async function isTeacher(c) {
  if (!c.env.TEACHER_CODE) return false;
  const payload = await readToken(c.env, getCookie(c.request, "gr_teacher"));
  return Boolean(payload && payload.t === "teacher" && payload.f === (await fingerprint(c.env.TEACHER_CODE)));
}

async function isUnlockedDevice(c) {
  const classCode = await getSetting(c.env, "class_code");
  if (!classCode) return false;
  const payload = await readToken(c.env, getCookie(c.request, "gr_dev"));
  return Boolean(payload && payload.t === "dev" && payload.f === (await fingerprint(normalizeCode(classCode))));
}

// ---------------------------------------------------------------------------
// Day setup: material, parts, shared quiz, what each level reads
// ---------------------------------------------------------------------------

function normalizeParts(p) {
  if (!p || typeof p !== "object") return { ...DEFAULT_PARTS };
  return { reading: p.reading !== false, ratings: p.ratings !== false, quiz: p.quiz !== false };
}

function normalizeQuestions(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  for (let i = 0; i < 2; i++) {
    const q = list[i] || {};
    const choices = Array.isArray(q.choices) ? q.choices : [];
    const correct = Number(q.correct);
    out.push({
      q: cleanText(q.q, 2000),
      choices: [0, 1, 2].map((j) => cleanText(choices[j], 1000)),
      correct: q.correct !== null && q.correct !== undefined && [0, 1, 2].includes(correct) ? correct : null,
    });
  }
  return out;
}

function questionsComplete(questions) {
  return (
    Array.isArray(questions) &&
    questions.length === 2 &&
    questions.every((q) => q.q && q.choices.length === 3 && q.choices.every(Boolean) && [0, 1, 2].includes(q.correct))
  );
}

function normalizeSources(list) {
  const set = new Set(Array.isArray(list) ? list : []);
  return SOURCE_TYPES.filter((s) => set.has(s));
}

function normalizeLevelSources(obj) {
  const out = {};
  for (const [levelId, list] of Object.entries(obj && typeof obj === "object" ? obj : {})) {
    if (toId(levelId)) out[Number(levelId)] = normalizeSources(list);
  }
  return out;
}

async function loadDay(env, date) {
  const day = await env.DB.prepare("SELECT * FROM days WHERE date = ?").bind(date).first();
  let levelSources = day ? parseJson(day.level_sources, null) : null;
  let copiedFrom = null;
  if (!levelSources) {
    // Levels usually read the same parts every day, so start from the last day that was set.
    const prev = await env.DB.prepare(
      "SELECT date, level_sources FROM days WHERE date < ? AND level_sources IS NOT NULL ORDER BY date DESC LIMIT 1"
    ).bind(date).first();
    if (prev) {
      levelSources = parseJson(prev.level_sources, {});
      copiedFrom = prev.date;
    }
  }
  return {
    date,
    saved: Boolean(day),
    material: { gemara: day?.gemara || "", rashi: day?.rashi || "", tosfos: day?.tosfos || "" },
    parts: normalizeParts(day ? parseJson(day.parts, null) : null),
    questions: normalizeQuestions(day ? parseJson(day.questions, []) : []),
    level_sources: normalizeLevelSources(levelSources),
    sources_copied_from: copiedFrom,
    updated_at: day?.updated_at || null,
  };
}

// What a level reads on a day, and whether it's ready.
function readingForLevel(day, levelId) {
  const sources = day.level_sources[levelId] || [];
  const parts = sources.map((s) => ({ source: s, text: day.material[s] || "" }));
  const missing = parts.filter((p) => !p.text.trim()).map((p) => p.source);
  return { sources, parts, ready: sources.length > 0 && missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Attempts
// ---------------------------------------------------------------------------

function publicQuestions(quizJson) {
  return parseJson(quizJson, []).map((q) => ({ q: q.q, choices: q.choices }));
}

function quizDetail(a) {
  const quiz = parseJson(a.quiz, []);
  const answers = parseJson(a.quiz_answers, null);
  return quiz.map((q, i) => ({ q: q.q, choices: q.choices, correct: q.correct, answer: answers ? answers[i] : null }));
}

// A grading that never finished counts as "needs manual grading".
function staleCutoffIso(env) {
  return new Date(Date.now() - (graderTimeoutSeconds(env) + 300) * 1000).toISOString();
}

function effectiveStatus(env, a) {
  if ((a.grading_status === "pending" || a.grading_status === "grading") && (a.recorded_at || a.submitted_at) < staleCutoffIso(env)) {
    return "manual";
  }
  return a.grading_status;
}

async function getAttempt(env, id) {
  const a = await env.DB.prepare("SELECT * FROM attempts WHERE id = ?").bind(id).first();
  if (!a) throw new HttpError(404, "That attempt wasn’t found.");
  return a;
}

async function getActiveStudent(env, id) {
  const s = await env.DB.prepare("SELECT * FROM students WHERE id = ? AND active = 1").bind(id).first();
  if (!s) throw new HttpError(404, "That student isn’t on the list.");
  return s;
}

// The next thing the student has to do in this attempt.
function nextStep(a) {
  const parts = normalizeParts(parseJson(a.parts, null));
  if (parts.reading && !a.recorded_at) return "reading";
  if (parts.ratings && !a.ratings_at) return "ratings";
  if (parts.quiz && !a.quiz_at) return "quiz";
  return "finish";
}

function attemptState(a) {
  const step = nextStep(a);
  return {
    attempt_id: a.id,
    step,
    parts: normalizeParts(parseJson(a.parts, null)),
    reading: step === "reading" ? { parts: parseJson(a.reading_parts, []) } : null,
    questions: step === "quiz" ? publicQuestions(a.quiz) : null,
    grading_status: a.grading_status,
    max_seconds: MAX_RECORDING_SECONDS,
  };
}

// After each step: mark the attempt finished once every part that was on is done.
async function advance(env, id) {
  let a = await getAttempt(env, id);
  if (nextStep(a) === "finish" && !a.completed_at) {
    await env.DB.prepare("UPDATE attempts SET completed_at = ? WHERE id = ? AND completed_at IS NULL").bind(nowIso(), id).run();
    a = await getAttempt(env, id);
  }
  return attemptState(a);
}

async function requireOpenAttempt(env, id) {
  const a = await getAttempt(env, requireId(id, "attempt"));
  if (a.completed_at) throw new HttpError(409, "You already finished this. Tap Done.");
  return a;
}

async function todaysAttemptInfo(env, studentId, date) {
  const { results } = await env.DB.prepare(
    "SELECT id, completed_at FROM attempts WHERE student_id = ? AND date = ? ORDER BY id DESC"
  ).bind(studentId, date).all();
  const retry = await env.DB.prepare("SELECT extra FROM retries WHERE student_id = ? AND date = ?").bind(studentId, date).first();
  return {
    finished: results.filter((r) => r.completed_at).length,
    allowed: 1 + (retry ? retry.extra : 0),
    open: results.find((r) => !r.completed_at) || null,
  };
}

function hasProgress(a) {
  return Boolean(a.recorded_at || a.ratings_at || a.quiz_at);
}

function teacherAttemptView(env, a, full) {
  const parts = normalizeParts(parseJson(a.parts, null));
  const view = {
    id: a.id,
    student_id: a.student_id,
    student_name: a.current_name || a.student_name,
    date: a.date,
    level_name: a.level_name,
    parts,
    sources: parseJson(a.sources, []),
    submitted_at: a.submitted_at,
    completed_at: a.completed_at,
    completed: Boolean(a.completed_at),
    recorded: Boolean(a.recorded_at),
    duration_sec: a.duration_sec,
    grading_status: parts.reading ? (a.recorded_at ? effectiveStatus(env, a) : "waiting") : "none",
    grading_note: a.grading_note,
    ai_score: a.ai_score,
    manual_score: a.manual_score,
    has_ai_feedback: Boolean(a.ai_feedback),
    has_manual_feedback: Boolean(a.manual_feedback),
    rating_inside: a.rating_inside,
    rating_outside: a.rating_outside,
    hasmada: a.hasmada,
    ratings_done: Boolean(a.ratings_at),
    quiz_correct: a.quiz_correct,
    quiz_total: a.quiz_total,
    quiz_percent: a.quiz_percent,
    quiz_done: Boolean(a.quiz_at),
    audio_available: Boolean(a.audio_key) && !a.audio_deleted,
  };
  if (full) {
    view.reading_parts = parseJson(a.reading_parts, null) || (a.reading_text ? [{ source: (view.sources[0] || "gemara"), text: a.reading_text }] : []);
    view.ai_feedback = a.ai_feedback;
    view.manual_feedback = a.manual_feedback;
    view.quiz = quizDetail(a);
  }
  return view;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const routes = [];
function route(method, pattern, auth, handler) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; })}$`);
  routes.push({ method, re, keys, auth, handler });
}

async function handleApi(request, env, exec, url) {
  const match = routes.find((r) => r.method === request.method && r.re.test(url.pathname));
  if (!match) throw new HttpError(404, "Not found.");

  const values = url.pathname.match(match.re).slice(1);
  const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(values[i])]));
  const timezone = (await getSetting(env, "timezone")) || "UTC";
  const c = { request, env, exec, url, params, timezone, today: dateInZone(timezone) };

  if (match.auth === "teacher" && !(await isTeacher(c))) throw new HttpError(401, "Sign in to continue.");
  if (match.auth === "device" && !(await isUnlockedDevice(c))) throw new HttpError(403, "This iPad needs the class code.");

  const result = await match.handler(c);
  return result instanceof Response ? result : json(result);
}

// ---------------------------------------------------------------------------
// Student API
// ---------------------------------------------------------------------------

route("GET", "/api/student/session", "none", async (c) => {
  const classCode = await getSetting(c.env, "class_code");
  return { setup: Boolean(classCode), unlocked: classCode ? await isUnlockedDevice(c) : false, today: c.today };
});

route("POST", "/api/student/unlock", "none", async (c) => {
  const { code } = await readJson(c.request);
  const classCode = await getSetting(c.env, "class_code");
  if (!classCode) throw new HttpError(409, "Your teacher hasn’t set a class code yet.");
  if (normalizeCode(code) !== normalizeCode(classCode)) {
    await sleep(600);
    throw new HttpError(401, "That class code isn’t right. Check with your teacher.");
  }
  const token = await makeToken(c.env, {
    t: "dev",
    f: await fingerprint(normalizeCode(classCode)),
    exp: Date.now() + DEVICE_SESSION_DAYS * 86400000,
  });
  return json({ ok: true }, 200, { "set-cookie": cookieHeader(c.url, "gr_dev", token, DEVICE_SESSION_DAYS * 86400) });
});

route("GET", "/api/student/roster", "device", async (c) => {
  const { DB } = c.env;
  const students = (await DB.prepare("SELECT id, name FROM students WHERE active = 1 ORDER BY name COLLATE NOCASE").all()).results;
  const counts = (await DB.prepare(
    `SELECT student_id,
            SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN completed_at IS NULL AND (recorded_at IS NOT NULL OR ratings_at IS NOT NULL OR quiz_at IS NOT NULL)
                     THEN 1 ELSE 0 END) AS progress
       FROM attempts WHERE date = ? GROUP BY student_id`
  ).bind(c.today).all()).results;
  const retries = (await DB.prepare("SELECT student_id, extra FROM retries WHERE date = ?").bind(c.today).all()).results;

  const countBy = new Map(counts.map((r) => [r.student_id, r]));
  const extraBy = new Map(retries.map((r) => [r.student_id, r.extra]));
  return {
    today: c.today,
    students: students.map((s) => {
      const info = countBy.get(s.id);
      let status = "ready";
      if (info && info.progress > 0) status = "resume";
      else if (info && info.done >= 1 + (extraBy.get(s.id) || 0)) status = "done";
      return { id: s.id, name: s.name, status };
    }),
  };
});

route("POST", "/api/student/start", "device", async (c) => {
  const { env } = c;
  const { student_id } = await readJson(c.request);
  const student = await getActiveStudent(env, requireId(student_id, "student"));
  const info = await todaysAttemptInfo(env, student.id, c.today);

  const level = student.level_id
    ? await env.DB.prepare("SELECT id, name FROM levels WHERE id = ? AND active = 1").bind(student.level_id).first()
    : null;

  // Pick up where they left off.
  if (info.open) {
    const state = await advance(env, info.open.id);
    if (state.step !== "finish") {
      const a = await getAttempt(env, info.open.id);
      return { ...state, student: { id: student.id, name: student.name }, level: { id: a.level_id, name: a.level_name } };
    }
    info.finished += 1;
  }
  if (info.finished >= info.allowed) throw new HttpError(409, "You already finished today. Great job.");

  const day = await loadDay(env, c.today);
  const parts = day.parts;
  if (!parts.reading && !parts.ratings && !parts.quiz) throw new HttpError(409, "There’s nothing to do today.");

  let reading = { sources: [], parts: [] };
  if (parts.reading) {
    if (!level) throw new HttpError(409, "Your teacher hasn’t set your level yet. Let your teacher know.");
    reading = readingForLevel(day, level.id);
    if (!reading.ready) throw new HttpError(409, "Today’s reading for your level isn’t ready yet. Let your teacher know.");
  }
  if (parts.quiz && !questionsComplete(day.questions)) {
    throw new HttpError(409, "Today’s quiz isn’t ready yet. Let your teacher know.");
  }

  const readingText = reading.parts.map((p) => p.text).join("\n\n");
  const inserted = await env.DB.prepare(
    `INSERT INTO attempts (student_id, student_name, date, level_id, level_name, parts, sources, reading_parts,
       reading_text, quiz, submitted_at, grading_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    student.id, student.name, c.today, level ? level.id : null, level ? level.name : null,
    JSON.stringify(parts), JSON.stringify(reading.sources), JSON.stringify(reading.parts),
    readingText, parts.quiz ? JSON.stringify(day.questions) : null, nowIso(), parts.reading ? "waiting" : "none"
  ).run();

  const state = await advance(env, inserted.meta.last_row_id);
  return { ...state, student: { id: student.id, name: student.name }, level: level ? { id: level.id, name: level.name } : null };
});

route("POST", "/api/student/submit", "device", async (c) => {
  const { env } = c;
  let form;
  try {
    form = await c.request.formData();
  } catch {
    throw new HttpError(400, "The recording didn’t arrive. Try sending it again.");
  }
  const a = await requireOpenAttempt(env, form.get("attempt_id"));
  // Already received (e.g. the network sent it twice): just move on.
  if (a.recorded_at) return advance(env, a.id);
  if (!normalizeParts(parseJson(a.parts, null)).reading) throw new HttpError(409, "There’s no reading today.");

  const audio = form.get("audio");
  if (!audio || typeof audio === "string" || audio.size === 0) throw new HttpError(400, "The recording was empty. Record again.");
  if (audio.size > MAX_UPLOAD_BYTES) throw new HttpError(413, "The recording is too large.");

  const audioType = (audio.type || "audio/mp4").split(";")[0];
  const ext = audioType.includes("webm") ? "webm" : audioType.includes("ogg") ? "ogg" : "m4a";
  const key = `recordings/${a.date}/${a.student_id}-${crypto.randomUUID()}.${ext}`;
  await env.BUCKET.put(key, await audio.arrayBuffer(), { httpMetadata: { contentType: audioType } });

  const duration = Math.min(Math.max(Number(form.get("duration")) || 0, 0), MAX_RECORDING_SECONDS + 5);
  const saved = await env.DB.prepare(
    `UPDATE attempts SET audio_key = ?, audio_type = ?, duration_sec = ?, recorded_at = ?, grading_status = 'pending'
      WHERE id = ? AND recorded_at IS NULL`
  ).bind(key, audioType, Math.round(duration * 10) / 10, nowIso(), a.id).run();
  if (saved.meta.changes === 0) await env.BUCKET.delete(key);
  return advance(env, a.id);
});

// The iPad calls this right after sending the recording, and keeps it open while
// the student does the next parts. The AI grader runs here.
route("POST", "/api/student/grade", "device", async (c) => {
  const { env } = c;
  const { attempt_id } = await readJson(c.request);
  const a = await getAttempt(env, requireId(attempt_id, "attempt"));

  const claim = await env.DB.prepare(
    "UPDATE attempts SET grading_status = 'grading' WHERE id = ? AND grading_status = 'pending'"
  ).bind(a.id).run();
  if (claim.meta.changes === 0) return { grading_status: effectiveStatus(env, a) };

  const work = (async () => {
    let result;
    try {
      if (!graderConnected(env)) {
        result = { ok: false, reason: "No AI grader connected yet" };
      } else {
        const obj = await env.BUCKET.get(a.audio_key);
        result = obj
          ? await gradeRecording(env, {
              audio: await obj.arrayBuffer(),
              audioType: a.audio_type,
              text: a.reading_text,
              sourceType: parseJson(a.sources, []).join(","),
              attemptId: a.id,
            })
          : { ok: false, reason: "Recording not found" };
      }
    } catch (err) {
      console.error("grading failed", err);
      result = { ok: false, reason: "AI grading failed" };
    }

    if (result.ok) {
      // Saved even if the student already gave up waiting, so the teacher still gets it.
      await env.DB.prepare(
        "UPDATE attempts SET grading_status = 'done', ai_feedback = ?, ai_score = ?, grading_note = NULL, graded_at = ? WHERE id = ?"
      ).bind(result.feedback, result.score, nowIso(), a.id).run();
      return "done";
    }
    await env.DB.prepare(
      "UPDATE attempts SET grading_status = 'manual', grading_note = ?, graded_at = ? WHERE id = ? AND grading_status IN ('pending', 'grading')"
    ).bind(result.reason, nowIso(), a.id).run();
    return "manual";
  })();

  c.exec.waitUntil(work);
  return { grading_status: await work };
});

function ratingValue(value, max, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new HttpError(400, `Pick a number for ${label}.`);
  return n;
}

route("POST", "/api/student/ratings", "device", async (c) => {
  const body = await readJson(c.request);
  const a = await requireOpenAttempt(c.env, body.attempt_id);
  if (nextStep(a) !== "ratings") return advance(c.env, a.id);
  const inside = ratingValue(body.inside, 5, "reviewing inside");
  const outside = ratingValue(body.outside, 5, "reviewing outside");
  const hasmada = ratingValue(body.hasmada, 10, "hasmada");
  await c.env.DB.prepare(
    `UPDATE attempts SET rating_inside = ?, rating_outside = ?, hasmada = ?, ratings_at = ?
      WHERE id = ? AND ratings_at IS NULL`
  ).bind(inside, outside, hasmada, nowIso(), a.id).run();
  return advance(c.env, a.id);
});

route("POST", "/api/student/quiz", "device", async (c) => {
  const { attempt_id, answers } = await readJson(c.request);
  const a = await requireOpenAttempt(c.env, attempt_id);
  if (nextStep(a) !== "quiz") return advance(c.env, a.id);

  const quiz = parseJson(a.quiz, []);
  if (!Array.isArray(answers) || answers.length !== quiz.length || !answers.every((x) => [0, 1, 2].includes(x))) {
    throw new HttpError(400, "Answer every question before handing in.");
  }
  const correct = quiz.reduce((n, q, i) => n + (q.correct === answers[i] ? 1 : 0), 0);
  const percent = quiz.length ? Math.round((correct / quiz.length) * 100) : 0;
  await c.env.DB.prepare(
    `UPDATE attempts SET quiz_answers = ?, quiz_correct = ?, quiz_total = ?, quiz_percent = ?, quiz_at = ?
      WHERE id = ? AND quiz_at IS NULL`
  ).bind(JSON.stringify(answers), correct, quiz.length, percent, nowIso(), a.id).run();
  // The student doesn't see the quiz score.
  return advance(c.env, a.id);
});

route("GET", "/api/student/result", "device", async (c) => {
  const a = await getAttempt(c.env, requireId(c.url.searchParams.get("attempt_id"), "attempt"));
  if (!a.completed_at) throw new HttpError(403, "Finish the other parts first.");
  if (!normalizeParts(parseJson(a.parts, null)).reading) return { grading_status: "none" };
  const status = effectiveStatus(c.env, a);
  return {
    grading_status: status,
    feedback: status === "done" ? a.ai_feedback : null,
    score: status === "done" ? a.ai_score : null,
    wait_seconds: graderTimeoutSeconds(c.env) + 15,
  };
});

route("POST", "/api/student/giveup", "device", async (c) => {
  const { attempt_id } = await readJson(c.request);
  await c.env.DB.prepare(
    "UPDATE attempts SET grading_status = 'manual', grading_note = 'AI grading took too long', graded_at = ? WHERE id = ? AND grading_status IN ('pending', 'grading')"
  ).bind(nowIso(), requireId(attempt_id, "attempt")).run();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Teacher API
// ---------------------------------------------------------------------------

route("GET", "/api/teacher/session", "none", async (c) => ({
  configured: Boolean(c.env.TEACHER_CODE),
  signed_in: await isTeacher(c),
}));

route("POST", "/api/teacher/login", "none", async (c) => {
  const { code } = await readJson(c.request);
  if (!c.env.TEACHER_CODE) throw new HttpError(409, "No access code is set up yet. Add TEACHER_CODE in Cloudflare first.");
  if (!safeEqual(String(code || "").trim(), String(c.env.TEACHER_CODE).trim())) {
    await sleep(800);
    throw new HttpError(401, "That access code isn’t right.");
  }
  const token = await makeToken(c.env, {
    t: "teacher",
    f: await fingerprint(c.env.TEACHER_CODE),
    exp: Date.now() + TEACHER_SESSION_HOURS * 3600000,
  });
  return json({ ok: true }, 200, { "set-cookie": cookieHeader(c.url, "gr_teacher", token, TEACHER_SESSION_HOURS * 3600) });
});

route("POST", "/api/teacher/logout", "none", async (c) =>
  json({ ok: true }, 200, { "set-cookie": cookieHeader(c.url, "gr_teacher", "", 0) })
);

async function listLevels(env) {
  return (await env.DB.prepare("SELECT id, name, sort_order FROM levels WHERE active = 1 ORDER BY sort_order, id").all()).results;
}

async function listStudents(env) {
  return (await env.DB.prepare("SELECT id, name, level_id FROM students WHERE active = 1 ORDER BY name COLLATE NOCASE").all()).results;
}

async function manualQueueCount(env) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM attempts
      WHERE manual_feedback IS NULL
        AND (grading_status = 'manual' OR (grading_status IN ('pending', 'grading') AND recorded_at < ?))`
  ).bind(staleCutoffIso(env)).first();
  return row ? row.n : 0;
}

route("GET", "/api/teacher/overview", "teacher", async (c) => ({
  today: c.today,
  timezone: c.timezone,
  timezone_set: Boolean(await getSetting(c.env, "timezone")),
  class_code: (await getSetting(c.env, "class_code")) || "",
  grader_connected: graderConnected(c.env),
  grader_timeout_seconds: graderTimeoutSeconds(c.env),
  levels: await listLevels(c.env),
  students: await listStudents(c.env),
  manual_count: await manualQueueCount(c.env),
}));

route("PUT", "/api/teacher/settings", "teacher", async (c) => {
  const body = await readJson(c.request);
  if (body.class_code !== undefined) {
    const code = String(body.class_code).trim();
    if (code.length < 4) throw new HttpError(400, "Use at least 4 characters for the class code.");
    if (code.length > 40) throw new HttpError(400, "Keep the class code under 40 characters.");
    await setSetting(c.env, "class_code", code);
  }
  if (body.timezone !== undefined) {
    if (!validTimeZone(body.timezone)) throw new HttpError(400, "That time zone isn’t recognized.");
    await setSetting(c.env, "timezone", body.timezone);
  }
  return { ok: true };
});

// Levels ---------------------------------------------------------------------

route("POST", "/api/teacher/levels", "teacher", async (c) => {
  const name = cleanText((await readJson(c.request)).name, 80);
  if (!name) throw new HttpError(400, "Give the level a name.");
  const max = await c.env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM levels WHERE active = 1").first();
  await c.env.DB.prepare("INSERT INTO levels (name, sort_order) VALUES (?, ?)").bind(name, max.m + 1).run();
  return { levels: await listLevels(c.env) };
});

route("PUT", "/api/teacher/levels/:id", "teacher", async (c) => {
  const name = cleanText((await readJson(c.request)).name, 80);
  if (!name) throw new HttpError(400, "Give the level a name.");
  await c.env.DB.prepare("UPDATE levels SET name = ? WHERE id = ? AND active = 1").bind(name, requireId(c.params.id)).run();
  return { levels: await listLevels(c.env) };
});

route("POST", "/api/teacher/levels/order", "teacher", async (c) => {
  const { ids } = await readJson(c.request);
  if (!Array.isArray(ids)) throw new HttpError(400, "Missing level order.");
  await c.env.DB.batch(ids.map((id, i) => c.env.DB.prepare("UPDATE levels SET sort_order = ? WHERE id = ?").bind(i + 1, requireId(id))));
  return { levels: await listLevels(c.env) };
});

route("DELETE", "/api/teacher/levels/:id", "teacher", async (c) => {
  const id = requireId(c.params.id);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE levels SET active = 0 WHERE id = ?").bind(id),
    c.env.DB.prepare("UPDATE students SET level_id = NULL WHERE level_id = ?").bind(id),
  ]);
  return { levels: await listLevels(c.env), students: await listStudents(c.env) };
});

// Students -------------------------------------------------------------------

async function checkLevel(env, levelId) {
  if (levelId === null || levelId === undefined || levelId === "") return null;
  const id = requireId(levelId, "level");
  const level = await env.DB.prepare("SELECT id FROM levels WHERE id = ? AND active = 1").bind(id).first();
  if (!level) throw new HttpError(400, "That level doesn’t exist.");
  return id;
}

route("POST", "/api/teacher/students", "teacher", async (c) => {
  const body = await readJson(c.request);
  const name = cleanText(body.name, 80);
  if (!name) throw new HttpError(400, "Type the student’s name.");
  const levelId = await checkLevel(c.env, body.level_id);
  await c.env.DB.prepare("INSERT INTO students (name, level_id, created_at) VALUES (?, ?, ?)").bind(name, levelId, nowIso()).run();
  return { students: await listStudents(c.env) };
});

route("PUT", "/api/teacher/students/:id", "teacher", async (c) => {
  const id = requireId(c.params.id);
  const body = await readJson(c.request);
  await getActiveStudent(c.env, id);
  if (body.name !== undefined) {
    const name = cleanText(body.name, 80);
    if (!name) throw new HttpError(400, "The name can’t be empty.");
    await c.env.DB.prepare("UPDATE students SET name = ? WHERE id = ?").bind(name, id).run();
  }
  if (body.level_id !== undefined) {
    await c.env.DB.prepare("UPDATE students SET level_id = ? WHERE id = ?").bind(await checkLevel(c.env, body.level_id), id).run();
  }
  return { students: await listStudents(c.env) };
});

route("DELETE", "/api/teacher/students/:id", "teacher", async (c) => {
  // Kept in the database (inactive) so old reports still show their results.
  await c.env.DB.prepare("UPDATE students SET active = 0 WHERE id = ?").bind(requireId(c.params.id)).run();
  return { students: await listStudents(c.env) };
});

route("POST", "/api/teacher/students/:id/retry", "teacher", async (c) => {
  const id = requireId(c.params.id);
  await getActiveStudent(c.env, id);
  const done = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM attempts WHERE student_id = ? AND date = ? AND completed_at IS NOT NULL").bind(id, c.today).first();
  // Allowed tries today becomes (finished tries + 1).
  await c.env.DB.prepare(
    `INSERT INTO retries (student_id, date, extra) VALUES (?, ?, ?)
     ON CONFLICT(student_id, date) DO UPDATE SET extra = MAX(extra, excluded.extra)`
  ).bind(id, c.today, done.n).run();
  return { ok: true };
});


// Daily setup ----------------------------------------------------------------

async function dayView(env, date) {
  const day = await loadDay(env, date);
  const levels = await listLevels(env);
  day.level_status = Object.fromEntries(levels.map((l) => {
    const r = readingForLevel(day, l.id);
    return [l.id, { ready: r.ready, sources: r.sources, missing: r.missing }];
  }));
  day.quiz_ready = questionsComplete(day.questions);
  return day;
}

route("GET", "/api/teacher/day", "teacher", async (c) => {
  const date = c.url.searchParams.get("date") || c.today;
  if (!isDate(date)) throw new HttpError(400, "Pick a valid date.");
  return dayView(c.env, date);
});

route("PUT", "/api/teacher/day", "teacher", async (c) => {
  const body = await readJson(c.request);
  if (!isDate(body.date)) throw new HttpError(400, "Pick a valid date.");
  const m = body.material || {};
  const activeLevels = new Set((await listLevels(c.env)).map((l) => l.id));
  const levelSources = Object.fromEntries(
    Object.entries(normalizeLevelSources(body.level_sources)).filter(([id]) => activeLevels.has(Number(id)))
  );
  await c.env.DB.prepare(
    `INSERT INTO days (date, gemara, rashi, tosfos, parts, questions, level_sources, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET gemara = excluded.gemara, rashi = excluded.rashi, tosfos = excluded.tosfos,
       parts = excluded.parts, questions = excluded.questions, level_sources = excluded.level_sources,
       updated_at = excluded.updated_at`
  ).bind(
    body.date,
    cleanText(m.gemara, 100000), cleanText(m.rashi, 100000), cleanText(m.tosfos, 100000),
    JSON.stringify(normalizeParts(body.parts)),
    JSON.stringify(normalizeQuestions(body.questions)),
    JSON.stringify(levelSources),
    nowIso()
  ).run();
  return dayView(c.env, body.date);
});

// Results --------------------------------------------------------------------

// Tries where the student hasn't done anything yet are left out of results.
const STARTED = "(a.recorded_at IS NOT NULL OR a.ratings_at IS NOT NULL OR a.quiz_at IS NOT NULL)";

route("GET", "/api/teacher/attempts", "teacher", async (c) => {
  const q = c.url.searchParams;
  const from = q.get("from") || c.today;
  const to = q.get("to") || from;
  if (!isDate(from) || !isDate(to)) throw new HttpError(400, "Pick valid dates.");
  const full = q.get("full") === "1";
  const ids = (q.get("students") || "").split(",").map(toId).filter(Boolean);

  let sql = `SELECT a.*, s.name AS current_name FROM attempts a LEFT JOIN students s ON s.id = a.student_id
             WHERE a.date >= ? AND a.date <= ? AND ${STARTED}`;
  const args = [from, to];
  if (ids.length) {
    sql += ` AND a.student_id IN (${ids.map(() => "?").join(",")})`;
    args.push(...ids);
  }
  sql += " ORDER BY a.date DESC, a.submitted_at DESC";
  const rows = (await c.env.DB.prepare(sql).bind(...args).all()).results;
  return { from, to, attempts: rows.map((a) => teacherAttemptView(c.env, a, full)) };
});

route("GET", "/api/teacher/attempts/:id", "teacher", async (c) => {
  const a = await c.env.DB.prepare(
    "SELECT a.*, s.name AS current_name FROM attempts a LEFT JOIN students s ON s.id = a.student_id WHERE a.id = ?"
  ).bind(requireId(c.params.id)).first();
  if (!a) throw new HttpError(404, "That attempt wasn’t found.");
  return teacherAttemptView(c.env, a, true);
});

route("GET", "/api/teacher/manual", "teacher", async (c) => {
  const rows = (await c.env.DB.prepare(
    `SELECT a.*, s.name AS current_name FROM attempts a LEFT JOIN students s ON s.id = a.student_id
      WHERE a.manual_feedback IS NULL
        AND (a.grading_status = 'manual' OR (a.grading_status IN ('pending', 'grading') AND a.recorded_at < ?))
      ORDER BY a.recorded_at`
  ).bind(staleCutoffIso(c.env)).all()).results;
  return { attempts: rows.map((a) => teacherAttemptView(c.env, a, true)) };
});

route("POST", "/api/teacher/attempts/:id/manual", "teacher", async (c) => {
  const id = requireId(c.params.id);
  const body = await readJson(c.request);
  const feedback = cleanText(body.feedback, 20000);
  if (!feedback) throw new HttpError(400, "Write some feedback before saving.");
  const score = body.score === "" || body.score === null || body.score === undefined ? null : Number(body.score);
  if (score !== null && !Number.isFinite(score)) throw new HttpError(400, "The score has to be a number.");
  await getAttempt(c.env, id);
  await c.env.DB.prepare(
    "UPDATE attempts SET manual_feedback = ?, manual_score = ?, manual_at = ? WHERE id = ?"
  ).bind(feedback, score, nowIso(), id).run();
  return { ok: true };
});

route("GET", "/api/teacher/audio/:id", "teacher", async (c) => {
  const a = await c.env.DB.prepare("SELECT audio_key, audio_type, audio_deleted FROM attempts WHERE id = ?")
    .bind(requireId(c.params.id)).first();
  if (!a || !a.audio_key || a.audio_deleted) throw new HttpError(404, "This recording is no longer stored.");

  const wantsRange = c.request.headers.has("range");
  let obj;
  try {
    obj = await c.env.BUCKET.get(a.audio_key, wantsRange ? { range: c.request.headers } : undefined);
  } catch {
    obj = await c.env.BUCKET.get(a.audio_key);
  }
  if (!obj) throw new HttpError(404, "This recording is no longer stored.");

  const headers = new Headers({
    "content-type": a.audio_type || obj.httpMetadata?.contentType || "audio/mp4",
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
  });
  let status = 200;
  if (wantsRange && obj.range) {
    const size = obj.size;
    let offset;
    let length;
    if (obj.range.suffix !== undefined) {
      length = Math.min(obj.range.suffix, size);
      offset = size - length;
    } else {
      offset = obj.range.offset ?? 0;
      length = obj.range.length ?? size - offset;
    }
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${size}`);
    headers.set("content-length", String(length));
    status = 206;
  } else {
    headers.set("content-length", String(obj.size));
  }
  return new Response(obj.body, { status, headers });
});

// ---------------------------------------------------------------------------
// Hourly cleanup
// ---------------------------------------------------------------------------

async function cleanup(env) {
  const cutoff = new Date(Date.now() - RECORDING_KEEP_DAYS * 86400000).toISOString();
  for (;;) {
    const { results } = await env.DB.prepare(
      "SELECT id, audio_key FROM attempts WHERE audio_deleted = 0 AND audio_key IS NOT NULL AND recorded_at < ? LIMIT 500"
    ).bind(cutoff).all();
    if (!results.length) break;
    await env.BUCKET.delete(results.map((r) => r.audio_key));
    await env.DB.batch(results.map((r) => env.DB.prepare("UPDATE attempts SET audio_deleted = 1 WHERE id = ?").bind(r.id)));
    if (results.length < 500) break;
  }

  await env.DB.prepare(
    `UPDATE attempts SET grading_status = 'manual', grading_note = COALESCE(grading_note, 'AI grading never finished'), graded_at = ?
      WHERE grading_status IN ('pending', 'grading') AND recorded_at < ?`
  ).bind(nowIso(), staleCutoffIso(env)).run();
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      await ensureSchema(env);
      return await handleApi(request, env, ctx, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "Something went wrong on the server. Try again." }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    await ensureSchema(env);
    ctx.waitUntil(cleanup(env));
  },
};
