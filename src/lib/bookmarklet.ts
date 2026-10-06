/**
 * 記事の本文をコピーするブックマークレット。
 * AI が記事のページを開けない（ボット対策で拒否される）ときに、運営者が自分のブラウザで記事を開いて実行し、
 * 本文を管理画面に貼り付けるために使う。本文は運営者のクリップボードにコピーするだけで、どこにも送らない。
 */

/**
 * 記事のページで実行して、本文を取り出してクリップボードにコピーし、コピーした文字列を返す。
 * ブックマークレットとして単独で動くよう、この関数の外の変数・関数は使わない（toString() で書き出す）
 */
export async function copyArticleText(): Promise<string> {
  const MARKER = '【トピあつめ 本文】';
  const MAX = 20000;
  /** 本文とは関係ない部分（メニュー・関連記事・ランキング・共有ボタン・コメント・広告など） */
  const SKIP =
    'script,style,noscript,template,iframe,video,audio,canvas,svg,nav,aside,footer,form,button,select,figure,[hidden],[aria-hidden="true"],[class*="share"],[class*="related"],[class*="ranking"],[class*="recommend"],[class*="banner"],[class*="breadcrumb"],[class*="sns"],[class*="comment"],[id*="comment"]';
  const textOf = (el: Element | null) => (el ? ((el as HTMLElement).innerText || el.textContent || '').trim() : '');

  /** 本文らしいまとまり: 本文の目印がある要素、なければ文字がいちばん多いまとまり（その記事 article 全体に広げることもある） */
  const findRoot = (): Element => {
    const marked = document.querySelector('[itemprop="articleBody"]');
    if (marked && textOf(marked).length >= 100) return marked;
    // 文字（テキスト）を、それを含むいちばん近いまとまり（div・section・article など）ごとに数える
    const counts = new Map<Element, number>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = (node.nodeValue ?? '').trim().length;
      const parent = node.parentElement;
      if (length === 0 || !parent || parent.closest(SKIP)) continue;
      const box = parent.closest('article,main,section,div,td,body');
      if (box) counts.set(box, (counts.get(box) ?? 0) + length);
    }
    const total = (el: Element) => {
      let sum = 0;
      counts.forEach((count, box) => {
        if (el.contains(box)) sum += count;
      });
      return sum;
    };
    let best: Element = document.body;
    let top = 0;
    counts.forEach((count, box) => {
      if (count > top) {
        best = box;
        top = count;
      }
    });
    // 本文が小見出しごとのまとまりに分かれている場合に備えて、記事（article）が大きすぎなければ記事全体にする
    const article = best.closest('article');
    return article && total(article) <= total(best) * 2.5 ? article : best;
  };

  /** まとまりの文字を、本文と関係ない部分を除いて画面に見えるとおりの改行で取り出す */
  const cleanText = (root: Element): string => {
    const clone = root.cloneNode(true) as Element;
    clone.querySelectorAll(SKIP).forEach((el) => el.remove());
    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;left:-99999px;top:0;width:800px';
    holder.append(clone);
    document.body.append(holder);
    const text = textOf(holder);
    holder.remove();
    return text
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');
  };

  // 自分で選んだ部分があれば、それを本文にする（自動で見つけた本文が違うときのため）
  let body = (window.getSelection()?.toString() ?? '').trim();
  if (body.length < 100) body = cleanText(findRoot());

  const title = (textOf(document.querySelector('h1')) || document.title).replace(/\s+/g, ' ');
  const output = [MARKER, `タイトル: ${title}`, `URL: ${location.href}`, '', body.slice(0, MAX)].join('\n');

  /** ページの右上に短い案内を出す（コピーできなかったときは、手でコピーできるように本文の欄も出す） */
  const notice = (message: string, manual: boolean) => {
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;z-index:2147483647;top:16px;right:16px;width:340px;max-width:calc(100vw - 32px);padding:12px 14px;background:#16191e;color:#fff;font:14px/1.6 sans-serif;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);text-align:left';
    box.textContent = message;
    if (manual) {
      const area = document.createElement('textarea');
      area.value = output;
      area.style.cssText = 'display:block;width:100%;height:140px;margin-top:8px;color:#111;background:#fff;font:12px/1.5 monospace';
      box.append(area);
      setTimeout(() => area.select(), 0);
    }
    const close = document.createElement('button');
    close.textContent = '閉じる';
    close.style.cssText = 'display:block;margin-top:8px;padding:2px 10px;color:#111;background:#fff;border:0;border-radius:6px;cursor:pointer';
    close.addEventListener('click', () => box.remove());
    box.append(close);
    document.body.append(box);
    if (!manual) setTimeout(() => box.remove(), 4000);
  };

  let copied = false;
  try {
    await navigator.clipboard.writeText(output);
    copied = true;
  } catch {
    const area = document.createElement('textarea');
    area.value = output;
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(area);
    area.select();
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    area.remove();
  }
  const length = Array.from(body).length;
  if (copied) {
    notice(`本文をコピーしました（${length.toLocaleString()}字）。管理画面の本文の欄に貼り付けてください。`, false);
  } else {
    notice('自動でコピーできませんでした。下の欄の文字を Ctrl+C（Mac は ⌘+C）でコピーしてください。', true);
  }
  return output;
}

/** ブックマークとして登録する URL（javascript: で始まる） */
export const COPY_ARTICLE_BOOKMARKLET = `javascript:${encodeURIComponent(`void (${copyArticleText.toString()})()`)}`;
