'use strict';
/* ====== storage helpers ====== */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = s => esc(s).replace(/https?:\/\/[^\s<]+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u.length > 60 ? u.slice(0, 57) + '…' : u}</a>`);

/* ====== theme ====== */
const applyTheme = () => { const t = LS.get('theme', null); if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
applyTheme();

/* ====== decrypt ====== */
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function decrypt(pw) {
  const enc = await (await fetch('data.enc.json?t=' + Date.now(), { cache: 'no-store' })).json();
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(enc.salt), iterations: enc.iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const gz = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(enc.iv) }, key, b64(enc.ct));
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

/* ====== dates ====== */
const D = s => new Date(s);
const MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONN = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const DOW = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const DOWS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtDay = d => `${d.getDate()} ${MON[d.getMonth()]}`;
const fmtDayW = d => `${DOW[d.getDay()]}, ${fmtDay(d)}`;
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 864e5);
function rel(d) {
  const now = new Date(), ms = d - now, abs = Math.abs(ms), dd = daysBetween(now, d);
  if (abs < 3600e3) return ms > 0 ? `через ${Math.max(1, Math.round(abs / 6e4))} мин` : `${Math.round(abs / 6e4)} мин назад`;
  if (dd === 0) return ms > 0 ? `сегодня в ${hm(d)}` : `сегодня, ${hm(d)}`;
  if (dd === 1) return `завтра в ${hm(d)}`;
  if (dd === -1) return `вчера`;
  if (dd > 0) return `через ${dd} ${plural(dd, 'день', 'дня', 'дней')}`;
  return `${-dd} ${plural(-dd, 'день', 'дня', 'дней')} назад`;
}
const plural = (n, a, b, c) => { n = Math.abs(n) % 100; const k = n % 10; return n > 10 && n < 20 ? c : k > 1 && k < 5 ? b : k === 1 ? a : c; };

/* ====== state ====== */
let DATA = null, S = null;
const st = {
  done: new Set(LS.get('done', [])),
  undone: new Set(LS.get('undone', [])),   // снято вручную, хотя LMS считает сданным
  showOther: LS.get('showOther', false),
  showDone: LS.get('showDone', false),
  dlSubj: null, dlSrc: 'all', calMonth: null, chatTopic: 'imp', chatQ: '',
};
const saveDone = () => { LS.set('done', [...st.done]); LS.set('undone', [...st.undone]); };
const subj = k => S.get(k) || { key: null, short: '—', name: 'Другое', color: '#8f8aa8' };
const isDone = d => st.undone.has(d.id) ? false : (st.done.has(d.id) || d.status === 'done' || d.done === true);
const visibleDl = () => DATA.deadlines.filter(d => (st.showOther || !d.other));

/* ====== boot ====== */
async function unlock(pw, remember) {
  DATA = await decrypt(pw);
  if (remember) LS.set('pw', pw);
  S = new Map(DATA.subjects.map(s => [s.key, s]));
  $('#lock').hidden = true; $('#app').hidden = false;
  $('#grp').textContent = DATA.group;
  const gen = D(DATA.generated);
  $('#fresh').textContent = `обновлено ${rel(gen).replace('сегодня, ', 'сегодня в ')}`;
  $('#fresh').title = `ЛК: ${DATA.sources.lk || '—'}\nLMS: ${DATA.sources.lms || '—'}\nTelegram: ${DATA.sources.tg || '—'}`;
  buildBottomTabs(); renderAll();
  const h = location.hash.slice(1); if (h) switchTab(h);
  setInterval(() => { renderHome(); }, 30000);
}
$('#lockForm').addEventListener('submit', async e => {
  e.preventDefault(); $('#lockErr').hidden = true;
  const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Расшифровываю…';
  try { await unlock($('#pw').value, $('#remember').checked); }
  catch (err) { $('#lockErr').textContent = 'Неверный пароль или данные ещё не загружены'; $('#lockErr').hidden = false; console.error(err); }
  btn.disabled = false; btn.textContent = 'Открыть';
});
(async () => { const pw = LS.get('pw', null); if (pw) try { await unlock(pw, true); } catch { LS.del('pw'); } })();
$('#logoutBtn').onclick = () => { LS.del('pw'); location.reload(); };
$('#themeBtn').onclick = () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  LS.set('theme', cur === 'light' ? 'dark' : 'light'); applyTheme();
};

/* ====== tabs ====== */
const TABS = [['home', '🏠', 'Главная'], ['cal', '🗓', 'Календарь'], ['dl', '⚑', 'Дедлайны'], ['subj', '📚', 'Предметы'], ['chat', '💬', 'Чат']];
function buildBottomTabs() {
  $('#bottomTabs').innerHTML = TABS.map(([k, i, t]) => `<button data-tab="${k}"><i>${i}</i>${t}${k === 'dl' ? '<span class="badge" id="dlCount2"></span>' : ''}</button>`).join('');
}
function switchTab(k) {
  if (!TABS.some(t => t[0] === k)) return;
  $$('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === k));
  $$('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + k));
  history.replaceState(null, '', '#' + k); window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-tab]'); if (b) { switchTab(b.dataset.tab); return; }
  const go = e.target.closest('[data-go]'); if (go) { switchTab(go.dataset.go); if (go.dataset.subj) { st.dlSubj = go.dataset.subj; renderDeadlines(); } return; }
  if (e.target.closest('[data-close]')) closeDrawer();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeDrawer();
  if (e.target.matches('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  const i = +e.key; if (i >= 1 && i <= 5 && DATA) switchTab(TABS[i - 1][0]);
});
document.addEventListener('change', e => {
  const cb = e.target.closest('.cb[data-id]'); if (!cb) return;
  const id = cb.dataset.id, d = [...DATA.deadlines, ...DATA.tasks].find(x => x.id === id);
  const lmsDone = d && (d.status === 'done' || d.done === true);
  if (cb.checked) { st.done.add(id); st.undone.delete(id); } else { st.done.delete(id); if (lmsDone) st.undone.add(id); }
  saveDone(); renderAll();
});

function renderAll() { renderHome(); renderCalendar(); renderDeadlines(); renderSubjects(); renderChat(); updateBadges(); }
function updateBadges() {
  const now = new Date(), wk = new Date(now.getTime() + 7 * 864e5);
  const n = visibleDl().filter(d => !isDone(d) && D(d.due) < wk && d.kind !== 'exam').length || '';
  $('#dlCount').textContent = n; const b2 = $('#dlCount2'); if (b2) b2.textContent = n;
}

/* ====== components ====== */
function lessonHTML(l) {
  const s = subj(l.subject), now = new Date(), a = D(l.start), b = D(l.end);
  const cls = ['lesson', now >= a && now <= b ? 'now' : '', now > b ? 'past' : '', l.control ? 'control' : ''].join(' ');
  const link = l.links[0];
  const where = l.rooms.length ? l.rooms.join(', ') : (l.online ? 'онлайн' : '');
  return `<div class="${cls}" style="--c:${s.color}">
    <div class="time">${hm(a)}<br><small>${hm(b)}</small></div><div class="bar"></div>
    <div><div class="t">${esc(l.subjectName)}</div><div class="meta">${esc(l.type)}${where ? ' · ' + esc(where) : ''}${l.teachers.length ? ' · ' + esc(l.teachers.map(shortName).join(', ')) : ''}</div></div>
    ${link ? `<a class="join" href="${esc(link.url)}" target="_blank" rel="noopener">▶ Подключиться</a>` : '<span></span>'}
  </div>`;
}
const shortName = n => { const p = n.split(' '); return p.length >= 3 ? `${p[0]} ${p[1][0]}.${p[2][0]}.` : n; };
const SRC = { lms: 'LMS', tg: 'чат', lk: 'ЛК', manual: 'вручную' };
function urgency(d) {
  if (isDone(d)) return 'done';
  const days = (D(d.due) - new Date()) / 864e5;
  return days < 0 ? 'over' : days < 3 ? 'hot' : days < 8 ? 'warn' : 'calm';
}
function dlHTML(d, opts = {}) {
  const s = subj(d.subject), done = isDone(d), dd = D(d.due), u = urgency(d);
  const sub = d.submission ? `<span class="src">${esc(d.submission)}</span>` : '';
  const kindIcon = d.kind === 'exam' ? '🎯 ' : d.kind === 'quiz' ? '📝 ' : d.kind === 'chat' ? '💬 ' : '';
  const details = d.text || d.desc ? `<details><summary>${d.source === 'tg' ? `из чата · ${esc(d.from)} · ${fmtDay(D(d.at))}${d.mentions > 1 ? ` · упоминаний: ${d.mentions}` : ''}` : 'описание'}</summary><p>${linkify(d.text || d.desc)}</p></details>` : '';
  return `<div class="dl u-${u} ${done ? 'done' : ''}" style="--c:${s.color}">
    ${d.kind === 'exam' ? '<span style="font-size:18px">🎯</span>' : `<input type="checkbox" class="cb" data-id="${esc(d.id)}" ${done ? 'checked' : ''} title="Отметить сделанным">`}
    <div><div class="ttl">${kindIcon}${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener" style="color:inherit">${esc(d.title)}</a>` : esc(d.title)}</div>
      <div class="row"><span class="pill" style="--c:${s.color}">${esc(s.short)}</span><span class="src">${SRC[d.source] || d.source}</span>${d.retake ? '<span class="src">пересдача</span>' : ''}${d.other ? '<span class="src">другой поток</span>' : ''}${sub}${d.rooms?.length ? `<span class="src">${esc(d.rooms.join(', '))}</span>` : ''}</div>
      ${opts.noDetails ? '' : details}</div>
    <div class="due"><b>${done ? '✓' : rel(dd)}</b><span class="muted">${fmtDay(dd)}, ${hm(dd)}</span></div>
  </div>`;
}
function taskHTML(t) {
  const s = subj(t.subject), done = isDone(t);
  return `<div class="dl ${done ? 'done' : ''}" style="--c:${s.color}">
    <input type="checkbox" class="cb" data-id="${esc(t.id)}" ${done ? 'checked' : ''}>
    <div><div class="ttl"><a href="${esc(t.url)}" target="_blank" rel="noopener" style="color:inherit">${esc(t.title)}</a></div>
    <div class="row"><span class="pill" style="--c:${s.color}">${esc(s.short)}</span><span class="src">LMS</span>${t.submission ? `<span class="src">${esc(t.submission)}</span>` : ''}${t.grade ? `<span class="src">${esc(t.grade)}</span>` : ''}</div>
    ${t.intro ? `<details><summary>задание</summary><p>${linkify(t.intro)}</p></details>` : ''}</div>
    <div class="due"><b>без срока</b></div></div>`;
}
function msgHTML(m, q) {
  const s = m.subject ? subj(m.subject) : null;
  let body = linkify(m.t);
  if (q) { const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'); body = body.replace(/(^|>)([^<]+)/g, (_, a, b) => a + b.replace(re, '<mark>$1</mark>')); }
  return `<div class="msg ${m.important ? 'imp' : ''}">
    <div class="h"><b>${esc(m.from)}</b>${s ? `<span class="pill" style="--c:${s.color}">${esc(s.short)}</span>` : `<span class="src">${esc(m.topicTitle)}</span>`}${m.pin ? '📌' : ''}<span>${fmtDay(D(m.at))}, ${hm(D(m.at))}</span><a href="${esc(m.link)}" target="_blank" rel="noopener" style="margin-left:auto">открыть ↗</a></div>
    ${m.t ? `<div class="b">${body}</div>` : ''}${m.doc ? `<a class="file" href="${esc(m.link)}" target="_blank" rel="noopener">📎 ${esc(m.doc)}</a>` : ''}
  </div>`;
}

/* ====== HOME ====== */
function nextLessons() {
  const now = new Date();
  const upcoming = DATA.lessons.filter(l => D(l.end) > now);
  if (!upcoming.length) return { day: null, list: [] };
  const day = upcoming[0].date;
  return { day, list: DATA.lessons.filter(l => l.date === day) };
}
function renderHome() {
  if (!DATA) return;
  const now = new Date(), { day, list } = nextLessons();
  const cur = list.find(l => now >= D(l.start) && now <= D(l.end));
  const nxt = list.find(l => D(l.start) > now);
  const target = cur ? D(cur.end) : nxt ? D(nxt.start) : null;
  const diff = target ? Math.max(0, target - now) : 0;
  const cd = target ? [[Math.floor(diff / 864e5), 'дн'], [Math.floor(diff / 36e5) % 24, 'ч'], [Math.floor(diff / 6e4) % 60, 'мин']] : [];
  const focus = cur || nxt;
  const s = focus ? subj(focus.subject) : null;
  const open = visibleDl().filter(d => !isDone(d) && d.kind !== 'exam');
  const over = open.filter(d => D(d.due) < now), week = open.filter(d => D(d.due) >= now && D(d.due) < new Date(now.getTime() + 7 * 864e5));
  const exams = visibleDl().filter(d => d.kind === 'exam' && D(d.due) > now);
  const noDue = DATA.tasks.filter(t => !t.due && !isDone(t));
  const upcomingDl = open.filter(d => D(d.due) >= now).slice(0, 6);
  const imp = DATA.chat.filter(m => m.important || m.subject).slice(0, 6);
  const errs = DATA.sources.errors?.length ? `<div class="warnbar">⚠️ При последнем обновлении не удалось собрать: ${esc(DATA.sources.errors.join('; '))}. Показаны предыдущие данные.</div>` : '';

  $('#tab-home').innerHTML = `${errs}
  <div class="hero">
    <div class="hero-main glass" ${s ? `style="background:linear-gradient(135deg, color-mix(in srgb, ${s.color} 22%, var(--card)), var(--card))"` : ''}>
      <div class="kicker">${cur ? '🔴 Идёт сейчас' : focus ? 'Следующая пара' : 'Пар больше нет'}</div>
      <h1>${focus ? esc(focus.subjectName) : 'Отдыхаем 😎'}</h1>
      ${focus ? `<div class="muted">${esc(focus.type)} · ${fmtDayW(D(focus.start))}, ${hm(D(focus.start))}–${hm(D(focus.end))}${focus.teachers.length ? ' · ' + esc(focus.teachers.map(shortName).join(', ')) : ''}</div>` : ''}
      ${target ? `<div class="countdown">${cd.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join('')}<div style="background:none;border:0;display:flex;align-items:center;color:var(--muted);font-size:13px">${cur ? 'до конца пары' : 'до начала'}</div></div>` : ''}
      ${focus?.links?.[0] ? `<a class="btn primary" style="display:inline-block;margin-top:10px" href="${esc(focus.links[0].url)}" target="_blank" rel="noopener">▶ Подключиться к паре</a>` : ''}
    </div>
    <div class="stats">
      <div class="stat glass ${over.length ? 'hot' : 'ok'}" data-go="dl"><span class="muted">Просрочено</span><b>${over.length}</b></div>
      <div class="stat glass ${week.length ? 'warn' : 'ok'}" data-go="dl"><span class="muted">Сдать за 7 дней</span><b>${week.length}</b></div>
      <div class="stat glass" data-go="dl"><span class="muted">Зачёты и экзамены</span><b>${exams.length}</b><small class="muted">${exams[0] ? 'ближайший ' + fmtDay(D(exams[0].due)) : ''}</small></div>
      <div class="stat glass" data-go="dl"><span class="muted">Задания без срока</span><b>${noDue.length}</b></div>
    </div>
  </div>
  <div class="grid2">
    <div class="panel glass"><div class="panel-h"><h2>${day ? (ymd(now) === day ? 'Сегодня' : cap(fmtDayW(D(day + 'T12:00')))) : 'Расписание'}</h2><a href="#cal" data-tab="cal">календарь →</a></div>
      ${list.length ? list.map(lessonHTML).join('') : '<div class="empty">В расписании пока ничего нет</div>'}
      ${exams.length ? `<div class="sect"><h3>Зачёты и экзамены</h3>${exams.slice(0, 4).map(d => dlHTML(d)).join('')}</div>` : ''}
    </div>
    <div class="panel glass"><div class="panel-h"><h2>Ближайшие дедлайны</h2><a href="#dl" data-tab="dl">все →</a></div>
      ${over.length ? `<div class="sect" style="margin-top:0"><h3 style="color:var(--hot)">Просрочено</h3>${over.slice(-4).map(d => dlHTML(d, { noDetails: true })).join('')}</div><div class="sect"><h3>Впереди</h3>` : '<div>'}
      ${upcomingDl.length ? upcomingDl.map(d => dlHTML(d)).join('') : '<div class="empty">Ничего срочного 🎉</div>'}</div>
    </div>
  </div>
  <div class="panel glass" style="margin-top:16px"><div class="panel-h"><h2>Свежее из чата</h2><a href="#chat" data-tab="chat">весь чат →</a></div>
    ${imp.map(m => msgHTML(m)).join('') || '<div class="empty">Тишина</div>'}</div>`;
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/* ====== CALENDAR ====== */
function itemsByDay() {
  const map = new Map(); const add = (k, x) => { if (!map.has(k)) map.set(k, []); map.get(k).push(x); };
  for (const l of DATA.lessons) add(l.date, { type: l.control ? 'exam' : 'lesson', at: l.start, l });
  for (const d of visibleDl()) if (d.kind !== 'exam') add(ymd(D(d.due)), { type: 'dl', at: d.due, d });
  for (const m of DATA.meetings) if (st.showOther || !m.other) add(ymd(D(m.start)), { type: 'meet', at: m.start, m });
  for (const v of map.values()) v.sort((a, b) => a.at.localeCompare(b.at));
  return map;
}
function renderCalendar() {
  const now = new Date();
  if (!st.calMonth) { const nl = DATA.lessons.find(l => D(l.end) > now); st.calMonth = new Date(now.getFullYear(), now.getMonth(), 1); }
  const m0 = st.calMonth, first = new Date(m0), offset = (first.getDay() + 6) % 7;
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
  const map = itemsByDay(), todayKey = ymd(now);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i); const k = ymd(d); const items = map.get(k) || [];
    if (i >= 35 && d.getMonth() !== m0.getMonth()) break;
    const lessonsBySubj = new Map(); for (const it of items) if (it.type === 'lesson') { const key = it.l.subject + it.l.type; if (!lessonsBySubj.has(key)) lessonsBySubj.set(key, { it, n: 0 }); lessonsBySubj.get(key).n++; }
    const chips = [
      ...items.filter(x => x.type === 'exam').map(x => `<div class="ev exam" style="--c:${subj(x.l.subject).color}">🎯 ${esc(subj(x.l.subject).short)}</div>`),
      ...[...lessonsBySubj.values()].map(({ it, n }) => `<div class="ev" style="--c:${subj(it.l.subject).color}">${esc(subj(it.l.subject).short)}${n > 1 ? ' ×' + n : ''}</div>`),
      ...items.filter(x => x.type === 'dl').map(x => `<div class="ev dl-ev" style="--c:${subj(x.d.subject).color}">⚑ ${esc(x.d.title)}</div>`),
    ];
    cells.push(`<div class="cell ${d.getMonth() !== m0.getMonth() ? 'out' : ''} ${k === todayKey ? 'today' : ''}" data-day="${k}"><div class="n"><span>${d.getDate()}</span>${items.length ? `<span class="muted" style="font-weight:500">${items.length}</span>` : ''}</div>${chips.slice(0, 4).join('')}${chips.length > 4 ? `<div class="more">+${chips.length - 4}</div>` : ''}</div>`);
  }
  // список ближайших учебных дней
  const futureDays = [...new Set(DATA.lessons.filter(l => D(l.end) > now).map(l => l.date))].slice(0, 6);
  $('#tab-cal').innerHTML = `
    <div class="cal-head"><h2>${MONN[m0.getMonth()]} ${m0.getFullYear()}</h2>
      <button class="btn" data-cal="-1">←</button><button class="btn" data-cal="0">Сегодня</button><button class="btn" data-cal="1">→</button>
      <span style="margin-left:auto" class="muted">${weekParity(now)}</span></div>
    <div class="cal">${DOWS.map(d => `<div class="dow">${d}</div>`).join('')}${cells.join('')}</div>
    <div class="panel glass" style="margin-top:18px"><div class="panel-h"><h2>Ближайшие учебные дни</h2></div>
      ${futureDays.map(k => `<div class="day-block"><div class="day-title">${fmtDayW(D(k + 'T12:00'))}</div>${DATA.lessons.filter(l => l.date === k).map(lessonHTML).join('')}</div>`).join('') || '<div class="empty">Пар в расписании больше нет</div>'}
    </div>`;
  $$('[data-cal]', $('#tab-cal')).forEach(b => b.onclick = () => { const v = +b.dataset.cal; st.calMonth = v === 0 ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(m0.getFullYear(), m0.getMonth() + v, 1); renderCalendar(); });
  $$('.cell', $('#tab-cal')).forEach(c => c.onclick = () => openDay(c.dataset.day));
}
function weekParity(d) {
  // нечётная/чётная по ISO-неделе от 1 сентября учебного года
  const y = d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1; const s = new Date(y, 8, 1); const sMon = new Date(s); sMon.setDate(s.getDate() - (s.getDay() + 6) % 7);
  const n = Math.floor((startOfDay(d) - sMon) / (7 * 864e5)) + 1; return `Неделя ${n} · ${n % 2 ? 'нечётная' : 'чётная'}`;
}
function openDay(k) {
  const items = itemsByDay().get(k) || []; const d = D(k + 'T12:00');
  const ls = items.filter(x => x.type === 'lesson' || x.type === 'exam').map(x => x.l);
  const dls = items.filter(x => x.type === 'dl').map(x => x.d);
  const ms = items.filter(x => x.type === 'meet').map(x => x.m);
  openDrawer(`<h2>${cap(fmtDayW(d))}</h2>
    ${ls.length ? `<div class="sect"><h3>Пары</h3>${ls.map(lessonHTML).join('')}</div>` : ''}
    ${dls.length ? `<div class="sect"><h3>Дедлайны</h3>${dls.map(x => dlHTML(x)).join('')}</div>` : ''}
    ${ms.length ? `<div class="sect"><h3>Встречи в LMS</h3>${ms.map(m => `<div class="msg"><div class="h"><span class="pill" style="--c:${subj(m.subject).color}">${esc(subj(m.subject).short)}</span>${hm(D(m.start))}</div><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.title)}</a></div>`).join('')}</div>` : ''}
    ${!items.length ? '<div class="empty">В этот день ничего нет</div>' : ''}`);
}

/* ====== DEADLINES ====== */
function renderDeadlines() {
  const now = new Date();
  let list = visibleDl();
  if (st.dlSubj) list = list.filter(d => d.subject === st.dlSubj);
  if (st.dlSrc !== 'all') list = list.filter(d => st.dlSrc === 'exam' ? d.kind === 'exam' : d.source === st.dlSrc && d.kind !== 'exam');
  const notDone = list.filter(d => !isDone(d));
  const groups = [
    ['Просрочено', notDone.filter(d => D(d.due) < now && d.kind !== 'exam'), 'var(--hot)'],
    ['На этой неделе', notDone.filter(d => D(d.due) >= now && D(d.due) < new Date(now.getTime() + 7 * 864e5))],
    ['Дальше', notDone.filter(d => D(d.due) >= new Date(now.getTime() + 7 * 864e5))],
  ];
  let tasks = DATA.tasks.filter(t => !t.due && (!st.dlSubj || t.subject === st.dlSubj));
  if (!st.showDone) tasks = tasks.filter(t => !isDone(t));
  const doneList = list.filter(d => isDone(d));
  const subjects = [...new Set(DATA.deadlines.map(d => d.subject).concat(DATA.tasks.map(t => t.subject)))].filter(Boolean);
  $('#tab-dl').innerHTML = `
    <div class="filters">
      <button class="chip ${!st.dlSubj ? 'on' : ''}" data-f-subj="">Все предметы</button>
      ${subjects.map(k => `<button class="chip ${st.dlSubj === k ? 'on' : ''}" data-f-subj="${k}"><span class="dot" style="background:${subj(k).color}"></span>${esc(subj(k).short)}</button>`).join('')}
    </div>
    <div class="filters">
      ${[['all', 'Все источники'], ['lms', 'LMS'], ['tg', 'Из чата'], ['exam', 'Зачёты/экзамены'], ['manual', 'Вручную']].map(([k, t]) => `<button class="chip ${st.dlSrc === k ? 'on' : ''}" data-f-src="${k}">${t}</button>`).join('')}
      <span class="sep"></span>
      <label class="toggle"><input type="checkbox" id="tOther" ${st.showOther ? 'checked' : ''}> чужие потоки и группы</label>
      <label class="toggle"><input type="checkbox" id="tDone" ${st.showDone ? 'checked' : ''}> показать сделанное</label>
    </div>
    ${groups.map(([t, arr, c]) => arr.length ? `<div class="group-h"><h3 ${c ? `style="color:${c}"` : ''}>${t}</h3><span class="muted">${arr.length}</span></div>${(t === 'Просрочено' ? arr.slice().reverse() : arr).map(d => dlHTML(d)).join('')}` : '').join('')}
    ${tasks.length ? `<div class="group-h"><h3>Задания в LMS без срока</h3><span class="muted">${tasks.length}</span></div>${tasks.map(taskHTML).join('')}` : ''}
    ${st.showDone && doneList.length ? `<div class="group-h"><h3>Сделано</h3><span class="muted">${doneList.length}</span></div>${doneList.slice().reverse().map(d => dlHTML(d)).join('')}` : ''}
    ${!groups.some(g => g[1].length) && !tasks.length ? '<div class="empty">Пусто. Можно выдохнуть 🎉</div>' : ''}
    <p class="muted" style="margin-top:24px;font-size:13px">Галочки хранятся только в этом браузере. Статус «сдано» из LMS подтягивается сам. Дедлайны «из чата» найдены автоматически по фразам вида «до 25 числа» / «до 01.12»: проверяйте по ссылке.</p>`;
  $$('[data-f-subj]').forEach(b => b.onclick = () => { st.dlSubj = b.dataset.fSubj || null; renderDeadlines(); });
  $$('[data-f-src]').forEach(b => b.onclick = () => { st.dlSrc = b.dataset.fSrc; renderDeadlines(); });
  $('#tOther').onchange = e => { st.showOther = e.target.checked; LS.set('showOther', st.showOther); renderAll(); };
  $('#tDone').onchange = e => { st.showDone = e.target.checked; LS.set('showDone', st.showDone); renderDeadlines(); };
}

/* ====== SUBJECTS ====== */
function renderSubjects() {
  const now = new Date();
  const cards = DATA.subjects.filter(s => DATA.lessons.some(l => l.subject === s.key) || DATA.deadlines.some(d => d.subject === s.key && !d.other)).map(s => {
    const next = DATA.lessons.find(l => l.subject === s.key && D(l.end) > now);
    const open = visibleDl().filter(d => d.subject === s.key && !isDone(d) && D(d.due) > now && d.kind !== 'exam').length + DATA.tasks.filter(t => t.subject === s.key && !t.due && !isDone(t)).length;
    const exam = DATA.deadlines.find(d => d.subject === s.key && d.kind === 'exam' && D(d.due) > now);
    return `<div class="subj glass" style="--c:${s.color}" data-subj="${s.key}">
      <span class="pill" style="--c:${s.color}">${esc(s.short)}</span>
      <h3>${esc(s.name)}</h3>
      <div class="muted" style="font-size:13px">${esc(s.teachers.map(t => shortName(t.name)).join(', ') || '—')}</div>
      <div class="nums"><span>Пара: <b>${next ? fmtDay(D(next.start)) : '—'}</b></span><span>Задач: <b>${open}</b></span>${exam ? `<span>${esc(exam.title.split(':')[0])}: <b>${fmtDay(D(exam.due))}</b></span>` : ''}</div>
    </div>`;
  });
  $('#tab-subj').innerHTML = `<div class="subj-grid">${cards.join('')}</div>`;
  $$('.subj', $('#tab-subj')).forEach(c => c.onclick = () => openSubject(c.dataset.subj));
}
function openSubject(k) {
  const s = subj(k), now = new Date();
  const ls = DATA.lessons.filter(l => l.subject === k);
  const upcoming = ls.filter(l => D(l.end) > now);
  const dls = visibleDl().filter(d => d.subject === k);
  const tasks = DATA.tasks.filter(t => t.subject === k && !t.due);
  const msgs = DATA.chat.filter(m => m.subject === k).slice(0, 15);
  openDrawer(`<span class="pill" style="--c:${s.color}">${esc(s.short)}</span><h2 style="margin-top:8px">${esc(s.name)}</h2>
    <div class="kv">
      ${s.teachers.map(t => `<div><b>${esc(t.name)}</b><span class="muted">${esc(t.types.join(', '))}</span></div>`).join('')}
      ${s.emails.length ? `<div>✉️ ${s.emails.map(e => `<a href="mailto:${esc(e)}">${esc(e)}</a>`).join(', ')}</div>` : ''}
      <div>${s.lms.map(c => `<a class="btn" href="${esc(c.url)}" target="_blank" rel="noopener">Курс в LMS ↗</a>`).join(' ')} ${s.tg.map(t => `<a class="btn" href="${esc(t.url)}" target="_blank" rel="noopener">Тема в чате ↗</a>`).join(' ')}</div>
    </div>
    <div class="sect"><h3>Дедлайны и задания</h3>${dls.map(d => dlHTML(d)).join('') + tasks.map(taskHTML).join('') || '<div class="empty">Нет</div>'}</div>
    <div class="sect"><h3>Пары (${upcoming.length} впереди из ${ls.length})</h3>${upcoming.slice(0, 8).map(l => `<div class="day-title">${fmtDayW(D(l.start))}</div>${lessonHTML(l)}`).join('') || '<div class="empty">Больше пар нет</div>'}</div>
    ${s.materials.length ? `<div class="sect"><h3>Ссылки из чата</h3><ul class="link-list">${s.materials.map(m => `<li><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.note || m.url)}</a> <span class="muted">· ${fmtDay(D(m.at))}</span></li>`).join('')}</ul></div>` : ''}
    ${s.files.length ? `<div class="sect"><h3>Файлы в чате</h3><ul class="link-list">${s.files.map(f => `<li><a href="${esc(f.link)}" target="_blank" rel="noopener">📎 ${esc(f.name)}</a> <span class="muted">· ${fmtDay(D(f.at))}</span></li>`).join('')}</ul></div>` : ''}
    ${msgs.length ? `<div class="sect"><h3>Последнее в теме</h3>${msgs.map(m => msgHTML(m)).join('')}</div>` : ''}`);
}

/* ====== CHAT ====== */
function renderChat() {
  const topics = [...new Map(DATA.chat.map(m => [m.topic, m.topicTitle])).entries()];
  const q = st.chatQ.trim().toLowerCase();
  let list = DATA.chat;
  if (st.chatTopic === 'imp') list = list.filter(m => m.important || m.subject);
  else if (st.chatTopic !== 'all') list = list.filter(m => String(m.topic) === st.chatTopic);
  if (q) list = list.filter(m => (m.t + ' ' + (m.doc || '') + ' ' + m.from).toLowerCase().includes(q));
  $('#tab-chat').innerHTML = `
    <input class="search" id="chatQ" placeholder="Поиск по чату: «лаба», «почта», «зачёт»…" value="${esc(st.chatQ)}">
    <div class="filters">
      <button class="chip ${st.chatTopic === 'imp' ? 'on' : ''}" data-ct="imp">⭐ Учёба и важное</button>
      <button class="chip ${st.chatTopic === 'all' ? 'on' : ''}" data-ct="all">Всё</button>
      ${topics.map(([id, t]) => `<button class="chip ${st.chatTopic === String(id) ? 'on' : ''}" data-ct="${id}">${esc(t.length > 26 ? t.slice(0, 24) + '…' : t)}</button>`).join('')}
    </div>
    <div id="chatList">${list.slice(0, 150).map(m => msgHTML(m, q)).join('') || '<div class="empty">Ничего не найдено</div>'}</div>
    <p class="muted" style="font-size:13px">Сообщения за последние 60 дней. Флуд и мемы отфильтрованы, из общего чата остаются только сообщения про учёбу.</p>`;
  $$('[data-ct]').forEach(b => b.onclick = () => { st.chatTopic = b.dataset.ct; renderChat(); });
  const inp = $('#chatQ'); inp.oninput = () => { st.chatQ = inp.value; const pos = inp.selectionStart; renderChat(); const n = $('#chatQ'); n.focus(); n.setSelectionRange(pos, pos); };
}

/* ====== drawer ====== */
function openDrawer(html) { $('#drawerBody').innerHTML = html; $('#drawer').hidden = false; document.body.style.overflow = 'hidden'; }
function closeDrawer() { $('#drawer').hidden = true; document.body.style.overflow = ''; }

/* ====== ICS export ====== */
$('#icsBtn').onclick = () => {
  const z = s => s.replace(/[-:]/g, '').replace(/\.\d+/, '');
  const utc = iso => z(new Date(iso).toISOString()).slice(0, 15) + 'Z';
  const escI = s => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, m => '\\' + m);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ubst2503//study//RU', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:' + DATA.group];
  for (const l of DATA.lessons) lines.push('BEGIN:VEVENT', 'UID:' + l.id + '@ubst', 'DTSTAMP:' + utc(DATA.generated), 'DTSTART:' + utc(l.start), 'DTEND:' + utc(l.end),
    'SUMMARY:' + escI(`${subj(l.subject).short} · ${l.type}`), 'DESCRIPTION:' + escI(`${l.subjectName}\n${l.teachers.join(', ')}${l.links[0] ? '\n' + l.links[0].url : ''}`), 'END:VEVENT');
  for (const d of visibleDl()) if (!isDone(d) && d.kind !== 'exam') { const e = new Date(d.due); lines.push('BEGIN:VEVENT', 'UID:' + d.id + '@ubst', 'DTSTAMP:' + utc(DATA.generated), 'DTSTART:' + utc(new Date(e.getTime() - 3600e3).toISOString()), 'DTEND:' + utc(d.due),
    'SUMMARY:' + escI(`⚑ ${subj(d.subject).short}: ${d.title}`), 'DESCRIPTION:' + escI(d.url || ''), 'BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY', 'DESCRIPTION:Дедлайн завтра', 'END:VALARM', 'END:VEVENT'); }
  lines.push('END:VCALENDAR');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/calendar' })); a.download = DATA.group + '.ics'; a.click();
};
