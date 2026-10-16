import { models, providers } from "/models.js";
import { orderedStructure, orderShots, parseScript, norm } from "/structure.js";
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const paths = {
  archive: '<path d="M4 5h16v4H4zM5 9v10h14V9M10 13h4"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  script: '<path d="M7 3h8l4 4v14H5V3h2zM15 3v5h4M8 12h8M8 16h6"/>',
  shots:
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  media:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
  edit: '<path d="M4 5h16M4 12h16M4 19h16"/><rect x="7" y="3" width="4" height="4" rx="1"/><rect x="14" y="10" width="4" height="4" rx="1"/><rect x="6" y="17" width="4" height="4" rx="1"/>',
  jobs: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  settings:
    '<path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>',
  play: '<path d="m8 4 12 8-12 8z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 9h18"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  alert: '<path d="M12 4 2.5 20h19zM12 10v4.5M12 17.5v.01"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  chat: '<path d="M21 12a9 9 0 0 1-9 9H3l2-5A9 9 0 1 1 21 12z"/>',
};
const icon = (name, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.film}</svg>`;
const money = (n) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 3,
  }).format(n || 0);
const time = (n) =>
  `${Math.floor((n || 0) / 60)
    .toString()
    .padStart(2, "0")}:${((n || 0) % 60).toFixed(1).padStart(4, "0")}`;
const labels = {
  planned: "Запланирован",
  reference: "Есть референс",
  generated: "Есть видео",
  approved: "Выбран",
  queued: "В очереди",
  submitting: "Отправляется",
  waiting: "У провайдера",
  running: "Обрабатывается",
  downloading: "Скачивается",
  succeeded: "Готово",
  failed: "Ошибка",
  uncertain: "Нужна проверка",
  download_failed: "Повторить скачивание",
  archived: "Архив",
};
 let state, projectId=localStorage.getItem('kazak-project'), view=localStorage.getItem('kazak-view') || 'shots', shotId=null, generateMode='video', leftTab='create', focus=null, selectedAsset=null, previewOpenerId=null, previewOpenerIndex=0, dirty=false, loading=false, previewStop=null, playPosition=0, noticeTimer, autosaveTimer, saving=null, draftVersion=0, quoteVersion=0, quoteData=null, quoteTimer, animateGenerationId=null, libraryTab='media', collectionView='library', filter='all', search='', cardId=null, newCard=false, newProjectOpen=false, assistantDraft='', chatBusy=false;
const p=()=>state?.projects.find(x=>x.id===projectId);
const shot=()=>p()?.shots.find(x=>x.id===shotId);
const projectAssets=()=>state?.assets.filter(a=>a.projectId===projectId) || [];
const assets=()=>projectAssets().filter(a=>(a.collection || 'library')==='library');
const asset=id=>state?.assets.find(a=>a.id===id);
const jobs=()=>state?.jobs.filter(j=>j.projectId===projectId) || [];
const activeGenerationStatuses=['queued','submitting','running','waiting','downloading'];
const generationBusy=s=>jobs().some(j=>j.shotId===s?.id&&j.kind===generateMode&&activeGenerationStatuses.includes(j.status));
function generationError(job) {const raw=job.error||job.pollError||'Провайдер не вернул результат.';return job.provider==='openai'&&/no credits remaining/i.test(raw)?'На балансе OpenAI API нет кредитов. Подписка ChatGPT не включает оплату API.':raw;}
function syncGenerationStatus() {
 const s=shot(),button=$('#generate-form button[type=submit]');if(!s||!button)return;
 const busy=generationBusy(s),wasBusy=button.dataset.busy==='true';button.dataset.busy=String(busy);
 button.disabled=busy||!state.connections[models.find(m=>m.id===$('#generate-form').dataset.model)?.provider];
 button.textContent=busy?'Создаётся…':generateLabel();
 if(wasBusy&&!busy)void updateQuote();
}
const ext=file=>file.slice(file.lastIndexOf('.'));
const option=(value,label,current)=>`<option value="${esc(value)}" ${value===current?'selected':''}>${esc(label)}</option>`;
const input=(label,name,value='',extra='')=>`<label>${label}<input name="${name}" value="${esc(value)}" ${extra}></label>`;
const textarea=(label,name,value='',rows=3,placeholder='')=>`<label>${label}<textarea name="${name}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(value)}</textarea></label>`;
const title=(name,sub='',actions='')=>`<header class="page-head"><div class="page-title"><h1>${name}</h1>${(Array.isArray(sub)?sub:[sub]).filter(Boolean).map(x=>`<span>${x}</span>`).join('')}</div><div class="head-actions">${actions}</div></header>`;
const pad2=n=>String(n).padStart(2,'0');
const thumbSrc=id=>state?.assets.find(a=>a.id===id)?.kind==='image'?'/media/'+id:'/thumb/'+id;  // server makes no thumbnails for images
const clock=n=>{n=Math.max(0,Math.round(n||0));return `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`;};
const plural=(n,a,b,c)=>n%10===1&&n%100!==11?a:n%10>=2&&n%10<=4&&(n%100<10||n%100>=20)?b:c;
let viewerId=null,scriptDoc='script',timelineHtml='',renderedView=null,renaming=null;
const sourceByShot={};  // how each shot is shot (text, frame, frames, cast) as chosen in this session
const shotNumber=id=>orderShots(p()).findIndex(x=>x.id===id)+1;
const shotLabel=a=>{const s=a?.shotId&&p()?.shots.find(x=>x.id===a.shotId);return s?`${pad2(shotNumber(s.id))} ${s.title}`:'';};
const NBSP=/(^|[\s(«"])([а-яёА-ЯЁA-Za-z]{1,2}|[\d.,:$≈]+)\s+(?=\S)/g;
function typograph(root) {  // Russian typesetting: «в доме», «5 с», «из $25» never break apart
 if(!root)return;const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement.closest('textarea,pre,code,script,style,option,select,input')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});
 const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
 for(const n of nodes){const v=n.nodeValue,next=v.replace(NBSP,'$1$2 ').replace(NBSP,'$1$2 ').replace(/\s+([—–])/g,'\u00a0$1');if(next!==v)n.nodeValue=next;}
}
const badge=status=>`<span class="badge ${['succeeded','approved'].includes(status)?'good':['failed','uncertain','download_failed'].includes(status)?'warning':''}">${esc(labels[status] || status)}</span>`;
const categories={character:'Персонаж',location:'Локация',style:'Стиль',object:'Предмет'};
async function api(path,{method='GET',body,...rest}={}) {
 const response=await fetch(path,{method,headers:{'X-Studio-Request':'1',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,...rest});
 const result=await response.json(); if(!response.ok) throw Object.assign(new Error(result.error || `HTTP ${response.status}`),{status:response.status}); return result;
}
function notify(message,error=false) {clearTimeout(noticeTimer);$('#notice').textContent=message;$('#notice').className=`visible ${error?'error':''}`;noticeTimer=setTimeout(()=>$('#notice').className='',error?12000:4000);}
async function reload() {
 state=await api('/api/state');if(!p())projectId=state.projects[0]?.id||null;
 if(!dirty&&!saving)editorRevision=p()?.revision||0;  // structure actions bump the revision; the next autosave must use it
 const shots=p()?orderShots(p()):[],saved=localStorage.getItem('kazak-shot-'+projectId);
 shotId=saved==='all'?null:shots.some(s=>s.id===saved)?saved:shotId&&shots.some(s=>s.id===shotId)?shotId:shots[0]?.id||null;
 if(shotId)localStorage.setItem('kazak-shot-'+projectId,shotId);
 localStorage.setItem('kazak-project',projectId||'');
}
async function action(fn) {if(loading)return;loading=true;try{await flush();await fn();}catch(e){notify(e.message,true);}finally{loading=false;}}
function savedLabel(text) {const el=$('#save-state');if(el)el.textContent=text;}
function draftNotice() {if(!projectId||dirty)return '';try{const d=JSON.parse(localStorage.getItem(`kazak-draft-${projectId}`)||'null');return d&&(d.id===projectId||d.projectId===projectId)?`<div class="draft-recovery"><span>Несохранённый черновик</span><button class="text-button" data-action="restore-draft">Восстановить</button></div>`:'';}catch{return '';}}
function preview(a) {if(!a)return '<div class="viewer-empty">Выберите материал</div>';return a.kind==='video'?`<video src="/media/${a.id}" controls playsinline preload="metadata"></video>`:a.kind==='image'?`<img src="/media/${a.id}" alt="${esc(a.name)}">`:`<audio src="/media/${a.id}" controls></audio>`;}
function imageChoices(current,label,name) {return `<label class="kv"><span>${label}</span><select name="${name}"><option value="">Не выбран</option>${assets().filter(a=>a.kind==='image').map(a=>option(a.id,a.name,current)).join('')}</select></label>`;}
function refChoices(selected=[],name='referenceIds') {const list=assets().filter(a=>a.kind==='image');return list.length?`<div class="reference-choices">${list.map(a=>`<label class="reference-choice"><input type="checkbox" name="${name}" value="${a.id}" ${selected.includes(a.id)?'checked':''}><img src="${thumbSrc(a.id)}" alt=""><span>${esc(a.name)}</span></label>`).join('')}</div>`:'<p class="hint">Изображений пока нет. Загрузите их в библиотеке или создайте на вкладке «Кадр».</p>';}
function castChoices(selected=[]) {
 const images=assets().filter(a=>a.kind==='image'),cards=p().cards.filter(c=>c.assetIds.some(id=>images.some(a=>a.id===id)));
 if(!cards.length&&!images.length)return refChoices(selected);
 const heroes=cards.length?`<div class="card-choices">${cards.map(c=>`<button type="button" class="card-choice" data-pick-card="${c.id}" aria-pressed="false"><img src="${thumbSrc(c.assetIds.find(id=>images.some(a=>a.id===id)))}" alt=""><span>${esc(c.title)}</span></button>`).join('')}</div>`:`<p class="hint">${p().cards.length?'В карточках пока нет изображений.':'Героев и мест пока нет.'} <button type="button" class="text-btn" data-view="cast">${p().cards.length?'Открыть раздел':'Создать карточку'}</button></p>`;
 return `${heroes}<div class="ref-sub">Изображения библиотеки</div>${refChoices(selected)}`;
}
function cardBoxes(c) {return c.assetIds.map(id=>$(`input[name=referenceIds][value="${id}"]`)).filter(Boolean);}
function syncCardChoices() {document.querySelectorAll('[data-pick-card]').forEach(b=>{const boxes=cardBoxes(p().cards.find(c=>c.id===b.dataset.pickCard));b.setAttribute('aria-pressed',String(!!boxes.length&&boxes.every(x=>x.checked)));});}
function liveCount() {return p()?jobs().filter(j=>j.kind!=='assistant'&&activeGenerationStatuses.includes(j.status)).length:0;}
function topbarLive() {const n=liveCount();return n?`В работе: ${n}`:'';}
function spendStats() {
 const total=state.estimatedSpend[projectId]||0,generations=jobs().filter(j=>['image','video'].includes(j.kind)&&j.provider!=='local');
 return {total,remaining:p().budget==null?null:Math.max(0,p().budget-total),count:generations.length,average:generations.length?generations.reduce((sum,j)=>sum+(j.estimate||0),0)/generations.length:null};
}
function topbarSpend() {if(!p())return '';const spend=spendStats();return p().budget==null?`≈ <b>${money(spend.total)}</b>`:`≈ <b>${money(spend.total)}</b> из ${money(p().budget)}`;}
function syncTopbar() {const live=$('#topbar-live'),spend=$('#topbar-spend'),rail=$('#live-rail');if(live){live.textContent=topbarLive();live.hidden=!live.textContent;}if(rail)rail.hidden=!liveCount();if(spend)spend.innerHTML=topbarSpend();}
function shell() {
 const nav=[['script','Сценарий'],['shots','Раскадровка'],['cast','Герои и места'],['media','Библиотека'],['edit','Монтаж'],['jobs','История']];
 const inProject=p()&&view!=='projects'&&view!=='settings';
 const page=view==='settings'?settingsPage():view==='projects'||!p()?projectsPage():({shots:shotsPage,script:scriptPage,cast:castPage,media:mediaPage,edit:editPage,jobs:jobsPage}[view] || shotsPage)();
 return `<div class="shell"><div class="live-rail" id="live-rail" role="presentation" ${liveCount()?'':'hidden'}></div><header class="topbar"><button class="brand" data-view="projects" title="Все фильмы" aria-label="KAZAK, все фильмы">KAZAK</button><div class="film-switch"><label class="sr-only" for="project-select">Текущий фильм</label><select id="project-select"><option value="">Выберите фильм</option>${state.projects.map(x=>option(x.id,x.title,projectId)).join('')}</select></div><nav aria-label="Разделы студии">${nav.map(([id,name])=>`<button data-view="${id}" ${!p()?'disabled':''} ${view===id?'aria-current="page"':''}>${name}</button>`).join('')}</nav><div class="topbar-status"><span class="live" id="topbar-live" ${liveCount()?'':'hidden'}>${topbarLive()}</span>${p()?`<span id="topbar-spend" title="Оценка стоимости по заданиям. Фактическое списание у провайдера.">${topbarSpend()}</span><span id="save-state" role="status">${dirty?'Сохранение…':'Сохранено на Mac'}</span>`:''}</div><div class="topbar-tools">${p()?`<button class="icon-btn" data-action="open-folder" title="Папка фильма в Finder" aria-label="Папка фильма">${icon('folder',17)}</button><button class="icon-btn" data-action="bundle" title="Архив фильма .kazak" aria-label="Архив фильма">${icon('download',17)}</button>`:''}<button class="icon-btn ${view==='settings'?'on':''}" data-view="settings" title="Подключения" aria-label="Подключения">${icon('settings',17)}</button></div></header><main class="main view-${inProject?view:view==='settings'?'settings':'projects'}">${draftNotice()}<div class="page${inProject?' page-'+view:''}">${page}</div></main></div>${selectedAsset?`<dialog class="preview-overlay" id="preview-dialog" aria-label="Просмотр материала"><button class="icon-btn" data-action="close-preview" aria-label="Закрыть просмотр">${icon('close')}</button>${preview(asset(selectedAsset))}</dialog>`:''}`;
}
function projectsPage() {
 const actions=state.projects.length?`<button class="quiet" data-action="import-project">Открыть архив</button><button class="primary" data-action="new-project">${icon('plus')} Создать фильм</button>`:'';
 const form=newProjectOpen?`<form id="new-project-form" class="new-project">${input('Название фильма','title','','required maxlength="200" placeholder="Новый фильм" autofocus')}<label>Формат<select name="ratio">${['16:9','9:16','1:1'].map(r=>option(r,r,'16:9')).join('')}</select></label><button class="primary">Создать фильм</button><button class="quiet" type="button" data-action="cancel-new-project">Отмена</button></form>`:'';
 const shelf=state.projects.length?`<section class="project-shelf"><div class="project-grid" aria-label="Фильмы">${state.projects.map(x=>{const a=state.assets.find(a=>a.projectId===x.id && (a.collection || 'library')==='library' && ['image','video'].includes(a.kind)),count=state.assets.filter(a=>a.projectId===x.id && (a.collection || 'library')==='library').length;return `<button class="project-tile" data-project="${x.id}" aria-label="Открыть фильм ${esc(x.title)}"><span class="project-cover">${a?`<img src="${thumbSrc(a.id)}" alt="">`:icon('film',38)}</span><span class="project-caption"><strong>${esc(x.title)}</strong><span class="project-meta"><span>${x.shots.length} ${plural(x.shots.length,'шот','шота','шотов')}</span><span>${count} ${plural(count,'материал','материала','материалов')}</span><span>${esc(x.ratio)}</span></span><span class="project-open">Открыть фильм ${icon('arrow',14)}</span></span></button>`;}).join('')}</div></section>`:'';
 const empty=!state.projects.length&&!newProjectOpen?`<section class="catalog-empty"><h2>Фильмов пока нет</h2><div class="empty-actions"><button class="primary" data-action="new-project">${icon('plus')} Создать первый фильм</button><button class="quiet" data-action="import-project">Открыть архив</button></div></section>`:'';
 return `${title('Фильмы',state.projects.length?String(state.projects.length):'',actions)}${form}${shelf}${empty}`;
}
function assistantProvider() {return localStorage.getItem('kazak-assistant') || (state.connections.deepseek?'deepseek':state.capabilities.codex?'local':'openai');}
function shotsPage() {
 const shots=orderShots(p());
 if(!shot()&&shots.length){shotId=shots[0].id;localStorage.setItem('kazak-shot-'+projectId,shotId);}
 const s=shot();
 if(!s)return `<div class="work work-empty"><section class="panel panel-empty"><h2>Раскадровка пуста</h2><p>Шот снимается из текста, из одного кадра или из двух: начального и конечного. Все дубли шота хранятся вместе.</p><button class="btn-primary" data-action="new-shot">Первый шот</button></section>${timelinePanel(null)}</div>`;
 return `<div class="work">${leftPanel(s)}${previewPanel(s)}${inspectorPanel(s)}${timelinePanel(s)}</div>`;
}
function leftPanel(s) {
 const tab=(attr,val,label,on)=>`<button type="button" ${attr}="${val}" aria-pressed="${on}">${label}</button>`;
 const tabs=tab('data-mode','video','Шот',leftTab==='create'&&generateMode==='video')+tab('data-mode','image','Кадр',leftTab==='create'&&generateMode==='image')+tab('data-left','assistant','Соавтор',leftTab==='assistant');
 return `<section class="panel panel-left" aria-label="Создание"><div class="ptabs" role="group" aria-label="Что создаём">${tabs}</div>${leftTab==='assistant'?assistantSection(assistantProvider(),true):`<div class="generation-dock">${generationForm(s)}</div>`}</section>`;
}
function previewPanel(s) {
 return `<section class="panel panel-preview" aria-label="Просмотр"><div class="ptabs"><span class="ptitle">Просмотр</span></div><div id="generation-feed" class="feed" data-version="${esc(generationVersion(s))}" aria-live="polite">${generationFeed(s)}</div></section>`;
}
function inspectorPanel(s) {
 const order=(dir,label)=>`<button type="button" class="icon-btn" data-order="shot:${s.id}:${dir}" title="${label}" aria-label="${label}">${icon(dir<0?'up':'down',15)}</button>`;
 return `<section class="panel panel-inspector" aria-label="Шот"><div class="ptabs"><span class="ptitle">Шот</span></div><div class="pbody"><form id="shot-form" class="insp-shot"><label class="field-label" for="shot-title">Название</label><input id="shot-title" class="field-title" name="title" value="${esc(s.title)}" maxlength="200"><label class="field-label" for="shot-scene">Сцена</label><div class="field-row">${sceneSelect(s)}<span class="insp-order">${order(-1,'Выше в сцене')}${order(1,'Ниже в сцене')}</span></div><div id="takes-feed" class="takes">${takesList(s)}</div><details class="insp-more"><summary>Описание и заметки</summary><div class="details-body">${textarea('Описание','description',s.description,3)}${textarea('Заметки','notes',s.notes,2)}</div></details><button class="text-btn danger" type="button" data-action="delete-shot">Убрать шот</button></form></div></section>`;
}
function latestAsset(item) {return projectAssets().filter(a=>a.shotId===item.id&&(a.collection||'library')!=='archive'&&a.kind!=='audio').at(-1);}
function renameForm(kind,item) {return `<form class="tl-rename" data-rename-form="${kind}:${item.id}"><input name="title" value="${esc(item.title)}" maxlength="200" aria-label="Название" autocomplete="off"></form>`;}
function sceneSelect(s) {
 const pr=p(),multi=pr.episodes.length>1,opt=e=>option(e.scene.id,e.scene.title,s.sceneId),tree=orderedStructure(pr);
 return `<select id="shot-scene" name="sceneId">${multi?tree.map(g=>`<optgroup label="${esc(g.episode.title)}">${g.scenes.map(opt).join('')}</optgroup>`).join(''):tree.flatMap(g=>g.scenes).map(opt).join('')}</select>`;
}
function viewerAsset(s) {
 const ids=generationRecords(s).map(j=>j.assetId).filter(id=>id&&asset(id));
 if(viewerId&&asset(viewerId)&&(ids.includes(viewerId)||viewerId===s.referenceId))return asset(viewerId);
 return asset(s.selectedVideoId)||asset(ids.at(-1))||asset(s.referenceId)||null;
}
function viewerActions(s,a) {
 const c=a.collection||'library',isFirst=a.id===s.referenceId,isEnd=a.id===s.endReferenceId,isTake=a.id===s.selectedVideoId;
 const label=c==='review'?'Новый результат':c==='archive'?'В архиве':a.kind==='video'?(isTake?'Выбранный дубль':'Дубль'):isFirst?'Начальный кадр шота':isEnd?'Конечный кадр шота':'Кадр';
 let acts='';
 if(c==='review')acts+=`<button class="text-button" data-review="${a.id}" data-collection="library">В библиотеку</button><button class="text-button" data-review="${a.id}" data-collection="archive">В архив</button>`;
 else if(c==='archive')acts+=`<button class="text-button" data-move-asset="${a.id}" data-collection="library">Вернуть в библиотеку</button>`;
 else {
  if(a.kind==='video')acts+=(isTake?`<button class="text-button" data-clear-take="${a.id}">Снять выбор</button>`:`<button class="text-button" data-select-take="${a.id}">Выбрать дубль</button>`)+`<button class="text-button" data-add-clip="${a.id}">В монтаж</button>`;
  if(a.kind==='image'&&!isFirst)acts+=`<button class="text-button" data-use-first="${a.id}">Начальный кадр</button>`;
  if(a.kind==='image'&&!isEnd)acts+=`<button class="text-button" data-use-end="${a.id}">Конечный кадр</button>`;
  acts+=`<button class="text-button" data-move-asset="${a.id}" data-collection="archive">В архив</button>`;
 }
 return `<span class="state${isTake?' selected':''}">${label}</span>${acts}<span class="viewer-tools"><button class="icon-button" data-media-open="${a.id}" title="Открыть крупно" aria-label="Открыть крупно">${icon('expand',15)}</button><a class="icon-button" href="/media/${a.id}" download="${esc(a.name+ext(a.file))}" title="Скачать" aria-label="Скачать">${icon('download',15)}</a></span>`;
}
function takeIndex(s) {const counts={image:0,video:0},map=new Map();for(const j of generationRecords(s)){const n=++counts[j.kind];if(j.assetId)map.set(j.assetId,{kind:j.kind,n,job:j});}return map;}
function takeRow(s,j,n,current) {
 const a=j.assetId?asset(j.assetId):null,m=models.find(x=>x.id===j.modelId),since=Date.parse(j.createdAt)/1000;
 const name=`${j.kind==='image'?'Кадр':'Дубль'} ${n}`,model=esc(m?.name||j.model||'');
 if(a){
  const st=a.id===s.selectedVideoId?'<span class="st ok">в монтаже</span>':(a.collection||'library')==='review'?'<span class="st">новый</span>':a.kind==='video'?`<span class="st">${time(a.duration)}</span>`:'';
  return `<button type="button" class="take-row${current?.id===a.id?' on':''}" data-view-asset="${a.id}" title="${esc(j.prompt||'')}"><span class="take-th"><img src="${thumbSrc(a.id)}" alt=""></span><span class="take-name"><b>${name}</b><small>${model}</small></span>${st}</button>`;
 }
 if(activeGenerationStatuses.includes(j.status))return `<div class="take-row" title="${esc(j.prompt||'')}"><span class="take-th"><span class="busy-bar"></span></span><span class="take-name"><b>${name}</b><small>${esc(labels[j.status]||j.status)}</small></span><span class="st" data-since="${since}">${clock(Date.now()/1000-since)}</span></div>`;
 const noCredits=j.provider==='openai'&&/no credits remaining/i.test(j.error||j.pollError||'');
 return `<div class="take-row failed" title="${esc(j.prompt||'')}"><span class="take-th">${icon('alert',16)}</span><span class="take-name"><b>${name}</b><small>${esc(generationError(j))}${noCredits?' <a href="https://platform.openai.com/settings/organization/billing/" target="_blank" rel="noreferrer">Биллинг</a>':''}${j.status==='download_failed'?` <button type="button" class="text-btn" data-poll="${j.id}">Скачать снова</button>`:''}</small></span><span class="st bad">${j.status==='uncertain'?'проверить':j.status==='download_failed'?'не скачано':'ошибка'}</span></div>`;
}
function takesList(s) {
 const records=generationRecords(s),a=viewerAsset(s),counts={image:0,video:0},numbered=records.map(j=>({j,n:++counts[j.kind]})).reverse(),spent=records.filter(j=>j.provider!=='local').reduce((n,j)=>n+(j.estimate||0),0);
 return `<div class="takes-head"><span>Дубли и кадры</span>${records.length?`<span class="muted">${records.length}</span>`:''}${spent?`<span class="muted nowrap">≈ ${money(spent)}</span>`:''}</div><div class="takes-list">${numbered.map(({j,n})=>takeRow(s,j,n,a)).join('')||'<p class="takes-empty">Пока пусто. Опишите шот слева и снимите первый дубль.</p>'}</div>`;
}
function generationFeed(s) {
 const records=generationRecords(s),a=viewerAsset(s);
 const arriving=records.some(j=>j.id===animateGenerationId&&j.assetId===a?.id),finished=records.some(j=>j.id===animateGenerationId&&!activeGenerationStatuses.includes(j.status));
 if(arriving||finished)animateGenerationId=null;
 const media=a?(a.kind==='video'?`<video src="/media/${a.id}#t=0.1" controls playsinline preload="metadata"></video>`:`<img src="/media/${a.id}" alt="${esc(a.name)}">`):`<div class="viewer-empty">${records.length?'Выберите результат справа':'Здесь появятся кадры и дубли этого шота'}</div>`;
 const sc=sceneOf(s),info=a?takeIndex(s).get(a.id):null,cells=[['Сцена',sc?sceneIndex(sc)+1:1],['Шот',shotNumber(s.id)]];
 if(info)cells.push([info.kind==='video'?'Дубль':'Кадр',info.n]);
 return `<div class="viewer${arriving?' result-arrival':''}">${media}<div class="slate" aria-label="${cells.map(([l,v])=>l+' '+v).join(', ')}">${cells.map(([l,v])=>`<div><small>${l}</small><b>${v}</b></div>`).join('')}</div></div>${a?`<div class="viewer-bar">${viewerActions(s,a)}</div>`:''}`;
}
function generationRecords(s) {return jobs().filter(j=>j.shotId===s.id&&['image','video'].includes(j.kind)&&(!j.assetId||asset(j.assetId)?.collection!=='archive')).slice().sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));}
function generationVersion(s) {return JSON.stringify(generationRecords(s).map(j=>[j.id,j.status,j.assetId,asset(j.assetId)?.collection,j.error,j.pollError]));}
function refreshFeed() {const feed=$('#generation-feed'),takes=$('#takes-feed'),s=shot();if(!feed||!s)return;feed.innerHTML=generationFeed(s);feed.dataset.version=generationVersion(s);if(takes)takes.innerHTML=takesList(s);typograph(feed);typograph(takes);bindActions(feed);if(takes)bindActions(takes);}
function syncFeed() {
 const feed=$('#generation-feed'),s=shot();if(!feed||!s)return;
 if([...feed.querySelectorAll('video')].some(video=>!video.paused))return;
 const version=generationVersion(s);if(feed.dataset.version===version)return;
 const seen=new Set([...feed.querySelectorAll('[data-view-asset]')].map(b=>b.dataset.viewAsset)),fresh=generationRecords(s).map(j=>j.assetId).filter(id=>id&&asset(id)&&!seen.has(id));
 if(fresh.length)viewerId=fresh.at(-1);  // a new result takes the viewer
 refreshFeed();
}
const sceneColor=i=>'c'+(i%4);
const sceneIndex=sc=>orderedStructure(p()).flatMap(g=>g.scenes).findIndex(e=>e.scene.id===sc.id);
const sceneOf=s=>p().scenes.find(x=>x.id===s.sceneId);
const shotSeconds=x=>Number(x.duration)||5;
function tlClip(x,s) {
 const a=asset(x.selectedVideoId)||asset(x.referenceId)||latestAsset(x),takes=generationRecords(x).length,busy=jobs().some(j=>j.shotId===x.id&&activeGenerationStatuses.includes(j.status));
 return `<button type="button" class="tl-clip${x.id===s?.id?' on':''}${a?'':' none'}" data-shot="${esc(x.id)}" data-d="${shotSeconds(x)}" title="${esc(x.title)}">${a?`<img src="${thumbSrc(a.id)}" alt="">`:''}${takes?`<span class="tl-count" title="Дублей и кадров: ${takes}">${takes}</span>`:''}<span class="tl-label"><em>${shotNumber(x.id)}</em>${esc(x.title)}</span>${busy?'<span class="tl-busy" role="img" aria-label="Идёт генерация"></span>':''}</button>`;
}
function toolsGroup(kind,item,label,removable) {
 const title=renaming?.kind===kind&&renaming.id===item.id?renameForm(kind,item):`<span class="tool-title" title="${esc(item.title)}">${esc(item.title)}</span>`;
 const btn=(attr,t,ic)=>`<button type="button" class="icon-btn" ${attr} title="${t}" aria-label="${t}">${icon(ic,15)}</button>`;
 return `<div class="tl-tools" role="group" aria-label="${label}"><span class="tool-kind">${label}</span>${title}${btn(`data-rename="${kind}:${item.id}"`,'Переименовать','pencil')}${btn(`data-order="${kind}:${item.id}:-1"`,'Сдвинуть влево','left')}${btn(`data-order="${kind}:${item.id}:1"`,'Сдвинуть вправо','right')}${removable?btn(`data-remove="${kind}:${item.id}"`,'Убрать пустую','close'):''}</div>`;
}
function timelinePanel(s) {
 const pr=p(),tree=orderedStructure(pr),multi=pr.episodes.length>1,all=orderShots(pr),total=all.reduce((n,x)=>n+shotSeconds(x),0);
 const focusedScene=focus?.kind==='scene'?pr.scenes.find(x=>x.id===focus.id):null,curScene=focusedScene||(s?sceneOf(s):null);
 const curEpisode=focus?.kind==='episode'?pr.episodes.find(x=>x.id===focus.id):curScene?pr.episodes.find(e=>e.id===curScene.episodeId):null;
 let si=-1;
 const episodes=tree.map(g=>{
  const scenes=g.scenes.map(e=>{si++;const sum=e.shots.reduce((n,x)=>n+shotSeconds(x),0)||4;
   return `<div class="tl-scene ${sceneColor(si)}" data-w="${sum}"><button type="button" class="tl-bar${curScene?.id===e.scene.id?' on':''}" data-scene-pick="${e.scene.id}" title="${esc(e.scene.title)}">${esc(e.scene.title)}</button><div class="tl-clips">${e.shots.map(x=>tlClip(x,s)).join('')||`<button type="button" class="tl-empty" data-action="new-shot" data-scene-id="${e.scene.id}">Добавить шот</button>`}</div></div>`;}).join('');
  const w=g.scenes.reduce((n,e)=>n+(e.shots.reduce((m,x)=>m+shotSeconds(x),0)||4),0)||4;
  return `<div class="tl-episode" data-w="${w}">${multi?`<button type="button" class="tl-ep-bar${curEpisode?.id===g.episode.id?' on':''}" data-episode-pick="${g.episode.id}">${esc(g.episode.title)}</button>`:''}<div class="tl-scenes">${scenes||'<p class="tl-note">В эпизоде пока нет сцен.</p>'}</div></div>`;
 }).join('');
 const sceneRemovable=curScene&&!pr.shots.some(x=>x.sceneId===curScene.id)&&!curScene.fromScript;
 const epRemovable=multi&&curEpisode&&!pr.scenes.some(x=>x.episodeId===curEpisode.id)&&!curEpisode.fromScript;
 const add=(act,label)=>`<button type="button" class="btn-sm" data-action="${act}">${icon('plus',14)}${label}</button>`;
 return `<section class="panel panel-timeline" aria-label="Раскадровка" data-total="${total||1}"><div class="tl-head"><span class="ptitle">Раскадровка</span><span class="muted nowrap">${all.length} ${plural(all.length,'шот','шота','шотов')}, ${clock(total)}</span><span class="tl-gap"></span>${multi&&curEpisode?toolsGroup('episode',curEpisode,'Эпизод',epRemovable):''}${curScene?toolsGroup('scene',curScene,'Сцена',sceneRemovable):''}<span class="tl-gap"></span>${add('new-shot','Шот')}${add('new-scene','Сцена')}${add('new-episode','Эпизод')}</div><div class="tl-scroll"><div class="tl-track"><div class="tl-ruler"></div><div class="tl-row">${episodes||'<p class="tl-note">Здесь появятся сцены и шоты.</p>'}</div></div></div></section>`;
}
function layoutTimeline() {
 const root=$('.panel-timeline');if(!root)return;
 root.querySelectorAll('[data-w]').forEach(el=>{el.style.flexGrow=el.dataset.w;});
 root.querySelectorAll('[data-d]').forEach(el=>{el.style.flexGrow=el.dataset.d;});
 const total=Number(root.dataset.total)||1,track=root.querySelector('.tl-track');
 track.style.minWidth=Math.ceil(total*26+40)+'px';
 const width=track.clientWidth,step=[1,2,5,10,15,30,60,120,300,600].find(t=>width/total*t>=88)||600,ruler=root.querySelector('.tl-ruler');
 ruler.replaceChildren();
 for(let t=0;t<=total&&t/total*width<=width-36;t+=step){const tick=document.createElement('span');tick.textContent=clock(t);tick.style.left=(t/total*100)+'%';ruler.appendChild(tick);}
 const on=root.querySelector('.tl-clip.on'),box=root.querySelector('.tl-scroll');  // keep the shot in view without moving the page
 if(on){const o=on.getBoundingClientRect(),b=box.getBoundingClientRect();if(o.left<b.left+16)box.scrollLeft-=b.left+16-o.left;else if(o.right>b.right-16)box.scrollLeft+=o.right-b.right+16;}
}
function redrawTimeline() {
 const old=$('.panel-timeline');if(!old||!p())return;
 const left=old.querySelector('.tl-scroll')?.scrollLeft||0,html=timelinePanel(shot());
 old.outerHTML=html;timelineHtml=html;
 const next=$('.panel-timeline');next.querySelector('.tl-scroll').scrollLeft=left;layoutTimeline();typograph(next);bindActions(next);bindRename(next);
}
function syncTimeline() {if(renaming||!$('.panel-timeline')||!p())return;if(timelinePanel(shot())!==timelineHtml)redrawTimeline();}
function bindRename(root) {
 root.querySelectorAll('[data-rename-form]').forEach(f=>{
  const input=f.querySelector('input'),[kind,id]=f.dataset.renameForm.split(':'),original=input.value;let done=false;
  const finish=async(save)=>{if(done)return;done=true;const title=input.value.trim();renaming=null;
   if(save&&title&&title!==original)await action(async()=>{await api(`/api/${kind}s/${id}`,{method:'PATCH',body:{projectId,revision:p().revision,title}});await reload();render();});
   else redrawTimeline();};
  f.onsubmit=e=>{e.preventDefault();void finish(true);};input.onblur=()=>void finish(true);
  input.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();void finish(false);}};
  input.focus();input.select();
 });
}
function generateLabel() {return generateMode==='image'?'Создать кадр':'Снять дубль';}
function generationForm(s) {
 const video=generateMode==='video',available=models.filter(m=>m.kind===generateMode),m=available.find(m=>m.id===s.modelId)||available.find(m=>m.provider===localStorage.getItem('kazak-'+generateMode+'-provider'))||available.find(m=>video&&m.id==='seedance-2-openrouter')||available[0],busy=generationBusy(s),options=[...new Set(available.map(x=>x.provider))].map(pr=>`<optgroup label="${esc(providers[pr])}">${available.filter(x=>x.provider===pr).map(x=>option(x.id,x.name,m.id)).join('')}</optgroup>`).join(''),connect=state.connections[m.provider]?'':'<button class="text-btn" type="button" data-view="settings">Подключить '+esc(providers[m.provider])+'</button>';
 return `<form id="generate-form" data-model="${esc(m.id)}"><div class="gen-fields">${video?sourcePanels(m,s):''}<label class="sr-only" for="gen-prompt">${video?'Промпт шота':'Промпт кадра'}</label><textarea id="gen-prompt" name="prompt" required placeholder="${video?'Что происходит в шоте: действие, камера, свет, звук':'Что на кадре: композиция, герои, свет, оптика'}">${esc(s[video?'videoPrompt':'imagePrompt'])}</textarea><div class="kv-list">${video?howRow(m,s):''}<label class="kv"><span>Модель</span><span class="kv-end"><em class="kv-note">${esc(providers[m.provider])}</em><select id="model-select" name="modelId">${options}</select></span></label><div class="model-settings" id="model-controls">${modelControls(m,s)}</div></div></div><div class="compose-footer">${connect}<div class="price"><strong id="quote-text">…</strong><small id="quote-source"></small></div><div class="compose-actions"><button class="btn-primary generate-button" type="submit" data-busy="${busy}" title="Cmd+Enter" ${!state.connections[m.provider]||busy?'disabled':''}>${busy?'Создаётся…':generateLabel()}</button></div></div></form>`;
}
const sourceLabels={text:'Текст',frame:'Кадр',frames:'Начало и конец',cast:'Герои и места'};
const sourceModes=m=>['text','frame',...(m.end?['frames']:[]),...(m.refs?['cast']:[])];
function currentSource(s,m) {
 const modes=sourceModes(m),chosen=sourceByShot[s.id];if(chosen&&modes.includes(chosen))return chosen;
 const want=s.referenceIds?.length&&!s.referenceId&&m.refs?'cast':s.endReferenceId&&m.end?'frames':s.referenceId?'frame':'text';
 return modes.includes(want)?want:'text';
}
function frameSlot(name,label,current) {
 const a=asset(current);
 return `<div class="frame-slot"><input type="hidden" name="${name}" value="${esc(current||'')}"><div class="slot-box"><button type="button" class="slot-pick" data-pick-frame="${name}" aria-label="${label}">${a?`<img src="${thumbSrc(a.id)}" alt="">`:icon('plus',16)}</button>${a?`<button type="button" class="slot-clear" data-clear-frame="${name}" aria-label="Убрать: ${label.toLowerCase()}">${icon('close',12)}</button>`:''}</div><span class="slot-label">${label}</span></div>`;
}
function howRow(m,s) {
 const source=currentSource(s,m);
 return `<div class="kv kv-source"><span>Как снимаем</span><div class="seg" role="radiogroup" aria-label="Как снимаем">${sourceModes(m).map(id=>`<label class="seg-item"><input type="radio" name="inputMode" value="${id}" ${id===source?'checked':''}><span>${sourceLabels[id]}</span></label>`).join('')}</div><p class="hint" data-for="text" ${source==='text'?'':'hidden'}>Без кадров у нейросети больше свободы.</p></div>`;
}
function sourcePanels(m,s) {
 const source=currentSource(s,m),shown=id=>source===id?'':'hidden';
 return `<div class="frame-panel" data-for="frame frames" ${['frame','frames'].includes(source)?'':'hidden'}>${frameSlot('referenceId','Начальный кадр',s.referenceId)}${m.end?`<div data-for="frames" ${shown('frames')}>${frameSlot('endReferenceId','Конечный кадр',s.endReferenceId)}</div>`:''}</div>${m.refs?`<div class="ref-section" data-for="cast" ${shown('cast')}><div class="ref-head"><span>Герои и места</span><span class="muted">до ${m.refs} ${plural(m.refs,'изображения','изображений','изображений')}</span></div>${castChoices(s.referenceIds)}</div>`:''}`;
}
function modelControls(m,s) {
 if(m.kind==='image')return `<label class="kv"><span>Качество</span><select name="quality">${m.quality.map(q=>option(q,{low:'Черновое',medium:'Стандартное',high:'Высокое'}[q],'medium')).join('')}</select></label><div class="ref-section"><div class="ref-head"><span>Референсы</span><span class="muted">до ${m.refs} ${plural(m.refs,'изображения','изображений','изображений')}</span></div>${castChoices(s.referenceIds)}</div>`;
 const durationOptions=(m.durations||Array.from({length:m.max-m.min+1},(_,i)=>m.min+i)).map(d=>option(String(d),d+' с',String(s.duration||5))).join('');
 const resolution=m.resolutions.length?`<label class="kv"><span>Разрешение</span><select name="resolution">${m.resolutions.map(r=>option(r,r,'720p')).join('')}</select></label>`:'';
 const sound=m.sound?'<label class="kv"><span>Звук</span><input type="checkbox" name="sound" class="switch"></label>':'';
 return `<label class="kv"><span>Длительность</span><select name="duration">${durationOptions}</select></label>${resolution}${sound}`;
}
function applySource(form) {
 const mode=form.elements.namedItem('inputMode')?.value||'text';
 form.querySelectorAll('[data-for]').forEach(el=>{el.hidden=!el.dataset.for.split(' ').includes(mode);});
}
function openFramePicker(name) {
 const dlg=document.createElement('dialog'),imgs=assets().filter(a=>a.kind==='image'),end=name==='endReferenceId',target=shotId;
 dlg.className='frame-picker';
 dlg.innerHTML=`<div class="dlg-head"><span class="label">${end?'Конечный кадр':'Начальный кадр'}</span><span class="spacer"></span><label class="quiet upload-btn">${icon('upload',14)} Загрузить<input type="file" accept="image/png,image/jpeg,image/webp" hidden></label><button type="button" class="icon-button" data-close aria-label="Закрыть">${icon('close')}</button></div><div class="pick-grid">${imgs.map(a=>`<button type="button" data-pick="${a.id}"><img src="${thumbSrc(a.id)}" alt="${esc(a.name)}"></button>`).join('')||'<p class="hint">Изображений пока нет. Загрузите кадр или создайте его на вкладке «Кадр».</p>'}</div>`;
 const close=()=>{if(dlg.open)dlg.close();dlg.remove();};
 const set=id=>action(async()=>{shotId=target;await patchShot(end?{endReferenceId:id,status:'reference'}:{referenceId:id,status:'reference'});render();});
 dlg.addEventListener('click',e=>{const b=e.target.closest('[data-pick]');if(b){close();void set(b.dataset.pick);return;}if(e.target===dlg||e.target.closest('[data-close]'))close();});
 dlg.addEventListener('cancel',()=>dlg.remove());
 dlg.querySelector('input[type=file]').onchange=e=>{const f=e.target.files[0];if(!f)return;close();void action(async()=>{notify(`Загружаем ${f.name}`);const res=await fetch(`/api/upload?${new URLSearchParams({projectId,name:f.name,shotId:target})}`,{method:'POST',headers:{'X-Studio-Request':'1'},body:f}),data=await res.json();if(!res.ok)throw new Error(data.error);shotId=target;await patchShot(end?{endReferenceId:data.id,status:'reference'}:{referenceId:data.id,status:'reference'});render();});};
 document.body.appendChild(dlg);dlg.showModal();
}
function promptBlocks(text) {const parts=text.split(/```[^\n]*\n([\s\S]*?)```/g);return parts.map((part,i)=>i%2?`<div class="prompt-block"><pre>${esc(part.trim())}</pre><div><button class="text-button" data-prompt-type="image" data-prompt="${esc(part.trim())}">В промпт кадра</button><button class="text-button" data-prompt-type="video" data-prompt="${esc(part.trim())}">В промпт шота</button></div></div>`:part.trim()?`<div class="message-text">${esc(part.trim())}</div>`:'').join('');}
function sceneNav() {
 const pr=p(),heads=parseScript(pr.script||'').filter(h=>h.kind==='scene'),multi=pr.episodes.length>1;let si=-1;
 const html=orderedStructure(pr).map(g=>(multi?`<span class="nav-episode">${esc(g.episode.title)}</span>`:'')+g.scenes.map(({scene,shots})=>{si++;const h=heads.find(x=>norm(x.title)===norm(scene.title));return `<button type="button" class="scene-link ${sceneColor(si)}${h?'':' loose'}" ${h?`data-scene="${h.index}"`:`data-scene-goto="${scene.id}"`}><span>${esc(scene.title)}</span>${shots.length?`<small>${shots.length}</small>`:''}</button>`;}).join('')).join('');
 return html||'<p class="hint">Здесь появятся сцены. Заголовки, которые начинаются с ИНТ. или НАТ., становятся сценами сами.</p>';
}
function syncSceneNav() {const nav=$('#scene-nav');if(!nav)return;nav.innerHTML=sceneNav();typograph(nav);bindActions(nav);}
function scrollToScene(index,btn) {
 if(scriptDoc!=='script')$('[data-doc="script"]')?.click();
 const t=$('#doc-script'),desk=$('.desk');if(!t||!desk)return;
 document.querySelectorAll('.scene-link').forEach(x=>x.classList.toggle('on',x===btn));
 const cs=getComputedStyle(t),m=document.createElement('div');  // mirror measures where the heading sits, soft wraps included
 for(const k of ['fontFamily','fontSize','lineHeight','letterSpacing','paddingLeft','paddingRight','paddingTop'])m.style[k]=cs[k];
 Object.assign(m.style,{position:'absolute',visibility:'hidden',boxSizing:'border-box',width:t.clientWidth+'px',whiteSpace:'pre-wrap',overflowWrap:'break-word'});
 m.textContent=t.value.slice(0,index);document.body.appendChild(m);const y=m.offsetHeight;m.remove();
 t.focus({preventScroll:true});t.setSelectionRange(index,index);
 if(t.scrollHeight>t.clientHeight+2)t.scrollTop=Math.max(0,y-140);else desk.scrollTop+=t.getBoundingClientRect().top-desk.getBoundingClientRect().top+y-160;
}
function assistantSection(provider,compact=false) {
 const model={openai:state.settings.textModel,deepseek:state.settings.deepseekModel,anthropic:state.settings.anthropicModel,local:state.settings.codexModel,sonnet:'Claude Sonnet'}[provider]||'';
 return `<section class="assistant${compact?' compact':''}">${compact?'':`<header><h2>Соавтор</h2><span class="mono">${esc(model)}</span></header>`}<div class="messages" role="log">${p().messages.length?'':'<p class="hint">Соавтор видит сценарий, библию фильма и раскадровку. Попросите разбить сцену на шоты или написать промпт. Промпты придут отдельными блоками с кнопками.</p>'}${p().messages.map(m=>`<article class="message ${m.role}"><span class="message-label">${m.role==='user'?'Вы':esc(m.model || 'Соавтор')}</span>${promptBlocks(m.text)}${m.role==='assistant'?`<div class="message-actions"><button class="text-button" data-apply="${m.id}">В сценарий</button><button class="text-button" data-answer-shot="${m.id}">Новый шот</button></div>`:''}</article>`).join('')}<article class="message assistant" id="stream-message" ${!chatBusy?'hidden':''}><span class="message-label">Соавтор</span><div id="stream-text" class="message-text">Готовим ответ…</div></article></div><form id="assistant-form"><label class="sr-only" for="chat-prompt">Сообщение соавтору</label><textarea id="chat-prompt" name="prompt" required rows="2" placeholder="Сообщение">${esc(assistantDraft)}</textarea><div class="chat-attachments" ${!['openai','anthropic'].includes(provider)?'hidden':''}><details><summary>Прикрепить кадры</summary>${refChoices([],'attachments')}</details></div><div class="assistant-options"><label class="sr-only" for="assistant-provider">Модель соавтора</label><select id="assistant-provider" name="provider">${[['API',[['openai','OpenAI'],['deepseek','DeepSeek'],['anthropic','Claude']]],['Подписка',[['sonnet','Claude Sonnet'],['local','Codex']]]].map(([g,list])=>`<optgroup label="${g}">${list.map(([id,n])=>`<option value="${id}" ${id===provider?'selected':''} ${['local','sonnet'].includes(id)?!state.capabilities[id==='local'?'codex':'sonnet']?'disabled':'':!state.connections[id]?'disabled':''}>${n}</option>`).join('')}</optgroup>`).join('')}</select><button class="primary" ${chatBusy?'disabled':''}>Отправить</button></div><small class="hint">${['local','sonnet'].includes(provider)?'Используется подписка и её лимиты.':`Резерв на ответ: ${money(state.settings.assistantReserve)}.`}</small></form></section>`;
}
function scriptPage() {
 const provider=assistantProvider();
 const text=p().script||'',words=(text.match(/\S+/g)||[]).length,pages=Math.max(1,Math.ceil(text.split('\n').length/55));
 const docs=[['script','Сценарий'],['brief','Бриф'],['bible','Библия фильма']];
 const placeholders={script:'ИНТ. КВАРТИРА — НОЧЬ\n\nДействие…',brief:'О чём фильм и какое впечатление он должен оставить.',bible:'Персонажи и их внешность, костюмы, локации, свет и цвет, правила непрерывности.'};
 return `<div class="script-desk"><form id="script-form"><aside class="script-nav"><span class="label">Сцены</span><div id="scene-nav">${sceneNav()}</div><span class="label">Фильм</span><div class="film-fields">${input('Название','title',p().title,'maxlength="200"')}<label>Формат<select name="ratio">${['16:9','9:16','1:1'].map(r=>option(r,r,p().ratio)).join('')}</select></label></div></aside><section class="desk"><div class="desk-bar"><div class="doc-tabs" role="group" aria-label="Документ">${docs.map(([id,n])=>`<button type="button" data-doc="${id}" aria-pressed="${scriptDoc===id}">${n}</button>`).join('')}</div><span class="desk-stats"><span>≈ ${pages} стр.</span><span>${words} ${plural(words,'слово','слова','слов')}</span></span><button type="button" class="text-button" data-action="import-script">Импорт</button><button type="button" class="text-button" data-action="restore">Предыдущая версия</button></div><div class="paper-wrap">${docs.map(([id,n])=>`<label class="sr-only" for="doc-${id}">${n}</label><textarea id="doc-${id}" class="paper" name="${id}" spellcheck="true" placeholder="${esc(placeholders[id])}" ${scriptDoc===id?'':'hidden'}>${esc(p()[id])}</textarea>`).join('')}</div></section></form>${assistantSection(provider)}</div>`;
}
function mediaItem(a) {
 const archived=libraryTab==='archive',reviewing=libraryTab==='review',id=esc(a.id);
 const media=a.kind==='audio'?icon('edit',32):`<img src="${thumbSrc(a.id)}" alt="">`;
 const main=archived?`<button class="text-button" data-collection="library" data-move-asset="${id}">Вернуть в библиотеку</button>`:reviewing?`<button class="text-button" data-collection="library" data-move-asset="${id}">В библиотеку</button>`:a.kind==='video'?`<button class="text-button" data-add-clip="${id}">В монтаж</button>`:a.kind==='image'&&p().shots.length?`<button class="text-button" data-use-first="${id}">Начальный кадр</button>`:'';
 const tools=(archived?'':`<button class="icon-button" data-collection="archive" data-move-asset="${id}" aria-label="В архив" title="В архив">${icon('archive',16)}</button>`)+`<a class="icon-button" href="/media/${id}" download="${esc(a.name+ext(a.file))}" aria-label="Скачать" title="Скачать">${icon('download',16)}</a>`;
 return `<article class="media-item"><button class="media-image" data-media-open="${id}" aria-label="Открыть ${esc(a.name)}">${media}${a.kind==='video'?`<span class="duration">${time(a.duration)}</span>`:''}</button><strong title="${esc(a.name)}">${esc(a.name)}</strong><span>${a.kind==='image'?a.width+' × '+a.height:time(a.duration)}<i>${(a.bytes/1048576).toFixed(1)} МБ</i></span><div class="media-actions"><span>${main}</span><span class="media-tools">${tools}</span></div></article>`;
}
function mediaShelf(label,items) {return items.length?`<section class="media-shelf"><div class="rail-heading"><h2>${label}</h2><span>${items.length}</span></div><div class="media-grid">${items.map(mediaItem).join('')}</div></section>`:'';}
function mediaPage() {
 const reviewAssets=projectAssets().filter(a=>a.collection==='review'),source=libraryTab==='review'?reviewAssets:libraryTab==='archive'?projectAssets().filter(a=>a.collection==='archive'):assets(),list=source.filter(a=>(filter==='all'||a.kind===filter)&&(search===''||a.name.toLowerCase().includes(search.toLowerCase()))), kinds=[['image','Изображения'],['video','Видео'],['audio','Звук']];
 const shelves=(filter==='all'?kinds:kinds.filter(([kind])=>kind===filter)).map(([kind,label])=>mediaShelf(label,list.filter(a=>a.kind===kind))).join('');
 const reviewTab=reviewAssets.length?'<button data-library="review" aria-pressed="'+(libraryTab==='review')+'">На проверку <small>'+reviewAssets.length+'</small></button>':'';
 return `${title('Библиотека','',`${libraryTab==='archive'?'':`<button class="primary" data-action="import">${icon('upload')} Загрузить</button>`}`)}<div class="library-toolbar"><div class="mode-tabs">${reviewTab}<button data-library="media" aria-pressed="${libraryTab==='media'}">Материалы <small>${assets().length}</small></button><button data-library="archive" aria-pressed="${libraryTab==='archive'}">Архив <small>${projectAssets().filter(a=>a.collection==='archive').length}</small></button></div><label class="sr-only" for="library-search">Поиск материалов</label><input id="library-search" type="search" placeholder="Найти материал" value="${esc(search)}"><label class="sr-only" for="media-filter">Тип материалов</label><select id="media-filter">${[['all','Все материалы'],['image','Изображения'],['video','Видео'],['audio','Звук']].map(([id,n])=>option(id,n,filter)).join('')}</select></div>${shelves||`<div class="empty-page"><h2>${libraryTab==='archive'?'Архив пуст':libraryTab==='review'?'Нет материалов на проверке':'Библиотека пока пуста'}</h2><p>${libraryTab==='archive'?'Отклонённые версии останутся здесь. Их можно вернуть в библиотеку.':libraryTab==='review'?'Готовые генерации ждут решения: добавить их в библиотеку или убрать в архив.':'Загрузите материал или примите готовую генерацию в библиотеку.'}</p></div>`}`;
}
function castPage() {
 const c=p().cards.find(c=>c.id===cardId),n=p().cards.length;
 return `${title('Герои и места','',n?`<button class="quiet" data-action="new-card">Новая карточка</button>`:'')}${newCard?`<form id="new-card-form" class="new-card">${input('Название','title','','required placeholder="Например, главный герой"')}<label>Тип<select name="category">${Object.entries(categories).map(([id,n])=>option(id,n,'character')).join('')}</select></label><button class="primary">Создать карточку</button><button type="button" class="quiet" data-action="cancel-card">Отмена</button></form>`:''}<div class="cards-layout"><section class="media-shelf">${n?'<div class="card-grid">':''}${p().cards.map(c=>`<button class="reference-card ${c.id===cardId?'selected':''}" data-card="${c.id}"><span class="card-cover">${c.assetIds[0]?`<img src="${thumbSrc(c.assetIds[0])}" alt="">`:icon('media',28)}</span><strong>${esc(c.title)}</strong><span>${categories[c.category]}, ${c.assetIds.length} ${plural(c.assetIds.length,'изображение','изображения','изображений')}</span></button>`).join('')}${n?'</div>':`<div class="empty-page"><h2>Пока никого нет</h2><p>Карточка собирает описание и изображения героя или места. Добавьте её в шот, и внешность не будет меняться от дубля к дублю.</p><button class="primary" data-action="new-card">Создать карточку</button></div>`}</section>${c?`<form id="card-form" class="card-inspector">${input('Название','title',c.title,'maxlength="200"')}${textarea('Описание','description',c.description,5)}<h3>Изображения героя или места</h3>${refChoices(c.assetIds,'assetIds')}<button type="button" class="quiet" data-action="card-to-shot" ${!c.assetIds.length?'disabled':''}>Добавить в шот</button><button type="button" class="text-button danger" data-action="delete-card">Убрать карточку</button></form>`:''}</div>`;
}
function jobsPage() {
 const spend=spendStats(),budget=p().budget;
 const stats=`<section class="spend-summary" aria-label="Оценка расходов"><div class="spend-stat"><span>Оценка по заданиям</span><strong>≈ ${money(spend.total)}</strong></div><div class="spend-stat"><span>Плановый бюджет</span><strong>${budget==null?'Не задан':money(budget)}</strong></div><div class="spend-stat"><span>Остаток</span><strong>${spend.remaining==null?'Без лимита':money(spend.remaining)}</strong></div><div class="spend-stat"><span>Средняя генерация</span><strong>${spend.average==null?'—':`≈ ${money(spend.average)}`}</strong><small>${spend.count} ${plural(spend.count,'задание','задания','заданий')}</small></div></section>`;
 const history=jobs().slice().reverse().map(j=>`<details class="job"><summary><span class="job-type">${icon(j.kind==='assistant'?'chat':j.kind==='export'?'edit':'film')}</span><span class="job-title"><strong>${esc(j.kind==='assistant'?'Соавтор':j.kind==='export'?'Экспорт MP4':p().shots.find(s=>s.id===j.shotId)?.title || 'Шот')}</strong><small>${esc(j.model || 'FFmpeg')}</small><small>${new Date(j.createdAt).toLocaleString('ru')}</small></span>${badge(j.status)}<span class="job-price">${j.provider==='local'?'Локально':`≈ ${money(j.estimate)}`}</span></summary><div class="job-detail">${j.prompt?`<pre>${esc(j.prompt)}</pre>`:''}<p>ID: ${esc(j.remoteId || j.id)}</p>${j.status!=='succeeded'&&(j.error||j.pollError)?`<p class="error-copy">${esc(j.error || j.pollError)}</p>`:''}${j.text?`<pre>${esc(j.text)}</pre>`:''}${j.assetId?`<button class="quiet" data-media-open="${j.assetId}">Открыть результат</button>`:''}${j.kind==='video'&&['waiting','download_failed'].includes(j.status)?`<button class="quiet" data-poll="${j.id}">${j.status==='download_failed'?'Скачать повторно':'Проверить статус'}</button>`:''}${j.kind==='video'&&j.status==='uncertain'&&!j.remoteId?`<form data-recover="${j.id}"><label>ID в кабинете провайдера<input name="remoteId" required></label><button class="quiet">Найти результат</button></form>`:''}</div></details>`).join('') || '<div class="empty-page"><h2>Пока нет заданий</h2><p>Здесь сохраняются промпты, параметры и результаты.</p></div>';
 return `${title('История')}${stats}<form id="budget-form" class="budget-form"><label>План бюджета, USD <span class="optional">необязательно</span><input name="budget" type="number" min="0" step="0.01" value="${budget==null?'':esc(budget)}" placeholder="Без лимита"></label><button class="quiet">Сохранить бюджет</button></form><p class="hint budget-hint">Оставьте поле пустым, чтобы не ограничивать генерации. Стоимость здесь оценочная; фактическое списание смотрите у провайдера.</p><div class="job-list">${history}</div>`;
}
function settingsPage() {const rows=[['openai','OpenAI','openaiKey','platform.openai.com/api-keys'],['openrouter','OpenRouter','openrouterKey','openrouter.ai/settings/keys','Seedance и Kling через один ключ. Пополнение от $5, комиссия 5.5% берётся при покупке кредитов. Перед запуском показывается оценка стоимости.'],['seedance','Seedance через BytePlus','seedanceKey','console.byteplus.com','Для активации Seedance 2.0/2.5 нужен баланс Credits от $30 или отдельный план/пакет от $30. При оплате по Credits списывается фактическое использование; $30 — порог доступа, а не стоимость одного видео.'],['deepseek','DeepSeek','deepseekKey','platform.deepseek.com'],['anthropic','Claude API','anthropicKey','console.anthropic.com']];return `${title('Подключения','API оплачивается отдельно от подписки ChatGPT. Ключи хранятся в Связке ключей macOS.')}<form id="settings-form" class="settings-form">${rows.map(([id,n,k,url,note])=>`<section class="connection"><div class="connection-head"><h2>${n}</h2><span>${state.connections[id]?'Ключ доступен':'Не подключён'}</span></div>${note?`<p>${note}</p>`:''}<div class="key-entry">${input('API-ключ',k,'','type="password" autocomplete="off" placeholder="Вставьте ключ"')}<button type="button" class="quiet key-save" data-save-key="${k}" data-provider="${n}">${state.connections[id]?'Заменить ключ':'Сохранить ключ'}</button></div><a href="https://${url}" target="_blank" rel="noreferrer">Кабинет провайдера ${icon('arrow',13)}</a></section>`).join('')}<section class="connection"><div class="connection-head"><h2>Подписки</h2></div><p>Codex: ${state.capabilities.codex?'CLI установлен':'CLI не найден'}. Claude Sonnet: ${state.capabilities.sonnet?'CLI установлен':'CLI не найден'}.</p>${input('Модель Codex','codexModel',state.settings.codexModel)}</section><section class="connection"><h2>Модели соавтора</h2>${input('OpenAI','textModel',state.settings.textModel)}${input('DeepSeek','deepseekModel',state.settings.deepseekModel)}${input('Claude API','anthropicModel',state.settings.anthropicModel)}</section><section class="connection"><h2>Резервы бюджета</h2><p>Seedance 2.5: $10.70/млн токенов для 480p/720p, $11.70 для 1080p (вход без видео). Свой тариф — необязательное переопределение.</p>${input('Изображение, USD','imageReserve',state.settings.imageReserve,'type="number" step="0.01" min="0.001"')}${input('Ответ соавтора, USD','assistantReserve',state.settings.assistantReserve,'type="number" step="0.01" min="0.001"')}${input('Kling напрямую, USD/с','klingSecondRate',state.settings.klingSecondRate,'type="number" step="0.001" min="0.001"')}${input('Переопределить тариф Seedance 2.5, USD/млн токенов (необязательно)','seedance25TokenRate',state.settings.seedance25TokenRate || '','type="number" step="0.1" min="0.001" placeholder="Автоматический тариф ModelArk"')}</section><div class="settings-submit"><button class="primary">Сохранить настройки</button><span class="hint">Настройки сохраняются отдельно от ключей.</span></div></form>`;}
let editorRevision=0;
function generationData() {const form=$('#generate-form');if(!form)return null;const d=new FormData(form),m=models.find(m=>m.id===d.get('modelId'));return {projectId,shotId,kind:generateMode,provider:m.provider,modelId:m.id,prompt:d.get('prompt'),quality:d.get('quality') || 'medium',duration:Number(d.get('duration')),resolution:d.get('resolution') || undefined,sound:d.has('sound'),referenceIds:generateMode==='image'||d.get('inputMode')==='cast'?d.getAll('referenceIds'):[],referenceId:generateMode==='video'&&['frame','frames'].includes(d.get('inputMode'))?d.get('referenceId') || null:null,endReferenceId:generateMode==='video'&&d.get('inputMode')==='frames'?d.get('endReferenceId') || null:null};}
async function updateQuote() {const data=generationData(),v=++quoteVersion;if(!data)return;quoteData=null;try{const q=await api('/api/quote',{method:'POST',body:data});if(v!==quoteVersion)return;quoteData=q;$('#quote-text').textContent=`≈ ${money(q.amount)}`;$('#quote-source').textContent=q.basis==='estimate'?'Оценка по тарифу':q.source;$('#quote-source').parentElement.title=q.source;const b=$('#generate-form button[type=submit]');if(b)b.disabled=generationBusy(shot())||!state.connections[data.provider]||(p().budget!=null&&q.amount+(state.estimatedSpend[projectId]||0)>p().budget);}catch(e){if(v!==quoteVersion)return;$('#quote-text').textContent=e.message;$('#quote-source').textContent='';const b=$('#generate-form button[type=submit]');if(b)b.disabled=true;}}
function cutDraft() {const f=$('#cut-form');if(!f)return {timeline:p().timeline,musicId:p().musicId,musicVolume:p().musicVolume};const d=new FormData(f);return {timeline:p().timeline.map(c=>({...c,start:Number(d.get(`start-${c.id}`)),end:Number(d.get(`end-${c.id}`)),muted:d.has(`muted-${c.id}`)})),musicId:d.get('musicId') || null,musicVolume:Number(d.get('musicVolume'))};}
async function saveProject(fields) {const id=projectId;await api(`/api/projects/${id}`,{method:'PATCH',body:{revision:p().revision,...fields}});await reload();editorRevision=p().revision;}
function draftSnapshot() {
 const sf=$('#script-form'),sh=$('#shot-form'),cf=$('#card-form');
 if(sf)return {type:'project',id:projectId,fields:Object.fromEntries(new FormData(sf))};
 if(sh){const fields=Object.fromEntries(new FormData(sh)),g=generationData(),form=$('#generate-form');if(g){fields[generateMode==='image'?'imagePrompt':'videoPrompt']=g.prompt;fields.modelId=g.modelId;const mode=form.elements.namedItem('inputMode')?.value||'text',hasSet=!!form.querySelector('[name="referenceIds"]');if(generateMode==='image'){if(hasSet)fields.referenceIds=g.referenceIds;}else{fields.duration=g.duration;if(mode==='cast'){if(hasSet)fields.referenceIds=g.referenceIds;}else{fields.referenceId=g.referenceId;fields.endReferenceId=g.endReferenceId;}}}return {type:'shot',id:shotId,projectId,fields};}
 if(cf){const d=new FormData(cf);return {type:'card',id:cardId,projectId,fields:{title:d.get('title'),description:d.get('description'),assetIds:d.getAll('assetIds')}};}
 if($('#cut-form'))return {type:'project',id:projectId,fields:cutDraft()};return null;
}
function markDirty() {dirty=true;draftVersion++;savedLabel('Сохранение…');const snapshot=draftSnapshot();if(snapshot)localStorage.setItem(`kazak-draft-${projectId}`,JSON.stringify(snapshot));clearTimeout(autosaveTimer);autosaveTimer=setTimeout(()=>flush().catch(e=>notify(e.message,true)),600);}
function restoreDraft() {const d=JSON.parse(localStorage.getItem(`kazak-draft-${projectId}`)||'null');if(!d)return;if(d.type==='shot'&&p().shots.some(s=>s.id===d.id)){shotId=d.id;localStorage.setItem('kazak-shot-'+projectId,shotId);view='shots';}else if(d.type==='card'&&p().cards.some(c=>c.id===d.id)){cardId=d.id;view='cast';}else if(d.type==='project'&&d.id===projectId)view=d.fields?.timeline?'edit':'script';else throw new Error('Черновик относится к другому объекту.');render();for(const [name,value] of Object.entries(d.fields||{})){const nodes=document.querySelectorAll(`[name="${CSS.escape(name)}"]`);for(const el of nodes){if(el.type==='checkbox')el.checked=Array.isArray(value)?value.includes(el.value):!!value;else if(el.type==='radio')el.checked=el.value===String(value);else if(typeof value==='string'||typeof value==='number')el.value=String(value);}}markDirty();}
async function flush() {
 clearTimeout(autosaveTimer);if(saving){await saving;if(dirty)return flush();return;}if(!dirty)return;
 const snapshot=draftSnapshot();if(!snapshot)return;const version=draftVersion,id=projectId,revision=editorRevision;
 saving=(async()=>{try {const route=snapshot.type==='project'?`/api/projects/${snapshot.id}`:`/api/${snapshot.type==='shot'?'shots':'cards'}/${snapshot.id}`;await api(route,{method:'PATCH',body:{projectId:id,revision,...snapshot.fields}});await reload();editorRevision=state.projects.find(x=>x.id===id).revision;if(view==='script')syncSceneNav();else if(view==='shots')syncTimeline();if(version===draftVersion){dirty=false;localStorage.removeItem(`kazak-draft-${id}`);savedLabel('Сохранено на Mac');}else savedLabel('Сохранение…');}catch(e){savedLabel(e.status===409?'Конфликт версий':'Не сохранено');throw e;}finally{saving=null;}})();
 await saving;if(dirty)return flush();
}
async function saveCut(){await flush();await saveProject(cutDraft());}
function render() {
 if(previewStop)previewStop();
 const viewChanged=renderedView!==null&&renderedView!==view,left=$('.tl-scroll')?.scrollLeft||0;
 renderedView=view;editorRevision=p()?.revision || 0;
 $('#app').innerHTML=shell();
 if(viewChanged) $('.page')?.classList.add('view-enter');
 typograph($('#app'));
 timelineHtml=$('.panel-timeline')?timelinePanel(shot()):'';
 bind();
 if($('.tl-scroll'))$('.tl-scroll').scrollLeft=left;
 layoutTimeline();
 if($('#generate-form'))void updateQuote();
}
function closePreview() {const id=previewOpenerId,index=previewOpenerIndex;selectedAsset=null;previewOpenerId=null;previewOpenerIndex=0;render();[...document.querySelectorAll('[data-media-open]')].filter(b=>b.dataset.mediaOpen===id)[index]?.focus();}
async function go(next) {await flush();if(next!==view)animateGenerationId=null;view=next;selectedAsset=null;localStorage.setItem('kazak-view',view);render();}
async function patchShot(fields) {const target=shot() || p().shots[0];if(!target)throw new Error('Сначала добавьте шот.');await api(`/api/shots/${target.id}`,{method:'PATCH',body:{projectId,revision:p().revision,...fields}});shotId=target.id;localStorage.setItem('kazak-shot-'+projectId,shotId);await reload();}
function bindActions(root) {
 const all=s=>root.querySelectorAll(s);
 all('[data-view]').forEach(b=>b.onclick=()=>action(()=>go(b.dataset.view)));
 all('[data-project]').forEach(b=>b.onclick=()=>action(async()=>{projectId=b.dataset.project;const shots=p()?orderShots(p()):[],saved=localStorage.getItem('kazak-shot-'+projectId);shotId=saved==='all'?null:shots.find(s=>s.id===saved)?.id||shots[0]?.id||null;await go('shots');}));
 all('[data-shot]').forEach(b=>b.onclick=()=>action(async()=>{animateGenerationId=null;shotId=b.dataset.shot;viewerId=null;focus=null;localStorage.setItem('kazak-shot-'+projectId,shotId);render();}));
 all('[data-mode]').forEach(b=>b.onclick=()=>action(async()=>{generateMode=b.dataset.mode;leftTab='create';render();}));
 all('[data-library]').forEach(b=>b.onclick=()=>action(async()=>{libraryTab=b.dataset.library;render();}));
 all('[data-card]').forEach(b=>b.onclick=()=>action(async()=>{cardId=b.dataset.card;render();}));
 all('[data-media-open]').forEach(b=>b.onclick=()=>action(async()=>{previewOpenerId=b.dataset.mediaOpen;previewOpenerIndex=[...document.querySelectorAll('[data-media-open]')].filter(x=>x.dataset.mediaOpen===previewOpenerId).indexOf(b);selectedAsset=b.dataset.mediaOpen;render();$('#preview-dialog .icon-button').focus();}));
 all('[data-action]').forEach(b=>b.onclick=()=>action(async()=>{
 const name=b.dataset.action;
 if(name==='new-project'){newProjectOpen=true;render();$('#new-project-form [name="title"]')?.focus();}
 if(name==='cancel-new-project'){newProjectOpen=false;render();}
 if(name==='open-folder'){await api('/api/project-folder',{method:'POST',body:{projectId}});notify('Папка фильма открыта в Finder.');}
 if(name==='restore-draft'){restoreDraft();notify('Черновик восстановлен.');return;}
 if(name==='clear-start-frame'){await patchShot({referenceId:null,status:'planned'});render();}
 if(name==='clear-end-frame'){await patchShot({endReferenceId:null});render();}
 if(name==='new-scene'||name==='new-episode'){await api(name==='new-scene'?'/api/scenes':'/api/episodes',{method:'POST',body:{projectId,revision:p().revision,...(b.dataset.episodeId?{episodeId:b.dataset.episodeId}:{})}});await reload();const made=(name==='new-scene'?p().scenes:p().episodes).at(-1).id,kind=name==='new-scene'?'scene':'episode';focus={kind,id:made};renaming={kind,id:made};view='shots';render();}
 if(name==='new-shot'){const sceneId=b.dataset.sceneId||shot()?.sceneId,s=await api('/api/shots',{method:'POST',body:{projectId,...(sceneId?{sceneId}:{})}});shotId=s.id;localStorage.setItem('kazak-shot-'+projectId,shotId);await reload();view='shots';render();}
 if(name==='shot-board'){shotId=null;localStorage.setItem('kazak-shot-'+projectId,'all');render();}
 if(name==='import')$('#media-picker').click();
 if(name==='import-script')$('#script-picker').click();
 if(name==='import-project')$('#project-picker').click();
 if(name==='close-preview'){closePreview();}
 if(name==='bundle'){const d=await api('/api/bundle',{method:'POST',body:{projectId}});const link=document.createElement('a');link.href=d.url;link.download=d.name || `${p().title}.kazak`;link.click();}
 if(name==='render'){await saveCut();await api('/api/render',{method:'POST',body:{projectId}});notify('Экспорт запущен. Результат появится в истории.');await reload();view='jobs';render();}
 if(name==='play-cut'){if(previewStop)previewStop();else{await saveCut();playCut();}}
 if(name==='split-cut'){await saveCut();await api('/api/split',{method:'POST',body:{projectId,revision:p().revision,position:playPosition}});await reload();render();}
 if(name==='restore'){await api('/api/restore',{method:'POST',body:{projectId,revision:p().revision}});await reload();render();notify('Предыдущая версия восстановлена.');}
 if(name==='delete-shot'){await api(`/api/shots/${shotId}`,{method:'DELETE',body:{projectId,revision:p().revision}});shotId=null;await reload();render();notify('Шот убран. Материалы сохранены; отмена доступна через предыдущую версию.');}
 if(name==='new-card'){newCard=true;render();}
 if(name==='cancel-card'){newCard=false;render();}
 if(name==='delete-card'){await api(`/api/cards/${cardId}`,{method:'DELETE',body:{projectId,revision:p().revision}});cardId=null;await reload();render();}
 if(name==='card-to-shot'){const c=p().cards.find(c=>c.id===cardId);await patchShot({referenceIds:[...new Set([...(shot()?.referenceIds || []),...c.assetIds])],notes:[shot()?.notes,c.description].filter(Boolean).join('\n')});sourceByShot[shotId]='cast';view='shots';render();notify('Герои и места добавлены в шот.');}
 }));
 all('[data-apply]').forEach(b=>b.onclick=()=>action(async()=>{const m=p().messages.find(m=>m.id===b.dataset.apply);await saveProject({script:[p().script,m.text].filter(Boolean).join('\n\n')});render();notify('Текст добавлен в сценарий.');}));
 all('[data-answer-shot]').forEach(b=>b.onclick=()=>action(async()=>{const m=p().messages.find(m=>m.id===b.dataset.answerShot),s=await api('/api/shots',{method:'POST',body:{projectId,description:m.text.slice(0,10000)}});shotId=s.id;localStorage.setItem('kazak-shot-'+projectId,shotId);await reload();view='shots';render();}));
 all('[data-prompt]').forEach(b=>b.onclick=()=>action(async()=>{if(!shot()&&!p().shots.length){const s=await api('/api/shots',{method:'POST',body:{projectId}});shotId=s.id;localStorage.setItem('kazak-shot-'+projectId,shotId);await reload();}await patchShot({[b.dataset.promptType==='image'?'imagePrompt':'videoPrompt']:b.dataset.prompt});generateMode=b.dataset.promptType;view='shots';render();}));
 all('[data-pick-card]').forEach(b=>b.onclick=()=>{const boxes=cardBoxes(p().cards.find(c=>c.id===b.dataset.pickCard)),on=boxes.length&&boxes.every(x=>x.checked);boxes.forEach(x=>x.checked=!on);boxes[0]?.dispatchEvent(new Event('change',{bubbles:true}));syncCardChoices();});
 all('input[name=referenceIds]').forEach(i=>i.addEventListener('change',syncCardChoices));syncCardChoices();
 all('[data-use-first]').forEach(b=>b.onclick=()=>action(async()=>{await patchShot({referenceId:b.dataset.useFirst,referenceIds:[],status:'reference'});view='shots';generateMode='video';render();}));
 all('[data-use-end]').forEach(b=>b.onclick=()=>action(async()=>{await patchShot({endReferenceId:b.dataset.useEnd,status:'reference'});render();notify('Конечный кадр выбран.');}));
 all('[data-select-take]').forEach(b=>b.onclick=()=>action(async()=>{await patchShot({selectedVideoId:b.dataset.selectTake,status:'approved'});render();}));
 all('[data-clear-take]').forEach(b=>b.onclick=()=>action(async()=>{await patchShot({selectedVideoId:null,status:'generated'});render();}));
 all('[data-review]').forEach(b=>b.onclick=()=>action(async()=>{const a=asset(b.dataset.review);await api(`/api/assets/${a.id}`,{method:'PATCH',body:{projectId,name:$('#review-name')?.value||a.name,collection:b.dataset.collection}});await reload();render();notify(b.dataset.collection==='library'?'Материал добавлен в библиотеку.':'Материал перемещён в архив.');}));
 all('[data-move-asset]').forEach(b=>b.onclick=()=>action(async()=>{await api(`/api/assets/${b.dataset.moveAsset}`,{method:'PATCH',body:{projectId,collection:b.dataset.collection}});if(b.dataset.collection==='library')libraryTab='media';else if(libraryTab==='review')libraryTab='archive';await reload();render();notify(b.dataset.collection==='library'?'Материал возвращён в библиотеку.':'Материал перемещён в архив.');}));
 all('[data-rename-asset]').forEach(b=>b.onclick=()=>action(async()=>{const a=asset(b.dataset.renameAsset),name=window.prompt('Название материала',a.name);if(name===null)return;await api(`/api/assets/${a.id}`,{method:'PATCH',body:{projectId,name,collection:a.collection || 'library'}});await reload();render();notify('Название сохранено.');}));
 all('[data-add-clip]').forEach(b=>b.onclick=()=>action(async()=>{const a=asset(b.dataset.addClip),draft=cutDraft();draft.timeline.push({id:crypto.randomUUID(),assetId:a.id,start:0,end:a.duration,muted:false});await saveProject(draft);render();notify('Клип добавлен в монтаж.');}));
 all('[data-move]').forEach(b=>b.onclick=()=>action(async()=>{const d=cutDraft(),i=Number(b.dataset.move),j=i+Number(b.dataset.direction);if(j<0||j>=d.timeline.length)return;[d.timeline[i],d.timeline[j]]=[d.timeline[j],d.timeline[i]];await saveProject(d);render();}));
 all('[data-remove-clip]').forEach(b=>b.onclick=()=>action(async()=>{const d=cutDraft();d.timeline.splice(Number(b.dataset.removeClip),1);await saveProject(d);render();}));
 all('[data-poll]').forEach(b=>b.onclick=()=>action(async()=>{await api('/api/poll',{method:'POST',body:{id:b.dataset.poll}});notify('Проверяем сохранённое задание.');}));
 all('[data-recover]').forEach(f=>f.onsubmit=e=>{e.preventDefault();action(async()=>{await api('/api/poll',{method:'POST',body:{id:f.dataset.recover,remoteId:new FormData(f).get('remoteId')}});await reload();render();});});
 all('[data-order]').forEach(b=>b.onclick=()=>action(async()=>{const [kind,id,dir]=b.dataset.order.split(':');const r=await api('/api/move',{method:'POST',body:{projectId,revision:p().revision,kind,id,direction:Number(dir)}});if(!r.ok)return;await reload();render();}));
 all('[data-rename]').forEach(b=>b.onclick=()=>{const [kind,id]=b.dataset.rename.split(':');renaming={kind,id};redrawTimeline();});
 all('[data-remove]').forEach(b=>b.onclick=()=>action(async()=>{const [kind,id]=b.dataset.remove.split(':');await api(`/api/${kind}s/${id}`,{method:'DELETE',body:{projectId,revision:p().revision}});focus=null;await reload();render();}));
 all('[data-left]').forEach(b=>b.onclick=()=>action(async()=>{leftTab=b.dataset.left;render();}));
 all('[data-scene-pick]').forEach(b=>b.onclick=()=>action(async()=>{const e=orderedStructure(p()).flatMap(g=>g.scenes).find(x=>x.scene.id===b.dataset.scenePick);focus={kind:'scene',id:b.dataset.scenePick};if(e?.shots[0]){shotId=e.shots[0].id;viewerId=null;localStorage.setItem('kazak-shot-'+projectId,shotId);}render();}));
 all('[data-episode-pick]').forEach(b=>b.onclick=()=>action(async()=>{focus={kind:'episode',id:b.dataset.episodePick};render();}));
 all('[data-pick-frame]').forEach(b=>b.onclick=()=>openFramePicker(b.dataset.pickFrame));
 all('[data-clear-frame]').forEach(b=>b.onclick=()=>action(async()=>{await patchShot({[b.dataset.clearFrame]:null});render();}));
 all('[data-scene-goto]').forEach(b=>b.onclick=()=>action(async()=>{const first=orderedStructure(p()).flatMap(g=>g.scenes).find(e=>e.scene.id===b.dataset.sceneGoto)?.shots[0];if(first){shotId=first.id;localStorage.setItem('kazak-shot-'+projectId,shotId);}await go('shots');}));
 all('[data-view-asset]').forEach(b=>b.onclick=()=>{viewerId=b.dataset.viewAsset;refreshFeed();});
 all('[data-doc]').forEach(b=>b.onclick=()=>{scriptDoc=b.dataset.doc;document.querySelectorAll('[data-doc]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));document.querySelectorAll('.paper').forEach(t=>t.hidden=t.name!==scriptDoc);$('#doc-'+scriptDoc)?.focus();});
 all('[data-scene]').forEach(b=>b.onclick=()=>scrollToScene(Number(b.dataset.scene),b));
}
function bind() {
 const preview=$('#preview-dialog');if(preview){preview.showModal();preview.addEventListener('cancel',e=>{e.preventDefault();closePreview();});}
 bindActions(document);
 bindRename(document);
 $('#gen-prompt')?.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();$('#generate-form').requestSubmit();}});
 if($('#generate-form'))applySource($('#generate-form'));
 $('#project-select').onchange=e=>action(async()=>{animateGenerationId=null;projectId=e.target.value;shotId=null;cardId=null;await reload();view='shots';render();});
 const forms=[['#new-project-form','/api/projects'],['#new-card-form','/api/cards'],['#settings-form','/api/settings']];
 for(const [selector,route] of forms)$(selector)?.addEventListener('submit',e=>{e.preventDefault();const values=Object.fromEntries(new FormData(e.target));if(selector==='#settings-form')for(const field of e.target.querySelectorAll('input[type="password"]'))delete values[field.name];action(async()=>{const result=await api(route,{method:'POST',body:selector==='#new-card-form'?{projectId,revision:p().revision,...values}:values});if(selector==='#new-project-form'){projectId=result.id;view='shots';shotId=null;newProjectOpen=false;}if(selector==='#new-card-form'){newCard=false;cardId=result.id;}await reload();render();notify('Сохранено.');});});
 document.querySelectorAll('#settings-form [data-save-key]').forEach(button=>button.onclick=()=>{const field=button.closest('.key-entry')?.querySelector('input[type="password"]');if(!field?.value.trim()){notify('Вставьте API-ключ в поле рядом.',true);field?.focus();return;}action(async()=>{await api('/api/settings',{method:'POST',body:{[button.dataset.saveKey]:field.value}});await reload();render();notify(`${button.dataset.provider}: ключ сохранён.`);});});
 document.querySelectorAll('#settings-form input[type="password"]').forEach(field=>field.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();field.closest('.key-entry')?.querySelector('[data-save-key]')?.click();}}));
 $('#budget-form')?.addEventListener('submit',e=>{e.preventDefault();action(async()=>{const value=new FormData(e.target).get('budget');await saveProject({budget:value===''?null:Number(value)});render();notify(value===''?'Лимит снят.':'Бюджет сохранён.');});});
 $('#cut-form')?.addEventListener('submit',e=>{e.preventDefault();action(async()=>{await saveCut();render();notify('Монтаж сохранён.');});});
 document.querySelectorAll('#script-form,#shot-form,#card-form,#cut-form').forEach(f=>{f.oninput=markDirty;f.onchange=markDirty;f.onsubmit=e=>e.preventDefault();});
 $('#generate-form')?.addEventListener('submit',e=>{e.preventDefault();action(async()=>{const data=generationData(),mode=new FormData(e.target).get('inputMode');if(generateMode==='video'){if(['frame','frames'].includes(mode)&&!data.referenceId)throw new Error('Выберите начальный кадр.');if(mode==='frames'&&!data.endReferenceId)throw new Error('Выберите конечный кадр.');if(mode==='cast'&&!data.referenceIds.length)throw new Error('Отметьте героев или места.');}const requestId=e.target.dataset.requestId || (e.target.dataset.requestId=crypto.randomUUID());const job=await api('/api/jobs',{method:'POST',body:{...data,requestId}});animateGenerationId=job.id;await reload();render();});});
 $('#generate-form')?.addEventListener('input',e=>{if(e.target.name==='prompt'){markDirty();clearTimeout(quoteTimer);quoteTimer=setTimeout(()=>void updateQuote(),350);}});
 $('#generate-form')?.addEventListener('change',e=>{
 if(e.target.name==='modelId')action(async()=>{const m=models.find(m=>m.id===e.target.value);await patchShot({modelId:m.id});localStorage.setItem(`kazak-${generateMode}-provider`,m.provider);render();});
 else {if(e.target.name==='inputMode'){sourceByShot[shotId]=e.target.value;applySource(e.currentTarget);}markDirty();void updateQuote();}
 });
 $('#assistant-form')?.addEventListener('submit',e=>{e.preventDefault();if(chatBusy)return;const d=new FormData(e.target);action(async()=>{const job=await api('/api/jobs',{method:'POST',body:{projectId,kind:'assistant',provider:d.get('provider'),prompt:d.get('prompt'),referenceIds:d.getAll('attachments'),requestId:crypto.randomUUID()}});assistantDraft='';chatBusy=true;render();void watchChat(job.id,projectId);});});
 $('#assistant-provider')?.addEventListener('change',e=>{assistantDraft=$('#chat-prompt').value;localStorage.setItem('kazak-assistant',e.target.value);render();});
 $('#chat-prompt')?.addEventListener('input',e=>assistantDraft=e.target.value);
 $('#media-filter')?.addEventListener('change',e=>{filter=e.target.value;render();});
 $('#library-search')?.addEventListener('input',e=>{search=e.target.value;const position=e.target.selectionStart;render();$('#library-search').focus();if(position!==null)$('#library-search').setSelectionRange(position,position);});
 document.querySelectorAll('[data-segment]').forEach(b=>{b.style.flexGrow=String(Number(b.dataset.length));b.onclick=()=>seekCut(Number(b.dataset.offset));});
 $('#cut-seek')?.addEventListener('input',e=>seekCut(Number(e.target.value)));if(view==='edit')seekCut(playPosition);
}
async function watchChat(id,targetProject) {try{while(true){const j=await api(`/api/job/${id}`);if(projectId===targetProject&&$('#stream-text')){$('#stream-message').hidden=false;$('#stream-text').textContent=j.text || 'Готовим ответ…';const box=$('.messages');box.scrollTop=box.scrollHeight;}if(['succeeded','uncertain','failed'].includes(j.status)){if(j.status!=='succeeded')notify(j.error,true);break;}await new Promise(resolve=>setTimeout(resolve,400));}}catch(e){notify(e.message,true);}finally{chatBusy=false;await reload();if(view==='script'&&!dirty)render();}}
$('#media-picker').onchange=e=>{const files=Array.from(e.target.files);action(async()=>{if(!p())throw new Error('Сначала создайте проект.');const target=projectId,targetShot=view==='shots'?shotId:null;for(const f of files){notify(`Загружаем ${f.name}`);const q=new URLSearchParams({projectId:target,name:f.name,...(targetShot?{shotId:targetShot}:{})}),res=await fetch(`/api/upload?${q}`,{method:'POST',headers:{'X-Studio-Request':'1'},body:f});const data=await res.json();if(!res.ok)throw new Error(data.error);}e.target.value='';await reload();render();notify(`${files.length} материалов загружено.`);});};
$('#script-picker').onchange=e=>{const f=e.target.files[0];if(!f)return;action(async()=>{if(f.size>300000)throw new Error('Текст больше 300 КБ.');await saveProject({script:await f.text()});e.target.value='';render();notify('Сценарий импортирован.');});};
$('#project-picker').onchange=e=>{const f=e.target.files[0];if(!f)return;action(async()=>{const res=await fetch('/api/import-project',{method:'POST',headers:{'X-Studio-Request':'1'},body:f});const data=await res.json();if(!res.ok)throw new Error(data.error);projectId=data.id;shotId=null;view='shots';e.target.value='';await reload();render();notify('Проект открыт.');});};
window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
window.addEventListener('resize',()=>layoutTimeline());
window.addEventListener('keydown',e=>{
 const tag=document.activeElement?.tagName;
 if(view!=='shots'||!p()||e.metaKey||e.ctrlKey||e.altKey||['INPUT','TEXTAREA','SELECT'].includes(tag)||document.activeElement?.isContentEditable||$('dialog[open]'))return;
 if(e.key==='ArrowLeft'||e.key==='ArrowRight'){const all=orderShots(p()),next=all[all.findIndex(x=>x.id===shotId)+(e.key==='ArrowRight'?1:-1)];if(next){e.preventDefault();shotId=next.id;focus=null;viewerId=null;localStorage.setItem('kazak-shot-'+projectId,shotId);render();}}
});
window.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='s'){e.preventDefault();void flush().catch(e=>notify(e.message,true));}});
try{await reload();render();}catch(e){$('#app').innerHTML=`<div class="fatal"><h1>Не удалось открыть студию</h1><p>${esc(e.message)}</p><button id="retry-start">Повторить</button></div>`;$('#retry-start').onclick=()=>location.reload();}
setInterval(async()=>{if(loading||saving||!state)return;try{const before=JSON.stringify([state.jobs,state.assets]),oldJobs=state.jobs;await reload();syncGenerationStatus();syncFeed();syncTimeline();syncTopbar();for(const j of state.jobs)if(j.status==='succeeded'&&oldJobs.find(x=>x.id===j.id)?.status!=='succeeded'&&j.kind==='export')notify('Экспорт фильма готов.');if(before!==JSON.stringify([state.jobs,state.assets])&&(!$('#generation-feed')||view!=='shots')&&!selectedAsset&&!dirty&&!previewStop&&!chatBusy&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName))render();}catch{notify('Нет связи с локальным сервером. Черновик сохраняется в браузере.',true);}},3000);
setInterval(()=>document.querySelectorAll('[data-since]').forEach(el=>el.textContent=clock(Date.now()/1000-Number(el.dataset.since))),1000);
function editPage() {
  const clips = p().timeline,
    total = clips.reduce((n, c) => n + c.end - c.start, 0),
    videoAssets = assets().filter(
      (a) => a.kind === "video" && a.role !== "film-export",
    );
  return `${title("Монтаж", [time(total), p().ratio, "24 fps"], `<button class="quiet" data-action="import">${icon("upload")} Импорт</button><button class="primary" data-action="render" ${!clips.length ? "disabled" : ""}>Экспорт MP4 ${icon("arrow")}</button>`)}<div class="edit-layout"><section class="cut-workspace"><div class="cut-player">${clips.length ? `<video id="cut-preview" src="/media/${clips[0].assetId}" playsinline preload="metadata"></video>` : `<div class="cut-empty">${icon("edit", 44)}<h2>Соберите историю.</h2><p>Добавляйте клипы из списка справа.<br>Порядок и обрезка меняют только монтаж.</p></div>`}</div><div class="transport"><button class="icon-button" data-action="play-cut" ${!clips.length ? "disabled" : ""} aria-label="Воспроизвести монтаж">${icon("play", 22)}</button><span id="play-time" class="timecode">00:00.0</span><span class="transport-total">/ ${time(total)}</span><span class="transport-spacer"></span><button class="quiet" data-action="split-cut" ${!clips.length ? "disabled" : ""}>Разрезать</button><button class="quiet" data-action="restore">Предыдущая версия</button></div>${timelineStrip(clips, total)}<form id="cut-form"><div class="timeline-head"><h2>Последовательность</h2><span>${clips.length} клипов</span></div><div class="timeline-list">${
    clips.length
      ? clips
          .map((c, i) => {
            const a = asset(c.assetId);
            return `<div class="clip-row" data-clip-id="${c.id}"><span class="clip-index">${String(i + 1).padStart(2, "0")}</span><img src="${thumbSrc(a.id)}" alt=""><div class="clip-name"><strong>${esc(shotLabel(a)||a.name)}</strong><small>${time(c.end - c.start)} из ${time(a.duration)}</small></div><label>Начало<input name="start-${c.id}" type="number" value="${c.start.toFixed(2)}" min="0" max="${a.duration}" step="0.01"></label><label>Конец<input name="end-${c.id}" type="number" value="${c.end.toFixed(2)}" min="0.04" max="${a.duration}" step="0.01"></label><label class="mute-label"><input type="checkbox" name="muted-${c.id}" ${c.muted ? "checked" : ""}> Без звука</label><div class="clip-buttons"><button type="button" class="icon-button" data-move="${i}" data-direction="-1" aria-label="Переместить клип ${i + 1} выше" ${i === 0 ? "disabled" : ""}>${icon("up")}</button><button type="button" class="icon-button" data-move="${i}" data-direction="1" aria-label="Переместить клип ${i + 1} ниже" ${i === clips.length - 1 ? "disabled" : ""}>${icon("down")}</button><button type="button" class="icon-button" data-remove-clip="${i}" aria-label="Убрать клип ${i + 1} из монтажа">${icon("close")}</button></div></div>`;
          })
          .join("")
      : '<p class="timeline-empty">Добавить видео в фильм можно одним кликом: «Добавить» рядом с видео.</p>'
  }</div><div class="soundtrack"><div><h2>Звуковая дорожка</h2><p class="hint">Музыка повторяется до конца фильма и смешивается с оригинальным звуком.</p></div><label>Аудио<select name="musicId">${option("", "Без отдельной дорожки", p().musicId)}${assets()
    .filter((a) => a.kind === "audio")
    .map((a) => option(a.id, a.name, p().musicId))
    .join(
      "",
    )}</select></label><label>Громкость<input name="musicVolume" type="range" min="0" max="1" step="0.05" value="${p().musicVolume}"></label></div></form>${state.jobs
    .filter((j) => j.projectId === projectId && j.kind === "export")
    .slice(-3)
    .reverse()
    .map(
      (j) =>
        `<div class="export-row"><span>Экспорт ${new Date(j.createdAt).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" })}</span>${badge(j.status)}${j.status === "running" ? `<span>${j.progress || 0}%</span>` : ""}${j.assetId ? `<a class="text-button" href="/media/${j.assetId}" download="${esc(p().title)}.mp4">Скачать MP4</a>` : ""}${j.error ? `<p class="error-copy">${esc(j.error)}</p>` : ""}</div>`,
    )
    .join(
      "",
    )}</section><aside class="clip-library"><h2>Видео проекта</h2><button class="quiet" data-action="import">${icon("plus")} Загрузить видео</button>${videoAssets.length ? videoAssets.map((a) => `<article><img src="${thumbSrc(a.id)}" alt="${esc(a.name)}"><strong>${esc(shotLabel(a)||a.name)}</strong><div><span>${time(a.duration)}</span><button class="text-button" data-add-clip="${a.id}">Добавить ${icon("plus", 14)}</button></div></article>`).join("") : '<p class="hint">Здесь появятся ваши загруженные видео и готовые генерации.</p>'}</aside></div>`;
}
function playCut() {
  if (previewStop) {
    previewStop();
    return;
  }
  const video = $("#cut-preview"),
    clips = p().timeline;
  if (!video || !clips.length) return;
  let index = 0,
    elapsed = 0,
    stopped = false;
  const total = clips.reduce((sum, c) => sum + c.end - c.start, 0);
  const initialPosition = playPosition >= total - 0.04 ? 0 : playPosition;
  while (
    index < clips.length - 1 &&
    elapsed + clips[index].end - clips[index].start <= initialPosition
  ) {
    elapsed += clips[index].end - clips[index].start;
    index++;
  }
  const music = p().musicId ? new Audio(`/media/${p().musicId}`) : null;
  if (music) {
    music.volume = p().musicVolume;
    music.loop = true;
    music.onloadedmetadata = () => {
      if (Number.isFinite(music.duration) && music.duration > 0)
        music.currentTime = initialPosition % music.duration;
      if (!stopped)
        music
          .play()
          .catch(() => notify("Музыка не запустилась в предпросмотре.", true));
    };
  }
  const playButton = $('[data-action="play-cut"]');
  playButton.setAttribute("aria-label", "Пауза монтажа");
  playButton.innerHTML = icon("pause", 22);
  const stop = () => {
    stopped = true;
    video.pause();
    music?.pause();
    video.removeEventListener("timeupdate", advance);
    video.removeEventListener("ended", next);
    previewStop = null;
    playButton.setAttribute("aria-label", "Воспроизвести монтаж");
    playButton.innerHTML = icon("play", 22);
  };
  const next = () => {
    if (stopped) return;
    elapsed += clips[index].end - clips[index].start;
    index++;
    if (index >= clips.length) {
      stop();
      notify("Просмотр завершён.");
    } else load();
  };
  const advance = () => {
    if (stopped) return;
    const c = clips[index];
    playPosition =
      elapsed +
      Math.min(c.end - c.start, Math.max(0, video.currentTime - c.start));
    $("#play-time").textContent = time(playPosition);
    if ($("#cut-seek")) $("#cut-seek").value = playPosition;
    if (video.currentTime >= c.end - 0.03) next();
  };
  const load = () => {
    const c = clips[index];
    video.src = `/media/${c.assetId}`;
    video.muted = c.muted;
    video.onloadedmetadata = () => {
      if (stopped) return;
      video.currentTime = c.start + Math.max(0, initialPosition - elapsed);
      video.play().catch((e) => {
        stop();
        notify(e.message, true);
      });
    };
  };
  video.addEventListener("timeupdate", advance);
  video.addEventListener("ended", next);
  previewStop = stop;
  load();
}
function timelineStrip(clips, total) {
  if (!clips.length) return "";
  let offset = 0;
  return `<div class="visual-timeline"><div class="timeline-ruler"><span>00:00</span><span>${time(total / 2)}</span><span>${time(total)}</span></div><div class="timeline-track">${clips
    .map((c, i) => {
      const start = offset;
      offset += c.end - c.start;
      return `<button class="timeline-segment" data-segment="${i}" data-length="${c.end - c.start}" data-offset="${start}" title="${esc(asset(c.assetId).name)}" aria-label="Перейти к клипу ${i + 1}"><img src="${thumbSrc(c.assetId)}" alt=""><span>${i + 1}</span></button>`;
    })
    .join(
      "",
    )}</div><label class="sr-only" for="cut-seek">Позиция монтажа в секундах</label><input id="cut-seek" type="range" min="0" max="${Math.max(0, total - 0.04)}" step="0.04" value="${Math.min(playPosition, total)}"></div>`;
}
function seekCut(position) {
  const video = $("#cut-preview");
  if (!video || !p()?.timeline.length) return;
  if (previewStop) previewStop();
  position = Math.max(
    0,
    Math.min(
      position,
      p().timeline.reduce((n, c) => n + c.end - c.start, 0) - 0.04,
    ),
  );
  let offset = 0,
    index = p().timeline.length - 1;
  for (let i = 0; i < p().timeline.length; i++) {
    const c = p().timeline[i];
    if (position < offset + c.end - c.start) {
      index = i;
      break;
    }
    offset += c.end - c.start;
  }
  const c = p().timeline[index];
  playPosition = Math.max(
    0,
    Math.min(
      position,
      p().timeline.reduce((n, c) => n + c.end - c.start, 0) - 0.04,
    ),
  );
  const target = Math.max(
    c.start,
    Math.min(c.end - 0.04, c.start + playPosition - offset),
  );
  if (video.getAttribute("src") !== `/media/${c.assetId}`) {
    video.src = `/media/${c.assetId}`;
    video.onloadedmetadata = () => {
      video.currentTime = Math.max(target, 0.04);  // 0 shows no frame until play
    };
  } else video.currentTime = Math.max(target, 0.04);  // 0 shows no frame until play
  video.muted = c.muted;
  if ($("#play-time")) $("#play-time").textContent = time(playPosition);
  if ($("#cut-seek")) $("#cut-seek").value = playPosition;
}
