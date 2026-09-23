export type CourseStatus = 'queued' | 'playing' | 'paused' | 'attention' | 'done';
export type RunStatus = 'idle' | 'running' | 'paused' | 'attention' | 'done';
export interface Settings {
  speed: number;
  muted: boolean;
  keepAwake: boolean;
  textMode: 'pause' | 'confirm';
  textWaitSeconds: number;
  quizMode: 'auto' | 'pause';
  missionMode: 'draft' | 'pause';
}
export interface Progress { completed: number; total: number }
export interface Course {
  id: string;
  key: string;
  url: string;
  title: string;
  status: CourseStatus;
  progress: Progress | null;
  quizzes?: Progress | null;
  missions?: Progress | null;
  lesson: string;
  reason: string;
}
export interface LogEntry { at: number; text: string }
export interface State {
  version: 1;
  courses: Course[];
  settings: Settings;
  run: {
    status: RunStatus;
    tabId: number | null;
    courseId: string | null;
    token: string;
    boundKey: string | null;
    lastSeenAt: number;
    startedAt: number;
    detail: string;
    media: { current: number; duration: number } | null;
  };
  logs: LogEntry[];
  lastConfirmAt: number;
}
export interface LocationInfo { key: string; url: string; unitId: string; title: string }
export interface Snapshot {
  url: string;
  key: string;
  courseTitle: string;
  unitId: string;
  lesson: string;
  progress: Progress | null;
  quizzes?: Progress | null;
  missions?: Progress | null;
  currentComplete: boolean;
  units: { id: string; title: string; complete: boolean; kind: 'video' | 'text' | 'quiz' | 'mission' | 'live' | 'unknown'; locked: boolean }[];
  next: boolean;
  video: { current: number; duration: number; paused: boolean; ended: boolean; error: boolean } | null;
  problem: string;
}
export type PageReply = { ok: boolean; error?: string; snapshot?: Snapshot };
export type Command =
  | { type: 'STATE' }
  | { type: 'ADD'; urls: string[] }
  | { type: 'IMPORT_TABS' }
  | { type: 'REMOVE'; id: string }
  | { type: 'UPDATE_URL'; id: string; url: string }
  | { type: 'MOVE'; id: string; direction: -1 | 1 }
  | { type: 'RETRY'; id: string }
  | { type: 'SETTINGS'; settings: Settings }
  | { type: 'START' }
  | { type: 'PAUSE' }
  | { type: 'FOCUS' }
  | { type: 'LOGIN' }
  | { type: 'SKIP' }
  | { type: 'CLEAR_DONE' }
  | { type: 'CONFIRM_SLOT'; token: string }
  | { type: 'QUIZ_MEMORY'; token: string; unitId: string; question: string; feedback?: { choice: string; correct: boolean } }
  | { type: 'REPORT'; token: string; snapshot: Snapshot; event: 'status' | 'done' | 'attention'; detail: string };

export const defaults = (): State => ({
  version: 1,
  courses: [],
  settings: { speed: 1, muted: true, keepAwake: true, textMode: 'pause', textWaitSeconds: 65, quizMode: 'auto', missionMode: 'draft' },
  run: { status: 'idle', tabId: null, courseId: null, token: '', boundKey: null, lastSeenAt: 0, startedAt: 0, detail: '강좌를 추가하면 순서대로 재생합니다.', media: null },
  logs: [],
  lastConfirmAt: 0,
});

export function parseCourseUrl(input: string): LocationInfo {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('인프런 강좌 또는 강의실 주소를 입력해 주세요.'); }
  if (url.protocol !== 'https:' || !['www.inflearn.com', 'inflearn.com', 'biz.inflearn.com'].includes(url.hostname) || url.username || url.password || url.port) {
    throw new Error('인프런(www.inflearn.com 또는 biz.inflearn.com) 주소만 추가할 수 있습니다.');
  }
  const path = url.pathname.replace(/^\/(ko|en|ja|vi)(?=\/)/, '').replace(/\/$/, '');
  const classroom = /^\/courses?\/lecture$/.test(path);
  let slug = url.searchParams.get('courseSlug') || '';
  let courseId = url.searchParams.get('courseId') || '';
  const product = path.match(/^\/course\/([^/]+)(?:\/(?:curriculum|dashboard))?$/);
  if (!classroom && product) {
    slug = decodeURIComponent(product[1]);
    const productId = url.searchParams.get('cid');
    courseId = productId && /^\d+$/.test(productId) ? productId : '';
  }
  if ((!classroom && !product) || (!slug && !/^\d+$/.test(courseId))) {
    throw new Error('강좌 소개 또는 강의실 주소가 필요합니다. 내 강의실 목록 주소는 사용할 수 없습니다.');
  }
  if (slug.length > 300 || /[\x00-\x1f]/.test(slug)) throw new Error('올바르지 않은 강좌 주소입니다.');
  const origin = url.hostname === 'biz.inflearn.com' ? url.origin : 'https://www.inflearn.com';
  const canonical = new URL(courseId ? '/courses/lecture' : '/course/lecture', origin);
  if (slug && !courseId) canonical.searchParams.set('courseSlug', slug);
  if (courseId) canonical.searchParams.set('courseId', courseId);
  const unitId = classroom ? url.searchParams.get('unitId') || 'current' : 'current';
  canonical.searchParams.set('unitId', /^\d+$/.test(unitId) ? unitId : 'current');
  const type = url.searchParams.get('type');
  if (classroom && type && /^[A-Z_]+$/.test(type)) canonical.searchParams.set('type', type);
  return { key: courseId ? `id:${courseId}` : `slug:${slug}`, url: canonical.href, unitId, title: slug ? slug.replace(/-/g, ' ') : `강좌 ${courseId}` };
}

export function validateSettings(value: Settings): Settings {
  if (!value || ![1, 1.25, 1.5, 1.75, 2].includes(value.speed) || typeof value.muted !== 'boolean' || typeof value.keepAwake !== 'boolean' || !['pause', 'confirm'].includes(value.textMode) || !Number.isInteger(value.textWaitSeconds) || value.textWaitSeconds < 65 || value.textWaitSeconds > 600) {
    throw new Error('재생 설정을 확인해 주세요. 자료 대기 시간은 65~600초입니다.');
  }
  if (!['auto', 'pause'].includes(value.quizMode) || !['draft', 'pause'].includes(value.missionMode)) throw new Error('퀴즈와 미션 설정을 확인해 주세요.');
  return { speed: value.speed, muted: value.muted, keepAwake: value.keepAwake, textMode: value.textMode, textWaitSeconds: value.textWaitSeconds, quizMode: value.quizMode, missionMode: value.missionMode };
}

export function isComplete(progress: Progress | null): boolean {
  return !!progress && Number.isInteger(progress.completed) && Number.isInteger(progress.total) && progress.total > 0 && progress.completed === progress.total;
}

export function allComplete(snapshot: Snapshot): boolean {
  return isComplete(snapshot.progress)
    && (!snapshot.quizzes || isComplete(snapshot.quizzes))
    && (!snapshot.missions || isComplete(snapshot.missions))
    && !snapshot.units.some(unit => ['quiz', 'mission'].includes(unit.kind) && !unit.complete);
}

export interface QuizMemory { correct: string | null; wrong: string[] }
export function chooseAnswer(choices: string[], memory: QuizMemory): string | null {
  if (memory.correct && choices.includes(memory.correct)) return memory.correct;
  return choices.find(choice => !memory.wrong.includes(choice)) ?? null;
}

export function progressPercent(progress: Progress | null): number | null {
  if (!progress || progress.total <= 0) return null;
  return Math.floor(progress.completed / progress.total * 100);
}

export function appendLog(state: State, text: string): void {
  if (state.logs[0]?.text === text) return;
  state.logs.unshift({ at: Date.now(), text });
  state.logs = state.logs.slice(0, 100);
}

export function newCourse(input: string): Course {
  const parsed = parseCourseUrl(input);
  return { id: crypto.randomUUID(), key: parsed.key, url: parsed.url, title: parsed.title, status: 'queued', progress: null, lesson: '', reason: '' };
}
