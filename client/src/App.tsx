import React,{useState} from 'react';
import {Navigate,Route,Routes,Link,useNavigate} from 'react-router-dom';
import {ArrowLeft,AtSign,LockKeyhole,Mail,MessageSquare,ShieldCheck,Sparkles,UserPlus} from 'lucide-react';
import {AuthProvider,useAuth,ToastProvider,useToast,announceAuthChange} from './state';
import {api,post} from './api';
import Shell from './components/Shell';
import {Button,Field,Loading} from './components/ui';
import {HomePage,FriendsPage,DiscoverPage,ProfilePage,InvitePage,EventsPage,InfoPage,InboxPage,HelpPage} from './pages/CorePages';
import {ChannelPage,DmPage} from './pages/ChatPages';
import {SettingsPage,ServerSettingsPage} from './pages/SettingsPages';

function AuthScreen({mode}:{mode:'login'|'register'|'forgot'}){
 const {user,setUser,refresh}=useAuth();const navigate=useNavigate();const toast=useToast();const [login,setLogin]=useState('');const [email,setEmail]=useState('');const [username,setUsername]=useState('');const [password,setPassword]=useState('');const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 if(user)return <Navigate to="/home" replace/>;
 if(mode==='forgot')return <div className="auth-screen"><div className="auth-brand"><span className="brand-mark">R</span><span>relay</span></div><div className="auth-card"><div className="auth-icon"><LockKeyhole size={22}/></div><h1>Password reset</h1><p>Password-reset email is not configured on this server, so Relay cannot send a reset link. Contact your server administrator for account recovery.</p><div className="auth-bottom"><Link to="/login">Back to sign in</Link></div></div><div className="auth-footer">Relay account recovery requires a configured email provider.</div></div>;
 const submit=async(e:React.FormEvent)=>{e.preventDefault();setBusy(true);setError('');try{
   const r=mode==='login'?await post<any>('/auth/login',{login,password}):await post<any>('/auth/register',{email,username,password});
   setUser(r.user);announceAuthChange();await refresh();navigate('/home');toast.show(mode==='login'?'Signed in.':'Account created.','success');
  }catch(err:any){setError(err.message);}finally{setBusy(false);}};
 return <div className="auth-screen"><div className="auth-brand"><span className="brand-mark">R</span><span>relay</span></div><div className="auth-card"><div className="auth-icon"><Sparkles size={22}/></div><h1>{mode==='login'?'Welcome back':'Create your account'}</h1><p>{mode==='login'?'Sign in and pick up the conversation.':'A place for your people, projects, and communities.'}</p>
  <form onSubmit={submit} className="form-stack">{mode==='register'?<><Field label="Email address"><input value={email} onChange={e=>setEmail(e.target.value)} type="email" autoComplete="email" maxLength={254} required placeholder="you@example.com"/></Field><Field label="Username"><input value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" minLength={3} maxLength={24} required pattern="[A-Za-z0-9_.-]+" placeholder="Choose a username"/></Field></>:<Field label="Email or username"><input value={login} onChange={e=>setLogin(e.target.value)} autoComplete="username" required placeholder="Enter your email or username"/></Field>}
   <Field label="Password"><input value={password} onChange={e=>setPassword(e.target.value)} type="password" autoComplete={mode==='login'?'current-password':'new-password'} minLength={mode==='register'?10:1} maxLength={128} required placeholder={mode==='register'?'At least 10 characters':'Your password'}/></Field>
   {error&&<div className="form-error" role="alert">{error}</div>}
   <Button type="submit" disabled={busy}>{busy?'Please wait…':mode==='login'?'Sign in':'Create account'}</Button>
  </form>
  <div className="auth-bottom">{mode==='login'?<>New to Relay? <Link to="/register">Create an account</Link><Link to="/forgot-password">Forgot password?</Link></>:mode==='register'?<>Already registered? <Link to="/login">Sign in</Link></>:<Link to="/login">Back to sign in</Link>}</div>
 </div><div className="auth-footer">Relay is an original community app and is not affiliated with Discord.</div></div>;
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
