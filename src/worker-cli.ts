import fs from "node:fs";
import { loadConfig } from "./config.js";
import { delegate, detectDesktopApps, detectWorkers, fanout } from "./workers.js";

const C={
  reset:"\x1b[0m",bold:"\x1b[1m",dim:"\x1b[2m",green:"\x1b[32m",yellow:"\x1b[33m",red:"\x1b[31m",cyan:"\x1b[36m",blue:"\x1b[34m"
};
const color=(c:string,s:string)=>process.env.NO_COLOR?s:c+s+C.reset;
function arg(name:string){
  const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:undefined;
}
function has(name:string){return process.argv.includes(name);}
function promptValue(){
  const p=arg("--prompt");if(p)return p;
  const f=arg("--prompt-file");if(f)return requireText(f);
  return "";
}
function requireText(file:string){
  return fs.readFileSync(file,"utf8");
}
async function main(){
  const cmd=process.argv[2]||"detect";
  const json=has("--json");
  if(cmd==="detect"||cmd==="list"){
    const rows=detectWorkers();
    if(json){console.log(JSON.stringify(rows,null,2));return;}
    console.log(color(C.bold,"Local agent workers"));
    for(const w of rows){
      const mark=w.detected?color(C.green,"●"):color(C.dim,"○");
      console.log(`  ${mark} ${w.label.padEnd(24)} ${w.detected?w.path:"not installed"}${w.automation!=="supported"?"  "+color(C.yellow,w.automation):""}`);
    }
    const apps=detectDesktopApps();
    if(apps.length){
      console.log("\n"+color(C.bold,"Desktop apps"));
      for(const a of apps) console.log(`  ${color(C.green,"●")} ${a.label.padEnd(24)} ${a.desktopFile}  ${color(C.yellow,a.automation)}`);
    }
    return;
  }
  const config=loadConfig();
  const prompt=promptValue();
  if(!prompt)throw new Error("Provide --prompt TEXT or --prompt-file FILE");
  const cwd=arg("--cwd");
  if(cmd==="delegate"){
    const result=await delegate(config,{worker:arg("--worker"),pool:arg("--pool"),prompt,cwd});
    if(json){console.log(JSON.stringify(result,null,2));return;}
    console.log(color(C.cyan,`Worker: ${result.worker}  •  ${(result.durationMs/1000).toFixed(1)}s  •  exit ${result.code}`));
    if(result.stdout)console.log(result.stdout);
    if(result.stderr)console.error(color(result.code?C.red:C.dim,result.stderr));
    process.exitCode=result.code;
    return;
  }
  if(cmd==="fanout"){
    const pool=arg("--pool")||"subscriptions";
    const results=await fanout(config,{pool,prompt,cwd});
    if(json){console.log(JSON.stringify(results,null,2));return;}
    for(const r of results){
      console.log("\n"+color(C.bold+C.cyan,`══ ${r.worker} • ${(r.durationMs/1000).toFixed(1)}s • exit ${r.code} ══`));
      if(r.stdout)console.log(r.stdout);
      if(r.stderr)console.error(color(C.red,r.stderr));
    }
    if(results.some(r=>r.code!==0))process.exitCode=1;
    return;
  }
  throw new Error(`Unknown worker command "${cmd}"`);
}
main().catch(e=>{console.error(color(C.red,"ROTOXY: "+e.message));process.exit(1);});
