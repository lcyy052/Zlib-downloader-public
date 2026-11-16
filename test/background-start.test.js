import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { launchBackgroundProcess } from '../src/background-start.js';
const run = promisify(execFile);
const moduleUrl = new URL('../src/background-start.js', import.meta.url).href;
const fixture = `const http=require('node:http');const s=http.createServer((q,r)=>{r.end('alive');if(q.url==='/stop')s.close(()=>process.exit(0));if(q.url==='/crash')setImmediate(()=>{throw Error('fixture-fatal')})});s.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:s.address().port,pid:process.pid})));`;
async function ready(file) { for(let i=0;i<100;i++) { const text=await readFile(file,'utf8');if(text.trim())return JSON.parse(text.trim().split('\n')[0]);await new Promise(r=>setTimeout(r,20)); } throw Error('Fixture did not start'); }
async function directory() { return mkdtemp(path.join(os.tmpdir(),'zlib-background-')); }
async function cleanup(dir,url,pid) {
  if(url)await fetch(`${url}/stop`).catch(()=>{});
  for(let i=0;i<100&&pid;i++){try{process.kill(pid,0);}catch{break;}await new Promise(r=>setTimeout(r,20));}
  await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}

test('detached service stays alive after its launch process exits and logs shutdown', async t => {
  const dir=await directory();let url,pid;t.after(()=>cleanup(dir,url,pid));
  const parent=`import {launchBackgroundProcess} from ${JSON.stringify(moduleUrl)};console.log(JSON.stringify(await launchBackgroundProcess({args:['-e',${JSON.stringify(fixture)}],cwd:${JSON.stringify(dir)},logDirectory:${JSON.stringify(dir)}})));`;
  const {stdout}=await run(process.execPath,['--input-type=module','-e',parent],{timeout:10000,windowsHide:true});
  const logs=JSON.parse(stdout.trim());const child=await ready(logs.stdout);url=`http://127.0.0.1:${child.port}`;pid=child.pid;
  assert.equal(await(await fetch(url)).text(),'alive');
  await new Promise(r=>setTimeout(r,100));assert.equal(await(await fetch(url)).text(),'alive');
  assert.equal(await readFile(logs.stderr,'utf8'),'');
  await fetch(`${url}/stop`);
});

test('detached process fatal stderr is retained rather than lost with the terminal', async t => {
  const dir=await directory();let url,pid;t.after(()=>cleanup(dir,url,pid));const logs=await launchBackgroundProcess({args:['-e',fixture],cwd:dir,logDirectory:dir});const child=await ready(logs.stdout);
  url=`http://127.0.0.1:${child.port}`;pid=child.pid;await fetch(`${url}/crash`);
  for(let i=0;i<100;i++){if((await readFile(logs.stderr,'utf8')).includes('fixture-fatal'))break;await new Promise(r=>setTimeout(r,20));}
  assert.match(await readFile(logs.stderr,'utf8'),/fixture-fatal/);
});
