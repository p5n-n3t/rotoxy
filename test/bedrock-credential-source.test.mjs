import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm,symlink} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {loadBedrockCredentialSource} from '../dist/bedrock-credential-source.js';
test('Bedrock source reads only allowlisted settings, denies shared files and symlinks',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'rotoxy-bedrock-source-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'settings.json');
 const saved={};for(const key of ['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_REGION']){saved[key]=process.env[key];delete process.env[key];}t.after(()=>{for(const[key,value]of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;});
 await writeFile(path,JSON.stringify({env:{AWS_ACCESS_KEY_ID:'synthetic-access',AWS_SECRET_ACCESS_KEY:'synthetic-secret',AWS_REGION:'eu-north-1',UNRELATED_SECRET:'omit-me',ANTHROPIC_BASE_URL:'https://untrusted.invalid'}}),{mode:0o600});
 const env=await loadBedrockCredentialSource(path);assert.equal(env.AWS_ACCESS_KEY_ID,'synthetic-access');assert.equal(env.CLAUDE_CODE_USE_BEDROCK,'1');assert.equal(env.UNRELATED_SECRET,undefined);assert.equal(env.ANTHROPIC_BASE_URL,undefined);
 await chmod(path,0o644);await assert.rejects(loadBedrockCredentialSource(path),/source_invalid/);await chmod(path,0o600);
 const link=join(dir,'link');await symlink(path,link);await assert.rejects(loadBedrockCredentialSource(link),/source_invalid/);
 await writeFile(path,JSON.stringify({env:{AWS_ACCESS_KEY_ID:'synthetic-alone'}}));await assert.rejects(loadBedrockCredentialSource(path),/pair_incomplete/);
});
