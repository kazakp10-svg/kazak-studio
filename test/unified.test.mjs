import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import http from 'node:http';
import ffmpeg from 'ffmpeg-static';
import {createStudio,streamText} from '../server.mjs';
import {models,validateModelInput} from '../public/models.js';
const m=id=>models.find(m=>m.id===id);
test('model capabilities reject unsupported controls and preserve input roles',()=>{
 assert.throws(()=>validateModelInput(m('kling-direct'),{duration:15}),/длительность/);
 assert.throws(()=>validateModelInput(m('kling-3-pro-openrouter'),{duration:5,resolution:'720p'}),/разрешение/);
 assert.throws(()=>validateModelInput(m('seedance-2-direct'),{duration:30}),/длительность/);
 validateModelInput(m('seedance-25-direct'),{duration:30,resolution:'1080p',referenceId:'a',endReferenceId:'b',sound:true});
 assert.throws(()=>validateModelInput(m('seedance-25-direct'),{duration:5,referenceId:'a',referenceIds:['b']}),/способ/);
 assert.throws(()=>validateModelInput(m('gpt-image-2'),{quality:'high',referenceIds:Array(17).fill('a')}),/референсов/);
});
test('streaming parses split UTF8 chunks, completion and interrupted responses',async()=>{
 let payload='data: {"type":"response.output_text.delta","delta":"Привет"}\n\ndata: {"type":"response.completed","response":{"usage":{"output_tokens":2}}}\n\n';
 const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});const bytes=Buffer.from(payload);res.write(bytes.subarray(0,55));res.end(bytes.subarray(55));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;try{let text='';const usage=await streamText(url,'test',{},'openai',s=>text+=s);assert.equal(text,'Привет');assert.equal(usage.output_tokens,2);payload='data: {"choices":[{"delta":{"content":"partial"}}]}\n\n';await assert.rejects(()=>streamText(url,'test',{},'deepseek',()=>{}),/оборвалось/);}finally{server.close();}
});
test('unified workflow: cards, multi refs, quotes, recovery, archive remapping',async()=>{
 const root=mkdtempSync(join(tmpdir(),'kazak-unified-')),calls=[];const png=join(root,'ref.png'),video=join(root,'take.mp4');
 execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=gray:s=640x360','-frames:v','1','-y',png]);
 execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=gray:s=640x360:d=1','-c:v','libx264','-y',video]);
 let ambiguous=false, remoteFailed=false;
 const studio=createStudio({root,keys:{openaiKey:'test-openai',openrouterKey:'test-openrouter',seedanceKey:'test-seed'},request:async(url,key,body)=>{
 calls.push({url,body});
 if(url==='https://openrouter.ai/api/v1/videos'&&body){if(ambiguous)throw new Error('network dropped');return {id:'remote123',status:'pending'};}
 if(url.startsWith('https://openrouter.ai/api/v1/videos/'))return remoteFailed?{status:'failed',error:'test failure'}:{status:'completed',unsigned_urls:['https://cdn.example/result.mp4']};
 if(url.includes('/images/'))return {data:[{b64_json:readFileSync(png).toString('base64')}]};
 return {id:'seed-123'};
 },download:async(url,path)=>writeFileSync(path,readFileSync(video))});
 await new Promise(r=>studio.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${studio.server.address().port}`;
 async function api(path,body,method=body?'POST':'GET'){const res=await fetch(base+path,{method,headers:{'X-Studio-Request':'1','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const d=await res.json();assert.ok(res.ok,JSON.stringify(d));return d;}
 async function state(){return api('/api/state');}
 try{
 const p=await api('/api/projects',{title:'Unified QA'}),s=await api('/api/shots',{projectId:p.id});
 const upload=await fetch(`${base}/api/upload?projectId=${p.id}&name=reference.png`,{method:'POST',headers:{'X-Studio-Request':'1'},body:readFileSync(png)});assert.ok(upload.ok);const a=await upload.json();
 let rev=(await state()).projects[0].revision;
 const c=await api('/api/cards',{projectId:p.id,revision:rev,title:'Character',category:'character'});rev=(await state()).projects[0].revision;
 await api('/api/cards/'+c.id,{projectId:p.id,revision:rev,assetIds:[a.id],description:'Continuity'},'PATCH');
 let input={projectId:p.id,shotId:s.id,kind:'video',modelId:'seedance-25-openrouter',duration:30,resolution:'720p',referenceIds:[a.id],prompt:'@Image1 walks',requestId:crypto.randomUUID()};
 const q=await api('/api/quote',input);assert.equal(q.amount,7.3149);assert.match(q.source,/5\.5%/);const or720=await api('/api/quote',{...input,duration:4});assert.equal(or720.amount,0.9753);const or20=await api('/api/quote',{...input,modelId:'seedance-2-openrouter',duration:4});assert.equal(or20.amount,0.6381);const klingOff=await api('/api/quote',{...input,modelId:'kling-3-pro-openrouter',duration:4,sound:false,resolution:undefined,referenceIds:[]});assert.equal(klingOff.amount,0.4726);const klingOn=await api('/api/quote',{...input,modelId:'kling-3-pro-openrouter',duration:4,sound:true,resolution:undefined,referenceIds:[]});assert.equal(klingOn.amount,0.709);const direct={...input,modelId:'seedance-25-direct',provider:'seedance',resolution:'1080p'};const directQuote=await api('/api/quote',direct);assert.equal(directQuote.amount,17.0586);assert.match(directQuote.source, /\$11\.70/);const currentShotQuote=await api('/api/quote',{...direct,duration:4,resolution:'720p'});assert.equal(currentShotQuote.amount,0.9245);assert.match(currentShotQuote.source, /\$10\.70/);await api('/api/settings',{seedance25TokenRate:14});const overriddenQuote=await api('/api/quote',direct);assert.ok(overriddenQuote.amount>directQuote.amount);const j=await api('/api/jobs',input);assert.equal(j.estimate,q.amount);
 assert.equal((await api('/api/jobs',input)).id,j.id);
 const changed=await fetch(base+'/api/jobs',{method:'POST',headers:{'X-Studio-Request':'1','Content-Type':'application/json'},body:JSON.stringify({...input,duration:29})});assert.equal(changed.status,400);assert.match((await changed.json()).error,/идентификатор/i);
 for(let i=0;i<30;i++){if((await api('/api/job/'+j.id)).status==='waiting')break;await new Promise(r=>setTimeout(r,30));}
 const submitted=calls.find(x=>x.url==='https://openrouter.ai/api/v1/videos'&&x.body);assert.equal(submitted.body.input_references.length,1);assert.equal(submitted.body.resolution,'720p');assert.equal(submitted.body.duration,30);assert.equal(submitted.body.frame_images,undefined);
 await api('/api/poll',{id:j.id});for(let i=0;i<100;i++){if((await api('/api/job/'+j.id)).status==='succeeded')break;await new Promise(r=>setTimeout(r,30));}assert.equal((await api('/api/job/'+j.id)).status,'succeeded');
 rev=(await state()).projects[0].revision;await api('/api/shots/'+s.id,{projectId:p.id,revision:rev,referenceIds:[a.id],endReferenceId:a.id},'PATCH');
 const image=await api('/api/jobs',{projectId:p.id,shotId:s.id,kind:'image',modelId:'gpt-image-2.5',referenceIds:[a.id],prompt:'portrait'});for(let i=0;i<100;i++){if((await api('/api/job/'+image.id)).status==='succeeded')break;await new Promise(r=>setTimeout(r,30));}assert.ok(calls.find(x=>x.url.endsWith('/images/edits')).body instanceof FormData);
 const bundle=await api('/api/bundle',{projectId:p.id});const bytes=await (await fetch(base+bundle.url)).arrayBuffer();const imported=await fetch(base+'/api/import-project',{method:'POST',headers:{'X-Studio-Request':'1'},body:bytes});assert.ok(imported.ok);const restored=await imported.json();assert.notEqual(restored.cards[0].assetIds[0],a.id);assert.equal(restored.cards[0].assetIds[0],restored.shots[0].referenceIds[0]);assert.equal(restored.shots[0].endReferenceId,restored.cards[0].assetIds[0]);const importedVideo=(await state()).jobs.find(x=>x.projectId===restored.id&&x.modelId==='seedance-25-openrouter');assert.deepEqual(importedVideo.referenceIds,restored.shots[0].referenceIds);assert.equal(importedVideo.resolution,'720p');
 ambiguous=true;input={...input,duration:5,referenceIds:[],referenceId:a.id,resolution:'720p',requestId:crypto.randomUUID()};const fail=await api('/api/jobs',input);for(let i=0;i<30;i++){if((await api('/api/job/'+fail.id)).status==='uncertain')break;await new Promise(r=>setTimeout(r,30));}assert.equal((await api('/api/job/'+fail.id)).status,'uncertain');const before=calls.filter(x=>x.body&&x.url==='https://openrouter.ai/api/v1/videos').length;await api('/api/jobs',input);assert.equal(calls.filter(x=>x.body&&x.url==='https://openrouter.ai/api/v1/videos').length,before);await api('/api/poll',{id:fail.id,remoteId:'recovered123'});for(let i=0;i<100;i++){if((await api('/api/job/'+fail.id)).status==='succeeded')break;await new Promise(r=>setTimeout(r,30));}assert.equal((await api('/api/job/'+fail.id)).status,'succeeded');
 ambiguous=false;remoteFailed=true;const failed=await api('/api/jobs',{projectId:p.id,shotId:s.id,kind:'video',modelId:'seedance-25-openrouter',duration:5,resolution:'720p',referenceId:a.id,prompt:'Fail gracefully'});for(let i=0;i<30;i++){if((await api('/api/job/'+failed.id)).status==='waiting')break;await new Promise(r=>setTimeout(r,30));}assert.equal((await api('/api/job/'+failed.id)).status,'waiting');await api('/api/poll',{id:failed.id});assert.equal((await api('/api/job/'+failed.id)).status,'failed');assert.equal((await api('/api/job/'+failed.id)).error,'test failure');
 const stale=await fetch(base+'/api/cards/'+c.id,{method:'PATCH',headers:{'X-Studio-Request':'1','Content-Type':'application/json'},body:JSON.stringify({projectId:p.id,revision:0,title:'Stale'})});assert.equal(stale.status,409);
 }finally{studio.close();rmSync(root,{recursive:true,force:true});}
});

test('OpenRouter video route quotes Seedance and preserves first/last frame through completion',async()=>{
 const root=mkdtempSync(join(tmpdir(),'kazak-openrouter-')),png=join(root,'ref.png'),video=join(root,'take.mp4'),calls=[];
 execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=gray:s=640x360','-frames:v','1','-y',png]);
 execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=gray:s=640x360:d=1','-c:v','libx264','-y',video]);
 const studio=createStudio({root,keys:{openrouterKey:'test-openrouter'},request:async(url,key,body)=>{
  calls.push({url,key,body});
  if(url==='https://openrouter.ai/api/v1/videos'&&body)return {id:'or-video-123',status:'pending'};
  if(url==='https://openrouter.ai/api/v1/videos/or-video-123')return {id:'or-video-123',status:'completed',unsigned_urls:['https://openrouter.ai/api/v1/videos/or-video-123/content?index=0'],usage:{cost:0.9753}};
  throw new Error(`Unexpected API request: ${url}`);
 },download:async(url,path,_depth,headers)=>{calls.push({url,headers});writeFileSync(path,readFileSync(video));}});
 await new Promise(r=>studio.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${studio.server.address().port}`;
 async function api(path,body,method=body?'POST':'GET'){const res=await fetch(base+path,{method,headers:{'X-Studio-Request':'1','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const d=await res.json();assert.ok(res.ok,JSON.stringify(d));return d;}
 try{
  const project=await api('/api/projects',{title:'OpenRouter QA'}),shot=await api('/api/shots',{projectId:project.id});
  const upload=await fetch(`${base}/api/upload?projectId=${project.id}&name=reference.png`,{method:'POST',headers:{'X-Studio-Request':'1'},body:readFileSync(png)});assert.ok(upload.ok);const ref=await upload.json();
  const baseInput={projectId:project.id,shotId:shot.id,kind:'video',provider:'openrouter',duration:4,resolution:'720p',sound:true,prompt:'A slow camera move',requestId:crypto.randomUUID()};
  const seedance25=await api('/api/quote',{...baseInput,modelId:'seedance-25-openrouter'});assert.equal(seedance25.amount,0.9753);assert.match(seedance25.source,/5\.5%/);
  const seedance20=await api('/api/quote',{...baseInput,modelId:'seedance-2-openrouter'});assert.equal(seedance20.amount,0.6381);
  const klingStd=await api('/api/quote',{...baseInput,modelId:'kling-3-std-openrouter',duration:5,resolution:undefined,sound:false});assert.equal(klingStd.amount,0.4431);
  const job=await api('/api/jobs',{...baseInput,modelId:'seedance-25-openrouter',referenceId:ref.id,endReferenceId:ref.id});
  for(let i=0;i<50&&!(await api('/api/job/'+job.id)).remoteId;i++)await new Promise(r=>setTimeout(r,20));
  const submitted=calls.find(c=>c.url==='https://openrouter.ai/api/v1/videos'&&c.body);assert.equal(submitted.key,'test-openrouter');assert.equal(submitted.body.model,'bytedance/seedance-2.5');assert.deepEqual(submitted.body.frame_images.map(x=>x.frame_type),['first_frame','last_frame']);assert.match(submitted.body.frame_images[0].image_url.url,/^data:image\/png;base64,/);
  await api('/api/poll',{id:job.id});
  for(let i=0;i<50&&(await api('/api/job/'+job.id)).status!=='succeeded';i++)await new Promise(r=>setTimeout(r,20));
  assert.equal((await api('/api/job/'+job.id)).status,'succeeded');assert.equal(calls.find(c=>c.headers)?.headers.Authorization,'Bearer test-openrouter');
 }finally{studio.close();rmSync(root,{recursive:true,force:true});}
});
