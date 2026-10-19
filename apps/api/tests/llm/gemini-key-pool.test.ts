import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiKeyPool } from '../../src/modules/llm/gemini-key-pool.js';
import { createChatEngine, loadChatConfig } from '../../src/modules/llm/chat-bootstrap.js';
import { GeminiProvider, CHAT_MODEL_ID } from '../../src/modules/llm/providers/gemini/gemini-provider.js';
import { ProviderCredential } from '../../src/modules/llm/provider-credential.js';
import { geminiFrame, providerResponse } from './gemini-fixture.js';
import type { LLMStreamEvent, ResolvedLLMRequest } from '../../src/modules/llm/types.js';
const keys = ['test-only-placeholder-key-one', 'test-only-placeholder-key-two'];
const url = 'https://generativelanguage.googleapis.com/test';
const req = (signal = new AbortController().signal): ResolvedLLMRequest => ({ modelAlias: 'giga-chat-default', providerId:'gemini', modelId: CHAT_MODEL_ID, messages:[{role:'user',content:'Hi'}], maxOutputTokens:32, caller:'chat', requestId:'test', signal });

describe('backend Gemini key pool', () => {
  it('validates bounded JSON configuration without leaking values and preserves legacy key', () => {
    const env = { CHAT_ENABLED:'true', CHAT_MODEL_ID, GEMINI_API_KEY: keys[0] };
    assert.equal(loadChatConfig(env, true)?.apiKey, keys[0]);
    assert.deepEqual(loadChatConfig({...env,GEMINI_API_KEYS:JSON.stringify([...keys,keys[0]])},true)?.apiKeys, keys);
    for (const raw of ['', '{}', '[]', JSON.stringify(['x']), JSON.stringify(Array(9).fill(keys[0])), '["private-secret-invalid']) {
      assert.throws(() => loadChatConfig({...env,GEMINI_API_KEYS:raw},true), error => {
        assert.equal((error as Error).message.includes('private-secret-invalid'),false); return true;
      });
    }
  });
  it('rotates requests, deduplicates keys and serializes no secrets', async () => {
    const pool = new GeminiKeyPool([...keys,keys[0]!]); const seen:string[]=[];
    for(let i=0;i<4;i++) await pool.request(async(_,init)=>{seen.push(new Headers(init.headers).get('x-goog-api-key')!);return new Response('ok');},url,{});
    assert.deepEqual(seen,[...keys,...keys]);
    assert.equal(JSON.stringify(pool).includes(keys[0]!),false);
  });
  it('honors Retry-After, skips cooled keys, recovers and bounds exhaustion attempts', async () => {
    let now=0;let calls=0;const pool=new GeminiKeyPool(keys,()=>now);
    const transport = async()=>{calls++;return new Response(null,{status:429,headers:{'retry-after':'120'}});};
    assert.equal((await pool.request(transport,url,{})).status,429);assert.equal(calls,2);
    const blocked=await pool.request(transport,url,{});assert.equal(calls,2);assert.equal(blocked.headers.get('retry-after'),'120');
    now=119000;await pool.request(transport,url,{});assert.equal(calls,2);
    now=120000;await pool.request(async()=>{calls++;return new Response('ok');},url,{});assert.equal(calls,3);
  });
  it('disables rejected credentials and cancels discarded error bodies', async () => {
    const pool = new GeminiKeyPool(keys);let calls=0;let cancelled=0;
    const response=await pool.request(async()=>{calls++;return calls===1?new Response(new ReadableStream({cancel(){cancelled++;}}),{status:403}):new Response('ok');},url,{});
    assert.equal(response.status,200);assert.equal(cancelled,1);
    await pool.request(async(_,init)=>{assert.equal(new Headers(init.headers).get('x-goog-api-key'),keys[1]);calls++;return new Response('ok');},url,{});
    assert.equal(calls,3);
    const rejected=new GeminiKeyPool(keys);let rejects=0;
    for(let i=0;i<2;i++)assert.equal((await rejected.request(async()=>{rejects++;return new Response(null,{status:401});},url,{})).status,403);
    assert.equal(rejects,2);
  });
  it('does not retry ambiguous network exceptions or successful HTTP bodies', async () => {
    const pool = new GeminiKeyPool(keys);let calls=0;
    await assert.rejects(pool.request(async()=>{calls++;throw new Error('network');},url,{}));assert.equal(calls,1);
    const response=await pool.request(async()=>{calls++;return new Response('partial');},url,{});
    assert.equal(await response.text(),'partial');assert.equal(calls,2);
  });
  it('aborts before transport and between attempts without trying the next key', async () => {
    const pool = new GeminiKeyPool(keys);const controller=new AbortController();let calls=0;
    await assert.rejects(pool.request(async()=>{calls++;controller.abort();return new Response(null,{status:429});},url,{signal:controller.signal}));
    assert.equal(calls,1);await assert.rejects(pool.request(async()=>{calls++;return new Response();},url,{signal:controller.signal}));assert.equal(calls,1);
  });
  it('never redirects BYOK to the platform pool, including invalid BYOK', async () => {
    let calls=0;const provider=new GeminiProvider(async(_,init)=>{calls++;assert.equal(new Headers(init.headers).get('x-goog-api-key'),'test-only-user-credential');return new Response(null,{status:403});},100,new GeminiKeyPool(keys));
    await assert.rejects(provider.generateText(req(),new ProviderCredential('test-only-user-credential','user')),{code:'BYOK_CREDENTIAL_INVALID'});assert.equal(calls,1);
  });
  it('uses one overall adapter deadline across attempts', async () => {
    let calls=0;const provider=new GeminiProvider(async(_,init)=>{calls++;if(calls===1)return new Response(null,{status:429});return await new Promise<Response>((_,reject)=>{init.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});},20,new GeminiKeyPool(keys));
    await assert.rejects(provider.generateText(req(),new ProviderCredential(keys[0]!,'platform')),{code:'PROVIDER_TIMEOUT'});assert.equal(calls,2);
  });
  it('does not replay a truncated stream after emitting partial text', async () => {
    let calls=0;const provider=new GeminiProvider(async()=>{calls++;return providerResponse(geminiFrame('partial'));},100,new GeminiKeyPool(keys));
    const events: LLMStreamEvent[]=[];await assert.rejects(async()=>{for await(const event of provider.streamText(req(),new ProviderCredential(keys[0]!,'platform')))events.push(event);},{code:'PROVIDER_FAILURE'});
    assert.equal(calls,1);assert.deepEqual(events,[{type:'text.delta',text:'partial'}]);
  });
  it('bootstraps the pool and completes exactly one generation after pre-stream failover', async () => {
    let calls=0;const engine=createChatEngine(loadChatConfig({CHAT_ENABLED:'true',CHAT_MODEL_ID,GEMINI_API_KEYS:JSON.stringify(keys)},true),async()=>++calls===1?new Response(null,{status:429}):providerResponse())!;
    const events: LLMStreamEvent[]=[];for await(const event of engine.streamText(req()))events.push(event);
    assert.equal(calls,2);assert.equal(events.filter(e=>e.type==='completed').length,1);
  });
});
