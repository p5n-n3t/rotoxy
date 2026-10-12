import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { StateStore } from '../dist/store.js';

test('CLI SIGTERM removes its owned bridge socket and the same supervisor can restart', {timeout:90000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 't2o-cli-stop-'));
  const before = process.env.TOKEN2OAUTH_CONFIG_DIR;
  process.env.TOKEN2OAUTH_CONFIG_DIR = directory;
  let child;
  try {
    const store = new StateStore();
    await store.init({adminPassword:'isolated-cli-stop-only'});
    const account = await store.addAccount({label:'Isolated shutdown fixture',token:'fixture-not-a-provider-credential'});
    const policy = join(directory,'runtime.json');
    await writeFile(policy, JSON.stringify({version:1,maxWorkers:1,allowUnknownQuota:true,
      localLimits:{maxTasks:10,maxJobBytes:65536,maxOutputBytes:4096},
      projects:[{projectId:'fixture',clientIds:['fixture-client'],accountIds:[account.id],registeredSessions:[{sessionId:"fixture-session",accountId:account.id,model:"gpt-6-luna",workspaceId:"fixture-workspace"}]}]}), {mode:0o600});
    const reservation = createServer();
    await new Promise(r=>reservation.listen(0,'127.0.0.1',r));
    const port = reservation.address().port;
    await new Promise(r=>reservation.close(r));
    for(let attempt=0;attempt<2;attempt++) {
      child=spawn(process.execPath,[resolve('dist/cli.js'),'serve','--host','127.0.0.1','--port',String(port),'--supervisor-config',policy],
        {env:{...process.env,HOME:directory,TOKEN2OAUTH_CONFIG_DIR:directory},stdio:['ignore','ignore','pipe']});
      let diagnostic='';child.stderr.on('data',part=>{diagnostic+=part.toString().slice(0,1000);});
      const exited=once(child,'exit');
      let ready=false;
      const deadline=Date.now()+40_000;
      while(Date.now()<deadline) {
        if(child.exitCode!==null)throw Error('CLI exited before ready: '+diagnostic);
        try {ready=(await fetch(`http://127.0.0.1:${port}/healthz`,{signal:AbortSignal.timeout(1000)})).ok;}catch{}
        if(ready)break;
        await new Promise(r=>setTimeout(r,100));
      }
      assert.ok(ready);
      await access(join(directory,'supervisor.sock'));
      child.kill('SIGTERM');
      const [code,signal]=await exited;
      assert.equal(code,0);assert.equal(signal,null);
      await assert.rejects(access(join(directory,'supervisor.sock')));
      child=undefined;
    }
  } finally {
    child?.kill('SIGKILL');
    if(before===undefined)delete process.env.TOKEN2OAUTH_CONFIG_DIR;else process.env.TOKEN2OAUTH_CONFIG_DIR=before;
    await rm(directory,{recursive:true,force:true});
  }
});
