import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const stateRoot=fs.mkdtempSync(path.join(os.tmpdir(),"rotoxy-test-state-"));
process.env.ROTOXY_STATE_DIR=stateRoot;
const { createRotoxyServer } = await import("../dist/server.js");

const listen=(s)=>new Promise(r=>s.listen(0,"127.0.0.1",()=>r(s.address().port)));
const close=(s)=>new Promise(r=>s.close(()=>r()));
const request=(port,path,token,body)=>new Promise((resolve,reject)=>{
  const raw=body?JSON.stringify(body):"";
  const req=http.request({hostname:"127.0.0.1",port,path,method:body?"POST":"GET",headers:{...(token?{Authorization:"Bearer "+token}:{}),...(body?{"content-type":"application/json","content-length":Buffer.byteLength(raw)}:{})}},res=>{
    const chunks=[];res.on("data",d=>chunks.push(d));res.on("end",()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
  });req.on("error",reject);if(raw)req.write(raw);req.end();
});
test("gateway enforces client token and rotates upstream accounts",async()=>{
  const seen=[];
  const upstream=http.createServer((req,res)=>{let body="";req.on("data",d=>body+=d).on("end",()=>{seen.push({auth:req.headers.authorization,body:JSON.parse(body)});res.setHeader("content-type","application/json");res.end(JSON.stringify({usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5},ok:true}));});});
  const upPort=await listen(upstream);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rotoxy-test-"));const tokenFile=path.join(dir,"token");fs.writeFileSync(tokenFile,"client-secret");
  process.env.TEST_S1="up-one";process.env.TEST_S2="up-two";
  const config={version:2,listen:{host:"127.0.0.1",port:0},security:{tokenFile},exposure:{mode:"none",layout:"single",servicePrefix:"r"},defaultPool:"mock",providers:{mock:{id:"mock",label:"Mock",adapter:"openai",wire:"openai",baseUrl:`http://127.0.0.1:${upPort}`,auth:{kind:"bearer",header:"Authorization",prefix:"Bearer "},accounts:[{id:"one",name:"One",secret:"TEST_S1"},{id:"two",name:"Two",secret:"TEST_S2"}]}},pools:{mock:{id:"mock",label:"Mock",type:"provider",strategy:"round-robin",provider:"mock"}},routers:{task:{enabled:false,fallbackPool:"mock",mappings:{}},difficulty:{enabled:false,fallbackPool:"mock",mappings:{}},autoPolicy:"task-then-difficulty"},workers:{profiles:{},pools:{}}};
  const gateway=createRotoxyServer(config);const port=await listen(gateway);
  const denied=await request(port,"/__rotoxy/health",null);assert.equal(denied.status,401);
  const r1=await request(port,"/v1/chat/completions","client-secret",{model:"same",messages:[{content:"hi"}]});
  const r2=await request(port,"/v1/chat/completions","client-secret",{model:"same",messages:[{content:"hi"}]});
  assert.equal(r1.status,200);assert.equal(r2.status,200);
  assert.deepEqual(seen.map(x=>x.auth),["Bearer up-one","Bearer up-two"]);
  assert.equal(seen[0].body.model,"same");
  await close(gateway);await close(upstream);
  await new Promise(r=>setTimeout(r,250));
  fs.rmSync(dir,{recursive:true,force:true});
  fs.rmSync(stateRoot,{recursive:true,force:true});
});

test("MCP HTTP relay hides upstream credentials behind the ROTOXY token",async()=>{
  const seen=[];
  const upstream=http.createServer((req,res)=>{
    let body="";
    req.on("data",d=>body+=d).on("end",()=>{
      seen.push({auth:req.headers.authorization,protocol:req.headers["mcp-protocol-version"],body});
      res.writeHead(200,{"content-type":"application/json","mcp-session-id":"relay-test"});
      res.end(body||JSON.stringify({ok:true}));
    });
  });
  const upPort=await listen(upstream);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rotoxy-mcp-relay-"));
  const tokenFile=path.join(dir,"token");fs.writeFileSync(tokenFile,"front-door");
  process.env.MCP_UPSTREAM_TOKEN="provider-secret";
  const config={
    version:2,listen:{host:"127.0.0.1",port:0},security:{tokenFile},exposure:{mode:"none",layout:"single",servicePrefix:"r"},
    defaultPool:"mock",
    providers:{mock:{id:"mock",label:"Mock",adapter:"openai",wire:"openai",baseUrl:"http://127.0.0.1:1",auth:{kind:"bearer"},accounts:[{id:"one",name:"One",secret:"TEST_S1"}]}},
    pools:{mock:{id:"mock",label:"Mock",type:"provider",strategy:"round-robin",provider:"mock"}},
    routers:{task:{enabled:false,fallbackPool:"mock",mappings:{}},difficulty:{enabled:false,fallbackPool:"mock",mappings:{}},autoPolicy:"task-then-difficulty"},
    workers:{profiles:{},pools:{}},
    mcp:{servers:{memory:{id:"memory",label:"Memory",transport:"streamable-http",url:`http://127.0.0.1:${upPort}/mcp`,bearerTokenSecret:"MCP_UPSTREAM_TOKEN",enabled:true}},assignments:{}}
  };
  const gateway=createRotoxyServer(config);const port=await listen(gateway);
  const payload=JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize"});
  const response=await new Promise((resolve,reject)=>{
    const req=http.request({hostname:"127.0.0.1",port,path:"/mcp/memory",method:"POST",headers:{
      Authorization:"Bearer front-door","content-type":"application/json","content-length":Buffer.byteLength(payload),"mcp-protocol-version":"2025-11-25"
    }},res=>{const chunks=[];res.on("data",d=>chunks.push(d));res.on("end",()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));});
    req.on("error",reject);req.end(payload);
  });
  assert.equal(response.status,200);
  assert.equal(response.headers["mcp-session-id"],"relay-test");
  assert.equal(seen[0].auth,"Bearer provider-secret");
  assert.equal(seen[0].protocol,"2025-11-25");
  assert.equal(seen[0].body,payload);
  await close(gateway);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});
});
