import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import { ArrowLeft, Bell, Bookmark, Camera, Check, FilePlus2, Forward as ForwardIcon, Hash, Images, MessageCircle, Mic, MonitorUp, MoreHorizontal, Paperclip, Pin, Reply, Send, Smile, Square, Users, Volume2, VolumeX, Edit3, X, Search, MessageSquarePlus, UsersRound, Vote } from 'lucide-react';
import { api, apiOrigin, post, patch, del } from '../api';
import { useAuth, useToast } from '../state';
import { Avatar, Button, EmptyState, Loading, Modal } from '../components/ui';

type ChatMessage = { id:string; sender_id:string; username:string; avatar?:string|null; content:string; created_at:string; edited_at?:string|null; reply_to?:string|null; pinned?:number; reactions?:{emoji:string;user_id:string}[]; attachments?:{id:string;filename:string;mime:string;size:number}[]; read_by?:{user_id:string;username:string;read_at:string}[]; channel_id?:string|null; dm_id?:string|null; forwarded_from_message_id?:string|null; forwarded_from_user_id?:string|null; forwarded_from_username?:string|null; poll?:{id:string;allow_multiple:boolean;ends_at:string|null;is_closed:boolean;total_votes:number;options:{id:string;text:string;vote_count:number;selected:boolean}[];selected_option_ids:string[]}|null };

function compareMessages(a: ChatMessage, b: ChatMessage) {
 const timeDifference = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
 return timeDifference || a.id.localeCompare(b.id);
}

function renderInlineFormatting(value:string):React.ReactNode[]{
 const tokens=value.split(/(\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\|\|[^|]+\|\||\*[^*]+\*|_[^_]+_|\x60[^\x60]+\x60|https?:[/]{2}[^\s<>]+)/g).filter(Boolean);
 return tokens.map((token,index)=>{
  if(token.startsWith('**')&&token.endsWith('**'))return <strong key={index}>{token.slice(2,-2)}</strong>;
  if(token.startsWith('__')&&token.endsWith('__'))return <u key={index}>{token.slice(2,-2)}</u>;
  if(token.startsWith('~~')&&token.endsWith('~~'))return <del key={index}>{token.slice(2,-2)}</del>;
  if(token.startsWith('||')&&token.endsWith('||'))return <details className="message-spoiler" key={index}><summary>Spoiler</summary><span>{token.slice(2,-2)}</span></details>;
  if((token.startsWith('*')&&token.endsWith('*'))||(token.startsWith('_')&&token.endsWith('_')))return <em key={index}>{token.slice(1,-1)}</em>;
  if(token.startsWith('`')&&token.endsWith('`'))return <code key={index}>{token.slice(1,-1)}</code>;
  if(/^https?:\/\//i.test(token))return <a key={index} href={token} target="_blank" rel="noopener noreferrer">{token}</a>;
  return <React.Fragment key={index}>{token}</React.Fragment>;
 });
}

function renderFormattedMessage(content:string):React.ReactNode{
 const lines=content.split(/\r?\n/);const blocks:React.ReactNode[]=[];let index=0;
 const isBlockStart=(line:string)=>/^\s*```/.test(line)||/^\s*>\s?/.test(line)||/^\s*[-*+]\s+/.test(line)||/^\s*\d+\.\s+/.test(line)||/^#{1,4}\s+/.test(line);
 while(index<lines.length){
  const line=lines[index];
  if(!line.trim()){index++;continue;}
  if(/^\s*```/.test(line)){
   const codeLines:string[]=[];index++;
   while(index<lines.length&&!/^\s*```/.test(lines[index]))codeLines.push(lines[index++]);
   if(index<lines.length)index++;
   blocks.push(<pre className="message-code-block" key={blocks.length}><code>{codeLines.join('\n')}</code></pre>);continue;
  }
  if(/^\s*>\s?/.test(line)){
   const quote:string[]=[];
   while(index<lines.length&&/^\s*>\s?/.test(lines[index]))quote.push(lines[index++].replace(/^\s*>\s?/,''));
   blocks.push(<blockquote key={blocks.length}>{quote.map((text,i)=><React.Fragment key={i}>{renderInlineFormatting(text)}{i<quote.length-1?<br/>:null}</React.Fragment>)}</blockquote>);continue;
  }
  const unordered=/^\s*[-*+]\s+/.test(line);const ordered=/^\s*\d+\.\s+/.test(line);
  if(unordered||ordered){
   const items:string[]=[];const pattern=unordered?/^\s*[-*+]\s+/:/^\s*\d+\.\s+/;
   while(index<lines.length&&pattern.test(lines[index]))items.push(lines[index++].replace(pattern,''));
   blocks.push(unordered?<ul key={blocks.length}>{items.map((item,i)=><li key={i}>{renderInlineFormatting(item)}</li>)}</ul>:<ol key={blocks.length}>{items.map((item,i)=><li key={i}>{renderInlineFormatting(item)}</li>)}</ol>);continue;
  }
  const heading=line.match(/^(#{1,4})\s+(.+)$/);
  if(heading){const level=Math.min(4,heading[1].length);const Tag=(['h2','h3','h4','h4'] as const)[level-1];blocks.push(<Tag key={blocks.length}>{renderInlineFormatting(heading[2])}</Tag>);index++;continue;}
  const paragraph:string[]=[];
  while(index<lines.length&&lines[index].trim()&&!isBlockStart(lines[index]))paragraph.push(lines[index++]);
  if(!paragraph.length){paragraph.push(lines[index++]);}
  blocks.push(<p key={blocks.length}>{paragraph.map((text,i)=><React.Fragment key={i}>{renderInlineFormatting(text)}{i<paragraph.length-1?<br/>:null}</React.Fragment>)}</p>);
 }
 return <>{blocks}</>;
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Set([
 'image/png','image/jpeg','image/gif','image/webp','application/pdf','text/plain',
 'application/zip','audio/mpeg','audio/ogg','audio/webm','video/mp4'
]);
const BLOCKED_ATTACHMENT_EXTENSIONS = new Set(['.exe','.bat','.cmd','.js','.html','.svg','.sh','.ps1']);
type RoomServer = { server:{id:string;name:string;description?:string}; channels:any[]; members:any[]; categories:any[] };

function PollCard({poll,question}:{poll:NonNullable<ChatMessage['poll']>;question:string}){
 const toast=useToast();const [current,setCurrent]=useState(poll);const [selected,setSelected]=useState<string[]>(poll.selected_option_ids||[]);const [busy,setBusy]=useState(false);
 useEffect(()=>{setCurrent(poll);setSelected(poll.selected_option_ids||[]);},[poll]);
 const closed=current.is_closed||!!current.ends_at&&new Date(current.ends_at).getTime()<=Date.now();
 const choose=(optionId:string)=>setSelected(values=>current.allow_multiple?(values.includes(optionId)?values.filter(value=>value!==optionId):[...values,optionId]):[optionId]);
 const submit=async()=>{if(!selected.length||busy||closed)return;setBusy(true);try{const result=await post<{poll:NonNullable<ChatMessage['poll']>}>(`/polls/${current.id}/vote`,{optionIds:selected});setCurrent(result.poll);setSelected(result.poll.selected_option_ids||[]);}catch(error:any){toast.show(error.message,'error');}finally{setBusy(false);}};
 return <section className="poll-card" aria-label={question}>
  <div className="poll-card-heading"><b>Poll</b><span>{current.total_votes} vote{current.total_votes===1?'':'s'}</span></div>
  <div className="poll-choices">{current.options.map(option=>{const percent=current.total_votes?Math.round(option.vote_count/current.total_votes*100):0;return <button type="button" key={option.id} className={`poll-choice ${selected.includes(option.id)?'selected':''}`} disabled={closed||busy} onClick={()=>choose(option.id)}>
   <span className="poll-choice-top"><span className="poll-choice-indicator">{selected.includes(option.id)?'✓':''}</span><b>{option.text}</b><strong>{percent}%</strong></span>
   <span className="poll-choice-track"><span style={{width:`${percent}%`}}/></span>
   <small>{option.vote_count} vote{option.vote_count===1?'':'s'}</small>
  </button>;})}</div>
  <div className="poll-card-footer"><span>{closed?'Poll ended':current.ends_at?`Ends ${new Date(current.ends_at).toLocaleString()}`:'No end time'}{current.allow_multiple?' · Multiple answers allowed':''}</span><button type="button" className="btn primary" disabled={closed||busy||!selected.length} onClick={()=>void submit()}>{busy?'Saving…':'Vote'}</button></div>
 </section>;
}

function MessageList({ messages, loading=false, hasOlder=false, loadingOlder=false, onLoadOlder, currentUserId, onReply, onEdit, onMore, onReact, isDm=false }: {
 messages:ChatMessage[]; loading?:boolean; hasOlder?:boolean; loadingOlder?:boolean; onLoadOlder?:()=>void; currentUserId?:string; onReply:(m:ChatMessage)=>void; onEdit:(m:ChatMessage)=>void; onMore:(m:ChatMessage)=>void; onReact:(m:ChatMessage,emoji:string)=>void; isDm?:boolean;
}) {
 const bottomRef=useRef<HTMLDivElement>(null);
 useEffect(()=>{bottomRef.current?.scrollIntoView({block:'end',behavior:'auto'});},[messages[messages.length-1]?.id,loading]);
 return <div className="message-list">{hasOlder&&<div className="load-older-wrap"><button className="load-older" type="button" disabled={loadingOlder} onClick={onLoadOlder}>{loadingOlder?"Loading earlier messages…":"Load earlier messages"}</button></div>}{loading?<div className="chat-empty" role="status"><h3>Loading messages…</h3><p>Connecting to this conversation.</p></div>:messages.length===0?<div className="chat-empty"><h3>This is the beginning.</h3><p>Send the first message and get the conversation moving.</p></div>:messages.map((m,i)=>{
  const previous=i>0?messages[i-1]:null;
  const grouped=!!previous&&previous.sender_id===m.sender_id&&new Date(m.created_at).getTime()-new Date(previous.created_at).getTime()<5*60*1000;
  const own=m.sender_id===currentUserId;
  return <article className={`message ${grouped?'grouped':''} ${own?'own':'incoming'}`} key={m.id}>
   {!grouped?<Avatar name={m.username} src={m.avatar} size="md"/>:<span className="message-gutter"/>}
   <div className="message-body">
    {!grouped&&<div className="message-meta"><b>{m.username}</b><time>{new Date(m.created_at).toLocaleString()}</time>{m.edited_at&&<small>(edited)</small>}{m.pinned? <span className="pinned-mark"><Pin size={10}/> Pinned</span>:null}</div>}
    {m.reply_to&&<div className="reply-quote"><Reply size={11}/> Reply</div>}
    {m.forwarded_from_message_id&&<div className="forwarded-message-label"><ForwardIcon size={11}/> Forwarded from {m.forwarded_from_username||'another member'}</div>}
    <div className="message-content">{renderFormattedMessage(m.content)}</div>{m.poll&&<PollCard poll={m.poll} question={m.content}/>}<time className="message-time">{new Date(m.created_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time>
    {own&&isDm&&!!m.read_by?.length&&<small className="message-read-status">{m.read_by.length===1?'Seen':`Seen by ${m.read_by.length}`}</small>}
    {m.attachments?.map(a=>{const url=`${apiOrigin}/api/uploads/${a.id}`;return a.mime.startsWith('image/')?<a className="attachment-preview" key={a.id} href={url} target="_blank" rel="noreferrer"><img src={url} alt={a.filename} loading="lazy"/><small>{a.filename}</small></a>:a.mime==='video/mp4'?<div className="attachment-preview" key={a.id}><video src={url} controls preload="metadata"/><small>{a.filename}</small></div>:a.mime.startsWith('audio/')?<div className="attachment-audio" key={a.id}><audio src={url} controls preload="metadata"/><small>{a.filename}</small></div>:<a className="attachment" key={a.id} href={url} target="_blank" rel="noreferrer"><FilePlus2 size={18}/><span>{a.filename}<small>{Math.ceil(a.size/1024)} KB</small></span></a>;})}
    {!!m.reactions?.length&&<div className="reactions">{m.reactions.map((r,i)=><button key={`${r.emoji}-${i}`} onClick={()=>onReact(m,r.emoji)}>{r.emoji}</button>)}</div>}
   </div>
   <div className="message-tools">
    <button title="Reply" aria-label="Reply to message" onClick={()=>onReply(m)}><Reply size={14}/></button>
    <button title="React" aria-label="React to message" onClick={()=>onReact(m,'👍')}><Smile size={14}/></button>
    {own&&<button title="Edit" aria-label="Edit message" onClick={()=>onEdit(m)}><Edit3 size={14}/></button>}
    <button title="Message actions" aria-label="More message actions" onClick={()=>onMore(m)}><MoreHorizontal size={14}/></button>
   </div>
  </article>;
 })}<div ref={bottomRef}/></div>;
}

function SharedMediaPanel({items,loading,onClose}:{items:any[];loading:boolean;onClose:()=>void}){
 return <aside className="member-panel shared-media-panel"><div className="shared-media-heading"><div><b>Shared media</b><small>Latest 100 attachments</small></div><button className="icon-btn" onClick={onClose} aria-label="Close shared media">×</button></div>{loading?<Loading label="Loading shared files…"/>:items.length?<div className="shared-media-grid">{items.map(item=>{const url=`${apiOrigin}/api/uploads/${item.id}`;return <a key={item.id} className="shared-media-item" href={url} target="_blank" rel="noreferrer">{String(item.mime).startsWith('image/')?<img src={url} alt={item.filename} loading="lazy"/>:item.mime==='video/mp4'?<video src={url} muted preload="metadata"/>:<span className="shared-file-icon"><FilePlus2 size={22}/></span>}<b>{item.filename}</b><small>{item.username} · {new Date(item.created_at).toLocaleDateString()}</small></a>;})}</div>:<div className="mini-empty">No files have been shared here yet.</div>}</aside>;
}

function ChatComposer({ conversationId, isDm, socket, onSent, reply, clearReply }: { conversationId:string; isDm:boolean; socket:Socket|null; onSent:(m:ChatMessage)=>void; reply:ChatMessage|null; clearReply:()=>void }) {
 const {user}=useAuth();const draftKey=`relay:draft:${user?.id||'guest'}:${isDm?'dm':'channel'}:${conversationId}`;
 const [content,setContent]=useState(()=>{try{return window.localStorage.getItem(draftKey)||'';}catch{return '';}});const [busy,setBusy]=useState(false);
 useEffect(()=>{try{if(content)window.localStorage.setItem(draftKey,content);else window.localStorage.removeItem(draftKey);}catch{/* Draft saving is best effort when browser storage is restricted. */}},[content,draftKey]);const [files,setFiles]=useState<File[]>([]);const fileRef=useRef<HTMLInputElement>(null);const textareaRef=useRef<HTMLTextAreaElement>(null);const toast=useToast();const typingTarget=isDm?{dmId:conversationId}:{channelId:conversationId};
 const [recording,setRecording]=useState(false);const recorderRef=useRef<MediaRecorder|null>(null);const mediaStreamRef=useRef<MediaStream|null>(null);const audioChunksRef=useRef<Blob[]>([]);const mountedRef=useRef(true);
 useEffect(()=>{mountedRef.current=true;return()=>{mountedRef.current=false;const recorder=recorderRef.current;if(recorder&&recorder.state!=='inactive'){recorder.onstop=null;recorder.stop();}mediaStreamRef.current?.getTracks().forEach(track=>track.stop());};},[]);
 const [pollOpen,setPollOpen]=useState(false);const [pollQuestion,setPollQuestion]=useState('');const [pollOptions,setPollOptions]=useState(['','']);const [pollMultiple,setPollMultiple]=useState(false);const [pollDuration,setPollDuration]=useState('168');const [pollBusy,setPollBusy]=useState(false);
 const send=async(e?:React.FormEvent)=>{e?.preventDefault();socket?.emit('typing:stop',typingTarget);if((!content.trim()&&!files.length)||busy)return;setBusy(true);try{
  let uploadIds:string[]=[];
  if(files.length){const form=new FormData();files.forEach(f=>form.append('files',f));const uploaded=await post<{uploads:{id:string}[]}>('/uploads',form);uploadIds=uploaded.uploads.map(u=>u.id);}
  const route=isDm?`/dms/${conversationId}/messages`:`/channels/${conversationId}/messages`;
  const result=await post<{message:ChatMessage}>(route,{content:content.trim(),reply_to:reply?.id,uploadIds});onSent(result.message);setContent('');if(textareaRef.current)textareaRef.current.style.height='auto';setFiles([]);clearReply();
 }catch(err:any){toast.show(err.message,'error');}finally{setBusy(false);}};
 const startVoiceNote=async()=>{if(typeof MediaRecorder==='undefined'||!navigator.mediaDevices?.getUserMedia){toast.show('Voice recording is not supported in this browser.','error');return;}try{const stream=await navigator.mediaDevices.getUserMedia({audio:true});mediaStreamRef.current=stream;const mimeType=['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/webm','audio/ogg'].find(type=>MediaRecorder.isTypeSupported(type));const recorder=mimeType?new MediaRecorder(stream,{mimeType}):new MediaRecorder(stream);audioChunksRef.current=[];recorder.ondataavailable=event=>{if(event.data.size)audioChunksRef.current.push(event.data);};recorder.onerror=()=>toast.show('Voice recording failed. Try again.','error');recorder.onstop=()=>{const chunks=audioChunksRef.current;audioChunksRef.current=[];const actualType=recorder.mimeType.toLowerCase().startsWith('audio/ogg')?'audio/ogg':'audio/webm';const blob=new Blob(chunks,{type:actualType});stream.getTracks().forEach(track=>track.stop());if(mountedRef.current){mediaStreamRef.current=null;recorderRef.current=null;setRecording(false);if(blob.size>MAX_UPLOAD_BYTES){toast.show('This voice note is over the 10 MB limit. Record a shorter note.','error');return;}if(blob.size){const file=new File([blob],`voice-note-${Date.now()}.${actualType==='audio/ogg'?'ogg':'webm'}`,{type:actualType});setFiles(current=>{if(current.length>=8){toast.show('A message can contain up to 8 files.','error');return current;}return [...current,file];});}}};recorderRef.current=recorder;recorder.start(500);setRecording(true);}catch(error:any){mediaStreamRef.current?.getTracks().forEach(track=>track.stop());mediaStreamRef.current=null;toast.show(error.name==='NotAllowedError'?'Allow microphone access to record a voice note.':error.message||'Could not start voice recording.','error');}};
 const stopVoiceNote=()=>{const recorder=recorderRef.current;if(recorder&&recorder.state==='recording')recorder.stop();};
 const createPoll=async(e?:React.FormEvent)=>{e?.preventDefault();const question=pollQuestion.trim();const options=pollOptions.map(option=>option.trim()).filter(Boolean);if(question.length<3){toast.show('Write a poll question first.','error');return;}if(options.length<2){toast.show('Add at least two poll options.','error');return;}if(new Set(options.map(option=>option.toLocaleLowerCase())).size!==options.length){toast.show('Poll options must be unique.','error');return;}setPollBusy(true);try{const route=isDm?`/dms/${conversationId}/messages`:`/channels/${conversationId}/messages`;const result=await post<{message:ChatMessage}>(route,{content:question,poll:{options,allowMultiple:pollMultiple,durationHours:Number(pollDuration)}});onSent(result.message);setPollOpen(false);setPollQuestion('');setPollOptions(['','']);setPollMultiple(false);setPollDuration('168');}catch(error:any){toast.show(error.message,'error');}finally{setPollBusy(false);}};
 return <><div className="composer-wrap">
  {reply&&<div className="reply-banner"><Reply size={13}/> Replying to {reply.username}: {reply.content.slice(0,90)}<button onClick={clearReply} aria-label="Cancel reply"><X size={13}/></button></div>}
  {recording&&<div className="voice-recording-note"><span/> Recording voice note · press stop when finished</div>}
  {files.length>0&&<div className="file-chips">{files.map((f,i)=><span key={`${f.name}-${i}`}>{f.name}<button onClick={()=>setFiles(v=>v.filter((_,n)=>n!==i))}><X size={12}/></button></span>)}</div>}
  <form className="composer" onSubmit={send}>
   <input ref={fileRef} type="file" multiple hidden accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,application/zip,audio/mpeg,audio/ogg,video/mp4" onChange={e=>{
    const incoming = Array.from(e.currentTarget.files || []);
    const accepted = incoming.filter(file => {
     const dot = file.name.lastIndexOf('.');
     const extension = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
     return file.size <= MAX_UPLOAD_BYTES && ALLOWED_ATTACHMENT_TYPES.has(file.type) && !BLOCKED_ATTACHMENT_EXTENSIONS.has(extension);
    });
    const rejectedCount = incoming.length - accepted.length;
    const remainingSlots = Math.max(0, 8 - files.length);
    const added = accepted.slice(0, remainingSlots);
    if (rejectedCount) toast.show('Some files were skipped. Use supported file types up to 10 MB each.','error');
    if (added.length < accepted.length) toast.show('A message can contain up to 8 files.','info');
    setFiles(current => [...current, ...added]);
    e.currentTarget.value = '';
   }}/>
   <button className="composer-icon" type="button" title="Attach file" onClick={()=>fileRef.current?.click()}><Paperclip size={18}/></button>
   <button className={`composer-icon ${recording?'recording':''}`} type="button" title={recording?'Stop voice note':'Record voice note'} onClick={()=>recording?stopVoiceNote():void startVoiceNote()}>{recording?<Square size={17}/>:<Mic size={18}/>}</button>
   <button className="composer-icon" type="button" title="Create poll" onClick={()=>setPollOpen(true)}><Vote size={18}/></button>
   <textarea ref={textareaRef} rows={1} value={content} onChange={e=>{setContent(e.target.value);e.currentTarget.style.height='auto';e.currentTarget.style.height=`${Math.min(e.currentTarget.scrollHeight,144)}px`;socket?.emit(e.target.value.trim()?'typing:start':'typing:stop',typingTarget);}} onBlur={()=>socket?.emit('typing:stop',typingTarget)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void send();}}} placeholder="Write a message… Supports Markdown formatting" maxLength={4000}/>
   <button className="composer-send" type="submit" disabled={busy||(!content.trim()&&!files.length)} title="Send"><Send size={16}/></button>
  </form><div className="composer-foot"><span>Enter to send · Shift+Enter for a new line · **bold** *italic* ~~strike~~ `code`</span><span>{content.length}/4000</span></div>
 </div>
 {pollOpen&&<Modal title="Create a poll" onClose={()=>setPollOpen(false)}><form className="form-stack" onSubmit={createPoll}>
  <label className="field"><span>Question</span><input autoFocus value={pollQuestion} onChange={event=>setPollQuestion(event.target.value)} maxLength={240} placeholder="What should we do next?" required/></label>
  <div className="poll-editor-heading"><b>Answer options</b><small>{pollOptions.length}/10</small></div>
  {pollOptions.map((option,index)=><div className="poll-option-editor" key={index}><input value={option} onChange={event=>setPollOptions(values=>values.map((value,i)=>i===index?event.target.value:value))} maxLength={80} placeholder={`Option ${index+1}`}/><button type="button" className="icon-btn" title="Remove option" disabled={pollOptions.length<=2} onClick={()=>setPollOptions(values=>values.filter((_,i)=>i!==index))}><X size={15}/></button></div>)}
  <Button type="button" variant="secondary" disabled={pollOptions.length>=10} onClick={()=>setPollOptions(values=>[...values,''])}>Add option</Button>
  <label className="poll-checkbox"><input type="checkbox" checked={pollMultiple} onChange={event=>setPollMultiple(event.target.checked)}/> Allow multiple answers</label>
  <label className="field"><span>Poll duration</span><select value={pollDuration} onChange={event=>setPollDuration(event.target.value)}><option value="1">1 hour</option><option value="24">1 day</option><option value="72">3 days</option><option value="168">1 week</option><option value="336">2 weeks</option><option value="720">30 days</option></select></label>
  <div className="modal-actions"><Button type="button" variant="secondary" onClick={()=>setPollOpen(false)}>Cancel</Button><Button type="submit" disabled={pollBusy}>{pollBusy?'Creating…':'Create poll'}</Button></div>
 </form></Modal>}
 </>;
}

function useRoomMessages(id:string|undefined,isDm:boolean){
 const [messages,setMessages]=useState<ChatMessage[]>([]);
 const [loading,setLoading]=useState(true);
 const [hasOlder,setHasOlder]=useState(false);
 const [loadingOlder,setLoadingOlder]=useState(false);
 const [socket,setSocket]=useState<Socket|null>(null);
 const [typingUsers,setTypingUsers]=useState<Array<{id:string;username:string}>>([]);
 const toast=useToast();
 const typingTimers=useRef<Map<string,number>>(new Map());
 const requestGeneration=useRef(0);
 const route=isDm? `/dms/${id}/messages` : `/channels/${id}/messages`;

 const load=async(generation=requestGeneration.current)=>{
  if(!id){
   if(generation===requestGeneration.current){setMessages([]);setHasOlder(false);setLoadingOlder(false);setLoading(false);}
   return;
  }
  setMessages([]);
  setHasOlder(false);
  setLoadingOlder(false);
  setLoading(true);
  try{
   const response=await api<{messages:ChatMessage[]}>(route);
   if(generation!==requestGeneration.current)return;
   const next=response.messages||[];
   setMessages([...next].sort(compareMessages));
   setHasOlder(next.length===60);
  }catch(error:any){
   if(generation!==requestGeneration.current)return;
   toast.show(error.message,'error');
   setMessages([]);
  }finally{
   if(generation===requestGeneration.current)setLoading(false);
  }
 };

 const refreshLatest=async()=>{
  if(!id)return;
  const generation=requestGeneration.current;
  try{
   const response=await api<{messages:ChatMessage[]}>(route);
   if(generation!==requestGeneration.current)return;
   const latest=response.messages||[];
   const latestIds=new Set(latest.map(message=>message.id));
   const oldestLatest=latest[0];
   setMessages(current=>{
    const merged=new Map(current.map(message=>[message.id,message]));
    for(const message of latest)merged.set(message.id,message);
    if(latest.length<60)return [...latest].sort(compareMessages);
    if(oldestLatest){
     for(const message of current){
      if(compareMessages(message,oldestLatest)>=0&&!latestIds.has(message.id))merged.delete(message.id);
     }
    }
    return [...merged.values()].sort(compareMessages);
   });
   if(latest.length===60)setHasOlder(true);
  }catch{
   // Realtime polling is best-effort; a later cycle retries.
  }
 };

 useEffect(()=>{
  const generation=++requestGeneration.current;
  void load(generation);
  return()=>{
   if(requestGeneration.current===generation)requestGeneration.current+=1;
  };
 },[id,isDm]);

 useEffect(()=>{
  if(!id){setSocket(null);return;}
  const generation=requestGeneration.current;
  const isCurrentRoom=()=>generation===requestGeneration.current;
  const live:Socket=io(apiOrigin,{
   withCredentials:true,
   transports:['websocket'],
   reconnection:true,
   reconnectionDelay:500,
   reconnectionDelayMax:5000
  });
  let plannedRotation=false;let rotationTimer:number|undefined;
  live.on('relay:rotate',()=>{plannedRotation=true;});
  live.on('disconnect',()=>{if(plannedRotation){plannedRotation=false;rotationTimer=window.setTimeout(()=>{if(isCurrentRoom())live.connect();},250);}});
  setSocket(live);
  const joinEvent=isDm?'room:join-dm':'room:join-channel';
  live.on('connect',()=>{
   if(!isCurrentRoom())return;
   live.emit(joinEvent,id);
   void refreshLatest();
  });
  live.on('friends:updated',()=>{
   if(!isCurrentRoom())return;
   if(isDm)live.emit(joinEvent,id);
   void refreshLatest();
  });
  live.on('message:new',(message:ChatMessage)=>{
   if(!isCurrentRoom())return;
   setMessages(current=>current.some(item=>item.id===message.id)?current:[...current,message].sort(compareMessages));
  });
  live.on('message:read',(event:{userId:string;username:string;messageIds:string[];readAt:string})=>{
   if(!isCurrentRoom()||!Array.isArray(event?.messageIds))return;
   const readIds=new Set(event.messageIds);
   setMessages(current=>current.map(message=>readIds.has(message.id)?{...message,read_by:[...(message.read_by||[]).filter(reader=>reader.user_id!==event.userId),{user_id:event.userId,username:event.username,read_at:event.readAt}]}:message));
  });
  live.on('message:updated',(message:ChatMessage)=>{
   if(isCurrentRoom())setMessages(current=>current.map(item=>item.id===message.id?message:item).sort(compareMessages));
  });
  live.on('message:deleted',(message:{id:string})=>{
   if(isCurrentRoom())setMessages(current=>current.filter(item=>item.id!==message.id));
  });
  live.on('message:reactions',(update:{messageId:string;reactions:ChatMessage['reactions']})=>{
   if(isCurrentRoom())setMessages(current=>current.map(item=>item.id===update.messageId?{...item,reactions:update.reactions}:item));
  });
  const removeTypingUser=(userId:string)=>{
   const timer=typingTimers.current.get(userId);if(timer)window.clearTimeout(timer);
   typingTimers.current.delete(userId);
   setTypingUsers(current=>current.filter(item=>item.id!==userId));
  };
  live.on('typing',(event:any)=>{
   if(!isCurrentRoom())return;
   const userId=String(event?.userId||'');if(!userId)return;
   removeTypingUser(userId);
   if(!event.active)return;
   const username=String(event.username||'Someone');
   setTypingUsers(current=>[...current.filter(item=>item.id!==userId),{id:userId,username}]);
   const timer=window.setTimeout(()=>{if(typingTimers.current.get(userId)===timer){typingTimers.current.delete(userId);setTypingUsers(current=>current.filter(item=>item.id!==userId));}},5000);
   typingTimers.current.set(userId,timer);
  });
  const syncTimer=window.setInterval(()=>{if(isCurrentRoom())void refreshLatest();},15000);
  return()=>{
   window.clearInterval(syncTimer);
   if(rotationTimer)window.clearTimeout(rotationTimer);
   live.disconnect();
   for(const timer of typingTimers.current.values())window.clearTimeout(timer);
   typingTimers.current.clear();
   setSocket(current=>current===live?null:current);
   setTypingUsers([]);
  };
 },[id,isDm]);

 const loadOlder=async()=>{
  if(!id||!hasOlder||loadingOlder||!messages.length)return;
  const generation=requestGeneration.current;
  const oldest=messages[0];
  setLoadingOlder(true);
  try{
   const cursor=`?before=${encodeURIComponent(oldest.created_at)}&beforeId=${encodeURIComponent(oldest.id)}`;
   const older=(await api<{messages:ChatMessage[]}>(route+cursor)).messages||[];
   if(generation!==requestGeneration.current)return;
   setMessages(current=>[...older.filter(message=>!current.some(existing=>existing.id===message.id)),...current].sort(compareMessages));
   setHasOlder(older.length===60);
  }catch(error:any){
   if(generation===requestGeneration.current)toast.show(error.message,'error');
  }finally{
   if(generation===requestGeneration.current)setLoadingOlder(false);
  }
 };
 const add=(message:ChatMessage)=>{
  const belongsToRoom=isDm?message.dm_id===id:message.channel_id===id;
  if(!belongsToRoom)return;
  setMessages(current=>current.some(item=>item.id===message.id)?current:[...current,message].sort(compareMessages));
 };
 const typing=typingUsers.length?`${typingUsers.map(item=>item.username).join(', ')} ${typingUsers.length===1?'is':'are'} typing…`:'';
 return {messages,setMessages,loading,hasOlder,loadingOlder,loadOlder,typing,socket,add,reload:load};
}
function MessageActions({ message, isDm, onClose }: {message:ChatMessage;isDm:boolean;onClose:()=>void}) {
 const toast=useToast();const {user}=useAuth();const [bookmarked,setBookmarked]=useState<boolean|null>(null);
 const [forwardOpen,setForwardOpen]=useState(false);const [forwardTargets,setForwardTargets]=useState<Array<{id:string;type:'dm'|'channel';label:string}>>([]);
 const [forwardSelection,setForwardSelection]=useState('');const [forwardLoading,setForwardLoading]=useState(false);const [forwardBusy,setForwardBusy]=useState(false);
 useEffect(()=>{let active=true;api<{bookmarked:boolean}>(`/messages/${message.id}/bookmark`).then(result=>{if(active)setBookmarked(result.bookmarked);}).catch(error=>{if(active){setBookmarked(false);toast.show(error.message,'error');}});return()=>{active=false;};},[message.id]);
 useEffect(()=>{if(!forwardOpen)return;let active=true;setForwardLoading(true);setForwardTargets([]);setForwardSelection('');
  void (async()=>{const [dmResult,serverResult]=await Promise.all([api<{conversations:any[]}>('/dms'),api<{servers:any[]}>('/servers')]);
   const dmTargets=(dmResult.conversations||[]).map(conversation=>({id:conversation.id,type:'dm' as const,label:conversation.name||conversation.members?.filter((member:any)=>member.id!==user?.id).map((member:any)=>member.username).join(', ')||'Direct message'}));
   const serverResults=await Promise.all((serverResult.servers||[]).map(async(server:any)=>{try{return {server,room:await api<RoomServer>(`/servers/${server.id}`)};}catch{return null;}}));
   const channelTargets=serverResults.filter(Boolean).flatMap((entry:any)=>(entry.room.channels||[]).filter((channel:any)=>channel.type!=='voice').map((channel:any)=>({id:channel.id,type:'channel' as const,label:`${entry.server.name} · #${channel.name}`})));
   if(active){const options=[...dmTargets,...channelTargets];setForwardTargets(options);setForwardSelection(options.length?`${options[0].type}:${options[0].id}`:'');}
  })().catch(error=>{if(active)toast.show(error.message,'error');}).finally(()=>{if(active)setForwardLoading(false);});
  return()=>{active=false;};
 },[forwardOpen,user?.id]);
 const toggleBookmark=async()=>{try{if(bookmarked){await del(`/messages/${message.id}/bookmark`);setBookmarked(false);toast.show('Removed from saved messages.','success');}else{await post(`/messages/${message.id}/bookmark`);setBookmarked(true);toast.show('Message saved.','success');}}catch(error:any){toast.show(error.message,'error');}};
 const submitForward=async()=>{const [type,id]=forwardSelection.split(':');if(!id||!type||forwardBusy)return;setForwardBusy(true);try{await post(`/messages/${message.id}/forward`,type==='dm'?{dmId:id}:{channelId:id});toast.show('Message forwarded.','success');setForwardOpen(false);onClose();}catch(error:any){toast.show(error.message,'error');}finally{setForwardBusy(false);}};
 return <>
  <Modal title="Message actions" onClose={onClose}><div className="form-stack">
   <Button variant="secondary" onClick={async()=>{try{await post(`/messages/${message.id}/reactions`,{emoji:'👍'});toast.show('Reaction added.','success');onClose();}catch(e:any){toast.show(e.message,'error');}}}>Add 👍 reaction</Button>
   <Button variant="secondary" onClick={()=>setForwardOpen(true)}><ForwardIcon size={15}/> Forward message</Button>
   <Button variant="secondary" disabled={bookmarked===null} onClick={()=>void toggleBookmark()}><Bookmark size={15}/>{bookmarked===null?'Checking saved status…':bookmarked?'Remove saved message':'Save message'}</Button>
   <Button variant="secondary" onClick={async()=>{try{await navigator.clipboard.writeText(message.content);toast.show('Message copied.','success');}catch{toast.show('Clipboard access is unavailable in this browser.','error');}}}>Copy message</Button>
   {!isDm&&<Button variant="secondary" onClick={async()=>{try{const r=await post<{pinned:boolean}>(`/messages/${message.id}/pin`);toast.show(r.pinned?'Message pinned.':'Message unpinned.','success');onClose();}catch(e:any){toast.show(e.message,'error');}}}>Pin or unpin</Button>}
   {!isDm&&<Button variant="secondary" onClick={async()=>{const reason=window.prompt('Why are you reporting this message?');if(!reason)return;try{await post(`/messages/${message.id}/report`,{reason});toast.show('Report submitted.','success');onClose();}catch(e:any){toast.show(e.message,'error');}}}>Report message</Button>}
   {message.sender_id===user?.id&&<Button variant="danger" onClick={async()=>{if(!window.confirm('Delete this message?'))return;try{await del(`/messages/${message.id}`);toast.show('Message deleted.','success');onClose();}catch(e:any){toast.show(e.message,'error');}}}>Delete message</Button>}
  </div></Modal>
  {forwardOpen&&<Modal title="Forward message" onClose={()=>setForwardOpen(false)}><div className="form-stack">
    <p className="field-hint">Choose a direct conversation or a channel that you can access. Attachments are copied too.</p>
    {forwardLoading?<Loading label="Loading destinations…"/>:forwardTargets.length?<label className="field"><span>Destination</span><select value={forwardSelection} onChange={event=>setForwardSelection(event.target.value)}>{forwardTargets.map(target=><option key={`${target.type}:${target.id}`} value={`${target.type}:${target.id}`}>{target.label}</option>)}</select></label>:<EmptyState title="No destinations available" description="Join a conversation or community before forwarding a message."/>}
    <div className="modal-actions"><Button variant="secondary" onClick={()=>setForwardOpen(false)}>Cancel</Button><Button disabled={forwardLoading||!forwardSelection||forwardBusy} onClick={()=>void submitForward()}>{forwardBusy?'Forwarding…':'Forward message'}</Button></div>
   </div></Modal>}
 </>;
}

export function ChannelPage(){
 const {serverId,channelId}=useParams();const navigate=useNavigate();const {user}=useAuth();const toast=useToast();const [room,setRoom]=useState<RoomServer|null>(null);const [selected,setSelected]=useState<string|undefined>(channelId);const [reply,setReply]=useState<ChatMessage|null>(null);const [edit,setEdit]=useState<ChatMessage|null>(null);const [actionMessage,setActionMessage]=useState<ChatMessage|null>(null);const [membersOpen,setMembersOpen]=useState(false);const [sharedOpen,setSharedOpen]=useState(false);const [sharedItems,setSharedItems]=useState<any[]>([]);const [sharedLoading,setSharedLoading]=useState(false);
 useEffect(()=>{
  let active=true;
  if(!serverId){setRoom(null);return()=>{active=false;};}
  setRoom(null);
  api<RoomServer>(`/servers/${serverId}`)
   .then(r=>{
    if(!active)return;
    setRoom(r);
    const target=channelId||r.channels.find(c=>c.type!=='voice')?.id||r.channels[0]?.id;
    if(target){
     setSelected(target);
     if(!channelId)navigate(`/channels/${serverId}/${target}`,{replace:true});
    }
   })
   .catch(e=>{if(active)toast.show(e.message,'error');});
  return()=>{active=false;};
 },[serverId,navigate]);
 useEffect(()=>{setSelected(channelId);setReply(null);},[channelId]);
 const channel=room?.channels.find(c=>c.id===selected);const chat=useRoomMessages(channel?.id,false);
 const loadShared=async()=>{if(!channel?.id)return;setSharedOpen(true);setMembersOpen(false);setSharedLoading(true);try{const result=await api<any>(`/channels/${channel.id}/attachments`);setSharedItems(result.attachments||[]);}catch(error:any){toast.show(error.message,'error');}finally{setSharedLoading(false);}};
 const typing=chat.typing;
 useEffect(()=>{const toggle=()=>setMembersOpen(value=>!value);window.addEventListener('relay:toggle-members',toggle);return()=>window.removeEventListener('relay:toggle-members',toggle);},[]);
 const sendEdit=async()=>{if(!edit)return;try{const r=await patch<{message:ChatMessage}>(`/messages/${edit.id}`,{content:edit.content});chat.setMessages(v=>v.map(m=>m.id===r.message.id?r.message:m));setEdit(null);}catch(e:any){toast.show(e.message,'error');}};
 if(!serverId)return <Loading/>;if(!room)return <Loading label="Loading server"/>;
 if(!channel)return <div className="page-content"><EmptyState title="No channel selected" description="Create a channel in server settings or choose another server." action={<Link to={`/server/${serverId}/settings/overview`}>Server settings</Link>}/></div>;
 if(channel.type==='voice')return <div className="page-content voice-page"><div className="voice-card"><Volume2 size={32}/><h1>{channel.name}</h1><p>Talk with your community, turn on your camera, or share your screen. Some networks require TURN relay support.</p><VoiceJoin channelId={channel.id}/><div className="voice-controls"><Button variant="secondary" onClick={()=>setMembersOpen(v=>!v)}><Users size={15}/> {room.members.length} members</Button><Button variant="secondary" onClick={()=>navigate(`/server/${serverId}/settings/overview`)}>Channel settings</Button></div>{membersOpen&&<div className="voice-member-list">{room.members.map(m=><div className="member-row" key={m.id}><Avatar name={m.username} src={m.avatar} size="sm" presence={m.presence}/><span>{m.username}</span><small>{m.role_name||'Member'}</small></div>)}</div>}</div></div>;
 return <div className="chat-page">
  <div className="chat-heading"><div><h2><span>#</span>{channel.name}</h2><p>{channel.topic||room.server.description||'Conversation starts here.'}</p></div><div className="chat-head-actions"><button className={`icon-btn ${sharedOpen?'active':''}`} onClick={()=>void loadShared()} title="Shared media"><Images size={17}/></button><button className="icon-btn" onClick={()=>{setSharedOpen(false);setMembersOpen(v=>!v);}} title="Toggle members"><Users size={17}/></button><Link className="icon-btn" to={`/server/${serverId}/settings/overview`} title="Server settings"><MoreHorizontal size={18}/></Link></div></div>
  <div className="chat-main"><div className="chat-scroll"><MessageList messages={chat.messages} isDm={false} loading={chat.loading} hasOlder={chat.hasOlder} loadingOlder={chat.loadingOlder} onLoadOlder={()=>void chat.loadOlder()} currentUserId={user?.id} onReply={setReply} onEdit={m=>setEdit({...m})} onMore={setActionMessage} onReact={(m,e)=>void post(`/messages/${m.id}/reactions`,{emoji:e}).catch((x:any)=>toast.show(x.message,'error'))}/></div>
  {membersOpen&&<aside className="member-panel"><div className="section-label">MEMBERS · {room.members.length}</div>{room.members.map(m=><div className="member-row" key={m.id}><Avatar name={m.username} src={m.avatar} size="sm" presence={m.presence}/><span>{m.username}</span></div>)}</aside>}{sharedOpen&&<SharedMediaPanel items={sharedItems} loading={sharedLoading} onClose={()=>setSharedOpen(false)}/>}</div>
  {typing&&<div className="typing-note">{typing}</div>}
  <ChatComposer key={channel.id} conversationId={channel.id} isDm={false} socket={chat.socket} onSent={chat.add} reply={reply} clearReply={()=>setReply(null)}/>
  {edit&&<Modal title="Edit message" onClose={()=>setEdit(null)}><textarea className="modal-textarea" value={edit.content} onChange={e=>setEdit({...edit,content:e.target.value})}/><div className="modal-actions"><Button variant="secondary" onClick={()=>setEdit(null)}>Cancel</Button><Button onClick={()=>void sendEdit()}>Save</Button></div></Modal>}
  {actionMessage&&<MessageActions message={actionMessage} isDm={false} onClose={()=>setActionMessage(null)}/>}
 </div>;
}

type VoiceSignal = {type:'offer'|'answer';sdp:RTCSessionDescriptionInit}|{type:'candidate';candidate:RTCIceCandidateInit};
function VoiceJoin({channelId}:{channelId:string}){
 const [joined,setJoined]=useState(false);const [joining,setJoining]=useState(false);const [muted,setMuted]=useState(false);const [deafened,setDeafened]=useState(false);const [cameraOn,setCameraOn]=useState(false);const [sharingScreen,setSharingScreen]=useState(false);const [peers,setPeers]=useState<any[]>([]);const [remoteStreams,setRemoteStreams]=useState<Record<string,MediaStream>>({});const [localVideo,setLocalVideo]=useState<MediaStream|null>(null);const [preferredOutputDeviceId,setPreferredOutputDeviceId]=useState('');const toast=useToast();
 const socketRef=useRef<Socket|null>(null);const localStreamRef=useRef<MediaStream|null>(null);const selectedInputDeviceRef=useRef('');const cameraTrackRef=useRef<MediaStreamTrack|null>(null);const screenTrackRef=useRef<MediaStreamTrack|null>(null);const connectionsRef=useRef<Map<string,RTCPeerConnection>>(new Map());const pendingCandidatesRef=useRef<Map<string,RTCIceCandidateInit[]>>(new Map());const rotationReconnectTimerRef=useRef<number|undefined>(undefined);
 const emitSignal=(peerId:string,payload:VoiceSignal)=>socketRef.current?.emit('webrtc:signal',{toSocketId:peerId,payload,channelId});
 const createPeer=async(peerId:string,offerer:boolean):Promise<RTCPeerConnection>=>{
  const existing=connectionsRef.current.get(peerId);if(existing)return existing;
  const stream=localStreamRef.current;if(!stream)throw new Error('Microphone is not available.');
  const ice=await api<{iceServers:RTCIceServer[]}>('/voice/ice-servers').catch(()=>({iceServers:[{urls:'stun:stun.l.google.com:19302'}]}));const pc=new RTCPeerConnection({iceServers:ice.iceServers});connectionsRef.current.set(peerId,pc);
  stream.getAudioTracks().forEach(track=>pc.addTrack(track,stream));
  const activeVideo=screenTrackRef.current||cameraTrackRef.current;if(activeVideo)pc.addTrack(activeVideo,stream);
  pc.onicecandidate=event=>{if(event.candidate)emitSignal(peerId,{type:'candidate',candidate:event.candidate.toJSON()});};
  pc.ontrack=event=>{const remote=event.streams?.[0]||new MediaStream([event.track]);setRemoteStreams(current=>({...current,[peerId]:remote}));};
  pc.onconnectionstatechange=()=>{if(pc.connectionState==='failed'){toast.show('A voice connection failed. This network may require a TURN relay.','error');}};
  if(offerer){const offer=await pc.createOffer();await pc.setLocalDescription(offer);if(pc.localDescription)emitSignal(peerId,{type:'offer',sdp:pc.localDescription.toJSON()});}
  return pc;
 };
 const receiveSignal=async(data:any)=>{
  const peerId=String(data?.fromSocketId||'');const payload=data?.payload as VoiceSignal|undefined;if(!peerId||!payload)return;
  const pc=await createPeer(peerId,false);
  if(payload.type==='candidate'){
   if(pc.remoteDescription)await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
   else pendingCandidatesRef.current.set(peerId,[...(pendingCandidatesRef.current.get(peerId)||[]),payload.candidate]);
   return;
  }
  await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
  const queued=pendingCandidatesRef.current.get(peerId)||[];pendingCandidatesRef.current.delete(peerId);for(const candidate of queued)await pc.addIceCandidate(new RTCIceCandidate(candidate));
  if(payload.type==='offer'){const answer=await pc.createAnswer();await pc.setLocalDescription(answer);if(pc.localDescription)emitSignal(peerId,{type:'answer',sdp:pc.localDescription.toJSON()});}
 };
 const renegotiate=async(pc:RTCPeerConnection,peerId:string)=>{const offer=await pc.createOffer();await pc.setLocalDescription(offer);if(pc.localDescription)emitSignal(peerId,{type:'offer',sdp:pc.localDescription.toJSON()});};
 const updateVideoTrack=async(track:MediaStreamTrack|null)=>{const stream=localStreamRef.current;for(const [peerId,pc] of connectionsRef.current){const sender=pc.getSenders().find(item=>item.track?.kind==='video');if(sender){const previous=sender.track;if(track){if(stream&&!stream.getTracks().some(item=>item.id===track.id))stream.addTrack(track);await sender.replaceTrack(track);if(previous&&previous.id!==track.id)stream?.removeTrack(previous);}else{if(previous)stream?.removeTrack(previous);pc.removeTrack(sender);await renegotiate(pc,peerId);}}else if(track){if(stream&&!stream.getTracks().some(item=>item.id===track.id))stream.addTrack(track);pc.addTrack(track,stream||new MediaStream([track]));await renegotiate(pc,peerId);}}};
 const stopScreenShare=()=>{const track=screenTrackRef.current;if(!track)return;screenTrackRef.current=null;track.onended=null;track.stop();setSharingScreen(false);const restore=cameraTrackRef.current;setLocalVideo(restore?new MediaStream([restore]):null);void updateVideoTrack(restore);};
 const stopCamera=()=>{const track=cameraTrackRef.current;if(!track)return;cameraTrackRef.current=null;track.onended=null;track.stop();setCameraOn(false);if(!screenTrackRef.current){setLocalVideo(null);void updateVideoTrack(null);}};
 const startCamera=async()=>{try{if(!navigator.mediaDevices?.getUserMedia)throw new Error('Camera access requires HTTPS and a supported browser.');const stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:1280},height:{ideal:720},facingMode:'user'}});const track=stream.getVideoTracks()[0];if(!track)throw new Error('No camera was found.');cameraTrackRef.current=track;setLocalVideo(new MediaStream([track]));setCameraOn(true);if(!screenTrackRef.current)await updateVideoTrack(track);}catch(error:any){toast.show(error.name==='NotAllowedError'?'Camera permission was denied.':error.message||'Could not start the camera.','error');}};
 const startScreenShare=async()=>{try{if(!navigator.mediaDevices?.getDisplayMedia)throw new Error('Screen sharing is not supported by this browser.');const stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});const track=stream.getVideoTracks()[0];if(!track)throw new Error('No screen track was returned.');screenTrackRef.current=track;setLocalVideo(new MediaStream([track]));setSharingScreen(true);await updateVideoTrack(track);track.onended=()=>stopScreenShare();}catch(error:any){if(error.name!=='NotAllowedError')toast.show(error.message||'Could not start screen sharing.','error');}};
 const removePeer=(peerId:string)=>{const pc=connectionsRef.current.get(peerId);pc?.close();connectionsRef.current.delete(peerId);pendingCandidatesRef.current.delete(peerId);setRemoteStreams(current=>{const next={...current};delete next[peerId];return next;});setPeers(current=>current.filter(peer=>peer.socketId!==peerId));};
 const leave=()=>{
  if(rotationReconnectTimerRef.current)window.clearTimeout(rotationReconnectTimerRef.current);rotationReconnectTimerRef.current=undefined;
  socketRef.current?.emit('voice:leave',channelId);socketRef.current?.disconnect();socketRef.current=null;
  for(const pc of connectionsRef.current.values())pc.close();connectionsRef.current.clear();pendingCandidatesRef.current.clear();
  localStreamRef.current?.getTracks().forEach(track=>track.stop());localStreamRef.current=null;selectedInputDeviceRef.current='';
  if(screenTrackRef.current){screenTrackRef.current.onended=null;screenTrackRef.current.stop();screenTrackRef.current=null;}if(cameraTrackRef.current){cameraTrackRef.current.onended=null;cameraTrackRef.current.stop();cameraTrackRef.current=null;}
  setLocalVideo(null);setCameraOn(false);setSharingScreen(false);
  setRemoteStreams({});setPeers([]);setJoined(false);setMuted(false);setDeafened(false);
 };
 const join=async()=>{
  setJoining(true);
  try{
   if(!navigator.mediaDevices?.getUserMedia)throw new Error('Microphone access requires HTTPS or localhost and a supported browser.');
   const preferences=await api<any>('/settings').catch(()=>({settings:{}}));const inputDeviceId=String(preferences.settings?.voiceInputDeviceId||'');setPreferredOutputDeviceId(String(preferences.settings?.voiceOutputDeviceId||''));let stream:MediaStream;try{stream=await navigator.mediaDevices.getUserMedia({audio:{...(inputDeviceId?{deviceId:{exact:inputDeviceId}}:{}),echoCancellation:true,noiseSuppression:true,autoGainControl:true}});}catch(error:any){if(inputDeviceId&&['OverconstrainedError','NotFoundError'].includes(error.name)){toast.show('Your saved microphone was not found. Using the system default instead.','info');stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});}else throw error;}localStreamRef.current=stream;selectedInputDeviceRef.current=inputDeviceId;
   const live=io(apiOrigin,{withCredentials:true,transports:['websocket'],reconnection:true,reconnectionDelay:500,reconnectionDelayMax:5000});socketRef.current=live;let plannedRotation=false;
   live.on('relay:rotate',()=>{plannedRotation=true;});
   const restoreVoiceRoom=()=>{
    for(const connection of connectionsRef.current.values())connection.close();
    connectionsRef.current.clear();pendingCandidatesRef.current.clear();setRemoteStreams({});setPeers([]);
    live.emit('voice:join',{channelId},async(response:any)=>{
     if(!response?.ok){toast.show(response?.error||'You cannot join this voice channel.','error');leave();setJoining(false);return;}
     const participants=response.participants||[];setPeers(participants);setJoined(true);setJoining(false);
     for(const participant of participants){try{await createPeer(participant.socketId,true);}catch(error:any){toast.show(error.message||'Could not establish a voice connection.','error');}}
    });
   };
   live.on('connect',restoreVoiceRoom);
   live.on('disconnect',()=>{
    for(const connection of connectionsRef.current.values())connection.close();connectionsRef.current.clear();pendingCandidatesRef.current.clear();setRemoteStreams({});setPeers([]);setJoined(false);
    if(plannedRotation){plannedRotation=false;rotationReconnectTimerRef.current=window.setTimeout(()=>{if(socketRef.current===live)live.connect();},250);return;}
    live.io.reconnection(false);
    localStreamRef.current?.getTracks().forEach(track=>track.stop());localStreamRef.current=null;
   });
   live.on('voice:forced-leave',(event:any)=>{if(event?.channelId===channelId){toast.show(event.reason||'Your voice access has ended.','info');leave();}});
   live.on('voice:participant',(participant:any)=>{
    if(participant.state==='left'){removePeer(participant.socketId);return;}
    setPeers(current=>[...current.filter(peer=>peer.socketId!==participant.socketId),participant]);
    void createPeer(participant.socketId,false).catch((error:any)=>toast.show(error.message||'Could not connect to a participant.','error'));
   });
   live.on('webrtc:signal',(data:any)=>void receiveSignal(data).catch((error:any)=>toast.show(error.message||'Voice signaling failed.','error')));
   live.on('connect_error',()=>{toast.show('Voice connection failed. Check your server and network.','error');leave();setJoining(false);});
  }catch(error:any){localStreamRef.current?.getTracks().forEach(track=>track.stop());localStreamRef.current=null;toast.show(error.name==='NotAllowedError'?'Microphone permission was denied.':error.message||'Could not access the microphone.','error');setJoining(false);}
 };
 const setAudioState=(nextMuted:boolean,nextDeafened:boolean)=>{setMuted(nextMuted);setDeafened(nextDeafened);localStreamRef.current?.getAudioTracks().forEach(track=>{track.enabled=!nextMuted;});socketRef.current?.emit('voice:state',{channelId,muted:nextMuted,deafened:nextDeafened});};
 useEffect(()=>{localStreamRef.current?.getAudioTracks().forEach(track=>{track.enabled=!muted;});},[muted]);
 useEffect(()=>{
  const onSettings=(event:Event)=>{
   const prefs=(event as CustomEvent).detail||{};
   const nextOutput=String(prefs.voiceOutputDeviceId||'');
   setPreferredOutputDeviceId(nextOutput);
   const nextInput=String(prefs.voiceInputDeviceId||'');
   if(!joined||nextInput===selectedInputDeviceRef.current||!localStreamRef.current)return;
   void (async()=>{
    let nextStream:MediaStream|undefined;
    try{
     nextStream=await navigator.mediaDevices.getUserMedia({audio:{...(nextInput?{deviceId:{exact:nextInput}}:{}),echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
     const nextTrack=nextStream.getAudioTracks()[0];
     if(!nextTrack)throw new Error('The selected microphone returned no audio track.');
     const current=localStreamRef.current;
     if(!current||!joined){nextStream.getTracks().forEach(track=>track.stop());return;}
     const nextLocalStream=new MediaStream([...current.getVideoTracks(),nextTrack]);
     nextTrack.enabled=!muted;
     const oldAudio=current.getAudioTracks()[0];
     if(!oldAudio)throw new Error('The current microphone track is no longer available.');
     const audioSenders=Array.from(connectionsRef.current.values()).map(pc=>pc.getSenders().find(item=>item.track?.kind==='audio')).filter((sender):sender is RTCRtpSender=>!!sender);
     try{await Promise.all(audioSenders.map(sender=>sender.replaceTrack(nextTrack)));}
     catch(error){await Promise.allSettled(audioSenders.map(sender=>sender.replaceTrack(oldAudio)));throw error;}
     if(localStreamRef.current!==current||!joined){
      await Promise.allSettled(audioSenders.map(sender=>sender.replaceTrack(oldAudio)));
      nextStream.getTracks().forEach(track=>track.stop());
      return;
     }
     localStreamRef.current=nextLocalStream;
     selectedInputDeviceRef.current=nextInput;
     oldAudio.stop();
     nextStream.getVideoTracks().forEach(track=>track.stop());
     toast.show('Voice microphone updated.','success');
    }catch(error:any){
     nextStream?.getTracks().forEach(track=>track.stop());
     toast.show(error.name==='NotAllowedError'?'Microphone permission was denied.':error.message||'Could not switch microphones during this call.','error');
    }
   })();
  };
  window.addEventListener('relay:settings',onSettings);
  return()=>window.removeEventListener('relay:settings',onSettings);
 },[joined,muted,toast]);
 useEffect(()=>()=>{if(rotationReconnectTimerRef.current)window.clearTimeout(rotationReconnectTimerRef.current);socketRef.current?.disconnect();localStreamRef.current?.getTracks().forEach(track=>track.stop());if(screenTrackRef.current){screenTrackRef.current.onended=null;screenTrackRef.current.stop();}if(cameraTrackRef.current){cameraTrackRef.current.onended=null;cameraTrackRef.current.stop();}for(const pc of connectionsRef.current.values())pc.close();connectionsRef.current.clear();pendingCandidatesRef.current.clear();},[]);
 return <div className="voice-join">
  <Button onClick={()=>joined?leave():void join()} disabled={joining}>{joining?'Connecting…':joined?'Leave voice':'Join voice'}</Button>
  {joined&&<><Button variant="secondary" onClick={()=>setAudioState(!muted,deafened)}>{muted?<VolumeX size={15}/>:<Volume2 size={15}/>} {muted?'Unmute':'Mute'}</Button><Button variant="secondary" onClick={()=>setAudioState(muted,!deafened)}>{deafened?'Enable audio':'Deafen'}</Button><Button variant="secondary" onClick={()=>cameraOn?stopCamera():void startCamera()}><Camera size={15}/>{cameraOn?'Stop camera':'Camera'}</Button><Button variant="secondary" onClick={()=>sharingScreen?stopScreenShare():void startScreenShare()}><MonitorUp size={15}/>{sharingScreen?'Stop sharing':'Share screen'}</Button><p>{peers.length+1} participant(s) · live voice</p>{localVideo&&<div className="voice-local-preview"><span>Your preview</span><video autoPlay muted playsInline ref={element=>{if(element&&element.srcObject!==localVideo){element.srcObject=localVideo;void element.play().catch(()=>{});}}}/></div>}<div className="voice-video-grid" aria-label="Voice participants">{Object.entries(remoteStreams).map(([peerId,stream])=><div className="voice-video-tile" key={peerId}><video autoPlay playsInline muted={deafened} ref={element=>{if(element&&element.srcObject!==stream){element.srcObject=stream;void element.play().catch(()=>{});}if(element&&preferredOutputDeviceId&&'setSinkId' in element&&element.dataset.relaySink!==preferredOutputDeviceId){element.dataset.relaySink=preferredOutputDeviceId;const media=element as HTMLMediaElement&{setSinkId?:(id:string)=>Promise<void>};if(media.setSinkId)void media.setSinkId(preferredOutputDeviceId).catch(()=>toast.show('The selected speaker is no longer available.','error'));}}}/><span>{peers.find(peer=>peer.socketId===peerId)?.username||'Participant'}</span></div>)}</div></>}
 </div>;
}

export function DmPage(){
 const {conversationId}=useParams();const {user}=useAuth();const toast=useToast();const navigate=useNavigate();const [conversations,setConversations]=useState<any[]>([]);const [reply,setReply]=useState<ChatMessage|null>(null);const [edit,setEdit]=useState<ChatMessage|null>(null);const [actionMessage,setActionMessage]=useState<ChatMessage|null>(null);const [membersOpen,setMembersOpen]=useState(false);const [sharedOpen,setSharedOpen]=useState(false);const [sharedItems,setSharedItems]=useState<any[]>([]);const [sharedLoading,setSharedLoading]=useState(false);const [messageSearchOpen,setMessageSearchOpen]=useState(false);const [messageSearch,setMessageSearch]=useState('');
 useEffect(()=>{
  let active=true;
  const refresh=async()=>{
   try{
    const r=await api<any>('/dms');
    if(!active)return;
    const next=r.conversations||[];
    setConversations(next);
    if(conversationId&&!next.some((conversation:any)=>conversation.id===conversationId)){
     navigate('/channels/@me',{replace:true});
     toast.show('You no longer have access to that conversation.','info');
    }
   }catch(e:any){if(active)toast.show(e.message,'error');}
  };
  void refresh();
  const timer=window.setInterval(()=>void refresh(),15000);
  return()=>{active=false;window.clearInterval(timer);};
 },[conversationId,navigate,toast]);
 const dm=conversations.find(d=>d.id===conversationId);const others=dm?.members?.filter((m:any)=>m.id!==user?.id)||[];const title=dm?.name||others.map((m:any)=>m.username).join(', ')||'Direct messages';const chat=useRoomMessages(conversationId,true);
 const loadShared=async()=>{if(!conversationId)return;setSharedOpen(true);setMembersOpen(false);setSharedLoading(true);try{const result=await api<any>(`/dms/${conversationId}/attachments`);setSharedItems(result.attachments||[]);}catch(error:any){toast.show(error.message,'error');}finally{setSharedLoading(false);}};
 const [searchMatches,setSearchMatches]=useState<ChatMessage[]|null>(null);const [searchBusy,setSearchBusy]=useState(false);const searchGeneration=useRef(0);
 useEffect(()=>{const query=messageSearch.trim();const generation=++searchGeneration.current;if(!messageSearchOpen||query.length<2||!conversationId){setSearchMatches(null);setSearchBusy(false);return;}setSearchMatches(null);setSearchBusy(true);const timer=window.setTimeout(()=>api<{messages:ChatMessage[]}>(`/dms/${conversationId}/messages/search?q=${encodeURIComponent(query)}`).then(result=>{if(generation===searchGeneration.current)setSearchMatches(result.messages||[]);}).catch(error=>{if(generation===searchGeneration.current){setSearchMatches([]);toast.show(error.message,'error');}}).finally(()=>{if(generation===searchGeneration.current)setSearchBusy(false);}),250);return()=>window.clearTimeout(timer);},[conversationId,messageSearch,messageSearchOpen]);
 useEffect(()=>{const toggle=()=>setMembersOpen(value=>!value);window.addEventListener('relay:toggle-members',toggle);return()=>window.removeEventListener('relay:toggle-members',toggle);},[]);
 const sendEdit=async()=>{if(!edit)return;try{const r=await patch<{message:ChatMessage}>(`/messages/${edit.id}`,{content:edit.content});chat.setMessages(v=>v.map(m=>m.id===r.message.id?r.message:m));setEdit(null);}catch(e:any){toast.show(e.message,'error');}};
 if(!conversationId)return <div className="dm-empty-stage"><div className="dm-empty-illustration"><MessageCircle size={34}/><span>R</span></div><p className="dm-empty-eyebrow">RELAY MESSAGES</p><h2>Your conversations, all together.</h2><p className="dm-empty-copy">Pick a chat from the list, message a friend, or bring your group into one place.</p><Link className="btn primary" to="/friends"><MessageSquarePlus size={16}/> Start a conversation</Link></div>;
 const query=messageSearch.trim();const visibleMessages=query.length>=2?(searchMatches||[]):query?chat.messages.filter(message=>message.content.toLowerCase().includes(query.toLowerCase())):chat.messages;
 return <div className="chat-page dm-chat-page"><div className="chat-heading dm-chat-heading"><div className="dm-title-line">{others.length===1?<Avatar name={others[0].username} src={others[0].avatar} size="lg" presence={others[0].presence}/>:<span className="dm-group-avatar"><UsersRound size={21}/></span>}<div className="dm-heading-copy"><h2>{title}</h2><p>{dm?.is_group?'Group · '+(dm?.members?.length||0)+' members':others[0]?.status_text||others[0]?.presence||'Direct message'}</p></div></div><div className="chat-head-actions"><button className={`icon-btn ${messageSearchOpen?'active':''}`} onClick={()=>{setMessageSearchOpen(v=>!v);setMessageSearch('');}} title="Search this chat"><Search size={18}/></button><button className={`icon-btn ${sharedOpen?'active':''}`} onClick={()=>void loadShared()} title="Shared media"><Images size={18}/></button><button className={`icon-btn ${membersOpen?'active':''}`} onClick={()=>{setSharedOpen(false);setMembersOpen(v=>!v);}} title="Conversation members"><Users size={18}/></button></div></div>
 {messageSearchOpen&&<div className="dm-search-inline"><Search size={15}/><input autoFocus value={messageSearch} onChange={e=>setMessageSearch(e.target.value)} placeholder="Search messages in this chat"/><span>{visibleMessages.length} matches</span><button onClick={()=>{setMessageSearchOpen(false);setMessageSearch('');}} aria-label="Close search"><X size={15}/></button></div>}
 <div className="chat-main"><div className="chat-scroll dm-scroll"><MessageList messages={visibleMessages} isDm={true} loading={chat.loading||searchBusy} hasOlder={!messageSearch&&chat.hasOlder} loadingOlder={chat.loadingOlder} onLoadOlder={()=>void chat.loadOlder()} currentUserId={user?.id} onReply={setReply} onEdit={m=>setEdit({...m})} onMore={setActionMessage} onReact={(m,e)=>void post(`/messages/${m.id}/reactions`,{emoji:e}).catch((x:any)=>toast.show(x.message,'error'))}/></div>{membersOpen&&<aside className="member-panel"><div className="section-label">IN THIS CHAT · {dm?.members?.length||0}</div>{dm?.members?.map((m:any)=><div className="member-row" key={m.id}><Avatar name={m.username} src={m.avatar} size="sm" presence={m.presence}/><span>{m.username}</span></div>)}</aside>}{sharedOpen&&<SharedMediaPanel items={sharedItems} loading={sharedLoading} onClose={()=>setSharedOpen(false)}/>}</div>
 {chat.typing&&<div className="typing-note">{chat.typing}</div>}
 <ChatComposer key={conversationId} conversationId={conversationId} isDm socket={chat.socket} onSent={chat.add} reply={reply} clearReply={()=>setReply(null)}/>
 {edit&&<Modal title="Edit message" onClose={()=>setEdit(null)}><textarea className="modal-textarea" value={edit.content} onChange={e=>setEdit({...edit,content:e.target.value})}/><div className="modal-actions"><Button variant="secondary" onClick={()=>setEdit(null)}>Cancel</Button><Button onClick={()=>void sendEdit()}>Save</Button></div></Modal>}
 {actionMessage&&<MessageActions message={actionMessage} isDm onClose={()=>setActionMessage(null)}/>}
 </div>;
}
