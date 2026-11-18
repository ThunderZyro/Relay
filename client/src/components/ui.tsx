import React,{useEffect,useId,useRef} from 'react';
import { X, Search, LoaderCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export function Button({ children, variant = 'primary', className = '', type = 'button', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button type={type} {...props} className={`btn ${variant} ${className}`.trim()}>{children}</button>;
}
export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
export function Avatar({ name, src, size = 'md', presence }: { name: string; src?: string | null; size?: 'sm'|'md'|'lg'|'xl'; presence?: string }) {
  return <span className={`avatar ${size}`} aria-label={name}>{src ? <img src={src} alt=""/> : <span>{(name.trim()[0] || '?').toUpperCase()}</span>}{presence && <i className={`presence-dot ${presence}`} />}</span>;
}
export function Loading({ label = 'Loading' }: { label?: string }) {
  return <div className="loading-state"><LoaderCircle size={20} className="spin"/><span>{label}</span></div>;
}
type ModalStackEntry={element:HTMLElement;close:()=>void};
const modalStack:ModalStackEntry[]=[];

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }) {
  const titleId=useId();const dialogRef=useRef<HTMLElement>(null);const closeRef=useRef(onClose);closeRef.current=onClose;
  useEffect(()=>{
    const previous=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const dialog=dialogRef.current;
    if(!dialog)return;
    const entry:ModalStackEntry={element:dialog,close:()=>closeRef.current()};
    modalStack.push(entry);
    const isTop=()=>modalStack[modalStack.length-1]===entry;
    const focusable=()=>Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')).filter(el=>el.getAttribute('aria-hidden')!=='true');
    (focusable()[0]||dialog).focus();
    const onKeyDown=(event:KeyboardEvent)=>{
      if(!isTop())return;
      if(event.key==='Escape'){event.preventDefault();entry.close();return;}
      if(event.key!=='Tab')return;
      const items=focusable();if(!items.length){event.preventDefault();dialog?.focus();return;}
      const first=items[0],last=items[items.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    };
    document.addEventListener('keydown',onKeyDown);
    return()=>{
      document.removeEventListener('keydown',onKeyDown);
      const index=modalStack.indexOf(entry);
      if(index>=0)modalStack.splice(index,1);
      if(previous?.isConnected)previous.focus();
    };
  },[]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><header><h2 id={titleId}>{title}</h2><button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X size={18}/></button></header><div className="modal-body">{children}</div>{footer && <footer className="modal-footer">{footer}</footer>}</section></div>;
}
export function SearchInput({ value, onChange, placeholder = 'Search' }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <label className="search-input"><Search size={16}/><input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}/></label>;
}
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return <header className="page-header"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{actions && <div className="page-header-actions">{actions}</div>}</header>;
}
export function EmptyState({ title, description, action, icon: Icon }: { title: string; description?: string; action?: React.ReactNode; icon?: LucideIcon }) {
  return <div className="empty-state">{Icon && <Icon size={28}/>}<h3>{title}</h3>{description && <p>{description}</p>}{action}</div>;
}
