import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { Client } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';

function queryWorker(worker:Worker,sql:string,params:unknown[]=[]):any {
  const responseBuffer=new SharedArrayBuffer(8+1024*1024);
  const header=new Int32Array(responseBuffer,0,2);
  Atomics.store(header,0,0);
  Atomics.store(header,1,0);
  worker.postMessage({action:'query',sql,params,responseBuffer});
  const wait=Atomics.wait(header,0,0,15_000);
  if(wait==='timed-out')throw new Error('The database worker did not answer within 15 seconds.');
  const length=Atomics.load(header,1);
  if(length<=0 || length>responseBuffer.byteLength-8)throw new Error('The database worker returned an invalid response.');
  const response=JSON.parse(Buffer.from(new Uint8Array(responseBuffer,8,length)).toString('utf8'));
  if(response.error){
    const error=new Error(response.error.message||'PostgreSQL query failed.') as Error & {code?:string};
    error.code=response.error.code;
    throw error;
  }
  return response;
}

test('reconnects the database worker after PostgreSQL terminates its idle session', {skip:process.env.RELAY_RUN_DB_TESTS!=='true'}, async()=>{
  assert.ok(process.env.DATABASE_URL,'DATABASE_URL is required for the database worker recovery test.');
  const worker=new Worker(new URL('./db-worker.ts',import.meta.url),{
    workerData:{connectionString:process.env.DATABASE_URL},
    ...(process.execArgv.length?{execArgv:process.execArgv}:{execArgv:['--import','tsx/esm']})
  });
  const administrator=new Client({connectionString:process.env.DATABASE_URL});
  try{
    const first=queryWorker(worker,'SELECT pg_backend_pid() AS pid');
    const backendPid=Number(first.rows[0]?.pid);
    assert.ok(backendPid>0,'the worker should establish a PostgreSQL session');
    await administrator.connect();
    const terminated=await administrator.query('SELECT pg_terminate_backend($1) AS terminated',[backendPid]);
    assert.equal(terminated.rows[0]?.terminated,true,'the test should terminate the worker database connection');
    await delay(250);
    const recovered=queryWorker(worker,'SELECT 42::int AS answer');
    assert.equal(recovered.rows[0]?.answer,42,'the worker should reconnect and complete a later query');
  }finally{
    await administrator.end().catch(()=>{});
    await worker.terminate();
  }
});
