import fs from "node:fs";
import { CONFIG_FILE, loadConfig } from "./config.js";
import { createRotoxyServer, shutdownUsage } from "./server.js";

const config=loadConfig();
const server=createRotoxyServer(config);

let reloadTimer:NodeJS.Timeout|undefined;
fs.watchFile(CONFIG_FILE,{interval:1000},()=>{
  if(reloadTimer)clearTimeout(reloadTimer);
  reloadTimer=setTimeout(()=>{
    try{
      const next=loadConfig();
      for(const key of Object.keys(config)) delete (config as any)[key];
      Object.assign(config,next);
      console.log(`ROTOXY config reloaded • default pool=${config.defaultPool}`);
    }catch(e:any){console.error("ROTOXY config reload rejected:",e.message);}
  },100);
});

server.listen(config.listen.port,config.listen.host,()=>{
  console.log(`ROTOXY v2.1.0 listening on http://${config.listen.host}:${config.listen.port}`);
  console.log(`providers=${Object.keys(config.providers).length} pools=${Object.keys(config.pools).length} default=${config.defaultPool}`);
  console.log("Secrets are loaded from the private ROTOXY config directory and are never logged.");
});

for(const sig of ["SIGTERM","SIGINT"] as const){
  process.on(sig,()=>{
    fs.unwatchFile(CONFIG_FILE);
    shutdownUsage();
    server.close(()=>process.exit(0));
    setTimeout(()=>process.exit(0),2000).unref();
  });
}
