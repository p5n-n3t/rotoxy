import test from "node:test";
import assert from "node:assert/strict";
import { classifyRequest, resolveRoute } from "../dist/router.js";

function baseConfig(){
  process.env.KEY_A1="a1";process.env.KEY_A2="a2";process.env.KEY_B1="b1";process.env.KEY_OR="or";
  return {
    version:2,listen:{host:"127.0.0.1",port:2025},security:{tokenFile:"/tmp/token"},
    exposure:{mode:"none",layout:"single",servicePrefix:"rotoxy"},defaultPool:"a",
    providers:{
      a:{id:"a",label:"A",adapter:"openai",wire:"openai",baseUrl:"https://a.invalid",auth:{kind:"bearer",header:"Authorization",prefix:"Bearer "},accounts:[{id:"a1",name:"A1",secret:"KEY_A1"},{id:"a2",name:"A2",secret:"KEY_A2"}]},
      b:{id:"b",label:"B",adapter:"openai",wire:"openai",baseUrl:"https://b.invalid",auth:{kind:"bearer",header:"Authorization",prefix:"Bearer "},accounts:[{id:"b1",name:"B1",secret:"KEY_B1"}]},
      or:{id:"or",label:"OpenRouter",adapter:"openrouter",wire:"openai",baseUrl:"https://openrouter.ai/api",auth:{kind:"bearer",header:"Authorization",prefix:"Bearer "},policy:{freeOnly:true},defaultModel:"openrouter/free",accounts:[{id:"or1",name:"OR1",secret:"KEY_OR"}]}
    },
    pools:{
      a:{id:"a",label:"A",type:"provider",strategy:"round-robin",provider:"a"},
      b:{id:"b",label:"B",type:"provider",strategy:"round-robin",provider:"b"},
      or:{id:"or",label:"OR",type:"provider",strategy:"round-robin",provider:"or"},
      fed:{id:"fed",label:"Federated",type:"federated",strategy:"round-robin",targets:[{provider:"a",model:"model-a"},{provider:"b",model:"model-b"}]}
    },
    routers:{
      task:{enabled:true,fallbackPool:"a",mappings:{coding:{pool:"fed",model:"model-a"},debugging:{pool:"a",model:"debug-model"}}},
      difficulty:{enabled:true,fallbackPool:"a",mappings:{easy:{pool:"a",model:"easy-model"},medium:{pool:"b",model:"medium-model"},hard:{pool:"fed",model:"hard-model"}}},
      autoPolicy:"task-then-difficulty"
    },
    workers:{profiles:{},pools:{}}
  };
}
test("classifies debugging task difficulty",()=>{
  const c=classifyRequest({messages:[{content:"Debug failing distributed TypeScript proxy tests and redesign the architecture"}]});
  assert.equal(c.task,"debugging");assert.equal(c.difficulty,"hard");
});
test("rotates accounts inside one provider",()=>{
  const cfg=baseConfig();
  const r1=resolveRoute(cfg,"/v1/chat/completions",{}, {model:"x"}).decision;
  const r2=resolveRoute(cfg,"/v1/chat/completions",{}, {model:"x"}).decision;
  assert.notEqual(r1.accountId,r2.accountId);assert.equal(r1.providerId,"a");assert.equal(r2.providerId,"a");
});
test("federated pool rotates equivalent models across providers",()=>{
  const cfg=baseConfig();
  const r1=resolveRoute(cfg,"/pool/fed/v1/chat/completions",{}, {model:"rotoxy/pool/fed"}).decision;
  const r2=resolveRoute(cfg,"/pool/fed/v1/chat/completions",{}, {model:"rotoxy/pool/fed"}).decision;
  assert.notEqual(r1.providerId,r2.providerId);
  assert.deepEqual(new Set([r1.upstreamModel,r2.upstreamModel]),new Set(["model-a","model-b"]));
  assert.equal(r1.path,"/v1/chat/completions");
});
test("smart task and difficulty routes resolve without URL changes",()=>{
  const cfg=baseConfig();
  const a=resolveRoute(cfg,"/smart/task/v1/chat/completions",{}, {model:"rotoxy/auto",messages:[{content:"debug a failing unit test"}]}).decision;
  assert.equal(a.poolId,"a");assert.equal(a.upstreamModel,"debug-model");
  const b=resolveRoute(cfg,"/smart/difficulty/v1/chat/completions",{}, {model:"x",messages:[{content:"Design and debug a comprehensive distributed architecture migration with multiple systems"}]}).decision;
  assert.equal(b.poolId,"fed");
});
test("OpenRouter free-only policy blocks paid models",()=>{
  const cfg=baseConfig();
  assert.throws(()=>resolveRoute(cfg,"/p/or/v1/chat/completions",{}, {model:"openai/gpt-paid"}),/free-only policy blocked/);
  const ok=resolveRoute(cfg,"/p/or/v1/chat/completions",{}, {model:"openrouter/free"}).decision;
  assert.equal(ok.providerId,"or");assert.equal(ok.upstreamModel,"openrouter/free");
});
