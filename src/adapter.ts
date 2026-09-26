import { parseCourseUrl } from './model.ts';
import type { Progress, Snapshot } from './model.ts';

const checkedIcon = '[data-icon="circle-check"], [data-icon="check-circle"]';
const label = (element: Element) => (element.getAttribute('aria-label') || element.textContent || '').replace(/\s+/g, ' ').trim();
export function visible(element: Element): boolean {
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}
function usable(element: Element): boolean {
  return visible(element) && !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true' && getComputedStyle(element).pointerEvents !== 'none';
}
const reviewClicks = new WeakMap<HTMLElement, number>();
export function dismissReviewPrompt(): 'dismissed' | 'waiting' | null {
  let waiting = false;
  for (const button of document.querySelectorAll<HTMLElement>('button, [role="button"]')) {
    if (!/^(다음에|나중에)$/.test(label(button)) || !visible(button)) continue;
    const dialog = button.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog');
    let prompt: Element | null = dialog;
    if (!dialog) {
      // Some portals omit dialog semantics. Require a small fixed overlay so
      // lesson text and an unrelated "later" button cannot match together.
      let parent = button.parentElement;
      for (let depth = 0; parent && parent !== document.body && depth < 6; depth++, parent = parent.parentElement) {
        if ((parent.textContent || '').length > 1200) break;
        if (getComputedStyle(parent).position === 'fixed') { prompt = parent; break; }
      }
    }
    if (!prompt || !visible(prompt) || !/수강평(?:을)?\s*(?:남겨|작성)/.test(prompt.textContent || '')) continue;
    waiting = true;
    if (!usable(button) || button.closest('[inert]')) continue;
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!hit || !button.contains(hit)) continue;
    const now = Date.now();
    if (now - (reviewClicks.get(button) || 0) < 3000) continue;
    reviewClicks.set(button, now);
    button.click();
    return 'dismissed';
  }
  return waiting ? 'waiting' : null;
}
export function readProgress(root: Document = document, name = /^(진도율|Progress)$/i): Progress | null {
  const labels = [...root.querySelectorAll('p, span, dt, strong, [aria-label]')].filter(node => name.test(label(node)));
  for (const node of labels) {
    if (node.closest('li[data-unit-id]')) continue;
    let parent: Element | null = node;
    for (let i = 0; parent && i < 5; i++, parent = parent.parentElement) {
      const walker = root.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
      const parts: string[] = [];
      while (walker.nextNode()) parts.push(walker.currentNode.textContent || '');
      const text = parts.join(' ');
      if (text.length > 500) break;
      const match = text.match(/([\d,]+)\s*\/\s*([\d,]+)/);
      if (!match) continue;
      const completed = Number(match[1].replaceAll(',', ''));
      const total = Number(match[2].replaceAll(',', ''));
      if (total > 0 && completed >= 0 && completed <= total) return { completed, total };
    }
  }
  return null;
}
export function getVideo(): HTMLVideoElement | null {
  const videos = [...document.querySelectorAll<HTMLVideoElement>('.shaka-video-container video, video')];
  return videos.filter(video => visible(video)).sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] || null;
}
export function completeButton(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('footer button, [aria-label="영상 하단 버튼"] button')].find(button => /^(봤어요|Watched)$/i.test(label(button))) || null;
}
export function nextButton(): HTMLElement | null {
  const direct = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')].find(button => /^(다음 수업으로 이동|다음 수업보기|다음 수업|Next lecture|Go to next lecture)$/i.test(label(button)) && usable(button));
  return direct || [...document.querySelectorAll<HTMLElement>('footer button, [aria-label="영상 하단 버튼"] button')].find(button => /^(다음|Next)$/i.test(label(button)) && usable(button)) || null;
}
function kindOf(row: HTMLElement): Snapshot['units'][number]['kind'] {
  const icons = [...row.querySelectorAll('[data-icon]')].map(icon => icon.getAttribute('data-icon') || '').join(' ');
  const meta = (row.textContent || '').replace(row.querySelector('.unit-title')?.textContent || '', '');
  if (/AI 퀴즈|AI Quiz/i.test(meta)) return 'quiz';
  if (/미션|Mission/i.test(meta)) return 'mission';
  if (/\bLIVE\b|라이브/.test(meta) || /video-camera|camera-web|signal-stream/.test(icons)) return 'live';
  if (/file|book-open|memo/.test(icons)) return 'text';
  if (/circle-play|play-circle|video/.test(icons) || /\d+\s*(?:분|초|min)|\d+:\d+/.test(meta)) return 'video';
  if (/^(?:수업 자료|Lecture resources)$/i.test(meta.trim())) return 'text';
  return 'unknown';
}
export function readSnapshot(): Snapshot {
  const info = parseCourseUrl(location.href);
  const units = [...document.querySelectorAll<HTMLElement>('li[data-unit-id]')].map(row => ({
    id: row.dataset.unitId!,
    title: (row.querySelector('.unit-title')?.textContent || '').trim(),
    complete: !!row.querySelector(`.unit-icon ${checkedIcon.split(', ').join(', .unit-icon ')}`),
    kind: kindOf(row),
    locked: !!row.querySelector('.unit-icon.disabled'),
  }));
  const current = units.find(unit => unit.id === info.unitId);
  const video = getVideo();
  const complete = completeButton();
  const titleLink = document.querySelector<HTMLAnchorElement>('a[href*="/course/"]:has([aria-label="강의소개로 이동"]), a[href*="/course/"]:has([aria-label="Go to course introduction"])');
  let courseTitle = document.title.replace(/\s*[-|·]\s*(인프런|Inflearn|학습 페이지).*$/i, '').trim();
  if (!courseTitle || /^(인프런|Inflearn|강의실)$/i.test(courseTitle) || courseTitle === current?.title) courseTitle = '';
  if (titleLink?.title) courseTitle = titleLink.title;
  // Only inspect the content area, so words in a curriculum title cannot trigger an error.
  const alerts = [...document.querySelectorAll('[role="alert"], [role="dialog"], main, #root > div')].filter(visible);
  let problem = '';
  for (const element of alerts) {
    const text = (element.textContent || '').trim();
    if (text.length > 1800) continue;
    if (/수강권한이 없|수강 권한이 없|수강신청 이후|수강신청이 필요|Access Denied/i.test(text)) problem = '수강 권한을 확인해 주세요. 강좌를 구매하거나 로그인한 뒤 이어 재생할 수 있습니다.';
    if (/다른 브라우저에서 학습|동시 접속|다른 기기에서/.test(text)) problem = '다른 강의실에서 재생 중입니다. 중복 재생을 정리한 뒤 이어 재생해 주세요.';
    if (/삭제 되었거나 존재하지 않는 수업|보안 재생이 불가능|DRM.*오류/.test(text)) problem = '강의실에서 재생 오류가 발생했습니다. 재생 탭을 확인해 주세요.';
  }
  return {
    url: location.href, key: info.key, courseTitle, unitId: info.unitId,
    lesson: current?.title || document.querySelector('[data-ui="unit-header"], h1')?.textContent?.trim().slice(0, 200) || '',
    progress: readProgress(), quizzes: readProgress(document, /^(퀴즈|Quizzes)$/i),
    missions: readProgress(document, /^(미션|Missions)$/i), currentComplete: current?.complete || !!complete?.querySelector(checkedIcon), units,
    next: !!nextButton(), problem,
    video: video ? { current: Number.isFinite(video.currentTime) ? video.currentTime : 0, duration: Number.isFinite(video.duration) ? video.duration : 0, paused: video.paused, ended: video.ended, error: !!video.error } : null,
  };
}

export function revealCurriculum(): boolean {
  // The closed sidebar can retain hidden rows. Conversely, while the open
  // sidebar is loading, clicking its toggle again would close it.
  if (new URL(location.href).searchParams.get('tab') === 'curriculum' || (document.querySelector('li[data-unit-id]') && readProgress())) return false;
  const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"], button')].find(node => /^(커리큘럼|목차|Curriculum)$/i.test(label(node)) && node.getAttribute('aria-selected') !== 'true' && usable(node));
  if (!tab) return false;
  tab.click();
  return true;
}
export function goToUnit(id: string): boolean {
  const row = [...document.querySelectorAll<HTMLElement>('li[data-unit-id]')].find(node => node.dataset.unitId === id);
  if (!row || row.querySelector('.unit-icon.disabled')) return false;
  // The row's title changes lessons; the adjacent checkmark button changes completion.
  (row.querySelector<HTMLElement>('.unit-title') || row).click();
  return true;
}
export function confirmCurrent(): boolean {
  const button = completeButton();
  if (!button || button.querySelector(checkedIcon) || !usable(button)) return false;
  button.click();
  return true;
}
export function canConfirmCurrent(): boolean {
  const button = completeButton();
  return !!button && !button.querySelector(checkedIcon) && usable(button);
}
export function goNext(): boolean {
  const button = nextButton();
  if (!button) return false;
  button.click();
  return true;
}
