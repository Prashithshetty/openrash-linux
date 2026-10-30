// A fixed course overview: branch riders use the same main-route progress as race positions.
// It deliberately stays independent of the moving 3D road/camera coordinate charts.
const NS = 'http://www.w3.org/2000/svg';
const WIDTH = 240, HEIGHT = 180, START = 50;
const COLORS = ['#70dfff','#ff9670','#d9a4ff','#8bff9b','#ffb8dd','#98b5ff','#ffffff','#f8f078'];
let serial = 0;
export function courseMap(data, sections = [], level = 1) {
  const end = data.steps.length - 2;
  let at = 0, finish = end - 1;
  for (let n=1;n<=Math.max(1,Math.min(5,level));n++) {
    const section = sections.find(s=>(s[2]&0xffff)===((n<<8)|6)&&s[0]>at);
    if(section){at=section[0];finish=section[0];}
  }
  finish=Math.max(START+1,Math.min(end-1,finish));
  const points=[];let x=0,z=0,h=0;
  for(let i=0;i<=finish;i++){h+=Math.atan(data.steps[i][0]/256)/2;x+=Math.sin(h);z-=Math.cos(h);if(i>=START)points.push({x,y:z});}
  const xs=points.map(p=>p.x),ys=points.map(p=>p.y),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const scale=Math.min((WIDTH-40)/Math.max(1,maxX-minX),(HEIGHT-40)/Math.max(1,maxY-minY));
  const ox=(WIDTH-(maxX-minX)*scale)/2,oy=(HEIGHT-(maxY-minY)*scale)/2;
  const projected=points.map(p=>({x:ox+(p.x-minX)*scale,y:oy+(p.y-minY)*scale}));
  const position=s=>{const v=Math.max(0,Math.min(projected.length-1,s-START)),i=Math.floor(v),a=projected[i],b=projected[Math.min(i+1,projected.length-1)];return {x:a.x+(b.x-a.x)*(v-i),y:a.y+(b.y-a.y)*(v-i)};};
  const stride=Math.max(1,Math.floor(points.length/400)),sampled=projected.filter((_,i)=>i%stride===0);sampled.push(projected.at(-1));
  return {start:START,finish,position,path:sampled.map((p,i)=>(i?'L':'M')+p.x.toFixed(1)+','+p.y.toFixed(1)).join(' ')};
}
function el(tag,attrs={},text){const node=document.createElementNS(NS,tag);for(const [k,v]of Object.entries(attrs))node.setAttribute(k,v);if(text!==undefined)node.textContent=text;return node;}
export function mountCourseMap(parent,model,{live=false,name='Course',legend:legendText}={}) {
  const figure=document.createElement('figure');figure.className=live?'course-map race-map':'course-map track-map';
  const caption=document.createElement('figcaption');caption.textContent=live?'RACE MAP':name+' · Route';figure.append(caption);
  const svg=el('svg',{viewBox:`0 0 ${WIDTH} ${HEIGHT}`,role:'img','aria-label':name+' course map. Start and checkered finish marked.'});figure.append(svg);
  const pattern='map-finish-'+(++serial),defs=el('defs'),p=el('pattern',{id:pattern,width:8,height:8,patternUnits:'userSpaceOnUse'});
  p.append(el('rect',{width:8,height:8,fill:'#fff'}),el('path',{d:'M0 0h4v4H0zM4 4h4v4H4z',fill:'#000'}));defs.append(p);svg.append(defs);
  svg.append(el('path',{d:model.path,fill:'none',stroke:'#000','stroke-width':7,'stroke-linecap':'round','stroke-linejoin':'round'}),el('path',{d:model.path,fill:'none',stroke:'#d4fff6','stroke-width':3,'stroke-linecap':'round','stroke-linejoin':'round'}));
  const start=model.position(model.start),finish=model.position(model.finish);
  svg.append(el('circle',{cx:start.x,cy:start.y,r:4,fill:'#8bff9b',stroke:'#000','stroke-width':1}));
  const finishFlag=el('rect',{x:finish.x-6,y:finish.y-6,width:12,height:12,fill:`url(#${pattern})`,stroke:'#000','stroke-width':1});svg.append(finishFlag);
  const dots=el('g');svg.append(dots);const nodes=new Map();
  const legend=document.createElement('small');legend.textContent=legendText??(live?'YOU = YELLOW · ■ FINISH':'● START · ■ FINISH');figure.append(legend);parent.append(figure);
  let last=0;
  return {element:figure,update(riders,selfId,now=performance.now()){
    if(now-last<100)return;last=now;
    const present=new Set(),self=riders.find(r=>r.id===selfId),labels=[];
    // Paint the local rider last, so your yellow dot stays visible on a crowded grid.
    for(const r of [...riders.filter(r=>r.id!==selfId),...(self?[self]:[])]){
      if(!Number.isFinite(r.s)||r.s<0)continue;present.add(r.id);
      let item=nodes.get(r.id);if(!item){const group=el('g',{'data-rider':r.id}),title=el('title'),dot=el('circle',{r:4,stroke:'#000','stroke-width':1.5}),label=el('text',{'font-size':12,fill:'#d4fff6',stroke:'#000','stroke-width':3,'paint-order':'stroke'});group.append(title,dot,label);dots.append(group);item={group,title,dot,label};nodes.set(r.id,item);}
      const point=model.position(r.s),isSelf=r.id===selfId;
      item.title.textContent=(isSelf?'You':r.name)+(r.finished?' · Finished':'');
      item.dot.setAttribute('cx',point.x);item.dot.setAttribute('cy',point.y);item.dot.setAttribute('r',isSelf?5:4);item.dot.setAttribute('fill',isSelf?'#f8f078':COLORS[(r.slot||0)%7]);
      const nearby=self&&Math.abs(r.s-self.s)<(model.finish-model.start)*.08;
      let y=Math.max(14,Math.min(HEIGHT-6,point.y-9)),x=Math.max(4,Math.min(WIDTH-78,point.x+8));
      const show=isSelf||(nearby&&!labels.some(p=>Math.abs(p.y-y)<14&&Math.abs(p.x-x)<80));
      item.label.textContent=show?(isSelf?'YOU':String(r.name||'Friend').slice(0,12)):'';item.label.setAttribute('x',x);item.label.setAttribute('y',y);if(show)labels.push({x,y});
      if(isSelf)dots.append(item.group);
    }
    for(const [id,item]of nodes)if(!present.has(id)){item.group.remove();nodes.delete(id);}
  }};
}
const cache=new Map();
export async function previewCourseMap(parent,course,level,name){
  const key=course+':'+level;
  if(!cache.has(key))cache.set(key,Promise.all([fetch(`./data/${course}.json`),fetch(`./data/${course}-sections.json`)]).then(async rs=>{if(rs.some(r=>!r.ok))throw Error('Map unavailable');return courseMap(await rs[0].json(),await rs[1].json(),level);}).catch(e=>{cache.delete(key);throw e;}));
  try{const model=await cache.get(key);if(parent.isConnected)mountCourseMap(parent,model,{name});}catch{if(parent.isConnected)parent.textContent='Track preview unavailable.';}
}
