import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRotoxyServer } from "../dist/server.js";

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
  await close(gateway);await close(upstream);fs.rmSync(dir,{recursive:true,force:true});
});
