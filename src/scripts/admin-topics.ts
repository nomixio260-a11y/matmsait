/**
 * 管理画面の「トピック整理」（/admin/topics/）:
 * トピックを選ぶ → AI 整理のプロンプトをコピー → チャット AI の回答を貼り付けて確かめる → data/topic-notes/YYYY-MM.json に保存する
 */
import {
  buildTopicNotePrompt,
  mergeTopicNotes,
  parseTopicNoteAnswer,
  parseTopicNoteFile,
  removeTopicNote,
  serializeTopicNoteFile,
  topicNoteFilePath,
  type NoteArticle,
  type NoteParseResult,
  type TopicNote,
} from '../lib/topic-notes-core.ts';
import {
  TOPIC_OVERRIDES_PATH,
  addMerge,
  addSplit,
  emptyOverrides,
  parseTopicOverrides,
  removeMerge,
  removeSplit,
  serializeTopicOverrides,
  type TopicOverrides,
} from '../lib/topic-overrides-core.ts';
import { normalizeText } from '../lib/search-core.ts';
import { requireSession, watchSession } from './admin-common.ts';
import { $, actionsLink, dateFormat, el, errorText, githubClient, loadAdminData, setStatus, type AdminDataCommon } from './admin-shared.ts';

interface NoteTopicInfo {
  id: string;
  title: string;
  firstAt: string;
  latestAt: string;
  coverage: number;
  score: number;
  category: string;
  articles: NoteArticle[];
  excluded: number;
  allItems: string[];
  /** トピックのすべての記事（報じた順） */
  items: { id: string; title: string; url: string; site: string; publishedAt: string }[];
  noted?: { topic: string; notedAt: string; firstAt: string; newer: number };
}

interface TopicsData extends AdminDataCommon {
  topics?: NoteTopicInfo[];
  topicOverrides?: TopicOverrides;
}

const root = document.querySelector<HTMLElement>('[data-admin]')!;
let data: TopicsData;
let token = '';
let selected: NoteTopicInfo | undefined;
let accepted: NoteParseResult['note'];

const client = () => githubClient(token, data.repository);
const shorten = (text: string, max: number) => (Array.from(text).length > max ? `${Array.from(text).slice(0, max).join('')}…` : text);

function categoryName(slug: string): string {
  return data.categories.find((category) => category.slug === slug)?.name ?? slug;
}

// ===== 1. トピックの一覧 =====

function renderList(): void {
  const query = normalizeText($<HTMLInputElement>('topic-search').value.trim());
  const onlyNew = $<HTMLInputElement>('only-new').checked;
  const topics = (data.topics ?? []).filter(
    (topic) => (!onlyNew || !topic.noted || topic.noted.newer > 0) && (!query || normalizeText(topic.title).includes(query)),
  );
  const list = $('topic-list');
  list.replaceChildren(
    ...topics.slice(0, 60).map((topic) => {
      const li = el('li');
      li.classList.toggle('is-selected', topic.id === selected?.id);
      const text = el('div', 'result-text');
      text.append(el('div', 'pick-title', topic.title));
      const meta = [
        `話題度${topic.score}`,
        `${topic.coverage}媒体が報道`,
        categoryName(topic.category),
        `最新 ${dateFormat.format(new Date(topic.latestAt))}`,
      ];
      text.append(el('div', 'pick-meta', meta.join(' ・ ')));
      if (topic.noted) {
        text.append(
          el(
            'span',
            'badge-inline',
            topic.noted.newer > 0 ? `整理済み（${dateFormat.format(new Date(topic.noted.notedAt))}）・そのあと${topic.noted.newer}件の報道` : `整理済み（${dateFormat.format(new Date(topic.noted.notedAt))}）`,
          ),
        );
      }
      const button = el('button', 'small', topic.id === selected?.id ? '選択中' : '選ぶ');
      button.type = 'button';
      button.addEventListener('click', () => select(topic));
      li.append(text, button);
      return li;
    }),
  );
  $('topic-empty').hidden = topics.length > 0;
}

// ===== 2. プロンプトと回答 =====

function select(topic: NoteTopicInfo): void {
  selected = topic;
  accepted = undefined;
  renderList();
  $('work').hidden = false;
  $('work-topic').textContent = topic.title;
  $('work-meta').textContent = `${topic.coverage}媒体が報道 ・ 話題度${topic.score} ・ プロンプトに入れる記事 ${topic.articles.length}件`;
  $('work-articles').replaceChildren(
    ...topic.articles.map((article) => {
      const li = el('li');
      const link = el('a', '', article.title);
      link.href = article.url;
      link.target = '_blank';
      link.rel = 'noopener';
      li.append(el('b', '', `${article.site}: `), link);
      return li;
    }),
  );
  const excluded = $('work-excluded');
  excluded.hidden = topic.excluded === 0;
  excluded.textContent = `要約を禁じている掲載元などの${topic.excluded}媒体の記事は、プロンプトに入れていません。`;
  $<HTMLTextAreaElement>('prompt').value = buildTopicNotePrompt(
    { id: topic.id, title: topic.title, firstAt: topic.firstAt, articles: topic.articles },
    { siteName: data.siteName },
  );
  $<HTMLTextAreaElement>('answer').value = '';
  $('issues').replaceChildren();
  $('preview').hidden = true;
  $<HTMLButtonElement>('save').disabled = true;
  $('remove').hidden = !topic.noted;
  setStatus($('save-status'), '');
  setStatus($('copy-status'), '');
  renderFix();
  $('work').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ===== 3. まとめ方の手直し（分割・統合） =====

let overrides: TopicOverrides = emptyOverrides();

/** data/topic-overrides.json を読み、変えて保存する */
async function updateOverrides(message: string, change: (current: TopicOverrides) => TopicOverrides): Promise<void> {
  const github = client();
  const { defaultBranch } = await github.repository();
  let saved = overrides;
  await github.commitFiles(defaultBranch, message, async (read) => {
    saved = change(parseTopicOverrides(await read(TOPIC_OVERRIDES_PATH)));
    return [{ path: TOPIC_OVERRIDES_PATH, content: serializeTopicOverrides(saved) }];
  });
  overrides = saved;
}

async function runFix(label: string, action: () => Promise<void>): Promise<void> {
  const status = $('fix-status');
  setStatus(status, `${label}を保存しています…`);
  for (const button of document.querySelectorAll<HTMLButtonElement>('#fix button')) button.disabled = true;
  try {
    await action();
    setStatus(status, `${label}を保存しました。次のサイトの更新（2〜3分）から反映されます。`, 'ok');
    status.append(' ', actionsLink(data.repository));
  } catch (error) {
    setStatus(status, `${label}を保存できませんでした: ${errorText(error)}`, 'error');
  } finally {
    for (const button of document.querySelectorAll<HTMLButtonElement>('#fix button')) button.disabled = false;
    renderFix();
  }
}

function renderFix(): void {
  const topic = selected;
  $('fix').hidden = !topic;
  if (!topic) return;
  const split = new Set(overrides.splits.map((entry) => entry.id));
  $('fix-items').replaceChildren(
    ...topic.items.map((article) => {
      const li = el('li');
      const row = el('div', 'fix-row');
      const text = el('div', 'fix-text');
      const link = el('a', '', article.title);
      link.href = article.url;
      link.target = '_blank';
      link.rel = 'noopener';
      text.append(link, el('div', 'pick-meta', `${article.site} ・ ${dateFormat.format(new Date(article.publishedAt))}`));
      row.append(text);
      if (split.has(article.id)) {
        row.append(el('span', 'badge-inline', '外し済み（次の更新で反映）'));
      } else {
        const button = el('button', 'small', '外す');
        button.type = 'button';
        button.setAttribute('aria-label', `「${shorten(article.title, 20)}」をこのトピックから外す`);
        button.addEventListener('click', () => {
          if (!confirm(`「${shorten(article.title, 40)}」をこのトピックから外しますか？（このトピックのほかの記事とはまとめなくなります）`)) return;
          const from = topic.allItems.filter((id) => id !== article.id);
          void runFix('分割', () =>
            updateOverrides(`トピックから記事を外す: ${shorten(article.title, 30)}`, (current) =>
              addSplit(current, { id: article.id, from, title: article.title, at: new Date().toISOString() }),
            ),
          );
        });
        row.append(button);
      }
      li.append(row);
      return li;
    }),
  );
  renderMergeResults();
  renderFixLog();
}

function renderMergeResults(): void {
  const topic = selected;
  const query = normalizeText($<HTMLInputElement>('merge-search').value.trim());
  const list = $('merge-results');
  if (!topic || !query) {
    list.replaceChildren();
    return;
  }
  const candidates = (data.topics ?? []).filter((other) => other.id !== topic.id && normalizeText(other.title).includes(query)).slice(0, 10);
  list.replaceChildren(
    ...candidates.map((other) => {
      const li = el('li');
      const text = el('div', 'result-text');
      text.append(el('div', 'pick-title', other.title), el('div', 'pick-meta', `${other.coverage}媒体が報道 ・ 最新 ${dateFormat.format(new Date(other.latestAt))}`));
      const button = el('button', 'small', 'まとめる');
      button.type = 'button';
      button.setAttribute('aria-label', `「${shorten(other.title, 20)}」とまとめる`);
      button.addEventListener('click', () => {
        if (!confirm(`「${shorten(topic.title, 30)}」と「${shorten(other.title, 30)}」を同じトピックにまとめますか？`)) return;
        void runFix('統合', () =>
          updateOverrides(`トピックをまとめる: ${shorten(topic.title, 20)} ＋ ${shorten(other.title, 20)}`, (current) =>
            addMerge(current, { ids: [topic.id, other.id], titles: [topic.title, other.title], at: new Date().toISOString() }),
          ),
        );
      });
      li.append(text, button);
      return li;
    }),
  );
  if (candidates.length === 0) list.append(el('li', 'pick-meta', '当てはまるトピックがありません（72時間のトピックから探します）。'));
}

function renderFixLog(): void {
  const entries = [
    ...overrides.splits.map((split) => ({
      at: split.at,
      text: `分割: 「${shorten(split.title ?? split.id, 40)}」を、そのとき同じトピックだった${split.from.length}件の記事とまとめない`,
      undo: () => updateOverrides(`トピックの分割を取り消す: ${shorten(split.title ?? split.id, 30)}`, (current) => removeSplit(current, split.id)),
    })),
    ...overrides.merges.map((merge) => ({
      at: merge.at,
      text: `統合: 「${shorten(merge.titles?.[0] ?? merge.ids[0], 30)}」と「${shorten(merge.titles?.[1] ?? merge.ids[1], 30)}」`,
      undo: () => updateOverrides('トピックの統合を取り消す', (current) => removeMerge(current, merge.ids)),
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  $('fix-log').replaceChildren(
    ...entries.map((entry) => {
      const li = el('li');
      const row = el('div', 'fix-row');
      const text = el('div', 'fix-text');
      text.append(el('div', '', entry.text), el('div', 'pick-meta', dateFormat.format(new Date(entry.at))));
      const button = el('button', 'small ghost', '取り消す');
      button.type = 'button';
      button.addEventListener('click', () => {
        if (confirm('この手直しを取り消しますか？')) void runFix('取り消し', entry.undo);
      });
      row.append(text, button);
      li.append(row);
      return li;
    }),
  );
  $('fix-empty').hidden = entries.length > 0;
}

function siteOf(id: string): string {
  return selected?.articles.find((article) => article.id === id)?.site ?? id;
}

function renderPreview(note: NonNullable<NoteParseResult['note']>): void {
  const preview = $('preview');
  const section = (title: string, items: { text: string; cite?: string }[]) => {
    if (items.length === 0) return [];
    const list = el('ul');
    list.append(
      ...items.map((item) => {
        const li = el('li', '', item.text);
        if (item.cite) li.append(el('span', 'cite', `（${item.cite}）`));
        return li;
      }),
    );
    return [el('h3', '', title), list];
  };
  preview.replaceChildren(
    ...section(
      '共通して報じられていること',
      note.common.map((entry) => ({ text: entry.text, cite: entry.sources.map(siteOf).join('・') })),
    ),
    ...section(
      '各媒体が特に伝えていること',
      note.emphasis.map((entry) => ({ text: `${siteOf(entry.source)}: ${entry.text}` })),
    ),
    ...section(
      '報道内容の差',
      note.differences.map((entry) => ({ text: entry.text, cite: entry.sources.map(siteOf).join('・') })),
    ),
    ...(note.background ? [el('h3', '', '背景'), el('p', '', note.background)] : []),
    ...(note.interpretation ? [el('h3', '', 'AI による整理・解釈（事実とは分けて表示）'), el('p', '', note.interpretation)] : []),
  );
  preview.hidden = false;
}

function check(): void {
  if (!selected) return;
  const answer = $<HTMLTextAreaElement>('answer').value;
  const result = parseTopicNoteAnswer(
    answer,
    selected.articles.map((article) => article.id),
  );
  accepted = result.note;
  // 受け付けなかった点・取り除いた点と、要確認（宣伝の言葉・定型文・推測など。保存はできる）
  $('issues').replaceChildren(
    ...result.issues.map((issue) => el('li', '', issue)),
    ...(result.note ? (result.warnings ?? []).map((warning) => el('li', 'warn', `要確認: ${warning}`)) : []),
  );
  if (result.note) {
    renderPreview(result.note);
    setStatus($('save-status'), '問題がなければ「保存して公開」を押してください。', 'ok');
  } else {
    $('preview').hidden = true;
    setStatus($('save-status'), '保存できる内容がありません。上の説明を見て、回答を直すか AI にもう一度依頼してください。', 'error');
  }
  $<HTMLButtonElement>('save').disabled = !result.note;
}

/** 1つのファイルを読み、変えて保存する（既定のブランチに1つのコミット） */
async function updateFile(path: string, message: string, change: (notes: TopicNote[]) => TopicNote[]): Promise<boolean> {
  const github = client();
  const { defaultBranch } = await github.repository();
  const result = await github.commitFiles(defaultBranch, message, async (read) => {
    const current = parseTopicNoteFile(await read(path));
    return [{ path, content: serializeTopicNoteFile(change(current)) }];
  });
  return result.changed;
}

async function save(): Promise<void> {
  if (!selected || !accepted) return;
  const topic = selected;
  const note: TopicNote = {
    topic: topic.id,
    items: topic.allItems,
    title: topic.title,
    firstAt: topic.firstAt,
    ...accepted,
    notedAt: new Date().toISOString(),
  };
  const button = $<HTMLButtonElement>('save');
  button.disabled = true;
  setStatus($('save-status'), '保存しています…');
  try {
    // 前の整理が別の月のファイルにあれば、そこからは消す（同じトピックの整理を2つ残さない）
    const path = topicNoteFilePath(topic.firstAt);
    if (topic.noted && topicNoteFilePath(topic.noted.firstAt) !== path) {
      await updateFile(topicNoteFilePath(topic.noted.firstAt), `AI 整理を移す: ${shorten(topic.title, 30)}`, (notes) => removeTopicNote(notes, topic.noted!.topic));
    }
    await updateFile(path, `AI 整理を保存: ${shorten(topic.title, 30)}`, (notes) => mergeTopicNotes(notes, note));
    topic.noted = { topic: topic.id, notedAt: note.notedAt, firstAt: topic.firstAt, newer: 0 };
    setStatus($('save-status'), '保存しました。サイトの更新（2〜3分）のあと、トピックのページの「各メディアの視点」に出ます。', 'ok');
    $('save-status').append(' ', actionsLink(data.repository));
    $('remove').hidden = false;
    renderList();
  } catch (error) {
    setStatus($('save-status'), `保存できませんでした: ${errorText(error)}`, 'error');
    button.disabled = false;
  }
}

async function remove(): Promise<void> {
  const topic = selected;
  if (!topic?.noted || !confirm('このトピックの AI 整理を消しますか？（トピックのページは見出しの比較に戻ります）')) return;
  const noted = topic.noted;
  setStatus($('save-status'), '消しています…');
  try {
    await updateFile(topicNoteFilePath(noted.firstAt), `AI 整理を消す: ${shorten(topic.title, 30)}`, (notes) => removeTopicNote(notes, noted.topic));
    topic.noted = undefined;
    $('remove').hidden = true;
    setStatus($('save-status'), '消しました。サイトの更新のあとに反映されます。', 'ok');
    renderList();
  } catch (error) {
    setStatus($('save-status'), `消せませんでした: ${errorText(error)}`, 'error');
  }
}

async function copyPrompt(): Promise<void> {
  const prompt = $<HTMLTextAreaElement>('prompt').value;
  try {
    await navigator.clipboard.writeText(prompt);
    setStatus($('copy-status'), 'コピーしました。チャット AI に貼り付けて送ってください。', 'ok');
  } catch {
    // クリップボードが使えないときは、プロンプトを開いて選択しておく
    const box = $<HTMLTextAreaElement>('prompt');
    (box.closest('details') as HTMLDetailsElement).open = true;
    box.select();
    setStatus($('copy-status'), 'コピーできませんでした。開いたプロンプトを選択してコピーしてください。', 'error');
  }
}

// ===== 起動 =====

async function main(): Promise<void> {
  const session = requireSession();
  if (!session) return;
  token = session.token;
  watchSession(session);
  root.hidden = false;
  try {
    data = await loadAdminData<TopicsData>();
  } catch (error) {
    $('data-info').textContent = `管理画面のデータを読み込めませんでした（${errorText(error)}）`;
    return;
  }
  const topics = data.topics ?? [];
  const noted = topics.filter((topic) => topic.noted).length;
  $('data-info').textContent = `サイトの最終更新: ${dateFormat.format(new Date(data.generatedAt))} ・ 72時間のトピック ${topics.length}件（うち整理済み ${noted}件）`;
  overrides = data.topicOverrides ?? emptyOverrides();
  $('merge-search').addEventListener('input', renderMergeResults);
  $('topic-search').addEventListener('input', renderList);
  $('only-new').addEventListener('change', renderList);
  $('copy-prompt').addEventListener('click', () => void copyPrompt());
  $('check').addEventListener('click', check);
  $('save').addEventListener('click', () => void save());
  $('remove').addEventListener('click', () => void remove());
  // 回答を書き換えたら、確かめ直すまで保存できない
  $('answer').addEventListener('input', () => {
    accepted = undefined;
    $<HTMLButtonElement>('save').disabled = true;
  });
  renderList();
}

void main();
