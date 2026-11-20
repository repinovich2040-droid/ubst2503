// Нормализует data/raw/*.json в единый набор данных и шифрует его в docs/data.enc.json.
//   node collector/build.mjs            — собрать и зашифровать (пароль из .site-password или SITE_PASSWORD)
//   node collector/build.mjs --plain    — дополнительно положить data/data.json (для отладки, в git не идёт)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { webcrypto as crypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'raw');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const load = n => { try { return JSON.parse(fs.readFileSync(path.join(RAW, n), 'utf8')); } catch { return null; } };
const lk = load('lk.json'), lms = load('lms.json'), tg = load('tg.json'), status = load('status.json');
let manual = []; try { manual = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'manual.json'), 'utf8')); } catch {}

const TZ = '+03:00';
const pad = n => String(n).padStart(2, '0');
const isoMsk = ts => { const d = new Date((ts + 3 * 3600) * 1000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${TZ}`; };
const fromRuDate = (d, t = '00:00') => { const [dd, mm, yy] = d.split('.'); return `${yy}-${mm}-${dd}T${t}${TZ}`; };
const subjOf = name => { if (!name) return null; const n = name.toLowerCase(); const s = cfg.subjects.find(s => s.match.some(m => n.includes(m))); return s ? s.key : null; };
const nowTs = Date.now() / 1000;

// --- группа в тексте: относится ли запись к нашей группе ---
function forOtherGroup(text) {
  if (!text) return false;
  const t = text.replace(/\s+/g, ' ');
  if (/УБСТ\s?25\d\d\s?[-–]\s?\d\d/i.test(t) || /для всех групп/i.test(t)) return false; // диапазон/все
  const codes = new Set();
  for (const m of t.matchAll(/УБСТ\s?25(\d\d)((?:\s?[,и]\s?(?:УБСТ\s?25)?\d\d)*)/gi)) {
    codes.add(m[1]); for (const k of (m[2] || '').matchAll(/(\d\d)\b/g)) codes.add(k[1]);
  }
  return codes.size > 0 && !codes.has(cfg.groupCode);
}

// ---------- расписание ----------
const lessons = (lk?.lessons || []).map(x => ({
  id: 'lk' + x.id, date: fromRuDate(x.date).slice(0, 10), start: fromRuDate(x.date, x.start), end: fromRuDate(x.date, x.end), num: x.num,
  subject: subjOf(x.subject), subjectName: x.subject, type: x.type, teachers: x.teachers, rooms: x.rooms.filter(r => r && !/дистанц/i.test(r)),
  online: x.online, control: x.control, retake: x.retake, links: [],
})).sort((a, b) => a.start.localeCompare(b.start));

// ---------- LMS ----------
const courses = (lms?.courses || []).map(c => ({ id: c.id, name: c.name, url: c.url, subject: subjOf(c.name),
  own: c.name.includes(cfg.lmsOwnStream) && !c.name.startsWith('2сем_'), retake: c.name.startsWith('2сем_') }));
const courseById = new Map(courses.map(c => [c.id, c]));
const actById = new Map((lms?.act || []).map(a => [a.id, a]));
const deadlines = [], meetings = [];
for (const e of lms?.events || []) {
  const c = courseById.get(e.courseId) || { name: e.course, own: false };
  const other = forOtherGroup(e.name) || !(c.own || c.retake || (c.name || '').includes('УБСТ'));
  const base = { subject: subjOf(c.name), course: c.name, courseUrl: c.url || null, url: e.url, other };
  if (e.mod === 'assign' || e.mod === 'quiz') {
    if (/открывается$/i.test(e.name)) continue;
    const a = actById.get(e.id);
    const title = e.name.replace(/\s*-\s*срок сдачи$/i, '').replace(/\s*закрывается$/i, '');
    deadlines.push({ id: 'lms' + e.id, source: 'lms', kind: e.mod, title, due: isoMsk(e.ts), ...base,
      status: a ? 'open' : (e.ts < nowTs ? 'done' : 'unknown'), retake: c.retake || /пересдач/i.test(e.name), desc: e.desc || '' });
  } else {
    meetings.push({ id: 'm' + e.id, title: e.name.replace(/\s*запланировано на$/, ''), start: isoMsk(e.ts), ...base, kind: e.mod || e.type, retake: c.retake || /пересдач/i.test(e.name) });
  }
}
// ссылки на видеовстречи — к парам того же дня и предмета
for (const m of meetings) {
  if (m.other) continue;
  const day = m.start.slice(0, 10);
  const ls = lessons.filter(l => l.date === day && l.subject && l.subject === m.subject);
  if (ls.length) { for (const l of ls) if (!l.links.some(x => x.url === m.url)) l.links.push({ title: m.title, url: m.url }); m.attached = true; }
}
// задания со страниц курсов (в т.ч. без срока)
const ruMonths = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const parseRuLong = s => { const m = s && s.match(/(\d{1,2})\s+([а-я]+)\s+(\d{4}),?\s+(\d{1,2}):(\d{2})/i); if (!m) return null; const mo = ruMonths.indexOf(m[2].toLowerCase()); if (mo < 0) return null; return `${m[3]}-${pad(mo + 1)}-${pad(m[1])}T${pad(m[4])}:${m[5]}${TZ}`; };
const tasks = [];
for (const a of lms?.assigns || []) {
  const c = courseById.get(a.courseId) || {};
  const rows = a.rows || {};
  const st = Object.entries(rows).find(([k]) => /состояние ответа/i.test(k))?.[1] || '';
  const grade = Object.entries(rows).find(([k]) => /состояние оценивания|оценка/i.test(k))?.[1] || '';
  const dueTxt = Object.entries(rows).find(([k]) => /срок сдачи|последний срок/i.test(k))?.[1] || (a.dates || '').match(/Срок сдачи:([^]+?)(?:$|Открыто|Закрывается)/)?.[1] || '';
  const done = /отправлено|оценено|зачтено|submitted/i.test(st) && !/не представлен|нет ответа|черновик/i.test(st);
  tasks.push({ id: 'task' + (a.url || '').split('id=')[1], subject: subjOf(c.name), course: c.name, title: a.name, url: a.url,
    due: parseRuLong(dueTxt), submission: st || null, grade: grade || null, done, intro: a.intro || '' });
}
// у LMS-дедлайнов проставим статус сдачи, если есть страница задания
for (const d of deadlines) { const t = tasks.find(t => t.url === d.url); if (t) { d.submission = t.submission; if (t.done) d.status = 'done'; else if (t.submission) d.status = 'open'; } }

// ---------- Telegram ----------
const topicTitle = new Map((tg?.topics || []).map(t => [t.id, t.title]));
const topicIds = new Set(topicTitle.keys());
const msgById = new Map((tg?.messages || []).map(m => [m.id, m]));
const topicOf = (m, depth = 0) => {
  if (m.topId && topicIds.has(m.topId)) return m.topId;
  if (m.re == null) return 1;
  if (topicIds.has(m.re)) return m.re;
  const p = msgById.get(m.re); return (!p || depth > 40) ? 1 : topicOf(p, depth + 1);
};
const subjByTopic = new Map(); for (const s of cfg.subjects) for (const id of s.tg) subjByTopic.set(id, s.key);
const firstName = id => ((tg?.users || {})[id] || '').split(' ')[0] || '—';
const since = nowTs - cfg.chatDaysBack * 86400;
const kw = /(сда|срок|дедлайн|до \d|перенос|отмен|зач[её]т|экзам|контрольн|лаб|расписан|почт|ссылк|автомат)/i;
const chat = [];
for (const m of tg?.messages || []) {
  if (m.d < since || m.act) continue;
  if (!m.t && !m.doc) continue;
  if (m.doc && /^sticker/.test(m.doc)) continue;
  const topic = topicOf(m);
  if (cfg.tgSkipTopics.includes(topic)) continue;
  const isFlood = topic === 1;
  if (isFlood && !(kw.test(m.t) && m.t.length > 15)) continue;
  chat.push({ id: m.id, at: isoMsk(m.d), from: firstName(m.f), t: m.t, doc: m.doc, urls: m.urls, pin: m.pin, topic, topicTitle: topicTitle.get(topic) || 'Общий',
    subject: subjByTopic.get(topic) || null, important: cfg.tgImportantTopics.includes(topic) || m.pin,
    link: `https://t.me/c/${tg.chatId}/${topic === 1 ? '' : topic + '/'}${m.id}` });
}
chat.sort((a, b) => b.at.localeCompare(a.at));

// дедлайны из текста чата
const monthIdx = w => ruMonths.findIndex(x => w.toLowerCase().startsWith(x.slice(0, 3)));
const chatDeadlines = [];
for (const m of tg?.messages || []) {
  if (m.d < nowTs - 150 * 86400 || !m.t) continue;
  const t = m.t; const md = new Date((m.d + 3 * 3600) * 1000);
  if (!/(сда|сдел|присл|скин|отправ|загруз|срок|дедлайн|выполн|реш|прикреп)/i.test(t)) continue;
  let day, mon, year = md.getUTCFullYear(), r;
  if ((r = t.match(/до\s+(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?/i))) { day = +r[1]; mon = +r[2] - 1; if (r[3]) year = +(r[3].length === 2 ? '20' + r[3] : r[3]); }
  else if ((r = t.match(/до\s+(\d{1,2})(?:-?го)?\s+(январ|феврал|март|апрел|ма[яй]|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-я]*/i))) { day = +r[1]; mon = monthIdx(r[2]); }
  else if ((r = t.match(/до\s+(\d{1,2})(?:-?го)?\s+числа/i))) { day = +r[1]; mon = md.getUTCMonth() + (day < md.getUTCDate() ? 1 : 0); }
  else continue;
  if (!(day >= 1 && day <= 31 && mon >= 0)) continue;
  const due = new Date(Date.UTC(year, mon, day, 20, 59)); // 23:59 МСК
  if (!r[3] && due.getTime() / 1000 < m.d - 86400 * 7) due.setUTCFullYear(due.getUTCFullYear() + 1);
  const topic = topicOf(m);
  if (cfg.tgSkipTopics.includes(topic)) continue;
  const subject = subjByTopic.get(topic) || subjOf(t);
  const dueIso = isoMsk(Math.floor(due.getTime() / 1000)).slice(0, 10) + 'T23:59' + TZ;
  const dup = chatDeadlines.find(d => d.due === dueIso && (d.subject === subject || !subject || !d.subject || d.text.trim() === t.trim()));
  if (dup && !dup.subject && subject) dup.subject = subject;
  if (dup) { dup.mentions++; continue; }
  chatDeadlines.push({ id: 'tg' + m.id, source: 'tg', kind: 'chat', title: t.split('\n').find(l => /до\s+\d/i.test(l))?.trim().slice(0, 140) || t.slice(0, 140),
    text: t.slice(0, 1200), due: dueIso, subject, from: firstName(m.f), at: isoMsk(m.d), mentions: 1, status: 'open',
    url: `https://t.me/c/${tg.chatId}/${topic === 1 ? '' : topic + '/'}${m.id}` });
}
deadlines.push(...chatDeadlines);

// экзамены и зачёты из расписания
for (const l of lessons) if (l.control) deadlines.push({ id: 'exam' + l.id, source: 'lk', kind: 'exam', title: `${l.type}: ${l.subjectName}`, due: l.start, subject: l.subject,
  status: 'open', retake: l.retake, rooms: l.rooms, teachers: l.teachers, online: l.online });
// ручные записи
for (const m of manual) deadlines.push({ source: 'manual', status: 'open', kind: 'manual', ...m });

// ---------- контакты и материалы по предметам ----------
const emailRe = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const urlRe = /https?:\/\/[^\s)]+/g;
const subjects = cfg.subjects.map(s => {
  const ls = lessons.filter(l => l.subject === s.key);
  const teachers = {}; for (const l of ls) for (const t of l.teachers) (teachers[t] ||= new Set()).add(l.type);
  const emails = new Set(), materials = new Map(), files = [];
  for (const m of tg?.messages || []) {
    if (!s.tg.includes(topicOf(m))) continue;
    for (const e of (m.t.match(emailRe) || [])) emails.add(e.toLowerCase());
    for (const u of [...(m.t.match(urlRe) || []), ...(m.urls || [])]) if (!/salutejazz|telemost|ktalk/.test(u)) materials.set(u, { url: u, at: isoMsk(m.d), note: m.t.replace(urlRe, '').replace(/\s+/g, ' ').trim().slice(0, 80) });
    if (m.doc && !/^sticker/.test(m.doc) && !/УБСТ2503\s|Задачи|Практикум|_УБСТ/.test(m.doc)) files.push({ name: m.doc, at: isoMsk(m.d), link: `https://t.me/c/${tg.chatId}/${topicOf(m)}/${m.id}` });
  }
  return { key: s.key, short: s.short, name: s.name, color: s.color,
    teachers: Object.entries(teachers).map(([n, types]) => ({ name: n, types: [...types] })),
    emails: [...emails], materials: [...materials.values()].slice(0, 12), files: files.slice(0, 15),
    lms: courses.filter(c => c.subject === s.key && c.own).map(c => ({ name: c.name, url: c.url })),
    tg: s.tg.map(id => ({ id, title: topicTitle.get(id), url: `https://t.me/c/${tg?.chatId}/${id}` })) };
});

// прошедшие пересдачи не показываем
for (let i = deadlines.length - 1; i >= 0; i--) { const d = deadlines[i]; if (d.retake && new Date(d.due) < Date.now() - 3 * 864e5) deadlines.splice(i, 1); }
const data = {
  generated: new Date().toISOString(), group: cfg.group,
  sources: { lk: lk?.fetched || null, lms: lms?.fetched || null, tg: tg?.fetched || null, errors: status?.errors || [] },
  subjects, lessons, deadlines: deadlines.sort((a, b) => a.due.localeCompare(b.due)), tasks, meetings: meetings.filter(m => !m.attached), chat,
};

// ---------- шифрование ----------
let password = process.env.SITE_PASSWORD;
if (!password) try { password = fs.readFileSync(path.join(ROOT, '.site-password'), 'utf8').trim(); } catch {}
if (!password) { console.error('Нет пароля: создайте файл .site-password'); process.exit(1); }
// если содержимое (без даты сборки) не изменилось — файл не трогаем, чтобы не было пустых коммитов
const { createHash } = await import('node:crypto');
const hash = createHash('sha256').update(JSON.stringify({ ...data, generated: null, sources: { ...data.sources, lk: null, lms: null, tg: null } }) + password).digest('hex');
const hashFile = path.join(ROOT, 'data', '.lasthash');
const encFile = path.join(ROOT, 'docs', 'data.enc.json');
if (!process.argv.includes('--force') && fs.existsSync(encFile) && fs.existsSync(hashFile) && fs.readFileSync(hashFile, 'utf8') === hash) {
  if (process.argv.includes('--plain')) fs.writeFileSync(path.join(ROOT, 'data', 'data.json'), JSON.stringify(data, null, 1));
  console.log('build: без изменений'); process.exit(0);
}
fs.writeFileSync(hashFile, hash);
const plain = zlib.gzipSync(Buffer.from(JSON.stringify(data)));
const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), iter = 250000;
const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
const b64 = u => Buffer.from(u).toString('base64');
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs', 'data.enc.json'), JSON.stringify({ v: 1, iter, salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
if (process.argv.includes('--plain')) fs.writeFileSync(path.join(ROOT, 'data', 'data.json'), JSON.stringify(data, null, 1));
console.log(`build: пар ${lessons.length}, дедлайнов ${deadlines.length} (из чата ${chatDeadlines.length}), заданий ${tasks.length}, сообщений ${chat.length}, ${ct.length} байт`);
