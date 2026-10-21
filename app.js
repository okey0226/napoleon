import { matchRatingChanges, computeEloDelta, ELO_INIT, quantizeStrength, rankTierOf, trickPhaseOf, pointsTierOf } from './constants.js';
import {
  shouldBid, chooseDiscard, chooseDeputyCall, chooseSoloCall, chooseCardToPlay, chooseDeputyCard,
  winningEntry, strongestSuit, colorStrength, ntHandStrength
} from './ai-tactics.js';

const SUITS=['♣','♦','♥','♠'],SV={'♣':1,'♦':2,'♥':3,'♠':4,NT:5},RANKS=['2','3','4','5','6','7','8','9','10','J','Q','K','A'],FACE=['10','J','Q','K','A'],POINT=['10','J','Q','K','A'],$=id=>document.getElementById(id);

function safeJsonParse(str, fallback = null) {
  try { if (typeof str !== 'string' || !str.trim()) return fallback; return JSON.parse(str); }
  catch (e) { console.warn('[safeJsonParse] failed:', e.message); return fallback; }
}
function sanitizeMessage(msg) { return String(msg == null ? '' : msg).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 500); }
async function readResponse(res) {
  const text = await res.text().catch(() => '');
  let data = null, parseError = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { parseError = e; }
  return { data, text, parseError, ok: res.ok, status: res.status };
}

const CALIBRATION={13:0.62,14:0.55,15:0.45,16:0.35,17:0.25,18:0.15,19:0.08,20:0.04};
const g={round:1,rate:1000,elo:ELO_INIT,mult:1,botLevel:3,aiWeights:{bidThreshold:4.0,riskTolerance:0.5,leadAggression:0.6,followAggression:0.4,trumpBonus:0.6,mightyBonus:2.0,safeAceWeight:0.7,roleCardPreservation:0.6,deputyFeedBias:0.5,opponentInferenceWeight:0.4,suitConflictWeight:0.6,mightyShadowWeight:0.3,weakOpponentBoost:0.3,bluffLossMultiplier:0.6,cooperationBonus:0.5,ntPreference:0.85,ntSuitLengthBonus:1.2,ntAceWeight:1.5,ntMightyBonus:2.5,highBidNtThreshold:17,aceWeakSuitBonus:0.3,aceShortBonus:0.15,aceLongPenalty:0.15,sameTwoAceCounter:0.3,sameTwoShortBonus:0.4,sameTwoLongPenalty:0.25,sameTwoHighBidBonus:0.2,trumpExhaustionThreshold:3,baitModeWindow:2,baitMinTrumps:4,strongTrumpLeadAggression:0.7,aceCashUrgency:1.0,pointCardSafetyThreshold:0.5,tenHoldThreshold:0.6,nonTrumpAceWaiting:0.5,baitBackJWindow:3,baitBackJChance:0.6,faceCardOnNapWin:0.9,preserveNextStronger:0.9,deputyRevealUrgency:0.5,deputyCoverWeight:0.5,sameTwoDeputyBonus:0.5,allyFaceCardBonus:0.9,napWeaknessLeadWeight:0.8,trumpAvoidWeight:0.9,sameColorSuitAvoid:0.8,spadeLeadPriority:0.7,nonDeclaredSuitWeight:0.6,queenHoardWeight:0.6,sameTwoHoardWeight:0.5,allyYieldBonus:0.5,allySameTwoLeadChance:0.55,allySameTwoWindow:4},players:[],kitty:[],allianceKittyPoints:0,auction:null,contract:null,trick:[],trickNo:0,points:[0,0,0,0,0],matchScores:[0,0,0,0,0],matchArt:[0,0,0,0,0],matchStats:[],matchContracts:[],playoff:false,appealInfo:'',roundArt:[0,0,0,0,0],phase:'',bid:13,suit:'♠',timer:[],greenRedraws:0,selectedCard:null,onlineSelectedCard:null,user:null,account:null,sessionToken:null,room:null,presenceRoom:null,online:null,leaderboardExpanded:false,announcedCallRound:null,announcedRound:null,localLog:null,matchDebugLog:null,playedCards:[],voids:[{},{},{},{},{}],aiExperience:null,humanRoundLog:null};let toastTimer;
function toast(t){const e=$('toast');if(!e)return;e.textContent=t;e.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>e.classList.remove('show'),2600)}
function screen(id){['home-screen','mode-select-screen','profile-screen','game-screen','records-screen','strategy-screen'].forEach(x=>{const el=$(x);if(el)el.classList.toggle('hidden',x!==id)});if(id==='mode-select-screen'){loadLeaderboard();loadAccount();startPresence()}if(id==='strategy-screen'){loadStrategyLab()}}
function startPresence(){if(g.presenceRoom||!window.WebsimSocket?.joinRoom)return;const pending=window.WebsimSocket.joinRoom();g.presenceRoom=pending;pending.then(room=>{if(g.presenceRoom!==pending){room.close?.();return}g.presenceRoom=room;room.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch{return}if(m.type==='presence'){const el=$('concurrent-count');if(el)el.textContent='同接: '+m.count+'人'}}}).catch(()=>{if(g.presenceRoom===pending)g.presenceRoom=null})}
async function stopPresence(){const current=g.presenceRoom;g.presenceRoom=null;try{(await current)?.close?.()}catch{}}
function later(fn,ms){g.timer.push(setTimeout(fn,ms))}
function clearTimers(){g.timer.forEach(clearTimeout);g.timer=[]}
function closeOnline(){clearTimers();clearTimeout(g.auction?.humanTimeout);g.room?.close?.();g.room=null;g.online=null;g.onlineState=null;g.privateHand=[];g.onlineLegal=[];g.onlineSelectedCard=null;const ac=$('auction-clock');if(ac)ac.classList.add('hidden')}
function message(t){const el=$('table-message');if(el)el.textContent=t}
function addGameLog(text){if(!g.localLog)return;g.localLog.push({round:g.round,text});if(g.localLog.length>300)g.localLog.shift();const cnt=$('game-log-count');if(cnt)cnt.textContent=String(g.localLog.length);if($('game-log-dialog')?.open)renderGameLog()}
function renderGameLog(){const list=$('game-log-list');if(!list)return;list.innerHTML=g.localLog?.length?g.localLog.map(entry=>'<article class="game-log-entry"><small>第'+entry.round+'局</small><span>'+escapeHTML(entry.text)+'</span></article>').join(''):'<p class="game-log-empty">まだログはありません</p>';list.scrollTop=list.scrollHeight}
function openGameLog(){renderGameLog();$('game-log-dialog')?.showModal()}

function addDebugLog(type,data){if(!g.matchDebugLog)g.matchDebugLog=[];const entry={t:Date.now(),type};if(data&&typeof data==='object'){for(const k in data){try{entry[k]=data[k]}catch{}}}g.matchDebugLog.push(entry);if(g.matchDebugLog.length>3000)g.matchDebugLog.shift()}
function sanitizeForLog(obj,depth=0){if(depth>6)return'[deep]';if(obj===null||obj===undefined)return obj;const t=typeof obj;if(t==='function')return'[fn]';if(t==='string'||t==='number'||t==='boolean')return obj;if(Array.isArray(obj))return obj.map(x=>sanitizeForLog(x,depth+1));if(t==='object'){const out={};for(const k in obj){try{out[k]=sanitizeForLog(obj[k],depth+1)}catch{out[k]='[err]'}}return out}return String(obj)}
function buildLogPayload(){const contract=g.contract?{nap:g.contract.nap,num:g.contract.num,suit:g.contract.suit,deputy:g.contract.deputy,solo:g.contract.solo,call:g.contract.call,revealedCall:g.contract.revealedCall,revealTrickNo:g.contract.revealTrickNo,strengthAtBid:g.contract.strengthAtBid}:null;return{version:'v1.5',timestamp:new Date().toISOString(),userAgent:navigator.userAgent,url:location.href,phase:g.phase,round:g.round,botLevel:g.botLevel,aiWeights:sanitizeForLog(g.aiWeights),account:g.account?{id:g.account.id,rating:g.account.rating,elo:g.account.elo}:null,contract,allianceKittyPoints:g.allianceKittyPoints,players:(g.players||[]).map((p,i)=>({seat:i,name:p.name,bot:p.bot,handCount:p.hand?.length??0,roundPoints:p.roundPoints??0,taken:(p.taken||[]).map(c=>c.id)})),kitty:(g.kitty||[]).map(c=>c.id),matchScores:g.matchScores,matchArt:g.matchArt,matchContracts:g.matchContracts,bidHistory:g.bidHistory,trickNo:g.trickNo,trick:(g.trick||[]).map(e=>({seat:e.player,card:e.card?.id})),playedCards:g.playedCards,voids:g.voids,localLog:g.localLog,debugLog:g.matchDebugLog,humanRoundLog:g.humanRoundLog}}
function downloadLog(){try{const payload=buildLogPayload();const json=JSON.stringify(payload,null,2);const blob=new Blob([json],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');const ts=new Date().toISOString().replace(/[:.]/g,'-');a.href=url;a.download='napoleon-log-'+ts+'.json';document.body.appendChild(a);a.click();setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(url)},100);toast('ログをダウンロードしました')}catch(e){console.error('download failed',e);toast('ダウンロードに失敗しました: '+e.message)}}
function logPlayDecision(seat,card,reasonInfo,context){try{addDebugLog('play-decision',{seat,round:g.round,trickNo:g.trickNo,card:card?.id,reason:reasonInfo?.reason,detail:sanitizeForLog(reasonInfo?.detail),context:sanitizeForLog(context)})}catch(e){addDebugLog('play-decision-log-error',{message:e?.message})}}
function buildPlayContext(seat){return{hand:(g.players[seat]?.hand||[]).map(c=>c.id),trick:(g.trick||[]).map(x=>({seat:x.player,card:x.card?.id})),contract:g.contract?{nap:g.contract.nap,num:g.contract.num,suit:g.contract.suit,solo:g.contract.solo,deputy:g.contract.deputy,call:g.contract.call,revealedCall:g.contract.revealedCall}:null,aiWeights:g.aiWeights,points:g.points.slice(),roundPoints:g.players.map(p=>p.roundPoints||0),matchScores:g.matchScores.slice(),voids:g.voids,playedCards:g.playedCards}}

function phase(t){const roundTag=g.playoff?'プレーオフ · ':g.round===9?'ラス前 · ':g.round>=10?'オールラスト · ':'';const pl=$('phase-label');if(pl)pl.textContent=roundTag+t;const gs=$('game-screen');if(gs)gs.classList.toggle('auctioning',g.phase==='auction');renderContractInfo()}
function name(i){return i===0?'あなた':g.players[i]?.name||'COM '+i}
function color(s){return s==='♥'||s==='♦'?'red':''}
function cardEl(c,extra){const e=document.createElement('div');e.className='card '+(c?color(c.suit):'')+' '+(extra||'');if(c)e.innerHTML='<span class="rank">'+c.rank+'</span><span class="suit">'+c.suit+'</span>';return e}

function renderContractInfo(){
  const box=$('contract-info');
  if(!box)return;
  const contract=g.contract;
  if(contract){
    box.classList.remove('hidden');
    const bid=document.createElement('strong');
    bid.className='contract-bid';
    bid.textContent='宣言 '+contract.num+contract.suit;
    const label=document.createElement('span');
    label.className='contract-call-label';
    label.textContent='副官札';
    const parts=[bid,label,contract.call?cardEl(contract.call,'contract-card'):Object.assign(document.createElement('span'),{className:'contract-pending',textContent:'指名前'})];
    if(g.allianceKittyPoints>0){
      const kp=document.createElement('span');
      kp.className='contract-call-label';
      kp.textContent='捨て札 '+g.allianceKittyPoints+'pt(連合軍)';
      parts.push(kp);
    }
    box.replaceChildren(...parts);
    return
  }
  box.classList.add('hidden');
  box.replaceChildren()
}

function showKittyBacks(){const el=$('kitty-view');if(el)el.replaceChildren(cardEl(null,'card-back'),cardEl(null,'card-back'))}
function showOpenKitty(){const label=document.createElement('span');label.className='open-label';label.textContent='オープン';const el=$('kitty-view');if(el)el.replaceChildren(label,...g.kitty.map(c=>cardEl(c)))}
function showDiscardedKitty(){
  const label=document.createElement('span');
  label.className='open-label';
  label.textContent='捨て札';
  const cards=(g.kitty||[]).map(c=>cardEl(c));
  const el=$('kitty-view');
  if(!el)return;
  if(cards.length)el.replaceChildren(label,...cards);
  else el.replaceChildren();
}
function deck(){let d=[];SUITS.forEach(s=>RANKS.forEach(r=>d.push({suit:s,rank:r,id:s+r})));for(let i=d.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]]}return d}
function sort(h){h.sort((a,b)=>SV[b.suit]-SV[a.suit]||RANKS.indexOf(b.rank)-RANKS.indexOf(a.rank))}

function soloMinimumBid(gap,mult){return 13+Math.floor(Math.max(0,gap)/(10*Math.max(1,mult)))}

function computeTeamMinBid(scores,mult,napSeat,deputySeat){
  const ranked=scores.map((s,i)=>({s,i})).sort((a,b)=>a.s-b.s||a.i-b.i);
  const S5=ranked[0].s,S4=ranked[1].s,S3=ranked[2].s;
  const bottomSeat=ranked[0].i,fourthSeat=ranked[1].i;
  const m=Math.max(1,mult);
  const f=(gap,denom)=>Math.floor(Math.max(0,gap)/denom);
  if(napSeat===bottomSeat&&deputySeat===fourthSeat){const a=13+f(S4-S5,2*m),b=13+f(S3-S4,4*m),raw=Math.max(a,b);const broken=b>20,soloBid=soloMinimumBid(S4-S5,m);return{minBid:broken?Math.min(20,soloBid):Math.min(20,raw),rawMin:broken?soloBid:raw,canOvertake:(broken?soloBid:raw)<=20,incentiveBroken:broken,soloRequired:broken,soloMinBid:Math.min(20,soloBid),soloRawMin:soloBid,soloPossible:soloBid<=20,case:'A',details:{S3,S4,S5,needNapOverDeputy:a,needDeputyOverThird:b,soloNeed:soloBid}}}
  if(napSeat===fourthSeat&&deputySeat===bottomSeat){const a=13+f(S3-S4,6*m),b=13+f(S3-S5,4*m),c=13+f(S4-S5,2*m),raw=Math.max(a,b,c);return{minBid:Math.min(20,raw),rawMin:raw,canOvertake:raw<=20,incentiveBroken:a>20||b>20,soloRequired:false,case:'B',details:{S3,S4,S5,needNapOverThird:a,needDeputyOverThird:b,needDeputyOverNapOnLoss:c}}}
  if(napSeat===bottomSeat&&deputySeat!==fourthSeat){const raw=13+f(S4-S5,6*m);return{minBid:Math.min(20,raw),rawMin:raw,canOvertake:raw<=20,incentiveBroken:false,soloRequired:false,case:'C',details:{S3,S4,S5,needNapOverFourth:raw}}}
  if(napSeat===fourthSeat&&deputySeat!==bottomSeat){const raw=13+f(S4-S5,6*m);return{minBid:Math.min(20,raw),rawMin:raw,canOvertake:raw<=20,incentiveBroken:false,soloRequired:false,case:'D',details:{S3,S4,S5,needNapLoss:raw}}}
  return null;
}

function isSoloForced(){if(g.round<10||!g.contract)return false;const ranked=g.matchScores.map((s,i)=>({s,i})).sort((a,b)=>a.s-b.s||a.i-b.i);const bottomSeat=ranked[0].i;if(g.contract.nap!==bottomSeat)return false;const fourthSeat=ranked[1].i;const r=computeTeamMinBid(g.matchScores,g.mult,bottomSeat,fourthSeat);return r?.soloRequired===true}

function isSafeToCashAce(suit,seat){if(!g.contract)return false;if(suit==='♠')return true;if(g.trickNo>0){const twoPlayed=g.playedCards.some(c=>c.id===suit+'2');if(!twoPlayed){const anyVoid=[0,1,2,3,4].some(s=>s!==seat&&g.voids[s]&&g.voids[s][suit]);if(!anyVoid)return false}}if(g.contract.suit!=='NT'&&g.contract.suit!==suit){for(let s=0;s<5;s++){if(s===seat)continue;if(g.contract.revealedCall){if(s===g.contract.nap||(!g.contract.solo&&s===g.contract.deputy))continue}else{if(s===g.contract.nap)continue}if(g.voids[s]&&g.voids[s][suit])return false}}return true}

async function loadTopStrategy(){
  try {
    const res = await fetch('/api/ai/top-strategy');
    if (!res.ok) return;
    const { data } = await readResponse(res);
    if (data && data.strategy && typeof data.strategy === 'object') {
      for (const [k, v] of Object.entries(data.strategy)) if (typeof v === 'number' && Number.isFinite(v)) g.aiWeights[k] = v;
      if (data.source === 'learned' && data.generation) console.log('[AI] Top strategy loaded: gen ' + data.generation + ', avgRating: ' + data.avgRating);
    }
  } catch (e) { console.warn('[loadTopStrategy]', e?.message); }
}

async function loadExperience(){
  try {
    const res = await fetch('/api/ai/experience');
    if (!res.ok) return;
    const { data } = await readResponse(res);
    if (data && typeof data === 'object') g.aiExperience = data;
  } catch (e) { console.warn('[loadExperience]', e?.message); }
}

function sendRoundLearn(wonRound) {
  try {
    if (!g.humanRoundLog) return;
    const payload = {
      round: g.round,
      wonRound: wonRound === true,
      bid: g.humanRoundLog.bid || null,
      call: g.humanRoundLog.call || null,
      playDecisions: (g.humanRoundLog.playDecisions || []).filter(d => d.won !== null)
    };
    if (!payload.bid && !payload.call && !payload.playDecisions.length) return;
    fetch('/api/ai/learn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(() => loadExperience()).catch(() => {});
  } catch (e) { console.warn('[sendRoundLearn]', e?.message); }
}

function startLocal(){
  closeOnline();
  g.matchDebugLog=[];
  addDebugLog('match-start',{botLevel:g.botLevel,aiWeights:sanitizeForLog(g.aiWeights)});
  loadTopStrategy();
  g.aiExperience = null;
  loadExperience();
  g.localLog=[];
  const openLogBtn=$('game-log-open'); if(openLogBtn)openLogBtn.classList.remove('hidden');
  const logCnt=$('game-log-count'); if(logCnt)logCnt.textContent='0';
  g.botLevel=3;
  g.round=1;
  g.rate=Number.isFinite(Number(g.account?.rating))?Number(g.account.rating):1000;
  g.elo=Number.isFinite(Number(g.account?.elo))?Number(g.account.elo):ELO_INIT;
  g.mult=1;
  g.greenRedraws=0;
  g.playoff=false;
  g.appealInfo='';
  g.announcedRound=null;
  g.matchScores=Array(5).fill(0);
  g.matchArt=Array(5).fill(0);
  g.matchContracts=[];
  g.bidHistory=[];
  g.lastTrickWinner=null;
  g.playedCards=[];
  g.voids=[{},{},{},{},{}];
  g.allianceKittyPoints=0;
  g.matchStats=Array.from({length:5},()=>({declarerAttempts:0,declarerSuccesses:0,exactAttempts:0,exactSuccesses:0,boldAttempts:0,boldSuccesses:0,soloAttempts:0,soloSuccesses:0,deputyAttempts:0,deputySuccesses:0,artAttempts:0,dramaticPlays:0,allyFeedAttempts:0,allyFeedSuccesses:0,bidTotal:0}));
  g.players=Array.from({length:5},(_,i)=>({name:i?'COM '+i:'あなた',bot:i>0,hand:[],taken:[],roundTaken:[],roundPoints:0}));
  screen('game-screen');
  const modeLabel=$('game-mode-label'); if(modeLabel)modeLabel.textContent='COM戦';
  const ratCap=$('rating-caption'); if(ratCap)ratCap.textContent='SIM RATE';
  const ratLab=$('rating-label'); if(ratLab)ratLab.textContent=g.rate;
  roundStart()
}

function roundStart(){
  clearTimers();clearTimeout(g.auction?.humanTimeout);
  g.lastTrickWinner=null;g.phase='deal';g.contract=null;g.trick=[];g.trickNo=0;g.points=[0,0,0,0,0];g.roundArt=Array(5).fill(0);g.playedCards=[];g.voids=[{},{},{},{},{}];
  g.allianceKittyPoints=0;
  g.humanRoundLog = { round: g.round, bid: null, call: null, playDecisions: [] };
  g.players.forEach(p=>{p.roundTaken=[];p.roundPoints=0;});
  addGameLog('配札');
  const roundLab=$('round-label'); if(roundLab)roundLab.textContent=g.round;
  $('auction-panel')?.classList.add('hidden');$('call-panel')?.classList.add('hidden');$('play-panel')?.classList.add('hidden');$('result-panel')?.classList.add('hidden');
  $('trick-cards')?.replaceChildren();$('kitty-view')?.replaceChildren();$('auction-clock')?.classList.add('hidden');
  let d=deck();
  g.players.forEach(p=>{p.hand=d.splice(0,10);p.taken=[];sort(p.hand)});
  g.kitty=d.splice(0,2);
  renderHand();drawSeats();phase('配札');message('手札を確認しています');later(checkGreen,900)
}

function checkGreen(){let i=g.players.findIndex(p=>!p.hand.some(c=>FACE.includes(c.rank)));if(i>=0&&g.greenRedraws<5){if(i===0){phase('手札確認');message('10・J・Q・K・Aがありません。公開して配り直しますか？');const pp=$('play-panel');if(pp){pp.classList.remove('hidden');pp.innerHTML='<div class="panel-title">手札に10・J・Q・K・Aがありません</div><div class="panel-row"><button class="small-action" id="green-ok">公開して配り直す</button><button class="small-action pass" id="green-skip">続ける</button></div>';$('green-ok').onclick=()=>greenRedraw('あなた');$('green-skip').onclick=()=>{pp.classList.add('hidden');prepAuction()}}return}greenRedraw(name(i));return}prepAuction()}

function greenRedraw(n){
  addGameLog(n+'の手札条件により配り直し');
  g.greenRedraws++;
  g.mult=g.mult+1;
  $('play-panel')?.classList.add('hidden');
  const d=$('message-dialog');
  if(!d)return;
  const dt=$('dialog-title'),db=$('dialog-body'),dok=$('dialog-ok');
  if(dt)dt.textContent='手札を配り直します';
  if(db)db.textContent=n+'の手札に10・J・Q・K・Aがありません。倍率は'+g.mult+'倍です。';
  if(dok)dok.onclick=()=>{d.close();roundStart()};
  d.showModal()
}

function finalAuctionRule(scores,mult=1){const ranked=scores.map((score,seat)=>({score,seat})).sort((a,b)=>a.score-b.score||a.seat-b.seat),cutoff=ranked[1]?.score??0,gap=Math.max(0,(ranked[1]?.score??0)-(ranked[0]?.score??0)),rawMin=13+Math.floor(gap/(6*Math.max(1,mult)));return{eligible:ranked.filter(x=>x.score<=cutoff).map(x=>x.seat),bottomSeat:ranked[0]?.seat,fourthSeat:ranked[1]?.seat,thirdSeat:ranked[2]?.seat,thirdScore:ranked[2]?.score,minBid:Math.min(20,rawMin),canOvertake:rawMin<=20}}

function announceRound(round,rule){
  if(g.announcedRound===round||round<9)return;
  g.announcedRound=round;
  if(round===9){dialog('ラス前','第9局です。次はいよいよオールラストです。');return}
  const scores=g.matchScores||Array(5).fill(0);
  const ranked=scores.map((score,seat)=>({score,seat})).sort((a,b)=>b.score-a.score||a.seat-b.seat);
  const lines=ranked.map((e,i)=>(i+1)+'位 '+name(e.seat)+'  '+e.score+'点');
  const bottomSeat=ranked[4].seat,fourthSeat=ranked[3].seat;
  const S5=ranked[4].score,S4=ranked[3].score;
  const m=Math.max(1,g.mult||1);
  const caseA=computeTeamMinBid(scores,m,bottomSeat,fourthSeat);
  const caseB=computeTeamMinBid(scores,m,fourthSeat,bottomSeat);
  const caseC=computeTeamMinBid(scores,m,bottomSeat,bottomSeat);
  const caseD=computeTeamMinBid(scores,m,fourthSeat,fourthSeat);
  const caseEraw=soloMinimumBid(S4-S5,m);
  const caseE={minBid:Math.min(20,caseEraw),rawMin:caseEraw};
  const fmt=r=>{if(!r)return'—';if(r.soloRequired)return r.soloPossible?r.soloMinBid+'枚以上（一人立ち）':'20枚でも不足（一人立ち）';if(r.rawMin>20)return'20枚でも不足（逆転不可）';return Math.min(20,r.rawMin)+'枚以上'};
  const fmtE=r=>r.rawMin>20?'20枚でも不足（逆転不可）':r.minBid+'枚以上';
  const body=['現在の得点（全員）',lines.join('\n'),'','■ 5位が4位を逆転するための最低立ち（ケース別）','','【A】5位=ナポレオン / 4位=副官','  勝った時に5位も4位も3位を超える（4位が勝つインセンティブを保証）','  → '+fmt(caseA),(caseA?.soloRequired?'  ⚠ 4位が勝っても3位を超えられないため、5位は【一人立ち】が必須です':''),'','【B】4位=ナポレオン / 5位=副官','  勝った時に4位も5位も3位を超え、負けた時に5位が4位を逆転','  → '+fmt(caseB),'','【C】5位=ナポレオン / 4位=連合軍（副官は別）','  5位が4位を超えるだけでOK（3位超えは不要）','  → '+fmt(caseC),'','【D】4位=ナポレオン / 5位=連合軍','  ナポレオンが負けると5位が4位を逆転','  → '+fmt(caseD),'','【E】5位=ナポレオン（ひとり立ち） / 副官なし（4位以下は全員連合軍）','  → '+fmtE(caseE),'','※ アピールで副官が判明しない場合、ゲーム中に指名札が公開された時点で','   上記の該当ケースに合わせて立ちが変更されます。','   立ちが変わった際は画面上部の宣言・卓上メッセージ・局ログに表示されます。','','プレーオフ条件：5位が勝利して4位と同点なら再戦'].filter(x=>x!=='').join('\n');
  dialog(g.playoff?'プレーオフ':'オールラスト',body);
}

function prepAuction(){g.phase='prep';announceRound(g.round,finalAuctionRule(g.matchScores,g.mult));phase('競り準備');let n=7;message('競り開始まで '+n+' 秒');const tick=()=>{n--;if(n<=0){auctionStart();return}message('競り開始まで '+n+' 秒');later(tick,1000)};later(tick,1000)}

function scheduleHumanAuctionTimeout(){const auction=g.auction;if(!auction)return;clearTimeout(auction.humanTimeout);auction.humanTimeout=setTimeout(()=>{if(g.phase==='auction'&&g.auction===auction)humanApprove(true)},30000)}
function auctionActivity(){if(g.phase!=='auction'||!g.auction)return;g.auction.autoApprove[0]=false;scheduleHumanAuctionTimeout()}
function appealDetails(hand){const targets=[['♣J','♣J'],['♦J','♦J'],['♥J','♥J'],['♠J','♠J'],['マイティ（♠A）','♠A']];return targets.map(([label,id])=>label+'：'+(hand.some(c=>c.id===id)?'あり':'なし')).join(' · ')}

function enterAuction(){g.phase='auction';phase('競り');message(g.auction.requiredBidSeat===null?'順番なし。宣言するか、承認して競りを降りてください':name(g.auction.requiredBidSeat)+'が申告せず立つ選択。最低枚数以上で宣言してください');$('auction-panel')?.classList.remove('hidden');$('auction-clock')?.classList.add('hidden');scheduleHumanAuctionTimeout();drawAuction();drawSeats();scheduleComBids()}

function drawAppealOffer(){const p=$('auction-panel');if(!p)return;p.classList.remove('hidden');p.innerHTML='<div class="panel-title">オーラス・アピール</div><div class="micro-copy">4位にJ・マイティの所持を尋ねますか？</div><div class="panel-row"><button class="small-action" id="appeal-yes">アピールする</button><button class="small-action pass" id="appeal-no">競りへ進む</button></div>';p.querySelector('#appeal-yes').onclick=()=>answerLocalAppeal('appeal');p.querySelector('#appeal-no').onclick=()=>answerLocalAppeal('skip')}
function drawAppealResponse(){const p=$('auction-panel');if(!p)return;p.classList.remove('hidden');p.innerHTML='<div class="panel-title">5位からアピール</div><div class="micro-copy">所持するJ・マイティを申告するか、申告せず立つか選んでください。</div><div class="panel-row"><button class="small-action" id="appeal-disclose">札を申告する</button><button class="small-action pass" id="appeal-stand">申告せず立つ</button></div>';p.querySelector('#appeal-disclose').onclick=()=>answerLocalAppeal('disclose');p.querySelector('#appeal-stand').onclick=()=>answerLocalAppeal('stand')}
function answerLocalAppeal(choice){const rule=finalAuctionRule(g.matchScores,g.mult),fourth=rule.fourthSeat;if(choice==='skip'){g.appealInfo='5位はアピールせず競りへ';enterAuction();return}if(choice==='appeal'){if(fourth===0){g.phase='appeal-response';phase('アピール回答');message('4位は所持するJ・マイティを申告するか、申告せず立ちます');drawAppealResponse();return}g.appealInfo='4位の申告：'+appealDetails(g.players[fourth].hand);enterAuction();return}if(choice==='stand'){g.auction.requiredBidSeat=fourth;g.appealInfo='4位は申告せず立つことを選択';enterAuction();return}g.appealInfo='4位の申告：'+appealDetails(g.players[fourth].hand);enterAuction()}

function auctionStart(){
  addGameLog('競り開始');
  g.suit='♠';
  showOpenKitty();
  g.appealInfo='';
  const rule=g.round>=10?finalAuctionRule(g.matchScores,g.mult):null;
  g.auction={active:rule?rule.eligible:[0,1,2,3,4],minBid:rule?.minBid||13,high:{num:12,suit:'',player:-1},version:0,autoApprove:Array(5).fill(false),botBids:Array(5).fill(0),botSeen:Array(5).fill(-1),requiredBidSeat:null};
  g.bid=g.auction.minBid;
  g.active=-1;
  if(!rule){enterAuction();return}
  const bottom=rule.bottomSeat,fourth=rule.fourthSeat;
  if(bottom===0){g.phase='appeal-offer';phase('アピール');message('5位は4位にJ・マイティの所持を尋ねられます');drawAppealOffer();return}
  if(fourth===0){g.phase='appeal-response';phase('アピール回答');g.appealInfo='5位からのアピール';message('5位がアピールしました。所持する札を申告するか、申告せず立つか選んでください');drawAppealResponse();return}
  g.appealInfo='4位の申告：'+appealDetails(g.players[fourth].hand);
  enterAuction()
}

function bidHistoryHTML(history,getName){const entries=(history||[]).slice(-50).reverse();return'<div class="bid-history"><div class="bid-history-title">この対局の立ち履歴</div>'+(entries.length?'<div class="bid-history-list">'+entries.map(entry=>'<div class="bid-history-row player-color-'+entry.seat+'"><small>第'+entry.round+'局</small><span class="bid-player">'+escapeHTML(getName(entry.seat))+'</span><strong>'+entry.num+entry.suit+'</strong></div>').join('')+'</div>':'<div class="bid-history-empty">まだありません</div>')+'</div>'}

function drawAuction(){
  renderContractInfo();
  const p=$('auction-panel');if(!p)return;
  let h=g.auction.high,t=h.num<13?'なし':name(h.player)+' · '+h.num+h.suit;
  const ruleNote=g.round>=10?'<div class="micro-copy">オールラスト · 最低宣言 '+g.auction.minBid+' · 得点2倍 · 立ち必須</div>':'',historyPanel=bidHistoryHTML(g.bidHistory,i=>name(i)),appealPanel=g.appealInfo?'<div class="appeal-info">'+escapeHTML(g.appealInfo)+'</div>':'';
  p.classList.remove('hidden');
  if(g.auction.requiredBidSeat!==null&&g.auction.requiredBidSeat!==0){p.innerHTML='<div class="panel-title">4位が申告せず立ちを選択</div><div class="micro-copy">4位の宣言を待っています</div>'+appealPanel+historyPanel;return}
  if(!g.auction.active.includes(0)){p.innerHTML='<div class="panel-title">現在の宣言　<strong>'+t+'</strong></div><div class="micro-copy">承認済み</div>'+ruleNote+appealPanel+historyPanel;return}
  p.innerHTML='<div class="panel-title">現在の宣言　<strong>'+t+'</strong></div>'+ruleNote+appealPanel+'<div class="panel-row">'+SUITS.map(s=>'<button class="suit-choice '+color(s)+' '+(g.suit===s?'selected':'')+'" data-suit="'+s+'">'+s+'</button>').join('')+'<button class="suit-choice '+(g.suit==='NT'?'selected':'')+'" data-suit="NT">NT</button></div><div class="panel-row"><button class="small-action" id="bid-minus">−</button><span class="bid-number">'+g.bid+'</span><button class="small-action" id="bid-plus">＋</button></div><div class="panel-row"><button class="small-action pass" id="bid-approve" '+(g.auction.high.player===0&&g.auction.active.length>1||g.round>=10&&g.auction.high.num<13?'disabled':'')+'>承認</button><button class="small-action" id="bid-submit">宣言する</button></div>'+historyPanel;
  document.querySelectorAll('[data-suit]').forEach(b=>b.onclick=()=>{auctionActivity();g.suit=b.dataset.suit;drawAuction()});
  const minus=$('bid-minus'),plus=$('bid-plus'),approve=$('bid-approve'),submit=$('bid-submit');
  if(plus)plus.onclick=()=>{auctionActivity();g.bid=Math.min(20,g.bid+1);drawAuction()};
  if(minus)minus.onclick=()=>{auctionActivity();g.bid=Math.max(g.auction.minBid,g.bid-1);drawAuction()};
  if(approve)approve.onclick=()=>humanApprove();
  if(submit)submit.onclick=humanBid
}

function beatsBid(n,s){const h=g.auction.high;return n>=g.auction.minBid&&n>h.num||(n===h.num&&n>=13&&SV[s]>SV[h.suit])}
function removeBid(i){g.auction.active=g.auction.active.filter(x=>x!==i)}
function scheduleComBids(){if(g.phase!=='auction')return;const version=g.auction.version;for(let i=1;i<5;i++)if(g.auction.active.includes(i)&&g.auction.botSeen[i]<version)later(()=>comBid(i,version),500+Math.random()*1800)}

function humanApprove(forced=false){
  if(g.phase!=='auction'||!g.auction||!g.auction.active.includes(0))return;
  if(!g.auction.active.length){auctionEnd(-1);return}
  if(g.round>=10&&g.auction.high.num<13){if(forced&&(g.auction.requiredBidSeat??g.auction.active[0])===0){g.bid=g.auction.minBid;g.suit=strongestSuit(g.players[0].hand);humanBid()}return}
  if(!forced)auctionActivity();
  if(g.auction.high.player===0){if(g.auction.active.length===1)auctionEnd(0);else if(forced){g.auction.autoApprove[0]=true;message('30秒操作がなかったため、宣言者は自動承認待ちです')}return}
  removeBid(0);
  addGameLog(forced?'あなたが自動承認':'あなたが承認');
  message(forced?'30秒操作がなかったため、自動で承認しました':'あなたは承認しました');
  if(!g.auction.active.length){auctionEnd(-1);return}
  if(g.auction.active.length===1&&g.auction.high.player===g.auction.active[0]){const last=g.auction.active[0];if(g.auction.autoApprove[last]){auctionEnd(last);return}message(name(last)+'以外は承認しました。さらに宣言するか、承認して確定してください')}
  g.auction.active.filter(i=>i>0).forEach(i=>g.auction.botSeen[i]=g.auction.version-1);
  drawAuction();
  drawSeats();
  scheduleComBids()
}

function humanBid(){
  if(g.phase!=='auction'||!g.auction.active.includes(0)||g.auction.requiredBidSeat!==null&&g.auction.requiredBidSeat!==0)return;
  auctionActivity();
  if(!beatsBid(g.bid,g.suit)){toast('現在の宣言より強い宣言を選んでください');return}
  g.bidHistory.push({round:g.round,seat:0,num:g.bid,suit:g.suit});
  addGameLog('あなたが'+g.bid+g.suit+'を宣言');
  if(g.bidHistory.length>50)g.bidHistory.shift();
  g.auction.high={num:g.bid,suit:g.suit,player:0};
  if(g.auction.requiredBidSeat===0)g.auction.requiredBidSeat=null;
  g.auction.version++;
  g.active=0;
  g.bid=g.auction.high.num;
  g.suit=g.auction.high.suit;
  message('あなたが'+g.bid+g.suit+'を宣言しました');
  if(g.bid===20&&g.suit==='NT'){auctionEnd(0);return}
  drawAuction();
  drawSeats();
  scheduleComBids()
}

function comBid(i,version){
  if(g.phase!=='auction'||version!==g.auction.version||!g.auction.active.includes(i))return;
  if(g.auction.botSeen[i]>=version)return;
  if(g.auction.requiredBidSeat!==null&&g.auction.requiredBidSeat!==i)return;
  g.auction.botSeen[i]=version;
  const h=g.players[i].hand;
  const currentBids=(g.bidHistory||[]).filter(b=>b.round===g.round);
  const aiBid=shouldBid(h,g.auction.high,g.auction.minBid||13,g.aiWeights,currentBids,i,g.aiExperience);
  const forcedStand=(g.auction.requiredBidSeat===i)||(g.round>=10&&g.auction.high.num<13&&g.auction.active[0]===i);
  let b=null;
  if(aiBid&&beatsBid(aiBid.num,aiBid.suit)){
    b={num:aiBid.num,suit:aiBid.suit,solo:aiBid.solo===true};
  }else if(forcedStand){
    const suit=strongestSuit(h);const num=g.auction.minBid||13;
    b={num,suit,solo:false};
  }
  if(b){
    g.bidHistory.push({round:g.round,seat:i,num:b.num,suit:b.suit,solo:b.solo});
    addGameLog(name(i)+'が'+b.num+b.suit+(b.solo?'（ひとり立ち）':'')+'を宣言');
    if(g.bidHistory.length>50)g.bidHistory.shift();
    g.auction.botBids[i]++;
    g.auction.high={num:b.num,suit:b.suit,player:i,solo:b.solo===true};
    if(g.auction.requiredBidSeat===i)g.auction.requiredBidSeat=null;
    g.auction.version++;
    g.active=i;
    if(g.auction.autoApprove[0]&&g.auction.active.includes(0)){humanApprove(true);return}
    message(name(i)+'が'+b.num+b.suit+(b.solo?'（ひとり立ち）':'')+'を宣言しました');
    if(b.num===20&&b.suit==='NT'){auctionEnd(i);return}
    drawAuction();drawSeats();scheduleComBids();
    return;
  }
  if(g.auction.high.player===i){if(g.auction.active.length===1)auctionEnd(i);return}
  removeBid(i);addGameLog(name(i)+'が承認');message(name(i)+'は承認しました');
  if(!g.auction.active.length){auctionEnd(-1);return}
  if(g.auction.active.length===1&&g.auction.high.player===g.auction.active[0]){const last=g.auction.active[0];if(g.auction.autoApprove[last]){auctionEnd(last);return}message(name(last)+'以外は承認しました。さらに宣言するか、承認して確定してください')}
  g.auction.active.filter(j=>j>0).forEach(j=>g.auction.botSeen[j]=g.auction.version-1);
  drawAuction();drawSeats();scheduleComBids()
}

function doApprove(i,version){if(!g.auction.active.includes(i))return;if(g.auction.high.player===i){if(g.auction.active.length===1)auctionEnd(i);return}removeBid(i);addGameLog(name(i)+'が承認');message(name(i)+'は承認しました');if(!g.auction.active.length){auctionEnd(-1);return}g.auction.active.filter(j=>j>0).forEach(j=>g.auction.botSeen[j]=g.auction.version-1);drawAuction();drawSeats();scheduleComBids()}

function auctionEnd(w){
  clearTimeout(g.auction?.humanTimeout);
  $('auction-panel')?.classList.add('hidden');
  showKittyBacks();
  $('auction-clock')?.classList.add('hidden');
  if(w<0||g.auction.high.num<13){
    if(g.round>=10){w=finalAuctionRule(g.matchScores,g.mult).bottomSeat;g.auction.high={num:g.auction.minBid,suit:strongestSuit(g.players[w].hand),player:w}}
    else{dialog('流局','宣言がありませんでした。配り直します。',roundStart);return}
  }
  const suit=g.auction.high.suit;
  const strengthAtBid=suit==='NT'?ntHandStrength(g.players[w].hand,g.aiWeights):colorStrength(g.players[w].hand,suit,g.aiWeights);
  g.contract={nap:w,num:g.auction.high.num,suit,deputy:-1,solo:false,revealTrickNo:null,strengthAtBid};
  if (w === 0 && g.humanRoundLog) {
    g.humanRoundLog.bid = {
      strengthKey: quantizeStrength(strengthAtBid),
      trumpType: suit === 'NT' ? 'NT' : 'color',
      num: g.auction.high.num
    };
  }
  addDebugLog('contract-set',{nap:w,num:g.contract.num,suit:g.contract.suit,strengthAtBid,highBid:g.auction.high,bidHistory:sanitizeForLog(g.bidHistory)});
  addGameLog(name(w)+'が'+g.contract.num+g.contract.suit+'で宣言を確定');
  phase('浮き札の交換');
  message(name(w)+'が'+g.contract.num+g.contract.suit+'で宣言。オープンを手札に入れて2枚捨ててください');
  kittyStart()
}

function callUi(){
  g.phase='call';
  phase('副官指名');
  showDiscardedKitty();
  const forceSolo=isSoloForced();
  message(forceSolo?'⚠ Case A破綻：一人立ちが必須です。自分の手札から指名札を選んでください':'捨て札を決めました。副官に指名するカードを選んでください');
  let p=$('call-panel');if(!p)return;
  p.classList.remove('hidden');
  let s='♠',r='A';
  p.innerHTML='<div class="panel-title">'+(forceSolo?'⚠ 一人立ち（指名札）':'副官に指名するカード')+'</div><div class="call-card-preview"><div id="call-preview"></div><div><div class="micro-copy">'+(forceSolo?'一人立ち札':'今回の指名')+'</div><strong id="call-val">♠A</strong><div id="call-warning" class="call-warning"></div></div></div><div class="panel-row">'+SUITS.map(x=>'<button class="suit-choice '+color(x)+'" data-cs="'+x+'">'+x+'</button>').join('')+'</div><div class="panel-row call-ranks">'+RANKS.map(x=>'<button class="small-action call-rank-choice" data-cr="'+x+'">'+x+'</button>').join('')+'</div><div class="panel-row"><span class="micro-copy">'+(forceSolo?'自分の手札のカードのみ指名可能':'自分の手札にある札を選ぶと、ひとり立ちになります')+'</span><button class="small-action" id="call-ok">決定</button></div>';
  const ownCards=new Set((g.players[g.contract.nap]?.hand||[]).map(c=>c.id));
  const update=()=>{
    p.querySelectorAll('[data-cs]').forEach(b=>b.classList.toggle('selected',b.dataset.cs===s));
    p.querySelectorAll('[data-cr]').forEach(b=>b.classList.toggle('selected',b.dataset.cr===r));
    const cv=$('call-val');if(cv)cv.textContent=s+r;
    const cp=$('call-preview');if(cp)cp.replaceChildren(cardEl({suit:s,rank:r},'call-preview-card'));
    const discarded=g.kitty.some(c=>c.suit===s&&c.rank===r);
    const isOwn=ownCards.has(s+r);
    const cw=$('call-warning'), co=$('call-ok');
    if(forceSolo){if(cw)cw.textContent=!isOwn?'⚠ 自分の手札のカードを選んでください':'';if(co)co.disabled=!isOwn||discarded}
    else{if(cw)cw.textContent=discarded?'捨て札は指名できません':'';if(co)co.disabled=discarded}
  };
  p.querySelectorAll('[data-cs]').forEach(b=>b.onclick=()=>{s=b.dataset.cs;update()});
  p.querySelectorAll('[data-cr]').forEach(b=>b.onclick=()=>{r=b.dataset.cr;update()});
  const cok=$('call-ok');
  if(cok)cok.onclick=()=>{
    if(g.kitty.some(c=>c.suit===s&&c.rank===r))return;
    if(forceSolo&&!ownCards.has(s+r))return;
    g.contract.call={suit:s,rank:r,id:s+r};
    g.contract.solo=g.players[0].hand.some(c=>c.suit===s&&c.rank===r);
    if(forceSolo&&!g.contract.solo)return;
    if (g.contract.nap === 0 && g.humanRoundLog) {
      g.humanRoundLog.call = {
        callId: s+r,
        trumpSuit: g.contract.suit === 'NT' ? 'NT' : g.contract.suit
      };
    }
    addGameLog('副官指名 '+s+r+(g.contract.solo?'（ひとり立ち'+(forceSolo?'・強制':'')+'）':''));
    g.contract.revealedCall=false;
    g.kitty=[];
    renderContractInfo();
    message(s+r+'を指名しました'+(forceSolo?'（一人立ち強制）':''));
    p.classList.add('hidden');
    announceCall(g.contract.call,playStart)
  };
  update()
}

function kittyStart(){
  let n=g.contract.nap;
  g.players[n].hand.push(...g.kitty);
  sort(g.players[n].hand);
  g.phase='discard';
  phase('浮き札の交換');
  if(n===0){
    g.discard=new Set();
    const cp=$('call-panel');if(!cp)return;
    cp.classList.remove('hidden');
    cp.innerHTML='<div class="panel-title">手札から2枚を選んで捨ててください</div><div class="panel-row"><span class="micro-copy" id="discard-count">0 / 2 SELECTED</span><button class="small-action" id="discard-ok" disabled>決定</button></div>';
    renderHand(true);
    const dok=$('discard-ok');
    if(dok)dok.onclick=()=>{
      if(g.discard.size!==2)return;
      g.kitty=g.players[0].hand.filter(c=>g.discard.has(c.id));
      const kittyPoints=g.kitty.filter(c=>POINT.includes(c.rank));
      g.allianceKittyPoints += kittyPoints.length;
      g.players[0].hand=g.players[0].hand.filter(c=>!g.discard.has(c.id));
      sort(g.players[0].hand);
      $('game-screen')?.classList.remove('discarding');
      $('hand')?.classList.remove('discard-mode');
      cp.classList.add('hidden');
      callUi()
    };
    return
  }
  const drop=chooseDiscard(g.players[n].hand,g.contract.suit);
  g.players[n].hand=g.players[n].hand.filter(c=>!drop.some(x=>x.id===c.id));
  g.kitty=drop;
  const kittyPoints=drop.filter(c=>POINT.includes(c.rank));
  g.allianceKittyPoints += kittyPoints.length;
  sort(g.players[n].hand);
  const forceSolo=isSoloForced();
  if(forceSolo){
    const chosen=chooseSoloCall(g.players[n].hand);
    g.contract.call={suit:chosen.suit,rank:chosen.rank,id:chosen.id};
    g.contract.solo=true;
    addGameLog(name(n)+'が副官指名 '+g.contract.call.id+'（ひとり立ち・強制）');
  }else{
    const call=chooseDeputyCall(g.players[n].hand,g.kitty,g.contract.suit,g.botLevel,g.contract.num,g.aiWeights,g.aiExperience);
    g.contract.call={suit:call.suit,rank:call.rank,id:call.id};
    g.contract.solo=g.players[n].hand.some(c=>c.id===g.contract.call.id);
    addGameLog(name(n)+'が副官指名 '+g.contract.call.id+(g.contract.solo?'（ひとり立ち）':''));
  }
  g.contract.revealedCall=false;
  g.kitty=[];
  later(()=>{showDiscardedKitty();announceCall(g.contract.call,playStart);},700)
}

function renderHand(discard=false){
  let box=$('hand');if(!box)return;
  box.classList.toggle('discard-mode',discard);
  $('game-screen')?.classList.toggle('discarding',discard);
  box.replaceChildren();
  (g.players[0]?.hand||[]).forEach(c=>{
    let e=cardEl(c,discard?'playable':'');
    if(discard){
      const protectedCall=g.contract?.solo&&g.contract.call?.id===c.id;
      e.classList.toggle('protected',protectedCall);
      e.classList.toggle('selected',g.discard.has(c.id));
      e.setAttribute('aria-pressed',String(g.discard.has(c.id)));
      e.onclick=()=>{
        if(protectedCall){toast('指名札は捨てられません');return}
        if(g.discard.has(c.id))g.discard.delete(c.id);
        else if(g.discard.size<2)g.discard.add(c.id);
        const selected=g.discard.has(c.id);
        e.classList.toggle('selected',selected);
        e.setAttribute('aria-pressed',String(selected));
        const dc=$('discard-count'), dok=$('discard-ok');
        if(dc)dc.textContent=g.discard.size+' / 2枚選択';
        if(dok)dok.disabled=g.discard.size!==2
      }
    }else if(g.phase==='play'&&g.active===0){
      const ok=legal(0).some(x=>x.id===c.id);
      e.classList.toggle('playable',ok);
      e.classList.toggle('selected',g.selectedCard===c.id);
      if(ok)e.onclick=()=>{g.selectedCard=g.selectedCard===c.id?null:c.id;renderHand();drawLocalPlayControls()}
    }
    box.append(e)
  });
  const hc=$('hand-count');if(hc)hc.textContent=(g.players[0]?.hand.length||0)+'枚'
}

function drawLocalPlayControls(){
  const p=$('play-panel');if(!p)return;
  if(g.phase!=='play'||g.active!==0){p.classList.add('hidden');return}
  const card=g.players[0].hand.find(c=>c.id===g.selectedCard&&legal(0).some(x=>x.id===c.id));
  if(!card){g.selectedCard=null;p.classList.remove('hidden');p.innerHTML='<div class="panel-title">出すカードを手札から選んでください</div>';return}
  p.classList.remove('hidden');
  p.innerHTML='<div class="panel-title">このカードを出しますか？</div><div class="play-confirm-preview"><div id="local-play-card"></div><span class="micro-copy">選択中</span></div><div class="play-confirm-actions"><button id="cancel-local-play" class="small-action">選び直す</button><button id="confirm-local-play" class="primary-button">出す</button></div>';
  const lpc=$('local-play-card');if(lpc)lpc.replaceChildren(cardEl(card,'play-confirm-card'));
  const cancel=$('cancel-local-play');if(cancel)cancel.onclick=()=>{g.selectedCard=null;renderHand();drawLocalPlayControls()};
  const confirm=$('confirm-local-play');if(confirm)confirm.onclick=()=>{const chosen=card;g.selectedCard=null;p.classList.add('hidden');play(0,chosen)}
}

function playStart(){
  g.selectedCard=null;
  g.lastTrickWinner=null;
  g.phase='play';
  let c=g.contract;
  if(c.solo)c.deputy=c.nap;
  else{g.contract.deputy=g.players.findIndex(p=>p.hand.some(x=>x.suit===c.call.suit&&x.rank===c.call.rank));if(g.contract.deputy<0)g.contract.deputy=c.nap}
  g.contract.revealedCall=false;
  g.contract.revealTrickNo=null;
  g.active=c.nap;
  g.trickNo=0;
  g.trick=[];
  addGameLog(name(c.nap)+'が先攻');
  phase('カードプレイ');
  message(name(c.nap)+'が先攻です');
  $('call-panel')?.classList.add('hidden');
  $('kitty-view')?.replaceChildren();
  renderHand();
  drawSeats();
  playTurn()
}

function legal(i){let h=g.players[i].hand;if(!g.trick.length)return h;let suit=g.trick[0].card.suit,follow=h.filter(c=>c.suit===suit);return follow.length?follow:h}
function trump(c){return g.contract.suit!=='NT'&&c.suit===g.contract.suit}

function cardPower(entry,trick,trickNo=0){
  let c=entry.card,led=trick[0].card.suit,allSame=trick.every(x=>x.card.suit===led),mighty=trick.some(x=>x.card.id==='♠A');
  if(mighty&&c.id==='♥Q')return 10000;
  if(c.id==='♠A')return 9000;
  if(g.contract.suit!=='NT'&&c.rank==='J'&&c.suit===g.contract.suit)return 8000;
  let black=s=>s==='♣'||s==='♠';
  if(g.contract.suit!=='NT'&&c.rank==='J'&&c.suit!==g.contract.suit&&black(c.suit)===black(g.contract.suit))return 7000;
  if(trickNo>0){if(allSame&&c.suit===led&&c.rank==='2')return 6000}
  if(trump(c))return 5000+RANKS.indexOf(c.rank);
  if(c.suit===led)return 3000+RANKS.indexOf(c.rank);
  return 1000+RANKS.indexOf(c.rank);
}
function winning(trick=g.trick){return trick.reduce((best,e)=>cardPower(e,trick,g.trickNo)>cardPower(best,trick,g.trickNo)?e:best,trick[0])}

function computeBotPlay(seat){
  const hand=g.players[seat].hand;
  const legalCardsList=legal(seat);
  const contract={nap:g.contract.nap,num:g.contract.num,suit:g.contract.suit,solo:g.contract.solo,deputy:g.contract.deputy,revealedCall:g.contract.revealedCall,call:g.contract.call};
  const trick=g.trick.map(x=>({seat:x.player,card:x.card}));
  const deputyPts=(!g.contract.solo&&g.contract.deputy>=0)?(g.points[g.contract.deputy]||0):0;
  const currentNapPoints=(g.points[g.contract.nap]||0)+deputyPts;
  const ctx={hand,legal:legalCardsList,trick,trickNo:g.trickNo,contract,playedCards:g.playedCards,voids:g.voids,seat,deputy:g.contract.deputy,params:g.aiWeights,call:g.contract.call,
    isMySideNap:seat===contract.nap||(contract.revealedCall&&seat===contract.deputy),
    isCurrentNapWinning:false,isRevealed:contract.revealedCall,isNapLeading:false,lastSeat:trick.length===4,currentNapPoints,
    experience:g.aiExperience};
  if(trick.length>0){
    const winner=winningEntry(contract,g.trickNo,trick);
    if(winner){ctx.isCurrentNapWinning=winner.seat===contract.nap||(!contract.solo&&winner.seat===contract.deputy);ctx.isNapLeading=trick[0].seat===contract.nap}
  }
  try{return chooseCardToPlay(ctx)}catch(e){addDebugLog('chooseCardToPlay-error',{seat,message:e?.message,stack:e?.stack});return null}
}

function playTurn(){
  if(g.phase!=='play')return;
  drawSeats();
  renderHand();
  if(g.active===0){
    message(g.trick.length?'あなたの番です。場札のマークに続けてください。':'あなたが先攻です。カードを出してください。');
    drawLocalPlayControls();
    return
  }
  message(name(g.active)+'がカードを選んでいます');
  later(()=>{
    try{
      if(g.phase!=='play')return;
      const seat=g.active;
      const legalCardsList=legal(seat);
      if(!legalCardsList.length){addDebugLog('play-no-legal',{seat,context:sanitizeForLog(buildPlayContext(seat))});g.active=(seat+4)%5;playTurn();return}
      const chosen=computeBotPlay(seat);
      if(chosen&&legalCardsList.some(x=>x.id===chosen.id)){
        logPlayDecision(seat,chosen,{reason:'ai-tactics'},buildPlayContext(seat));
        play(seat,chosen);
      }else{
        const fallback=legalCardsList[Math.floor(Math.random()*legalCardsList.length)];
        addDebugLog('play-fallback-random',{seat,expected:chosen?.id||null,fallback:fallback.id,legalIds:legalCardsList.map(x=>x.id)});
        play(seat,fallback);
      }
    }catch(e){
      console.error("Bot Error:",e);
      const errSeat=g.active;
      addDebugLog('bot-error',{seat:errSeat,message:e?.message,stack:e?.stack,phase:g.phase,round:g.round,trickNo:g.trickNo,context:sanitizeForLog(buildPlayContext(errSeat))});
      const errMsg=e&&e.message?e.message:String(e);
      addGameLog("⚠️ COM思考エラー: "+errMsg+" → ランダムなカードを出しました");
      const l=legal(errSeat);
      if(l.length){const random=l[Math.floor(Math.random()*l.length)];addDebugLog('bot-error-fallback-random',{seat:errSeat,fallback:random.id,legalIds:l.map(x=>x.id)});play(errSeat,random)}
      else{g.active=(errSeat+4)%5;playTurn()}
    }
  },650+Math.random()*550)
}

function artfulCard(entry,trick){const c=entry.card,led=trick[0].card.suit,black=s=>s==='♣'||s==='♠';return c.id==='♠A'||c.id==='♥Q'&&trick.some(x=>x.card.id==='♠A')||c.rank==='J'&&g.contract.suit!=='NT'&&(c.suit===g.contract.suit||c.suit!==g.contract.suit&&black(c.suit)===black(g.contract.suit))||c.rank==='2'&&c.suit===led&&trick.every(x=>x.card.suit===led)}

function play(i,c){
  if(g.phase!=='play'||g.active!==i||!legal(i).some(x=>x.id===c.id))return;
  if(!g.trick.length)g.lastTrickWinner=null;
  const previous=g.trick.length?winning():null;
  g.selectedCard=null;
  $('play-panel')?.classList.add('hidden');
  let h=g.players[i].hand;
  h.splice(h.findIndex(x=>x.id===c.id),1);
  g.trick.push({player:i,card:c});
  g.playedCards.push({suit:c.suit,rank:c.rank,id:c.id,seat:i});
  if (i === 0 && g.humanRoundLog && g.contract) {
    const role = g.contract.nap === 0 ? 'nap' : (!g.contract.solo && g.contract.revealedCall && g.contract.deputy === 0 ? 'dep' : 'ally');
    const phase = trickPhaseOf(g.trickNo);
    const pointsTier = pointsTierOf(g.trick.filter(e => POINT.includes(e.card.rank)).length);
    const rankTier = rankTierOf(c.rank);
    g.humanRoundLog.playDecisions.push({ trickNo: g.trickNo, role, phase, pointsTier, rankTier, won: null });
  }
  if(g.trick.length>1){const ledSuit=g.trick[0].card.suit;if(c.suit!==ledSuit){if(!g.voids[i])g.voids[i]={};g.voids[i][ledSuit]=true}}
  if(artfulCard({player:i,card:c},g.trick)){g.matchStats[i].artAttempts=(g.matchStats[i].artAttempts||0)+1}
  const reveal=g.contract.call?.id===c.id&&!g.contract.revealedCall;
  addGameLog(name(i)+'が'+c.id+'を出した'+(reveal?'（指名札）':''));
  if(reveal){
    g.contract.revealedCall=true;
    g.contract.revealTrickNo=g.trickNo;
    addGameLog('指名札公開、副官は'+name(g.contract.deputy));
    if(g.round>=10&&!g.contract.solo){
      const r=computeTeamMinBid(g.matchScores,g.mult,g.contract.nap,g.contract.deputy);
      if(r!==null){
        const oldBid=g.contract.num,forcedMin=r.minBid,caseLabel={A:'5位=ナポレオン / 4位=副官',B:'4位=ナポレオン / 5位=副官',C:'5位=ナポレオン / 4位=連合軍',D:'4位=ナポレオン / 5位=連合軍'}[r.case];
        if(forcedMin>oldBid){g.contract.num=forcedMin;renderContractInfo();drawSeats();toast('副官判明：最低立ち条件が変わりました。立ちを '+oldBid+'枚 → '+forcedMin+'枚 に引き上げます（'+caseLabel+'）');addGameLog('★副官判明による立ち変更：'+oldBid+'枚 → '+forcedMin+'枚（'+caseLabel+'）');message('副官が判明したため、最低立ち条件に合わせて立ちを '+forcedMin+'枚へ引き上げました')}
        else{addGameLog('副官判明：現在の立ち '+oldBid+'枚は最低条件 '+forcedMin+'枚を満たしています（'+caseLabel+'）');toast('副官判明：立ち '+oldBid+'枚は最低条件を満たしています（'+caseLabel+'）')}
        if(r.incentiveBroken){const warnMsg='⚠ 20枚でも4位が3位を超えられません。副官に勝つインセンティブがなく、わざと負ける行動が最適になります';toast(warnMsg);addGameLog('⚠ '+warnMsg+'（'+caseLabel+'）');message(warnMsg)}
      }
    }
  }
  if(previous&&g.contract.revealedCall){const team=seat=>seat===g.contract.nap||seat===g.contract.deputy?'nap':'alliance';if(team(i)===team(previous.player)&&winning().player===i)g.roundArt[i]--}
  $('trick-cards')?.append(cardEl(c,'trick-card played-seat-'+i));
  if(g.trick.length<5){g.active=(i+4)%5;playTurn();return}
  addDebugLog('trick-end',{trickNo:g.trickNo,winner:winning().player,cards:g.trick.map(x=>({seat:x.player,card:x.card.id})),roundPoints:g.players.map(p=>p.roundPoints||0),roundArt:g.roundArt.slice(),scores:g.matchScores.slice()});
  g.phase='trick-end';
  const winningEntry=winning(),w=winningEntry.player,taken=g.trick.filter(e=>POINT.includes(e.card.rank)).map(e=>e.card);
  if(taken.length>=3&&artfulCard(winningEntry,g.trick)){g.matchStats[w].dramaticPlays=(g.matchStats[w].dramaticPlays||0)+1;if(g.roundArt[w]<2)g.roundArt[w]++}
  g.points[w]+=taken.length;
  g.players[w].taken.push(...taken);
  g.players[w].roundTaken.push(...taken);
  g.players[w].roundPoints=(g.players[w].roundPoints||0)+taken.length;
  if(!g.contract.solo&&g.contract.deputy>=0&&g.contract.deputy!==g.contract.nap){const deputyEntry=g.trick.find(e=>e.player===g.contract.deputy);if(deputyEntry&&POINT.includes(deputyEntry.card.rank)){g.matchStats[g.contract.deputy].allyFeedAttempts=(g.matchStats[g.contract.deputy].allyFeedAttempts||0)+1;if(w===g.contract.nap||w===g.contract.deputy){g.matchStats[g.contract.deputy].allyFeedSuccesses=(g.matchStats[g.contract.deputy].allyFeedSuccesses||0)+1}}}
  addGameLog(name(w)+'が第'+(g.trickNo+1)+'勝負を獲得（'+taken.length+'点札）');
  g.lastTrickWinner=w;
  g.active=w;
  if (g.humanRoundLog && g.contract) {
    const humanIsNapSide = g.contract.nap === 0 || (!g.contract.solo && g.contract.deputy === 0);
    const napTeamWon = w === g.contract.nap || (!g.contract.solo && w === g.contract.deputy);
    const humanWonTrick = humanIsNapSide ? napTeamWon : !napTeamWon;
    for (const d of g.humanRoundLog.playDecisions) {
      if (d.trickNo === g.trickNo && d.won === null) d.won = humanWonTrick;
    }
  }
  const alliancePointsRaw=g.points.reduce((n,points,i)=>n+(i!==g.contract.nap&&(g.contract.solo||i!==g.contract.deputy)?points:0),0);
  const alliancePoints=alliancePointsRaw+(g.allianceKittyPoints||0);
  const napPoints=g.points.reduce((n,points,i)=>n+(i===g.contract.nap||!g.contract.solo&&i===g.contract.deputy?points:0),0);
  if(alliancePoints>20-g.contract.num||napPoints>=g.contract.num&&(g.contract.num===20||alliancePoints>=1)){finishGame();return}
  message(name(w)+'が場札を取りました');
  drawSeats();
  later(()=>{g.trickNo++;if(g.trickNo>=10){finishGame();return}g.trick=[];$('trick-cards')?.replaceChildren();g.phase='play';message(name(w)+'から次の勝負');playTurn()},1250)
}

function finishGame(){
  g.phase='result';
  const c=g.contract;
  const side=c.solo?[c.nap]:[c.nap,c.deputy];
  const pts=side.reduce((n,i)=>n+g.points[i],0);
  const success=pts>=c.num&&(c.num===20||pts<20);
  const exact=success&&pts===c.num;
  const bold=c.num>=15;
  const napStat=g.matchStats[c.nap];
  napStat.declarerAttempts++;napStat.bidTotal+=c.num;
  if(success)napStat.declarerSuccesses++;
  napStat.exactAttempts++;
  if(exact)napStat.exactSuccesses++;
  if(bold){napStat.boldAttempts++;if(exact)napStat.boldSuccesses++}
  if(c.solo){napStat.soloAttempts++;if(success)napStat.soloSuccesses++}
  if(!c.solo&&c.deputy!==c.nap){const depStat=g.matchStats[c.deputy];depStat.deputyAttempts++;if(success)depStat.deputySuccesses++}

  sendRoundLearn(success);

  try{const lastPlacePenalty=g.matchScores.filter(s=>s>g.matchScores[0]).length===4?1:0;fetch('/api/ai/report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({napoleonWon:(()=>{const cc=g.contract,side=cc.solo?[cc.nap]:[cc.nap,cc.deputy],pts=side.reduce((n,i)=>n+g.points[i],0);return pts>=cc.num})(),exactWins:g.roundArt.filter(a=>a>=4).length,lastPlacePenalty})}).then(r=>r.json()).then(d=>{if(d.weights)Object.assign(g.aiWeights,d.weights)}).catch(()=>{})}catch{}
  let finalRule=g.round>=10?finalAuctionRule(g.matchScores,g.mult):null,sign=success?1:-1,unit=Math.max(0,c.num-12)*g.mult*(g.round>=10?2:1),scores=Array(5).fill(0);
  scores[c.nap]=sign*unit*(c.solo?4:2);
  if(c.solo){g.players.forEach((_,i)=>{if(i!==c.nap)scores[i]=-sign*unit})}
  else{scores[c.deputy]=sign*unit;g.players.forEach((_,i)=>{if(i!==c.nap&&i!==c.deputy)scores[i]=-sign*unit})}
  const art=g.roundArt.slice();
  if(success&&pts===c.num){art[c.nap]+=2;if(!c.solo)art[c.deputy]+=1;if(c.num>=15){art[c.nap]+=2;if(!c.solo)art[c.deputy]+=1}}
  if(c.solo)art[c.nap]+=success?4:2;
  if(!success&&!c.solo&&c.num-pts>=3){art[c.nap]-=2;art[c.deputy]-=1}
  for(let i=0;i<5;i++){g.matchScores[i]+=scores[i];g.matchArt[i]+=art[i]}
  g.matchContracts.push({round:g.round,nap:c.nap,deputy:c.deputy,num:c.num,suit:c.suit,solo:c.solo,points:pts,napWin:success,revealTrickNo:c.revealTrickNo??null,takenPoints:g.players.map(p=>p.roundPoints||0),allianceKittyPoints:g.allianceKittyPoints,strengthAtBid:c.strengthAtBid??8,mult:g.mult||1});
  const replayAllLast=!!(finalRule&&scores[finalRule.bottomSeat]>0&&g.matchScores[finalRule.bottomSeat]===g.matchScores[finalRule.fourthSeat]);
  if(replayAllLast)g.playoff=true;
  const format=n=>(n>0?'+':'')+(Number.isInteger(n)?n:n.toFixed(1)),role=i=>i===c.nap?'NAP':!c.solo&&i===c.deputy?'DEPUTY':'ALLY',rows=g.players.map((_,i)=>'<div class="round-score-row"><span>'+name(i)+' · '+role(i)+'</span><strong class="'+(scores[i]<0?'score-down':'score-up')+'">ROUND Δ '+format(scores[i])+'<small>TOTAL '+format(g.matchScores[i])+'</small></strong></div>').join(''),final=g.round>=10&&!replayAllLast;
  const ratings=final?matchRatingChanges(g.matchScores,g.matchArt,[g.rate,1000,1000,1000,1000],g.matchStats,g.matchContracts):null;
  let eloDelta=0;
  if(final&&ratings){const oppElos=[1000,1000,1000,1000];eloDelta=computeEloDelta(g.elo,oppElos,ratings[0].outcome);g.elo=Math.max(100,g.elo+eloDelta)}
  if(final){g.rate+=ratings[0].delta;const rl=$('rating-label');if(rl)rl.textContent=g.rate}
  if (final && ratings) {
    try {
      const rank = 1 + g.matchScores.filter(s => s > g.matchScores[0]).length;
      const wonMatch = rank === 1;
      const playerWonAsNap = g.matchContracts.filter(mc => mc.nap === 0 && mc.napWin).length;
      const playerWonAsDeputy = g.matchContracts.filter(mc => !mc.solo && mc.deputy === 0 && mc.nap !== 0 && mc.napWin).length;
      const playerWonAsAlly = g.matchContracts.filter(mc => mc.nap !== 0 && (mc.solo || mc.deputy !== 0) && !mc.napWin).length;
      const avgBid = g.matchContracts.filter(mc => mc.nap === 0).reduce((n, mc) => n + mc.num, 0) / Math.max(1, g.matchContracts.filter(mc => mc.nap === 0).length);
      const exactWins = g.matchContracts.filter(mc => mc.nap === 0 && mc.napWin && mc.points === mc.num).length;
      const soloWins = g.matchContracts.filter(mc => mc.nap === 0 && mc.solo && mc.napWin).length;
      fetch('/api/ai/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          wonMatch, playerRank: rank, aiWeights: g.aiWeights,
          playerWonAsNap, playerWonAsDeputy, playerWonAsAlly,
          avgBid, exactWins, soloWins, matchRatingDelta: ratings[0].delta,
          contracts: g.matchContracts, userId: g.account?.id || null, playerId: g.account?.id || 'guest'
        })
      }).catch(() => {});
    } catch (e) { console.warn('[learn match-end]', e?.message); }
  }
  phase('結果');
  addGameLog((success?'ナポレオン軍成功':'連合軍成功')+' · 宣言 '+c.num+'枚 / 獲得 '+pts+'枚（捨て札連合軍'+g.allianceKittyPoints+'pt）');
  message(replayAllLast?'プレーオフ':success?'NAP TEAM WINS':'ALLIANCE WINS');
  drawSeats();
  const finalRows=final?g.players.map((_,i)=>{const result=ratings[i],b=result.breakdown,roundStr=(b.rounds||[]).map(r=>(r.role==='nap'?'N':r.role==='dep'?'D':'A')+r.bid+':'+format(r.delta)).join(' ');return'<div class="round-score-row"><span>'+name(i)+' · MATCH '+format(g.matchScores[i])+' / ART '+format(g.matchArt[i])+'</span><strong class="'+(result.delta<0?'score-down':'score-up')+'">SIM RATE Δ '+format(result.delta)+'<small>順位 '+b.rank+' · '+roundStr+'</small></strong></div>'}).join('')+'<div class="round-score-row"><span>ELO</span><strong class="'+(eloDelta<0?'score-down':'score-up')+'">'+format(eloDelta)+'<small>TOTAL '+g.elo+'</small></strong></div>':'',r=$('result-panel');
  if(!r)return;
  r.classList.remove('hidden');
  r.innerHTML='<div class="eyebrow">'+(g.playoff?'プレーオフ':g.round===9?'ラス前':g.round>=10?'オールラスト':'ROUND '+String(g.round).padStart(2,'0'))+' · RESULT</div><h2>'+(success?'NAP TEAM WINS':'ALLIANCE WINS')+'</h2><p>BID '+c.num+c.suit+' · POINTS '+pts+(c.solo?' · SOLO':'')+'<br>NAP '+name(c.nap)+(c.solo?'':' · DEPUTY '+name(c.deputy))+(g.allianceKittyPoints>0?'<br>捨て札: '+g.allianceKittyPoints+'pt（連合軍共有）':'')+'</p>'+(replayAllLast?'<p>5位が4位に並びました。プレーオフを行います。</p>':'')+'<div class="round-score-list"><div class="micro-copy">ROUND SCORE</div>'+rows+'</div>'+(final?'<div class="round-score-list"><div class="micro-copy">MATCH COMPLETE · SIM RATE '+g.rate+' · ELO '+g.elo+'</div>'+finalRows+'</div>':'')+'<button id="next-round" class="primary-button">'+(final?'MENU':replayAllLast?'プレーオフ再戦':'NEXT ROUND')+'</button>';
  const nr=$('next-round');
  if(nr)nr.onclick=()=>{r.classList.add('hidden');if(final){screen('home-screen');return}g.round++;g.mult=1;g.greenRedraws=0;roundStart()}
}

function addTakenCards(seat,cards=[]){const row=document.createElement('div');row.className='taken-cards';const label=document.createElement('span');label.className='taken-label';label.textContent='獲得 '+cards.length;row.append(label);cards.forEach(c=>{const tag=document.createElement('span');tag.className='taken-card '+color(c.suit);tag.textContent=c.suit+c.rank;row.append(tag)});seat.append(row)}
function drawSeats(){let box=$('players-ring');if(!box)return;box.replaceChildren();const leadSeat=g.phase==='play'&&g.trick.length?g.trick[0].player:g.lastTrickWinner;g.players.forEach((p,i)=>{let e=document.createElement('div');e.className='player-seat player-color-'+i+' pos-'+i+(i===0?' me':'')+(i===g.active?' active':'')+(i===leadSeat?' trick-winner':'');let role=g.contract?(g.contract.nap===i?(g.contract.revealedCall&&g.contract.solo?'ナポレオン（ひとり立ち）':'ナポレオン'):!g.contract.revealedCall?'':g.contract.deputy===i?'副官':'連合軍'):g.phase==='auction'&&!g.auction.active.includes(i)?'承認済み':'';e.classList.toggle('deputy-seat',role==='副官');e.innerHTML='<div class="seat-name">'+name(i)+(p.bot?'<span class="com-badge">COM</span>':'')+'</div>'+(i===leadSeat?'<div class="lead-badge" role="img" aria-label="トリック先攻"><i></i></div>':'')+'<div class="seat-role '+(role==='副官'?'deputy-status':'')+'">'+role+'</div>';addTakenCards(e,p.taken);box.append(e)})}

function dialog(title,text,cb){let d=$('message-dialog'),card=$('dialog-card');if(!d||!card)return;card.classList.add('hidden');card.replaceChildren();$('dialog-eyebrow')?.classList.remove('hidden');const de=$('dialog-eyebrow');if(de)de.textContent='Napoleon';const dok=$('dialog-ok');if(dok)dok.textContent='OK';const dt=$('dialog-title'),db=$('dialog-body');if(dt)dt.textContent=title;if(db)db.textContent=text;if(dok)dok.onclick=()=>{d.close();if(cb)cb()};d.showModal()}
function announceCall(card,onConfirm,online=false){const d=$('message-dialog'),slot=$('dialog-card');if(!d||!slot)return;$('dialog-eyebrow')?.classList.add('hidden');const dt=$('dialog-title');if(dt)dt.textContent='DEPUTY CALL';slot.classList.remove('hidden');slot.replaceChildren(cardEl(card,'announcement-card'));const db=$('dialog-body');if(db)db.textContent=online?'全員が確認すると最初のトリックが始まります。':'確認して、最初のトリックを始めます。';const dok=$('dialog-ok');if(dok)dok.textContent=online?'確認':'最初のトリックへ';if(dok)dok.onclick=()=>{d.close();slot.classList.add('hidden');slot.replaceChildren();$('dialog-eyebrow')?.classList.remove('hidden');const de=$('dialog-eyebrow');if(de)de.textContent='Napoleon';if(dok)dok.textContent='OK';if(onConfirm)onConfirm()};d.showModal()}

async function getUser(){try{g.user=await window.websim?.getUser?.()||null}catch(e){g.user=null}return g.user}

function renderAccount(){
  if(!g.account)return;
  const po=$('profile-open');if(po)po.textContent='PROFILE';
  const eloText=g.account.elo?' · Elo '+g.account.elo:'';
  const ac=$('account-chip');
  if(ac){ac.textContent='ID '+g.account.id+' · '+g.account.rating+eloText;ac.classList.remove('hidden');ac.onclick=records}
  const pf=$('profile-form');if(pf)pf.classList.add('hidden');
  const ps=$('profile-summary');if(ps){ps.classList.remove('hidden');ps.innerHTML='<div class="profile-emblem">♠</div><div><div class="eyebrow">PLAYER CARD</div><div class="profile-summary-id">'+g.account.id+'</div><div class="micro-copy">RATE '+g.account.rating+(g.account.elo?' · Elo '+g.account.elo:'')+' · '+g.account.wins+'W · '+g.account.losses+'L</div></div><button type="button" id="open-my-page" class="secondary-button">VIEW PROFILE</button>';const omp=$('open-my-page');if(omp)omp.onclick=records}
}

async function account(path){
  const idEl=$('account-id'), passEl=$('account-password');
  if(!idEl||!passEl)return;
  const id=idEl.value.trim(),password=passEl.value;
  if(!id||!password){toast('IDとパスワードを入力してください');return}
  try{
    const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,password})});
    const { data: d, parseError } = await readResponse(r);
    if(!r.ok || parseError)throw Error((d && d.error) || (parseError && 'JSON parse error') || '処理できませんでした');
    g.account=d;g.sessionToken=d.sessionToken||null;if(d.sessionToken)localStorage.setItem('napoleon_session',d.sessionToken);
    renderAccount();toast(path.endsWith('register')?'登録しました':'ログインしました');records()
  }catch(e){toast(sanitizeMessage(e.message)||'処理できませんでした')}
}

async function loadAccount(){
  const token=localStorage.getItem('napoleon_session');
  if(!token){renderHomeRating({unregistered:true});return}
  try{
    const r=await fetch('/api/account/me',{headers:{'x-session-token':token}});
    const { data } = await readResponse(r);
    if(r.ok && data){
      g.account=data;g.sessionToken=token;if(data.elo)g.elo=data.elo;renderAccount();renderHomeRating(g.account)
    }else if(r.status===401||r.status===404){
      localStorage.removeItem('napoleon_session');g.sessionToken=null;renderHomeRating({unregistered:true})
    }
  }catch{}
}

function renderHomeRating(d){
  const box=$('my-rating');if(!box)return;
  if(!d){box.classList.add('hidden');return}
  box.classList.remove('hidden');
  if(d.unregistered){
    box.innerHTML='<div class="rating-signup"><div><div class="eyebrow">YOUR RATING</div><h2>BUILD YOUR RATING</h2><p>REGISTER TO TRACK YOUR RATE AND MATCH HISTORY.</p></div><button id="rating-register" class="secondary-button">REGISTER</button></div>';
    const rr=$('rating-register');if(rr)rr.onclick=()=>screen('profile-screen');
    return
  }
  box.classList.add('hidden')
}

async function loadLeaderboard(){
  const section=$('leaderboard'),box=$('rating-leaders');
  if(!section||!box)return;
  try{
    const response=await fetch('/api/rating/top');
    if(!response.ok)throw Error();
    const { data: leaders } = await readResponse(response);
    if(!Array.isArray(leaders))throw Error();
    const list = leaders.slice(0,g.leaderboardExpanded?50:3);
    if(!list.length){section.classList.add('hidden');return}
    section.classList.remove('hidden');
    box.classList.toggle('expanded',g.leaderboardExpanded);
    const sr=$('show-ranking');
    if(sr){sr.textContent=g.leaderboardExpanded?'TOP 3':'VIEW TOP 50';sr.setAttribute('aria-expanded',String(g.leaderboardExpanded))}
    box.innerHTML=list.map((player,i)=>{const username=String(player.username||player.id||'player'),href='https://websim.com/@'+encodeURIComponent(username),avatar='https://images.websim.com/avatar/'+encodeURIComponent(username);return'<article class="rating-leader rank-'+(i+1)+'"><span class="leader-place">'+String(i+1).padStart(2,'0')+'</span><a class="leader-person" href="'+escapeHTML(href)+'" target="_blank" rel="noopener noreferrer"><img src="'+escapeHTML(avatar)+'" alt="" loading="lazy"><span>@'+escapeHTML(username)+'</span></a><strong>'+Number(player.rating||0)+'<small> pt</small></strong></article>'}).join('')
  }catch{section.classList.add('hidden')}
}

function escapeHTML(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

async function records(){
  screen('records-screen');
  const token=localStorage.getItem('napoleon_session');
  const rc=$('records-content');if(!rc)return;
  if(!token){rc.innerHTML='<p class="subcopy">REGISTER TO UNLOCK PLAYER STATS.</p><button id="records-register" class="primary-button">プレイヤー登録</button>';const rr=$('records-register');if(rr)rr.onclick=()=>screen('profile-screen');return}
  try{
    const response=await fetch('/api/account/me',{headers:{'x-session-token':token}});
    const { data: d, parseError } = await readResponse(response);
    if(!response.ok || parseError || !d)throw Error('UNABLE TO LOAD PLAYER STATS.');
    g.account=d;renderAccount();
    const perf=d.performance||{},prec=d.precision||{},ally=d.allyFeed||{},bold=d.boldBid||{},art=d.artRate||{},ms=d.matchStats||{};
    const napAtt=Number(perf.declarer_attempts)||0,napWins=Number(perf.declarer_successes)||0,napWinRate=napAtt?napWins/napAtt:0;
    const exactAtt=Number(prec.exact_attempts)||0,exactWins=Number(prec.exact_successes)||0,exactRate=exactAtt?exactWins/exactAtt:0;
    const boldAtt=Number(bold.attempts)||0,boldWins=Number(bold.successes)||0,boldRate=boldAtt?boldWins/boldAtt:0;
    const soloAtt=Number(prec.solo_attempts)||0,soloWins=Number(prec.solo_successes)||0,soloRate=soloAtt?soloWins/soloAtt:0;
    const depAtt=Number(perf.deputy_attempts)||0,depWins=Number(perf.deputy_successes)||0,depWinRate=depAtt?depWins/depAtt:0;
    const feedAtt=Number(ally.attempts)||0,feedWins=Number(ally.successes)||0,feedRate=feedAtt?feedWins/feedAtt:0;
    const artAtt=Number(art.attempts)||0,artPlays=Number(art.plays)||0,artRate=artAtt?artPlays/artAtt:0;
    const bidTotal=Number(ms.bid_total)||0,avgBid=napAtt?bidTotal/napAtt:0,matchCount=Number(ms.match_count)||0,napRatio=matchCount?(napAtt/(matchCount*10)):0;
    const r1=Number(ms.rank_1)||0,r2=Number(ms.rank_2)||0,r3=Number(ms.rank_3)||0,r4=Number(ms.rank_4)||0,r5=Number(ms.rank_5)||0;
    const totalRanks=r1+r2+r3+r4+r5,avgRank=totalRanks?((r1*1+r2*2+r3*3+r4*4+r5*5)/totalRanks):0,rankScore=totalRanks?Math.max(0,Math.min(1,(5-avgRank)/4)):0;
    const napScore=napAtt>0?Math.round((napWinRate*0.65+exactRate*0.25+boldRate*0.05+soloRate*0.05)*100):null;
    const depScore=depAtt>0?Math.round((depWinRate*0.75+feedRate*0.25)*100):null;
    const allScore=totalRanks>0?Math.round((rankScore*0.7+artRate*0.3)*100):null;
    const pct=v=>(v*100).toFixed(1)+'%',scoreText=s=>s===null?'—':String(s),barW=s=>s===null?0:s,scoreUnit=s=>s===null?'':'<small>/100</small>';
    rc.innerHTML=`
      <div class="mypage-head"><div class="profile-emblem large">♠</div><div class="mypage-identity"><div class="eyebrow">PLAYER CARD</div><h2>${escapeHTML(d.id)}</h2></div><div class="mypage-rating"><span>RATE</span><strong>${d.rating}</strong>${d.elo?'<small>ELO '+d.elo+'</small>':''}</div></div>
      <div class="record-stats"><div class="record-stat"><span>MATCHES</span><b>${d.games}</b></div><div class="record-stat"><span>WINS</span><b>${d.wins}</b></div><div class="record-stat"><span>LOSSES</span><b>${d.losses}</b></div></div>
      <section class="performance-section"><h3 class="section-title">パフォーマンス指標</h3><div class="performance-grid">
        <article class="performance-card"><span>平均立ち成功率</span><strong>${napAtt>0?pct(napWinRate):'—'}</strong><small>${napWins} / ${napAtt}</small></article>
        <article class="performance-card"><span>平均宣言数</span><strong>${avgBid>0?avgBid.toFixed(1)+'枚':'—'}</strong><small>${napAtt>0?napAtt+'回の立ち':'実績なし'}</small></article>
        <article class="performance-card"><span>ナポレオン率</span><strong>${matchCount>0?pct(napRatio):'—'}</strong><small>${matchCount>0?(matchCount*10)+'局中'+napAtt+'回':'実績なし'}</small></article>
      </div></section>
      <section class="role-skill-section"><h3 class="section-title">役割別実力</h3><div class="role-skill-grid">
        <article class="role-skill role-nap"><div class="role-skill-head"><div class="role-emblem">♠</div><div class="role-title"><span class="eyebrow">NAPOLEON</span><div class="role-score">${scoreText(napScore)}${scoreUnit(napScore)}</div></div></div><div class="skill-bar"><div style="width:${barW(napScore)}%"></div></div><div class="skill-rows"><div><span>立ち成功率</span><b>${napAtt>0?pct(napWinRate):'—'}</b></div><div><span>EXACT率</span><b>${exactAtt>0?pct(exactRate):'—'}</b></div><div><span>BOLD成功率</span><b>${boldAtt>0?pct(boldRate):'—'}</b></div><div><span>SOLO成功率</span><b>${soloAtt>0?pct(soloRate):'—'}</b></div></div></article>
        <article class="role-skill role-dep"><div class="role-skill-head"><div class="role-emblem">♣</div><div class="role-title"><span class="eyebrow">DEPUTY</span><div class="role-score">${scoreText(depScore)}${scoreUnit(depScore)}</div></div></div><div class="skill-bar"><div style="width:${barW(depScore)}%"></div></div><div class="skill-rows"><div><span>副官成功率</span><b>${depAtt>0?pct(depWinRate):'—'}</b></div><div><span>絵札回し成功率</span><b>${feedAtt>0?pct(feedRate):'—'}</b></div><div><span>副官経験</span><b>${depAtt>0?depAtt+'回':'—'}</b></div></div></article>
        <article class="role-skill role-all"><div class="role-skill-head"><div class="role-emblem">♥</div><div class="role-title"><span class="eyebrow">ALLIANCE</span><div class="role-score">${scoreText(allScore)}${scoreUnit(allScore)}</div></div></div><div class="skill-bar"><div style="width:${barW(allScore)}%"></div></div><div class="skill-rows"><div><span>平均順位</span><b>${totalRanks>0?avgRank.toFixed(2)+'位':'—'}</b></div><div><span>1位率</span><b>${totalRanks>0?pct(r1/totalRanks):'—'}</b></div><div><span>4〜5位率</span><b>${totalRanks>0?pct((r4+r5)/totalRanks):'—'}</b></div><div><span>アート成功率</span><b>${artAtt>0?pct(artRate):'—'}</b></div></div></article>
      </div></section>
    `;
  }catch(e){rc.textContent='UNABLE TO LOAD PLAYER STATS.'}
}

async function loadStrategyLab(){
  const wrap=$('strategy-content');
  if(!wrap)return;
  wrap.innerHTML='<p class="subcopy">戦略を読み込み中…</p>';
  try{
    const[stratRes,insightRes,genRes]=await Promise.all([
      fetch('/api/ai/strategies?limit=10').then(r=>readResponse(r)).catch(()=>({data:null})),
      fetch('/api/ai/insights').then(r=>readResponse(r)).catch(()=>({data:null})),
      fetch('/api/ai/generations').then(r=>readResponse(r)).catch(()=>({data:null}))
    ]);
    const strategies = Array.isArray(stratRes.data) ? stratRes.data : [];
    const insights = (insightRes.data && Array.isArray(insightRes.data.insights)) ? insightRes.data.insights : [];
    const generations = Array.isArray(genRes.data) ? genRes.data : [];
    renderStrategyLab({strategies,insights,generations});
  }catch(e){console.warn('[loadStrategyLab]', e?.message);wrap.innerHTML='<p class="subcopy">戦略を読み込めませんでした。</p>'}
}

function renderStrategyLab({strategies,insights,generations}){
  const wrap=$('strategy-content');if(!wrap)return;
  let cards='';
  if(strategies.length===0){cards='<p class="subcopy" style="padding:10px 0;">まだ学習データがありません。上の「自己対戦を実行」ボタンから学習を開始してください。</p>'}
  else{cards=strategies.slice(0,5).map((s,i)=>{const rank=i+1;const delta=Number(s.avg_rating_delta||0);return`<article class="strategy-card rank-${rank}"><div class="strategy-rank">#${rank}</div><div class="strategy-meta"><span class="eyebrow">GEN ${s.generation} · ${s.matches}試合</span><strong>${delta>0?'+':''}${delta.toFixed(2)} <small>pt/試合</small></strong></div><div class="strategy-roles"><span>NAP ${(Number(s.nap_win_rate)*100).toFixed(1)}%</span><span>DEP ${(Number(s.deputy_win_rate)*100).toFixed(1)}%</span><span>ALLI ${(Number(s.alliance_win_rate)*100).toFixed(1)}%</span></div></article>`}).join('')}
  const paramNames={bidThreshold:'立ち強度',riskTolerance:'リスク許容',leadAggression:'リード積極性',followAggression:'フォロー積極性',trumpBonus:'切り札評価',mightyBonus:'マイティ評価',safeAceWeight:'A温存',roleCardPreservation:'役札温存',deputyFeedBias:'副官の絵札回し'};
  let paramRows='<p class="subcopy" style="padding:10px 0;">データなし</p>';
  if(strategies.length>0){
    const parsedParams = safeJsonParse(strategies[0].params, null);
    if (parsedParams && typeof parsedParams === 'object') {
      const rows = Object.entries(parsedParams).map(([k,v])=>`<div class="param-row"><span>${escapeHTML(paramNames[k]||k)}</span><b>${Number(v).toFixed(2)}</b></div>`).join('');
      if (rows) paramRows = rows;
    }
  }
  const insightCards=insights.length>0?insights.map(ins=>`<article class="insight-card"><h3>${escapeHTML(ins.title)}</h3><p>${escapeHTML(ins.detail)}</p></article>`).join(''):'<p class="subcopy" style="padding:10px 0;">データなし</p>';
  const genRows=generations.length>0?generations.slice(-10).map(gg=>{const delta=Number(gg.best_delta||0);return`<div class="gen-row"><span>Gen ${gg.generation}</span><b>${delta>0?'+':''}${delta.toFixed(2)}pt</b><small>NAP ${(Number(gg.nap)*100).toFixed(0)} / DEP ${(Number(gg.dep)*100).toFixed(0)} / ALLI ${(Number(gg.ally)*100).toFixed(0)}</small></div>`}).join(''):'<p class="subcopy" style="padding:10px 0;">データなし</p>';
  wrap.innerHTML=`<div class="strategy-actions"><button id="run-selfplay" class="primary-button">自己対戦を実行（100局）</button><button id="refresh-strategy" class="secondary-button">再読み込み</button><span id="selfplay-status" class="micro-copy"></span></div><section class="strategy-section"><h2>TOP STRATEGIES（レート上昇順）</h2><div class="strategy-list">${cards}</div></section><section class="strategy-section"><h2>最上位戦略のパラメータ</h2><div class="param-table">${paramRows}</div></section><section class="strategy-section"><h2>学習インサイト</h2><div class="insight-list">${insightCards}</div></section><section class="strategy-section"><h2>世代推移</h2><div class="gen-list">${genRows}</div></section>`;
  const runSelfplay=$('run-selfplay');
  if(runSelfplay)runSelfplay.onclick=async()=>{
    const btn=$('run-selfplay'),status=$('selfplay-status');
    if(!btn||!status)return;
    btn.disabled=true;status.textContent='自己対戦100局を実行中…（数秒かかります）';
    const doRun=async()=>{
      const res=await fetch('/api/ai/run-selfplay',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({matches:100})});
      const { data, text, parseError } = await readResponse(res);
      if (parseError) { const preview = sanitizeMessage(text).slice(0,180); throw new Error(`HTTP ${res.status} JSON解析失敗: ${sanitizeMessage(parseError.message)} / 本文先頭: ${preview}`); }
      if(!res.ok||!data||data.error)throw new Error(sanitizeMessage(data?.error)||`HTTP ${res.status}`);
      return data;
    };
    try{
      let data;
      try{ data=await doRun() }
      catch(e){
        if(e.message&&e.message.includes('no such table')){
          status.textContent='初回データベースセットアップ中…';
          const setupRes=await fetch('/api/setup-db');
          if(!setupRes.ok)throw new Error('データベースの初期化に失敗しました');
          status.textContent='自己対戦100局を実行中…（再試行）';
          data=await doRun()
        }else{ throw e }
      }
      status.textContent=`Gen ${data.generation} 完了（${data.matches}試合）`;
      await loadTopStrategy();
      await loadStrategyLab()
    }catch(e){status.textContent='実行できませんでした: '+sanitizeMessage(e?.message||'ネットワークエラー');console.warn('[run-selfplay]', e);}
    finally{btn.disabled=false}
  };
  const refresh=$('refresh-strategy');
  if(refresh)refresh.onclick=()=>loadStrategyLab();
}

function code(){return Math.random().toString(36).slice(2,7).toUpperCase()}

async function online(mode,roomCode,bots,botLevel=3){
  $('game-log-open')?.classList.add('hidden');
  if(mode==='ranked'&&!localStorage.getItem('napoleon_session')){toast('先にプレイヤー登録をしてください');screen('profile-screen');return}
  loadTopStrategy();
  try{
    g.room=await new Promise((resolve,reject)=>{const proto=location.protocol==='https:'?'wss:':'ws:';const ws=new WebSocket(proto+'//'+location.host+'/ws');ws.onopen=()=>resolve({ws,send:m=>ws.send(JSON.stringify(m)),close:()=>ws.close()});ws.onerror=reject});
    g.mySeat=-1;g.privateHand=[];g.onlineState=null;g.onlineDiscard=new Set();g.onlineSelectedCard=null;g.onlineBid=13;g.onlineSuit='♠';g.onlineRank='A';g.announcedCallRound=null;g.announcedRound=null;
    ['auction-panel','call-panel','play-panel','result-panel'].forEach(id=>$('id')?.classList.add('hidden'));
    screen('game-screen');
    const gml=$('game-mode-label');if(gml)gml.textContent=mode==='ranked'?'RANKED':'FRIEND MATCH';
    const rc=$('rating-caption');if(rc)rc.textContent='RATE';
    phase(mode==='ranked'?'対戦相手を検索':'部屋を準備中');
    message(mode==='ranked'?'最後の入室から90秒経過するとCOMが参加します':'合言葉 '+roomCode+' で参加を待っています');
    g.room.ws.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch{return}if(m.type==='lobby'){message(m.text)}if(m.type==='matched'){g.online=m;g.mySeat=m.seat;g.players=m.players.map(p=>({name:p.id,hand:[]}));g.active=-1;drawSeats();phase('対戦開始');message('配札しました。競り開始まで7秒です。'+(m.botCount?' COM '+m.botCount+'人が参加します。':''))}if(m.type==='game-state'){g.onlineState=m.state;g.mySeat=m.you;g.active=m.state.active;g.phase=m.state.phase;g.players=m.state.players.map(p=>({name:p.name,hand:Array(p.handCount).fill(null)}));renderOnline()}if(m.type==='private-hand'){g.privateHand=m.hand;g.onlineLegal=m.legal;drawOnlineHand();if(g.onlineState)drawOnlineControls(g.onlineState)}if(m.type==='rating-updated'){g.lastRating=m;g.account=Object.assign({},g.account,{rating:m.rating,elo:m.elo});const rl=$('rating-label');if(rl)rl.textContent=m.rating;const eloMsg = m.eloDelta != null ? ' · Elo Δ '+m.eloDelta : '';toast('RATE Δ '+m.delta+eloMsg);if(g.onlineState?.phase==='result')showOnlineResult(g.onlineState)}if(m.type==='room-error')toast(m.message)};
    g.room.send({type:'join',mode:mode,code:roomCode,bots:bots,botLevel:Number(botLevel)||3,sessionToken:localStorage.getItem('napoleon_session'),playerId:g.account?.id||'プレイヤー'})
  }catch(e){toast('対戦に接続できませんでした');screen('home-screen')}
}

// ==========================================
// 画面切り替え・初期化
// ==========================================

// 要素が存在する場合のみイベントを登録（JSエラーで止まらないようにする）
$('home-start')?.addEventListener('click', () => screen('mode-select-screen'));

$('start-com')?.addEventListener('click', () => startLocal());
$('game-log-open')?.addEventListener('click', openGameLog);
$('game-log-close')?.addEventListener('click', () => $('game-log-dialog').close());
$('game-log-download')?.addEventListener('click', downloadLog);

window.addEventListener('error', (e) => {
  try { addDebugLog('global-error', { message: e.message, stack: e.error?.stack, filename: e.filename, line: e.lineno, col: e.colno, phase: g.phase, round: g.round }); } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  try { addDebugLog('unhandled-rejection', { message: e.reason?.message || String(e.reason), stack: e.reason?.stack, phase: g.phase, round: g.round }); } catch {}
});

$('create-friend')?.addEventListener('click', () => {
  let c = code();
  const fc = $('friend-code');
  if (fc) fc.value = c;
  const cc = $('com-count');
  online('friend', c, Number(cc?.value || 4), 3);
});
$('join-friend')?.addEventListener('click', () => {
  const fc = $('friend-code');
  if (!fc) return;
  let c = fc.value.trim().toUpperCase();
  if (!c) { toast('合言葉を入力してください'); return; }
  const cc = $('com-count');
  online('friend', c, Number(cc?.value || 4), 3);
});

$('start-ranked')?.addEventListener('click', () => online('ranked', '', 0));
$('profile-open')?.addEventListener('click', () => g.account ? records() : screen('profile-screen'));
$('show-record')?.addEventListener('click', records);
$('show-ranking')?.addEventListener('click', () => { g.leaderboardExpanded = !g.leaderboardExpanded; loadLeaderboard(); });

const strategyBtn = $('open-strategy-lab');
if (strategyBtn) strategyBtn.addEventListener('click', () => screen('strategy-screen'));

document.querySelectorAll('[data-go-home]').forEach(b => b.addEventListener('click', () => screen('home-screen')));
$('leave-game')?.addEventListener('click', () => { closeOnline(); screen('home-screen'); });

$('register-account')?.addEventListener('click', () => account('/api/account/register'));
$('login-account')?.addEventListener('click', () => account('/api/account/login'));

loadAccount();
loadLeaderboard();

// 初期表示を確実にヒーロー画面にする
screen('home-screen');
