import assert from 'node:assert/strict';
import test from 'node:test';
import { createRunConnection, isConnectionFailure } from '../web/src/agent/runConnection.ts';
class ApiError extends Error {
 status: number;
 data: unknown;
 constructor(message: string, status: number, data?: unknown) { super(message); this.name='ApiError'; this.status=status; this.data=data; }
}
const { reconnectRun } = createRunConnection(async (path, init) => {
 let response: Response;
 try { response=await fetch(`/omc/api/v1${path}`,init); } catch(error) { if(error instanceof TypeError) throw new ApiError('network',0); throw error; }
 if(!response.ok) throw new ApiError('terminal',response.status);
 return response;
});
import { readSSE } from '../web/src/agent/sse.ts';

function stream(body: string): Response { return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }); }
const DONE = 'event: done\ndata: {}\n\n';

test('network status zero retries, authentication and missing journals do not', () => {
 assert.equal(isConnectionFailure(new ApiError('network', 0)), true);
 for (const status of [400, 401, 403, 404, 409]) assert.equal(isConnectionFailure(new ApiError('terminal', status)), false);
 assert.equal(isConnectionFailure(new SyntaxError('malformed event')), false);
});

test('a lost POST acknowledgement recovers by GET only, using the original id', async () => {
 const originalFetch = globalThis.fetch;
 const calls: { url: string; method: string; id: string | undefined }[] = [];
 let replays = 0;
 try {
  globalThis.fetch = async (url, init) => {
   calls.push({ url: String(url), method: init?.method ?? 'GET', id: (init?.headers as Record<string,string>)?.['X-OMC-Run-ID'] });
   if (calls.length === 1) throw new TypeError('lost acknowledgement');
   return stream('event: delta\ndata: {"content":"complete"}\n\n' + DONE);
  };
  const frames = [];
  for await (const frame of reconnectRun({ workspace: 'playground', id: 'original', signal: new AbortController().signal, initial: { method: 'POST', body: '{}' }, replay: () => { replays++; }, waitForRetry: async () => {} })) frames.push(frame);
  assert.deepEqual(calls.map(call => call.method), ['POST','GET']);
  assert.deepEqual(calls.map(call => call.url), ['/omc/api/v1/playground/chat','/omc/api/v1/playground/runs/original']);
  assert.ok(calls.every(call => call.id === 'original'));
  assert.equal(replays,1); assert.equal(frames.length,2);
 } finally { globalThis.fetch = originalFetch; }
});

test('partial SSE reconnect resets before replay, never appending duplicated tokens', async () => {
 const originalFetch = globalThis.fetch;
 let calls = 0;
 let answer = '';
 try {
  globalThis.fetch = async () => ++calls === 1 ? stream('event: delta\ndata: {"content":"half"}\n\n') : stream('event: delta\ndata: {"content":"whole"}\n\n' + DONE);
  for await (const frame of reconnectRun({ workspace:'playground', id:'same', signal:new AbortController().signal, initial:{method:'POST'}, replay:()=>{answer='';}, waitForRetry:async()=>{} })) {
   if (frame.event==='delta') answer+=JSON.parse(frame.data).content;
  }
  assert.equal(answer,'whole'); assert.equal(calls,2);
 } finally { globalThis.fetch=originalFetch; }
});

test('a missing accepted run never repeats generation, including after process restart', async () => {
 const originalFetch = globalThis.fetch;
 const methods:string[]=[];
 try {
  globalThis.fetch = async (_,init) => { methods.push(init?.method??'GET'); if (methods.length===1) throw new TypeError('disconnected'); return new Response('{"code":"run_not_found"}', {status:404}); };
  await assert.rejects(async()=>{ for await (const _frame of reconnectRun({workspace:'agent',id:'lost',signal:new AbortController().signal,initial:{method:'POST'},replay:()=>{},waitForRetry:async()=>{}})) {} }, error=>error instanceof ApiError && error.status===404);
  assert.deepEqual(methods,['POST','GET']);
 } finally {globalThis.fetch=originalFetch;}
});

test('abort releases a pending SSE read rather than waiting for another network byte', async () => {
 const controller=new AbortController();
 let wasCancelled=false;
 const source=new ReadableStream<Uint8Array>({cancel(){wasCancelled=true;}});
 const frames=readSSE(source,controller.signal);
 const read=frames.next();
 controller.abort();
 assert.equal((await read).done,true); assert.equal(wasCancelled,true);
});

test('offline waits for online rather than polling and cancellation retries only the stop command', async () => {
 const originalWindow = globalThis.window;
 const onlineDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
 const events = new EventTarget();
 const retries: string[] = [];
 let notifyFailure: () => void = () => {};
 const failed = new Promise<void>(resolve => { notifyFailure = resolve; });
 try {
  globalThis.window = events as unknown as Window & typeof globalThis;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
  const connection = createRunConnection(async path => {
   retries.push(path);
   if (retries.length === 1) { notifyFailure(); throw new ApiError('network', 0); }
   return new Response('{}');
  });
  const cancellation = connection.cancelRun('agent', 'original', new AbortController().signal);
  await failed;
  // The catch installs its online listener in the same microtask before another turn can run.
  await Promise.resolve();
  assert.equal(retries.length, 1);
  events.dispatchEvent(new Event('online'));
  await cancellation;
  assert.deepEqual(retries, ['/agent/runs/original/cancel','/agent/runs/original/cancel']);
 } finally {
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis,'window'); else globalThis.window=originalWindow;
  if (onlineDescriptor) Object.defineProperty(globalThis,'navigator',onlineDescriptor); else Reflect.deleteProperty(globalThis,'navigator');
 }
});

test('auth expiry stops recovery instead of infinitely retrying or resubmitting', async () => {
 let calls=0;
 const connection = createRunConnection(async () => { calls++; throw new ApiError('authentication_required',401); });
 await assert.rejects(async () => { for await (const _frame of connection.reconnectRun({ workspace:'agent',id:'original',signal:new AbortController().signal,replay:()=>{} })) {} }, error => error instanceof ApiError && error.status===401);
 assert.equal(calls,1);
});


test('a coded upstream refusal ends a managed run rather than replaying its failure forever', async () => {
 let calls=0;
 const connection = createRunConnection(async () => { calls++; throw new ApiError('gateway_unavailable',502,{code:'gateway_unavailable'}); });
 await assert.rejects(async () => { for await (const _frame of connection.reconnectRun({workspace:'playground',id:'refused',signal:new AbortController().signal,initial:{method:'POST'},replay:()=>{}})) {} }, error=>error instanceof ApiError && error.status===502);
 assert.equal(calls,1);
});

test('Stop can arrive before admission and stops retrying when its parent subscription ends', async () => {
 const originalWindow = globalThis.window;
 const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
 const events = new EventTarget();
 const controller = new AbortController();
 let calls=0;
 let notifyFirst: () => void = () => {};
 const first = new Promise<void>(resolve => { notifyFirst=resolve; });
 try {
  globalThis.window=events as unknown as Window & typeof globalThis;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{onLine:false}});
  const connection=createRunConnection(async () => { calls++; notifyFirst(); throw new ApiError('run_not_found',404,{code:'run_not_found'}); });
  const command=connection.cancelRun('agent','not-yet-admitted',controller.signal);
  await first; await Promise.resolve();
  assert.equal(calls,1);
  controller.abort();
  await assert.rejects(command,error => error instanceof DOMException && error.name==='AbortError');
  events.dispatchEvent(new Event('online'));
  assert.equal(calls,1);
 } finally {
  if(originalWindow===undefined) Reflect.deleteProperty(globalThis,'window'); else globalThis.window=originalWindow;
  if(descriptor) Object.defineProperty(globalThis,'navigator',descriptor); else Reflect.deleteProperty(globalThis,'navigator');
 }
});
