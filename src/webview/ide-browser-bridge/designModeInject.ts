/** Thin page-realm half of hybrid D: hit-test, outline, serialize, and navigation signal only. */
import type { DmThemeCssVars } from "./themeTokens.js";

const STYLE_KEYS = ["color","backgroundColor","fontSize","fontWeight","fontFamily","display","padding","margin","border","borderRadius","width","height","position","flexDirection","gap","justifyContent","alignItems"] as const;
export type DesignModeInjectOptions = { bindingName: string; themeVars?: DmThemeCssVars; restorePickMode?: boolean };

export function buildDesignModeInjectExpression(bindingNameOrOptions: string | DesignModeInjectOptions): string {
  const opts = typeof bindingNameOrOptions === "string" ? { bindingName: bindingNameOrOptions } : bindingNameOrOptions;
  const focus = opts.themeVars?.["--ds-focus"] ?? "#007fd4";
  return `(() => {
    const BIND=${JSON.stringify(opts.bindingName)}, STYLE_KEYS=${JSON.stringify([...STYLE_KEYS])};
    if(window.__tachyonDmCleanup)try{window.__tachyonDmCleanup()}catch{}
    window.__tachyonDmQueue=window.__tachyonDmQueue||[];
    let pickMode=${JSON.stringify(opts.restorePickMode !== false)},hover=null;
    const post=(value)=>{const raw=JSON.stringify(value);window.__tachyonDmQueue.push(raw);try{if(typeof window[BIND]==='function')window[BIND](raw)}catch{}};
    const root=document.createElement('div');root.id='tachyon-dm-root';root.setAttribute('aria-hidden','true');
    Object.assign(root.style,{position:'fixed',display:'none',pointerEvents:'none',zIndex:'2147483646',border:'2px solid ${focus}',boxSizing:'border-box',borderRadius:'2px'});document.documentElement.appendChild(root);
    const clear=()=>{hover=null;root.style.display='none'};
    const show=(el)=>{const r=el.getBoundingClientRect();hover=el;Object.assign(root.style,{display:'block',left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'})};
    const move=(e)=>{if(!pickMode)return;const el=document.elementFromPoint(e.clientX,e.clientY);if(el&&el!==root&&el!==hover)show(el)};
    const capture=(el)=>{const r=el.getBoundingClientRect(),cs=getComputedStyle(el),styles={};for(const k of STYLE_KEYS)styles[k]=cs[k]||'';return{url:location.href,tag:el.tagName,id:el.id||'',className:typeof el.className==='string'?el.className:'',text:(el.innerText||el.textContent||'').trim().slice(0,2000),html:el.outerHTML.slice(0,12000),bounds:{x:r.x,y:r.y,width:r.width,height:r.height},styles}};
    const click=(e)=>{if(!pickMode)return;const el=document.elementFromPoint(e.clientX,e.clientY);if(!el||el===root)return;e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();post(capture(el));clear()};
    const key=(e)=>{if(e.key==='Escape'){pickMode=false;clear()}};
    const nav=(e)=>{const target=e.target instanceof Element?e.target:null;if(target?.closest('a[href],form'))post({__layout:'internalNav'})};
    const setPick=(on)=>{pickMode=!!on;if(!pickMode)clear();return pickMode};window.__tachyonDmSetPickMode=setPick;
    document.addEventListener('mousemove',move,true);document.addEventListener('click',click,true);document.addEventListener('click',nav,true);document.addEventListener('submit',nav,true);document.addEventListener('keydown',key,true);
    window.__tachyonDmCleanup=()=>{document.removeEventListener('mousemove',move,true);document.removeEventListener('click',click,true);document.removeEventListener('click',nav,true);document.removeEventListener('submit',nav,true);document.removeEventListener('keydown',key,true);root.remove();delete window.__tachyonDmSetPickMode;delete window.__tachyonDmCleanup};
    return true;
  })()`;
}
