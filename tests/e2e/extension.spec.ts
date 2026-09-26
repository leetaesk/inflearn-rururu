import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test, state } from './fixture.ts';
import type { QuizMemory } from '../../src/model.ts';

test('dismisses repeated review prompts before the next lesson and next course', async ({ dashboard, context }) => {
  await dashboard.locator('#urls').fill('https://biz.inflearn.com/courses/lecture?courseId=116&unitId=1\nhttps://biz.inflearn.com/courses/lecture?courseId=101&unitId=1');
  await dashboard.getByRole('button', { name: '대기열에 추가', exact: true }).click();
  const opened = context.waitForEvent('page');
  await dashboard.locator('#start').click();
  const player = await opened;
  await expect.poll(async () => (await state(dashboard)).run.status, { timeout: 40_000 }).toBe('done');
  expect((await state(dashboard)).courses.map(course => course.status)).toEqual(['done', 'done']);
  expect(await player.evaluate(() => sessionStorage.getItem('review-dismissals'))).toBe('2');
  expect(await player.evaluate(() => sessionStorage.getItem('review-submissions'))).toBeNull();
  expect(await player.evaluate(() => sessionStorage.getItem('review-blocked-navigation'))).toBeNull();
});

test('leaves unrelated later buttons and paused review prompts untouched', async ({ dashboard, context }) => {
  await dashboard.locator('#urls').fill('https://www.inflearn.com/courses/lecture?courseId=103&unitId=1');
  await dashboard.getByRole('button', { name: '대기열에 추가', exact: true }).click();
  const opened = context.waitForEvent('page');
  await dashboard.locator('#start').click();
  const player = await opened;
  await expect.poll(() => player.evaluate(() => !!document.querySelector('video') && !document.querySelector('video')!.paused)).toBe(true);
  await player.evaluate(() => {
    const prompt = document.createElement('div');
    prompt.id = 'other-prompt'; prompt.setAttribute('role', 'dialog');
    prompt.style.cssText = 'position:fixed;inset:0;background:white;z-index:1000';
    prompt.innerHTML = '<h2>학습 알림 설정</h2><button>다음에</button>';
    prompt.querySelector('button')!.onclick = () => prompt.remove();
    document.body.append(prompt);
  });
  await player.waitForTimeout(2500);
  await expect(player.locator('#other-prompt')).toBeVisible();
  await dashboard.locator('#pause').click();
  await player.locator('#other-prompt h2').evaluate(node => { node.textContent = '힘이 되는 수강평을 남겨주세요!'; });
  await player.waitForTimeout(2500);
  await expect(player.locator('#other-prompt')).toBeVisible();
  await dashboard.locator('#start').click();
  await expect(player.locator('#other-prompt')).toHaveCount(0);
  await dashboard.locator('#pause').click();
});

test('login redirect offers official sign-in and resumes the same course after login', async ({ dashboard, context }) => {
  const loginOpened = context.waitForEvent('page');
  await dashboard.locator('#login').click();
  const loginPage = await loginOpened;
  await expect(loginPage).toHaveURL('https://www.inflearn.com/signin');
  await loginPage.close();
  await dashboard.locator('#urls').fill('https://biz.inflearn.com/courses/lecture?courseId=114&unitId=1');
  await dashboard.getByRole('button', { name: '대기열에 추가', exact: true }).click();
  const opened = context.waitForEvent('page');
  await dashboard.locator('#start').click();
  const player = await opened;
  await expect(dashboard.locator('#run-detail')).toContainText('인프런 로그인이 필요합니다.');
  expect((await state(dashboard)).courses[0].status).toBe('attention');
  await dashboard.locator('#login').click();
  await expect(player).toHaveURL('https://www.inflearn.com/signin');
  await expect(player.locator('#signin')).toBeVisible({ timeout: 5000 });
  await player.locator('#signin').click();
  await expect(player.locator('body')).toHaveAttribute('data-signed-in', 'yes');
  await dashboard.locator('#start').click();
  await expect.poll(async () => (await state(dashboard)).run.status, { timeout: 45_000 }).toBe('done');
  expect((await state(dashboard)).courses[0].progress).toEqual({ completed: 2, total: 2 });
});

test('404 classroom shows an address error and repairs the queued course in place', async ({ dashboard, context }) => {
  await dashboard.locator('#urls').fill('https://biz.inflearn.com/courses/lecture?courseId=115&unitId=1');
  await dashboard.getByRole('button', { name: '대기열에 추가', exact: true }).click();
  const opened = context.waitForEvent('page');
  await dashboard.locator('#start').click();
  const player = await opened;
  await expect(player).toHaveURL('https://biz.inflearn.com/not-found');
  await expect(dashboard.locator('#run-detail')).toContainText('강의실 주소를 찾지 못했습니다(404)');
  await dashboard.getByRole('button', { name: '강좌 115 강의실 주소 수정' }).click();
  const field = dashboard.locator('.course-url-editor input');
  await expect(field).toHaveValue(/courseId=115/);
  await dashboard.screenshot({ path: 'test-results/address-repair-light.png', fullPage: true });
  expect((await new AxeBuilder({ page: dashboard }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await dashboard.locator('#theme').click();
  await dashboard.setViewportSize({ width: 320, height: 850 });
  expect(await dashboard.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dashboard.screenshot({ path: 'test-results/address-repair-mobile-dark.png', fullPage: true });
  await field.fill('https://biz.inflearn.com/courses/lecture?courseId=101&unitId=1');
  await dashboard.getByRole('button', { name: '주소 저장' }).click();
  expect((await state(dashboard)).courses[0].key).toBe('id:101');
  await dashboard.locator('#start').click();
  await expect.poll(async () => (await state(dashboard)).run.status, { timeout: 40_000 }).toBe('done');
  expect((await state(dashboard)).courses[0].progress).toEqual({ completed: 2, total: 2 });
});

test('quiz automation survives same-document navigation from a lesson', async ({ dashboard, context }) => {
  await dashboard.locator('#urls').fill('https://biz.inflearn.com/courses/lecture?courseId=113&unitId=1');
  await dashboard.getByRole('button', { name: '대기열에 추가', exact: true }).click();
  const opened = context.waitForEvent('page');
  await dashboard.locator('#start').click();
  const player = await opened;
  await player.waitForURL('**unitId=2**');
  await expect(player.getByText('오답이에요.', { exact: true })).toBeVisible({ timeout: 15_000 });
  expect((await state(dashboard)).run.status).toBe('running');
  await dashboard.locator('#pause').click();
});

test('biz classroom completes quizzes using feedback across shuffled retries before advancing', async ({ dashboard, context }) => {
  await dashboard.locator('#urls').fill('https://biz.inflearn.com/courses/lecture?courseId=110&unitId=2');
  await dashboard.getByRole('button', { name: '대기열에 추가', exact: true }).click();
  const opened = context.waitForEvent('page');
  await dashboard.locator('#start').click();
  const player = await opened;
  await player.waitForURL('https://biz.inflearn.com/**');
  expect(new URL(player.url()).searchParams.get('tab')).toBe('curriculum');
  await expect(player.getByText('오답이에요.', { exact: true })).toBeVisible();
  await dashboard.locator('#pause').click();
  expect((await state(dashboard)).run.status).toBe('paused');
  await dashboard.locator('#start').click();
  await expect.poll(async () => (await state(dashboard)).run.status, { timeout: 70_000 }).toBe('done');
  expect(await player.locator('body').getAttribute('data-correct')).toBe('2');
  expect(Number(await player.locator('body').getAttribute('data-attempts'))).toBeGreaterThan(0);
  const result = await state(dashboard);
  expect(result.courses[0].quizzes).toEqual({ completed: 1, total: 1 });
  expect(result.courses[0].title).toBe('quiz-auto');
  const memory = await dashboard.evaluate(async () => (await chrome.storage.local.get('quizMemory')).quizMemory as Record<string, QuizMemory>);
  expect(Object.keys(memory)).toHaveLength(2);
  expect(Object.values(memory).every(entry => entry.correct && entry.wrong.length)).toBe(true);
});

test('reopens a closed curriculum even when hidden lesson rows remain mounted', async ({ dashboard, context }) => {
  await dashboard.locator('#urls').fill('https://www.inflearn.com/courses/lecture?courseId=103&unitId=1');
  await dashboard.getByRole('button', { name: '대기열에 추가', exact: true }).click();
  const opened = context.waitForEvent('page');
  await dashboard.locator('#start').click();
  const player = await opened;
  await expect(dashboard.locator('.course-meta')).toContainText('0 / 2');
  await player.evaluate(() => {
    const counts = document.getElementById('counts')!;
    counts.remove();
    const url = new URL(location.href); url.searchParams.set('tab', 'none'); history.pushState({}, '', url);
    const sidebar = document.querySelector<HTMLElement>('aside')!;
    sidebar.style.display = 'none';
    const toggle = document.createElement('button'); toggle.textContent = '커리큘럼';
    toggle.onclick = () => { document.querySelector('main')!.prepend(counts); sidebar.style.display = ''; url.searchParams.set('tab', 'curriculum'); history.pushState({}, '', url); };
    document.body.append(toggle);
  });
  await expect(player.locator('#counts')).toBeVisible({ timeout: 15_000 });
  expect(new URL(player.url()).searchParams.get('tab')).toBe('curriculum');
  await expect(dashboard.locator('.course-meta')).toContainText('0 / 2');
  await dashboard.locator('#pause').click();
});

test('saved mission drafts submit once and instructor review is never counted complete', async ({ dashboard, context }) => {
  await dashboard.locator('#urls').fill('https://biz.inflearn.com/courses/lecture?courseId=111&unitId=2\nhttps://biz.inflearn.com/courses/lecture?courseId=112&unitId=2');
  await dashboard.getByRole('button', { name: '대기열에 추가', exact: true }).click();
  const opened = context.waitForEvent('page');
  await dashboard.locator('#start').click();
  const player = await opened;
  await expect(dashboard.locator('#run-detail')).toContainText('강사의 검토', { timeout: 35_000 });
  const result = await state(dashboard);
  expect(result.courses.map(course => course.status)).toEqual(['done', 'attention']);
  expect(result.courses[1].missions).toEqual({ completed: 0, total: 1 });
  expect(await player.locator('body').getAttribute('data-submissions')).toBe('1');
});

test('real extension plays two courses, confirms counts, and reuses one playback tab', async ({ dashboard, context }) => {
  const errors: string[] = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await dashboard.locator('#urls').fill('https://www.inflearn.com/course/alpha\nhttps://www.inflearn.com/course/beta');
  await dashboard.getByRole('button', { name: '대기열에 추가', exact: true }).click();
  await expect(dashboard.locator('.course')).toHaveCount(2);
  await dashboard.locator('#start').click();
  await dashboard.locator('#focus').click();
  await expect.poll(async () => (await state(dashboard)).run.status, { timeout: 65_000 }).toBe('done');
  const result = await state(dashboard);
  expect(result.courses.map(course => course.status)).toEqual(['done', 'done']);
  expect(result.courses.map(course => course.progress)).toEqual([{ completed: 2, total: 2 }, { completed: 2, total: 2 }]);
  expect(context.pages().filter(page => page.url().startsWith('https://www.inflearn.com/'))).toHaveLength(1);
  expect(errors).toEqual([]);
  await dashboard.locator('#clear-done').click();
  await expect(dashboard.locator('#empty')).toBeVisible();
});

test('video ending without a site completion check stays incomplete', async ({ dashboard, context }) => {
  await dashboard.locator('#urls').fill('https://www.inflearn.com/course/unconfirmed');
  await dashboard.getByRole('button', { name: '대기열에 추가', exact: true }).click();
  const opened = context.waitForEvent('page');
  await dashboard.locator('#start').click();
  const player = await opened;
  await player.waitForURL('https://www.inflearn.com/**');
  await expect.poll(() => player.locator('body').getAttribute('data-confirm-clicks')).toBe('1');
  const result = await state(dashboard);
  expect(result.courses[0].status).toBe('playing');
  expect(result.courses[0].progress?.completed).toBe(0);
  expect(player.url()).toContain('unitId=1');
  await dashboard.locator('#pause').click();
  expect((await state(dashboard)).courses[0].status).toBe('paused');
});

test('text auto confirmation waits 65 seconds and only then completes', async ({ dashboard, context }) => {
  await dashboard.locator('#urls').fill('https://www.inflearn.com/course/text-auto');
  await dashboard.getByRole('button', { name: '대기열에 추가', exact: true }).click();
  await dashboard.locator('#text-mode').selectOption('confirm');
  await dashboard.getByRole('button', { name: '설정 저장' }).click();
  const opened = context.waitForEvent('page');
  const startedAt = Date.now();
  await dashboard.locator('#start').click();
  const player = await opened;
  await player.waitForURL('https://www.inflearn.com/**');
  await expect(dashboard.locator('#run-detail')).toContainText('자료 수업 확인까지', { timeout: 25_000 });
  expect(await player.locator('body').getAttribute('data-confirm-clicks')).toBeNull();
  await expect.poll(async () => (await state(dashboard)).run.status, { timeout: 75_000 }).toBe('done');
  const confirmedAt = Number(await player.locator('body').getAttribute('data-confirmed-at'));
  expect(confirmedAt - startedAt).toBeGreaterThanOrEqual(65_000);
  expect((await state(dashboard)).lastConfirmAt).toBeGreaterThanOrEqual(startedAt + 65_000);
  expect((await state(dashboard)).courses[0].progress).toEqual({ completed: 1, total: 1 });
});

test('pause, resume, settings, tab closure, deferral and retry preserve the queue', async ({ dashboard, context }) => {
  await dashboard.locator('#urls').fill('https://www.inflearn.com/course/long\nhttps://www.inflearn.com/course/alpha');
  await dashboard.getByRole('button', { name: '대기열에 추가', exact: true }).click();
  await dashboard.locator('#speed').selectOption('1.5');
  await dashboard.locator('#keep-awake').uncheck();
  await dashboard.getByRole('button', { name: '설정 저장' }).click();
  await expect(dashboard.locator('#settings-status')).toHaveText('설정을 저장했습니다.');
  const opened = context.waitForEvent('page');
  await dashboard.locator('#start').click();
  const player = await opened;
  await player.waitForURL('https://www.inflearn.com/**');
  await expect.poll(() => player.locator('video').evaluate(video => (video as HTMLVideoElement).paused)).toBe(false);
  expect(await player.locator('video').evaluate(video => (video as HTMLVideoElement).playbackRate)).toBe(1.5);
  await dashboard.locator('#pause').click();
  await expect.poll(() => player.locator('video').evaluate(video => (video as HTMLVideoElement).paused)).toBe(true);
  await dashboard.reload();
  await expect(dashboard.locator('#start')).toHaveText('이어 재생');
  await dashboard.locator('#start').click();
  await expect.poll(() => player.locator('video').evaluate(video => (video as HTMLVideoElement).paused)).toBe(false);
  await player.close();
  await expect(dashboard.locator('#run-status')).toHaveText('확인 필요');
  await dashboard.locator('#start').click();
  await expect(dashboard.locator('#run-status')).toHaveText('재생 중');
  await dashboard.locator('#skip').click();
  await expect.poll(async () => (await state(dashboard)).courses[1].status, { timeout: 40_000 }).toBe('done');
  await expect(dashboard.locator('#run-status')).toHaveText('확인 필요');
  expect((await state(dashboard)).courses[0].status).toBe('attention');
  await dashboard.getByRole('button', { name: /long 강좌 다시 대기열에 넣기/ }).click();
  expect((await state(dashboard)).courses[0].status).toBe('queued');
});

test('text and quiz lessons request attention and native autoplay does not skip a lesson', async ({ dashboard }) => {
  await dashboard.locator('#urls').fill('https://www.inflearn.com/course/text\nhttps://www.inflearn.com/course/quiz\nhttps://www.inflearn.com/course/native-next');
  await dashboard.getByRole('button', { name: '대기열에 추가', exact: true }).click();
  await dashboard.locator('#quiz-mode').selectOption('pause');
  await dashboard.getByRole('button', { name: '설정 저장' }).click();
  await dashboard.locator('#start').click();
  await expect(dashboard.locator('#run-detail')).toContainText('자료 수업입니다', { timeout: 25_000 });
  await dashboard.locator('#skip').click();
  await expect(dashboard.locator('#run-detail')).toContainText('퀴즈·미션 자동 진행');
  await dashboard.locator('#skip').click();
  await expect.poll(async () => (await state(dashboard)).courses[2].status, { timeout: 40_000 }).toBe('done');
  const result = await state(dashboard);
  expect(result.courses.map(course => course.status)).toEqual(['attention', 'attention', 'done']);
});

test('all queue controls and help work, layouts and accessibility pass in both themes', async ({ dashboard, context }) => {
  await dashboard.screenshot({ path: 'test-results/empty-light.png', fullPage: true });
  await expect(dashboard.locator('#empty')).toBeVisible();
  await dashboard.locator('#urls').fill('https://evil.test/course/alpha');
  await dashboard.getByRole('button', { name: '대기열에 추가', exact: true }).click();
  await expect(dashboard.getByRole('alert')).toContainText('주소만');
  await dashboard.locator('#urls').fill('https://www.inflearn.com/course/alpha\nhttps://www.inflearn.com/course/beta\nhttps://www.inflearn.com/course/alpha');
  await dashboard.getByRole('button', { name: '대기열에 추가', exact: true }).click();
  await expect(dashboard.locator('.course')).toHaveCount(2);
  await dashboard.getByRole('button', { name: 'alpha 아래로 이동', exact: true }).click();
  await expect(dashboard.locator('.course-title').first()).toHaveText('beta');
  await dashboard.getByRole('button', { name: 'alpha 위로 이동', exact: true }).click();
  await expect(dashboard.locator('.course-title').first()).toHaveText('alpha');
  await dashboard.getByRole('button', { name: 'beta 대기열에서 삭제' }).click();
  await expect(dashboard.locator('.course')).toHaveCount(1);
  const source = await context.newPage();
  await source.goto('https://www.inflearn.com/course/lecture?courseSlug=gamma&unitId=1');
  await dashboard.locator('#import-tabs').click();
  await expect(dashboard.locator('.course')).toHaveCount(2);
  await source.close();
  await dashboard.locator('#text-mode').selectOption('confirm');
  await expect(dashboard.locator('#text-wait-row')).toBeVisible();
  await dashboard.locator('#text-wait').fill('90');
  await dashboard.locator('#muted').uncheck();
  await dashboard.locator('#mission-mode').selectOption('pause');
  await dashboard.getByRole('button', { name: '설정 저장' }).click();
  expect((await state(dashboard)).settings.textWaitSeconds).toBe(90);
  expect((await state(dashboard)).settings.missionMode).toBe('pause');
  await dashboard.locator('summary').click();
  await expect(dashboard.locator('#logs')).toBeVisible();
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await dashboard.locator('#theme').click();
    for (const width of [1280, 760, 390, 320]) {
      await dashboard.setViewportSize({ width, height: 1000 });
      expect(await dashboard.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await dashboard.setViewportSize({ width: 1280, height: 1000 });
    const violations = (await new AxeBuilder({ page: dashboard }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations;
    expect(violations).toEqual([]);
    await dashboard.screenshot({ path: `test-results/queue-${theme}.png`, fullPage: true });
  }
  await dashboard.setViewportSize({ width: 390, height: 1000 });
  await dashboard.screenshot({ path: 'test-results/mobile-dark.png', fullPage: true });
  await dashboard.keyboard.press('Tab');
  expect(await dashboard.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).not.toBe('none');
  const helpPage = context.waitForEvent('page');
  await dashboard.getByRole('link', { name: '설치와 사용 안내' }).click();
  const help = await helpPage;
  await expect(help.getByRole('heading', { name: '루루루 사용 안내' })).toBeVisible();
  await help.getByRole('link', { name: '대기열로 돌아가기' }).click();
  await expect(help.locator('.course')).toHaveCount(2);
});
