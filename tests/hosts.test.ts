import { describe, expect, it } from 'vitest';
import { siteKey } from '../scripts/lib/hosts.ts';

describe('siteKey', () => {
  it('サブドメインが違っても同じ運営元のサイトは同じキーにする', () => {
    expect(siteKey('pc.watch.impress.co.jp')).toBe('impress.co.jp');
    expect(siteKey('car.watch.impress.co.jp')).toBe('impress.co.jp');
    expect(siteKey('www.watch.impress.co.jp')).toBe('impress.co.jp');
    expect(siteKey('rss.itmedia.co.jp')).toBe('itmedia.co.jp');
    expect(siteKey('b.hatena.ne.jp')).toBe('hatena.ne.jp');
    expect(siteKey('feeds.bbci.co.uk')).toBe('bbci.co.uk');
  });

  it('.com や .jp などはドメイン名の最後の2つ', () => {
    expect(siteKey('news.denfaminicogamer.jp')).toBe('denfaminicogamer.jp');
    expect(siteKey('www.soccer-king.jp')).toBe('soccer-king.jp');
    expect(siteKey('jp.motorsport.com')).toBe('motorsport.com');
    expect(siteKey('zenn.dev')).toBe('zenn.dev');
    expect(siteKey('WWW.Example.COM.')).toBe('example.com');
  });

  it('IP アドレスはそのまま', () => {
    expect(siteKey('127.0.0.1')).toBe('127.0.0.1');
  });
});
