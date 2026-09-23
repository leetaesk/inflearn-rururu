import { progressPercent } from './model.ts';
import type { Command, Course, Settings, State } from './model.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let state: State | null = null;
let settingsDirty = false;
let pending = false;
const statuses = { idle: '재생 대기', queued: '대기', running: '재생 중', playing: '재생 중', paused: '일시정지', attention: '확인 필요', done: '완료 확인' };
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}
function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function notice(text = '') { $('notice').textContent = text; $('notice').hidden = !text; }
async function send(command: Command): Promise<State> {
  const reply = await chrome.runtime.sendMessage(command);
  if (!reply.ok) throw new Error(reply.error || '요청을 처리하지 못했습니다.');
  return reply.data;
}
async function action(command: Command): Promise<boolean> {
  if (pending) return false;
  pending = true;
  notice();
  try { state = await send(command); render(state); return true; }
  catch (error) { notice(error instanceof Error ? error.message : '확장 프로그램을 다시 열어 주세요.'); return false; }
  finally { pending = false; }
}
function row(course: Course, index: number, total: number): HTMLLIElement {
  const item = el('li', 'course'); item.dataset.status = course.status; item.dataset.id = course.id;
  item.append(el('span', 'course-index', String(index + 1).padStart(2, '0')));
  const body = el('div'); body.append(el('h3', 'course-title', course.title));
  const meta = el('p', 'course-meta');
  meta.append(el('span', 'course-status', statuses[course.status]));
  const percent = progressPercent(course.progress);
  meta.append(el('span', '', course.progress ? `${course.progress.completed} / ${course.progress.total} 수업 · ${percent}%` : '진도 확인 전'));
  if (course.quizzes) meta.append(el('span', '', `퀴즈 ${course.quizzes.completed} / ${course.quizzes.total}`));
  if (course.missions) meta.append(el('span', '', `미션 ${course.missions.completed} / ${course.missions.total}`));
  body.append(meta);
  if (course.reason) body.append(el('p', 'course-reason', course.reason));
  item.append(body);
  const controls = el('div', 'row-actions');
  const button = (text: string, command: Command, disabled: boolean, accessible: string) => {
    const node = el('button', 'quiet', text); node.type = 'button'; node.disabled = disabled;
    node.setAttribute('aria-label', `${course.title} ${accessible}`);
    node.dataset.action = command.type;
    node.addEventListener('click', () => void action(command)); controls.append(node);
  };
  const current = state?.run.status === 'running' && state.run.courseId === course.id;
  button('위로', { type: 'MOVE', id: course.id, direction: -1 }, index === 0, '위로 이동');
  button('아래로', { type: 'MOVE', id: course.id, direction: 1 }, index === total - 1, '아래로 이동');
  if (['attention', 'done', 'paused'].includes(course.status)) button('다시 대기', { type: 'RETRY', id: course.id }, !!current, '다시 대기열에 넣기');
  const edit = el('button', 'quiet', '주소 수정'); edit.type = 'button'; edit.disabled = !!current;
  edit.setAttribute('aria-label', `${course.title} 강의실 주소 수정`);
  edit.setAttribute('aria-expanded', 'false');
  controls.append(edit);
  button('삭제', { type: 'REMOVE', id: course.id }, !!current, '대기열에서 삭제');
  item.append(controls);
  const editor = el('form', 'course-url-editor'); editor.hidden = true;
  const fieldId = `course-address-${index}`;
  const label = el('label', '', '강의실 주소'); label.htmlFor = fieldId;
  const field = el('input'); field.id = fieldId; field.type = 'url'; field.required = true; field.value = course.url;
  const help = el('p', 'hint', '인프런 강좌 소개 또는 강의실 주소를 입력하세요. 404 오류라면 강의실의 실제 주소를 사용하세요.');
  const controlsRow = el('div', 'course-url-actions');
  const save = el('button', '', '주소 저장'); save.type = 'submit';
  const cancel = el('button', 'quiet', '취소'); cancel.type = 'button';
  controlsRow.append(save, cancel); editor.append(label, field, help, controlsRow); item.append(editor);
  edit.addEventListener('click', () => { editor.hidden = false; edit.setAttribute('aria-expanded', 'true'); field.focus(); field.select(); });
  cancel.addEventListener('click', () => { editor.hidden = true; edit.setAttribute('aria-expanded', 'false'); edit.focus(); });
  editor.addEventListener('submit', async event => {
    event.preventDefault();
    if (await action({ type: 'UPDATE_URL', id: course.id, url: field.value })) $('start').focus();
  });
  return item;
}
function render(next: State) {
  state = next;
  document.querySelector('.player')?.setAttribute('aria-busy', 'false');
  const course = next.courses.find(item => item.id === next.run.courseId);
  const running = next.run.status === 'running';
  $('run-status').textContent = statuses[next.run.status];
  $('current-title').textContent = course?.title || (next.run.status === 'done' ? '대기열을 모두 재생했습니다.' : next.courses.length ? '대기열이 준비되었습니다.' : '재생할 강좌를 추가해 주세요.');
  $('current-lesson').textContent = course?.lesson || '';
  $('run-detail').textContent = next.run.status === 'idle' && next.courses.length ? '재생 버튼을 누르면 첫 강좌부터 시작합니다.' : next.run.detail;
  const media = next.run.media;
  $<HTMLProgressElement>('media-progress').value = media && media.duration > 0 ? media.current / media.duration * 100 : 0;
  $('media-time').textContent = media && media.duration > 0 ? `${clock(media.current)} / ${clock(media.duration)}` : '재생 대기';
  $('start').hidden = running;
  $<HTMLButtonElement>('start').disabled = !next.courses.some(item => item.status !== 'done');
  $('start').textContent = ['paused', 'attention'].includes(next.run.status) ? '이어 재생' : '대기열 재생';
  $('pause').hidden = !running;
  $('login-help').hidden = next.run.status !== 'attention' || !next.run.detail.includes('인프런 로그인이 필요합니다.');
  $<HTMLButtonElement>('focus').disabled = next.run.tabId === null;
  $<HTMLButtonElement>('skip').disabled = !course;
  $<HTMLButtonElement>('clear-done').disabled = !next.courses.some(item => item.status === 'done');
  $('queue-count').textContent = String(next.courses.length);
  const completed = next.courses.filter(item => item.status === 'done').length;
  $('queue-summary').textContent = next.courses.length ? `${next.courses.length}개 중 ${completed}개 완료 확인 · 한 탭에서 순서대로 재생` : '강좌 순서대로 한 탭에서 재생합니다.';
  $('empty').hidden = next.courses.length > 0;
  // Keep row nodes while only the media clock changes, preserving keyboard focus.
  const signature = JSON.stringify(next.courses);
  if ($('queue').dataset.signature !== signature) {
    const focused = document.activeElement as HTMLElement | null;
    const focusId = focused?.closest<HTMLElement>('[data-id]')?.dataset.id;
    const focusAction = focused?.dataset.action;
    $('queue').replaceChildren(...next.courses.map((item, index) => row(item, index, next.courses.length)));
    $('queue').dataset.signature = signature;
    if (focusId && focusAction) {
      const replacement = [...$('queue').querySelectorAll<HTMLElement>('[data-id]')].find(item => item.dataset.id === focusId)?.querySelector<HTMLElement>(`[data-action="${focusAction}"]`);
      replacement?.focus();
    }
  }
  $('no-logs').hidden = !!next.logs.length;
  $('logs').replaceChildren(...next.logs.slice(0, 15).map(entry => {
    const item = el('li'); const time = el('time', '', new Date(entry.at).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    time.dateTime = new Date(entry.at).toISOString(); item.append(time, el('span', '', entry.text)); return item;
  }));
  if (!settingsDirty) fillSettings(next.settings);
}
function fillSettings(settings: Settings) {
  $<HTMLSelectElement>('speed').value = String(settings.speed);
  $<HTMLInputElement>('muted').checked = settings.muted;
  $<HTMLInputElement>('keep-awake').checked = settings.keepAwake;
  $<HTMLSelectElement>('text-mode').value = settings.textMode;
  $<HTMLInputElement>('text-wait').value = String(settings.textWaitSeconds);
  $('text-wait-row').hidden = settings.textMode !== 'confirm';
  $<HTMLSelectElement>('quiz-mode').value = settings.quizMode;
  $<HTMLSelectElement>('mission-mode').value = settings.missionMode;
}
function setTheme(dark: boolean) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('theme').textContent = dark ? '밝은 화면' : '어두운 화면';
  $('theme').setAttribute('aria-label', dark ? '밝은 화면으로 변경' : '어두운 화면으로 변경');
  localStorage.setItem('theme', dark ? 'dark' : 'light');
}
setTheme(localStorage.getItem('theme') === 'dark');
$('theme').addEventListener('click', () => setTheme(document.documentElement.dataset.theme !== 'dark'));
for (const [id, type] of [['start', 'START'], ['pause', 'PAUSE'], ['focus', 'FOCUS'], ['login', 'LOGIN'], ['skip', 'SKIP'], ['clear-done', 'CLEAR_DONE'], ['import-tabs', 'IMPORT_TABS']] as const) {
  $(id).addEventListener('click', () => void action({ type }));
}
$('add-form').addEventListener('submit', async event => {
  event.preventDefault();
  const field = $<HTMLTextAreaElement>('urls');
  if (await action({ type: 'ADD', urls: field.value.split(/\n+/).map(url => url.trim()).filter(Boolean) })) { field.value = ''; field.focus(); }
});
$('settings-form').addEventListener('input', () => {
  settingsDirty = true;
  $('settings-status').textContent = '저장하지 않은 설정';
  $('text-wait-row').hidden = $<HTMLSelectElement>('text-mode').value !== 'confirm';
});
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const settings: Settings = {
    speed: Number($<HTMLSelectElement>('speed').value), muted: $<HTMLInputElement>('muted').checked,
    keepAwake: $<HTMLInputElement>('keep-awake').checked, textMode: $<HTMLSelectElement>('text-mode').value as Settings['textMode'],
    textWaitSeconds: Number($<HTMLInputElement>('text-wait').value),
    quizMode: $<HTMLSelectElement>('quiz-mode').value as Settings['quizMode'],
    missionMode: $<HTMLSelectElement>('mission-mode').value as Settings['missionMode'],
  };
  if (await action({ type: 'SETTINGS', settings })) { settingsDirty = false; $('settings-status').textContent = '설정을 저장했습니다.'; }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.rururu?.newValue) render(changes.rururu.newValue as State);
});
void action({ type: 'STATE' });
