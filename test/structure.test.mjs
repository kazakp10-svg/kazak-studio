import test from 'node:test';
import assert from 'node:assert/strict';
import {parseScript,orderedStructure,orderShots,migrateStructure,syncFromScript,renameHeading,moveItem,describeStructure} from '../public/structure.js';
let n=0;const newId=()=>'id'+(++n);
const project=(extra={})=>({script:'',episodes:[],scenes:[],shots:[],...extra});

test('script headings: scenes and episodes in text order',()=>{
 const text='ЭПИЗОД 1\n\nИНТ. КВАРТИРА — НОЧЬ\nДействие.\n\n2. НАТ. ДВОР — ДЕНЬ\n\nЭпизод 2\n\nИНТ./НАТ. МАШИНА\nСцена 4\nобычный текст про сцену';
 assert.deepEqual(parseScript(text).map(h=>[h.kind,h.title]),[['episode','ЭПИЗОД 1'],['scene','ИНТ. КВАРТИРА — НОЧЬ'],['scene','2. НАТ. ДВОР — ДЕНЬ'],['episode','Эпизод 2'],['scene','ИНТ./НАТ. МАШИНА'],['scene','Сцена 4']]);
 assert.equal(parseScript('Инструкция по сцене и интересный день').length,0);
});

test('old shots with episode and scene text become real scenes, in order of first appearance',()=>{
 const p={shots:[{id:'a',episode:'Эпизод 1',scene:'Квартира'},{id:'b',episode:'Эпизод 1',scene:'Двор'},{id:'c',episode:'Эпизод 1',scene:'Квартира'},{id:'d',scene:''}]};
 assert.equal(migrateStructure(p,newId),true);
 assert.deepEqual(p.episodes.map(e=>e.title),['Эпизод 1']);
 assert.deepEqual(p.scenes.map(s=>s.title),['Квартира','Двор','Сцена 1']);
 assert.equal(p.shots[0].sceneId,p.shots[2].sceneId);
 assert.notEqual(p.shots[0].sceneId,p.shots[1].sceneId);
 assert.ok(p.shots.every(s=>!('episode' in s)&&!('scene' in s)));
 assert.equal(migrateStructure(p,newId),false,'second run changes nothing');
 assert.deepEqual(orderShots(p).map(s=>s.id),['a','c','b','d'],'shots follow scene order, not creation order');
 const empty=project();migrateStructure(empty,newId);assert.equal(empty.episodes.length,1);
});

test('script sync: new headings create scenes, a renamed heading keeps its scene and shots',()=>{
 const p=project({script:'ИНТ. ПЕРВАЯ\n\nНАТ. ВТОРАЯ\n'});
 assert.equal(syncFromScript(p,newId),true);
 assert.deepEqual(p.scenes.map(s=>s.title),['ИНТ. ПЕРВАЯ','НАТ. ВТОРАЯ']);
 const [first,second]=p.scenes;p.shots.push({id:'s1',sceneId:first.id},{id:'s2',sceneId:second.id});
 p.script='ИНТ. ПЕРВАЯ\n\nНАТ. ВТОРАЯ, ВЕЧЕР\n';
 syncFromScript(p,newId);
 assert.equal(p.scenes.length,2);assert.equal(p.scenes[1].id,second.id,'renamed, not recreated');assert.equal(p.scenes[1].title,'НАТ. ВТОРАЯ, ВЕЧЕР');
 p.script='НАТ. ВТОРАЯ, ВЕЧЕР\n';syncFromScript(p,newId);
 assert.ok(p.scenes.some(s=>s.id===first.id),'a scene with shots survives when its heading is deleted');
 assert.equal(p.scenes.find(s=>s.id===first.id).fromScript,false);
 p.shots=p.shots.filter(s=>s.id!=='s1');p.script='НАТ. ВТОРАЯ, ВЕЧЕР\nещё сцена\nИНТ. ТРЕТЬЯ\n';syncFromScript(p,newId);
 assert.deepEqual(p.scenes.map(s=>s.title),['НАТ. ВТОРАЯ, ВЕЧЕР','ИНТ. ТРЕТЬЯ','ИНТ. ПЕРВАЯ'],'script scenes follow the text, a detached scene stays after them');
 p.script='НАТ. ВТОРАЯ, ВЕЧЕР\n';syncFromScript(p,newId);
 assert.deepEqual(p.scenes.map(s=>s.title),['НАТ. ВТОРАЯ, ВЕЧЕР','ИНТ. ПЕРВАЯ'],'a shotless scene born from the script goes when its heading goes');
 assert.equal(syncFromScript(project({script:'просто текст без заголовков'}),newId),false);
});

test('episodes from the script take their scenes; manual scenes stay',()=>{
 const p=project();migrateStructure(p,newId);
 p.scenes.push({id:'manual',episodeId:p.episodes[0].id,title:'Моя сцена',fromScript:false});
 p.script='ЭПИЗОД 1\nИНТ. А\nЭПИЗОД 2\nИНТ. Б\nНАТ. В\n';
 syncFromScript(p,newId);
 assert.deepEqual(p.episodes.map(e=>e.title),['ЭПИЗОД 1','ЭПИЗОД 2']);
 const byTitle=t=>p.scenes.find(s=>s.title===t);
 assert.equal(byTitle('ИНТ. А').episodeId,p.episodes[0].id);
 assert.equal(byTitle('НАТ. В').episodeId,p.episodes[1].id);
 assert.ok(byTitle('Моя сцена'),'manual scene is kept');
 assert.deepEqual(orderedStructure(p).map(g=>g.scenes.map(s=>s.scene.title)),[['ИНТ. А','Моя сцена'],['ИНТ. Б','НАТ. В']]);
});

test('heading rename goes back into the script text',()=>{
 assert.equal(renameHeading('ИНТ. А\n  Текст\nНАТ. Б','ИНТ. А','ИНТ. АА'),'ИНТ. АА\n  Текст\nНАТ. Б');
 assert.equal(renameHeading('ничего','ИНТ. А','Б'),null);
});

test('moving shots, scenes and episodes',()=>{
 const p=project({script:'ЭПИЗОД 1\nИНТ. А\nИНТ. Б\nЭПИЗОД 2\nИНТ. В\n'});syncFromScript(p,newId);
 const [a,b,v]=p.scenes;p.shots.push({id:'1',sceneId:a.id},{id:'2',sceneId:a.id},{id:'3',sceneId:v.id});
 assert.equal(moveItem(p,'shot','2',-1),true);assert.deepEqual(orderShots(p).map(s=>s.id),['2','1','3']);
 assert.equal(moveItem(p,'shot','2',-1),false,'first shot of a scene cannot go up');
 assert.equal(moveItem(p,'scene',v.id,-1),true,'a scene moves up across the episode border');
 assert.equal(v.episodeId,p.episodes[0].id);assert.deepEqual(orderedStructure(p)[0].scenes.map(s=>s.scene.title),['ИНТ. А','ИНТ. Б','ИНТ. В']);
 assert.equal(moveItem(p,'scene',a.id,1),true);assert.deepEqual(orderedStructure(p)[0].scenes.map(s=>s.scene.title),['ИНТ. Б','ИНТ. А','ИНТ. В']);
 assert.equal(moveItem(p,'episode',p.episodes[1].id,-1),true);assert.equal(p.episodes[0].title,'ЭПИЗОД 2');
});

test('assistant sees the film as a tree in the shared vocabulary',()=>{
 const p=project({script:'ИНТ. А\n'});syncFromScript(p,newId);
 p.shots.push({id:'1',sceneId:p.scenes[0].id,title:'Окно',duration:5,referenceId:'x',endReferenceId:'y',videoPrompt:'slow dolly'},{id:'2',sceneId:p.scenes[0].id,title:'Двор',duration:4});
 const text=describeStructure(p);
 assert.match(text,/Сцена «ИНТ\. А»/);assert.match(text,/Шот 1 «Окно», 5 с, из начального и конечного кадра\. Промпт шота: slow dolly/);assert.match(text,/Шот 2 «Двор», 4 с, из текста/);
 assert.doesNotMatch(text,/[Кк]адры:/);
});
