/**
 * What a canvas is given to draw with (ADR 0073): `OMC.rows`, `OMC.fmt`, `OMC.chart`, `OMC.table`,
 * `OMC.diagram`, and a stylesheet of components (`omc-card`, `omc-stat`, `omc-grid` and the rest).
 *
 * A canvas is the Agent's only figure, so the common figures - a chart, a table - must not cost
 * the model hand-written SVG each time, nor come out looking different each time. The kit draws
 * them from the frozen rows with the console's tokens, and formats numbers the way the console's
 * own pages do, so a figure reads like part of the product whichever model asked for it.
 *
 * It is source text, not a module: it runs inside the canvas's sandboxed document, which shares
 * nothing with the console, so it is injected as a script and must stand entirely on its own. It
 * is written without template literals so it can live in one here.
 *
 * The kit also answers the console's request for a picture of the canvas. The frame has no origin
 * the console could read, so only the canvas can describe itself: it serialises its own document
 * as an SVG image and posts that back.
 */
export const CANVAS_CAPTURE_REQUEST = 'omc-canvas-capture';
export const CANVAS_CAPTURE_REPLY = 'omc-canvas-image';

export const CANVAS_KIT_CSS = [
  '.omc-chart{position:relative;min-width:0}',
  '.omc-chart svg{display:block;width:100%;height:auto;overflow:visible}',
  '.omc-chart text{fill:var(--muted);font-size:11px}',
  '.omc-chart .grid{stroke:var(--border-soft);stroke-width:1;fill:none}',
  '.omc-chart .zero{stroke:var(--border);stroke-width:1;fill:none}',
  '.omc-chart [data-tip]{cursor:default}',
  '.omc-legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:8px;color:var(--fg-2);font-size:12px}',
  '.omc-legend span{display:inline-flex;align-items:center;gap:6px;min-width:0}',
  '.omc-legend i{flex:none;width:8px;height:8px;border-radius:2px}',
  '.omc-legend em{color:var(--fg);font-style:normal;font-variant-numeric:tabular-nums}',
  '.omc-legend small{color:var(--meta);font-size:11px;font-variant-numeric:tabular-nums}',
  '.omc-pie{display:flex;align-items:center;gap:20px;flex-wrap:wrap}',
  '.omc-pie svg{flex:none;width:168px}',
  '.omc-pie .omc-legend{flex:1;min-width:180px;flex-direction:column;gap:6px;margin:0}',
  '.omc-pie .omc-legend b{flex:1;min-width:0;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.omc-tip{position:absolute;z-index:2;max-width:260px;padding:4px 8px;border:1px solid var(--border);border-radius:var(--radius-control);background:var(--bg);color:var(--fg);font-size:12px;line-height:1.4;pointer-events:none;white-space:nowrap}',
  '.omc-table-wrap{max-width:100%;overflow:auto}',
  '.omc-table{width:100%;font-size:12px;font-variant-numeric:tabular-nums}',
  '.omc-table th,.omc-table td{padding:6px 10px;border-bottom:1px solid var(--border-soft);text-align:left;white-space:nowrap}',
  '.omc-table th{position:sticky;top:0;background:var(--surface);color:var(--muted);font-weight:500;cursor:pointer;user-select:none}',
  '.omc-table th[aria-sort]{color:var(--fg)}',
  '.omc-table th[aria-sort=ascending]:after{content:" \\2191"}',
  '.omc-table th[aria-sort=descending]:after{content:" \\2193"}',
  '.omc-table .num{text-align:right}',
  '.omc-table tbody tr:hover{background:var(--hover)}',
  '.omc-empty{padding:16px 0;color:var(--muted);font-size:12px}',
  // The components a canvas is composed from. They carry the console's own spacing, radii and
  // tones, and every one is fluid, so markup written with them cannot leave the frame.
  '.omc-stack{display:flex;flex-direction:column;gap:12px;min-width:0}',
  '.omc-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;min-width:0}',
  '.omc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:12px;min-width:0}',
  '.omc-card{min-width:0;padding:12px 14px;border:1px solid var(--border-soft);border-radius:var(--radius-surface);background:var(--bg)}',
  '.omc-title{margin:0;color:var(--fg);font-size:13px;font-weight:600}',
  '.omc-muted{margin:0;color:var(--muted);font-size:12px}',
  '.omc-stat{display:flex;flex-direction:column;gap:2px;min-width:0}',
  '.omc-stat small{color:var(--muted);font-size:11px}',
  '.omc-stat b{color:var(--fg);font-size:22px;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums}',
  '.omc-stat span{color:var(--fg-2);font-size:12px}',
  '.omc-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;background:color-mix(in srgb,var(--fg) 8%,transparent);color:var(--fg-2);font-size:11px;white-space:nowrap}',
  '.omc-badge[data-tone=success]{background:color-mix(in srgb,var(--success) 14%,transparent);color:var(--success)}',
  '.omc-badge[data-tone=warn]{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)}',
  '.omc-badge[data-tone=danger]{background:color-mix(in srgb,var(--danger) 14%,transparent);color:var(--danger)}',
  '.omc-badge[data-tone=accent]{background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent)}',
  '.omc-callout{padding:10px 12px;border-radius:var(--radius-surface);background:color-mix(in srgb,var(--fg) 5%,transparent);color:var(--fg-2);font-size:12px}',
  '.omc-callout[data-tone=warn]{background:color-mix(in srgb,var(--warn) 12%,transparent)}',
  '.omc-callout[data-tone=danger]{background:color-mix(in srgb,var(--danger) 10%,transparent)}',
  '.omc-callout[data-tone=success]{background:color-mix(in srgb,var(--success) 10%,transparent)}',
  '.omc-kv{display:grid;grid-template-columns:minmax(0,auto) minmax(0,1fr);gap:4px 16px;margin:0;font-size:12px}',
  '.omc-kv dt{color:var(--muted)}',
  '.omc-kv dd{margin:0;color:var(--fg);font-variant-numeric:tabular-nums}',
  '.omc-field{display:flex;flex-direction:column;gap:4px;min-width:0;color:var(--muted);font-size:12px}',
  '.omc-field output{color:var(--fg);font-variant-numeric:tabular-nums}',
  'input[type=range]{width:100%;margin:0;padding:0;border:0;background:none;accent-color:var(--accent)}',
  'input[type=checkbox],input[type=radio]{width:auto;padding:0;accent-color:var(--accent)}',
  '.omc-tabs{display:inline-flex;align-self:flex-start;flex-wrap:wrap;gap:2px;padding:2px;border-radius:var(--radius-surface);background:color-mix(in srgb,var(--fg) 6%,transparent)}',
  '.omc-tabs button{padding:4px 10px;border:0;border-radius:var(--radius-control);background:none;color:var(--fg-2);font-size:12px}',
  '.omc-tabs button:hover{background:none;color:var(--fg)}',
  '.omc-tabs button[aria-pressed=true]{background:var(--surface);color:var(--fg)}',
  '.omc-diagram{display:flex;flex-direction:column;gap:12px;min-width:0}',
  // Side by side where there is room; in a narrow frame the layers stack, each indented under
  // the one before, and the edges run down a gutter and turn into each box - a tree, which is the
  // shape that stays legible at a phone's width.
  '.omc-diagram-stage{position:relative;display:flex;align-items:center;justify-content:space-between;gap:68px;min-width:0}',
  '.omc-diagram-stage[data-dir=column]{flex-direction:column;align-items:stretch;gap:20px}',
  '.omc-diagram-layer{display:flex;flex:1 1 0;flex-direction:column;justify-content:center;gap:12px;min-width:0}',
  '.omc-diagram-stage[data-dir=column] .omc-diagram-layer{gap:20px;margin-left:calc(var(--omc-depth,0)*20px)}',
  '.omc-diagram-node{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;min-width:0;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-surface);background:var(--surface);color:var(--fg);font-size:12px;text-align:left}',
  '.omc-diagram-node:hover{background:var(--surface);border-color:var(--muted)}',
  '.omc-diagram-node b{display:flex;align-items:center;gap:6px;font-weight:600}',
  '.omc-diagram-node small{color:var(--muted);font-size:11px}',
  '.omc-diagram-node[data-tone=accent]{border-color:var(--accent)}',
  '.omc-diagram-node[data-tone=success]{border-color:color-mix(in srgb,var(--success) 60%,var(--border))}',
  '.omc-diagram-node[data-tone=warn]{border-color:color-mix(in srgb,var(--warn) 60%,var(--border))}',
  '.omc-diagram-node[data-tone=danger]{border-color:color-mix(in srgb,var(--danger) 60%,var(--border))}',
  '.omc-diagram-node[data-tone=muted]{border-style:dashed;color:var(--muted)}',
  '.omc-diagram-node[aria-pressed=true]{border-color:var(--accent);outline:1px solid var(--accent)}',
  '.omc-diagram-stage[data-picked] .omc-diagram-node:not([data-near]){opacity:.45}',
  '.omc-diagram-edges{position:absolute;inset:0;z-index:1;width:100%;height:100%;overflow:visible;pointer-events:none}',
  '.omc-diagram-stage[data-dir=column] .omc-diagram-edges text{text-anchor:start}',
  '.omc-diagram-edges path{fill:none;stroke:var(--border);stroke-width:1.25}',
  '.omc-diagram-edges polygon{fill:var(--muted)}',
  '.omc-diagram-edges text{fill:var(--muted);font-size:10px;text-anchor:middle;paint-order:stroke;stroke:var(--surface);stroke-width:4px}',
  '.omc-diagram-edges g[data-on] path{stroke:var(--accent);stroke-width:1.5}',
  '.omc-diagram-edges g[data-on] polygon{fill:var(--accent)}',
  '.omc-diagram-edges g[data-on] text{fill:var(--fg)}',
  '.omc-diagram-stage[data-picked] .omc-diagram-edges g:not([data-on]){opacity:.3}',
  '.omc-diagram-detail{padding:10px 12px;border-radius:var(--radius-surface);background:color-mix(in srgb,var(--fg) 5%,transparent);color:var(--fg-2);font-size:12px}',
  '.omc-diagram-detail b{display:block;margin-bottom:2px;color:var(--fg)}',
  '.omc-diagram-detail p{margin:0}',
  '.omc-diagram-detail small{display:block;margin-top:6px;color:var(--muted);font-size:11px}',
].join('');

export const CANVAS_KIT = String.raw`(function(){
var config=window.OMC_CONFIG||{};
var locale=config.locale||'en';
var rows=Array.isArray(window.OMC_DATA)?window.OMC_DATA:[];
var SVG='http://www.w3.org/2000/svg';
var EPOCH_FLOOR=1e11;

function isNumber(value){return typeof value==='number'&&isFinite(value)}
function intl(options){try{return new Intl.NumberFormat(locale,options)}catch(error){return new Intl.NumberFormat('en',options)}}
var whole=intl({maximumFractionDigits:0});
var plain=intl({maximumFractionDigits:2});
var money=intl({minimumFractionDigits:2,maximumFractionDigits:2});
function trim(value,digits){return String(Number(value.toFixed(digits)))}
function scaled(value,steps){
  var size=Math.abs(value);
  for(var index=0;index<steps.length;index++)if(size>=steps[index][0])return trim(value/steps[index][0],1)+steps[index][1];
  return whole.format(value);
}
var COMPACT=[[1e9,'B'],[1e6,'M'],[1e3,'K']];
var CHINESE=[[1e8,'亿'],[1e4,'万']];
function tokens(value){
  if(config.tokenStyle==='full')return whole.format(value);
  return scaled(value,config.tokenStyle==='zh'?CHINESE:COMPACT);
}
function duration(value){
  var size=Math.abs(value);
  if(size<1000)return Math.round(value)+' ms';
  if(size<60000)return trim(value/1000,1)+' s';
  var seconds=Math.round(size/1000);
  return (value<0?'-':'')+Math.floor(seconds/60)+' min '+(seconds%60)+' s';
}
function bytes(value){
  var units=['B','KB','MB','GB','TB'],index=0,size=value;
  while(Math.abs(size)>=1024&&index<units.length-1){size/=1024;index++}
  return (index?trim(size,1):String(Math.round(size)))+' '+units[index];
}
function time(value){
  var isDay=typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);
  var date=new Date(isDay?value+'T00:00:00Z':value);
  if(isNaN(date.getTime()))return String(value);
  var options=isDay?{timeZone:'UTC',month:'short',day:'numeric'}:{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'};
  if(!isDay&&config.timeZone)options.timeZone=config.timeZone;
  try{return new Intl.DateTimeFormat(locale,options).format(date)}catch(error){return date.toISOString()}
}
function fmt(value,unit){
  if(value===null||value===undefined||value==='')return '—';
  if(unit==='time')return time(value);
  if(!isNumber(value))return String(value);
  switch(unit){
    case 'tokens':return tokens(value);
    case 'usd':return (value<0?'-$':'$')+(value!==0&&Math.abs(value)<0.01?trim(Math.abs(value),4):money.format(Math.abs(value)));
    case 'ms':return duration(value);
    case 'percent':return trim(value*100,1)+'%';
    case 'bytes':return bytes(value);
    default:return Math.abs(value)>=1e6?scaled(value,COMPACT):plain.format(value);
  }
}

function resolve(target){
  var element=typeof target==='string'?document.querySelector(target):target;
  if(!element){element=document.createElement('div');document.body.appendChild(element)}
  return element;
}
function make(name,attributes,parent){
  var element=document.createElementNS(SVG,name);
  for(var key in attributes)element.setAttribute(key,attributes[key]);
  if(parent)parent.appendChild(element);
  return element;
}
function html(name,className,text,parent){
  var element=document.createElement(name);
  if(className)element.className=className;
  if(text!==undefined)element.textContent=text;
  if(parent)parent.appendChild(element);
  return element;
}
function round(value){return Math.round(value*100)/100}
function clip(text,length){return text.length>length?text.slice(0,Math.max(1,length-1))+'…':text}
function color(index){return 'var(--series-'+(index%6+1)+', var(--accent))'}
function unique(values){var seen=[];values.forEach(function(value){if(seen.indexOf(value)<0)seen.push(value)});return seen}
function empty(element){element.textContent='';return html('div','omc-empty',config.emptyLabel||'No data',element)}

function ticksFor(low,high){
  low=Math.min(0,low);high=Math.max(0,high);
  var rough=(high-low||1)/4,magnitude=Math.pow(10,Math.floor(Math.log10(rough)));
  var step=[1,2,2.5,5,10].filter(function(factor){return factor*magnitude>=rough})[0]*magnitude;
  var ticks=[];
  for(var index=Math.floor(low/step);index<=Math.ceil(high/step);index++)ticks.push(Number((index*step).toPrecision(12)));
  return ticks;
}

function pointsOf(spec,data){
  var fields=Array.isArray(spec.y)?spec.y:[spec.y],points=[];
  data.forEach(function(row){
    var raw=row[spec.x],x=raw===null||raw===undefined?'':String(raw);
    if(spec.series){
      if(isNumber(row[fields[0]]))points.push({x:x,series:String(row[spec.series]===null||row[spec.series]===undefined?'':row[spec.series]),value:row[fields[0]]});
      return;
    }
    fields.forEach(function(field){if(isNumber(row[field]))points.push({x:x,series:fields.length>1?String(field):'',value:row[field]})});
  });
  return points;
}

function tooltip(host){
  var isBound=!!host.omcTip;
  host.omcTip=html('div','omc-tip','',host);
  host.omcTip.hidden=true;
  // A chart drawn again keeps the listeners of its first drawing; they reach the tip in force.
  if(isBound)return;
  host.addEventListener('mousemove',function(event){
    var tip=host.omcTip,mark=event.target&&event.target.getAttribute?event.target.getAttribute('data-tip'):null;
    if(!mark){tip.hidden=true;return}
    tip.textContent=mark;tip.hidden=false;
    var box=host.getBoundingClientRect();
    var left=Math.min(event.clientX-box.left+12,Math.max(0,box.width-tip.offsetWidth-4));
    tip.style.left=left+'px';tip.style.top=Math.max(0,event.clientY-box.top-tip.offsetHeight-8)+'px';
  });
  host.addEventListener('mouseleave',function(){host.omcTip.hidden=true});
}

// A chart is drawn at the width of the frame it sits in, up to the desktop measure, so its text
// keeps its size on a phone instead of shrinking with a fixed drawing; a frame that changes width
// (a rotated phone, the full-screen view) is drawn again.
var CHART_WIDTH=760,CHART_MIN_WIDTH=280;
function chart(target,spec){
  var host=resolve(target),drawnWidth=0;
  spec=spec||{};
  function draw(){
    var width=Math.max(CHART_MIN_WIDTH,Math.min(CHART_WIDTH,Math.round(host.clientWidth)||CHART_WIDTH));
    // Only the width decides the drawing: its own change of height must not draw it again.
    if(Math.abs(width-drawnWidth)<8)return;
    drawnWidth=width;paintChart(host,spec,width);
  }
  draw();
  if(window.ResizeObserver){
    if(host.omcChartObserver)host.omcChartObserver.disconnect();
    host.omcChartObserver=new ResizeObserver(draw);host.omcChartObserver.observe(host);
  }
  return host;
}

function paintChart(host,spec,W){
  var data=Array.isArray(spec.rows)?spec.rows:rows,points=pointsOf(spec,data);
  host.textContent='';host.classList.add('omc-chart');
  if(!points.length)return empty(host);
  var type=spec.type||'line',unit=spec.unit;
  var names=unique(points.map(function(point){return point.series}));
  var categories=unique(points.map(function(point){return point.x}));
  var isTime=type!=='pie'&&categories.every(function(x){return /^\d+$/.test(x)&&Number(x)>=EPOCH_FLOOR});
  function category(x){return isTime?time(Number(x)):/^\d{4}-\d{2}-\d{2}$/.test(x)?time(x):x}
  function describe(point){return [category(point.x),point.series].filter(Boolean).join(' · ')+': '+fmt(point.value,unit)}
  function legend(parent){
    if(names.length<2)return;
    var list=html('div','omc-legend','',parent);
    names.forEach(function(name,index){var item=html('span','','',list);html('i','','',item).style.background=color(index);item.appendChild(document.createTextNode(name))});
  }
  tooltip(host);

  if(type==='pie'){
    host.classList.add('omc-pie');
    var total=points.reduce(function(sum,point){return sum+Math.max(0,point.value)},0),drawn=0;
    var svg=make('svg',{viewBox:'0 0 180 180',role:'img'},host);
    make('circle',{cx:90,cy:90,r:64,fill:'none',stroke:'var(--border)','stroke-width':32},svg);
    var list=html('div','omc-legend','',host);
    points.forEach(function(point,index){
      var share=total>0?Math.max(0,point.value)/total:0;
      // A hairline of surface shows between slices: the gap comes out of each slice's own arc.
      var arc=Math.max(0,share-(points.length>1?0.004:0));
      if(total>0)make('circle',{cx:90,cy:90,r:64,fill:'none',stroke:color(index),'stroke-width':32,pathLength:1,'stroke-dasharray':round(arc*1e4)/1e4+' 1','stroke-dashoffset':-round(drawn*1e4)/1e4,transform:'rotate(-90 90 90)','data-tip':describe(point)},svg);
      drawn+=share;
      var item=html('span','','',list);
      html('i','','',item).style.background=color(index);
      html('b','',[point.x,point.series].filter(Boolean).join(' · '),item);
      html('em','',fmt(point.value,unit),item);
      html('small','',total>0?trim(share*100,1)+'%':'',item);
    });
    return host;
  }

  // A stacked mark starts where the series before it at the same category ended.
  var isStacked=!!spec.stacked&&type!=='line'&&names.length>1,floors=[];
  if(isStacked){
    var totals={};
    names.forEach(function(name){points.forEach(function(point,index){
      if(point.series!==name)return;
      floors[index]=totals[point.x]||0;totals[point.x]=(totals[point.x]||0)+point.value;
    })});
  }
  function from(index){return floors[index]||0}
  function to(index){return from(index)+points[index].value}
  var tops=points.map(function(point,index){return to(index)});
  var ticks=ticksFor(Math.min.apply(null,tops),Math.max.apply(null,tops));
  var low=ticks[0],span=ticks[ticks.length-1]-low||1;

  if(type==='bar'){
    var LEFT=Math.round(Math.min(148,W*0.36)),RIGHT=W-12,TOP=6,BAND=Math.max(24,(isStacked?1:names.length)*14+10),bottom=TOP+categories.length*BAND;
    var bars=make('svg',{viewBox:'0 0 '+W+' '+(bottom+24),role:'img'},host);
    var across=function(value){return LEFT+(value-low)/span*(RIGHT-LEFT)};
    var thickness=(BAND-10)/(isStacked?1:names.length);
    // A narrow scale names every other gridline rather than letting the figures run together.
    var labelStride=(RIGHT-LEFT)/ticks.length<48?2:1;
    ticks.forEach(function(tick,index){
      make('path',{'class':tick===0?'zero':'grid',d:'M'+round(across(tick))+' '+TOP+'V'+bottom},bars);
      if(index%labelStride===0)make('text',{x:round(across(tick)),y:bottom+16,'text-anchor':'middle'},bars).textContent=fmt(tick,unit);
    });
    categories.forEach(function(x,index){make('text',{x:LEFT-10,y:TOP+index*BAND+BAND/2+4,'text-anchor':'end'},bars).textContent=clip(category(x),Math.max(6,Math.floor((LEFT-14)/6.7)))});
    points.forEach(function(point,index){
      var top=TOP+categories.indexOf(point.x)*BAND+5+(isStacked?0:names.indexOf(point.series)*thickness);
      make('rect',{x:round(Math.min(across(from(index)),across(to(index)))),y:round(top),width:round(Math.abs(across(to(index))-across(from(index)))),height:round(Math.max(2,thickness-2)),rx:1,fill:color(names.indexOf(point.series)),'data-tip':describe(point)},bars);
    });
    legend(host);
    return host;
  }

  var L=58,R=W-8,T=10,B=T+Math.round(Math.max(160,Math.min(222,W*0.52)));
  var plot=make('svg',{viewBox:'0 0 '+W+' '+(B+26),role:'img'},host);
  var up=function(value){return B-(value-low)/span*(B-T)};
  var band=(R-L)/categories.length;
  var along=function(x){return L+(categories.indexOf(x)+0.5)*band};
  ticks.forEach(function(tick){
    make('path',{'class':tick===0?'zero':'grid',d:'M'+L+' '+round(up(tick))+'H'+R},plot);
    make('text',{x:L-8,y:round(up(tick))+4,'text-anchor':'end'},plot).textContent=fmt(tick,unit);
  });
  // Labels are thinned to what the width can seat instead of being rotated or overlapped.
  var stride=Math.max(1,Math.ceil(categories.length/Math.max(2,Math.floor((R-L)/86)))),room=Math.max(6,Math.floor(band*stride/6.4)-1);
  categories.forEach(function(x,index){if(index%stride===0)make('text',{x:round(along(x)),y:B+18,'text-anchor':'middle'},plot).textContent=clip(category(x),room)});
  names.forEach(function(name,seriesIndex){
    var own=[];
    points.forEach(function(point,index){if(point.series===name)own.push(index)});
    var paint=color(seriesIndex);
    if(type==='column'){
      var width=Math.min(40,band*0.72/(isStacked?1:names.length)),offset=isStacked?-0.5:seriesIndex-names.length/2;
      own.forEach(function(index){
        make('rect',{x:round(along(points[index].x)+offset*width+1),y:round(Math.min(up(from(index)),up(to(index)))),width:round(Math.max(1,width-2)),height:round(Math.abs(up(from(index))-up(to(index)))),rx:1,fill:paint,'data-tip':describe(points[index])},plot);
      });
      return;
    }
    var line=own.map(function(index,position){return (position?'L':'M')+round(along(points[index].x))+' '+round(up(to(index)))}).join('');
    if(type==='area'){
      var floor=own.slice().reverse().map(function(index){return 'L'+round(along(points[index].x))+' '+round(up(from(index)))}).join('');
      make('path',{d:line+floor+'Z',fill:paint,opacity:isStacked?0.32:0.14},plot);
    }
    make('path',{d:line,stroke:paint,'stroke-width':1.5,'stroke-linejoin':'round','stroke-linecap':'round',fill:'none'},plot);
    var radius=own.length>32?0:2.5;
    own.forEach(function(index){make('circle',{cx:round(along(points[index].x)),cy:round(up(to(index))),r:radius||6,fill:radius?paint:'transparent','data-tip':describe(points[index])},plot)});
  });
  legend(host);
  return host;
}

function table(target,spec){
  var host=resolve(target);
  spec=spec||{};
  var data=(Array.isArray(spec.rows)?spec.rows:rows).slice();
  var columns=(spec.columns||Object.keys(data[0]||{})).map(function(column){return typeof column==='string'?{field:column}:column});
  host.textContent='';host.classList.add('omc-table-wrap');
  if(!data.length||!columns.length)return empty(host);
  var element=html('table','omc-table','',host),head=html('tr','','',html('thead','','',element)),body=html('tbody','','',element);
  var sorted=-1,direction=1;
  // Decided once per column: asking per cell scans every row for every cell of every row.
  var numeric=columns.map(function(column){return data.some(function(row){return isNumber(row[column.field])})&&column.unit!=='time'});
  function draw(){
    body.textContent='';
    data.forEach(function(row){
      var line=html('tr','','',body);
      columns.forEach(function(column,index){html('td',numeric[index]?'num':'',fmt(row[column.field],column.unit),line)});
    });
  }
  columns.forEach(function(column,index){
    var cell=html('th',numeric[index]?'num':'',column.label||column.field,head);
    cell.scope='col';cell.tabIndex=0;
    function sort(){
      direction=sorted===index?-direction:1;sorted=index;
      data.sort(function(a,b){
        var left=a[column.field],right=b[column.field];
        if(left===right)return 0;
        if(left===null||left===undefined)return 1;
        if(right===null||right===undefined)return -1;
        return (isNumber(left)&&isNumber(right)?left-right:String(left).localeCompare(String(right)))*direction;
      });
      Array.prototype.forEach.call(head.children,function(other){other.removeAttribute('aria-sort')});
      cell.setAttribute('aria-sort',direction>0?'ascending':'descending');
      draw();
    }
    cell.addEventListener('click',sort);
    cell.addEventListener('keydown',function(event){if(event.key==='Enter'||event.key===' '){event.preventDefault();sort()}});
  });
  draw();
  return host;
}

function picture(){
  var root=document.documentElement,body=document.body;
  var width=Math.ceil(root.clientWidth),height=Math.ceil(Math.max(root.scrollHeight,body.scrollHeight));
  var copy=body.cloneNode(true);
  var live=body.querySelectorAll('canvas'),still=copy.querySelectorAll('canvas');
  for(var index=0;index<live.length;index++){
    var image=document.createElement('img');
    try{image.src=live[index].toDataURL()}catch(error){}
    image.width=live[index].clientWidth;image.height=live[index].clientHeight;
    still[index].parentNode.replaceChild(image,still[index]);
  }
  Array.prototype.forEach.call(copy.querySelectorAll('script,.omc-tip'),function(node){node.parentNode.removeChild(node)});
  var wrapper=document.createElement('div');
  wrapper.setAttribute('xmlns','http://www.w3.org/1999/xhtml');
  wrapper.setAttribute('style','width:'+width+'px;height:'+height+'px;overflow:hidden;background:'+getComputedStyle(body).backgroundColor+';color:var(--fg)');
  Array.prototype.forEach.call(document.querySelectorAll('style'),function(style){
    if(body.contains(style))return;
    var sheet=document.createElement('style');sheet.textContent=style.textContent;wrapper.appendChild(sheet);
  });
  wrapper.appendChild(copy);
  return {width:width,height:height,svg:'<svg xmlns="'+SVG+'" width="'+width+'" height="'+height+'"><foreignObject width="100%" height="100%">'+new XMLSerializer().serializeToString(wrapper)+'</foreignObject></svg>'};
}
addEventListener('message',function(event){
  if(event.source!==parent||!event.data||event.data.type!=='omc-canvas-capture')return;
  var reply={type:'omc-canvas-image',id:event.data.id};
  try{var drawn=picture();reply.svg=drawn.svg;reply.width=drawn.width;reply.height=drawn.height}catch(error){}
  parent.postMessage(reply,'*');
});

function icon(name,size){
  size=Number.isFinite(size)?Math.min(128,Math.max(8,size)):16;
  var assets=window.OMC_ICONS||{},asset=Object.prototype.hasOwnProperty.call(assets,name)?assets[name]:null;
  var node=document.createElement(asset&&!asset.isMono?'img':'span');
  node.setAttribute('aria-hidden','true');node.setAttribute('data-icon',name);
  node.style.cssText='display:inline-block;vertical-align:middle;flex:none;width:'+size+'px;height:'+size+'px;object-fit:contain';
  if(asset&&asset.isMono){node.style.backgroundColor='currentColor';node.style.mask='url("'+asset.url+'") center/contain no-repeat';node.style.webkitMask=node.style.mask}
  else if(asset){node.src=asset.url;node.alt=''}
  else{node.style.border='1px solid currentColor';node.style.borderRadius='2px';node.style.opacity='0.4'}
  return node;
}
function mountIcons(){
  document.querySelectorAll('[data-omc-icon]').forEach(function(host){
    host.replaceChildren(icon(host.getAttribute('data-omc-icon'),Number(host.getAttribute('data-size'))||16));
  });
}
function compose(message){
  if(typeof message!=='string'||!message.trim()||new TextEncoder().encode(message).length>48*1024)return false;
  // The host requires a separate operator click before copying this untrusted draft. This
  // message grants neither capability authority nor permission to send a model request.
  parent.postMessage({type:'omc-ui-compose',message:message},'*');return true;
}
// A diagram of named parts and what joins them: nodes in layers by how far they sit from a source,
// edges drawn between their boxes, and a node that can be picked to read about it and see what it
// touches. The boxes are ordinary elements, so labels wrap and the layout is the browser's own;
// only the edges are measured, and they are measured again whenever the stage changes size.
function diagram(target,spec){
  var host=typeof target==='string'?document.querySelector(target):target;
  if(!host)return;
  spec=spec||{};
  // Prototype-free: a node the model named 'constructor' or 'toString' is a node, not a lookup.
  var byId=Object.create(null),nodes=[],edges=[];
  (Array.isArray(spec.nodes)?spec.nodes:[]).forEach(function(node){
    if(node&&node.id!=null&&!byId[node.id]){byId[node.id]=node;nodes.push(node)}
  });
  (Array.isArray(spec.edges)?spec.edges:[]).forEach(function(edge){
    if(edge&&byId[edge.from]&&byId[edge.to]&&edge.from!==edge.to)edges.push(edge);
  });
  host.textContent='';host.classList.add('omc-diagram');
  if(!nodes.length){var none=document.createElement('div');none.className='omc-empty';none.textContent=config.emptyLabel||'';host.appendChild(none);return}
  // Longest path from a source. The passes are bounded, so a cycle settles instead of spinning.
  var layer={};nodes.forEach(function(node){layer[node.id]=0});
  for(var pass=0;pass<nodes.length;pass++){
    var moved=false;
    edges.forEach(function(edge){var next=layer[edge.from]+1;if(layer[edge.to]<next&&next<nodes.length){layer[edge.to]=next;moved=true}});
    if(!moved)break;
  }
  var stage=document.createElement('div');stage.className='omc-diagram-stage';
  var lines=document.createElementNS(SVG,'svg');lines.setAttribute('class','omc-diagram-edges');lines.setAttribute('aria-hidden','true');
  stage.appendChild(lines);
  var detail=document.createElement('div');detail.className='omc-diagram-detail';detail.hidden=true;detail.setAttribute('role','status');
  var boxes={},columns={},picked=null;
  nodes.forEach(function(node){
    var column=columns[layer[node.id]];
    if(!column){column=columns[layer[node.id]]=document.createElement('div');column.className='omc-diagram-layer'}
    var box=document.createElement('button');box.type='button';box.className='omc-diagram-node';box.setAttribute('aria-pressed','false');
    if(node.tone)box.setAttribute('data-tone',String(node.tone));
    var name=document.createElement('b');
    if(node.icon)name.appendChild(icon(String(node.icon),14));
    name.appendChild(document.createTextNode(String(node.label==null?node.id:node.label)));
    box.appendChild(name);
    if(node.note){var note=document.createElement('small');note.textContent=String(node.note);box.appendChild(note)}
    box.addEventListener('click',function(){pick(picked===node.id?null:node.id)});
    boxes[node.id]=box;column.appendChild(box);
  });
  Object.keys(columns).map(Number).sort(function(a,b){return a-b}).forEach(function(index,depth){
    columns[index].style.setProperty('--omc-depth',String(Math.min(depth,3)));stage.appendChild(columns[index]);
  });
  host.appendChild(stage);host.appendChild(detail);
  var marks=edges.map(function(edge){
    var group=make('g',{},lines);
    return {edge:edge,group:group,path:make('path',{},group),head:make('polygon',{},group),text:edge.label?make('text',{},group):null};
  });
  marks.forEach(function(mark){if(mark.text)mark.text.textContent=String(mark.edge.label)});
  function labelOf(id){var node=byId[id];return String(node.label==null?node.id:node.label)}
  function pick(id){
    picked=id;
    nodes.forEach(function(node){boxes[node.id].setAttribute('aria-pressed',String(node.id===id));boxes[node.id].removeAttribute('data-near')});
    marks.forEach(function(mark){
      var on=id!=null&&(mark.edge.from===id||mark.edge.to===id);
      if(on){mark.group.setAttribute('data-on','');boxes[mark.edge.from].setAttribute('data-near','');boxes[mark.edge.to].setAttribute('data-near','')}
      else mark.group.removeAttribute('data-on');
    });
    if(id==null){stage.removeAttribute('data-picked');detail.hidden=true;return}
    boxes[id].setAttribute('data-near','');stage.setAttribute('data-picked','');
    detail.textContent='';detail.hidden=false;
    var title=document.createElement('b');title.textContent=labelOf(id);detail.appendChild(title);
    if(byId[id].detail){var body=document.createElement('p');body.textContent=String(byId[id].detail);detail.appendChild(body)}
    var links=marks.filter(function(mark){return mark.edge.from===id||mark.edge.to===id}).map(function(mark){
      var arrow=mark.edge.from===id?'→ '+labelOf(mark.edge.to):'← '+labelOf(mark.edge.from);
      return mark.edge.label?arrow+' ('+mark.edge.label+')':arrow;
    });
    if(links.length){var list=document.createElement('small');list.textContent=links.join('  ·  ');detail.appendChild(list)}
  }
  function draw(){
    var isColumn=spec.direction==='down'||stage.clientWidth<Math.max(360,Object.keys(columns).length*150);
    stage.setAttribute('data-dir',isColumn?'column':'row');
    var origin=stage.getBoundingClientRect();
    marks.forEach(function(mark){
      var from=boxes[mark.edge.from].getBoundingClientRect(),to=boxes[mark.edge.to].getBoundingClientRect();
      var forward=layer[mark.edge.to]>layer[mark.edge.from],x1,y1,x2,y2,angle,size=6;
      if(isColumn){
        // Down the gutter from under the source, then across into the target's side.
        x1=from.left+8-origin.left;y1=(forward?from.bottom:from.top)-origin.top;x2=to.left-origin.left;y2=to.top+Math.min(to.height/2,18)-origin.top;
        if(x2<=x1+size)x1=x2-12;
        mark.path.setAttribute('d','M'+x1+' '+y1+'V'+y2+'H'+x2);angle=0;
        if(mark.text){mark.text.setAttribute('x',(x2+10).toFixed(1));mark.text.setAttribute('y',(to.top-origin.top-5).toFixed(1))}
      }else{
        y1=from.top+from.height/2-origin.top;y2=to.top+to.height/2-origin.top;x1=(forward?from.right:from.left)-origin.left;x2=(forward?to.left:to.right)-origin.left;
        var bend=(x2-x1)/2;
        mark.path.setAttribute('d','M'+x1+' '+y1+'C'+(x1+bend)+' '+y1+' '+(x2-bend)+' '+y2+' '+x2+' '+y2);angle=x2>=x1?0:Math.PI;
        // Near the source, where the edges of one node have not yet fanned out over each other.
        if(mark.text){mark.text.setAttribute('x',(x1+bend).toFixed(1));mark.text.setAttribute('y',((y1+y2)/2-4).toFixed(1))}
      }
      mark.head.setAttribute('points',[[x2,y2],[x2-size*Math.cos(angle-0.45),y2-size*Math.sin(angle-0.45)],[x2-size*Math.cos(angle+0.45),y2-size*Math.sin(angle+0.45)]].map(function(point){return point[0].toFixed(1)+','+point[1].toFixed(1)}).join(' '));
    });
  }
  draw();
  if(window.ResizeObserver)new ResizeObserver(draw).observe(stage);
}
// Tabs written as markup: buttons that name a panel, and the panels they show.
function mountTabs(){
  document.querySelectorAll('[data-omc-tabs]').forEach(function(root){
    var buttons=[].slice.call(root.querySelectorAll('[data-tab]')),panels=[].slice.call(root.querySelectorAll('[data-panel]'));
    function show(name){
      buttons.forEach(function(button){button.setAttribute('aria-pressed',String(button.getAttribute('data-tab')===name))});
      // Set inline: a panel laid out by a class would ignore the hidden attribute.
      panels.forEach(function(panel){var isShown=panel.getAttribute('data-panel')===name;panel.hidden=!isShown;panel.style.display=isShown?'':'none'});
    }
    buttons.forEach(function(button){button.addEventListener('click',function(){show(button.getAttribute('data-tab'))})});
    if(buttons.length)show(buttons[0].getAttribute('data-tab'));
  });
}
window.OMC={rows:rows,fmt:fmt,chart:chart,table:table,diagram:diagram,icon:icon,mountIcons:mountIcons,compose:compose};
addEventListener('DOMContentLoaded',function(){mountIcons();mountTabs()});
})();`;
