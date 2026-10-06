import { describe, expect, it } from 'vitest';
import { aiOptOut, hasNoAiDirective, isAllowed, parseRobots } from '../scripts/lib/robots.ts';

describe('robots.txt', () => {
  const robots = parseRobots(
    [
      '# コメント',
      'User-agent: *',
      'Disallow: /private/',
      'Allow: /private/open/',
      'Disallow: /*.pdf$',
      '',
      'User-agent: GPTBot',
      'User-agent: ClaudeBot',
      'Disallow: /',
      '',
      'User-agent: PerplexityBot',
      'Disallow: /news/',
      '',
      'User-agent: TopiatsumeBot',
      'Disallow: /members/',
    ].join('\n'),
  );

  it('名前が一致するグループ（なければ *）の、いちばん長く一致するルールで決める', () => {
    expect(isAllowed(robots, 'SomeBot', '/news/1')).toBe(true);
    expect(isAllowed(robots, 'SomeBot', '/private/x')).toBe(false);
    expect(isAllowed(robots, 'SomeBot', '/private/open/x')).toBe(true);
    expect(isAllowed(robots, 'SomeBot', '/file.pdf')).toBe(false);
    expect(isAllowed(robots, 'SomeBot', '/file.pdf?x=1')).toBe(true);
    // 自分の名前のグループがあれば、* のルールは使わない
    expect(isAllowed(robots, 'TopiatsumeBot', '/private/x')).toBe(true);
    expect(isAllowed(robots, 'TopiatsumeBot', '/members/1')).toBe(false);
  });

  it('主な AI のエージェントを名前で挙げて断っていれば、AI での利用を断っているとみなす', () => {
    expect(aiOptOut(robots, '/news/1')).toBe('GPTBot');
    // Perplexity だけを断るサイト・* だけで断るサイトは、主な AI を断っているとはみなさない
    expect(aiOptOut(parseRobots('User-agent: PerplexityBot\nDisallow: /'), '/a')).toBeUndefined();
    expect(aiOptOut(parseRobots('User-agent: *\nDisallow: /'), '/a')).toBeUndefined();
    expect(aiOptOut(parseRobots('User-agent: ChatGPT-User\nDisallow: /news/\nAllow: /news/free/'), '/news/free/1')).toBeUndefined();
    expect(aiOptOut(parseRobots('User-agent: ChatGPT-User\nDisallow: /news/\nAllow: /news/free/'), '/news/1')).toBe('ChatGPT-User');
  });

  it('空の Disallow はすべて許可、空の robots.txt もすべて許可', () => {
    expect(isAllowed(parseRobots('User-agent: *\nDisallow:'), 'TopiatsumeBot', '/a')).toBe(true);
    expect(isAllowed(parseRobots(''), 'TopiatsumeBot', '/a')).toBe(true);
    expect(isAllowed(parseRobots('User-agent: *\nDisallow: /'), 'TopiatsumeBot', '/a')).toBe(false);
  });

  it('noai の指定（meta robots・X-Robots-Tag）を見分ける', () => {
    expect(hasNoAiDirective(['index, noai'])).toBe(true);
    expect(hasNoAiDirective(['noai'])).toBe(true);
    expect(hasNoAiDirective(['noimageai', 'index, follow'])).toBe(false);
  });
});
