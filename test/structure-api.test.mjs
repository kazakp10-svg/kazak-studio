import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import {createStudio} from '../server.mjs';

async function boot(root){
 const studio=createStudio({root,keys:{}});
 await new Promise(r=>studio.server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${studio.server.address().port}`;
 const call=async(path,body,method=body?'POST':'GET')=>{
  const res=await fetch(base+path,{method,headers:{'X-Studio-Request':'1','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  return {status:res.status,data:await res.json()};
 };
 const api=async(...a)=>{const r=await call(...a);assert.ok(r.status<300,`${a[0]} -> ${r.status} ${JSON.stringify(r.data)}`);return r.data;};
 const project=async id=>(await api('/api/state')).projects.find(p=>p.id===id);
 return {studio,base,call,api,project};
}

test('script headings become scenes, scenes and shots move, titles stay in step with the script and the folders',async()=>{
 const root=mkdtempSync(join(tmpdir(),'kazak-structure-')),png=join(root,'frame.png');
 execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=gray:s=320x180','-frames:v','1','-y',png]);
 const {studio,base,call,api,project}=await boot(root);
 try{
  const created=await api('/api/projects',{title:'Структура'});
  let p=await project(created.id);
  assert.equal(p.episodes.length,1);assert.deepEqual(p.scenes,[]);

  const first=await api('/api/shots',{projectId:p.id,title:'Первый'}),second=await api('/api/shots',{projectId:p.id,title:'Второй'});
  p=await project(p.id);
  assert.deepEqual(p.scenes.map(s=>s.title),['Сцена 1']);assert.equal(first.sceneId,second.sceneId,'new shots join the last scene');

  const upload=await fetch(`${base}/api/upload?projectId=${p.id}&name=frame.png&shotId=${first.id}`,{method:'POST',headers:{'X-Studio-Request':'1'},body:readFileSync(png)});assert.ok(upload.ok);
  await api('/api/shots/'+first.id,{projectId:p.id,revision:p.revision,referenceId:(await upload.json()).id},'PATCH');

  p=await project(p.id);
  await api('/api/projects/'+p.id,{revision:p.revision,script:'ИНТ. КВАРТИРА — НОЧЬ\nДействие.\nНАТ. ДВОР — ДЕНЬ\n'},'PATCH');
  p=await project(p.id);
  assert.deepEqual(p.scenes.map(s=>s.title),['ИНТ. КВАРТИРА — НОЧЬ','НАТ. ДВОР — ДЕНЬ','Сцена 1'],'headings first, the manual scene with shots stays');
  const [flat,yard,manual]=p.scenes;assert.deepEqual([flat.fromScript,yard.fromScript,manual.fromScript],[true,true,false]);

  await api('/api/shots/'+second.id,{projectId:p.id,revision:p.revision,sceneId:flat.id},'PATCH');
  p=await project(p.id);assert.equal(p.shots.find(s=>s.id===second.id).sceneId,flat.id);
  assert.equal((await call('/api/shots/'+second.id,{projectId:p.id,revision:p.revision,sceneId:'nope'},'PATCH')).status,404);

  await api('/api/scenes/'+manual.id,{projectId:p.id,revision:p.revision,title:'Пролог'},'PATCH');
  p=await project(p.id);assert.equal(p.scenes.find(s=>s.id===manual.id).title,'Пролог');assert.match(p.script,/^ИНТ\. КВАРТИРА/,'a manual scene has no heading to rename');
  await api('/api/scenes/'+flat.id,{projectId:p.id,revision:p.revision,title:'ИНТ. КВАРТИРА АННЫ — НОЧЬ'},'PATCH');
  p=await project(p.id);assert.match(p.script,/^ИНТ\. КВАРТИРА АННЫ — НОЧЬ\n/);assert.equal(p.scenes.filter(s=>s.fromScript).length,2,'the heading and the scene are still one scene');

  const asset=(await api('/api/state')).assets.find(a=>a.projectId===p.id);
  assert.match(asset.folder,/Сцены\/Пролог\/Шоты\/Первый\//,'files followed their scene');
  await api('/api/scenes/'+manual.id,{projectId:p.id,revision:p.revision,title:'Пролог, ночь'},'PATCH');
  assert.match((await api('/api/state')).assets.find(a=>a.projectId===p.id).folder,/Сцены\/Пролог, ночь\/Шоты\/Первый\//,'and moved again after a rename');

  p=await project(p.id);
  assert.equal((await call('/api/scenes/'+manual.id,{projectId:p.id,revision:p.revision},'DELETE')).status,400,'a scene with shots stays');
  assert.equal((await call('/api/scenes/'+yard.id,{projectId:p.id,revision:p.revision},'DELETE')).status,400,'a script scene is removed in the script');
  assert.equal((await call('/api/scenes',{projectId:p.id,revision:p.revision-1,title:'Старое'})).status,409);
  await api('/api/scenes',{projectId:p.id,revision:p.revision,title:'Лишняя'});
  p=await project(p.id);const extra=p.scenes.at(-1);assert.equal(extra.title,'Лишняя');
  await api('/api/scenes/'+extra.id,{projectId:p.id,revision:p.revision},'DELETE');
  p=await project(p.id);assert.ok(!p.scenes.some(s=>s.id===extra.id));

  await api('/api/episodes',{projectId:p.id,revision:p.revision,title:'Эпизод 2'});
  p=await project(p.id);assert.equal(p.episodes.length,2);
  await api('/api/move',{projectId:p.id,revision:p.revision,kind:'scene',id:manual.id,direction:1});
  p=await project(p.id);assert.equal(p.scenes.find(s=>s.id===manual.id).episodeId,p.episodes[0].id,'still in episode 1: it was not the last scene');
  await api('/api/scenes/'+yard.id,{projectId:p.id,revision:p.revision,episodeId:p.episodes[1].id},'PATCH');
  p=await project(p.id);assert.equal(p.scenes.find(s=>s.id===yard.id).episodeId,p.episodes[1].id);
  const third=await api('/api/shots',{projectId:p.id,title:'Третий',sceneId:flat.id});
  const moved=await api('/api/move',{projectId:p.id,revision:(await project(p.id)).revision,kind:'shot',id:third.id,direction:-1});assert.equal(moved.ok,true);
  p=await project(p.id);assert.deepEqual(p.shots.filter(s=>s.sceneId===flat.id).map(s=>s.id),[third.id,second.id],'the third shot moved above the second');
  assert.equal((await api('/api/move',{projectId:p.id,revision:p.revision,kind:'shot',id:third.id,direction:-1})).ok,false,'nothing above the first shot of a scene');
  assert.equal((await call('/api/episodes/'+p.episodes[1].id,{projectId:p.id,revision:(await project(p.id)).revision},'DELETE')).status,400,'an episode with scenes stays');

  const bundle=await api('/api/bundle',{projectId:p.id});
  const imported=await (await fetch(base+'/api/import-project',{method:'POST',headers:{'X-Studio-Request':'1'},body:await (await fetch(base+bundle.url)).arrayBuffer()})).json();
  assert.deepEqual(imported.episodes.map(e=>e.title),p.episodes.map(e=>e.title));assert.deepEqual(imported.scenes.map(s=>s.title),p.scenes.map(s=>s.title));
  assert.ok(imported.scenes.every(s=>!p.scenes.some(o=>o.id===s.id)),'imported scenes get new ids');
  assert.ok(imported.shots.every(s=>imported.scenes.some(sc=>sc.id===s.sceneId)),'every imported shot sits in an imported scene');
 }finally{studio.close();rmSync(root,{recursive:true,force:true});}
});

test('a film saved with episode and scene as text on each shot opens as a structured film, with a safety copy',async()=>{
 const root=mkdtempSync(join(tmpdir(),'kazak-legacy-'));
 mkdirSync(join(root,'backups'),{recursive:true});
 const legacy={projects:[{id:'p1',title:'Старый фильм',brief:'',script:'',bible:'',ratio:'16:9',budget:null,cards:[],timeline:[],musicId:null,musicVolume:0.25,messages:[],revision:3,createdAt:'2026-01-01T00:00:00.000Z',folder:'projects/Старый фильм-p1',
  shots:[{id:'a',title:'А',episode:'Эпизод 1',scene:'Квартира',description:'',imagePrompt:'',videoPrompt:'',notes:'',duration:5,status:'planned',referenceId:null,referenceIds:[]},
         {id:'b',title:'Б',episode:'Эпизод 1',scene:'Двор',description:'',imagePrompt:'',videoPrompt:'',notes:'',duration:5,status:'planned',referenceId:null,referenceIds:[]},
         {id:'c',title:'В',episode:'Эпизод 2',scene:'Квартира',description:'',imagePrompt:'',videoPrompt:'',notes:'',duration:5,status:'planned',referenceId:null,referenceIds:[]}]}],assets:[],jobs:[],settings:{}};
 writeFileSync(join(root,'studio.json'),JSON.stringify(legacy));
 const {studio,api}=await boot(root);
 try{
  const p=(await api('/api/state')).projects[0];
  assert.deepEqual(p.episodes.map(e=>e.title),['Эпизод 1','Эпизод 2']);
  assert.deepEqual(p.scenes.map(s=>[s.title,p.episodes.find(e=>e.id===s.episodeId).title]),[['Квартира','Эпизод 1'],['Двор','Эпизод 1'],['Квартира','Эпизод 2']],'the same scene text in two episodes stays two scenes');
  assert.equal(p.shots.length,3);assert.ok(p.shots.every(s=>s.sceneId&&!('episode' in s)&&!('scene' in s)));
  assert.equal(p.revision,3,'migration is not an edit');
  assert.ok(readdirSync(join(root,'backups')).some(f=>f.startsWith('studio-before-structure-')),'the old file was kept');
  assert.equal(JSON.parse(readFileSync(join(root,'studio.json'),'utf8')).projects[0].scenes.length,3,'and the migrated film is saved');
 }finally{studio.close();rmSync(root,{recursive:true,force:true});}
});
