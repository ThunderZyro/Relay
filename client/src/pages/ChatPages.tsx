import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import { ArrowLeft, Bell, Check, FilePlus2, Hash, MessageCircle, MoreHorizontal, Paperclip, Pin, Reply, Send, Smile, Users, Volume2, VolumeX, Edit3, X, Search, MessageSquarePlus, UsersRound } from 'lucide-react';
import { api, apiOrigin, post, patch, del } from '../api';
import { useAuth, useToast } from '../state';
import { Avatar, Button, EmptyState, Loading, Modal } from '../components/ui';

type ChatMessage = { id:string; sender_id:string; username:string; avatar?:string|null; content:string; created_at:string; edited_at?:string|null; reply_to?:string|null; pinned?:number; reactions?:{emoji:string;user_id:string}[]; attachments?:{id:string;filename:string;mime:string;size:number}[]; channel_id?:string|null; dm_id?:string|null };

function compareMessages(a: ChatMessage, b: ChatMessage) {
 const timeDifference = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
 return timeDifference || a.id.localeCompare(b.id);
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Set([
 'image/png','image/jpeg','image/gif','image/webp','application/pdf','text/plain',
 'application/zip','audio/mpeg','audio/ogg','video/mp4'
]);
const BLOCKED_ATTACHMENT_EXTENSIONS = new Set(['.exe','.bat','.cmd','.js','.html','.svg','.sh','.ps1']);
type RoomServer = { server:{id:string;name:string;description?:string}; channels:any[]; members:any[]; categories:any[] };

function MessageList({ messages, loading=false, hasOlder=false, loadingOlder=false, onLoadOlder, currentUserId, onReply, onEdit, onMore, onReact }: {
 messages:ChatMessage[]; loading?:boolean; hasOlder?:boolean; loadingOlder?:boolean; onLoadOlder?:()=>void; currentUserId?:string; onReply:(m:ChatMessage)=>void; onEdit:(m:ChatMessage)=>void; onMore:(m:ChatMessage)=>void; onReact:(m:ChatMessage,emoji:string)=>void;
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
    <p className="message-content">{m.content}</p><time className="message-time">{new Date(m.created_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time>
    {m.attachments?.map(a=><a className="attachment" key={a.id} href={`${apiOrigin}/api/uploads/${a.id}`} target="_blank" rel="noreferrer"><FilePlus2 size={18}/><span>{a.filename}<small>{Math.ceil(a.size/1024)} KB</small></span></a>)}
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

function ChatComposer({ conversationId, isDm, socket, onSent, reply, clearReply }: { conversationId:string; isDm:boolean; socket:Socket|null; onSent:(m:ChatMessage)=>void; reply:ChatMessage|null; clearReply:()=>void }) {
 const [content,setContent]=useState('');const [busy,setBusy]=useState(false);const [files,setFiles]=useState<File[]>([]);const fileRef=useRef<HTMLInputElement>(null);const textareaRef=useRef<HTMLTextAreaElement>(null);const toast=useToast();const typingTarget=isDm?{dmId:conversationId}:{channelId:conversationId};
 const send=async(e?:React.FormEvent)=>{e?.preventDefault();socket?.emit('typing:stop',typingTarget);if((!content.trim()&&!files.length)||busy)return;setBusy(true);try{
  let uploadIds:string[]=[];
  if(files.length){const form=new FormData();files.forEach(f=>form.append('files',f));const uploaded=await post<{uploads:{id:string}[]}>('/uploads',form);uploadIds=uploaded.uploads.map(u=>u.id);}
  const route=isDm?`/dms/${conversationId}/messages`:`/channels/${conversationId}/messages`;
  const result=await post<{message:ChatMessage}>(route,{content:content.trim(),reply_to:reply?.id,uploadIds});onSent(result.message);setContent('');if(textareaRef.current)textareaRef.current.style.height='auto';setFiles([]);clearReply();
 }catch(err:any){toast.show(err.message,'error');}finally{setBusy(false);}};
 return <div className="composer-wrap">
  {reply&&<div className="reply-banner"><Reply size={13}/> Replying to {reply.username}: {reply.content.slice(0,90)}<button onClick={clearReply} aria-label="Cancel reply"><X size={13}/></button></div>}
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
   <textarea ref={textareaRef} rows={1} value={content} onChange={e=>{setContent(e.target.value);e.currentTarget.style.height='auto';e.currentTarget.style.height=`${Math.min(e.currentTarget.scrollHeight,144)}px`;socket?.emit(e.target.value.trim()?'typing:start':'typing:stop',typingTarget);}} onBlur={()=>socket?.emit('typing:stop',typingTarget)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void send();}}} placeholder="Write a message…" maxLength={4000}/>
   <button className="composer-send" type="submit" disabled={busy||(!content.trim()&&!files.length)} title="Send"><Send size={16}/></button>
  </form><div className="composer-foot"><span>Enter to send · Shift+Enter for a new line</span><span>{content.length}/4000</span></div>
 </div>;
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
  live.on('message:new',(message:ChatMessage)=>{
   if(!isCurrentRoom())return;
   setMessages(current=>current.some(item=>item.id===message.id)?current:[...current,message].sort(compareMessages));
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
 const toast=useToast();const {user}=useAuth();
 return <Modal title="Message actions" onClose={onClose}><div className="form-stack">
  <Button variant="secondary" onClick={async()=>{try{await post(`/messages/${message.id}/reactions`,{emoji:'👍'});toast.show('Reaction added.','success');onClose();}catch(e:any){toast.show(e.message,'error');}}}>Add 👍 reaction</Button>
  {!isDm&&<Button variant="secondary" onClick={async()=>{try{const r=await post<{pinned:boolean}>(`/messages/${message.id}/pin`);toast.show(r.pinned?'Message pinned.':'Message unpinned.','success');onClose();}catch(e:any){toast.show(e.message,'error');}}}>Pin or unpin</Button>}
  {!isDm&&<Button variant="secondary" onClick={async()=>{const reason=window.prompt('Why are you reporting this message?');if(!reason)return;try{await post(`/messages/${message.id}/report`,{reason});toast.show('Report submitted.','success');onClose();}catch(e:any){toast.show(e.message,'error');}}}>Report message</Button>}
  {message.sender_id===user?.id&&<Button variant="danger" onClick={async()=>{if(!window.confirm('Delete this message?'))return;try{await del(`/messages/${message.id}`);toast.show('Message deleted.','success');onClose();}catch(e:any){toast.show(e.message,'error');}}}>Delete message</Button>}
 </div></Modal>;
}

export function ChannelPage(){
 const {serverId,channelId}=useParams();const navigate=useNavigate();const {user}=useAuth();const toast=useToast();const [room,setRoom]=useState<RoomServer|null>(null);const [selected,setSelected]=useState<string|undefined>(channelId);const [reply,setReply]=useState<ChatMessage|null>(null);const [edit,setEdit]=useState<ChatMessage|null>(null);const [actionMessage,setActionMessage]=useState<ChatMessage|null>(null);const [membersOpen,setMembersOpen]=useState(false);
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
 const typing=chat.typing;
 useEffect(()=>{const toggle=()=>setMembersOpen(value=>!value);window.addEventListener('relay:toggle-members',toggle);return()=>window.removeEventListener('relay:toggle-members',toggle);},[]);
 const sendEdit=async()=>{if(!edit)return;try{const r=await patch<{message:ChatMessage}>(`/messages/${edit.id}`,{content:edit.content});chat.setMessages(v=>v.map(m=>m.id===r.message.id?r.message:m));setEdit(null);}catch(e:any){toast.show(e.message,'error');}};
 if(!serverId)return <Loading/>;if(!room)return <Loading label="Loading server"/>;
 if(!channel)return <div className="page-content"><EmptyState title="No channel selected" description="Create a channel in server settings or choose another server." action={<Link to={`/server/${serverId}/settings/overview`}>Server settings</Link>}/></div>;
 if(channel.type==='voice')return <div className="page-content voice-page"><div className="voice-card"><Volume2 size={32}/><h1>{channel.name}</h1><p>Voice uses peer-to-peer audio, with optional TURN relay support when configured by the server.</p><VoiceJoin channelId={channel.id}/><div className="voice-controls"><Button variant="secondary" onClick={()=>setMembersOpen(v=>!v)}><Users size={15}/> {room.members.length} members</Button><Button variant="secondary" onClick={()=>navigate(`/server/${serverId}/settings/overview`)}>Channel settings</Button></div>{membersOpen&&<div className="voice-member-list">{room.members.map(m=><div className="member-row" key={m.id}><Avatar name={m.username} src={m.avatar} size="sm" presence={m.presence}/><span>{m.username}</span><small>{m.role_name||'Member'}</small></div>)}</div>}</div></div>;
 return <div className="chat-page">
  <div className="chat-heading"><div><h2><span>#</span>{channel.name}</h2><p>{channel.topic||room.server.description||'Conversation starts here.'}</p></div><div className="chat-head-actions"><button className="icon-btn" onClick={()=>setMembersOpen(v=>!v)} title="Toggle members"><Users size={17}/></button><Link className="icon-btn" to={`/server/${serverId}/settings/overview`} title="Server settings"><MoreHorizontal size={18}/></Link></div></div>
  <div className="chat-main"><div className="chat-scroll"><MessageList messages={chat.messages} loading={chat.loading} hasOlder={chat.hasOlder} loadingOlder={chat.loadingOlder} onLoadOlder={()=>void chat.loadOlder()} currentUserId={user?.id} onReply={setReply} onEdit={m=>setEdit({...m})} onMore={setActionMessage} onReact={(m,e)=>void post(`/messages/${m.id}/reactions`,{emoji:e}).catch((x:any)=>toast.show(x.message,'error'))}/></div>
  {membersOpen&&<aside className="member-panel"><div className="section-label">MEMBERS · {room.members.length}</div>{room.members.map(m=><div className="member-row" key={m.id}><Avatar name={m.username} src={m.avatar} size="sm" presence={m.presence}/><span>{m.username}</span></div>)}</aside>}</div>
  {typing&&<div className="typing-note">{typing}</div>}
  <ChatComposer conversationId={channel.id} isDm={false} socket={chat.socket} onSent={chat.add} reply={reply} clearReply={()=>setReply(null)}/>
  {edit&&<Modal title="Edit message" onClose={()=>setEdit(null)}><textarea className="modal-textarea" value={edit.content} onChange={e=>setEdit({...edit,content:e.target.value})}/><div className="modal-actions"><Button variant="secondary" onClick={()=>setEdit(null)}>Cancel</Button><Button onClick={()=>void sendEdit()}>Save</Button></div></Modal>}
  {actionMessage&&<MessageActions message={actionMessage} isDm={false} onClose={()=>setActionMessage(null)}/>}
 </div>;
}

type VoiceSignal = {type:'offer'|'answer';sdp:RTCSessionDescriptionInit}|{type:'candidate';candidate:RTCIceCandidateInit};
function VoiceJoin({channelId}:{channelId:string}){
 const [joined,setJoined]=useState(false);const [joining,setJoining]=useState(false);const [muted,setMuted]=useState(false);const [deafened,setDeafened]=useState(false);const [peers,setPeers]=useState<any[]>([]);const [remoteStreams,setRemoteStreams]=useState<Record<string,MediaStream>>({});const toast=useToast();
 const socketRef=useRef<Socket|null>(null);const localStreamRef=useRef<MediaStream|null>(null);const connectionsRef=useRef<Map<string,RTCPeerConnection>>(new Map());const pendingCandidatesRef=useRef<Map<string,RTCIceCandidateInit[]>>(new Map());const rotationReconnectTimerRef=useRef<number|undefined>(undefined);
 const emitSignal=(peerId:string,payload:VoiceSignal)=>socketRef.current?.emit('webrtc:signal',{toSocketId:peerId,payload,channelId});
 const createPeer=async(peerId:string,offerer:boolean):Promise<RTCPeerConnection>=>{
  const existing=connectionsRef.current.get(peerId);if(existing)return existing;
  const stream=localStreamRef.current;if(!stream)throw new Error('Microphone is not available.');
  const ice=await api<{iceServers:RTCIceServer[]}>('/voice/ice-servers').catch(()=>({iceServers:[{urls:'stun:stun.l.google.com:19302'}]}));const pc=new RTCPeerConnection({iceServers:ice.iceServers});connectionsRef.current.set(peerId,pc);
  stream.getTracks().forEach(track=>pc.addTrack(track,stream));
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
 const removePeer=(peerId:string)=>{const pc=connectionsRef.current.get(peerId);pc?.close();connectionsRef.current.delete(peerId);pendingCandidatesRef.current.delete(peerId);setRemoteStreams(current=>{const next={...current};delete next[peerId];return next;});setPeers(current=>current.filter(peer=>peer.socketId!==peerId));};
 const leave=()=>{
  if(rotationReconnectTimerRef.current)window.clearTimeout(rotationReconnectTimerRef.current);rotationReconnectTimerRef.current=undefined;
  socketRef.current?.emit('voice:leave',channelId);socketRef.current?.disconnect();socketRef.current=null;
  for(const pc of connectionsRef.current.values())pc.close();connectionsRef.current.clear();pendingCandidatesRef.current.clear();
  localStreamRef.current?.getTracks().forEach(track=>track.stop());localStreamRef.current=null;
  setRemoteStreams({});setPeers([]);setJoined(false);setMuted(false);setDeafened(false);
 };
 const join=async()=>{
  setJoining(true);
  try{
   if(!navigator.mediaDevices?.getUserMedia)throw new Error('Microphone access requires HTTPS or localhost and a supported browser.');
   const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});localStreamRef.current=stream;
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
 useEffect(()=>()=>{if(rotationReconnectTimerRef.current)window.clearTimeout(rotationReconnectTimerRef.current);socketRef.current?.disconnect();localStreamRef.current?.getTracks().forEach(track=>track.stop());for(const pc of connectionsRef.current.values())pc.close();connectionsRef.current.clear();},[]);
 return <div className="voice-join">
  <Button onClick={()=>joined?leave():void join()} disabled={joining}>{joining?'Connecting…':joined?'Leave voice':'Join voice'}</Button>
  {joined&&<><Button variant="secondary" onClick={()=>setAudioState(!muted,deafened)}>{muted?<VolumeX size={15}/>:<Volume2 size={15}/>} {muted?'Unmute':'Mute'}</Button><Button variant="secondary" onClick={()=>setAudioState(muted,!deafened)}>{deafened?'Enable audio':'Deafen'}</Button><p>{peers.length+1} participant(s) · peer-to-peer audio</p><div className="voice-audio" aria-label="Remote participant audio">{Object.entries(remoteStreams).map(([peerId,stream])=><audio key={peerId} autoPlay playsInline muted={deafened} ref={element=>{if(element&&element.srcObject!==stream){element.srcObject=stream;void element.play().catch(()=>{});}}}/>)}</div></>}
 </div>;
}

export function DmPage(){
 const {conversationId}=useParams();const {user}=useAuth();const toast=useToast();const navigate=useNavigate();const [conversations,setConversations]=useState<any[]>([]);const [reply,setReply]=useState<ChatMessage|null>(null);const [edit,setEdit]=useState<ChatMessage|null>(null);const [actionMessage,setActionMessage]=useState<ChatMessage|null>(null);const [membersOpen,setMembersOpen]=useState(false);const [messageSearchOpen,setMessageSearchOpen]=useState(false);const [messageSearch,setMessageSearch]=useState('');
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
 const [searchMatches,setSearchMatches]=useState<ChatMessage[]|null>(null);const [searchBusy,setSearchBusy]=useState(false);const searchGeneration=useRef(0);
 useEffect(()=>{const query=messageSearch.trim();const generation=++searchGeneration.current;if(!messageSearchOpen||query.length<2||!conversationId){setSearchMatches(null);setSearchBusy(false);return;}setSearchMatches(null);setSearchBusy(true);const timer=window.setTimeout(()=>api<{messages:ChatMessage[]}>(`/dms/${conversationId}/messages/search?q=${encodeURIComponent(query)}`).then(result=>{if(generation===searchGeneration.current)setSearchMatches(result.messages||[]);}).catch(error=>{if(generation===searchGeneration.current){setSearchMatches([]);toast.show(error.message,'error');}}).finally(()=>{if(generation===searchGeneration.current)setSearchBusy(false);}),250);return()=>window.clearTimeout(timer);},[conversationId,messageSearch,messageSearchOpen]);
 useEffect(()=>{const toggle=()=>setMembersOpen(value=>!value);window.addEventListener('relay:toggle-members',toggle);return()=>window.removeEventListener('relay:toggle-members',toggle);},[]);
 const sendEdit=async()=>{if(!edit)return;try{const r=await patch<{message:ChatMessage}>(`/messages/${edit.id}`,{content:edit.content});chat.setMessages(v=>v.map(m=>m.id===r.message.id?r.message:m));setEdit(null);}catch(e:any){toast.show(e.message,'error');}};
 if(!conversationId)return <div className="dm-empty-stage"><div className="dm-empty-illustration"><MessageCircle size={34}/><span>R</span></div><p className="dm-empty-eyebrow">RELAY MESSAGES</p><h2>Your conversations, all together.</h2><p className="dm-empty-copy">Pick a chat from the list, message a friend, or bring your group into one place.</p><Link className="btn primary" to="/friends"><MessageSquarePlus size={16}/> Start a conversation</Link></div>;
 const query=messageSearch.trim();const visibleMessages=query.length>=2?(searchMatches||[]):query?chat.messages.filter(message=>message.content.toLowerCase().includes(query.toLowerCase())):chat.messages;
 return <div className="chat-page dm-chat-page"><div className="chat-heading dm-chat-heading"><div className="dm-title-line">{others.length===1?<Avatar name={others[0].username} src={others[0].avatar} size="lg" presence={others[0].presence}/>:<span className="dm-group-avatar"><UsersRound size={21}/></span>}<div className="dm-heading-copy"><h2>{title}</h2><p>{dm?.is_group?'Group · '+(dm?.members?.length||0)+' members':others[0]?.status_text||others[0]?.presence||'Direct message'}</p></div></div><div className="chat-head-actions"><button className={`icon-btn ${messageSearchOpen?'active':''}`} onClick={()=>{setMessageSearchOpen(v=>!v);setMessageSearch('');}} title="Search this chat"><Search size={18}/></button><button className={`icon-btn ${membersOpen?'active':''}`} onClick={()=>setMembersOpen(v=>!v)} title="Conversation members"><Users size={18}/></button></div></div>
 {messageSearchOpen&&<div className="dm-search-inline"><Search size={15}/><input autoFocus value={messageSearch} onChange={e=>setMessageSearch(e.target.value)} placeholder="Search messages in this chat"/><span>{visibleMessages.length} matches</span><button onClick={()=>{setMessageSearchOpen(false);setMessageSearch('');}} aria-label="Close search"><X size={15}/></button></div>}
 <div className="chat-main"><div className="chat-scroll dm-scroll"><MessageList messages={visibleMessages} loading={chat.loading||searchBusy} hasOlder={!messageSearch&&chat.hasOlder} loadingOlder={chat.loadingOlder} onLoadOlder={()=>void chat.loadOlder()} currentUserId={user?.id} onReply={setReply} onEdit={m=>setEdit({...m})} onMore={setActionMessage} onReact={(m,e)=>void post(`/messages/${m.id}/reactions`,{emoji:e}).catch((x:any)=>toast.show(x.message,'error'))}/></div>{membersOpen&&<aside className="member-panel"><div className="section-label">IN THIS CHAT · {dm?.members?.length||0}</div>{dm?.members?.map((m:any)=><div className="member-row" key={m.id}><Avatar name={m.username} src={m.avatar} size="sm" presence={m.presence}/><span>{m.username}</span></div>)}</aside>}</div>
 {chat.typing&&<div className="typing-note">{chat.typing}</div>}
 <ChatComposer conversationId={conversationId} isDm socket={chat.socket} onSent={chat.add} reply={reply} clearReply={()=>setReply(null)}/>
 {edit&&<Modal title="Edit message" onClose={()=>setEdit(null)}><textarea className="modal-textarea" value={edit.content} onChange={e=>setEdit({...edit,content:e.target.value})}/><div className="modal-actions"><Button variant="secondary" onClick={()=>setEdit(null)}>Cancel</Button><Button onClick={()=>void sendEdit()}>Save</Button></div></Modal>}
 {actionMessage&&<MessageActions message={actionMessage} isDm onClose={()=>setActionMessage(null)}/>}
 </div>;
}
