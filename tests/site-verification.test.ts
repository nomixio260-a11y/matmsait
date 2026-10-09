import { describe, expect, it } from 'vitest';
import { verificationCodes } from '../src/lib/site-verification.ts';

describe('verificationCodes（検索エンジンの所有権確認のコード）', () => {
  it('コードだけならそのまま使う。未設定なら何も出さない', () => {
    expect(verificationCodes('3Ny1UgvYwgOgaaY4Uq1C-ys_llLq0cK4AkG9vqESkCY')).toEqual(['3Ny1UgvYwgOgaaY4Uq1C-ys_llLq0cK4AkG9vqESkCY']);
    expect(verificationCodes(undefined)).toEqual([]);
    expect(verificationCodes('  ')).toEqual([]);
  });

  it('タグ全体・DNS の TXT レコードの形を貼り付けても、コードだけを取り出す', () => {
    expect(verificationCodes('<meta name="google-site-verification" content="AbC_123-xyz" />')).toEqual(['AbC_123-xyz']);
    expect(verificationCodes('google-site-verification=3Ny1UgvYwgOgaaY4Uq1C-ys_llLq0cK4AkG9vqESkCY')).toEqual(['3Ny1UgvYwgOgaaY4Uq1C-ys_llLq0cK4AkG9vqESkCY']);
    expect(verificationCodes('"google-site-verification=AbC"')).toEqual(['AbC']);
    expect(verificationCodes('<meta name="msvalidate.01" content="0123456789ABCDEF" />')).toEqual(['0123456789ABCDEF']);
  });

  it('複数のコード（空白・カンマ・改行・別の値）を、重なりなく並べる', () => {
    expect(verificationCodes('AAA, BBB\nCCC AAA')).toEqual(['AAA', 'BBB', 'CCC']);
    expect(verificationCodes('', 'google-site-verification=AAA', 'AAA', '<meta content="BBB">')).toEqual(['AAA', 'BBB']);
  });

  it('HTML ファイルの名前や、タグを壊す文字を含むものは使わない', () => {
    expect(verificationCodes('google-site-verification: google0123456789abcdef.html')).toEqual([]);
    expect(verificationCodes('"><script>alert(1)</script>')).toEqual([]);
  });
});
