import { describe, expect, it } from 'vitest';
import {
  COMMENT_MAX,
  PICKS_MAX,
  activeNotice,
  activePicks,
  cleanLink,
  cleanNotice,
  cleanPicks,
  noticeId,
  parseNotice,
  parsePicks,
  serializeNotice,
  serializePicks,
} from '../src/lib/editorial-core.ts';

const notice = {
  id: 'n1',
  text: 'メンテナンスのお知らせ',
  url: '/about/',
  level: 'info',
  start: '2026-10-07T00:00:00.000Z',
  end: '2026-10-08T00:00:00.000Z',
  updatedAt: '2026-10-07T00:00:00.000Z',
};

describe('お知らせ', () => {
  it('形を確かめ、掲載期間のうちだけ載せる', () => {
    const parsed = parseNotice(serializeNotice(cleanNotice(notice)!));
    expect(parsed).toEqual(notice);
    expect(activeNotice(parsed, Date.parse('2026-10-07T12:00:00Z'))).toEqual(notice);
    expect(activeNotice(parsed, Date.parse('2026-10-08T00:00:00Z'))).toBeUndefined();
    expect(activeNotice(parsed, Date.parse('2026-10-06T23:59:00Z'))).toBeUndefined();
    expect(cleanNotice({ ...notice, text: '' })).toBeUndefined();
    expect(cleanNotice({ ...notice, end: notice.start })).toBeUndefined();
    expect(cleanNotice({ ...notice, level: 'weird', id: 'Bad ID!' })).toMatchObject({ level: 'info', id: 'notice' });
    expect(cleanNotice({ ...notice, text: 'あ'.repeat(200) })?.text).toHaveLength(120);
    expect(parseNotice('{broken')).toBeUndefined();
  });

  it('リンクはサイト内のパスか https だけ', () => {
    expect(cleanLink('/summary/x/')).toBe('/summary/x/');
    expect(cleanLink('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(cleanLink('//evil.example/')).toBe('');
    expect(cleanLink('javascript:alert(1)')).toBe('');
    expect(cleanLink('http://example.com/')).toBe('');
    expect(cleanLink('https://user:pass@example.com/')).toBe('');
    expect(cleanNotice({ ...notice, url: 'javascript:alert(1)' })).not.toHaveProperty('url');
  });

  it('内容が変わると番号も変わる（閉じた人にも新しいお知らせは出る）', () => {
    const { id: _, ...rest } = cleanNotice(notice)!;
    expect(noticeId(rest)).toBe(noticeId({ ...rest }));
    expect(noticeId({ ...rest, text: '別のお知らせ' })).not.toBe(noticeId(rest));
    expect(noticeId(rest)).toMatch(/^n[0-9a-z]+$/);
  });
});

describe('ピックアップ', () => {
  const pick = (id: string, until = '2026-10-10T00:00:00.000Z') => ({ id, comment: 'おすすめ', at: '2026-10-07T00:00:00.000Z', until });

  it('形の正しいもの・同じ記事は1つ・上限まで。期限が過ぎたものは載せない', () => {
    const list = cleanPicks([
      pick('0000000000000001'),
      pick('0000000000000001'),
      { ...pick('0000000000000002'), comment: 'x'.repeat(500) },
      { ...pick('bad') },
      { ...pick('0000000000000003'), until: 'never' },
      pick('0000000000000004', '2026-10-07T06:00:00.000Z'),
    ]);
    expect(list.map((entry) => entry.id)).toEqual(['0000000000000001', '0000000000000002', '0000000000000004']);
    expect(list[1].comment).toHaveLength(COMMENT_MAX);
    expect(activePicks(list, Date.parse('2026-10-07T12:00:00Z')).map((entry) => entry.id)).toEqual(['0000000000000001', '0000000000000002']);
    const many = cleanPicks(Array.from({ length: 20 }, (_, i) => pick(i.toString(16).padStart(16, '0'))));
    expect(many).toHaveLength(PICKS_MAX);
    expect(parsePicks(serializePicks(list))).toEqual(list);
    expect(parsePicks('nope')).toEqual([]);
  });
});
