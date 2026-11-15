#!/usr/bin/env node
/**
 * MSNR Poland — automat newsów makro
 *
 * Źródła (w kolejności prób):
 *   1. TradingView economic calendar  (stabilne, ma też odczyty "actual")
 *   2. Forex Factory mirror           (zapas, agresywny rate limit)
 *
 * Użycie:
 *   node news.js auto            # produkcja: digest o 07:00 + alerty 30 min przed High
 *   node news.js digest          # wymuś dzienny kalendarz teraz
 *   node news.js digest --dry --date=2026-11-16   # podgląd, bez wysyłki
 *   node news.js alerts          # tylko okna alertów
 *   node news.js alerts --demo   # przykładowy alert
 *
 * Wymaga Node 18+. Zero zależności.
 */
const fs = require("fs");
const path = require("path");

const TZ = "Europe/Warsaw";
const DIGEST_HOUR = 7;
const ALERT_LEAD_MIN = 30;
const FOOTER = "-# MSNR Poland • dane: TradingView";

const COUNTRIES = ["US", "CA", "GB", "EU", "JP", "AU", "NZ", "CH", "CN"];
const FLAG = {
  USD: "🇺🇸", EUR: "🇪🇺", GBP: "🇬🇧", JPY: "🇯🇵", CAD: "🇨🇦",
  AUD: "🇦🇺", NZD: "🇳🇿", CHF: "🇨🇭", CNY: "🇨🇳",
  US: "🇺🇸", EU: "🇪🇺", GB: "🇬🇧", JP: "🇯🇵", CA: "🇨🇦",
  AU: "🇦🇺", NZ: "🇳🇿", CH: "🇨🇭", CN: "🇨🇳",
};

// ---- konfiguracja -----------------------------------------------------------
const cfgPath = path.join(__dirname, "config.json");
const CONFIG = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};
const WEBHOOK_CALENDAR = process.env.WEBHOOK_KALENDARZ || CONFIG.webhookKalendarz;
const WEBHOOK_ALERTS = process.env.WEBHOOK_ALERTY || CONFIG.webhookAlerty;

const STATE_PATH = path.join(__dirname, "state.json");
const CACHE_PATH = path.join(__dirname, "feed-cache.json");
const CACHE_TTL_MIN = Number(process.env.CACHE_TTL_MIN || 60);

const STATE = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) : { digestDate: null, alerts: [] };

// ---- pomocnicze -------------------------------------------------------------
const now = () => new Date();
const pad = (n) => String(n).padStart(2, "0");

function tzParts(d) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  const hour = g("hour") === "24" ? "00" : g("hour");
  return { key: `${g("year")}-${g("month")}-${g("day")}`, time: `${hour}:${g("minute")}`, hour: Number(hour) };
}

const fmtDateKey = (d) => tzParts(d).key;
const fmtTime = (d) => tzParts(d).time;
const fmtWeekday = (d) =>
  new Intl.DateTimeFormat("pl-PL", { timeZone: TZ, weekday: "long", day: "2-digit", month: "2-digit" }).format(d);

function num(v, unit) {
  if (v === null || v === undefined || v === "") return "";
  const s = typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")) : String(v);
  return unit ? s + unit : s;
}

// ---- cache ------------------------------------------------------------------
function readCache() {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return { ...c, events: c.events.map((e) => ({ ...e, date: new Date(e.date) })), ageMin: (Date.now() - c.at) / 60000 };
  } catch {
    return null;
  }
}

function writeCache(source, events) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify({ at: Date.now(), source, events }));
}

// ---- źródło 1: TradingView --------------------------------------------------
async function loadTradingView() {
  const from = new Date(now().getTime() - 2 * 86400000).toISOString();
  const to = new Date(now().getTime() + 8 * 86400000).toISOString();
  const url = `https://economic-calendar.tradingview.com/events?from=${from}&to=${to}&countries=${COUNTRIES.join(",")}`;
  const res = await fetch(url, {
    headers: {
      Origin: "https://www.tradingview.com",
      Referer: "https://www.tradingview.com/",
      "User-Agent": "Mozilla/5.0 (MSNR-Poland-news-bot)",
    },
  });
  if (!res.ok) throw new Error(`tradingview ${res.status}`);
  const json = await res.json();
  if (json.status !== "ok" || !Array.isArray(json.result)) throw new Error("tradingview: zły format");

  return json.result
    .map((e) => ({
      title: e.title,
      country: e.country,
      currency: e.currency,
      date: new Date(e.date),
      impact: e.importance === 1 ? "High" : e.importance === 0 ? "Medium" : "Low",
      forecast: num(e.forecast, e.unit),
      previous: num(e.previous, e.unit),
      actual: num(e.actual, e.unit),
    }))
    .filter((e) => !isNaN(e.date))
    .sort((a, b) => a.date - b.date);
}

// ---- źródło 2: Forex Factory (zapas) ---------------------------------------
async function loadForexFactory() {
  const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
    headers: { "User-Agent": "Mozilla/5.0 (MSNR-Poland-news-bot)" },
  });
  if (!res.ok) throw new Error(`forexfactory ${res.status}`);
  const raw = await res.json();
  return raw
    .map((e) => ({
      title: String(e.title || "").replace(/\\\//g, "/").trim(),
      country: e.country,
      currency: e.country,
      date: new Date(e.date),
      impact: e.impact || "Low",
      forecast: (e.forecast || "").trim(),
      previous: (e.previous || "").trim(),
      actual: "",
    }))
    .filter((e) => !isNaN(e.date))
    .sort((a, b) => a.date - b.date);
}

async function loadEvents(forceFresh) {
  const cached = readCache();
  if (!forceFresh && cached && cached.ageMin < CACHE_TTL_MIN) {
    console.log(`[feed] cache ${cached.source} (${Math.round(cached.ageMin)} min)`);
    return cached.events;
  }
  for (const [name, fn] of [["TradingView", loadTradingView], ["ForexFactory", loadForexFactory]]) {
    try {
      const events = await fn();
      writeCache(name, events);
      console.log(`[feed] pobrano ${name}: ${events.length} zdarzeń`);
      return events;
    } catch (err) {
      console.log(`[feed] ${name} nie działa (${err.message})`);
    }
  }
  if (cached) {
    console.log(`[feed] używam cache sprzed ${Math.round(cached.ageMin)} min`);
    return cached.events;
  }
  throw new Error("żadne źródło nie odpowiedziało");
}

// ---- wysyłka ----------------------------------------------------------------
async function post(webhook, content) {
  if (!webhook) throw new Error("brak webhooka w config.json");
  const res = await fetch(webhook + "?wait=true", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, username: "MSNR News", allowed_mentions: { parse: [] } }),
  });
  if (!res.ok) throw new Error(`webhook ${res.status}: ${await res.text()}`);
  await new Promise((r) => setTimeout(r, 700));
}

function splitMessage(text, limit = 1950) {
  if (text.length <= limit) return [text];
  const out = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if ((buf + "\n" + line).length > limit) {
      out.push(buf);
      buf = line;
    } else buf = buf ? buf + "\n" + line : line;
  }
  if (buf) out.push(buf);
  return out;
}

function eventLine(e) {
  const bits = [];
  if (e.forecast) bits.push(`prognoza ${e.forecast}`);
  if (e.previous) bits.push(`poprzednio ${e.previous}`);
  const detail = bits.length ? ` — _${bits.join(" · ")}_` : "";
  return `> **${fmtTime(e.date)}** ${FLAG[e.country] || "🌍"} ${e.currency || e.country} — ${e.title}${detail}`;
}

/** Medium w jednej linii na godzinę + walutę: "> **14:30** 🇨🇦 CAD — CPI · Core CPI" */
function compactLines(list) {
  const groups = new Map();
  for (const e of list) {
    const k = `${fmtTime(e.date)}|${e.country}`;
    if (!groups.has(k)) groups.set(k, { time: fmtTime(e.date), country: e.country, currency: e.currency || e.country, items: [] });
    const g = groups.get(k);
    g.items.push(e.title);
  }
  return [...groups.values()].map(
    (g) => `> **${g.time}** ${FLAG[g.country] || "🌍"} ${g.currency} — ${g.items.join(" · ")}`,
  );
}

// hałas, który nie wnosi nic dla tradera
const NOISE = /auction|nopa|reserve assets|allotted at high|bid-to-cover|total accepted|soybean/i;

// ---- digest ----------------------------------------------------------------
function buildDigest(events, forceKey) {
  const key = forceKey || fmtDateKey(now());
  const todays = events.filter((e) => fmtDateKey(e.date) === key && !NOISE.test(e.title));
  const high = todays.filter((e) => e.impact === "High");
  const medium = todays.filter((e) => e.impact === "Medium");

  const lines = [`# 📅 KALENDARZ — ${fmtWeekday(todays.length ? todays[0].date : now())}`, ""];

  if (!high.length && !medium.length) {
    lines.push("## ☕ SPOKOJNY DZIEŃ", "", "> Brak istotnych publikacji makro (High / Medium).", "");
  } else {
    if (high.length) lines.push("## 🔴 HIGH IMPACT", "", ...high.map(eventLine), "");
    if (medium.length) lines.push("## 🟡 MEDIUM", "", ...compactLines(medium), "");
    lines.push("-# Dane to nie setup — czekaj na reakcję ceny, nie na nagłówek.", "");
  }
  lines.push(FOOTER);
  return { text: lines.join("\n"), key, count: high.length + medium.length };
}

// ---- alerty ----------------------------------------------------------------
function dueAlerts(events) {
  const t = now().getTime();
  return events.filter((e) => {
    if (e.impact !== "High") return false;
    const key = `${e.date.toISOString()}|${e.country}|${e.title}`;
    if (STATE.alerts.includes(key)) return false;
    const lead = e.date.getTime() - ALERT_LEAD_MIN * 60000;
    return t >= lead && t <= e.date.getTime() + 5 * 60000;
  });
}

function buildAlert(e) {
  const bits = [];
  if (e.forecast) bits.push(`Prognoza **${e.forecast}**`);
  if (e.previous) bits.push(`Poprzednio ${e.previous}`);
  const lines = [
    `# 🚨 ZA ${ALERT_LEAD_MIN} MIN: ${e.currency || e.country} — ${e.title}`,
    "",
    `${FLAG[e.country] || "🌍"} **${e.currency || e.country}** · 🔴 High Impact · **${fmtTime(e.date)}**`,
  ];
  if (bits.length) lines.push(bits.join(" · "));
  lines.push("", "-# Podwyższona zmienność. Uważaj na poszerzone spready — dane to nie setup.", FOOTER);
  return lines.join("\n");
}

// ---- main ------------------------------------------------------------------
const saveState = () => fs.writeFileSync(STATE_PATH, JSON.stringify(STATE, null, 1));

(async () => {
  const mode = (process.argv[2] || "auto").toLowerCase();
  const dry = process.argv.includes("--dry");
  const dateArg = (process.argv.find((a) => a.startsWith("--date=")) || "").split("=")[1];
  const events = await loadEvents(process.argv.includes("--fresh"));

  if (mode === "digest" || mode === "auto") {
    const { text, key, count } = buildDigest(events, dateArg);
    const already = STATE.digestDate === key;
    const hourNow = tzParts(now()).hour;

    if (mode === "auto" && (already || hourNow !== DIGEST_HOUR)) {
      if (!dry) console.log(`[digest] pominięty (${already ? "już wysłany" : "godzina " + hourNow})`);
    } else {
      const parts = splitMessage(text);
      if (dry) {
        console.log("=== DIGEST ===\n" + text + `\n\n[High+Medium: ${count}, części: ${parts.length}]`);
      } else {
        for (let i = 0; i < parts.length; i++) {
          const suffix = parts.length > 1 ? `\n\n-# Część ${i + 1}/${parts.length}` : "";
          await post(WEBHOOK_CALENDAR, parts[i] + suffix);
        }
        STATE.digestDate = key;
        saveState();
        console.log(`[digest] wysłano (${count} zdarzeń, ${parts.length} cz.)`);
      }
    }
  }

  if (mode === "alerts" || mode === "auto") {
    if (mode === "alerts" && process.argv.includes("--demo")) {
      const nextHigh = events.find((e) => e.impact === "High" && e.date > now());
      console.log("=== ALERT (przykład) ===\n" + (nextHigh ? buildAlert(nextHigh) : "(brak High w najbliższych dniach)"));
      return;
    }
    const due = dueAlerts(events);
    if (!due.length) console.log("[alerts] brak zdarzeń w oknie " + ALERT_LEAD_MIN + " min");
    for (const e of due) {
      const text = buildAlert(e);
      if (dry) console.log("\n=== ALERT ===\n" + text);
      else {
        await post(WEBHOOK_ALERTS, text);
        STATE.alerts = STATE.alerts.concat(`${e.date.toISOString()}|${e.country}|${e.title}`).slice(-500);
        saveState();
        console.log(`[alert] ${e.currency || e.country} — ${e.title}`);
      }
    }
  }
})().catch((err) => {
  console.error("BŁĄD:", err.message);
  process.exit(1);
});
