import { CANVAS_MIN_HEIGHT, CANVAS_MAX_HEIGHT } from './canvasDocument';

// Only this fixed script is executable. Transcript strings never enter script, CSS or attributes unescaped.
export const SNAPSHOT_SCRIPT = String.raw`
const one=(selector,root=document)=>root.querySelector(selector);
const all=(selector,root=document)=>Array.from(root.querySelectorAll(selector));
const search=one('[data-search]');
const searchBar=one('.search-bar');
const panel=one('.aside');
const panelToggle=one('[data-toggle-panel]');
const closePanel=()=>{panel.hidden=true;panelToggle.setAttribute('aria-expanded','false')};
const showPanel=id=>{panel.hidden=false;panelToggle.setAttribute('aria-expanded','true');all('.panel-content').forEach(content=>content.hidden=content.id!==id);panel.scrollTop=0;one('[data-close]',panel).focus()};
const applySearch=()=>{const query=search.value.trim().toLocaleLowerCase();const turns=all('.turn');let shown=0;turns.forEach(turn=>{turn.hidden=query!==''&&!turn.textContent.toLocaleLowerCase().includes(query);if(!turn.hidden)shown++});one('[data-search-count]').textContent=query===''?'':shown+' / '+turns.length;one('.no-matches').hidden=shown>0};
const closeSearch=()=>{search.value='';applySearch();searchBar.hidden=true};
const copyText=async text=>{if(navigator.clipboard&&window.isSecureContext)return navigator.clipboard.writeText(text);const input=document.createElement('textarea');input.value=text;input.style.cssText='position:fixed;opacity:0';document.body.append(input);input.select();const copied=document.execCommand('copy');input.remove();if(!copied)throw Error('copy')};
search.addEventListener('input',applySearch);
addEventListener('message',event=>{const frame=all('iframe.canvas-frame').find(item=>item.contentWindow===event.source);const height=event.data&&event.data.type==='omc-canvas-height'?Number(event.data.height):NaN;if(frame&&Number.isFinite(height))frame.style.height=Math.min(${CANVAS_MAX_HEIGHT},Math.max(${CANVAS_MIN_HEIGHT},Math.ceil(height)))+'px'});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){closePanel();closeSearch()}if(event.key==='/'&&!/^(INPUT|TEXTAREA)$/.test(event.target.tagName)){event.preventDefault();searchBar.hidden=false;search.focus()}});
document.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button)return;
if(button.hasAttribute('data-toggle-panel')){if(panel.hidden)showPanel('snapshot-info');else closePanel()}
if(button.hasAttribute('data-close')){closePanel();panelToggle.focus()}
if(button.hasAttribute('data-panel'))showPanel(button.dataset.panel);
if(button.hasAttribute('data-toggle-search')){if(searchBar.hidden){searchBar.hidden=false;search.focus()}else closeSearch()}
if(button.hasAttribute('data-expand'))all('.turn details').forEach(detail=>detail.open=true);
if(button.hasAttribute('data-collapse'))all('.turn details').forEach(detail=>detail.open=false);
if(button.hasAttribute('data-print'))window.print();
if(button.hasAttribute('data-view')){const figure=button.closest('figure');all('.figure-content',figure).forEach(content=>content.hidden=content.id!==button.dataset.view);all('[data-view]',figure).forEach(tab=>tab.setAttribute('aria-pressed',String(tab===button)))}
if(button.hasAttribute('data-copy')){const frame=button.closest('.code-frame');const text=frame?one('pre',frame).innerText:all('.answer-text',button.closest('.answer')).map(markdown=>markdown.innerText).join('\n\n');const label=one('[data-copy-label]',button);const words=document.body.dataset;let state='copied';try{await copyText(text)}catch{state='failed'}button.dataset.state=state;label.textContent=state==='copied'?words.copied:words.copyFailed;clearTimeout(button.resetTimer);button.resetTimer=setTimeout(()=>{delete button.dataset.state;label.textContent=words.copy},state==='copied'?1600:4000)}
if(button.hasAttribute('data-sort')){const table=button.closest('table');const column=Number(button.dataset.sort);const ascending=button.dataset.direction!=='ascending';all('th',table).forEach(header=>header.removeAttribute('aria-sort'));all('[data-sort]',table).forEach(other=>{if(other!==button)delete other.dataset.direction});button.dataset.direction=ascending?'ascending':'descending';button.closest('th').setAttribute('aria-sort',button.dataset.direction);const rows=Array.from(table.tBodies[0].rows);rows.sort((left,right)=>{const first=left.cells[column].textContent;const second=right.cells[column].textContent;const order=first.trim()!==''&&second.trim()!==''&&Number.isFinite(Number(first))&&Number.isFinite(Number(second))?Number(first)-Number(second):first.localeCompare(second,undefined,{numeric:true});return ascending?order:-order});rows.forEach(row=>table.tBodies[0].append(row))}
});`;
