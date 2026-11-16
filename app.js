/* Отпускной планировщик: дни, маршруты, рестораны, погода. Без сборки и зависимостей, кроме Leaflet. */
(() => {
  'use strict';

  const KEY = 'holiday-kgd-2026';
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const WD_FULL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const MODES = { pd: 'пешком', mt: 'на транспорте', auto: 'на машине' };
  const $ = (s, el = document) => el.querySelector(s);
  const app = $('#app');

  // ---------- состояние ----------
  const blank = () => ({ done: {}, pack: {}, packAdd: {}, notes: {}, rest: {}, restAdd: [], todo: {}, spent: {}, swap: null });
  let state = blank();
  try { state = Object.assign(blank(), JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* хранилище недоступно */ }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* без сохранения */ } };

  const ui = { view: 'days', day: 0, seg: 0, mapMode: 'map', area: 'Все', only: 'all' };
  let wx = {};          // погода: wx[place][date]
  let wxState = 'load'; // load | ok | fail
  let map = null;
  const routeCache = {};

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const todayIso = iso(new Date());
  const plural = (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // Какой план показываем в слоте дня (с учётом переноса моря на 27-е)
  function content(i) {
    const slot = DAYS[i];
    if (state.swap && slot.id === state.swap) return DAYS.find((d) => d.id === 'd27');
    if (state.swap && slot.id === 'd27') return DAYS.find((d) => d.id === state.swap);
    return slot;
  }
  const mainItems = (c) => c.items.filter((it) => !it.opt);
  const doneCount = (c) => mainItems(c).filter((it) => state.done[`${c.id}.${it.id}`]).length;

  // ---------- погода ----------
  const WMO = [
    [[0], '☀️', 'Ясно'], [[1], '🌤️', 'Малооблачно'], [[2], '⛅', 'Переменная облачность'], [[3], '☁️', 'Пасмурно'],
    [[45, 48], '🌫️', 'Туман'], [[51, 53, 55, 56, 57], '🌦️', 'Морось'], [[61, 63, 80, 81], '🌧️', 'Дождь'],
    [[65, 82], '🌧️', 'Сильный дождь'], [[66, 67], '🌧️', 'Ледяной дождь'], [[71, 73, 75, 77, 85, 86], '🌨️', 'Снег'],
    [[95, 96, 99], '⛈️', 'Гроза'],
  ];
  const wmo = (code) => { const r = WMO.find((w) => w[0].includes(code)); return r ? { icon: r[1], text: r[2] } : { icon: '🌥️', text: 'Облачно' }; };
  const isBad = (w) => w && ((w.pop >= 70 && w.rain >= 3) || w.wind >= 12);

  async function loadWeather() {
    const keys = Object.keys(PLACES);
    try {
      const cached = JSON.parse(localStorage.getItem(KEY + '-wx') || 'null');
      if (cached && Date.now() - cached.at < 3600e3) { wx = cached.wx; wxState = 'ok'; return; }
    } catch (e) { /* нет кэша */ }
    try {
      const url = 'https://api.open-meteo.com/v1/forecast'
        + `?latitude=${keys.map((k) => PLACES[k].ll[0]).join(',')}&longitude=${keys.map((k) => PLACES[k].ll[1]).join(',')}`
        + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,sunrise,sunset'
        + '&wind_speed_unit=ms&timezone=Europe%2FKaliningrad&forecast_days=16';
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      let data = await res.json();
      if (!Array.isArray(data)) data = [data];
      wx = {};
      data.forEach((loc, i) => {
        const d = loc.daily; const out = {};
        d.time.forEach((date, j) => {
          if (d.temperature_2m_max[j] == null) return;
          out[date] = {
            code: d.weather_code[j], tmax: Math.round(d.temperature_2m_max[j]), tmin: Math.round(d.temperature_2m_min[j]),
            pop: d.precipitation_probability_max[j] ?? 0, rain: d.precipitation_sum[j] ?? 0,
            wind: Math.round(d.wind_speed_10m_max[j] ?? 0), sunrise: (d.sunrise[j] || '').slice(11, 16), sunset: (d.sunset[j] || '').slice(11, 16),
          };
        });
        wx[keys[i]] = out;
      });
      wxState = 'ok';
      try { localStorage.setItem(KEY + '-wx', JSON.stringify({ at: Date.now(), wx })); } catch (e) { /* без кэша */ }
    } catch (e) {
      wxState = 'fail';
    }
  }
  const weatherFor = (i) => (wx[content(i).place] || {})[DAYS[i].date];

  function sign(n) { return (n > 0 ? '+' : '') + n + '°'; }

  function weatherCard(i) {
    const c = content(i); const w = weatherFor(i); const place = PLACES[c.place].name;
    let body;
    if (w) {
      const m = wmo(w.code);
      body = `<div class="wx-main"><div class="wx-icon">${m.icon}</div><div>
          <div class="wx-temp">${sign(w.tmax)} <small>/ ${sign(w.tmin)}</small></div>
          <div class="wx-desc">${m.text} · ${esc(place)}</div></div></div>
        <div class="wx-facts">
          <div>Осадки<b>${w.pop}% · ${w.rain.toFixed(1)} мм</b></div>
          <div>Ветер<b>до ${w.wind} м/с</b></div>
          <div>Закат<b>${w.sunset || '—'}</b></div>
        </div>`;
      if (c.sea && isBad(w) && !state.swap) {
        body += `<p class="wx-note">🌧️ Для моря погода так себе. По плану такой день переезжает на 27-е.</p>
          <button class="btn" data-act="swap" data-id="${c.id}">🔁 Перенести на 27-е</button>`;
      } else if (c.sea && w.sunset) {
        body += `<p class="wx-note">🌅 Будь у моря до ${w.sunset} — потом темно.</p>`;
      }
    } else if (wxState === 'load') {
      body = `<div class="wx-main"><div class="wx-icon">⏳</div><div><div class="wx-desc">Загружаю прогноз…</div></div></div>`;
    } else if (wxState === 'fail') {
      body = `<div class="wx-main"><div class="wx-icon">📡</div><div><div class="wx-desc">Прогноз не загрузился</div></div></div>
        <p class="wx-note">Нет сети или сервис недоступен. Обычно в конце ноября здесь +1…+5°, ветрено и сыро.</p>
        <button class="btn" data-act="wx-retry">Попробовать ещё раз</button>`;
    } else {
      body = `<div class="wx-main"><div class="wx-icon">🗓️</div><div><div class="wx-desc">Прогноз на этот день появится ближе к дате</div></div></div>
        <p class="wx-note">Прогноз доступен на 16 дней вперёд. Обычно в конце ноября здесь +1…+5°, ветрено и сыро, закат около 16:20.</p>`;
    }
    if (state.swap && (c.id === state.swap || c.id === 'd27')) {
      body += `<p class="wx-note">🔁 Дни поменяны местами.</p><button class="btn" data-act="unswap">Вернуть как было</button>`;
    } else if (c.sea && !state.swap && !(w && isBad(w))) {
      body += `<button class="btn" data-act="swap" data-id="${c.id}">🔁 Перенести на 27-е</button>`;
    }
    return `<section class="card wx-card">${body}</section>`;
  }

  // ---------- сборы ----------
  function packItems(i) {
    const c = content(i); const w = weatherFor(i);
    const list = [...(c.noBase ? [] : BASE_PACK), ...c.pack].map((text) => ({ text }));
    const auto = [];
    if (w) {
      if (w.pop >= 50 || w.rain >= 1) auto.push('Зонт или дождевик');
      if (w.wind >= 9) auto.push('Ветровка и капюшон — сильный ветер');
      if (w.tmin <= 0) auto.push('Термобельё и тёплые носки');
      if ([71, 73, 75, 77, 85, 86].includes(w.code)) auto.push('Нескользящая обувь — снег');
      if (w.code <= 1 && c.sea) auto.push('Солнечные очки — у моря слепит');
    }
    auto.forEach((text) => list.push({ text, auto: true }));
    (state.packAdd[c.id] || []).forEach((text) => list.push({ text, own: true }));
    return list;
  }

  function packCard(i) {
    const c = content(i); const items = packItems(i); const st = state.pack[c.id] || {};
    const n = items.filter((it) => st[it.text]).length;
    return `<section class="card"><h3>🎒 Взять с собой <small>${n} из ${items.length}</small></h3>
      <ul class="cl">${items.map((it) => `<li class="${st[it.text] ? 'done' : ''}" data-act="pack" data-id="${esc(it.text)}">
        <span class="box">✓</span><span class="txt">${esc(it.text)}${it.auto ? '<span class="tag">по прогнозу</span>' : ''}</span>
        ${it.own ? `<button class="x" data-act="pack-del" data-id="${esc(it.text)}" aria-label="Удалить">✕</button>` : ''}</li>`).join('')}</ul>
      <form class="add" data-form="pack"><input type="text" name="t" placeholder="Добавить своё…" maxlength="80" autocomplete="off"><button class="btn dark">+</button></form>
    </section>`;
  }

  // ---------- маршруты ----------
  const yaSearch = (q) => `https://yandex.ru/maps/?text=${encodeURIComponent(q)}`;
  const rtext = (pts) => pts.map((p) => p.ll.join(',')).join('~');
  const yaRoute = (pts, mode) => `https://yandex.ru/maps/?rtext=${rtext(pts)}&rtt=${mode}`;
  const yaWidget = (pts, mode) => `https://yandex.ru/map-widget/v1/?rtext=${rtext(pts)}&rtt=${mode}`;
  const yaFromHere = (p) => `https://yandex.ru/maps/?rtext=~${p.ll.join(',')}&rtt=mt`;
  const homeText = encodeURIComponent(HOME.address);
  const yaFromHome = (p) => `https://yandex.ru/maps/?rtext=${homeText}~${p.ll.join(',')}&rtt=mt`;
  const yaToHome = (p) => `https://yandex.ru/maps/?rtext=${p.ll.join(',')}~${homeText}&rtt=mt`;
  const segPoints = (c, seg) => seg.pts.map((id) => c.items.find((it) => it.id === id)).filter((p) => p && p.ll);

  function mapCard(i) {
    const c = content(i);
    if (!c.segments.length) return '';
    const seg = c.segments[Math.min(ui.seg, c.segments.length - 1)];
    const pts = segPoints(c, seg);
    const stops = c.items.filter((it) => it.ll && !it.opt);
    const first = stops[0], last = stops[stops.length - 1];
    return `<section class="card"><h3>🗺️ Маршрут дня <small>${MODES[seg.mode]}</small></h3>
      ${c.segments.length > 1 ? `<div class="seg">${c.segments.map((s, k) => `<button class="${k === ui.seg ? 'on' : ''}" data-act="seg" data-id="${k}">${esc(s.title)}</button>`).join('')}</div>` : ''}
      <div class="seg">
        <button class="${ui.mapMode === 'map' ? 'on' : ''}" data-act="mapmode" data-id="map">Карта</button>
        <button class="${ui.mapMode === 'ya' ? 'on' : ''}" data-act="mapmode" data-id="ya">Яндекс Карты</button>
      </div>
      <div class="map-wrap">${ui.mapMode === 'ya'
        ? `<iframe src="${yaWidget(pts, seg.mode)}" loading="lazy" allowfullscreen title="Маршрут в Яндекс Картах"></iframe>`
        : '<div id="map"></div>'}</div>
      <p class="route-info" id="route-info">${esc(seg.title)}</p>
      <div class="btns">
        <a class="btn ya" href="${yaRoute(pts, seg.mode)}" target="_blank" rel="noopener">Открыть маршрут в Яндекс Картах</a>
      </div>
      <div class="btns" style="margin-top:8px">
        <a class="btn" href="${yaFromHome(first)}" target="_blank" rel="noopener">🚋 От дома до старта</a>
        <a class="btn" href="${yaToHome(last)}" target="_blank" rel="noopener">🏠 Домой с финиша</a>
        <a class="btn" href="${yaFromHere(pts[0])}" target="_blank" rel="noopener">📍 Отсюда до старта</a>
      </div>
      <p class="muted" style="font-size:13px;margin:10px 0 0">Дом — ${esc(HOME.label)}. Старт дня: ${esc(first.name)}, финиш: ${esc(last.name)}. Яндекс сам подберёт трамвай или автобус.</p>
      ${c.approx ? '<p class="muted" style="font-size:13px;margin:10px 0 0">Точки за городом расставлены примерно — точный адрес открывается по кнопке «Яндекс» у каждого места.</p>' : ''}
    </section>`;
  }

  const haversine = (a, b) => {
    const R = 6371, r = Math.PI / 180;
    const x = Math.sin((b[0] - a[0]) * r / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin((b[1] - a[1]) * r / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };

  async function fetchRoute(pts, mode) {
    const profile = mode === 'pd' ? 'foot' : 'car';
    const key = profile + ':' + rtext(pts);
    if (routeCache[key]) return routeCache[key];
    const coords = pts.map((p) => `${p.ll[1]},${p.ll[0]}`).join(';');
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(`https://routing.openstreetmap.de/routed-${profile}/route/v1/driving/${coords}?overview=full&geometries=geojson`, { signal: ctl.signal });
      const data = await res.json();
      if (data.code !== 'Ok') throw new Error(data.code);
      const r = data.routes[0];
      return (routeCache[key] = { line: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]), km: r.distance / 1000, min: r.duration / 60 });
    } finally { clearTimeout(timer); }
  }

  function fmtDur(min) { const h = Math.floor(min / 60), m = Math.round(min % 60); return h ? `${h} ч ${m} мин` : `${m} мин`; }

  function drawMap(i) {
    if (map) { map.remove(); map = null; }
    const el = $('#map');
    if (!el || !window.L) return;
    const c = content(i);
    const segIdx = Math.min(ui.seg, c.segments.length - 1);
    const seg = c.segments[segIdx];
    const pts = segPoints(c, seg);
    map = L.map(el, { scrollWheelZoom: false, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);

    const numbered = c.items.filter((it) => it.ll);
    numbered.forEach((it) => {
      const inSeg = seg.pts.includes(it.id);
      const n = c.items.filter((x) => x.ll && !x.opt).indexOf(it) + 1;
      const icon = L.divIcon({ className: '', iconSize: [28, 28], iconAnchor: [14, 28], popupAnchor: [0, -26],
        html: `<div class="mk ${it.opt ? 'opt' : inSeg ? '' : 's1'}"><b>${it.opt ? '+' : n}</b></div>` });
      L.marker(it.ll, { icon, opacity: inSeg || it.opt ? 1 : 0.7 }).addTo(map)
        .bindPopup(`<b>${esc(it.name)}</b>${it.opt ? '<br>если останется время' : ''}<br><a href="${yaSearch(it.q || it.name)}" target="_blank" rel="noopener">Открыть в Яндекс Картах</a>`);
    });

    if (c.place === 'kgd') {
      L.marker(HOME.ll, { icon: L.divIcon({ className: '', iconSize: [28, 28], iconAnchor: [14, 14], html: '<div class="home-mk">🏠</div>' }) }).addTo(map)
        .bindPopup(`<b>Дом</b><br>${esc(HOME.label)}<br><span style="opacity:.7">значок стоит примерно</span>`);
    }

    const straight = pts.map((p) => p.ll);
    const bounds = L.latLngBounds(straight);
    map.fitBounds(bounds.pad(0.25), { maxZoom: 16 });
    const fallback = L.polyline(straight, { color: '#e8674a', weight: 4, dashArray: '6 8', opacity: 0.8 }).addTo(map);
    const info = $('#route-info');
    const approxKm = straight.slice(1).reduce((s, p, k) => s + haversine(straight[k], p), 0) * 1.3;
    if (info) info.textContent = `${seg.title} · примерно ${approxKm.toFixed(1)} км`;

    if (pts.length > 1) {
      const token = (drawMap.token = Math.random());
      fetchRoute(pts, seg.mode).then((r) => {
        if (drawMap.token !== token || !map) return;
        fallback.remove();
        L.polyline(r.line, { color: '#12344a', weight: 7, opacity: 0.25 }).addTo(map);
        L.polyline(r.line, { color: '#e8674a', weight: 4 }).addTo(map);
        if (info) info.textContent = `${seg.title} · ${r.km.toFixed(1)} км${seg.mode === 'pd' ? ` · около ${fmtDur(r.min)} пешком без остановок` : seg.mode === 'auto' ? ` · около ${fmtDur(r.min)} в пути` : ''}`;
      }).catch(() => { /* остаётся прямая пунктирная линия */ });
    }
    setTimeout(() => map && map.invalidateSize(), 60);
  }

  // ---------- день ----------
  function strip() {
    return `<div class="strip" id="strip">${DAYS.map((slot, i) => {
      const d = parse(slot.date); const c = content(i); const w = weatherFor(i);
      const complete = mainItems(c).length && doneCount(c) === mainItems(c).length;
      return `<button class="chip ${i === ui.day ? 'on' : ''} ${slot.date === todayIso ? 'today' : ''} ${complete ? 'complete' : ''}" data-act="day" data-id="${i}">
        <span class="wd">${WD[d.getDay()]}</span><span class="num">${d.getDate()}</span>
        <span class="wx">${w ? `${wmo(w.code).icon} ${sign(w.tmax)}` : c.emoji}</span></button>`;
    }).join('')}</div>`;
  }

  function itemRow(c, it, n) {
    const id = `${c.id}.${it.id}`; const done = state.done[id];
    const links = [];
    if (it.q) links.push(`<a class="pill" href="${yaSearch(it.q)}" target="_blank" rel="noopener">📍 Яндекс</a>`);
    if (it.food) links.push(`<button class="pill" data-act="food" data-id="${esc(it.food)}">🍽️ Где поесть</button>`);
    return `<li class="${done ? 'done' : ''}">
      <button class="check ${it.ll && !it.opt ? 'pin' : ''}" data-act="done" data-id="${id}" aria-label="Отметить">${done ? '✓' : it.opt ? '+' : it.ll ? n : '·'}</button>
      <div>${it.t ? `<div class="tl-time">${esc(it.t)}</div>` : ''}
        <div class="tl-name">${esc(it.name)}</div>
        ${it.desc ? `<div class="tl-desc">${esc(it.desc)}</div>` : ''}
        ${links.length ? `<div class="tl-links">${links.join('')}</div>` : ''}</div></li>`;
  }

  function viewDays() {
    const i = ui.day; const slot = DAYS[i]; const c = content(i); const d = parse(slot.date);
    const main = mainItems(c); const opt = c.items.filter((it) => it.opt);
    const pinned = c.items.filter((x) => x.ll && !x.opt);
    const pct = main.length ? Math.round(doneCount(c) / main.length * 100) : 0;
    return `${strip()}
      <section class="card">
        <div class="day-head"><div class="day-emoji">${c.emoji}</div><div>
          <div class="date">${d.getDate()} ноября · ${WD_FULL[d.getDay()]}${slot.date === todayIso ? ' · сегодня' : ''}</div>
          <h2>${esc(c.title)}</h2><p>${esc(c.intro)}</p></div></div>
        <div class="progress"><i style="width:${pct}%"></i></div>
        ${(c.alerts || []).map((a) => `<div class="alert"><span>💡</span><span>${esc(a)}</span></div>`).join('')}
      </section>
      <div class="grid"><div>
        <section class="card"><h3>📌 План <small>${doneCount(c)} из ${main.length}</small></h3>
          <ul class="tl">${main.map((it) => itemRow(c, it, pinned.indexOf(it) + 1)).join('')}</ul>
          ${opt.length ? `<div class="opt-title">если останется время</div><ul class="tl">${opt.map((it) => itemRow(c, it)).join('')}</ul>` : ''}
        </section>
        ${mapCard(i)}
      </div><div>
        ${weatherCard(i)}
        ${packCard(i)}
        <section class="card"><h3>📝 Заметки</h3>
          <textarea data-note="${c.id}" placeholder="Что понравилось, что запомнить…">${esc(state.notes[c.id] || '')}</textarea></section>
      </div></div>`;
  }

  // ---------- рестораны ----------
  const allRest = () => [...RESTAURANTS, ...state.restAdd.map((r) => ({ ...r, own: true }))];

  function viewFood() {
    const list = allRest();
    const visited = list.filter((r) => state.rest[r.id]?.visited);
    const rated = visited.filter((r) => state.rest[r.id].rating);
    const avg = rated.length ? (rated.reduce((s, r) => s + state.rest[r.id].rating, 0) / rated.length).toFixed(1) : '—';
    const shown = list.filter((r) => (ui.area === 'Все' || r.area === ui.area)
      && (ui.only === 'all' || (ui.only === 'yes') === !!state.rest[r.id]?.visited));
    return `<h2 class="section-title">Где поесть</h2>
      <p class="section-sub">Подборка-ориентир: адреса и часы перед визитом проверь. Свои находки добавляй внизу.</p>
      <div class="stat-row">
        <div class="stat"><b>${visited.length}</b> из ${list.length} ${plural(list.length, 'места', 'мест', 'мест')}</div>
        <div class="stat">средняя оценка <b>${avg}</b> ★</div>
      </div>
      <div class="filters" style="margin-top:12px">${['Все', ...REST_AREAS].map((a) => `<button class="${ui.area === a ? 'on' : ''}" data-act="area" data-id="${esc(a)}">${esc(a)}</button>`).join('')}</div>
      <div class="filters">${[['all', 'Все'], ['no', 'Ещё не был'], ['yes', 'Посещённые']].map(([k, t]) => `<button class="${ui.only === k ? 'on' : ''}" data-act="only" data-id="${k}">${t}</button>`).join('')}</div>
      <div class="rest-grid">${shown.map(restCard).join('') || '<p class="muted">Здесь пока пусто — добавь своё место ниже.</p>'}</div>
      <section class="card"><h3>➕ Добавить своё место</h3>
        <form data-form="rest" style="display:grid;gap:8px">
          <input type="text" name="name" placeholder="Название" maxlength="60" required autocomplete="off">
          <select name="area">${REST_AREAS.map((a) => `<option>${esc(a)}</option>`).join('')}</select>
          <input type="text" name="note" placeholder="Что там взять, адрес, чей совет" maxlength="160" autocomplete="off">
          <button class="btn dark" style="justify-content:center">Добавить</button>
        </form></section>`;
  }

  function restCard(r) {
    const s = state.rest[r.id] || {};
    const city = REST_CITY[r.area] ?? '';
    return `<article class="card rest ${s.visited ? 'visited' : ''}">
      <div class="rest-top"><div><h4>${esc(r.name)}</h4><div class="kind">${esc(r.kind || 'Своя находка')} · ${esc(r.area)}</div></div>
        <button class="visit" data-act="visit" data-id="${esc(r.id)}">${s.visited ? '✓ Был' : 'Отметить'}</button></div>
      ${r.note ? `<p>${esc(r.note)}</p>` : ''}
      <div class="stars" role="group" aria-label="Оценка">${[1, 2, 3, 4, 5].map((n) => `<button class="${s.rating >= n ? 'on' : ''}" data-act="rate" data-id="${esc(r.id)}" data-n="${n}" aria-label="${n}">★</button>`).join('')}</div>
      <input type="text" data-rnote="${esc(r.id)}" value="${esc(s.note || '')}" placeholder="Моя заметка: что брал, как было" maxlength="200">
      <div class="rest-foot"><a class="pill" href="${yaSearch(`${r.name} ${city}`.trim())}" target="_blank" rel="noopener">📍 На Яндекс Картах</a>
        ${r.own ? `<button class="x" data-act="rest-del" data-id="${esc(r.id)}">Удалить</button>` : ''}</div>
    </article>`;
  }

  // ---------- подготовка ----------
  function viewPrep() {
    const spent = BUDGET.rows.reduce((s, _, k) => s + (Number(state.spent[k]) || 0), 0);
    const min = BUDGET.rows.reduce((s, r) => s + r.min, 0), max = BUDGET.rows.reduce((s, r) => s + r.max, 0);
    const nTodo = TODO.filter((_, k) => state.todo[k]).length;
    const fmt = (n) => n.toLocaleString('ru-RU');
    return `<h2 class="section-title">Подготовка</h2>
      <p class="section-sub">Что забронировать, сколько потратить и что держать в голове.</p>
      <div class="grid"><div>
        <section class="card"><h3>✅ Проверить и забронировать <small>${nTodo} из ${TODO.length}</small></h3>
          <ul class="cl">${TODO.map((t, k) => `<li class="${state.todo[k] ? 'done' : ''}" data-act="todo" data-id="${k}"><span class="box">✓</span><span class="txt">${esc(t)}</span></li>`).join('')}</ul></section>
        <section class="card"><h3>💡 Полезно помнить</h3>
          <ul class="know">${GOOD_TO_KNOW.map((g) => `<li><span>${g.icon}</span><span>${esc(g.text)}</span></li>`).join('')}</ul></section>
      </div><div>
        <section class="card"><h3>💰 Бюджет <small>без еды и жилья</small></h3>
          <div class="stat-row" style="margin-bottom:10px">
            <div class="stat">план <b>${fmt(min)}–${fmt(max)} ₽</b></div>
            <div class="stat">потрачено <b id="spent-sum">${fmt(spent)} ₽</b></div>
          </div>
          <div class="progress" style="margin:0 0 12px"><i id="spent-bar" style="width:${Math.min(100, spent / BUDGET.limit[1] * 100)}%"></i></div>
          <table class="bud">${BUDGET.rows.map((r, k) => `<tr><td>${esc(r.name)}<div class="plan">план ${fmt(r.min)}–${fmt(r.max)} ₽</div></td>
            <td><input type="number" inputmode="numeric" min="0" step="50" data-spent="${k}" value="${state.spent[k] ?? ''}" placeholder="факт, ₽"></td></tr>`).join('')}</table>
          <p class="muted" style="font-size:13px;margin:10px 0 0">Потолок — ${fmt(BUDGET.limit[1])} ₽. Цены, кроме косы, — оценки.</p>
        </section>
      </div></div>`;
  }

  // ---------- рендер ----------
  function render() {
    if (map) { map.remove(); map = null; }
    app.innerHTML = ui.view === 'days' ? viewDays() : ui.view === 'food' ? viewFood() : viewPrep();
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === ui.view));
    if (ui.view === 'days') {
      if (ui.mapMode === 'map') drawMap(ui.day);
      const on = $('.chip.on');
      if (on) $('#strip').scrollLeft = on.offsetLeft - ($('#strip').clientWidth - on.clientWidth) / 2;
    }
  }

  function countdown() {
    const now = parse(todayIso), start = parse(TRIP.start), end = parse(TRIP.end);
    const days = Math.round((start - now) / 864e5);
    const el = $('#countdown');
    if (days > 0) el.textContent = `🌊 до отпуска ${days} ${plural(days, 'день', 'дня', 'дней')}`;
    else if (now <= end) el.textContent = `☀️ день ${1 - days} из ${DAYS.length} — кайфуем`;
    else el.textContent = '🧡 отпуск удался';
  }

  // ---------- события ----------
  const actions = {
    day: (id) => { ui.day = +id; ui.seg = 0; },
    seg: (id) => { ui.seg = +id; },
    mapmode: (id) => { ui.mapMode = id; },
    done: (id) => { state.done[id] = !state.done[id]; },
    pack: (id) => { const c = content(ui.day); (state.pack[c.id] ||= {})[id] = !state.pack[c.id][id]; },
    'pack-del': (id) => { const c = content(ui.day); state.packAdd[c.id] = (state.packAdd[c.id] || []).filter((t) => t !== id); },
    swap: (id) => { state.swap = id; toast('Перенёс на 27-е, а запасной день встал сюда'); },
    unswap: () => { state.swap = null; toast('Вернул дни на место'); },
    'wx-retry': () => { wxState = 'load'; loadWeather().then(render); },
    food: (id) => { ui.view = 'food'; ui.area = id; ui.only = 'all'; window.scrollTo({ top: $('#tabs').offsetTop }); },
    area: (id) => { ui.area = id; },
    only: (id) => { ui.only = id; },
    visit: (id) => { const s = (state.rest[id] ||= {}); s.visited = !s.visited; },
    rate: (id, el) => { const s = (state.rest[id] ||= {}); const n = +el.dataset.n; s.rating = s.rating === n ? 0 : n; if (s.rating) s.visited = true; },
    'rest-del': (id) => { state.restAdd = state.restAdd.filter((r) => r.id !== id); delete state.rest[id]; },
    todo: (id) => { state.todo[id] = !state.todo[id]; },
    export: async () => {
      const text = JSON.stringify(state);
      try { await navigator.clipboard.writeText(text); toast('Данные скопированы — вставь их на другом устройстве'); }
      catch (e) { prompt('Скопируй эту строку:', text); }
      return false;
    },
    import: () => {
      const text = prompt('Вставь строку с данными, скопированную на другом устройстве:');
      if (!text) return false;
      try { state = Object.assign(blank(), JSON.parse(text)); toast('Данные загружены'); }
      catch (e) { toast('Не получилось прочитать данные'); return false; }
    },
  };

  document.addEventListener('click', async (e) => {
    const tab = e.target.closest('#tabs button');
    if (tab) { ui.view = tab.dataset.view; render(); window.scrollTo({ top: 0 }); return; }
    const el = e.target.closest('[data-act]');
    if (!el || !actions[el.dataset.act]) return;
    e.stopPropagation();
    const keep = await actions[el.dataset.act](el.dataset.id, el);
    if (keep === false) return;
    save(); render();
  });

  document.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    const data = new FormData(form);
    if (form.dataset.form === 'pack') {
      const t = String(data.get('t')).trim(); if (!t) return;
      const c = content(ui.day);
      if (!packItems(ui.day).some((it) => it.text === t)) (state.packAdd[c.id] ||= []).push(t);
    } else {
      const name = String(data.get('name')).trim(); if (!name) return;
      state.restAdd.push({ id: 'own' + Date.now(), name, area: data.get('area'), note: String(data.get('note')).trim() });
      ui.area = data.get('area'); ui.only = 'all';
      toast('Добавил в список');
    }
    save(); render();
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.note) state.notes[t.dataset.note] = t.value;
    else if (t.dataset.rnote) (state.rest[t.dataset.rnote] ||= {}).note = t.value;
    else if (t.dataset.spent) {
      state.spent[t.dataset.spent] = t.value === '' ? undefined : Math.max(0, Number(t.value));
      const sum = BUDGET.rows.reduce((s, _, k) => s + (Number(state.spent[k]) || 0), 0);
      $('#spent-sum').textContent = sum.toLocaleString('ru-RU') + ' ₽';
      $('#spent-bar').style.width = Math.min(100, sum / BUDGET.limit[1] * 100) + '%';
    } else return;
    save();
  });

  // ---------- старт ----------
  const idx = DAYS.findIndex((d) => d.date === todayIso);
  ui.day = idx >= 0 ? idx : 0;
  countdown();
  render();
  loadWeather().then(() => { if (ui.view === 'days') render(); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
