'use strict';

const APP_VERSION = '1.0.0';

/* ───────────────────────── 설정 ───────────────────────── */

const MIN = 60 * 1000, DAY = 24 * 60 * MIN;
const CFG = {
  learnSteps: [1, 10],    // 새 카드 학습 단계(분)
  relearnSteps: [10],     // 틀린 복습 카드 재학습 단계(분)
  gradIvl: 1,             // 학습 단계를 마치면 첫 간격(일)
  easyIvl: 4,             // 새 카드에서 '쉬움' 선택 시 간격(일)
  startEase: 2.5,
  minEase: 1.3,
  easyBonus: 1.3,
  hardFactor: 1.2,
  maxIvl: 36500,
  learnAhead: 20 * MIN,   // 다른 카드가 없으면 이 시간 안에 돌아올 학습 카드를 미리 보여 줌
  rolloverHour: 4,        // 새벽 4시에 하루가 바뀜
  newPerDay: 20,
};

/* ───────────────────────── 유틸 ───────────────────────── */

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const byName = (a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true });

function startOfDay(ts = Date.now()) {
  const d = new Date(ts);
  if (d.getHours() < CFG.rolloverHour) d.setDate(d.getDate() - 1);
  d.setHours(CFG.rolloverHour, 0, 0, 0);
  return d.getTime();
}
function dueInDays(days, now = Date.now()) {
  const d = new Date(startOfDay(now));
  d.setDate(d.getDate() + days);
  return d.getTime();
}
function todayKey() {
  const d = new Date(startOfDay());
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function fmtDays(d) {
  if (d < 30) return `${d}일`;
  if (d < 365) return `${(d / 30).toFixed(1).replace(/\.0$/, '')}개월`;
  return `${(d / 365).toFixed(1).replace(/\.0$/, '')}년`;
}
function fmtWait(ms) {
  const m = Math.max(1, Math.round(ms / MIN));
  return m < 60 ? `${m}분` : `${Math.round(m / 60)}시간`;
}
function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

const store = {
  get(k, d) { try { const v = localStorage.getItem('fc.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('fc.' + k, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } },
};

/* ───────────────────────── 저장소(IndexedDB) ───────────────────────── */

const STORES = ['domains', 'categories', 'decks', 'cards'];
const S = { domains: new Map(), categories: new Map(), decks: new Map(), cards: new Map() };

const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('flashcards', 1);
      r.onupgradeneeded = () => {
        for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'id' });
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  all(name) {
    return new Promise((res, rej) => {
      const q = this.db.transaction(name).objectStore(name).getAll();
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  },
  write(ops) {
    return new Promise((res, rej) => {
      const t = this.db.transaction([...new Set(ops.map(o => o.store))], 'readwrite');
      for (const o of ops) {
        const os = t.objectStore(o.store);
        if (o.clear) os.clear();
        (o.put || []).forEach(v => os.put(v));
        (o.del || []).forEach(k => os.delete(k));
      }
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('저장이 취소되었습니다'));
    });
  },
};

async function loadAll() {
  for (const s of STORES) {
    S[s].clear();
    for (const o of await DB.all(s)) S[s].set(o.id, o);
  }
}

/** 메모리 상태와 DB를 함께 갱신한다. put/del: { storeName: [...] } */
async function commit(put = {}, del = {}) {
  const ops = [];
  for (const [s, arr] of Object.entries(put)) if (arr && arr.length) { arr.forEach(o => S[s].set(o.id, o)); ops.push({ store: s, put: arr }); }
  for (const [s, ids] of Object.entries(del)) if (ids && ids.length) { ids.forEach(id => S[s].delete(id)); ops.push({ store: s, del: ids }); }
  if (!ops.length) return;
  try { await DB.write(ops); } catch (e) { toast('저장 실패: ' + e.message); throw e; }
}

function requestPersist() {
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* 무시 */ }
}

/* ───────────────────────── 구조 조회 ───────────────────────── */

const domainList = () => [...S.domains.values()].sort(byName);
const catsOf = domId => [...S.categories.values()].filter(c => c.domainId === domId).sort(byName);
const decksOf = catId => [...S.decks.values()].filter(d => d.catId === catId).sort(byName);
const cardsOf = deckId => [...S.cards.values()].filter(c => c.deckId === deckId);

// 범위 문자열: 'all' | 'dom:<id>' | 'cat:<id>' | 'deck:<id>'
// 약점 연습은 앞에 'weak:', 객관식 퀴즈는 'quiz:'를 붙인다
const WEAK = 'weak:', QUIZ = 'quiz:';
const baseScope = scope => scope.replace(/^(weak|quiz):/, '');
function scopeDecks(scope) {
  if (scope !== baseScope(scope)) return scopeDecks(baseScope(scope));
  const [t, id] = scope.split(':');
  if (t === 'deck') return S.decks.has(id) ? [id] : [];
  if (t === 'cat') return decksOf(id).map(d => d.id);
  if (t === 'dom') return catsOf(id).flatMap(c => decksOf(c.id).map(d => d.id));
  return [...S.decks.keys()];
}
function scopeName(scope) {
  if (scope.startsWith(WEAK)) return `💪 약점 · ${scopeName(baseScope(scope))}`;
  if (scope.startsWith(QUIZ)) return `🎯 퀴즈 · ${scopeName(baseScope(scope))}`;
  const [t, id] = scope.split(':');
  if (t === 'deck') return S.decks.get(id)?.name ?? '';
  if (t === 'cat') return S.categories.get(id)?.name ?? '';
  if (t === 'dom') return S.domains.get(id)?.name ?? '';
  return '전체';
}
function catPath(catId) {
  const c = S.categories.get(catId);
  const d = c && S.domains.get(c.domainId);
  return c ? `${d ? d.name : '?'} › ${c.name}` : '';
}

/* ───────────────────────── 간격 반복 스케줄러(Anki SM-2 방식) ───────────────────────── */

/* 시험일 모드: 시험 전까지 새 카드를 모두 한 번 보도록 하루 할당량을 자동 계산하고,
   복습 예정일이 시험일을 넘지 않게 당긴다. */
function examInfo(deck, now = Date.now()) {
  if (!deck || !deck.examDate) return null;
  const [y, m, d] = deck.examDate.split('-').map(Number);
  const days = Math.round((new Date(y, m - 1, d, CFG.rolloverHour).getTime() - startOfDay(now)) / DAY);
  return { days, past: days < 0 };
}
function newLimit(deck) {
  const ex = examInfo(deck);
  if (!ex || ex.past) return deck.newPerDay ?? CFG.newPerDay;
  let left = 0;
  for (const c of S.cards.values()) if (c.deckId === deck.id && c.state === 'new' && !c.suspended) left++;
  const doneToday = deck.newDate === todayKey() ? deck.newCount || 0 : 0;
  // 시험 직전 며칠은 새 카드 없이 복습만 하도록 여유를 둔다
  const buffer = ex.days > 14 ? 3 : ex.days > 5 ? 1 : 0;
  return Math.ceil((left + doneToday) / Math.max(1, ex.days - buffer));
}
function remainingNew(deck) {
  const limit = newLimit(deck);
  return deck.newDate === todayKey() ? Math.max(0, limit - (deck.newCount || 0)) : limit;
}

/** 카드에 평가(1 다시, 2 어려움, 3 보통, 4 쉬움)를 적용한 새 카드 객체를 돌려준다. */
function schedule(c, r, now = Date.now()) {
  const n = { ...c, reps: (c.reps || 0) + 1, last: now };
  const ease = c.ease || CFG.startEase;
  n.ease = ease;
  const ex = examInfo(S.decks.get(c.deckId), now);
  const cap = ex && !ex.past && ex.days >= 1 ? Math.max(1, ex.days - 1) : CFG.maxIvl;
  const toReview = ivl => {
    n.state = 'review';
    n.step = 0;
    n.ivl = Math.min(CFG.maxIvl, Math.max(1, Math.round(ivl)));
    // 간격(ivl)은 그대로 키우되, 시험일 모드에서는 다음 복습일만 시험 전날로 당긴다
    n.due = dueInDays(Math.min(n.ivl, cap), now);
    return n;
  };

  if (c.state !== 'review') {
    const re = c.state === 'relearning';
    const steps = re ? CFG.relearnSteps : CFG.learnSteps;
    const step = c.state === 'new' ? 0 : Math.min(c.step || 0, steps.length - 1);
    const stay = (s, mins) => {
      n.state = re ? 'relearning' : 'learning';
      n.step = s;
      n.due = now + mins * MIN;
      return n;
    };
    if (r === 1) return stay(0, steps[0]);
    if (r === 2) {
      if (step === 0 && steps.length > 1) return stay(0, (steps[0] + steps[1]) / 2);
      return stay(step, steps.length === 1 ? steps[0] * 1.5 : steps[step]);
    }
    if (r === 3) return step + 1 < steps.length ? stay(step + 1, steps[step + 1]) : toReview(re ? (c.ivl || 1) : CFG.gradIvl);
    return toReview(re ? (c.ivl || 1) + 1 : CFG.easyIvl);
  }

  const ivl = c.ivl || 1;
  const late = Math.max(0, Math.round((startOfDay(now) - c.due) / DAY));
  if (r === 1) {
    n.lapses = (c.lapses || 0) + 1;
    n.ease = Math.max(CFG.minEase, ease - 0.2);
    n.ivl = 1;
    n.state = 'relearning';
    n.step = 0;
    n.due = now + CFG.relearnSteps[0] * MIN;
    return n;
  }
  const hard = Math.max(ivl + 1, Math.round(ivl * CFG.hardFactor));
  const good = Math.max(hard + 1, Math.round((ivl + late / 2) * ease));
  const easy = Math.max(good + 1, Math.round((ivl + late) * ease * CFG.easyBonus));
  if (r === 2) { n.ease = Math.max(CFG.minEase, ease - 0.15); return toReview(hard); }
  if (r === 3) return toReview(good);
  n.ease = ease + 0.15;
  return toReview(easy);
}

function nextLabel(c, r, now) {
  const n = schedule(c, r, now);
  return n.state === 'review' ? fmtDays(Math.round((n.due - startOfDay(now)) / DAY)) : fmtWait(n.due - now);
}

/** 암기장별 카운트: n 오늘 볼 새 카드, l 학습 중(오늘), r 오늘 복습, total, susp */
function tally(now = Date.now()) {
  const end = dueInDays(1, now);
  const m = new Map();
  for (const d of S.decks.values()) m.set(d.id, { n: 0, l: 0, r: 0, total: 0, susp: 0, newTotal: 0 });
  for (const c of S.cards.values()) {
    const t = m.get(c.deckId);
    if (!t) continue;
    t.total++;
    if (c.suspended) { t.susp++; continue; }
    if (c.state === 'new') t.newTotal++;
    else if (c.state === 'review') { if (c.due <= now) t.r++; }
    else if (c.due < end) t.l++;
  }
  for (const [id, t] of m) t.n = Math.min(t.newTotal, remainingNew(S.decks.get(id)));
  return m;
}
function sumTally(m, deckIds) {
  const s = { n: 0, l: 0, r: 0, total: 0, newTotal: 0 };
  for (const id of deckIds) { const t = m.get(id); if (t) { s.n += t.n; s.l += t.l; s.r += t.r; s.total += t.total; s.newTotal += t.newTotal; } }
  return s;
}
/** "새 5 · 복습 12" 형태의 남은 양 표시 */
function dueHtml(t) {
  const parts = [];
  if (t.n) parts.push(`새 <b>${t.n}</b>`);
  if (t.l + t.r) parts.push(`복습 <b>${t.l + t.r}</b>`);
  if (!parts.length) return t.total ? '<span class="due done">✓</span>' : '<span class="due">비어 있음</span>';
  return `<span class="due">${parts.join(' · ')}</span>`;
}
/** 한 번이라도 본 카드 비율 막대 */
function seenBar(t) {
  const pct = t.total ? Math.round(((t.total - t.newTotal) / t.total) * 100) : 0;
  return `<span class="bar-mini" title="${pct}% 학습함"><i style="width:${pct}%"></i></span>`;
}

/* 대분류 색 탭 */
const TAB_COLORS = ['#8b7cf6', '#4fbf9f', '#ff9a76', '#5aa9ec', '#ef7fae', '#e2b33c', '#a78bfa', '#56c2d6'];
function domColor(d) {
  if (Number.isInteger(d.color)) return TAB_COLORS[d.color % TAB_COLORS.length];
  let h = 0;
  for (const ch of d.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TAB_COLORS[h % TAB_COLORS.length];
}

/* 연속 학습일 */
function markStudied() {
  const days = store.get('days', []);
  const k = todayKey();
  if (days[days.length - 1] !== k) { days.push(k); store.set('days', days.slice(-400)); }
}
function studyDays() {
  const set = new Set(store.get('days', []));
  const dayAt = offset => {
    const d = new Date(startOfDay());
    d.setDate(d.getDate() - offset);
    return d;
  };
  const keyAt = offset => { const d = dayAt(offset); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
  let streak = 0;
  for (let i = set.has(keyAt(0)) ? 0 : 1; set.has(keyAt(i)); i++) streak++;
  const week = Array.from({ length: 7 }, (_, i) => ({
    on: set.has(keyAt(6 - i)), today: i === 6, label: '일월화수목금토'[dayAt(6 - i).getDay()],
  }));
  return { streak, week, today: set.has(keyAt(0)) };
}

/* ───────────────────────── 모달 ───────────────────────── */

function modal({ title = '', body = '', actions = [], sheet = false }) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'overlay' + (sheet ? ' sheet' : '');
    wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      ${title ? `<h2>${esc(title)}</h2>` : ''}
      <div class="modal-body">${body}</div>
      <div class="modal-actions">${actions.map((a, i) => `<button type="button" class="btn ${a.cls || ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>
    </div>`;
    const close = value => {
      wrap.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve({ value, el: wrap });
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        const p = actions.find(a => a.cls && a.cls.includes('primary'));
        if (p) { e.preventDefault(); close(p.value); }
      }
    };
    wrap.addEventListener('click', e => {
      if (e.target === wrap) return close(null);
      const b = e.target.closest('[data-i]');
      if (b) close(actions[+b.dataset.i].value);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(wrap);
    const f = wrap.querySelector('input:not([type=checkbox]), textarea');
    if (f) { f.focus(); if (f.select) f.select(); }
  });
}
const ui = {
  async alert(title, msg) {
    await modal({ title, body: `<p>${esc(msg)}</p>`, actions: [{ label: '확인', value: true, cls: 'primary' }] });
  },
  async confirm(title, msg, ok = '확인', danger = false) {
    const r = await modal({ title, body: msg ? `<p>${esc(msg)}</p>` : '', actions: [{ label: '취소', value: false }, { label: ok, value: true, cls: danger ? 'primary danger-bg' : 'primary' }] });
    return r.value === true;
  },
  async prompt(title, value = '', { type = 'text', placeholder = '' } = {}) {
    const r = await modal({
      title,
      body: `<input type="${type}" id="m-in" value="${esc(value)}" placeholder="${esc(placeholder)}" ${type === 'number' ? 'inputmode="numeric" min="0"' : ''}>`,
      actions: [{ label: '취소', value: false }, { label: '확인', value: true, cls: 'primary' }],
    });
    if (!r.value) return null;
    const v = r.el.querySelector('#m-in').value.trim();
    return v === '' ? null : v;
  },
  async menu(title, items) {
    const r = await modal({
      title, sheet: true,
      actions: [...items.map(i => ({ label: i.label, value: i.value, cls: i.danger ? 'danger' : '' })), { label: '취소', value: null, cls: 'cancel' }],
    });
    return r.value;
  },
};

/* ───────────────────────── 화면 전환 ───────────────────────── */

const app = $('#app');
let V = { name: 'home' };
let depth = 0;
let waitTimer = null;

function go(name, params = {}, replace = false) {
  V = { name, ...params };
  if (replace) history.replaceState({ v: V, depth }, '');
  else history.pushState({ v: V, depth: ++depth }, '');
  render();
  window.scrollTo(0, 0);
}
function back() {
  if (depth > 0) history.back();
  else go('home', {}, true);
}
window.addEventListener('popstate', e => {
  const st = e.state || { v: { name: 'home' }, depth: 0 };
  V = st.v;
  depth = st.depth || 0;
  if (V.name === 'import' && !imp) V = { name: 'home' };
  render();
});

function render() {
  clearTimeout(waitTimer);
  const views = { home: viewHome, deck: viewDeck, study: viewStudy, browse: viewBrowse, import: viewImport };
  app.className = 'view-' + V.name;
  app.innerHTML = (views[V.name] || viewHome)();
  if (V.name === 'study') bindSwipe();
}

function bar(title, right = '') {
  return `<header class="bar">
    <button class="icon-btn" data-act="back" aria-label="뒤로">‹</button>
    <div class="title">${esc(title)}</div>${right}
  </header>`;
}

/* ───────────────────────── 홈 ───────────────────────── */

let collapsed = new Set(store.get('collapsed', []));
function toggleCollapsed(key) {
  collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key);
  store.set('collapsed', [...collapsed]);
  render();
}

function viewHome() {
  const m = tally();
  const doms = domainList();
  const all = sumTally(m, [...S.decks.keys()]);
  const due = all.n + all.l + all.r;

  let body;
  if (!doms.length) {
    body = `<div class="empty">
      <div style="font-size:56px">📒</div>
      <h2>첫 암기장을 만들어 볼까요?</h2>
      <p>엑셀 파일을 가져와서 앞면·뒷면으로 쓸 컬럼을 고르면<br>암기 카드가 만들어집니다.</p>
      <button class="btn primary" data-act="import">엑셀 가져오기</button>
    </div>`;
  } else {
    const sd = studyDays();
    const h = new Date().getHours();
    const hello = h < 5 ? '늦은 밤이에요 🌙' : h < 12 ? '좋은 아침이에요 ☀️' : h < 18 ? '좋은 오후예요 🌤️' : '좋은 저녁이에요 🌙';
    const week = sd.week.map(d => `<div class="d ${d.on ? 'on' : ''} ${d.today ? 'now' : ''}"><i>${d.on ? '✓' : ''}</i>${d.label}</div>`).join('');
    body = `
      <section class="hero">
        <div class="hello">${hello}</div>
        <div class="hero-title">${due ? `오늘 <b>${due}장</b> 남았어요` : '오늘 분량 끝! 🎉'}</div>
        <div class="week">${week}</div>
        <div class="hero-meta">${sd.streak ? `🔥 ${sd.streak}일 연속 공부 중` : '오늘부터 연속 기록을 시작해 보세요'}</div>
        <div class="hero-actions">
          ${due
            ? `<button class="btn" data-act="study" data-scope="all">▶ 학습 시작</button>`
            : `<div class="done-msg">내일 또 만나요 👋</div>`}
          <button class="btn quiz-btn" data-act="study" data-scope="${QUIZ}all" aria-label="객관식 퀴즈">🎯</button>
        </div>
      </section>
      ${weakHtml('all')}
      ${doms.map(d => domainHtml(d, m)).join('')}`;
  }

  return `<header class="bar">
      <h1>암기장</h1>
      <button class="btn small primary" data-act="import">＋ 가져오기</button>
    </header>
    <main>
      ${body}
      <div class="footer-actions">
        <button class="btn" data-act="add-domain">＋ 대분류 추가</button>
        <div class="row">
          <button class="btn" data-act="backup">백업 내보내기</button>
          <label class="btn file-btn" style="flex:1">백업 복원<input type="file" id="restore-file" accept=".json,application/json"></label>
        </div>
      </div>
      <div class="version muted">암기장 v${APP_VERSION} · 데이터는 이 기기에만 저장됩니다</div>
    </main>`;
}

function domainHtml(d, m) {
  const cats = catsOf(d.id);
  const ids = cats.flatMap(c => decksOf(c.id).map(k => k.id));
  const t = sumTally(m, ids);
  const open = !collapsed.has('d:' + d.id);
  return `<section class="domain ${open ? 'open' : ''}" style="--tab:${domColor(d)}">
    <div class="head" data-act="toggle" data-key="d:${d.id}">
      <span class="name">${esc(d.name)}</span>${dueHtml(t)}<span class="chev">▶</span>
      <button class="icon-btn" data-act="menu-dom" data-id="${d.id}" aria-label="대분류 메뉴">⋯</button>
    </div>
    ${open ? (cats.length ? cats.map(c => catHtml(c, m)).join('') : `<div class="deck-empty muted">소분류가 없습니다. <button class="link" data-act="add-cat" data-id="${d.id}">＋ 소분류 추가</button></div>`) : ''}
  </section>`;
}

function catHtml(c, m) {
  const decks = decksOf(c.id);
  const t = sumTally(m, decks.map(d => d.id));
  const open = !collapsed.has('c:' + c.id);
  return `<div class="cat ${open ? 'open' : ''}">
    <div class="head" data-act="toggle" data-key="c:${c.id}">
      <span class="chev">▶</span><span class="name">${esc(c.name)}</span>${dueHtml(t)}
      <button class="icon-btn" data-act="menu-cat" data-id="${c.id}" aria-label="소분류 메뉴">⋯</button>
    </div>
    ${open ? `<div class="decks">${decks.length
      ? decks.map(d => { const dt = m.get(d.id); return `<button class="deck" data-act="open-deck" data-id="${d.id}"><span class="name">${esc(d.name)}</span>${examChip(d)}${seenBar(dt)}${dueHtml(dt)}</button>`; }).join('')
      : `<div class="deck-empty muted">암기장이 없습니다. <button class="link" data-act="import-here" data-id="${c.id}">엑셀 가져오기</button></div>`}</div>` : ''}
  </div>`;
}

/* ───────────────────────── 암기장 화면 ───────────────────────── */

function viewDeck() {
  const d = S.decks.get(V.id);
  if (!d) { queueMicrotask(() => go('home', {}, true)); return ''; }
  const t = tally().get(d.id);
  const due = t.n + t.l + t.r;
  const src = d.source;
  const dom = S.domains.get(S.categories.get(d.catId)?.domainId);
  const seen = t.total - t.newTotal;
  const ex = examInfo(d);
  const examOn = ex && !ex.past;
  return `${bar('', `<button class="icon-btn" data-act="menu-deck" data-id="${d.id}" aria-label="암기장 메뉴">⋯</button>`)}
  <main style="--tab:${dom ? domColor(dom) : 'var(--accent)'}">
    <div class="path">${esc(catPath(d.catId))}</div>
    <h2 class="deck-title">${esc(d.name)}</h2>
    <div class="progress-line muted">한 번 이상 본 카드 ${seen} / ${t.total}장${seenBar(t)}</div>
    ${examOn ? `<button class="exam-banner" data-act="exam" data-id="${d.id}">
        <span class="dday">${ex.days ? `D-${ex.days}` : 'D-DAY'}</span>
        <span>시험까지 새 카드 <b>${t.newTotal}장</b> 남음 · 하루 <b>${newLimit(d)}장</b>씩 자동 배정</span></button>`
      : ex ? `<button class="exam-banner past" data-act="exam" data-id="${d.id}"><span class="dday">끝</span><span>시험일(${esc(d.examDate)})이 지나 시험일 모드가 꺼졌어요</span></button>` : ''}
    <div class="stat-grid">
      <div class="stat n"><div class="v">${t.n}</div><div class="k">새 카드</div></div>
      <div class="stat l"><div class="v">${t.l}</div><div class="k">학습 중</div></div>
      <div class="stat r"><div class="v">${t.r}</div><div class="k">복습</div></div>
    </div>
    ${due
      ? `<button class="btn primary block reveal-btn" data-act="study" data-scope="deck:${d.id}">학습 시작</button>`
      : `<div class="panel" style="text-align:center">🎉 오늘 이 암기장의 학습을 모두 마쳤습니다.</div>`}
    <div class="row" style="margin:12px 0">
      <button class="btn" data-act="study" data-scope="${QUIZ}deck:${d.id}">🎯 객관식 퀴즈</button>
      <button class="btn" data-act="browse" data-id="${d.id}">카드 목록</button>
    </div>
    <button class="btn block" style="margin-bottom:12px" data-act="import-deck" data-id="${d.id}">엑셀로 카드 추가</button>
    <div style="margin-bottom:18px">${weakHtml('deck:' + d.id)}</div>
    <div class="panel">
      <div class="kv"><span>전체 카드</span><span>${t.total}장</span></div>
      <div class="kv"><span>아직 안 본 카드</span><span>${t.newTotal}장</span></div>
      <div class="kv"><span>일시중지</span><span>${t.susp}장</span></div>
      <div class="kv"><span>하루 새 카드</span><span>${examOn ? `${newLimit(d)}장 (시험일 자동)` : `${d.newPerDay ?? CFG.newPerDay}장`}</span></div>
      <div class="kv"><span>시험일</span><span>${d.examDate ? esc(d.examDate) : '설정 안 함'}</span></div>
      ${src ? `<div class="kv"><span>앞면 / 뒷면</span><span>${esc(src.front.join(', '))} / ${esc(src.back.join(', '))}</span></div>
      <div class="kv"><span>원본</span><span>${esc(src.file)}${src.sheet ? ' · ' + esc(src.sheet) : ''}</span></div>` : ''}
    </div>
  </main>`;
}

/* ───────────────────────── 학습 ───────────────────────── */

let study = null;

function buildQueue(s, now = Date.now()) {
  const ids = new Set(scopeDecks(s.scope));
  const end = dueInDays(1, now);
  const learnNow = [], learnLater = [], rev = [], newByDeck = new Map();
  for (const c of S.cards.values()) {
    if (!ids.has(c.deckId) || c.suspended) continue;
    if (c.state === 'new') {
      if (!newByDeck.has(c.deckId)) newByDeck.set(c.deckId, []);
      newByDeck.get(c.deckId).push(c);
    } else if (c.state === 'review') { if (c.due <= now) rev.push(c); }
    else (c.due <= now ? learnNow : learnLater).push(c);
  }
  const news = [];
  for (const [id, arr] of newByDeck) {
    arr.sort((a, b) => a.order - b.order);
    news.push(...arr.slice(0, remainingNew(S.decks.get(id))));
  }
  news.sort((a, b) => a.order - b.order);
  learnNow.sort((a, b) => a.due - b.due);
  learnLater.sort((a, b) => a.due - b.due);
  rev.sort((a, b) => a.due - b.due);

  const counts = { n: news.length, l: learnNow.length + learnLater.filter(c => c.due < end).length, r: rev.length };
  let next = null, waitUntil = null;
  if (learnNow.length) next = learnNow[0];
  else if (rev.length || news.length) {
    // 새 카드를 복습 카드 사이에 고르게 섞는다
    const every = news.length ? Math.max(1, Math.floor(rev.length / news.length)) : Infinity;
    next = !rev.length || (news.length && s.revSinceNew >= every) ? news[0] : rev[0];
  } else if (learnLater.length) {
    if (learnLater[0].due <= now + CFG.learnAhead) next = learnLater[0];
    else waitUntil = learnLater[0].due;
  }
  return { next, counts, waitUntil };
}

function startStudy(scope) {
  study = { scope, card: null, revealed: false, undo: null, revSinceNew: 0, done: 0, busy: false, q: null };
  if (scope.startsWith(WEAK)) {
    // 약점 연습: 복습 일정은 건드리지 않고, '알았어요'가 나올 때까지 돌려 본다
    study.practice = true;
    study.queue = weakCards(baseScope(scope)).slice(0, WEAK_LIMIT).map(c => c.id);
  } else if (scope.startsWith(QUIZ)) {
    study.quiz = true;
    study.dir = store.get('quizDir', 'fb');
    study.queue = quizQuestions(baseScope(scope), study.dir);
    study.right = 0;
    study.wrong = [];
  }
  pickNext();
}
function pickNext() {
  study.revealed = false;
  if (study.quiz) {
    study.queue = study.queue.filter(id => S.cards.has(id));
    study.card = S.cards.get(study.queue[0]) || null;
    study.picked = null;
    study.options = study.card ? quizOptions(study.card) : [];
    study.q = { counts: { n: 0, l: 0, r: 0 } };
    return;
  }
  if (study.practice) {
    study.queue = study.queue.filter(id => S.cards.has(id) && !S.cards.get(id).suspended);
    study.card = S.cards.get(study.queue[0]) || null;
    study.q = { counts: { n: 0, l: 0, r: 0 } };
    return;
  }
  study.q = buildQueue(study);
  study.card = study.q.next;
}

function fieldsHtml(fields, deck) {
  if (!fields || !fields.length) return '<div class="muted">(비어 있음)</div>';
  const labels = deck.showLabels !== false && fields.length > 1;
  return fields.map(f => `<div class="fld">${labels ? `<div class="flabel">${esc(f.l)}</div>` : ''}<div class="fval">${esc(f.v)}</div></div>`).join('');
}

function viewStudy() {
  if (!study || study.scope !== V.scope) startStudy(V.scope);
  if (study.quiz) return viewQuiz();
  const s = study, c = s.card, q = s.q.counts;
  const right = `${s.practice ? '' : `<button class="icon-btn" data-act="undo" ${s.undo ? '' : 'disabled'} aria-label="되돌리기">↶</button>`}
    ${c ? `<button class="icon-btn" data-act="ask-claude" aria-label="Claude에게 묻기">💬</button>
    <button class="icon-btn" data-act="menu-card" aria-label="카드 메뉴">⋯</button>` : ''}`;
  const head = `${bar(scopeName(s.scope), right)}`;

  if (!c) {
    let msg;
    if (s.q.waitUntil) {
      msg = `<div class="emoji">⏳</div><h2>잠시 후 다시</h2><p class="muted">학습 중인 카드가 ${fmtWait(s.q.waitUntil - Date.now())} 뒤에 다시 나옵니다.</p>`;
      waitTimer = setTimeout(() => { if (V.name === 'study' && study === s) { pickNext(); render(); } }, Math.max(1000, s.q.waitUntil - CFG.learnAhead - Date.now() + 500));
    } else if (s.practice) {
      msg = `<div class="emoji">💪</div><h2>약점 연습 완료</h2><p class="muted">${s.done ? `${s.done}장을 모두 통과했어요.` : '지금은 약점 카드가 없어요.'}</p>`;
    } else {
      msg = `<div class="emoji">🎉</div><h2>오늘 분량 완료</h2><p class="muted">${s.done ? `이번에 ${s.done}장을 학습했습니다.` : '지금 학습할 카드가 없습니다.'}</p>`;
    }
    return `${head}<main><div class="done">${msg}<button class="btn primary" data-act="back">돌아가기</button></div></main>`;
  }

  const deck = S.decks.get(c.deckId);
  const now = Date.now();
  const left = s.practice ? s.queue.length : q.n + q.l + q.r;
  const pct = Math.round((s.done / Math.max(1, s.done + left)) * 100);
  const detail = s.practice ? '약점 연습 · 복습 일정은 그대로' : `새 ${q.n} · 복습 ${q.l + q.r}`;
  const dom = S.domains.get(S.categories.get(deck.catId)?.domainId);
  // 새 카드가 나올 때는 올라오는 애니메이션, 정답을 열 때는 뒤집기 애니메이션
  const enter = s.animId !== c.id;
  const flip = !enter && s.flip;
  s.animId = c.id;
  s.flip = false;
  // 처음 몇 번만 스와이프 사용법을 보여 준다
  let hint = '';
  if (s.revealed) {
    const seen = store.get('swipeHint', 0);
    if (seen < 8) {
      if (flip) store.set('swipeHint', seen + 1);
      hint = `<div class="swipe-hint">${s.practice ? '← 몰랐어요 · 알았어요 →' : '← 다시 · 보통 → · ↑ 쉬움 · ↓ 어려움'} 으로 밀어도 돼요</div>`;
    }
  }
  const buttons = s.practice
    ? `<div class="answer-bar two">
        <button class="ans a1" data-act="ans" data-r="1"><small>한 번 더</small>몰랐어요</button>
        <button class="ans a3" data-act="ans" data-r="3"><small>통과</small>알았어요</button>
      </div>`
    : `<div class="answer-bar">
        ${[['다시', 1], ['어려움', 2], ['보통', 3], ['쉬움', 4]].map(([l, r]) =>
          `<button class="ans a${r}" data-act="ans" data-r="${r}"><small>${nextLabel(c, r, now)}</small>${l}</button>`).join('')}
      </div>`;
  return `${head}
  <main style="--tab:${dom ? domColor(dom) : 'var(--accent)'}">
    <div class="study-progress">
      <span class="bar-mini"><i style="width:${pct}%"></i></span>
      <div class="muted"><span>${left}장 남음</span><span>${detail}</span></div>
    </div>
    <div class="study-card ${enter ? 'enter' : ''} ${flip ? 'flip' : ''}" data-act="reveal">
      <div class="deck-tag">${esc(deck.name)}</div>
      ${tts.ok ? '<button class="speak-btn" data-act="speak" aria-label="읽어 주기">🔊</button>' : ''}
      <div class="swipe-label" aria-hidden="true"></div>
      <div class="inner">
        <div class="front">${fieldsHtml(c.front, deck)}</div>
        ${s.revealed ? `<hr><div class="back">${fieldsHtml(c.back, deck)}</div>` : '<div class="tap-hint">탭하면 정답이 보입니다</div>'}
      </div>
      ${hint}
    </div>
    ${s.revealed ? buttons : `<div class="answer-bar one"><button class="btn primary reveal-btn" data-act="reveal">정답 보기</button></div>`}
  </main>`;
}

async function answer(r) {
  const s = study;
  if (!s || !s.card || !s.revealed || s.busy) return;
  if (s.practice) return answerPractice(r >= 3);
  s.busy = true;
  try {
    const c = s.card, deck = S.decks.get(c.deckId);
    s.undo = { card: { ...c }, deck: { ...deck }, revSinceNew: s.revSinceNew };
    const put = { cards: [schedule(c, r)] };
    if (c.state === 'new') {
      const tk = todayKey();
      put.decks = [{ ...deck, newDate: tk, newCount: (deck.newDate === tk ? deck.newCount || 0 : 0) + 1 }];
      s.revSinceNew = 0;
    } else if (c.state === 'review') s.revSinceNew++;
    s.done++;
    markStudied();
    await commit(put);
    pickNext();
    render();
  } finally { s.busy = false; }
}

async function undo() {
  const s = study;
  if (!s || !s.undo) return;
  const u = s.undo;
  s.undo = null;
  await commit({ cards: [u.card], decks: [u.deck] });
  s.revSinceNew = u.revSinceNew;
  s.done = Math.max(0, s.done - 1);
  s.q = buildQueue(s);
  s.card = S.cards.get(u.card.id);
  s.revealed = false;
  render();
}

function answerPractice(ok) {
  const s = study;
  const id = s.queue.shift();
  if (ok) s.done++;
  else s.queue.splice(Math.min(3, s.queue.length), 0, id); // 몇 장 뒤에 다시 나오게
  markStudied();
  pickNext();
  render();
}

/* ───────────────────────── 객관식 퀴즈 ───────────────────────── */
// 같은 암기장(부족하면 같은 범위)의 다른 카드 답을 오답 보기로 섞은 4지선다. 복습 일정에는 반영하지 않는다.

const QUIZ_SIZE = 20;
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const sideOf = (card, side) => spoken(side === 'front' ? card.front : card.back);
const sideText = (card, side) => sideOf(card, side).map(f => f.v).join(' / ');
const quizSides = dir => (dir === 'bf' ? ['back', 'front'] : ['front', 'back']);

function quizQuestions(scope, dir) {
  const [qs, as] = quizSides(dir);
  const ids = new Set(scopeDecks(scope));
  const pool = [...S.cards.values()].filter(c => ids.has(c.deckId) && !c.suspended && sideText(c, qs) && sideText(c, as));
  return shuffle(pool).slice(0, QUIZ_SIZE).map(c => c.id);
}

function quizOptions(card) {
  const [, as] = quizSides(study.dir);
  const answer = sideText(card, as);
  const scopeIds = new Set(scopeDecks(study.scope));
  const seen = new Set([answer]);
  const wrong = [];
  // 같은 암기장의 보기를 먼저, 모자라면 같은 범위의 다른 암기장에서 채운다
  for (const sameDeck of [true, false]) {
    const cands = shuffle([...S.cards.values()].filter(c =>
      c.id !== card.id && (sameDeck ? c.deckId === card.deckId : c.deckId !== card.deckId && scopeIds.has(c.deckId))));
    for (const c of cands) {
      if (wrong.length >= 3) break;
      const t = sideText(c, as);
      if (t && !seen.has(t)) { seen.add(t); wrong.push(t); }
    }
  }
  return shuffle([{ text: answer, correct: true }, ...wrong.map(text => ({ text, correct: false }))]);
}

function pickQuiz(i) {
  const s = study;
  if (!s || !s.quiz || !s.card || s.picked != null || !s.options[i]) return;
  s.picked = i;
  const ok = s.options[i].correct;
  if (ok) s.right++;
  else s.wrong.push(s.card.id);
  markStudied();
  render();
  if (ok) {
    const id = s.card.id;
    setTimeout(() => { if (study === s && s.card && s.card.id === id && s.picked != null) nextQuiz(); }, 750);
  }
}
function nextQuiz() {
  const s = study;
  if (!s || !s.quiz || s.picked == null) return;
  s.queue.shift();
  s.done++;
  pickNext();
  render();
}
function restartQuiz(onlyWrong) {
  const s = study;
  s.queue = onlyWrong ? shuffle([...new Set(s.wrong)]) : quizQuestions(baseScope(s.scope), s.dir);
  s.right = 0;
  s.done = 0;
  s.wrong = [];
  pickNext();
  render();
}
function toggleQuizDir() {
  study.dir = study.dir === 'fb' ? 'bf' : 'fb';
  store.set('quizDir', study.dir);
  restartQuiz(false);
  toast(study.dir === 'fb' ? '앞면을 보고 뒷면 고르기' : '뒷면을 보고 앞면 고르기');
}

function viewQuiz() {
  const s = study, c = s.card;
  const head = bar(scopeName(s.scope), c ? `<button class="icon-btn" data-act="ask-claude" aria-label="Claude에게 묻기">💬</button>` : '');
  const dirChip = `<button class="dir-chip" data-act="quiz-dir">${s.dir === 'fb' ? '앞면 → 뒷면' : '뒷면 → 앞면'} ⇄</button>`;

  if (!c) {
    const total = s.done;
    const pct = total ? Math.round((s.right / total) * 100) : 0;
    const face = !total ? '🤔' : pct >= 90 ? '🏆' : pct >= 70 ? '🎉' : pct >= 50 ? '💪' : '📚';
    return `${head}<main><div class="done">
      <div class="emoji">${face}</div>
      ${total ? `<h2>${s.right} / ${total} 정답</h2><p class="muted">정답률 ${pct}%${s.wrong.length ? ` · 틀린 문제 ${new Set(s.wrong).size}개` : ''}</p>`
        : '<h2>퀴즈를 만들 카드가 부족해요</h2><p class="muted">앞면과 뒷면이 모두 있는 카드가 필요해요.</p>'}
      <div class="quiz-end">
        ${s.wrong.length ? `<button class="btn primary block" data-act="quiz-again" data-only="wrong">틀린 문제만 다시 풀기</button>` : ''}
        ${total ? `<button class="btn block" data-act="quiz-again">새로 섞어서 풀기</button>` : ''}
        <button class="btn block" data-act="back">돌아가기</button>
      </div>
    </div></main>`;
  }

  const deck = S.decks.get(c.deckId);
  const dom = S.domains.get(S.categories.get(deck.catId)?.domainId);
  const [qs] = quizSides(s.dir);
  const total = s.done + s.queue.length;
  const enter = s.animId !== c.id;
  s.animId = c.id;
  const answered = s.picked != null;
  const opts = s.options.map((o, i) => {
    let cls = '';
    if (answered) cls = o.correct ? 'right' : i === s.picked ? 'wrong' : 'dim';
    return `<button class="opt ${cls}" data-act="quiz-pick" data-i="${i}" ${answered ? 'disabled' : ''}>
      <span class="n">${answered && o.correct ? '✓' : answered && i === s.picked ? '✕' : i + 1}</span><span class="t">${esc(o.text)}</span></button>`;
  }).join('');
  const missed = answered && !s.options[s.picked].correct;
  return `${head}
  <main style="--tab:${dom ? domColor(dom) : 'var(--accent)'}">
    <div class="study-progress">
      <span class="bar-mini"><i style="width:${Math.round((s.done / Math.max(1, total)) * 100)}%"></i></span>
      <div class="muted"><span>${s.done + 1} / ${total} 문제 · 정답 ${s.right}</span>${dirChip}</div>
    </div>
    <div class="study-card quiz-card ${enter ? 'enter' : ''}">
      <div class="deck-tag">${esc(deck.name)}</div>
      <div class="inner"><div class="front">${fieldsHtml(sideOf(c, qs), deck)}</div></div>
    </div>
    <div class="quiz-options ${s.options.length < 4 ? 'few' : ''}">${opts}</div>
    <div class="quiz-foot">${missed ? `<button class="btn primary block" data-act="quiz-next">다음 문제 →</button>` : ''}</div>
  </main>`;
}

/* ───────────────────────── 약점 카드 ───────────────────────── */

const WEAK_LIMIT = 50;
function isWeak(c) {
  if (c.suspended || c.state === 'new') return false;
  const lapses = c.lapses || 0;
  return lapses >= 2 || (lapses >= 1 && (c.ease || CFG.startEase) <= 2.1) || c.state === 'relearning';
}
function weakCards(scope) {
  const ids = new Set(scopeDecks(scope));
  return [...S.cards.values()].filter(c => ids.has(c.deckId) && isWeak(c))
    .sort((a, b) => (b.lapses || 0) - (a.lapses || 0) || (a.ease || CFG.startEase) - (b.ease || CFG.startEase));
}
function weakHtml(scope) {
  const n = Math.min(weakCards(scope).length, WEAK_LIMIT);
  if (!n) return '';
  return `<button class="weak-card" data-act="study" data-scope="${WEAK}${scope}">
    <span class="wi">💪</span>
    <span class="wt"><b>약점 카드 ${n}장</b><small>자주 틀린 카드만 모아 집중 연습 · 복습 일정은 그대로</small></span>
    <span class="go">›</span>
  </button>`;
}

function examChip(deck) {
  const ex = examInfo(deck);
  return ex && !ex.past ? `<span class="exam-chip">${ex.days ? `D-${ex.days}` : 'D-DAY'}</span>` : '';
}

/* ───────────────────────── 스와이프 평가 ───────────────────────── */
// 정답을 연 뒤 카드를 밀어서 평가: ← 다시, → 보통, ↑ 쉬움, ↓ 어려움 (약점 연습은 좌우만)

function bindSwipe() {
  const el = $('.study-card');
  if (!el || !study || !study.card) return;
  const label = el.querySelector('.swipe-label');
  const canVertical = () => !study.practice && el.scrollHeight <= el.clientHeight + 2;
  el.style.touchAction = canVertical() ? 'none' : 'pan-y';
  const MAP = study.practice
    ? { left: [1, '몰랐어요', 'a1'], right: [3, '알았어요', 'a3'] }
    : { left: [1, '다시', 'a1'], right: [3, '보통', 'a3'], up: [4, '쉬움', 'a4'], down: [2, '어려움', 'a2'] };
  const TH = 80;
  let sx = 0, sy = 0, dx = 0, dy = 0, axis = null, pid = null;

  const dirOf = () => axis === 'x' ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
  const reset = () => {
    el.classList.remove('dragging');
    el.style.transform = '';
    label.className = 'swipe-label';
    axis = null;
    pid = null;
  };

  el.addEventListener('pointerdown', e => {
    if (!study.revealed || e.target.closest('button') || e.button > 0) return;
    pid = e.pointerId; sx = e.clientX; sy = e.clientY; dx = dy = 0; axis = null;
  });
  el.addEventListener('pointermove', e => {
    if (e.pointerId !== pid) return;
    dx = e.clientX - sx; dy = e.clientY - sy;
    if (!axis) {
      if (Math.hypot(dx, dy) < 10) return;
      axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : (canVertical() ? 'y' : null);
      if (!axis) { pid = null; return; }       // 세로 스크롤에 양보
      try { el.setPointerCapture(pid); } catch { /* 무시 */ }
      el.classList.add('dragging');
    }
    const tx = axis === 'x' ? dx : 0, ty = axis === 'y' ? dy : 0;
    el.style.transform = `translate(${tx}px, ${ty}px) rotate(${tx / 18}deg)`;
    const m = MAP[dirOf()];
    const dist = Math.abs(axis === 'x' ? dx : dy);
    label.textContent = m ? m[1] : '';
    label.className = `swipe-label ${m ? m[2] : ''}`;
    label.style.opacity = m ? Math.min(1, dist / TH) : 0;
  });
  const end = e => {
    if (e.pointerId !== pid) return;
    if (!axis) { pid = null; return; }
    const m = MAP[dirOf()];
    const dist = Math.abs(axis === 'x' ? dx : dy);
    study.suppressClick = true;
    setTimeout(() => { if (study) study.suppressClick = false; }, 350);
    if (m && dist >= TH) {
      el.classList.remove('dragging');
      el.classList.add('fly');
      const k = 5;
      el.style.transform = `translate(${axis === 'x' ? dx * k : 0}px, ${axis === 'y' ? dy * k : 0}px) rotate(${axis === 'x' ? dx / 6 : 0}deg)`;
      pid = null;
      setTimeout(() => answer(m[0]), 170);
    } else {
      el.classList.remove('dragging');
      reset();
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', e => { if (e.pointerId === pid) reset(); });
}

/* ───────────────────────── 음성 읽기 ───────────────────────── */

const tts = {
  ok: 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
  langOf(text) {
    if (/[가-힣]/.test(text)) return 'ko-KR';
    if (/[぀-ヿ]/.test(text)) return 'ja-JP';
    if (/[一-鿿]/.test(text)) return 'zh-CN';
    return 'en-US';
  },
  voiceFor(lang) {
    const vs = speechSynthesis.getVoices();
    return vs.find(v => v.lang === lang) || vs.find(v => v.lang.replace('_', '-').startsWith(lang.slice(0, 2)));
  },
  speak(text, rate = 1) {
    return new Promise(resolve => {
      if (!this.ok || !text || !text.trim()) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = this.langOf(text);
      const v = this.voiceFor(u.lang);
      if (v) u.voice = v;
      u.rate = rate;
      u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  },
  stop() { if (this.ok) speechSynthesis.cancel(); },
};
const spoken = fields => (fields || []).filter(f => f.l !== MEMO);

async function speakCurrent() {
  const c = study && study.card;
  if (!c) return;
  tts.stop();
  for (const f of spoken(study.revealed ? c.back : c.front)) await tts.speak(f.v);
}

/* ───────────────────────── 시험일 모드 설정 ───────────────────────── */

function isoDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function setExam(deckId) {
  const d = S.decks.get(deckId);
  const r = await modal({
    title: '📅 시험일 모드',
    body: `<p class="muted">시험일까지 모든 카드를 한 번 이상 보도록 <b>하루 새 카드 수를 자동</b>으로 정하고,
      복습 예정일이 <b>시험일을 넘지 않게</b> 당겨 줍니다. 시험 직전 며칠은 새 카드 없이 복습만 해요.</p>
      <label class="field"><span>시험 날짜</span><input type="date" id="m-date" value="${esc(d.examDate || '')}" min="${isoDate(startOfDay() + DAY)}"></label>`,
    actions: [
      ...(d.examDate ? [{ label: '끄기', value: 'clear', cls: 'danger left' }] : []),
      { label: '취소', value: null },
      { label: '저장', value: 'save', cls: 'primary' },
    ],
  });
  if (!r.value) return;
  if (r.value === 'clear') {
    await commit({ decks: [{ ...d, examDate: '' }] });
    toast('시험일 모드를 껐어요');
    return render();
  }
  const date = r.el.querySelector('#m-date').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('날짜를 선택하세요');
  const nd = { ...d, examDate: date };
  const ex = examInfo(nd);
  if (!ex || ex.days < 1) return toast('내일 이후 날짜를 선택하세요');

  // 이미 시험일 뒤로 잡혀 있는 복습 카드는 남은 기간에 고르게 나눠 당겨 온다
  const cap = Math.max(1, ex.days - 1);
  const late = cardsOf(d.id).filter(c => c.state === 'review' && c.due > dueInDays(cap)).sort((a, b) => a.due - b.due);
  const moved = late.map((c, k) => ({ ...c, due: dueInDays(1 + Math.floor((k * cap) / late.length)) }));
  await commit({ decks: [nd], cards: moved });
  toast(`시험까지 D-${ex.days} · 하루 새 카드 ${newLimit(nd)}장${moved.length ? ` · 복습 ${moved.length}장 앞당김` : ''}`);
  render();
}

/* ───────────────────────── 카드 목록 / 편집 ───────────────────────── */

const STATE_LABEL = { new: '새 카드', learning: '학습 중', relearning: '재학습', review: '복습' };
const cardText = c => [...c.front, ...c.back].map(f => f.v).join(' ');
const firstLine = fields => (fields && fields.length ? fields[0].v.split('\n')[0] : '');

function viewBrowse() {
  const d = S.decks.get(V.id);
  if (!d) { queueMicrotask(() => go('home', {}, true)); return ''; }
  return `${bar(d.name, `<button class="btn small" data-act="add-card" data-id="${d.id}">＋ 카드</button>`)}
  <main>
    <div class="search"><input type="search" id="search" placeholder="카드 검색" value="${esc(V.q || '')}"></div>
    <div id="list">${browseList()}</div>
  </main>`;
}

function browseList() {
  const q = (V.q || '').trim().toLowerCase();
  const all = cardsOf(V.id).sort((a, b) => a.order - b.order);
  const hits = q ? all.filter(c => cardText(c).toLowerCase().includes(q)) : all;
  const LIMIT = 300;
  const badge = c => {
    if (c.suspended) return `<span class="badge">일시중지</span>`;
    const label = c.state === 'review' ? fmtDate(c.due) : STATE_LABEL[c.state];
    return `<span class="badge ${c.state}">${esc(label)}</span>`;
  };
  return `<p class="muted">${q ? `${hits.length}장 검색됨 / ` : ''}전체 ${all.length}장</p>`
    + hits.slice(0, LIMIT).map(c => `<button class="card-row" data-act="edit-card" data-id="${c.id}">
        <div class="cf">${esc(firstLine(c.front))}</div>${badge(c)}<div class="cb">${esc(firstLine(c.back)) || '&nbsp;'}</div>
      </button>`).join('')
    + (hits.length > LIMIT ? `<p class="muted">처음 ${LIMIT}장만 표시합니다. 검색으로 범위를 좁혀 보세요.</p>` : '');
}

/** 카드 편집 모달. 결과: 'saved' | 'deleted' | null */
async function editCard(card, isNew = false) {
  const side = (fields, name, fallback) => {
    const list = fields.length ? fields : [{ l: fallback, v: '' }];
    return `<div class="side-label">${name}</div>` + list.map((f, i) =>
      `<label class="field"><span>${esc(f.l)}</span><textarea data-side="${name === '앞면' ? 'front' : 'back'}" data-i="${i}" data-l="${esc(f.l)}">${esc(f.v)}</textarea></label>`).join('');
  };
  const body = side(card.front, '앞면', '앞면') + side(card.back, '뒷면', '뒷면')
    + (isNew ? '' : `<label class="check"><input type="checkbox" id="m-susp" ${card.suspended ? 'checked' : ''}> 일시중지(학습에서 제외)</label>
       <label class="check"><input type="checkbox" id="m-reset"> 학습 기록 초기화(새 카드로)</label>`);
  const actions = isNew
    ? [{ label: '취소', value: null }, { label: '추가', value: 'save', cls: 'primary' }]
    : [{ label: '삭제', value: 'delete', cls: 'danger left' }, { label: '취소', value: null }, { label: '저장', value: 'save', cls: 'primary' }];
  const r = await modal({ title: isNew ? '카드 추가' : '카드 편집', body, actions });
  if (!r.value) return null;

  if (r.value === 'delete') {
    if (!(await ui.confirm('카드 삭제', '이 카드를 삭제할까요?', '삭제', true))) return null;
    await commit({}, { cards: [card.id] });
    return 'deleted';
  }
  const read = s => [...r.el.querySelectorAll(`textarea[data-side="${s}"]`)]
    .map(t => ({ l: t.dataset.l, v: t.value.trim() })).filter(f => f.v);
  const front = read('front'), backF = read('back');
  if (!front.length) { toast('앞면이 비어 있어 저장하지 않았습니다'); return null; }
  let n = { ...card, front, back: backF };
  if (!isNew) {
    n.suspended = r.el.querySelector('#m-susp').checked;
    if (r.el.querySelector('#m-reset').checked) n = resetCard(n);
  }
  await commit({ cards: [n] });
  return 'saved';
}

const MEMO = '메모';

/** 뒷면의 '메모' 필드를 추가·수정한다. Claude 답변을 붙여 넣는 용도. */
async function editMemo(card) {
  const cur = card.back.find(f => f.l === MEMO);
  const r = await modal({
    title: '메모',
    body: `<textarea id="m-memo" style="min-height:160px" placeholder="Claude 답변이나 암기 요령을 붙여 넣으세요">${esc(cur ? cur.v : '')}</textarea>
      <p class="muted" style="margin-top:6px">메모는 정답 아래에 함께 표시됩니다.</p>`,
    actions: [{ label: '취소', value: null }, { label: '저장', value: 'save', cls: 'primary' }],
  });
  if (!r.value) return false;
  const v = r.el.querySelector('#m-memo').value.trim();
  const back = card.back.filter(f => f.l !== MEMO);
  if (v) back.push({ l: MEMO, v });
  await commit({ cards: [{ ...card, back }] });
  toast(v ? '메모를 저장했습니다' : '메모를 지웠습니다');
  return true;
}

/* ───────────────────────── Claude에게 묻기 ───────────────────────── */
// 사용 중인 Claude 계정(구독)을 그대로 쓰도록, 카드 내용을 담은 질문으로 claude.ai를 연다.
// claude.ai는 다른 사이트 안에 넣을 수 없어(X-Frame-Options) PC에서는 화면 오른쪽에 별도 창으로 띄운다.

const ASK_PRESETS = [
  ['더 자세히 설명해 줘', '이 카드 내용을 더 자세히, 이해하기 쉽게 설명해 줘.'],
  ['예시를 들어 줘', '이 내용을 이해하는 데 도움이 되는 구체적인 예시를 들어 줘.'],
  ['헷갈리는 것과 비교해 줘', '이 내용과 헷갈리기 쉬운 개념을 짚고 차이를 비교해 줘.'],
  ['외우는 요령 알려 줘', '이 내용을 오래 기억할 수 있는 암기 요령을 알려 줘.'],
  ['웹에서 확인해 줘', '웹 검색으로 이 내용이 정확한지, 최신 정보는 무엇인지 확인하고 출처와 함께 알려 줘.'],
];

function cardPrompt(card, question) {
  const deck = S.decks.get(card.deckId);
  const side = fields => fields.map(f => (fields.length > 1 ? `${f.l}: ${f.v}` : f.v)).join('\n');
  return `암기 공부 중인 카드에 대해 질문할게요. 한국어로 답해 주세요.

[암기장] ${deck ? `${catPath(deck.catId)} › ${deck.name}` : ''}
[앞면]
${side(card.front)}
[뒷면]
${side(card.back) || '(비어 있음)'}

질문: ${question}`;
}

async function askClaude(card) {
  const items = ASK_PRESETS.map(([label, q]) => ({ label, value: q }));
  let q = await ui.menu('Claude에게 묻기', [...items, { label: '직접 입력…', value: '__custom' }]);
  if (!q) return;
  if (q === '__custom') {
    const r = await modal({
      title: 'Claude에게 묻기',
      body: '<textarea id="m-q" placeholder="궁금한 내용을 입력하세요"></textarea>',
      actions: [{ label: '취소', value: null }, { label: '묻기', value: 'ok', cls: 'primary' }],
    });
    q = r.value && r.el.querySelector('#m-q').value.trim();
    if (!q) return;
  }
  openClaude(cardPrompt(card, q));
}

function openClaude(prompt) {
  // 미리 채우기가 동작하지 않는 환경을 대비해 질문을 클립보드에도 복사해 둔다.
  try { navigator.clipboard && navigator.clipboard.writeText(prompt).catch(() => {}); } catch { /* 무시 */ }
  const url = 'https://claude.ai/new?q=' + encodeURIComponent(prompt);
  const wide = window.matchMedia('(min-width: 900px) and (pointer: fine)').matches;
  let w = null;
  if (wide) {
    // 화면 오른쪽 절반에 'claude' 창을 띄우고, 다음 질문도 같은 창에서 연다.
    const sw = screen.availWidth, sh = screen.availHeight;
    const width = Math.max(480, Math.floor(sw / 2)), left = (screen.availLeft || 0) + sw - width, top = screen.availTop || 0;
    w = window.open(url, 'claude', `popup,left=${left},top=${top},width=${width},height=${sh}`);
  } else {
    w = window.open(url, '_blank');
  }
  if (w) { try { w.focus(); } catch { /* 무시 */ } toast('Claude를 열었습니다. 질문 내용은 클립보드에도 복사해 두었습니다'); }
  else toast('팝업이 차단되었습니다. 질문 내용을 클립보드에 복사했으니 Claude에 붙여 넣으세요');
}

function resetCard(c) {
  return { ...c, state: 'new', step: 0, due: 0, ivl: 0, ease: CFG.startEase, reps: 0, lapses: 0, last: undefined };
}

/* ───────────────────────── 엑셀 가져오기 ───────────────────────── */

let imp = null;
const NEW = '__new';

function startImport(dest = {}) {
  imp = { header: true, reverse: false, front: new Set([0]), back: new Set([1]), domainId: null, catId: null, deckId: NEW, ...dest };
  if (!imp.domainId) imp.domainId = domainList()[0]?.id || NEW;
  if (!imp.catId) imp.catId = imp.domainId === NEW ? NEW : (catsOf(imp.domainId)[0]?.id || NEW);
  go('import');
}

async function loadFile(file) {
  try {
    let wb;
    if (/\.(csv|txt|tsv)$/i.test(file.name)) {
      const buf = new Uint8Array(await file.arrayBuffer());
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('euc-kr').decode(buf); }
      wb = XLSX.read(text, { type: 'string' });
    } else {
      wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    }
    if (!wb.SheetNames.length) throw new Error('시트가 없습니다');
    imp.wb = wb;
    imp.fileName = file.name;
    imp.sheet = wb.SheetNames[0];
    loadSheet(true);
    render();
  } catch (e) {
    ui.alert('파일을 읽을 수 없습니다', e.message || String(e));
  }
}

function loadSheet(resetName) {
  const ws = imp.wb.Sheets[imp.sheet];
  imp.raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false });
  applyHeader();
  if (resetName || !imp.deckNameEdited) {
    const base = imp.fileName.replace(/\.[^.]+$/, '');
    imp.deckName = imp.wb.SheetNames.length > 1 ? `${base} - ${imp.sheet}` : base;
  }
}

function applyHeader() {
  const ncol = imp.raw.reduce((m, r) => Math.max(m, r.length), 0);
  const head = imp.header ? (imp.raw[0] || []) : [];
  imp.cols = Array.from({ length: ncol }, (_, i) => String(head[i] ?? '').trim() || `${XLSX.utils.encode_col(i)}열`);
  imp.rows = (imp.header ? imp.raw.slice(1) : imp.raw).filter(r => r.some(v => String(v).trim()));
  for (const k of ['front', 'back']) imp[k] = new Set([...imp[k]].filter(i => i < ncol));
}

const cell = (row, i) => String(row[i] ?? '').trim();
function rowFields(row, idxs) {
  return idxs.map(i => ({ l: imp.cols[i], v: cell(row, i) })).filter(f => f.v);
}
const keyOf = fields => fields.map(f => f.v).join('␟');

function viewImport() {
  if (!imp) { queueMicrotask(() => go('home', {}, true)); return ''; }
  const hasFile = !!imp.rows;
  const letters = i => XLSX.utils.encode_col(i);

  let fileSec = `<section class="panel">
    <h3>1. 파일 선택</h3>
    <label class="btn file-btn ${hasFile ? '' : 'primary'}">${hasFile ? '다른 파일 선택' : '엑셀 / CSV 파일 선택'}
      <input type="file" id="imp-file" accept=".xlsx,.xls,.xlsm,.ods,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv">
    </label>`;
  if (hasFile) {
    const preview = imp.rows.slice(0, 5);
    fileSec += `<p class="muted" style="margin:10px 0">${esc(imp.fileName)} · 데이터 ${imp.rows.length}행 · 컬럼 ${imp.cols.length}개</p>
      ${imp.wb.SheetNames.length > 1 ? `<label class="field"><span>시트</span><select id="imp-sheet">${imp.wb.SheetNames.map(n => `<option ${n === imp.sheet ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>` : ''}
      <label class="check"><input type="checkbox" id="imp-header" ${imp.header ? 'checked' : ''}> 첫 행은 제목(컬럼명)입니다</label>
      <div class="table-wrap"><table>
        <tr>${imp.cols.map((c, i) => `<th><small>${letters(i)}</small>${esc(c)}</th>`).join('')}</tr>
        ${preview.map(r => `<tr>${imp.cols.map((_, i) => `<td>${esc(cell(r, i))}</td>`).join('')}</tr>`).join('')}
      </table></div>`;
  }
  fileSec += `</section>`;
  if (!hasFile) {
    return `${bar('엑셀 가져오기')}<main>${fileSec}
      <div class="panel muted">
        첫 행에 컬럼 이름이 있고 한 행이 카드 한 장이 되는 표 형식이면 됩니다.<br>
        예) <b>단어 | 뜻 | 예문</b> → 앞면: 단어, 뒷면: 뜻 + 예문
      </div></main>`;
  }

  const chips = side => `<div class="chips">${imp.cols.map((c, i) =>
    `<button class="chip ${imp[side].has(i) ? 'on' : ''}" data-act="imp-col" data-side="${side}" data-i="${i}">${esc(c)}</button>`).join('')}</div>`;
  const front = [...imp.front].sort((a, b) => a - b), back = [...imp.back].sort((a, b) => a - b);
  const sample = imp.rows.find(r => rowFields(r, front).length) || [];
  const pDeck = { showLabels: true };
  const colSec = `<section class="panel">
    <h3>2. 컬럼 선택</h3>
    <div class="side-label">앞면(질문) — 여러 개 선택 가능</div>${chips('front')}
    <div class="side-label">뒷면(정답) — 여러 개 선택 가능</div>${chips('back')}
    <label class="check"><input type="checkbox" id="imp-reverse" ${imp.reverse ? 'checked' : ''}> 앞뒤를 바꾼 카드도 함께 만들기</label>
    <div class="side-label" style="margin-top:12px">미리보기</div>
    <div class="preview-card">
      <div class="front">${fieldsHtml(rowFields(sample, front), pDeck)}</div><hr>
      <div class="back">${fieldsHtml(rowFields(sample, back), pDeck)}</div>
    </div>
  </section>`;

  const doms = domainList();
  const cats = imp.domainId === NEW ? [] : catsOf(imp.domainId);
  const decks = imp.catId === NEW ? [] : decksOf(imp.catId);
  const opt = (v, label, sel) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(label)}</option>`;
  const destSec = `<section class="panel">
    <h3>3. 저장 위치</h3>
    <label class="field"><span>대분류</span>
      <select id="imp-dom">${doms.map(d => opt(d.id, d.name, imp.domainId)).join('')}${opt(NEW, '＋ 새 대분류 만들기', imp.domainId)}</select>
      ${imp.domainId === NEW ? `<input type="text" class="sub-input" id="imp-dom-name" placeholder="새 대분류 이름 (예: 어학)" value="${esc(imp.domName || '')}">` : ''}
    </label>
    <label class="field"><span>소분류</span>
      <select id="imp-cat">${cats.map(c => opt(c.id, c.name, imp.catId)).join('')}${opt(NEW, '＋ 새 소분류 만들기', imp.catId)}</select>
      ${imp.catId === NEW ? `<input type="text" class="sub-input" id="imp-cat-name" placeholder="새 소분류 이름 (예: 영어 단어)" value="${esc(imp.catName || '')}">` : ''}
    </label>
    <label class="field"><span>암기장</span>
      <select id="imp-deck">${opt(NEW, '＋ 새 암기장 만들기', imp.deckId)}${decks.map(d => opt(d.id, `${d.name} (기존에 추가)`, imp.deckId)).join('')}</select>
      ${imp.deckId === NEW ? `<input type="text" class="sub-input" id="imp-deck-name" placeholder="암기장 이름" value="${esc(imp.deckName || '')}">`
        : `<p class="muted" style="margin:6px 0 0">앞면이 같은 카드는 학습 기록을 유지한 채 뒷면만 갱신하고, 새 행만 추가합니다.</p>`}
    </label>
  </section>`;

  return `${bar('엑셀 가져오기')}<main>${fileSec}${colSec}${destSec}
    <button class="btn primary block reveal-btn" data-act="imp-run">카드 만들기</button></main>`;
}

async function runImport() {
  const front = [...imp.front].sort((a, b) => a - b), back = [...imp.back].sort((a, b) => a - b);
  if (!front.length) return toast('앞면 컬럼을 하나 이상 선택하세요');
  if (!back.length) return toast('뒷면 컬럼을 하나 이상 선택하세요');

  const now = Date.now();
  const put = { domains: [], categories: [], decks: [], cards: [] };
  let dom, cat, deck;
  if (imp.domainId === NEW) {
    const name = (imp.domName || '').trim();
    if (!name) return toast('새 대분류 이름을 입력하세요');
    dom = { id: uid(), name, created: now };
    put.domains.push(dom);
  } else dom = S.domains.get(imp.domainId);
  if (imp.catId === NEW) {
    const name = (imp.catName || '').trim();
    if (!name) return toast('새 소분류 이름을 입력하세요');
    cat = { id: uid(), domainId: dom.id, name, created: now };
    put.categories.push(cat);
  } else cat = S.categories.get(imp.catId);
  const source = { file: imp.fileName, sheet: imp.wb.SheetNames.length > 1 ? imp.sheet : '', front: front.map(i => imp.cols[i]), back: back.map(i => imp.cols[i]) };
  if (imp.deckId === NEW) {
    const name = (imp.deckName || '').trim();
    if (!name) return toast('암기장 이름을 입력하세요');
    deck = { id: uid(), catId: cat.id, name, newPerDay: CFG.newPerDay, showLabels: true, newDate: '', newCount: 0, created: now, source };
  } else deck = { ...S.decks.get(imp.deckId), source };
  put.decks.push(deck);

  const existing = new Map(cardsOf(deck.id).map(c => [c.key, c]));
  let order = cardsOf(deck.id).reduce((m, c) => Math.max(m, c.order + 1), 0);
  let added = 0, updated = 0, same = 0, empty = 0;
  const changed = new Map();
  const add = (f, b, key) => {
    const ex = existing.get(key);
    if (ex) {
      if (JSON.stringify(ex.back) !== JSON.stringify(b) || JSON.stringify(ex.front) !== JSON.stringify(f)) {
        const u = { ...ex, front: f, back: b };
        existing.set(key, u);
        if (!changed.has(u.id)) updated++;
        changed.set(u.id, u);
      } else same++;
      return;
    }
    const c = { id: uid(), deckId: deck.id, front: f, back: b, key, order: order++, state: 'new', step: 0, due: 0, ivl: 0, ease: CFG.startEase, reps: 0, lapses: 0, created: now };
    existing.set(key, c);
    changed.set(c.id, c);
    added++;
  };
  for (const row of imp.rows) {
    const f = rowFields(row, front), b = rowFields(row, back);
    if (!f.length) { empty++; continue; }
    add(f, b, keyOf(f));
    if (imp.reverse && b.length) add(b, f, 'R␞' + keyOf(b));
  }
  put.cards = [...changed.values()];

  await commit(put);
  requestPersist();
  imp = null;
  const lines = [`새 카드 ${added}장을 추가했습니다.`];
  if (updated) lines.push(`기존 카드 ${updated}장의 내용을 갱신했습니다.`);
  if (same) lines.push(`변경 없는 카드 ${same}장은 그대로 두었습니다.`);
  if (empty) lines.push(`앞면이 빈 ${empty}행은 건너뛰었습니다.`);
  go('deck', { id: deck.id }, true);
  ui.alert('가져오기 완료', lines.join('\n'));
}

/* ───────────────────────── 메뉴 동작 ───────────────────────── */

function countUnder(deckIds) {
  const set = new Set(deckIds);
  let n = 0;
  for (const c of S.cards.values()) if (set.has(c.deckId)) n++;
  return n;
}
function cardIdsIn(deckIds) {
  const set = new Set(deckIds);
  return [...S.cards.values()].filter(c => set.has(c.deckId)).map(c => c.id);
}

async function addDomain() {
  const name = await ui.prompt('새 대분류', '', { placeholder: '예: 어학, 자격증, 전공' });
  if (!name) return;
  await commit({ domains: [{ id: uid(), name, created: Date.now() }] });
  render();
}
async function addCat(domainId) {
  const name = await ui.prompt('새 소분류', '', { placeholder: '예: 영어 단어' });
  if (!name) return;
  collapsed.delete('d:' + domainId);
  store.set('collapsed', [...collapsed]);
  await commit({ categories: [{ id: uid(), domainId, name, created: Date.now() }] });
  render();
}

async function menuDomain(id) {
  const d = S.domains.get(id);
  const a = await ui.menu(d.name, [
    { label: '소분류 추가', value: 'add' },
    { label: '이 대분류 전체 학습', value: 'study' },
    { label: '💪 약점 카드 연습', value: 'weak' },
    { label: '🎯 객관식 퀴즈', value: 'quiz' },
    { label: '이름 변경', value: 'rename' },
    { label: '색상 바꾸기', value: 'color' },
    { label: '삭제', value: 'delete', danger: true },
  ]);
  if (a === 'add') return addCat(id);
  if (a === 'weak') { study = null; return go('study', { scope: WEAK + 'dom:' + id }); }
  if (a === 'quiz') { study = null; return go('study', { scope: QUIZ + 'dom:' + id }); }
  if (a === 'color') {
    const r = await modal({
      title: '색상 바꾸기',
      body: `<div class="chips">${TAB_COLORS.map((c, i) =>
        `<button type="button" class="chip swatch ${domColor(d) === c ? 'on' : ''}" data-i="${i}" style="--sw:${c}" aria-label="색상 ${i + 1}"></button>`).join('')}</div>`,
      actions: TAB_COLORS.map((_, i) => ({ label: '', value: i, cls: 'hidden' })).concat([{ label: '닫기', value: null }]),
    });
    if (Number.isInteger(r.value)) { await commit({ domains: [{ ...d, color: r.value }] }); render(); }
    return;
  }
  if (a === 'study') return go('study', { scope: 'dom:' + id });
  if (a === 'rename') {
    const name = await ui.prompt('대분류 이름 변경', d.name);
    if (name) { await commit({ domains: [{ ...d, name }] }); render(); }
  }
  if (a === 'delete') {
    const cats = catsOf(id).map(c => c.id);
    const decks = scopeDecks('dom:' + id);
    const n = countUnder(decks);
    if (!(await ui.confirm(`'${d.name}' 삭제`, `소분류 ${cats.length}개, 암기장 ${decks.length}개, 카드 ${n}장이 함께 삭제됩니다.\n되돌릴 수 없습니다.`, '삭제', true))) return;
    await commit({}, { domains: [id], categories: cats, decks, cards: cardIdsIn(decks) });
    render();
  }
}

async function menuCat(id) {
  const c = S.categories.get(id);
  const a = await ui.menu(c.name, [
    { label: '여기로 엑셀 가져오기', value: 'import' },
    { label: '이 소분류 전체 학습', value: 'study' },
    { label: '💪 약점 카드 연습', value: 'weak' },
    { label: '🎯 객관식 퀴즈', value: 'quiz' },
    { label: '이름 변경', value: 'rename' },
    { label: '다른 대분류로 이동', value: 'move' },
    { label: '삭제', value: 'delete', danger: true },
  ]);
  if (a === 'import') return startImport({ domainId: c.domainId, catId: id });
  if (a === 'study') return go('study', { scope: 'cat:' + id });
  if (a === 'weak') { study = null; return go('study', { scope: WEAK + 'cat:' + id }); }
  if (a === 'quiz') { study = null; return go('study', { scope: QUIZ + 'cat:' + id }); }
  if (a === 'rename') {
    const name = await ui.prompt('소분류 이름 변경', c.name);
    if (name) { await commit({ categories: [{ ...c, name }] }); render(); }
  }
  if (a === 'move') {
    const others = domainList().filter(d => d.id !== c.domainId);
    if (!others.length) return toast('옮길 수 있는 다른 대분류가 없습니다');
    const to = await ui.menu('어느 대분류로 옮길까요?', others.map(d => ({ label: d.name, value: d.id })));
    if (to) { await commit({ categories: [{ ...c, domainId: to }] }); render(); }
  }
  if (a === 'delete') {
    const decks = decksOf(id).map(d => d.id);
    if (!(await ui.confirm(`'${c.name}' 삭제`, `암기장 ${decks.length}개, 카드 ${countUnder(decks)}장이 함께 삭제됩니다.\n되돌릴 수 없습니다.`, '삭제', true))) return;
    await commit({}, { categories: [id], decks, cards: cardIdsIn(decks) });
    render();
  }
}

async function menuDeck(id) {
  const d = S.decks.get(id);
  const labels = d.showLabels !== false;
  const a = await ui.menu(d.name, [
    { label: `📅 시험일 모드 ${d.examDate ? `(${d.examDate})` : '설정'}`, value: 'exam' },
    { label: '이름 변경', value: 'rename' },
    { label: `하루 새 카드 수 (현재 ${d.newPerDay ?? CFG.newPerDay}장)`, value: 'limit' },
    { label: labels ? '카드에 컬럼명 숨기기' : '카드에 컬럼명 표시하기', value: 'labels' },
    { label: '다른 소분류로 이동', value: 'move' },
    { label: '학습 기록 초기화', value: 'reset', danger: true },
    { label: '암기장 삭제', value: 'delete', danger: true },
  ]);
  if (a === 'exam') return setExam(id);
  if (a === 'rename') {
    const name = await ui.prompt('암기장 이름 변경', d.name);
    if (name) { await commit({ decks: [{ ...d, name }] }); render(); }
  }
  if (a === 'limit') {
    const v = await ui.prompt('하루에 새로 볼 카드 수', String(d.newPerDay ?? CFG.newPerDay), { type: 'number' });
    const n = Math.floor(Number(v));
    if (v != null && Number.isFinite(n) && n >= 0) { await commit({ decks: [{ ...d, newPerDay: n }] }); render(); }
  }
  if (a === 'labels') { await commit({ decks: [{ ...d, showLabels: !labels }] }); render(); }
  if (a === 'move') {
    const targets = domainList().flatMap(dm => catsOf(dm.id).map(c => ({ label: `${dm.name} › ${c.name}`, value: c.id }))).filter(t => t.value !== d.catId);
    if (!targets.length) return toast('옮길 수 있는 다른 소분류가 없습니다');
    const to = await ui.menu('어느 소분류로 옮길까요?', targets);
    if (to) { await commit({ decks: [{ ...d, catId: to }] }); render(); }
  }
  if (a === 'reset') {
    if (!(await ui.confirm('학습 기록 초기화', '모든 카드가 새 카드 상태로 돌아갑니다.', '초기화', true))) return;
    await commit({ cards: cardsOf(id).map(resetCard), decks: [{ ...d, newDate: '', newCount: 0 }] });
    render();
  }
  if (a === 'delete') {
    if (!(await ui.confirm(`'${d.name}' 삭제`, `카드 ${countUnder([id])}장이 함께 삭제됩니다.\n되돌릴 수 없습니다.`, '삭제', true))) return;
    await commit({}, { decks: [id], cards: cardIdsIn([id]) });
    back();
  }
}

async function menuCard() {
  const c = study && study.card;
  if (!c) return;
  const a = await ui.menu('현재 카드', [
    { label: 'Claude에게 묻기', value: 'ask' },
    { label: '메모 추가 / 수정', value: 'memo' },
    { label: '편집', value: 'edit' },
    { label: '일시중지 (학습에서 제외)', value: 'suspend' },
  ]);
  if (a === 'ask') return askClaude(c);
  if (a === 'memo') {
    if (await editMemo(c)) { study.card = S.cards.get(c.id); render(); }
    return;
  }
  if (a === 'edit') {
    const r = await editCard(c);
    if (r === 'deleted') pickNext();
    else if (r === 'saved') {
      const n = S.cards.get(c.id);
      if (n.suspended || n.state !== c.state) pickNext(); else study.card = n;
    }
    render();
  }
  if (a === 'suspend') {
    await commit({ cards: [{ ...c, suspended: true }] });
    study.undo = null;
    pickNext();
    render();
    toast('일시중지했습니다. 카드 목록에서 해제할 수 있습니다');
  }
}

/* ───────────────────────── 백업 ───────────────────────── */

function backup() {
  const data = { app: 'flashcards', version: 1, exportedAt: new Date().toISOString() };
  for (const s of STORES) data[s] = [...S[s].values()];
  const d = new Date();
  const name = `암기장-백업-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: name }).catch(e => { if (e.name !== 'AbortError') toast('공유 실패: ' + e.message); });
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function restore(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return ui.alert('복원 실패', 'JSON 파일을 읽을 수 없습니다.'); }
  if (!data || data.app !== 'flashcards' || !STORES.every(s => Array.isArray(data[s]))) return ui.alert('복원 실패', '암기장 백업 파일이 아닙니다.');
  const ok = await ui.confirm('백업 복원',
    `${data.exportedAt ? fmtDate(Date.parse(data.exportedAt)) + ' 백업 · ' : ''}대분류 ${data.domains.length}개, 암기장 ${data.decks.length}개, 카드 ${data.cards.length}장\n\n현재 데이터는 모두 이 백업으로 교체됩니다.`, '복원', true);
  if (!ok) return;
  await DB.write(STORES.map(s => ({ store: s, clear: true, put: data[s] })));
  await loadAll();
  requestPersist();
  study = null;
  go('home', {}, true);
  toast('복원했습니다');
}

/* ───────────────────────── 이벤트 ───────────────────────── */

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.closest('.overlay') || el.disabled) return;
  if (study && study.suppressClick && el.closest('.study-card')) return; // 스와이프 직후의 클릭 무시
  const act = el.dataset.act, id = el.dataset.id;
  switch (act) {
    case 'speak': return speakCurrent();
    case 'exam': return setExam(id);
    case 'back': return back();
    case 'toggle': return toggleCollapsed(el.dataset.key);
    case 'import': return startImport();
    case 'import-here': return startImport({ domainId: S.categories.get(id).domainId, catId: id });
    case 'import-deck': {
      const d = S.decks.get(id);
      return startImport({ domainId: S.categories.get(d.catId).domainId, catId: d.catId, deckId: id });
    }
    case 'add-domain': return addDomain();
    case 'add-cat': return addCat(id);
    case 'menu-dom': return menuDomain(id);
    case 'menu-cat': return menuCat(id);
    case 'menu-deck': return menuDeck(id);
    case 'menu-card': return menuCard();
    case 'open-deck': return go('deck', { id });
    case 'browse': return go('browse', { id });
    case 'study': study = null; return go('study', { scope: el.dataset.scope });
    case 'quiz-pick': return pickQuiz(+el.dataset.i);
    case 'quiz-next': return nextQuiz();
    case 'quiz-dir': return toggleQuizDir();
    case 'quiz-again': return restartQuiz(el.dataset.only === 'wrong');
    case 'reveal':
      if (study && study.card && !study.quiz && !study.revealed) { study.revealed = true; study.flip = true; render(); }
      return;
    case 'ans': return answer(+el.dataset.r);
    case 'undo': return undo();
    case 'ask-claude': return study && study.card && askClaude(study.card);
    case 'backup': return backup();
    case 'edit-card': {
      const r = await editCard(S.cards.get(id));
      if (r) $('#list').innerHTML = browseList();
      return;
    }
    case 'add-card': {
      const d = S.decks.get(id);
      const order = cardsOf(id).reduce((m, c) => Math.max(m, c.order + 1), 0);
      const fl = d.source ? d.source.front : ['앞면'], bl = d.source ? d.source.back : ['뒷면'];
      const blank = { id: uid(), deckId: id, key: 'M␞' + uid(), order, state: 'new', step: 0, due: 0, ivl: 0, ease: CFG.startEase, reps: 0, lapses: 0, created: Date.now(),
        front: fl.map(l => ({ l, v: '' })), back: bl.map(l => ({ l, v: '' })) };
      if (await editCard(blank, true)) $('#list').innerHTML = browseList();
      return;
    }
    case 'imp-col': {
      const set = imp[el.dataset.side], i = +el.dataset.i;
      set.has(i) ? set.delete(i) : set.add(i);
      return render();
    }
    case 'imp-run': return runImport();
  }
});

document.addEventListener('change', e => {
  const t = e.target;
  switch (t.id) {
    case 'imp-file': if (t.files[0]) loadFile(t.files[0]); t.value = ''; return;
    case 'imp-sheet': imp.sheet = t.value; loadSheet(false); return render();
    case 'imp-header': imp.header = t.checked; applyHeader(); return render();
    case 'imp-reverse': imp.reverse = t.checked; return;
    case 'imp-dom':
      imp.domainId = t.value;
      imp.catId = t.value === NEW ? NEW : (catsOf(t.value)[0]?.id || NEW);
      imp.deckId = NEW;
      return render();
    case 'imp-cat': imp.catId = t.value; imp.deckId = NEW; return render();
    case 'imp-deck': imp.deckId = t.value; return render();
    case 'restore-file': if (t.files[0]) restore(t.files[0]); t.value = ''; return;
  }
});

document.addEventListener('input', e => {
  const t = e.target;
  switch (t.id) {
    case 'imp-dom-name': imp.domName = t.value; return;
    case 'imp-cat-name': imp.catName = t.value; return;
    case 'imp-deck-name': imp.deckName = t.value; imp.deckNameEdited = true; return;
    case 'search':
      V.q = t.value;
      history.replaceState({ v: V, depth }, '');
      $('#list').innerHTML = browseList();
      return;
  }
});

// 데스크톱 단축키: Space/Enter 정답 보기·보통, 1~4 평가, Z 되돌리기
document.addEventListener('keydown', e => {
  if (V.name !== 'study' || !study || $('.overlay') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (study.quiz) {
    if (study.picked == null && /^[1-4]$/.test(e.key)) pickQuiz(+e.key - 1);
    else if (study.picked != null && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); nextQuiz(); }
    return;
  }
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    if (!study.card) return;
    if (!study.revealed) { study.revealed = true; study.flip = true; render(); } else answer(3);
  } else if (/^[1-4]$/.test(e.key) && study.revealed) answer(+e.key);
  else if (e.key === 'z' || e.key === 'Z') undo();
});

// 앱이 다시 보일 때 날짜가 바뀌었거나 학습 카드 시간이 됐을 수 있으니 갱신
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if ($('.overlay')) return;
  if (V.name === 'study' && study && !study.card) pickNext();
  if (V.name !== 'import' && V.name !== 'browse') render();
});

/* ───────────────────────── 시작 ───────────────────────── */

(async function init() {
  try {
    await DB.open();
    await loadAll();
  } catch (e) {
    app.innerHTML = `<main><div class="empty"><h2>저장소를 열 수 없습니다</h2><p>${esc(e.message || e)}</p><p>사파리 개인정보 보호 브라우징에서는 동작하지 않을 수 있습니다.</p></div></main>`;
    return;
  }
  history.replaceState({ v: V, depth: 0 }, '');
  render();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => { /* 오프라인 기능만 비활성 */ });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('새 버전이 준비되었습니다. 앱을 다시 열면 적용됩니다');
    });
  }
})();
