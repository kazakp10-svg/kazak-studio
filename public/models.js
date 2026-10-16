// One capability catalogue is used by the form and by server validation.
export const models = [
  {id:'gpt-image-2.5', name:'GPT Image 2.5', provider:'openai', kind:'image', api:'gpt-image-2.5-sunburst', refs:16, quality:['low','medium','high']},
  {id:'gpt-image-2', name:'GPT Image 2', provider:'openai', kind:'image', api:'gpt-image-2', refs:16, quality:['low','medium','high']},
  {id:'seedance-2-direct', name:'Seedance 2.0', provider:'seedance', kind:'video', api:'dreamina-seedance-2-0-260128', min:2, max:15, resolutions:['480p','720p','1080p','4k'], sound:true, end:true, refs:9},
  {id:'seedance-25-direct', name:'Seedance 2.5', provider:'seedance', kind:'video', api:'dreamina-seedance-2-5-260628', min:2, max:30, resolutions:['480p','720p','1080p'], sound:true, end:true, refs:30},
  {id:'seedance-2-openrouter', name:'Seedance 2.0', provider:'openrouter', kind:'video', api:'bytedance/seedance-2.0', min:4, max:15, resolutions:['480p','720p'], sound:true, end:true, refs:9},
  {id:'seedance-2-mini-openrouter', name:'Seedance 2.0 Mini', provider:'openrouter', kind:'video', api:'bytedance/seedance-2.0-mini', min:4, max:15, resolutions:['480p','720p'], sound:true, end:true, refs:9},
  {id:'seedance-25-openrouter', name:'Seedance 2.5', provider:'openrouter', kind:'video', api:'bytedance/seedance-2.5', min:4, max:30, resolutions:['480p','720p'], sound:true, end:true, refs:30},
  {id:'kling-3-std-openrouter', name:'Kling 3.0 Standard', provider:'openrouter', kind:'video', api:'kwaivgi/kling-v3.0-std', min:3, max:15, resolutions:[], sound:true, end:true, refs:0},
  {id:'kling-3-pro-openrouter', name:'Kling 3.0 Pro', provider:'openrouter', kind:'video', api:'kwaivgi/kling-v3.0-pro', min:3, max:15, resolutions:[], sound:true, end:true, refs:0},
  {id:'kling-direct', name:'Kling v3', provider:'kling', kind:'video', api:'kling-v3', durations:[5,10], resolutions:[], sound:true, end:false, refs:0},
];
export const providers = {openai:'OpenAI',seedance:'BytePlus',openrouter:'OpenRouter',kling:'Kling',local:'Codex',deepseek:'DeepSeek',anthropic:'Claude'};
export function modelFor(input, settings={}) {
  if (input.modelId) return models.find(m=>m.id===input.modelId && m.kind===input.kind);
  return models.find(m=>m.kind===input.kind && m.provider===(input.kind==='image'?'openai':input.provider));
}
export function validateModelInput(model, input) {
  if (!model) throw new Error('Выберите доступную модель.');
  const refs=input.referenceIds || [];
  if (!Array.isArray(refs) || refs.length>model.refs || new Set(refs).size!==refs.length) throw new Error(`Модель принимает до ${model.refs} референсов.`);
  if (model.kind==='image') {
    if (!model.quality.includes(input.quality || 'medium')) throw new Error('Неверное качество изображения.');
    return;
  }
  const duration=input.duration;
  if (!Number.isInteger(duration) || (model.durations ? !model.durations.includes(duration) : duration<model.min || duration>model.max)) throw new Error('Эта длительность недоступна для выбранной модели.');
  if (input.resolution && !model.resolutions.includes(input.resolution)) throw new Error('Это разрешение недоступно для выбранной модели.');
  if (input.endReferenceId && (!model.end || !input.referenceId)) throw new Error('Для конечного кадра нужны начальный кадр и поддержка модели.');
  if (refs.length && (input.referenceId || input.endReferenceId)) throw new Error('Выберите один способ: кадры или герои и места.');
  if (input.sound && !model.sound) throw new Error('Эта модель не поддерживает звук.');
}
