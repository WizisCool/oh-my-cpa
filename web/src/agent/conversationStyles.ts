import { THREAD_RADII } from '../theme/palette';

// Mirrors the conversation workspace hierarchy using only resolved OMC tokens. The four tokens a
// caller may leave out fall back to their nearest authored neighbour, so a partial palette still reads.
export const SNAPSHOT_CSS = `
:root {
  --radius-document: ${THREAD_RADII.document}px;
  --radius-control: ${THREAD_RADII.control}px;
  --radius-surface: ${THREAD_RADII.surface}px;
  --radius-thread: ${THREAD_RADII.thread}px;
  --thread-field: color-mix(in srgb, var(--fg) 5%, transparent);
  --thread-hairline: color-mix(in srgb, var(--fg) 12%, transparent);
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.65 "OMC Snapshot",ui-monospace,"SF Mono",Menlo,Consolas,monospace;-webkit-font-smoothing:antialiased}
button,input{font:inherit;color:inherit}
button{display:inline-flex;align-items:center;gap:6px;margin:0;padding:0;border:0;border-radius:4px;background:none;cursor:pointer}
button:focus-visible,input:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
a{color:var(--accent);text-decoration:underline;text-underline-offset:2px;overflow-wrap:anywhere}
svg{flex-shrink:0}
[hidden]{display:none!important}
::selection{background:var(--accent);color:var(--bg)}

.workspace{height:100svh;display:flex;flex-direction:column}
.workspace-head{display:flex;align-items:center;gap:14px;min-height:56px;padding:10px 24px;border-bottom:1px solid var(--border);flex-shrink:0}
.brand{width:96px;height:auto;display:block}
.head-rule{width:1px;height:16px;background:var(--border)}
.workspace-head h1{flex:1;min-width:0;margin:0;font-size:14px;font-weight:700;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.actions{display:flex;align-items:center;gap:2px;margin-right:-8px}
.icon-button{justify-content:center;width:32px;height:32px;color:var(--muted)}
.icon-button:hover,.icon-button[aria-expanded=true]{color:var(--fg);background:var(--hover,var(--surface))}
.search-bar{display:flex;align-items:center;gap:10px;padding:0 24px;border-bottom:1px solid var(--border);color:var(--muted);flex-shrink:0}
.search-bar input{flex:1;min-width:0;height:40px;padding:0;border:0;background:none;outline:0;color:var(--fg)}
.search-bar input::placeholder{color:var(--meta,var(--muted))}
.search-count{font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.workspace-body{display:flex;flex:1;min-height:0}
.transcript{flex:1;min-width:0;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.transcript-column{display:flex;flex-direction:column;gap:28px;max-width:808px;margin:0 auto;padding:20px 24px 24px}

.masthead{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 0;padding-bottom:12px;border-bottom:1px solid var(--border-soft,var(--border));font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.masthead span+span::before{content:"·";margin:0 8px;color:var(--meta,var(--muted))}
.masthead .masthead-model{color:var(--fg-2)}
.masthead .masthead-date{margin-left:auto}
.masthead .masthead-date::before{content:none}

.turn{display:flex;flex-direction:column;gap:16px;min-width:0;scroll-margin-top:16px}
.user-row{display:flex;flex-direction:column;align-items:flex-end}
.sent-files{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;max-width:min(80%,640px);margin-bottom:6px}
.sent-file{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:var(--radius-control);background:var(--thread-field);color:var(--fg-2);font-size:12px}
.sent-file[data-tone=accent]{background:color-mix(in srgb,var(--accent) 10%,transparent);color:var(--accent)}
.user{max-width:min(80%,640px);border-radius:var(--radius-thread);background:var(--thread-field);padding:8px 14px}
.user-text{white-space:pre-wrap;overflow-wrap:anywhere}
.user-images{display:flex;flex-wrap:wrap;gap:6px}
.user-text+.user-images{margin-top:8px}
.attachment{display:block;min-width:48px;min-height:48px;max-width:min(220px,100%);max-height:160px;object-fit:contain;border:1px solid var(--border);border-radius:4px;background:var(--bg)}
.attachment-omitted{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border:1px dashed var(--border);border-radius:4px;color:var(--muted);font-size:12px}
.answer{display:flex;flex-direction:column;gap:12px;min-width:0}
.message-head{display:flex;align-items:center;gap:8px;min-width:0;color:var(--muted);font-size:12px}
.message-model{color:var(--fg-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.status{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.pip{display:inline-block;width:7px;height:7px;flex-shrink:0;border-radius:2px;background:var(--meta,var(--muted))}
.pip[data-tone=success]{background:var(--success)}
.pip[data-tone=processing]{background:var(--accent)}
.pip[data-tone=warning]{background:var(--warn)}
.pip[data-tone=error]{background:var(--danger)}
.spacer{flex:1}
.turn-index{color:var(--meta,var(--muted));text-decoration:none;font-variant-numeric:tabular-nums}
.turn-index:hover{color:var(--fg-2)}
.message-foot{display:flex;align-items:center;flex-wrap:wrap;gap:4px 16px;min-height:28px;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.message-foot>span{white-space:nowrap}
.metric{display:inline-flex;align-items:center;gap:5px}
.foot-actions{display:inline-flex;align-items:center;gap:2px;margin-right:-8px}
.text-button{height:26px;padding:0 8px;color:var(--muted);font-size:12px;white-space:nowrap}
.text-button:hover{color:var(--fg);background:var(--hover,var(--surface))}
.text-button[data-state=copied]{color:var(--success)}
.text-button[data-state=failed]{color:var(--danger)}
.failure{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;margin:0;padding:10px 14px;border-radius:var(--radius-surface);background:color-mix(in srgb,var(--danger) 8%,transparent);font-size:12px;color:var(--fg-2)}
.failure code{color:var(--danger)}
.meta{font-size:12px;color:var(--muted)}
.no-matches{margin:0;padding:32px 0;text-align:center}
.omitted{margin:-12px 0 0}

/* The answer's working, drawn as the conversation draws it: a timeline of disclosures on a rail
   with reasoning in a quieter ink. The values are the thread's own. */
details>summary{list-style:none;cursor:pointer;user-select:none}
details>summary::-webkit-details-marker{display:none}
.caret{color:var(--meta,var(--muted));transition:transform 50ms}
details[open]>summary>.caret{transform:rotate(90deg)}
.reasoning{min-width:0;font-size:12px}
.reasoning-toggle{display:inline-flex;align-items:center;gap:6px;padding:2px 0;color:var(--muted);border-radius:4px}
.reasoning-toggle:hover{color:var(--fg-2)}
.step-mark-slot{display:inline-flex;align-items:center;justify-content:center}
.reasoning-body{margin-top:6px;color:var(--fg-2);font-size:12.5px;line-height:1.6}
.reasoning-body .markdown{color:inherit}
.chain{display:flex;flex-direction:column;min-width:0;font-size:12px}
.chain-toggle{display:inline-flex;align-items:center;gap:8px;align-self:flex-start;min-height:24px;padding:2px 0;color:var(--muted);border-radius:4px}
.chain-toggle:hover{color:var(--fg-2)}
.chain-icon{display:inline-flex;align-items:center;justify-content:center;width:14px;flex-shrink:0}
.chain-failed{color:var(--danger)}
.chain-failed::before{content:"·";margin-right:8px;color:var(--meta,var(--muted))}
.chain-body{position:relative;display:flex;flex-direction:column;gap:4px;min-width:0;padding:6px 0 4px}
.chain-body::before{content:"";position:absolute;top:0;bottom:10px;left:6.5px;width:1px;background:var(--thread-hairline)}
.chain-body [data-step-mark]{position:relative;z-index:1;width:14px;height:14px;flex-shrink:0;border-radius:50%;background:var(--bg);outline:3px solid var(--bg)}
.chain-body .reasoning-toggle{gap:8px;min-height:28px}
.chain-body .reasoning-body{margin:0 0 6px 22px}
.call{display:flex;flex-direction:column;min-width:0}
.call-row{display:flex;align-items:center;gap:8px;width:100%;min-width:0;min-height:28px;padding:3px 8px 3px 0;border-radius:var(--radius-control);color:var(--fg-2);font-size:12px}
.call-row:hover .call-title,.call details[open]>.call-row .call-title{color:var(--fg)}
.call-row:hover .caret{color:var(--fg-2)}
.call-mark{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex-shrink:0;border-radius:50%;color:var(--muted)}
.call-mark:empty::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--meta,var(--muted))}
.call-mark[data-tone=success]{color:var(--success)}
.call-mark[data-tone=error]{color:var(--danger)}
.call-mark[data-tone=processing]{color:var(--accent)}
.call-mark[data-tone=warning]{color:var(--warn)}
.call-title{flex-shrink:0;color:var(--fg-2);font-weight:500}
.call-args{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 6px;border-radius:var(--radius-document);background:var(--thread-field);color:var(--fg-2);font-size:11px}
.call-status{flex-shrink:0;color:var(--muted);font-size:11px;white-space:nowrap}
.call-status[data-tone=warning]{color:var(--warn)}
.call-status[data-tone=error]{color:var(--danger)}
.call-status[data-tone=processing]{color:var(--accent)}
.call-duration{flex-shrink:0;color:var(--meta,var(--muted));font-size:11px;font-variant-numeric:tabular-nums}
.call-failure{display:flex;flex-wrap:wrap;gap:2px 8px;padding:0 8px 4px 22px;color:var(--muted);font-size:11.5px;overflow-wrap:anywhere}
.call-failure code{color:var(--danger)}
.call-detail{display:flex;flex-direction:column;gap:10px;min-width:0;margin:2px 0 8px 22px;padding:10px 12px 12px;border-radius:var(--radius-surface);background:var(--thread-field)}
.call-facts{display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px;color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.call-name{color:var(--fg-2);font-size:11px}
.call-section{display:flex;flex-direction:column;gap:6px;min-width:0}
.call-section h4{margin:0;color:var(--muted);font-size:11px;font-weight:400;letter-spacing:.08em;text-transform:uppercase}
.call-section .code-frame{margin:0}
.call-section pre{max-height:280px}

.markdown{min-width:0;overflow-wrap:anywhere}
.markdown>*:first-child{margin-top:0}
.markdown>*:last-child{margin-bottom:0}
.markdown p,.markdown ul,.markdown ol,.markdown blockquote{margin:0 0 10px}
.markdown h1,.markdown h2,.markdown h3,.markdown h4,.markdown h5,.markdown h6{margin:18px 0 8px;font-size:14px;font-weight:700;line-height:1.4}
.markdown h1{font-size:16px}
.markdown ul,.markdown ol{padding-left:20px}
.markdown li+li{margin-top:2px}
.markdown li::marker{color:var(--muted)}
.markdown blockquote{padding-left:12px;border-left:2px solid var(--border);color:var(--fg-2)}
.markdown hr{border:0;border-top:1px solid var(--border);margin:16px 0}
.markdown :not(pre)>code{padding:1px 5px;border:1px solid var(--border-soft,var(--border));border-radius:3px;background:var(--surface);font-size:.92em}
.markdown input[type=checkbox]{margin:0 6px 0 0;accent-color:var(--accent)}
pre,code{font-family:inherit}
.code-frame{margin:0 0 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);overflow:hidden}
.code-head{display:flex;align-items:center;min-height:30px;padding:0 4px 0 12px;border-bottom:1px solid var(--border-soft,var(--border));color:var(--muted);font-size:11px}
.code-lang{flex:1;letter-spacing:.04em}
.code-frame pre{margin:0;padding:10px 12px;max-height:480px;overflow:auto;white-space:pre;font-size:12.5px;line-height:1.6;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.table-scroll{max-width:100%;margin:0 0 10px;overflow-x:auto;border:1px solid var(--border);border-radius:4px;background:var(--bg);scrollbar-width:thin;scrollbar-color:var(--border) transparent}
table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
caption{position:absolute;clip-path:inset(50%);width:1px;height:1px;overflow:hidden}
th{padding:7px 12px;border-bottom:1px solid var(--border);background:var(--surface);color:var(--muted);font-size:12px;font-weight:500;white-space:nowrap}
th:not([align]){text-align:start}
td{padding:7px 12px;border-bottom:1px solid var(--border-soft,var(--border));vertical-align:top;overflow-wrap:anywhere}
tr:last-child td{border-bottom:0}
th button{gap:4px;color:inherit;font-size:inherit;font-weight:inherit}
th button:hover{color:var(--fg)}
th button::after{content:"";width:8px;color:var(--fg-2)}
th[aria-sort=ascending] button::after{content:"↑"}
th[aria-sort=descending] button::after{content:"↓"}
th[aria-sort] button{color:var(--fg)}

figure{display:flex;flex-direction:column;gap:8px;min-width:0;margin:0;padding:12px;border:1px solid var(--thread-hairline);border-radius:var(--radius-document);background:var(--surface)}
figure[data-frame=none]{padding:0;border:0;background:none}
figure .table-scroll{margin:0}
/* An interface keeps OpenUI's own stylesheet; the document lends it the console's two typefaces. */
.interface{--font-ui:"OMC Snapshot",ui-monospace,"SF Mono",Menlo,Consolas,monospace;--font-mono:var(--font-ui);display:block;min-width:0}

.snapshot-foot{display:flex;flex-direction:column;gap:4px;padding-top:14px;border-top:1px solid var(--border-soft,var(--border));font-size:12px;color:var(--muted)}
.snapshot-foot p{margin:0}

.aside{flex-shrink:0;width:380px;border-left:1px solid var(--border);overflow-y:auto;padding:0 16px 20px;background:var(--bg);scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.aside-head{display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:1;min-height:48px;margin:0 -16px 16px;padding:0 8px 0 16px;background:var(--bg);border-bottom:1px solid var(--border);font-size:12px;color:var(--muted)}
.panel-content{display:flex;flex-direction:column;gap:10px;min-width:0}
.panel-content h2{margin:0;font-size:14px;line-height:1.4;overflow-wrap:anywhere}
.panel-content h3{margin:10px 0 -2px;font-size:11px;font-weight:400;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.panel-content p{margin:0}
.panel-content .code-frame{margin:0}
.panel-content pre{white-space:pre-wrap;overflow-wrap:anywhere}
.panel-sub{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}
.panel-sub code{color:var(--fg-2)}
.facts{display:grid;grid-template-columns:auto 1fr;gap:0;margin:0;border:1px solid var(--border);border-radius:4px;font-size:12px;font-variant-numeric:tabular-nums}
.facts dt,.facts dd{margin:0;padding:6px 12px;border-bottom:1px solid var(--border-soft,var(--border))}
.facts dt{color:var(--muted)}
.facts dd{text-align:right;overflow-wrap:anywhere}
.facts dt:last-of-type,.facts dd:last-of-type{border-bottom:0}
.panel-controls{display:flex;gap:8px;flex-wrap:wrap}
.panel-controls .text-button{border:1px solid var(--border)}

.image-capture{width:840px}
.image-capture .workspace{height:auto}
.image-capture .workspace-head{min-height:0;padding:28px 40px 0;border-bottom:0}
.image-capture .workspace-body{display:block}
.image-capture .transcript{overflow:visible}
.image-capture .transcript-column{max-width:none;padding:14px 40px 28px}
.image-capture .actions,.image-capture .search-bar,.image-capture .aside,.image-capture .foot-actions,.image-capture .code-head button,.image-capture .turn-index,.image-capture .reasoning,.image-capture .caret,.image-capture .snapshot-foot{display:none}
.image-capture .code-frame:not([data-lang]) .code-head{display:none}
.image-capture .code-frame pre{max-height:none;white-space:pre-wrap;overflow-wrap:anywhere}
.image-capture .table-scroll{overflow:visible}
.image-capture th{white-space:normal}
.image-capture .masthead .masthead-date{flex-basis:auto;margin-left:auto}
.image-capture .user{max-width:min(80%,640px)}
.image-capture .brand{width:96px}

@media(max-width:900px){
.aside{position:fixed;inset:57px 0 0 auto;width:min(380px,100vw);z-index:2}
.workspace-head,.search-bar{padding-left:16px;padding-right:16px}
.brand{width:80px}
.transcript-column{padding:16px 16px 20px;gap:24px}
.user{max-width:90%}
.masthead .masthead-date{flex-basis:100%;margin-left:0}
}
@media print{
body{font-size:12px}
.workspace{height:auto}
.workspace-head{padding-left:0;padding-right:0}
.actions,.aside,.search-bar,.foot-actions,.code-head button{display:none}
.workspace-body{display:block}
.transcript{overflow:visible}
.transcript-column{max-width:none;padding-left:0;padding-right:0}
.code-frame pre{max-height:none;white-space:pre-wrap;overflow-wrap:anywhere}
.user,.code-frame,figure,.failure,tr{break-inside:avoid}
.message-head{break-after:avoid}
}
@media(prefers-reduced-motion:reduce){.caret{transition:none}}
`;
