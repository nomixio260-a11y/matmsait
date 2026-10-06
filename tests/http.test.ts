import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserHeaders, chromeMajorVersion, closeConnections, decodeBody, httpGet } from '../scripts/lib/http.ts';

describe('chromeMajorVersion', () => {
  it('日付から現行の1つ前の Chrome のバージョンを求める', () => {
    expect(chromeMajorVersion(new Date('2025-01-14T00:00:00Z'))).toBe(131);
    expect(chromeMajorVersion(new Date('2025-02-11T00:00:00Z'))).toBe(132);
    expect(chromeMajorVersion(new Date('2026-10-06T00:00:00Z'))).toBe(153);
  });
});

describe('browserHeaders', () => {
  it('Chrome と同じ並びのヘッダーで、自動化ツールの痕跡を含まない', () => {
    const now = new Date('2026-10-06T00:00:00Z');
    const headers = browserHeaders('document', now);
    expect(headers.map(([name]) => name)).toEqual([
      'Connection',
      'sec-ch-ua',
      'sec-ch-ua-mobile',
      'sec-ch-ua-platform',
      'Upgrade-Insecure-Requests',
      'User-Agent',
      'Accept',
      'Sec-Fetch-Site',
      'Sec-Fetch-Mode',
      'Sec-Fetch-User',
      'Sec-Fetch-Dest',
      'Accept-Encoding',
      'Accept-Language',
    ]);
    const map = new Map(headers);
    expect(map.get('User-Agent')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    );
    expect(map.get('sec-ch-ua')).toContain('"Google Chrome";v="153"');
    expect(map.get('Sec-Fetch-Mode')).toBe('navigate');
    expect(JSON.stringify(headers)).not.toMatch(/node|undici|bot|crawler/i);
  });

  it('API 用はページ内からの取得と同じヘッダーになる', () => {
    const map = new Map(browserHeaders('fetch'));
    expect(map.get('Sec-Fetch-Mode')).toBe('cors');
    expect(map.get('Sec-Fetch-Dest')).toBe('empty');
    expect(map.get('Accept')).toBe('*/*');
  });
});

describe('httpGet', () => {
  let server: http.Server;
  let base: string;
  const received: string[][] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      received.push(req.rawHeaders);
      switch (req.url) {
        case '/gzip':
          res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Type': 'text/plain' });
          res.end(zlib.gzipSync('gzip本文'));
          break;
        case '/br':
          res.writeHead(200, { 'Content-Encoding': 'br' });
          res.end(zlib.brotliCompressSync('br本文'));
          break;
        case '/redirect':
          res.writeHead(302, { Location: '/plain' });
          res.end();
          break;
        case '/loop':
          res.writeHead(301, { Location: '/loop' });
          res.end();
          break;
        case '/hang':
          break; // 応答しない
        default:
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('plain本文');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    closeConnections();
    server.closeAllConnections();
    server.close();
  });

  it('ブラウザと同じヘッダーだけを同じ順序で送る', async () => {
    received.length = 0;
    const res = await httpGet(`${base}/plain`);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('plain本文');
    const names = received[0].filter((_, i) => i % 2 === 0);
    expect(names).toEqual(['Host', ...browserHeaders('document').map(([name]) => name)]);
  });

  it('gzip / brotli を展開する', async () => {
    expect((await httpGet(`${base}/gzip`)).body.toString()).toBe('gzip本文');
    expect((await httpGet(`${base}/br`)).body.toString()).toBe('br本文');
  });

  it('リダイレクトを辿り、最終URLを返す', async () => {
    const res = await httpGet(`${base}/redirect`);
    expect(res.status).toBe(200);
    expect(res.url).toBe(`${base}/plain`);
  });

  it('リダイレクトの無限ループは打ち切る', async () => {
    await expect(httpGet(`${base}/loop`, { maxRedirects: 3 })).rejects.toThrow('リダイレクト');
  });

  it('応答がなければタイムアウトする', async () => {
    await expect(httpGet(`${base}/hang`, { timeoutMs: 200 })).rejects.toThrow('タイムアウト');
  });
});

describe('decodeBody', () => {
  const sjisA = Buffer.from([0x82, 0xa0]); // 「あ」の Shift_JIS

  it('Content-Type の charset で文字コードを決める', () => {
    expect(decodeBody(sjisA, 'text/xml; charset=Shift_JIS')).toBe('あ');
    expect(decodeBody(Buffer.from([0xa4, 0xa2]), 'application/xml; charset="EUC-JP"')).toBe('あ');
  });

  it('XML 宣言の encoding も見る', () => {
    const body = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="Shift_JIS"?><a>'), sjisA, Buffer.from('</a>')]);
    expect(decodeBody(body, 'application/xml')).toContain('<a>あ</a>');
  });

  it('指定がなければ UTF-8、未知の文字コード名でも落ちない', () => {
    expect(decodeBody(Buffer.from('あ'), undefined)).toBe('あ');
    expect(decodeBody(Buffer.from('あ'), 'text/xml; charset=unknown-charset')).toBe('あ');
  });
});
