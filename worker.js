export const schema = [
"CREATE TABLE IF NOT EXISTS players (user_id TEXT PRIMARY KEY, username TEXT NOT NULL, player_id TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL, rating INTEGER NOT NULL DEFAULT 1000, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, games INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
"CREATE TABLE IF NOT EXISTS match_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, username TEXT NOT NULL, result TEXT NOT NULL, delta INTEGER NOT NULL, rating_after INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
"CREATE TABLE IF NOT EXISTS player_stats (user_id TEXT PRIMARY KEY, exact_wins INTEGER NOT NULL DEFAULT 0, bold_exact_wins INTEGER NOT NULL DEFAULT 0, solo_wins INTEGER NOT NULL DEFAULT 0, dramatic_plays INTEGER NOT NULL DEFAULT 0)",
"CREATE INDEX IF NOT EXISTS match_history_user ON match_history(user_id, id DESC)",
"CREATE INDEX IF NOT EXISTS players_rating ON players(rating DESC)",
"CREATE TABLE IF NOT EXISTS player_performance (user_id TEXT PRIMARY KEY, declarer_attempts INTEGER NOT NULL DEFAULT 0, declarer_successes INTEGER NOT NULL DEFAULT 0, deputy_attempts INTEGER NOT NULL DEFAULT 0, deputy_successes INTEGER NOT NULL DEFAULT 0)",
"CREATE TABLE IF NOT EXISTS player_precision (user_id TEXT PRIMARY KEY, exact_attempts INTEGER NOT NULL DEFAULT 0, exact_successes INTEGER NOT NULL DEFAULT 0, solo_attempts INTEGER NOT NULL DEFAULT 0, solo_successes INTEGER NOT NULL DEFAULT 0)",
"CREATE TABLE IF NOT EXISTS player_art_rate (user_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, plays INTEGER NOT NULL DEFAULT 0)",
"CREATE TABLE IF NOT EXISTS player_ally_feed (user_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0)",
"CREATE TABLE IF NOT EXISTS player_bold_bid_rate (user_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0)",
"CREATE TABLE IF NOT EXISTS player_match_stats (user_id TEXT PRIMARY KEY, declarer_attempts INTEGER NOT NULL DEFAULT 0, bid_total INTEGER NOT NULL DEFAULT 0, nt_bids INTEGER NOT NULL DEFAULT 0, color_bids INTEGER NOT NULL DEFAULT 0, match_count INTEGER NOT NULL DEFAULT 0, rank_1 INTEGER NOT NULL DEFAULT 0, rank_2 INTEGER NOT NULL DEFAULT 0, rank_3 INTEGER NOT NULL DEFAULT 0, rank_4 INTEGER NOT NULL DEFAULT 0, rank_5 INTEGER NOT NULL DEFAULT 0)",
"CREATE TABLE IF NOT EXISTS ai_weights (id INTEGER PRIMARY KEY DEFAULT 1, weights TEXT NOT NULL, games INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
"CREATE TABLE IF NOT EXISTS ai_strategy_log (id INTEGER PRIMARY KEY AUTOINCREMENT, generation INTEGER NOT NULL, params TEXT NOT NULL, nap_win_rate REAL NOT NULL DEFAULT 0, deputy_win_rate REAL NOT NULL DEFAULT 0, alliance_win_rate REAL NOT NULL DEFAULT 0, overall_win_rate REAL NOT NULL DEFAULT 0, avg_rating_delta REAL NOT NULL DEFAULT 0, matches INTEGER NOT NULL DEFAULT 0, avg_bid REAL NOT NULL DEFAULT 0, parent_id INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
"CREATE INDEX IF NOT EXISTS ai_strategy_gen ON ai_strategy_log(generation DESC, avg_rating_delta DESC)",
"CREATE INDEX IF NOT EXISTS ai_strategy_rate ON ai_strategy_log(avg_rating_delta DESC)",
"CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
"CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)"
].join(";");
const SUITS=["♣","♦","♥","♠"],RANKS=["2","3","4","5","6","7","8","9","10","J","Q","K","A"],SV={"♣":1,"♦":2,"♥":3,"♠":4,NT:5};
const CALIBRATION={13:0.82,14:0.75,15:0.65,16:0.55,17:0.42,18:0.30,19:0.18,20:0.08};
const queues={ranked:[]},rankedUsers=new Map(),conns=new Map(),friendRooms=new Map(),matches=new Map(),connMatch=new Map();
function sendSafe(conn,message){if(!conn)return false;try{conn.send(message);return true}catch(error){console.warn("room send failed",conn.id,error);try{conn.close(4004,"Send failed")}catch{}return false}}
const hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,"0")).join("");const unhex=s=>new Uint8Array((s.match(/.{2}/g)||[]).map(x=>parseInt(x,16)));
async function hashPassword(password,salt){const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveBits"]);return hex(await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations:100000,hash:"SHA-256"},key,256))}
const response=(data,status=200)=>Response.json(data,{status}),identity=req=>({id:req.headers.get("x-websim-user-id"),username:req.headers.get("x-websim-username")||"player",anonymous:req.headers.get("x-websim-user-is-anonymous")==="true"}),validId=s=>typeof s==="string"&&/^[a-zA-Z0-9_-]{3,20}$/.test(s),signed=req=>{const u=identity(req);return u.id&&!u.anonymous?u:null};
function metricRank(db,table,successColumn,attemptColumn,successes,attempts){if(!attempts)return Promise.resolve(null);return db.prepare("SELECT COUNT(*) AS ahead FROM "+table+" WHERE "+attemptColumn+">0 AND "+successColumn+"*1.0/"+attemptColumn+">?").bind(successes/attempts).first().then(row=>row.ahead+1)}

// ===== AI自己対戦エンジン =====
const PARAM_BOUNDS={
  bidThreshold:[2.0,6.0],riskTolerance:[0.1,1.0],leadAggression:[0.2,1.0],
  followAggression:[0.1,1.0],trumpBonus:[0.2,1.5],mightyBonus:[1.0,3.0],
  safeAceWeight:[0.0,1.0],roleCardPreservation:[0.0,1.0],deputyFeedBias:[0.0,1.0]
};
function defaultStrategy(){return{bidThreshold:4.0,riskTolerance:0.5,leadAggression:0.6,followAggression:0.4,trumpBonus:0.6,mightyBonus:2.0,safeAceWeight:0.7,roleCardPreservation:0.6,deputyFeedBias:0.5}}
function mutateStrategy(base,rate=0.15){const out={...base};for(const[k,[lo,hi]]of Object.entries(PARAM_BOUNDS)){if(Math.random()<rate){const step=(hi-lo)*0.08;out[k]=Math.max(lo,Math.min(hi,out[k]+(Math.random()-0.5)*step*2))}}return out}
function simDeck(){const d=[];for(const s of SUITS)for(const r of RANKS)d.push({suit:s,rank:r,id:s+r});for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]]}return d}
function simSort(h){h.sort((a,b)=>SV[b.suit]-SV[a.suit]||RANKS.indexOf(b.rank)-RANKS.indexOf(a.rank))}
function simVal(c,trump){return RANKS.indexOf(c.rank)+(c.suit===trump?3:0)}
function simLow(cards,trump){return cards.slice().sort((a,b)=>simVal(a,trump)-simVal(b,trump))[0]}
function simPower(card,trick,trump){
  const led=trick[0].card.suit,allSame=trick.every(x=>x.card.suit===led),mightyIn=trick.some(x=>x.card.id==='♠A');
  if(mightyIn&&card.id==='♥Q')return 10000;
  if(card.id==='♠A')return 9000;
  if(trump!=='NT'&&card.rank==='J'&&card.suit===trump)return 8000;
  const blk=s=>s==='♣'||s==='♠';
  if(trump!=='NT'&&card.rank==='J'&&card.suit!==trump&&blk(card.suit)===blk(trump))return 7000;
  if(allSame&&card.suit===led&&card.rank==='2')return 6000;
  if(trump!=='NT'&&card.suit===trump)return 5000+RANKS.indexOf(card.rank);
  if(card.suit===led)return 3000+RANKS.indexOf(card.rank);
  return 1000+RANKS.indexOf(card.rank);
}
function simWin(trick,trump){let best=trick[0],bp=simPower(trick[0].card,trick,trump);for(let i=1;i<trick.length;i++){const p=simPower(trick[i].card,trick,trump);if(p>bp){best=trick[i];bp=p}}return best}
function simLegal(hand,trick){if(!trick.length)return hand;const led=trick[0].card.suit,follow=hand.filter(c=>c.suit===led);return follow.length?follow:hand}
function simSuitVal(hand,suit){const w={'10':1,J:1.8,Q:2.6,K:3.5,A:4.7};const cards=hand.filter(c=>c.suit===suit);return cards.reduce((n,c)=>n+(w[c.rank]||0),0)+Math.max(0,cards.length-3)*0.75}
function simBestSuit(hand){return SUITS.slice().sort((a,b)=>simSuitVal(hand,b)-simSuitVal(hand,a))[0]}
function simStrength(hand){return hand.reduce((n,c)=>n+(RANKS.indexOf(c.rank)>9?1.25:RANKS.indexOf(c.rank)>7?0.45:0)+(c.rank==='A'?0.35:0),0)+simSuitVal(hand,simBestSuit(hand))*0.3}
function simAuction(hands,params,scores){
  const ranked=scores.map((s,i)=>({s,i})).sort((a,b)=>a.s-b.s);
  const cutoff=ranked[1]?.s??0;
  const eligible=scores.map((s,i)=>({s,i})).filter(x=>x.s<=cutoff).map(x=>x.i);
  const active=eligible.length?eligible:[0,1,2,3,4];
  const minBid=13;let best={num:12,suit:'',player:-1};
  for(let r=0;r<2;r++)for(const s of active){
    const p=params[s],str=simStrength(hands[s]);
    const cap=13+Math.min(9,Math.floor(str/1.3));
    if(str>p.bidThreshold&&cap>=minBid&&Math.random()<Math.min(1,(str-p.bidThreshold)/3)){
      const num=Math.max(minBid,13+Math.min(9,Math.floor((str-2)/1.7)));
      if(num>best.num)best={num,suit:simBestSuit(hands[s]),player:s};
    }
  }
  if(best.player<0){const bottom=scores.indexOf(Math.min(...scores));best={num:minBid,suit:simBestSuit(hands[bottom]),player:bottom}}
  return best;
}
function simChooseDiscard(hand,trump){return hand.slice().sort((a,b)=>simVal(a,trump)-simVal(b,trump)).slice(0,2)}
function simChooseCall(hand,discard,trump){const used=new Set([...hand,...discard].map(c=>c.id));const cands=[];for(const s of SUITS)for(const r of RANKS)if(!used.has(s+r))cands.push({suit:s,rank:r,id:s+r});if(!cands.length)return{suit:'♠',rank:'A',id:'♠A'};const score=c=>(c.rank==='A'?10:c.rank==='K'?6:c.rank==='Q'?3:0)-hand.filter(x=>x.suit===c.suit).length*1.5;cands.sort((a,b)=>score(b)-score(a));return cands[0]}
function simSafeAce(suit,seat,played,voids,contract,trump){if(suit==='♠')return true;if(played.some(c=>c.id===suit+'2'))return true;for(let s=0;s<5;s++){if(s===seat)continue;if(voids[s]&&voids[s][suit])return false}if(trump!=='NT'&&trump!==suit){for(let s=0;s<5;s++){if(s===seat)continue;const ally=contract.revealed?(s===contract.nap||s===contract.deputy):s===contract.nap;if(ally)continue;if(voids[s]&&voids[s][suit])return false}}return true}
function simBotPlay(seat,legal,trick,contract,trump,revealed,p,played,voids){
  if(!trick.length){
    const safeAces=legal.filter(c=>c.rank==='A'&&simSafeAce(c.suit,seat,played,voids,contract,trump));
    if(safeAces.length&&Math.random()<p.leadAggression)return safeAces[0];
    const nonAce=legal.filter(c=>c.rank!=='A');
    if(nonAce.length&&p.safeAceWeight>Math.random())return simLow(nonAce,trump);
    return simLow(legal,trump);
  }
  const cur=simWin(trick,trump);
  const curSide=cur.seat===contract.nap||(revealed&&cur.seat===contract.deputy&&!contract.solo);
  const mySide=seat===contract.nap||(revealed&&seat===contract.deputy&&!contract.solo);
  const pointInTrick=trick.some(e=>['10','J','Q','K','A'].includes(e.card.rank));
  if(mySide){
    if(curSide)return simLow(legal,trump);
    const wins=legal.filter(c=>simWin([...trick,{seat,card:c}],trump).seat===seat);
    if(wins.length&&(pointInTrick||trick.length===4))return simLow(wins,trump);
    return simLow(legal,trump);
  }else{
    if(!curSide){const wins=legal.filter(c=>simWin([...trick,{seat,card:c}],trump).seat===seat);if(wins.length)return simLow(wins,trump)}
    return simLow(legal,trump);
  }
}
function simDeputyPlay(seat,legal,trick,contract,trump,p){
  const isRole=c=>c.id===contract.call.id||c.id==='♠A'||(trump!=='NT'&&c.rank==='J'&&(c.suit===trump||((c.suit==='♣'||c.suit==='♠')===(trump==='♣'||trump==='♠'))));
  if(trick.length&&trick[0].seat===contract.nap){
    const cur=simWin(trick,trump);
    const allyWin=cur.seat===contract.nap||cur.seat===contract.deputy;
    if(allyWin){const nonRole=legal.filter(c=>!isRole(c));if(nonRole.length&&Math.random()<p.roleCardPreservation)return simLow(nonRole,trump)}
  }
  return simLow(legal,trump);
}
function simRound(hands,round,matchScores,params){
  const d=simDeck();
  for(let i=0;i<5;i++){hands[i]=d.splice(0,10);simSort(hands[i])}
  const kitty=d.splice(0,2);
  const auc=simAuction(hands,params,matchScores);
  const nap=auc.player,trump=auc.suit,num=auc.num;
  hands[nap].push(...kitty);simSort(hands[nap]);
  const discard=simChooseDiscard(hands[nap],trump);
  hands[nap]=hands[nap].filter(c=>!discard.some(x=>x.id===c.id));
  const kittyPts=discard.filter(c=>['10','J','Q','K','A'].includes(c.rank)).length;
  const call=simChooseCall(hands[nap],discard,trump);
  let deputy=-1;
  for(let i=0;i<5;i++){if(i===nap)continue;if(hands[i].some(c=>c.id===call.id)){deputy=i;break}}
  const solo=deputy<0;
  if(solo)deputy=nap;
  const roundPts=[0,0,0,0,0];
  roundPts[nap]+=kittyPts;
  const played=[],voids=[{},{},{},{},{}];
  let revealed=solo,active=nap,trickNo=0;
  while(trickNo<10&&hands.some(h=>h.length>0)){
    const trick=[];
    for(let i=0;i<5;i++){
      const seat=(active+i)%5,hand=hands[seat];
      if(!hand.length)break;
      const legal=simLegal(hand,trick);
      let chosen;
      if(!solo&&revealed&&seat===deputy)chosen=simDeputyPlay(seat,legal,trick,{nap,deputy,call,solo,revealed},trump,params[seat]);
      else chosen=simBotPlay(seat,legal,trick,{nap,deputy,call,solo,revealed},trump,revealed,params[seat],played,voids);
      if(trick.length&&chosen.suit!==trick[0].card.suit){if(!voids[seat])voids[seat]={};voids[seat][trick[0].card.suit]=true}
      played.push({suit:chosen.suit,rank:chosen.rank,id:chosen.id});
      if(!revealed&&chosen.id===call.id)revealed=true;
      trick.push({seat,card:chosen});
      hands[seat]=hand.filter(c=>c.id!==chosen.id);
    }
    if(trick.length<5)break;
    const w=simWin(trick,trump);
    const taken=trick.filter(e=>['10','J','Q','K','A'].includes(e.card.rank)).length;
    roundPts[w.seat]+=taken;
    active=w.seat;
    trickNo++;
    const napPts=roundPts[nap]+(solo?0:roundPts[deputy]);
    const allyPts=roundPts.reduce((n,p,i)=>n+(i!==nap&&(solo||i!==deputy)?p:0),0);
    if(allyPts>20-num||(napPts>=num&&(num===20||allyPts>=1)))break;
  }
  const napPts=roundPts[nap]+(solo?0:roundPts[deputy]);
  const made=napPts>=num&&(num===20||napPts<20);
  const mult=round>=10?2:1;
  const unit=Math.max(0,num-12)*mult;
  const sign=made?1:-1;
  const sc=[0,0,0,0,0];
  sc[nap]=sign*unit*(solo?4:2);
  if(solo){for(let i=0;i<5;i++)if(i!==nap)sc[i]=-sign*unit}
  else{sc[deputy]=sign*unit;for(let i=0;i<5;i++)if(i!==nap&&i!==deputy)sc[i]=-sign*unit}
  for(let i=0;i<5;i++)matchScores[i]+=sc[i];
  const roundArt=[0,0,0,0,0];
  if(made&&napPts===num){roundArt[nap]+=2;if(!solo)roundArt[deputy]+=1;if(num>=15){roundArt[nap]+=2;if(!solo)roundArt[deputy]+=1}}
  if(solo)roundArt[nap]+=made?4:2;
  if(!made&&!solo&&num-napPts>=3){roundArt[nap]-=2;roundArt[deputy]-=1}
  return{round,nap,deputy,num,suit:trump,solo,made,napPts,scoreChanges:sc,takenPoints:roundPts,roundArt,contract:{nap,deputy,num,suit:trump,solo,points:napPts,napWin:made,revealTrickNo:null,takenPoints:roundPts}};
}
function simMatchDetailed(paramsBySeat){
  const hands=[[],[],[],[],[]];
  const matchScores=[0,0,0,0,0];
  const matchArt=[0,0,0,0,0];
  const rounds=[];
  for(let r=1;r<=10;r++){try{const res=simRound(hands,r,matchScores,paramsBySeat);rounds.push(res);for(let i=0;i<5;i++)matchArt[i]+=res.roundArt[i]}catch(e){break}}
  return{matchScores,matchArt,rounds,contracts:rounds.map(r=>r.contract)};
}
function buildMatchStats(contracts){
  const stats=Array.from({length:5},()=>({declarerAttempts:0,declarerSuccesses:0,exactAttempts:0,exactSuccesses:0,boldAttempts:0,boldSuccesses:0,soloAttempts:0,soloSuccesses:0,deputyAttempts:0,deputySuccesses:0,bidTotal:0}));
  for(const c of contracts){
    stats[c.nap].declarerAttempts++;stats[c.nap].bidTotal+=c.num;
    if(c.napWin)stats[c.nap].declarerSuccesses++;
    stats[c.nap].exactAttempts++;
    if(c.napWin&&c.points===c.num)stats[c.nap].exactSuccesses++;
    if(c.num>=15){stats[c.nap].boldAttempts++;if(c.napWin&&c.points===c.num)stats[c.nap].boldSuccesses++}
    if(c.solo){stats[c.nap].soloAttempts++;if(c.napWin)stats[c.nap].soloSuccesses++}
    else if(c.deputy!==c.nap){stats[c.deputy].deputyAttempts++;if(c.napWin)stats[c.deputy].deputySuccesses++}
  }
  return stats;
}
function simRatingDeltas(matchScores,matchArt,contracts){
  const stats=buildMatchStats(contracts);
  const meanArt=matchArt.reduce((n,x)=>n+x,0)/5;
  return matchScores.map((score,seat)=>{
    let delta=0;
    for(const c of contracts){
      const p=CALIBRATION[Math.min(20,Math.max(13,c.num))]??0.5;
      const diff=c.num-12;
      const actual=c.napWin?1:0;
      let roundDelta=0;
      if(seat===c.nap){
        roundDelta=(actual-p)*diff*8;
        if(c.napWin&&c.points>c.num)roundDelta-=(c.points-c.num)*0.3;
        if(c.solo)roundDelta*=1.5;
      }else if(!c.solo&&seat===c.deputy){
        roundDelta=(actual-p)*diff*3.2;
        if(c.napWin&&c.revealTrickNo!=null)roundDelta+=Math.max(0,c.revealTrickNo-3)*0.3;
      }else{
        const pts=(c.takenPoints&&c.takenPoints[seat])||0;
        roundDelta=(pts-4.4)*0.4;
        roundDelta+=c.napWin?-0.5:+0.5;
      }
      delta+=roundDelta;
    }
    delta+=(matchArt[seat]-meanArt)*0.3;
    const rank=1+matchScores.filter(x=>x>score).length;
    if(rank===1)delta+=0.5;else if(rank===5)delta-=0.5;
    delta-=0.05*contracts.length;
    return{delta:Math.round(delta*10)/10};
  });
}

// ★修正：実行直前に必ずテーブルの存在を確認・作成する
async function runSelfPlayBatch(env,matchCount=1000){
  try{
    await env.DB.batch(schema.map(sql=>env.DB.prepare(sql)));
  }catch(e){
    console.error("DB schema check failed in runSelfPlayBatch",e);
  }
  let existing=[];
  try{const{results}=await env.DB.prepare("SELECT * FROM ai_strategy_log ORDER BY avg_rating_delta DESC LIMIT 5").all();existing=results}catch{}
  const baseline=existing.length?existing.map(r=>JSON.parse(r.params)):[defaultStrategy()];
  const generation=existing.length?Math.max(...existing.map(r=>r.generation||0))+1:1;
  const challengers=baseline.map(b=>mutateStrategy(b,0.2));
  while(challengers.length<5)challengers.push(mutateStrategy(baseline[0]||defaultStrategy(),0.15));
  const pool=[...baseline.slice(0,3),...challengers.slice(0,5)];
  const stats=pool.map(()=>({n:0,totalRating:0,wins:0,napN:0,napW:0,depN:0,depW:0,alN:0,alW:0,bidSum:0,bidN:0}));
  for(let i=0;i<matchCount;i++){
    const seatIdx=[],seatParams=[];
    for(let s=0;s<5;s++){const idx=Math.floor(Math.random()*pool.length);seatIdx.push(idx);seatParams.push(pool[idx])}
    const{matchScores,matchArt,contracts}=simMatchDetailed(seatParams);
    const ratingDeltas=simRatingDeltas(matchScores,matchArt,contracts);
    const max=Math.max(...matchScores);
    for(let s=0;s<5;s++){
      const st=stats[seatIdx[s]];
      st.n++;st.totalRating+=ratingDeltas[s].delta;
      if(matchScores[s]===max)st.wins++;
      for(const c of contracts){
        if(c.nap===s){st.napN++;st.bidSum+=c.num;st.bidN++;if(c.napWin)st.napW++}
        else if(!c.solo&&c.deputy===s){st.depN++;if(c.napWin)st.depW++}
        else{st.alN++;if(!c.napWin)st.alW++}
      }
    }
  }
  const statements=[];
  const parentIds=existing.slice(0,3).map(r=>r.id);
  for(let i=0;i<pool.length;i++){
    const st=stats[i];
    if(!st.n)continue;
    const avgRating=st.totalRating/st.n;
    const napRate=st.napN?st.napW/st.napN:0;
    const depRate=st.depN?st.depW/st.depN:0;
    const alRate=st.alN?st.alW/st.alN:0;
    const overall=st.wins/st.n;
    const avgBid=st.bidN?st.bidSum/st.bidN:0;
    statements.push(env.DB.prepare("INSERT INTO ai_strategy_log(generation,params,nap_win_rate,deputy_win_rate,alliance_win_rate,overall_win_rate,avg_rating_delta,matches,avg_bid,parent_id) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(generation,JSON.stringify(pool[i]),napRate,depRate,alRate,overall,avgRating,st.n,avgBid,parentIds[i]||null));
  }
  if(statements.length)await env.DB.batch(statements);
  try{
    const top=await env.DB.prepare("SELECT params FROM ai_strategy_log ORDER BY avg_rating_delta DESC, id DESC LIMIT 1").first();
    if(top){
      await env.DB.prepare("INSERT INTO ai_weights(id,weights,games,updated_at) VALUES(1,?,1,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET weights=excluded.weights, games=games+1, updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify(JSON.parse(top.params))).run();
    }
  }catch(e){console.error("failed to update ai_weights",e)}
  try{await env.DB.prepare("DELETE FROM ai_strategy_log WHERE id NOT IN (SELECT id FROM ai_strategy_log ORDER BY avg_rating_delta DESC, id DESC LIMIT 50)").run()}catch{}
  return{generation,size:pool.length,matches:matchCount};
}
function generateInsights(strategies){
  if(!strategies.length)return[];
  const base=defaultStrategy();
  const top={...base,...JSON.parse(strategies[0].params||'{}')};
  const names={bidThreshold:'立ち強度',riskTolerance:'リスク許容',leadAggression:'リード積極性',followAggression:'フォロー積極性',trumpBonus:'切り札評価',mightyBonus:'マイティ評価',safeAceWeight:'A温存',roleCardPreservation:'役札温存',deputyFeedBias:'副官の絵札回し'};
  const deltas=Object.entries(PARAM_BOUNDS).map(([k,[lo,hi]])=>{const cur=top[k]??base[k];return{key:k,name:names[k]||k,delta:(cur-base[k])/(hi-lo),cur,baseVal:base[k]}}).sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta));
  const insights=deltas.slice(0,3).map(d=>({title:`${d.name}（${d.delta>0?'増加':'減少'}）`,detail:`初期値 ${d.baseVal.toFixed(2)} → ${d.cur.toFixed(2)}。改善に寄与した主要パラメータ。`}));
  insights.push({title:'役割別勝率（最上位戦略）',detail:`ナポレオン時 ${(Number(strategies[0].nap_win_rate||0)*100).toFixed(1)}% / 副官時 ${(Number(strategies[0].deputy_win_rate||0)*100).toFixed(1)}% / 連合軍時 ${(Number(strategies[0].alliance_win_rate||0)*100).toFixed(1)}%`});
  insights.push({title:'平均レート上昇',detail:`1局あたり +${Number(strategies[0].avg_rating_delta||0).toFixed(2)} pt（${strategies[0].matches}試合の平均）。`});
  return insights;
}

export default {
  async scheduled(event,env,ctx){
    if(!globalThis.__dbInitialized){
      try{await env.DB.batch(schema.map(sql=>env.DB.prepare(sql)));globalThis.__dbInitialized=true}
      catch(e){console.error("DB init failed on cron",e)}
    }
    ctx.waitUntil(runSelfPlayBatch(env,1000).catch(e=>console.error("scheduled self-play failed",e)));
    ctx.waitUntil(env.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(Date.now()).run().catch(e=>console.error("session cleanup failed",e)));
  },
  async fetch(request,env){
    if(!globalThis.__dbInitialized){
      try{await env.DB.batch(schema.map(sql=>env.DB.prepare(sql)));globalThis.__dbInitialized=true}
      catch(e){console.error("DB init failed",e)}
    }
    const url=new URL(request.url);
    if(request.method==="POST"&&(url.pathname==="/api/account/register"||url.pathname==="/api/account/login")){
      let body;try{body=await request.json()}catch{return response({error:"入力を確認してください"},400)}
      const id=String(body.id||"").trim(),pass=String(body.password||"");
      if(!validId(id))return response({error:"IDは英数字・_・-の3〜20文字です"},400);
      if(pass.length<8||pass.length>128)return response({error:"パスワードは8〜128文字です"},400);
      const isRegister=url.pathname.endsWith("register");
      let userId=null;
      if(isRegister){
        userId=crypto.randomUUID();
        const salt=crypto.getRandomValues(new Uint8Array(16)),digest=await hashPassword(pass,salt);
        try{
          await env.DB.prepare("INSERT INTO players(user_id,username,player_id,salt,password_hash) VALUES(?,?,?,?,?)").bind(userId,id,id,hex(salt),digest).run();
        }catch{
          return response({error:"そのIDはすでに使われています"},409);
        }
      }else{
        const p=await env.DB.prepare("SELECT user_id,salt,password_hash FROM players WHERE player_id=?").bind(id).first();
        if(!p||await hashPassword(pass,unhex(p.salt))!==p.password_hash)return response({error:"IDまたはパスワードが違います"},401);
        userId=p.user_id;
      }
      await env.DB.batch([
        env.DB.prepare("INSERT OR IGNORE INTO player_stats(user_id) VALUES(?)").bind(userId),
        env.DB.prepare("INSERT OR IGNORE INTO player_performance(user_id) VALUES(?)").bind(userId),
        env.DB.prepare("INSERT OR IGNORE INTO player_precision(user_id) VALUES(?)").bind(userId),
        env.DB.prepare("INSERT OR IGNORE INTO player_art_rate(user_id) VALUES(?)").bind(userId),
        env.DB.prepare("INSERT OR IGNORE INTO player_ally_feed(user_id) VALUES(?)").bind(userId),
        env.DB.prepare("INSERT OR IGNORE INTO player_bold_bid_rate(user_id) VALUES(?)").bind(userId)
      ]);
      const token=hex(crypto.getRandomValues(new Uint8Array(32)));
      const expiresAt=Date.now()+30*24*3600*1000;
      await env.DB.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)").bind(token,userId,expiresAt).run();
      const player=await env.DB.prepare("SELECT player_id AS id,rating,wins,losses,games FROM players WHERE user_id=?").bind(userId).first();
      return response({...player,sessionToken:token});
    }
    if(request.method==="GET"&&url.pathname==="/api/account/me"){
      const token=request.headers.get("x-session-token");
      let userId=null;
      if(token){
        const sess=await env.DB.prepare("SELECT user_id FROM sessions WHERE token=? AND expires_at>?").bind(token,Date.now()).first();
        if(sess)userId=sess.user_id;
      }
      if(!userId){const who=signed(request);if(who)userId=who.id}
      if(!userId)return response({error:"認証情報が必要です"},401);
      const p=await env.DB.prepare("SELECT player_id AS id,username,rating,wins,losses,games FROM players WHERE user_id=?").bind(userId).first();
      if(!p)return response({error:"プレイヤー登録がありません"},404);
      const [performanceRow,precisionRow,artRateRow,allyFeedRow,boldBidRow,historyPage,matchStatsRow]=await Promise.all([
        env.DB.prepare("SELECT declarer_attempts,declarer_successes,deputy_attempts,deputy_successes FROM player_performance WHERE user_id=?").bind(userId).first(),
        env.DB.prepare("SELECT exact_attempts,exact_successes,solo_attempts,solo_successes FROM player_precision WHERE user_id=?").bind(userId).first(),
        env.DB.prepare("SELECT attempts,plays FROM player_art_rate WHERE user_id=?").bind(userId).first(),
        env.DB.prepare("SELECT attempts,successes FROM player_ally_feed WHERE user_id=?").bind(userId).first(),
        env.DB.prepare("SELECT attempts,successes FROM player_bold_bid_rate WHERE user_id=?").bind(userId).first(),
        env.DB.prepare("SELECT result,delta,rating_after,created_at FROM match_history WHERE user_id=? ORDER BY id DESC LIMIT 50").bind(userId).all(),
        env.DB.prepare("SELECT declarer_attempts,bid_total,nt_bids,color_bids,match_count,rank_1,rank_2,rank_3,rank_4,rank_5 FROM player_match_stats WHERE user_id=?").bind(userId).first()
      ]);
      const matchStats=matchStatsRow||{declarer_attempts:0,bid_total:0,nt_bids:0,color_bids:0,match_count:0,rank_1:0,rank_2:0,rank_3:0,rank_4:0,rank_5:0};
      const performance=performanceRow||{declarer_attempts:0,declarer_successes:0,deputy_attempts:0,deputy_successes:0};
      const precision=precisionRow||{exact_attempts:0,exact_successes:0,solo_attempts:0,solo_successes:0};
      const artRate=artRateRow||{attempts:0,plays:0};
      const allyFeed=allyFeedRow||{attempts:0,successes:0};
      const boldBid=boldBidRow||{attempts:0,successes:0};
      const [ratingRank,performanceRankValues]=await Promise.all([
        env.DB.prepare("SELECT COUNT(*) AS ahead FROM players WHERE rating>?").bind(p.rating).first(),
        Promise.all([
          metricRank(env.DB,"player_performance","declarer_successes","declarer_attempts",performance.declarer_successes,performance.declarer_attempts),
          metricRank(env.DB,"player_performance","deputy_successes","deputy_attempts",performance.deputy_successes,performance.deputy_attempts),
          metricRank(env.DB,"player_precision","exact_successes","exact_attempts",precision.exact_successes,precision.exact_attempts),
          metricRank(env.DB,"player_precision","solo_successes","solo_attempts",precision.solo_successes,precision.solo_attempts),
          metricRank(env.DB,"player_art_rate","plays","attempts",artRate.plays,artRate.attempts),
          metricRank(env.DB,"player_ally_feed","successes","attempts",allyFeed.successes,allyFeed.attempts),
          metricRank(env.DB,"player_bold_bid_rate","successes","attempts",boldBid.successes,boldBid.attempts)
        ])
      ]);
      const performanceRanks={bid:performanceRankValues[0],deputy:performanceRankValues[1],exact:performanceRankValues[2],solo:performanceRankValues[3],artPlay:performanceRankValues[4],allyFeed:performanceRankValues[5],boldBid:performanceRankValues[6]};
      return response({...p,performance,precision,artRate,allyFeed,boldBid,ranks:{rating:ratingRank.ahead+1},performanceRanks,matchStats,history:historyPage.results});
    }
    if(request.method==="GET"&&url.pathname==="/api/rating/top"){const{results}=await env.DB.prepare("SELECT player_id AS id,username,rating,wins,losses,games FROM players ORDER BY rating DESC,games DESC LIMIT 50").all();return response(results)}
    if(request.method==="GET"&&url.pathname==="/api/ai/weights"){try{const w=await env.DB.prepare("SELECT weights,games FROM ai_weights WHERE id=1").first();return response(w||{weights:'{}',games:0})}catch(e){return response({weights:'{}',games:0})}}
    if(request.method==="POST"&&url.pathname==="/api/ai/report"){
      let body;try{body=await request.json()}catch{return response({error:"invalid"},400)}
      try{
        const w=await env.DB.prepare("SELECT weights,games FROM ai_weights WHERE id=1").first();
        const weights=JSON.parse(w?.weights||'{}');const lr=0.005;
        if(body.napoleonWon){weights.bidThreshold=Math.max(2.0,(weights.bidThreshold||4.0)-lr);weights.leadAggression=Math.min(1.0,(weights.leadAggression||0.6)+lr);weights.followAggression=Math.min(1.0,(weights.followAggression||0.4)+lr*0.5)}
        else{weights.bidThreshold=Math.min(6.0,(weights.bidThreshold||4.0)+lr);weights.leadAggression=Math.max(0.2,(weights.leadAggression||0.6)-lr);weights.followAggression=Math.max(0.1,(weights.followAggression||0.4)-lr*0.5)}
        if(body.exactWins>1){weights.riskTolerance=Math.min(1.0,(weights.riskTolerance||0.5)+lr*0.3);weights.trumpBonus=Math.min(1.5,(weights.trumpBonus||0.6)+lr*0.2)}
        if(body.lastPlacePenalty>0){weights.riskTolerance=Math.max(0.1,(weights.riskTolerance||0.5)-lr*0.3)}
        await env.DB.prepare("UPDATE ai_weights SET weights=?,games=games+1,updated_at=CURRENT_TIMESTAMP WHERE id=1").bind(JSON.stringify(weights)).run();
        return response({ok:true,weights,games:(w?.games||0)+1});
      }catch(e){return response({error:"save failed"},500)}
    }
    if(request.method==="POST"&&url.pathname==="/api/ai/run-selfplay"){try{const body=await request.json().catch(()=>({}));const count=Math.max(1,Math.min(5000,Number(body.matches)||1000));const result=await runSelfPlayBatch(env,count);return response({ok:true,...result})}catch(e){return response({error:"self-play failed: "+(e.message||"unknown")},500)}}
    if(request.method==="GET"&&url.pathname==="/api/ai/strategies"){try{const limit=Math.max(1,Math.min(50,Number(url.searchParams.get("limit"))||10));const{results}=await env.DB.prepare("SELECT * FROM ai_strategy_log ORDER BY avg_rating_delta DESC, id DESC LIMIT ?").bind(limit).all();return response(results)}catch(e){return response({error:"load failed"},500)}}
    if(request.method==="GET"&&url.pathname==="/api/ai/insights"){try{const{results}=await env.DB.prepare("SELECT * FROM ai_strategy_log ORDER BY avg_rating_delta DESC, id DESC LIMIT 5").all();return response({insights:generateInsights(results),strategies:results})}catch(e){return response({error:"load failed"},500)}}
    if(request.method==="GET"&&url.pathname==="/api/ai/generations"){try{const{results}=await env.DB.prepare("SELECT generation, MAX(overall_win_rate) AS best, MAX(avg_rating_delta) AS best_delta, MAX(nap_win_rate) AS nap, MAX(deputy_win_rate) AS dep, MAX(alliance_win_rate) AS ally, COUNT(*) AS count FROM ai_strategy_log GROUP BY generation ORDER BY generation DESC LIMIT 30").all();return response(results.reverse())}catch(e){return response({error:"load failed"},500)}}
    if(request.method==="GET"&&url.pathname==="/api/ai/top-strategy"){try{const row=await env.DB.prepare("SELECT params,avg_rating_delta,generation FROM ai_strategy_log ORDER BY avg_rating_delta DESC, id DESC LIMIT 1").first();if(!row)return response({strategy:defaultStrategy(),source:'default'});return response({strategy:JSON.parse(row.params),avgRating:row.avg_rating_delta,generation:row.generation,source:'learned'})}catch(e){return response({strategy:defaultStrategy(),source:'default'})}}
    return new Response("Not found",{status:404});
  }
};
function makeCode(){return Math.random().toString(36).slice(2,7).toUpperCase()}
function shuffledDeck(){const d=[];for(const s of SUITS)for(const r of RANKS)d.push({suit:s,rank:r,id:s+r});for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]]}return d}
function sortHand(h){h.sort((a,b)=>SV[b.suit]-SV[a.suit]||RANKS.indexOf(b.rank)-RANKS.indexOf(a.rank))}
function botSuitValue(hand,suit){const weight={"10":1,J:1.8,Q:2.6,K:3.5,A:4.7},cards=hand.filter(c=>c.suit===suit);return cards.reduce((n,c)=>n+(weight[c.rank]||0),0)+Math.max(0,cards.length-3)*.75}
function strongestBotSuit(hand,suits=SUITS){return suits.slice().sort((a,b)=>botSuitValue(hand,b)-botSuitValue(hand,a)||SV[b]-SV[a])[0]}
function chooseBotCall(hand,discard,trump,level,bid){const options=shuffledDeck().filter(c=>!hand.some(x=>x.id===c.id)&&!discard.some(x=>x.id===c.id));if(level===1)return options[0];const score=c=>RANKS.indexOf(c.rank)*4+(c.suit===trump?2:0)-hand.filter(x=>x.suit===c.suit).length*(level===3?1:.65),soloPower=hand.reduce((n,c)=>n+(c.rank==="A"?2:c.rank==="K"?1.2:c.rank==="Q"?.7:0)+((trump!=="NT"&&c.suit===trump)?0.5:0),0);if(level===3&&bid>=17&&soloPower>=8)return hand.slice().sort((a,b)=>score(b)-score(a))[0];return options.sort((a,b)=>score(b)-score(a)||SV[b.suit]-SV[a.suit])[0]}
async function getProfile(env,conn){
  const userId=conn.authUserId||conn.userId;
  if(!userId)return{rating:1000,games:0,username:conn.username||"ゲスト",playerId:conn.username||"ゲスト"};
  const p=await env.DB.prepare("SELECT player_id,username,rating,games FROM players WHERE user_id=?").bind(userId).first();
  return p?{rating:p.rating,games:p.games,username:p.username,playerId:p.player_id,userId}:{rating:1000,games:null,username:conn.username||"player",playerId:conn.username||"player",userId:null};
}
function beginMatch(kind,roomCode,group,room){const id=Math.random().toString(36).slice(2,12).toUpperCase(),seats=group.map(x=>({connId:x.id,originalConnId:x.id,player:x.player,bot:false,hand:[],points:0,taken:[],roundTaken:[],roundPoints:0}));while(seats.length<5)seats.push({connId:null,player:{username:"COM "+(seats.length+1),playerId:"COM",rating:1000,games:0},bot:true,hand:[],points:0,taken:[],roundTaken:[],roundPoints:0});const m={id,kind,code:roomCode,seats:seats.slice(0,5),created:Date.now(),botLevel:3,matchScores:Array(5).fill(0),matchArt:Array(5).fill(0),matchContracts:[],bidHistory:[],playoff:false,appeal:null,appealInfo:'',matchStats:Array.from({length:5},()=>({exactWins:0,boldExactWins:0,soloWins:0,dramaticPlays:0,declarerAttempts:0,declarerSuccesses:0,deputyAttempts:0,deputySuccesses:0,exactAttempts:0,exactSuccesses:0,soloAttempts:0,soloSuccesses:0,artAttempts:0,allyFeedAttempts:0,allyFeedSuccesses:0,boldAttempts:0,boldSuccesses:0,bidTotal:0,ntBids:0,colorBids:0})),roundArt:Array(5).fill(0),roundDrama:Array(5).fill(0),roundFeed:Array(5).fill(0),phase:"prep",round:1,mult:1,redraws:0,kitty:[],trick:[],trickNo:0,active:-1,auction:null,contract:null,deadline:Date.now()+7000,lastBot:0,notice:"配札しました。競り開始まで7秒です。",playedCards:[],voids:[{},{},{},{},{}]};matches.set(id,m);m.seats.forEach(x=>{if(x.connId)connMatch.set(x.connId,id)});const players=m.seats.map((x,seat)=>({seat,id:x.player.playerId,username:x.player.username,rating:x.player.rating,bot:x.bot}));group.forEach((x,seat)=>sendSafe(x.conn,{type:"matched",matchId:id,mode:kind,code:roomCode||null,players,seat,botCount:5-group.length}));deal(m);publish(m,room)}
function deal(m){m.lastTrickWinner=null;const d=shuffledDeck();m.seats.forEach(p=>{p.hand=d.splice(0,10);p.points=0;p.taken=[];p.roundTaken=[];p.roundPoints=0;sortHand(p.hand)});m.kitty=d.splice(0,2);m.trick=[];m.trickNo=0;m.earlyFinish=false;m.roundArt=Array(5).fill(0);m.roundDrama=Array(5).fill(0);m.roundFeed=Array(5).fill(0);m.result=null;m.contract=null;m.auction=null;m.active=-1;m.phase="prep";m.deadline=Date.now()+7000;m.playedCards=[];m.voids=[{},{},{},{},{}];m.notice="競り開始まで7秒です。";const green=m.seats.findIndex(p=>!p.hand.some(c=>["10","J","Q","K","A"].includes(c.rank)));if(green>=0&&m.redraws<5){m.redraws++;m.mult=m.mult>=4?2:m.mult+1;m.phase="redeal";m.notice=m.seats[green].player.username+"の手札に10・J・Q・K・Aがありません。倍率"+m.mult+"倍で配り直します。";m.deadline=Date.now()+1800}}
function finalAuctionRule(scores,mult=1){const ranked=scores.map((score,seat)=>({score,seat})).sort((a,b)=>a.score-b.score||a.seat-b.seat),cutoff=ranked[1]?.score??0,gap=Math.max(0,(ranked[1]?.score??0)-(ranked[0]?.score??0)),rawMin=13+Math.floor(gap/(6*Math.max(1,mult)));return {eligible:ranked.filter(x=>x.score<=cutoff).map(x=>x.seat),bottomSeat:ranked[0]?.seat,fourthSeat:ranked[1]?.seat,thirdSeat:ranked[2]?.seat,thirdScore:ranked[2]?.score,minBid:Math.min(20,rawMin),canOvertake:rawMin<=20}}
function soloMinimumBid(gap,mult){return 13+Math.floor(Math.max(0,gap)/(10*Math.max(1,mult)))}
function computeTeamMinBid(scores,mult,napSeat,deputySeat){const ranked=scores.map((s,i)=>({s,i})).sort((a,b)=>a.s-b.s||a.i-b.i);const S5=ranked[0].s,S4=ranked[1].s,S3=ranked[2].s;const bottomSeat=ranked[0].i,fourthSeat=ranked[1].i;const m=Math.max(1,mult);const f=(gap,denom)=>Math.floor(Math.max(0,gap)/denom);if(napSeat===bottomSeat&&deputySeat===fourthSeat){const a=13+f(S4-S5,2*m),b=13+f(S3-S4,4*m),raw=Math.max(a,b);const broken=b>20,soloBid=soloMinimumBid(S4-S5,m);return{minBid:broken?Math.min(20,soloBid):Math.min(20,raw),rawMin:broken?soloBid:raw,canOvertake:(broken?soloBid:raw)<=20,incentiveBroken:broken,soloRequired:broken,soloMinBid:Math.min(20,soloBid),soloRawMin:soloBid,soloPossible:soloBid<=20,case:'A',details:{S3,S4,S5,needNapOverDeputy:a,needDeputyOverThird:b,soloNeed:soloBid}}}if(napSeat===fourthSeat&&deputySeat===bottomSeat){const a=13+f(S3-S4,6*m),b=13+f(S3-S5,4*m),c=13+f(S4-S5,2*m),raw=Math.max(a,b,c);return{minBid:Math.min(20,raw),rawMin:raw,canOvertake:raw<=20,incentiveBroken:a>20||b>20,soloRequired:false,case:'B',details:{S3,S4,S5,needNapOverThird:a,needDeputyOverThird:b,needDeputyOverNapOnLoss:c}}}if(napSeat===bottomSeat&&deputySeat!==fourthSeat){const raw=13+f(S4-S5,6*m);return{minBid:Math.min(20,raw),rawMin:raw,canOvertake:raw<=20,incentiveBroken:false,soloRequired:false,case:'C',details:{S3,S4,S5,needNapOverFourth:raw}}}if(napSeat===fourthSeat&&deputySeat!==bottomSeat){const raw=13+f(S4-S5,6*m);return{minBid:Math.min(20,raw),rawMin:raw,canOvertake:raw<=20,incentiveBroken:false,soloRequired:false,case:'D',details:{S3,S4,S5,needNapLoss:raw}}}return null}
function isSoloForcedInMatch(m){if(m.round<10||!m.contract)return false;const ranked=m.matchScores.map((s,i)=>({s,i})).sort((a,b)=>a.s-b.s||a.i-b.i);const bottomSeat=ranked[0].i;if(m.contract.nap!==bottomSeat)return false;const fourthSeat=ranked[1].i;const r=computeTeamMinBid(m.matchScores,m.mult,bottomSeat,fourthSeat);return r?.soloRequired===true}
function isSafeToCashAceInMatch(m,suit,seat){if(!m.contract)return false;if(suit==='♠')return true;if(m.trickNo>0){const twoPlayed=m.playedCards.some(c=>c.id===suit+'2');if(!twoPlayed){const anyVoid=[0,1,2,3,4].some(s=>s!==seat&&m.voids[s]&&m.voids[s][suit]);if(!anyVoid)return false}}if(m.contract.suit!=='NT'&&m.contract.suit!==suit){for(let s=0;s<5;s++){if(s===seat)continue;if(m.contract.revealedCall){if(s===m.contract.nap||(!m.contract.solo&&s===m.contract.deputy))continue}else{if(s===m.contract.nap)continue}if(m.voids[s]&&m.voids[s][suit])return false}}return true}
function publicState(m){return {matchId:m.id,mode:m.kind,code:m.code,botLevel:m.botLevel,phase:m.phase,round:m.round,mult:m.mult,matchScores:m.matchScores,bidHistory:m.bidHistory||[],playoff:!!m.playoff,appeal:m.appeal,appealInfo:m.appealInfo||'',lastTrickWinner:m.lastTrickWinner??null,finalRoundRule:m.round>=10?finalAuctionRule(m.matchScores,m.mult):null,notice:m.notice,active:m.active,players:m.seats.map((p,seat)=>({seat,name:p.bot?p.player.username:(p.player.playerId||p.player.username),username:p.player.username,rating:p.player.rating,bot:p.bot,handCount:p.hand.length,points:p.points,taken:p.taken,active:m.active,approved:m.phase==="auction"&&m.auction&&Array.isArray(m.auction.active)&&!m.auction.active.includes(seat),role:m.contract?(m.contract.nap===seat?(m.contract.revealedCall&&m.contract.solo?"ナポレオン（ひとり立ち）":"ナポレオン"):!m.contract.revealedCall?"":m.contract.deputy===seat?"副官":"連合軍"):""})),kitty:m.phase==="auction"?m.kitty:[],auction:m.auction?{high:m.auction.high,active:m.auction.active,minBid:m.auction.minBid||13,requiredBidSeat:m.auction.requiredBidSeat??null}:null,contract:m.contract?{nap:m.contract.nap,num:m.contract.num,suit:m.contract.suit,deputy:m.contract.revealedCall?m.contract.deputy:-1,solo:m.contract.revealedCall?m.contract.solo:null,revealedCall:!!m.contract.revealedCall,call:m.contract.call}:null,trick:m.trick.map(x=>({seat:x.seat,card:x.card})),trickNo:m.trickNo,deadline:m.deadline,result:m.result||null}}
function legalCards(m,seat){const h=m.seats[seat].hand;if(!m.trick.length)return h;const led=m.trick[0].card.suit,follow=h.filter(c=>c.suit===led);return follow.length?follow:h}
function publish(m,room){const pub=publicState(m);for(let seat=0;seat<m.seats.length;seat++){const p=m.seats[seat];if(!p.connId)continue;const c=conns.get(p.connId);if(!c)continue;const view=m.phase==="call"&&seat===m.active?{...pub,kitty:m.kitty}:pub;try{sendSafe(c,{type:"game-state",state:view,you:seat});sendSafe(c,{type:"private-hand",hand:p.hand,legal:m.phase==="play"&&m.active===seat?legalCards(m,seat).map(x=>x.id):[]})}catch(error){console.warn("match publish failed",m.id,c.id,error)}}}
function tell(m,room,text){m.notice=text;publish(m,room)}
function validBid(m,n,s){const h=m.auction.high;return Number.isInteger(n)&&n>=(m.auction.minBid||13)&&n<=20&&(SUITS.includes(s)||s==="NT")&&(n>h.num||(n===h.num&&SV[s]>SV[h.suit]))}
function doApprove(m,seat,room,forced=false){if(m.phase!=="auction"||!m.auction.active.includes(seat))return;if(m.auction.requiredBidSeat!==null&&m.auction.high.num<13){if(forced&&seat===m.auction.requiredBidSeat)doBid(m,seat,m.auction.minBid||13,strongestBotSuit(m.seats[seat].hand),room);return}if(m.round>=10&&m.auction.high.num<13){const forcedSeat=m.auction.requiredBidSeat??m.auction.active[0];if(forced&&seat===forcedSeat)doBid(m,seat,m.auction.minBid||13,strongestBotSuit(m.seats[seat].hand),room);return}if(m.auction.high.player===seat){if(m.auction.active.length===1)auctionDone(m,seat,room);else if(forced&&!m.auction.autoApprove[seat]){m.auction.autoApprove[seat]=true;m.notice=m.seats[seat].player.username+"は30秒操作がなかったため、自動承認待ちです。";publish(m,room)}return}m.auction.lastAction[seat]=Date.now();m.auction.autoApprove[seat]=false;m.auction.active=m.auction.active.filter(x=>x!==seat);m.notice=forced?m.seats[seat].player.username+"は30秒操作がなかったため、自動で承認しました。":m.seats[seat].player.username+"が承認しました。";if(!m.auction.active.length){auctionDone(m,-1,room);return}if(m.auction.active.length===1&&m.auction.high.player===m.auction.active[0]){const last=m.auction.active[0];if(m.auction.autoApprove[last]){auctionDone(m,last,room);return}m.notice=m.seats[last].player.username+"以外は承認しました。さらに宣言するか、承認して確定できます。"}m.auction.active.forEach(i=>{if(m.seats[i].bot){m.auction.botSeen[i]=Math.min(m.auction.botSeen[i],m.auction.version-1);m.auction.botAt[i]=Date.now()+500+Math.random()*1300}});publish(m,room)}
function doBid(m,seat,n,s,room){if(m.phase!=="auction"||!m.auction.active.includes(seat)||m.auction.requiredBidSeat!==null&&m.auction.requiredBidSeat!==seat||!validBid(m,n,s))return;m.bidHistory.push({round:m.round,seat,num:n,suit:s});if(m.bidHistory.length>50)m.bidHistory.shift();m.auction.lastAction[seat]=Date.now();m.auction.autoApprove[seat]=false;m.auction.high={num:n,suit:s,player:seat};if(m.auction.requiredBidSeat===seat)m.auction.requiredBidSeat=null;m.auction.version++;m.active=seat;m.auction.botAt.forEach((_,i)=>{if(m.seats[i].bot&&i!==seat&&m.auction.active.includes(i))m.auction.botAt[i]=Date.now()+400+Math.random()*1600});for(const i of m.auction.active.slice())if(i!==seat&&m.auction.autoApprove[i])doApprove(m,i,room,true);if(m.phase!=="auction")return;m.notice=m.seats[seat].player.username+"が"+n+s+"を宣言しました。";if(n===20&&s==="NT"){auctionDone(m,seat,room);return}publish(m,room)}
function appealDetails(hand){const targets=[['♣J','♣J'],['♦J','♦J'],['♥J','♥J'],['♠J','♠J'],['マイティ（♠A）','♠A']];return targets.map(([label,id])=>label+'：'+(hand.some(card=>card.id===id)?'あり':'なし')).join(' · ')}
function enterAuctionAfterAppeal(m,room,requiredBidSeat=null){m.auction.requiredBidSeat=requiredBidSeat;m.phase='auction';m.active=-1;m.deadline=0;m.notice=m.appealInfo||'競り開始です。宣言するか、承認して競りを降りてください。';publish(m,room)}
function answerAppealOffer(m,seat,appeal,room){if(m.phase!=='appeal-offer'||seat!==m.appeal?.bottomSeat)return;if(!appeal){m.appealInfo='5位はアピールせず競りへ';enterAuctionAfterAppeal(m,room);return}m.phase='appeal-response';m.active=m.appeal.fourthSeat;m.deadline=Date.now()+30000;m.notice='5位がアピールしました。4位はJ・マイティを申告するか、申告せず立てます。';publish(m,room);if(m.seats[m.active].bot)answerAppealResponse(m,m.active,'declare',room)}
function answerAppealResponse(m,seat,choice,room){if(m.phase!=='appeal-response'||seat!==m.appeal?.fourthSeat)return;if(choice==='declare'){const player=m.seats[seat].player;m.appealInfo=(player.playerId||player.username)+'の申告：'+appealDetails(m.seats[seat].hand);enterAuctionAfterAppeal(m,room);return}const player=m.seats[seat].player;m.appealInfo=(player.playerId||player.username)+'は申告せず立つことを選択。';enterAuctionAfterAppeal(m,room,seat)}
function auctionDone(m,seat,room){if(seat<0||m.auction.high.num<13){if(m.round>=10){seat=finalAuctionRule(m.matchScores,m.mult).bottomSeat;m.auction.high={num:m.auction.minBid||13,suit:strongestBotSuit(m.seats[seat].hand),player:seat};m.notice="オールラストは立ち必須。最下位が最低枚数で立ちます。"}else{m.notice="宣言なし。配り直します。";m.phase="redeal";m.deadline=Date.now()+1800;publish(m,room);return}}m.contract={nap:seat,num:m.auction.high.num,suit:m.auction.high.suit,deputy:-1,call:null,solo:false,revealedCall:false,revealTrickNo:null};beginDiscard(m,seat,room)}
function startPlay(m,room){const c=m.contract;if(c.solo)c.deputy=c.nap;else{for(let i=0;i<5;i++){const found=m.seats[i].hand.some(x=>x.id===c.call.id);if(found){c.deputy=i;break}}if(c.deputy<0)c.deputy=c.nap;}m.phase="play";m.trick=[];m.trickNo=0;m.active=c.nap;m.deadline=Date.now()+30000;m.notice="カードを出してください。マストフォローです。";publish(m,room);if(m.seats[m.active].bot)botAction(m,room)}
function beginDiscard(m,seat,room){m.seats[seat].hand.push(...m.kitty);m.kitty=[];sortHand(m.seats[seat].hand);m.phase="discard";m.active=seat;m.deadline=Date.now()+30000;m.notice="オープンの2枚を手札に入れ、2枚を捨ててください。";publish(m,room);if(m.seats[seat].bot)botAction(m,room)}
function callCard(m,seat,suit,rank,room){if(m.phase!=="call"||m.active!==seat||!SUITS.includes(suit)||!RANKS.includes(rank))return;const card={suit,rank,id:suit+rank};if(m.kitty.some(x=>x.id===card.id))return;const forceSolo=isSoloForcedInMatch(m);if(forceSolo){const isOwn=m.seats[seat].hand.some(c=>c.id===card.id);if(!isOwn){m.notice="⚠ Case A破綻：一人立ち必須のため、自分の手札からのみ指名できます。";publish(m,room);return}}m.contract.call=card;m.contract.solo=m.seats[seat].hand.some(x=>x.id===card.id);if(forceSolo&&!m.contract.solo){m.notice="⚠ 一人立ち必須です。自分の手札から選んでください。";publish(m,room);return}m.contract.revealedCall=false;m.contract.ready=m.seats.map(p=>p.bot);m.phase="call-reveal";m.active=seat;m.deadline=Date.now()+15000;m.kitty=[];m.notice=suit+rank+"が指名されました"+(forceSolo?"（一人立ち強制）":"")+"。全員の確認後に開始します。";publish(m,room)}
function discardCards(m,seat,ids,room){if(m.phase!=="discard"||m.active!==seat||!Array.isArray(ids)||ids.length!==2||new Set(ids).size!==2||m.contract.solo&&ids.includes(m.contract.call.id))return;const h=m.seats[seat].hand;if(ids.some(id=>!h.some(c=>c.id===id)))return;const removed=h.filter(c=>ids.includes(c.id));m.seats[seat].hand=h.filter(c=>!ids.includes(c.id));const kittyPoints=removed.filter(c=>["10","J","Q","K","A"].includes(c.rank));m.seats[m.contract.nap].points+=kittyPoints.length;m.seats[m.contract.nap].taken.push(...kittyPoints);m.kitty=removed;sortHand(m.seats[seat].hand);m.phase="call";m.active=seat;m.deadline=Date.now()+30000;m.notice="捨て札を決めました。副官に指名するカードを選んでください。";publish(m,room);if(m.seats[seat].bot)botAction(m,room)}
function isTrump(m,c){return m.contract.suit!=="NT"&&c.suit===m.contract.suit}
function power(m,entry,trick){
  const c=entry.card,led=trick[0].card.suit,allSame=trick.every(x=>x.card.suit===led),mighty=trick.some(x=>x.card.id==="♠A");
  if(mighty&&c.id==="♥Q")return 10000;
  if(c.id==="♠A")return 9000;
  if(m.contract.suit!=="NT"&&c.rank==="J"&&c.suit===m.contract.suit)return 8000;
  const sameColor=(a,b)=>(a==="♣"||a==="♠")===(b==="♣"||b==="♠");
  if(m.contract.suit!=="NT"&&c.rank==="J"&&c.suit!==m.contract.suit&&sameColor(c.suit,m.contract.suit))return 7000;
  if(allSame&&c.suit===led&&c.rank==="2")return 6000;
  if(isTrump(m,c))return 5000+RANKS.indexOf(c.rank);
  if(c.suit===led)return 3000+RANKS.indexOf(c.rank);
  return 1000+RANKS.indexOf(c.rank);
}
function bestEntry(m,trick){return trick.reduce((best,x)=>power(m,x,trick)>power(m,best,trick)?x:best,trick[0])}
function winner(m){return bestEntry(m,m.trick)}
function matchRatingChanges(scores,art,ratings,matchStats,contracts){const meanArt=art.reduce((n,x)=>n+x,0)/5;const cs=contracts||[];return scores.map((score,seat)=>{let delta=0;const rounds=[];for(const c of cs){const p=CALIBRATION[Math.min(20,Math.max(13,c.num))]??0.5;const diff=c.num-12;const actual=c.napWin?1:0;let roundDelta=0;let role='ally';if(seat===c.nap){role='nap';roundDelta=(actual-p)*diff*8;if(c.napWin&&c.points>c.num){roundDelta-=(c.points-c.num)*0.3}if(c.solo)roundDelta*=1.5}else if(!c.solo&&seat===c.deputy){role='dep';roundDelta=(actual-p)*diff*3.2;if(c.napWin&&c.revealTrickNo!=null){roundDelta+=Math.max(0,c.revealTrickNo-3)*0.3}}else{role='ally';const pts=(c.takenPoints&&c.takenPoints[seat])||0;roundDelta=(pts-4.4)*0.4;roundDelta+=c.napWin?-0.5:+0.5}delta+=roundDelta;rounds.push({bid:c.num,role,delta:Math.round(roundDelta*100)/100})}delta+=(art[seat]-meanArt)*0.3;const rank=1+scores.filter(x=>x>score).length;if(rank===1)delta+=0.5;else if(rank===5)delta-=0.5;delta-=0.05*cs.length;const outcome=score>0?'win':score<0?'loss':'draw';return{seat,delta:Math.round(delta*10)/10,placement:rank,art:art[seat]-meanArt,outcome,breakdown:{rounds,rank}}})}
async function finish(m,room,env){
  m.matchScores=m.matchScores||Array(5).fill(0);m.matchArt=m.matchArt||Array(5).fill(0);m.matchContracts=m.matchContracts||[];
  m.matchStats=m.matchStats||Array.from({length:5},()=>({exactWins:0,boldExactWins:0,soloWins:0,dramaticPlays:0,declarerAttempts:0,declarerSuccesses:0,deputyAttempts:0,deputySuccesses:0,exactAttempts:0,exactSuccesses:0,soloAttempts:0,soloSuccesses:0,artAttempts:0,allyFeedAttempts:0,allyFeedSuccesses:0,boldAttempts:0,boldSuccesses:0,bidTotal:0,ntBids:0,colorBids:0}));
  m.matchStats.forEach(stat=>{stat.declarerAttempts=stat.declarerAttempts||0;stat.declarerSuccesses=stat.declarerSuccesses||0;stat.deputyAttempts=stat.deputyAttempts||0;stat.deputySuccesses=stat.deputySuccesses||0;stat.exactAttempts=stat.exactAttempts||0;stat.exactSuccesses=stat.exactSuccesses||0;stat.soloAttempts=stat.soloAttempts||0;stat.soloSuccesses=stat.soloSuccesses||0;stat.artAttempts=stat.artAttempts||0;stat.allyFeedAttempts=stat.allyFeedAttempts||0;stat.allyFeedSuccesses=stat.allyFeedSuccesses||0;stat.boldAttempts=stat.boldAttempts||0;stat.boldSuccesses=stat.boldSuccesses||0;stat.bidTotal=stat.bidTotal||0;stat.ntBids=stat.ntBids||0;stat.colorBids=stat.colorBids||0});
  m.roundArt=m.roundArt||Array(5).fill(0);
  const finalRule=m.round>=10?finalAuctionRule(m.matchScores,m.mult):null;
  const nap=m.contract.nap,unit=Math.max(0,m.contract.num-12)*m.mult*(m.round>=10?2:1);
  const team=m.contract.solo?[nap]:Array.from(new Set([nap,m.contract.deputy]));
  const points=team.reduce((n,i)=>n+m.seats[i].points,0);
  const made=points>=m.contract.num&&(m.contract.num===20||points<20);
  const sign=made?1:-1;const scores=Array(5).fill(0);
  m.matchStats[nap].declarerAttempts++;m.matchStats[nap].bidTotal=(m.matchStats[nap].bidTotal||0)+m.contract.num;
  if(m.contract.suit==="NT")m.matchStats[nap].ntBids=(m.matchStats[nap].ntBids||0)+1;else m.matchStats[nap].colorBids=(m.matchStats[nap].colorBids||0)+1;
  m.matchStats[nap].exactAttempts++;
  if(m.contract.num>=15){m.matchStats[nap].boldAttempts++;if(made&&points===m.contract.num)m.matchStats[nap].boldSuccesses++}
  if(made)m.matchStats[nap].declarerSuccesses++;
  if(!m.contract.solo){m.matchStats[m.contract.deputy].deputyAttempts++;if(made)m.matchStats[m.contract.deputy].deputySuccesses++}
  if(m.contract.solo){m.matchStats[nap].soloAttempts++;if(made)m.matchStats[nap].soloSuccesses++}
  scores[nap]=sign*unit*(m.contract.solo?4:2);
  if(m.contract.solo){for(let i=0;i<5;i++)if(i!==nap)scores[i]=-sign*unit}
  else{scores[m.contract.deputy]=sign*unit;for(let i=0;i<5;i++)if(i!==nap&&i!==m.contract.deputy)scores[i]=-sign*unit}
  const art=m.roundArt.slice();
  if(made&&points===m.contract.num){art[nap]+=2;m.matchStats[nap].exactWins++;m.matchStats[nap].exactSuccesses++;if(!m.contract.solo)art[m.contract.deputy]+=1;if(m.contract.num>=15){art[nap]+=2;m.matchStats[nap].boldExactWins++;if(!m.contract.solo)art[m.contract.deputy]+=1}}
  if(m.contract.solo){art[nap]+=made?4:2;if(made){m.matchStats[nap].soloWins++}}
  if(!made&&!m.contract.solo&&m.contract.num-points>=3){art[nap]-=2;art[m.contract.deputy]-=1}
  for(let i=0;i<5;i++){m.matchScores[i]+=scores[i];m.matchArt[i]+=art[i]}
  m.matchContracts.push({round:m.round,nap,deputy:m.contract.deputy,num:m.contract.num,suit:m.contract.suit,solo:!!m.contract.solo,points,napWin:made,revealTrickNo:m.contract.revealTrickNo??null,takenPoints:m.seats.map(s=>s.roundPoints||0)});
  const replayAllLast=!!(finalRule&&scores[finalRule.bottomSeat]>0&&m.matchScores[finalRule.bottomSeat]===m.matchScores[finalRule.fourthSeat]);
  const lastRound=m.round>=10&&!replayAllLast;
  if(replayAllLast)m.playoff=true;
  m.result={round:m.round,made,points,bid:m.contract.num,suit:m.contract.suit,solo:!!m.contract.solo,stake:unit,scoreChanges:scores.map((delta,seat)=>({seat,delta,role:seat===nap?"ナポレオン":!m.contract.solo&&seat===m.contract.deputy?"副官":"連合軍"})),artChanges:art.map((delta,seat)=>({seat,delta})),winners:made?team:m.seats.map((_,i)=>i).filter(i=>!team.includes(i)),matchScores:m.matchScores.slice(),matchArt:m.matchArt.slice(),allLastReplay:replayAllLast,playoff:!!m.playoff};
  m.phase=lastRound?"result":"round-result";m.active=-1;m.deadline=lastRound?0:Date.now()+8000;
  m.notice=replayAllLast?"5位が4位に並びました。プレーオフを行います。":lastRound?"オールラスト終了。レートを集計しています。":"第"+m.round+"局が終了しました。";
  if(!lastRound){publish(m,room);return}
  const ratingChanges=matchRatingChanges(m.matchScores,m.matchArt,m.seats.map(seat=>Number(seat.player.rating)||1000),m.matchStats,m.matchContracts);
  m.result.ratingChanges=ratingChanges;
  const placementOrder=m.matchScores.map((score,seat)=>({score,seat})).sort((a,b)=>b.score-a.score||a.seat-b.seat);
  const placementBySeat=[];placementOrder.forEach((entry,index)=>placementBySeat[entry.seat]=index+1);
  if(m.kind==="ranked"){
    const userIds=[...new Set(m.seats.map(seat=>seat.player.userId).filter(Boolean))];const updates=[];
    if(userIds.length){
      try{
        const placeholders=userIds.map(()=>"?").join(",");
        const{results:profiles}=await env.DB.prepare("SELECT user_id,username,rating FROM players WHERE user_id IN ("+placeholders+")").bind(...userIds).all();
        const byId=new Map(profiles.map(profile=>[profile.user_id,profile]));const statements=[];
        for(let seat=0;seat<m.seats.length;seat++){
          const player=m.seats[seat],userId=player.player.userId,profile=userId&&byId.get(userId);
          if(!profile)continue;
          const change=ratingChanges[seat],rating=profile.rating+change.delta,outcome=change.outcome;
          change.rating=rating;const stat=m.matchStats[seat];
          statements.push(
            env.DB.prepare("UPDATE players SET rating=?,wins=wins+?,losses=losses+?,games=games+1 WHERE user_id=?").bind(rating,outcome==="win"?1:0,outcome==="loss"?1:0,profile.user_id),
            env.DB.prepare("INSERT INTO match_history(user_id,username,result,delta,rating_after) VALUES(?,?,?,?,?)").bind(profile.user_id,profile.username,outcome,change.delta,rating),
            env.DB.prepare("INSERT OR IGNORE INTO player_stats(user_id) VALUES(?)").bind(profile.user_id),
            env.DB.prepare("UPDATE player_stats SET exact_wins=exact_wins+?,bold_exact_wins=bold_exact_wins+?,solo_wins=solo_wins+?,dramatic_plays=dramatic_plays+? WHERE user_id=?").bind(stat.exactWins,stat.boldExactWins,stat.soloWins,stat.dramaticPlays,profile.user_id),
            env.DB.prepare("INSERT INTO player_performance(user_id,declarer_attempts,declarer_successes,deputy_attempts,deputy_successes) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET declarer_attempts=declarer_attempts+excluded.declarer_attempts,declarer_successes=declarer_successes+excluded.declarer_successes,deputy_attempts=deputy_attempts+excluded.deputy_attempts,deputy_successes=deputy_successes+excluded.deputy_successes").bind(profile.user_id,stat.declarerAttempts,stat.declarerSuccesses,stat.deputyAttempts,stat.deputySuccesses),
            env.DB.prepare("INSERT INTO player_precision(user_id,exact_attempts,exact_successes,solo_attempts,solo_successes) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET exact_attempts=exact_attempts+excluded.exact_attempts,exact_successes=exact_successes+excluded.exact_successes,solo_attempts=solo_attempts+excluded.solo_attempts,solo_successes=solo_successes+excluded.solo_successes").bind(profile.user_id,stat.exactAttempts,stat.exactSuccesses,stat.soloAttempts,stat.soloSuccesses),
            env.DB.prepare("INSERT INTO player_art_rate(user_id,attempts,plays) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET attempts=attempts+excluded.attempts,plays=plays+excluded.plays").bind(profile.user_id,stat.artAttempts,stat.dramaticPlays),
            env.DB.prepare("INSERT INTO player_ally_feed(user_id,attempts,successes) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET attempts=attempts+excluded.attempts,successes=successes+excluded.successes").bind(profile.user_id,stat.allyFeedAttempts,stat.allyFeedSuccesses),
            env.DB.prepare("INSERT INTO player_bold_bid_rate(user_id,attempts,successes) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET attempts=attempts+excluded.attempts,successes=successes+excluded.successes").bind(profile.user_id,stat.boldAttempts,stat.boldSuccesses),
            env.DB.prepare("INSERT INTO player_match_stats(user_id,declarer_attempts,bid_total,nt_bids,color_bids,match_count,rank_1,rank_2,rank_3,rank_4,rank_5) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET declarer_attempts=declarer_attempts+excluded.declarer_attempts,bid_total=bid_total+excluded.bid_total,nt_bids=nt_bids+excluded.nt_bids,color_bids=color_bids+excluded.color_bids,match_count=match_count+1,rank_1=rank_1+excluded.rank_1,rank_2=rank_2+excluded.rank_2,rank_3=rank_3+excluded.rank_3,rank_4=rank_4+excluded.rank_4,rank_5=rank_5+excluded.rank_5").bind(profile.user_id,stat.declarerAttempts,stat.bidTotal||0,stat.ntBids||0,stat.colorBids||0,1,...Array.from({length:5},(_,index)=>placementBySeat[seat]===index+1?1:0))
          );
          updates.push({connId:player.connId,change,rating,outcome});
        }
        if(statements.length)await env.DB.batch(statements);
      }catch(error){console.error("ranked match settlement failed",m.id,error);m.result.rateSaveFailed=true}
      if(!m.result.rateSaveFailed)for(const update of updates){try{sendSafe(conns.get(update.connId),{type:"rating-updated",result:update.outcome,delta:update.change.delta,rating:update.rating,placement:update.change.placement,art:update.change.art,breakdown:update.change.breakdown})}catch(error){console.warn("rating notification failed",m.id,error)}}
    }
  }
  publish(m,room);matches.delete(m.id);
  for(const seat of m.seats){if(seat.connId)connMatch.delete(seat.connId);const userId=seat.player.userId;if(userId&&rankedUsers.get(userId)===seat.originalConnId)rankedUsers.delete(userId)}
}
function artfulCard(m,entry,trick){const c=entry.card,led=trick[0].card.suit,black=s=>s==="♣"||s==="♠";return c.id==="♠A"||c.id==="♥Q"&&trick.some(x=>x.card.id==="♠A")||c.rank==="J"&&m.contract.suit!=="NT"&&(c.suit===m.contract.suit||c.suit!==m.contract.suit&&black(c.suit)===black(m.contract.suit))||c.rank==="2"&&c.suit===led&&trick.every(x=>x.card.suit===led)}
function playCard(m,seat,id,room,env){
  if(m.phase!=="play"||m.active!==seat)return;
  const legal=legalCards(m,seat),card=legal.find(x=>x.id===id);
  if(!card)return;
  if(!m.trick.length)m.lastTrickWinner=null;
  const previous=m.trick.length?winner(m):null,hand=m.seats[seat].hand,teamOf=i=>i===m.contract.nap||!m.contract.solo&&i===m.contract.deputy?"nap":"alliance",feedOpportunity=!!(previous&&previous.seat!==seat&&m.contract.revealedCall&&teamOf(previous.seat)===teamOf(seat)&&legal.some(x=>["10","J","Q","K","A"].includes(x.rank))),feedCard=feedOpportunity&&["10","J","Q","K","A"].includes(card.rank);
  hand.splice(hand.findIndex(x=>x.id===id),1);
  m.trick.push({seat,card,feedOpportunity,feedCard});
  m.playedCards.push({suit:card.suit,rank:card.rank,id:card.id});
  if(m.trick.length>1){const ledSuit=m.trick[0].card.suit;if(card.suit!==ledSuit){if(!m.voids[seat])m.voids[seat]={};m.voids[seat][ledSuit]=true}}
  const reveal=m.contract.call?.id===card.id&&!m.contract.revealedCall;let raisedNotice="";
  if(reveal){
    m.contract.revealedCall=true;m.contract.revealTrickNo=m.trickNo;
    if(m.round>=10&&!m.contract.solo){
      const r=computeTeamMinBid(m.matchScores,m.mult,m.contract.nap,m.contract.deputy);
      if(r!==null){
        const forcedMin=r.minBid,oldBid=m.contract.num;
        const caseLabel={A:'5位=ナポレオン / 4位=副官',B:'4位=ナポレオン / 5位=副官',C:'5位=ナポレオン / 4位=連合軍',D:'4位=ナポレオン / 5位=連合軍'}[r.case];
        if(forcedMin>oldBid){m.contract.num=forcedMin;raisedNotice='副官判明（'+caseLabel+'）。立ちを '+oldBid+'枚 → '+forcedMin+'枚 に引き上げました。'}
        else{raisedNotice='副官判明（'+caseLabel+'）。立ち '+oldBid+'枚は最低条件を満たしています。'}
        if(r.incentiveBroken)raisedNotice+=' ⚠ 20枚でも4位が3位を超えられないため、副官に勝つインセンティブがありません。';
      }
    }
  }
  if(previous&&m.contract.revealedCall){const team=x=>x===m.contract.nap||x===m.contract.deputy?"nap":"alliance";if(team(seat)===team(previous.seat)&&winner(m).seat===seat)m.roundArt[seat]--}
  const revealNotice=m.contract.solo?"ひとり立ちが判明しました。":"副官が判明しました。";
  if(m.trick.length<5){m.active=(seat+4)%5;m.deadline=Date.now()+30000;m.notice=raisedNotice||(reveal?revealNotice:"カードを出してください。");publish(m,room);if(m.seats[m.active].bot)botAction(m,room);return}
  const winningEntry=winner(m),w=winningEntry.seat,taken=m.trick.filter(x=>["10","J","Q","K","A"].includes(x.card.rank)).map(x=>x.card);
  for(const entry of m.trick){if(!entry.feedOpportunity)continue;const stat=m.matchStats[entry.seat];stat.allyFeedAttempts++;if(entry.feedCard&&teamOf(w)===teamOf(entry.seat)){stat.allyFeedSuccesses++;m.roundFeed[entry.seat]++;m.roundArt[entry.seat]++}}
  if(taken.length>=3&&m.roundDrama[w]<2){m.matchStats[w].artAttempts++;if(artfulCard(m,winningEntry,m.trick)){m.roundArt[w]++;m.roundDrama[w]++;m.matchStats[w].dramaticPlays++}}
  m.seats[w].points+=taken.length;m.seats[w].taken.push(...taken);m.seats[w].roundTaken.push(...taken);m.seats[w].roundPoints=(m.seats[w].roundPoints||0)+taken.length;
  m.lastTrickWinner=w;m.active=w;
  const alliancePoints=m.seats.reduce((n,p,i)=>n+(i!==m.contract.nap&&(m.contract.solo||i!==m.contract.deputy)?p.points:0),0),napPoints=m.seats.reduce((n,p,i)=>n+(i===m.contract.nap||!m.contract.solo&&i===m.contract.deputy?p.points:0),0);
  m.earlyFinish=alliancePoints>20-m.contract.num||napPoints>=m.contract.num&&(m.contract.num===20||alliancePoints>=1);
  m.notice=raisedNotice||(napPoints>=m.contract.num?"ナポレオン軍が立ちを達成しました。":m.earlyFinish?"連合軍の獲得得点札で立ちが成立不能になりました。":reveal?revealNotice:m.seats[w].player.username+"が場札を取りました。");
  m.phase="trick-end";m.deadline=m.earlyFinish?Date.now():Date.now()+1250;publish(m,room);
}
function botAuctionBid(m,seat,room){m.botLevel=3;const a=m.auction,version=a.version;if(a.botSeen[seat]>=version||!a.active.includes(seat))return;a.botSeen[seat]=version;const level=m.botLevel||2,h=m.seats[seat].hand,strength=h.reduce((n,c)=>n+(RANKS.indexOf(c.rank)>9?1.2:RANKS.indexOf(c.rank)>7?.4:0)+(c.rank==="A"?.3:0),0)+Math.max(0,botSuitValue(h,strongestBotSuit(h))-6)*.35,high=a.high,openingChance=[.4,1,1][level-1],raiseChance=[.3,.9,1][level-1],minStrength=[4.5,2,1.2][level-1],divisor=[3,1.9,1.4][level-1],cap=13+Math.min(level===1?3:level===2?7:8,Math.floor(strength/divisor)),bestSuit=strongestBotSuit(h);let bid=null;if(a.botBids[seat]<2&&high.num<13&&strength>minStrength&&cap>=(a.minBid||13)&&Math.random()<openingChance)bid={num:Math.max(a.minBid||13,13+Math.min(level===1?1:level===2?3:5,Math.max(0,Math.floor((strength-2)/1.8)))),suit:level===1?SUITS[Math.floor(Math.random()*4)]:bestSuit};else if(a.botBids[seat]<2&&high.num>=13&&high.num<cap&&Math.random()<raiseChance){const suits=SUITS.filter(s=>SV[s]>SV[high.suit]).sort((a,b)=>botSuitValue(h,b)-botSuitValue(h,a));if(suits.length)bid={num:high.num,suit:suits[0]};else if(high.num+1<=cap)bid={num:high.num+1,suit:bestSuit}}if(m.round>=10&&high.num<13&&a.active[0]===seat)bid={num:a.minBid||13,suit:bestSuit};if(bid&&validBid(m,bid.num,bid.suit)){a.botBids[seat]++;doBid(m,seat,bid.num,bid.suit,room);if(m.phase==="auction")a.botAt[seat]=Date.now()+2500+Math.random()*1800;return}if(a.high.player===seat){if(a.active.length===1)doApprove(m,seat,room);return}doApprove(m,seat,room)}
function chooseBotDeputyPlay(m,i,legal){
 const contract=m.contract,nap=contract.nap,call=contract.call,trumpSuit=contract.suit,led=m.trick[0]?.card.suit,lastSeat=m.trick.length===4,ownSide="nap";
 const sideOf=seat=>seat===nap||!contract.solo&&seat===contract.deputy?"nap":"alliance",isFace=card=>["10","J","Q","K","A"].includes(card.rank),sameColor=(a,b)=>(a==="♣"||a==="♠")===(b==="♣"||b==="♠");
 const isRole=card=>card.id===call?.id||card.id==="♠A"||trumpSuit!=="NT"&&card.rank==="J"&&(card.suit===trumpSuit||sameColor(card.suit,trumpSuit));
 const low=cards=>cards.slice().sort((a,b)=>RANKS.indexOf(a.rank)+(a.suit===trumpSuit?3:0)-RANKS.indexOf(b.rank)-(b.suit===trumpSuit?3:0))[0];
 const winnerWith=card=>bestEntry(m,m.trick.concat([{seat:i,card}])),teamWinning=legal.filter(card=>sideOf(winnerWith(card).seat)===ownSide);
 const enemyCanOvertake=card=>{const trial=m.trick.concat([{seat:i,card}]);for(let step=1;step<=4-m.trick.length;step++){const seat=(i+step)%5;if(sideOf(seat)===ownSide)continue;const hand=m.seats[seat].hand,follow=hand.filter(x=>x.suit===led),options=follow.length?follow:hand;for(const response of options)if(sideOf(bestEntry(m,trial.concat([{seat,card:response}])).seat)!==ownSide)return true}return sideOf(bestEntry(m,trial).seat)!==ownSide};
 const safeTeamWins=teamWinning.filter(card=>!enemyCanOvertake(card));
 if(!m.trick.length){
  const napHand=m.seats[nap].hand,napHasTrump=trumpSuit!=="NT"&&napHand.some(card=>card.suit===trumpSuit),napAces=["♣","♦","♥","♠"].filter(suit=>napHand.some(card=>card.suit===suit&&card.rank==="A")),returnSuit=napAces.find(suit=>legal.some(card=>card.suit===suit));
  if(returnSuit)return low(legal.filter(card=>card.suit===returnSuit));
  if(trumpSuit!=="NT"&&napHand.some(card=>card.suit===trumpSuit)&&legal.some(card=>card.suit===trumpSuit))return low(legal.filter(card=>card.suit===trumpSuit));
  if(napHasTrump){const voidSuit=["♣","♦","♥","♠"].find(suit=>!napHand.some(card=>card.suit===suit)&&legal.some(card=>card.suit===suit));if(voidSuit)return low(legal.filter(card=>card.suit===voidSuit))}
  const secureAces=legal.filter(card=>card.rank==="A"&&(()=>{const trial=[{seat:i,card}];for(let offset=1;offset<5;offset++){const seat=(i+offset)%5,hand=m.seats[seat].hand,follow=hand.filter(x=>x.suit===card.suit),options=follow.length?follow:hand;for(const response of options)if(sideOf(bestEntry(m,trial.concat([{seat,card:response}])).seat)!==ownSide)return false}return true})());
  if(secureAces.length)return secureAces.sort((a,b)=>RANKS.indexOf(b.rank)-RANKS.indexOf(a.rank))[0];
  const sharedSuit=["♣","♦","♥","♠"].filter(suit=>legal.some(card=>card.suit===suit)&&napHand.some(card=>card.suit===suit)).sort((a,b)=>napHand.filter(card=>card.suit===b).length-napHand.filter(card=>card.suit===a).length)[0];
  if(sharedSuit)return low(legal.filter(card=>card.suit===sharedSuit));
  return legal.slice().sort((a,b)=>RANKS.indexOf(b.rank)+(b.suit===trumpSuit?3:0)-RANKS.indexOf(a.rank)-(a.suit===trumpSuit?3:0))[0];
 }
 const calledLead=m.trick[0].seat===nap&&(led===call?.suit||trumpSuit!=="NT"&&led===trumpSuit);
 if(calledLead){
  if(lastSeat){const delayed=safeTeamWins.filter(card=>!isRole(card));if(delayed.length){const points=delayed.filter(isFace);return(points.length?points:delayed).sort((a,b)=>RANKS.indexOf(b.rank)-RANKS.indexOf(a.rank))[0]}}
  const current=winner(m);
  if(sideOf(current.seat)===ownSide){
    const nonRole=legal.filter(c=>!isRole(c));
    if(nonRole.length){const candidate=low(nonRole);if(!enemyCanOvertake(candidate))return candidate}
  }
  if(trumpSuit==="NT"&&call?.rank==="A"&&call.id!=="♠A"&&led===call.suit&&m.trickNo>0){const allFollowed=m.trick.every(entry=>entry.card.suit===led),alreadyWonByTwo=m.trick.some(entry=>entry.card.suit===led&&entry.card.rank==="2")&&sideOf(winner(m).seat)!==ownSide,enemyTwoAfter=Array.from({length:4-m.trick.length},(_,index)=>(i+index+1)%5).some(seat=>sideOf(seat)!==ownSide&&m.seats[seat].hand.some(card=>card.suit===led&&card.rank==="2"));if(alreadyWonByTwo||allFollowed&&enemyTwoAfter){const shelter=legal.filter(card=>card.id!==call.id);if(shelter.length)return low(shelter)}}
  if(trumpSuit==="NT"&&call?.rank==="2"){const called=legal.find(card=>card.id===call.id);if(called)return called}
  const called=legal.find(card=>card.id===call?.id);if(called)return called;
  const roleCards=legal.filter(isRole);if(roleCards.length)return roleCards.sort((a,b)=>power(m,{seat:i,card:b},m.trick.concat([{seat:i,card:b}]))-power(m,{seat:i,card:a},m.trick.concat([{seat:i,card:a}])))[0];
 }
 if(m.trick.length){const current=winner(m),pointCards=safeTeamWins.filter(isFace);if(sideOf(current.seat)===ownSide&&pointCards.length)return pointCards.sort((a,b)=>RANKS.indexOf(b.rank)-RANKS.indexOf(a.rank))[0];if(sideOf(current.seat)!==ownSide&&teamWinning.length)return teamWinning.sort((a,b)=>power(m,{seat:i,card:b},m.trick.concat([{seat:i,card:b}]))-power(m,{seat:i,card:a},m.trick.concat([{seat:i,card:a}])))[0];if(sideOf(current.seat)===ownSide){const safe=legal.filter(card=>sideOf(winnerWith(card).seat)===ownSide);if(safe.length)return low(safe)}}
 return low(legal)
}
function botAction(m,room){
  if(!m||m.phase==="result")return;
  m.botLevel=3;const i=m.active,p=m.seats[i];
  if(!p?.bot)return;
  m.lastBot=Date.now();
  if(m.phase==="auction"){botAuctionBid(m,i,room);return}
  if(m.phase==="call"){
    const forceSolo=isSoloForcedInMatch(m);
    if(forceSolo){const hand=p.hand;const chosen=hand.slice().sort((a,b)=>RANKS.indexOf(a.rank)-RANKS.indexOf(b.rank))[0];callCard(m,i,chosen.suit,chosen.rank,room)}
    else{const x=chooseBotCall(p.hand,m.kitty,m.contract.suit,m.botLevel||2,m.contract.num);if(x)callCard(m,i,x.suit,x.rank,room)}
    return;
  }
  if(m.phase==="discard"){const hand=p.hand.slice(),value=c=>RANKS.indexOf(c.rank)+(c.suit===m.contract.suit?3:0);if(m.botLevel===1)hand.sort(()=>Math.random()-.5);else hand.sort((a,b)=>value(a)-value(b));const drop=hand.slice(0,2).map(x=>x.id);discardCards(m,i,drop,room);return}
  if(m.phase==="play"){
    const legal=legalCards(m,i),level=m.botLevel||2,low=cards=>cards.slice().sort((a,b)=>power(m,{seat:i,card:a},m.trick.length?m.trick.concat([{seat:i,card:a}]):[{seat:i,card:a}])-power(m,{seat:i,card:b},m.trick.length?m.trick.concat([{seat:i,card:b}]):[{seat:i,card:b}]))[0],napSide=i===m.contract.nap||m.contract.revealedCall&&i===m.contract.deputy||!m.contract.revealedCall&&!m.contract.solo&&m.contract.call&&p.hand.some(c=>c.id===m.contract.call.id),napPoints=m.seats.reduce((n,player,seat)=>n+(seat===m.contract.nap||!m.contract.solo&&seat===m.contract.deputy?player.points:0),0),alliancePoints=m.seats.reduce((n,player,seat)=>n+(seat!==m.contract.nap&&(m.contract.solo||seat!==m.contract.deputy)?player.points:0),0),isDeputy=i===m.contract.deputy&&!m.contract.solo,calledLead=isDeputy&&m.trick.length>0&&m.trick[0].seat===m.contract.nap&&(m.trick[0].card.suit===m.contract.call?.suit||m.contract.suit!=="NT"&&m.trick[0].card.suit===m.contract.suit);let c;
    if(calledLead)c=chooseBotDeputyPlay(m,i,legal);
    if(!c&&level>=2&&napSide&&m.contract.num<20&&napPoints>=m.contract.num&&alliancePoints===0){if(!m.trick.length)c=low(legal);else{const safe=legal.filter(x=>bestEntry(m,m.trick.concat([{seat:i,card:x}])).seat!==i);c=low(safe.length?safe:legal)}}
    if(!c&&isDeputy)c=chooseBotDeputyPlay(m,i,legal);
    if(!c&&level===1)c=legal[Math.floor(Math.random()*legal.length)];
    else if(!c&&!m.trick.length){
      const leadValue=card=>RANKS.indexOf(card.rank)+(card.suit===m.contract.suit?3:0)+(card.rank==="A"?3:card.rank==="K"?1:0)+p.hand.filter(x=>x.suit===card.suit).length*.25;
      const safeH=legal.filter(card=>{if(card.rank!=="A")return true;if(card.id==="♠A")return true;return isSafeToCashAceInMatch(m,card.suit,i)});
      const candidates=safeH.length?safeH:legal;
      c=candidates.slice().sort((a,b)=>leadValue(b)-leadValue(a))[0];
    }
    else if(!c){const winning=legal.filter(card=>bestEntry(m,m.trick.concat([{seat:i,card}])).seat===i),current=bestEntry(m,m.trick).seat,points=m.trick.filter(x=>["10","J","Q","K","A"].includes(x.card.rank)).length,team=seat=>seat===m.contract.nap?"nap":m.contract.revealedCall?seat===m.contract.deputy?"nap":"alliance":m.seats[seat].hand.some(card=>card.id===m.contract.call.id)?"nap":"alliance",teammate=team(i)===team(current);if(teammate){const safe=legal.filter(card=>bestEntry(m,m.trick.concat([{seat:i,card}])).seat!==i);c=low(safe.length?safe:legal)}else if(winning.length&&(points>0||m.trick.length===4))c=low(winning);else c=low(legal)}
    playCard(m,i,c.id,room,null)
  }
}
function nextRound(m,room){if(m.phase!=="round-result")return;m.round++;m.mult=1;m.redraws=0;deal(m);publish(m,room)}
async function processAction(conn,msg,room,env){const id=connMatch.get(conn.id),m=id&&matches.get(id);if(!m)return;const seat=m.seats.findIndex(s=>s.connId===conn.id);if(seat<0)return;const a=msg.action||{};if(a.type==="appeal")return answerAppealOffer(m,seat,true,room);if(a.type==="skip-appeal")return answerAppealOffer(m,seat,false,room);if(a.type==="appeal-declare")return answerAppealResponse(m,seat,"declare",room);if(a.type==="appeal-stand")return answerAppealResponse(m,seat,"stand",room);if(a.type==="next-round")return nextRound(m,room);if(a.type==="auction-activity"){if(m.phase==="auction"&&m.auction.active.includes(seat)){m.auction.lastAction[seat]=Date.now();m.auction.autoApprove[seat]=false}return}if(a.type==="confirm-call"){if(m.phase!=="call-reveal"||m.contract.ready[seat])return;m.contract.ready[seat]=true;if(m.contract.ready.every((ready,i)=>ready||m.seats[i].bot))startPlay(m,room);else{m.notice="指名カードの確認中です。";publish(m,room)}return}if(a.type==="approve"||a.type==="pass")doApprove(m,seat,room);else if(a.type==="bid")doBid(m,seat,Number(a.num),a.suit,room);else if(a.type==="call")callCard(m,seat,a.suit,a.rank,room);else if(a.type==="discard")discardCards(m,seat,a.cards,room);else if(a.type==="play")playCard(m,seat,a.card,room,env)}
async function saveEnd(m,room,env){await finish(m,room,env)}
function timeoutAction(m,room){const i=m.active,p=m.seats[i];if(m.phase==="call"){const forceSolo=isSoloForcedInMatch(m);if(forceSolo){const chosen=p.hand.slice().sort((a,b)=>RANKS.indexOf(a.rank)-RANKS.indexOf(b.rank))[0];if(chosen)callCard(m,i,chosen.suit,chosen.rank,room)}else{const c=shuffledDeck().find(x=>!p.hand.some(h=>h.id===x.id)&&!m.kitty.some(k=>k.id===x.id));if(c)callCard(m,i,c.suit,c.rank,room)}}else if(m.phase==="discard"){const ids=p.hand.slice().sort((a,b)=>RANKS.indexOf(a.rank)-RANKS.indexOf(b.rank)).slice(0,2).map(x=>x.id);discardCards(m,i,ids,room)}else if(m.phase==="play"){const c=legalCards(m,i).slice().sort((a,b)=>RANKS.indexOf(a.rank)-RANKS.indexOf(b.rank))[0];if(c)playCard(m,i,c.id,room,null)}}
export const room={tickMs:500,async onConnect(conn,room){if(conns.size>=180){conn.close(4003,"Room capacity reached");return}conns.set(conn.id,conn);sendSafe(conn,{type:"connected"});const presence={type:"presence",count:conns.size};sendSafe(conn,presence);room.broadcast(presence,{except:[conn.id]})},async onMessage(conn,raw,room,env){let msg;try{msg=typeof raw==="string"?JSON.parse(raw):raw}catch{return}
 if(msg.type==="join"){
   if(msg.sessionToken){
     const sess=await env.DB.prepare("SELECT user_id FROM sessions WHERE token=? AND expires_at>?").bind(msg.sessionToken,Date.now()).first();
     if(sess)conn.authUserId=sess.user_id;
   }
   const mode=msg.mode==="ranked"?"ranked":"friend";
   if(mode==="ranked"&&conn.authUserId&&rankedUsers.has(conn.authUserId)){sendSafe(conn,{type:"room-error",message:"このアカウントはすでに待機中または対戦中です"});return}
   if(mode==="ranked"&&conn.authUserId)rankedUsers.set(conn.authUserId,conn.id);
   if(connMatch.has(conn.id)){if(mode==="ranked"&&conn.authUserId&&rankedUsers.get(conn.authUserId)===conn.id)rankedUsers.delete(conn.authUserId);return}
   let player;try{player=await getProfile(env,conn)}catch(error){if(mode==="ranked"&&conn.authUserId&&rankedUsers.get(conn.authUserId)===conn.id)rankedUsers.delete(conn.authUserId);sendSafe(conn,{type:"room-error",message:"プレイヤー情報を確認できませんでした。再度お試しください"});return}
   if(!conns.has(conn.id)){if(mode==="ranked"&&conn.authUserId&&rankedUsers.get(conn.authUserId)===conn.id)rankedUsers.delete(conn.authUserId);return}
   const entry={id:conn.id,player,conn,joined:Date.now(),code:String(msg.code||"").toUpperCase().slice(0,8),bots:Math.max(1,Math.min(4,Number(msg.bots)||4)),botLevel:Math.max(1,Math.min(3,Math.floor(Number(msg.botLevel)||2)))};
   if(mode==="ranked"){queues.ranked.push(entry);queues.ranked.sort((a,b)=>a.joined-b.joined);sendSafe(conn,{type:"lobby",text:"対戦相手を検索中 · "+queues.ranked.length+"/5人"});if(queues.ranked.length>=5)beginMatch("ranked","",queues.ranked.splice(0,5),room);return}
   if(!entry.code)entry.code=makeCode();
   let l=friendRooms.get(entry.code);
   if(!l){l={code:entry.code,host:conn.id,bots:entry.bots,botLevel:entry.botLevel,players:[],created:Date.now()};friendRooms.set(entry.code,l)}
   if(l.players.some(x=>x.id===conn.id||player.userId&&x.player.userId===player.userId)){sendSafe(conn,{type:"room-error",message:"このプレイヤーはすでに部屋にいます"});return}
   const cap=Math.max(1,5-l.bots);
   if(l.players.length>=cap){sendSafe(conn,{type:"room-error",message:"この部屋は満員です"});return}
   l.players.push(entry);
   l.players.forEach(x=>sendSafe(x.conn,{type:"friend-lobby",code:l.code,count:l.players.length,capacity:cap,bots:l.bots,host:x.id===l.host}));
   sendSafe(conn,{type:"lobby",text:"合言葉 "+l.code+" · "+l.players.length+"/"+cap+"人"});
   if(l.players.length>=cap){friendRooms.delete(l.code);beginMatch("friend",l.code,l.players,room)}
   return;
 }
 if(msg.type==="cancel-queue"){const queueIndex=queues.ranked.findIndex(x=>x.id===conn.id);if(queueIndex>=0){queues.ranked.splice(queueIndex,1);if(conn.authUserId&&rankedUsers.get(conn.authUserId)===conn.id)rankedUsers.delete(conn.authUserId)}sendSafe(conn,{type:"queue-cancelled"});return}
 if(msg.type==="game")return processAction(conn,msg,room,env);
 },async onTick(room,env){const now=Date.now(),rankedQueue=queues.ranked;if(rankedQueue.length&&now-rankedQueue[rankedQueue.length-1].joined>=90000){const group=rankedQueue.splice(0,Math.min(4,rankedQueue.length));beginMatch("ranked","",group,room)}for(const [c,l] of friendRooms)if(now-l.created>900000)friendRooms.delete(c);for(const m of matches.values()){if(m.phase==="prep"&&now>=m.deadline){const rule=m.round>=10?finalAuctionRule(m.matchScores,m.mult):null;m.phase="auction";m.auction={active:rule?rule.eligible:[0,1,2,3,4],minBid:rule?.minBid||13,high:{num:12,suit:"",player:-1},version:0,startedAt:now,lastAction:Array(5).fill(now),autoApprove:Array(5).fill(false),botBids:Array(5).fill(0),botSeen:Array(5).fill(-1),botAt:m.seats.map(()=>now+500+Math.random()*2200),requiredBidSeat:null};m.active=-1;m.deadline=0;if(rule){m.appeal={bottomSeat:rule.bottomSeat,fourthSeat:rule.fourthSeat};m.appealInfo="";m.phase="appeal-offer";m.active=rule.bottomSeat;m.deadline=now+30000;m.notice="5位は4位にJ・マイティの所持を尋ねられます。";publish(m,room);if(m.seats[rule.bottomSeat].bot)answerAppealOffer(m,rule.bottomSeat,true,room)}else{m.appeal=null;m.appealInfo="";m.notice="競り開始です。宣言するか、承認して競りを降りてください。";publish(m,room)}}else if(m.phase==="appeal-offer"){if(now>=m.deadline)answerAppealOffer(m,m.appeal.bottomSeat,false,room)}else if(m.phase==="appeal-response"){if(m.seats[m.active]?.bot)answerAppealResponse(m,m.active,"declare",room);else if(now>=m.deadline)answerAppealResponse(m,m.active,"stand",room)}else if(m.phase==="auction"){for(const seat of m.auction.active.slice()){if(!m.seats[seat].bot&&!m.auction.autoApprove[seat]&&now-(m.auction.lastAction[seat]||m.auction.startedAt)>=30000)doApprove(m,seat,room,true);if(m.phase!=="auction")break}for(let seat=0;seat<m.seats.length&&m.phase==="auction";seat++){if(m.seats[seat].bot&&m.auction.active.includes(seat)&&m.auction.botSeen[seat]<m.auction.version&&now>=m.auction.botAt[seat])botAuctionBid(m,seat,room)}}else if(m.phase==="call-reveal"){if(now>=m.deadline)startPlay(m,room)}else if(m.phase==="call"||m.phase==="discard"||m.phase==="play"){if(m.seats[m.active]?.bot&&now-m.lastBot>850)botAction(m,room);else if(m.deadline&&now>=m.deadline){m.notice="持ち時間が切れたため、自動で進行します。";timeoutAction(m,room)}}else if(m.phase==="round-result"&&now>=m.deadline){nextRound(m,room)}else if(m.phase==="trick-end"&&now>=m.deadline){if(m.earlyFinish){await saveEnd(m,room,env);continue}m.trickNo++;if(m.trickNo>=10)await saveEnd(m,room,env);else{m.trick=[];m.phase="play";m.deadline=Date.now()+30000;m.notice="次の勝負です。";publish(m,room);if(m.seats[m.active].bot)botAction(m,room)}}else if(m.phase==="redeal"&&now>=m.deadline){deal(m);publish(m,room)}}},async onClose(conn,room){const id=connMatch.get(conn.id);conns.delete(conn.id);queues.ranked.splice(0,queues.ranked.length,...queues.ranked.filter(x=>x.id!==conn.id));const uid=conn.authUserId||conn.userId;if(uid&&rankedUsers.get(uid)===conn.id)rankedUsers.delete(uid);for(const [c,l] of friendRooms){l.players=l.players.filter(x=>x.id!==conn.id);if(!l.players.length)friendRooms.delete(c)}connMatch.delete(conn.id);if(id){const m=matches.get(id);if(m){const s=m.seats.find(x=>x.connId===conn.id);if(s){s.bot=true;s.connId=null;s.player.username="COM";s.player.playerId="COM";if(m.kind==="ranked")s.player.userId=null}publish(m,room)}}const presence={type:"presence",count:conns.size};room.broadcast(presence)}};
