import React,{useEffect,useMemo,useState} from 'react';
import {Link,useNavigate,useParams,useLocation} from 'react-router-dom';
import {Activity,ArrowRight,CalendarDays,Check,Compass,Globe,MessageCircle,Plus,Search,Shield,Ban,UserPlus,Users,X,Clock,BookOpen,Gift,ExternalLink,Lock,Camera,Save,Mail,Monitor,Volume2,Mic,Eye,Trash2,RefreshCw,Copy,Settings,Hash,VolumeX,ChevronRight} from 'lucide-react';
import {api,post,patch,put,del} from '../api';
import {useAuth,useToast} from '../state';
import {Avatar,Button,EmptyState,Field,Loading,Modal,PageHeader,SearchInput} from '../components/ui';

export function HomePage(){
 const {user}=useAuth();
 const [friends,setFriends]=useState<any[]>([]);
 const [dms,setDms]=useState<any[]>([]);
 const [loading,setLoading]=useState(true);
 useEffect(()=>{
  let active=true;
  Promise.all([api('/friends'),api('/dms')])
   .then(([f,d]:any[])=>{if(!active)return;setFriends(f.friends||[]);setDms(d.conversations||[]);})
   .catch(()=>{})
   .finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[]);
 const accepted=friends.filter(f=>f.status==='accepted');
 const pending=friends.filter(f=>f.status==='pending');
 const firstName=user?.username||'friend';
 return <div className="page-content clubhouse-home">
  <section className="home-hero">
   <div className="home-hero-copy">
    <div className="home-kicker"><span>✦</span> YOUR LITTLE CORNER OF RELAY</div>
    <h1>Welcome, {firstName}!</h1>
    <p>Your messages, friends, and communities are all in one place.</p>
    <div className="home-hero-actions">
     <Link className="btn primary" to="/channels/@me"><MessageCircle size={18}/> Open messages</Link>
     <Link className="home-quiet-link" to="/friends"><Users size={18}/> Meet my people <ArrowRight size={16}/></Link>
    </div>
    <div className="home-mini-counts">
     <span><b>{accepted.length}</b> {accepted.length===1?'friend':'friends'}</span>
     <i/>
     <span><b>{dms.length}</b> {dms.length===1?'chat':'chats'}</span>
    </div>
   </div>
   <div className="home-hero-art">
     <img className="relay-mascot-art" src="/relay-mascots.svg" alt="Three friendly Relay chat mascots"/>
     <span className="hero-art-caption"><i/> Good conversations start here</span>
    </div>
  </section>
  <div className="home-shortcut-row" aria-label="Quick places">
   <Link to="/discover" className="home-shortcut shortcut-clubs"><span className="shortcut-art"><Compass size={25}/><i>✳</i></span><span><b>Find a club</b><small>Explore new interests</small></span><ArrowRight size={18}/></Link>
   <Link to="/friends" className="home-shortcut shortcut-people"><span className="shortcut-art"><Users size={25}/><i>♥</i></span><span><b>Find your people</b><small>Add a friend</small></span><ArrowRight size={18}/></Link>
   <Link to="/channels/@me" className="home-shortcut shortcut-messages"><span className="shortcut-art"><MessageCircle size={25}/><i>✦</i></span><span><b>Read your chats</b><small>Pick up where you left off</small></span><ArrowRight size={18}/></Link>
  </div>
  <div className="home-lower-grid">
   <section className="home-board home-friend-board">
    <header className="home-board-heading"><div><span className="home-board-kicker">THE PEOPLE CORNER</span><h2>Your friends</h2></div><Link to="/friends">See everyone <ArrowRight size={15}/></Link></header>
    {loading?<Loading label="Finding your friends…"/>:accepted.length?
     <div className="home-friend-list">{accepted.slice(0,5).map((f:any,index:number)=><div className={'home-friend-card home-friend-card-'+(index%4)} key={f.id}>
      <Avatar name={f.user.username} src={f.user.avatar} size="lg" presence={f.user.presence}/>
      <div><b>{f.user.username}</b><small>{f.user.status_text||f.user.presence||'On Relay'}</small></div>
      <Link to={'/profile/'+f.user.id} aria-label={'Open '+f.user.username+"'s profile"}><ArrowRight size={17}/></Link>
     </div>)}</div>
     :<div className="home-friendly-empty"><span className="empty-doodle">☺</span><div><b>Your people are waiting to meet you.</b><p>Add someone you know to start chatting.</p><Link to="/friends">Find a friend <ArrowRight size={15}/></Link></div></div>}
   </section>
   <section className="home-board home-chat-board">
    <header className="home-board-heading"><div><span className="home-board-kicker">PICK UP WHERE YOU LEFT OFF</span><h2>Recent chats</h2></div><Link to="/channels/@me">All chats <ArrowRight size={15}/></Link></header>
    {loading?<Loading label="Loading your chats…"/>:dms.length?
     <div className="home-recent-list">{dms.slice(0,5).map((dm:any,index:number)=>{const others=dm.members.filter((m:any)=>m.id!==user?.id);const name=dm.name||others.map((m:any)=>m.username).join(', ')||'Group chat';return <Link to={'/channels/@me/'+dm.id} className={'home-recent-chat recent-chat-'+(index%4)} key={dm.id}>
      <span className="recent-chat-avatar">{others.length>1?<Users size={19}/>:<Avatar name={others[0]?.username||'Friend'} src={others[0]?.avatar} size="md"/>}</span>
      <span className="recent-chat-copy"><b>{name}</b><small>{dm.last_message||'Say hello and start the conversation'}</small></span>
      <ArrowRight size={17}/>
     </Link>;})}</div>
     :<div className="home-friendly-empty"><span className="empty-doodle">✉</span><div><b>No chats just yet.</b><p>Choose a friend and send your first hello.</p><Link to="/friends">Find someone to chat with <ArrowRight size={15}/></Link></div></div>}
   </section>
  </div>
  {pending.length>0&&<div className="home-pending-note"><span>✉</span><div><b>You have {pending.length} friend request{pending.length===1?'':'s'}.</b><small>Someone would like to connect with you.</small></div><Link to="/friends">Take a look <ArrowRight size={15}/></Link></div>}
 </div>;
}

export function FriendsPage(){
 const toast=useToast();const navigate=useNavigate();const [friends,setFriends]=useState<any[]>([]);const [tab,setTab]=useState('online');const [username,setUsername]=useState('');const [busy,setBusy]=useState(false);const [dmUsers,setDmUsers]=useState<string[]>([]);const [groupOpen,setGroupOpen]=useState(false);const [groupName,setGroupName]=useState('');const [groupUsers,setGroupUsers]=useState<string[]>([]);
 const load=async(showErrors=true)=>{try{const r=await api<{friends:any[]}>('/friends');setFriends(r.friends);}catch(e:any){if(showErrors)toast.show(e.message,'error');}};useEffect(()=>{void load();const refreshWhenActive=()=>{if(document.visibilityState==='visible')void load(false);};const refreshFromSocket=()=>void load(false);const timer=window.setInterval(()=>void load(false),15000);window.addEventListener('focus',refreshWhenActive);document.addEventListener('visibilitychange',refreshWhenActive);window.addEventListener('relay:friends-refresh',refreshFromSocket);return()=>{window.clearInterval(timer);window.removeEventListener('focus',refreshWhenActive);document.removeEventListener('visibilitychange',refreshWhenActive);window.removeEventListener('relay:friends-refresh',refreshFromSocket);};},[]);
 const add=async(e:React.FormEvent)=>{e.preventDefault();setBusy(true);try{await post('/friends/request',{username});toast.show('Friend request sent.','success');setUsername('');await load();}catch(e:any){toast.show(e.message,'error');}finally{setBusy(false);}};
 const accept=async(id:string)=>{try{await post(`/friends/${id}/accept`);toast.show('Friend request accepted.','success');await load();}catch(e:any){toast.show(e.message,'error');}};
 const remove=async(id:string)=>{try{await del(`/friends/${id}`);toast.show('Friend request removed.','success');await load();}catch(e:any){toast.show(e.message,'error');}};
 const startDm=async(userId:string)=>{try{const r=await post<any>('/dms',{userIds:[userId]});navigate(`/channels/@me/${r.conversation.id}`);}catch(e:any){toast.show(e.message,'error');}};
 const accepted=friends.filter(f=>f.status==='accepted');const incoming=friends.filter(f=>f.status==='pending'&&f.direction==='incoming');const outgoing=friends.filter(f=>f.status==='pending'&&f.direction==='outgoing');
 const list=tab==='pending'?friends.filter(f=>f.status==='pending'):tab==='all'?accepted:tab==='online'?accepted.filter(f=>f.user.presence==='online'):accepted;
 return <div className="page-content"><PageHeader title="Friends" subtitle="Keep up with people you know and start conversations." actions={<Button variant="secondary" onClick={()=>setGroupOpen(true)} disabled={accepted.length<2}><Users size={15}/> New group</Button>}/>
  <div className="friend-session-note"><b>Testing with two accounts?</b><span>Browser tabs in the same profile share one sign-in session. Use a separate browser profile, or one normal window and one private window, to stay signed in as two different users. Signing into another account updates the session in every tab.</span></div>
  <form className="add-friend-form" onSubmit={add}><div><strong>Add a friend</strong><small>Search by exact username. Incoming means they sent you a request; outgoing means this account sent it.</small></div><input value={username} onChange={e=>setUsername(e.target.value)} placeholder="Enter a username" minLength={3} maxLength={24}/><Button type="submit" disabled={busy||username.trim().length<3}><UserPlus size={16}/> Send request</Button></form>
  <div className="tabs"><button className={tab==='online'?'active':''} onClick={()=>setTab('online')}>Online <span>{accepted.filter(f=>f.user.presence==='online').length}</span></button><button className={tab==='all'?'active':''} onClick={()=>setTab('all')}>All <span>{accepted.length}</span></button><button className={tab==='pending'?'active':''} onClick={()=>setTab('pending')}>Pending <span>{incoming.length+outgoing.length}</span></button></div>
  {tab==='pending'&&<><h3 className="list-subhead">Incoming · {incoming.length}</h3>{incoming.length?incoming.map(f=><div className="friend-row" key={f.id}><Avatar name={f.user.username} src={f.user.avatar} size="md"/><div className="friend-info"><b>{f.user.username}</b><small>Wants to connect</small></div><Button onClick={()=>void accept(f.id)}><Check size={15}/> Accept</Button><Button variant="secondary" onClick={()=>void remove(f.id)}>Ignore</Button></div>):<div className="small-empty">No incoming friend requests.</div>}<h3 className="list-subhead">Outgoing · {outgoing.length}</h3>{outgoing.map(f=><div className="friend-row" key={f.id}><Avatar name={f.user.username} src={f.user.avatar} size="md"/><div className="friend-info"><b>{f.user.username}</b><small>Request sent</small></div><Button variant="secondary" onClick={()=>void remove(f.id)}>Cancel</Button></div>)}</>}
  {tab!=='pending'&&list.length?list.map(f=><div className="friend-row" key={f.id}><Avatar name={f.user.username} src={f.user.avatar} size="md" presence={f.user.presence}/><div className="friend-info"><b>{f.user.username}</b><small>{f.user.status_text||f.user.presence}</small></div><Button variant="secondary" onClick={()=>void startDm(f.user.id)}><MessageCircle size={15}/> Message</Button><Button variant="ghost" onClick={()=>navigate(`/profile/${f.user.id}`)}>Profile</Button><Button variant="ghost" onClick={()=>void remove(f.id)} title="Remove friend"><X size={15}/></Button></div>):tab!=='pending'?<EmptyState title={tab==='online'?'No friends online':'No friends yet'} description="Add a friend by username to start building your list." icon={Users}/>:null}
 {groupOpen&&<Modal title="Create a group DM" onClose={()=>setGroupOpen(false)}><form className="form-stack" onSubmit={async e=>{e.preventDefault();try{const r=await post<any>('/dms',{userIds:groupUsers,name:groupName||undefined});setGroupOpen(false);navigate(`/channels/@me/${r.conversation.id}`);}catch(e:any){toast.show(e.message,'error');}}}><Field label="Group name"><input value={groupName} onChange={e=>setGroupName(e.target.value)} maxLength={60} placeholder="Optional group name"/></Field><div className="group-picker">{accepted.map(f=><label key={f.user.id}><input type="checkbox" checked={groupUsers.includes(f.user.id)} onChange={e=>setGroupUsers(v=>e.target.checked?[...v,f.user.id]:v.filter(x=>x!==f.user.id))}/><Avatar name={f.user.username} src={f.user.avatar} size="sm"/><span>{f.user.username}</span></label>)}</div><p className="muted-note">Choose at least two friends. You will be included automatically.</p><div className="modal-actions"><Button variant="secondary" onClick={()=>setGroupOpen(false)}>Cancel</Button><Button type="submit" disabled={groupUsers.length<2}>Create group</Button></div></form></Modal>}
 </div>;
}

export function DiscoverPage(){
 const [q,setQ]=useState('');
 const [servers,setServers]=useState<any[]>([]);
 const [joined,setJoined]=useState<string[]>([]);
 const [loading,setLoading]=useState(true);
 const toast=useToast();
 const navigate=useNavigate();
 useEffect(()=>{
  const timer=window.setTimeout(()=>{
   setLoading(true);
   api('/discover?q='+encodeURIComponent(q))
    .then((r:any)=>setServers(r.servers))
    .catch((e:any)=>toast.show(e.message,'error'))
    .finally(()=>setLoading(false));
  },220);
  return()=>window.clearTimeout(timer);
 },[q]);
 const join=async(id:string)=>{
  try{await post('/servers/'+id+'/join');setJoined(v=>[...v,id]);toast.show('You joined the club.','success');navigate('/channels/'+id);}
  catch(e:any){toast.show(e.message,'error');}
 };
 return <div className="page-content clubhouse-discover">
  <section className="clubs-intro">
   <div><span className="clubs-kicker">AROUND THE NEIGHBOURHOOD</span><h1>Find your kind of people.</h1><p>There are lots of little communities to explore. Look for one that shares your favourite things.</p></div>
   <div className="clubs-intro-art" aria-hidden="true"><span className="clubs-art-sun">✳</span><span className="clubs-art-house">⌂</span><span className="clubs-art-star">✦</span><span className="clubs-art-line"/></div>
  </section>
  <div className="clubs-search-bar"><SearchInput value={q} onChange={setQ} placeholder="What are you interested in?"/><span>{servers.length} {servers.length===1?'club':'clubs'} to explore</span></div>
  {loading?<Loading label="Looking around…"/>:servers.length?
   <div className="clubs-grid">{servers.map((s:any,index:number)=><article className={'club-card club-card-'+(index%5)} key={s.id}>
    <div className={'club-art club-art-'+(index%5)} aria-hidden="true"><span className="club-art-initial">{(s.name||'R').slice(0,1).toUpperCase()}</span><i className="club-art-shape club-art-shape-one"/><i className="club-art-shape club-art-shape-two"/><span className="club-art-spark">✳</span><span className="club-art-ribbon">A PLACE TO BELONG</span></div>
    <div className="club-card-content"><div className="club-card-overline"><span>COMMUNITY CLUB</span><span><Users size={14}/>{s.member_count||0}</span></div><h2>{s.name}</h2><p>{s.description||'A friendly community on Relay. Come and have a look around.'}</p><div className="club-card-bottom"><span><Globe size={14}/> Public club</span><Button disabled={joined.includes(s.id)} onClick={()=>void join(s.id)}>{joined.includes(s.id)?'You joined':'Join this club'} <ArrowRight size={15}/></Button></div></div>
   </article>)}</div>
   :<div className="clubs-empty"><span>⌕</span><h2>No clubs found</h2><p>Try a different word, or come back and explore again.</p></div>}
 </div>;
}

export function ProfilePage(){
 const {userId}=useParams();const {user:me}=useAuth();const toast=useToast();const navigate=useNavigate();const [profile,setProfile]=useState<any>(null);const [blocked,setBlocked]=useState(false);const [loading,setLoading]=useState(true);const [friends,setFriends]=useState<any[]>([]);const [editOpen,setEditOpen]=useState(false);const [form,setForm]=useState<any>({});
 const own=userId===me?.id;
 const load=async()=>{if(!userId)return;try{const [p,f]=await Promise.all([api<any>(`/profile/${userId}`),api<any>('/friends')]);setProfile(p.user);setBlocked(p.isBlocked);setFriends(f.friends||[]);setForm({username:p.user.username,bio:p.user.bio||'',status_text:p.user.status_text||'',avatar:p.user.avatar||'',banner:p.user.banner||''});}catch(e:any){toast.show(e.message,'error');}finally{setLoading(false);}};
 useEffect(()=>{setLoading(true);void load();const refreshFromSocket=()=>void load();window.addEventListener('relay:friends-refresh',refreshFromSocket);return()=>window.removeEventListener('relay:friends-refresh',refreshFromSocket);},[userId]);
 const relationship=friends.find(f=>f.user.id===userId);const save=async(e:React.FormEvent)=>{e.preventDefault();try{const r=await patch<any>('/profile',form);setProfile(r.user);setEditOpen(false);toast.show('Profile updated.','success');}catch(e:any){toast.show(e.message,'error');}};
 const friend=async()=>{try{if(relationship){await del(`/friends/${relationship.id}`);}else{await post('/friends/request',{username:profile.username});}await load();toast.show(relationship?'Friend relationship removed.':'Friend request sent.','success');}catch(e:any){toast.show(e.message,'error');}};
 const dm=async()=>{try{const r=await post<any>('/dms',{userIds:[userId]});navigate(`/channels/@me/${r.conversation.id}`);}catch(e:any){toast.show(e.message,'error');}};
 const block=async()=>{try{if(blocked){await del(`/blocks/${userId}`);}else{await post(`/blocks/${userId}`);}setBlocked(!blocked);toast.show(blocked?'User unblocked.':'User blocked.','success');}catch(e:any){toast.show(e.message,'error');}};
 if(loading)return <Loading/>;if(!profile)return <EmptyState title="Profile unavailable" description="This user does not exist or is no longer available."/>;
 return <div className="page-content profile-page"><div className="profile-banner" style={profile.banner?{backgroundImage:`url(${profile.banner})`}:{}}/><div className="profile-card"><Avatar name={profile.username} src={profile.avatar} size="xl" presence={own?'online':profile.presence}/><div className="profile-actions">{own?<Button onClick={()=>setEditOpen(true)}>Edit profile</Button>:<><Button onClick={()=>void friend()}>{relationship?.status==='accepted'?'Remove friend':relationship?.status==='pending'?'Cancel request':'Add friend'}</Button><Button variant="secondary" onClick={()=>void dm()}><MessageCircle size={15}/> Message</Button><Button variant="ghost" onClick={()=>void block()}>{blocked?'Unblock':'Block'}</Button></>}</div><h1>{profile.username}</h1><p className="profile-status">{profile.status_text||'No status set'}</p><p>{profile.bio||'This user has not written a bio yet.'}</p><div className="profile-meta"><span><Activity size={14}/> {own?'Your account':profile.presence}</span><span>Member since {new Date(profile.created_at).toLocaleDateString()}</span></div></div>
 {editOpen&&<Modal title="Edit profile" onClose={()=>setEditOpen(false)}><form onSubmit={save} className="form-stack"><Field label="Username"><input value={form.username} onChange={e=>setForm({...form,username:e.target.value})} minLength={3} maxLength={24} required/></Field><Field label="Bio"><textarea value={form.bio} onChange={e=>setForm({...form,bio:e.target.value})} maxLength={300}/></Field><Field label="Status"><input value={form.status_text} onChange={e=>setForm({...form,status_text:e.target.value})} maxLength={80}/></Field><Field label="Avatar image URL"><input value={form.avatar} onChange={e=>setForm({...form,avatar:e.target.value})} placeholder="https://…"/></Field><Field label="Banner image URL"><input value={form.banner} onChange={e=>setForm({...form,banner:e.target.value})} placeholder="https://…"/></Field><div className="modal-actions"><Button variant="secondary" onClick={()=>setEditOpen(false)}>Cancel</Button><Button type="submit"><Save size={15}/> Save profile</Button></div></form></Modal>}
 </div>;
}

export function InvitePage(){
 const {inviteCode}=useParams();const navigate=useNavigate();const toast=useToast();const [invite,setInvite]=useState<any>(null);const [loading,setLoading]=useState(true);const [joined,setJoined]=useState(false);
 useEffect(()=>{api<any>(`/invites/${inviteCode}`).then(r=>setInvite(r.invite)).catch(e=>toast.show(e.message,'error')).finally(()=>setLoading(false));},[inviteCode]);
 const join=async()=>{try{const r=await post<any>(`/invites/${inviteCode}/join`);setJoined(true);toast.show('You joined the server.','success');navigate(`/channels/${r.serverId}`);}catch(e:any){toast.show(e.message,'error');}};
 if(loading)return <Loading/>;if(!invite)return <EmptyState title="Invite unavailable" description="This invite may have expired, reached its use limit, or been revoked."/>;
 return <div className="invite-page"><div className="invite-card"><div className="invite-logo"><img src="/relay-mark.svg" alt="Relay"/></div><span className="eyebrow">YOU'VE BEEN INVITED</span><h1>{invite.server.name}</h1><p>{invite.server.description||'Join this Relay community to chat and share.'}</p><div className="invite-count"><Users size={16}/>{invite.server.member_count} members</div><Button onClick={()=>void join()} disabled={joined}>{joined?'Joined':'Accept invite'} <ArrowRight size={16}/></Button><Link to="/home">Decline and return home</Link></div></div>;
}

export function InboxPage(){
 const [items,setItems]=useState<any[]>([]);const [filter,setFilter]=useState('all');const toast=useToast();
 const load=async()=>{try{const r=await api<any>('/notifications');setItems(r.notifications);}catch(e:any){toast.show(e.message,'error');}};useEffect(()=>{void load();},[]);
 const visible=items.filter(n=>filter==='all'||(filter==='mentions'?n.type==='mention':n.type!=='mention'));
 const markAll=async()=>{try{await post('/notifications/read-all');setItems(v=>v.map(n=>({...n,read_at:new Date().toISOString()})));}catch(e:any){toast.show(e.message,'error');}};
 return <div className="page-content"><PageHeader title="Inbox" subtitle="Your recent mentions, DMs, friend requests, and community updates." actions={<Button variant="secondary" onClick={()=>void markAll()}><Check size={15}/> Mark all read</Button>}/><div className="tabs"><button className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>All activity</button><button className={filter==='mentions'?'active':''} onClick={()=>setFilter('mentions')}>Mentions</button><button className={filter==='other'?'active':''} onClick={()=>setFilter('other')}>Other</button></div>{visible.length?visible.map(n=><Link to={n.href} key={n.id} className={`inbox-row ${n.read_at?'read':''}`} onClick={async()=>{if(!n.read_at){await post(`/notifications/${n.id}/read`);setItems(v=>v.map(x=>x.id===n.id?{...x,read_at:new Date().toISOString()}:x));}}}><span className="notification-dot"/><div><b>{n.title}</b><p>{n.body}</p><time>{new Date(n.created_at).toLocaleString()}</time></div></Link>):<EmptyState title="Nothing here yet" description="New activity will appear here when someone messages, mentions, invites, or adds you." icon={Activity}/>}</div>;
}
export function HelpPage(){return <div className="page-content"><PageHeader title="Relay help" subtitle="A quick guide to this local community app."/><div className="help-grid">{[['Getting started','Create an account, then join a public community from Discover or create your own server.'],['Channels and messages','Text channels support messages, replies, edits, reactions, pins, search, and local attachments. Enter sends; Shift+Enter adds a new line.'],['Friends and DMs','Send friend requests by exact username. Incoming and outgoing are shown from the currently signed-in account. Browser tabs share one session cookie, so use separate browser profiles to test two accounts at once. Direct messages respect privacy settings.'],['Voice and screen sharing','Join a voice channel to request microphone access. Camera and screen sharing require browser permissions and HTTPS outside localhost. Peer connections may fail without TURN.'],['Account and safety','Manage password, sessions, blocks, privacy, notifications, appearance, accessibility, and keybind preferences in Settings.'],['Demo boundaries','No email provider, payment processor, external OAuth, or hosted push service is configured. Plus and Shop are informational only.']] .map(([title,body])=><article className="help-card" key={title}><h3>{title}</h3><p>{body}</p></article>)}</div></div>;}

export function EventsPage(){
 const toast=useToast();const {user}=useAuth();const [events,setEvents]=useState<any[]>([]);const [servers,setServers]=useState<any[]>([]);const [modalOpen,setModalOpen]=useState(false);const [editing,setEditing]=useState<any>(null);const [form,setForm]=useState<any>({serverId:'',title:'',description:'',starts_at:'',location:''});const [loading,setLoading]=useState(true);const [saving,setSaving]=useState(false);
 const load=async()=>{try{const [e,s]=await Promise.all([api<any>('/events'),api<any>('/servers')]);setEvents(e.events);setServers(s.servers);if(!form.serverId&&s.servers[0])setForm((f:any)=>({...f,serverId:s.servers[0].id}));}catch(e:any){toast.show(e.message,'error');}finally{setLoading(false);}};
 useEffect(()=>{void load();},[]);
 const toLocalInput=(value:string)=>{const date=new Date(value);date.setMinutes(date.getMinutes()-date.getTimezoneOffset());return date.toISOString().slice(0,16);};
 const openCreate=()=>{setEditing(null);setForm({serverId:servers[0]?.id||'',title:'',description:'',starts_at:'',location:''});setModalOpen(true);};
 const openEdit=(event:any)=>{setEditing(event);setForm({serverId:event.server_id,title:event.title,description:event.description||'',starts_at:toLocalInput(event.starts_at),location:event.location||''});setModalOpen(true);};
 const submit=async(e:React.FormEvent)=>{e.preventDefault();setSaving(true);try{const payload={title:form.title,description:form.description,starts_at:new Date(form.starts_at).toISOString(),location:form.location};if(editing){await patch(`/events/${editing.id}`,payload);toast.show('Event updated.','success');}else{await post(`/servers/${form.serverId}/events`,payload);toast.show('Event created.','success');}setModalOpen(false);setEditing(null);await load();}catch(e:any){toast.show(e.message,'error');}finally{setSaving(false);}};
 const rsvp=async(event:any,status:'going'|'interested')=>{try{await post(`/events/${event.id}/rsvp`,{status});await load();}catch(err:any){toast.show(err.message,'error');}};
 const cancelRsvp=async(event:any)=>{try{await del(`/events/${event.id}/rsvp`);await load();}catch(err:any){toast.show(err.message,'error');}};
 const deleteEvent=async(event:any)=>{if(!window.confirm(`Cancel “${event.title}”?`))return;try{await del(`/events/${event.id}`);await load();toast.show('Event cancelled.','success');}catch(err:any){toast.show(err.message,'error');}};
 return <div className="page-content"><PageHeader title="Events" subtitle="See what your communities have planned." actions={<Button onClick={openCreate} disabled={!servers.length}><Plus size={16}/> Create event</Button>}/>
 {loading?<Loading/>:events.length?<div className="event-list">{events.map(event=><article className="event-card" key={event.id}><div className="event-date"><b>{new Date(event.starts_at).toLocaleDateString([], {day:'2-digit'})}</b><span>{new Date(event.starts_at).toLocaleDateString([], {month:'short'})}</span></div><div className="event-content"><span className="eyebrow">{event.server_name}</span><h3>{event.title}</h3><p>{event.description||'Community event'}</p><div className="event-meta"><span><Clock size={14}/>{new Date(event.starts_at).toLocaleString()}</span><span><Users size={14}/>{event.going_count} going</span>{event.location&&<span>{event.location}</span>}</div></div><div className="event-actions">{event.my_rsvp?<Button variant="secondary" onClick={()=>void cancelRsvp(event)}>{event.my_rsvp==='going'?'Going':'Interested'} · Cancel</Button>:<><Button onClick={()=>void rsvp(event,'going')}>I'm going</Button><Button variant="ghost" onClick={()=>void rsvp(event,'interested')}>Interested</Button></>}{event.creator_id===user?.id&&<><Button variant="ghost" onClick={()=>openEdit(event)}>Edit</Button><Button variant="danger" onClick={()=>void deleteEvent(event)}>Cancel event</Button></>}</div></article>)}</div>:<EmptyState title="No upcoming events" description="Create an event in one of your servers and invite the community." icon={CalendarDays}/>}
 {modalOpen&&<Modal title={editing?'Edit event':'Create an event'} onClose={()=>{setModalOpen(false);setEditing(null);}}><form className="form-stack" onSubmit={submit}>{!editing&&<Field label="Server"><select value={form.serverId} onChange={e=>setForm({...form,serverId:e.target.value})} required>{servers.map((server:any)=><option value={server.id} key={server.id}>{server.name}</option>)}</select></Field>}<Field label="Event name"><input value={form.title} onChange={e=>setForm({...form,title:e.target.value})} maxLength={100} minLength={2} required/></Field><Field label="Description"><textarea value={form.description} onChange={e=>setForm({...form,description:e.target.value})} maxLength={1000}/></Field><Field label="Date and time"><input type="datetime-local" value={form.starts_at} onChange={e=>setForm({...form,starts_at:e.target.value})} required/></Field><Field label="Location or voice channel"><input value={form.location} onChange={e=>setForm({...form,location:e.target.value})} maxLength={120}/></Field><div className="modal-actions"><Button variant="secondary" onClick={()=>{setModalOpen(false);setEditing(null);}}>Cancel</Button><Button type="submit" disabled={saving}>{saving?'Saving…':editing?'Save changes':'Create event'}</Button></div></form></Modal>}
 </div>;
}

export function InfoPage({kind}:{kind:'library'|'premium'|'shop'}){
 const config={library:{title:'Activity library',subtitle:'A small catalogue of things your community can do together.',icon:BookOpen,cards:[['Community prompts','Conversation starters and planning prompts.','Available in this local demo'],['Watch party planning','Coordinate a shared viewing session.','Planning guide only'],['Study room','Set up a focused study channel.','Use a server voice or text channel']]},premium:{title:'Relay Plus',subtitle:'Optional premium features are informational in this demo.',icon:Gift,cards:[['Expanded profile themes','More profile appearance choices.','Concept preview'],['Larger uploads','Higher attachment limits for hosted plans.','Not enabled locally'],['Community perks','Extra server customization options.','Not enabled locally']]},shop:{title:'Relay shop',subtitle:'A catalogue preview. No checkout or payment processing is connected.',icon:Gift,cards:[['Profile accent pack','Colour presets for your profile.','Preview only'],['Server icon collection','Original community icon concepts.','Preview only'],['Seasonal decorations','Small profile decoration concepts.','Preview only']]}}[kind];const Icon=config.icon;
 return <div className="page-content"><PageHeader title={config.title} subtitle={config.subtitle}/><div className="feature-grid">{config.cards.map(([title,desc,status])=><article className="feature-card" key={title}><div className="feature-icon"><Icon size={22}/></div><h3>{title}</h3><p>{desc}</p><span className="status-label">{status}</span></article>)}</div>{kind!=='library'&&<div className="disclosure-note"><Lock size={16}/> This page is demo/information only. No payments, purchases, or paid services are activated.</div>}</div>;
}
