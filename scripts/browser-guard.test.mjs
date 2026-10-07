import test from 'node:test';
import assert from 'node:assert/strict';
import { createProblemLedger, guardBrowserContext } from './acceptance/browser-guard.mjs';
import { installRoutes } from './acceptance/probe.mjs';

test('an unrelated successful assertion cannot erase runtime and network faults', () => {
  const ledger = createProblemLedger();
  ledger.record({kind:'pageerror',message:'synthetic-unexpected-exception'});
  ledger.record({kind:'outbound',url:'https://unowned.test/'});
  assert.equal(ledger.unexpected().length,2);
  ledger.expect({kind:'pageerror',message:/^synthetic-unexpected-exception$/,count:1});
  assert.equal(ledger.unexpected().length,1);
  ledger.record({kind:'pageerror',message:'synthetic-unexpected-exception'});
  assert.equal(ledger.unexpected().length,2,'expectations cannot hide an unbounded fault');
  assert.throws(()=>ledger.expect({kind:'pageerror',count:1}));
});

test('network allowlist covers HTTP and sockets, and respects ports', async () => {
  let http, socket;
  const context={on(){},pages:()=>[],route:async(_,handler)=>{http=handler;},routeWebSocket:async(_,handler)=>{socket=handler;}};
  const ledger=await guardBrowserContext(context,['http://127.0.0.1:5180/omc']);
  let passed=0,blocked=0;
  const route=url=>({request:()=>({url:()=>url,method:()=> 'GET'}),fallback:()=>passed++,abort:()=>blocked++});
  await http(route('http://127.0.0.1:5180/omc/'));
  await http(route('http://127.0.0.1:9999/private'));
  socket({url:()=> 'ws://127.0.0.1:5180/',connectToServer:()=>passed++});
  socket({url:()=> 'wss://external.test/',close:()=>blocked++});
  assert.equal(passed,2);assert.equal(blocked,2);assert.equal(ledger.unexpected().length,2);
});

test('unknown API endpoints and wrong methods never receive an empty successful response', async () => {
  let handler;
  const context={route:async(_,callback)=>{handler=callback;}};
  const problems=[];
  await installRoutes(context,[],{record:problem=>problems.push(problem)});
  for(const [method,pathname] of [['GET','/omc/api/v1/unregistered'],['POST','/omc/api/v1/dashboard']]) {
    let response;
    await handler({request:()=>({url:()=>`http://127.0.0.1${pathname}`,method:()=>method}),fulfill:value=>{response=value;}});
    assert.equal(response.status,501);
  }
  assert.equal(problems.length,2);
});


test('global expectation matchers produce repeatable bounded verdicts', () => {
  const ledger = createProblemLedger();
  ledger.expect({kind: 'console', message: /^expected$/g, count: 2});
  for (let i = 0; i < 3; i += 1) ledger.record({kind: 'console', message: 'expected'});
  assert.equal(ledger.unexpected().length, 1);
  assert.equal(ledger.unexpected().length, 1);
});
