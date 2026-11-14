import React,{useState} from 'react';
import {Navigate,Route,Routes,Link,useNavigate} from 'react-router-dom';
import {ArrowLeft,ArrowRight,AtSign,LockKeyhole,Mail,MessageSquare,ShieldCheck,Sparkles,UserPlus,Users} from 'lucide-react';
import {AuthProvider,useAuth,ToastProvider,useToast,announceAuthChange} from './state';
import {post} from './api';
import Shell from './components/Shell';
import {Button,Field,Loading} from './components/ui';
import {HomePage,FriendsPage,DiscoverPage,ProfilePage,InvitePage,EventsPage,InfoPage,InboxPage,HelpPage} from './pages/CorePages';
import {ChannelPage,DmPage} from './pages/ChatPages';
import {SettingsPage,ServerSettingsPage} from './pages/SettingsPages';

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
   const result=isRegister
    ? await post<any>('/auth/register',{email,username,password})
    : await post<any>('/auth/login',{login,password});
   setUser(result.user);
   announceAuthChange();
   await refresh();
   navigate('/home');
   toast.show(isRegister?'Your Relay account is ready.':'Welcome back to Relay.','success');
  }catch(err:any){
   setError(err.message||'Relay could not complete that request.');
  }finally{
   setBusy(false);
  }
 };

 return <main className="auth-screen">
  <div className="auth-layout">
   <section className="auth-showcase">
    <Link to="/login" className="auth-brand" aria-label="Relay home">
     <span className="brand-mark">R</span><span>relay</span>
    </Link>
    <div className="auth-showcase-content">
     <div className="auth-kicker"><i/> A better place to connect</div>
     <h1>Your people.<br/><em>Your space.</em></h1>
     <p>Bring your communities, conversations, and everyday moments together in one space that feels like yours.</p>
     <div className="auth-features">
      <div className="auth-feature"><span><MessageSquare size={16}/></span> Conversations that stay in sync</div>
      <div className="auth-feature"><span><Users size={16}/></span> Communities built around your people</div>
      <div className="auth-feature"><span><ShieldCheck size={16}/></span> Tools that put your community in control</div>
     </div>
    </div>
    <div className="auth-showcase-footer"><Sparkles size={13}/> Made for the moments worth sharing.</div>
   </section>

   <section className="auth-form-side">
    <div className="auth-form-top">
     {isRegister?'Already part of Relay?':isForgot?'Remember your password?':'New to Relay?'}
     <Link to={isRegister||isForgot?'/login':'/register'}>{isRegister||isForgot?'Sign in':'Create an account'}</Link>
    </div>

    <div className="auth-card">
     <div className="auth-icon">{isForgot?<Mail size={21}/>:isRegister?<UserPlus size={21}/>:<LockKeyhole size={21}/>}</div>
     <div className="auth-form-heading">
      <small>{isForgot?'ACCOUNT RECOVERY':isRegister?'GET STARTED':'MEMBER ACCESS'}</small>
      <h1>{isForgot?'Password reset':isRegister?'Create your account':'Welcome back'}</h1>
      <p>{isForgot
       ? 'Password-reset email is not configured on this server, so Relay cannot send a reset link. Contact your server administrator for account recovery.'
       : isRegister
        ? 'Set up your account and find your people on Relay.'
        : 'Sign in to pick up right where your community left off.'}</p>
     </div>

     {!isForgot&&<form onSubmit={submit} className="form-stack">
      {isRegister
       ? <>
          <Field label="Email address">
           <input value={email} onChange={e=>setEmail(e.target.value)} type="email" autoComplete="email" maxLength={254} required placeholder="you@example.com"/>
          </Field>
          <Field label="Username">
           <input value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" minLength={3} maxLength={24} required pattern="[A-Za-z0-9_.-]+" placeholder="Choose a username"/>
          </Field>
         </>
       : <Field label="Email or username">
          <div className="auth-input-wrap"><AtSign size={15}/><input value={login} onChange={e=>setLogin(e.target.value)} autoComplete="username" required placeholder="Enter your email or username"/></div>
         </Field>}
      <Field label="Password">
       <div className="auth-input-wrap"><LockKeyhole size={15}/><input value={password} onChange={e=>setPassword(e.target.value)} type="password" autoComplete={isRegister?'new-password':'current-password'} minLength={isRegister?10:1} maxLength={128} required placeholder={isRegister?'At least 10 characters':'Your password'}/></div>
      </Field>
      {error&&<div className="form-error" role="alert">{error}</div>}
      <Button type="submit" disabled={busy}>{busy?'Please wait…':isRegister?'Create account':'Sign in'} <ArrowRight size={16}/></Button>
     </form>}

     <div className="auth-bottom">
      {isForgot
       ? <Link to="/login"><ArrowLeft size={13}/> Back to sign in</Link>
       : isRegister
        ? <>Already registered? <Link to="/login">Sign in instead</Link></>
        : <><Link to="/forgot-password">Forgot password?</Link><span className="auth-bottom-note">Protected sign-in</span></>}
     </div>
    </div>

    <div className="auth-footer">
     <span>Relay is an original community app and is not affiliated with Discord.</span>
     <span className="auth-footer-left">By continuing, you agree to use Relay respectfully and keep your account secure.</span>
    </div>
   </section>
  </div>
 </main>;
}

function Protected(){const {user,loading}=useAuth();if(loading)return <Loading label="Checking session"/>;if(!user)return <Navigate to="/login" replace/>;return <Shell/>;}
function NotFound(){return <div className="not-found"><div className="notfound-code">404</div><h1>Lost in the channels?</h1><p>This route does not exist. It happens. URLs are surprisingly easy to mistype.</p><Link to="/home" className="btn primary"><ArrowLeft size={16}/> Back to Relay</Link></div>;}
function AppRoutes(){const {user,loading}=useAuth();if(loading)return <Loading label="Starting Relay"/>;return <Routes>
 <Route path="/login" element={<AuthScreen mode="login"/>}/><Route path="/register" element={<AuthScreen mode="register"/>}/><Route path="/forgot-password" element={<AuthScreen mode="forgot"/>}/>
 <Route element={<Protected/>}>
  <Route path="/" element={<Navigate to="/home" replace/>}/><Route path="/home" element={<HomePage/>}/><Route path="/channels/@me" element={<HomePage/>}/><Route path="/channels/@me/:conversationId" element={<DmPage/>}/>
  <Route path="/channels/:serverId/:channelId?" element={<ChannelPage/>}/><Route path="/discover" element={<DiscoverPage/>}/><Route path="/friends" element={<FriendsPage/>}/><Route path="/events" element={<EventsPage/>}/><Route path="/inbox" element={<InboxPage/>}/><Route path="/help" element={<HelpPage/>}/>
  <Route path="/library" element={<InfoPage kind="library"/>}/><Route path="/activities" element={<InfoPage kind="library"/>}/><Route path="/premium" element={<InfoPage kind="premium"/>}/><Route path="/shop" element={<InfoPage kind="shop"/>}/>
  <Route path="/profile/:userId" element={<ProfilePage/>}/><Route path="/invite/:inviteCode" element={<InvitePage/>}/>
  <Route path="/settings" element={<Navigate to="/settings/account" replace/>}/><Route path="/settings/:section" element={<SettingsPage/>}/>
  <Route path="/server/:serverId/settings" element={<Navigate to="overview" replace/>}/><Route path="/server/:serverId/settings/:section" element={<ServerSettingsPage/>}/>
 </Route>
 <Route path="*" element={user?<NotFound/>:<Navigate to="/login" replace/>}/>
 </Routes>;}
export default function App(){return <AuthProvider><ToastProvider><AppRoutes/></ToastProvider></AuthProvider>;}
