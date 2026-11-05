import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { configPathOf, dataDirOf, DEFAULT_SETTINGS, SETTINGS_LOCAL_HOSTS, parseSettings, saveSettings } from './config.js'
import { QQ_SETTINGS_FIELDS, QQ_RETIRED_FIELDS } from './settings-fields.js'
const blocked=new Set(['__proto__','constructor','prototype'])
const safe=v=>!v||typeof v!=='object'||Object.keys(v).every(k=>!blocked.has(k)&&safe(v[k]))
export function settingsOriginAllowed(headers={}) {
 const origin=headers.origin
 if(origin===undefined)return true
 try {const u=new URL(origin);return ['http:','https:'].includes(u.protocol)&&SETTINGS_LOCAL_HOSTS.includes(u.hostname)&&u.username===''&&u.password===''}catch{return false}
}
function project(settings){const next={...settings};for(const f of QQ_SETTINGS_FIELDS)if(f.secret)next[f.key]='';return next}
async function snapshot(dir){let raw={},text=null,broken=false;try{text=await readFile(configPathOf(dir),'utf8');try{raw=JSON.parse(text);if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error();}catch{broken=true;raw={};}}catch(e){if(e.code!=='ENOENT')throw e;}
 const {settings,problems}=parseSettings(raw);return {settings,exists:text!==null,broken,revision:text===null?null:createHash('sha256').update(text).digest('hex'),problemCount:problems.length};}
export async function handleSettingsRequest({method,headers={},body,dir=dataDirOf(),reload=async()=>{}}){
 const reply=(status,payload)=>({status,payload})
 if(!['GET','POST'].includes(method))return reply(405,{error:'method-not-allowed'})
 if(!settingsOriginAllowed(headers)||method==='POST'&&String(headers['x-echo-qq-edit'])!=='1')return reply(403,{error:'forbidden'})
 try{
  if(method==='POST'){
   if(!body||typeof body!=='object'||Array.isArray(body)||!safe(body))return reply(400,{error:'invalid-object'})
   const patch=body.settings??body;if(!patch||typeof patch!=='object'||Array.isArray(patch))return reply(400,{error:'invalid-patch'})
   const known=new Map(QQ_SETTINGS_FIELDS.map(f=>[f.key,f]));if(Object.keys(patch).some(k=>!known.has(k)||known.get(k).readOnly))return reply(400,{error:'unknown-or-readonly-field'})
   for(const [key,value]of Object.entries(patch)){const f=known.get(key);if(f.type==='bool'?typeof value!=='boolean':f.type==='number'?typeof value!=='number'||!Number.isFinite(value):f.type==='string[]'?!Array.isArray(value)||value.some(v=>typeof v!=='string'):typeof value!=='string')return reply(400,{error:'invalid-field-type'})}
   const before=await snapshot(dir);if(!before.exists&&body.create!==true||before.broken&&body.repair!==true)return reply(409,{error:'explicit-create-or-repair-required'})
   if(!Object.hasOwn(body,'revision')||body.revision!==before.revision)return reply(409,{error:'conflict'})
   const next={...patch};for(const f of QQ_SETTINGS_FIELDS)if(f.secret&&next[f.key]==='')delete next[f.key]
   // Retain legacy parseSettings normalization. The protocol adds no second clamp table.
   await saveSettings(next,dir,{revision:body.revision,repair:body.repair===true});await reload()
  }
  const state=await snapshot(dir),secretSet=Object.fromEntries(QQ_SETTINGS_FIELDS.filter(f=>f.secret).map(f=>[f.key,!!state.settings[f.key]]));
  return reply(200,{ok:true,settings:project(state.settings),defaults:project(DEFAULT_SETTINGS),fields:QQ_SETTINGS_FIELDS,retired:QQ_RETIRED_FIELDS,secretSet,exists:state.exists,broken:state.broken,revision:state.revision,problemCount:state.problemCount,effective:'next-poll'})
 }catch(e){return reply(e.code==='conflict'?409:500,{error:e.code==='conflict'?'conflict':'settings-unavailable'})}
}
