import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { loadConfig } from '../server/config.ts';
import { Store } from '../server/store.ts';
import { SchwabAuth, encryptToken } from '../server/auth.ts';
import { createApp } from '../server/app.ts';
import { DEFAULT_RULES, type MarketSnapshot } from '../shared/types.ts';

async function fixture(snapshot?: () => Promise<MarketSnapshot>) {
  const config = loadConfig({}); const store = new Store(':memory:'); const auth = new SchwabAuth(config,store);
  if (snapshot) {
    config.clientId = 'client'; config.clientSecret = 'secret'; config.encryptionKey = 'ab'.repeat(32);
    store.set('schwabTokens',encryptToken({accessToken:'test',refreshToken:'test',expiresAt:Date.now()+60_000_000},config.encryptionKey));
  }
  const server = createServer(createApp({config,store,auth,provider:{snapshot:snapshot || (async () => {throw new Error('Live provider must not run in demo tests.');})}}));
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  config.origin = origin;
  const request = (path:string,method='GET',body?:unknown,headers:Record<string,string>={}) => fetch(`${origin}${path}`,{
    method,headers:{Host:new URL(config.origin).host,Origin:config.origin,'Content-Type':'application/json',...headers},...(body === undefined ? {} : {body:JSON.stringify(body)}),
  });
  const close = async () => {server.closeAllConnections(); await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); store.close();};
  const unexpectedHost = () => new Promise<number | undefined>((resolve,reject) => {
    const req = httpRequest(`${origin}/api/state`,{headers:{Host:'attacker.example'}},res => {res.resume(); resolve(res.statusCode);});
    req.on('error',reject); req.end();
  });
  return {request,close,store,unexpectedHost};
}

test('API rejects cross-origin mutations and unexpected host headers', async () => {
  const f = await fixture();
  try {
    const csrf = await f.request('/api/mode','POST',{mode:'schwab'},{Origin:'https://attacker.example'});
    assert.equal(csrf.status,403); assert.equal(f.store.mode,'demo');
    assert.equal(await f.unexpectedHost(),403);
    const response = await f.request('/api/state'); assert.equal(response.status,200);
    assert.equal(response.headers.get('cache-control'),'no-store');
  } finally {await f.close();}
});

test('scan completion cannot restore results after settings, source, or connection changes', async () => {
  const mutations: {path:string;method:string;body:unknown}[] = [
    {path:'/api/watchlist',method:'PUT',body:{symbols:['IBM']}},
    {path:'/api/rules',method:'PUT',body:{...DEFAULT_RULES,relativeVolume:3}},
    {path:'/api/mode',method:'POST',body:{mode:'demo'}},
    {path:'/api/auth/schwab/disconnect',method:'POST',body:{}},
  ];
  for (const mutation of mutations) {
    let complete: (snapshot:MarketSnapshot) => void = () => {};
    let signalStart: () => void = () => {};
    const started = new Promise<void>(resolve => {signalStart = resolve;});
    const f = await fixture(async () => {signalStart(); return new Promise<MarketSnapshot>(resolve => {complete = resolve;});});
    try {
      const scan = f.request('/api/scan','POST',{mode:'schwab'});
      await started;
      assert.equal((await f.request(mutation.path,mutation.method,mutation.body)).status,200);
      complete({mode:'schwab',asOf:Date.now(),marketOpen:false,symbols:[],warnings:[]});
      assert.equal((await scan).status,409,mutation.path);
      assert.equal(f.store.mode,'demo');
      assert.equal(f.store.get('lastScan:schwab',null),null);
    } finally {await f.close();}
  }
});

test('watchlists are normalized, bounded, persistent, and invalidate old results', async () => {
  const f = await fixture();
  try {
    f.store.set('lastScan:demo',{stale:true});
    const response = await f.request('/api/watchlist','PUT',{symbols:['aapl','AAPL','msft']});
    assert.equal(response.status,200); assert.deepEqual(await response.json(),{watchlist:['AAPL','MSFT']});
    assert.equal(f.store.lastScan,null);
    assert.equal((await f.request('/api/watchlist','PUT',{symbols:[]})).status,400);
    assert.equal((await f.request('/api/watchlist','PUT',{symbols:['<script>']})).status,400);
  } finally {await f.close();}
});

test('live scans fail closed instead of serving demonstration data', async () => {
  const f = await fixture();
  try {
    const response = await f.request('/api/scan','POST',{mode:'schwab'});
    assert.equal(response.status,401); assert.equal(f.store.lastScan,null);
    const demo = await f.request('/api/scan','POST',{mode:'demo'});
    assert.equal(demo.status,200); assert.equal((await demo.json() as {mode:string}).mode,'demo');
  } finally {await f.close();}
});

test('paper-trade P&L uses quantity, direction, multiplier and total round-trip fees', async () => {
  const f = await fixture();
  try {
    const body = {signalId:'demo-test',symbol:'AAPL',instrument:'AAPL call',asset:'option',mode:'demo',horizon:'swing',direction:'short',entryPrice:5,quantity:2,multiplier:100,fees:4,notes:'Test'};
    const opened = await f.request('/api/journal','POST',body); assert.equal(opened.status,201);
    const {entry} = await opened.json() as {entry:{id:string}};
    const closed = await f.request(`/api/journal/${entry.id}`,'PATCH',{exitPrice:3,fees:6});
    assert.equal(closed.status,200); assert.equal((await closed.json() as {entry:{pnl:number}}).entry.pnl,394);
    assert.equal((await f.request(`/api/journal/${entry.id}`,'PATCH',{exitPrice:2})).status,409);
    assert.equal((await f.request('/api/journal','POST',{...body,asset:'stock'})).status,400);
    assert.equal((await f.request('/api/journal','POST',{...body,quantity:0.5})).status,400);
    const worthless = await f.request('/api/journal','POST',{...body,direction:'long',quantity:1,fees:0});
    const worthlessId = (await worthless.json() as {entry:{id:string}}).entry.id;
    const expired = await f.request(`/api/journal/${worthlessId}`,'PATCH',{exitPrice:0});
    assert.equal(expired.status,200); assert.equal((await expired.json() as {entry:{pnl:number}}).entry.pnl,-500);
  } finally {await f.close();}
});
