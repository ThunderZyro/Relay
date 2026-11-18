import React,{useEffect,useMemo,useState} from 'react';
import {Link,Outlet,useLocation,useNavigate} from 'react-router-dom';
import {io} from 'socket.io-client';
import {Activity, Bell, CalendarDays, Compass, Download, Headphones, HelpCircle, Home, Library, LogOut, Menu, MessageCircle, Plus, Search, Settings, Shield, Users, X, CircleDot, Hash, Volume2, Megaphone, UsersRound, MessageSquarePlus, ChevronDown} from 'lucide-react';
import {api,apiOrigin,post,del} from '../api';
import {useAuth,useToast,announceAuthChange} from '../state';
import {Avatar,Button,Field,Modal,SearchInput} from './ui';
import {hasRelayInstallPrompt,promptRelayInstall} from '../pwa';
import {applyRelayAppearance} from '../theme';

type Server={id:string;name:string;description:string;icon?:string|null;role_name?:string};
type Dm={id:string;name?:string|null;members:{id:string;username:string;avatar?:string;presence:string}[];last_message?:string;is_group?:boolean;unread_count?:number};
export default function Shell(){
 const {user,setUser}=useAuth();const toast=useToast();const navigate=useNavigate();const location=useLocation();
 const [servers,setServers]=useState<Server[]>([]);const [dms,setDms]=useState<Dm[]>([]);const [notifications,setNotifications]=useState<any[]>([]);const [searchOpen,setSearchOpen]=useState(false);const [search,setSearch]=useState('');const [searchResults,setSearchResults]=useState<any>(null);const [notifyOpen,setNotifyOpen]=useState(false);const [createOpen,setCreateOpen]=useState(false);const [serverName,setServerName]=useState('');const [serverDescription,setServerDescription]=useState('');const [mobileNav,setMobileNav]=useState(false);const [dmQuery,setDmQuery]=useState('');const [dmScope,setDmScope]=useState<'all'|'groups'|'online'>('all');const [keybinds,setKeybinds]=useState({focusSearch:'Ctrl+K',toggleMembers:'Ctrl+Shift+M'});const [installAvailable,setInstallAvailable]=useState(hasRelayInstallPrompt());
 const serverMatch=location.pathname.match(/^\/channels\/([^/]+)(?:\/([^/]+))?/);const activeServer=serverMatch&&serverMatch[1]!=='@me'?serverMatch[1]:null;
 const [serverInfo,setServerInfo]=useState<any>(null);
 const load=async(showErrors=true)=>{try{const [s,d,n]=await Promise.all([api<{servers:Server[]}>('/servers'),api<{conversations:Dm[]}>('/dms'),api<{notifications:any[]}>('/notifications')]);setServers(s.servers);setDms(d.conversations);setNotifications(n.notifications);}catch(e:any){if(showErrors)toast.show(e.message,'error');}};
 useEffect(()=>{void load();const refreshWhenActive=()=>{if(document.visibilityState==='visible')void load(false);};const timer=window.setInterval(()=>void load(false),15000);window.addEventListener('focus',refreshWhenActive);document.addEventListener('visibilitychange',refreshWhenActive);return()=>{window.clearInterval(timer);window.removeEventListener('focus',refreshWhenActive);document.removeEventListener('visibilitychange',refreshWhenActive);};},[location.pathname]);
 useEffect(()=>{let active=true;if(!activeServer){setServerInfo(null);return()=>{active=false;};}setServerInfo(null);api(`/servers/${activeServer}`).then(r=>{if(active)setServerInfo(r);}).catch(()=>{if(active)setServerInfo(null);});return()=>{active=false;};},[activeServer]);
 useEffect(()=>{const socket=io(apiOrigin,{withCredentials:true,transports:['websocket'],reconnection:true,reconnectionDelay:500,reconnectionDelayMax:5000});let plannedRotation=false;let reconnectTimer:number|undefined;socket.on('relay:rotate',()=>{plannedRotation=true;});socket.on('disconnect',()=>{if(plannedRotation){plannedRotation=false;reconnectTimer=window.setTimeout(()=>socket.connect(),250);}});socket.on('connect',()=>{void load();});socket.on('friends:updated',()=>window.dispatchEvent(new Event('relay:friends-refresh')));socket.on('notification:new',async(n:any)=>{setNotifications(v=>[n,...v.filter(x=>x.id!==n.id)]);void load(false);try{const r=await api<any>('/settings');const prefs=r.settings||{};const kind=String(n.type||n.kind||n.category||'').toLowerCase();const isMention=kind==='mention'||n.mention===true;const isDirect=kind==='dm'||!!n.dm_id;const allowed=!prefs.quietMode&&(!isDirect||prefs.dmNotifications!==false)&&(!isMention||prefs.mentionNotifications!==false);if(!allowed)return;window.dispatchEvent(new CustomEvent('relay:notification-new',{detail:n}));if(prefs.browserNotifications&&typeof Notification!=='undefined'&&Notification.permission==='granted')new Notification(n.title,{body:n.body});}catch{}});return()=>{if(reconnectTimer)window.clearTimeout(reconnectTimer);socket.disconnect();};},[]);
 useEffect(()=>{const syncInstall=()=>setInstallAvailable(hasRelayInstallPrompt());window.addEventListener('relay:install-available',syncInstall);return()=>window.removeEventListener('relay:install-available',syncInstall);},[]);
 useEffect(()=>{const beat=()=>post('/presence/heartbeat',{}).catch(()=>{});beat();const timer=window.setInterval(beat,45000);return()=>window.clearInterval(timer);},[]);
 useEffect(()=>{let active=true;const refreshAppearance=()=>api<any>('/settings').then(r=>{if(!active)return;applyRelayAppearance(r.settings,!!r.boost?.active);setKeybinds(v=>({...v,...r.settings?.keybinds}));}).catch(()=>{});void refreshAppearance();const timer=window.setInterval(()=>void refreshAppearance(),60000);const onFocus=()=>{if(document.visibilityState==='visible')void refreshAppearance();};window.addEventListener('focus',onFocus);const settingsChanged=(event:Event)=>{const detail=(event as CustomEvent).detail;if(!detail)return;const {boostActive,...settings}=detail;applyRelayAppearance(settings,!!boostActive);if(settings.keybinds)setKeybinds(v=>({...v,...settings.keybinds}));};window.addEventListener('relay:settings',settingsChanged);return()=>{active=false;window.clearInterval(timer);window.removeEventListener('focus',onFocus);window.removeEventListener('relay:settings',settingsChanged);};},[]);
 useEffect(()=>{
  const matches=(e:KeyboardEvent,bind:string)=>{
   const parts=bind.toLowerCase().split('+').map(x=>x.trim()).filter(Boolean);
   if(parts.length<2)return false;
   const key=parts[parts.length-1];
   const modifiers=parts.slice(0,-1);
   const wantsCtrl=modifiers.includes('ctrl')||modifiers.includes('control');
   const wantsMeta=modifiers.includes('meta')||modifiers.includes('cmd')||modifiers.includes('command');
   const wantsShift=modifiers.includes('shift');
   const wantsAlt=modifiers.includes('alt');
   const controlMatches=wantsCtrl&&!wantsMeta?(e.ctrlKey||e.metaKey):e.ctrlKey===wantsCtrl;
   const metaMatches=wantsCtrl&&!wantsMeta?true:e.metaKey===wantsMeta;
   return e.key.toLowerCase()===key&&controlMatches&&metaMatches&&e.shiftKey===wantsShift&&e.altKey===wantsAlt;
  };
  const onKey=(e:KeyboardEvent)=>{
   const target=e.target as HTMLElement|null;
   const editing=!!target&&(target.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(target.tagName));
   if(e.repeat)return;
   if(e.key==='Escape'){setSearchOpen(false);setNotifyOpen(false);return;}
   if(editing)return;
   if(matches(e,keybinds.focusSearch||'Ctrl+K')){e.preventDefault();setSearchOpen(true);}
   else if(matches(e,keybinds.toggleMembers||'Ctrl+Shift+M')){e.preventDefault();window.dispatchEvent(new Event('relay:toggle-members'));}
  };
  window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);
 },[keybinds]);
 useEffect(()=>{const query=search.trim();if(query.length<2){setSearchResults(null);return;}let active=true;setSearchResults(null);const timer=window.setTimeout(()=>api(`/search?q=${encodeURIComponent(query)}`).then(result=>{if(active)setSearchResults(result);}).catch(()=>{if(active)setSearchResults(null);}),250);return()=>{active=false;window.clearTimeout(timer);};},[search]);
 const title=useMemo(()=>{if(location.pathname.includes('/settings'))return 'Your settings';if(location.pathname.includes('/server/'))return 'Club settings';if(location.pathname.includes('/friends'))return 'People';if(location.pathname.includes('/discover'))return 'Find a club';if(location.pathname.includes('/events'))return 'Events';if(location.pathname.includes('/library'))return 'Library';if(location.pathname.includes('/premium'))return 'Relay Plus';if(location.pathname.includes('/shop'))return 'Shop';if(location.pathname.includes('/profile/'))return 'Profile';if(location.pathname.includes('/invite/'))return 'Invitation';if(location.pathname.includes('/channels/@me/'))return 'Chats';if(serverInfo?.server)return serverInfo.server.name;return 'Home';},[location.pathname,serverInfo]);
 const createServer=async(e:React.FormEvent)=>{e.preventDefault();try{const r=await post<{server:Server;channelId:string}>('/servers',{name:serverName,description:serverDescription});setCreateOpen(false);setServerName('');setServerDescription('');await load();navigate(`/channels/${r.server.id}/${r.channelId}`);toast.show('Your club is ready.','success');}catch(e:any){toast.show(e.message,'error');}};
 const logout=async()=>{try{await post('/auth/logout');setUser(null);announceAuthChange();navigate('/login');}catch(e:any){toast.show(e.message,'error');}};
 const markAll=async()=>{try{await post('/notifications/read-all');setNotifications(v=>v.map(n=>({...n,read_at:new Date().toISOString()})));}catch(e:any){toast.show(e.message,'error');}};
 const unread=notifications.filter(n=>!n.read_at).length;
 const filteredDms=dms.filter(dm=>{const others=dm.members.filter(m=>m.id!==user?.id);const label=(dm.name||others.map(m=>m.username).join(', ')).toLowerCase();const matches=label.includes(dmQuery.trim().toLowerCase());const group=!!dm.is_group||others.length>1;const online=others.some(m=>m.presence==='online');return matches&&(dmScope==='all'||(dmScope==='groups'&&group)||(dmScope==='online'&&online));});
 const selectedDm=location.pathname.match(/^\/channels\/@me\/([^/]+)/)?.[1];
 return <div className="app-shell clubhouse-shell">
   <div className={`server-rail ${mobileNav?'show':''}`}>
     <Link to="/home" className={`rail-home ${!activeServer?'active':''}`} aria-label="Relay home"><span className="relay-mark"><img src="/relay-mark.svg" alt="Relay"/></span></Link>
     <div className="rail-divider"/>
     {servers.map(s=><Link key={s.id} to={`/channels/${s.id}`} title={s.name} className={`server-icon ${activeServer===s.id?'active':''}`}><Avatar name={s.name} src={s.icon} size="md"/></Link>)}
     <button className="server-add" onClick={()=>setCreateOpen(true)} aria-label="Start a club" title="Start a club"><Plus size={22}/></button>
     <Link to="/discover" title="Explore communities" className={`rail-link ${location.pathname==='/discover'?'active':''}`}><Compass size={21}/></Link>
   </div>
   <aside className={`side-panel ${mobileNav?'show':''}`}>
     <div className="side-top"><Link to="/home" className="brand"><span className="brand-mark"><img src="/relay-mark.svg" alt=""/></span><span>relay</span></Link><button className="mobile-close icon-btn" onClick={()=>setMobileNav(false)} aria-label="Close navigation"><X size={19}/></button></div>
     {activeServer&&serverInfo?.server?<>
       <div className="server-heading"><div><strong>{serverInfo.server.name}</strong><small>{serverInfo.server.description||'Your club'}</small></div><button className="icon-btn" title="Club settings" onClick={()=>navigate(`/server/${activeServer}/settings/overview`)}><Settings size={17}/></button></div>
       <div className="side-scroll server-sidebar-scroll">
         <div className="channel-nav-title"><span>CHANNELS</span><button onClick={()=>navigate(`/server/${activeServer}/settings/channels`)} aria-label="Manage channels" title="Manage channels"><Plus size={15}/></button></div>
         {(serverInfo.categories||[]).map((cat:any)=><details className="channel-category" key={cat.id} open><summary><ChevronDown size={13}/><span>{cat.name}</span><button onClick={e=>{e.preventDefault();navigate(`/server/${activeServer}/settings/channels`);}} aria-label={`Add channel to ${cat.name}`}><Plus size={13}/></button></summary>{(serverInfo.channels||[]).filter((c:any)=>c.category_id===cat.id).map((c:any)=><Link key={c.id} to={`/channels/${activeServer}/${c.id}`} className={`side-item ${serverMatch?.[2]===c.id?'selected':''}`} onClick={()=>setMobileNav(false)}><span className="channel-symbol">{c.type==='voice'?<Volume2 size={15}/>:c.type==='announcement'?<Megaphone size={15}/>:<Hash size={15}/>}</span>{c.name}</Link>)}</details>)}
         {(serverInfo.channels||[]).filter((c:any)=>!c.category_id).map((c:any)=><Link key={c.id} to={`/channels/${activeServer}/${c.id}`} className={`side-item ${serverMatch?.[2]===c.id?'selected':''}`} onClick={()=>setMobileNav(false)}><span className="channel-symbol">{c.type==='voice'?<Volume2 size={15}/>:c.type==='announcement'?<Megaphone size={15}/>:<Hash size={15}/>}</span>{c.name}</Link>)}
         <button className="side-action" onClick={()=>navigate(`/server/${activeServer}/settings/overview`)}><Settings size={15}/> Club settings</button>
         <button className="side-action" onClick={async()=>{try{await post(`/servers/${activeServer}/leave`);navigate('/channels/@me');toast.show('Left server.','success');}catch(e:any){toast.show(e.message,'error');}}}>Leave server</button>
         <div className="section-label spacer">MEMBERS · {serverInfo.members?.length||0}</div>
         {serverInfo.members?.slice(0,80).map((m:any)=><Link key={m.id} to={`/profile/${m.id}`} className="member-row"><Avatar name={m.username} src={m.avatar} size="sm" presence={m.presence}/><span>{m.username}</span><small>{m.role_name}</small></Link>)}
       </div>
     </>:<>
       <div className="home-nav"><div className="sidebar-welcome"><span className="sidebar-welcome-mark">✦</span><span><b>Your Relay</b><small>Friends and communities</small></span></div>
         <Link to="/home" className={`side-item ${location.pathname==='/home'?'selected':''}`} onClick={()=>setMobileNav(false)}><Home size={17}/> Home</Link>
         <Link to="/channels/@me" className={`side-item ${location.pathname.startsWith('/channels/@me')?'selected':''}`} onClick={()=>setMobileNav(false)}><MessageCircle size={17}/> Chats</Link>
         <Link to="/friends" className={`side-item ${location.pathname==='/friends'?'selected':''}`} onClick={()=>setMobileNav(false)}><Users size={17}/> Friends</Link>
         <Link to="/discover" className={`side-item ${location.pathname==='/discover'?'selected':''}`} onClick={()=>setMobileNav(false)}><Compass size={17}/> Explore</Link>
         {user?.is_admin&&<Link to="/admin" className={`side-item ${location.pathname==='/admin'?'selected':''}`} onClick={()=>setMobileNav(false)}><Shield size={17}/> Admin panel</Link>}
       </div>
       <div className="dm-heading"><div><span>MESSAGES</span><small>{dms.length} conversations</small></div><Link to="/friends" className="dm-new-message" aria-label="Start a new chat" title="Start a new chat"><MessageSquarePlus size={16}/><span>New</span></Link></div>
       <div className="dm-tools">
         <label className="dm-search"><Search size={15}/><input value={dmQuery} onChange={e=>setDmQuery(e.target.value)} placeholder="Search chats"/></label>
         <div className="dm-filters" role="group" aria-label="Filter conversations">
           <button className={dmScope==='all'?'active':''} onClick={()=>setDmScope('all')}>All</button>
           <button className={dmScope==='groups'?'active':''} onClick={()=>setDmScope('groups')}>Groups</button>
           <button className={dmScope==='online'?'active':''} onClick={()=>setDmScope('online')}>Online</button>
         </div>
       </div>
       <div className="dm-list">
         {filteredDms.slice(0,60).map(dm=>{const others=dm.members.filter(m=>m.id!==user?.id);const other=others[0];const label=dm.name||others.map(m=>m.username).join(', ');const group=!!dm.is_group||others.length>1;return <Link key={dm.id} to={`/channels/@me/${dm.id}`} className={`dm-item ${selectedDm===dm.id?'selected':''}`} onClick={()=>setMobileNav(false)}>
           <span className="dm-avatar-wrap"><Avatar name={dm.name||other?.username||'Group'} src={other?.avatar} size="md" presence={!group?other?.presence:undefined}/>{group&&<i>{others.length+1}</i>}</span>
           <span className="dm-item-copy"><b>{label}</b><small>{typeof dm.last_message==='string'&&dm.last_message.trim()?dm.last_message:group?'Group conversation':'Open conversation'}</small></span>
           <span className="dm-item-meta">{group&&<UsersRound size={12}/>}{Number(dm.unread_count||0)>0&&<i className="dm-unread-count">{Number(dm.unread_count)>99?'99+':dm.unread_count}</i>}</span>
         </Link>;})}
         {!filteredDms.length&&<div className="dm-empty">{dmQuery?'No chats match that search.':dmScope==='groups'?'No group conversations yet.':dmScope==='online'?'No conversations with someone online.':'Your conversations will appear here.'}</div>}
       </div>
       <details className="side-more">
         <summary>More places</summary>
         <div className="side-more-links">
           <Link to="/events"><CalendarDays size={15}/> Events</Link>
           <Link to="/inbox"><Bell size={15}/> Inbox</Link>
           <Link to="/library"><Library size={15}/> Library</Link>
         </div>
       </details>
     </>}
     <div className="user-panel"><Avatar name={user?.username||'User'} src={user?.avatar} size="md" presence={user?.presence}/><div className="user-meta"><strong>{user?.username}</strong><small>{user?.presence||'offline'}</small></div><button className="icon-btn" onClick={logout} title="Log out" aria-label="Log out"><LogOut size={17}/></button><button className="icon-btn" onClick={()=>navigate('/settings/account')} title="User settings" aria-label="User settings"><Settings size={17}/></button></div>
   </aside>
   <main className="main-area">
     <header className="topbar"><button className="mobile-menu icon-btn" onClick={()=>setMobileNav(v=>!v)} aria-label="Open navigation"><Menu size={20}/></button><div className="crumb-title">{title}</div><div className="top-actions">{installAvailable&&<button className="install-relay-btn" onClick={()=>{void promptRelayInstall().finally(()=>setInstallAvailable(hasRelayInstallPrompt()));}}><Download size={15}/> Install</button>}<button className="global-search" onClick={()=>setSearchOpen(true)}><Search size={15}/><span>Search people and chats</span><kbd>Ctrl K</kbd></button><Link className="icon-btn" to="/help" title="Help" aria-label="Help"><HelpCircle size={18}/></Link><button className={`icon-btn notification-trigger ${unread?'has-unread':''}`} onClick={()=>setNotifyOpen(v=>!v)} aria-label={`Notifications${unread?`, ${unread} unread`:''}`}><Bell size={18}/>{unread>0&&<i>{unread>9?'9+':unread}</i>}</button><Link to="/settings/account" className="top-avatar"><Avatar name={user?.username||'User'} src={user?.avatar} size="sm"/></Link></div></header>
     <div className="workspace"><Outlet/></div>
   </main>
   {notifyOpen&&<><div className="popover-dismiss" onClick={()=>setNotifyOpen(false)}/><section className="notification-popover"><header><strong>Notifications</strong><button className="text-btn" onClick={markAll}>Mark all read</button></header>{notifications.length?notifications.slice(0,30).map(n=><button key={n.id} className={`notification-row ${n.read_at?'read':''}`} onClick={async()=>{await post(`/notifications/${n.id}/read`);setNotifications(v=>v.map(x=>x.id===n.id?{...x,read_at:new Date().toISOString()}:x));setNotifyOpen(false);navigate(n.href);}}><span className="notification-dot"/><span><b>{n.title}</b><small>{n.body}</small><time>{new Date(n.created_at).toLocaleString()}</time></span></button>):<div className="mini-empty">You're all caught up.</div>}</section></>}
   {searchOpen&&<Modal title="Search Relay" onClose={()=>{setSearchOpen(false);setSearch('');setSearchResults(null);}}><SearchInput value={search} onChange={setSearch} placeholder="Search people, servers, messages…"/><div className="search-results">{search.length<2?<div className="search-hint">Type at least 2 characters. Press Ctrl+K anytime to search.</div>:!searchResults?<div className="search-hint">Searching…</div>:<>
     {searchResults.users?.length>0&&<><h4>PEOPLE</h4>{searchResults.users.map((u:any)=><button className="result-row" key={u.id} onClick={()=>{setSearchOpen(false);navigate(`/profile/${u.id}`);}}><Avatar name={u.username} src={u.avatar} size="sm"/>{u.username}</button>)}</>}
     {searchResults.servers?.length>0&&<><h4>SERVERS</h4>{searchResults.servers.map((s:any)=><button className="result-row" key={s.id} onClick={()=>{setSearchOpen(false);navigate(`/channels/${s.id}`);}}>{s.name}</button>)}</>}
     {searchResults.messages?.length>0&&<><h4>MESSAGES</h4>{searchResults.messages.map((m:any)=><button className="result-row message-result" key={m.id} onClick={()=>{setSearchOpen(false);navigate(m.channel_id?`/channels/${servers.find(s=>s.id===m.server_id)?.id||''}/${m.channel_id}`:`/channels/@me/${m.dm_id}`);}}><b>{m.username}</b><span>{m.content}</span></button>)}</>}
     {!searchResults.users?.length&&!searchResults.servers?.length&&!searchResults.messages?.length&&<div className="search-hint">No results. Try a different search.</div>}
   </>}</div></Modal>}
   {createOpen&&<Modal title="Start a club" onClose={()=>setCreateOpen(false)} footer={<><Button variant="secondary" onClick={()=>setCreateOpen(false)}>Cancel</Button><Button onClick={()=>{const form=document.getElementById('create-server-form') as HTMLFormElement|null;form?.requestSubmit();}} disabled={!serverName.trim()}>Create server</Button></>}><form id="create-server-form" onSubmit={createServer}><Field label="Server name"><input value={serverName} onChange={e=>setServerName(e.target.value)} minLength={2} maxLength={80} required placeholder="e.g. Study group"/></Field><Field label="Description"><textarea value={serverDescription} onChange={e=>setServerDescription(e.target.value)} maxLength={300} placeholder="What is this community about?"/></Field><p className="muted-note">A general text channel and member role will be created automatically.</p></form></Modal>}
 </div>;
}
