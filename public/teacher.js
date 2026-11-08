import { h, api, toast, SOURCE_LABELS, SOURCE_HEBREW, formatDate, formatTime, clock } from "/common.js";

const app = document.getElementById("app");
const dialog = document.getElementById("detail");
const printArea = document.getElementById("print-report");

const TABS = [
  ["today", "Today"],
  ["setup", "Daily setup"],
  ["students", "Students"],
  ["levels", "Levels"],
  ["manual", "Manual grading"],
  ["reports", "Reports"],
  ["settings", "Settings"],
];

const state = {
  overview: null,
  tab: "today",
  dirty: false,
  readingDate: null,
  report: null, // { from, to, studentIds: [] }
};

let main = null;
let nav = null;
let refreshTimer = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function levelName(id) {
  const l = state.overview.levels.find((x) => x.id === id);
  return l ? l.name : "No level";
}

function fail(err) {
  if (err && err.status === 401) return showLogin();
  toast(err && err.message ? err.message : "Something went wrong.");
}

async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    fail(err);
    return undefined;
  }
}

function gradePill(a) {
  if (a.grading_status === "none") return h("span", { class: "muted" }, "Off");
  if (a.grading_status === "waiting") return "—";
  if (a.grading_status === "done") return h("span", { class: "pill ok" }, a.ai_score !== null && a.ai_score !== undefined ? `AI: ${a.ai_score}` : "AI graded");
  if (a.grading_status === "manual") {
    if (a.has_manual_feedback) return h("span", { class: "pill binding" }, a.manual_score !== null && a.manual_score !== undefined ? `You: ${a.manual_score}` : "Graded by you");
    return h("span", { class: "pill warn" }, "Needs manual grading");
  }
  return h("span", { class: "pill" }, "Grading…");
}

function gradeText(a) {
  if (a.grading_status === "none") return "Off";
  if (a.grading_status === "waiting") return "Not recorded";
  if (a.grading_status === "done") return "AI graded";
  if (a.grading_status === "manual") return a.has_manual_feedback ? "Graded by teacher" : "Needs manual grading";
  return "Grading";
}

function quizText(a) {
  if (!a.parts.quiz) return "Off";
  return a.quiz_done ? `${a.quiz_percent}%` : "Not finished";
}

function ratingText(a, key) {
  if (!a.parts.ratings) return "Off";
  return a.ratings_done ? String(a[key]) : "—";
}

function sourcesText(list) {
  return (list || []).map((s) => SOURCE_LABELS[s]).join(" + ");
}

function emptyQuestion() {
  return { q: "", choices: ["", "", ""], correct: null };
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

async function boot() {
  app.replaceChildren(h("div", { class: "s-center" }, h("div", { class: "spinner" })));
  let s;
  try {
    s = await api("/api/teacher/session");
  } catch (err) {
    return app.replaceChildren(h("div", { class: "s-center" }, h("div", { class: "stack" },
      h("p", {}, err.message), h("button", { class: "btn primary", onclick: boot }, "Try again"))));
  }
  if (!s.configured) {
    return app.replaceChildren(h("div", { class: "s-center" }, h("div", { class: "stack" },
      h("h1", {}, "Almost ready"),
      h("p", {}, "Set the teacher access code in Cloudflare: Workers › gemara-reader › Settings › Variables and Secrets, add a secret named TEACHER_CODE, then reload this page."))));
  }
  if (!s.signed_in) return showLogin();
  startApp();
}

function showLogin() {
  clearInterval(refreshTimer);
  if (dialog.open) dialog.close();
  const input = h("input", { type: "password", autocomplete: "current-password", "aria-label": "Access code", placeholder: "Access code", style: { textAlign: "center", fontSize: "1.2rem" } });
  const error = h("p", { class: "error-text", role: "alert" });
  const button = h("button", { class: "btn primary big", type: "submit" }, "Sign in");
  app.replaceChildren(h("div", { class: "s-center" }, h("form", {
    class: "stack",
    style: { width: "100%" },
    onsubmit: async (ev) => {
      ev.preventDefault();
      button.disabled = true;
      error.textContent = "";
      try {
        await api("/api/teacher/login", { method: "POST", body: { code: input.value } });
        startApp();
      } catch (err) {
        error.textContent = err.message;
        button.disabled = false;
        input.select();
      }
    },
  }, h("h1", {}, "Teacher sign in"), input, button, error)));
  input.focus();
}

async function startApp() {
  const ov = await guard(() => api("/api/teacher/overview"));
  if (!ov) return;
  state.overview = ov;

  if (!ov.timezone_set) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) {
      await guard(() => api("/api/teacher/settings", { method: "PUT", body: { timezone: tz } }));
      state.overview = await guard(() => api("/api/teacher/overview")) || ov;
      toast(`School time zone set to ${tz}. You can change it in Settings.`, 4000);
    }
  }

  nav = h("nav", { class: "t-nav", "aria-label": "Sections" });
  main = h("main", { class: "t-main" });
  app.replaceChildren(h("div", { class: "t-shell" },
    h("header", { class: "t-top" },
      h("div", { class: "row" },
        h("h1", {}, "Gemara Reading"),
        h("span", { class: "today" }, formatDate(state.overview.today))),
      nav),
    main));

  const fromHash = location.hash.slice(1);
  go(TABS.some(([id]) => id === fromHash) ? fromHash : "today", true);
}

function renderNav() {
  nav.replaceChildren(...TABS.map(([id, label]) =>
    h("button", { type: "button", "aria-current": state.tab === id ? "page" : null, onclick: () => go(id) },
      label,
      id === "manual" && state.overview.manual_count ? h("span", { class: "count" }, String(state.overview.manual_count)) : null)));
}

async function refreshOverview() {
  const ov = await guard(() => api("/api/teacher/overview"));
  if (ov) {
    state.overview = ov;
    renderNav();
  }
  return ov;
}

function go(tab, force = false) {
  if (!force && state.dirty && !confirm("You have unsaved changes. Leave without saving?")) return;
  state.dirty = false;
  state.tab = tab;
  history.replaceState(null, "", `#${tab}`);
  clearInterval(refreshTimer);
  renderNav();
  main.replaceChildren(h("div", { class: "spinner" }));
  const render = { today: renderToday, setup: renderSetup, students: renderStudents, levels: renderLevels, manual: renderManual, reports: renderReports, settings: renderSettings }[tab];
  render().catch(fail);
}

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) e.preventDefault();
});

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

async function renderToday() {
  const ov = await refreshOverview();
  if (!ov) return;
  const [day, res] = await Promise.all([
    api(`/api/teacher/day?date=${ov.today}`),
    api(`/api/teacher/attempts?from=${ov.today}&to=${ov.today}`),
  ]);
  if (state.tab !== "today") return;

  const notice = (text, label, tab, warn = true) =>
    h("div", { class: `notice${warn ? " warn" : ""}` }, text, " ",
      label ? h("button", { class: "btn small", onclick: () => go(tab) }, label) : null);
  const notices = [];
  const p = day.parts;
  if (!ov.class_code) notices.push(notice("Set a class code so the iPads can be unlocked.", "Set class code", "settings"));
  if (!p.reading && !p.ratings && !p.quiz) {
    notices.push(notice("Every part is turned off today, so students have nothing to do.", "Daily setup", "setup"));
  }
  if (p.reading) {
    if (!ov.levels.length) notices.push(notice("Add your levels first.", "Add levels", "levels"));
    const noLevel = ov.students.filter((s) => !s.level_id);
    if (ov.levels.length && noLevel.length) {
      notices.push(notice(
        `${noLevel.length} ${noLevel.length === 1 ? "student doesn’t" : "students don’t"} have a level yet: ${noLevel.map((s) => s.name).join(", ")}.`,
        "Set levels", "students"));
    }
    const used = ov.levels.filter((l) => ov.students.some((s) => s.level_id === l.id));
    const notReady = used.filter((l) => !(day.level_status[l.id] && day.level_status[l.id].ready));
    if (notReady.length) {
      notices.push(notice(
        `The reading isn’t ready for ${notReady.map((l) => l.name).join(", ")}. Students on ${notReady.length === 1 ? "that level" : "those levels"} can’t start yet.`,
        "Daily setup", "setup"));
    }
    if (!ov.grader_connected) notices.push(notice("The AI grader isn’t connected yet, so every reading goes to Manual grading.", null, null, false));
  }
  if (p.quiz && !day.quiz_ready) notices.push(notice("Today’s quiz isn’t finished, so students can’t start yet.", "Daily setup", "setup"));

  const latest = new Map();
  const counts = new Map();
  for (const a of res.attempts) {
    if (!latest.has(a.student_id)) latest.set(a.student_id, a);
    counts.set(a.student_id, (counts.get(a.student_id) || 0) + 1);
  }
  const finished = ov.students.filter((s) => latest.get(s.id) && latest.get(s.id).completed).length;

  const rows = ov.students.map((s) => {
    const a = latest.get(s.id);
    let status = h("span", { class: "pill" }, "Not started");
    if (a && !a.completed) status = h("span", { class: "pill warn" }, "In progress");
    if (a && a.completed) status = h("span", { class: "pill ok" }, `Finished ${formatTime(a.completed_at)}`);
    const tries = counts.get(s.id) || 0;
    return h("tr", {},
      h("td", {}, h("strong", {}, s.name)),
      h("td", {}, levelName(s.level_id)),
      h("td", {}, status, tries > 1 ? h("span", { class: "muted" }, ` (${tries} tries)`) : null),
      h("td", {}, a ? gradePill(a) : "—"),
      h("td", {}, a ? quizText(a) : "—"),
      h("td", { class: "num" }, a ? ratingText(a, "rating_inside") : "—"),
      h("td", { class: "num" }, a ? ratingText(a, "rating_outside") : "—"),
      h("td", { class: "num" }, a ? ratingText(a, "hasmada") : "—"),
      h("td", { style: { whiteSpace: "nowrap", textAlign: "right" } },
        a ? h("button", { class: "btn small", onclick: () => openDetail(a.id) }, "View") : null,
        a && a.completed ? h("button", {
          class: "btn small",
          onclick: () => guard(async () => {
            await api(`/api/teacher/students/${s.id}/retry`, { method: "POST" });
            toast(`${s.name} can do it again today.`);
          }),
        }, "Allow another try") : null));
  });

  const partsOn = [p.reading && "reading", p.ratings && "review questions", p.quiz && "quiz"].filter(Boolean);
  main.replaceChildren(
    h("header", {},
      h("div", {},
        h("h2", {}, "Today"),
        h("p", { class: "muted" }, `${finished} of ${ov.students.length} finished. Parts on today: ${partsOn.length ? partsOn.join(", ") : "none"}.`)),
      h("button", { class: "btn", onclick: () => go("today", true) }, "Refresh")),
    ...notices,
    ov.students.length
      ? h("div", { class: "panel" }, h("div", { class: "table-wrap" }, h("table", {},
          h("thead", {}, h("tr", {}, ["Student", "Level", "Status", "Reading", "Quiz", "Inside", "Outside", "Hasmada", ""].map((t) => h("th", {}, t)))),
          h("tbody", {}, rows))))
      : h("div", { class: "panel" }, h("p", {}, "No students yet."), h("div", {}, h("button", { class: "btn primary", onclick: () => go("students") }, "Add students"))),
  );

  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (state.tab === "today" && !dialog.open && document.visibilityState === "visible") renderToday().catch(() => {});
  }, 15000);
}

// ---------------------------------------------------------------------------
// Daily setup
// ---------------------------------------------------------------------------

async function renderSetup() {
  const ov = state.overview;
  const date = state.readingDate || ov.today;
  const day = await api(`/api/teacher/day?date=${date}`);
  if (state.tab !== "setup") return;

  const draft = {
    date,
    parts: { ...day.parts },
    material: { ...day.material },
    questions: day.questions.map((q) => ({ q: q.q, choices: [...q.choices], correct: q.correct })),
    level_sources: Object.fromEntries(ov.levels.map((l) => [l.id, [...(day.level_sources[l.id] || [])]])),
  };

  const saveStatus = h("span", { class: "muted" }, day.updated_at ? `Last saved ${formatTime(day.updated_at)}` : "Not saved yet");
  const statusUpdaters = [];
  const markDirty = () => {
    state.dirty = true;
    saveStatus.textContent = "Unsaved changes";
    statusUpdaters.forEach((fn) => fn());
  };

  const dateInput = h("input", { type: "date", value: date, style: { width: "auto" } });
  dateInput.addEventListener("change", () => {
    if (!dateInput.value) return;
    if (state.dirty && !confirm("You have unsaved changes. Switch dates without saving?")) {
      dateInput.value = date;
      return;
    }
    state.dirty = false;
    state.readingDate = dateInput.value;
    renderSetup().catch(fail);
  });

  // Parts on/off
  const partToggle = (key, label, hint) => {
    const box = h("input", { type: "checkbox", checked: draft.parts[key] });
    box.addEventListener("change", () => { draft.parts[key] = box.checked; markDirty(); });
    return h("label", { class: "toggle" }, box, h("span", {}, h("strong", {}, label), h("span", { class: "muted" }, hint)));
  };

  // Material
  const materialArea = (key, label) => {
    const ta = h("textarea", { class: "hebrew", rows: 6, dir: "rtl", lang: "he", value: draft.material[key] });
    ta.addEventListener("input", () => { draft.material[key] = ta.value; markDirty(); });
    return h("label", { class: "field" }, h("span", {}, label), ta);
  };

  // What each level reads
  const levelRows = ov.levels.map((l) => {
    const chosen = draft.level_sources[l.id];
    const count = ov.students.filter((s) => s.level_id === l.id).length;
    const pill = h("span", { class: "pill" });
    const update = () => {
      const missing = chosen.filter((s) => !draft.material[s].trim());
      if (!chosen.length) { pill.className = "pill warn"; pill.textContent = "Pick at least one"; }
      else if (missing.length) { pill.className = "pill warn"; pill.textContent = `Paste the ${sourcesText(missing)} text`; }
      else { pill.className = "pill ok"; pill.textContent = "Ready"; }
    };
    statusUpdaters.push(update);
    update();
    const boxes = Object.entries(SOURCE_LABELS).map(([key, label]) => {
      const box = h("input", { type: "checkbox", checked: chosen.includes(key) });
      box.addEventListener("change", () => {
        const set = new Set(chosen);
        if (box.checked) set.add(key); else set.delete(key);
        chosen.splice(0, chosen.length, ...Object.keys(SOURCE_LABELS).filter((k) => set.has(k)));
        markDirty();
      });
      return h("label", {}, box, label);
    });
    return h("tr", {},
      h("td", {}, h("strong", {}, l.name), h("div", { class: "muted" }, `${count} ${count === 1 ? "student" : "students"}`)),
      h("td", {}, h("div", { class: "checks" }, boxes)),
      h("td", { style: { textAlign: "right" } }, pill));
  });

  // Quiz (same for every level)
  const quizPill = h("span", { class: "pill" });
  const updateQuiz = () => {
    const complete = draft.questions.every((q) => q.q.trim() && q.choices.every((c) => c.trim()) && q.correct !== null);
    const empty = draft.questions.every((q) => !q.q.trim() && q.choices.every((c) => !c.trim()));
    quizPill.className = `pill ${complete ? "ok" : empty ? "" : "warn"}`;
    quizPill.textContent = complete ? "Ready" : empty ? "Empty" : "Not finished";
  };
  statusUpdaters.push(updateQuiz);
  updateQuiz();
  const qBlocks = draft.questions.map((q, qi) => {
    const qInput = h("input", { type: "text", dir: "auto", value: q.q, placeholder: "Question" });
    qInput.addEventListener("input", () => { q.q = qInput.value; markDirty(); });
    const rows = q.choices.map((c, ci) => {
      const radio = h("input", { type: "radio", name: `correct-${qi}`, checked: q.correct === ci, "aria-label": `Choice ${ci + 1} is correct` });
      radio.addEventListener("change", () => { q.correct = ci; markDirty(); });
      const cInput = h("input", { type: "text", dir: "auto", value: c, placeholder: `Choice ${ci + 1}` });
      cInput.addEventListener("input", () => { q.choices[ci] = cInput.value; markDirty(); });
      return h("div", { class: "choice-row" }, h("label", {}, radio, "Correct"), cInput);
    });
    return h("div", { class: "q-block" }, h("strong", {}, `Question ${qi + 1}`), qInput, ...rows);
  });

  const saveBtn = h("button", { class: "btn primary" }, "Save daily setup");
  saveBtn.addEventListener("click", () => guard(async () => {
    saveBtn.disabled = true;
    try {
      await api("/api/teacher/day", { method: "PUT", body: draft });
      state.dirty = false;
      toast("Daily setup saved");
      await renderSetup();
    } finally {
      saveBtn.disabled = false;
    }
  }));

  const copiedNote = !day.saved && day.sources_copied_from
    ? h("p", { class: "notice" }, `Level choices copied from ${formatDate(day.sources_copied_from)}. Save to use them for this day.`)
    : null;

  main.replaceChildren(
    h("header", {},
      h("div", {}, h("h2", {}, "Daily setup"), h("p", { class: "muted" }, date === ov.today ? "Today" : formatDate(date))),
      h("label", { class: "field" }, h("span", {}, "Date"), dateInput)),
    h("section", { class: "panel" },
      h("h3", {}, "Parts today"),
      h("p", { class: "muted" }, "Turn off anything the class isn’t doing this day. It applies to everyone."),
      h("div", { class: "toggles" },
        partToggle("reading", "Reading", "Students record themselves and the AI grades it"),
        partToggle("ratings", "Review questions", "Reviewed inside, reviewed outside, hasmada"),
        partToggle("quiz", "Quiz", "Two questions, graded automatically"))),
    h("section", { class: "panel" },
      h("h3", {}, "The day’s material"),
      h("p", { class: "muted" }, "Paste the Gemara, Rashi and Tosfos for this day. Each level reads the parts you check below."),
      h("div", { class: "material-grid" }, materialArea("gemara", "Gemara"), materialArea("rashi", "Rashi"), materialArea("tosfos", "Tosfos"))),
    h("section", { class: "panel" },
      h("h3", {}, "What each level reads"),
      copiedNote,
      ov.levels.length
        ? h("div", { class: "table-wrap" }, h("table", {}, h("tbody", {}, levelRows)))
        : h("div", {}, h("p", { class: "muted" }, "No levels yet."), h("button", { class: "btn primary", onclick: () => go("levels") }, "Add levels"))),
    h("section", { class: "panel" },
      h("header", {}, h("h3", {}, "Quiz (same for every level)"), quizPill),
      ...qBlocks),
    h("div", { class: "save-bar" }, saveStatus, saveBtn),
  );
}

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

function levelSelect(selected, onChange) {
  const sel = h("select", { "aria-label": "Level" },
    h("option", { value: "" }, "No level yet"),
    state.overview.levels.map((l) => h("option", { value: String(l.id), selected: l.id === selected ? true : null }, l.name)));
  if (onChange) sel.addEventListener("change", () => onChange(sel.value ? Number(sel.value) : null));
  return sel;
}

async function renderStudents() {
  await refreshOverview();
  const ov = state.overview;

  const names = h("textarea", { rows: 3, placeholder: "One name per line" });
  const newLevel = levelSelect(null);
  const addBtn = h("button", { class: "btn primary" }, "Add students");
  addBtn.addEventListener("click", () => guard(async () => {
    const list = names.value.split("\n").map((n) => n.trim()).filter(Boolean);
    if (!list.length) return names.focus();
    addBtn.disabled = true;
    try {
      for (const name of list) {
        await api("/api/teacher/students", { method: "POST", body: { name, level_id: newLevel.value ? Number(newLevel.value) : null } });
      }
      toast(list.length === 1 ? `Added ${list[0]}` : `Added ${list.length} students`);
      await renderStudents();
    } finally {
      addBtn.disabled = false;
    }
  }));

  const rows = ov.students.map((s) => {
    const nameInput = h("input", { type: "text", value: s.name, "aria-label": "Name" });
    const saveName = () => guard(async () => {
      const v = nameInput.value.trim();
      if (!v || v === s.name) { nameInput.value = s.name; return; }
      await api(`/api/teacher/students/${s.id}`, { method: "PUT", body: { name: v } });
      toast(`Renamed to ${v}`);
      s.name = v;
    });
    nameInput.addEventListener("change", saveName);
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") nameInput.blur(); });

    const sel = levelSelect(s.level_id, (levelId) => guard(async () => {
      await api(`/api/teacher/students/${s.id}`, { method: "PUT", body: { level_id: levelId } });
      s.level_id = levelId;
      toast(`${s.name}: ${levelName(levelId)}`);
    }));

    const remove = h("button", { class: "btn small danger" }, "Remove");
    remove.addEventListener("click", () => guard(async () => {
      if (!confirm(`Remove ${s.name} from the list? Their past results stay in reports.`)) return;
      await api(`/api/teacher/students/${s.id}`, { method: "DELETE" });
      toast(`Removed ${s.name}`);
      await renderStudents();
    }));

    return h("div", { class: "list-row" }, nameInput, sel, remove);
  });

  main.replaceChildren(
    h("header", {}, h("div", {}, h("h2", {}, "Students"), h("p", { class: "muted" }, `${ov.students.length} on the list`))),
    h("section", { class: "panel" },
      h("h3", {}, "Add students"),
      h("div", { class: "row-form" },
        h("label", { class: "field" }, h("span", {}, "Names"), names),
        h("label", { class: "field", style: { flex: "0 1 220px" } }, h("span", {}, "Level"), newLevel),
        addBtn)),
    h("section", { class: "panel" },
      h("h3", {}, "Class list"),
      ov.students.length ? h("div", {}, rows) : h("p", { class: "muted" }, "No students yet. Add them above.")),
  );
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

async function renderLevels() {
  await refreshOverview();
  const ov = state.overview;

  const nameInput = h("input", { type: "text", placeholder: "Level name" });
  const addBtn = h("button", { class: "btn primary", type: "submit" }, "Add level");
  const addForm = h("form", {
    class: "row-form",
    onsubmit: (ev) => {
      ev.preventDefault();
      guard(async () => {
        if (!nameInput.value.trim()) return nameInput.focus();
        await api("/api/teacher/levels", { method: "POST", body: { name: nameInput.value } });
        toast(`Added ${nameInput.value.trim()}`);
        await renderLevels();
      });
    },
  }, h("label", { class: "field" }, h("span", {}, "New level"), nameInput), addBtn);

  const move = (index, delta) => guard(async () => {
    const ids = ov.levels.map((l) => l.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + delta, 0, id);
    await api("/api/teacher/levels/order", { method: "POST", body: { ids } });
    await renderLevels();
  });

  const rows = ov.levels.map((l, i) => {
    const count = ov.students.filter((s) => s.level_id === l.id).length;
    const input = h("input", { type: "text", value: l.name, "aria-label": "Level name" });
    input.addEventListener("change", () => guard(async () => {
      const v = input.value.trim();
      if (!v) { input.value = l.name; return; }
      await api(`/api/teacher/levels/${l.id}`, { method: "PUT", body: { name: v } });
      toast(`Renamed to ${v}`);
      await refreshOverview();
    }));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
    const remove = h("button", { class: "btn small danger" }, "Remove");
    remove.addEventListener("click", () => guard(async () => {
      const msg = count
        ? `Remove ${l.name}? The ${count} ${count === 1 ? "student" : "students"} on it will need a new level.`
        : `Remove ${l.name}?`;
      if (!confirm(msg)) return;
      await api(`/api/teacher/levels/${l.id}`, { method: "DELETE" });
      toast(`Removed ${l.name}`);
      await renderLevels();
    }));
    return h("div", { class: "list-row" },
      input,
      h("span", { class: "muted", style: { minWidth: "90px" } }, `${count} ${count === 1 ? "student" : "students"}`),
      h("button", { class: "btn small", disabled: i === 0, "aria-label": `Move ${l.name} up`, onclick: () => move(i, -1) }, "Up"),
      h("button", { class: "btn small", disabled: i === ov.levels.length - 1, "aria-label": `Move ${l.name} down`, onclick: () => move(i, 1) }, "Down"),
      remove);
  });

  main.replaceChildren(
    h("header", {}, h("div", {}, h("h2", {}, "Levels"), h("p", { class: "muted" }, "Each level gets its own reading and questions every day."))),
    h("section", { class: "panel" }, addForm),
    h("section", { class: "panel" },
      h("h3", {}, "Your levels"),
      ov.levels.length ? h("div", {}, rows) : h("p", { class: "muted" }, "No levels yet. Add your first one above.")),
  );
}

// ---------------------------------------------------------------------------
// Manual grading
// ---------------------------------------------------------------------------

function manualForm(a, onSaved) {
  const feedback = h("textarea", { rows: 4, dir: "auto", value: a.manual_feedback || "", placeholder: "Your feedback (only you see this)" });
  const score = h("input", { type: "number", inputmode: "decimal", value: a.manual_score ?? "", placeholder: "Score (optional)", style: { maxWidth: "200px" } });
  const save = h("button", { class: "btn primary" }, a.manual_feedback ? "Update grade" : "Save grade");
  save.addEventListener("click", () => guard(async () => {
    if (!feedback.value.trim()) return feedback.focus();
    save.disabled = true;
    try {
      await api(`/api/teacher/attempts/${a.id}/manual`, { method: "POST", body: { feedback: feedback.value, score: score.value } });
      toast("Grade saved");
      onSaved && onSaved();
    } finally {
      save.disabled = false;
    }
  }));
  return h("div", { class: "field" }, feedback, h("div", { class: "row-form" }, score, save));
}

function readBlock(a) {
  return h("div", { class: "read-text", lang: "he" },
    (a.reading_parts || []).map((p) => h("div", { class: "read-part" },
      h("strong", { class: "read-source" }, SOURCE_HEBREW[p.source] || ""), p.text)));
}

function audioPlayer(a) {
  return a.audio_available
    ? h("audio", { controls: true, preload: "none", src: `/api/teacher/audio/${a.id}`, style: { width: "100%" } })
    : h("p", { class: "muted" }, "The recording was deleted after 7 days.");
}

async function renderManual() {
  const res = await api("/api/teacher/manual");
  await refreshOverview();
  if (state.tab !== "manual") return;

  const cards = res.attempts.map((a) => {
    const card = h("section", { class: "panel" },
      h("header", {},
        h("div", {},
          h("h3", {}, a.student_name),
          h("span", { class: "muted" }, `${formatDate(a.date, { weekday: "short", month: "short", day: "numeric" })}, ${a.level_name || ""}, ${sourcesText(a.sources)}, ${clock(a.duration_sec || 0)} long`)),
        h("span", { class: "pill warn" }, a.grading_note || "AI couldn’t grade")),
      audioPlayer(a),
      h("details", {}, h("summary", {}, "Text they read"), readBlock(a)),
      manualForm(a, async () => {
        card.remove();
        await refreshOverview();
        if (!main.querySelector(".panel")) renderManual().catch(fail);
      }));
    return card;
  });

  main.replaceChildren(
    h("header", {}, h("div", {}, h("h2", {}, "Manual grading"), h("p", { class: "muted" }, "Readings the AI couldn’t grade. Your grades are for your records; students don’t see them."))),
    ...(cards.length ? cards : [h("div", { class: "panel" }, h("p", {}, "Nothing to grade by hand right now."))]),
  );
}

// ---------------------------------------------------------------------------
// Attempt detail
// ---------------------------------------------------------------------------

async function openDetail(id) {
  const a = await guard(() => api(`/api/teacher/attempts/${id}`));
  if (!a) return;

  const quiz = a.quiz && a.quiz.length
    ? h("ol", { class: "quiz-review" }, a.quiz.map((q) => h("li", {},
        h("strong", { dir: "auto" }, q.q),
        q.choices.map((c, i) => {
          let cls = "opt";
          if (i === q.correct) cls += " correct";
          else if (i === q.answer) cls += " wrong";
          const tag = i === q.answer ? (i === q.correct ? " (their answer, correct)" : " (their answer)") : i === q.correct ? " (correct answer)" : "";
          return h("span", { class: cls, dir: "auto" }, c, tag ? h("bdi", { dir: "ltr" }, tag) : null);
        }))))
    : h("p", { class: "muted" }, "No quiz.");

  let aiSection;
  if (a.grading_status === "done") aiSection = h("div", { class: "feedback-card", dir: "auto", style: { fontSize: "1rem" } }, a.ai_score !== null && a.ai_score !== undefined ? `Score: ${a.ai_score}\n\n${a.ai_feedback}` : a.ai_feedback);
  else if (a.grading_status === "manual") aiSection = h("p", { class: "muted" }, `The AI didn’t grade this reading (${a.grading_note || "no reason given"}).`);
  else if (a.grading_status === "waiting") aiSection = h("p", { class: "muted" }, "Not recorded yet.");
  else aiSection = h("p", { class: "muted" }, "Still grading.");

  const sections = [];
  if (a.parts.reading) {
    sections.push(
      h("section", {}, h("h3", {}, `Recording (${clock(a.duration_sec || 0)})`), a.recorded ? audioPlayer(a) : h("p", { class: "muted" }, "Not recorded yet.")),
      h("section", {}, h("h3", {}, "Text they read"), readBlock(a)),
      h("section", {}, h("h3", {}, "AI feedback (shown to the student)"), aiSection));
  }
  if (a.parts.ratings) {
    sections.push(h("section", {}, h("h3", {}, "Review questions"),
      a.ratings_done
        ? h("table", { class: "mini" }, h("tbody", {},
            h("tr", {}, h("td", {}, "Reviewed inside"), h("td", { class: "num" }, `${a.rating_inside} of 5`)),
            h("tr", {}, h("td", {}, "Reviewed outside"), h("td", { class: "num" }, `${a.rating_outside} of 5`)),
            h("tr", {}, h("td", {}, "Hasmada"), h("td", { class: "num" }, `${a.hasmada} of 10`))))
        : h("p", { class: "muted" }, "Not answered yet.")));
  }
  if (a.parts.quiz) sections.push(h("section", {}, h("h3", {}, `Quiz: ${quizText(a)}`), a.quiz_done ? quiz : h("p", { class: "muted" }, "Not finished yet.")));
  if (a.parts.reading) {
    sections.push(h("section", {}, h("h3", {}, "Your grade for the reading (only you see this)"), manualForm(a, () => { dialog.close(); refreshOverview(); })));
  }

  dialog.replaceChildren(
    h("div", { class: "dlg-head" },
      h("div", {},
        h("h2", { id: "detail-title" }, a.student_name),
        h("span", { class: "muted" }, [formatDate(a.date), formatTime(a.completed_at || a.submitted_at), a.level_name, sourcesText(a.sources)].filter(Boolean).join(", "))),
      h("button", { class: "btn", onclick: () => dialog.close() }, "Close")),
    h("div", { class: "dlg-body" }, sections),
  );
  dialog.showModal();
}

dialog.addEventListener("close", () => {
  dialog.querySelectorAll("audio").forEach((x) => x.pause());
  if (state.tab === "today") renderToday().catch(() => {});
});

// ---------------------------------------------------------------------------
// Reports and export
// ---------------------------------------------------------------------------

async function renderReports() {
  await refreshOverview();
  const ov = state.overview;
  if (!state.report) state.report = { from: addDays(ov.today, -6), to: ov.today, studentIds: [] };
  const r = state.report;

  const from = h("input", { type: "date", value: r.from });
  const to = h("input", { type: "date", value: r.to });
  const all = h("input", { type: "checkbox", checked: r.studentIds.length === 0 });
  const boxes = ov.students.map((s) => {
    const box = h("input", { type: "checkbox", value: String(s.id), checked: r.studentIds.includes(s.id) });
    box.addEventListener("change", () => { if (box.checked) all.checked = false; });
    return h("label", {}, box, s.name);
  });
  all.addEventListener("change", () => {
    if (all.checked) boxes.forEach((l) => { l.querySelector("input").checked = false; });
  });

  const results = h("div", {});
  let loaded = null;

  const readFilters = () => {
    r.from = from.value || ov.today;
    r.to = to.value || r.from;
    if (r.to < r.from) [r.from, r.to] = [r.to, r.from];
    r.studentIds = all.checked ? [] : boxes.map((l) => l.querySelector("input")).filter((b) => b.checked).map((b) => Number(b.value));
  };

  const fetchData = () => api(`/api/teacher/attempts?from=${r.from}&to=${r.to}&full=1${r.studentIds.length ? `&students=${r.studentIds.join(",")}` : ""}`);

  const show = () => guard(async () => {
    readFilters();
    results.replaceChildren(h("div", { class: "spinner" }));
    loaded = await fetchData();
    const rows = loaded.attempts.map((a) => h("tr", { class: "clickable", onclick: () => openDetail(a.id) },
      h("td", {}, formatDate(a.date, { month: "short", day: "numeric" })),
      h("td", {}, a.student_name),
      h("td", {}, a.level_name || ""),
      h("td", {}, a.parts.reading ? sourcesText(a.sources) : "—"),
      h("td", {}, gradePill(a)),
      h("td", {}, quizText(a)),
      h("td", { class: "num" }, ratingText(a, "rating_inside")),
      h("td", { class: "num" }, ratingText(a, "rating_outside")),
      h("td", { class: "num" }, ratingText(a, "hasmada"))));
    results.replaceChildren(loaded.attempts.length
      ? h("div", { class: "table-wrap" }, h("table", {},
          h("thead", {}, h("tr", {}, ["Date", "Student", "Level", "Read", "Reading", "Quiz", "Inside", "Outside", "Hasmada"].map((t) => h("th", {}, t)))),
          h("tbody", {}, rows)))
      : h("p", { class: "muted" }, "No results for these dates and students."));
  });

  const ensureData = async () => {
    const before = JSON.stringify(r);
    readFilters();
    if (!loaded || before !== JSON.stringify(r)) await show();
    return loaded;
  };

  const xlsxBtn = h("button", { class: "btn" }, "Download spreadsheet");
  xlsxBtn.addEventListener("click", () => guard(async () => {
    xlsxBtn.disabled = true;
    try {
      const data = await ensureData();
      if (data) await exportSpreadsheet(data);
    } finally {
      xlsxBtn.disabled = false;
    }
  }));
  const pdfBtn = h("button", { class: "btn" }, "Download PDF");
  pdfBtn.addEventListener("click", () => guard(async () => {
    const data = await ensureData();
    if (data) exportPdf(data);
  }));

  main.replaceChildren(
    h("header", {}, h("div", {}, h("h2", {}, "Reports"), h("p", { class: "muted" }, "Pick dates and students, then view or download."))),
    h("section", { class: "panel" },
      h("div", { class: "row-form" },
        h("label", { class: "field" }, h("span", {}, "From"), from),
        h("label", { class: "field" }, h("span", {}, "To"), to)),
      h("div", { class: "field" }, h("span", {}, "Students"),
        h("div", { class: "checks" }, h("label", {}, all, h("strong", {}, "All students")), boxes)),
      h("div", { class: "row-form" },
        h("button", { class: "btn primary", onclick: show }, "Show results"),
        xlsxBtn,
        pdfBtn),
      h("p", { class: "muted" }, "For PDF, the print window opens. Choose Save as PDF (on iPad, use Share › Save to Files).")),
    h("section", { class: "panel" }, results),
  );
  show();
}

function summarize(attempts) {
  const by = new Map();
  const nums = (x) => x !== null && x !== undefined;
  for (const a of attempts) {
    if (!by.has(a.student_id)) by.set(a.student_id, { name: a.student_name, days: 0, quiz: [], ai: [], manual: [], inside: [], outside: [], hasmada: [] });
    const s = by.get(a.student_id);
    s.days += 1;
    if (a.quiz_done && nums(a.quiz_percent)) s.quiz.push(a.quiz_percent);
    if (nums(a.ai_score)) s.ai.push(a.ai_score);
    if (nums(a.manual_score)) s.manual.push(a.manual_score);
    if (a.ratings_done) { s.inside.push(a.rating_inside); s.outside.push(a.rating_outside); s.hasmada.push(a.hasmada); }
  }
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((x, y) => x + y, 0) / xs.length) * 10) / 10 : "");
  return [...by.values()].sort((x, y) => x.name.localeCompare(y.name)).map((s) => ({
    Student: s.name,
    Days: s.days,
    "Average quiz %": avg(s.quiz),
    "Average AI score": avg(s.ai),
    "Average teacher score": avg(s.manual),
    "Average inside (0-5)": avg(s.inside),
    "Average outside (0-5)": avg(s.outside),
    "Average hasmada (0-10)": avg(s.hasmada),
  }));
}

function resultRows(attempts) {
  return attempts.map((a) => {
    const q = a.quiz || [];
    const mark = (i) => (q[i] && a.quiz_done ? (q[i].answer === q[i].correct ? "Right" : "Wrong") : "");
    const rating = (key) => (a.ratings_done ? a[key] : "");
    return {
      Date: a.date,
      Student: a.student_name,
      Level: a.level_name || "",
      Read: a.parts.reading ? sourcesText(a.sources) : "",
      "Reading status": gradeText(a),
      "AI score": a.ai_score ?? "",
      "AI feedback": a.ai_feedback || "",
      "Teacher score": a.manual_score ?? "",
      "Teacher feedback": a.manual_feedback || "",
      "Quiz %": a.parts.quiz && a.quiz_done ? a.quiz_percent : "",
      "Question 1": mark(0),
      "Question 2": mark(1),
      "Reviewed inside (0-5)": rating("rating_inside"),
      "Reviewed outside (0-5)": rating("rating_outside"),
      "Hasmada (0-10)": rating("hasmada"),
      "Recording length (sec)": a.duration_sec ?? "",
      "Finished at": a.completed_at ? new Date(a.completed_at).toLocaleString() : "Not finished",
    };
  });
}

function loadSheetJs() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error("The spreadsheet tool didn’t load. Check the internet connection and try again."));
    document.head.append(s);
  });
}

async function exportSpreadsheet(data) {
  const XLSX = await loadSheetJs();
  const wb = XLSX.utils.book_new();
  const results = resultRows(data.attempts);
  const summary = summarize(data.attempts);
  const resultsSheet = XLSX.utils.json_to_sheet(results.length ? results : [{ Date: "No results" }]);
  resultsSheet["!cols"] = [10, 18, 12, 16, 20, 9, 60, 12, 60, 8, 10, 10, 12, 13, 12, 12, 20].map((w) => ({ wch: w }));
  const summarySheet = XLSX.utils.json_to_sheet(summary.length ? summary : [{ Student: "No results" }]);
  summarySheet["!cols"] = [20, 7, 14, 16, 20, 18, 19, 20].map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, summarySheet, "Summary");
  XLSX.utils.book_append_sheet(wb, resultsSheet, "Results");
  XLSX.writeFile(wb, `gemara-results-${data.from}-to-${data.to}.xlsx`);
}

function exportPdf(data) {
  const summary = summarize(data.attempts);
  const results = resultRows(data.attempts);
  const studentsLabel = state.report.studentIds.length
    ? state.report.studentIds.map((id) => (state.overview.students.find((s) => s.id === id) || {}).name).filter(Boolean).join(", ")
    : "All students";
  const table = (rows, cols) => h("table", {},
    h("thead", {}, h("tr", {}, cols.map((c) => h("th", {}, c)))),
    h("tbody", {}, rows.map((row) => h("tr", {}, cols.map((c) => h("td", {}, String(row[c] ?? "")))))));

  printArea.replaceChildren(
    h("h1", {}, "Gemara reading report"),
    h("p", {}, `${formatDate(data.from)} to ${formatDate(data.to)}. ${studentsLabel}.`),
    h("h2", {}, "Summary"),
    summary.length ? table(summary, Object.keys(summary[0])) : h("p", {}, "No results."),
    h("h2", {}, "Results"),
    results.length ? table(results, ["Date", "Student", "Level", "Read", "Reading status", "AI score", "Teacher score", "Quiz %", "Reviewed inside (0-5)", "Reviewed outside (0-5)", "Hasmada (0-10)"]) : h("p", {}, "No results."),
    results.some((x) => x["AI feedback"] || x["Teacher feedback"]) ? h("h2", {}, "Feedback") : null,
    ...data.attempts.filter((a) => a.ai_feedback || a.manual_feedback).map((a) => h("div", { class: "fb" },
      h("strong", {}, `${a.date}, ${a.student_name}`),
      a.ai_feedback ? h("p", {}, `AI: ${a.ai_feedback}`) : null,
      a.manual_feedback ? h("p", {}, `Teacher: ${a.manual_feedback}`) : null)),
  );
  window.print();
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function renderSettings() {
  await refreshOverview();
  const ov = state.overview;

  const code = h("input", { type: "text", value: ov.class_code, autocomplete: "off", autocapitalize: "off", spellcheck: "false" });
  const codeBtn = h("button", { class: "btn primary", type: "submit" }, "Save class code");
  const codeForm = h("form", {
    class: "row-form",
    onsubmit: (ev) => {
      ev.preventDefault();
      guard(async () => {
        if (ov.class_code && code.value.trim() !== ov.class_code &&
            !confirm("Change the class code? Every iPad will need the new code typed in once.")) return;
        await api("/api/teacher/settings", { method: "PUT", body: { class_code: code.value } });
        toast("Class code saved");
        await refreshOverview();
      });
    },
  }, h("label", { class: "field" }, h("span", {}, "Class code"), code), codeBtn);

  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [ov.timezone];
  if (!zones.includes(ov.timezone)) zones.unshift(ov.timezone);
  const tz = h("select", {}, zones.map((z) => h("option", { value: z, selected: z === ov.timezone ? true : null }, z.replace(/_/g, " "))));
  const tzBtn = h("button", { class: "btn primary" }, "Save time zone");
  tzBtn.addEventListener("click", () => guard(async () => {
    await api("/api/teacher/settings", { method: "PUT", body: { timezone: tz.value } });
    toast("Time zone saved");
    await refreshOverview();
  }));

  main.replaceChildren(
    h("header", {}, h("h2", {}, "Settings")),
    h("section", { class: "panel" },
      h("h3", {}, "iPad unlock"),
      h("p", { class: "muted" }, "Students type this once on each iPad. Changing it locks every iPad until the new code is entered."),
      codeForm),
    h("section", { class: "panel" },
      h("h3", {}, "School time zone"),
      h("p", { class: "muted" }, `Decides when a new school day starts. Today is ${formatDate(ov.today)}.`),
      h("div", { class: "row-form" }, h("label", { class: "field" }, h("span", {}, "Time zone"), tz), tzBtn)),
    h("section", { class: "panel" },
      h("h3", {}, "AI grader"),
      ov.grader_connected
        ? h("p", {}, h("span", { class: "pill ok" }, "Connected"), ` Readings that take longer than ${ov.grader_timeout_seconds} seconds go to Manual grading.`)
        : h("p", {}, h("span", { class: "pill warn" }, "Not connected"), " Every reading goes to Manual grading until GRADER_URL is set in Cloudflare.")),
    h("section", { class: "panel" },
      h("h3", {}, "Sign out"),
      h("p", { class: "muted" }, "Sign out when you’re done on a shared iPad."),
      h("div", {}, h("button", {
        class: "btn",
        onclick: () => guard(async () => {
          await api("/api/teacher/logout", { method: "POST" });
          showLogin();
        }),
      }, "Sign out"))),
  );
}

boot();
