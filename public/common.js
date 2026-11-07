// Shared helpers for the student and teacher pages.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "value") el.value = value;
    else if (key === "checked") el.checked = Boolean(value);
    else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = "GET", body } = {}) {
  const init = { method, headers: {}, credentials: "same-origin" };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, "Can’t reach the server. Check the Wi-Fi and try again.");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Something went wrong (${res.status}).`);
  return data;
}

let toastTimer;
export function toast(message, ms = 2600) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = h("div", { class: "toast", role: "status", "aria-live": "polite" });
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

export const SOURCE_LABELS = { gemara: "Gemara", rashi: "Rashi", tosfos: "Tosfos" };
export const SOURCE_HEBREW = { gemara: "גמרא", rashi: "רש״י", tosfos: "תוספות" };

export function formatDate(iso, opts = { weekday: "long", month: "long", day: "numeric" }) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}

export function formatTime(isoDateTime) {
  if (!isoDateTime) return "";
  return new Date(isoDateTime).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
