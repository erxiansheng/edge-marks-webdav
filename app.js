const DIRECT_UPLOAD_BYTES = 4 * 1024 * 1024;
const state = { session: '', connected: false, currentPath: '/', items: [], busy: false };
const $ = (id) => document.getElementById(id);
const el = {
  connect: $('connectButton'), badge: $('connectionBadge'), summary: $('configSummary'),
  parent: $('parentButton'), newFolder: $('newFolderButton'), reload: $('reloadButton'), currentPath: $('currentPath'), cacheBadge: $('cacheBadge'),
  dropZone: $('dropZone'), fileInput: $('fileInput'), chooseFile: $('chooseFileButton'), tbody: $('fileTableBody'), clearLog: $('clearLogButton'), log: $('logOutput'), toast: $('toast'),
  uploadProgress: $('uploadProgress'), progressText: $('progressText'), progressValue: $('progressValue'), progressBar: $('progressBar')
};
let toastTimer;

function log(message, type = 'info') {
  const row = document.createElement('div');
  row.className = `log-line ${type}`;
  row.innerHTML = `<span>${new Date().toLocaleTimeString('zh-CN', { hour12: false })}</span><code>${escapeHtml(message)}</code>`;
  el.log.prepend(row);
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function toast(message, error = false) { clearTimeout(toastTimer); el.toast.textContent = message; el.toast.className = `toast show${error ? ' error' : ''}`; toastTimer = setTimeout(() => el.toast.className = 'toast', 3200); }
function setStatus(kind, text) { el.badge.className = `status-badge ${kind}`; el.badge.lastElementChild.textContent = text; }
function updateControls() {
  const enabled = state.connected && !state.busy;
  for (const node of [el.parent, el.newFolder, el.reload, el.chooseFile]) node.disabled = !enabled;
  el.connect.disabled = state.busy;
  el.dropZone.classList.toggle('disabled', !enabled);
}
function setBusy(value, label = '') { state.busy = value; if (value) setStatus('busy', label || '处理中'); updateControls(); }
function formatBytes(bytes) { if (bytes == null) return '—'; if (bytes === 0) return '0 B'; const u=['B','KiB','MiB','GiB','TiB']; const i=Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),u.length-1); return `${(bytes/1024**i).toFixed(i?1:0)} ${u[i]}`; }
function formatDate(value) { if (!value) return '—'; const d=new Date(value); return Number.isNaN(d.getTime()) ? value : d.toLocaleString('zh-CN',{hour12:false}); }
function normalizePath(path, directory=false) { const parts=String(path||'').replace(/\\/g,'/').split('/').filter(Boolean); let out=`/${parts.join('/')}`; if (!parts.length) out='/'; if(directory&&out!=='/'&&!out.endsWith('/'))out+='/'; return out; }
function joinPath(dir, name) { return normalizePath(`${normalizePath(dir,true)}${name}`); }
function parentPath(path) { const parts=normalizePath(path,true).split('/').filter(Boolean); parts.pop(); return parts.length?`/${parts.join('/')}/`:'/'; }
async function errorMessage(response) { try { const p=await response.json(); return p?.error?.message || `HTTP ${response.status}`; } catch { return `HTTP ${response.status}`; } }
async function api(url, options={}) { const response=await fetch(url, options); if(!response.ok) throw new Error(await errorMessage(response)); return response; }
async function postJson(url, body) { return api(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }); }

function blobToBase64(blob){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(reader.error || new Error('读取上传分片失败'));
    reader.onload=()=>{
      const value=String(reader.result||'');
      const comma=value.indexOf(',');
      if(comma<0)return reject(new Error('Base64 编码失败'));
      resolve(value.slice(comma+1));
    };
    reader.readAsDataURL(blob);
  });
}

async function connect() {
  setBusy(true,'连接中'); log('使用 Makers 环境变量探测 WebDAV');
  try {
    const response=await postJson('/api/webdav/session',{});
    const payload=await response.json();
    state.session=payload.session; state.connected=true;
    setStatus('online','已连接');
    el.summary.classList.remove('empty');
    el.summary.innerHTML=`<strong>${escapeHtml(payload.connection.baseUrl)}</strong><br>账号：${escapeHtml(payload.connection.username)} · 配置来源：环境变量 · WebDAV 探测：HTTP ${payload.connection.probe.status} · ${payload.connection.probe.latencyMs} ms<br><span class="ok">浏览器未接收 WebDAV 密码；下载使用 EdgeOne CDN 原生直链；CDN MISS 时由分片回源访问 Makers Cloud Function → WebDAV Range。</span>`;
    log(`连接成功，延迟 ${payload.connection.probe.latencyMs} ms`,'success');
    await loadDirectory('/');
  } catch(error){ state.connected=false; setStatus('offline','连接失败'); log(error.message,'error'); toast(error.message,true); }
  finally { state.busy=false; updateControls(); }
}

async function loadDirectory(path=state.currentPath) {
  if(!state.session) return;
  setBusy(true,'读取目录');
  try {
    const response=await postJson('/api/webdav/list',{session:state.session,path:normalizePath(path,true)});
    const payload=await response.json();
    state.currentPath=payload.path; state.items=payload.items; el.currentPath.textContent=payload.path;
    const kv=response.headers.get('X-KV-Cache') || (payload.cache?.hit?'HIT':'BYPASS'); el.cacheBadge.textContent=`KV ${kv}`;
    renderItems(); setStatus('online','已连接'); log(`读取 ${payload.path}：${payload.items.length} 项 · KV ${kv}`,'success');
  } catch(error){ log(error.message,'error'); toast(error.message,true); }
  finally { state.busy=false; updateControls(); }
}

function actionButton(label, cls, handler){ const b=document.createElement('button'); b.type='button'; b.className=`button ${cls} small`; b.textContent=label; b.addEventListener('click',handler); return b; }
function renderItems(){
  el.tbody.textContent='';
  if(!state.items.length){ const r=document.createElement('tr'); r.className='empty-row'; r.innerHTML='<td colspan="5">当前目录为空</td>'; el.tbody.append(r); return; }
  for(const item of state.items){
    const row=document.createElement('tr');
    const name=document.createElement('td'); const open=document.createElement('button'); open.type='button'; open.className='file-name-button'; open.innerHTML=`<span class="file-icon">${item.type==='directory'?'▣':'◇'}</span><span></span>`; open.lastElementChild.textContent=item.name; open.addEventListener('click',()=>item.type==='directory'?loadDirectory(item.path):downloadItem(item)); name.append(open);
    const type=document.createElement('td'); type.innerHTML=`<span class="type-pill">${item.type==='directory'?'目录':'文件'}</span>`;
    const size=document.createElement('td'); size.textContent=item.type==='directory'?'—':formatBytes(item.size);
    const modified=document.createElement('td'); modified.textContent=formatDate(item.modified);
    const actions=document.createElement('td'); const wrap=document.createElement('div'); wrap.className='file-actions'; wrap.append(actionButton(item.type==='directory'?'打开':'下载','ghost',()=>item.type==='directory'?loadDirectory(item.path):downloadItem(item)),actionButton('删除','danger',()=>deleteItem(item))); actions.append(wrap);
    row.append(name,type,size,modified,actions); el.tbody.append(row);
  }
}

function showProgress(text, percent){ el.uploadProgress.classList.remove('hidden'); el.progressText.textContent=text; el.progressValue.textContent=`${Math.max(0,Math.min(100,Math.round(percent)))}%`; el.progressBar.style.width=`${Math.max(0,Math.min(100,percent))}%`; }
function hideProgress(){ setTimeout(()=>el.uploadProgress.classList.add('hidden'),700); }
async function invalidate(path){ try{ await postJson('/api/webdav/cache/invalidate',{session:state.session,path}); }catch{} }

async function directUpload(file,path){
  const dataBase64=await blobToBase64(file);
  const response=await postJson('/api/webdav/file',{session:state.session,path,contentType:file.type||'application/octet-stream',dataBase64});
  return response.json();
}

async function largeUpload(file,path){
  const initRes=await postJson('/api/webdav/upload/init',{session:state.session,path,size:file.size,contentType:file.type||'application/octet-stream'}); const init=await initRes.json();
  log(`分片会话 ${init.uploadId}：${init.totalChunks} 片 × ${formatBytes(init.chunkBytes)}`);
  let completed=0;
  try {
    for(let index=0;index<init.totalChunks;index+=1){
      const start=index*init.chunkBytes, end=Math.min(file.size,start+init.chunkBytes); const chunk=file.slice(start,end);
      showProgress(`上传分片 ${index+1}/${init.totalChunks}`, (completed/file.size)*88);
      const dataBase64=await blobToBase64(chunk);
      await postJson('/api/webdav/upload/chunk',{session:state.session,uploadId:init.uploadId,index,dataBase64});
      completed=end; showProgress(`已写入 WebDAV 临时分片 ${index+1}/${init.totalChunks}`,(completed/file.size)*88);
    }
    showProgress('Cloud Function 正在流式合并到最终 WebDAV 文件',92);
    const completeRes=await postJson('/api/webdav/upload/complete',{session:state.session,uploadId:init.uploadId,path,size:file.size,totalChunks:init.totalChunks,contentType:file.type||'application/octet-stream'});
    showProgress('合并完成并清理临时分片',100); return completeRes.json();
  } catch(error){
    try{ await postJson('/api/webdav/upload/cancel',{session:state.session,uploadId:init.uploadId}); }catch{}
    throw error;
  }
}

async function uploadSelected(file){
  if(!file)return; const path=joinPath(state.currentPath,file.name); setBusy(true,'上传中'); showProgress(`准备上传 ${file.name}`,1); log(`上传 ${file.name}（${formatBytes(file.size)}）`);
  try{ const result=file.size<=DIRECT_UPLOAD_BYTES?await directUpload(file,path):await largeUpload(file,path); await invalidate(path); log(`上传成功：${result.path}`,'success'); toast('上传成功'); showProgress('上传完成',100); await loadDirectory(state.currentPath); }
  catch(error){ log(error.message,'error'); toast(error.message,true); }
  finally{ state.busy=false; el.fileInput.value=''; hideProgress(); updateControls(); }
}

function nativeDownload(url,name){
  const a=document.createElement('a'); a.href=url; a.download=name; a.rel='noreferrer'; document.body.append(a); a.click(); a.remove();
}

async function primeCdnRangeMetadata(url){
  // EdgeOne 冷缓存首次完整 GET 需要先知道源站是否支持 Range 以及文件总大小。
  // 先发一个不可见的 1-byte Range 探测，让 CDN 获得 Content-Range/总大小。
  // 这里只读取 1 byte，不做文件分片下载，也不在前端拼接文件。
  const response=await fetch(url,{
    method:'GET',
    headers:{Range:'bytes=0-0'},
    credentials:'omit'
  });
  if(response.status!==206){
    throw new Error(`CDN Range 探测失败：HTTP ${response.status}，请检查分片回源和 /download/* 回源规则`);
  }
  const contentRange=response.headers.get('content-range')||'';
  if(!/^bytes\s+0-0\/\d+$/i.test(contentRange)){
    throw new Error(`CDN Range 探测缺少有效 Content-Range：${contentRange||'empty'}`);
  }
  await response.arrayBuffer(); // 实际只消费 1 byte，确保探测请求完整结束。
  return contentRange;
}

async function downloadItem(item){
  setBusy(true,'生成下载直链'); log(`生成 CDN 原生下载直链：${item.path}`);
  try{
    const response=await postJson('/api/webdav/download-url',{session:state.session,path:item.path});
    const payload=await response.json();
    log(`CDN Range 元数据探测：${payload.cdn.host} / bytes=0-0`);
    const contentRange=await primeCdnRangeMetadata(payload.url);
    log(`Range 探测成功：${contentRange}；开始浏览器原生直链下载`,'success');
    nativeDownload(payload.url,item.name);
    toast('已交给浏览器原生下载');
  }catch(error){ log(error.message,'error'); toast(error.message,true); }
  finally{ state.busy=false; setStatus('online','已连接'); updateControls(); }
}

async function createFolder(){ const name=prompt('新目录名称'); if(!name)return; const path=normalizePath(`${normalizePath(state.currentPath,true)}${name}`,true); setBusy(true,'创建目录'); try{ await postJson('/api/webdav/folder',{session:state.session,path}); await invalidate(path); toast('目录已创建'); log(`创建目录 ${path}`,'success'); await loadDirectory(state.currentPath); }catch(error){toast(error.message,true);log(error.message,'error');}finally{state.busy=false;updateControls();} }
async function deleteItem(item){ if(!confirm(`确认删除 ${item.name}？${item.type==='directory'?'\n目录内容也会被删除。':''}`))return; setBusy(true,'删除中'); try{ await postJson('/api/webdav/delete',{session:state.session,path:item.path}); await invalidate(item.path); toast('已删除'); log(`删除 ${item.path}`,'success'); await loadDirectory(state.currentPath); }catch(error){toast(error.message,true);log(error.message,'error');}finally{state.busy=false;updateControls();} }

el.connect.addEventListener('click',connect); el.reload.addEventListener('click',()=>loadDirectory()); el.parent.addEventListener('click',()=>loadDirectory(parentPath(state.currentPath))); el.newFolder.addEventListener('click',createFolder); el.chooseFile.addEventListener('click',()=>el.fileInput.click()); el.fileInput.addEventListener('change',()=>uploadSelected(el.fileInput.files?.[0])); el.clearLog.addEventListener('click',()=>el.log.textContent='');
for(const eventName of ['dragenter','dragover']) el.dropZone.addEventListener(eventName,(event)=>{event.preventDefault();if(state.connected)el.dropZone.classList.add('dragging');});
for(const eventName of ['dragleave','drop']) el.dropZone.addEventListener(eventName,(event)=>{event.preventDefault();el.dropZone.classList.remove('dragging');});
el.dropZone.addEventListener('drop',(event)=>{if(state.connected)uploadSelected(event.dataTransfer?.files?.[0]);});
updateControls();
