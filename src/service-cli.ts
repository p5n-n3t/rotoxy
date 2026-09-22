import { loadConfig } from "./config.js";

const C={reset:"\x1b[0m",bold:"\x1b[1m",dim:"\x1b[2m",green:"\x1b[32m",yellow:"\x1b[33m",cyan:"\x1b[36m"};
const p=(c:string,s:string)=>process.env.NO_COLOR?s:c+s+C.reset;
const config=loadConfig();
const prefix=config.exposure.servicePrefix||"rotoxy";

type Endpoint={name:string,service:string,path:string,kind:string};
const eps:Endpoint[]=[];
for(const provider of Object.values(config.providers).filter(x=>x.enabled!==false)){
  eps.push({name:provider.label,service:`svc:${prefix}-${provider.id}`,path:`/p/${provider.id}`,kind:"provider"});
}
for(const pool of Object.values(config.pools).filter(x=>x.enabled!==false&&x.type==="federated")){
  eps.push({name:pool.label,service:`svc:${prefix}-pool-${pool.id}`,path:`/pool/${pool.id}`,kind:"pool"});
}
if(config.routers.task.enabled)eps.push({name:"Task smart router",service:`svc:${prefix}-task`,path:"/smart/task",kind:"router"});
if(config.routers.difficulty.enabled)eps.push({name:"Difficulty smart router",service:`svc:${prefix}-difficulty`,path:"/smart/difficulty",kind:"router"});
if(config.routers.task.enabled||config.routers.difficulty.enabled)eps.push({name:"Automatic smart router",service:`svc:${prefix}-auto`,path:"/smart/auto",kind:"router"});

const cmd=process.argv[2]||"plan";
if(cmd==="machine"){
  for(const e of eps)console.log([e.service,e.path,e.name].join("\t"));
}else if(cmd==="json"){
  console.log(JSON.stringify(eps,null,2));
}else{
  console.log(p(C.bold,"ROTOXY endpoint plan"));
  console.log("  One URL is the default. Named Services are optional advanced aliases.");
  console.log("");
  for(const e of eps){
    console.log(`  ${p(C.green,"●")} ${p(C.cyan,e.service)}`);
    console.log(`    ${e.name} • routes through ${e.path}`);
  }
  console.log("");
  console.log(p(C.yellow,"Tailscale Services must exist/receive tailnet approval before their MagicDNS names become usable."));
}
