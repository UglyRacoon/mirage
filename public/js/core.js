/* ============ Mirage core: state, api, ws, router, ui primitives ============ */
const App = {
  state: {
    me: null, profiles: [], groups: [], proxies: [], sessions: [], settings: {}, stats: null,
    kernels: [], sel: new Set(), view: 'dashboard', params: [], auditCache: {},
    live: { pid: null, fps: 0, targets: [], activeTab: null, url: '' },
    lang: localStorage.getItem('mg_lang') || 'en',
  },
  esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  t(key) { const d = I18N[this.state.lang] || {}; return d[key] || key; },
};

/* ---------- i18n ---------- */
const I18N = {
  en: {
    'nav.dashboard': 'Dashboard', 'nav.profiles': 'Profiles', 'nav.proxies': 'Proxies', 'nav.checker': 'Fingerprint Lab',
    'nav.flows': 'Flows (RPA)', 'nav.team': 'Team', 'nav.activity': 'Activity', 'nav.api': 'Automation API',
    'nav.settings': 'Settings', 'act.newProfile': 'New Profile',
  },
  ru: {
    'nav.dashboard': 'Панель', 'nav.profiles': 'Профили', 'nav.proxies': 'Прокси', 'nav.checker': 'Лаба отпечатков',
    'nav.flows': 'Сценарии', 'nav.team': 'Команда', 'nav.activity': 'Активность', 'nav.api': 'Automation API',
    'nav.settings': 'Настройки', 'act.newProfile': 'Новый профиль',
  },
};

/* ---------- RU dictionary (exact trimmed text-node matches) ---------- */
const RU = {
  // nav & shell
  'Dashboard': 'Панель', 'Profiles': 'Профили', 'Proxies': 'Прокси', 'Fingerprint Lab': 'Лаба отпечатков',
  'Flows (RPA)': 'Сценарии (RPA)', 'Team': 'Команда', 'Activity': 'Активность', 'Automation': 'API автоматизации', 'Settings': 'Настройки',
  'New Profile': '+ Новый профиль', 'EN': 'ЯЗ', 'control plane': 'панель управления', 'realtime link · online': 'связь в реальном времени · онлайн', 'reconnecting…': 'переподключение…',
  // login
  'AntiDetect Browser · Control Plane': 'Антидетект-браузер · Панель управления', 'enter PIN': 'введите PIN', 'default PIN:': 'PIN по умолчанию:',
  'Signed in — welcome': 'Вы вошли — добро пожаловать',
  // dashboard
  'Quick launch': 'Быстрый запуск', 'Recent activity': 'Последняя активность', 'Identity health': 'Здоровье идентичности',
  'avg consistency score': 'средняя согласованность', 'Profiles owned': 'Профилей у вас', 'running states for all profiles': 'активных сессий',
  'healthy after last probe': 'в порядке после пробы', 'Activity · 24h': 'Активность · 24ч', 'Kernel': 'Ядро', 'Live view': 'Live-просмотр',
  'No events yet.': 'Событий пока нет.', 'Nothing yet.': 'Пока пусто.',
  // profiles
  'grid': 'плитка', 'list': 'список', 'All groups': 'Все группы', 'Favorites': 'Избранное', 'Create first profile': 'Создать первый профиль',
  'No profiles yet — create one.': 'Профилей пока нет — создайте.', 'No profiles match.': 'Ни один профиль не совпадает.',
  'search name, tag, country, os…': 'имя, тег, страна, ОС…', 'New Profile': '+ Новый профиль',
  'Open live view': 'Открыть live-просмотр', 'Open live view': 'Открыть live', 'Stop': '■ Стоп',
  'running': 'запущен', 'stopped': 'остановлен', 'direct': 'напрямую', 'Favorite profile': 'В избранном',
  'Selected': 'Выбрано', 'move': 'переместить', 'tag': 'тег', 'delete': 'удалить', 'export': 'экспорт', 'regroup': 'в группу',
  // wizard/editor common
  'Create profile': 'Создать профиль', 'Profile name': 'Имя профиля', 'Pick a base template': 'Выберите базовый шаблон',
  'Browser': 'Браузер', 'Country': 'Страна', 'Group': 'Группа', 'Proxy (optional)': 'Прокси (необязательно)',
  'Tags (comma separated)': 'Теги (через запятую)', 'Start URL(s) (comma separated)': 'Стартовые URL (через запятую)',
  'General': 'Основные', 'Identity': 'Личность', 'Screen': 'Экран', 'Timezone': 'Часовой пояс', 'Hardware': 'Железо',
  'GPU': 'GPU', 'Canvas': 'Canvas', 'WebRTC': 'WebRTC', 'Fonts': 'Шрифты', 'Media': 'Медиа', 'Network': 'Сеть',
  'Proxy': 'Прокси', 'Launch': 'Запуск', 'Data': 'Данные', 'Save': 'Сохранить', 'Delete': 'Удалить', 'Edit': 'Изменить',
  'Cancel': 'Отмена', 'Close': 'Закрыть', 'Clear': 'Очистить', 'Add': 'Добавить', 'Apply': 'Применить', 'Import': 'Импорт',
  'Export': 'Экспорт', 'Test': 'Проверить', 'Name': 'Имя', 'Label': 'Метка', 'Value': 'Значение', 'Type': 'Тип',
  'Scheme': 'Схема', 'Host': 'Хост', 'Port': 'Порт', 'Domain': 'Домен', 'City': 'Город', 'Region': 'Регион', 'Time': 'Время',
  'Last opened': 'Открывался', 'Score': 'Оценка', 'Details': 'Подробнее', 'None': 'Нет', 'none': 'нет', 'auto': 'авто',
  'Regenerate identity': 'Перегенерировать личность', 'Copy JSON': 'Копировать JSON', 'Import JSON': 'Импорт JSON',
  'Consistency audit': 'Аудит согласованности', 'Live leak test': 'Живой тест утечек', 'full stealth audit of a live session': 'полный stealth-аудит живой сессии',
  'No inconsistencies found — this identity hangs together.': 'Противоречий нет — идентичность целостна.',
  'Identity source': 'Источник идентичности', 'Proxy source': 'Источник прокси', 'From library': 'Из библиотеки', 'inline': 'вручную',
  'Random / none': 'Случайно / нет', 'Rotator endpoint (one IP per session)': 'Ротатор (новый IP на сессию)',
  'Align identity to proxy geo': 'Выровнять личность по гео прокси', 'Probe': 'Проба', 'Probe exit IP & geo through this proxy': 'Проверить выходной IP и гео через прокси',
  'Cookies & storage': 'Куки и хранилище', 'Identity snapshots (auto on stop)': 'Снапшоты идентичности (авто при стопе)',
  'Browsing history': 'История просмотров', 'Browsing history (this profile)': 'История (этот профиль)',
  'Empty jar — this identity has never visited anything.': 'Хранилище пусто — эта идентичность никуда не заходила.',
  'No snapshots yet.': 'Снапшотов пока нет.', 'Nothing yet — visit sites in a launched profile.': 'Пока пусто — откройте сайт в запущенном профиле.',
  'Snapshot now': 'Снять снапшот', 'Restore': 'Восстановить', 'Expires': 'Истекают', 'launch kernel to inspect live cookies': 'запустите ядро, чтобы увидеть живые куки',
  'Incognito mode (wipe data on every stop)': 'Инкогнито (стирать данные при остановке)', 'Save cookies snapshot on stop': 'Сохранять снапшот куки при остановке',
  // editor field labels (human ones; technical keep EN)
  'languages': 'языки', 'platform': 'платформа', 'timezone': 'часовой пояс', 'accuracy (m)': 'точность (м)', 'latitude': 'широта', 'longitude': 'долгота',
  'width': 'ширина', 'height': 'высота', 'mode': 'режим', 'enabled': 'включено', 'supported': 'поддерживаются', 'mobile': 'мобильный',
  'extensions': 'расширения', 'font list': 'список шрифтов', 'voices': 'голоса', 'noise intensity': 'интенсивность шума', 'canvas seed': 'сид canvas',
  'window inner size': 'внутренний размер окна', 'keyboard layout': 'раскладка клавиатуры', 'offset (minutes)': 'смещение (мин)', 'UTC string': 'строка UTC',
  'userAgent': 'userAgent', 'vendor': 'вендор', 'User-Agent & Navigator': 'User-Agent и Navigator', 'Client Hints (Sec-CH-UA)': 'Client Hints (Sec-CH-UA)',
  'Timezone & locale': 'Часовой пояс и локаль', 'Display': 'Дисплей', 'CPU / memory / touch': 'CPU / память / touch',
  'GPU / WebGL': 'GPU / WebGL', 'WebGPU (Chromium only)': 'WebGPU (только в Chromium)', 'WebRTC leak protection': 'Защита от утечек WebRTC',
  'Plugins & MIME types': 'Плагины и MIME-типы', 'Speech voices': 'Голоса речи', 'Media devices': 'Медиа-устройства', 'Battery': 'Батарея',
  'Geolocation': 'Геолокация', 'Codecs': 'Кодеки', 'HTTP headers': 'HTTP-заголовки', 'AudioContext': 'AudioContext',
  'TLS / QUIC (kernel-level — displayed honestly)': 'TLS / QUIC (уровень ядра — честно без имитаций)',
  'fake public IP': 'публичный IP (подмена)', 'fake local IP': 'локальный IP (подмена)', 'force TCP 443 (stun mask)': 'принудить TCP 443 (маска STUN)',
  'spoof enumeration': 'подмена перечисления', 'sample-rate lock': 'фиксация частоты', 'jitter': 'дрожание (jitter)',
  // proxies
  'New proxy': 'Новый прокси', 'Add proxy': 'Добавить прокси', 'Import proxies': 'Импорт прокси', 'Probe all': 'Пробовать все', 'one per line —': 'по одному в строке —',
  'socks5://user:pass@1.2.3.4:1080': 'socks5://user:pass@1.2.3.4:1080', 'search host, label, city…': 'хост, метка, город…',
  'Latency': 'Задержка', 'Exit IP': 'Выходной IP', 'ISP / ASN': 'Провайдер / ASN', 'Geo (last probe)': 'Гео (посл. проба)', 'Used by': 'Используют',
  'not probed': 'не пробовался', 'datacenter': 'дата-центр', 'hosting': 'хостинг', 'rotator': 'ротатор', 'mark as rotators': 'пометить как ротаторы',
  'edit': 'править', 'test': 'тест', 'Test first': 'Сначала тест',
  // team / activity / flows / automation
  'Add member': 'Добавить участника', 'Email (optional)': 'Email (необязательно)', 'Password': 'Пароль', 'Accent color': 'Акцентный цвет',
  'Roles:': 'Роли:', 'admin': 'админ', 'member': 'участник', 'viewer': 'наблюдатель', 'Member': 'Участник', 'User': 'Пользователь', 'Role': 'Роль',
  'events logged': 'событий в журнале', 'events': 'события', 'history': 'история',
  'Flows': 'Сценарии', 'New flow': '+ Сценарий', 'Steps': 'Шаги', 'Target profile': 'Целевой профиль', 'Title': 'Заголовок', 'Run': 'Выполнить',
  'actions' : 'действия', 'Actions': 'Действия',
  'Automation API': 'API автоматизации', 'API keys': 'API-ключи', 'Create key': 'Создать ключ', 'Rotate': 'Ротация', 'Try it': 'Попробовать', 'Run results': 'Результаты',
  // settings
  'Max concurrent kernels': 'Макс. ядер одновременно', 'JPEG quality (20–95)': 'Качество JPEG (20–95)', 'Screencast FPS (1–12)': 'FPS трансляции (1–12)',
  'Default homepage': 'Домашняя страница по умолчанию', 'Force cloud mode (Xvfb, no visible window)': 'Принудительно облачный режим (Xvfb, без окна)',
  'Open live view automatically after launch': 'Открывать live после запуска', 'Auto-save cookies/storage snapshot on stop': 'Автосохранение снапшота при остановке',
  'Cloud mode (headless Xvfb — only live-view streaming)': 'Облачный режим (Xvfb без окна — только live-стрим)',
  'Chromium binary': 'Бинарник Chromium', 'Extra CLI args (appended after stealth baseline)': 'Доп. CLI-аргументы (после stealth-базы)',
  'X display override': 'Свой X display', 'Save settings': 'Сохранить настройки', 'Window size': 'Размер окна',
  'Backup & data': 'Бэкап и данные', 'Export all': 'Экспорт всего', 'Import file': 'Импорт файла', 'Danger zone': 'Опасная зона',
  'Wipe all profiles': 'Стереть все профили', 'About': 'О системе',
  // live view
  'Go': 'Перейти', 'Back': 'Назад', 'Forward': 'Вперёд', 'Reload': 'Обновить', 'address': 'адрес',
  '⛶ Snapshot': '⛶ Снапшот', '⌕ Leak test': '⌕ Тест утечек', '■ Stop': '■ Стоп', '⤢ Full': '⤢ Во весь экран', '⤡ Exit': '⤡ Выйти',
  'click the page to capture input · Esc releases': 'клик по странице захватывает ввод · Esc освобождает',
  'kernel not running': 'ядро не запущено', 'cookies+storage snapshot': 'снапшот куки+данных', 'run leak checker in this kernel': 'тест утечек в этом ядре',
  'view cookies': 'посмотреть куки', 'grab a hi-res screenshot': 'скриншот в высоком качестве', 'Fullscreen — keeps the address bar': 'Полный экран — адресная строка остаётся',
  'Launched': 'Запущено', 'Snapshot saved': 'Снапшот сохранён',
  // fingerprint lab
  'Audit target': 'Объект проверки', 'Identity source': 'Источник идентичности',
  '⌕ Launch kernel & run 48-probe audit': '⌕ Запустить ядро и прогнать 48 проб',
  'Public checkers': 'Публичные детекторы', 'Last result': 'Последний результат', 'not run yet': 'ещё не запускалось',
  'What is tested': 'Что проверяется', '▶ kernel': '▶ в ядро', 'booting…': 'старт…', 'opening…': 'открываю…',
  'watch this kernel →': 'смотреть это ядро →', 'launching kernel + running 48 probes…': 'запускаю ядро + 48 проб…',
  'run failed': 'сбой прогона', 'result': 'итог', 'leak(s)': 'утечки', 'probes verified': 'проб подтверждено',
  'CLEAN': 'ЧИСТО',
  // editor tabs / section headers / misc buttons
  'Time · Geo': 'Время · Гео', 'GPU · WebGL': 'GPU · WebGL', 'Canvas · Audio': 'Canvas · Audio',
  'Bulk import': 'Массовый импорт', 'Apply to profile': 'Применить к профилю', 'Import JSON': 'Импорт JSON',
  'Copy JSON': 'Копировать JSON', 'Open live': 'Открыть live', 'Clone': 'Дублировать', 'Duplicate': 'Дублировать',
  'Regenerate': 'Перегенерировать', 'Wipe data': 'Стереть данные', 'Add group': 'Добавить группу',
  'Snapshot': 'Снапшот', 'Add proxy': 'Добавить прокси', 'Edit proxy': 'Изменить прокси', 'Proxy added': 'Прокси добавлен',
  'Finger­print': 'Отпечаток', 'Regenerate identity': 'Перегенерировать личность',
  'Identity snapshots': 'Снапшоты личности', 'Restore now': 'Восстановить', 'Delete all cookies': 'Удалить все куки',
  'Launch args': 'Аргументы запуска', 'Start URLs': 'Стартовые URL', 'Home URL': 'Домашний URL',
  'Reset to OS defaults': 'Сбросить к шрифтам ОС', 'Save cookies snapshot on stop': 'Сохранять снапшот куки при остановке',
  'Recent activity': 'Последняя активность', 'Quick launch': 'Быстрый запуск',
  // toasts
  'Saved': 'Сохранено', 'Saved ✓': 'Сохранено ✓', 'Deleted': 'Удалено', 'Cloned': 'Дубликат создан', 'Stopped': 'Остановлено',
  'Cleared': 'Очищено', 'Wiped': 'Стерто', 'Profile created': 'Профиль создан', 'Flow saved': 'Сценарий сохранён', 'Settings saved': 'Настройки сохранены',
  'Identities regenerated': 'Личности перегенерированы', 'New identity applied': 'Новая личность применена', 'New identity generated': 'Новая личность сгенерирована',
  'Fingerprint JSON copied': 'JSON отпечатка скопирован', 'Identity aligned to proxy geo — press Save': 'Личность выровнена по гео прокси — нажмите Сохранить',
  'Fonts reset to OS profile': 'Шрифты сброшены к профилю ОС', 'Imported — press Save': 'Импортировано — нажмите Сохранить',
  'Probes complete': 'Пробы завершены', 'Probing all proxies…': 'Пробую все прокси…', 'Launching kernel…': 'Запускаю ядро…',
  'Cookie deletion queued (re-read to confirm)': 'Удаление куки запланировано (перечитайте для подтверждения)',
};
function applyI18n(root) {
  const btn = document.getElementById('langBtn'); if (btn) btn.textContent = App.state.lang.toUpperCase();
  // static [data-i18n] chrome: restore EN or set RU from base snapshot
  document.querySelectorAll('[data-i18n]').forEach(el => {
    if (!el.dataset.en) el.dataset.en = el.textContent;
    const k = el.dataset.i18n;
    const want = (App.state.lang === 'ru' && I18N.ru[k]) ? I18N.ru[k] : el.dataset.en;
    if (el.textContent !== want) el.textContent = want;
  });
  if (App.state.lang !== 'ru') return;
  const scope = root || document.body;
  const norm = t => t.replace(/\s+/g, ' ').trim();
  const resolve = t => {
    if (RU[t] != null) return [t, RU[t]];
    const m = /^[^\p{L}\p{N}]+/u.exec(t);
    if (m && m[0].length <= 4) { const s = t.slice(m[0].length); if (RU[s] != null) return [s, RU[s]]; }
    return [];
  };
  const tw = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || /^(SCRIPT|STYLE|TEXTAREA|CODE|PRE|OPTION)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
      if (n._mg) return NodeFilter.FILTER_REJECT;
      return resolve(norm(n.nodeValue)).length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const nodes = []; while (tw.nextNode()) nodes.push(tw.currentNode);
  for (const n of nodes) {
    const raw = n.nodeValue, t = norm(raw); const [sub, hit] = resolve(t); if (hit == null) continue;
    const a = raw.indexOf(sub[0]), z = a + sub.length;
    n.nodeValue = raw.slice(0, a) + hit + raw.slice(z); n._mg = 1;
  }
  scope.querySelectorAll('[title]').forEach(el => { const [, h] = resolve(norm(el.getAttribute('title'))); if (h) el.setAttribute('title', h); });
  scope.querySelectorAll('input[placeholder],textarea[placeholder]').forEach(el => { const [, h] = resolve(norm(el.getAttribute('placeholder'))); if (h) el.setAttribute('placeholder', h); });
}
let _i18nT = null;
new MutationObserver(() => { if (App.state.lang !== 'ru') return; clearTimeout(_i18nT); _i18nT = setTimeout(() => applyI18n(), 140); })
  .observe(document.documentElement, { childList: true, subtree: true });
function forceI18n() { document.querySelectorAll('[data-i18n]').forEach(el => { const k = el.dataset.i18n; if (I18N[App.state.lang] && I18N[App.state.lang][k]) el.textContent = I18N[App.state.lang][k]; }); applyI18n(); }


/* ---------- fetch wrapper ---------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin', signal: opts.signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || res.statusText); e.status = res.status; e.data = data; throw e; }
  return data;
}

/* ---------- toast ---------- */
function toast(msg, kind = '', opts = {}) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  if (opts.html) el.innerHTML = msg; else el.textContent = msg;
  document.getElementById('toasts').appendChild(el); applyI18n(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = '.4s'; setTimeout(() => el.remove(), 450); }, opts.ms || 3600);
}
async function guard(fn) { try { await fn(); } catch (e) { toast(e.message || 'error', 'err'); } }

/* ---------- modal ---------- */
function modal({ title, body, actions = [], wide = false, onMount }) {
  const root = document.getElementById('modalRoot');
  const mask = document.createElement('div'); mask.className = 'mask';
  const m = document.createElement('div'); m.className = 'modal' + (wide ? ' wide' : '');
  m.innerHTML = `<div class="modal-h"><span class="mt"></span><button class="iconbtn x">✕</button></div>
    <div class="modal-b"></div><div class="modal-f"></div>`;
  m.querySelector('.mt').textContent = title || '';
  const bodyEl = m.querySelector('.modal-b');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  const fEl = m.querySelector('.modal-f');
  const close = () => mask.remove();
  actions.forEach(a => {
    if (!a) return;
    const b = document.createElement('button');
    b.className = 'btn ' + (a.kind || '');
    b.textContent = a.label;
    b.onclick = () => guard(async () => { const keep = await a.onClick?.({ close, bodyEl }); if (!keep) close(); });
    fEl.appendChild(b);
  });
  if (!actions.length) fEl.remove();
  mask.onclick = e => { if (e.target === mask) close(); };
  m.querySelector('.x').onclick = close;
  mask.appendChild(m);
  root.appendChild(mask); applyI18n(mask);
  onMount?.({ bodyEl, close });
  return { close, bodyEl };
}
function confirmDlg(title, text, onYes, yesLabel) {
  modal({ title, body: `<p class="mut" style="margin:2px 0">${App.esc(text)}</p>`, actions: [{ label: 'Cancel' }, { label: yesLabel || 'Confirm', kind: 'danger', onClick: onYes }] });
}

/* ---------- websocket ---------- */
function wsConnect() {
  let ws;
  try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); }
  catch (e) { setTimeout(wsConnect, 4000); return; }
  App.state.ws = ws;
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    setConn(true);
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'app' }));
    if (App.state.live.pid) ws.send(JSON.stringify({ type: 'subscribe', channel: 'live:' + App.state.live.pid }));
  };
  ws.onmessage = e => {
    if (typeof e.data !== 'string') { if (window.onLiveFrame) onLiveFrame(e.data); return; }
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'browsers') onBrowsersMsg(m.running);
    else if (['meta', 'targets', 'nav', 'closed'].includes(m.type)) { if (window.onLiveMsg) onLiveMsg(m); }
    else if (m.type === 'rpc' && m.id && RPC.pend.has(m.id)) { const p = RPC.pend.get(m.id); RPC.pend.delete(m.id); m.error ? p.rej(new Error(m.error)) : p.res(m.result); }
    else if (m.type === 'pong') { /* keepalive */ }
  };
  ws.onclose = () => { setConn(false); setTimeout(wsConnect, 2500); };
  ws.onerror = () => { try { ws.close(); } catch (e) { } };
}
function wsSend(obj) { const ws = App.state.ws; if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

/* ---------- ws rpc (browser.* commands) ---------- */
const RPC = { seq: 0, pend: new Map() };
function rpc(method, args) {
  return new Promise((res, rej) => {
    const id = ++RPC.seq;
    RPC.pend.set(id, { res, rej });
    wsSend({ type: 'rpc', id, method, args });
    setTimeout(() => { if (RPC.pend.has(id)) { RPC.pend.delete(id); rej(new Error('rpc timeout')); } }, 15000);
  });
}
function setConn(on) {
  const d = document.getElementById('connDot'); if (!d) return;
  d.className = 'dot' + (on ? ' on' : '');
  document.getElementById('connTxt').textContent = on ? 'realtime link · online' : 'reconnecting…';
}

/* ---------- data ---------- */
async function refreshAll() {
  const [p, g, px, st, sess, settings] = await Promise.all([
    api('/api/profiles'), api('/api/groups'), api('/api/proxies'), api('/api/stats'),
    api('/api/browser/list').catch(() => ({ sessions: [] })), api('/api/settings').catch(() => ({})),
  ]);
  Object.assign(App.state, {
    profiles: p.profiles, groups: g.groups, proxies: px.proxies, stats: st, sessions: sess.sessions || [],
    settings: settings.settings || {}, kernel: settings.kernel || null,
  });
  const n1 = document.getElementById('navProfilesN'), n2 = document.getElementById('navProxiesN');
  if (n1) n1.textContent = (p.profiles || []).length;
  if (n2) n2.textContent = (px.proxies || []).length;
  const kt = document.getElementById('kernTxt');
  if (kt) kt.textContent = 'kernel: ' + (App.state.kernel?.version || App.state.kernel?.binary || 'not found');
  renderSessions();
}
function onBrowsersMsg(running) {
  App.state.sessions = running || [];
  renderSessions();
  if (['dashboard', 'profiles'].includes(App.state.view)) rerender();
}
function renderSessions() {
  const b = document.getElementById('sessionsBadge'); if (!b) return;
  const n = App.state.sessions.length;
  b.classList.toggle('hidden', !n);
  b.textContent = '● ' + n + ' active';
}
const sessOf = pid => (App.state.sessions || []).find(s => s.profileId === pid);
const profileOf = pid => App.state.profiles.find(p => p.id === pid);

/* ---------- router ---------- */
const ROUTES = {};
function route() {
  const hash = (location.hash || '#/dashboard').replace(/^#\//, '');
  const [v, ...params] = hash.split('/');
  const prevPid = App.state.live.pid;
  App.state.view = ROUTES[v] ? v : 'dashboard';
  if (App.state.view !== 'live' && prevPid) { wsSend({ type: 'unsubscribe', channel: 'live:' + prevPid }); App.state.live.pid = null; if (window.LiveCleanup) LiveCleanup(); }
  App.state.params = params;
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.dataset.v === App.state.view));
  const view = document.getElementById('view');
  view.innerHTML = '';
  view.scrollTop = 0;
  ROUTES[App.state.view](view, params);
  applyI18n();
}
function rerender() { route(); }
function go(h) { if (location.hash === h) route(); else location.hash = h; }

/* ---------- helpers ---------- */
function fmtRel(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!(s >= 0)) return new Date(iso).toLocaleString();
  if (s < 60) return Math.floor(s) + 's ago'; if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago';
}
const OS_ICON = { windows: '⊞', macos: '', linux: '🐧', android: '🤖', ios: '' };
function osIcon(fp) { return OS_ICON[fp?.os?.family] || '◆'; }
function scoreCls(s) { return s >= 90 ? 'g' : s >= 70 ? 'y' : 'r'; }
function proxyLabel(p) { return p ? `${p.scheme}://${p.host}:${p.port}` : 'direct'; }
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function val(id) { const n = document.getElementById(id); return n ? (n.type === 'checkbox' ? n.checked : n.value) : undefined; }

/* ---------- profile actions (shared) ---------- */
async function launchProfile(pid, opts = {}) {
  return api('/api/browser/start', { method: 'POST', body: { profileId: pid, ...opts } });
}
async function stopProfile(pid) { return api('/api/browser/stop', { method: 'POST', body: { profileId: pid } }); }

/* ---------- boot + login ---------- */
async function boot() {
  let me = null;
  try { me = (await api('/api/auth/me')).member; } catch (e) { }
  if (!me) return showLogin();
  App.state.me = me;
  document.getElementById('login').classList.add('hidden');
  try { await refreshAll(); } catch (e) { toast('load failed: ' + e.message, 'err'); }
  wsConnect();
  route();
  window.addEventListener('hashchange', route);
}
function showLogin() {
  const login = document.getElementById('login');
  login.classList.remove('hidden');
  const keys = document.getElementById('pinKeys');
  const err = document.getElementById('pinErr');
  const dots = document.getElementById('pinDots');
  keys.innerHTML = `<input id="pinInput" type="password" placeholder="enter PIN" autocomplete="off"
      style="grid-column:1/-1;text-align:center;font-size:17px;letter-spacing:5px;padding:12px">
    <button id="pinGo" class="btn primary" style="grid-column:1/-1;justify-content:center">Enter →</button>`;
  const input = document.getElementById('pinInput');
  const draw = () => { dots.innerHTML = Array.from({ length: Math.max(6, input.value.length) }, (_, i) => `<i class="${i < input.value.length ? 'on' : ''}"></i>`).join(''); };
  input.addEventListener('input', draw); draw();
  const submit = () => guard(async () => {
    err.textContent = '';
    const r = await api('/api/auth/login', { method: 'POST', body: { pin: input.value } });
    App.state.me = r.member;
    login.classList.add('hidden');
    await refreshAll(); wsConnect(); route();
  });
  document.getElementById('pinGo').onclick = submit;
  input.onkeydown = e => { if (e.key === 'Enter') submit(); };
  setTimeout(() => input.focus(), 60);
}

document.getElementById('quickNew').onclick = () => go('#/profiles/new');
document.getElementById('langBtn').onclick = () => { App.state.lang = App.state.lang === 'en' ? 'ru' : 'en'; localStorage.setItem('mg_lang', App.state.lang); rerender(); };
document.getElementById('userChip').onclick = () => {
  const me = App.state.me || {};
  modal({ title: 'Session', body: `<div class="kv"><div class="r"><span class="k">member</span><b>${App.esc(me.name)}</b></div><div class="r"><span class="k">role</span><b>${App.esc(me.role)}</b></div></div>`, actions: [{ label: 'Sign out', kind: 'danger', onClick: async () => { await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => { }); location.reload(); } }] });
};

window.addEventListener('DOMContentLoaded', boot);
