import { visible } from './adapter.ts';
import { chooseAnswer } from './model.ts';
import type { QuizMemory, Snapshot } from './model.ts';

export interface AssessmentResult { detail: string; done?: boolean; attention?: boolean }
type Context = { token: string; active: () => boolean };
const text = (node: Element | null) => (node?.textContent || '').replace(/\s+/g, ' ').trim();
const available = (node: HTMLElement) => visible(node) && !node.hasAttribute('disabled') && node.getAttribute('aria-disabled') !== 'true' && getComputedStyle(node).pointerEvents !== 'none';
function button(pattern: RegExp, root: ParentNode = document): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>('button')].find(node => !node.closest('li[data-unit-id]') && pattern.test(text(node)) && available(node));
}
function action(name: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[data-dd-action-name]')].find(node => node.dataset.ddActionName === name && available(node));
}
let lastActionAt = 0;
let observedQuestion = '';
let lastChoice = '';
let recordedFeedback = '';
let lastAssessmentKey = '';
let missionSubmitted = false;
export function resetAssessments() { lastAssessmentKey = ''; }

function ready(snapshot: Snapshot): boolean {
  const key = `${snapshot.key}/${snapshot.unitId}`;
  if (lastAssessmentKey !== key) {
    lastAssessmentKey = key; lastActionAt = Date.now() - 1800; observedQuestion = ''; lastChoice = ''; recordedFeedback = ''; missionSubmitted = false;
  }
  return Date.now() - lastActionAt >= 1800;
}
function click(node: HTMLElement) { lastActionAt = Date.now(); node.click(); }
export function assessmentIdleMs() { return Date.now() - lastActionAt; }

function questionView() {
  const choices = [...document.querySelectorAll<HTMLElement>('[role="radio"], input[type="radio"][name="quiz"]')].filter(node => visible(node) || !!node.closest('label'));
  const group = choices[0]?.closest('[role="radiogroup"]') || choices[0]?.parentElement;
  let parent = group;
  let question = '';
  for (let i = 0; parent && i < 5; i++, parent = parent.parentElement) {
    const heading = parent.querySelector('h3');
    if (heading) { question = text(heading); break; }
  }
  return { question, choices: choices.map(node => {
    const label = node instanceof HTMLInputElement ? node.labels?.[0] || node.closest('label') || node.parentElement : node;
    // The A/B/C/D badge becomes a check or cross after submission. Read the
    // separate choice paragraph so an answer beginning with "AWS" keeps its A.
    const paragraph = label?.querySelector('p');
    return { node, content: paragraph ? text(paragraph) : text(label).replace(/^[A-ZⒶ-Ⓩ①-⑳]\s+/, ''), selected: node.getAttribute('aria-checked') === 'true' || (node instanceof HTMLInputElement && node.checked) };
  }) };
}

export async function quizStep(snapshot: Snapshot, context: Context): Promise<AssessmentResult> {
  if (!ready(snapshot)) return { detail: '퀴즈 응답이 반영되기를 기다리고 있습니다.' };
  const view = questionView();
  const next = action('다음 문항으로 이동') || action('마지막 문항 완료');
  if (view.question && view.choices.length) {
    if (observedQuestion !== view.question) { observedQuestion = view.question; lastChoice = ''; recordedFeedback = ''; }
    const selected = view.choices.find(choice => choice.selected);
    if (next) {
      const correct = [...document.querySelectorAll('p, span')].some(node => visible(node) && /^(정답입니다!|Correct!)$/.test(text(node)));
      const incorrect = [...document.querySelectorAll('p, span')].some(node => visible(node) && /^(오답이에요\.?|Incorrect\.?)$/.test(text(node)));
      const choice = selected?.content || lastChoice;
      if (!choice || (!correct && !incorrect)) return { detail: '퀴즈 정오답 표시를 확인하고 있습니다.' };
      const stamp = `${view.question}/${choice}/${correct}`;
      if (recordedFeedback !== stamp) {
        const reply = await chrome.runtime.sendMessage({ type: 'QUIZ_MEMORY', token: context.token, unitId: snapshot.unitId, question: view.question, feedback: { choice, correct } });
        if (!reply.ok) throw new Error(reply.error);
        recordedFeedback = stamp;
      }
      if (context.active()) click(next);
      return { detail: correct ? '정답을 확인하고 다음 문항으로 이동합니다.' : '오답을 기록했습니다. 남은 문항을 제출한 뒤 재시도합니다.' };
    }
    const submit = action('문항 제출');
    if (selected && submit) {
      lastChoice = selected.content;
      click(submit);
      return { detail: '선택한 퀴즈 답안을 제출하고 있습니다.' };
    }
    if (!selected) {
      const reply = await chrome.runtime.sendMessage({ type: 'QUIZ_MEMORY', token: context.token, unitId: snapshot.unitId, question: view.question });
      if (!reply.ok) throw new Error(reply.error);
      if (!context.active()) return { detail: '퀴즈 재생을 멈췄습니다.' };
      const answer = chooseAnswer(view.choices.map(choice => choice.content), reply.data as QuizMemory);
      const chosen = view.choices.find(choice => choice.content === answer);
      if (!chosen) return { detail: '기록된 오답을 제외하면 선택지가 없습니다. 퀴즈를 확인해 주세요.', attention: true };
      lastChoice = chosen.content;
      click(chosen.node);
      return { detail: '이전 정오답 기록을 반영해 퀴즈 선택지를 고릅니다.' };
    }
    return { detail: '퀴즈 제출 버튼을 기다리고 있습니다.' };
  }
  const retry = action('퀴즈결과화면 오답풀기') || action('문항 다시보기에서 오답풀기');
  if (retry) {
    click(retry); observedQuestion = ''; recordedFeedback = '';
    return { detail: '제공된 재시도 횟수 안에서 오답을 다시 풀고 있습니다.' };
  }
  const results = button(/^전체 문항 보기$/);
  if (results && snapshot.currentComplete) return { detail: '퀴즈 제출 완료를 확인했습니다.', done: true };
  const start = button(/^(퀴즈 생성하기|퀴즈 시작하기|퀴즈 시작|시작하기)$/);
  if (start) { click(start); return { detail: '섹션 퀴즈를 준비하고 있습니다.' }; }
  if (snapshot.currentComplete) return { detail: '이미 완료한 퀴즈입니다.', done: true };
  const pending = [...document.querySelectorAll('button')].find(node => visible(node) && text(node) === '퀴즈 대기중...');
  if (pending) return { detail: '섹션의 수업 완료가 반영되어야 퀴즈를 시작할 수 있습니다.', attention: true };
  return { detail: '퀴즈 문항을 불러오고 있습니다.' };
}

export function missionStep(snapshot: Snapshot): AssessmentResult {
  if (!ready(snapshot)) return { detail: '미션 제출 결과를 기다리고 있습니다.' };
  if (snapshot.currentComplete) return { detail: '미션 완료를 확인했습니다.', done: true };
  const messages = [...document.querySelectorAll('[role="alert"]')].filter(visible).map(text).join(' ');
  if (/제출을 완료했어요|피드백을 전달/.test(messages)) return { detail: '미션을 제출했습니다. 강사의 검토가 끝나야 완료됩니다.', attention: true };
  if (/마감된 미션|반려/.test(messages)) return { detail: '미션이 마감되었거나 보완 요청을 받았습니다. 미션 내용을 확인해 주세요.', attention: true };
  const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(visible);
  if (dialog) {
    const title = dialog.querySelector<HTMLInputElement>('input[name="title"], input[placeholder*="제목"]');
    const body = dialog.querySelector<HTMLElement>('[contenteditable="true"], textarea[name="body"]');
    if (!title || !body) return { detail: '저장된 미션 원고를 불러오고 있습니다.' };
    const content = body instanceof HTMLTextAreaElement ? body.value.trim() : text(body);
    if (!title?.value.trim() || !content) return { detail: '제출할 미션 원고가 없습니다. 제목과 본문을 작성해 두면 자동 제출할 수 있습니다.', attention: true };
    const submit = button(/^(제출하기|제출|미션 제출)$/i, dialog);
    if (submit && !missionSubmitted) { missionSubmitted = true; click(submit); return { detail: '작성된 미션 원고를 제출하고 있습니다.' }; }
    return { detail: '미션의 필수 항목과 제출 상태를 확인하고 있습니다.' };
  }
  const resume = button(/^이어 작성하기$/);
  if (resume) { click(resume); return { detail: '저장된 미션 원고를 열고 있습니다.' }; }
  if (button(/^작성하기$/)) return { detail: '이 미션은 원고 작성이 필요합니다. 원고를 임시 저장하면 이어 재생에서 자동 제출합니다.', attention: true };
  return { detail: '미션 상태를 불러오고 있습니다.' };
}
