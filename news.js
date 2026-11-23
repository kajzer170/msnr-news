#!/usr/bin/env node
/**
 * MSNR Poland — automat NEWS (rozdzielone kanały)
 *
 * 📅・wydarzenia  (webhookKalendarz): kalendarz makro USA (High+Medium)
 *                 - digest codziennie 07:00 PL (do końca dnia, odporne na opóźnienia)
 *                 - alert 30 min przed publikacją High Impact
 * 🚨・alerty      (webhookAlerty):    nagłe newsy/nagłówki (USA/rynek) w ciągu dnia
 *                 - watcher RSS (CNBC, MarketWatch), filtr słów-kluczowych, deduplikacja
 *
 * Źródła kalendarza (scalane): 1) TradingView  2) Forex Factory mirror (best-effort, cache)
 * Użycie:
 *   node news.js auto            # produkcja (cron co 10 min): digest + alerty makro + nagłówki
 *   node news.js digest          # wymuś dzienny kalendarz teraz
 *   node news.js digest --dry --date=2026-11-16
 *   node news.js alerts          # tylko alerty makro "30 min przed"
 *   node news.js alerts --demo   # przykładowy alert makro
 *   node news.js headlines       # tylko nagłe newsy
 *   node news.js headlines --dry # podgląd wykrytych nagłówków (bez wysyłki)
 *
 * Wymaga Node 18+. Zero zależności.
 */
const fs = require("fs");
const path = require("path");

const TZ = "Europe/Warsaw";
const DIGEST_HOUR = 7;
const ALERT_LEAD_MIN = 30;
const FOOTER_CAL = "-# MSNR Poland • kalendarz makro";
const FOOTER_NEWS = "-# MSNR Poland • alert";

// filtry nagłówków (opcja C — propozycja zaakceptowana)
const KEYWORDS = [
  "fed", "fomc", "powell", "warsh", "trump", "white house", "tariff", "tariffs",
  "cpi", "pce", "inflation", "jobs", "nfp", "payrolls", "unemployment",
  "recession", "gdp", "retail sales", "oil", "yields", "treasury", "dollar",
  "rate cut", "rate hike", "sanctions", "shutdown", "war",
];

const HEADLINE_FEEDS = [
  { name: "CNBC", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114" }, // US Top News
  { name: "CNBC", url: "https://www.cnbc.com/id/100727362/device/rss/rss.html" }, // World (filtrowane słowami)
  { name: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines" },
  { name: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories" },
];
const HEADLINE_MAX_AGE_MIN = Number(process.env.HEADLINE_MAX_AGE_MIN || 360); // nie cofaj się dalej niż 6h
const HEADLINE_MAX_PER_RUN = Number(process.env.HEADLINE_MAX_PER_RUN || 8);   // limit anty-spam na przebieg

const FLAG = { US: "🇺🇸", CA: "🇨🇦", GB: "🇬🇧", EU: "🇪🇺", JP: "🇯🇵", AU: "🇦🇺", NZ: "🇳🇿", CH: "🇨🇭", CN: "🇨🇳" };

const NOISE = /bill auction|bond auction|note auction|inflation expectations|reserve assets|redbook|nopA|crush report|export inspections|loan officer survey|fed balance sheet|api.*stock change|mba .* applications|loading|shipping|crop progress/i;

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith("--")) || "auto";
const dry = args.includes("--dry") || args.includes("--demo");
const fresh = args.includes("--fresh");
const argDate = (args.find((a) => a.startsWith("--date=")) || "").slice(7);
const force = args.includes("--force"); // wymuszenie wysyłki też w weekend (testy)

const cfgPath = path.join(__dirname, "config.json");
const CONFIG = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};

// kraje w kalendarzu (domyślnie tylko USA). Można nadpisać w config.json: "countries": ["US","CA"]
const COUNTRIES = (Array.isArray(CONFIG.countries) && CONFIG.countries.length
  ? CONFIG.countries
  : (process.env.COUNTRIES || "US").split(",")
).map((s) => String(s).trim().toUpperCase()).filter(Boolean);

const STATE_PATH = path.join(__dirname, "state.json");
const CACHE_PATH = path.join(__dirname, "feed-cache.json");
const FF_CACHE_PATH = path.join(__dirname, "ff-cache.json");
const CACHE_TTL_MIN = Number(process.env.CACHE_TTL_MIN || 60);
const FF_CACHE_TTL_MIN = Number(process.env.FF_CACHE_TTL_MIN || 360); // FF ma ostry rate limit

function emptyState() { return { digestDate: null, alerts: [], headlines: [] }; }
function loadState() {
  if (!fs.existsSync(STATE_PATH)) return emptyState();
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return { digestDate: s.digestDate || null, alerts: Array.isArray(s.alerts) ? s.alerts : [], headlines: Array.isArray(s.headlines) ? s.headlines : [] };
  } catch { return emptyState(); }
}
const STATE = loadState();

function saveState() {
  // przytnij historię, żeby plik nie rósł w nieskończoność
  STATE.alerts = (STATE.alerts || []).slice(-500);
  STATE.headlines = (STATE.headlines || []).slice(-800);
  fs.writeFileSync(STATE_PATH, JSON.stringify(STATE, null, 1));
}

function readCache(file = CACHE_PATH) {
  if (!fs.existsSync(file)) return null;
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ...c, events: c.events.map((e) => ({ ...e, date: new Date(e.date) })), ageMin: (Date.now() - c.at) / 60000 };
  } catch { return null; }
}

function writeCache(file, source, events) {
  fs.writeFileSync(file, JSON.stringify({ at: Date.now(), source, events }));
}

function now() { return new Date(); }
function inTZ(d) { return new Date(d.toLocaleString("en-US", { timeZone: TZ })); }
function fmtTime(d) { return inTZ(d).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit", hour12: false }); }
function fmtWeekday(d) { return inTZ(d).toLocaleDateString("pl-PL", { weekday: "long", day: "2-digit", month: "2-digit" }); }
function fmtDateKey(d) { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }

// ---- webhooks --------------------------------------------------------------
function getWebhook(which) {
  if (which === "kalendarz" || which === "wydarzenia") return process.env.WEBHOOK_KALENDARZ || CONFIG.webhookKalendarz;
  return process.env.WEBHOOK_ALERTY || CONFIG.webhookAlerty || CONFIG.webhookNaglowki;
}

async function postDiscord(content, which = "alerty", username = "MSNR News") {
  if (dry) { console.log(`=== POST -> ${which} ===\n${content}\n`); return; }
  const url = getWebhook(which);
  if (!url) throw new Error(`Brak webhooka (${which}). Ustaw WEBHOOK_${which === "kalendarz" ? "KALENDARZ" : "ALERTY"} lub config.json.`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, username, allowed_mentions: { parse: [] } }),
  });
  if (!res.ok) throw new Error(`Discord ${which} ${res.status}: ${await res.text()}`);
}

// ---- źródło 1: TradingView -------------------------------------------------
async function loadTradingView() {
  const from = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  const to = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const countries = COUNTRIES.join(",");
  const url = `https://economic-calendar.tradingview.com/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&countries=${countries}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (MSNR-Poland-news-bot)",
      Origin: "https://www.tradingview.com",
      Referer: "https://www.tradingview.com/",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`tradingview ${res.status}`);
  const data = await res.json();
  const imp = { 1: "High", 0: "Medium", "-1": "Low" };
  return (data.result || [])
    .map((e) => ({
      title: e.title || e.indicator || "?",
      country: e.country,
      currency: e.currency || e.country,
      date: new Date(e.date),
      impact: imp[String(e.importance)] || "Low",
      forecast: e.forecast || "",
      previous: e.previous || "",
      actual: e.actual || "",
    }))
    .filter((e) => !isNaN(e.date))
    .sort((a, b) => a.date - b.date);
}

// ---- źródło 2: Forex Factory (uzupełnienie — mowy Fed itp.) ----------------
async function fetchForexFactory() {
  const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
    headers: { "User-Agent": "Mozilla/5.0 (MSNR-Poland-news-bot)" },
  });
  if (!res.ok) throw new Error(`forexfactory ${res.status}`);
  const raw = await res.json();
  return raw
    .map((e) => ({
      title: String(e.title || "").replace(/\\\//g, "/").trim(),
      country: e.country === "USD" ? "US" : e.country,
      currency: e.country,
      date: new Date(e.date),
      impact: e.impact || "Low",
      forecast: (e.forecast || "").trim(),
      previous: (e.previous || "").trim(),
      actual: "",
    }))
    .filter((e) => !isNaN(e.date));
}

async function loadForexFactoryBestEffort(forceFresh) {
  const cached = readCache(FF_CACHE_PATH);
  if (!forceFresh && cached && cached.ageMin < FF_CACHE_TTL_MIN) return cached.events;
  try {
    const events = await fetchForexFactory();
    writeCache(FF_CACHE_PATH, "ForexFactory", events);
    console.log(`[feed] FF: ${events.length} zdarzeń`);
    return events;
  } catch (err) {
    console.log(`[feed] FF nie działa (${err.message})${cached ? ` — cache ${Math.round(cached.ageMin)} min` : ""}`);
    return cached ? cached.events : [];
  }
}

function normTitle(t) { return String(t || "").toLowerCase().replace(/m\/m/g, "mom").replace(/q\/q/g, "qoq").replace(/y\/y/g, "yoy").replace(/[^a-z0-9]+/g, " ").trim(); }

function mergeEvents(primary, secondary) {
  const IMP = { Low: 0, Medium: 1, High: 2 };
  const out = new Map();
  const put = (e, prefer = false) => {
    const key = `${e.date.toISOString().slice(0, 16)}|${e.country}|${normTitle(e.title)}`;
    const cur = out.get(key);
    if (!cur) return out.set(key, e);
    const score = (x) => (IMP[x.impact] || 0) * 10 + (x.forecast ? 1 : 0) + (x.previous ? 1 : 0) + (x.actual ? 1 : 0);
    if (score(e) > score(cur) || (prefer && score(e) === score(cur))) out.set(key, e);
  };
  for (const e of primary) put(e, true);
  for (const e of secondary) put(e, false);
  return [...out.values()].sort((a, b) => a.date - b.date);
}

async function loadEvents(forceFresh) {
  const cached = readCache(CACHE_PATH);
  if (!forceFresh && cached && cached.ageMin < CACHE_TTL_MIN) {
    console.log(`[feed] cache ${cached.source} (${Math.round(cached.ageMin)} min)`);
    return cached.events;
  }
  let tv = null;
  try {
    tv = await loadTradingView();
    console.log(`[feed] TradingView: ${tv.length} zdarzeń`);
  } catch (err) {
    console.log(`[feed] TradingView nie działa (${err.message})`);
  }
  const ff = await loadForexFactoryBestEffort(forceFresh);
  let events = null, source = "merged";
  if (tv && ff.length) { events = mergeEvents(tv, ff); source = "TradingView+ForexFactory"; }
  else if (tv) { events = tv; source = "TradingView"; }
  else if (ff.length) { events = ff; source = "ForexFactory"; }
  if (events) {
    writeCache(CACHE_PATH, source, events);
    console.log(`[feed] łącznie: ${events.length} zdarzeń (${source})`);
    return events;
  }
  if (cached) {
    console.log(`[feed] używam cache sprzed ${Math.round(cached.ageMin)} min`);
    return cached.events;
  }
  throw new Error("żadne źródło nie odpowiedziało");
}

// ---- digest / alerty makro -------------------------------------------------
function inScope(e) { return COUNTRIES.includes(e.country) || COUNTRIES.includes(e.currency); }

function splitParts(lines, maxParts = 3) {
  const text = lines.join("\n");
  if (text.length <= 1900) return [text];
  const parts = [];
  let buf = "";
  for (const line of lines) {
    if ((buf + "\n" + line).length > 1850) { parts.push(buf); buf = line; }
    else buf = buf ? buf + "\n" + line : line;
  }
  if (buf) parts.push(buf);
  return parts;
}

function eventLine(e) {
  const bits = [];
  if (e.forecast) bits.push(`prognoza ${e.forecast}`);
  if (e.previous) bits.push(`poprzednio ${e.previous}`);
  const detail = bits.length ? ` — _${bits.join(" · ")}_` : "";
  return `> **${fmtTime(e.date)}** ${FLAG[e.country] || "🌍"} ${e.currency || e.country} — ${e.title}${detail}`;
}

function compactLines(list) {
  const groups = new Map();
  for (const e of list) {
    const k = `${fmtTime(e.date)}|${e.country}`;
    if (!groups.has(k)) groups.set(k, { time: fmtTime(e.date), country: e.country, currency: e.currency || e.country, items: [] });
    groups.get(k).items.push(e.title);
  }
  return [...groups.values()].map((g) => `> **${g.time}** ${FLAG[g.country] || "🌍"} ${g.currency} — ${g.items.join(" · ")}`);
}

function buildDigest(events, forceKey) {
  const key = forceKey || fmtDateKey(now());
  const todays = events.filter((e) => inScope(e) && fmtDateKey(e.date) === key && !NOISE.test(e.title));
  const high = todays.filter((e) => e.impact === "High");
  const medium = todays.filter((e) => e.impact === "Medium");
  const countryLabel = COUNTRIES.length === 1 && COUNTRIES[0] === "US" ? " (USA)" : COUNTRIES.length === 1 ? ` (${COUNTRIES[0]})` : "";
  const lines = [`# 📅 KALENDARZ${countryLabel} — ${fmtWeekday(todays.length ? todays[0].date : now())}`, ""];

  if (!high.length && !medium.length) {
    const scope = COUNTRIES.length === 1 && COUNTRIES[0] === "US" ? " w USA" : "";
    lines.push("## ☕ SPOKOJNY DZIEŃ", "", `> Brak istotnych publikacji makro (High / Medium)${scope}.`, "");
  }
  if (high.length) {
    lines.push("## 🔴 HIGH IMPACT", "");
    for (const e of high) lines.push(eventLine(e));
    lines.push("");
  }
  if (medium.length) {
    lines.push("## 🟡 MEDIUM", "");
    for (const line of compactLines(medium)) lines.push(line);
    lines.push("");
  }
  if (high.length || medium.length) {
    lines.push("-# Dane to nie setup — czekaj na reakcję ceny, nie na nagłówek.", "");
  }
  lines.push(FOOTER_CAL);
  return { key, parts: splitParts(lines), count: high.length + medium.length };
}

function dueAlerts(events) {
  const t = now().getTime();
  return events.filter((e) => {
    if (!inScope(e) || e.impact !== "High") return false;
    if (NOISE.test(e.title)) return false;
    const diffMin = (e.date.getTime() - t) / 60000;
    return diffMin >= 0 && diffMin <= ALERT_LEAD_MIN;
  });
}

function alertKey(e) { return `${e.date.toISOString()}|${e.country}|${e.title}`; }

function formatAlert(e) {
  const bits = [];
  if (e.forecast) bits.push(`prognoza **${e.forecast}**`);
  if (e.previous) bits.push(`poprzednio ${e.previous}`);
  return [
    `# 🚨 ZA 30 MIN: ${e.currency || e.country} — ${e.title}`,
    "",
    `${FLAG[e.country] || "🌍"} **${e.currency || e.country}** · 🔴 High Impact · **${fmtTime(e.date)}** (czas PL)`,
    bits.length ? bits.join(" · ") : "",
    "",
    "-# Podwyższona zmienność. Nie graj w „zgadywanie” odczytu — poczekaj na reakcję ceny.",
    FOOTER_CAL,
  ].filter(Boolean).join("\n");
}

// ---- nagłówki (breaking news) -> 🚨・alerty --------------------------------
function decodeEntities(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#x2019;/g, "’").replace(/&#x201c;|&#x201d;/g, '"')
    .replace(/&#x2013;|&#x2014;/g, "—").replace(/&#xa0;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ").trim();
}

function parseRSS(xml, sourceName) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const b of blocks) {
    const chunk = b.split(/<\/item>/i)[0];
    const tag = (name) => {
      const m = chunk.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
      return m ? decodeEntities(m[1]) : "";
    };
    const title = tag("title");
    const link = tag("link") || (chunk.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] || "";
    const desc = tag("description");
    const pub = tag("pubDate") || tag("dc:date") || tag("updated");
    const guid = tag("guid") || link || title;
    const date = pub ? new Date(pub) : null;
    if (title) items.push({ title, link, desc, date: date && !isNaN(date) ? date : null, guid, source: sourceName });
  }
  return items;
}

function matchesKeywords(text) {
  const t = String(text || "").toLowerCase();
  return KEYWORDS.some((k) => {
    const kk = k.toLowerCase();
    if (/\s/.test(kk)) return t.includes(kk); // frazy (np. "white house", "rate cut")
    return new RegExp(`(^|[^a-z0-9])${kk}([^a-z0-9]|$)`, "i").test(t);
  });
}

async function fetchHeadlines() {
  const out = [];
  const feeds = (Array.isArray(CONFIG.headlineFeeds) && CONFIG.headlineFeeds.length) ? CONFIG.headlineFeeds : HEADLINE_FEEDS;
  for (const f of feeds) {
    try {
      const res = await fetch(f.url, { headers: { "User-Agent": "Mozilla/5.0 (MSNR-Poland-news-bot)" } });
      if (!res.ok) { console.log(`[headlines] ${f.name} ${res.status}`); continue; }
      const xml = await res.text();
      const items = parseRSS(xml, f.name);
      for (const it of items) out.push(it);
    } catch (err) {
      console.log(`[headlines] ${f.name} błąd: ${err.message}`);
    }
  }
  return out;
}

function headlineId(it) { return it.guid || it.link || `${it.source}|${it.title}`; }

function formatHeadline(it) {
  const when = it.date ? `${fmtTime(it.date)} (PL)` : "teraz";
  const lead = (it.desc || "").replace(/\s+/g, " ").trim();
  const shortLead = lead && lead !== it.title ? (lead.length > 220 ? lead.slice(0, 217) + "…" : lead) : "";
  const link = it.link ? `🔗 ${it.link}` : "";
  return [
    `# 🗞️ NEWS: ${it.title}`,
    `${it.source} · ${when}`,
    shortLead || null,
    link || null,
    "",
    FOOTER_NEWS,
  ].filter((x) => x !== null && x !== "").join("\n");
}

async function runHeadlines(forceDry) {
  const all = await fetchHeadlines();
  const cutoff = Date.now() - HEADLINE_MAX_AGE_MIN * 60000;
  const seen = new Set(STATE.headlines || []);
  const fresh = all
    .filter((it) => it.date && it.date.getTime() >= cutoff)
    .filter((it) => !seen.has(headlineId(it)))
    .filter((it) => matchesKeywords(`${it.title} ${it.desc || ""}`))
    .sort((a, b) => a.date - b.date);

  // dedupe w obrębie bieżącego przebiegu (ten sam news w wielu feedach)
  const uniq = [];
  const titles = new Set();
  for (const it of fresh) {
    const t = normTitle(it.title).slice(0, 80);
    if (titles.has(t)) continue;
    titles.add(t);
    uniq.push(it);
  }

  const toSend = uniq.slice(0, HEADLINE_MAX_PER_RUN);
  console.log(`[headlines] pobrano ${all.length}, nowe pasujące: ${uniq.length}, do wysłania: ${toSend.length}`);

  if (!toSend.length) return 0;

  if (forceDry || dry) {
    for (const it of toSend) console.log(formatHeadline(it) + "\n---");
    return toSend.length;
  }

  for (const it of toSend) {
    await postDiscord(formatHeadline(it), "alerty");
    STATE.headlines.push(headlineId(it));
  }
  saveState();
  console.log(`[headlines] wysłano ${toSend.length}`);
  return toSend.length;
}

// ---- orchestration ---------------------------------------------------------
// w soboty i niedziele (czas PL) rynki są zamknięte — nie wysyłamy kalendarza ani alertów makro
function isWeekend(d = now()) {
  const day = inTZ(d).getDay(); // 0 = niedziela, 6 = sobota
  return day === 0 || day === 6;
}
function skipWeekend(label, when = now()) {
  if (isWeekend(when) && !force) {
    console.log(`[${label}] weekend (PL) — pomijam kalendarz i alerty makro. Użyj --force, aby wymusić.`);
    return true;
  }
  return false;
}

async function runDigest(forceKey) {
  const when = forceKey ? new Date(`${forceKey}T12:00:00Z`) : now();
  if (skipWeekend("digest", when)) return;
  const events = await loadEvents(fresh);
  const d = buildDigest(events, forceKey);
  for (let i = 0; i < d.parts.length; i++) {
    const prefix = d.parts.length > 1 ? `_(Część ${i + 1}/${d.parts.length})_\n` : "";
    await postDiscord(prefix + d.parts[i], "kalendarz");
  }
  if (!dry && !forceKey) { STATE.digestDate = d.key; saveState(); }
  console.log(`[digest] ${d.count} zdarzeń, ${d.parts.length} cz.`);
}

async function runAlerts(demo) {
  if (skipWeekend("alerts")) return;
  if (demo) {
    const sample = { title: "CPI m/m", country: "US", currency: "USD", date: new Date(Date.now() + 30 * 60000), impact: "High", forecast: "0.3%", previous: "0.4%" };
    await postDiscord(formatAlert(sample), "kalendarz");
    return;
  }
  const events = await loadEvents(false);
  const due = dueAlerts(events);
  let sent = 0;
  for (const e of due) {
    const k = alertKey(e);
    if ((STATE.alerts || []).includes(k)) continue;
    await postDiscord(formatAlert(e), "kalendarz");
    STATE.alerts.push(k);
    sent++;
  }
  if (sent) saveState();
  console.log(`[alerts] wysłano ${sent} (sprawdzono ${due.length} w oknie)`);
}

(async () => {
  try {
    if (cmd === "digest") {
      await runDigest(argDate || null);
    } else if (cmd === "alerts") {
      await runAlerts(args.includes("--demo"));
    } else if (cmd === "headlines") {
      await runHeadlines(args.includes("--dry"));
    } else if (cmd === "auto") {
      const key = fmtDateKey(now());
      const h = inTZ(now()).getHours();
      // digest: od 07:00 do końca dnia (raz dziennie), odporne na opóźnienia Actions
      if (h >= DIGEST_HOUR && STATE.digestDate !== key) await runDigest(null);
      else console.log(`[auto] digest: już wysłany (${STATE.digestDate}) lub za wcześnie (${h}:xx)`);
      await runAlerts(false);
      await runHeadlines(false);
    } else {
      console.log("Użycie: node news.js [auto|digest|alerts|headlines] [--dry] [--fresh] [--force] [--date=YYYY-MM-DD]");
    }
  } catch (err) {
    console.error("Błąd:", err.message);
    process.exit(1);
  }
})();
