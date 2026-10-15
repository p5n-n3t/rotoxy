import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

test('manual installer installs commands and units without starting or publishing anything',async(t)=>{
 const dir=await mkdtemp(join(tmpdir(),'rotoxy-install-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const home=join(dir,'home'),prefix=join(dir,'runtime'),bin=join(dir,'bin');
 for(const p of [home,bin,join(prefix,'scripts'),join(prefix,'packaging')])await mkdir(p,{recursive:true});
 await writeFile(join(prefix,'install.sh'),'#!/bin/bash\nexit 0\n',{mode:0o755});
 await writeFile(join(prefix,'scripts/rotoxy-control.mjs'),'#!/usr/bin/env node\n',{mode:0o755});
 for(const n of ['rotoxy.target','rotoxy-funnel.service','rotoxy-gateway.service','rotoxy-oracle-pool.service','rotoxy-worker-monitor.service'])await writeFile(join(prefix,'packaging',n),await readFile(resolve('packaging',n),'utf8'));
 await writeFile(join(bin,'tailscale'),'#!/bin/bash\n[[ "$*" == "status --json" ]] || exit 9\nprintf \'{"Self":{"DNSName":"fixture.example.ts.net."}}\'\n',{mode:0o755});
 await writeFile(join(bin,'systemctl'),'#!/bin/bash\nprintf "%s\\n" "$*" >> "$HOME/systemctl.log"\n[[ "$*" == *is-active* || "$*" == *is-enabled* ]] && exit 3\nexit 0\n',{mode:0o755});
 execFileSync('bash',[resolve('install-rotoxy.sh')],{env:{...process.env,HOME:home,TOKEN2OAUTH_PREFIX:prefix,PATH:bin+':'+process.env.PATH},stdio:'pipe'});
 const calls=await readFile(join(home,'systemctl.log'),'utf8');assert.doesNotMatch(calls,/(?:^| )enable(?: |$)|--now|(?:^| )start(?: |$)/m);assert.match(calls,/daemon-reload/);
 const service=await readFile(join(home,'.config/systemd/user/rotoxy-gateway.service'),'utf8');assert.match(service,/2030/);assert.doesNotMatch(service,/WantedBy/);
 assert.ok((await readFile(join(home,'.local/lib/rotoxy-control.mjs'),'utf8')).startsWith('#!'));
});
