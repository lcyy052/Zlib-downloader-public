import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startRuntimeDiagnostics, safeDiagnosticError } from '../src/runtime-diagnostics.js';
const run=promisify(execFile);
test('diagnostics rotate and keep memory data without credentials or environment',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'zlib-runtime-'));
  const d=startRuntimeDiagnostics({directory:dir,getStatus:()=>({jobs:42,paused:true})});t.after(()=>{d.close();return rm(dir,{recursive:true,force:true});});
  await writeFile(d.file,'x'.repeat(2*1024*1024+1));d.record('fixture');
  const records=(await readFile(d.file,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(records[0].event,'fixture');assert.equal(records[0].status.jobs,42);assert.ok(records[0].memory.rss>0);assert.equal((await readFile(d.file+'.1','utf8')).length,2*1024*1024+1);
  const sampleUrl=new URL('https://example.com/file');sampleUrl.searchParams.set('token','private');
  const e=safeDiagnosticError(new Error(sampleUrl.href+' cookie=private'));assert.ok(!JSON.stringify(e).includes('private'));assert.ok(!records[0].env);
});
test('fatal monitor logs the error but does not suppress default process termination',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'zlib-runtime-fatal-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const url=new URL('../src/runtime-diagnostics.js',import.meta.url).href;
  const source=`import{startRuntimeDiagnostics}from${JSON.stringify(url)};startRuntimeDiagnostics({directory:${JSON.stringify(dir)}});throw Error('fixture-runtime-fatal');`;
  await assert.rejects(run(process.execPath,['--input-type=module','-e',source],{windowsHide:true}),e=>e.code===1);
  const records=(await readFile(path.join(dir,'runtime.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(records.some(r=>r.event==='fatal'&&r.error.message==='fixture-runtime-fatal'));assert.ok(records.some(r=>r.event==='exit'&&r.code===1));
});
