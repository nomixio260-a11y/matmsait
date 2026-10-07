/** 運営者によるトピックの手直し（data/topic-overrides.json）をビルドのときに読む */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TOPIC_OVERRIDES_PATH, emptyOverrides, parseTopicOverrides, type TopicOverrides } from './topic-overrides-core.ts';

let cache: TopicOverrides | undefined;

export function getTopicOverrides(): TopicOverrides {
  if (!cache) {
    const path = resolve(process.cwd(), TOPIC_OVERRIDES_PATH);
    try {
      cache = existsSync(path) ? parseTopicOverrides(readFileSync(path, 'utf8')) : emptyOverrides();
    } catch {
      // 壊れたファイルでビルドを止めない（管理画面の保存は parseTopicOverrides がエラーにして上書きを防ぐ）
      cache = emptyOverrides();
    }
  }
  return cache;
}
