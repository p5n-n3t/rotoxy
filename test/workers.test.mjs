import test from "node:test";
import assert from "node:assert/strict";
import { runWorker, fanout } from "../dist/workers.js";

test("custom worker receives delegated prompt without shell interpolation",async()=>{
  const p={id:"mock",label:"Mock",adapter:"custom",command:process.execPath,args:["-e","process.stdout.write(process.argv[1])"],enabled:true,timeoutSeconds:5};
  const out=await runWorker(p,"hello ; $(do-not-run)");
  assert.equal(out.code,0);assert.equal(out.stdout,"hello ; $(do-not-run)");
});
test("fanout executes every enabled worker in the selected pool",async()=>{
  const mk=(id)=>({id,label:id,adapter:"custom",command:process.execPath,args:["-e",`process.stdout.write("${id}:\u0020"+process.argv[1])`],enabled:true,timeoutSeconds:5});
  const config={workers:{profiles:{one:mk("one"),two:mk("two")},pools:{subs:{id:"subs",label:"subs",strategy:"round-robin",workers:["one","two"]}}}};
  const results=await fanout(config,{pool:"subs",prompt:"task"});
  assert.equal(results.length,2);assert.deepEqual(results.map(x=>x.code),[0,0]);assert.match(results[0].stdout,/task/);assert.match(results[1].stdout,/task/);
});
