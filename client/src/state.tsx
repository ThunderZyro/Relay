import React,{createContext,useCallback,useContext,useEffect,useState} from 'react';
import {api,ApiError} from './api';
import type {PublicUser} from '../../shared/types';
export type User=PublicUser;
type AuthValue={user:User|null;loading:boolean;refresh:()=>Promise<void>;setUser:(u:User|null)=>void};
const AuthContext=createContext<AuthValue>({user:null,loading:true,refresh:async()=>{},setUser:()=>{}});
const AUTH_SYNC_KEY='relay-auth-session-changed';

// Notify other tabs that the shared HttpOnly cookie may now represent another account.
// No credential or session token is ever written to browser storage.
export function announceAuthChange(){
 try{localStorage.setItem(AUTH_SYNC_KEY,`${Date.now()}-${Math.random().toString(36).slice(2)}`);}catch{/* Storage can be disabled; focus refresh remains available. */}
}

export function AuthProvider({children}:{children:React.ReactNode}){
 const [user,setUser]=useState<User|null>(null);const [loading,setLoading]=useState(true);
 const refresh=useCallback(async()=>{try{const r=await api<{user:User}>('/auth/me');setUser(r.user);}catch(error){if(error instanceof ApiError&&error.status===401)setUser(null);}finally{setLoading(false);}},[]);
 useEffect(()=>{
  void refresh();
  const refreshWhenActive=()=>{if(document.visibilityState==='visible')void refresh();};
  const onStorage=(event:StorageEvent)=>{if(event.key===AUTH_SYNC_KEY)void refresh();};
  window.addEventListener('focus',refreshWhenActive);
  document.addEventListener('visibilitychange',refreshWhenActive);
  window.addEventListener('storage',onStorage);
  return()=>{window.removeEventListener('focus',refreshWhenActive);document.removeEventListener('visibilitychange',refreshWhenActive);window.removeEventListener('storage',onStorage);};
 },[refresh]);
 return <AuthContext.Provider value={{user,loading,refresh,setUser}}>{children}</AuthContext.Provider>;
}
export const useAuth=()=>useContext(AuthContext);

type Toast={id:number;message:string;kind:'success'|'error'|'info'};
type ToastValue={show:(message:string,kind?:Toast['kind'])=>void};
const ToastContext=createContext<ToastValue>({show:()=>{}});
export function ToastProvider({children}:{children:React.ReactNode}){
 const [items,setItems]=useState<Toast[]>([]);
 const show=(message:string,kind:Toast['kind']='info')=>{const id=Date.now()+Math.random();setItems(v=>[...v,{id,message,kind}]);window.setTimeout(()=>setItems(v=>v.filter(t=>t.id!==id)),4200);};
 return <ToastContext.Provider value={{show}}>{children}<div className="toast-stack" aria-live="polite">{items.map(t=><div className={`toast ${t.kind}`} key={t.id}>{t.message}<button aria-label="Dismiss notification" onClick={()=>setItems(v=>v.filter(x=>x.id!==t.id))}>×</button></div>)}</div></ToastContext.Provider>;
}
export const useToast=()=>useContext(ToastContext);
