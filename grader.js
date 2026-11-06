// AI grader connection.
//
// This is the only file that needs to change when the real grader is ready.
// Right now it sends the recording to GRADER_URL (if set) as multipart/form-data:
//
//   audio        the recording file (audio/mp4 from iPads)
//   text         the exact text the student was supposed to read
//   source_type  "gemara", "rashi" or "tosfos"
//   attempt_id   an id you can use for logging
//
// and expects a JSON reply:
//
//   { "feedback": "full feedback text shown to the student", "score": 87 }
//
// "score" is optional. If GRADER_URL isn't set, the grader fails, or it takes
// longer than GRADER_TIMEOUT_SECONDS, the recording goes to the teacher's
// manual grading queue instead.

export function graderConnected(env) {
  return Boolean(env.GRADER_URL);
}

export function graderTimeoutSeconds(env) {
  const n = Number(env.GRADER_TIMEOUT_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : 120;
}

export async function gradeRecording(env, { audio, audioType, text, sourceType, attemptId }) {
  if (!graderConnected(env)) {
    return { ok: false, reason: "No AI grader connected yet" };
  }

  // GRADER_URL = "mock" returns practice feedback, for testing the whole flow.
  if (env.GRADER_URL === "mock") {
    await new Promise((r) => setTimeout(r, 4000));
    const words = (text || "").split(/\s+/).filter(Boolean).length;
    const kb = Math.round((audio.byteLength || 0) / 1024);
    return {
      ok: true,
      score: null,
      feedback:
        `This is practice feedback. The real AI grader isn’t connected yet.\n\n` +
        `The reading had ${words} words and your recording was ${kb} KB. ` +
        `When the real grader is connected, its full feedback on your reading will show here.`,
    };
  }

  const ext = audioType && audioType.includes("webm") ? "webm" : "m4a";
  const form = new FormData();
  form.append("audio", new Blob([audio], { type: audioType || "audio/mp4" }), `reading.${ext}`);
  form.append("text", text || "");
  form.append("source_type", sourceType || "");
  form.append("attempt_id", String(attemptId));

  const headers = {};
  if (env.GRADER_KEY) headers.Authorization = `Bearer ${env.GRADER_KEY}`;

  let res;
  try {
    res = await fetch(env.GRADER_URL, {
      method: "POST",
      body: form,
      headers,
      signal: AbortSignal.timeout(graderTimeoutSeconds(env) * 1000),
    });
  } catch (err) {
    const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
    return { ok: false, reason: timedOut ? "AI grader took too long" : "Couldn't reach the AI grader" };
  }

  if (!res.ok) return { ok: false, reason: `AI grader returned an error (${res.status})` };

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, reason: "AI grader sent a reply that isn't JSON" };
  }

  let feedback = data && data.feedback;
  if (feedback && typeof feedback !== "string") feedback = JSON.stringify(feedback, null, 2);
  if (!feedback) return { ok: false, reason: "AI grader sent no feedback" };

  const rawScore = data.score;
  const score = rawScore === null || rawScore === undefined || rawScore === "" || !Number.isFinite(Number(rawScore))
    ? null
    : Number(rawScore);

  return { ok: true, feedback, score };
}
