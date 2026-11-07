import { h, api, SOURCE_LABELS, SOURCE_HEBREW, formatDate, clock } from "/common.js";

const app = document.getElementById("app");
const IDLE_RETURN_MS = 3 * 60 * 1000;

let recorder = null;
let wakeLock = null;
const timers = new Set();

// ---------------------------------------------------------------------------
// Screen helpers
// ---------------------------------------------------------------------------

function later(fn, ms) {
  const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
  timers.add(id);
  return id;
}

function screen(...children) {
  for (const id of timers) clearTimeout(id);
  timers.clear();
  app.replaceChildren(...children);
  window.scrollTo(0, 0);
}

function center(...children) {
  return h("div", { class: "s-center" }, h("div", { class: "stack" }, ...children));
}

function spinner() {
  return h("div", { class: "spinner", role: "img", "aria-label": "Loading" });
}

function head(student, sub, action) {
  return h("header", { class: "s-head" },
    h("div", { class: "who" }, h("strong", {}, student.name), sub ? h("span", { class: "muted" }, sub) : null),
    action || null);
}

function showMessage(title, text, buttonLabel, action) {
  screen(center(
    title ? h("h1", {}, title) : null,
    h("p", {}, text),
    h("button", { class: "btn primary big", onclick: action }, buttonLabel),
  ));
}

function handleError(err, action, label = "Try again") {
  if (err.status === 403) return showUnlock();
  showMessage(null, err.message, label, action);
}

function requestWake() {
  if (!("wakeLock" in navigator) || wakeLock) return;
  navigator.wakeLock.request("screen").then((lock) => {
    wakeLock = lock;
    lock.addEventListener("release", () => { wakeLock = null; });
  }).catch(() => {});
}

function releaseWake() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

function releaseRecorder() {
  if (recorder) recorder.release();
  recorder = null;
}

// ---------------------------------------------------------------------------
// Start-up and unlocking
// ---------------------------------------------------------------------------

async function boot() {
  screen(center(spinner()));
  try {
    const s = await api("/api/student/session");
    if (!s.setup) {
      return showMessage("Not set up yet", "Your teacher needs to set a class code before this iPad can be used.", "Check again", boot);
    }
    if (!s.unlocked) return showUnlock();
    showNames();
  } catch (err) {
    showMessage(null, err.message, "Try again", boot);
  }
}

function showUnlock() {
  const input = h("input", {
    type: "text", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false",
    "aria-label": "Class code", placeholder: "Class code", style: { fontSize: "1.4rem", textAlign: "center" },
  });
  const error = h("p", { class: "error-text", role: "alert" });
  const button = h("button", { class: "btn primary big", type: "submit" }, "Unlock this iPad");
  const form = h("form", {
    class: "stack",
    style: { width: "100%" },
    onsubmit: async (ev) => {
      ev.preventDefault();
      if (!input.value.trim()) return input.focus();
      button.disabled = true;
      error.textContent = "";
      try {
        await api("/api/student/unlock", { method: "POST", body: { code: input.value } });
        showNames();
      } catch (err) {
        error.textContent = err.message;
        button.disabled = false;
        input.select();
      }
    },
  },
    h("h1", {}, "Unlock this iPad"),
    h("p", { class: "muted" }, "Type the class code from your teacher. Each iPad only needs it once."),
    input, button, error);
  screen(h("div", { class: "s-center" }, form));
  input.focus();
}

// ---------------------------------------------------------------------------
// Name picker
// ---------------------------------------------------------------------------

let lastRoster = "";

async function showNames(prefetched) {
  releaseRecorder();
  releaseWake();
  let data = prefetched;
  if (!data) {
    try {
      data = await api("/api/student/roster");
    } catch (err) {
      return handleError(err, () => showNames());
    }
  }
  lastRoster = JSON.stringify(data);

  const stateText = { done: "Finished today", resume: "Finish your quiz", ready: "" };
  const tiles = data.students.map((s) =>
    h("button", { class: `name-tile ${s.status}`, onclick: () => start(s) },
      h("span", {}, s.name),
      h("span", { class: "state" }, stateText[s.status] || "")));

  screen(
    h("header", { class: "s-head" },
      h("div", { class: "who" }, h("strong", {}, "Tap your name"), h("span", { class: "muted" }, formatDate(data.today)))),
    data.students.length
      ? h("div", { class: "names" }, tiles)
      : center(h("p", {}, "There are no students on the list yet. Your teacher can add them.")),
  );

  // Pick up changes (new students, finished students) without disturbing a tap.
  const refresh = async () => {
    try {
      const fresh = await api("/api/student/roster");
      if (JSON.stringify(fresh) !== lastRoster) return showNames(fresh);
    } catch { /* try again next time */ }
    later(refresh, 30000);
  };
  later(refresh, 30000);
}

async function start(student) {
  if (student.status === "done") {
    return showMessage(student.name, "You already finished today. Great job.", "Back to names", () => showNames());
  }
  screen(center(spinner(), h("p", {}, "Getting your reading…")));
  let data;
  try {
    data = await api("/api/student/start", { method: "POST", body: { student_id: student.id } });
  } catch (err) {
    return handleError(err, () => showNames(), "Back to names");
  }
  if (data.mode === "quiz") {
    kickGrading(data.attempt_id);
    return showQuiz(data.student, data.attempt_id, data.questions);
  }
  showReading(data);
}

// ---------------------------------------------------------------------------
// Reading and recording
// ---------------------------------------------------------------------------

class Recorder {
  constructor({ maxSeconds, onTick, onStopped, onLevel }) {
    Object.assign(this, { maxSeconds, onTick, onStopped, onLevel });
    this.state = "idle";
  }

  static supported() {
    return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  static canPause() {
    return Boolean(window.MediaRecorder && typeof MediaRecorder.prototype.pause === "function");
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"]
      .find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
    this.chunks = [];
    this.mr = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.mr.addEventListener("dataavailable", (e) => { if (e.data && e.data.size) this.chunks.push(e.data); });
    this.finished = new Promise((resolve) => this.mr.addEventListener("stop", resolve, { once: true }));
    this.mr.start();
    this.elapsed = 0;
    this.since = performance.now();
    this.state = "recording";
    this.ticker = setInterval(() => this.tick(), 200);
    this.startMeter();
  }

  get seconds() {
    return this.elapsed + (this.state === "recording" ? (performance.now() - this.since) / 1000 : 0);
  }

  tick() {
    const s = this.seconds;
    this.onTick(s);
    if (s >= this.maxSeconds && this.state === "recording") this.stop(true);
  }

  pause() {
    if (this.state !== "recording") return;
    this.mr.pause();
    this.elapsed += (performance.now() - this.since) / 1000;
    this.state = "paused";
    this.onLevel(0);
    this.onTick(this.seconds);
  }

  resume() {
    if (this.state !== "paused") return;
    this.mr.resume();
    this.since = performance.now();
    this.state = "recording";
  }

  async stop(auto = false) {
    if (this.state !== "recording" && this.state !== "paused") return;
    if (this.state === "recording") this.elapsed += (performance.now() - this.since) / 1000;
    this.state = "stopping";
    clearInterval(this.ticker);
    this.mr.stop();
    await this.finished;
    const type = this.mr.mimeType || (this.chunks[0] && this.chunks[0].type) || "audio/mp4";
    const blob = new Blob(this.chunks, { type });
    // Turn the microphone off so playback is at full volume and the mic light goes out.
    this.releaseStream();
    this.state = "stopped";
    this.onStopped(blob, Math.min(this.elapsed, this.maxSeconds), auto);
  }

  startMeter() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ac = new AC();
      this.ac.resume();
      const source = this.ac.createMediaStreamSource(this.stream);
      const analyser = this.ac.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const loop = () => {
        if (this.state === "recording") {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
          this.onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 5));
        }
        this.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch { /* the level ring is optional */ }
  }

  releaseStream() {
    cancelAnimationFrame(this.raf);
    this.onLevel(0);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ac) this.ac.close().catch(() => {});
    this.ac = null;
  }

  release() {
    clearInterval(this.ticker);
    try { if (this.mr && this.mr.state !== "inactive") this.mr.stop(); } catch { /* already stopped */ }
    this.releaseStream();
    this.state = "idle";
  }
}

function micErrorMessage(err) {
  if (!Recorder.supported()) return "This iPad can’t record here. Open the page in Safari.";
  if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
    return "The microphone is blocked. Ask your teacher to allow it (Settings › Apps › Safari › Microphone).";
  }
  if (err && err.name === "NotFoundError") return "No microphone was found.";
  return "The microphone didn’t start. Tap Record to try again.";
}

function showReading({ student, level, reading, max_seconds }) {
  requestWake();
  releaseRecorder();

  let state = "idle";
  let blob = null;
  let duration = 0;
  let audioUrl = null;

  const now = h("span", {}, clock(0));
  const timer = h("div", { class: "timer" }, now, " ", h("small", {}, `/ ${clock(max_seconds)}`));
  const hint = h("div", { class: "hint", role: "status", "aria-live": "polite" });
  const player = h("audio", { controls: true, preload: "auto" });
  const left = h("div", { class: "left" });
  const recBtn = h("button", { class: "rec-btn", type: "button" });
  const pauseBtn = h("button", { class: "btn", type: "button" });
  const againBtn = h("button", { class: "btn", type: "button" }, "Record again");
  const sendBtn = h("button", { class: "btn primary", type: "button" }, "Send reading");
  const side = h("div", { class: "side" });

  recorder = new Recorder({
    maxSeconds: max_seconds,
    onTick: (s) => { now.textContent = clock(s); },
    onLevel: (v) => recBtn.style.setProperty("--level", String(1 + v * 0.22)),
    onStopped: (b, secs, auto) => {
      blob = b;
      duration = secs;
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = URL.createObjectURL(b);
      player.src = audioUrl;
      setState("stopped");
      if (auto) hint.textContent = "The recording stopped at 3 minutes. Listen back, then send it or record again.";
    },
  });

  function setState(next) {
    state = next;
    recBtn.classList.toggle("recording", state === "recording");
    recBtn.classList.toggle("paused", state === "paused");
    recBtn.classList.toggle("hidden", state === "stopped");
    side.replaceChildren();
    left.replaceChildren();

    if (state === "idle") {
      recBtn.replaceChildren("Record");
      recBtn.setAttribute("aria-label", "Start recording");
      now.textContent = clock(0);
      hint.textContent = "Tap Record and read the text aloud. You can pause if you need to.";
      left.append(timer, hint);
    } else if (state === "recording" || state === "paused") {
      recBtn.replaceChildren(h("span", { class: "square" }));
      recBtn.setAttribute("aria-label", "Stop recording");
      hint.replaceChildren(
        state === "recording" ? h("span", { class: "rec-dot" }) : null,
        state === "recording" ? "Recording. Tap the square when you finish." : "Paused. Tap Resume to keep going.");
      left.append(timer, hint);
      if (Recorder.canPause()) {
        pauseBtn.textContent = state === "recording" ? "Pause" : "Resume";
        side.append(pauseBtn);
      }
    } else if (state === "stopped") {
      hint.textContent = `Your recording is ${clock(duration)}. Listen back, then send it.`;
      left.append(player, hint);
      againBtn.disabled = false;
      sendBtn.disabled = false;
      sendBtn.textContent = "Send reading";
      side.append(againBtn, sendBtn);
    }
  }

  recBtn.addEventListener("click", async () => {
    if (state === "idle") {
      recBtn.disabled = true;
      try {
        await recorder.start();
        setState("recording");
      } catch (err) {
        recorder.release();
        hint.textContent = micErrorMessage(err);
      } finally {
        recBtn.disabled = false;
      }
    } else if (state === "recording" || state === "paused") {
      recBtn.disabled = true;
      await recorder.stop(false);
      recBtn.disabled = false;
    }
  });

  pauseBtn.addEventListener("click", () => {
    if (state === "recording") { recorder.pause(); setState("paused"); }
    else if (state === "paused") { recorder.resume(); setState("recording"); }
  });

  againBtn.addEventListener("click", () => {
    if (!confirm("Record again? Your current recording will be erased.")) return;
    player.pause();
    player.removeAttribute("src");
    blob = null;
    recorder.state = "idle";
    setState("idle");
  });

  sendBtn.addEventListener("click", async () => {
    if (!blob) return;
    player.pause();
    sendBtn.disabled = true;
    againBtn.disabled = true;
    sendBtn.textContent = "Sending…";
    hint.textContent = "Sending your reading. Keep this screen open.";
    const ext = blob.type.includes("webm") ? "webm" : "m4a";
    const form = new FormData();
    form.append("student_id", String(student.id));
    form.append("reading_id", String(reading.id));
    form.append("duration", duration.toFixed(1));
    form.append("audio", blob, `reading.${ext}`);
    try {
      const res = await api("/api/student/submit", { method: "POST", body: form });
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      releaseRecorder();
      kickGrading(res.attempt_id);
      showQuiz(student, res.attempt_id, res.questions);
    } catch (err) {
      if (err.status === 403) return showUnlock();
      if (err.status === 409) return showMessage(null, err.message, "Back to names", () => showNames());
      hint.textContent = `${err.message} Tap Send reading to try again.`;
      sendBtn.disabled = false;
      againBtn.disabled = false;
      sendBtn.textContent = "Send reading";
    }
  });

  const leave = h("button", {
    class: "btn quiet",
    onclick: () => {
      if ((blob || state === "recording" || state === "paused") && !confirm("Leave without sending? Your recording will be erased.")) return;
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      showNames();
    },
  }, "Not you?");

  screen(
    head(student, `${level.name} · ${SOURCE_LABELS[reading.source_type] || ""}`, leave),
    h("div", { class: "reading-wrap" },
      h("article", { class: "page", lang: "he" },
        h("div", { class: "source" }, SOURCE_HEBREW[reading.source_type] || ""),
        h("div", { class: "text" }, reading.text))),
    h("div", { class: "dock" },
      h("div", { class: "dock-inner" }, left, recBtn, side)),
  );
  setState("idle");
}

// Grading runs on the server while the student answers the quiz.
function kickGrading(attemptId) {
  api("/api/student/grade", { method: "POST", body: { attempt_id: attemptId } }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Quiz
// ---------------------------------------------------------------------------

function showQuiz(student, attemptId, questions) {
  requestWake();
  const answers = questions.map(() => null);
  const handIn = h("button", { class: "btn primary big", disabled: true }, "Hand in answers");
  const error = h("p", { class: "error-text", role: "alert" });

  const blocks = questions.map((q, i) => {
    const buttons = q.choices.map((choice, j) =>
      h("button", {
        class: "choice", type: "button", role: "radio", "aria-checked": "false", dir: "auto",
        onclick: () => {
          answers[i] = j;
          buttons.forEach((b, k) => b.setAttribute("aria-checked", String(k === j)));
          handIn.disabled = answers.some((a) => a === null);
        },
      }, choice));
    return h("section", { class: "question" },
      h("p", { class: "muted" }, `Question ${i + 1} of ${questions.length}`),
      h("h2", { dir: "auto" }, q.q),
      h("div", { class: "choices", role: "radiogroup" }, buttons));
  });

  handIn.addEventListener("click", async () => {
    if (!confirm("Hand in your answers? You can’t change them afterward.")) return;
    handIn.disabled = true;
    error.textContent = "";
    try {
      await api("/api/student/quiz", { method: "POST", body: { attempt_id: attemptId, answers } });
    } catch (err) {
      if (err.status === 403) return showUnlock();
      if (err.status !== 409) {
        error.textContent = err.message;
        handIn.disabled = false;
        return;
      }
    }
    showFeedback(student, attemptId);
  });

  screen(
    head(student, "Two questions about what you read", h("button", { class: "btn quiet", onclick: () => showNames() }, "Not you?")),
    h("div", { class: "quiz" }, blocks, h("div", {}, handIn, error)),
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

function showFeedback(student, attemptId) {
  screen(
    head(student),
    center(spinner(), h("h1", {}, "Checking your reading…"), h("p", { class: "muted" }, "Your feedback will show here in a moment.")),
  );

  let deadline = null;
  const poll = async () => {
    let r = null;
    try {
      r = await api(`/api/student/result?attempt_id=${attemptId}`);
    } catch (err) {
      if (err.status === 403) return showUnlock();
    }
    if (r) {
      if (!deadline) deadline = Date.now() + r.wait_seconds * 1000;
      if (r.grading_status === "done") return showGraded(student, r);
      if (r.grading_status === "manual") return showSentToTeacher(student);
    }
    if (deadline && Date.now() > deadline) {
      await api("/api/student/giveup", { method: "POST", body: { attempt_id: attemptId } }).catch(() => {});
      return showSentToTeacher(student);
    }
    later(poll, 2000);
  };
  poll();
}

function doneButton() {
  return h("button", { class: "btn primary big", onclick: () => showNames() }, "Done");
}

function showGraded(student, result) {
  releaseWake();
  screen(
    head(student),
    center(
      h("h1", {}, "Your reading feedback"),
      result.score !== null && result.score !== undefined ? h("p", { class: "score-line" }, `Score: ${result.score}`) : null,
      h("div", { class: "feedback-card", dir: "auto" }, result.feedback),
      doneButton(),
    ),
  );
  later(() => showNames(), IDLE_RETURN_MS);
}

function showSentToTeacher(student) {
  releaseWake();
  screen(
    head(student),
    center(
      h("h1", {}, "You’re done for today"),
      h("p", {}, "Your reading was sent to your teacher, who will listen to it."),
      doneButton(),
    ),
  );
  later(() => showNames(), 60 * 1000);
}

boot();
