import { canConfirmCurrent, confirmCurrent, getVideo, goNext, goToUnit, readSnapshot, revealCurriculum } from './adapter.ts';
import { allComplete } from './model.ts';
import { quizStep, missionStep, assessmentIdleMs, resetAssessments } from './assessments.ts';
import { parseCourseUrl } from './model.ts';
import type { Settings, Snapshot } from './model.ts';

interface RunConfig { type: 'RUN'; token: string; settings: Settings }
let config: RunConfig | null = null;
let busy = false;
let stopped = false;
let lessonKey = '';
let enteredAt = 0;
let lastReportAt = 0;
let endedAt = 0;
let confirmedAt = 0;
let lastConfirmAt = 0;
let lastAdvanceAt = 0;
let lastMovementAt = 0;
let lastTime = -1;
let lastVideo: HTMLVideoElement | null = null;
let observedPlaying = false;
let revealedAt = 0;
let finishedAt = 0;
let completionSeenAt = 0;
let failures = 0;
let navigationAttempts = new Map<string, number>();

function resetLesson(key: string) {
  lessonKey = key;
  enteredAt = Date.now();
  lastMovementAt = enteredAt;
  endedAt = 0;
  confirmedAt = 0;
  lastAdvanceAt = 0;
  lastTime = -1;
  lastVideo = null;
  observedPlaying = false;
  finishedAt = 0;
  completionSeenAt = 0;
}
function stop() {
  if (config) getVideo()?.pause();
  config = null;
  stopped = true;
}
function run(value: RunConfig) {
  if (config?.token !== value.token) {
    resetAssessments();
    lessonKey = '';
    navigationAttempts = new Map();
    failures = 0;
    lastReportAt = 0;
  }
  config = value;
  stopped = false;
  void tick();
}
async function report(snapshot: Snapshot, event: 'status' | 'attention' | 'done', detail: string) {
  if (!config) return;
  if (event === 'status' && Date.now() - lastReportAt < 4500) return;
  lastReportAt = Date.now();
  const token = config.token;
  const reply = await chrome.runtime.sendMessage({ type: 'REPORT', token, snapshot, event, detail });
  if (!reply.ok) throw new Error(reply.error);
  if (config?.token === token && (reply.data.run.status !== 'running' || reply.data.run.token !== token)) stop();
}
async function attention(snapshot: Snapshot, detail: string) {
  getVideo()?.pause();
  await report(snapshot, 'attention', detail);
}
async function confirm() {
  if (!config || !canConfirmCurrent()) return;
  const token = config.token;
  const key = lessonKey;
  const reply = await chrome.runtime.sendMessage({ type: 'CONFIRM_SLOT', token });
  if (!reply.ok || !reply.data.allowed || config?.token !== token) return;
  const snapshot = readSnapshot();
  if (`${snapshot.key}:${snapshot.unitId}` !== key) return;
  if (confirmCurrent()) { confirmedAt = Date.now(); lastConfirmAt = confirmedAt; }
}
async function next(snapshot: Snapshot) {
  const now = Date.now();
  if (now - lastAdvanceAt < 8000) return;
  const remaining = snapshot.units.find(unit => !unit.complete && unit.id !== snapshot.unitId);
  const target = remaining?.id || (snapshot.next ? 'next' : '');
  if (!target) {
    if (!finishedAt) finishedAt = now;
    if (now - finishedAt > 25_000) await attention(snapshot, '마지막 수업까지 재생했지만 전체 완료를 확인하지 못했습니다. 진도율과 접힌 목차를 확인해 주세요.');
    else await report(snapshot, 'status', '전체 수강 완료가 반영되기를 기다리고 있습니다.');
    return;
  }
  const key = `${snapshot.unitId}:${target}`;
  const attempts = navigationAttempts.get(key) || 0;
  if (attempts >= 3) {
    await attention(snapshot, '다음 수업으로 이동하지 못했습니다. 재생 탭에서 목차를 확인해 주세요.');
    return;
  }
  if (remaining?.locked) {
    await attention(snapshot, '수강할 수 없는 수업이 남아 있습니다. 수강 권한을 확인해 주세요.');
    return;
  }
  lastAdvanceAt = now;
  navigationAttempts.set(key, attempts + 1);
  await report(snapshot, 'status', '다음 미완료 수업으로 이동하고 있습니다.');
  if (!config) return;
  const current = readSnapshot();
  if (`${current.key}:${current.unitId}` !== lessonKey) return;
  getVideo()?.pause();
  if (remaining) goToUnit(remaining.id);
  else goNext();
}
async function tick() {
  if (!config || stopped || busy) return;
  busy = true;
  let failed = false;
  try {
    const now = Date.now();
    const pageUrl = new URL(location.href);
    // The legacy slug redirect converts the sentinel "current" to NaN. Once the
    // site has resolved the course ID, enter its supported modern current route.
    if (pageUrl.searchParams.get('courseId') && pageUrl.searchParams.get('unitId') === 'NaN') {
      location.replace(parseCourseUrl(location.href).url);
      return;
    }
    let snapshot: Snapshot;
    try { snapshot = readSnapshot(); } catch {
      stop();
      await chrome.runtime.sendMessage({ type: 'HELLO' });
      return;
    }
    const key = `${snapshot.key}:${snapshot.unitId}`;
    if (key !== lessonKey) resetLesson(key);
    if (snapshot.problem) { await attention(snapshot, snapshot.problem); return; }
    if (now - revealedAt > 8000 && (!snapshot.units.length || !snapshot.progress)) {
      revealedAt = now;
      if (revealCurriculum()) return;
    }
    const current = snapshot.units.find(unit => unit.id === snapshot.unitId);
    if (current?.kind === 'quiz' || current?.kind === 'mission') {
      const automatic = current.kind === 'quiz' ? config.settings.quizMode === 'auto' : config.settings.missionMode === 'draft';
      if (!automatic && !snapshot.currentComplete) {
        await attention(snapshot, '퀴즈·미션 자동 진행이 꺼져 있습니다. 설정을 바꾸거나 직접 완료한 뒤 이어 재생해 주세요.');
        return;
      }
      const token = config.token;
      const result = automatic ? (current.kind === 'quiz' ? await quizStep(snapshot, { token, active: () => config?.token === token && `${parseCourseUrl(location.href).key}:${new URL(location.href).searchParams.get('unitId')}` === key }) : missionStep(snapshot)) : { done: true, detail: '완료를 확인했습니다.' };
      if (result.attention) { await attention(snapshot, result.detail); return; }
      if (!result.done) {
        if (assessmentIdleMs() > 180_000) await attention(snapshot, '평가 화면이 3분 동안 진행되지 않았습니다. 재생 탭을 확인해 주세요.');
        else await report(snapshot, 'status', result.detail);
        return;
      }
    }
    const videoInProgress = observedPlaying && snapshot.video && !snapshot.video.ended && !endedAt;
    if (allComplete(snapshot) && !videoInProgress) {
      // Require the count to remain complete, rather than trusting a stale render after navigation.
      if (!completionSeenAt) completionSeenAt = now;
      if (now - completionSeenAt >= 4000 && now - enteredAt >= 5000) {
        await report(snapshot, 'done', '인프런에서 모든 수업의 완료를 확인했습니다.');
      } else await report(snapshot, 'status', '전체 수강 완료를 확인하고 있습니다.');
      return;
    }
    completionSeenAt = 0;
    if (snapshot.currentComplete && (!observedPlaying || endedAt > 0)) {
      // Already completed lessons can be skipped; a video newly marked complete still plays to its end.
      if (now - enteredAt >= 3000) await next(snapshot);
      return;
    }
    if (current?.locked) { await attention(snapshot, '이 수업의 수강 권한이 없습니다. 로그인과 수강 기간을 확인해 주세요.'); return; }
    if (current?.kind === 'live') {
      await attention(snapshot, '라이브 수업입니다. 수업 진행 상태를 확인해 주세요.');
      return;
    }
    const video = getVideo();
    if (video) {
      if (video !== lastVideo) {
        lastVideo = video;
        endedAt = 0;
        observedPlaying = false;
        lastTime = -1;
        lastMovementAt = now;
      }
      if (video.error) { await attention(snapshot, '영상 재생 오류가 발생했습니다. 강의실에서 재생 상태를 확인해 주세요.'); return; }
      video.muted = config.settings.muted;
      if (video.playbackRate !== config.settings.speed) video.playbackRate = config.settings.speed;
      // During native autoplay the URL changes before the old ended video is
      // replaced. An ended element we never played in this lesson is stale.
      if (video.ended && !observedPlaying) {
        if (now - lastMovementAt > 90_000) await attention(snapshot, '새 수업의 영상이 열리지 않았습니다. 재생 탭을 확인해 주세요.');
        else await report(snapshot, 'status', '새 수업의 영상을 기다리고 있습니다.');
        return;
      }
      if (video.ended) {
        if (!endedAt) endedAt = now;
        if (now - endedAt >= 4000 && !snapshot.currentComplete && now - lastConfirmAt >= 65_000 && !confirmedAt) {
          await confirm();
        }
        if (now - endedAt > 100_000) await attention(snapshot, '영상은 끝났지만 수강 완료 표시가 반영되지 않았습니다. ‘봤어요’와 진도율을 확인해 주세요.');
        else await report(snapshot, 'status', '영상이 끝났습니다. 수강 완료 표시를 기다리고 있습니다.');
        return;
      }
      endedAt = 0;
      if (video.currentTime > lastTime + 0.1) {
        if (lastTime >= 0) observedPlaying = true;
        lastTime = video.currentTime;
        lastMovementAt = now;
      }
      if (now - lastMovementAt > 90_000) { await attention(snapshot, '90초 동안 영상이 진행되지 않았습니다. 버퍼링 또는 재생 제한을 확인해 주세요.'); return; }
      if (video.paused && video.readyState >= 2) {
        try { await video.play(); }
        catch (error) {
          if (error instanceof DOMException && error.name === 'NotAllowedError') {
            await attention(snapshot, '자동 재생이 차단되었습니다. 강의실에서 재생을 한 번 누르거나 음소거를 켠 뒤 이어 재생해 주세요.');
            return;
          }
          if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
        }
      }
      if (!config) { video.pause(); return; }
      if (!video.paused && video.readyState >= 2) observedPlaying = true;
      await report(snapshot, 'status', video.readyState < 3 ? '영상을 불러오고 있습니다.' : '강의를 재생하고 있습니다.');
      return;
    }
    const elapsed = now - enteredAt;
    if (current?.kind === 'text' && elapsed > 10_000) {
      if (config.settings.textMode === 'pause') {
        await attention(snapshot, '자료 수업입니다. 내용을 확인하고 ‘봤어요’를 누른 뒤 이어 재생해 주세요.');
        return;
      }
      const wait = Math.max(config.settings.textWaitSeconds * 1000, 65_000 - (now - lastConfirmAt));
      if (elapsed >= wait && now - lastConfirmAt >= 65_000 && !confirmedAt) {
        await confirm();
      }
      if (elapsed > config.settings.textWaitSeconds * 1000 + 100_000) await attention(snapshot, '자료 수업의 완료 버튼을 확인할 수 없습니다. 강의실에서 직접 확인해 주세요.');
      else await report(snapshot, 'status', confirmedAt ? '자료 수업의 완료 표시를 기다리고 있습니다.' : `자료 수업 확인까지 ${Math.max(0, Math.ceil((wait - elapsed) / 1000))}초 남았습니다.`);
      return;
    }
    if (elapsed > 45_000) await attention(snapshot, '영상 또는 수업 정보를 찾지 못했습니다. 로그인 상태와 강의실 목차를 확인해 주세요.');
    else await report(snapshot, 'status', '강의실의 영상과 목차를 불러오고 있습니다.');
  } catch (error) {
    failed = true;
    failures++;
    if (failures >= 3) {
      getVideo()?.pause();
      try { await attention(readSnapshot(), `재생 제어 오류: ${error instanceof Error ? error.message : '확장 프로그램을 새로고침해 주세요.'}`); } catch { stop(); }
    }
  } finally { if (!failed) failures = 0; busy = false; }
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === 'RUN') run(message);
  if (message.type === 'STOP') stop();
  if (message.type === 'CHECK') void tick();
  respond({ ok: true });
});
setInterval(() => void tick(), 1000);
document.addEventListener('visibilitychange', () => void tick());
window.addEventListener('pagehide', () => { if (config) getVideo()?.pause(); });
void chrome.runtime.sendMessage({ type: 'HELLO' }).then(reply => {
  if (reply.ok && reply.data.type === 'RUN') run(reply.data);
}).catch(() => undefined);
