import { allComplete, appendLog, defaults, newCourse, parseCourseUrl, validateSettings } from './model.ts';
import type { Command, State, Snapshot, QuizMemory } from './model.ts';

const STATE_KEY = 'rururu';
const WATCHDOG = 'rururu-watchdog';
let work: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = work.then(fn, fn);
  work = next.catch(() => undefined);
  return next;
}
async function read(): Promise<State> {
  const saved = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] as State | undefined;
  if (!saved) return defaults();
  if (saved.version !== 1 || !Array.isArray(saved.courses)) throw new Error('저장된 대기열 형식을 읽을 수 없습니다.');
  saved.settings = { ...defaults().settings, ...saved.settings };
  return saved as State;
}
async function save(state: State): Promise<void> {
  await chrome.storage.local.set({ [STATE_KEY]: state });
  const active = state.run.status === 'running';
  if (active && state.settings.keepAwake) chrome.power.requestKeepAwake('display');
  else chrome.power.releaseKeepAwake();
  await chrome.action.setBadgeText({ text: active ? '▶' : state.run.status === 'attention' ? '!' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: state.run.status === 'attention' ? '#963b22' : '#087b50' });
  if (active && !(await chrome.alarms.get(WATCHDOG))) await chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
  if (!active) await chrome.alarms.clear(WATCHDOG);
}
async function tell(tabId: number | null, message: unknown): Promise<boolean> {
  if (tabId === null) return false;
  try { await chrome.tabs.sendMessage(tabId, message, { frameId: 0 }); return true; } catch { return false; }
}
function config(state: State) {
  return { type: 'RUN', token: state.run.token, settings: state.settings };
}
function isSignIn(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['www.inflearn.com', 'inflearn.com', 'biz.inflearn.com'].includes(parsed.hostname)
      && /^\/(?:signin|login)(?:\/|$)/i.test(parsed.pathname);
  } catch { return false; }
}
function isNotFound(url: string): boolean {
  try { return new URL(url).pathname === '/not-found'; } catch { return false; }
}
async function pause(state: State, detail: string, attention = false) {
  state.run.status = attention ? 'attention' : 'paused';
  state.run.detail = detail;
  const course = state.courses.find(item => item.id === state.run.courseId);
  if (course) { course.status = attention ? 'attention' : 'paused'; course.reason = detail; }
  await tell(state.run.tabId, { type: 'STOP' });
  appendLog(state, detail);
  await save(state);
}
async function startCourse(state: State, id: string, resume = false) {
  const course = state.courses.find(item => item.id === id);
  if (!course) throw new Error('재생할 강좌가 없습니다.');
  let tab: chrome.tabs.Tab | undefined;
  if (state.run.tabId !== null) {
    try { tab = await chrome.tabs.get(state.run.tabId); } catch { /* The user may have closed the playback tab. */ }
  }
  if (!tab) tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  if (tab.id === undefined) throw new Error('재생 탭을 열 수 없습니다.');
  const previous = state.run.courseId;
  const now = Date.now();
  state.run = { status: 'running', tabId: tab.id, courseId: id, token: crypto.randomUUID(), boundKey: null, lastSeenAt: now, startedAt: now, detail: '강의실을 열고 있습니다.', media: null };
  course.status = 'playing';
  course.reason = '';
  appendLog(state, `${course.title} 재생 시작`);
  await save(state);
  let sameCourse = false;
  try { sameCourse = parseCourseUrl(tab.url || '').key === course.key; } catch { /* A new tab has no course yet. */ }
  if (resume && previous === id && sameCourse && await tell(tab.id, config(state))) return;
  await tell(tab.id, { type: 'STOP' });
  const launchUrl = new URL(course.url);
  launchUrl.searchParams.set('tab', 'curriculum');
  await chrome.tabs.update(tab.id, { url: launchUrl.href, autoDiscardable: false });
}
async function advance(state: State) {
  const next = state.courses.find(course => course.status === 'queued');
  if (next) { await startCourse(state, next.id); return; }
  const pending = state.courses.some(course => course.status !== 'done');
  state.run.status = pending ? 'attention' : 'done';
  state.run.courseId = null;
  state.run.media = null;
  state.run.detail = pending ? '재생 가능한 대기열을 마쳤습니다. 확인이 필요한 강좌가 남아 있습니다.' : '모든 강좌의 수강 완료를 확인했습니다.';
  await tell(state.run.tabId, { type: 'STOP' });
  appendLog(state, state.run.detail);
  await save(state);
}
function requireEditable(state: State, id: string) {
  if (state.run.status === 'running' && state.run.courseId === id) throw new Error('현재 강좌는 재생을 멈춘 뒤 변경할 수 있습니다.');
}
function validSnapshot(snapshot: Snapshot): boolean {
  if (!snapshot || typeof snapshot.url !== 'string' || typeof snapshot.lesson !== 'string' || !Array.isArray(snapshot.units)) return false;
  try { if (parseCourseUrl(snapshot.url).key !== snapshot.key) return false; } catch { return false; }
  const p = snapshot.progress;
  return !p || (Number.isInteger(p.completed) && Number.isInteger(p.total) && p.completed >= 0 && p.total > 0 && p.completed <= p.total);
}

async function handle(message: Command | { type: 'HELLO' }, sender: chrome.runtime.MessageSender) {
  const pageMessage = message.type === 'HELLO' || message.type === 'REPORT' || message.type === 'CONFIRM_SLOT' || message.type === 'QUIZ_MEMORY';
  if (pageMessage) {
    if (sender.frameId !== 0 || sender.tab?.id === undefined || !sender.url?.startsWith('https://')) throw new Error('잘못된 재생 탭 메시지입니다.');
  } else if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) {
    throw new Error('대기열 화면에서 실행해 주세요.');
  }
  const state = await read();
  if (message.type === 'HELLO') {
    if (state.run.status === 'running' && state.run.tabId === sender.tab?.id) {
      try { parseCourseUrl(sender.url!); } catch {
        await pause(state, isSignIn(sender.url!)
          ? '인프런 로그인이 필요합니다. 로그인 페이지에서 로그인한 뒤 이어 재생해 주세요.'
          : isNotFound(sender.url!)
          ? '인프런에서 강의실 주소를 찾지 못했습니다(404). 강좌 주소와 수강 권한을 확인해 주세요.'
          : '강의실을 벗어났습니다. 재생 탭의 주소와 수강 권한을 확인한 뒤 이어 재생해 주세요.', true);
        return { type: 'STOP' };
      }
      return config(state);
    }
    return { type: 'STOP' };
  }
  switch (message.type) {
    case 'STATE': return state;
    case 'ADD': {
      if (!Array.isArray(message.urls) || message.urls.length > 200) throw new Error('한 번에 최대 200개 주소를 추가할 수 있습니다.');
      const additions = message.urls.filter(url => url.trim()).map(newCourse);
      if (!additions.length) throw new Error('강좌 주소를 한 줄에 하나씩 입력해 주세요.');
      let count = 0;
      for (const course of additions) {
        if (state.courses.some(item => item.key === course.key)) continue;
        state.courses.push(course); count++;
      }
      appendLog(state, count ? `${count}개 강좌를 추가했습니다.` : '이미 대기열에 있는 강좌입니다.');
      if (count && state.run.status === 'done') { state.run.status = 'idle'; state.run.detail = '새 강좌를 추가했습니다. 대기열 재생을 눌러 주세요.'; }
      break;
    }
    case 'IMPORT_TABS': {
      const tabs = await chrome.tabs.query({ url: ['https://www.inflearn.com/*', 'https://inflearn.com/*', 'https://biz.inflearn.com/*'] });
      let count = 0;
      for (const tab of tabs) {
        try {
          const course = newCourse(tab.url || '');
          if (state.courses.some(item => item.key === course.key)) continue;
          if (tab.title && !/^(?:https?:\/\/)?(?:www\.)?inflearn\.com(?:\/|$)/i.test(tab.title)) {
            course.title = tab.title.replace(/\s*[-|·]\s*(인프런|Inflearn|학습 페이지).*$/i, '').slice(0, 200);
          }
          state.courses.push(course); count++;
        } catch { /* Ignore non-course tabs such as the course catalog. */ }
      }
      if (!count) throw new Error('추가할 새 강좌 탭이 없습니다. 강좌 소개나 강의실 탭을 열어 주세요.');
      appendLog(state, `열린 탭에서 ${count}개 강좌를 추가했습니다.`);
      if (state.run.status === 'done') { state.run.status = 'idle'; state.run.detail = '새 강좌를 추가했습니다. 대기열 재생을 눌러 주세요.'; }
      break;
    }
    case 'REMOVE':
      requireEditable(state, message.id);
      state.courses = state.courses.filter(course => course.id !== message.id);
      if (state.run.courseId === message.id) { state.run.courseId = null; state.run.status = 'idle'; }
      break;
    case 'UPDATE_URL': {
      requireEditable(state, message.id);
      const course = state.courses.find(item => item.id === message.id);
      if (!course) throw new Error('주소를 바꿀 강좌가 없습니다.');
      const parsed = parseCourseUrl(message.url);
      if (state.courses.some(item => item.id !== message.id && item.key === parsed.key)) throw new Error('이미 대기열에 있는 강좌 주소입니다.');
      course.key = parsed.key;
      course.url = parsed.url;
      course.status = 'queued';
      course.reason = '';
      course.lesson = '';
      course.progress = null;
      course.quizzes = null;
      course.missions = null;
      if (state.run.courseId === course.id) {
        state.run.status = 'attention';
        state.run.boundKey = null;
        state.run.media = null;
        state.run.detail = '강좌 주소를 바꿨습니다. 이어 재생을 눌러 새 주소로 열어 주세요.';
      }
      appendLog(state, `${course.title} 강의실 주소 변경`);
      break;
    }
    case 'MOVE': {
      const index = state.courses.findIndex(course => course.id === message.id);
      const other = index + message.direction;
      if (![-1, 1].includes(message.direction) || index < 0 || other < 0 || other >= state.courses.length) return state;
      [state.courses[index], state.courses[other]] = [state.courses[other], state.courses[index]];
      break;
    }
    case 'RETRY': {
      requireEditable(state, message.id);
      const course = state.courses.find(item => item.id === message.id);
      if (course) { course.status = 'queued'; course.reason = ''; }
      break;
    }
    case 'SETTINGS':
      state.settings = validateSettings(message.settings);
      await save(state);
      if (state.run.status === 'running') await tell(state.run.tabId, config(state));
      return state;
    case 'START': {
      if (state.run.status === 'running') return state;
      const current = state.courses.find(course => course.id === state.run.courseId && course.status !== 'done');
      const next = current || state.courses.find(course => course.status === 'queued') || state.courses.find(course => course.status === 'paused' || course.status === 'attention');
      if (!next) throw new Error('먼저 재생할 강좌를 추가해 주세요.');
      await startCourse(state, next.id, !!current);
      return state;
    }
    case 'PAUSE': await pause(state, '재생을 일시정지했습니다. 이어 재생으로 다시 시작할 수 있습니다.'); return state;
    case 'FOCUS': {
      if (state.run.tabId === null) throw new Error('아직 재생 탭이 없습니다.');
      try {
        const tab = await chrome.tabs.update(state.run.tabId, { active: true });
        if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      } catch { throw new Error('재생 탭이 닫혔습니다. 이어 재생으로 다시 열어 주세요.'); }
      return state;
    }
    case 'LOGIN': {
      let signInTab: chrome.tabs.Tab | undefined;
      if (state.run.tabId !== null) {
        try {
          const tab = await chrome.tabs.get(state.run.tabId);
          if (isSignIn(tab.url || '')) signInTab = tab;
        } catch { /* A closed playback tab does not block login. */ }
      }
      if (signInTab?.id !== undefined) {
        await chrome.tabs.update(signInTab.id, { active: true });
        if (signInTab.windowId !== undefined) await chrome.windows.update(signInTab.windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url: 'https://www.inflearn.com/signin', active: true });
      }
      return state;
    }
    case 'SKIP': {
      const current = state.courses.find(course => course.id === state.run.courseId);
      if (!current) throw new Error('보류할 현재 강좌가 없습니다.');
      current.status = 'attention'; current.reason = '사용자가 보류했습니다.';
      await tell(state.run.tabId, { type: 'STOP' });
      appendLog(state, `${current.title} 보류`);
      await advance(state);
      return state;
    }
    case 'CLEAR_DONE': state.courses = state.courses.filter(course => course.status !== 'done'); break;
    case 'CONFIRM_SLOT': {
      if (state.run.status !== 'running' || sender.tab?.id !== state.run.tabId || message.token !== state.run.token) return { allowed: false };
      const now = Date.now();
      if (now - (state.lastConfirmAt || 0) < 65_000) return { allowed: false };
      state.lastConfirmAt = now;
      await save(state);
      return { allowed: true };
    }
    case 'QUIZ_MEMORY': {
      if (state.run.status !== 'running' || sender.tab?.id !== state.run.tabId || message.token !== state.run.token) throw new Error('종료된 퀴즈 요청입니다.');
      // sender.url retains the document's original URL across history.pushState.
      // Validate the quiz against the owned tab's current lesson instead.
      const tab = await chrome.tabs.get(state.run.tabId!);
      const info = parseCourseUrl(tab.url || '');
      if (state.run.boundKey && info.key !== state.run.boundKey) throw new Error('현재 재생 중인 강좌의 퀴즈가 아닙니다.');
      if (info.unitId !== message.unitId || typeof message.question !== 'string' || !message.question.trim() || message.question.length > 2000) throw new Error('퀴즈 문항을 확인할 수 없습니다.');
      const key = `${info.key}/${message.unitId}/${message.question}`;
      const bank = (await chrome.storage.local.get('quizMemory')).quizMemory as Record<string, QuizMemory> || {};
      const memory = bank[key] || { correct: null, wrong: [] };
      if (message.feedback) {
        const { choice, correct } = message.feedback;
        if (typeof choice !== 'string' || choice.length > 5000 || typeof correct !== 'boolean') throw new Error('올바르지 않은 퀴즈 피드백입니다.');
        if (correct) memory.correct = choice;
        else if (!memory.wrong.includes(choice)) memory.wrong.push(choice);
        bank[key] = memory;
        const keys = Object.keys(bank);
        for (const old of keys.slice(0, Math.max(0, keys.length - 2000))) delete bank[old];
        await chrome.storage.local.set({ quizMemory: bank });
      }
      return memory;
    }
    case 'REPORT': {
      if (state.run.status !== 'running' || sender.tab?.id !== state.run.tabId || message.token !== state.run.token || !validSnapshot(message.snapshot)) return state;
      const course = state.courses.find(item => item.id === state.run.courseId);
      if (!course) return state;
      const snapshot = message.snapshot;
      if (state.run.boundKey && snapshot.key !== state.run.boundKey) {
        await pause(state, '다른 강좌로 이동하여 재생을 멈췄습니다. 대기열에서 이어 재생해 주세요.', true);
        return state;
      }
      if (snapshot.units.length || snapshot.video || snapshot.progress) {
        course.key = snapshot.key;
        state.run.boundKey = snapshot.key;
      }
      course.url = parseCourseUrl(snapshot.url).url;
      if (snapshot.courseTitle) course.title = snapshot.courseTitle.slice(0, 200);
      if (snapshot.lesson) course.lesson = snapshot.lesson.slice(0, 300);
      // Keep the last observed counts while the sidebar or a new unit loads.
      // Completion itself always uses the fresh snapshot below.
      if (snapshot.progress) course.progress = snapshot.progress;
      if (snapshot.quizzes) course.quizzes = snapshot.quizzes;
      if (snapshot.missions) course.missions = snapshot.missions;
      state.run.lastSeenAt = Date.now();
      state.run.detail = message.detail.slice(0, 500);
      state.run.media = snapshot.video ? { current: snapshot.video.current, duration: snapshot.video.duration } : null;
      if (message.event === 'done' && allComplete(snapshot)) {
        course.status = 'done'; course.reason = '';
        appendLog(state, `${course.title}: ${snapshot.progress!.completed}/${snapshot.progress!.total} 수업 완료 확인`);
        await advance(state); return state;
      }
      if (message.event === 'attention') {
        await pause(state, message.detail, true); return state;
      }
      break;
    }
    default: throw new Error('지원하지 않는 요청입니다.');
  }
  await save(state);
  return state;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  serial(() => handle(message, sender)).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});
chrome.runtime.onInstalled.addListener(() => {
  void serial(async () => {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const state = await read();
    if (state.run.status === 'running') await pause(state, '확장 프로그램이 업데이트되었습니다. 이어 재생해 주세요.');
    else await save(state);
  });
});
chrome.runtime.onStartup.addListener(() => {
  void serial(async () => {
    const state = await read();
    state.run.tabId = null;
    if (state.run.status === 'running') await pause(state, '브라우저를 다시 열었습니다. 이어 재생해 주세요.');
    else await save(state);
  });
});
chrome.tabs.onRemoved.addListener(tabId => {
  void serial(async () => {
    const state = await read();
    if (state.run.tabId !== tabId) return;
    state.run.tabId = null;
    if (state.run.status === 'running') await pause(state, '재생 탭이 닫혔습니다. 이어 재생을 누르면 새 탭에서 재개합니다.', true);
    else await save(state);
  });
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== WATCHDOG) return;
  void serial(async () => {
    const state = await read();
    if (state.run.status !== 'running') return;
    if (Date.now() - state.run.lastSeenAt > 120_000) {
      await pause(state, '2분 동안 재생 탭의 응답이 없습니다. 네트워크와 강의실을 확인해 주세요.', true);
      return;
    }
    await tell(state.run.tabId, { type: 'CHECK' });
  });
});
