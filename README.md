# ◆ Mirage — web AntiDetect browser

A complete **anti-detect browser as a web application**: the control plane runs in your browser,
profile identities live in a local database, and browsing happens in **real Chromium kernels** the
server launches per profile — shown back to you as a live cloud-browser stream, like
Nstbrowser / GeeLark / GoLogin's cloud mode, but entirely self-hosted and zero-dependency.

```
node >= 22 (node:sqlite, global WebSocket)     →  no npm install, no build step
src/            backend (ESM)
public/         SPA frontend (vanilla, no framework)
test/selftest.js 31 engine tests
data/           SQLite db + per-profile kernel dirs (created at runtime)
```

**Run:** `npm start` → http://localhost:7788 → sign in with the **one-time PIN printed to the server log on first run** (change it in Team). A legacy install keeps its old PIN but auto-upgrades it to a salted scrypt hash on first login.
**Tests:** `npm run selftest`.

---

## Описание на русском (Russian)

**Mirage** — антидетект-браузер целиком в виде веб-приложения. Управляющая панель крутится в
вашем браузере, профили-личности живут в локальной базе SQLite, а сам просмотр идёт в **реальных
ядрах Chromium**, которые сервер запускает отдельно под каждый профиль и отдаёт обратно как
live-стрим облачного браузера (как Nstbrowser / GeeLark / GoLogin в cloud-режиме), но полностью
self-hosted и **без единой зависимости** — нужен только Node.js ≥ 22.

```
node >= 22 (node:sqlite, глобальный WebSocket)   →  без npm install, без сборки
src/             backend (ESM)
public/          SPA-фронтенд (vanilla, без фреймворка)
test/selftest.js 31 тест движка
data/            SQLite БД + каталоги ядер по профилям (создаются при запуске)
```

**Запуск:** `npm start` → http://localhost:7788 → вход по **одноразовому PIN, выведенному в лог сервера при первом запуске** (смените в Team). У существующей установки старый PIN работает и при первом входе автоматически апгрейдится до солёного scrypt-хэша.
**Тесты:** `npm run selftest`.

### Что внутри
- **Детерминированный генератор отпечатков** на seeded-PRNG (mulberry32): один seed → байт-идентичный
  отпечаток (32 комбинации ОС×браузер, 60+ атрибутов).
- **Аудитор когерентности** (~40 правил) выдаёт оценку 0–100 и объясняет каждую проблему прямо в редакторе.
- **Шум** для canvas / WebGL / WebGPU / audio / шрифтов / ClientRects — стабилен для профиля между сессиями.
- **Прокси-релей** (HTTP CONNECT / SOCKS5 с аутентификацией) + пробы (задержка, exit-IP, гео, ASN).
- **Облачный режим**: live-видео ядра (screencast) + мышь/клавиатура/вкладки через WebSocket.
- **Автоматизация** совместимым с AdsPower API (`/api/v1/browser/start|stop`, `user/list`, `group/list`).

### 10 фич максимальной скрытности (§2.5)
Реализованы по убыванию эффекта; перед переходом к следующей каждая гонялась через тесты и
живой аудит 6 профилей, пока не было `score 100 / 0 leaks`:

| # | Фича | Суть |
|---|---|---|
| F1 | **Когерентность модели устройства** | одно физическое устройство вяжет GPU/GL-лимиты/точность шейдеров/ядра/экран/аудио/медиа |
| F2 | **Поведенческая гуманизация** | S-кривые траектории мыши, двор/холд клавиш с 1.5% самоисправлением, замедляющийся скролл |
| F3 | **Когерентность «уже живой»** | `history.length≥2`, `performance.memory` (растёт), `storage.estimate` квота>использовано, дрейф батареи |
| F4 | **WebRTC-транспорт + консистентность** | host→маска LAN, srflx→реальный egress-IP, kernel IP-policy, проверка `public==egress` |
| F5 | **Анти-headless / анти-CDP** | `navigator.webdriver=false`, scrubber `$cdc_`/`$chrome_asyncCall`, плагины для desktop |
| F6 | **Гео следует за прокси** | GPS + часовой пояс привязываются к гео exit-IP прокси |
| F7 | **Захват TLS/JA3/JA4** | честное пассивное чтение реального ClientHello (без MITM, офлайн) + кнопка в редакторе |
| F8 | **Device-DNA** | зашифрованный экспорт/импорт личности (PBKDF2 + AES-256-GCM) |
| F9 | **Планировщик ротации** | новый seed (+опционально модель) при сохранении cookie/localStorage — сессии выживают |
| F10 | **Лог аудита команды** | `/api/audit`: кто / какой профиль / какой exit-IP (вкладка Activity) |

### Честная оговорка (§4)
TLS/JA3/JA4, HTTP/2 SETTINGS и QUIC выдаёт **сетевой стек ядра**, и JavaScript их изменить не может.
Mirage **честно показывает** реальный JA3/JA4 (F7), но не *подделывает* его — настоящее искажение
требует патченого ядра или TLS-шима на прокси (это и есть реальный moat рынка). Вся остальная
маскировка живёт внутри страницы (JS + CDP), поэтому сайты, зондирующие на сетевом уровне, видят
хост-машину.

### Развёртывание

#### Вариант 1: Интерактивный скрипт (рекомендуется)
На **любом** свежем Linux запустите интерактивный скрипт установки:
```bash
sudo ./deploy.sh
```
Скрипт предложит меню с тремя опциями:
1. **Install Mirage** — установка всех зависимостей (Node.js 22, Chromium, Xvfb, nginx), создание systemd-юнита, настройка nginx vhost, запуск сервиса
2. **Update Mirage** — обновление до последней версии с автоматическим бэкапом и откатом при ошибке
3. **Uninstall Mirage** — полное удаление приложения с подтверждением

После установки **смените PIN** в интерфейсе Team и, при удалённом доступе, закройте vhost за TLS + авторизацией.

#### Вариант 2: Ручная установка
- На этом хосте: сервис `mirage` под systemd + nginx (см. §6).
- Альтернативно: one-shot `sudo ./deploy.sh` (выберите пункт 1 в меню) установит Node 22 + chromium + Xvfb + nginx, создаст юнит, vhost, пропишет `/etc/hosts`; идемпотентен.

MIT-подобная лицензия. Не юридический совет — соблюдайте правила каждой платформы (ToS).

---

## 1 · What the market offers (2025-26 research digest)

Analyzed from official API docs / OpenAPI specs of **Multilogin** (Mimic & Stealthfox kernels,
per-subsystem masking enums `natural|custom|mask|disabled`, cookie robot, script runner, folders,
PAYG proxies), **GoLogin** (Orbita kernel, richest public OpenAPI — bulk ops, fingerprint re-roll
from template, cloud-browser WS, trash/restore, CSV import, session lock, MCP server),
**AdsPower** (the de-facto local-API standard: `/api/v1/browser/start` → `{ws.puppeteer, debug_port,
webdriver}`, 37-parameter `fingerprint_config` incl. TLS cipher lists, RPA, fakey/TOTP vault),
**Dolphin{anty}** (server-generated coherent UA/WebGL pairs via `/fingerprints/*`, automation=1
launch, synchronizer, recycle bin), **Nstbrowser** (cloud-first `LaunchFingerprint` flag enums
`Real|Noise|Masked|Custom|BasedOnIp`, WS `connect` config API, per-launch billing, containers),
**GeeLark** (cloud Android: GPS, ADB, app install, per-minute pricing), **Undetectable**,
**Incogniton** (local-vs-cloud launch split, dryLaunch), **Hidemium**, **Kameleo**.

### Feature parity matrix — what Mirage implements

| Feature | Market | Mirage |
|---|---|---|
| Seeded deterministic fingerprint generator (32 OS×browser combos, 60+ attributes) | AdsPower/GoLogin/Dolphin | ✅ + same-seed byte-identical reproducibility (nobody exposes it) |
| Consistency auditor (40+ cross-check rules → 0–100 score) | implicit in kernels | ✅ explicit, live in editor, explains every issue |
| Canvas / WebGL / WebGPU / audio / fonts / client-rects noise | all | ✅ per-profile seed, stable across sessions |
| UA ⇄ client-hints ⇄ headers ⇄ platform atomic block (GREASE brands, Edg/CriOS/FxiOS tokens) | best-in-class only | ✅ + CDP `userAgentMetadata` at header level |
| WebGL unmasked vendor/renderer pools per OS + per-GPU extension lists | AdsPower/Dolphin | ✅ incl. Apple-GPU no-ANGLE & WebGPU-vendor rules |
| Fonts: per-OS lists, `document.fonts.check`, canvas measureText geometry | AdsPower ships tables | ✅ |
| WebRTC ICE rewrite (disable / proxy-strip / spoof), STUN leak-verified | all | ✅ 0 real candidates observed in audit |
| Timezone + geolocation + Intl.Date consistency, proxy geo alignment | all | ✅ + one-click *align identity to proxy exit IP* |
| HTTP/SOCKS5 authenticated proxy relay + probe (latency, exit IP, geo, ASN, hosting flag) | Multilogin/AdsPower | ✅ hand-rolled relay, DNS-leak-free (domain ATYP) |
| Per-profile persistent `user-data-dir` (real cookies/IndexedDB on disk) | desktop norm | ✅ + automatic cookie/storage snapshots & restore |
| Cloud-browser live view (screencast streaming + mouse/keyboard/tabs) | Nstbrowser/GeeLark/GoLogin | ✅ native `Page.screencastFrame` → WS → browser tab |
| AdsPower-compatible automation API (`/api/v1/browser/start|stop`, `user/list`, `group/list`, `wdm`) | AdsPower, Dolphin | ✅ same response shape for Selenium/Puppeteer/Playwright |
| API keys, RBAC (admin/member/viewer), PIN login, team page | all paid tiers | ✅ |
| Bulk profile ops, clone, groups, tags, favorites, search, history & event logs | all | ✅ |
| In-app leak checker vs `__MIRAGE.expected` (BrowserLeaks/Pixelscan-style, 47 probes) | marketed, never built-in | ✅ first-class page + API |
| Flows (mini-RPA: goto/wait/eval/click/type/screenshot) | AdsPower RPA | ✅ basic |
| Backup export/import JSON | Multilogin/GoLogin | ✅ |
| Per-field editing + JSON import/export of the fingerprint | advanced tiers | ✅ |
| Mobile profile emulation (touch, device metrics, UA family) | GeeLark (cloud), AdsPower (local) | ✅ (x86-only kernel caveat) |
| TLS/JA3/HTTP2 fingerprint masking | kernel-level moat | ⚠ **observable, not faked** — real JA3/JA4 capture (F7), true shaping = kernel moat, see §4 |
| Device-model coherence (GPU⇄GL limits⇄cores⇄screen⇄audio⇄media) | best kernels | ✅ one physical device drives every subsystem (F1) |
| Behavioral humanization (S-curve pointer, keystroke dwell, decel scroll) | premium | ✅ `POST /api/browser/human` + humanized Flows (F2) |
| "Already-alive" coherence (history, perf.memory, storage quota, battery drift) | — | ✅ fresh devices never look factory-new (F3) |
| WebRTC transport consistency (srflx = HTTP exit IP, host mask, kernel IP policy) | all | ✅ no real-LAN leak + public==egress (F4) |
| Anti-headless / anti-CDP tripwire (navigator.webdriver, $cdc_ scrubber, plugins) | premium | ✅ active scrubber on every kernel (F5) |
| Geolocation follows proxy egress (GPS + tz snap to exit geo) | some | ✅ (F6) |
| TLS/JA3/JA4 **capture** (passive ClientHello read) | — | ✅ honest, self-serve inside editor (F7) |
| Device-DNA encrypted export/import (PBKDF2 + AES-256-GCM) | Multilogin/GoLogin | ✅ move identities between servers (F8) |
| Rotation scheduler with cookie/storage memory | Multilogin/AdsPower | ✅ new seed + optional model, sessions survive (F9) |
| Team audit trail (who / profile / exit IP) | enterprise | ✅ `/api/audit` + Activity view (F10) |
| Cloud Android phones / app install / GPS / ADB | GeeLark | ❌ out of scope (web self-hosted) |
| Built-in residential proxy network + traffic billing | Multilogin/GoLogin/Nst | ❌ bring-your-own proxies |
| Cookie robot / account warm-up automation | Multilogin/AdsPower | ❌ roadmap |
| Extension management / central sync | Multilogin/Dolphin | ⚠ via `extraArgs` (`--load-extension`) |
| Storage quota & cloud/local conversion | Multilogin | ❌ self-hosted = always local |

## 2 · Architecture

```
public/ SPA ──HTTP /api/*──> src/api.js (route table, RBAC, AdsPower-compat /api/v1)
    │                            │
    └──WS /ws (sub,input,rpc)──> src/ws.js hub ◄─ BrowserManager (src/browser/manager.js)
                                          │            │ CDP over WebSocket (src/browser/cdp.js)
                                          │            ▼
                                          │   real Chromium per profile
                                          │   data/browsers/<id> (--user-data-dir)
                                          │   :0 headed or Xvfb "cloud mode"
                                          ├─ stealth bundle injected pre-page-script:
                                          │   Page.addScriptToEvaluateOnNewDocument(runImmediately)
                                          │   + attach PAUSED (waitForDebuggerOnStart) → override → runIfWaitingForDebugger
                                          └─ proxy relay (src/browser/proxyrelay.js):
                                              localhost HTTP CONNECT/SOCKS5 gateway
                                              that injects Proxy-Authorization upstream
```

* **Fingerprint engine** (`src/fingerprint/`) — seeded mulberry32/cyrb53 PRNG draws from curated
  pools (`pools.js`) of UAs, GPU/ANGLE strings, per-GPU WebGL extension lists, screens+DPR, fonts,
  media devices, voices, codecs, regions→tz/locale/geo. **`generateFingerprint()` is pure and
  deterministic**; `consistency.js` audits ~40 cross-attribute rules; `stealth.js` compiles the
  injection bundle whose every section is error-isolated and self-hides
  (`Function.prototype.toString` returns the original native source for patched surfaces).
* **Kernel lifecycle** — launch allocates a free debug port, resolves display (local `:0` window
  or on-demand Xvfb for cloud mode), spawns Chromium with an automation-removal flag baseline,
  connects flattened CDP, and applies **per-target** overrides on attach (UA+CH metadata, headers,
  timezone, geolocation, device metrics, permissions, stealth script). Runtime.enable is never
  touched during normal ops (CDP-timing-detection hygiene); screenshots/eval enable it on demand.
* **Live view** — binary JPEG frames streamed over a hand-written RFC6455 server; the SPA maps
  pointer/key events back through `Input.dispatch*` with viewport scaling from screencast metadata.
* **Proxies** — the browser only ever sees `127.0.0.1:relay`, so Chromium's no-SOCKS-auth gap and
  credential rotation are handled by the relay; probe returns latency + exit IP + geo + ASN +
  hosting/proxy flags (ip-api) **through the tunnel itself**.

## 2.5 · Max-stealth hardening — the 10 features

Built strongest-effect-first, each gated on a green audit before the next was started.

| # | Feature | What it does | Verified |
|---|---|---|---|
| F1 | **Device-model coherence** | One physical device drives GPU vendor/renderer + GL limits + GLSL precision + cores/RAM/touch + screen + audio clock + media labels — per-vendor pools (Apple draw-buf 4, Mali medium-float 10 vs 23, NVIDIA maxVP 32767). | generator + audit |
| F2 | **Behavioral humanization** | Box-Muller pointer paths (S-curve, sub-pixel tremor), keystroke dwell/hold + 1.5% self-correcting typos, decelerating scroll normalized to target. Exposed via `POST /api/browser/human` and humanized Flows. | live kernel, typed into a real input |
| F3 | **Already-alive coherence** | `history.length≥2`, `performance.memory` growing, `navigator.storage.estimate` quota>usage, battery drift from `performance.now()`, `visibilityState=visible`. | audit (4 probes ok) |
| F4 | **WebRTC transport + consistency** | host → masked LAN, srflx → real egress IP (from proxy probe), kernel `--force-webrtc-ip-handling-policy`, coherent candidate structure, `public==egress` probe. | audit 100/0 |
| F5 | **Anti-headless / anti-CDP tripwire** | `navigator.webdriver=false`, `$cdc_`/`$chrome_asyncCall` scrubber on interval, benign `window.external`, desktop plugins present (headless tell removed). | checker probes ok |
| F6 | **Geolocation follows proxy egress** | When a proxy with a resolved geo is attached, GPS + timezone snap to the exit — HTTP/WebRTC/Geo all agree. | launch logic |
| F7 | **TLS/JA3/JA4 capture** | Passive ClientHello read from a local socket → the kernel's *real* JA3/JA4/ALPN/curves (GREASE included). Honest, no MITM, works offline. See §4 for why shaping is the real moat. | live kernel capture |
| F8 | **Device-DNA encrypted export/import** | Seal the full identity (fingerprint + proxy) with PBKDF2 + AES-256-GCM; move it between servers without exposing the raw identity. | roundtrip + selftest |
| F9 | **Rotation scheduler + cookie memory** | Periodic identity rotation (new seed + optional model) that preserves the cookie jar & localStorage — logged-in sessions survive. | live rotate |
| F10 | **Team audit trail** | `/api/audit` records actor / profile / exit IP for launch, stop, rotate, import, export, regenerate, login. Shown in the Activity view. | endpoint + UI |

All 10 were implemented in order; after each, a 6-profile in-kernel audit confirmed `score 100, leaks 0` (60 probes) before the next began.

## 3 · Automation API (AdsPower-protocol compatible)

```bash
KEY=mgk_...   # Settings → API keys in the UI
curl -X POST localhost:7788/api/v1/browser/start -H "X-Api-Key: $KEY" \
     -H 'Content-Type: application/json' -d '{"user_id":"<profile id>"}'
# → {"code":0,"data":{"ws":{"puppeteer":"ws://127.0.0.1:9333/devtools/browser/…",
#      "selenium":"127.0.0.1:9333"},"debug_port":"9333",
#      "webdriver":"/api/v1/wdm/<id>/capabilities", "status":"success"}}

node -e "const p=require('playwright-core');(async()=>{ // attach to the *profile* kernel
  const b=await p.chromium.connectOverCDP('ws://127.0.0.1:9333/devtools/browser/…');
  const ctx=b.contexts()[0];                    // persistent identity, real cookies
  await (await ctx.newPage()).goto('https://example.com');
})()"
```

`GET /api/v1/user/list`, `GET /api/v1/group/list`, `POST /api/v1/browser/stop`,
`GET /api/v1/browser/status`, `POST /api/browser/eval`, `POST /api/checker/run/:id`
(full in-kernel leak audit via HTTP). Session cookie login for the UI: `POST /api/auth/login {pin}`.

## 3.5 · Proxy sources, auto-check & bulk profile generation

All proxy and fingerprint logic is now reachable both from the UI and the JSON API.

### Proxy import & parsing
`POST /api/proxies/import` accepts the common formats — `host:port`, `user:pass@host:port`,
`host:port:user:pass`, `socks5://user:pass@host:port`. Set `check:true` to probe every new
proxy right after import, and `onlyKeepAlive:true` to drop dead ones.

### Fetch from known public sources (auto-check)
`GET /api/proxies/sources` lists curated free proxy-list resources. `POST /api/proxies/fetch`
pulls raw lists, parses them, de-duplicates against existing proxies, and — when `check` is set —
verifies each one live (exit IP + geo + latency) before storing. The UI exposes this as the
**"☁ From public sources"** button on the Proxies page. ⚠️ Public free proxies are shared and
unreliable — treat them as disposable.

### Bulk probe
`POST /api/proxies/probe-all` probes every stored proxy serverside with a bounded worker pool
(default concurrency 8). The **"Probe all"** button on the Proxies page uses it.

### Country-targeted bulk profiles
`POST /api/profiles/generate-bulk {country, count, osList?, browserList?, namePrefix?,
group_id?, proxy_id?, tags?}` creates N profiles that all share the chosen country
(timezone, geolocation, languages) while OS, browser, device model, screen and seed vary.
In the UI this is the **"⚙ Generate a batch for a country"** card on the New-profile page.

> SOCKS5 (and HTTP auth) access path was hardened: the browser connects through a local
> authenticated relay (no credentials are ever placed in `--proxy-server`), and the relay
> CONNECT handshake carries a timeout so a dead proxy can never hang a probe.

## 4 · Honesty section (read this before trusting any anti-detect)

* **TLS/JA3/JA4, HTTP/2 SETTINGS, QUIC are produced by the kernel's network stack** and cannot be
  changed by JavaScript. Mirage *displays* TLS/HTTP2 profile labels and disables QUIC by default;
  matching them truly requires a patched kernel or proxy-side TLS shim — the market's real moat.
  What Mirage *can* do honestly: **capture the kernel's actual ClientHello** (F7) — point the running
  browser at a local socket and read the plaintext JA3/JA4 it sends, so you always know exactly what
  fingerprint each profile presents. Shaping it is explicitly roadmap, not claimed.
* All spoofing happens **inside the page** (JS + CDP). Sites that probe at network level see the
  host machine (Linux kernel TTL/TCP window, real renderer behind ANGLE noise).
* One kernel binary = one shared TLS/JA3 across all profiles of this install.
* Screenshots are captured via CDP — a site that detects DevTools usage (timing of
  `Runtime.enable`) could in principle notice eval/checker moments; the streaming path avoids
  `Runtime.enable` by design.
* Live view transits JPEG frames over your LAN/server — deploy behind TLS if remote.
* PIN auth is fine for a personal tool; put it behind SSO/reverse-proxy for teams on untrusted
  networks.

## 5 · Verified on this machine

* `npm run selftest` → **31/31** (determinism, 32-combo audit-clean generation, contradiction
  catchers, bundle compile & stability, pool sanity, device-model + behavioral + already-alive +
  WebRTC + DNA + rotation coherence, and a real JA3 capture).
* End-to-end: profile launched (real Chromium 152, display :0/Xvfb), 60-probe checker executed
  **inside the patched kernel**: `score 100, leaks 0` — Windows-11 identity on
  a Linux host (UA, client hints headers, Win tz/geo, GPU tuple, font stack, canvas & audio
  noise stable per profile, WebRTC candidates spoofed with public==egress, plugins/mimeTypes coherent,
  `Function.toString` self-hiding confirmed, anti-CDP tripwire clean).
* Proxy relay, probe with geo/ASN, cookie snapshots/restore, bulk ops, API-key auth — exercised
  via REST during development.

## 6 · Deployment on this host (mirage.hata)

Run as a managed service behind the machine's existing nginx, reachable at **http://mirage.hata**
(`*.hata` resolves to `192.168.0.115` via this host's `dnsmasq`; a matching `/etc/hosts` line was
added for local lookups too).

* **`/etc/systemd/system/mirage.service`** — runs `node src/index.js` as user `pluton`,
  `WorkingDirectory` = the project, `Restart=always`, `PORT=7788`. With no `DISPLAY` in a systemd
  context every kernel launches on its own **Xvfb** display (`forceXvfb` is on in the DB settings),
  so nothing pops a window on the console and Xvfb children are reaped on stop.
* **`/etc/nginx/conf.d/mirage.conf`** — vhost `server_name mirage.hata` → `proxy_pass
  http://127.0.0.1:7788`, with the `Upgrade/Connection` map (WebSocket + live screencast stream),
  64 m body limit (backup import) and buffering off. Matches the homelab's plain-HTTP convention.
* Chromium got `--no-sandbox --disable-gpu-sandbox --disable-dev-shm-usage` so the service user can
  launch it headless reliably.

Manage it:
```bash
sudo systemctl status|restart|stop mirage      # service
journalctl -u mirage -f                        # live logs
sudo nginx -t && sudo systemctl reload nginx   # after editing the vhost
```
Verified through the domain: SPA 200, login + `/api/stats` over the proxy, WS **101 Switching
Protocols**, kernel launch (mode xvfb, dedicated display), and the in-kernel checker
**score 100 / 0 leaks** — all via `http://mirage.hata`.

### One-shot deploy on any Linux server (`deploy.sh`)

`deploy.sh` turns a bare Debian/Ubuntu/RHEL box into a running Mirage instance:

```bash
# on the target server (needs root / sudo):
sudo ./deploy.sh                # installs node 22 + chromium + xvfb + nginx,
                                 # drops in the systemd unit + nginx vhost + /etc/hosts,
                                 # enables & starts mirage, prints the URL + default PIN
```

It is idempotent (safe to re-run), detects apt vs dnf, and leaves the service under
`systemd` (`mirage`) reachable on port 80. Edit the `DOMAIN`/`APP_USER`/`PORT` vars at the top
of the script to taste. For the SPA+API build, the script copies the working tree (or you point
`REPO` at a git checkout). After deploy, **change the default PIN in Team** and (if remote)
front it with TLS + auth.

> **Do this now:** fresh installs no longer ship a default PIN — a random one is printed to the log
> once on first run; an *existing* install that still uses the historical PIN `mirage` keeps working
> (it auto-upgrades to a salted hash) but **you should change it in Team** since `mirage` is publicly
> known. The whole `/api/*` surface is now auth-gated, but the transport is still plain HTTP — if this
> host is reachable beyond your LAN, **front the vhost with TLS** (`nginx listen 443`) or a Tailscale
> ACL before leaving it exposed. The automation API keys live in **Settings → API keys**.

## 7 · Security & performance hardening (applied)

A full audit (see `AUDIT.md`) drove a set of fixes; they are enforced and verified by the pre-prod
gate `test/prodcheck.mjs` (**26 PASS · 1 FAIL** — the only remaining FAIL is *TLS*, an infra step,
not code) and keep `test/selftest.js` at **31 passed / 0 failed**.

**AuthN / AuthZ**
- **Global auth gate** on every `/api/*` route — a valid session cookie **or** an `X-Api-Key` is
  required; only `POST /api/auth/login` and `GET /api/auth/me` are public. This closed the previous
  hole where profiles, proxies, backups and kernel control were readable/operable unauthenticated.
- **WebSocket is authenticated** at the upgrade (rejected before `101` without a session/key) plus a
  **same-origin `Origin` check** → no cross-site WS-hijack into a running kernel.
- **RBAC**: `viewer` is strictly read-only across REST *and* the browser RPC (`input`, `browser.*`);
  proxy test/probe and profile export now require `canWrite`.
- **Login rate-limit**: 10 attempts / 15 min / IP → `429` + `Retry-After`.

**Credentials & sessions**
- PINs are stored as **salted scrypt** (`N=16384, r=8, p=1`); a legacy unsalted `sha256` hash is
  accepted **once** and transparently upgraded on first successful login (no lockout of old installs).
- Sessions are **HMAC-SHA256 signed tokens with expiry** and timing-safe verification (replacing a
  forgeable `sha256(secret‖id)` check). Fresh installs seed a **random one-time admin PIN** to the
  log instead of the publicly-known `mirage`.

**Input & transport**
- **Stored-XSS closed at the root**: every entity id is validated (`^[A-Za-z0-9_-]{1,64}$`) on save,
  so a client-supplied id like `<svg onload=…>` or a `javascript:` href can never be persisted.
- Security headers on all responses: **CSP** (`frame-ancestors 'self'`, `base-uri 'self'`,
  `object-src 'none'`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
  `Referrer-Policy: no-referrer`. CORS no longer reflects `*` (same-host / allow-list only); 5xx
  responses no longer leak internal error strings. `generateFingerprint` falls back on unknown
  `os`/`browser`/`country` instead of crashing. `HOST` is configurable (set `127.0.0.1` behind a proxy).

**Performance** (measured with `test/bench.mjs`)
- **Static assets**: `gzip` (−66…73% bytes: `views.js` 67→18 KB) + weak `ETag` / `must-revalidate`
  → repeat SPA loads return **304** (≈0 bytes).
- **SQLite**: `synchronous=NORMAL` + `busy_timeout` + a prepared-statement cache → writes **×3.0**,
  single-row reads **×2.4**.
- **Profile list denormalized for reads**: `score`/`issues`/`os`/`browser`/`country`/`tz`/`screen`/
  `canvas` are precomputed at save time (including `auditFingerprint`), so `GET /api/profiles` no
  longer parses fingerprint blobs or re-runs the audit per row → **×18.7 (−95% CPU)** on 200 profiles.
  The list payload is unchanged and `GET /api/profiles/:id` still returns the full fingerprint;
  pre-existing rows are backfilled automatically on startup.

**Still operator-owned (not code):** front the vhost with **TLS**, **rotate the admin PIN** if it is
still the historical default, and add systemd sandboxing (`NoNewPrivileges`/`ProtectSystem=strict`/
`PrivateTmp`). The pre-prod gate `test/prodcheck.mjs` re-verifies all of the above.

## 8 · Roadmap (what the market has that we don't)
TLS-profile proxy shim · cookie-robot/warm-up flows + account vault with TOTP generation ·
extension manager with central sync · per-profile proxy failover & traffic metering ·
Playwright/Puppeteer one-click snippets per profile in the Automation tab · profile password lock ·
recycle bin with timed restore · WebGL software-rasterizer noise at kernel level (fingerprint-chromium style).

MIT-ish: use it, break it, fix it. Not legal advice — respect each platform's ToS.
