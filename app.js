const SUITS=['♣','♦','♥','♠'],SV={'♣':1,'♦':2,'♥':3,'♠':4,NT:5},RANKS=['2','3','4','5','6','7','8','9','10','J','Q','K','A'],FACE=['10','J','Q','K','A'],POINT=['10','J','Q','K','A'],$=id=>document.getElementById(id);
const CALIBRATION={13:0.82,14:0.75,15:0.65,16:0.55,17:0.42,18:0.30,19:0.18,20:0.08};
const g={round:1,rate:1000,mult:1,botLevel:3,aiWeights:{bidThreshold:4.0,riskTolerance:0.5,leadAggression:0.6,followAggression:0.4,trumpBonus:0.6,mightyBonus:2.0,safeAceWeight:0.7,roleCardPreservation:0.6,deputyFeedBias:0.5},players:[],kitty:[],auction:null,contract:null,trick:[],trickNo:0,points:[0,0,0,0,0],matchScores:[0,0,0,0,0],matchArt:[0,0,0,0,0],matchStats:[],matchContracts:[],playoff:false,appealInfo:'',roundArt:[0,0,0,0,0],phase:'',bid:13,suit:'♠',timer:[],greenRedraws:0,selectedCard:null,onlineSelectedCard:null,user:null,account:null,sessionToken:null,room:null,presenceRoom:null,online:null,leaderboardExpanded:false,announcedCallRound:null,announcedRound:null,localLog:null,playedCards:[],voids:[{},{},{},{},{}]};let toastTimer;
function toast(t){const e=$('toast');e.textContent=t;e.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>e.classList.remove('show'),2600)}
function screen(id){['home-screen','profile-screen','game-screen','records-screen','strategy-screen'].forEach(x=>$(x).classList.toggle('hidden',x!==id));if(id==='home-screen'){loadLeaderboard();loadAccount();startPresence()}if(id==='strategy-screen'){loadStrategyLab()}}
function startPresence(){if(g.presenceRoom||!window.WebsimSocket?.joinRoom)return;const pending=window.WebsimSocket.joinRoom();g.presenceRoom=pending;pending.then(room=>{if(g.presenceRoom!==pending){room.close?.();return}g.presenceRoom=room;room.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch{return}if(m.type==='presence')$('concurrent-count').textContent='同接: '+m.count+'人'}}).catch(()=>{if(g.presenceRoom===pending)g.presenceRoom=null})}
async function stopPresence(){const current=g.presenceRoom;g.presenceRoom=null;try{(await current)?.close?.()}catch{}}
function later(fn,ms){g.timer.push(setTimeout(fn,ms))}
function clearTimers(){g.timer.forEach(clearTimeout);g.timer=[]}
function closeOnline(){clearTimers();clearTimeout(g.auction?.humanTimeout);g.room?.close?.();g.room=null;g.online=null;g.onlineState=null;g.privateHand=[];g.onlineLegal=[];g.onlineSelectedCard=null;$('auction-clock').classList.add('hidden')}
function message(t){$('table-message').textContent=t}
function addGameLog(text){if(!g.localLog)return;g.localLog.push({round:g.round,text});if(g.localLog.length>300)g.localLog.shift();$('game-log-count').textContent=String(g.localLog.length);if($('game-log-dialog').open)renderGameLog()}
function renderGameLog(){const list=$('game-log-list');list.innerHTML=g.localLog?.length?g.localLog.map(entry=>'<article class="game-log-entry"><small>第'+entry.round+'局</small><span>'+escapeHTML(entry.text)+'</span></article>').join(''):'<p class="game-log-empty">まだログはありません</p>';list.scrollTop=list.scrollHeight}
function openGameLog(){renderGameLog();$('game-log-dialog').showModal()}
function phase(t){const roundTag=g.playoff?'プレーオフ · ':g.round===9?'ラス前 · ':g.round>=10?'オールラスト · ':'';$('phase-label').textContent=roundTag+t;$('game-screen').classList.toggle('auctioning',g.phase==='auction');renderContractInfo()}
function name(i){return i===0?'あなた':g.players[i]?.name||'COM '+i}
function color(s){return s==='♥'||s==='♦'?'red':''}
function cardEl(c,extra){const e=document.createElement('div');e.className='card '+(c?color(c.suit):'')+' '+(extra||'');if(c)e.innerHTML='<span class="rank">'+c.rank+'</span><span class="suit">'+c.suit+'</span>';return e}
function renderContractInfo(){const box=$('contract-info');if(!box)return;const contract=g.contract;if(contract){box.classList.remove('hidden');const bid=document.createElement('strong');bid.className='contract-bid';bid.textContent='宣言 '+contract.num+contract.suit;const label=document.createElement('span');label.className='contract-call-label';label.textContent='副官札';box.replaceChildren(bid,label,contract.call?cardEl(contract.call,'contract-card'):Object.assign(document.createElement('span'),{className:'contract-pending',textContent:'指名前'}));return}box.classList.add('hidden');box.replaceChildren()}
function showKittyBacks(){$('kitty-view').replaceChildren(cardEl(null,'card-back'),cardEl(null,'card-back'))}
function showOpenKitty(){const label=document.createElement('span');label.className='open-label';label.textContent='オープン';$('kitty-view').replaceChildren(label,...g.kitty.map(c=>cardEl(c)))}
function deck(){let d=[];SUITS.forEach(s=>RANKS.forEach(r=>d.push({suit:s,rank:r,id:s+r})));for(let i=d.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]]}return d}
function sort(h){h.sort((a,b)=>SV[b.suit]-SV[a.suit]||RANKS.indexOf(b.rank)-RANKS.indexOf(a.rank))}

function soloMinimumBid(gap, mult){
  return 13 + Math.floor(Math.max(0, gap) / (10 * Math.max(1, mult)));
}

function computeTeamMinBid(scores, mult, napSeat, deputySeat){
  const ranked=scores.map((s,i)=>({s,i})).sort((a,b)=>a.s-b.s||a.i-b.i);
  const S5=ranked[0].s, S4=ranked[1].s, S3=ranked[2].s;
  const bottomSeat=ranked[0].i, fourthSeat=ranked[1].i;
  const m=Math.max(1, mult);
  const f=(gap,denom)=>Math.floor(Math.max(0,gap)/denom);
  if(napSeat===bottomSeat && deputySeat===fourthSeat){
    const a=13+f(S4-S5, 2*m), b=13+f(S3-S4, 4*m), raw=Math.max(a,b);
    const broken=b>20, soloBid=soloMinimumBid(S4-S5, m);
    return { minBid: broken?Math.min(20,soloBid):Math.min(20,raw), rawMin: broken?soloBid:raw, canOvertake: (broken?soloBid:raw)<=20, incentiveBroken: broken, soloRequired: broken, soloMinBid: Math.min(20,soloBid), soloRawMin: soloBid, soloPossible: soloBid<=20, case: 'A', details: { S3, S4, S5, needNapOverDeputy: a, needDeputyOverThird: b, soloNeed: soloBid } };
  }
  if(napSeat===fourthSeat && deputySeat===bottomSeat){
    const a=13+f(S3-S4, 6*m), b=13+f(S3-S5, 4*m), c=13+f(S4-S5, 2*m), raw=Math.max(a,b,c);
    return { minBid: Math.min(20,raw), rawMin: raw, canOvertake: raw<=20, incentiveBroken: a>20||b>20, soloRequired: false, case: 'B', details: { S3, S4, S5, needNapOverThird: a, needDeputyOverThird: b, needDeputyOverNapOnLoss: c } };
  }
  if(napSeat===bottomSeat && deputySeat!==fourthSeat){
    const raw=13+f(S4-S5, 6*m);
    return { minBid: Math.min(20,raw), rawMin: raw, canOvertake: raw<=20, incentiveBroken: false, soloRequired: false, case: 'C', details: { S3, S4, S5, needNapOverFourth: raw } };
  }
  if(napSeat===fourthSeat && deputySeat!==bottomSeat){
    const raw=13+f(S4-S5, 6*m);
    return { minBid: Math.min(20,raw), rawMin: raw, canOvertake: raw<=20, incentiveBroken: false, soloRequired: false, case: 'D', details: { S3, S4, S5, needNapLoss: raw } };
  }
  return null;
}

function isSoloForced(){
  if(g.round<10 || !g.contract) return false;
  const ranked=g.matchScores.map((s,i)=>({s,i})).sort((a,b)=>a.s-b.s||a.i-b.i);
  const bottomSeat=ranked[0].i;
  if(g.contract.nap!==bottomSeat) return false;
  const fourthSeat=ranked[1].i;
  const r=computeTeamMinBid(g.matchScores, g.mult, bottomSeat, fourthSeat);
  return r?.soloRequired === true;
}

function isSafeToCashAce(suit, seat){
  if(!g.contract) return false;
  if(suit==='♠') return true;
  if(g.trickNo>0){
    const twoPlayed=g.playedCards.some(c=>c.id===suit+'2');
    if(!twoPlayed){
      const anyVoid=[0,1,2,3,4].some(s=>s!==seat&&g.voids[s]&&g.voids[s][suit]);
      if(!anyVoid) return false;
    }
  }
  if(g.contract.suit!=='NT'&&g.contract.suit!==suit){
    for(let s=0;s<5;s++){
      if(s===seat) continue;
      if(g.contract.revealedCall){
        if(s===g.contract.nap||(!g.contract.solo&&s===g.contract.deputy)) continue;
      }else{
        if(s===g.contract.nap) continue;
      }
      if(g.voids[s]&&g.voids[s][suit]) return false;
    }
  }
  return true;
}

async function loadTopStrategy(){
  try{
    const res=await fetch('/api/ai/top-strategy');
    if(!res.ok)return;
    const data=await res.json();
    if(data.strategy){
      Object.assign(g.aiWeights,data.strategy);
      if(data.source==='learned'&&data.generation){
        console.log('[AI] Top strategy loaded: gen '+data.generation+', avgRating: '+data.avgRating);
      }
    }
  }catch(e){}
}

function startLocal(){
  closeOnline();
  loadTopStrategy();
  g.localLog=[];
  $('game-log-open').classList.remove('hidden');
  $('game-log-count').textContent='0';
  g.botLevel=3;
  g.round=1;
  g.rate=Number.isFinite(Number(g.account?.rating))?Number(g.account.rating):1000;
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
  g.matchStats=Array.from({length:5},()=>({declarerAttempts:0,declarerSuccesses:0,exactAttempts:0,exactSuccesses:0,boldAttempts:0,boldSuccesses:0,soloAttempts:0,soloSuccesses:0,deputyAttempts:0,deputySuccesses:0,artAttempts:0,dramaticPlays:0,allyFeedAttempts:0,allyFeedSuccesses:0,bidTotal:0}));
  g.players=Array.from({length:5},(_,i)=>({name:i?'COM '+i:'あなた',bot:i>0,hand:[],taken:[],roundTaken:[],roundPoints:0}));
  screen('game-screen');
  $('game-mode-label').textContent='COM戦';
  $('rating-caption').textContent='SIM RATE';
  $('rating-label').textContent=g.rate;
  roundStart()
}

function roundStart(){
  clearTimers();
  clearTimeout(g.auction?.humanTimeout);
  g.lastTrickWinner=null;
  g.phase='deal';
  g.contract=null;
  g.trick=[];
  g.trickNo=0;
  g.points=[0,0,0,0,0];
  g.roundArt=Array(5).fill(0);
  g.playedCards=[];
  g.voids=[{},{},{},{},{}];
  g.players.forEach(p=>{p.roundTaken=[];p.roundPoints=0;});
  addGameLog('配札');
  $('round-label').textContent=g.round;
  $('auction-panel').classList.add('hidden');
  $('call-panel').classList.add('hidden');
  $('play-panel').classList.add('hidden');
  $('result-panel').classList.add('hidden');
  $('trick-cards').replaceChildren();
  $('kitty-view').replaceChildren();
  $('auction-clock').classList.add('hidden');
  let d=deck();
  g.players.forEach(p=>{p.hand=d.splice(0,10);p.taken=[];sort(p.hand)});
  g.kitty=d.splice(0,2);
  renderHand();
  drawSeats();
  phase('配札');
  message('手札を確認しています');
  later(checkGreen,900)
}

function checkGreen(){
  let i=g.players.findIndex(p=>!p.hand.some(c=>FACE.includes(c.rank)));
  if(i>=0&&g.greenRedraws<5){
    if(i===0){
      phase('手札確認');
      message('10・J・Q・K・Aがありません。公開して配り直しますか？');
      $('play-panel').classList.remove('hidden');
      $('play-panel').innerHTML='<div class="panel-title">手札に10・J・Q・K・Aがありません</div><div class="panel-row"><button class="small-action" id="green-ok">公開して配り直す</button><button class="small-action pass" id="green-skip">続ける</button></div>';
      $('green-ok').onclick=()=>greenRedraw('あなた');
      $('green-skip').onclick=()=>{$('play-panel').classList.add('hidden');prepAuction()};
      return
    }
    greenRedraw(name(i));
    return
  }
  prepAuction()
}

function greenRedraw(n){
  addGameLog(n+'の手札条件により配り直し');
  g.greenRedraws++;
  g.mult=g.mult>=4?2:g.mult+1;
  $('play-panel').classList.add('hidden');
  const d=$('message-dialog');
  $('dialog-title').textContent='手札を配り直します';
  $('dialog-body').textContent=n+'の手札に10・J・Q・K・Aがありません。倍率は'+g.mult+'倍です。';
  $('dialog-ok').onclick=()=>{d.close();roundStart()};
  d.showModal()
}

function finalAuctionRule(scores,mult=1){
  const ranked=scores.map((score,seat)=>({score,seat})).sort((a,b)=>a.score-b.score||a.seat-b.seat),
    cutoff=ranked[1]?.score??0,
    gap=Math.max(0,(ranked[1]?.score??0)-(ranked[0]?.score??0)),
    rawMin=13+Math.floor(gap/(6*Math.max(1,mult)));
  return {eligible:ranked.filter(x=>x.score<=cutoff).map(x=>x.seat),bottomSeat:ranked[0]?.seat,fourthSeat:ranked[1]?.seat,thirdSeat:ranked[2]?.seat,thirdScore:ranked[2]?.score,minBid:Math.min(20,rawMin),canOvertake:rawMin<=20}
}

function playoffBidHints(scores,rule,mult){
  const gap=Math.max(0,Number(scores[rule?.fourthSeat]||0)-Number(scores[rule?.bottomSeat]||0)),
    scale=Math.max(1,mult||1),
    modes=[[10,'ひとり立ち'],[6,'4位以外が副官'],[2,'4位が副官']],
    hints=[];
  for(let bid=rule?.minBid||13;bid<=20;bid++)for(const [perBid,label] of modes)if(gap===perBid*(bid-12)*scale)hints.push(bid+'枚（'+label+'）');
  return hints.length?'同点になり得る立ち：'+hints.join('、'):'この点差で同点になる立ちはありません'
}

function announceRound(round,rule){
  if(g.announcedRound===round||round<9)return;
  g.announcedRound=round;
  if(round===9){dialog('ラス前','第9局です。次はいよいよオールラストです。');return}
  const scores=g.matchScores||Array(5).fill(0);
  const ranked=scores.map((score,seat)=>({score,seat})).sort((a,b)=>b.score-a.score||a.seat-b.seat);
  const lines=ranked.map((e,i)=>(i+1)+'位 '+name(e.seat)+'  '+e.score+'点');
  const bottomSeat=ranked[4].seat, fourthSeat=ranked[3].seat;
  const S5=ranked[4].score, S4=ranked[3].score;
  const m=Math.max(1,g.mult||1);

  const caseA=computeTeamMinBid(scores, m, bottomSeat, fourthSeat);
  const caseB=computeTeamMinBid(scores, m, fourthSeat, bottomSeat);
  const caseC=computeTeamMinBid(scores, m, bottomSeat, bottomSeat);
  const caseD=computeTeamMinBid(scores, m, fourthSeat, fourthSeat);
  const caseEraw=soloMinimumBid(S4-S5, m);
  const caseE={minBid:Math.min(20,caseEraw), rawMin:caseEraw};

  const fmt=r=>{
    if(!r)return '—';
    if(r.soloRequired)return r.soloPossible ? r.soloMinBid+'枚以上（一人立ち）' : '20枚でも不足（一人立ち）';
    if(r.rawMin>20)return '20枚でも不足（逆転不可）';
    return Math.min(20,r.rawMin)+'枚以上';
  };
  const fmtE=r=>r.rawMin>20 ? '20枚でも不足（逆転不可）' : r.minBid+'枚以上';

  const body=[
    '現在の得点（全員）',
    lines.join('\n'),
    '',
    '■ 5位が4位を逆転するための最低立ち（ケース別）',
    '',
    '【A】5位=ナポレオン / 4位=副官',
    '  勝った時に5位も4位も3位を超える（4位が勝つインセンティブを保証）',
    '  → '+fmt(caseA),
    (caseA?.soloRequired ? '  ⚠ 4位が勝っても3位を超えられないため、5位は【一人立ち】が必須です' : ''),
    '',
    '【B】4位=ナポレオン / 5位=副官',
    '  勝った時に4位も5位も3位を超え、負けた時に5位が4位を逆転',
    '  → '+fmt(caseB),
    '',
    '【C】5位=ナポレオン / 4位=連合軍（副官は別）',
    '  5位が4位を超えるだけでOK（3位超えは不要）',
    '  → '+fmt(caseC),
    '',
    '【D】4位=ナポレオン / 5位=連合軍',
    '  ナポレオンが負けると5位が4位を逆転',
    '  → '+fmt(caseD),
    '',
    '【E】5位=ナポレオン（ひとり立ち） / 副官なし（4位以下は全員連合軍）',
    '  → '+fmtE(caseE),
    '',
    '※ アピールで副官が判明しない場合、ゲーム中に指名札が公開された時点で',
    '   上記の該当ケースに合わせて立ちが変更されます。',
    '   立ちが変わった際は画面上部の宣言・卓上メッセージ・局ログに表示されます。',
    '',
    'プレーオフ条件：5位が勝利して4位と同点なら再戦'
  ].filter(x=>x!=='').join('\n');

  dialog(g.playoff?'プレーオフ':'オールラスト', body);
}

function prepAuction(){
  g.phase='prep';
  announceRound(g.round,finalAuctionRule(g.matchScores,g.mult));
  phase('競り準備');
  let n=7;
  message('競り開始まで '+n+' 秒');
  const tick=()=>{n--;if(n<=0){auctionStart();return}message('競り開始まで '+n+' 秒');later(tick,1000)};
  later(tick,1000)
}

function scheduleHumanAuctionTimeout(){
  const auction=g.auction;
  clearTimeout(auction.humanTimeout);
  auction.humanTimeout=setTimeout(()=>{if(g.phase==='auction'&&g.auction===auction)humanApprove(true)},30000)
}

function auctionActivity(){
  if(g.phase!=='auction'||!g.auction)return;
  g.auction.autoApprove[0]=false;
  scheduleHumanAuctionTimeout()
}

function appealDetails(hand){
  const targets=[['♣J','♣J'],['♦J','♦J'],['♥J','♥J'],['♠J','♠J'],['マイティ（♠A）','♠A']];
  return targets.map(([label,id])=>label+'：'+(hand.some(c=>c.id===id)?'あり':'なし')).join(' · ')
}

function enterAuction(){
  g.phase='auction';
  phase('競り');
  message(g.auction.requiredBidSeat===null?'順番なし。宣言するか、承認して競りを降りてください':name(g.auction.requiredBidSeat)+'が申告せず立つ選択。最低枚数以上で宣言してください');
  $('auction-panel').classList.remove('hidden');
  $('auction-clock').classList.add('hidden');
  scheduleHumanAuctionTimeout();
  drawAuction();
  drawSeats();
  scheduleComBids()
}

function drawAppealOffer(){
  const p=$('auction-panel');
  p.classList.remove('hidden');
  p.innerHTML='<div class="panel-title">オーラス・アピール</div><div class="micro-copy">4位にJ・マイティの所持を尋ねますか？</div><div class="panel-row"><button class="small-action" id="appeal-yes">アピールする</button><button class="small-action pass" id="appeal-no">競りへ進む</button></div>';
  p.querySelector('#appeal-yes').onclick=()=>answerLocalAppeal('appeal');
  p.querySelector('#appeal-no').onclick=()=>answerLocalAppeal('skip')
}

function drawAppealResponse(){
  const p=$('auction-panel');
  p.classList.remove('hidden');
  p.innerHTML='<div class="panel-title">5位からアピール</div><div class="micro-copy">所持するJ・マイティを申告するか、申告せず立つか選んでください。</div><div class="panel-row"><button class="small-action" id="appeal-disclose">札を申告する</button><button class="small-action pass" id="appeal-stand">申告せず立つ</button></div>';
  p.querySelector('#appeal-disclose').onclick=()=>answerLocalAppeal('disclose');
  p.querySelector('#appeal-stand').onclick=()=>answerLocalAppeal('stand')
}

function answerLocalAppeal(choice){
  const rule=finalAuctionRule(g.matchScores,g.mult),fourth=rule.fourthSeat;
  if(choice==='skip'){g.appealInfo='5位はアピールせず競りへ';enterAuction();return}
  if(choice==='appeal'){
    if(fourth===0){g.phase='appeal-response';phase('アピール回答');message('4位は所持するJ・マイティを申告するか、申告せず立ちます');drawAppealResponse();return}
    g.appealInfo='4位の申告：'+appealDetails(g.players[fourth].hand);
    enterAuction();
    return
  }
  if(choice==='stand'){g.auction.requiredBidSeat=fourth;g.appealInfo='4位は申告せず立つことを選択';enterAuction();return}
  g.appealInfo='4位の申告：'+appealDetails(g.players[fourth].hand);
  enterAuction()
}

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

function bidHistoryHTML(history,getName){
  const entries=(history||[]).slice(-50).reverse();
  return '<div class="bid-history"><div class="bid-history-title">この対局の立ち履歴</div>'+(entries.length?'<div class="bid-history-list">'+entries.map(entry=>'<div class="bid-history-row player-color-'+entry.seat+'"><small>第'+entry.round+'局</small><span class="bid-player">'+escapeHTML(getName(entry.seat))+'</span><strong>'+entry.num+entry.suit+'</strong></div>').join('')+'</div>':'<div class="bid-history-empty">まだありません</div>')+'</div>'
}

function drawAuction(){
  renderContractInfo();
  let h=g.auction.high,t=h.num<13?'なし':name(h.player)+' · '+h.num+h.suit;
  const p=$('auction-panel'),
    ruleNote=g.round>=10?'<div class="micro-copy">オールラスト · 最低宣言 '+g.auction.minBid+' · 得点2倍 · 立ち必須</div>':'',
    historyPanel=bidHistoryHTML(g.bidHistory,i=>name(i)),
    appealPanel=g.appealInfo?'<div class="appeal-info">'+escapeHTML(g.appealInfo)+'</div>':'';
  p.classList.remove('hidden');
  if(g.auction.requiredBidSeat!==null&&g.auction.requiredBidSeat!==0){p.innerHTML='<div class="panel-title">4位が申告せず立ちを選択</div><div class="micro-copy">4位の宣言を待っています</div>'+appealPanel+historyPanel;return}
  if(!g.auction.active.includes(0)){p.innerHTML='<div class="panel-title">現在の宣言　<strong>'+t+'</strong></div><div class="micro-copy">承認済み</div>'+ruleNote+appealPanel+historyPanel;return}
  p.innerHTML='<div class="panel-title">現在の宣言　<strong>'+t+'</strong></div>'+ruleNote+appealPanel+'<div class="panel-row">'+SUITS.map(s=>'<button class="suit-choice '+color(s)+' '+(g.suit===s?'selected':'')+'" data-suit="'+s+'">'+s+'</button>').join('')+'<button class="suit-choice '+(g.suit==='NT'?'selected':'')+'" data-suit="NT">NT</button></div><div class="panel-row"><button class="small-action" id="bid-minus">−</button><span class="bid-number">'+g.bid+'</span><button class="small-action" id="bid-plus">＋</button></div><div class="panel-row"><button class="small-action pass" id="bid-approve" '+(g.auction.high.player===0&&g.auction.active.length>1||g.round>=10&&g.auction.high.num<13?'disabled':'')+'>承認</button><button class="small-action" id="bid-submit">宣言する</button></div>'+historyPanel;
  document.querySelectorAll('[data-suit]').forEach(b=>b.onclick=()=>{auctionActivity();g.suit=b.dataset.suit;drawAuction()});
  $('bid-plus').onclick=()=>{auctionActivity();g.bid=Math.min(20,g.bid+1);drawAuction()};
  $('bid-minus').onclick=()=>{auctionActivity();g.bid=Math.max(g.auction.minBid,g.bid-1);drawAuction()};
  $('bid-approve').onclick=()=>humanApprove();
  $('bid-submit').onclick=humanBid
}

function beatsBid(n,s){const h=g.auction.high;return n>=g.auction.minBid&&n>h.num||(n===h.num&&n>=13&&SV[s]>SV[h.suit])}
function removeBid(i){g.auction.active=g.auction.active.filter(x=>x!==i)}
function scheduleComBids(){if(g.phase!=='auction')return;const version=g.auction.version;for(let i=1;i<5;i++)if(g.auction.active.includes(i)&&g.auction.botSeen[i]<version)later(()=>comBid(i,version),500+Math.random()*1800)}

function humanApprove(forced=false){
  if(g.phase!=='auction'||!g.auction||!g.auction.active.includes(0))return;
  if(!g.auction.active.length){auctionEnd(-1);return}
  if(g.round>=10&&g.auction.high.num<13){
    if(forced&&(g.auction.requiredBidSeat??g.auction.active[0])===0){g.bid=g.auction.minBid;g.suit=strongestBotSuit(g.players[0].hand);humanBid()}
    return
  }
  if(!forced)auctionActivity();
  if(g.auction.high.player===0){
    if(g.auction.active.length===1)auctionEnd(0);
    else if(forced){g.auction.autoApprove[0]=true;message('30秒操作がなかったため、宣言者は自動承認待ちです')}
    return
  }
  removeBid(0);
  addGameLog(forced?'あなたが自動承認':'あなたが承認');
  message(forced?'30秒操作がなかったため、自動で承認しました':'あなたは承認しました');
  if(!g.auction.active.length){auctionEnd(-1);return}
  if(g.auction.active.length===1&&g.auction.high.player===g.auction.active[0]){
    const last=g.auction.active[0];
    if(g.auction.autoApprove[last]){auctionEnd(last);return}
    message(name(last)+'以外は承認しました。さらに宣言するか、承認して確定してください')
  }
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

function botSuitValue(hand,suit){
  const weight={10:1,J:1.8,Q:2.6,K:3.5,A:4.7},cards=hand.filter(c=>c.suit===suit);
  return cards.reduce((n,c)=>n+(weight[c.rank]||0),0)+Math.max(0,cards.length-3)*.75
}
function strongestBotSuit(hand,suits=SUITS){return suits.slice().sort((a,b)=>botSuitValue(hand,b)-botSuitValue(hand,a)||SV[b]-SV[a])[0]}
function chooseBotCall(hand,discard,trump,level,bid){
  const options=deck().filter(c=>!hand.some(x=>x.id===c.id)&&!discard.some(x=>x.id===c.id));
  if(level===1)return options[0];
  const score=c=>RANKS.indexOf(c.rank)*4+(c.suit===trump?2:0)-hand.filter(x=>x.suit===c.suit).length*(level===3?1:.65),
    soloPower=hand.reduce((n,c)=>n+(c.rank==='A'?2:c.rank==='K'?1.2:c.rank==='Q'?.7:0)+((trump!=='NT'&&c.suit===trump)?0.5:0),0);
  if(level===3&&bid>=17&&soloPower>=8)return hand.slice().sort((a,b)=>score(b)-score(a))[0];
  return options.sort((a,b)=>score(b)-score(a)||SV[b.suit]-SV[a.suit])[0]
}

function comBid(i,version){
  if(g.phase!=='auction'||version!==g.auction.version||!g.auction.active.includes(i)||g.auction.botSeen[i]>=version||g.auction.requiredBidSeat!==null&&g.auction.requiredBidSeat!==i)return;
  g.auction.botSeen[i]=version;
  let level=g.botLevel||3,h=g.players[i].hand,
    strength=h.reduce((n,c)=>n+(RANKS.indexOf(c.rank)>9?1.25:RANKS.indexOf(c.rank)>7?.45:0)+(c.rank==='A'?.35:0),0)+botSuitValue(h,strongestBotSuit(h))*.3,
    high=g.auction.high,b=null,
    openingChance=[.5,1,1][level-1],
    raiseChance=[.4,.95,1][level-1],
    minStrength=[Math.max(1.0,g.aiWeights.bidThreshold+0.2),Math.max(1.0,g.aiWeights.bidThreshold-2.2),Math.max(1.0,g.aiWeights.bidThreshold-3.0)][level-1],
    divisor=[2.8,1.7,1.3][level-1],
    cap=13+Math.min(level===1?3:level===2?8:9,Math.floor(strength/divisor)),
    bestSuit=strongestBotSuit(h),
    hasMighty=h.some(c=>c.id==='♠A'),
    hasTrumpJ=h.some(c=>c.rank==='J'&&c.suit===bestSuit),
    partnerIsNapoleon=i===g.contract?.deputy;

  if(partnerIsNapoleon&&high.num>=13)return doApprove(i,version);

  if(g.auction.botBids[i]<2&&high.num<13&&strength>minStrength&&cap>=g.auction.minBid&&Math.random()<openingChance){
    b={num:Math.max(g.auction.minBid,13+Math.min(level===1?1:level===2?3:6,Math.max(0,Math.floor((strength-2)/1.7)))),suit:level===1?SUITS[Math.floor(Math.random()*4)]:bestSuit}
  }
  else if(g.auction.botBids[i]<2&&high.num>=13&&high.num<cap&&Math.random()<raiseChance){
    const suits=SUITS.filter(s=>SV[s]>SV[high.suit]).sort((a,b)=>botSuitValue(h,b)-botSuitValue(h,a));
    if(suits.length&&(hasMighty||hasTrumpJ||strength>5))b={num:high.num,suit:suits[0]};
    else if(high.num+1<=cap)b={num:high.num+1,suit:bestSuit}
  }
  if(b&&g.auction.high.num<13)b.num=Math.max(g.auction.minBid,b.num);
  if(g.auction.requiredBidSeat===i||g.round>=10&&high.num<13&&g.auction.active[0]===i)b={num:g.auction.minBid,suit:bestSuit};
  if(b)b.num=Math.max(g.auction.minBid,b.num);

  if(b&&beatsBid(b.num,b.suit)){
    g.bidHistory.push({round:g.round,seat:i,num:b.num,suit:b.suit});
    addGameLog(name(i)+'が'+b.num+b.suit+'を宣言');
    if(g.bidHistory.length>50)g.bidHistory.shift();
    g.auction.botBids[i]++;
    g.auction.high={...b,player:i};
    if(g.auction.requiredBidSeat===i)g.auction.requiredBidSeat=null;
    g.auction.version++;
    g.active=i;
    if(g.auction.autoApprove[0]&&g.auction.active.includes(0)){humanApprove(true);return}
    message(name(i)+'が'+b.num+b.suit+'を宣言しました');
    if(b.num===20&&b.suit==='NT'){auctionEnd(i);return}
    drawAuction();
    drawSeats();
    scheduleComBids();
    return
  }

  if(g.auction.high.player===i){if(g.auction.active.length===1)auctionEnd(i);return}
  removeBid(i);
  addGameLog(name(i)+'が承認');
  message(name(i)+'は承認しました');
  if(!g.auction.active.length){auctionEnd(-1);return}
  if(g.auction.active.length===1&&g.auction.high.player===g.auction.active[0]){
    const last=g.auction.active[0];
    if(g.auction.autoApprove[last]){auctionEnd(last);return}
    message(name(last)+'以外は承認しました。さらに宣言するか、承認して確定してください')
  }
  g.auction.active.filter(j=>j>0).forEach(j=>g.auction.botSeen[j]=g.auction.version-1);
  drawAuction();
  drawSeats();
  scheduleComBids()
}

function doApprove(i, version) {
  if(!g.auction.active.includes(i))return;
  if(g.auction.high.player===i){if(g.auction.active.length===1)auctionEnd(i);return}
  removeBid(i);
  addGameLog(name(i)+'が承認');
  message(name(i)+'は承認しました');
  if(!g.auction.active.length){auctionEnd(-1);return}
  g.auction.active.filter(j=>j>0).forEach(j=>g.auction.botSeen[j]=g.auction.version-1);
  drawAuction();
  drawSeats();
  scheduleComBids();
}

function auctionEnd(w){
  clearTimeout(g.auction?.humanTimeout);
  $('auction-panel').classList.add('hidden');
  showKittyBacks();
  $('auction-clock').classList.add('hidden');
  if(w<0||g.auction.high.num<13){
    if(g.round>=10){
      w=finalAuctionRule(g.matchScores,g.mult).bottomSeat;
      g.auction.high={num:g.auction.minBid,suit:strongestBotSuit(g.players[w].hand),player:w}
    }else{
      dialog('流局','宣言がありませんでした。配り直します。',roundStart);
      return
    }
  }
  g.contract={nap:w,num:g.auction.high.num,suit:g.auction.high.suit,deputy:-1,solo:false,revealTrickNo:null};
  addGameLog(name(w)+'が'+g.contract.num+g.contract.suit+'で宣言を確定');
  phase('浮き札の交換');
  message(name(w)+'が'+g.contract.num+g.contract.suit+'で宣言。オープンを手札に入れて2枚捨ててください');
  kittyStart()
}

function callUi(){
  g.phase='call';
  phase('副官指名');
  const forceSolo=isSoloForced();
  message(forceSolo?'⚠ Case A破綻：一人立ちが必須です。自分の手札から指名札を選んでください':'捨て札を決めました。副官に指名するカードを選んでください');
  let p=$('call-panel');
  p.classList.remove('hidden');
  let s='♠',r='A';
  p.innerHTML='<div class="panel-title">'+(forceSolo?'⚠ 一人立ち（指名札）':'副官に指名するカード')+'</div><div class="call-card-preview"><div id="call-preview"></div><div><div class="micro-copy">'+(forceSolo?'一人立ち札':'今回の指名')+'</div><strong id="call-val">♠A</strong><div id="call-warning" class="call-warning"></div></div></div><div class="panel-row">'+SUITS.map(x=>'<button class="suit-choice '+color(x)+'" data-cs="'+x+'">'+x+'</button>').join('')+'</div><div class="panel-row call-ranks">'+RANKS.map(x=>'<button class="small-action call-rank-choice" data-cr="'+x+'">'+x+'</button>').join('')+'</div><div class="panel-row"><span class="micro-copy">'+(forceSolo?'自分の手札のカードのみ指名可能':'自分の手札にある札を選ぶと、ひとり立ちになります')+'</span><button class="small-action" id="call-ok">決定</button></div>';
  const ownCards=new Set((g.players[g.contract.nap]?.hand||[]).map(c=>c.id));
  const update=()=>{
    p.querySelectorAll('[data-cs]').forEach(b=>b.classList.toggle('selected',b.dataset.cs===s));
    p.querySelectorAll('[data-cr]').forEach(b=>b.classList.toggle('selected',b.dataset.cr===r));
    $('call-val').textContent=s+r;
    $('call-preview').replaceChildren(cardEl({suit:s,rank:r},'call-preview-card'));
    const discarded=g.kitty.some(c=>c.suit===s&&c.rank===r);
    const isOwn=ownCards.has(s+r);
    if(forceSolo){
      $('call-warning').textContent=!isOwn?'⚠ 自分の手札のカードを選んでください':'';
      $('call-ok').disabled=!isOwn||discarded;
    }else{
      $('call-warning').textContent=discarded?'捨て札は指名できません':'';
      $('call-ok').disabled=discarded;
    }
  };
  p.querySelectorAll('[data-cs]').forEach(b=>b.onclick=()=>{s=b.dataset.cs;update()});
  p.querySelectorAll('[data-cr]').forEach(b=>b.onclick=()=>{r=b.dataset.cr;update()});
  $('call-ok').onclick=()=>{
    if(g.kitty.some(c=>c.suit===s&&c.rank===r))return;
    if(forceSolo&&!ownCards.has(s+r))return;
    g.contract.call={suit:s,rank:r,id:s+r};
    g.contract.solo=g.players[0].hand.some(c=>c.suit===s&&c.rank===r);
    if(forceSolo&&!g.contract.solo)return;
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
  $('kitty-view').replaceChildren();
  g.players[n].hand.push(...g.kitty);
  sort(g.players[n].hand);
  g.phase='discard';
  phase('浮き札の交換');
  if(n===0){
    g.discard=new Set();
    $('call-panel').classList.remove('hidden');
    $('call-panel').innerHTML='<div class="panel-title">手札から2枚を選んで捨ててください</div><div class="panel-row"><span class="micro-copy" id="discard-count">0 / 2 SELECTED</span><button class="small-action" id="discard-ok" disabled>決定</button></div>';
    renderHand(true);
    $('discard-ok').onclick=()=>{
      if(g.discard.size!==2)return;
      g.kitty=g.players[0].hand.filter(c=>g.discard.has(c.id));
      const kittyPoints=g.kitty.filter(c=>POINT.includes(c.rank));
      g.points[g.contract.nap]+=kittyPoints.length;
      g.players[g.contract.nap].taken.push(...kittyPoints);
      g.players[0].hand=g.players[0].hand.filter(c=>!g.discard.has(c.id));
      sort(g.players[0].hand);
      $('game-screen').classList.remove('discarding');
      $('hand').classList.remove('discard-mode');
      $('call-panel').classList.add('hidden');
      callUi()
    };
    return
  }
  let discardPool=g.players[n].hand.slice();
  discardPool.sort((a,b)=>cardValue(a)-cardValue(b));
  let drop=discardPool.slice(0,2);
  g.players[n].hand=g.players[n].hand.filter(c=>!drop.includes(c));
  g.kitty=drop;
  const kittyPoints=drop.filter(c=>POINT.includes(c.rank));
  g.points[n]+=kittyPoints.length;
  g.players[n].taken.push(...kittyPoints);
  sort(g.players[n].hand);
  const forceSolo=isSoloForced();
  if(forceSolo){
    const hand=g.players[n].hand;
    const chosen=hand.slice().sort((a,b)=>cardValue(a)-cardValue(b))[0];
    g.contract.call={suit:chosen.suit,rank:chosen.rank,id:chosen.id};
    g.contract.solo=true;
    addGameLog(name(n)+'が副官指名 '+g.contract.call.id+'（ひとり立ち・強制）');
  }else{
    g.contract.call=chooseBotCall(g.players[n].hand,g.kitty,g.contract.suit,g.botLevel,g.contract.num);
    g.contract.solo=g.players[n].hand.some(c=>c.id===g.contract.call.id);
    addGameLog(name(n)+'が副官指名 '+g.contract.call.id+(g.contract.solo?'（ひとり立ち）':''));
  }
  g.contract.revealedCall=false;
  g.kitty=[];
  later(()=>announceCall(g.contract.call,playStart),700)
}

function cardValue(c){return RANKS.indexOf(c.rank)+(c.suit===g.contract.suit?3:0)}

function renderHand(discard=false){
  let box=$('hand');
  box.classList.toggle('discard-mode',discard);
  $('game-screen').classList.toggle('discarding',discard);
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
        $('discard-count').textContent=g.discard.size+' / 2枚選択';
        $('discard-ok').disabled=g.discard.size!==2
      }
    }else if(g.phase==='play'&&g.active===0){
      const ok=legal(0).some(x=>x.id===c.id);
      e.classList.toggle('playable',ok);
      e.classList.toggle('selected',g.selectedCard===c.id);
      if(ok)e.onclick=()=>{g.selectedCard=g.selectedCard===c.id?null:c.id;renderHand();drawLocalPlayControls()}
    }
    box.append(e)
  });
  $('hand-count').textContent=(g.players[0]?.hand.length||0)+'枚'
}

function drawLocalPlayControls(){
  const p=$('play-panel');
  if(g.phase!=='play'||g.active!==0){p.classList.add('hidden');return}
  const card=g.players[0].hand.find(c=>c.id===g.selectedCard&&legal(0).some(x=>x.id===c.id));
  if(!card){g.selectedCard=null;p.classList.remove('hidden');p.innerHTML='<div class="panel-title">出すカードを手札から選んでください</div>';return}
  p.classList.remove('hidden');
  p.innerHTML='<div class="panel-title">このカードを出しますか？</div><div class="play-confirm-preview"><div id="local-play-card"></div><span class="micro-copy">選択中</span></div><div class="play-confirm-actions"><button id="cancel-local-play" class="small-action">選び直す</button><button id="confirm-local-play" class="primary-button">出す</button></div>';
  p.querySelector('#local-play-card').replaceChildren(cardEl(card,'play-confirm-card'));
  p.querySelector('#cancel-local-play').onclick=()=>{g.selectedCard=null;renderHand();drawLocalPlayControls()};
  p.querySelector('#confirm-local-play').onclick=()=>{const chosen=card;g.selectedCard=null;p.classList.add('hidden');play(0,chosen)}
}

function playStart(){
  g.selectedCard=null;
  g.lastTrickWinner=null;
  g.phase='play';
  let c=g.contract;
  if(c.solo)c.deputy=c.nap;
  else{
    g.contract.deputy=g.players.findIndex(p=>p.hand.some(x=>x.suit===c.call.suit&&x.rank===c.call.rank));
    if(g.contract.deputy<0)g.contract.deputy=c.nap;
  }
  g.contract.revealedCall=false;
  g.contract.revealTrickNo=null;
  g.active=c.nap;
  g.trickNo=0;
  g.trick=[];
  addGameLog(name(c.nap)+'が先攻');
  phase('カードプレイ');
  message(name(c.nap)+'が先攻です');
  $('call-panel').classList.add('hidden');
  $('kitty-view').replaceChildren();
  renderHand();
  drawSeats();
  playTurn()
}

function legal(i){
  let h=g.players[i].hand;
  if(!g.trick.length)return h;
  let suit=g.trick[0].card.suit,follow=h.filter(c=>c.suit===suit);
  return follow.length?follow:h
}

function trump(c){return g.contract.suit!=='NT'&&c.suit===g.contract.suit}

function cardPower(entry,trick){
  let c=entry.card,led=trick[0].card.suit,allSame=trick.every(x=>x.card.suit===led),mighty=trick.some(x=>x.card.id==='♠A');
  if(mighty&&c.id==='♥Q')return 10000;
  if(c.id==='♠A')return 9000;
  if(g.contract.suit!=='NT'&&c.rank==='J'&&c.suit===g.contract.suit)return 8000;
  let black=s=>s==='♣'||s==='♠';
  if(g.contract.suit!=='NT'&&c.rank==='J'&&c.suit!==g.contract.suit&&black(c.suit)===black(g.contract.suit))return 7000;
  if(allSame&&c.suit===led&&c.rank==='2')return 6000;
  if(trump(c))return 5000+RANKS.indexOf(c.rank);
  if(c.suit===led)return 3000+RANKS.indexOf(c.rank);
  return 1000+RANKS.indexOf(c.rank);
}

function winning(trick=g.trick){return trick.reduce((best,e)=>cardPower(e,trick)>cardPower(best,trick)?e:best,trick[0])}

function chooseLocalBotCard(i){
  const h=legal(i),level=g.botLevel||3;
  const low=cards=>cards.slice().sort((a,b)=>cardValue(a)-cardValue(b))[0];
  const napSide=i===g.contract.nap||g.contract.revealedCall&&i===g.contract.deputy||!g.contract.revealedCall&&!g.contract.solo&&g.contract.call&&g.players[i].hand.some(c=>c.id===g.contract.call.id);
  const napPoints=g.points.reduce((n,x,seat)=>n+(seat===g.contract.nap||!g.contract.solo&&seat===g.contract.deputy?x:0),0);
  const alliancePoints=g.points.reduce((n,x,seat)=>n+(seat!==g.contract.nap&&(g.contract.solo||seat!==g.contract.deputy)?x:0),0);

  const isDeputy=i!==g.contract.nap&&!g.contract.solo&&(g.contract.revealedCall?i===g.contract.deputy:g.players[i].hand.some(c=>c.id===g.contract.call?.id));
  const calledLead=isDeputy&&g.trick.length>0&&g.trick[0].player===g.contract.nap&&(g.trick[0].card.suit===g.contract.call?.suit||g.contract.suit!=='NT'&&g.trick[0].card.suit===g.contract.suit);

  if(calledLead){const choice=chooseLocalDeputyCard(i,h);if(choice)return choice}
  if(level>=2&&napSide&&g.contract.num<20&&napPoints>=g.contract.num&&alliancePoints===0){
    if(!g.trick.length)return low(h);
    const safe=h.filter(c=>winning(g.trick.concat([{player:i,card:c}])).player!==i);
    return low(safe.length?safe:h)
  }
  if(isDeputy){const choice=chooseLocalDeputyCard(i,h);if(choice)return choice}
  if(level===1)return h[Math.floor(Math.random()*h.length)];

  if(!g.trick.length){
    const leadValue=c=>cardValue(c)+(c.rank==='A'?3:c.rank==='K'?1:0)+g.players[i].hand.filter(x=>x.suit===c.suit).length*.25;
    const safeH=h.filter(c=>{
      if(c.rank!=='A')return true;
      if(c.id==='♠A')return true;
      return isSafeToCashAce(c.suit,i);
    });
    const candidates=safeH.length?safeH:h;
    const strongLead=candidates.filter(c=>c.rank==='A'||c.id==='♠A'||(c.rank==='J'&&g.contract.suit!=='NT'&&(c.suit===g.contract.suit||(c.suit==='♣'||c.suit==='♠')===(g.contract.suit==='♣'||g.contract.suit==='♠'))));
    if(strongLead.length&&Math.random()<g.aiWeights.leadAggression)return strongLead.sort((a,b)=>leadValue(b)-leadValue(a))[0];
    const nonAce=candidates.filter(c=>c.rank!=='A');
    if(nonAce.length&&Math.random()<g.aiWeights.safeAceWeight)return nonAce.slice().sort((a,b)=>leadValue(b)-leadValue(a))[0];
    return candidates.slice().sort((a,b)=>leadValue(b)-leadValue(a))[0];
  }

  const winningCards=h.filter(c=>winning(g.trick.concat([{player:i,card:c}])).player===i),
    current=winning().player,
    points=g.trick.filter(e=>POINT.includes(e.card.rank)).length,
    team=seat=>seat===g.contract.nap?'nap':g.contract.revealedCall?seat===g.contract.deputy?'nap':'alliance':g.players[seat].hand.some(c=>c.id===g.contract.call.id)?'nap':'alliance',
    teammate=team(i)===team(current);

  if(teammate){
    const safe=h.filter(c=>winning(g.trick.concat([{player:i,card:c}])).player!==i);
    return low(safe.length?safe:h)
  }
  if(winningCards.length&&(points>0||g.trick.length===4||level===3&&points>=2))return low(winningCards);
  if(level===3&&points===0&&g.trick.length<4){
    return low(h)
  }
  return low(h)
}

function chooseLocalDeputyCard(i,h){
  const contract=g.contract,nap=contract.nap,call=contract.call,trumpSuit=contract.suit,ownSide='nap',led=g.trick[0]?.card.suit,lastSeat=g.trick.length===4;
  const sideOf=seat=>seat===nap||(!contract.solo&&(contract.revealedCall?seat===contract.deputy:g.players[seat].hand.some(c=>c.id===call?.id)))?'nap':'alliance';
  const isFace=card=>POINT.includes(card.rank),sameColor=(a,b)=>['♣','♠'].includes(a)===['♣','♠'].includes(b);
  const isRole=card=>card.id===call?.id||card.id==='♠A'||trumpSuit!=='NT'&&card.rank==='J'&&(card.suit===trumpSuit||sameColor(card.suit,trumpSuit));
  const winnerWith=card=>winning(g.trick.concat([{player:i,card}]));
  const teamWinningCards=h.filter(card=>sideOf(winnerWith(card).player)===ownSide);
  const canEnemyOvertake=card=>{
    const trial=g.trick.concat([{player:i,card}]),current=winning(trial),remaining=4-g.trick.length;
    for(let step=1;step<=remaining;step++){
      const seat=(i+step)%5;if(sideOf(seat)===ownSide)continue;
      const hand=g.players[seat].hand,follow=hand.filter(x=>x.suit===led),options=follow.length?follow:hand;
      for(const response of options)if(sideOf(winning(trial.concat([{player:seat,card:response}])).player)!==ownSide)return true;
    }
    return sideOf(current.player)!==ownSide
  };
  const safeTeamWins=teamWinningCards.filter(card=>!canEnemyOvertake(card));

  if(!g.trick.length){
    const napHand=g.players[nap].hand,
      napHasTrump=trumpSuit!=='NT'&&napHand.some(card=>card.suit===trumpSuit),
      napAces=SUITS.filter(suit=>napHand.some(card=>card.suit===suit&&card.rank==='A'));
    const returnSuit=napAces.find(suit=>h.some(card=>card.suit===suit));
    if(returnSuit)return low(h.filter(card=>card.suit===returnSuit));
    if(trumpSuit!=='NT'&&napHand.some(card=>card.suit===trumpSuit)&&h.some(card=>card.suit===trumpSuit))return low(h.filter(card=>card.suit===trumpSuit));
    if(napHasTrump){
      const voidSuit=SUITS.find(suit=>!napHand.some(card=>card.suit===suit)&&h.some(card=>card.suit===suit));
      if(voidSuit)return low(h.filter(card=>card.suit===voidSuit))
    }
    const secureAce=h.filter(card=>card.rank==='A'&&(()=>{
      const trial=[{player:i,card}];
      for(let offset=1;offset<5;offset++){
        const seat=(i+offset)%5,hand=g.players[seat].hand,follow=hand.filter(x=>x.suit===card.suit),options=follow.length?follow:hand;
        for(const response of options)if(sideOf(winning(trial.concat([{player:seat,card:response}])).player)!==ownSide)return false
      }
      return true
    })());
    if(secureAce.length)return secureAce.sort((a,b)=>cardValue(b)-cardValue(a))[0];
    const sharedSuit=SUITS.filter(suit=>h.some(card=>card.suit===suit)&&napHand.some(card=>card.suit===suit)).sort((a,b)=>napHand.filter(card=>card.suit===b).length-napHand.filter(card=>card.suit===a).length)[0];
    if(sharedSuit)return low(h.filter(card=>card.suit===sharedSuit));
    const leadValue=card=>cardValue(card)+(card.rank==='A'?3:card.rank==='K'?1:0)+g.players[i].hand.filter(x=>x.suit===card.suit).length*.25;
    return h.slice().sort((a,b)=>leadValue(b)-leadValue(a))[0]
  }

  const calledLead=g.trick[0].player===nap&&(led===call?.suit||trumpSuit!=='NT'&&led===trumpSuit);
  if(calledLead){
    if(lastSeat){
      const delayed=safeTeamWins.filter(card=>!isRole(card));
      if(delayed.length){const points=delayed.filter(isFace);return (points.length?points:delayed).sort((a,b)=>cardValue(b)-cardValue(a))[0]}
    }
    const current=winning();
    if(sideOf(current.player)===ownSide){
      const nonRole=h.filter(c=>!isRole(c));
      if(nonRole.length&&Math.random()<g.aiWeights.roleCardPreservation){
        const candidate=low(nonRole);
        if(!canEnemyOvertake(candidate))return candidate;
      }
    }
    if(trumpSuit==='NT'&&call?.rank==='A'&&call.id!=='♠A'&&led===call.suit&&g.trickNo>0){
      const allFollowed=g.trick.every(entry=>entry.card.suit===led),
        alreadyWonByTwo=g.trick.some(entry=>entry.card.suit===led&&entry.card.rank==='2')&&sideOf(winning().player)!==ownSide,
        enemyTwoAfter=Array.from({length:4-g.trick.length},(_,index)=>(i+index+1)%5).some(seat=>sideOf(seat)!==ownSide&&g.players[seat].hand.some(card=>card.suit===led&&card.rank==='2'));
      if(alreadyWonByTwo||allFollowed&&enemyTwoAfter){const shelter=h.filter(card=>card.id!==call.id);if(shelter.length)return low(shelter)}
    }
    if(trumpSuit==='NT'&&call?.rank==='2'){const called=h.find(card=>card.id===call.id);if(called)return called}
    const called=h.find(card=>card.id===call?.id);if(called)return called;
    const roleCards=h.filter(isRole);
    if(roleCards.length)return roleCards.sort((a,b)=>cardPower({player:i,card:b},g.trick.concat([{player:i,card:b}]))-cardPower({player:i,card:a},g.trick.concat([{player:i,card:a}])))[0];
  }

  if(g.trick.length){
    const current=winning(),currentSide=sideOf(current.player),pointCards=safeTeamWins.filter(isFace);
    if(currentSide===ownSide&&pointCards.length)return pointCards.sort((a,b)=>cardValue(b)-cardValue(a))[0];
    if(currentSide!==ownSide&&teamWinningCards.length)return teamWinningCards.sort((a,b)=>cardPower({player:i,card:b},g.trick.concat([{player:i,card:b}]))-cardPower({player:i,card:a},g.trick.concat([{player:i,card:a}])))[0];
    if(currentSide===ownSide){const safe=h.filter(card=>sideOf(winnerWith(card).player)===ownSide);if(safe.length)return low(safe)}
  }
  return low(h)
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
    try {
      if(g.phase!=='play')return;
      const chosen=chooseLocalBotCard(g.active);
      const legalCardsList=legal(g.active);
      if(chosen&&legalCardsList.some(x=>x.id===chosen.id)){
        play(g.active,chosen)
      }else if(legalCardsList.length){
        play(g.active,legalCardsList[Math.floor(Math.random()*legalCardsList.length)])
      }else{
        g.active = (g.active + 4) % 5;
        playTurn();
      }
    } catch (e) {
      console.error("Bot Error:", e);
      const errMsg = e && e.message ? e.message : String(e);
      addGameLog("⚠️ COM思考エラー: " + errMsg + " → ランダムなカードを出しました");
      const l = legal(g.active);
      if (l.length) {
        play(g.active, l[Math.floor(Math.random()*l.length)]);
      } else {
        g.active = (g.active + 4) % 5;
        playTurn();
      }
    }
  },650+Math.random()*550)
}

function artfulCard(entry,trick){
  const c=entry.card,led=trick[0].card.suit,black=s=>s==='♣'||s==='♠';
  return c.id==='♠A'||c.id==='♥Q'&&trick.some(x=>x.card.id==='♠A')||c.rank==='J'&&g.contract.suit!=='NT'&&(c.suit===g.contract.suit||c.suit!==g.contract.suit&&black(c.suit)===black(g.contract.suit))||c.rank==='2'&&c.suit===led&&trick.every(x=>x.card.suit===led);
}

function play(i,c){
  if(g.phase!=='play'||g.active!==i||!legal(i).some(x=>x.id===c.id))return;
  if(!g.trick.length)g.lastTrickWinner=null;
  const previous=g.trick.length?winning():null;
  g.selectedCard=null;
  $('play-panel').classList.add('hidden');
  let h=g.players[i].hand;
  h.splice(h.findIndex(x=>x.id===c.id),1);
  g.trick.push({player:i,card:c});
  g.playedCards.push({suit:c.suit,rank:c.rank,id:c.id});
  if(g.trick.length>1){
    const ledSuit=g.trick[0].card.suit;
    if(c.suit!==ledSuit){
      if(!g.voids[i])g.voids[i]={};
      g.voids[i][ledSuit]=true;
    }
  }
  if(artfulCard({player:i,card:c},g.trick)){
    g.matchStats[i].artAttempts=(g.matchStats[i].artAttempts||0)+1;
  }
  const reveal=g.contract.call?.id===c.id&&!g.contract.revealedCall;
  addGameLog(name(i)+'が'+c.id+'を出した'+(reveal?'（指名札）':''));
  if(reveal){
    g.contract.revealedCall=true;
    g.contract.revealTrickNo=g.trickNo;
    addGameLog('指名札公開、副官は'+name(g.contract.deputy));
    if(g.round>=10&&!g.contract.solo){
      const r=computeTeamMinBid(g.matchScores, g.mult, g.contract.nap, g.contract.deputy);
      if(r!==null){
        const oldBid=g.contract.num;
        const forcedMin=r.minBid;
        const caseLabel={A:'5位=ナポレオン / 4位=副官',B:'4位=ナポレオン / 5位=副官',C:'5位=ナポレオン / 4位=連合軍',D:'4位=ナポレオン / 5位=連合軍'}[r.case];
        if(forcedMin>oldBid){
          g.contract.num=forcedMin;
          renderContractInfo();
          drawSeats();
          toast('副官判明：最低立ち条件が変わりました。立ちを '+oldBid+'枚 → '+forcedMin+'枚 に引き上げます（'+caseLabel+'）');
          addGameLog('★副官判明による立ち変更：'+oldBid+'枚 → '+forcedMin+'枚（'+caseLabel+'）');
          message('副官が判明したため、最低立ち条件に合わせて立ちを '+forcedMin+'枚へ引き上げました');
        }else{
          addGameLog('副官判明：現在の立ち '+oldBid+'枚は最低条件 '+forcedMin+'枚を満たしています（'+caseLabel+'）');
          toast('副官判明：立ち '+oldBid+'枚は最低条件を満たしています（'+caseLabel+'）');
        }
        if(r.incentiveBroken){
          const warnMsg='⚠ 20枚でも4位が3位を超えられません。副官に勝つインセンティブがなく、わざと負ける行動が最適になります';
          toast(warnMsg);
          addGameLog('⚠ '+warnMsg+'（'+caseLabel+'）');
          message(warnMsg);
        }
      }
    }
  }
  if(previous&&g.contract.revealedCall){
    const team=seat=>seat===g.contract.nap||seat===g.contract.deputy?'nap':'alliance';
    if(team(i)===team(previous.player)&&winning().player===i)g.roundArt[i]--
  }
  $('trick-cards').append(cardEl(c,'trick-card played-seat-'+i));
  if(g.trick.length<5){g.active=(i+4)%5;playTurn();return}
  g.phase='trick-end';
  const winningEntry=winning(),w=winningEntry.player,
    taken=g.trick.filter(e=>POINT.includes(e.card.rank)).map(e=>e.card);
  if(taken.length>=3&&artfulCard(winningEntry,g.trick)){
    g.matchStats[w].dramaticPlays=(g.matchStats[w].dramaticPlays||0)+1;
    if(g.roundArt[w]<2)g.roundArt[w]++;
  }
  g.points[w]+=taken.length;
  g.players[w].taken.push(...taken);
  g.players[w].roundTaken.push(...taken);
  g.players[w].roundPoints=(g.players[w].roundPoints||0)+taken.length;
  if(!g.contract.solo&&g.contract.deputy>=0&&g.contract.deputy!==g.contract.nap){
    const deputyEntry=g.trick.find(e=>e.player===g.contract.deputy);
    if(deputyEntry&&POINT.includes(deputyEntry.card.rank)){
      g.matchStats[g.contract.deputy].allyFeedAttempts=(g.matchStats[g.contract.deputy].allyFeedAttempts||0)+1;
      if(w===g.contract.nap||w===g.contract.deputy){
        g.matchStats[g.contract.deputy].allyFeedSuccesses=(g.matchStats[g.contract.deputy].allyFeedSuccesses||0)+1;
      }
    }
  }
  addGameLog(name(w)+'が第'+(g.trickNo+1)+'勝負を獲得（'+taken.length+'点札）');
  g.lastTrickWinner=w;
  g.active=w;
  const alliancePoints=g.points.reduce((n,points,i)=>n+(i!==g.contract.nap&&(g.contract.solo||i!==g.contract.deputy)?points:0),0),
    napPoints=g.points.reduce((n,points,i)=>n+(i===g.contract.nap||!g.contract.solo&&i===g.contract.deputy?points:0),0);
  if(alliancePoints>20-g.contract.num||napPoints>=g.contract.num&&(g.contract.num===20||alliancePoints>=1)){finishGame();return}
  message(name(w)+'が場札を取りました');
  drawSeats();
  later(()=>{
    g.trickNo++;
    if(g.trickNo>=10){finishGame();return}
    g.trick=[];
    $('trick-cards').replaceChildren();
    g.phase='play';
    message(name(w)+'から次の勝負');
    playTurn()
  },1250)
}

function finalRatingDeltas(scores,art,ratings,matchStats,contracts){
  const meanArt=art.reduce((n,x)=>n+x,0)/5;
  const cs=contracts||[];
  return scores.map((score,seat)=>{
    let delta=0;
    const rounds=[];
    for(const c of cs){
      const p=CALIBRATION[Math.min(20,Math.max(13,c.num))]??0.5;
      const diff=c.num-12;
      const actual=c.napWin?1:0;
      let roundDelta=0;
      let role='ally';
      if(seat===c.nap){
        role='nap';
        roundDelta=(actual-p)*diff*8;
        if(c.napWin&&c.points>c.num){roundDelta-=(c.points-c.num)*0.3;}
        if(c.solo)roundDelta*=1.5;
      }else if(!c.solo&&seat===c.deputy){
        role='dep';
        roundDelta=(actual-p)*diff*3.2;
        if(c.napWin&&c.revealTrickNo!=null){roundDelta+=Math.max(0,c.revealTrickNo-3)*0.3;}
      }else{
        role='ally';
        const pts=(c.takenPoints&&c.takenPoints[seat])||0;
        roundDelta=(pts-4.4)*0.4;
        roundDelta+=c.napWin?-0.5:+0.5;
      }
      delta+=roundDelta;
      rounds.push({bid:c.num,role,delta:Math.round(roundDelta*100)/100});
    }
    delta+=(art[seat]-meanArt)*0.3;
    const rank=1+scores.filter(x=>x>score).length;
    if(rank===1)delta+=0.5;
    else if(rank===5)delta-=0.5;
    delta-=0.05*cs.length;
    return {seat,delta:Math.round(delta*10)/10,placement:rank,art:art[seat]-meanArt,breakdown:{rounds,rank}};
  })
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
  napStat.declarerAttempts++;
  napStat.bidTotal+=c.num;
  if(success)napStat.declarerSuccesses++;
  napStat.exactAttempts++;
  if(exact)napStat.exactSuccesses++;
  if(bold){napStat.boldAttempts++;if(exact)napStat.boldSuccesses++;}
  if(c.solo){napStat.soloAttempts++;if(success)napStat.soloSuccesses++;}
  if(!c.solo&&c.deputy!==c.nap){const depStat=g.matchStats[c.deputy];depStat.deputyAttempts++;if(success)depStat.deputySuccesses++;}

  try{
    const lastPlacePenalty=g.matchScores.filter(s=>s>g.matchScores[0]).length===4?1:0;
    fetch('/api/ai/report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({napoleonWon:(()=>{const cc=g.contract,side=cc.solo?[cc.nap]:[cc.nap,cc.deputy],pts=side.reduce((n,i)=>n+g.points[i],0);return pts>=cc.num;})(),exactWins:g.roundArt.filter(a=>a>=4).length,lastPlacePenalty})}).then(r=>r.json()).then(d=>{if(d.weights)Object.assign(g.aiWeights,d.weights);}).catch(()=>{});
  }catch{}

  let finalRule=g.round>=10?finalAuctionRule(g.matchScores,g.mult):null,
    sign=success?1:-1,
    unit=Math.max(0,c.num-12)*g.mult*(g.round>=10?2:1),
    scores=Array(5).fill(0);
  scores[c.nap]=sign*unit*(c.solo?4:2);
  if(c.solo){g.players.forEach((_,i)=>{if(i!==c.nap)scores[i]=-sign*unit})}
  else{
    scores[c.deputy]=sign*unit;
    g.players.forEach((_,i)=>{if(i!==c.nap&&i!==c.deputy)scores[i]=-sign*unit})
  }
  const art=g.roundArt.slice();
  if(success&&pts===c.num){art[c.nap]+=2;if(!c.solo)art[c.deputy]+=1;if(c.num>=15){art[c.nap]+=2;if(!c.solo)art[c.deputy]+=1}}
  if(c.solo)art[c.nap]+=success?4:2;
  if(!success&&!c.solo&&c.num-pts>=3){art[c.nap]-=2;art[c.deputy]-=1}
  for(let i=0;i<5;i++){g.matchScores[i]+=scores[i];g.matchArt[i]+=art[i]}

  g.matchContracts.push({round:g.round,nap:c.nap,deputy:c.deputy,num:c.num,suit:c.suit,solo:c.solo,points:pts,napWin:success,revealTrickNo:c.revealTrickNo??null,takenPoints:g.players.map(p=>p.roundPoints||0)});

  const replayAllLast=!!(finalRule&&scores[finalRule.bottomSeat]>0&&g.matchScores[finalRule.bottomSeat]===g.matchScores[finalRule.fourthSeat]);
  if(replayAllLast)g.playoff=true;
  const format=n=>(n>0?'+':'')+(Number.isInteger(n)?n:n.toFixed(1)),
    role=i=>i===c.nap?'NAP':!c.solo&&i===c.deputy?'DEPUTY':'ALLY',
    rows=g.players.map((_,i)=>'<div class="round-score-row"><span>'+name(i)+' · '+role(i)+'</span><strong class="'+(scores[i]<0?'score-down':'score-up')+'">ROUND Δ '+format(scores[i])+'<small>TOTAL '+format(g.matchScores[i])+'</small></strong></div>').join(''),
    final=g.round>=10&&!replayAllLast,
    ratings=final?finalRatingDeltas(g.matchScores,g.matchArt,[g.rate,1000,1000,1000,1000],g.matchStats,g.matchContracts):null;
  if(final){g.rate+=ratings[0].delta;$('rating-label').textContent=g.rate}
  phase('結果');
  addGameLog((success?'ナポレオン軍成功':'連合軍成功')+' · 宣言 '+c.num+'枚 / 獲得 '+pts+'枚');
  message(replayAllLast?'プレーオフ':success?'NAP TEAM WINS':'ALLIANCE WINS');
  drawSeats();
  const finalRows=final?g.players.map((_,i)=>{
    const result=ratings[i],b=result.breakdown,
      roundStr=(b.rounds||[]).map(r=>(r.role==='nap'?'N':r.role==='dep'?'D':'A')+r.bid+':'+format(r.delta)).join(' ');
    return '<div class="round-score-row"><span>'+name(i)+' · MATCH '+format(g.matchScores[i])+' / ART '+format(g.matchArt[i])+'</span><strong class="'+(result.delta<0?'score-down':'score-up')+'">SIM RATE Δ '+format(result.delta)+'<small>順位 '+b.rank+' · '+roundStr+'</small></strong></div>'
  }).join(''):'',
    r=$('result-panel');
  r.classList.remove('hidden');
  r.innerHTML='<div class="eyebrow">'+(g.playoff?'プレーオフ':g.round===9?'ラス前':g.round>=10?'オールラスト':'ROUND '+String(g.round).padStart(2,'0'))+' · RESULT</div><h2>'+(success?'NAP TEAM WINS':'ALLIANCE WINS')+'</h2><p>BID '+c.num+c.suit+' · POINTS '+pts+(c.solo?' · SOLO':'')+'<br>NAP '+name(c.nap)+(c.solo?'':' · DEPUTY '+name(c.deputy))+'</p>'+(replayAllLast?'<p>5位が4位に並びました。プレーオフを行います。</p>':'')+'<div class="round-score-list"><div class="micro-copy">ROUND SCORE</div>'+rows+'</div>'+(final?'<div class="round-score-list"><div class="micro-copy">MATCH COMPLETE · SIM RATE '+g.rate+'</div>'+finalRows+'</div>':'')+'<button id="next-round" class="primary-button">'+(final?'MENU':replayAllLast?'プレーオフ再戦':'NEXT ROUND')+'</button>';
  $('next-round').onclick=()=>{
    r.classList.add('hidden');
    if(final){screen('home-screen');return}
    g.round++;
    g.mult=1;
    g.greenRedraws=0;
    roundStart()
  }
}

function addTakenCards(seat,cards=[]){
  const row=document.createElement('div');row.className='taken-cards';
  const label=document.createElement('span');label.className='taken-label';label.textContent='獲得 '+cards.length;
  row.append(label);
  cards.forEach(c=>{const tag=document.createElement('span');tag.className='taken-card '+color(c.suit);tag.textContent=c.suit+c.rank;row.append(tag)});
  seat.append(row)
}

function drawSeats(){
  let box=$('players-ring');
  box.replaceChildren();
  const leadSeat=g.phase==='play'&&g.trick.length?g.trick[0].player:g.lastTrickWinner;
  g.players.forEach((p,i)=>{
    let e=document.createElement('div');
    e.className='player-seat player-color-'+i+' pos-'+i+(i===0?' me':'')+(i===g.active?' active':'')+(i===leadSeat?' trick-winner':'');
    let role=g.contract?(g.contract.nap===i?(g.contract.revealedCall&&g.contract.solo?'ナポレオン（ひとり立ち）':'ナポレオン'):!g.contract.revealedCall?'':g.contract.deputy===i?'副官':'連合軍'):g.phase==='auction'&&!g.auction.active.includes(i)?'承認済み':'';
    e.classList.toggle('deputy-seat',role==='副官');
    e.innerHTML='<div class="seat-name">'+name(i)+(p.bot?'<span class="com-badge">COM</span>':'')+'</div>'+(i===leadSeat?'<div class="lead-badge" role="img" aria-label="トリック先攻"><i></i></div>':'')+'<div class="seat-role '+(role==='副官'?'deputy-status':'')+'">'+role+'</div>';
    addTakenCards(e,p.taken);
    box.append(e)
  })
}

function dialog(title,text,cb){
  let d=$('message-dialog'),card=$('dialog-card');
  card.classList.add('hidden');
  card.replaceChildren();
  $('dialog-eyebrow').classList.remove('hidden');
  $('dialog-eyebrow').textContent='Napoleon';
  $('dialog-ok').textContent='OK';
  $('dialog-title').textContent=title;
  $('dialog-body').textContent=text;
  $('dialog-ok').onclick=()=>{d.close();if(cb)cb()};
  d.showModal()
}

function announceCall(card,onConfirm,online=false){
  const d=$('message-dialog'),slot=$('dialog-card');
  $('dialog-eyebrow').classList.add('hidden');
  $('dialog-title').textContent='DEPUTY CALL';
  slot.classList.remove('hidden');
  slot.replaceChildren(cardEl(card,'announcement-card'));
  $('dialog-body').textContent=online?'全員が確認すると最初のトリックが始まります。':'確認して、最初のトリックを始めます。';
  $('dialog-ok').textContent=online?'確認':'最初のトリックへ';
  $('dialog-ok').onclick=()=>{d.close();slot.classList.add('hidden');slot.replaceChildren();$('dialog-eyebrow').classList.remove('hidden');$('dialog-eyebrow').textContent='Napoleon';$('dialog-ok').textContent='OK';if(onConfirm)onConfirm()};
  d.showModal()
}

async function getUser(){try{g.user=await window.websim?.getUser?.()||null}catch(e){g.user=null}return g.user}

function renderAccount(){
  if(!g.account)return;
  $('profile-open').textContent='PROFILE';
  $('account-chip').textContent='ID '+g.account.id+' · '+g.account.rating;
  $('account-chip').classList.remove('hidden');
  $('account-chip').onclick=records;
  $('profile-form').classList.add('hidden');
  $('profile-summary').classList.remove('hidden');
  $('profile-summary').innerHTML='<div class="profile-emblem">♠</div><div><div class="eyebrow">PLAYER CARD</div><div class="profile-summary-id">'+g.account.id+'</div><div class="micro-copy">RATE '+g.account.rating+' · '+g.account.wins+'W · '+g.account.losses+'L</div></div><button type="button" id="open-my-page" class="secondary-button">VIEW PROFILE</button>';
  document.getElementById('open-my-page').onclick=records
}

async function account(path){
  const id=$('account-id').value.trim(),password=$('account-password').value;
  if(!id||!password){toast('IDとパスワードを入力してください');return}
  try{
    const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,password})});
    const d=await r.json();
    if(!r.ok)throw Error(d.error||'処理できませんでした');
    g.account=d;
    g.sessionToken=d.sessionToken||null;
    if(d.sessionToken)localStorage.setItem('napoleon_session',d.sessionToken);
    renderAccount();
    toast(path.endsWith('register')?'登録しました':'ログインしました');
    records()
  }catch(e){toast(e.message)}
}

async function loadAccount(){
  const token=localStorage.getItem('napoleon_session');
  if(!token){renderHomeRating({unregistered:true});return}
  try{
    const r=await fetch('/api/account/me',{headers:{'x-session-token':token}});
    if(r.ok){g.account=await r.json();g.sessionToken=token;renderAccount();renderHomeRating(g.account)}
    else if(r.status===401||r.status===404){localStorage.removeItem('napoleon_session');g.sessionToken=null;renderHomeRating({unregistered:true})}
  }catch{}
}

function renderHomeRating(d){
  const box=$('my-rating');if(!box)return;
  if(!d){box.classList.add('hidden');return}
  box.classList.remove('hidden');
  if(d.unregistered){
    box.innerHTML='<div class="rating-signup"><div><div class="eyebrow">YOUR RATING</div><h2>BUILD YOUR RATING</h2><p>REGISTER TO TRACK YOUR RATE AND MATCH HISTORY.</p></div><button id="rating-register" class="secondary-button">REGISTER</button></div>';
    $('rating-register').onclick=()=>screen('profile-screen');
    return
  }
  box.classList.add('hidden')
}

async function loadLeaderboard(){
  const section=$('leaderboard'),box=$('rating-leaders');if(!section||!box)return;
  try{
    const response=await fetch('/api/rating/top');if(!response.ok)throw Error();
    const leaders=(await response.json()).slice(0,g.leaderboardExpanded?50:3);
    if(!leaders.length){section.classList.add('hidden');return}
    section.classList.remove('hidden');
    box.classList.toggle('expanded',g.leaderboardExpanded);
    $('show-ranking').textContent=g.leaderboardExpanded?'TOP 3':'VIEW TOP 50';
    $('show-ranking').setAttribute('aria-expanded',String(g.leaderboardExpanded));
    box.innerHTML=leaders.map((player,i)=>{
      const username=String(player.username||player.id||'player'),href='https://websim.com/@'+encodeURIComponent(username),avatar='https://images.websim.com/avatar/'+encodeURIComponent(username);
      return '<article class="rating-leader rank-'+(i+1)+'"><span class="leader-place">'+String(i+1).padStart(2,'0')+'</span><a class="leader-person" href="'+escapeHTML(href)+'" target="_blank" rel="noopener noreferrer"><img src="'+escapeHTML(avatar)+'" alt="" loading="lazy"><span>@'+escapeHTML(username)+'</span></a><strong>'+Number(player.rating||0)+'<small> pt</small></strong></article>'
    }).join('')
  }catch{section.classList.add('hidden')}
}

function escapeHTML(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

async function records(){
  screen('records-screen');
  const token=localStorage.getItem('napoleon_session');
  if(!token){
    $('records-content').innerHTML='<p class="subcopy">REGISTER TO UNLOCK PLAYER STATS.</p><button id="records-register" class="primary-button">プレイヤー登録</button>';
    $('records-register').onclick=()=>screen('profile-screen');
    return
  }
  try{
    const response=await fetch('/api/account/me',{headers:{'x-session-token':token}});
    if(!response.ok)throw Error('UNABLE TO LOAD PLAYER STATS.');
    const d=await response.json();
    g.account=d;renderAccount();

    const perf=d.performance||{};
    const prec=d.precision||{};
    const ally=d.allyFeed||{};
    const bold=d.boldBid||{};
    const art=d.artRate||{};
    const ms=d.matchStats||{};

    const napAtt=Number(perf.declarer_attempts)||0;
    const napWins=Number(perf.declarer_successes)||0;
    const napWinRate=napAtt?napWins/napAtt:0;

    const exactAtt=Number(prec.exact_attempts)||0;
    const exactWins=Number(prec.exact_successes)||0;
    const exactRate=exactAtt?exactWins/exactAtt:0;

    const boldAtt=Number(bold.attempts)||0;
    const boldWins=Number(bold.successes)||0;
    const boldRate=boldAtt?boldWins/boldAtt:0;

    const soloAtt=Number(prec.solo_attempts)||0;
    const soloWins=Number(prec.solo_successes)||0;
    const soloRate=soloAtt?soloWins/soloAtt:0;

    const depAtt=Number(perf.deputy_attempts)||0;
    const depWins=Number(perf.deputy_successes)||0;
    const depWinRate=depAtt?depWins/depAtt:0;

    const feedAtt=Number(ally.attempts)||0;
    const feedWins=Number(ally.successes)||0;
    const feedRate=feedAtt?feedWins/feedAtt:0;

    const artAtt=Number(art.attempts)||0;
    const artPlays=Number(art.plays)||0;
    const artRate=artAtt?artPlays/artAtt:0;

    const bidTotal=Number(ms.bid_total)||0;
    const avgBid=napAtt?bidTotal/napAtt:0;
    const matchCount=Number(ms.match_count)||0;
    const napRatio=matchCount?(napAtt/(matchCount*10)):0;

    const r1=Number(ms.rank_1)||0,r2=Number(ms.rank_2)||0,r3=Number(ms.rank_3)||0,r4=Number(ms.rank_4)||0,r5=Number(ms.rank_5)||0;
    const totalRanks=r1+r2+r3+r4+r5;
    const avgRank=totalRanks?((r1*1+r2*2+r3*3+r4*4+r5*5)/totalRanks):0;
    const rankScore=totalRanks?Math.max(0,Math.min(1,(5-avgRank)/4)):0;

    const napScore=napAtt>0?Math.round((napWinRate*0.65+exactRate*0.25+boldRate*0.05+soloRate*0.05)*100):null;
    const depScore=depAtt>0?Math.round((depWinRate*0.75+feedRate*0.25)*100):null;
    const allScore=totalRanks>0?Math.round((rankScore*0.7+artRate*0.3)*100):null;

    const pct=v=>(v*100).toFixed(1)+'%';
    const scoreText=s=>s===null?'—':String(s);
    const barW=s=>s===null?0:s;
    const scoreUnit=s=>s===null?'':'<small>/100</small>';

    $('records-content').innerHTML=`
      <div class="mypage-head">
        <div class="profile-emblem large">♠</div>
        <div class="mypage-identity">
          <div class="eyebrow">PLAYER CARD</div>
          <h2>${escapeHTML(d.id)}</h2>
        </div>
        <div class="mypage-rating">
          <span>RATE</span>
          <strong>${d.rating}</strong>
        </div>
      </div>

      <div class="record-stats">
        <div class="record-stat"><span>MATCHES</span><b>${d.games}</b></div>
        <div class="record-stat"><span>WINS</span><b>${d.wins}</b></div>
        <div class="record-stat"><span>LOSSES</span><b>${d.losses}</b></div>
      </div>

      <section class="performance-section">
        <h3 class="section-title">パフォーマンス指標</h3>
        <div class="performance-grid">
          <article class="performance-card">
            <span>平均立ち成功率</span>
            <strong>${napAtt>0?pct(napWinRate):'—'}</strong>
            <small>${napWins} / ${napAtt}</small>
          </article>
          <article class="performance-card">
            <span>平均宣言数</span>
            <strong>${avgBid>0?avgBid.toFixed(1)+'枚':'—'}</strong>
            <small>${napAtt>0?napAtt+'回の立ち':'実績なし'}</small>
          </article>
          <article class="performance-card">
            <span>ナポレオン率</span>
            <strong>${matchCount>0?pct(napRatio):'—'}</strong>
            <small>${matchCount>0?(matchCount*10)+'局中'+napAtt+'回':'実績なし'}</small>
          </article>
        </div>
      </section>

      <section class="role-skill-section">
        <h3 class="section-title">役割別実力</h3>
        <div class="role-skill-grid">
          <article class="role-skill role-nap">
            <div class="role-skill-head">
              <div class="role-emblem">♠</div>
              <div class="role-title">
                <span class="eyebrow">NAPOLEON</span>
                <div class="role-score">${scoreText(napScore)}${scoreUnit(napScore)}</div>
              </div>
            </div>
            <div class="skill-bar"><div style="width:${barW(napScore)}%"></div></div>
            <div class="skill-rows">
              <div><span>立ち成功率</span><b>${napAtt>0?pct(napWinRate):'—'}</b></div>
              <div><span>EXACT率</span><b>${exactAtt>0?pct(exactRate):'—'}</b></div>
              <div><span>BOLD成功率</span><b>${boldAtt>0?pct(boldRate):'—'}</b></div>
              <div><span>SOLO成功率</span><b>${soloAtt>0?pct(soloRate):'—'}</b></div>
            </div>
          </article>

          <article class="role-skill role-dep">
            <div class="role-skill-head">
              <div class="role-emblem">♣</div>
              <div class="role-title">
                <span class="eyebrow">DEPUTY</span>
                <div class="role-score">${scoreText(depScore)}${scoreUnit(depScore)}</div>
              </div>
            </div>
            <div class="skill-bar"><div style="width:${barW(depScore)}%"></div></div>
            <div class="skill-rows">
              <div><span>副官成功率</span><b>${depAtt>0?pct(depWinRate):'—'}</b></div>
              <div><span>絵札回し成功率</span><b>${feedAtt>0?pct(feedRate):'—'}</b></div>
              <div><span>副官経験</span><b>${depAtt>0?depAtt+'回':'—'}</b></div>
            </div>
          </article>

          <article class="role-skill role-all">
            <div class="role-skill-head">
              <div class="role-emblem">♥</div>
              <div class="role-title">
                <span class="eyebrow">ALLIANCE</span>
                <div class="role-score">${scoreText(allScore)}${scoreUnit(allScore)}</div>
              </div>
            </div>
            <div class="skill-bar"><div style="width:${barW(allScore)}%"></div></div>
            <div class="skill-rows">
              <div><span>平均順位</span><b>${totalRanks>0?avgRank.toFixed(2)+'位':'—'}</b></div>
              <div><span>1位率</span><b>${totalRanks>0?pct(r1/totalRanks):'—'}</b></div>
              <div><span>4〜5位率</span><b>${totalRanks>0?pct((r4+r5)/totalRanks):'—'}</b></div>
              <div><span>アート成功率</span><b>${artAtt>0?pct(artRate):'—'}</b></div>
            </div>
          </article>
        </div>
      </section>
    `;
  }catch(e){$('records-content').textContent='UNABLE TO LOAD PLAYER STATS.'}
}

async function loadStrategyLab(){
  const wrap=$('strategy-content');
  if(!wrap)return;
  wrap.innerHTML='<p class="subcopy">戦略を読み込み中…</p>';
  try{
    const [stratRes,insightRes,genRes]=await Promise.all([
      fetch('/api/ai/strategies?limit=10'),
      fetch('/api/ai/insights'),
      fetch('/api/ai/generations')
    ]);
    const strategies=stratRes.ok?await stratRes.json():[];
    const insights=insightRes.ok?(await insightRes.json()).insights||[]:[];
    const generations=genRes.ok?await genRes.json():[];
    renderStrategyLab({strategies,insights,generations});
  }catch(e){
    wrap.innerHTML='<p class="subcopy">戦略を読み込めませんでした。</p>';
  }
}

function renderStrategyLab({strategies,insights,generations}){
  const wrap=$('strategy-content');
  if(!strategies.length){
    wrap.innerHTML='<p class="subcopy">まだ学習データがありません。「自己対戦を実行」ボタンを押してください。</p>';
    return;
  }
  const paramNames={bidThreshold:'立ち強度',riskTolerance:'リスク許容',leadAggression:'リード積極性',followAggression:'フォロー積極性',trumpBonus:'切り札評価',mightyBonus:'マイティ評価',safeAceWeight:'A温存',roleCardPreservation:'役札温存',deputyFeedBias:'副官の絵札回し'};
  const cards=strategies.slice(0,5).map((s,i)=>{
    const rank=i+1;
    return `<article class="strategy-card rank-${rank}">
      <div class="strategy-rank">#${rank}</div>
      <div class="strategy-meta">
        <span class="eyebrow">GEN ${s.generation} · ${s.matches}試合</span>
        <strong>+${Number(s.avg_rating_delta||0).toFixed(2)} <small>pt/試合</small></strong>
      </div>
      <div class="strategy-roles">
        <span>NAP ${(Number(s.nap_win_rate)*100).toFixed(1)}%</span>
        <span>DEP ${(Number(s.deputy_win_rate)*100).toFixed(1)}%</span>
        <span>ALLI ${(Number(s.alliance_win_rate)*100).toFixed(1)}%</span>
      </div>
    </article>`;
  }).join('');
  const params=JSON.parse(strategies[0].params||'{}');
  const paramRows=Object.entries(params).map(([k,v])=>
    `<div class="param-row"><span>${paramNames[k]||k}</span><b>${Number(v).toFixed(2)}</b></div>`
  ).join('');
  const insightCards=insights.map(ins=>`<article class="insight-card"><h3>${escapeHTML(ins.title)}</h3><p>${escapeHTML(ins.detail)}</p></article>`).join('');
  const genRows=generations.slice(-10).map(gg=>`
    <div class="gen-row">
      <span>Gen ${gg.generation}</span>
      <b>+${Number(gg.best_delta||0).toFixed(2)}pt</b>
      <small>NAP ${(Number(gg.nap)*100).toFixed(0)} / DEP ${(Number(gg.dep)*100).toFixed(0)} / ALLI ${(Number(gg.ally)*100).toFixed(0)}</small>
    </div>`).join('');
  wrap.innerHTML=`
    <div class="strategy-actions">
      <button id="run-selfplay" class="primary-button">自己対戦を実行（1000局）</button>
      <button id="refresh-strategy" class="secondary-button">再読み込み</button>
      <span id="selfplay-status" class="micro-copy"></span>
    </div>
    <section class="strategy-section"><h2>TOP STRATEGIES（レート上昇順）</h2><div class="strategy-list">${cards}</div></section>
    <section class="strategy-section"><h2>最上位戦略のパラメータ</h2><div class="param-table">${paramRows}</div></section>
    <section class="strategy-section"><h2>学習インサイト</h2><div class="insight-list">${insightCards}</div></section>
    <section class="strategy-section"><h2>世代推移</h2><div class="gen-list">${genRows}</div></section>
  `;
  $('run-selfplay').onclick=async()=>{
    const btn=$('run-selfplay'),status=$('selfplay-status');
    btn.disabled=true;
    status.textContent='自己対戦1000局を実行中…（10〜20秒かかります）';
    try{
      const res=await fetch('/api/ai/run-selfplay',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({matches:1000})});
      const data=await res.json();
      if(data.ok){
        status.textContent=`Gen ${data.generation} 完了（${data.matches}試合）`;
        await loadTopStrategy();
        await loadStrategyLab();
      }else{
        status.textContent='エラー: '+(data.error||'unknown');
      }
    }catch(e){
      status.textContent='実行できませんでした';
    }finally{
      btn.disabled=false;
    }
  };
  $('refresh-strategy').onclick=()=>loadStrategyLab();
}

function code(){return Math.random().toString(36).slice(2,7).toUpperCase()}

async function online(mode,roomCode,bots,botLevel=3){
  $('game-log-open').classList.add('hidden');
  if(mode==='ranked'&&!localStorage.getItem('napoleon_session')){toast('先にプレイヤー登録をしてください');screen('profile-screen');return}
  loadTopStrategy();
  try{
    g.room=await new Promise((resolve,reject)=>{
      const proto=location.protocol==='https:'?'wss:':'ws:';
      const ws=new WebSocket(proto+'//'+location.host+'/ws');
      ws.onopen=()=>resolve({ws,send:m=>ws.send(JSON.stringify(m)),close:()=>ws.close()});
      ws.onerror=reject
    });
    g.mySeat=-1;g.privateHand=[];g.onlineState=null;g.onlineDiscard=new Set();g.onlineSelectedCard=null;g.onlineBid=13;g.onlineSuit='♠';g.onlineRank='A';g.announcedCallRound=null;g.announcedRound=null;
    ['auction-panel','call-panel','play-panel','result-panel'].forEach(id=>$(id).classList.add('hidden'));
    screen('game-screen');
    $('game-mode-label').textContent=mode==='ranked'?'RANKED':'FRIEND MATCH';
    $('rating-caption').textContent='RATE';
    phase(mode==='ranked'?'対戦相手を検索':'部屋を準備中');
    message(mode==='ranked'?'最後の入室から90秒経過するとCOMが参加します':'合言葉 '+roomCode+' で参加を待っています');
    g.room.ws.onmessage=e=>{
      let m;try{m=JSON.parse(e.data)}catch{return}
      if(m.type==='lobby'){message(m.text)}
      if(m.type==='matched'){g.online=m;g.mySeat=m.seat;g.players=m.players.map(p=>({name:p.id,hand:[]}));g.active=-1;drawSeats();phase('対戦開始');message('配札しました。競り開始まで7秒です。'+(m.botCount?' COM '+m.botCount+'人が参加します。':''))}
      if(m.type==='game-state'){g.onlineState=m.state;g.mySeat=m.you;g.active=m.state.active;g.phase=m.state.phase;g.players=m.state.players.map(p=>({name:p.name,hand:Array(p.handCount).fill(null)}));renderOnline()}
      if(m.type==='private-hand'){g.privateHand=m.hand;g.onlineLegal=m.legal;drawOnlineHand();if(g.onlineState)drawOnlineControls(g.onlineState)}
      if(m.type==='rating-updated'){g.lastRating=m;g.account=Object.assign({},g.account,{rating:m.rating});$('rating-label').textContent=m.rating;toast('RATE Δ '+m.delta);if(g.onlineState?.phase==='result')showOnlineResult(g.onlineState)}
      if(m.type==='room-error')toast(m.message)
    };
    g.room.send({type:'join',mode:mode,code:roomCode,bots:bots,botLevel:Number(botLevel)||3,sessionToken:localStorage.getItem('napoleon_session'),playerId:g.account?.id||'プレイヤー'})
  }catch(e){toast('対戦に接続できませんでした');screen('home-screen')}
}

$('start-com').onclick=()=>startLocal();
$('game-log-open').onclick=openGameLog;
$('game-log-close').onclick=()=>$('game-log-dialog').close();
$('create-friend').onclick=()=>{let c=code();$('friend-code').value=c;online('friend',c,Number($('com-count').value),3)};
$('join-friend').onclick=()=>{let c=$('friend-code').value.trim().toUpperCase();if(!c){toast('合言葉を入力してください');return}online('friend',c,Number($('com-count').value),3)};
$('start-ranked').onclick=()=>online('ranked','',0);
$('profile-open').onclick=()=>g.account?records():screen('profile-screen');
$('show-record').onclick=records;
$('show-ranking').onclick=()=>{g.leaderboardExpanded=!g.leaderboardExpanded;loadLeaderboard()};
const strategyBtn=$('open-strategy-lab');
if(strategyBtn)strategyBtn.onclick=()=>screen('strategy-screen');
document.querySelectorAll('[data-go-home]').forEach(b=>b.onclick=()=>screen('home-screen'));
$('leave-game').onclick=()=>{closeOnline();screen('home-screen')};
$('register-account').onclick=()=>account('/api/account/register');
$('login-account').onclick=()=>account('/api/account/login');
loadAccount();loadLeaderboard();
setInterval(()=>{if(g.onlineState&&['prep','call','discard','play'].includes(g.onlineState.phase)&&g.onlineState.deadline)$('auction-clock').textContent=Math.max(0,Math.ceil((g.onlineState.deadline-Date.now())/1000))+'秒'},250);

function sendGame(action){g.room?.send({type:'game',action:action})}

function renderOnline(){
  const s=g.onlineState;if(!s)return;
  g.round=s.round||1;g.playoff=!!s.playoff;g.appealInfo=s.appealInfo||'';
  if(s.phase!=='play'||s.active!==g.mySeat)g.onlineSelectedCard=null;
  g.matchScores=s.matchScores||g.matchScores;
  g.players=s.players.map(p=>({name:p.name,bot:p.bot,hand:Array(p.handCount).fill(null),taken:p.taken||[]}));
  g.active=s.players.findIndex(p=>p.active===s.active);
  g.contract=s.contract?{nap:s.contract.nap,deputy:s.contract.deputy,num:s.contract.num,suit:s.contract.suit,solo:s.contract.solo,call:s.contract.call,revealedCall:s.contract.revealedCall}:null;
  phase(({prep:'競り準備',auction:'競り',call:'指名札選び','call-reveal':'指名カード確認',discard:'浮き札の交換',play:'カードプレイ',result:'結果','round-result':'局結果',redeal:'配り直し','trick-end':'勝負の結果'})[s.phase]||'対戦中');
  $('round-label').textContent=s.round||1;
  if(s.phase==='prep')announceRound(g.round,s.finalRoundRule);
  $('game-mode-label').textContent=s.mode==='ranked'?'RANKED'+(s.players.some(p=>p.bot)?' · COM '+s.players.filter(p=>p.bot).length:''):'FRIEND MATCH'+(s.players.some(p=>p.bot)?' · COM '+s.players.filter(p=>p.bot).length:'');
  $('rating-label').textContent=g.account?.rating??'—';
  message(s.notice||'');
  drawOnlineSeats(s);
  $('trick-cards').replaceChildren(...s.trick.map(x=>{const e=cardEl(x.card,'trick-card played-seat-'+x.seat);e.title=s.players[x.seat].name;return e}));
  const kittyCards=(s.kitty||[]).map(c=>cardEl(c));
  if(['auction','call'].includes(s.phase)){
    const label=document.createElement('span');label.className='open-label';label.textContent=s.phase==='auction'?'オープン':'捨て札';
    if(kittyCards.length)kittyCards.unshift(label);
    else kittyCards.push(label,cardEl(null,'card-back'),cardEl(null,'card-back'))
  }
  $('kitty-view').replaceChildren(...kittyCards);
  const clock=$('auction-clock');
  if(['prep','call','discard','play'].includes(s.phase)&&s.deadline){clock.classList.remove('hidden');clock.textContent=Math.max(0,Math.ceil((s.deadline-Date.now())/1000))+'秒'}
  else clock.classList.add('hidden');
  drawOnlineHand();drawOnlineControls(s);
  if(s.phase==='call-reveal'){
    if(g.announcedCallRound!==s.round){g.announcedCallRound=s.round;announceCall(g.contract.call,()=>sendGame({type:'confirm-call'}),true)}
  }else{
    if(g.announcedCallRound!==null){
      const d=$('message-dialog'),slot=$('dialog-card');
      if(d.open)d.close();
      slot.classList.add('hidden');slot.replaceChildren();
      $('dialog-eyebrow').classList.remove('hidden');
      $('dialog-eyebrow').textContent='Napoleon';
      $('dialog-ok').textContent='OK';
      g.announcedCallRound=null
    }
    if(['result','round-result'].includes(s.phase))showOnlineResult(s);
    else $('result-panel').classList.add('hidden')
  }
}

function drawOnlineSeats(s){
  const box=$('players-ring');box.replaceChildren();
  const leadSeat=s.phase==='play'&&s.trick?.length?s.trick[0].seat:s.lastTrickWinner;
  s.players.forEach((p,i)=>{
    const e=document.createElement('div');
    e.className='player-seat player-color-'+i+' pos-'+i+(i===g.mySeat?' me':'')+(i===s.active?' active':'')+(leadSeat===i?' trick-winner':'');
    const role=p.approved?'承認済み':p.role||'';
    e.classList.toggle('deputy-seat',role==='副官');
    e.innerHTML='<div class="seat-name">'+p.name+(p.bot?'<span class="com-badge">COM</span>':'')+'</div>'+(leadSeat===i?'<div class="lead-badge" role="img" aria-label="トリック先攻"><i></i></div>':'')+'<div class="seat-role '+(role==='副官'?'deputy-status':'')+'">'+role+'</div>';
    addTakenCards(e,p.taken);
    box.append(e)
  })
}

function drawOnlineHand(){
  const box=$('hand'),scrollLeft=box.scrollLeft,discarding=g.onlineState?.phase==='discard'&&g.mySeat===g.onlineState.active;
  box.classList.toggle('discard-mode',discarding);
  $('game-screen').classList.toggle('discarding',discarding);
  box.replaceChildren();
  (g.privateHand||[]).forEach(c=>{
    const e=cardEl(c,''),legal=(g.onlineLegal||[]).includes(c.id);
    if(g.onlineState?.phase==='discard'&&g.mySeat===g.onlineState.active){
      const protectedCall=g.mySeat===g.onlineState.contract?.nap&&g.onlineState.contract?.call?.id===c.id;
      e.classList.add('playable');
      e.classList.toggle('protected',protectedCall);
      e.classList.toggle('selected',g.onlineDiscard?.has(c.id));
      e.onclick=()=>{
        if(protectedCall){toast('指名札は捨てられません');return}
        g.onlineDiscard=g.onlineDiscard||new Set();
        if(g.onlineDiscard.has(c.id))g.onlineDiscard.delete(c.id);
        else if(g.onlineDiscard.size<2)g.onlineDiscard.add(c.id);
        const selected=g.onlineDiscard.has(c.id);
        e.classList.toggle('selected',selected);
        e.setAttribute('aria-pressed',String(selected));
        const count=$('online-discard-count'),confirm=$('online-discard');
        if(count)count.textContent=g.onlineDiscard.size+' / 2 SELECTED';
        if(confirm)confirm.disabled=g.onlineDiscard.size!==2
      }
    }else if(g.onlineState?.phase==='play'&&g.mySeat===g.onlineState.active&&legal){
      e.classList.add('playable');
      e.classList.toggle('selected',g.onlineSelectedCard===c.id);
      e.onclick=()=>{g.onlineSelectedCard=g.onlineSelectedCard===c.id?null:c.id;drawOnlineHand();drawOnlineControls(g.onlineState)}
    }
    box.append(e)
  });
  if(discarding)box.scrollLeft=scrollLeft;
  $('hand-count').textContent=(g.privateHand||[]).length+'枚'
}

function drawOnlineControls(s){
  ['auction-panel','call-panel','play-panel'].forEach(id=>$(id).classList.add('hidden'));
  if(s.phase==='appeal-offer'||s.phase==='appeal-response'){
    const p=$('auction-panel');p.classList.remove('hidden');
    if(s.phase==='appeal-offer'){
      p.innerHTML=g.mySeat===s.active?'<div class="panel-title">オーラス・アピール</div><div class="micro-copy">4位に各J・マイティの所持を尋ねますか？</div><div class="panel-row"><button id="online-appeal" class="small-action">アピールする</button><button id="online-appeal-skip" class="small-action pass">競りへ進む</button></div>':'<div class="panel-title">5位のアピール選択待ち</div>';
      if(g.mySeat===s.active){$('online-appeal').onclick=()=>sendGame({type:'appeal'});$('online-appeal-skip').onclick=()=>sendGame({type:'skip-appeal'})}
    }else{
      p.innerHTML=g.mySeat===s.active?'<div class="panel-title">5位からアピール</div><div class="micro-copy">所持するJ・マイティを申告するか、申告せず立つか選んでください。</div><div class="panel-row"><button id="online-appeal-disclose" class="small-action">札を申告する</button><button id="online-appeal-stand" class="small-action pass">申告せず立つ</button></div>':'<div class="panel-title">4位のアピール回答待ち</div>';
      if(g.mySeat===s.active){$('online-appeal-disclose').onclick=()=>sendGame({type:'appeal-declare'});$('online-appeal-stand').onclick=()=>sendGame({type:'appeal-stand'})}
    }
    return
  }
  if(s.phase==='auction'){
    const p=$('auction-panel');p.classList.remove('hidden');
    const high=s.auction.high,minBid=s.auction.minBid||13,
      historyPanel=bidHistoryHTML(s.bidHistory,seat=>s.players[seat]?.name||'COM'),
      ruleNote=s.round>=10?'<div class="micro-copy">オールラスト · 最低宣言 '+minBid+' · 得点2倍 · 立ち必須</div>':'';
    if(!s.auction.active.includes(g.mySeat)){p.innerHTML='<div class="panel-title">現在の宣言　<strong>'+(high.num<13?'なし':s.players[high.player].name+' · '+high.num+high.suit)+'</strong></div><div class="micro-copy">承認済み</div>'+ruleNote+historyPanel;return}
    let suit=g.onlineSuit||'♠',bid=Math.max(minBid,g.onlineBid||13);
    g.onlineBid=bid;
    p.innerHTML='<div class="panel-title">現在の宣言　<strong>'+(high.num<13?'なし':s.players[high.player].name+' · '+high.num+high.suit)+'</strong></div>'+ruleNote+'<div class="panel-row">'+['♣','♦','♥','♠','NT'].map(x=>'<button class="suit-choice '+(x===suit?'selected':'')+'" data-osuit="'+x+'">'+x+'</button>').join('')+'</div><div class="panel-row"><button class="small-action" id="online-minus">−</button><span class="bid-number">'+bid+'</span><button class="small-action" id="online-plus">＋</button></div><div class="panel-row"><button class="small-action pass" id="online-approve" '+(high.player===g.mySeat&&s.auction.active.length>1||s.round>=10&&high.num<13?'disabled':'')+'>承認</button><button class="small-action" id="online-bid">宣言する</button></div>'+historyPanel;
    p.querySelectorAll('[data-osuit]').forEach(b=>b.onclick=()=>{g.onlineSuit=b.dataset.osuit;sendGame({type:'auction-activity'});drawOnlineControls(s)});
    $('online-minus').onclick=()=>{g.onlineBid=Math.max(minBid,bid-1);sendGame({type:'auction-activity'});drawOnlineControls(s)};
    $('online-plus').onclick=()=>{g.onlineBid=Math.min(20,bid+1);sendGame({type:'auction-activity'});drawOnlineControls(s)};
    $('online-approve').onclick=()=>{sendGame({type:'auction-activity'});sendGame({type:'approve'})};
    $('online-bid').onclick=()=>{sendGame({type:'auction-activity'});sendGame({type:'bid',num:bid,suit:suit})};
    return
  }
  if(s.phase==='call'&&s.active===g.mySeat){
    const p=$('call-panel');p.classList.remove('hidden');
    let suit=g.onlineSuit||'♠',rank=g.onlineRank||'A';
    const discarded=(s.kitty||[]).some(c=>c.suit===suit&&c.rank===rank);
    p.innerHTML='<div class="panel-title">副官に指名するカード</div><div class="call-card-preview"><div id="online-call-preview"></div><div><div class="micro-copy">今回の指名</div><strong>'+suit+rank+'</strong><div class="call-warning">'+(discarded?'捨て札は指名できません':'自分の手札ならひとり立ち')+'</div></div></div><div class="panel-row">'+['♣','♦','♥','♠'].map(x=>'<button class="suit-choice '+(x===suit?'selected ':'')+(x==='♥'||x==='♦'?'red':'')+'" data-csuit="'+x+'">'+x+'</button>').join('')+'</div><div class="panel-row call-ranks">'+RANKS.map(x=>'<button class="small-action call-rank-choice '+(x===rank?'selected':'')+'" data-crank="'+x+'">'+x+'</button>').join('')+'</div><div class="panel-row"><button id="online-call" class="small-action" '+(discarded?'disabled':'')+'>決定</button></div>';
    p.querySelector('#online-call-preview').replaceChildren(cardEl({suit,rank},'call-preview-card'));
    p.querySelectorAll('[data-csuit]').forEach(b=>b.onclick=()=>{g.onlineSuit=b.dataset.csuit;drawOnlineControls(s)});
    p.querySelectorAll('[data-crank]').forEach(b=>b.onclick=()=>{g.onlineRank=b.dataset.crank;drawOnlineControls(s)});
    $('online-call').onclick=()=>sendGame({type:'call',suit:suit,rank:rank});
    return
  }
  if(s.phase==='discard'&&s.active===g.mySeat){
    const p=$('call-panel');p.classList.remove('hidden');
    p.innerHTML='<div class="panel-title">手札から2枚を選んで捨ててください</div><div class="panel-row"><span class="micro-copy" id="online-discard-count">'+(g.onlineDiscard?.size||0)+' / 2 SELECTED</span><button id="online-discard" class="small-action" '+(g.onlineDiscard?.size===2?'':'disabled')+'>決定</button></div>';
    $('online-discard').onclick=()=>sendGame({type:'discard',cards:Array.from(g.onlineDiscard||[])});
    return
  }
  if(s.phase==='play'&&s.active===g.mySeat){
    const p=$('play-panel');p.classList.remove('hidden');
    const card=(g.privateHand||[]).find(c=>c.id===g.onlineSelectedCard&&(g.onlineLegal||[]).includes(c.id));
    if(!card){g.onlineSelectedCard=null;p.innerHTML='<div class="panel-title">出すカードを手札から選んでください</div>';return}
    p.innerHTML='<div class="panel-title">このカードを出しますか？</div><div class="play-confirm-preview"><div id="online-play-card"></div><span class="micro-copy">選択中</span></div><div class="play-confirm-actions"><button id="cancel-online-play" class="small-action">選び直す</button><button id="confirm-online-play" class="primary-button">出す</button></div>';
    p.querySelector('#online-play-card').replaceChildren(cardEl(card,'play-confirm-card'));
    p.querySelector('#cancel-online-play').onclick=()=>{g.onlineSelectedCard=null;drawOnlineHand();drawOnlineControls(s)};
    p.querySelector('#confirm-online-play').onclick=()=>{const id=g.onlineSelectedCard;if(!id||!(g.onlineLegal||[]).includes(id))return;g.onlineSelectedCard=null;p.innerHTML='<div class="panel-title">カードを送信中…</div>';drawOnlineHand();sendGame({type:'play',card:id})};
    return
  }
}

function showOnlineResult(s){
  const r=$('result-panel'),result=s.result,final=s.phase==='result',
    format=n=>(n>0?'+':'')+(Number.isInteger(n)?n:n.toFixed(1)),
    scores=result.scoreChanges||[];
  r.classList.remove('hidden');
  let content;
  if(final){
    const rating=result.ratingChanges?.[g.mySeat],
      rows=s.players.map((p,i)=>{
        const change=result.ratingChanges?.[i],
          roundDelta=Number((result.scoreChanges||[]).find(x=>x.seat===i)?.delta||0),
          rawArt=Number((result.matchArt||[])[i]||0),
          delta=change?format(change.delta):'—',
          b=change?.breakdown||{},
          roundStr=(b.rounds||[]).map(rr=>(rr.role==='nap'?'N':rr.role==='dep'?'D':'A')+rr.bid+':'+format(rr.delta)).join(' ');
        return '<div class="round-score-row"><span>'+p.name+' · ROUND Δ '+format(roundDelta)+' · MATCH '+format((result.matchScores||[])[i]||0)+' / ART '+format(rawArt)+'</span><strong class="'+(change?.delta<0?'score-down':'score-up')+'">'+(s.mode==='ranked'?'RATE Δ ':'')+delta+'<small>順位 '+(b.rank||'—')+' · '+roundStr+'</small></strong></div>'
      }).join(''),
      summary=s.mode==='ranked'&&rating?'<p>NEW RATE '+rating.rating+' · Δ '+format(rating.delta)+'</p>':'<p>MATCH COMPLETE</p>';
    content='<div class="eyebrow">MATCH COMPLETE</div><h2>RATE BREAKDOWN</h2>'+summary+'<div class="round-score-list">'+rows+'</div><button id="online-home" class="primary-button">BACK TO MENU</button>'
  }else{
    const rows=s.players.map((p,i)=>{
      const score=scores.find(x=>x.seat===i),
        role=score?.role==='ナポレオン'?'NAP':score?.role==='副官'?'DEPUTY':'ALLY';
      return '<div class="round-score-row"><span>'+p.name+' · '+role+'</span><strong>ROUND Δ '+format(score?.delta||0)+'<small>TOTAL '+format((result.matchScores||[])[i]||0)+'</small></strong></div>'
    }).join('');
    content='<div class="eyebrow">ROUND '+String(result.round).padStart(2,'0')+' · RESULT</div><h2>'+(result.made?'NAP TEAM WINS':'ALLIANCE WINS')+'</h2><p>BID '+result.bid+result.suit+' · POINTS '+result.points+(result.solo?' · SOLO':'')+'</p><div class="round-score-list"><div class="micro-copy">ROUND SCORE</div>'+rows+'</div><button id="next-online-round" class="primary-button">'+(result.allLastReplay?'ALL-LAST AGAIN':'NEXT ROUND')+'</button>'
  }
  r.innerHTML=content;
  if(final)$('online-home').onclick=()=>{closeOnline();screen('home-screen')};
  else $('next-online-round').onclick=()=>sendGame({type:'next-round'})
}
