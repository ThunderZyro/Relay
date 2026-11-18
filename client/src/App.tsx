import React,{useEffect,useState} from 'react';
import {Navigate,Route,Routes,Link,useNavigate} from 'react-router-dom';
import {ArrowLeft,ArrowRight,AtSign,LockKeyhole,ShieldCheck,Users,MessageSquareText,RefreshCw,MailCheck} from 'lucide-react';
import {AuthProvider,useAuth,ToastProvider,useToast,announceAuthChange} from './state';
import {api,post} from './api';
import Shell from './components/Shell';
import {Button,Field,Loading} from './components/ui';
import {HomePage,FriendsPage,DiscoverPage,ProfilePage,InvitePage,EventsPage,InfoPage,InboxPage,HelpPage} from './pages/CorePages';
import {ChannelPage,DmPage} from './pages/ChatPages';
import {SettingsPage,ServerSettingsPage} from './pages/SettingsPages';


function AuthBrandPanel({headline,description}:{headline:string;description:string}){
 return <aside className="auth-story">
  <Link to="/login" className="auth-brand" aria-label="Relay home"><span className="brand-mark"><img src="/relay-mark.svg" alt=""/></span><span>relay</span></Link>
  <div className="auth-story-copy"><span className="auth-story-kicker"><i/> YOUR PEOPLE, IN ONE PLACE</span><h1>{headline}</h1><p>{description}</p></div>
  <img className="auth-story-art" src="/relay-mascots.svg" alt="Three cheerful chat mascots around a message window"/>
  <div className="auth-story-footer"><span>✦</span> Friends, messages, and communities — together.</div>
 </aside>;
}

function AuthScreen({mode}:{mode:'login'|'register'|'forgot'}){
 const {user,setUser,refresh}=useAuth();
 const navigate=useNavigate();
 const toast=useToast();
 const [login,setLogin]=useState('');
 const [email,setEmail]=useState('');
 const [username,setUsername]=useState('');
 const [password,setPassword]=useState('');
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const isRegister=mode==='register';
 const isForgot=mode==='forgot';

 if(user)return <Navigate to="/home" replace/>;

 const submit=async(e:React.FormEvent)=>{
  e.preventDefault();
  if(isForgot)return;
  setBusy(true);
  setError('');
  try{
   if(isRegister){
    const result=await post<any>('/auth/register',{email,username,password});
    navigate(`/verify-email?email=${encodeURIComponent(result.email||email)}`);
    toast.show('Check your email for a six-digit verification code.','success');
    return;
   }
   const result=await post<any>('/auth/login',{login,password});
   setUser(result.user);
   announceAuthChange();
   await refresh();
   navigate('/home');
   toast.show('Welcome back to Relay.','success');
  }catch(err:any){
   if(err.code==='EMAIL_VERIFICATION_REQUIRED'){
    const pendingEmail=String(err.details?.email||(login.includes('@')?login:''));
    navigate(`/verify-email?email=${encodeURIComponent(pendingEmail)}`);
    return;
   }
   setError(err.message||'Relay could not complete that request.');
  }finally{
   setBusy(false);
  }
 };

 return <main className="auth-screen">
  <div className="auth-layout">
   <AuthBrandPanel headline={isRegister?'Make your corner of Relay.':'Good to see you again.'} description={isRegister?'Create an account, meet your people, and build a place for the things you love.':'Your friends, conversations, and clubs are right where you left them.'}/>
   <section className="auth-form-side">
    <div className="auth-form-top">
     {isRegister ? 'Already part of Relay?' : isForgot ? 'Remember your password?' : 'New to Relay?'}
     <Link to={isRegister || isForgot ? '/login' : '/register'}>{isRegister || isForgot ? 'Sign in' : 'Create an account'}</Link>
    </div>

    <div className="auth-card">
     <div className="auth-form-heading">
      <h1>{isForgot ? 'Password reset' : isRegister ? 'Create your account' : 'Welcome back'}</h1>
      {isForgot && <p>Password-reset email is not configured on this server. Contact your server administrator for account recovery.</p>}
     </div>

     {!isForgot && <form onSubmit={submit} className="form-stack">
      {isRegister
       ? <>
          <Field label="Email address">
           <input value={email} onChange={e=>setEmail(e.target.value)} type="email" autoComplete="email" maxLength={254} required placeholder="you@example.com"/>
          </Field>
          <Field label="Username">
           <input value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" minLength={3} maxLength={24} required pattern="^(?:[A-Za-z0-9_.]|-){3,24}$" placeholder="Choose a username"/>
          </Field>
         </>
       : <Field label="Email or username">
          <div className="auth-input-wrap"><AtSign size={15}/><input value={login} onChange={e=>setLogin(e.target.value)} autoComplete="username" required placeholder="Enter your email or username"/></div>
         </Field>}
      <Field label="Password">
       <div className="auth-input-wrap"><LockKeyhole size={15}/><input value={password} onChange={e=>setPassword(e.target.value)} type="password" autoComplete={isRegister?'new-password':'current-password'} minLength={isRegister?10:1} maxLength={128} required placeholder={isRegister?'At least 10 characters':'Your password'}/></div>
      </Field>
      {error && <div className="form-error" role="alert">{error}</div>}
      <Button type="submit" disabled={busy}>{busy?'Please wait…':isRegister?'Create account':'Sign in'} <ArrowRight size={16}/></Button>
     </form>}

     {!isRegister && !isForgot && <div className="auth-bottom">
      <Link to="/forgot-password">Forgot password?</Link>
     </div>}
    </div>
   </section>
  </div>
 </main>;
}

function EmailVerificationScreen(){
 const {user,setUser,refresh}=useAuth();
 const navigate=useNavigate();
 const toast=useToast();
 const [email,setEmail]=useState(()=>new URLSearchParams(window.location.search).get('email')||'');
 const [code,setCode]=useState('');
 const [busy,setBusy]=useState(false);
 const [resending,setResending]=useState(false);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('We sent a six-digit code to your email address. It expires in 15 minutes.');
 const [resendWait,setResendWait]=useState(60);
 useEffect(()=>{
  if(resendWait<=0)return;
  const timer=window.setTimeout(()=>setResendWait(value=>Math.max(0,value-1)),1000);
  return()=>window.clearTimeout(timer);
 },[resendWait]);
 if(user)return <Navigate to="/home" replace/>;
 const submit=async(e:React.FormEvent)=>{
  e.preventDefault();setBusy(true);setError('');
  try{
   const result=await post<any>('/auth/verify-email',{email,code});
   setUser(result.user);announceAuthChange();await refresh();navigate('/home');
   toast.show('Your email is verified. Welcome to Relay!','success');
  }catch(err:any){setError(err.message||'Relay could not verify that code.');}
  finally{setBusy(false);}
 };
 const resend=async()=>{
  setResending(true);setError('');
  try{
   const result=await post<any>('/auth/resend-verification',{email});
   setNotice(result.message||'A new code has been sent if your account is awaiting verification.');
   setResendWait(60);
  }catch(err:any){
   setError(err.message||'Relay could not send another code.');
   if(Number(err.details?.retryAfterSeconds)>0)setResendWait(Number(err.details.retryAfterSeconds));
  }finally{setResending(false);}
 };
 return <main className="auth-screen"><div className="auth-layout">
  <AuthBrandPanel headline="One quick check, then you’re in." description="We use email verification to protect your account and keep your Relay conversations safer."/>
  <section className="auth-form-side">
   <div className="auth-form-top">Already verified? <Link to="/login">Sign in</Link></div>
   <div className="auth-card">
    <div className="auth-form-heading"><MailCheck size={28}/><h1>Check your email</h1><p>{notice}</p></div>
    <form className="form-stack" onSubmit={submit}>
     <Field label="Email address"><input type="email" autoComplete="email" required maxLength={254} value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"/></Field>
     <Field label="Six-digit code"><input type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} minLength={6} required value={code} onChange={e=>setCode(e.target.value.replace(/[^0-9]/g,'').slice(0,6))} placeholder="000000" className="verification-code-input"/></Field>
     {error&&<div className="form-error" role="alert">{error}</div>}
     <Button type="submit" disabled={busy||code.length!==6}>{busy?'Verifying…':'Verify email'} <ArrowRight size={16}/></Button>
    </form>
    <div className="auth-bottom verification-resend"><span>Didn't receive it?</span><button type="button" className="text-btn" disabled={resending||resendWait>0||!email} onClick={()=>void resend()}>{resending?'Sending…':resendWait>0?`Resend in ${resendWait}s`:'Send a new code'}</button></div>
    <div className="auth-bottom"><Link to="/register">Use a different email address</Link></div>
   </div>
  </section>
 </div></main>;
}

function AdminPanel(){
 const {user}=useAuth();
 const [overview,setOverview]=useState<any>(null);
 const [users,setUsers]=useState<any[]>([]);
 const [query,setQuery]=useState('');
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState('');
 const [refreshing,setRefreshing]=useState(false);
 const load=async(search=query)=>{
  setRefreshing(true);setError('');
  try{
   const [summary,accounts]=await Promise.all([
    api<any>('/admin/overview'),
    api<any>(`/admin/users?limit=50&q=${encodeURIComponent(search)}`)
   ]);
   setOverview(summary);setUsers(accounts.users||[]);
  }catch(err:any){setError(err.message||'Could not load the admin dashboard.');}
  finally{setLoading(false);setRefreshing(false);}
 };
 useEffect(()=>{void load('');},[]);
 if(!user?.is_admin)return <Navigate to="/home" replace/>;
 return <div className="page-content admin-page">
  <div className="admin-heading"><div><span className="admin-kicker"><ShieldCheck size={14}/> RELAY CONTROL ROOM</span><h1>Admin panel</h1><p>Account and platform overview. User-contact tools are intentionally not enabled yet.</p></div><Button variant="secondary" onClick={()=>void load()} disabled={refreshing}><RefreshCw size={15}/>{refreshing?'Refreshing…':'Refresh'}</Button></div>
  {error&&<div className="form-error" role="alert">{error}</div>}
  {loading?<Loading label="Loading admin dashboard…"/>:<>
   <div className="admin-stat-grid">
    <article><span>Total accounts</span><strong>{overview?.users??0}</strong><small><Users size={13}/> Registered users</small></article>
    <article><span>Verified emails</span><strong>{overview?.verifiedUsers??0}</strong><small><MailCheck size={13}/> Ready to use Relay</small></article>
    <article><span>Pending verification</span><strong>{overview?.pendingVerifications??0}</strong><small>Accounts waiting for a code</small></article>
    <article><span>Messages</span><strong>{overview?.messages??0}</strong><small><MessageSquareText size={13}/> Stored messages</small></article>
    <article><span>Communities</span><strong>{overview?.communities??0}</strong><small>Relay servers</small></article>
   </div>
   <section className="admin-section">
    <div className="admin-section-heading"><div><h2>Accounts</h2><p>Recent users and verification status</p></div><span>{users.length} shown</span></div>
    <form className="admin-search" onSubmit={e=>{e.preventDefault();void load(query);}}><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search username or email" aria-label="Search accounts"/><Button type="submit" variant="secondary" disabled={refreshing}>Search</Button></form>
    <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Account</th><th>Email</th><th>Status</th><th>Joined</th></tr></thead><tbody>
     {users.map(account=><tr key={account.id}><td><strong>{account.username}</strong>{account.is_admin&&<small>Administrator</small>}</td><td>{account.email}</td><td><span className={account.email_verified?'admin-status verified':'admin-status pending'}>{account.email_verified?'Verified':'Pending'}</span></td><td>{account.created_at?new Date(account.created_at).toLocaleDateString():'—'}</td></tr>)}
     {!users.length&&<tr><td colSpan={4} className="admin-empty">No accounts match this search.</td></tr>}
    </tbody></table></div>
   </section>
   <section className="admin-contact-note"><ShieldCheck size={18}/><div><strong>Contact tools are not connected yet</strong><p>Tell me how you want admins to reach users and I’ll add that workflow with the right permissions and audit trail.</p></div></section>
  </>}
 </div>;
}

function PasswordRecovery({reset=false}:{reset?:boolean}){
 const [email,setEmail]=useState('');const [password,setPassword]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');const [recoveryConfigured,setRecoveryConfigured]=useState<boolean|null>(null);const navigate=useNavigate();const toast=useToast();
 useEffect(()=>{if(reset)return;let active=true;api<{passwordRecoveryConfigured?:boolean}>('/health').then(result=>{if(active&&typeof result.passwordRecoveryConfigured==='boolean')setRecoveryConfigured(result.passwordRecoveryConfigured);}).catch(()=>{});return()=>{active=false;};},[reset]);
 const submit=async(e:React.FormEvent)=>{e.preventDefault();setBusy(true);setError('');setNotice('');try{
  if(reset){const token=new URLSearchParams(window.location.search).get('token')||'';await post('/auth/reset-password',{token,password});toast.show('Password updated. Sign in with your new password.','success');navigate('/login');}
  else{const result=await post<{message:string}>('/auth/forgot-password',{email});setNotice(result.message||'If that email belongs to a Relay account, a reset link is on its way.');}
 }catch(err:any){setError(err.message||'Relay could not complete that request.');}finally{setBusy(false);}};
 return <main className="auth-screen"><div className="auth-layout"><AuthBrandPanel headline={reset?'Choose a new password.':'Let’s get you back to your people.'} description="Your Relay account keeps your conversations, friends, and communities connected."/><section className="auth-form-side"><div className="auth-form-top">Remembered it? <Link to="/login">Sign in</Link></div><div className="auth-card"><div className="auth-form-heading"><h1>{reset?'Reset your password':'Password recovery'}</h1><p>{reset?'Choose a new password for your Relay account.':recoveryConfigured===false?'Password recovery email is not enabled yet. Contact your Relay administrator for help.':recoveryConfigured===true?'We will email you a secure, one-time reset link.':'Checking whether password recovery is available…'}</p></div><form className="form-stack" onSubmit={submit}>{reset?<Field label="New password"><input type="password" autoComplete="new-password" minLength={10} maxLength={128} required value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 10 characters"/></Field>:<Field label="Account email"><input type="email" autoComplete="email" maxLength={254} required value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"/></Field>}{error&&<div className="form-error" role="alert">{error}</div>}{notice&&<div className="form-success" role="status">{notice}</div>}<Button type="submit" disabled={busy}>{busy?'Please wait…':reset?'Update password':'Send reset link'} <ArrowRight size={16}/></Button></form></div></section></div></main>;
}

function Protected(){const {user,loading}=useAuth();if(loading)return <Loading label="Checking session"/>;if(!user)return <Navigate to="/login" replace/>;return <Shell key={user.id}/>;}
function NotFound(){return <div className="not-found"><div className="notfound-code">404</div><h1>Lost in the channels?</h1><p>This route does not exist. It happens. URLs are surprisingly easy to mistype.</p><Link to="/home" className="btn primary"><ArrowLeft size={16}/> Back to Relay</Link></div>;}
function AppRoutes(){const {user,loading}=useAuth();if(loading)return <Loading label="Starting Relay"/>;return <Routes>
 <Route path="/login" element={<AuthScreen mode="login"/>}/><Route path="/register" element={<AuthScreen mode="register"/>}/><Route path="/verify-email" element={<EmailVerificationScreen/>}/><Route path="/forgot-password" element={<PasswordRecovery/>}/><Route path="/reset-password" element={<PasswordRecovery reset/>}/>
 <Route element={<Protected/>}>
  <Route path="/" element={<Navigate to="/channels/@me" replace/>}/><Route path="/home" element={<HomePage/>}/><Route path="/channels/@me" element={<DmPage/>}/><Route path="/channels/@me/:conversationId" element={<DmPage/>}/>
  <Route path="/admin" element={<AdminPanel/>}/>
  <Route path="/channels/:serverId/:channelId?" element={<ChannelPage/>}/><Route path="/discover" element={<DiscoverPage/>}/><Route path="/friends" element={<FriendsPage/>}/><Route path="/events" element={<EventsPage/>}/><Route path="/inbox" element={<InboxPage/>}/><Route path="/help" element={<HelpPage/>}/>
  <Route path="/library" element={<InfoPage kind="library"/>}/><Route path="/activities" element={<InfoPage kind="library"/>}/><Route path="/premium" element={<InfoPage kind="premium"/>}/><Route path="/shop" element={<InfoPage kind="shop"/>}/>
  <Route path="/profile/:userId" element={<ProfilePage/>}/><Route path="/invite/:inviteCode" element={<InvitePage/>}/>
  <Route path="/settings" element={<Navigate to="/settings/account" replace/>}/><Route path="/settings/:section" element={<SettingsPage/>}/>
  <Route path="/server/:serverId/settings" element={<Navigate to="overview" replace/>}/><Route path="/server/:serverId/settings/:section" element={<ServerSettingsPage/>}/>
 </Route>
 <Route path="*" element={user?<NotFound/>:<Navigate to="/login" replace/>}/>
 </Routes>;}
export default function App(){return <AuthProvider><ToastProvider><AppRoutes/></ToastProvider></AuthProvider>;}
