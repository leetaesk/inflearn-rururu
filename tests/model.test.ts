import test from 'node:test';
import assert from 'node:assert/strict';
import { allComplete, chooseAnswer, defaults, isComplete, newCourse, parseCourseUrl, progressPercent, validateSettings, type Snapshot } from '../src/model.ts';

test('accepts current and legacy classrooms, localized URLs, and course introductions', () => {
  assert.equal(parseCourseUrl('https://www.inflearn.com/courses/lecture?courseId=123&unitId=456').key, 'id:123');
  const legacy = parseCourseUrl('https://www.inflearn.com/course/lecture?courseSlug=hello&unitId=456&tracking=private');
  assert.equal(legacy.key, 'slug:hello');
  assert.equal(new URL(legacy.url).searchParams.has('tracking'), false);
  assert.equal(parseCourseUrl('https://inflearn.com/en/course/hello/curriculum').key, legacy.key);
  assert.equal(new URL(parseCourseUrl('https://www.inflearn.com/course/한글-강좌').url).searchParams.get('courseSlug'), '한글-강좌');
  assert.equal(parseCourseUrl('https://www.inflearn.com/courses/lecture?courseId=123&courseSlug=hello&unitId=NaN').url, 'https://www.inflearn.com/courses/lecture?courseId=123&unitId=current');
  assert.equal(parseCourseUrl('https://biz.inflearn.com/courses/lecture?courseId=123&unitId=456').url, 'https://biz.inflearn.com/courses/lecture?courseId=123&unitId=456');
  assert.equal(parseCourseUrl('https://biz.inflearn.com/course/hello/dashboard?cid=123').url, 'https://biz.inflearn.com/courses/lecture?courseId=123&unitId=current');
});

test('100% lecture progress does not hide unfinished quizzes or missions', () => {
  const snapshot = { progress: { completed: 19, total: 19 }, quizzes: { completed: 3, total: 4 }, units: [] } as unknown as Snapshot;
  assert.equal(allComplete(snapshot), false);
  snapshot.quizzes = { completed: 4, total: 4 };
  assert.equal(allComplete(snapshot), true);
  snapshot.units = [{ id: '1', kind: 'mission', title: 'assignment', locked: false, complete: false }];
  assert.equal(allComplete(snapshot), false);
});

test('quiz correction uses choice text despite shuffled order and never repeats known wrong answers', () => {
  assert.equal(chooseAnswer(['wrong', 'right'], { correct: null, wrong: ['wrong'] }), 'right');
  assert.equal(chooseAnswer(['other', 'right', 'wrong'], { correct: 'right', wrong: ['wrong'] }), 'right');
  assert.equal(chooseAnswer(['a', 'b'], { correct: null, wrong: ['b', 'a'] }), null);
});

test('rejects lookalike domains, login credentials, ports, scripts, and non-course URLs', () => {
  for (const url of ['https://www.inflearn.com.evil.test/course/a', 'https://evil.test/?courseSlug=a', 'javascript:alert(1)', 'http://www.inflearn.com/course/a', 'https://user:secret@www.inflearn.com/course/a', 'https://www.inflearn.com:123/course/a', 'https://www.inflearn.com/my-courses', 'https://www.inflearn.com/course/lecture']) {
    assert.throws(() => parseCourseUrl(url), url);
  }
});

test('does not round an incomplete course up to 100%', () => {
  assert.equal(progressPercent({ completed: 999, total: 1000 }), 99);
  assert.equal(isComplete({ completed: 999, total: 1000 }), false);
  assert.equal(isComplete({ completed: 0, total: 0 }), false);
  assert.equal(isComplete(null), false);
  assert.equal(isComplete({ completed: 2, total: 2 }), true);
  assert.equal(isComplete({ completed: 2.5, total: 2.5 }), false);
});

test('settings constrain supported playback speed and completion interval', () => {
  const settings = defaults().settings;
  assert.deepEqual(validateSettings(settings), settings);
  assert.throws(() => validateSettings({ ...settings, speed: 100 }));
  assert.throws(() => validateSettings({ ...settings, textWaitSeconds: 1 }));
  assert.throws(() => validateSettings({ ...settings, textWaitSeconds: 65.5 }));
  assert.throws(() => validateSettings({ ...settings, muted: 'true' as unknown as boolean }));
});

test('new courses have no fabricated progress and canonical keys allow deduplication', () => {
  const a = newCourse('https://www.inflearn.com/course/example');
  const b = newCourse('https://www.inflearn.com/course/lecture?courseSlug=example&unitId=45');
  assert.equal(a.key, b.key);
  assert.notEqual(a.id, b.id);
  assert.equal(a.progress, null);
  assert.equal(a.status, 'queued');
});
