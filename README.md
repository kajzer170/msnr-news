# MSNR News — automat kalendarza makro

Skrypt pobiera kalendarz makro i wysyła na Discorda:

| Kanał | Co wysyła | Kiedy |
|---|---|---|
| `📅・kalendarz-dnia` | wszystkie wydarzenia dnia (High + Medium), Medium zagęszczone | codziennie **07:00** czasu PL |
| `🚨・news-alerty` | alert o publikacji **High Impact** | **30 min przed** publikacją |

Zero zależności — wystarczy Node 18+.

## Źródła danych

1. **TradingView economic calendar** (główne) — stabilne, zawiera też odczyty `actual`
   (przydatne, jeśli kiedyś dorobimy kanał „wyniki po publikacji").
2. **Forex Factory mirror** (`nfs.faireconomy.media`) — zapas, gdy TradingView nie odpowie.
   Uwaga: FF ma **agresywny rate limit** (`429` + `retry-after` do kilku minut), dlatego nie jest głównym źródłem.

Domyślnie tylko **USA** (`COUNTRIES=["US"]`). Można zmienić w `config.json` (`"countries": ["US","CA",...]`).
Odrzucany szum: aukcje bonów, NOPA, „reserve assets" itp.

## Pliki

| Plik | Rola |
|---|---|
| `news.js` | cały automat |
| `config.json` | webhooki — **lokalnie**, w repo nie trafia (`.gitignore`) |
| `state.json` | pamięć: co już wysłane (żeby nie dublować) |
| `feed-cache.json` | cache kalendarza (TTL 1 h) |
| `.github/workflows/news.yml` | gotowy workflow GitHub Actions |

## Uruchamianie lokalne

```bash
node news.js auto                              # produkcja (digest 07:00 + alerty)
node news.js digest --dry --date=2026-11-16    # podgląd digestu, bez wysyłki
node news.js alerts --demo                     # przykładowy alert
node news.js digest                            # wyślij digest teraz
```

## Wdrożenie: GitHub Actions (opcja B, 0 zł)

### 1. Repozytorium

- Na GitHubie utwórz repo, np. `msnr-news`.
- **Ustaw je jako PUBLIC** — wtedy Actions ma nielimitowane minuty. W kodzie nie ma nic
  wrażliwego (webhooki są w sekretach), a prywatne repo zużywałoby limit 2000 min/mies.
- Prywatne też zadziała, ale wtedy zmień cron na `*/15 * * * *` (żeby zmieścić się w limicie).

### 2. Wypchnij pliki

W folderze `msnr-news`:

```bash
git init
git add .
git commit -m "MSNR news bot"
git branch -M main
git remote add origin https://github.com/TWOJ-LOGIN/msnr-news.git
git push -u origin main
```

### 3. Sekrety

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Nazwa | Wartość |
|---|---|
| `WEBHOOK_KALENDARZ` | webhook kanału `📅・kalendarz-dnia` |
| `WEBHOOK_ALERTY` | webhook kanału `🚨・news-alerty` |

### 4. Pierwszy test

Repo → **Actions → MSNR news → Run workflow**.
Digest wyśle się tylko między 07:00–07:59 czasu PL (tak działa tryb `auto`);
poza tą godziną zobaczysz w logu `[digest] pominięty (godzina X)` — to normalne.

### 5. Uwagi

- Cron GitHuba bywa spóźniony o 5–15 min (nie ma SLA). Dla kalendarza to bez znaczenia,
  ale alert „30 min przed" może wyjść 15–25 min przed — okno alertu jest od `T-30` do `T+5`,
  więc cron co 10 min zawsze trafi.
- GitHub **wyłącza** harmonogram po 60 dniach bez aktywności w repo. Dlatego workflow
  commituje `state.json` / `feed-cache.json` — to utrzymuje repo „żywym".

## Alternatywy

- **Twoja strona (cron + Node/PHP)** — jeśli hosting ma cron: `*/10 * * * * cd ~/msnr-news && node news.js auto >> log.txt 2>&1`. Tylko PHP? Daj znać, przepiszę.
- **Domowy serwer/VPS** — ten sam cron.

## Bezpieczeństwo

Webhook = prawo pisania na kanał. Gdyby wyciekł: *Kanał → Integracje → Webhooks → Usuń*
i wygeneruj nowy adres, potem podmiana sekretu w repo.
