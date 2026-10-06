/**
 * robots.txt の読み取り（記事の本文を自動で取得するときに、サイトの意向を守るため）。
 * Google と同じ考え方で、名前が一致する User-agent のグループ（なければ * のグループ）のルールを使い、
 * パスにいちばん長く一致するルールを優先する（同じ長さなら Allow を優先）
 */

export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsGroup {
  /** 小文字にした User-agent の名前 */
  agents: string[];
  rules: RobotsRule[];
}

/**
 * AI の利用を断るときに robots.txt で名前を挙げる、主な AI のクローラー・エージェント。
 * どれかがそのページを拒否されていれば、そのサイトは AI での利用を断っているとみなす
 * （運営者は本文をチャット AI に渡すため。Perplexity など運営者が使わない AI だけを断るサイトは対象外）
 */
export const AI_AGENTS = [
  'GPTBot',
  'ChatGPT-User',
  'OAI-SearchBot',
  'ClaudeBot',
  'Claude-User',
  'Claude-SearchBot',
  'anthropic-ai',
  'Google-Extended',
];

export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;
  let lastWasAgent = false;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const match = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === 'user-agent') {
      // User-agent が続く間は同じグループ。ルールのあとに来たら新しいグループ
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      lastWasAgent = false;
      // 空の Disallow は「すべて許可」なのでルールにしない
      if (current && value !== '') current.rules.push({ allow: key === 'allow', path: value });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = new RegExp(`^${body.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${anchored ? '$' : ''}`);
  return regex.test(path);
}

/** そのエージェントに当てはまるルール（名前で書かれたグループ。なければ * のグループ）。名前で書かれていたかも返す */
function rulesFor(groups: RobotsGroup[], agent: string): { rules: RobotsRule[]; named: boolean } {
  const name = agent.toLowerCase();
  const named = groups.filter((group) => group.agents.includes(name));
  if (named.length > 0) return { rules: named.flatMap((group) => group.rules), named: true };
  return { rules: groups.filter((group) => group.agents.includes('*')).flatMap((group) => group.rules), named: false };
}

function decide(rules: RobotsRule[], path: string): boolean {
  let best: RobotsRule | undefined;
  for (const rule of rules) {
    if (!matches(rule.path, path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}

/** そのエージェントがパス（クエリを含む）を取得してよいか */
export function isAllowed(groups: RobotsGroup[], agent: string, path: string): boolean {
  return decide(rulesFor(groups, agent).rules, path);
}

/**
 * AI での利用を断っているか。主な AI のエージェントを名前で挙げて、そのパスを拒否していれば、そのエージェント名を返す
 * （* のグループだけの拒否は、AI に限った意思表示ではないので含めない。その場合は isAllowed で自分の取得が止まる）
 */
export function aiOptOut(groups: RobotsGroup[], path: string): string | undefined {
  return AI_AGENTS.find((agent) => {
    const { rules, named } = rulesFor(groups, agent);
    return named && !decide(rules, path);
  });
}

/** ページの meta robots・X-Robots-Tag に AI での利用を断る指定（noai・noimageai）があるか */
export function hasNoAiDirective(robotsValues: string[]): boolean {
  return robotsValues.some((value) => /(^|[\s,])noai([\s,]|$)/i.test(value));
}
