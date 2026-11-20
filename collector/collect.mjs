// Сборщик данных: ЛК МТУСИ (расписание), LMS (Moodle), Telegram-форум группы.
// Работает через постоянный профиль Edge (.profile), где вы один раз вошли во все три сервиса.
//   node collector/collect.mjs --login   — открыть окно и войти (закройте окно, когда закончите)
//   node collector/collect.mjs           — собрать данные в data/raw/*.json (без окна)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'raw');
const PROFILE = path.join(ROOT, '.profile');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
fs.mkdirSync(RAW, { recursive: true });

const LOGIN = process.argv.includes('--login');
const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const want = s => !only.length || only.includes(s);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const save = (name, obj) => fs.writeFileSync(path.join(RAW, name), JSON.stringify(obj));
const load = name => { try { return JSON.parse(fs.readFileSync(path.join(RAW, name), 'utf8')); } catch { return null; } };

const SESSION = path.join(ROOT, 'data', 'session.json'); // cookies (в т.ч. сессионные) — восстанавливаем при каждом запуске
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'msedge',
  headless: !LOGIN,
  viewport: LOGIN ? null : { width: 1280, height: 900 },
  args: ['--disable-blink-features=AutomationControlled'],
});
try { const s = JSON.parse(fs.readFileSync(SESSION, 'utf8')); if (s.cookies?.length) await ctx.addCookies(s.cookies); } catch {}
const saveSession = async () => { const s = await ctx.storageState(); fs.writeFileSync(SESSION, JSON.stringify({ cookies: s.cookies.filter(c => /mtuci\.ru$/.test(c.domain)) })); };

if (LOGIN) {
  const map = { lk: 'https://lk.mtuci.ru/student/schedule', lms: 'https://lms.mtuci.ru/my/', tg: 'https://web.telegram.org/k/' };
  const keys = only.length ? only : ['lk', 'lms', 'tg'];
  const pages = {};
  for (const k of keys) { pages[k] = ctx.pages().find(p => p.url() === 'about:blank' && !Object.values(pages).includes(p)) || await ctx.newPage(); await pages[k].goto(map[k]).catch(() => {}); }
  log('Войдите во все вкладки (в ЛК — с галочкой «Запомнить меня»). Окно закроется само, когда вход будет найден.');
  const ok = {
    lk: async p => /^\/student/.test(new URL(p.url()).pathname) && new URL(p.url()).hostname === 'lk.mtuci.ru',
    lms: async p => { if (new URL(p.url()).hostname !== 'lms.mtuci.ru') return false; return p.evaluate(() => !!(window.M?.cfg?.sesskey) && document.body.id !== 'page-login-index').catch(() => false); },
    tg: async p => p.evaluate(() => !!document.querySelector('.chatlist, .chat-list, #column-left .chatlist-container')).catch(() => false),
  };
  for (let i = 0; i < 900; i++) { // до 30 минут
    await new Promise(r => setTimeout(r, 2000));
    if (ctx.pages().length === 0) break;
    const st = {}; for (const k of keys) st[k] = pages[k].isClosed() ? false : await ok[k](pages[k]);
    if (i % 5 === 0) log('статус входа:', JSON.stringify(st));
    if (keys.every(k => st[k])) { await new Promise(r => setTimeout(r, 4000)); await saveSession(); log('Вход найден, сессия сохранена.'); break; }
  }
  await ctx.close().catch(() => {});
  process.exit(0);
}

const errors = [];
let page = ctx.pages()[0] || await ctx.newPage();

// Переход с прохождением единого входа МТУСИ (Keycloak, «Запомнить меня»): ждём, пока цепочка редиректов успокоится
async function gotoSSO(url, host) {
  await page.goto(url, { waitUntil: 'commit', timeout: 60000 }).catch(e => { if (!/interrupted|ERR_ABORTED/.test(e.message)) throw e; });
  let last = '', stable = 0;
  for (let i = 0; i < 60 && stable < 3; i++) {
    await page.waitForTimeout(1000);
    const u = page.url();
    stable = (u === last) ? stable + 1 : 0; last = u;
  }
  const u = new URL(page.url());
  if (u.hostname !== host || u.pathname.startsWith('/bvzauth') || u.pathname.includes('after-login'))
    throw new Error('нет входа (' + page.url().slice(0, 90) + '): запустите `node collector/collect.mjs --login --only=lk,lms` и войдите с галочкой «Запомнить меня»');
  await page.waitForLoadState('domcontentloaded');
}

// ---------- ЛК: расписание ----------
async function collectLK() {
  await gotoSSO('https://lk.mtuci.ru/student/schedule', 'lk.mtuci.ru');
  await page.waitForTimeout(2000);
  const res = await page.evaluate(async (group) => {
    const seen = new Set(); const lessons = [];
    for (let m = 0; m < 12; m++) {
      const r = await fetch('/api/timetable/get?value=' + encodeURIComponent(group) + '&month=' + m + '&type=group', { credentials: 'include' });
      const txt = await r.text();
      let j; try { j = JSON.parse(txt); } catch { return { error: 'not-json (нет входа в ЛК?)' }; }
      for (const [d, arr] of Object.entries(j.data?.days || {})) for (const x of arr) {
        if (seen.has(x.ID)) continue; seen.add(x.ID);
        lessons.push({ id: x.ID, date: d, num: +x.UF_NUMBER, start: x.UF_TIME_START, end: x.UF_TIME_END, subject: x.UF_DISCIPLINE, type: x.UF_TYPE,
          teachers: x.UF_TEACHER || [], rooms: x.UF_AUDIENCE || [], online: x.UF_IS_ONLINE === '1', control: x.UF_IS_FORM_CONTROL === '1', retake: x.UF_IS_RETAKE === '1' });
      }
    }
    return { lessons };
  }, cfg.lkGroupParam);
  if (res.error) throw new Error('ЛК: ' + res.error);
  save('lk.json', { fetched: new Date().toISOString(), group: cfg.group, ...res });
  log('ЛК: пар', res.lessons.length);
}

// ---------- LMS (Moodle) ----------
async function collectLMS() {
  await gotoSSO('https://lms.mtuci.ru/my/', 'lms.mtuci.ru');
  if (page.url().includes('/login/')) { // страница входа Moodle — жмём кнопку входа через ЛК
    const sso = await page.$('a[href*="auth/oidc"]'); if (sso) { await sso.click(); await page.waitForURL(u => u.hostname === 'lms.mtuci.ru' && !u.pathname.startsWith('/login'), { timeout: 30000 }).catch(() => {}); }
  }
  await page.waitForFunction(() => window.M?.cfg?.sesskey, null, { timeout: 20000 }).catch(() => {});
  if (!(await page.evaluate(() => !!(window.M && M.cfg && M.cfg.sesskey && document.body.id !== 'page-login-index')))) throw new Error('LMS: нет входа');
  const res = await page.evaluate(async (own) => {
    const sk = M.cfg.sesskey;
    const call = async (m, a) => { const r = await fetch('/lib/ajax/service.php?sesskey=' + sk + '&info=' + m, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([{ index: 0, methodname: m, args: a }]) }); const j = (await r.json())[0]; if (j.error) throw new Error(m + ': ' + JSON.stringify(j.exception)); return j.data; };
    const clean = h => (h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').trim();
    const courses = (await call('core_course_get_enrolled_courses_by_timeline_classification', { classification: 'all', limit: 0, offset: 0, sort: 'fullname' }))
      .courses.map(x => ({ id: x.id, name: x.fullname, url: x.viewurl, start: x.startdate, end: x.enddate }));
    const now = new Date(); const events = new Map();
    for (let k = -3; k <= 7; k++) {
      const d = new Date(now.getFullYear(), now.getMonth() + k, 1);
      const v = await call('core_calendar_get_calendar_monthly_view', { year: d.getFullYear(), month: d.getMonth() + 1, courseid: 1, day: 1 });
      for (const w of v.weeks) for (const dd of w.days) for (const e of dd.events)
        events.set(e.id, { id: e.id, name: e.name, course: e.course?.fullname || null, courseId: e.course?.id || null, ts: e.timestart, dur: e.timeduration,
          mod: e.modulename || null, type: e.eventtype, url: e.url, cmid: e.instance ? null : null, desc: clean(e.description).slice(0, 800) });
    }
    const act = (await call('core_calendar_get_action_events_by_timesort', { timesortfrom: Math.floor(Date.now() / 1000) - 86400 * 200, limitnum: 50 }))
      .events.map(e => ({ id: e.id, overdue: e.overdue, actionable: !!e.action?.actionable, action: e.action?.name || null }));
    // активности текущих курсов своего потока
    const cur = courses.filter(c => c.name.includes(own) && !c.name.startsWith('2сем_') && c.end * 1000 > Date.now() - 86400e3 * 30);
    const pages = {};
    for (const c of cur) {
      const doc = new DOMParser().parseFromString(await (await fetch('/course/view.php?id=' + c.id)).text(), 'text/html');
      pages[c.id] = [...doc.querySelectorAll('li.activity')].map(li => ({
        name: li.querySelector('.instancename')?.firstChild?.textContent?.trim() || li.innerText.trim().split('\n')[0],
        url: li.querySelector('a.aalink')?.href || null,
        mod: ([...li.classList].find(k => k.startsWith('modtype_')) || '').slice(8),
        dates: li.querySelector('[data-region="activity-dates"]')?.innerText?.replace(/\s+/g, ' ').trim() || null,
        section: li.closest('li.section')?.querySelector('.sectionname')?.innerText?.trim() || null,
      }));
    }
    // статусы заданий
    const assigns = [];
    for (const [cid, acts] of Object.entries(pages)) for (const a of acts) {
      if (a.mod !== 'assign' || !a.url) continue;
      try {
        const doc = new DOMParser().parseFromString(await (await fetch(a.url)).text(), 'text/html');
        const rows = {}; doc.querySelectorAll('.submissionstatustable tr, .generaltable tr').forEach(tr => { const th = tr.querySelector('th,td.cell.c0'); const td = tr.querySelector('td:last-child'); if (th && td && th !== td) rows[th.innerText.trim()] = td.innerText.replace(/\s+/g, ' ').trim(); });
        const intro = clean(doc.querySelector('.activity-description, #intro, .no-overflow')?.innerHTML).slice(0, 1200);
        const dates = doc.querySelector('[data-region="activity-dates"]')?.innerText?.replace(/\s+/g, ' ').trim() || null;
        assigns.push({ courseId: +cid, name: a.name, url: a.url, rows, intro, dates });
      } catch (e) { assigns.push({ courseId: +cid, name: a.name, url: a.url, error: String(e) }); }
    }
    return { courses, events: [...events.values()], act, pages, assigns };
  }, cfg.lmsOwnStream);
  save('lms.json', { fetched: new Date().toISOString(), ...res });
  log('LMS: курсов', res.courses.length, 'событий', res.events.length, 'заданий', res.assigns.length);
}

// ---------- Telegram ----------
async function collectTG() {
  await page.goto('https://web.telegram.org/k/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.rootScope?.managers?.apiManager, null, { timeout: 90000 });
  await page.waitForTimeout(4000);
  const prev = load('tg.json');
  const stopAt = prev?.messages?.length ? Math.max(...prev.messages.map(m => m.id)) - 300 : 0;
  const res = await page.evaluate(async ({ title, stopAt }) => {
    const m = rootScope.managers;
    const s = await m.apiManager.invokeApi('contacts.search', { q: title, limit: 20 });
    const c = s.chats.find(c => c.title === title);
    if (!c) return { error: 'чат не найден' };
    const peer = { _: 'inputPeerChannel', channel_id: c.id, access_hash: c.access_hash };
    const t = await m.apiManager.invokeApi('messages.getForumTopics', { peer, limit: 100, offset_date: 0, offset_id: 0, offset_topic: 0 });
    const topics = t.topics.map(x => ({ id: x.id, title: x.title, top: x.top_message, pinned: !!x.pinned, closed: !!x.closed }));
    const users = {}; const msgs = []; let off = 0;
    while (true) {
      const r = await m.apiManager.invokeApi('messages.getHistory', { peer, offset_id: off, offset_date: 0, add_offset: 0, limit: 100, max_id: 0, min_id: 0, hash: 0 });
      for (const u of r.users || []) users[u.id] = [u.first_name, u.last_name].filter(Boolean).join(' ');
      if (!r.messages.length) break;
      for (const x of r.messages) msgs.push({ id: x.id, d: x.date, f: x.from_id?.user_id || x.from_id?.channel_id || null, t: x.message || '',
        re: x.reply_to?.reply_to_msg_id || null, topId: x.reply_to?.reply_to_top_id || null,
        media: x.media?._ || null, doc: x.media?.document?.attributes?.find(a => a._ === 'documentAttributeFilename')?.file_name || null,
        act: x.action?._ || null, urls: (x.entities || []).filter(e => e._ === 'messageEntityTextUrl').map(e => e.url), pin: !!x.pinned, edit: x.edit_date || null });
      const last = r.messages[r.messages.length - 1].id;
      if (last === off || last <= 1 || last <= stopAt) break;
      off = last; await new Promise(z => setTimeout(z, 250));
    }
    return { chatId: String(c.id), topics, users, msgs };
  }, { title: cfg.tgChatTitle, stopAt });
  if (res.error) throw new Error('Telegram: ' + res.error);
  const byId = new Map((prev?.messages || []).map(x => [x.id, x]));
  for (const x of res.msgs) byId.set(x.id, x);
  const messages = [...byId.values()].sort((a, b) => b.id - a.id);
  save('tg.json', { fetched: new Date().toISOString(), chatId: res.chatId, topics: res.topics, users: { ...(prev?.users || {}), ...res.users }, messages });
  log('Telegram: новых/обновлённых', res.msgs.length, 'всего', messages.length);
}

for (const [name, fn] of [['lk', collectLK], ['lms', collectLMS], ['tg', collectTG]]) {
  if (!want(name)) continue;
  page = await ctx.newPage();
  try { await fn(); } catch (e) { errors.push(name + ': ' + e.message.split('\n')[0]); log('ОШИБКА', name, e.message.split('\n')[0]); }
  await page.close().catch(() => {});
}
save('status.json', { at: new Date().toISOString(), errors });
if (!errors.some(e => /^(lk|lms)/.test(e))) await saveSession().catch(() => {});
await ctx.close();
process.exit(errors.length === 3 ? 1 : 0);
