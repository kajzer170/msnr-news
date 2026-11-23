# MSNR News — automat NEWS (wydarzenia + alerty)

Skrypt obsługuje dwa osobne strumienie (dwa webhooki/kanały):

| Kanał (webhook) | Co wysyła | Kiedy | Czego nie ma |
|---|---|---|---|
| `📅・wydarzenia` (`WEBHOOK_KALENDARZ`) | kalendarz makro USA (High + Medium): digest dnia + alert **30 min przed** publikacją High Impact | digest codziennie **07:00** czasu PL (raz dziennie, do końca dnia), **tylko w dni robocze** | nagłych newsów/nagłówków |
| `🚨・alerty` (`WEBHOOK_ALERTY`) | **nagłe newsy/nagłówki** rynkowe wykryte w RSS (filtrowane słowami-kluczowymi) | w trakcie dnia (przy każdym przebiegu `auto`, cron co 10 min) | kalendarza dnia, zaplanowanych wydarzeń, alertów „30 min przed” |

Zero zależności — wymaga Node 18+.

## Źródła danych

### Kalendarz makro (📅・wydarzenia)
1. **TradingView economic calendar** (główne) — stabilne, zawiera też odczyty `actual`.
2. **Forex Factory mirror** (`nfs.faireconomy.media`, best-effort) — uzupełnienie (np. mowy Fed, których TV czasem nie ma). FF ma agresywny rate limit, więc używamy osobnego cache (`ff-cache.json`, domyślnie 6 h) i traktujemy jako dodatek.

Domyślnie tylko **USA** (`COUNTRIES=["US"]`). Można zmienić w `config.json`: `"countries": ["US","CA",...]`.
Odrzucany szum: aukcje bonów, NOPA, „reserve assets" itp.

### Nagłe newsy (🚨・alerty)
- Źródła RSS (domyślnie): CNBC (US Top News, World) + MarketWatch (Realtime Headlines, Top Stories).
- Filtr słów-kluczowych (opcja C), dopasowanie po tytule i opisie (wyrazy całe / frazy): `fed, fomc, powell, warsh, trump, white house, tariff, tariffs, cpi, pce, inflation, jobs, nfp, payrolls, unemployment, recession, gdp, retail sales, oil, yields, treasury, dollar, rate cut, rate hike, sanctions, shutdown, war`.
- Deduplikacja (guid/link/tytuł) + pamięć w `state.json`; brane pod uwagę tylko świeże wpisy (domyślnie 6 h) i limit na przebieg (anty-spam).
- Uwaga: posty z Truth Social nie mają stabilnego oficjalnego RSS — trafiają, gdy pojawią się jako nagłówek w źródłach RSS (zwykle z opóźnieniem). Zakładka „News” na Forex Factory nie jest automatyzowalna (Cloudflare).

## Pliki

| Plik | Rola |
|---|---|
| `news.js` | cały automat (kalendarz + nagłówki) |
| `config.json` | webhooki/konfiguracja — **lokalnie**, w `.gitignore` (sekrety) |
| `state.json` | stan: wysłany digest, alerty makro i wysłane nagłówki (deduplikacja) |
| `feed-cache.json` | cache scalonego kalendarza (TV+FF) |
| `ff-cache.json` | cache Forex Factory (best-effort, w `.gitignore`) |
| `.github/workflows/news.yml` | GitHub Actions (cron co 10 min) |

## Konfiguracja

`config.json` (lokalnie, nie commitować):
```json
{
  "webhookKalendarz": "https://discord.com/api/webhooks/... (📅・wydarzenia)",
  "webhookAlerty": "https://discord.com/api/webhooks/... (🚨・alerty)"
}
```

Na GitHub Actions ustaw sekrety repo: `WEBHOOK_KALENDARZ`, `WEBHOOK_ALERTY` (mają pierwszeństwo przed plikiem). Można nadpisać: `countries`, `headlineFeeds`.

## Uruchamianie

```bash
node news.js auto                          # produkcja: digest + alerty makro + nagłówki
node news.js digest                        # wymuś digest teraz
node news.js digest --dry --date=2026-11-16
node news.js alerts                        # tylko alerty makro "30 min przed"
node news.js alerts --demo                 # przykładowy alert makro (na sucho/--dry)
node news.js headlines                     # tylko nagłe newsy
node news.js headlines --dry               # podgląd wykrytych nagłówków (bez wysyłki)
```
**Weekendy:** w soboty i niedziele (czas PL) digest i alerty makro są pomijane (rynki zamknięte). Nagłówki RSS nadal działają. Aby wymusić wysyłkę w weekend, użyj `--force`.

Flagi: `--dry` (bez wysyłki), `--fresh` (pomiń cache kalendarza), `--force` (wymuś wysyłkę w weekend).

## GitHub Actions

Workflow `.github/workflows/news.yml` uruchamia `node news.js auto` co 10 minut i commituje `state.json`/`feed-cache.json` (deduplikacja i pamięć wysłanych pozycji). `ff-cache.json` nie jest commitowany.

```bash
gh workflow run news.yml   # ręcznie
```
