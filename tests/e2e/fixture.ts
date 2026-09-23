import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { State } from '../../src/model.ts';

export const test = base.extend<{ context: BrowserContext; dashboard: Page; extensionId: string }>({
  context: async ({}, use) => {
    const extension = resolve('dist');
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      viewport: { width: 1280, height: 1000 },
    });
    const video = await readFile(resolve('tests/fixtures/lesson.webm'));
    await context.route(/https:\/\/(www|biz)\.inflearn\.com\//, async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/fixture.webm') { await route.fulfill({ contentType: 'video/webm', body: video }); return; }
      if (url.pathname === '/favicon.ico') { await route.fulfill({ status: 204 }); return; }
      if (url.pathname === '/signin') {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ko"><title>로그인 - 인프런</title><button id="signin">로그인 완료</button><script>document.getElementById("signin").onclick=()=>{document.cookie="signed-in=yes; Domain=.inflearn.com; Path=/; SameSite=Lax";document.body.dataset.signedIn="yes"}</script></html>' });
        return;
      }
      if (url.pathname === '/not-found') {
        await route.fulfill({ status: 404, contentType: 'text/html', body: '<!doctype html><html lang="ko"><title>찾을 수 없음</title><p>404 Error Page Not Found</p></html>' });
        return;
      }
      const names = ['alpha', 'beta', 'long', 'text', 'quiz', 'native-next', 'unconfirmed', 'text-auto', 'gamma', 'quiz-auto', 'mission-draft', 'mission-review', 'quiz-spa', 'auth-redirect', 'not-found'];
      const slug = url.searchParams.get('courseSlug') || names[Number(url.searchParams.get('courseId')) - 101] || 'alpha';
      if (slug === 'auth-redirect' && !route.request().headers().cookie?.includes('signed-in=yes')) {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ko"><title>로그인 확인</title><script>location.replace("https://www.inflearn.com/signin")</script></html>' });
        return;
      }
      if (slug === 'not-found') {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ko"><title>강의실 확인</title><script>location.replace("https://biz.inflearn.com/not-found")</script></html>' });
        return;
      }
      if (url.pathname === '/course/lecture' && !url.searchParams.has('courseId')) {
        const redirect = new URL('/courses/lecture', url.origin);
        redirect.searchParams.set('courseId', String(names.indexOf(slug) + 101));
        redirect.searchParams.set('courseSlug', slug);
        redirect.searchParams.set('unitId', String(Number(url.searchParams.get('unitId'))));
        await route.fulfill({ contentType: 'text/html', body: `<html><head><script>setTimeout(() => location.replace(${JSON.stringify(redirect.href)}), 250)</script></head><body>강의실을 불러오는 중</body></html>` });
        return;
      }
      if (url.searchParams.get('unitId') === 'NaN') {
        await route.fulfill({ contentType: 'text/html', body: '<html><body>올바른 수업 주소가 필요합니다.</body></html>' });
        return;
      }
      await route.fulfill({ contentType: 'text/html', body: slug === 'quiz-auto' || slug === 'quiz-spa' || slug.startsWith('mission-') ? assessmentClassroom(slug) : classroom(slug) });
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await use(new URL(worker.url()).host);
  },
  dashboard: async ({ context, extensionId }, use, testInfo) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/dashboard.html`);
    await page.locator('.player[aria-busy="false"]').waitFor();
    await use(page);
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('queue-state', { body: JSON.stringify(await state(page), null, 2), contentType: 'application/json' });
      await page.screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true });
    }
  },
});

function assessmentClassroom(slug: string) {
  const isQuiz = slug.startsWith('quiz-');
  return `<!doctype html><html lang="ko"><head><meta charset="UTF-8"><title>${slug} | 학습 페이지</title><style>body{font-family:sans-serif}button{padding:12px}svg{width:16px;height:16px}</style></head><body>
  <main><div><span>진도율</span><p>1 / 1</p></div><div><span>${isQuiz ? '퀴즈' : '미션'}</span><p id="count">0 / 1</p></div><section id="exam"></section></main>
  <aside><ul><li data-unit-id="1"><span class="unit-icon"><svg data-icon="circle-check"></svg></span><span class="unit-title">완료된 영상</span><p>00:02</p></li><li data-unit-id="2"><span class="unit-icon" id="icon"><svg data-icon="fire"></svg></span><span class="unit-title">평가</span><p>${isQuiz ? 'AI 퀴즈' : '미션'}</p></li></ul></aside>
  <script>
  const slug = ${JSON.stringify(slug)};
  const url = new URL(location.href);
  if(slug !== 'quiz-spa'){url.searchParams.set('unitId','2'); history.replaceState({},'',url);}
  const exam = document.getElementById('exam');
  const questions = [{title:'문항 하나: 옳은 선택은?',choices:['Amazon S3','Amazon EBS','Amazon EC2','Amazon EFS'],correct:'Amazon EFS'}, {title:'문항 둘: 옳은 선택은?',choices:['다른 오답','정답 둘','세번째 오답','네번째 오답'],correct:'정답 둘'}];
  let attempt = 0, index = 0, selected = '', submitted = false;
  const passed = new Set();
  function mark() {document.getElementById('count').textContent='1 / 1';document.getElementById('icon').innerHTML='<svg data-icon="circle-check"></svg>';}
  function results() {
    mark(); document.body.dataset.attempts=String(attempt); document.body.dataset.correct=String(passed.size);
    exam.innerHTML='<p>퀴즈 점수 '+passed.size+'/2</p><button data-dd-action-name="퀴즈결과화면 오답풀기" '+(passed.size===2 || attempt===5?'disabled':'')+'>오답 풀기 '+(5-attempt)+'회 남음</button><button>전체 문항 보기</button>';
    exam.querySelector('button').onclick=()=>{attempt++;index=0;selected='';submitted=false;render();};
  }
  function render() {
    while(passed.has(index)) index++;
    if(index>=questions.length){results();return;}
    const q=questions[index]; const choices=attempt%2 ? [...q.choices].reverse() : q.choices;
    exam.innerHTML='<div><h3>'+q.title+'</h3><div role="radiogroup">'+choices.map((c,i)=>'<button role="radio" aria-checked="'+(selected===c)+'" data-choice="'+c+'"><span>'+(submitted && selected===c ? '' : String.fromCharCode(65+i))+'</span> <p>'+c+'</p></button>').join('')+'</div></div>'+(submitted?'<p>'+(selected===q.correct?'정답입니다!':'오답이에요.')+'</p>':'')+'<button data-dd-action-name="'+(submitted?(index===questions.length-1?'마지막 문항 완료':'다음 문항으로 이동'):'문항 제출')+'" '+(!selected?'disabled':'')+'>'+(submitted?'다음':'제출')+'</button>';
    exam.querySelectorAll('[role=radio]').forEach(b=>b.onclick=()=>{if(!submitted){selected=b.dataset.choice;render();}});
    exam.querySelector('[data-dd-action-name]').onclick=()=>{if(!submitted){submitted=true;render();}else{if(selected===q.correct)passed.add(index);index++;selected='';submitted=false;render();}};
  }
  function startQuiz(){exam.innerHTML='<button>퀴즈 생성하기</button>';exam.querySelector('button').onclick=render;}
  if(slug==='quiz-spa'){
    exam.innerHTML='<p>완료된 영상입니다.</p>';
    document.querySelector('[data-unit-id="2"]').onclick=()=>{url.searchParams.set('unitId','2');history.pushState({},'',url);startQuiz();};
  }
  else if(slug==='quiz-auto'){startQuiz();}
  else {
    exam.innerHTML='<div role="alert">작성 중인 결과물이 있어요.</div><button>이어 작성하기</button>';
    exam.querySelector('button').onclick=()=>{exam.innerHTML='<div role="dialog"><input name="title" value="작성해 둔 제목"><textarea name="body">작성해 둔 미션 본문</textarea><button>제출하기</button></div>';exam.querySelector('button').onclick=()=>{document.body.dataset.submissions=String(Number(document.body.dataset.submissions||0)+1);exam.innerHTML='<div role="alert">제출을 완료했어요. 내용을 지식공유자가 살펴본 뒤 피드백을 전달해드릴게요.</div>';if(slug==='mission-draft')mark();};};
  }
  </script></body></html>`;
}

export async function state(page: Page): Promise<State> {
  return page.evaluate(async () => (await chrome.storage.local.get('rururu')).rururu as State);
}

function classroom(slug: string) {
  const kind = slug.startsWith('text') ? 'text' : slug === 'quiz' ? 'quiz' : 'video';
  const total = slug === 'text-auto' ? 1 : 2;
  return `<!doctype html><html lang="ko"><head><meta charset="UTF-8"><title>${slug} 강좌 - 인프런</title>
  <style>body{font-family:sans-serif}video{width:640px;height:360px}button{padding:12px}li{padding:16px;cursor:pointer}.unit-icon svg{width:16px;height:16px}</style></head><body>
  <main><h1>${slug} 강좌 (자동 테스트용 강의실)</h1><div id="counts"><span>진도율</span><p><span id="completed">0</span><span> / ${total}</span></p><p id="percent">0%</p></div><div id="player"></div></main>
  <aside><ul id="units"></ul></aside><footer aria-label="영상 하단 컨테이너"><button id="next">다음</button><button id="watched">봤어요</button></footer>
  <script>
    const slug = ${JSON.stringify(slug)};
    const kind = ${JSON.stringify(kind)};
    const total = ${total};
    const done = new Set(JSON.parse(sessionStorage.getItem('done:' + slug) || '[]'));
    let current = new URL(location.href).searchParams.get('unitId');
    if (!['1','2'].includes(current)) current = '1';
    function renderCounts() {
      document.getElementById('completed').textContent = done.size;
      document.getElementById('percent').textContent = Math.round(done.size / total * 100) + '%';
      document.getElementById('units').innerHTML = (total === 1 ? ['1'] : ['1','2']).map(id => '<li data-unit-id="' + id + '"><span class="unit-icon"><svg data-icon="' + (done.has(id) ? 'circle-check' : kind === 'text' ? 'memo' : 'circle-play') + '"></svg></span><span class="unit-title">' + id + '. 테스트 수업</span><p>' + (kind === 'quiz' ? 'AI 퀴즈' : kind === 'text' ? '수업 자료' : '0:02') + '</p></li>').join('');
      document.querySelectorAll('[data-unit-id]').forEach(row => row.addEventListener('click', () => navigate(row.dataset.unitId)));
      document.getElementById('watched').innerHTML = (done.has(current) ? '<svg data-icon="circle-check"></svg>' : '') + '봤어요';
      document.getElementById('next').disabled = current === String(total);
    }
    function complete() {
      document.body.dataset.confirmedAt = String(Date.now());
      done.add(current); sessionStorage.setItem('done:' + slug, JSON.stringify([...done])); renderCounts();
    }
    function navigate(id) {
      current = id;
      const url = new URL(location.href);url.searchParams.set('unitId',id);history.pushState({},'',url);
      renderCounts();
      const container = document.getElementById('player');
      const renderPlayer = () => {
      container.innerHTML = kind === 'video' ? '<div class="shaka-video-container"><video muted src="/fixture.webm"></video></div>' : '<p>' + (kind === 'quiz' ? '퀴즈 풀기' : '직접 읽는 자료 수업') + '</p>';
      const video = document.querySelector('video');
      if (video) {
        if (slug === 'long') video.loop = true;
        video.addEventListener('ended', () => {
          if (slug === 'unconfirmed') return;
          setTimeout(() => {complete(); if (slug === 'native-next' && current === '1') navigate('2');}, 200);
        });
      }
      };
      // Inflearn can update the URL and curriculum before replacing the old
      // ended media. The runner must not carry that ending into the new unit.
      if (slug === 'native-next' && container.querySelector('video')?.ended) setTimeout(renderPlayer, 2500);
      else renderPlayer();
    }
    document.getElementById('next').onclick = () => navigate('2');
    document.getElementById('watched').onclick = () => {
      document.body.dataset.confirmClicks = String(Number(document.body.dataset.confirmClicks || 0) + 1);
      if (slug !== 'unconfirmed') complete();
    };
    navigate(current);
  </script></body></html>`;
}
