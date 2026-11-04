#!/usr/bin/env node
// staging-autofollow.test.sh 用の偽 /healthz サーバー。
// 応答は毎回ファイルから読む（テストの途中でファイルを書き換えて状態を変える）。
// 実サービス・実 DB には触らない。
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const port = Number(process.argv[2]);
const responseFile = process.argv[3];

const server = createServer((_request, response) => {
  let body = '{}';
  try {
    body = readFileSync(responseFile, 'utf8');
  } catch {
    // まだ応答ファイルが無い（起動直後）。空の JSON を返す
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(body);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`ready ${port}`);
});
