import { playOutcomeVideo } from "./race-outcome.js?v=7ff6fafad2";
import { previewCourseMap } from "./race-map.js?v=7ff6fafad2";
import { track, analyticsId, analyticsReady } from "./analytics.js?v=7ff6fafad2";
import { offerInstall, shareLinks, WA_ICON, SHARE_ICON } from "./install.js?v=7ff6fafad2";
import { offerPromo } from "./promo.js?v=7ff6fafad2";
// Friend rooms use invite links and host-controlled race starts.
let sock = null, myId = null, games = [], game = null, chat = [], listeners = new Set(), myChar = null;
const send = (m) => { if (sock?.readyState === 1) sock.send(JSON.stringify(m)); };
let connecting = null, connectingRoom = null, sockRoom = null, heartbeat = null;
// The relay keeps a dropped rider's place for 2 minutes; this tab's token (kept across reloads) reclaims it.
const RESUME_KEY = "rr-resume", RESUME_MS = 110000;
const savedResume = () => { try { const r = JSON.parse(sessionStorage.getItem(RESUME_KEY) || "null"); return r && Date.now() - r.at < RESUME_MS ? r : null; } catch { return null; } };
const keepResume = (r) => { try { r ? sessionStorage.setItem(RESUME_KEY, JSON.stringify({ ...r, at: Date.now() })) : sessionStorage.removeItem(RESUME_KEY); } catch {} };
let myToken = null;
// Each room code has its own relay; hosts pick a random free code (the relay answers "taken" if it's in use).
const newRoomCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, "0");
// Close this page's socket on purpose, without reporting a lost connection.
function disconnect() {
  const ws = sock; sock = null; sockRoom = null; game = null; myId = null;
  clearInterval(heartbeat); heartbeat = null; ws?.close();
}
function connect(name, room) {
  if (sock?.readyState === WebSocket.OPEN && sockRoom === room) return Promise.resolve();
  if (connecting && connectingRoom === room) return connecting;
  disconnect();
  connectingRoom = room;
  connecting = new Promise((ok, fail) => {
    const query = room?.startsWith("pub:") ? `?pub=${encodeURIComponent(room.slice(4))}` : room ? `?room=${encodeURIComponent(room)}` : "";
    const ws = sock = new WebSocket(`wss://roadrash.fun/mano${query}`);
    sockRoom = room;
    let settled = false, lastPong = Date.now(), pingAt = 0, closeCause = "socket_lost";
    const timeout = setTimeout(() => { fail(new Error("Connection timed out")); ws.close(); }, 10000);
    ws.onopen = () => {
      clearTimeout(timeout); settled = true; const ph = analyticsId(), back = savedResume();
      send({ t: "hello", name, ph: ph ?? undefined, resume: back && back.room === room ? back.token : undefined });
      // invite links can connect before analytics loads; tell the room server the id once it exists
      if (!ph) analyticsReady.then((id) => { if (id && sock === ws) send({ t: "hello", name, ph: id }); });
      clearInterval(heartbeat);
      // Background tabs run timers about once a minute, so only an unanswered ping counts as a dead connection.
      heartbeat = setInterval(() => { if (pingAt && lastPong < pingAt && Date.now() - pingAt > 20000) { closeCause = "heartbeat_timeout"; ws.close(); } else { pingAt = Date.now(); send({t:"ping"}); } }, 15000);
      ok();
    };
    ws.onerror = () => { if (!settled) { clearTimeout(timeout); fail(new Error("No connection")); } };
    ws.onclose = (event) => {
      clearTimeout(timeout);
      if (!settled) fail(new Error("Connection closed"));
      if (sock !== ws) return;
      clearInterval(heartbeat); heartbeat = null;
      sock = null; game = null; games = []; myId = null;
      for (const l of listeners) l({ t: "closed", lost: true, cause: closeCause, code: event?.code, text: "Connection lost. Reconnect to join a room again." });
    };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; }
      lastPong = Date.now();
      if (m.t === "pong") return;
      if (m.t === "start" && game) game.status = "racing";
      if (m.t === "you") { myId = m.id; myToken = m.token || null; } else if (m.t === "games") games = m.list; else if (m.t === "room") game = m.game; else if (m.t === "closed") { game = null; chat.push(`— ${m.text}`); }
      else if (m.t === "chat") chat.push(m.from ? `${m.from}: ${m.text}` : m.text);
      if (chat.length > 60) chat.splice(0, chat.length - 60);
      for (const l of listeners) l(m);
    };
  }).finally(() => { connecting = null; connectingRoom = null; });
  return connecting;
}

export async function manoLobby(ctx) {
  const {menuScreen,esc,S,TRACKS,CHARS,t} = ctx;
  let online = !!ctx.online; // "Race Online": public races with strangers (relay: auto rooms)
  let cancelOutcome=null;
  let racing=false, joiningVia=null, disposed=false, pending=false, notice='', codeValue=ctx.invite || '', view='entry', settingsOpen=false, round=null, latestResults=null;
  listeners.clear();
  const cleanURL = () => { const url=new URL(location.href);url.searchParams.delete('room');history.replaceState(null,'',url); };
  const exit = () => {disposed=true;listeners.clear();document.removeEventListener('visibilitychange',onVisible);send({t:'leave'});keepResume(null);disconnect();cleanURL();ctx.back();};
  // Reconnect quietly after a dropped connection (refresh, background tab, phone switching apps).
  let roomCode = null, rejoining = 0;
  async function rejoin() {
    if (disposed || racing || !roomCode || sock || connecting) return;
    const code = roomCode; rejoining++; notice = 'Reconnecting…'; setNotice(notice);
    if (await ensureConnected(savedResume()?.room ?? (online ? `pub:${code}` : code))) send(online ? { t: 'quick', char: 0 } : { t: 'join', code, char: 0 });
  }
  function onVisible() { if (document.visibilityState === 'visible') rejoin(); }
  document.addEventListener('visibilitychange', onVisible);
  const inviteURL = () => {const url=new URL('https://roadrash.fun/');url.searchParams.set('room',game?.code||roomCode||'');return url.href;};
  const setNotice = (text,error=false) => {notice=text;const el=ctx.app.querySelector('[data-notice]');if(el){el.textContent=text;el.classList.toggle('error',error);}};
  const setName = input => {const n=input.value.trim().slice(0,16);if(n){S.name=n;S.nameAuto=false;ctx.persist();}input.value=S.name;send({t:'hello',name:S.name});};
  let hostTries = 0, joinCode = null, reviving = false, missingCode = null;
  async function createRoom() {
    if(await ensureConnected(newRoomCode()))send({t:'host',private:true,char:0,level:1,cars:false,ai:false});
  }
  async function ensureConnected(room) {
    try {await connect(S.name || 'Player 1', room);return true;}catch{pending=false;notice="Couldn't connect. Check your connection and try again.";renderEntry();setNotice(notice,true);return false;}
  }
  function renderEntry() {
    if(cancelOutcome)return;
    if(online)return renderOnline();
    view='entry';
    const root=menuScreen('Play with Friends', `<p>Race people online, or make a private room for your friends. No account needed.</p>
      <div class="menu-columns three"><section class="menu-card"><h2>Race online</h2><p>Jump into a race with riders around the world. Starts in seconds.</p><button class="primary" data-online ${pending?'disabled':''}>Find a Race</button></section>
      <section class="menu-card"><h2>Race your friends</h2><p>Make a private room and send the link. You pick the track and when to start.</p><button data-create ${pending?'disabled':''}>${pending?'Connecting…':'Create Room'}</button></section>
      <form class="menu-card" data-join><h2>Have an invite?</h2><label>Room code or invite link<input data-code inputmode="numeric" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="e.g. 0427" required></label><div class="menu-actions"><button type="submit" ${pending?'disabled':''}>Join Room</button></div></form></div>
      <p class="menu-message" data-notice role="status" aria-live="polite"></p>${missingCode ? `<button data-reopen ${pending?'disabled':''}>Reopen room ${esc(missingCode)}</button>` : ''}`,{back:exit});
    root.classList.add('wide-screen');
    root.querySelector('[data-code]').value=codeValue;
    root.querySelector('[data-code]').oninput=e=>{codeValue=e.target.value;};
    root.querySelector('[data-create]').onclick=()=>{pending=true;hostTries=0;renderEntry();createRoom();};
    root.querySelector('[data-online]').onclick=()=>{track('menu_choice',{choice:'online'});online=true;findTries=0;findRace();};
    root.querySelector('[data-join]').onsubmit=e=>{e.preventDefault();join(codeValue);};
    root.querySelector('[data-reopen]')?.addEventListener('click', async () => {
      const code = missingCode; missingCode = null; pending = true; notice = 'Reopening room…'; renderEntry();
      if (await ensureConnected(code)) { joinCode = code; reviving = true; send({t:'host',private:true,char:0,level:1,cars:false,ai:false}); }
    });
    setNotice(notice);
  }
  async function join(input) {
    let code=input.trim();try{const url=new URL(code);code=url.searchParams.get('room')||'';}catch{}
    code=code.replace(/[\s-]/g,'').toUpperCase();codeValue=code;
    if(!/^(?:[0-9]{4}|[A-Z2-9]{6})$/.test(code)){setNotice('Enter the four-digit room code or paste the invite link.',true);return;}
    missingCode=null;pending=true;notice='Joining your friend…';renderEntry();
    const back=savedResume()?.code===code;
    joiningVia=back?null:ctx.invite&&code===ctx.invite?'invite':'code';joinCode=code;reviving=false;if(!back)track('room_join_requested',{via:joiningVia});if(await ensureConnected(code))send({t:'join',code,char:0});
  }
  // ---- Race Online ----
  let startsAt=null, findTries=0, tick=null;
  async function findRace() {
    pending=true;notice='Finding riders…';renderOnline();
    if(await ensureConnected('pub:new'))send({t:'quick',char:0});
  }
  function renderOnline() {
    if(disposed||racing||cancelOutcome)return;
    clearInterval(tick);
    const names=new Map((round?.order||game?.players||[]).map(p=>[p.id,p.name]));
    const scores=latestResults;
    const standings=scores ? Object.entries(scores).sort((a,b)=>(a[1].status==='finished'?a[1].time:Infinity)-(b[1].status==='finished'?b[1].time:Infinity)) : [];
    const results=standings.length ? `<section><table class="room-results" aria-label="Final standings"><thead><tr><th>Rider</th><th>Result</th></tr></thead><tbody>${standings.map(([id,r],i)=>`<tr><td>${esc(names.get(id)||'Rider')}${id===myId?' (you)':''}</td><td>${r.status==='finished'?`#${i+1} · ${Math.floor(r.time/60)}:${(r.time%60).toFixed(2).padStart(5,'0')}`:({quit:'Left race',unavailable:'Could not load',wrecked:'Wrecked',busted:'Busted'}[r.status]||'Left race')}</td></tr>`).join('')}</tbody></table></section>`:'';
    const waiting=game?.status==='racing'&&game.racers&&!game.racers.includes(myId);
    const root=menuScreen(standings.length?'Race Results':'Race Online',`${results}<div class="menu-card online-card">
      ${game?`<p class="online-next" data-countdown aria-live="polite"></p><h2>Riders · ${game.players.length}/8</h2><ul class="room-players">${game.players.map(p=>`<li><span>${esc(p.name)}${p.id===myId?' (you)':''}</span><small>${p.away?'Reconnecting…':''}</small></li>`).join('')}</ul>`:`<p>${pending?'Finding riders…':'Race people from around the world. No account needed.'}</p>`}
      </div><p class="menu-message" data-notice role="status" aria-live="polite"></p>
      <div class="room-launch"><div>${game?'':'<button class="primary" data-find>Find a Race</button>'}<button data-leave>${game?'Leave Race':'Back'}</button></div></div>`,{back:exit});
    root.classList.add('friend-room','wide-screen');
    root.querySelector('[data-find]')?.addEventListener('click',()=>{findTries=0;findRace();});
    root.querySelector('[data-leave]').onclick=()=>{clearInterval(tick);send({t:'leave'});keepResume(null);disconnect();online=false;game=null;round=null;latestResults=null;roomCode=null;pending=false;notice='';renderEntry();};
    const cd=root.querySelector('[data-countdown]');
    // the room can go (connection lost, host closed it) while this screen is still up: stop ticking then
    const show=()=>{if(!cd)return;if(!game){clearInterval(tick);cd.textContent='';return;}if(waiting||game.status==='racing'){cd.textContent='A race is on. You’re in the next one.';return;}const sec=startsAt?Math.max(0,Math.ceil((startsAt-Date.now())/1000)):null;cd.textContent=sec==null?'Waiting for riders…':sec>0?`Next race starts in ${sec}s`:'Starting…';};
    show();if(cd)tick=setInterval(()=>{if(disposed||racing||!root.isConnected){clearInterval(tick);return;}show();},500);
    if(standings.length)offerInstall(root.querySelector('.menu-body'),S.raced||0)||offerPromo(root.querySelector('.menu-body'),S.raced||0,online?'online':'room');
    setNotice(notice);
  }
  function renderRoom() {
    if(disposed||racing||cancelOutcome)return;
    if(online)return renderOnline();
    if(!game)return renderEntry();
    view='room';
    const host=game.hostId===myId, active=game.status==='racing';
    const tour=!!game.spectate, canStart=host&&!active&&game.players.length>=2, waiting=active&&game.racers&&!game.racers.includes(myId)&&!(tour&&host);
    const standingsHTML=tour&&game.tally?.length?`<section class="menu-card tournament"><h2>Tournament · ${game.rounds} round${game.rounds===1?'':'s'}</h2><ol class="board-list">${game.tally.map(r=>`<li class="${r.id===myId?'me':''}"><span>${esc(r.name)}</span><span>${r.points} pts${r.wins?` · ${r.wins} win${r.wins===1?'':'s'}`:''}</span></li>`).join('')}</ol>${host?'<div class="menu-actions"><button data-reset-tally>Reset standings</button></div>':''}</section>`:'';
    const names=new Map((round?.order||game.players).map(p=>[p.id,p.name]));
    const scores=latestResults || (Object.keys(game.results||{}).length?game.results:null);
    const standings=scores ? Object.entries(scores).sort((a,b)=>(a[1].status==='finished'?a[1].time:Infinity)-(b[1].status==='finished'?b[1].time:Infinity)) : [];
    const results=standings.length ? `<section><table class="room-results" aria-label="Final standings"><thead><tr><th>Rider</th><th>Result</th></tr></thead><tbody>${standings.map(([id,r],i)=>`<tr><td>${esc(names.get(id)||'Player')}</td><td>${r.status==='finished'?`#${i+1} · ${Math.floor(r.time/60)}:${(r.time%60).toFixed(2).padStart(5,'0')}`:({quit:'Left race',unavailable:'Could not load',wrecked:'Wrecked',busted:'Busted'}[r.status]||'Left race')}</td></tr>`).join('')}</tbody></table></section>`:'';
    const root=menuScreen(standings.length ? (tour?'Round Results':'Race Results') : (tour?'Your Tournament':'Your Room'), `${results}${standingsHTML}${standings.length?'<details><summary>Room & players</summary>':''}<div class="menu-columns"><section class="menu-card"><h2>Invite your friends</h2><span class="menu-muted">Room code</span><strong class="room-code">${esc(game.code||'')}</strong>
      <div class="menu-actions"><button data-copy>Copy Invite Link</button><button class="icon-btn" data-wa>${WA_ICON}WhatsApp</button>${navigator.share?`<button class="icon-btn" data-share>${SHARE_ICON}Share</button>`:''}</div>
      <label style="margin-top:24px">Your name<input data-name maxlength="16" autocomplete="nickname"></label></section>
      <section class="menu-card"><h2>Riders · ${tour?game.players.length-1:game.players.length}/8</h2><ul class="room-players">${game.players.map(p=>`<li><span>${esc(p.name)}${p.id===myId?' (you)':''}</span><small>${p.away?'Reconnecting…':p.id===game.hostId?(tour?'Host · watching':'Host'):'Joined'}</small></li>`).join('')}</ul>
      <p class="room-status">${tour&&host?(active?'Round in progress.':game.players.length<2?'Invite riders to start the tournament.':'You’ll watch. Start the round when your riders are ready.'):waiting?'A race is on right now. You’ll ride in the next one.':active?'Waiting for the remaining riders to finish.':host?game.players.length<2?'Invite a friend to get started.':'Everyone is here. Start when you’re ready.':`Waiting for ${esc(game.host)} to start.`}</p></section></div>${standings.length?'</details>':''}
      <div class="menu-card" style="margin-top:24px"><label>Track<select aria-label="Track" data-track ${!host||active?'disabled':''}>${TRACKS.map(tr=>`<option value="${tr.id}">${esc(tr.name)}</option>`).join('')}</select></label><div data-track-map></div>
      <details data-race-settings ${settingsOpen?'open':''}><summary>Race Settings</summary><div class="menu-stack"><label>Difficulty<select aria-label="Difficulty" data-level ${!host||active?'disabled':''}>${[1,2,3,4,5].map(n=>`<option value="${n}">Level ${n}${n===1?' · Easy':''}</option>`).join('')}</select></label><label class="check-label"><input data-cars type="checkbox" ${!host||active?'disabled':''}> Cars</label><label class="check-label"><input data-ai type="checkbox" ${!host||active?'disabled':''}> Fill empty places with AI riders</label><label class="check-label"><input data-spectate type="checkbox" ${!host||active?'disabled':''}> Tournament: I watch, everyone else races (points every round)</label></div></details>
      </div><p class="menu-message" data-notice role="status" aria-live="polite"></p>
      <div class="room-launch"><div>${host?`<button class="primary" data-start ${canStart?'':'disabled'}>${standings.length?'Race Again':'Start Race'}</button>`:`<span class="launch-status">${waiting?'Race in progress · you’re next':active?'Race in progress':'Waiting for host…'}</span>`}<button data-leave>Leave Room</button></div></div>`,{back:exit});
    root.classList.add('friend-room','wide-screen');
    root.querySelector('[data-name]').value=S.name;
    root.querySelector('[data-name]').onchange=e=>setName(e.target);
    const trackPicker=root.querySelector('[data-track]');trackPicker.value=game.track||'city';trackPicker.onchange=()=>send({t:'settings',track:trackPicker.value});
    previewCourseMap(root.querySelector('[data-track-map]'),game.track||'city',game.level,TRACKS.find(t=>t.id===(game.track||'city'))?.name||'Track');
    const level=root.querySelector('[data-level]');level.value=game.level;level.onchange=()=>send({t:'settings',level:+level.value});
    for(const key of ['cars','ai','spectate']){const input=root.querySelector('[data-'+key+']');input.checked=game[key];input.onchange=()=>send({t:'settings',[key]:input.checked});}
    root.querySelector('[data-race-settings]').ontoggle=e=>{settingsOpen=e.target.open;};
    root.querySelector('[data-reset-tally]')?.addEventListener('click',()=>{if(confirm('Reset the tournament standings?'))send({t:'settings',resetTally:true});});
    root.querySelector('[data-start]')?.addEventListener('click',e=>{e.target.disabled=true;send({t:'start'});});
    root.querySelector('[data-leave]').onclick=()=>{send({t:'leave'});keepResume(null);roomCode=null;disconnect();game=null;round=null;latestResults=null;notice='';cleanURL();renderEntry();};
    root.querySelector('[data-copy]').onclick=async()=>{
      try{await navigator.clipboard.writeText(inviteURL());track('invite_shared',{method:'copy'});setNotice('Invite link copied. Send it to your friends.');}
      catch{const label=document.createElement('label');label.textContent='Copy this invite link';const input=document.createElement('input');input.readOnly=true;input.value=inviteURL();label.append(input);root.querySelector('[data-notice]').replaceChildren(label);input.focus();input.select();}
    };
    root.querySelector('[data-wa]').onclick=()=>{window.open(shareLinks('Race me in Road Rash! Tap to join my room:',inviteURL()).wa,'_blank','noopener');track('invite_shared',{method:'whatsapp'});};
    if(standings.length)offerInstall(root.querySelector('.menu-body'),S.raced||0)||offerPromo(root.querySelector('.menu-body'),S.raced||0,online?'online':'room');
    root.querySelector('[data-share]')?.addEventListener('click',async()=>{try{await navigator.share({title:'Race with me — Road Rash',url:inviteURL()});track('invite_shared',{method:'share'});}catch{}});
    const url=new URL(location.href);url.searchParams.set('room',game.code);history.replaceState(null,'',url);
    setNotice(notice);
  }
  listeners.add(m=>{
    if(disposed)return;
    if(m.t==='start'){if(!racing){cancelOutcome?.();startRace(m);}return;}
    if(m.t==='race_end'){latestResults=m.results;if(m.text)notice=m.text;}
    if(m.t==='room'){roomCode=game.code;rejoining=0;if(game.auto)startsAt=game.startIn==null?null:Date.now()+game.startIn;if(myToken)keepResume({room:game.auto?`pub:${game.code}`:sockRoom,code:game.code,token:myToken});if(notice==='Reconnecting…'||notice==='Joining your friend…'||notice==='Finding riders…')notice='';if(reviving&&game.hostId===myId){reviving=false;notice='That room had closed, so it’s yours now. Anyone else with the same link will join you.';track('room_revived',{});}if(joiningVia&&game.hostId!==myId){track('room_entered',{via:joiningVia,riders:game.players.length});joiningVia=null;}const me=game.players.find(p=>p.id===myId);if(me&&S.name==='Player 1'){S.name=me.name;ctx.persist();}pending=false;if(!racing)renderRoom();}
    if(m.t==='rejected'&&online&&m.reason==='full'&&findTries++<4){findRace();return;}
    if(m.t==='rejected'){if(m.reason==='taken'&&reviving&&joinCode){reviving=false;send({t:'join',code:joinCode,char:0});return;}
      if(m.reason==='taken'&&pending&&hostTries++<5){createRoom();return;}
      if(m.reason==='not found'&&joinCode&&joinCode===ctx.invite&&!reviving&&sockRoom===joinCode){reviving=true;send({t:'host',private:true,char:0,level:1,cars:false,ai:false});return;}
      if(m.reason==='not found'&&!joinCode){roomCode=null;keepResume(null);}
      missingCode=m.reason==='not found' && /^[0-9]{4}$/.test(joinCode||'') ? joinCode : null;
      reviving=false;if(!game)disconnect();pending=false;notice=missingCode ? `Room ${missingCode} has closed or doesn't exist. Check the code, or reopen it for your friends.` : m.text;if(!racing){game?renderRoom():renderEntry();setNotice(notice,true);}}
    if(m.t==='closed'&&m.lost&&roomCode&&rejoining<4){setTimeout(rejoin,[0,1000,3000,6000][rejoining]);if(!racing){notice='Reconnecting…';setNotice(notice);}return;}
    if(m.t==='closed'){pending=false;roomCode=null;keepResume(null);notice=m.text||'The host left. Create a new room or ask for another invite.';if(!racing){renderEntry();setNotice(notice,true);}}
  });
  async function startRace(m) {
    racing = true; round = m; latestResults = null; notice = ""; const { S: st, SPEC, BIKES, raceBike, riderOpts, runRace } = ctx;
    const lvl = m.level, course = TRACKS.find((x) => x.id === m.track), host = !m.solo && (m.order[0].id === myId || game?.hostId === myId); // nobody hosts shared A.I. in public races
    const bikeOf = (row) => BIKES.find((b) => b.id === SPEC.rivals[row][lvl - 1]) || BIKES[0];
    const peers = [], used = new Set();
    m.order.forEach((p, k) => { const c = CHARS[p.char ?? 0]; used.add(c.row); if (p.id !== myId) peers.push({ id: p.id, name: p.name || c.short, scheme: c.scheme, slot: k, bike: raceBike(bikeOf(c.row)), ...riderOpts(c.rider), row: c.row }); });
    // limited A.I. bikers: fill the field to 8 from the other rider rows, the same on every machine (seeded by the host)
    let seed = m.seed; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const rows = [...SPEC.rivals.keys()].filter((r) => !used.has(r)).sort(() => rnd() - 0.5), bots = [];
    // public races: every rider gets their own A.I. field (the rest of the 16-rider grid), not shared over the network
    if (m.solo) for (let k = 0; k < Math.min(rows.length, 16 - m.order.length); k++) { const row = rows[k]; bots.push({ slot: row, name: t(320 + (row % 20)) || `Biker ${k + 1}`, scheme: (row * 3 + 1) % 15,
      skill: 0.9 + lvl * 0.015 + rnd() * 0.06, bike: raceBike(bikeOf(row)), ...riderOpts(SPEC.riders[row]) }); }
    if (m.ai) for (let k = 0; k < Math.max(0, 8 - m.order.length); k++) { const row = rows[k]; bots.push({ botId: `bot:${k}`, slot: row, name: t(320 + (row % 20)) || `Biker ${k + 1}`, scheme: (row * 3 + 1) % 15,
      skill: 0.92 + lvl * 0.015, bike: raceBike(bikeOf(row)), ...riderOpts(SPEC.riders[row]) }); }
    const spectating = m.spectator === myId; // tournament host: watches, doesn't race
    const meIdx = m.order.findIndex((p) => p.id === myId), c = CHARS[m.order[meIdx]?.char ?? 0];
    const raceSend = msg => send({...msg,raceId:m.raceId});
    const net = { id: myId, raceId: m.raceId, host, peers, send: raceSend, ready: () => raceSend({ t: "ready" }), onMessage: null };
    const relay = (msg) => {
      if (msg.raceId && msg.raceId !== m.raceId) return;
      if (msg.t === "race_end") { net.roundEnded = true; latestResults = msg.results; }
      if (msg.t === "closed" || (msg.t === "race_end" && msg.text)) {
        net.disconnected = msg.text || "Disconnected";
        net.interruption = { interruption_kind: msg.t === "race_end" ? "round_cancelled" : msg.lost ? "socket_lost" : "room_closed",
          interruption_reason: msg.reason || msg.cause || (msg.t === "race_end" ? "round_ended" : "room_closed"), socket_code: msg.code, tab_hidden: document.hidden };
        track('race_interrupted', {race_id:m.raceId, ...net.interruption});
        net.onMessage?.({t:"closed",text:net.disconnected});
      } else if (["state", "hit", "left", "go"].includes(msg.t)) net.onMessage?.(msg);
    };
    listeners.add(relay);
    ctx.menuMusic(false); ctx.app.innerHTML = `<div id="race"></div>`; ctx.setKeys(null);
    const song = ctx.raceSong();
    const res = await runRace({ container: document.getElementById("race"), quitText: t(316), course: course.id, scheme: c.scheme, rivals: bots, music: song.url, playerName: m.order[meIdx]?.name || c.short,
      bike: raceBike(bikeOf(c.row)), rider: riderOpts(c.rider), slot: spectating ? 0 : meIdx, level: lvl, spectate: spectating, brains: SPEC.brains, swing: SPEC.swing, band: SPEC.band, traffic: m.cars, mix: st.mix,
      view: st.view || "chase", onView: (v) => { st.view = v; ctx.persist(); }, net, publicRace: !!m.solo });
    listeners.delete(relay); racing = false;
    raceSend({t:"fin",status:res?.status || "quit",time:res?.time});
    if (disposed) return;
    if (!spectating && ['finished', 'busted', 'wrecked'].includes(res?.status)) {
      await new Promise(resolve => { cancelOutcome = playOutcomeVideo(ctx.video, res, resolve); });
      cancelOutcome = null;
      if (disposed || round !== m || racing) return;
    }
    ctx.menuMusic();
    if (res?.status === 'unavailable') notice = net.disconnected || "The track couldn't load. Try starting again.";
    else if (net.disconnected) notice = net.disconnected;
    else if (res?.status === 'quit') notice = spectating ? "You stopped watching; the round goes on." : "You left the race.";
    else if (res?.status === 'spectated') notice = "Round over.";
    view = 'room'; renderRoom();
    res?.score?.then((b) => { if (!b || disposed || racing) return; const r = b.day?.city?.rank ? ` · #${b.day.city.rank} in ${b.day.city.name} today` : b.day?.world?.rank ? ` · #${b.day.world.rank} in the world today` : ''; notice = `+${b.points} leaderboard points${r}`; setNotice(notice); });
  }
  if(online){findRace();return;}
  renderEntry();
  if(ctx.invite)join(ctx.invite);
}
