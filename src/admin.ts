import { redactString } from "./telemetry.js";

export interface SupervisionOracle {
  status?: string;
  model?: string;
  actualModel?: string;
  assignedHost?: string;
  result?: string;
}

export interface SupervisionEvent {
  id: string;
  eventId?: string;
  worker?: string;
  kind?: string;
  model?: string;
  at?: string | number;
  owner?: string;
  job?: string;
  ackAt?: string | number;
  guidanceState?: string;
  oracle?: SupervisionOracle;
}

export interface SupervisionModelHost {
  host: string;
  models: string[];
  updated?: string | number;
  error?: string;
}

export interface SupervisionInbox {
  available: boolean;
  events: SupervisionEvent[];
  models: SupervisionModelHost[];
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const MAX_EVENTS = 20;
const MAX_MODEL_HOSTS = 20;
const MAX_MODELS_PER_HOST = 30;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, max = 240): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return redactString(value.replace(CONTROL_CHARS, " "), max).slice(0, max);
}

function safeTime(value: unknown): string | number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return safeText(value, 100);
  return undefined;
}

function oracleValue(value: unknown): SupervisionOracle | undefined {
  if (!record(value)) return undefined;
  const oracle: SupervisionOracle = {
    status: safeText(value.status, 80),
    model: safeText(value.model, 120),
    actualModel: safeText(value.actual_model, 120),
    assignedHost: safeText(value.assigned_host, 160),
    result: safeText(value.result, 480),
  };
  return Object.values(oracle).some((part) => part !== undefined) ? oracle : undefined;
}

/** Keep only bounded fields from the selected project's supervision endpoint. */
export function normalizeSupervisionInbox(input: unknown): SupervisionInbox | undefined {
  if (!record(input) || typeof input.available !== "boolean") return undefined;
  const events = (Array.isArray(input.events) ? input.events : []).slice(0, MAX_EVENTS).flatMap((value): SupervisionEvent[] => {
    if (!record(value)) return [];
    const id = typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id > 0 ? String(value.id) : safeText(value.id, 160);
    if (!id) return [];
    const event: SupervisionEvent = {
      id,
      eventId: safeText(value.eventId, 160),
      worker: safeText(value.worker),
      kind: safeText(value.kind, 120),
      model: safeText(value.model, 120),
      at: safeTime(value.at),
      owner: safeText(value.owner, 160),
      job: safeText(value.job, 160),
      ackAt: safeTime(value.ack_at),
      guidanceState: safeText(value.guidance_state, 120),
      oracle: oracleValue(value.oracle),
    };
    return [event];
  });
  const models = (Array.isArray(input.models) ? input.models : []).slice(0, MAX_MODEL_HOSTS).flatMap((value): SupervisionModelHost[] => {
    if (!record(value)) return [];
    const host = safeText(value.host, 160);
    if (!host) return [];
    const names = Array.isArray(value.models)
      ? value.models.slice(0, MAX_MODELS_PER_HOST).flatMap((model) => {
          const name = safeText(model, 120);
          return name ? [name] : [];
        })
      : [];
    return [{ host, models: names, updated: safeTime(value.updated), error: safeText(value.error, 240) }];
  });
  return { available: input.available, events, models };
}

function attr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Same-origin, bounded and text-only inbox client. A POST is possible only after a CSRF token is rendered. */
export function renderSupervisionInboxScript(nonce: string): string {
  return `<script nonce="${attr(nonce)}">(()=>{
const root=document.getElementById("supervision-feed"),status=document.getElementById("supervision-status"),eventsNode=document.getElementById("supervision-events"),modelsNode=document.getElementById("supervision-models"),refresh=document.getElementById("supervision-refresh");
if(!root||!status||!eventsNode||!modelsNode||!refresh)return;
const MAX_BYTES=262144,MAX_TEXT=480;let current=null,closed=false;
const clean=(v,n=240)=>typeof v==="string"?v.replace(/[\\u0000-\\u001f\\u007f]/g," ").replace(/Bearer\\s+[A-Za-z0-9._~+\\/-]+=*/gi,"Bearer [REDACTED]").replace(/(api[_-]?key|token|secret)(\\s*[:=]\\s*)[^\\s,;]+/gi,"$1$2[REDACTED]").slice(0,n):"";
const eventId=v=>typeof v==="number"&&Number.isSafeInteger(v)&&v>0?String(v):clean(v,160);
const record=v=>!!v&&typeof v==="object"&&!Array.isArray(v);
const element=(tag,cls,value)=>{const n=document.createElement(tag);if(cls)n.className=cls;n.textContent=clean(value,MAX_TEXT);return n;};
const message=(host,value)=>host.replaceChildren(element("p","empty",value));
const timeText=v=>{if(typeof v==="number"&&Number.isFinite(v)){const ms=Math.abs(v)<100000000000?v*1000:v;try{return new Date(ms).toISOString();}catch{return "Time unavailable";}}return clean(v,100)||"Time unavailable";};
async function boundedJson(response){const len=response.headers.get("content-length");if(len&&/^\\d+$/.test(len)&&Number(len)>MAX_BYTES)throw new Error("size");if(!response.body)throw new Error("body");const reader=response.body.getReader(),chunks=[];let total=0;try{while(true){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>MAX_BYTES){await reader.cancel().catch(()=>{});throw new Error("size");}chunks.push(part.value);}}finally{reader.releaseLock();}const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder().decode(bytes));}
function field(row,label,value){const safe=clean(value);if(!safe)return;const line=element("div","supervision-field","");const name=document.createElement("strong");name.textContent=label+": ";const val=document.createElement("span");val.textContent=safe;line.append(name,val);row.append(line);}
function render(payload){if(!record(payload)||typeof payload.available!=="boolean"||!Array.isArray(payload.events)||!Array.isArray(payload.models))throw new Error("shape");current=payload;eventsNode.replaceChildren();modelsNode.replaceChildren();if(!payload.available){status.textContent="Durable inbox is unavailable for this project.";message(eventsNode,"The inbox endpoint is unavailable; workforce and job data remain available above.");message(modelsNode,"No supervision model inventory is available.");return;}
status.textContent="Durable inbox connected · showing up to 20 project-scoped events";
const events=payload.events.slice(0,20);if(!events.length)message(eventsNode,"No durable supervision events are recorded for this project.");
for(const raw of events){if(!record(raw)||!eventId(raw.id))continue;const row=element("article","supervision-event","");const heading=element("h3","",clean(raw.kind,120)||"Supervision event");row.append(heading);field(row,"At",timeText(raw.at));field(row,"Worker",raw.worker);field(row,"Model",raw.model);field(row,"Owner",raw.owner);field(row,"Job",raw.job);field(row,"Guidance",raw.guidance_state);if(record(raw.oracle)){const oracle=element("div","oracle-detail","");field(oracle,"Oracle status",raw.oracle.status);field(oracle,"Requested model",raw.oracle.model);field(oracle,"Actual model",raw.oracle.actual_model);field(oracle,"Assigned host",raw.oracle.assigned_host);field(oracle,"Result",clean(raw.oracle.result,MAX_TEXT));if(oracle.childNodes.length)row.append(oracle);}const ack=raw.ack_at||raw.acknowledged;const footer=element("div","supervision-ack",ack?"Acknowledged"+(raw.ack_at?" · "+timeText(raw.ack_at):""):"Awaiting acknowledgment");if(!ack&&root.dataset.csrfToken){const button=element("button","","Acknowledge");button.type="button";button.addEventListener("click",()=>acknowledge(raw,button));footer.append(button);}row.append(footer);eventsNode.append(row);}
const hosts=payload.models.slice(0,20);if(!hosts.length)message(modelsNode,"No model-host records are available.");for(const raw of hosts){if(!record(raw))continue;const row=element("article","supervision-model","");row.append(element("h3","",clean(raw.host,160)||"Model host"));const names=Array.isArray(raw.models)?raw.models.slice(0,30).map(v=>clean(v,120)).filter(Boolean):[];field(row,"Models",names.join(" · ")||"Not reported");field(row,"Updated",timeText(raw.updated));field(row,"Status detail",raw.error);modelsNode.append(row);}}
async function acknowledge(raw,button){const csrf=root.dataset.csrfToken,projectId=root.dataset.projectId,eventIdValue=eventId(raw.eventId||raw.id);if(!csrf||!projectId||!current||!eventIdValue)return;button.disabled=true;try{const base=new URL(root.dataset.endpoint,location.href);if(base.origin!==location.origin)throw new Error("origin");base.pathname=base.pathname.replace(/\\/$/,"")+"/"+encodeURIComponent(eventIdValue)+"/ack";base.search="";const response=await fetch(base,{method:"POST",credentials:"same-origin",cache:"no-store",redirect:"error",headers:{Accept:"application/json","Content-Type":"application/json","X-CSRF-Token":csrf},body:JSON.stringify({})});if(!response.ok)throw new Error("ack");raw.acknowledged=true;status.textContent="Acknowledgment saved.";render(current);}catch{button.disabled=false;status.textContent="Acknowledgment could not be saved; refresh to check the current state.";}}
async function load(){if(closed)return;status.textContent="Refreshing durable inbox…";try{const url=new URL(root.dataset.endpoint,location.href);if(url.origin!==location.origin)throw new Error("origin");url.searchParams.set("after","0");url.searchParams.set("limit","20");const response=await fetch(url,{credentials:"same-origin",cache:"no-store",redirect:"error",headers:{Accept:"application/json"}});if(!response.ok)throw new Error("response");render(await boundedJson(response));}catch{status.textContent="Inbox unavailable; retry when supervision service is available.";if(!current){message(eventsNode,"The authenticated inbox did not respond. No remote activity is being inferred.");message(modelsNode,"Model inventory unavailable.");}}}
refresh.addEventListener("click",()=>void load());window.addEventListener("pagehide",()=>{closed=true;},{once:true});void load();})();</script>`;
}
