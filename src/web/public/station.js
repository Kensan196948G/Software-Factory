(function(){
'use strict';
/* ===================== 基本ユーティリティ ===================== */
const KEY='sf-station-v1';
const OSRM=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
let RM=OSRM,CFGX=null;
const MSF_ON=!!(window.__MSF__||document.getElementById('msf-boot'));
try{const c0=JSON.parse(localStorage.getItem(KEY+'-settings')||'null');if(c0&&c0.motion==='reduce'){RM=true;document.documentElement.classList.add('rm')}}catch(e){}
const $=(s,el)=>(el||document).querySelector(s);
const $$=(s,el)=>Array.from((el||document).querySelectorAll(s));
const E=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad=(n,l)=>String(n).padStart(l||2,'0');
const nowISO=()=>new Date().toISOString();
function fmt(iso,withTime){if(!iso)return '';const d=new Date(iso);if(isNaN(d))return String(iso);const s=d.getFullYear()+'/'+pad(d.getMonth()+1)+'/'+pad(d.getDate());return withTime===false?s:s+' '+pad(d.getHours())+':'+pad(d.getMinutes())}
function fmtS(iso){if(!iso)return '-';const d=new Date(iso);if(isNaN(d))return String(iso);return pad(d.getMonth()+1)+'/'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes())}
const lines=t=>String(t||'').split(/\r?\n/).map(s=>s.replace(/^\s*[-・●]\s*/,'').trim()).filter(Boolean);
const br=t=>E(t).replace(/\n/g,'<br>');

/* ===================== アイコン（インラインSVG・外部依存なし） ===================== */
const ICONS={
 dash:'<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
 inbox:'<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
 bot:'<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4.5"/><circle cx="12" cy="3.5" r="1"/><path d="M9 13v2M15 13v2"/><path d="M2 13v3M22 13v3"/>',
 users:'<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',
 user:'<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
 wrench:'<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
 doc:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>',
 shieldok:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
 shield:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4M12 16h.01"/>',
 db:'<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>',
 cpu:'<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>',
 audit:'<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4M12 16h4M8 11h.01M8 16h.01"/>',
 check:'<path d="M20 6 9 17l-5-5"/>',
 x:'<path d="M18 6 6 18M6 6l12 12"/>',
 alert:'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><path d="M12 9v4M12 17h.01"/>',
 clock:'<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
 search:'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
 sparkles:'<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 3v4M17 5h4M5 17v4M3 19h4"/>',
 send:'<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',
 download:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
 upload:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
 reset:'<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
 copy:'<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
 monitor:'<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
 help:'<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
 arrow:'<path d="M5 12h14M12 5l7 7-7 7"/>',
 back:'<path d="M19 12H5M12 19l-7-7 7-7"/>',
 info:'<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
 lock:'<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
 trend:'<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>',
 sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
 moon:'<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
 logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
 login:'<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
 undo:'<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
 msg:'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
 globe:'<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
 layers:'<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
 activity:'<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
 zap:'<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
 target:'<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
 tag:'<path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><path d="M7 7h.01"/>',
 list:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
 eye:'<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
 calendar:'<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
 helmet:'<path d="M2 18a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v2z"/><path d="M10 10V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5"/><path d="M4 15v-3a6 6 0 0 1 6-6"/><path d="M14 6a6 6 0 0 1 6 6v3"/>',
 board:'<rect x="3" y="3" width="5" height="18" rx="1.5"/><rect x="10" y="3" width="5" height="12" rx="1.5"/><rect x="17" y="3" width="4" height="8" rx="1.5"/>',
 stamp:'<path d="M5 22h14"/><path d="M19.27 13.73A2.5 2.5 0 0 0 17.5 13h-11A2.5 2.5 0 0 0 4 15.5V17a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1.5c0-.66-.26-1.3-.73-1.77z"/><path d="M14 13V8.5C14 7 15 7 15 5a3 3 0 0 0-6 0c0 2 1 2 1 3.5V13"/>',
 gauge:'<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
 flag:'<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
 edit:'<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
 trash:'<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
 box:'<path d="M21 8v8a2 2 0 0 1-1 1.73l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.73l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
 bug:'<rect x="8" y="6" width="8" height="14" rx="4"/><path d="M9 6a3 3 0 0 1 6 0"/><path d="M4 13h4M16 13h4M5 7l3 2M19 7l-3 2M5 20l3-2M19 20l-3-2M12 11v9"/>',
 play:'<path d="m6 3 14 9-14 9z"/>',
 pause:'<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
 factory:'<path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/><path d="M17 18h1M12 18h1M7 18h1"/>',
 gear:'<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M2 12h3M19 12h3M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12"/>',
 truck:'<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
 ruler:'<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0z"/><path d="m14.5 12.5 2-2M11.5 9.5l2-2M8.5 6.5l2-2M17.5 15.5l2-2"/>',
 yen:'<circle cx="12" cy="12" r="10"/><path d="m8 7 4 6 4-6"/><path d="M12 13v5M9 13h6M9 16h6"/>',
 calc:'<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8"/><path d="M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>',
 compass:'<circle cx="12" cy="5" r="2"/><path d="m12 7 7.5 13M12 7 4.5 20"/><path d="M5.5 16.5a12 12 0 0 0 13 0"/>',
 briefcase:'<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><path d="M2 13h20"/>',
 mega:'<path d="m3 11 18-5v12L3 14z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
 loop:'<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
 grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
 clip:'<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
 pin:'<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
 code:'<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>'
};
const I=(n,c)=>`<svg class="ico${c?' '+c:''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]||ICONS.info}</svg>`;

/* ===================== 部署別 道具カタログ ===================== */
const CATALOG_FALLBACK=[
 {id:'keiei',short:'経営企画',name:'経営企画部',icon:'gauge',color:'#3b82f6',role:'会社のかじ取り役。数字を見て、進む方向を決める',tools:[
  ['経営ダッシュボード','受注・売上・利益・人員を1つの画面でひと目で見られる','g',1],
  ['会議の議事録まとめ','会議の録音から、決まったことと宿題を整理する','g'],
  ['公共事業・業界の情報あつめ','発注の見通しや業界ニュースを集めて、短くまとめる','g'],
  ['中期計画の資料づくり','過去の数字から、計画資料のたたき台を作る','y'],
  ['経審の点数の試算','経営事項審査の点数が、何で上がり下がりするかを試算する（申請内容は人が決める）','y'],
  ['投資・撤退の決定','AIは判断材料を集めるまで。決めるのは経営陣','r']]},
 {id:'eigyo',short:'営業',name:'営業部',icon:'briefcase',color:'#0ea5e9',role:'仕事をとってくる係。お客様と会社をつなぐ',tools:[
  ['入札・発注情報のお知らせ','発注機関の公告を集めて、自社に合いそうな案件を知らせる','g',1],
  ['営業台帳（お客様・案件の管理）','だれと、どの案件を、どこまで話したかを記録する','g'],
  ['過去の実績さがし','似た工事の実績・写真・工事成績をすぐに探せる','g'],
  ['入札参加資格・提出期限の管理','資格の更新日や書類の締切を知らせる','g'],
  ['技術提案書のたたき台','総合評価の技術提案などの下書きを作る','y'],
  ['入札に参加するか・価格の決定','参加の可否と入札価格は、責任者が決める','r']]},
 {id:'sekisan',short:'積算',name:'積算部',icon:'calc',color:'#14b8a6',role:'工事の値段を計算する係',tools:[
  ['社内単価データベースの検索','過去に使った単価や資材価格をすぐに引ける','g',1],
  ['図面からの数量拾いの補助','図面から数量を拾う作業を手伝う（数量は技術者が確認）','y'],
  ['過去工事との見積比べ','似た工事と比べて、大きなズレがある項目を知らせる','y'],
  ['見積書・内訳書づくりの補助','計算結果を決まった様式の書類にまとめる','y'],
  ['積算基準の改定チェック','基準の変わった所を整理して知らせる（読み方は人が判断）','y'],
  ['見積金額の最終決定','いくらで出すかは、責任者が決める','r']]},
 {id:'sekkei',short:'設計・技術',name:'設計・技術部',icon:'compass',color:'#8b5cf6',role:'図面と技術を考える係',tools:[
  ['図面・設計書の版の管理','どれが最新版か一目でわかる保管場所（共通データ環境）','g',1],
  ['技術基準・仕様書の検索','基準書や過去の設計から、必要な所をすぐに探す','g'],
  ['照査チェックリストの書きもれ確認','照査の記入もれや未確認の項目を知らせる','y'],
  ['設計変更の協議資料のたたき台','変更の理由と比較表の下書きを作る','y'],
  ['BIM/CIMモデルの閲覧・干渉の見える化','3Dモデルを見て、ぶつかっていそうな所に印を付ける','y'],
  ['構造計算・設計の合否判断','安全かどうかの判断は、資格を持つ技術者が行う','r']]},
 {id:'koji',short:'工事（現場）',name:'工事部（土木・建築の現場）',icon:'helmet',color:'#f59e0b',role:'現場で工事を進める係',tools:[
  ['工事写真の整理・写真台帳','撮った写真を工種・測点ごとに並べ、台帳づくりを楽にする（圏外でも消えない）','g',1],
  ['作業日報・工事日報','スマホで現場から入力。天候・人員・機械を前日から引き継ぐ','g'],
  ['打合せ簿・協議記録のたたき台','打合せのメモから、決まった様式の記録を作る','y'],
  ['工程表のたたき台・遅れのお知らせ','過去の工事から下書きを作り、遅れそうな所を早めに知らせる','y'],
  ['実行予算と原価の見える化','予算と実際にかかったお金の差を、工種ごとに見る','y'],
  ['3D点群・ドローン写真の閲覧','現場の形を3Dで見る（数量・寸法の確定は技術者）','y'],
  ['施工計画書のたたき台','過去の計画書から下書きを作り、所長が手直しして決める','y'],
  ['仮設・揚重計画の決定','足場やクレーンの計画を決めるのは、責任を持つ技術者','r']]},
 {id:'anzen',short:'安全環境',name:'安全環境部',icon:'shieldok',color:'#ef4444',role:'みんなを守る係。けがと環境への影響をなくす',tools:[
  ['安全パトロール記録','パトロールでの指摘と、直したかどうかを記録する','g'],
  ['産業廃棄物マニフェストの管理','廃棄物の伝票の出し忘れや期限を知らせる','g'],
  ['KY・安全書類の書きもれ確認','空欄や記入もれを知らせるだけ。危険の見積もりは人','y',1],
  ['暑さ指数（WBGT）のお知らせ','気象データから暑さ指数を現場に知らせる（休憩・中止の判断は人）','y'],
  ['ヒヤリハットの集計・傾向','報告を集めて、多い場所・時間・作業を見える化する','y'],
  ['多言語の安全教育資料','外国籍の仲間向けに資料を訳す（訳は必ず人が確認）','y'],
  ['作業中止・立入禁止などの安全判断','現場の安全に関わる決定は、責任者が行う','r']]},
 {id:'hinshitsu',short:'品質管理',name:'品質管理部',icon:'ruler',color:'#10b981',role:'出来ばえを確かめる係',tools:[
  ['検査記録・試験成績の管理','コンクリート試験などの結果を工事ごとに整理する','g',1],
  ['不具合・是正の追跡','見つかった不具合が、直ったかどうかを最後まで追う','g'],
  ['社内検査の日程・立会い調整','検査の予定と、立ち会う人を調整する','g'],
  ['出来形管理の帳票づくり','測った値を帳票へ転記する（判定の確認は技術者）','y'],
  ['電子納品の形式チェック','提出データの形式やファイル名のまちがいを知らせる','y'],
  ['検査の合否判定','合格か不合格かを決めるのは検査員','r']]},
 {id:'kizai',short:'機材',name:'機材部（機械センター）',icon:'truck',color:'#f97316',role:'重機と資材の係',tools:[
  ['重機・機材の予約と空き状況','どの機械が、いつ、どの現場で使えるかがわかる','g',1],
  ['点検・車検・特定自主検査の期限管理','期限が近い機械を知らせ、期限切れは予約できなくする','g'],
  ['資材ヤードの在庫管理','鋼材や仮設材がどこに何本あるかがわかる','g'],
  ['回送（運搬）手配の調整','機械を運ぶトラックの手配を一覧で調整する','g'],
  ['修理履歴と故障の傾向','修理の記録から、故障しやすい機械や時期を見える化する','y'],
  ['機械を使ってよいかの最終判断','点検結果をもとに、使ってよいかは人が決める','r']]},
 {id:'kobai',short:'購買・外注',name:'購買・外注部',icon:'box',color:'#a855f7',role:'協力会社と材料を手配する係',tools:[
  ['協力会社データベース','建設業許可・保険・実績・評価を1か所で管理する','g',1],
  ['協力会社からの書類回収','安全書類（グリーンファイル）などの、出た・出ていないを見える化','g'],
  ['見積の比較表づくり','複数社の見積を同じ形の表に並べる','y'],
  ['注文書・契約書類の作成補助','決まった内容から、注文書の下書きを作る','y'],
  ['出来高・支払いの確認補助','出来高と請求の金額が合っているかを照らし合わせる','y'],
  ['発注先の決定・契約の締結','どこに頼むかと契約は、責任者が決める','r']]},
 {id:'gijutsu',short:'技術開発・ICT',name:'技術開発・ICT推進部',icon:'sparkles',color:'#6366f1',role:'新しい技術を試して、会社に広める係',tools:[
  ['ICT施工の事例・ノウハウ検索','社内のICT施工の事例や失敗談を探せる','g',1],
  ['新技術（NETISなど）の情報あつめ','新しい技術の情報を集めて、短くまとめる','g'],
  ['社内の試行（PoC）の記録と効果','試した技術の結果と、効果の数字を記録する','g'],
  ['3D・点群データの変換と共有','形式のちがう3Dデータを変換して共有しやすくする','y'],
  ['技術論文・発表資料のたたき台','現場の成果から、発表資料の下書きを作る','y'],
  ['新工法を採用するかの決定','現場で使うかどうかは、技術者と責任者が決める','r']]},
 {id:'iji',short:'維持管理',name:'維持管理・アフターサービス部',icon:'loop',color:'#06b6d4',role:'引き渡したあとも見守る係',tools:[
  ['点検記録・損傷写真の管理','点検の結果と写真を、施設・部位ごとに整理する','g',1],
  ['補修履歴の台帳','いつ、どこを、どう直したかを残す','g'],
  ['お客様からの連絡の受付','連絡の内容と、対応がどこまで進んだかを見える化','g'],
  ['保証期間・定期点検のお知らせ','保証の期限や点検の時期が近いことを知らせる','g'],
  ['損傷写真からの「要確認」候補','ひび割れなどがありそうな写真に印を付ける（判断は技術者）','y'],
  ['健全度・補修が必要かの判定','施設の状態の評価は、資格を持つ技術者が行う','r']]},
 {id:'somu',short:'総務・法務',name:'総務・法務部',icon:'doc',color:'#64748b',role:'会社の書類とルールの係',tools:[
  ['規程・マニュアルの検索','「この場合どうする？」を社内規程からすぐに探す','g',1],
  ['許認可の更新期限の管理','建設業許可などの更新日を知らせる','g'],
  ['社内申請・稟議の電子化','紙の申請を desknet\'s NEO / AppSuite の電子申請にする','g'],
  ['文書の保存期間と廃棄の管理','いつまで保存し、いつ廃棄するかを管理する','g'],
  ['契約書の条文チェック補助','ひな形とちがう条文に印を付ける（読み方は法務担当）','y'],
  ['契約の締結・法的な判断','契約してよいか、法律上どうかは人が判断する','r']]},
 {id:'jinji',short:'人事・労務',name:'人事・労務部',icon:'users',color:'#ec4899',role:'人を育て、働き方を守る係',tools:[
  ['勤怠と時間外労働のお知らせ','残業の上限に近づいた人と上司に、早めに知らせる','g',1],
  ['資格・免許の取得と期限の管理','だれが何の資格を持ち、いつ更新かがわかる','g'],
  ['教育・研修の受講記録','受けた研修と、まだ受けていない研修がわかる','g'],
  ['建設キャリアアップシステム（CCUS）の記録整理','就業の記録を集計して、確認しやすくする','g'],
  ['求人票・研修資料のたたき台','求人や研修の資料の下書きを作る（公平な表現か人が確認）','y'],
  ['採用・評価・配置・処分の決定','人に関わる判断はAIに決めさせない。人が責任を持って決める','r']]},
 {id:'keiri',short:'経理・財務',name:'経理・財務部',icon:'yen',color:'#84cc16',role:'お金の出入りの係',tools:[
  ['工事ごとの原価集計','現場の入力から、工事ごとのお金を自動で集計する','g'],
  ['入金・支払いの予定の見える化','いつ、いくら入って、いくら出るかがわかる','g'],
  ['請求書の受け取りと仕訳の候補','届いた請求書を読み取り、仕訳の候補を出す（確定は経理担当）','y',1],
  ['経費精算の書きもれチェック','領収書の不足や、ルールとちがう申請を知らせる','y'],
  ['内部統制（J-SOX）の証跡あつめ','確認に必要な記録を集めて、そろっているか示す','y'],
  ['支払いの承認・決算の確定','お金を払うことと、決算の数字は人が確定する','r']]},
 {id:'it',short:'情報システム',name:'情報システム・DX部',icon:'monitor',color:'#2563eb',role:'ITの道具をそろえ、会社の情報を守る係',tools:[
  ['PC・アカウントの台帳','入社・退社と連動して、PCとアカウントを管理する','g',1],
  ['現場ネットワーク・機器の状態の見える化','現場の通信機器が動いているかを一覧で見る','g'],
  ['ヘルプデスクの受付と一次回答','desknet\'s NEO / AppSuite で受け付け、よくある質問に答える（回答内容は担当が見守る）','y'],
  ['セキュリティ通知の整理','たくさんの警告をまとめ、急ぐものを上に出す','y'],
  ['ソフトウェアファクトリー自体の運用','このラインの検査ルールや権限を管理する','y'],
  ['権限の付与・セキュリティ例外の承認','だれに何の権限を渡すかは、人が承認する','r']]},
 {id:'kansa',short:'内部監査',name:'内部監査・コンプライアンス室',icon:'eye',color:'#7c3aed',role:'ルールが守られているかを確かめる係',tools:[
  ['法令改正のお知らせ','仕事に関係する法令の改正を集めて知らせる','g',1],
  ['監査の指摘のフォロー','指摘された点が、直ったかどうかを追う','g'],
  ['監査の証跡あつめ・チェックリスト','監査に必要な記録を集め、チェックリストを準備する','y'],
  ['規程と実際のずれの候補','規程と実際の記録がちがいそうな所に印を付ける','y'],
  ['内部通報の受付台帳','通報の受付と対応の記録（見られるのは担当者だけ、通報者を守る）','y'],
  ['不正の認定・処分の判断','不正かどうか、どう対応するかは人が判断する','r']]},
 {id:'koho',short:'広報・CSR',name:'広報・CSR',icon:'mega',color:'#e11d48',role:'会社のことを社会に知ってもらう係',tools:[
  ['現場見学会・イベントの申込受付','見学会の申込と参加者の連絡をまとめる','g',1],
  ['写真素材の管理（了解つき）','広報用の写真を、写っている人の了解の有無と一緒に管理する','g'],
  ['広報記事・SNS投稿のたたき台','現場の話題から記事の下書きを作る','y'],
  ['工事のお知らせ文（近隣向け）','近隣の方へのお知らせの下書きを作る（内容は現場と確認）','y'],
  ['環境・CSRデータの集計','CO2や廃棄物の量などを集めて報告用にまとめる','y'],
  ['対外発表・おわびの最終決定','会社として何を発表するかは、責任者が決める','r']]}
];

/* サーバの正本（部署・道具）からカタログを組み立てる。無いときは見本（完全オフライン用）。 */
const DEPT_STYLE={
 keiei:['gauge','#3b82f6'],eigyo:['briefcase','#0ea5e9'],solution:['target','#0891b2'],
 sekkei:['compass','#8b5cf6'],ict:['cpu','#7c3aed'],kaijo:['layers','#0284c7'],
 rikujo:['helmet','#d97706'],senpaku:['globe','#1d4ed8'],kobai:['box','#a855f7'],
 anzen:['shieldok','#ef4444'],hinshitsu:['ruler','#10b981'],iji:['loop','#06b6d4'],
 shiten:['pin','#0f766e'],somu:['doc','#64748b'],jinji:['users','#ec4899'],
 keiri:['yen','#84cc16'],dx:['monitor','#4f46e5'],kansa:['eye','#7c3aed'],koho:['mega','#e11d48']
};
const CATALOG=(()=>{
 const c=window.__SF_CATALOG__;
 if(!c||!Array.isArray(c.departments)||!c.departments.length)return CATALOG_FALLBACK;
 const tools=new Map();
 (c.tools||[]).forEach(t=>{if(!t||!t.deptCode)return;if(!tools.has(t.deptCode))tools.set(t.deptCode,[]);tools.get(t.deptCode).push(t)});
 return c.departments.map(d=>{
  const st=DEPT_STYLE[d.code]||['grid','#64748b'];
  return {id:d.code,short:d.shortName||d.name,name:d.name,icon:st[0],color:st[1],role:d.roleDesc||'',
   tools:(tools.get(d.code)||[]).map(t=>[t.name,t.description,t.signal,!!t.seedCandidate,t.id])};
 });
})();

/* ===================== マスタ ===================== */
const COLORS={g:{l:'青',n:'任せる'},y:{l:'黄',n:'チェック付き'},r:{l:'赤',n:'決めさせない'}};
const RANK={g:0,y:1,r:2};
const STATUSES=[
 {k:'received',l:'受付',flow:1,ic:'inbox',tone:'u',who:'依頼者',wi:'user',cls:'b-acc'},
 {k:'review',l:'内容確認中',flow:1,ic:'search',tone:'h',who:'受付担当',wi:'user',cls:'b-warn',live:1},
 {k:'wait',l:'承認待ち',flow:1,ic:'clock',tone:'h',who:'承認者',wi:'user',cls:'b-warn',live:1},
 {k:'approved',l:'承認済み',flow:1,ic:'stamp',tone:'h',who:'承認者',wi:'shieldok',cls:'b-ok'},
 {k:'dev',l:'実装中',flow:1,ic:'bot',tone:'a',who:'AIが実装',wi:'sparkles',cls:'b-ai',live:1},
 {k:'verify',l:'検証中',flow:1,ic:'shieldok',tone:'a',who:'検査機',wi:'cpu',cls:'b-ai',live:1},
 {k:'field',l:'現場試用',flow:1,ic:'helmet',tone:'s',who:'現場',wi:'pin',cls:'b-ok',live:1},
 {k:'release_wait',l:'公開承認待ち',flow:1,ic:'send',tone:'h',who:'承認者',wi:'shieldok',cls:'b-warn',live:1},
 {k:'done',l:'完了',flow:1,ic:'flag',tone:'s',who:'人が確認',wi:'check',cls:'b-ok'},
 {k:'back',l:'差戻し',flow:0,ic:'undo',tone:'b',cls:'b-bad'},
 {k:'hold',l:'見送り',flow:0,ic:'pause',tone:'n',cls:''},
 {k:'cancel',l:'取消',flow:0,ic:'x',tone:'n',cls:''}
];
const FLOW=STATUSES.filter(s=>s.flow);
const NEXT={received:'review',review:'wait',wait:'approved',approved:'dev',dev:'verify',verify:'field',field:'release_wait',release_wait:'done',back:'received'};
const ROLES=[
 {k:'requester',l:'依頼者',name:'山田 太郎',dept:'koji'},
 {k:'desk',l:'受付担当（IT・DX）',name:'佐藤 花子',dept:'it'},
 {k:'approver',l:'承認者（業務責任者）',name:'鈴木 一郎',dept:'koji'}
];
const APPROVERS=['鈴木 一郎','田中 誠司','松本 綾'];
const KINDS=['新しい道具がほしい','いまある道具を良くしたい','不具合の報告','相談・アイデア'];
const USERS=['現場の担当者','現場所長','現場事務','本社・支店の担当者','協力会社','発注者','経営層'];
const PLACES=['事務所','現場（屋外）','電波の弱い現場','移動中・車内'];
const DATA=[
 {k:'personal',l:'個人情報（名簿・資格・健康など）'},
 {k:'client',l:'発注者から預かった図面・データ'},
 {k:'location',l:'現場の位置情報'},
 {k:'photo',l:'工事写真・検査記録の原本'},
 {k:'money',l:'お金の情報（金額・原価・支払い）'}
];
const PARTIES=['社内のみ','協力会社も使う','発注者も見る'];
const DECIDES=[
 {k:'g',l:'記録・整理・検索・お知らせ',d:'まちがえてもすぐ直せる。人やお金に直接ひびかない'},
 {k:'y',l:'たたき台づくり・比べっこ・見落としチェック',d:'結果は必ず担当者や技術者が見てから使う'},
 {k:'r',l:'合否・金額・契約・人の処遇・安全などを決める',d:'AIに決めさせない。道具は「材料集め・表示」までにする'}
];
const CONSTRAINTS=['いまのログイン方法は変えない','本物のデータを練習用の場所に持ち込まない','写真・記録の原本は加工しない','個人情報は必要な人だけが見られるようにする','電波がなくても入力が消えないようにする'];
const APPROVALS=['データを消す・作り直す変更','ログインや権限の変更','新しい外部サービスとの接続','協力会社・発注者に見せる範囲の変更','提出様式の変更','安全・品質の判定にかかわる変更'];
const FREQ=[{k:'d',l:'毎日',m:20},{k:'w',l:'毎週',m:4},{k:'m',l:'毎月',m:1},{k:'o',l:'ときどき',m:0.3}];
const READY=[{k:5,l:'電子データでそろっている'},{k:3,l:'一部は紙・Excel'},{k:1,l:'紙や人の頭の中'}];
const SPREAD=[{k:5,l:'全社で使えそう'},{k:3,l:'いくつかの部署・現場で使えそう'},{k:1,l:'自分の部署だけ'}];
const VAGUE=['使いやすい','使い易い','見やすい','わかりやすい','分かりやすい','いい感じ','いいかんじ','適切','適宜','なるべく','できるだけ','早く','速く','すばやく','簡単','かんたん','便利','スムーズ','きれい','ちゃんと','しっかり','柔軟','直感的','快適','いろいろ','など'];
const TONE={u:'linear-gradient(135deg,var(--accent),#3b82f6)',a:'linear-gradient(135deg,var(--ai),#8b5cf6)',h:'linear-gradient(135deg,var(--warn),#f59e0b)',s:'linear-gradient(135deg,var(--ok),#22c55e)',n:'linear-gradient(135deg,#475569,#64748b)',b:'linear-gradient(135deg,var(--bad),#f97316)'};
const STEPS=[
 {t:'はじめに',ic:'sparkles',h:'どんな依頼ですか？',d:'近い道具がカタログにあれば選んでください。なくても大丈夫です。'},
 {t:'だれが',ic:'users',h:'だれが・どこで使いますか？',d:'使う人と場所がわかると、合格の条件や信号の色が決めやすくなります。'},
 {t:'困りごと',ic:'msg',h:'いま困っていること・目的',d:'「いま、こうで困っている」「こうなればうれしい」をそのまま書いてください。'},
 {t:'作るもの',ic:'box',h:'作るもの・今回は作らないもの',d:'「作らない」を書いておくと、作りすぎや手戻りを防げます。'},
 {t:'合格の条件',ic:'target',h:'どうなれば合格？',d:'検査機で確かめられるように、数字や「〜できる／〜できない」で書きます。'},
 {t:'データと安全',ic:'shieldok',h:'この道具は何をしますか？',d:'信号の色を決める大事な質問です。「決める」仕事はAIに任せません。'},
 {t:'確認',ic:'stamp',h:'ものさしと最終確認',d:'手間の大きさは参考値です。着手順は別途決めます。'}
];

const statusOf=k=>STATUSES.find(s=>s.k===k)||STATUSES[0];
const deptOf=id=>CATALOG.find(d=>d.id===id);
function toolOf(ref){
 if(!ref)return null;
 for(const dep of CATALOG){for(const t of dep.tools){if(t[4]===ref)return {dept:dep,name:t[0],desc:t[1],c:t[2],id:t[4]}}}
 const p=String(ref).split('|');const dep=deptOf(p[0]);if(!dep)return null;const t=dep.tools[+p[1]];
 return t?{dept:dep,name:t[0],desc:t[1],c:t[2],id:t[4]}:null;
}
const roleOf=k=>ROLES.find(r=>r.k===k)||ROLES[0];

/* ===================== 業務ロジック（信号・ものさし・合格条件・権限・注文書） ===================== */
function judge(r){
 const reasons=[];let c='g';
 const up=(to,why)=>{if(RANK[to]>RANK[c])c=to;reasons.push({c:to,t:why})};
 if(r.decides)up(r.decides,r.decides==='r'?'「決める」仕事が入っています。AIに決めさせない範囲です':r.decides==='y'?'たたき台・チェックの道具は、担当者の確認が必要です':'記録・整理・お知らせの道具です');
 const tool=toolOf(r.toolRef);
 if(tool&&tool.c!=='g')up(tool.c,'カタログ上の色が「'+COLORS[tool.c].l+'」の道具です');
 (r.data||[]).forEach(k=>{const d=DATA.find(x=>x.k===k);if(d)up('y',d.l+'を扱います')});
 if(r.parties&&r.parties!=='社内のみ')up('y','社外の人（'+r.parties.replace('も使う','').replace('も見る','')+'）が関わります');
 if((r.approvals||[]).includes('安全・品質の判定にかかわる変更'))up('y','安全・品質の判定にかかわります');
 if(!reasons.length)reasons.push({c:'g',t:'まだ判定材料がありません（「この道具は何をしますか」を選んでください）'});
 return {c,reasons};
}
function measure(r){
 const f=FREQ.find(x=>x.k===r.freq);
 const people=Math.max(0,+r.people||0),minutes=Math.max(0,+r.minutes||0);
 const hours=f?Math.round(people*f.m*minutes/60*10)/10:0;
 const band=(v,cuts)=>{let s=1;cuts.forEach((x,i)=>{if(v>=x)s=i+2});return Math.min(s,5)};
 const j=judge(r);
 const scores=[
  {k:'people',l:'困っている人の多さ',v:people?band(people,[3,10,30,100]):0},
  {k:'signal',l:'青信号か',v:r.decides?({g:5,y:3,r:1})[j.c]:0},
  {k:'hours',l:'手間の減り方',v:hours?band(hours,[5,20,50,150]):0},
  {k:'ready',l:'データがそろっているか',v:+r.dataReady||0},
  {k:'spread',l:'ほかに広げられるか',v:+r.spread||0}
 ];
 return {hours,scores};
}
function lint(text){
 const t=String(text||'').trim();
 if(!t)return {ok:false,level:'empty',words:[],tip:''};
 if(/〇〇|△△|○○/.test(t))return {ok:false,level:'vague',words:['〇〇'],tip:'「〇〇」「△△」の所を、自分の言葉に書きかえてください。'};
 const words=VAGUE.filter(w=>t.includes(w));
 if(words.length)return {ok:false,level:'vague',words,tip:'「'+words.join('」「')+'」は人によって受け取り方がちがうため、検査機で合否を決められません。数字や「〜できる／〜できない」で書いてみましょう。'};
 if(t.length<8)return {ok:false,level:'short',words:[],tip:'もう少し具体的に書きましょう（だれが・何を・どうなれば合格か）。'};
 return {ok:true,level:'ok',words:[],tip:'検査で確かめられる書き方です。'};
}
function markVague(text){let h=E(text);VAGUE.slice().sort((a,b)=>b.length-a.length).forEach(w=>{h=h.split(E(w)).join('<mark class="vague">'+E(w)+'</mark>')});return h}
function canMove(role,from,to){
 if(from===to)return false;
 if(role==='approver')return true;
 if(role==='desk')return !['approved','done'].includes(to)&&from!=='done';
 if(role==='requester')return (from==='back'&&to==='received')||(['received','back'].includes(from)&&to==='hold');
 return false;
}
function canEdit(role,r){return role!=='requester'?r.status!=='done':['received','back'].includes(r.status)}
function preflight(r){
 const crit=(r.criteria||[]).filter(x=>String(x).trim()),bad=crit.filter(c=>!lint(c).ok),out=lines(r.outScope),j=judge(r);
 const sens=(r.data||[]).length>0||(r.parties&&r.parties!=='社内のみ');
 const ap=(r.approvals||[]).length;
 const mz=(+r.people>0)&&r.freq&&(+r.minutes>0);
 return [
  {ok:crit.length>0&&!bad.length,s:'合格条件 '+(crit.length-bad.length)+'/'+crit.length,t:!crit.length?'合格の条件がありません':bad.length?`合格の条件 ${crit.length}件のうち ${bad.length}件が、検査で確かめにくい書き方です`:`合格の条件 ${crit.length}件は、検査で確かめられる書き方です`},
  {ok:out.length>0,s:'作らない '+out.length+'件',t:out.length?`「今回は作らない」が ${out.length}件 書かれています`:'「今回は作らない」が空です（作りすぎ・手戻りのもと）'},
  {ok:j.c!=='r',s:j.c==='r'?'赤信号あり':'赤信号なし',t:j.c==='r'?'赤信号の範囲（AIに決めさせない仕事）が含まれています':'赤信号の範囲は含まれていません'},
  {ok:!sens||ap>0,s:'人に聞く '+ap+'件',t:sens?(ap?`注意が必要な情報・社外の関係者あり。「必ず人に聞くこと」は ${ap}件 設定済みです`:'注意が必要な情報・社外の関係者があるのに「必ず人に聞くこと」が未設定です'):(ap?`「必ず人に聞くこと」は ${ap}件 設定済みです`:'注意が必要な情報・社外の関係者はありません')},
  {ok:!!mz,s:mz?'ものさし 入力済':'ものさし 未入力',t:mz?'ものさし（人数・頻度・手間）が入力されています':'ものさしが未入力です（効果を見積もれません）'}
 ];
}
function q(s){return '"'+String(s==null?'':s).replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\r?\n/g,' ')+'"'}
function ylist(key,arr,ind){ind=ind||'';if(!arr||!arr.length)return ind+key+': []\n';return ind+key+':\n'+arr.map(x=>ind+'  - '+q(x)).join('\n')+'\n'}
function toYAML(r){
 const j=judge(r),m=measure(r),d=deptOf(r.dept),tool=toolOf(r.toolRef);
 const dataL=(r.data||[]).map(k=>(DATA.find(x=>x.k===k)||{}).l).filter(Boolean);
 const f=FREQ.find(x=>x.k===r.freq);
 let y='';
 y+='id: '+q(r.id)+'\n';
 y+='title: '+q(r.title)+'\n';
 y+='kind: '+q(r.kind)+'\n';
 y+='department: '+q(d?d.name:'')+'\n';
 y+='catalog_tool: '+q(tool?tool.name:'カタログ外')+'\n';
 y+='requested_by: '+q(r.applicant)+'\n';
 y+='approver: '+q(r.approver)+'\n';
 y+='status: '+q(statusOf(r.status).l)+'\n';
 y+='signal:\n  suggested: '+q(COLORS[j.c].l)+'\n  decided: '+q(r.signalFinal?COLORS[r.signalFinal].l:'未決定（承認者が決める）')+'\n';
 y+='\n'+ylist('problem',lines(r.problem));
 y+=ylist('purpose',lines(r.purpose));
 y+=ylist('users',r.users);
 y+=ylist('places',r.places);
 y+='\n'+ylist('scope',lines(r.scope));
 y+=ylist('out_of_scope',lines(r.outScope));
 y+='\n'+ylist('acceptance_criteria',(r.criteria||[]).filter(Boolean));
 y+='\n'+ylist('constraints',(r.constraints||[]).concat(lines(r.constraintsOther)));
 y+=ylist('data_handling',dataL.length?dataL:['特別な情報は扱わない']);
 y+='parties: '+q(r.parties||'社内のみ')+'\n';
 y+=ylist('requires_human_approval',r.approvals);
 y+='\nmeasure:  # 参考値。着手順は別途決める\n';
 y+='  people: '+(+r.people||0)+'\n  frequency: '+q(f?f.l:'')+'\n  minutes_per_time: '+(+r.minutes||0)+'\n  est_hours_per_month: '+m.hours+'\n';
 y+='\nrequested_at: '+q(fmt(r.createdAt))+'\nwish_date: '+q(r.wish||'')+'\n';
 return y;
}
function yamlHl(y){
 return y.split('\n').map(l=>{
  const m=l.match(/^(\s*)(- )?(?:([a-z_]+)(:))?(.*)$/);
  if(!m)return E(l);
  let rest=m[5]||'',cm='';
  const ci=rest.indexOf('  # ');
  if(ci>=0&&rest.indexOf('"')<0){cm=rest.slice(ci);rest=rest.slice(0,ci)}
  return E(m[1]||'')+(m[2]?'<span class="y-b">- </span>':'')+(m[3]?'<span class="y-k">'+E(m[3])+'</span>:':'')+(rest?'<span class="'+(/"/.test(rest)?'y-s':'y-n')+'">'+E(rest)+'</span>':'')+(cm?'<span class="y-c">'+E(cm)+'</span>':'');
 }).join('\n');
}
const csvCell=v=>'"'+String(v==null?'':v).replace(/"/g,'""')+'"';
function toCSV(items){
 const head=['受付番号','件名','部署','依頼区分','起票者','信号（候補）','信号（決定）','状態','月あたり削減見込み(h)','受付日時','更新日時'];
 const rows=items.map(r=>{const j=judge(r),m=measure(r),d=deptOf(r.dept);return [r.id,r.title,d?d.name:'',r.kind,r.applicant,COLORS[j.c].l,r.signalFinal?COLORS[r.signalFinal].l:'',statusOf(r.status).l,m.hours,fmt(r.createdAt),fmt(r.updatedAt)].map(csvCell).join(',')});
 return '\ufeff'+head.map(csvCell).join(',')+'\r\n'+rows.join('\r\n');
}
function download(name,text,mime){
 try{const blob=new Blob([text],{type:(mime||'text/plain')+';charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},500);return true}catch(e){return false}
}

/* ===================== 保存（ブラウザ内のみ） ===================== */
let memory=null;
function storageOK(){try{const k='__sf_t';localStorage.setItem(k,'1');localStorage.removeItem(k);return true}catch(e){return false}}
function load(){
 try{const s=localStorage.getItem(KEY);if(s){const d=JSON.parse(s);if(d&&Array.isArray(d.items))return {data:d,persistent:true}}}
 catch(e){return {data:memory||seed(),persistent:false}}
 return {data:seed(),persistent:storageOK()};
}
function save(data){memory=data;try{localStorage.setItem(KEY,JSON.stringify(data));return true}catch(e){return false}}
function nextId(data){data.seq=(data.seq||0)+1;return 'REQ-'+new Date().getFullYear()+'-'+pad(data.seq,4)}
function validImport(o){return o&&Array.isArray(o.items)&&o.items.every(x=>x&&typeof x.id==='string'&&typeof x.title==='string')}
/* ---------- 承認者（サーバ接続時は表示名ではなく利用者IDで選ぶ） ---------- */
const APV=(()=>{
 if(!MSF_ON)return {available:false,reason:'',items:[]};
 const m=window.__MSF__;
 if(!m)return {available:false,reason:'サーバ接続用の画面処理を読み込めませんでした。再読み込みしてください。',items:[]};
 const st=m.approverState;
 if(st&&st.available===true&&Array.isArray(st.items))return {available:true,reason:'',items:st.items};
 return {available:false,reason:String((st&&st.reason)||'承認者一覧を取得できませんでした。'),items:[]};
})();
const APV_BY_ID=new Map(APV.items.map(a=>[a.id,a]));
const APV_DUP=APV.items.reduce((c,a)=>c.set(a.displayName,(c.get(a.displayName)||0)+1),new Map());
function apvLabel(a){
 if(!(APV_DUP.get(a.displayName)>1))return String(a.displayName);
 const dp=a.deptCode?deptOf(a.deptCode):null;
 return a.displayName+'（'+(a.email||(dp?dp.short:a.deptCode)||String(a.id).slice(0,8))+'）';
}
function apvShow(r){const a=MSF_ON&&r.approverUserId?APV_BY_ID.get(String(r.approverUserId)):null;return a?apvLabel(a):(r.approver||'')}
function apvErr(d){
 if(!MSF_ON)return d.approver?'':'承認者を選んでください';
 if(!APV.available)return APV.reason||'承認者一覧を取得できませんでした。画面を再読み込みしてください';
 if(!APV.items.length)return '有効な承認者が登録されていません。管理者に確認してください';
 const id=String(d.approverUserId||'');
 if(!id)return d.approver?'承認者を選び直してください（利用者IDが未設定のため、名前だけでは決められません）':'承認者を選んでください';
 if(!APV_BY_ID.has(id))return '選ばれている承認者は現在利用できません。承認者を選び直してください';
 return '';
}
function apvSelect(d){
 if(!MSF_ON){const L=(CFGX?CFGX.approvers:APPROVERS).slice();if(d.approver&&!L.includes(d.approver))L.push(d.approver);return `<select data-bind="approver">${L.map(a=>`<option${d.approver===a?' selected':''}>${E(a)}</option>`).join('')}</select>`}
 const id=String(d.approverUserId||'');
 if(!APV.available)return '<select data-bind="approverUserId" aria-label="承認者（業務責任者）" disabled><option value="" selected>承認者一覧を取得できません</option></select>';
 if(!APV.items.length)return '<select data-bind="approverUserId" aria-label="承認者（業務責任者）" disabled><option value="" selected>有効な承認者がいません</option></select>';
 return `<select data-bind="approverUserId" aria-label="承認者（業務責任者）">${id&&!APV_BY_ID.has(id)?`<option value="${E(id)}" selected disabled>現在の承認者: ${E(d.approver||'（不明）')}（現在は選択できません）</option>`:''}<option value=""${id?'':' selected'}>${E(!id&&d.approver?'承認者を選択してください（現在: '+d.approver+'／利用者IDが未設定）':'承認者を選択してください')}</option>${APV.items.map(a=>`<option value="${E(a.id)}"${id===a.id?' selected':''}>${E(apvLabel(a))}</option>`).join('')}</select>`;
}
function apvHint(d){
 const e=apvErr(d);
 if(!MSF_ON||!e||(APV.available&&APV.items.length&&!d.approverUserId&&!d.approver))return '信号の色の最終決定と承認を行う人';
 return `<span role="alert" style="color:var(--bad);font-weight:600">${E(e)}</span>`;
}
function bindDraft(d,k,v){
 if(k==='approverUserId'){const a=APV_BY_ID.get(v);d.approverUserId=a?a.id:null;d.approver=a?String(a.displayName):'';return}
 d[k]=v;
}
function blank(role){
 const ro=roleOf(role);
 const a=window.__SF_ACTORS__&&window.__SF_ACTORS__[role];
 const u=window.__MSF__&&window.__MSF__.user;
 const cands=[a&&a.divisionCode,u&&u.deptCode,ro.dept].filter(Boolean);
 const dept=cands.find(c=>CATALOG.some(d=>d.id===c))||(CATALOG[0]?CATALOG[0].id:'keiei');
 return {id:'',createdAt:'',updatedAt:'',applicant:(a?String(a.name):(u?String(u.displayName||ro.name):ro.name)),dept,contact:'',title:'',kind:KINDS[0],toolRef:'',
  problem:'',purpose:'',users:[],people:'',places:[],scope:'',outScope:'',criteria:['','',''],constraints:CONSTRAINTS.slice(0,2),
  constraintsOther:'',data:[],parties:'社内のみ',approvals:[],decides:'',freq:'',minutes:'',dataReady:'',spread:'',
  wish:'',attachments:[],approver:(MSF_ON?'':(CFGX?CFGX.approvers[0]:APPROVERS[0])),approverUserId:null,status:'received',signalFinal:'',history:[],comments:[]};
}

/* ===================== サンプルデータ ===================== */
const SEEDS=[
 {title:'工事写真の圏外保存',dept:'koji',toolRef:'koji|0',kind:'いまある道具を良くしたい',applicant:'山田 太郎',decides:'g',data:['photo'],status:'field',signalFinal:'y',
  problem:'山の中の現場では写真が送れず、事務所に戻ってから整理し直している',purpose:'電波の弱い現場でも写真が消えずに残り、事務所での整理の手間をなくす',
  users:['現場の担当者','現場事務','現場所長'],people:40,places:['現場（屋外）','電波の弱い現場'],scope:'圏外での一時保存\n電波が戻った時の自動送信\n送信済み・未送信の表示',outScope:'発注者システムへの直接提出\n写真の加工・編集',
  criteria:['圏外で撮った写真がアプリを閉じても消えない','電波が戻ると自動で送られ、二重に登録されない','撮影日時・撮影場所の記録をあとから書きかえられない','ほかの現場の写真は見えない'],
  constraints:['写真・記録の原本は加工しない','本物のデータを練習用の場所に持ち込まない','電波がなくても入力が消えないようにする'],approvals:['提出様式の変更'],freq:'d',minutes:15,dataReady:5,spread:5,d0:0},
 {title:'重機・機材の空き状況を見たい',dept:'kizai',toolRef:'kizai|0',kind:'新しい道具がほしい',applicant:'高橋 健',decides:'g',status:'dev',signalFinal:'g',
  problem:'どの重機が空いているか電話で確認しており、現場間で取り合いになる',purpose:'重機・機材の空き状況を、だれでもすぐに見られるようにする',
  users:['現場所長','現場の担当者','本社・支店の担当者'],people:60,places:['事務所','現場（屋外）'],scope:'機械ごとの予約カレンダー\n予約の登録・取り消し\n点検期限切れの機械は予約できない',outScope:'回送トラックの手配\n料金の計算',
  criteria:['同じ機械を同じ時間に二重予約できない','点検期限切れの機械は予約画面に「予約不可」と表示される','予約の変更履歴（だれが・いつ）が残る'],constraints:['いまのログイン方法は変えない'],freq:'d',minutes:10,dataReady:3,spread:5,d0:2},
 {title:'KY記録の書きもれ確認',dept:'anzen',toolRef:'anzen|2',kind:'新しい道具がほしい',applicant:'伊藤 誠',decides:'y',data:['personal'],parties:'協力会社も使う',status:'wait',
  problem:'KY活動記録の空欄や記入もれが、パトロールのときに見つかる',purpose:'提出前に書きもれに気づけるようにする（危険の見積もりは人が行う）',
  users:['現場の担当者','協力会社','現場所長'],people:120,places:['現場（屋外）'],scope:'必須欄の空欄チェック\n作業内容と危険のポイントの未記入の知らせ',outScope:'危険度の自動判定\n作業可否の判断',
  criteria:['必須欄が空のまま提出すると、空欄の項目名が表示される','記入内容の良し悪しは判定しない（空欄のみを知らせる）','協力会社は自社の記録だけが見られる'],
  constraints:['個人情報は必要な人だけが見られるようにする'],approvals:['安全・品質の判定にかかわる変更','協力会社・発注者に見せる範囲の変更'],freq:'d',minutes:5,dataReady:3,spread:5,d0:4},
 {title:'請求書の仕訳候補',dept:'keiri',toolRef:'keiri|2',kind:'新しい道具がほしい',applicant:'渡辺 美咲',decides:'y',data:['money'],status:'review',
  problem:'協力会社からの請求書を手で入力しており、月末に作業が集中する',purpose:'請求書の読み取りと仕訳の候補づくりで入力時間を減らす（確定は経理担当）',
  users:['本社・支店の担当者'],people:8,places:['事務所'],scope:'請求書PDFの読み取り\n工事番号・勘定科目の候補表示',outScope:'支払いの承認\n会計システムへの自動登録',
  criteria:['読み取った金額と請求書の金額が一致しない場合は警告を出す','候補は経理担当が「確定」を押すまで登録されない'],constraints:['本物のデータを練習用の場所に持ち込まない'],approvals:['新しい外部サービスとの接続'],freq:'m',minutes:600,dataReady:3,spread:3,d0:6},
 {title:'残業上限の早めのお知らせ',dept:'jinji',toolRef:'jinji|0',kind:'新しい道具がほしい',applicant:'中村 由紀',decides:'g',data:['personal'],status:'done',signalFinal:'y',
  problem:'時間外労働の上限に近づいていることに、月末まで気づけない',purpose:'本人と上司が早めに気づき、働き方を調整できるようにする',
  users:['現場所長','本社・支店の担当者'],people:300,places:['事務所','現場（屋外）'],scope:'月の途中での残業時間の見える化\n上限の8割を超えたら本人と上司へ知らせる',outScope:'評価や処分への利用',
  criteria:['上限の8割を超えた日の翌朝までに本人と上司へ通知される','本人と上司以外は個人の残業時間を見られない','通知の記録が残る'],constraints:['個人情報は必要な人だけが見られるようにする'],approvals:['ログインや権限の変更'],freq:'w',minutes:10,dataReady:5,spread:5,d0:-10},
 {title:'入札・発注情報のお知らせ',dept:'eigyo',toolRef:'eigyo|0',kind:'新しい道具がほしい',applicant:'小林 大輔',decides:'g',status:'received',
  problem:'発注機関のサイトを毎日見て回っている',purpose:'自社に合いそうな案件だけを毎朝まとめて知らせる',
  users:['本社・支店の担当者'],people:15,places:['事務所'],scope:'公告情報の収集\n工種・地域での絞り込み\n毎朝のお知らせ',outScope:'入札に参加するかの判断',
  criteria:['登録した工種・地域に合う公告が、翌営業日の朝9時までに一覧で届く','元の公告ページへのリンクが付いている'],constraints:['いまのログイン方法は変えない'],approvals:['新しい外部サービスとの接続'],freq:'d',minutes:30,dataReady:5,spread:3,d0:12},
 {title:'見積金額を自動で決めたい',dept:'sekisan',toolRef:'sekisan|5',kind:'相談・アイデア',applicant:'加藤 修',decides:'r',data:['money'],status:'back',
  problem:'見積の作成に時間がかかる',purpose:'見積金額をAIで自動的に決めたい',
  users:['本社・支店の担当者'],people:10,places:['事務所'],scope:'見積金額の自動決定',outScope:'',
  criteria:['いい感じの金額が出る'],constraints:[],approvals:[],freq:'w',minutes:240,dataReady:3,spread:1,d0:8,
  backNote:'金額の決定は赤信号（AIに決めさせない）です。「過去工事との見積比べ（黄）」に範囲を変え、合格の条件を数字で書き直して再提出してください。'},
 {title:'協力会社書類の回収状況',dept:'kobai',toolRef:'kobai|1',kind:'新しい道具がほしい',applicant:'吉田 恵',decides:'g',parties:'協力会社も使う',data:['personal'],status:'verify',signalFinal:'y',
  problem:'安全書類が出たかどうかを、電話とメールで確認している',purpose:'書類の提出状況を一覧で見られるようにする',
  users:['現場事務','協力会社','現場所長'],people:80,places:['事務所','現場（屋外）'],scope:'書類ごとの提出状況の一覧\n未提出の協力会社への連絡文の下書き',outScope:'書類内容の審査',
  criteria:['協力会社は自社の書類と提出状況だけが見られる','未提出の書類が現場ごとに件数で表示される','提出日時が自動で記録される'],constraints:['個人情報は必要な人だけが見られるようにする'],approvals:['協力会社・発注者に見せる範囲の変更'],freq:'w',minutes:60,dataReady:3,spread:5,d0:3}
];
const SAMPLES=[{label:'青：重機の空き状況',ic:'truck',i:1},{label:'黄：KY記録の書きもれ確認',ic:'shieldok',i:2},{label:'赤：見積金額の自動決定',ic:'yen',i:6}];
function seed(){
 const base=Date.now()-13*86400000-2*3600000;
 const at=(day,h)=>new Date(base+day*86400000+(h||0)*3600000).toISOString();
 const H=(day,by,role,action,note,h)=>({at:at(day,h),by,role,action,note:note||''});
 const order=['received','review','wait','approved','dev','verify','field','done'];
 const Y=new Date().getFullYear();
 const items=SEEDS.map((s,i)=>{
  const r=Object.assign(blank('requester'),JSON.parse(JSON.stringify(s)));
  r.id='REQ-'+Y+'-'+pad(i+1,4);
  r.createdAt=at(s.d0,1);r.history=[H(s.d0,s.applicant,'依頼者','受付','依頼を登録しました',1)];
  const upto=s.status==='back'?2:s.status==='hold'?1:order.indexOf(s.status);
  for(let k=1;k<=upto&&k<order.length;k++){
   const st=order[k],who=['approved','done'].includes(st)?ROLES[2]:ROLES[1];
   r.history.push(H(s.d0+k,who.name,who.l,'状態を「'+statusOf(st).l+'」に変更',st==='approved'?'信号の色を「'+COLORS[r.signalFinal||judge(r).c].l+'」に決定':'',2));
  }
  if(s.status==='back'){r.history.push(H(s.d0+3,ROLES[2].name,ROLES[2].l,'状態を「差戻し」に変更',s.backNote,3));r.comments=[{at:at(s.d0+3,3),by:ROLES[2].name,text:s.backNote}]}
  if(s.status==='field')r.comments=[{at:at(s.d0+7,4),by:'山田 太郎',text:'河川敷の現場で試用中。手袋のままでも押しやすいです。'}];
  r.updatedAt=r.history[r.history.length-1].at;
  delete r.d0;delete r.backNote;
  return r;
 });
 return {seq:items.length,items};
}

/* ===================== 状態 ===================== */
const loaded=load();
const S={data:loaded.data,persistent:loaded.persistent,role:(window.__MSF__&&window.__MSF__.initialRole?window.__MSF__.initialRole():'requester'),view:'dash',sel:{},step:0,draft:null,editId:null,dpTab:'card',fq:'',fd:'',fs:'',fc:'',open:null,dtab:'sum',pickDept:'',fresh:null,cat:'koji',catTool:'',catq:'',logq:'',devTab:'line',secTab:'vuln',setTab:'personal',logk:'',cfg:null};
const me=()=>{
 const ro=roleOf(S.role);
 const a=window.__SF_ACTORS__&&window.__SF_ACTORS__[S.role];
 if(a)return Object.assign({},ro,{name:String(a.name||ro.name),dept:String(a.divisionCode||ro.dept),divisionName:String(a.divisionName||''),section:String(a.section||'')});
 const u=window.__MSF__&&window.__MSF__.user;
 if(!u)return ro;
 return Object.assign({},ro,{name:String(u.displayName||ro.name),dept:String(u.deptCode||ro.dept)});
};
const find=id=>S.data.items.find(x=>x.id===id);
/* ---------- 社員名簿（Mirai-Info） ---------- */
const EMP={};let empLoading=false,empLoaded=false;
function empOf(dept){return EMP[dept]||null}
function loadEmployees(){
 if(!window.__MSF__||empLoaded||empLoading)return;
 empLoading=true;
 window.__MSF__.api('GET','/api/mirai/employees').then(res=>{
  const items=(res&&Array.isArray(res.items))?res.items:[];
  items.forEach(e=>{const d=e.divisionCode||'';if(!d)return;(EMP[d]=EMP[d]||[]).push(e)});
  empLoaded=true;
  if(S.view==='new'){const a=document.activeElement;if(!(a&&a.dataset&&a.dataset.bind==='applicant'))renderStepBody()}
 }).catch(()=>{empLoading=false});
}
function applicantField(d){
 const list=empOf(d.dept);
 if(!list||!list.length)return inp('applicant','例：社員名');
 const has=list.some(e=>e.name===d.applicant);
 const cur=has?d.applicant:(d.applicant||list[0].name);
 return `<select data-bind="applicant">${list.map(e=>`<option value="${E(e.name)}"${cur===e.name?' selected':''}>${E(e.name)}${e.section?`（${E(e.section)}）`:''}</option>`).join('')}${has||!cur?'':`<option value="${E(cur)}" selected>${E(cur)}</option>`}</select>`;
}
const colorOf=r=>r.signalFinal||judge(r).c;
const reportedSync=new WeakSet();
function reportSync(res){
 if(!res||reportedSync.has(res))return;
 reportedSync.add(res);
 if(!res.ok)toast(res.error||'保存できませんでした','bad');
 (res.notices||[]).forEach(n=>toast(n.message||n.id+' はサーバ上で「'+statusOf(n.actual).l+'」になっています','bad'));
}
function persist(opts){
 syncLines(S.data);
 if(!save(S.data)&&S.persistent){S.persistent=false;renderNav()}
 if(window.__MSF__)return window.__MSF__.persist(S.data,opts).then(res=>{reportSync(res);return res});
 return Promise.resolve({ok:true,ids:{},notices:[]});
}
let lastView=null,lastSel=null,modalHook=null,confirmFn=null;

/* ===================== 画面部品 ===================== */
function av(n){const s=String(n||'?');let h=0;for(const ch of s)h=(h*31+ch.charCodeAt(0))%360;return `<span class="av" style="--h:${h}" title="${E(s)}">${E(s.trim().slice(0,1))}</span>`}
const avn=n=>`<span class="avn">${av(n)}<span>${E(n)}</span></span>`;
const cico=(id,cls)=>{const d=deptOf(id);return `<span class="cico${cls?' '+cls:''}" style="--cc:${d?d.color:'#64748b'}">${I(d?d.icon:'help')}</span>`};
const sig=c=>c?`<span class="sig ${c}"><i></i>${COLORS[c].l}</span>`:'';
const sb=k=>{const s=statusOf(k);return `<span class="badge ${s.cls}">${s.live?'<i class="dot pulse"></i>':I(s.ic)}${E(s.l)}</span>`};
const light=(on,cls)=>`<div class="light${cls?' '+cls:''}">${['g','y','r'].map(c=>`<span class="${c}${(Array.isArray(on)?on.includes(c):on===c)?' on':''}"></span>`).join('')}</div>`;
function pageHead(ic,title,sub,tone){return `<div class="ph rise"><span class="pic" style="background:${TONE[tone]||TONE.u}">${I(ic,'lg')}</span><div><h1>${title}</h1><p class="sub">${sub}</p></div></div>`}
function flowBar(act){return `<div class="flow rise">${FLOW.map((s,i)=>{const on=act.includes(s.k);return `<span class="fs ${on?'on '+s.tone:''}" data-a="goList" data-v="${s.k}" title="${i+1}. ${s.l}の依頼を一覧で見る"><span class="fi">${I(s.ic)}</span>${i+1}. ${s.l}</span>`}).join('<span class="fa">›</span>')}</div>`}
function ring(v,color){const L=282.74;return `<svg class="ring" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" class="rbg"/><circle cx="50" cy="50" r="45" class="rfg" style="stroke:${color};stroke-dashoffset:${(L*(1-Math.max(0,Math.min(1,v)))).toFixed(2)}"/></svg>`}
const pct=v=>Math.floor(v*100+1e-9);
function emptyBox(ic,text){return `<div class="empty"><div class="eic">${I(ic)}</div>${text}</div>`}
function miniSteps(r){
 const ci=FLOW.findIndex(s=>s.k===r.status),off=ci<0;
 return `<div class="msteps">${FLOW.map((s,i)=>{const c=off?'skip':i<ci?'done':i===ci?(r.status==='done'?'done':'cur'):'';return `<span class="ms ${c}" title="${i+1}. ${s.l}">${c==='done'?I('check'):I(s.ic)}</span>${i<FLOW.length-1?`<i class="ml${!off&&i<ci?' done':''}${!off&&i===ci-1?' go':''}"></i>`:''}`}).join('')}</div>${off?`<div class="hint">${I(statusOf(r.status).ic,'sm')} いまは「${statusOf(r.status).l}」です（通常の流れの外）</div>`:''}`;
}
function auIc(a){
 const m=[['承認待ち','clock','var(--warn)'],['承認済み','stamp','var(--ok)'],['差戻し','undo','var(--bad)'],['見送り','pause','var(--mute)'],['完了','flag','var(--ok)'],['実装中','bot','var(--ai)'],['検証中','shieldok','var(--ai)'],['現場試用','helmet','var(--ok)'],['内容確認中','search','var(--warn)'],['編集','edit','var(--accent)'],['受付','inbox','var(--accent)']].find(x=>String(a).includes(x[0]))||['','activity','var(--mute)'];
 return `<span class="aic" style="--cc:${m[2]}">${I(m[1])}</span>`;
}
/* ---------- 右端パネル（1ページ・スクロールなし）の部品 ---------- */
const SPLIT=['new','review','board','catalog','log','devops','secops','settings'],DOCK=['review','board','log'];
const isNarrow=()=>!!(window.matchMedia&&window.matchMedia('(max-width: 700px)').matches);
/* パネルの中身が高さを超えるときは、全体を縮小して1ページに収める（スクロールさせない） */
function fitScale(el,avail){
 el.style.width='';if(el.offsetHeight<=avail)return 1;
 let lo=.45,hi=1,best=.45;
 for(let i=0;i<9;i++){const k=(lo+hi)/2;el.style.width=(100/k)+'%';if(el.offsetHeight*k<=avail){best=k;lo=k}else hi=k}
 return best;
}
function fitPane(el){
 if(!el)return;el.style.transform='';el.style.width='';el.classList.remove('tight');
 if(isNarrow())return;
 const avail=el.parentElement.clientHeight;if(!avail)return;
 let k=fitScale(el,avail);
 if(k<.9){el.classList.add('tight');k=fitScale(el,avail)}
 if(k<1){el.style.width=(100/k)+'%';el.style.transform='scale('+k+')'}else el.style.width='';
}
const tip=a=>E((a||[]).join(' ／ '));
function capList(a,n,ordered,mark){
 a=a||[];if(!a.length)return '<span class="hint">－</span>';
 const tag=ordered?'ol':'ul';
 return `<${tag}>${a.slice(0,n).map(x=>`<li><span class="cl1" title="${E(x)}">${mark?markVague(x):E(x)}</span></li>`).join('')}</${tag}>${a.length>n?`<div class="more" title="${tip(a.slice(n))}">ほか ${a.length-n}件（注文書タブに全文）</div>`:''}`;
}
const reasonsHTML=j=>`<ul class="reasons c">${j.reasons.slice(0,3).map((x,i)=>`<li style="--i:${i}" title="${E(x.t)}"><span class="lamp ${x.c}"></span><span class="cl1">${E(x.t)}</span></li>`).join('')}</ul>${j.reasons.length>3?`<div class="more" title="${tip(j.reasons.slice(3).map(x=>x.t))}">ほか ${j.reasons.length-3}件の理由</div>`:''}`;
function sigRowHTML(r){
 const j=judge(r),m=measure(r);
 return `<div class="sgrow"><div class="sgl">${light(colorOf(r),'md')}<div style="min-width:0;flex:1"><div class="btns xs"><span class="hint">候補</span>${sig(j.c)}<span class="hint">決定</span>${r.signalFinal?sig(r.signalFinal):'<span class="badge">未決定</span>'}</div>${reasonsHTML(j)}</div></div>
 <div class="sgm"><div class="hint">${I('gauge','sm')} ものさし（参考値）</div><div class="big">${m.hours}<small> 時間／月</small></div>${m.scores.map(s=>`<div class="mb"><span class="cl1">${E(s.l)}</span><div class="meter"><i style="width:${s.v*20}%"></i></div><b>${s.v||'－'}</b></div>`).join('')}</div></div>`;
}
const pfRowHTML=r=>`<div class="pfrow"><span class="pfl" title="受付チェック：ルールによる自動点検です。見落としを知らせるだけで、判断は人が行います">${I('cpu','sm')}</span>${preflight(r).map(p=>`<span class="pfp ${p.ok?'':'ng'}" title="${E(p.t)}">${I(p.ok?'check':'alert')}${E(p.s)}</span>`).join('')}</div>`;
function contentHTML(r){
 const dep=deptOf(r.dept),tl=toolOf(r.toolRef),crit=(r.criteria||[]).filter(x=>String(x).trim());
 const dataL=(r.data||[]).map(k=>(DATA.find(x=>x.k===k)||{}).l).filter(Boolean),cons=(r.constraints||[]).concat(lines(r.constraintsOther));
 const txt=t=>String(t||'').trim()?`<p class="cl2" title="${E(t)}">${E(t)}</p>`:'<p class="hint">（未入力）</p>';
 const mp=(k,v,t)=>`<span class="mp" title="${E(k+'：'+(t||v))}"><b>${k}</b>${E(v)}</span>`;
 const users=(r.users||[]).join('・')+(r.people?'（約'+r.people+'人）':'');
 return `<div class="g2c"><div class="blk"><h5>${I('msg','sm')}困りごと</h5>${txt(r.problem)}</div><div class="blk"><h5>${I('target','sm')}目的</h5>${txt(r.purpose)}</div></div>
 <div class="g2c"><div class="blk"><h5>${I('box','sm')}作るもの</h5>${capList(lines(r.scope),3)}</div><div class="blk"><h5>${I('x','sm')}今回は作らない</h5>${capList(lines(r.outScope),3)}</div></div>
 <div class="blk" style="margin-top:7px"><h5>${I('check','sm')}合格の条件（${crit.length}件）</h5>${capList(crit,4,true,true)}</div>
 <div class="metas">${mp('起票',r.applicant||'－')}${mp('部署',dep?dep.short:'－',dep?dep.name:'')}${mp('区分',r.kind||'－')}${mp('カタログ',tl?tl.name:'カタログ外')}${mp('使う人',users||'－')}${mp('場所',(r.places||[]).join('・')||'－')}${mp('扱う情報',dataL.length?dataL.join('・'):'特になし')}${mp('相手',r.parties||'社内のみ')}${mp('守ること',cons.length+'件',cons.join(' ／ ')||'なし')}${mp('人に聞く',(r.approvals||[]).length+'件',(r.approvals||[]).join(' ／ ')||'なし')}${mp('承認者',apvShow(r)||'－')}${mp('希望',r.wish||'－')}${(r.attachments||[]).length?mp('添付',r.attachments.length+'件',r.attachments.map(a=>a.name).join(' ／ ')):''}</div>`;
}
/* 依頼の詳細パネル（右端固定・ドロワー共通）。全文は「注文書」タブにあります */
function paneDetail(r,overlay){
 const nx=NEXT[r.status],can=k=>canMove(S.role,r.status,k),id=E(r.id);
 const nxL=!nx?'':r.status==='back'?'再提出する':nx==='approved'?'承認する（色を決める）':'「'+statusOf(nx).l+'」へ進める';
 const gate=nx&&!can(nx)?ROLES.filter(x=>canMove(x.k,r.status,nx)):[];
 const cm=r.comments||[],hs=(r.history||[]).slice().reverse(),lastC=cm[cm.length-1];
 let body;
 if(S.dtab==='yaml')body=`<pre class="yaml two">${yamlHl(toYAML(r).trim())}</pre><div class="btns" style="margin-top:8px"><button class="btn ghost sm" data-a="ycopy" data-id="${id}" type="button">${I('copy')}コピー</button><button class="btn ghost sm" data-a="ydl" data-id="${id}" type="button">${I('download')}ダウンロード</button><span class="hint">${I('user','sm')} AIへ渡す前に、人がレビューします</span></div>`;
 else if(S.dtab==='log')body=`<div class="blk"><h5>${I('msg','sm')}コメント（${cm.length}件）</h5>${cm.length?cm.slice(-2).reverse().map(c=>`<div class="cmt">${av(c.by)}<div style="min-width:0;flex:1"><small>${fmtS(c.at)}　${E(c.by)}</small><span class="cl2" title="${E(c.text)}">${E(c.text)}</span></div></div>`).join(''):'<div class="hint">まだありません</div>'}${cm.length>2?`<div class="more">ほか ${cm.length-2}件（古いコメント）</div>`:''}
  <div class="inrow"><input id="ctx" data-id="${id}" placeholder="コメントを入力（Enterで送信）"><button class="btn sm" data-a="comment" data-id="${id}" type="button">${I('send')}送信</button></div></div>
  <div class="blk" style="margin-top:8px"><h5>${I('clock','sm')}変更履歴（${hs.length}件・新しい順）</h5><ul class="tl c">${hs.slice(0,6).map((h,i)=>`<li class="${/差戻し/.test(h.action)?'bad':/承認済み|完了/.test(h.action)?'ok':/実装中|検証中/.test(h.action)?'ai':''}" style="--i:${i}"><b>${E(h.action)}</b><small>${fmtS(h.at)}　${E(h.by)}（${E(h.role)}）</small>${h.note?`<div class="cl1 hint" title="${E(h.note)}">${E(h.note)}</div>`:''}</li>`).join('')}</ul>${hs.length>6?`<button class="btn ghost sm" data-a="logOf" data-id="${id}" type="button">${I('audit')}ほか ${hs.length-6}件を監査ログで見る</button>`:''}</div>`;
 else body=`${r.status==='back'&&lastC?`<div class="note n-bad" style="margin:0 0 8px">${I('undo')}<div class="cl2" title="${E(lastC.text)}"><b>差戻し理由</b>　${E(lastC.text)}</div></div>`:''}${sigRowHTML(r)}${pfRowHTML(r)}${contentHTML(r)}`;
 return `<div class="dp-h">${cico(r.dept,'lg')}<div class="dp-t"><div class="hint"><span class="mono">${id}</span>　更新 ${fmtS(r.updatedAt)}</div><h2 class="cl2" title="${E(r.title)}">${E(r.title)}</h2><div class="btns xs" style="margin-top:3px">${sb(r.status)}${sig(colorOf(r))}${r.signalFinal?'':'<span class="hint">候補</span>'}${avn(r.applicant)}${S.data.devsec&&S.data.devsec.lines[r.id]?`<button class="badge b-ai lk2" data-a="go" data-v="devops" data-id="${id}" type="button" title="DevOps で開発ラインを見る">${I('code')}DevOps</button>`:''}</div></div>${overlay?`<button class="btn ghost sm icon" data-a="closeDrawer" type="button" title="閉じる">${I('x')}</button>`:''}</div>
 ${miniSteps(r)}
 <div class="dp-acts">${nx?`<button class="btn sm ${nx==='approved'?'ok':''}${can(nx)?' ready':''}" data-a="status" data-id="${id}" data-v="${nx}" type="button"${can(nx)?'':' disabled'}>${I(statusOf(nx).ic)}${nxL}</button>`:''}${r.status!=='back'&&r.status!=='hold'?`<button class="btn sm bad" data-a="status" data-id="${id}" data-v="back" type="button"${can('back')?'':' disabled'}>${I('undo')}差戻し</button>`:''}${r.status!=='hold'?`<button class="btn sm ghost" data-a="status" data-id="${id}" data-v="hold" type="button"${can('hold')?'':' disabled'}>${I('pause')}見送り</button>`:''}<span style="flex:1"></span><button class="btn sm ghost icon" data-a="status" data-id="${id}" type="button" title="状態を変更">${I('flag')}</button><button class="btn sm ghost icon" data-a="edit" data-id="${id}" type="button" title="${canEdit(S.role,r)?'編集':'いまの役割・状態では編集できません'}"${canEdit(S.role,r)?'':' disabled'}>${I('edit')}</button><button class="btn sm ghost icon dng" data-a="del" data-id="${id}" type="button" title="${S.role==='requester'?'依頼者は削除できません':'削除'}"${S.role==='requester'?' disabled':''}>${I('trash')}</button></div>
 ${gate.length?`<div class="gatel">${I('lock','sm')}<span>いまの役割（${E(me().l.replace(/（.*）/,''))}）では進められません</span>${gate.map(x=>`<button class="btn sm ghost" data-a="role" data-v="${x.k}" type="button">${I('user')}${E(x.name)}に切り替える</button>`).join('')}</div>`:''}
 <div class="ptabs">${[['sum','概要','inbox'],['yaml','注文書','doc'],['log','コメント・履歴（'+cm.length+'）','clock']].map(t=>`<button type="button" data-a="dtab" data-v="${t[0]}" class="${S.dtab===t[0]?'on':''}">${I(t[2],'sm')}${t[1]}</button>`).join('')}</div>
 <div>${body}</div>`;
}
function catPane(){
 const d=deptOf(S.cat)||CATALOG[0],n={g:0,y:0,r:0};d.tools.forEach(t=>n[t[2]]++);
 const reqN=ref=>S.data.items.filter(r=>r.toolRef===ref).length;
 return `<div class="dp-h" style="align-items:center">${cico(d.id,'lg')}<div class="dp-t"><h2>${E(d.name)}</h2><div class="hint">${E(d.role)}</div></div></div>
 <div class="btns xs" style="margin:10px 0 2px"><span class="hint">${I('grid','sm')} 道具 ${d.tools.length}件</span>${sig('g')}<b>${n.g}</b>${sig('y')}<b>${n.y}</b>${sig('r')}<b>${n.r}</b></div>
 ${d.tools.map((t,j)=>{const ref=t[4]||(d.id+'|'+j),c=t[2],k=reqN(ref);return `<div class="trow ${c}${ref===S.catTool?' on':''}" style="--i:${j}"><span class="lamp ${c}"></span><div style="min-width:0"><b class="cl1" title="${E(t[0])}">${E(t[0])}</b><div class="hint cl2" title="${E(t[1])}">${E(t[1])}</div></div><div class="tr-a">${k?`<span class="badge b-acc" title="この道具の依頼 ${k}件">${I('inbox')}${k}</span>`:''}<button class="btn sm ${c==='r'?'ghost':''}" data-a="useTool" data-v="${ref}" type="button" title="${c==='r'?'赤の道具は相談として依頼します':'この道具で依頼をはじめます'}">${I(c==='r'?'msg':'plus')}${c==='r'?'相談':'依頼'}</button></div></div>`}).join('')}
 <div class="note n-acc" style="margin:10px 0 0">${I('info')}<div>色は目安です。最終的な色は承認者が決めます。赤の道具は「材料集め・表示」までにとどめ、決めるのは人です。</div></div>`;
}
function updPane(){
 const box=$('#rin');if(!box)return;
 if(S.view==='new'){box.innerHTML='';updPreview();return}
 if(S.view==='catalog'){box.innerHTML=catPane();fitPane(box);return}
 if(S.view==='devops'){box.innerHTML=devPane();fitPane(box);return}
 if(S.view==='secops'){box.innerHTML=secPane();fitPane(box);return}
 if(S.view==='settings'){box.innerHTML=setPane();fitPane(box);return}
 if(S.view==='log'&&String(S.sel.log||'').indexOf('A:')===0){const a=S.data.audit.find(x=>'A:'+x.id===S.sel.log)||ra.find(x=>'A:'+x.id===S.sel.log);box.innerHTML=a?auditPane(a):emptyBox('audit','記録を選ぶと、ここに中身が出ます');fitPane(box);return}
 const r=find(S.sel[S.view]);
 box.innerHTML=r?paneDetail(r,false):emptyBox(S.view==='review'?'check':'inbox',S.view==='review'?'確認・承認を待っている依頼はありません':'依頼を選ぶと、ここに要点が1ページで表示されます');
 fitPane(box);
}
function markSel(){const id=S.sel[S.view];$$('#work .kc').forEach(e=>e.classList.toggle('sel',e.dataset.id===id));$$('#work tr.click').forEach(e=>e.classList.toggle('on',e.dataset.id===id))}
function showDetail(id,tab){
 if(!find(id))return;if(tab)S.dtab=tab;
 if(DOCK.includes(S.view)){S.sel[S.view]=id;if(S.view==='review')render();else{updPane();markSel()}}
 else openDrawer(id,tab);
}
function refreshDetail(){if(S.open)renderDrawer();else if(DOCK.includes(S.view))updPane()}

/* ---------- サーバの監査ログ（実行時のみ。依頼の履歴と重ならない種類だけ） ---------- */
let ra=[],raLoaded=false;
const RA_AREA={session:'auth',mail_outbox:'settings',ops_state:'settings',job:'devops',release:'devops'};
const RA_ACT={'session.login':'ログイン','session.login_failed':'ログイン失敗','session.role_switch':'役割を切り替え','ops.save':'設定を保存','mail.enqueue':'メールを送信待ち','mail.sent':'メールを送信','mail.reminder':'リマインダー'};
function serverAudit(){
 if(!window.__MSF__||raLoaded)return;raLoaded=true;
 window.__MSF__.api('GET','/api/audit-logs?limit=300').then(res=>{
  const items=(res&&Array.isArray(res.items))?res.items:[];
  ra=items.filter(a=>a&&a.targetType!=='request').map(a=>({
   id:'SRV-'+a.id,at:a.at,by:a.actor||'',role:rl0(a.role)||a.role||'',
   area:RA_AREA[a.targetType]||'settings',
   action:RA_ACT[a.action]||a.action,
   note:(a.result&&a.result!=='success')?a.result:'',
   ref:a.targetId||''
  }));
  ra.sort((a,b)=>a.at<b.at?1:-1);
  if(S.view==='log'){if(AFTER.log)AFTER.log();if(String(S.sel.log||'').indexOf('A:')===0)updPane()}
 }).catch(()=>{raLoaded=false});
}

/* ===================== ナビ ===================== */
const NAV=[['dash','ダッシュボード','dash'],['new','新しい依頼','plus'],['review','確認・承認','stamp'],['board','ボード','board'],['list','一覧','list'],['catalog','道具カタログ','grid'],['sep','運用'],['devops','DevOps','code'],['secops','SecOps','shield'],['sep','管理'],['log','監査ログ','audit'],['settings','システム設定','gear']];
function renderNav(){
 const it=S.data.items,c=k=>it.filter(r=>r.status===k).length;
 const toolIds=new Set();CATALOG.forEach(d=>d.tools.forEach(t=>{if(t[4])toolIds.add(t[4])}));
 const cnt={review:[c('received')+c('review')+c('wait')+c('back'),c('wait')>0],board:[c('approved')+c('dev')+c('verify')+c('field'),false],list:[it.length,false],catalog:[toolIds.size||CATALOG.reduce((a,d)=>a+d.tools.length,0),false]};
 const dk=devKpi(),sk=secKpi();cnt.devops=[dk.mine,dk.mine>0];cnt.secops=[sk.over+sk.alert,sk.over+sk.alert>0];
 $('#nav').innerHTML=NAV.map(n=>{
  if(n[0]==='sep')return n[1]?`<div class="sep t">${n[1]}</div>`:'<div class="sep"></div>';
  const x=cnt[n[0]];
  return `<a class="${S.view===n[0]?'on':''}" data-a="${n[0]==='new'?'navNew':'go'}" data-v="${n[0]}"><span class="ni">${I(n[2])}</span><span class="lb">${n[1]}</span>${x?`<span class="cnt ${x[1]&&x[0]?'hot':''}">${x[0]}</span>`:''}</a>`;
 }).join('')+`<div class="navnote">${I('lock','sm')}<span>信号の色は候補を自動で出しますが、最終決定は承認者が行います。${window.__MSF__?'依頼はサーバ（PostgreSQL）に保存されます。DevOps・SecOps の見本は端末内です。':`データは${S.persistent?'このブラウザ内（localStorage）だけに保存されます。':'一時的に保持されます（このブラウザでは保存できないため、閉じる前にエクスポートしてください）。'}`}</span></div>`;
}
function setBusy(b){const st=$('#stat');if(!st)return;st.className='live'+(b?' busy':'');st.innerHTML=`<i class="ld"></i>${b?'工場ラインへ投入中':(window.__MSF__?'サーバ保存':'完全オフライン')}`}

/* ===================== 各画面 ===================== */
const V={},AFTER={};

V.dash=function(){
 const it=S.data.items,h=new Date().getHours();
 const greet=h<11?'おはようございます':h<17?'こんにちは':'おつかれさまです';
 const cnt=k=>it.filter(r=>r.status===k).length;
 const liveIt=it.filter(r=>!['back','hold'].includes(r.status));
 const hours=Math.round(liveIt.reduce((a,r)=>a+measure(r).hours,0));
 const t={g:0,y:0,r:0};it.forEach(r=>t[colorOf(r)]++);
 const n=Math.max(1,it.length);
 const doneRate=liveIt.length?cnt('done')/liveIt.length:0;
 let cAll=0,cOk=0;it.forEach(r=>(r.criteria||[]).filter(Boolean).forEach(c=>{cAll++;if(lint(c).ok)cOk++}));
 const critRate=cAll?cOk/cAll:0;
 const wait=cnt('wait'),off=cnt('back')+cnt('hold');
 const mine=S.role==='requester'?it.filter(r=>r.applicant===me().name):S.role==='approver'?it.filter(r=>r.status==='wait'):it.filter(r=>['received','review'].includes(r.status));
 const mineT=S.role==='requester'?'あなたの依頼':S.role==='approver'?'あなたの承認を待っている依頼':'確認を待っている依頼';
 const ev=[];it.forEach(r=>(r.history||[]).forEach(x=>ev.push({r,x})));ev.sort((a,b)=>a.x.at<b.x.at?1:-1);
 const byDept=CATALOG.map(c=>({c,n:it.filter(r=>r.dept===c.id).length})).filter(x=>x.n).sort((a,b)=>b.n-a.n).slice(0,8);
 const mx=Math.max(1,...byDept.map(x=>x.n));
 const alive=['review','wait','dev','verify','field'];
 return `${pageHead('dash','ダッシュボード','依頼の受付から完了までの流れと、各段階にある件数です。カードを押すと、その段階の依頼を一覧で見られます。','u')}
 ${S.persistent?'':`<div class="note n-warn rise">${I('alert')}<div>このブラウザでは保存領域が使えないため、データは一時的に保持されます。閉じる前に右上の「エクスポート」でJSONに書き出してください。</div></div>`}
 <div class="grid g-main" style="margin-bottom:14px">
  <div class="hero rise" style="--i:0"><span class="gear g1">${I('gear')}</span><span class="gear g2">${I('gear')}</span>
   <h2>${greet}、${E(me().name.split(' ')[0])}さん</h2>
   <p>現場や部署の「困った」「これがあったら」を、注文書（作業指示書）にして受け付けます。AIが作り、検査機と現場で確かめ、最後は人が決めます。</p>
   <button class="btn cta" data-a="startNew" type="button">${I('plus')}新しい依頼をはじめる${I('arrow','nud')}</button>
   <div class="belt" aria-hidden="true">${['g','y','g','r','y','g'].map((c,i)=>`<i class="bx ${c}" style="animation-delay:${-i*1.5}s">${I('box')}</i>`).join('')}</div>
  </div>
  <div class="card hov rise" style="--i:1"><h2>${I('flag')}信号の色の割合</h2>
   <div class="sigbox" style="background:none;border:0;padding:0">${light(['g','y','r'].filter(c=>t[c]>0))}<div>
    <div class="ratio"><i class="g" style="--w:${t.g/n*100}%"></i><i class="y" style="--w:${t.y/n*100}%"></i><i class="r" style="--w:${t.r/n*100}%"></i></div>
    <div class="rl"><span>${sig('g')} <b data-count="${t.g}">${t.g}</b>件</span><span>${sig('y')} <b data-count="${t.y}">${t.y}</b>件</span><span>${sig('r')} <b data-count="${t.r}">${t.r}</b>件</span></div>
    <p class="hint" style="margin:10px 0 0">青＝任せる／黄＝担当者のチェック付き／赤＝AIに決めさせない。最終的な色は承認者が決めます。</p></div></div>
  </div>
 </div>
 <div class="pipe">${FLOW.map((s,i)=>{const c=cnt(s.k);return `<div class="stage c-${s.tone} ${c&&alive.includes(s.k)?'alive':''} rise" style="--i:${i+2}" data-a="goList" data-v="${s.k}" title="「${s.l}」の依頼を一覧で見る"><div class="st-top"><span class="st-ic">${I(s.ic)}</span><span class="no">STEP ${i+1}</span></div><div class="l">${s.l}</div><div class="n" data-count="${c}">${c}</div><div class="who">${I(s.wi,'sm')}${s.who}</div></div>`}).join('')}</div>
 <div class="rail rise" style="--i:10"><i></i><i></i><i></i><i></i><i></i></div>
 <div class="legend rise" style="--i:11"><span><i style="background:var(--accent)"></i>依頼者</span><span><i style="background:var(--warn)"></i>人が確認・承認</span><span><i style="background:var(--ai)"></i>AIが作る・検査機が確かめる</span><span><i style="background:var(--ok)"></i>現場で確かめて完了</span><span>${I('activity','sm')}脈打つアイコン＝進行中あり</span></div>
 <div class="kpis">
  <div class="card kpi hov rise" style="--i:4"><div class="ring-wrap">${ring(doneRate,'var(--ok)')}<b data-count="${pct(doneRate)}" data-suf="%">${pct(doneRate)}%</b></div><div><div class="l">完了率</div><div class="hint">完了 ${cnt('done')}／進行 ${liveIt.length}</div></div></div>
  <div class="card kpi hov rise" style="--i:5"><span class="ki" style="--kc:var(--ai)">${I('gauge')}</span><div><div class="l">月あたり削減見込み</div><div class="v"><span data-count="${hours}">${hours}</span><small>時間</small></div><div class="hint">参考値（差戻し・見送りを除く）</div></div></div>
  <div class="card kpi hov rise" style="--i:6;cursor:pointer" data-a="go" data-v="review"><span class="ki ${wait?'alarm':''}" style="--kc:${wait?'var(--warn)':'var(--ok)'}">${I(wait?'stamp':'check')}</span><div><div class="l">承認待ち</div><div class="v" data-count="${wait}">${wait}</div><div class="hint">信号の色を承認者が決定</div></div></div>
  <div class="card kpi hov rise" style="--i:7"><div class="ring-wrap">${ring(critRate,'var(--ai)')}<b data-count="${pct(critRate)}" data-suf="%">${pct(critRate)}%</b></div><div><div class="l">検査できる合格条件</div><div class="hint">${cOk}／${cAll}件があいまい語なし</div></div></div>
  <div class="card kpi hov rise" style="--i:8"><span class="ki" style="--kc:${off?'var(--bad)':'var(--ok)'}">${I('undo')}</span><div><div class="l">差戻し・見送り</div><div class="v" data-count="${off}">${off}</div><div class="hint">差戻し ${cnt('back')}／見送り ${cnt('hold')}</div></div></div>
 </div>
 <div class="grid g3" style="margin-bottom:14px">
  <div class="card hov rise" style="--i:9"><h2>${I('user')}${E(mineT)}</h2>${mine.length?mine.slice(0,6).map((r,i)=>`<div class="li" style="--i:${i};margin-bottom:6px" data-a="open" data-id="${E(r.id)}">${cico(r.dept)}<div class="bd"><div class="t">${E(r.title)}</div><div class="m"><span class="mono">${E(r.id)}</span>${sig(colorOf(r))}${sb(r.status)}</div></div></div>`).join(''):emptyBox('check','いまはありません')}</div>
  <div class="card hov rise" style="--i:10"><h2>${I('trend')}部署別の依頼件数</h2>${byDept.length?byDept.map(x=>`<div class="barrow"><span class="catl">${cico(x.c.id)}<span>${E(x.c.short)}</span></span><div class="bar"><i style="width:${x.n/mx*100}%;background:${x.c.color}"></i></div><b>${x.n}</b></div>`).join(''):emptyBox('trend','まだ依頼がありません')}<div class="btns" style="margin-top:10px"><button class="btn ghost sm" data-a="go" data-v="catalog" type="button">${I('grid')}道具カタログを見る</button></div></div>
  <div class="card hov rise" style="--i:11"><h2>${I('activity')}最近の動き</h2><div class="feed">${ev.slice(0,6).map((e,i)=>`<div class="feed-i" style="--i:${i}">${auIc(e.x.action)}<div><div class="t">${E(e.x.action)} <a data-a="open" data-id="${E(e.r.id)}">${E(e.r.title)}</a></div><div class="hint">${fmtS(e.x.at)}・${E(e.x.by)}</div></div></div>`).join('')||emptyBox('activity','まだありません')}</div><div class="btns" style="margin-top:10px"><button class="btn ghost sm" data-a="go" data-v="log" type="button">${I('audit')}監査ログを見る</button></div></div>
 </div>
 <div class="card rise" style="--i:12"><h2>${I('shieldok')}このステーションの約束</h2><ul class="prom">
  <li>${I('check')}<span>インターネットに接続せず、外部のサービスやライブラリを一切読み込みません</span></li>
  <li>${I('check')}<span>信号の色は「候補」を自動で出しますが、<b>最終決定は承認者</b>が行います</span></li>
  <li>${I('check')}<span>赤信号の承認には「AIに決めさせない」確認が必要です</span></li>
  <li>${I('check')}<span>「承認済み」「完了」にできるのは承認者だけです（右上の「操作する人」の切り替えは動作確認用）</span></li>
  <li>${I('check')}<span>受付・相談・承認依頼の入口はここ。正式な判断は対象のPR等に記録する想定です</span></li></ul></div>`;
};

/* ---------- 新しい依頼（7ステップ） ---------- */
V.new=function(){
 if(!S.draft){S.draft=blank(S.role);S.draft.criteria=['']}
 const s=STEPS[S.step];
 return `${flowBar(['received'])}${pageHead('plus',S.editId?`依頼を編集 <span class="hint mono">${E(S.editId)}</span>`:'新しい依頼','「困った」「これがあったら」を、7つのステップで注文書（作業指示書）にします。右端のパネルに、信号の色・ものさし・注文書が1ページでまとまります。','u')}
 <div class="wsteps rise" style="--i:1">${STEPS.map((x,i)=>`<button type="button" class="ws ${i<S.step?'done':i===S.step?'on':''}" data-a="step" data-v="${i}"><span class="wi">${i<S.step?I('check'):I(x.ic)}</span><b>STEP ${i+1}</b><span class="wl">${E(x.t)}</span></button>`).join('')}</div>
 <div class="card pane detail rise" style="--i:2" id="pane">
  <div class="ph2"><span class="pic sm" style="background:${TONE.u}">${I(s.ic)}</span><div><h2 class="mt0" style="margin:0">${E(s.h)}</h2><div class="hint">${E(s.d)}</div></div></div>
  <div id="stepBody">${stepHTML(S.step)}</div>
  <div class="note n-bad" id="err" style="display:none"></div>
  <div class="navbtns"><button class="btn ghost" data-a="prev" type="button"${S.step===0?' disabled':''}>${I('back')}もどる</button>${S.step<STEPS.length-1?`<button class="btn" data-a="next" type="button">つぎへ${I('arrow')}</button>`:`<button class="btn ai ready" data-a="submit" type="button">${I('stamp')}${S.editId?'この内容で更新する':'この内容で受け付ける'}</button>`}</div>
 </div>`;
};
const fld=(label,req,html,hint,ic)=>`<div class="fld"><div class="lbl">${ic?I(ic,'sm'):''}${label}${req?'<span class="req">必須</span>':''}</div>${html}${hint?`<div class="hint">${hint}</div>`:''}</div>`;
const inp=(f,ph,type)=>`<input type="${type||'text'}" data-bind="${f}" value="${E(S.draft[f])}" placeholder="${E(ph||'')}"${type==='number'?' min="0"':''}>`;
const ta=(f,ph,rows)=>`<textarea data-bind="${f}" rows="${rows||3}" placeholder="${E(ph||'')}">${E(S.draft[f])}</textarea>`;
const optK=o=>o.k!==undefined?o.k:o,optL=o=>o.l||o;
const chipsM=(f,opts)=>`<div class="chips">${opts.map(o=>`<button type="button" class="chip tog${(S.draft[f]||[]).includes(optK(o))?' on':''}" data-a="chip" data-f="${f}" data-v="${E(optK(o))}">${E(optL(o))}</button>`).join('')}</div>`;
const segO=(f,opts)=>`<div class="seg">${opts.map(o=>`<button type="button" class="${String(S.draft[f])===String(optK(o))?'on':''}" data-a="one" data-f="${f}" data-v="${E(optK(o))}">${E(optL(o))}</button>`).join('')}</div>`;
const lintMsg=L=>L.level==='empty'?'':I(L.ok?'check':'alert','sm')+' '+E(L.tip);
const critRow=(c,j)=>{const L=lint(c);return `<div class="ci"><span class="n">${j+1}</span><div><input type="text" data-crit="${j}" value="${E(c)}" class="${L.ok?'good':L.level==='empty'?'':'vague'}" placeholder="${j===0?'例：圏外で撮った写真がアプリを閉じても消えない':''}"><div class="lint ${L.level==='empty'?'':L.level}">${lintMsg(L)}</div></div><button type="button" class="rm" data-a="rmC" data-v="${j}" title="削除"${S.draft.criteria.length<=1?' disabled':''}>${I('x')}</button></div>`};
const attHtml=()=>(S.draft.attachments||[]).length?S.draft.attachments.map((a,i)=>`${I('clip','sm')} ${E(a.name)} <span class="hint">(${Math.max(1,Math.round(a.size/1024))} KB)</span> <a data-a="rmAtt" data-v="${i}">削除</a>`).join('<br>'):'なし';
function stepHTML(i){
 const d=S.draft;
 if(i===0){
  const kic=['sparkles','wrench','bug','msg'],kdesc=['まだない道具を作ってほしい','いま使っている道具を直したい・足したい','動かない・まちがっている','まだ形になっていない思いつき'];
  const dep=S.pickDept||(d.toolRef?d.toolRef.split('|')[0]:'');
  return `${S.editId?'':`<div class="lbl">${I('sparkles','sm')}サンプル入力（デモ用）</div><div class="btns" style="margin-bottom:14px">${SAMPLES.map((s,j)=>`<button type="button" class="btn ghost sm" data-a="sample" data-v="${j}">${I(s.ic)}${E(s.label)}</button>`).join('')}</div>`}
  <div class="lbl">${I('tag','sm')}依頼の種類<span class="req">必須</span></div>
  <div class="choices">${KINDS.map((k,j)=>`<button type="button" class="choice${d.kind===k?' on':''}" data-a="one" data-f="kind" data-v="${E(k)}"><span class="ib">${I(kic[j])}</span><span><b>${E(k)}</b><small>${E(kdesc[j])}</small></span></button>`).join('')}</div>
  <div class="lbl" style="margin-top:14px">${I('grid','sm')}部署別 道具カタログから選ぶ（任意）</div>
  <div class="tiles">${CATALOG.map(c=>`<button type="button" class="tile${dep===c.id?' on':''}" data-a="pick" data-v="${c.id}" style="--cc:${c.color}"><span class="cico">${I(c.icon)}</span><span>${E(c.short)}</span></button>`).join('')}</div>
  ${dep?`<div class="tools">${deptOf(dep).tools.map((t,j)=>{const ref=t[4]||(dep+'|'+j);return `<button type="button" class="tool${d.toolRef===ref?' on':''}" data-a="tool" data-v="${ref}" style="--i:${j}"><span class="lamp ${t[2]}"></span><span><b>${E(t[0])}</b><small>${E(t[1])}</small></span></button>`}).join('')}</div>${d.toolRef?`<div style="margin-top:8px"><button type="button" class="btn ghost sm" data-a="tool" data-v="">${I('x')}選択を外す</button></div>`:''}`:`<div class="hint">${I('info','sm')} 部署を選ぶと、その部署の道具の候補が出ます。丸の色はカタログ上の信号の色です。</div>`}`;
 }
 if(i===1){
  return `<div class="row">${fld('起票者',1,applicantField(d),'部署の社員名簿（Mirai-Info）から選べます','user')}${fld('連絡先',0,inp('contact','例：内線 1234'),'','msg')}</div>
  ${fld('所属部署',1,`<select data-bind="dept">${CATALOG.map(c=>`<option value="${c.id}"${d.dept===c.id?' selected':''}>${E(c.name)}</option>`).join('')}</select>`,'','layers')}
  ${fld('だれが使う？',1,chipsM('users',USERS),'','users')}
  <div class="row">${fld('使う人のおよその人数',0,inp('people','例：40','number'),'人','users')}<div class="fld"></div></div>
  ${fld('どこで使う？',0,chipsM('places',PLACES),'「電波の弱い現場」を選ぶと、圏外でも動くことが大事な条件になります','pin')}`;
 }
 if(i===2){
  return `${fld('件名',1,inp('title','例：工事写真の圏外保存'),'ひとことで「何がほしいか」がわかる名前に','tag')}
  ${fld('いま困っていること',1,ta('problem','例：山の中の現場では写真が送れず、事務所に戻ってから整理し直している'),'','msg')}
  ${fld('なんのため？（目的）',1,ta('purpose','例：電波の弱い現場でも写真が消えずに残り、整理の手間をなくす'),'','target')}`;
 }
 if(i===3){
  return `${fld('作るもの',1,ta('scope','1行に1つずつ\n例：圏外での一時保存\n例：電波が戻った時の自動送信',4),'1行に1項目','box')}
  ${fld('今回は作らない',0,ta('outScope','例：写真の加工・編集'),'書いておくと、受付チェックの「作りすぎ防止」が通ります','x')}`;
 }
 if(i===4){
  return `<div class="vsbox"><div class="b"><b style="color:var(--bad)">${I('x','sm')} 検査できない</b><br>「使いやすい画面にする」</div><div class="gd"><b style="color:var(--ok)">${I('check','sm')} 検査できる</b><br>「圏外で撮った写真がアプリを閉じても消えない」</div></div>
  <div class="crit">${d.criteria.map((c,j)=>critRow(c,j)).join('')}</div>
  <div style="margin-top:10px"><button type="button" class="btn ghost sm" data-a="addC"${d.criteria.length>=8?' disabled':''}>${I('plus')}条件を追加</button></div>
  <div class="hint" style="margin-top:12px">${I('sparkles','sm')} よく使う書き方（押すと追加されます）</div><div class="examples">${['〇〇しても消えない','〇〇は自分の分だけが見られる','同じ〇〇を二重に登録できない','〇〇の翌朝9時までに通知される','〇〇の記録（だれが・いつ）が残る','〇〇は△△が「確定」を押すまで登録されない'].map(x=>`<button type="button" data-a="ex" data-v="${E(x)}">${E(x)}</button>`).join('')}</div>`;
 }
 if(i===5){
  return `<div class="lbl">${I('flag','sm')}この道具は何をしますか？<span class="req">必須</span></div>
  <div class="choices one" style="margin-bottom:12px">${DECIDES.map(o=>`<button type="button" class="choice sg ${o.k}${d.decides===o.k?' on':''}" data-a="one" data-f="decides" data-v="${o.k}"><span class="dot">${COLORS[o.k].l}</span><span><b>${E(o.l)}</b><small>${E(o.d)}</small></span></button>`).join('')}</div>
  ${fld('扱う情報',0,chipsM('data',DATA),'','db')}
  ${fld('関わる相手',0,segO('parties',PARTIES),'','globe')}
  ${fld('守ること',0,chipsM('constraints',CONSTRAINTS)+`<textarea data-bind="constraintsOther" rows="2" style="margin-top:8px;min-height:56px" placeholder="その他に守ること（1行に1つ）">${E(d.constraintsOther)}</textarea>`,'','lock')}
  ${fld('必ず人に聞くこと',0,chipsM('approvals',APPROVALS),'当てはまる変更が出たら、作業を止めて承認者に確認します','shield')}`;
 }
 if(i===6){
  return `<div class="row">${fld('その手間の頻度',0,segO('freq',FREQ),'','calendar')}${fld('1回あたりの手間（分）',0,inp('minutes','例：15','number'),'','clock')}</div>
  ${fld('元になるデータ',0,segO('dataReady',READY),'','db')}
  ${fld('ほかに広げられそう？',0,segO('spread',SPREAD),'','globe')}
  <div class="row">${fld('承認者（業務責任者）',1,apvSelect(d),apvHint(d),'stamp')}${fld('希望時期',0,inp('wish','','date'),'目安。着手順は別途決めます','calendar')}</div>
  ${fld('添付ファイル',0,`<input type="file" id="att" multiple><div class="hint" id="attL" style="margin-top:6px">${attHtml()}</div>`,'サンプルではファイル名と大きさだけを記録します','clip')}`;
 }
 return '';
}
function renderStepBody(){const b=$('#stepBody');if(b){b.innerHTML=stepHTML(S.step);updPreview()}}
function validate(i){
 const d=S.draft,e=[];
 if(i===0&&!d.kind)e.push('依頼の種類を選んでください');
 if(i===1){if(!String(d.applicant).trim())e.push('起票者を入力してください');if(!d.users.length)e.push('使う人を1つ以上選んでください')}
 if(i===2){if(!d.title.trim())e.push('件名を入力してください');if(!d.problem.trim())e.push('困っていることを入力してください');if(!d.purpose.trim())e.push('目的を入力してください')}
 if(i===3&&!d.scope.trim())e.push('作るものを1つ以上書いてください');
 if(i===4&&!d.criteria.filter(x=>x.trim()).length)e.push('合格の条件を1つ以上書いてください');
 if(i===5&&!d.decides)e.push('「この道具は何をしますか」を選んでください');
 if(i===6){const m=apvErr(d);if(m)e.push(m)}
 return e;
}
function showErr(list){const e=$('#err');if(!e)return;e.innerHTML=I('alert')+'<div>'+list.map(E).join('<br>')+'</div>';e.style.display='flex';const p=$('#pane');p.classList.remove('shake','rise');void p.offsetWidth;p.classList.add('shake');toast(list[0],'bad')}
function validUpTo(to){for(let i=0;i<to;i++){const e=validate(i);if(e.length){S.step=i;render();showErr(e);return false}}return true}
function setHTML(el,h){if(el&&el.__h!==h){el.innerHTML=h;el.__h=h}}
function updPreview(){
 const box=$('#rin');if(!box||S.view!=='new'||!S.draft)return;
 const d=S.draft,j=judge(d),m=measure(d);
 if(!$('#pvo',box)){
  box.innerHTML=`<div class="dp-h" style="align-items:center"><span class="pic sm" style="background:${TONE.a}">${I('eye')}</span><div class="dp-t"><div class="hint">プレビュー — 入力に合わせて変わります</div><h2 class="cl1" id="pvtitle"></h2></div><span class="badge b-acc" id="pvstep"></span></div>
  <div class="sgrow" style="margin-top:10px"><div class="sgl">${light('','md')}<div style="min-width:0;flex:1"><div class="hint">信号の色（判定の候補）</div><b id="pvsig"></b><div id="pvrs"></div></div></div>
  <div class="sgm"><div class="hint">${I('gauge','sm')} ものさし（参考値）</div><div class="big"><span id="pvh">0</span><small> 時間／月</small></div>${m.scores.map((s,i)=>`<div class="mb"><span class="cl1">${E(s.l)}</span><div class="meter"><i id="pvm${i}" style="width:0%"></i></div><b id="pvn${i}">－</b></div>`).join('')}</div></div>
  <div id="pvpf"></div>
  <div class="ptabs"><span class="pt-l">${I('doc','sm')}注文書プレビュー</span><button type="button" data-a="dp" data-v="card">${I('list','sm')}カード</button><button type="button" data-a="dp" data-v="yaml">${I('code','sm')}YAML</button></div>
  <div id="pvo"></div>`;
 }
 ['g','y','r'].forEach(c=>$('.light .'+c,box).classList.toggle('on',j.c===c));
 $('#pvtitle').textContent=d.title||'（件名は未入力）';$('#pvtitle').title=d.title||'';
 $('#pvstep').textContent='STEP '+(S.step+1)+' / '+STEPS.length;
 setHTML($('#pvsig'),sig(j.c)+' '+E(COLORS[j.c].n));
 setHTML($('#pvrs'),reasonsHTML(j));
 $('#pvh').textContent=m.hours;
 m.scores.forEach((s,i)=>{$('#pvm'+i).style.width=(s.v*20)+'%';$('#pvn'+i).textContent=s.v||'－'});
 setHTML($('#pvpf'),pfRowHTML(d));
 $$('[data-a="dp"]',box).forEach(b=>b.classList.toggle('on',b.dataset.v===S.dpTab));
 if(S.dpTab==='yaml'){const x=Object.assign({},d,{id:d.id||'（受付時に採番）'});setHTML($('#pvo'),'<pre class="yaml two">'+yamlHl(toYAML(x).trim())+'</pre>')}
 else setHTML($('#pvo'),contentHTML(d));
 fitPane(box);
}
function startNew(ref){
 S.draft=blank(S.role);S.draft.criteria=[''];S.editId=null;S.step=0;S.pickDept='';
 if(ref){const tl=toolOf(ref);if(tl){const d=S.draft;d.toolRef=ref;d.dept=tl.dept.id;d.title=tl.name;d.decides=tl.c;if(tl.c==='r')d.kind=KINDS[3]}}
 go('new');
 if(ref&&S.draft.toolRef){const tl=toolOf(ref);toast('「'+tl.name+'」で依頼をはじめます（件名・部署・信号の候補に反映）','','grid')}
}
function startEdit(id){const r=find(id);if(!r)return;S.draft=JSON.parse(JSON.stringify(r));if(!(S.draft.criteria||[]).length)S.draft.criteria=[''];S.editId=id;S.step=0;S.pickDept='';go('new')}
function submit(){
 for(let i=0;i<STEPS.length;i++){const e=validate(i);if(e.length){S.step=i;render();showErr(e);return}}
 const d=S.draft,now=nowISO();
 d.criteria=d.criteria.map(x=>x.trim()).filter(Boolean);
 if(S.editId){
  d.updatedAt=now;d.history=d.history||[];d.history.push({at:now,by:me().name,role:me().l,action:'内容を編集',note:''});
  const k=S.data.items.findIndex(x=>x.id===S.editId);if(k>=0)S.data.items[k]=d;persist();
  const id=d.id;S.draft=null;S.editId=null;S.fresh=id;go('board',id);toast(id+' を更新しました','ok');return;
 }
d.id=nextId(S.data);d.createdAt=now;d.updatedAt=now;d.status='received';
 d.history=[{at:now,by:d.applicant,role:me().l,action:'受付',note:'依頼を登録しました'}];
 S.data.items.push(d);persist();S.fresh=d.id;S.draft=null;
 const sp=$('#stamp');$('#stampNo').textContent=d.id;$('#stampDate').textContent=fmt(now,false);
 sp.classList.add('show');const h=$('.hanko',sp);h.style.animation='none';void h.offsetWidth;h.style.animation='';
 setTimeout(()=>{sp.classList.remove('show');go('board');toast('受け付けました（'+d.id+'）','ok','stamp');confetti(90)},RM?300:1500);
}

/* ---------- 確認・承認 ---------- */
V.review=function(){
 const ord={wait:0,review:1,received:2,back:3};
 const list=S.data.items.filter(r=>r.status in ord).sort((a,b)=>ord[a.status]-ord[b.status]||(a.updatedAt<b.updatedAt?1:-1));
 if(!S.sel.review||!list.some(r=>r.id===S.sel.review))S.sel.review=list[0]?list[0].id:'';
 return `${flowBar(['review','wait','approved'])}${pageHead('stamp','確認・承認','受付担当が内容を確かめ、承認者が信号の色を決めて承認します。依頼を選ぶと、右端のパネルに要点と操作が1ページでまとまります。','h')}
 ${list.length?`<div class="lgrid">${list.map((x,i)=>`<div class="li ${x.id===S.sel.review?'on':''}" style="--i:${i}" data-a="sel" data-id="${E(x.id)}">${cico(x.dept)}<div class="bd"><div class="t">${E(x.title)}</div><div class="m"><span class="mono">${E(x.id)}</span>${sig(colorOf(x))}${sb(x.status)}</div><div class="m">${avn(x.applicant)}<span>${fmtS(x.updatedAt)}</span></div></div></div>`).join('')}</div>`:emptyBox('check','確認・承認を待っている依頼はありません')}
 <div class="note n-ai rise" style="--i:6;margin-top:14px">${I('cpu')}<div>右端の「受付チェック」は、ルールによる自動点検です。見落としを知らせるだけで、進める・差し戻すを決めるのは人です。</div></div>`;
};

/* ---------- ボード ---------- */
V.board=function(){
 const side=STATUSES.filter(s=>!s.flow);
 if(S.fresh&&find(S.fresh))S.sel.board=S.fresh;
 if(!find(S.sel.board)){const a=S.data.items.slice().sort((x,y)=>x.updatedAt<y.updatedAt?1:-1);S.sel.board=a[0]?a[0].id:''}
 const items=S.data.items.filter(r=>!S.fd||r.dept===S.fd);
 const card=(r,i)=>{const c=colorOf(r),d=deptOf(r.dept);return `<div class="kc ${c}${S.fresh===r.id?' new':''}${S.sel.board===r.id?' sel':''}" style="--i:${i}" draggable="true" data-a="open" data-id="${E(r.id)}"><span class="mono hint">${E(r.id)}</span><b>${E(r.title)}</b><div class="meta">${sig(c)}${r.signalFinal?'':'<span>候補</span>'}<span class="catl">${cico(r.dept)}<span>${E(d?d.short:'')}</span></span><span>${I('gauge','sm')}${measure(r).hours}h/月</span></div></div>`};
 const col=(s,n)=>{const a=items.filter(r=>r.status===s.k);return `<div class="col" data-st="${s.k}"><h4><span class="hi" style="background:${TONE[s.tone]}">${I(s.ic)}</span>${n?n+'. ':''}${E(s.l)}<em>${a.length}</em></h4>${a.map(card).join('')}</div>`};
 return `${pageHead('board','ボード','カードを押すと、右端のパネルに要点が1ページで出ます。ドラッグで状態を変えられます（役割による制限あり。動かせない列は薄く表示）。','n')}
 <div class="btns rise" style="--i:1;margin-bottom:12px"><select data-flt="fd" style="width:auto" aria-label="部署で絞り込み"><option value="">すべての部署</option>${CATALOG.map(c=>`<option value="${c.id}"${S.fd===c.id?' selected':''}>${E(c.name)}</option>`).join('')}</select><span style="flex:1"></span><button class="btn" data-a="startNew" type="button">${I('plus')}新しい依頼</button></div>
 <div class="board rise" style="--i:2" id="board">${FLOW.map((s,i)=>col(s,i+1)).join('')}${side.map(s=>col(s,0)).join('')}</div>`;
};
AFTER.board=function(){
 S.fresh=null;let dragId=null;
 $$('.kc').forEach(k=>{
  k.addEventListener('dragstart',e=>{dragId=k.dataset.id;k.classList.add('drag');const r=find(dragId);$$('.col').forEach(c=>{if(r&&c.dataset.st!==r.status)c.classList.add(canMove(S.role,r.status,c.dataset.st)?'can':'no')});try{e.dataTransfer.setData('text/plain',dragId);e.dataTransfer.effectAllowed='move'}catch(_){}});
  k.addEventListener('dragend',()=>{k.classList.remove('drag');$$('.col').forEach(c=>c.classList.remove('no','can','over'))});
 });
 $$('.col').forEach(c=>{
  c.addEventListener('dragover',e=>{e.preventDefault();c.classList.add('over')});
  c.addEventListener('dragleave',()=>c.classList.remove('over'));
  c.addEventListener('drop',e=>{e.preventDefault();$$('.col').forEach(x=>x.classList.remove('no','can','over'));const r=find(dragId);if(!r)return;const to=c.dataset.st;if(r.status===to)return;
   if(!canMove(S.role,r.status,to)){toast('いまの役割（'+me().l+'）では「'+statusOf(to).l+'」にできません','bad','lock');return}
   S.sel.board=r.id;updPane();markSel();openStatus(r,to)});
 });
};

/* ---------- 一覧 ---------- */
V.list=function(){
 return `${S.fs&&statusOf(S.fs).flow?flowBar([S.fs]):flowBar([])}${pageHead('list','一覧','すべての依頼を検索・絞り込みできます。行を押すと詳細が開きます。','n')}
 <div class="card rise" style="--i:1"><div class="row" style="margin-bottom:10px;align-items:flex-end">
  <div class="fld" style="flex:2 1 220px;margin:0"><div class="lbl">${I('search','sm')}キーワード</div><input type="search" data-flt="fq" value="${E(S.fq)}" placeholder="件名・起票者・内容"></div>
  <div class="fld" style="margin:0"><div class="lbl">${I('layers','sm')}部署</div><select data-flt="fd" aria-label="部署で絞り込み"><option value="">すべての部署</option>${CATALOG.map(c=>`<option value="${c.id}"${S.fd===c.id?' selected':''}>${E(c.name)}</option>`).join('')}</select></div>
  <div class="fld" style="margin:0"><div class="lbl">${I('activity','sm')}状態</div><select data-flt="fs" aria-label="状態で絞り込み"><option value="">すべての状態</option>${STATUSES.map(s=>`<option value="${s.k}"${S.fs===s.k?' selected':''}>${E(s.l)}</option>`).join('')}</select></div>
  <div class="fld" style="margin:0"><div class="lbl">${I('flag','sm')}信号</div><select data-flt="fc" aria-label="信号の色で絞り込み"><option value="">すべての色</option>${['g','y','r'].map(c=>`<option value="${c}"${S.fc===c?' selected':''}>${COLORS[c].l}</option>`).join('')}</select></div>
  <div class="btns"><button class="btn ghost sm" data-a="csv" type="button">${I('download')}CSV</button><button class="btn ghost sm" data-a="clearFlt" type="button">${I('x')}絞り込み解除</button></div></div>
  <div class="tbl" tabindex="0"><table><thead><tr><th>受付番号</th><th>件名</th><th>部署</th><th>起票者</th><th>信号</th><th>状態</th><th>削減見込み</th><th>更新</th></tr></thead><tbody id="ltb"></tbody></table></div>
  <div class="hint" id="lcnt" style="margin-top:8px"></div></div>`;
};
function listRows(){
 const q=S.fq.trim().toLowerCase();
 return S.data.items.filter(r=>(!S.fd||r.dept===S.fd)&&(!S.fs||r.status===S.fs)&&(!S.fc||colorOf(r)===S.fc)&&(!q||[r.id,r.title,r.applicant,r.problem,r.purpose].join(' ').toLowerCase().includes(q))).sort((x,y)=>x.id<y.id?1:-1);
}
function updList(){
 const tb=$('#ltb');if(!tb)return;const a=listRows();
 tb.innerHTML=a.length?a.map((r,i)=>{const d=deptOf(r.dept);return `<tr class="click" style="--i:${Math.min(i,14)}" data-a="open" data-id="${E(r.id)}"><td class="mono" style="white-space:nowrap">${E(r.id)}</td><td><b>${E(r.title)}</b></td><td><span class="catl">${cico(r.dept)}<span>${E(d?d.short:'')}</span></span></td><td>${avn(r.applicant)}</td><td>${sig(colorOf(r))}${r.signalFinal?'':' <span class="hint">候補</span>'}</td><td>${sb(r.status)}</td><td>${measure(r).hours} h/月</td><td style="white-space:nowrap">${fmtS(r.updatedAt)}</td></tr>`}).join(''):`<tr><td colspan="8">${emptyBox('search','条件に合う依頼がありません')}</td></tr>`;
 $('#lcnt').textContent=a.length+' 件 ／ 全 '+S.data.items.length+' 件';
}
AFTER.list=updList;

/* ---------- 道具カタログ ---------- */
V.catalog=function(){
 const tot={g:0,y:0,r:0};CATALOG.forEach(d=>d.tools.forEach(t=>tot[t[2]]++));
 return `${pageHead('grid','道具カタログ',`${CATALOG.length}の部署ごとに、作れそうな道具と信号の色の目安をまとめています。部署を選ぶと、右端のパネルにその部署の道具が1ページで並びます。`,'a')}
 <div class="card rise" style="--i:1;margin-bottom:12px"><div class="fld" style="margin:0 0 10px"><div class="lbl">${I('search','sm')}道具をさがす（全部署から）</div><input type="search" data-flt="catq" value="${E(S.catq)}" placeholder="例：写真、期限、見積"></div>
  <div class="legend" style="margin:0"><span><i class="rd" style="background:var(--sg)"></i>青 任せる ${tot.g}</span><span><i class="rd" style="background:var(--sy)"></i>黄 チェック付き ${tot.y}</span><span><i class="rd" style="background:var(--sr)"></i>赤 決めさせない ${tot.r}</span></div></div>
 <div id="catleft"></div>`;
};
function updCatalog(){
 const box=$('#catleft');if(!box)return;const q=S.catq.trim().toLowerCase();
 if(q){
  const hits=[];CATALOG.forEach(d=>d.tools.forEach((t,j)=>{if((t[0]+' '+t[1]+' '+d.name).toLowerCase().includes(q))hits.push([d,t,j])}));
  box.innerHTML=`<div class="sec-h">${I('search','sm')}「${E(S.catq.trim())}」の検索結果 ${hits.length}件 — 押すと、右端にその部署の道具が出ます</div>${hits.length?`<div class="lgrid">${hits.map((h,i)=>{const ref=h[0].id+'|'+h[2];return `<div class="li ${ref===S.catTool?'on':''}" style="--i:${Math.min(i,14)}" data-a="catHit" data-v="${ref}">${cico(h[0].id)}<div class="bd"><div class="t">${E(h[1][0])}</div><div class="m">${sig(h[1][2])}<span>${E(h[0].short)}</span></div></div></div>`}).join('')}</div>`:emptyBox('search','該当する道具はありません。「新しい依頼」からカタログ外として依頼できます。')}`;
  return;
 }
 box.innerHTML=`<div class="dgrid">${CATALOG.map((x,i)=>{const n={g:0,y:0,r:0};x.tools.forEach(t=>n[t[2]]++);return `<div class="li ${x.id===S.cat?'on':''}" style="--i:${i}" data-a="cat" data-v="${x.id}">${cico(x.id)}<div class="bd"><div class="t">${E(x.short)}</div><div class="m"><span class="dots3"><span><i class="lamp g"></i>${n.g}</span><span><i class="lamp y"></i>${n.y}</span><span><i class="lamp r"></i>${n.r}</span></span></div></div></div>`}).join('')}</div>`;
}
AFTER.catalog=updCatalog;

/* ---------- 監査ログ ---------- */
const LOGK=[['','すべて','list'],['req','依頼','inbox'],['devops','DevOps','code'],['secops','SecOps','shield'],['settings','設定','gear'],['auth','ログイン','user']];
function logValid(k){if(!k)return false;if(String(k).indexOf('A:')===0)return S.data.audit.some(a=>'A:'+a.id===k)||ra.some(a=>'A:'+a.id===k);return !!find(k)}
V.log=function(){
 if(!logValid(S.sel.log)){const a=logRows();if(a[0]){S.sel.log=a[0].key;if(a[0].k==='req')S.dtab='log'}}
 return `${pageHead('audit','監査ログ','依頼の受付・状態の変更・編集に加えて、DevOps・SecOps の操作、システム設定の変更、ログイン・ログアウトを新しい順にすべて記録します。行を押すと、右端のパネルに中身が1ページで出ます。','n')}
 <div class="card rise" style="--i:1"><div class="seg tabs">${LOGK.map(x=>`<button class="${S.logk===x[0]?'on':''}" data-a="logk" data-v="${x[0]}" type="button">${I(x[2])}${x[1]}</button>`).join('')}</div>
 <div class="row" style="margin-bottom:10px;align-items:flex-end"><div class="fld" style="margin:0;flex:2 1 200px"><div class="lbl">${I('search','sm')}キーワード</div><input type="search" data-flt="logq" value="${E(S.logq)}" placeholder="操作者・操作・対象・受付番号・メモ"></div><div class="btns"><button class="btn ghost sm" data-a="logcsv" type="button">${I('download')}CSV</button><span class="hint" id="logcnt"></span></div></div>
 <div class="tbl" tabindex="0"><table><thead><tr><th>日時</th><th>操作・操作者</th><th>対象</th></tr></thead><tbody id="logtb"></tbody></table></div></div>`;
};
function logRows(){
 const ev=[];
 S.data.items.forEach(r=>(r.history||[]).forEach(x=>ev.push({k:'req',r,x,key:r.id})));
 (S.data.audit||[]).forEach(a=>ev.push({k:a.area,a,x:a,r:find(a.ref)||null,key:'A:'+a.id}));
 ra.forEach(a=>ev.push({k:a.area,a,x:a,r:find(a.ref)||null,key:'A:'+a.id}));
 ev.sort((a,b)=>a.x.at<b.x.at?1:a.x.at>b.x.at?-1:0);
 const q=S.logq.trim().toLowerCase(),kk=S.logk;
 return ev.filter(e=>(!kk||e.k===kk)&&(!q||[e.x.by,e.x.role,e.x.action,e.x.note,e.r?e.r.id:'',e.r?e.r.title:'',e.a?e.a.ref:'',e.a?refLabel(e.a.ref):'',(AREA[e.k]||AREA.req)[0]].join(' ').toLowerCase().includes(q)));
}
function logIc(e){if(e.k==='req')return auIc(e.x.action);const ar=AREA[e.k]||AREA.req;return `<span class="aic" style="--cc:${ar[2]}">${I(ar[1])}</span>`}
function logTarget(e){
 const ar=AREA[e.k]||AREA.req,tag=`<span class="badge ar" style="color:${ar[2]}">${I(ar[1])}${ar[0]}</span>`;
 if(e.r)return `${tag} <span class="mono hint">${E(e.r.id)}</span><div class="cl1" style="max-width:170px" title="${E(e.r.title)}">${E(e.r.title)}</div>`;
 if(e.a&&e.a.ref){const lb=refLabel(e.a.ref);return `${tag}<div class="cl1" style="max-width:170px" title="${E(lb)}">${E(lb)}</div>`}
 return tag;
}
function updLog(){
 const tb=$('#logtb');if(!tb)return;const a=logRows();
 tb.innerHTML=a.length?a.map((e,i)=>`<tr class="click${e.key===S.sel.log?' on':''}" style="--i:${Math.min(i,14)}" data-a="logSel" data-id="${E(e.key)}"><td style="white-space:nowrap">${fmtS(e.x.at)}</td><td><div style="display:flex;gap:9px;align-items:center">${logIc(e)}<div style="min-width:0"><b style="font-weight:600">${E(e.x.action)}</b><div class="hint cl1" style="max-width:230px" title="${E(e.x.by+'（'+e.x.role+'）'+(e.x.note?'　'+e.x.note:''))}">${E(e.x.by)}${e.x.note?'・'+E(e.x.note):''}</div></div></div></td><td>${logTarget(e)}</td></tr>`).join(''):`<tr><td colspan="3">${emptyBox('search','該当する記録はありません')}</td></tr>`;
 $('#logcnt').textContent=a.length+'件';
}
AFTER.log=updLog;


/* ===================== DevOps・SecOps・システム設定・監査ログ ===================== */
const DAY=86400000;
const daysAgo=(d,h)=>new Date(Date.now()-d*DAY-(h||0)*3600000).toISOString();
const PIPE=['approved','dev','verify','field','done'];
const CHECKS=[['build','ビルド','box'],['type','型の検査','code'],['unit','単体テスト','check'],['integ','結合テスト','layers'],['e2e','画面テスト','monitor'],['sast','コード検査','search'],['dep','依存関係','db'],['secret','シークレット','lock'],['offline','圏外テスト','globe']];
const CHK_LOCK=['build','secret'];
const CKL=k=>(CHECKS.find(c=>c[0]===k)||[k,k])[1];
const DSTAGES=[['Issue化','doc'],['AIが実装','bot'],['自動検査','shieldok'],['人のレビュー','user'],['マージ','loop'],['ステージング','layers'],['本番','flag']];
const SEV={critical:{l:'緊急',cls:'b-bad'},high:{l:'高',cls:'b-warn'},medium:{l:'中',cls:'b-acc'},low:{l:'低',cls:''}};
const SEVK=['critical','high','medium','low'];
const VST={open:['未対応','b-bad'],doing:['対応中','b-warn'],riskreq:['リスク受容の申請中','b-ai'],accepted:['リスク受容','b-acc'],fixed:['修正済み','b-ok']};
const AST={new:['未確認','b-bad'],ack:['確認済み','b-warn'],closed:['対応済み','b-ok']};
const RST={pending:['確認待ち','b-warn'],ok:['継続を確認','b-ok'],revoked:['権限を外した','']};
const AREA={req:['依頼','inbox','var(--accent)'],devops:['DevOps','code','var(--ai)'],secops:['SecOps','shield','var(--bad)'],settings:['設定','gear','#64748b'],auth:['ログイン','user','var(--ok)']};
const GROUP={requester:'SF-Requesters',desk:'SF-Desk',approver:'SF-Approvers'};
/* だれがどの操作をできるか（依頼の状態は canMove のとおり） */
const CAN={ai:['desk'],check:['desk'],review:['approver'],merge:['desk'],stg:['desk'],prod:['approver'],rollback:['desk'],
 handoff:['desk','approver'],stop:['desk','approver'],resume:['desk','approver'],
 vtake:['desk'],vfix:['desk'],vrisk:['desk'],vriskok:['approver'],ack:['desk','approver'],access:['approver'],gate:['desk'],cfg:['desk']};
const may=k=>(CAN[k]||[]).includes(S.role);
const rl=k=>roleOf(k).l.replace(/（.*）/,'');
const whoCanT=k=>(CAN[k]||[]).map(rl).join('・');
const fieldUse=r=>(r.places||[]).some(p=>/現場（屋外）|電波の弱い現場/.test(p));
const isReq=k=>CHK_LOCK.includes(k)||!!S.cfg.req[k];

/* ---------- 設定（このブラウザに保存。依頼のデータとは別） ---------- */
const CKEY=KEY+'-settings';
function cfg0(){return {org:'',stampName:'SFステーション',startLogin:false,motion:'auto',approvers:APPROVERS.slice(),sla:{critical:7,high:30,medium:90,low:180},req:{build:true,type:true,unit:true,integ:true,e2e:true,sast:true,dep:true,secret:true,offline:true}}}
function normCfg(c){
 const d=cfg0();if(!c||typeof c!=='object')return d;
 if(typeof c.org==='string')d.org=c.org.trim().slice(0,40);
 if(typeof c.stampName==='string'&&c.stampName.trim())d.stampName=c.stampName.trim().slice(0,12);
 d.startLogin=c.startLogin===true;
 if(['auto','reduce'].includes(c.motion))d.motion=c.motion;
 if(Array.isArray(c.approvers)){const a=[...new Set(c.approvers.filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim().slice(0,20)))];if(a.length)d.approvers=a}
 if(c.sla&&typeof c.sla==='object')SEVK.forEach(k=>{const v=Math.round(+c.sla[k]);if(v>=1&&v<=365)d.sla[k]=v});
 if(c.req&&typeof c.req==='object')Object.keys(d.req).forEach(k=>{if(!CHK_LOCK.includes(k)&&typeof c.req[k]==='boolean')d.req[k]=c.req[k]});
 return d;
}
function loadCfg(){let c=null;try{c=JSON.parse(localStorage.getItem(CKEY)||'null')}catch(e){}return normCfg(c)}
function saveCfg(){try{localStorage.setItem(CKEY,JSON.stringify(S.cfg));return true}catch(e){return false}}
function applyMotion(){RM=S.cfg.motion==='reduce'||OSRM;document.documentElement.classList.toggle('rm',S.cfg.motion==='reduce')}
const SUB0=window.__MSF__?'依頼の受付・注文書づくり・承認の流れ':'依頼の受付・注文書づくり・承認の流れ サンプル（完全オフライン）';
const brandSub=()=>(S.cfg.org?S.cfg.org+'　':'')+SUB0;
function applyOrg(){const el=$('#brandsub');if(el)el.textContent=brandSub();const h=$('#stamp .hanko small');if(h)h.textContent=S.cfg.stampName}

/* ---------- 監査ログ（依頼の履歴以外の記録） ---------- */
function addAudit(area,action,note,ref,who){
 const d=S.data,w=who||me();d.aseq=(d.aseq||0)+1;
 d.audit.push({id:'AU-'+pad(d.aseq,5),at:nowISO(),by:w.name,role:w.l,area,action,note:note||'',ref:ref||''});
 if(d.audit.length>5000)d.audit.splice(0,d.audit.length-5000);
}

/* ---------- 開発ライン（承認済み〜完了の依頼に1本ずつ） ---------- */
function lineTpl(r,d){
 const v=d.devsec;v.iseq=(v.iseq||40)+1;
 const l={req:r.id,issue:v.iseq,pr:null,branch:'feat/'+String(r.id).toLowerCase(),ai:{runs:0,min:0,cost:0},checks:{},review:'none',reviewBy:'',merged:false,stg:'',prod:'',ver:'1.0.0',bug:'',at:nowISO()};
 CHECKS.forEach(c=>l.checks[c[0]]=c[0]==='offline'&&!fieldUse(r)?'na':'pend');
 const st=PIPE.indexOf(r.status);
 if(st>=1){v.pseq=(v.pseq||110)+1;l.pr=v.pseq;l.ai={runs:1,min:22,cost:14}}
 if(st>=2)CHECKS.forEach(c=>{if(l.checks[c[0]]!=='na')l.checks[c[0]]='pass'});
 if(st>=3){l.review='ok';l.reviewBy=ROLES[2].name;l.merged=true;l.stg=l.ver}
 if(st>=4)l.prod=l.ver;
 return l;
}
function normLine(l,r){
 if(!l.ai||typeof l.ai!=='object')l.ai={runs:0,min:0,cost:0};
 ['runs','min','cost'].forEach(k=>{l.ai[k]=Math.max(0,+l.ai[k]||0)});
 if(!l.checks||typeof l.checks!=='object')l.checks={};
 CHECKS.forEach(([k])=>{const v=l.checks[k];l.checks[k]=['pass','fail','pend','na'].includes(v)?v:(k==='offline'&&r&&!fieldUse(r)?'na':'pend')});
 l.running='';['stg','prod','ver','bug','branch','reviewBy'].forEach(k=>{if(typeof l[k]!=='string')l[k]=k==='ver'?'1.0.0':''});
 l.merged=!!l.merged;if(l.review!=='ok')l.review='none';
}
function syncLines(d){
 if(!d||!d.devsec)return;const L=d.devsec.lines;
 d.items.forEach(r=>{if(PIPE.includes(r.status)&&!L[r.id])L[r.id]=lineTpl(r,d)});
 Object.keys(L).forEach(id=>{if(!d.items.some(r=>r.id===id))delete L[id]});
}
function seedDevsec(d){
 const v=d.devsec={lines:{},deploys:[],vulns:[],alerts:[],access:[],gchk:{at:daysAgo(6),by:ROLES[1].name},iseq:40,pseq:110,dseq:0};
 syncLines(d);
 const by=k=>d.items.find(r=>r.status===k),L=v.lines,ver=(id,o)=>{if(L[id])Object.assign(L[id],o)};
 const dep=(at,env,r,vv,who,o)=>{v.dseq++;v.deploys.push(Object.assign({id:'DEP-'+pad(v.dseq,4),at,env,kind:'deploy',req:r.id,ver:vv,by:who.name},o||{}))};
 const dv=by('dev'),vf=by('verify'),fd=by('field'),dn=by('done');
 if(dv)ver(dv.id,{ai:{runs:2,min:41,cost:34},bug:'e2e',at:daysAgo(4),checks:Object.assign({},L[dv.id].checks,{build:'pass',type:'pass',unit:'pass',integ:'pass',e2e:'fail',sast:'pass',dep:'pass',secret:'pass'})});
 if(dv&&L[dv.id].checks.offline!=='na')L[dv.id].checks.offline='pass';
 if(vf)ver(vf.id,{review:'none',reviewBy:'',merged:false,stg:'',ai:{runs:1,min:26,cost:17},at:daysAgo(5)});
 if(fd){ver(fd.id,{at:daysAgo(8),ai:{runs:3,min:63,cost:46}});dep(daysAgo(1,3),'stg',fd,'1.0.0',ROLES[1])}
 if(dn){ver(dn.id,{ver:'1.0.2',stg:'1.0.2',prod:'1.0.2',at:daysAgo(11),ai:{runs:4,min:88,cost:61}});
  dep(daysAgo(9),'stg',dn,'1.0.0',ROLES[1]);dep(daysAgo(8),'prod',dn,'1.0.0',ROLES[2]);
  dep(daysAgo(5),'stg',dn,'1.0.1',ROLES[1]);dep(daysAgo(4,3),'prod',dn,'1.0.1',ROLES[2]);
  dep(daysAgo(4,1),'prod',dn,'1.0.0',ROLES[1],{kind:'rollback',from:'1.0.1',note:'保存のときに画面が止まる不具合'});
  dep(daysAgo(3),'stg',dn,'1.0.2',ROLES[1]);dep(daysAgo(2),'prod',dn,'1.0.2',ROLES[2])}
 const ref=x=>x?x.id:'';
 v.vulns=[
  {id:'VUL-001',title:'PDF出力ライブラリの既知の脆弱性',comp:'PDF出力ライブラリ 2.3',sev:'critical',req:ref(dn),found:daysAgo(9),status:'open',owner:'',note:'細工したファイルを読み込むと、意図しない処理が動くおそれ。修正版が公開されています。'},
  {id:'VUL-002',title:'画面部品のクロスサイトスクリプティング',comp:'画面の部品ライブラリ 5.1',sev:'high',req:ref(fd),found:daysAgo(26),status:'doing',owner:ROLES[1].name,note:'入力欄の表示で、文字の無害化が抜ける場合があります。'},
  {id:'VUL-003',title:'日付処理ライブラリの処理遅延（ReDoS）',comp:'日付処理ライブラリ 1.9',sev:'medium',req:ref(vf),found:daysAgo(12),status:'open',owner:'',note:'特殊な文字列で処理に時間がかかることがあります。'},
  {id:'VUL-004',title:'テスト用ツールの依存関係の脆弱性',comp:'テスト用ツール 3.0',sev:'low',req:ref(dv),found:daysAgo(40),status:'riskreq',owner:ROLES[1].name,note:'本番の成果物に含まれないため、次の更新でまとめて直す（リスク受容を申請）'},
  {id:'VUL-005',title:'画像縮小ライブラリのメモリ破損',comp:'画像縮小ライブラリ 0.9',sev:'high',req:ref(fd),found:daysAgo(20),status:'fixed',owner:ROLES[1].name,fixedAt:daysAgo(15),note:'修正版に更新し、検査に合格しました。'}
 ];
 v.alerts=[
  {id:'ALT-001',title:'大量のデータ書き出し',sev:'high',at:daysAgo(0,3),status:'new',detail:'「工事写真台帳」から5分間に1,200件の書き出しがありました（ふだんの約20倍）。',ref:ref(fd)},
  {id:'ALT-002',title:'シークレットの検出（コミット前に止めました）',sev:'medium',at:daysAgo(1,2),status:'new',detail:'開発ラインのブランチに、APIキーらしき文字列がありました。コミットは止まっています。',ref:ref(dv)},
  {id:'ALT-003',title:'注文書へのなりすまし命令の疑い',sev:'high',at:daysAgo(3),status:'ack',ackBy:ROLES[1].name,detail:'依頼の本文に「前の指示を無視して…」という文があり、AIへ渡す前に止めました。',ref:''},
  {id:'ALT-004',title:'時間外のログイン',sev:'low',at:daysAgo(6),status:'closed',ackBy:ROLES[2].name,detail:'深夜2時に、受付担当のアカウントでログインがありました（本人の作業と確認済み）。',ref:''}
 ];
 const acc=(i,name,rk,last,status,note,o)=>Object.assign({id:'ACC-'+pad(i,3),name,role:rk,last:daysAgo(last),status,note:note||''},o||{});
 v.access=[
  acc(1,'山田 太郎','requester',0,'pending'),
  acc(2,'佐藤 花子','desk',0,'ok','',{at:daysAgo(20),by:ROLES[2].name}),
  acc(3,'鈴木 一郎','approver',1,'pending'),
  acc(4,'田中 誠司','approver',12,'pending'),
  acc(5,'松本 綾','approver',95,'pending','90日以上ログインがありません'),
  acc(6,'ITベンダー 保守担当','desk',61,'pending','保守契約の終了が近づいています')
 ];
 d.audit=[];d.aseq=0;
 const A=(at,area,action,note,refId,w)=>{d.aseq++;d.audit.push({id:'AU-'+pad(d.aseq,5),at,by:w.name,role:w.l,area,action,note:note||'',ref:refId||''})};
 v.deploys.forEach(x=>A(x.at,'devops',x.kind==='rollback'?'ロールバック':x.env==='prod'?'本番にデプロイ':'ステージングに配備',x.kind==='rollback'?x.from+' → '+x.ver+'（'+x.note+'）':x.ver,x.req,x.env==='prod'&&x.kind!=='rollback'?ROLES[2]:ROLES[1]));
 if(dv){A(daysAgo(2,4),'devops','AIで実装','PR #'+L[dv.id].pr+'（2回目）',dv.id,ROLES[1]);A(daysAgo(1,5),'devops','自動検査を実行','不合格 1件（画面テスト）',dv.id,ROLES[1])}
 A(daysAgo(25),'secops','脆弱性を担当','VUL-002',"VUL-002",ROLES[1]);
 A(daysAgo(15),'secops','修正済みにする','VUL-005','VUL-005',ROLES[1]);
 A(daysAgo(7),'secops','リスク受容を申請',v.vulns[3].note,'VUL-004',ROLES[1]);
 A(daysAgo(3,-1),'secops','通知を確認','注文書へのなりすまし命令の疑い','ALT-003',ROLES[1]);
 A(daysAgo(6),'secops','品質ゲートを点検','7項目','G',ROLES[1]);
 A(daysAgo(20),'secops','権限の継続を確認','佐藤 花子（受付担当）','ACC-002',ROLES[2]);
 d.audit.sort((a,b)=>a.at<b.at?-1:1);
 v.deploys.sort((a,b)=>a.at<b.at?-1:1);
}
function normData(d){
 if(!d.devsec||typeof d.devsec!=='object'||!d.devsec.lines||typeof d.devsec.lines!=='object'||Array.isArray(d.devsec.lines))seedDevsec(d);
 const v=d.devsec;['deploys','vulns','alerts','access'].forEach(k=>{if(!Array.isArray(v[k]))v[k]=[]});
 const str=x=>typeof x==='string',ok=x=>x&&typeof x==='object';
 v.deploys=v.deploys.filter(x=>ok(x)&&str(x.req)&&str(x.at)&&str(x.ver)&&['stg','prod'].includes(x.env)).map(x=>Object.assign({kind:'deploy',by:'',id:''},x,{kind:x.kind==='rollback'?'rollback':'deploy'}));
 v.vulns=v.vulns.filter(x=>ok(x)&&str(x.id)&&/^VUL/.test(x.id)&&SEV[x.sev]&&VST[x.status]&&str(x.found)).map(x=>Object.assign({title:'',comp:'',req:'',owner:'',note:''},x));
 v.alerts=v.alerts.filter(x=>ok(x)&&str(x.id)&&/^ALT/.test(x.id)&&SEV[x.sev]&&AST[x.status]&&str(x.at)).map(x=>Object.assign({title:'',detail:'',ref:'',ackBy:''},x));
 v.access=v.access.filter(x=>ok(x)&&str(x.id)&&/^ACC/.test(x.id)&&str(x.name)&&GROUP[x.role]&&RST[x.status]&&str(x.last)).map(x=>Object.assign({note:''},x));
 if(!ok(v.gchk))v.gchk={at:'',by:''};
 ['iseq','pseq','dseq'].forEach(k=>{v[k]=+v[k]||0});v.iseq=Math.max(v.iseq,40);v.pseq=Math.max(v.pseq,110);v.dseq=Math.max(v.dseq,v.deploys.length);
 Object.keys(v.lines).forEach(id=>{if(!ok(v.lines[id]))delete v.lines[id];else v.lines[id].req=id});
 if(!Array.isArray(d.audit))d.audit=[];
 d.audit=d.audit.filter(a=>ok(a)&&str(a.at)&&str(a.action)).map(a=>Object.assign({id:'',by:'',role:'',area:'req',note:'',ref:''},a,{area:AREA[a.area]?a.area:'req',ref:str(a.ref)?a.ref:''}));
 d.audit.forEach((a,i)=>{if(!str(a.id)||!a.id)a.id='AU-X'+pad(i+1,5)});
 d.aseq=Math.max(+d.aseq||0,d.audit.length);
 syncLines(d);
 Object.keys(v.lines).forEach(id=>normLine(v.lines[id],d.items.find(r=>r.id===id)));
 return d;
}

/* ---------- 開発ラインの判定 ---------- */
const lineOf=id=>S.data.devsec.lines[id];
function ckState(l){let fail=0,pend=0,pass=0,all=0;CHECKS.forEach(([k])=>{const v=l.checks[k];if(v==='na')return;if(v==='pass')pass++;if(!isReq(k))return;all++;if(v==='fail')fail++;else if(v!=='pass')pend++});return {fail,pend,pass,all,ok:!fail&&!pend}}
function stageIdx(l){const c=ckState(l);return !l.pr?1:!c.ok?2:l.review!=='ok'?3:!l.merged?4:l.stg!==l.ver?5:l.prod!==l.ver?6:7}
function lineNext(l,r){
 if(l.running==='ai')return {k:'run',t:'AIが実装しています',who:''};
 if(l.running==='check')return {k:'run',t:'自動検査を実行中',who:''};
 const c=ckState(l);
 if(!l.pr)return {k:'ai',t:'AIで実装する',who:'desk'};
 if(c.fail)return {k:'ai',t:'不合格をAIで直す',who:'desk'};
 if(c.pend)return {k:'check',t:'自動検査を実行する',who:'desk'};
 if(l.review!=='ok')return {k:'review',t:'レビューで承認する',who:'approver'};
 if(!l.merged)return {k:'merge',t:'マージする',who:'desk'};
 if(l.stg!==l.ver)return {k:'stg',t:'ステージングに配備する',who:'desk'};
 if(l.prod!==l.ver)return {k:'prod',t:'本番にデプロイする',who:'approver'};
 return {k:'done',t:'本番で稼働中',who:''};
}
function devLines(){
 const L=S.data.devsec.lines;
 return Object.keys(L).map(id=>({l:L[id],r:find(id)})).filter(x=>x.r&&PIPE.includes(x.r.status))
  .sort((a,b)=>{const fa=lineNext(a.l,a.r).k==='done',fb=lineNext(b.l,b.r).k==='done';if(fa!==fb)return fa?1:-1;return a.r.id<b.r.id?1:-1});
}
function prodPrev(l){
 const h=S.data.devsec.deploys.filter(x=>x.req===l.req&&x.env==='prod');
 if(!h.length||!l.prod||h[h.length-1].kind==='rollback'||h[h.length-1].ver!==l.prod)return null;
 for(let i=h.length-2;i>=0;i--)if(h[i].ver!==l.prod)return {ver:h[i].ver};
 return null;
}
function within(at,days){return Date.now()-new Date(at).getTime()<=days*DAY}
function devKpi(){
 const L=devLines(),D=S.data.devsec.deploys;
 const prod30=D.filter(x=>x.env==='prod'&&x.kind==='deploy'&&within(x.at,30)),rb30=D.filter(x=>x.kind==='rollback'&&within(x.at,30));
 return {active:L.filter(x=>lineNext(x.l,x.r).k!=='done').length,mine:L.filter(x=>lineNext(x.l,x.r).who===S.role).length,
  fail:L.filter(x=>ckState(x.l).fail).length,prod:prod30.length,cfr:prod30.length?Math.round(rb30.length/prod30.length*100):0,rb:rb30.length};
}
/* ---------- SecOps の判定 ---------- */
const vDue=v=>new Date(new Date(v.found).getTime()+S.cfg.sla[v.sev]*DAY);
const vOpen=v=>['open','doing','riskreq'].includes(v.status);
const vLeft=v=>Math.ceil((vDue(v).getTime()-Date.now())/DAY);
function dueHTML(v){if(!vOpen(v))return v.status==='fixed'?`<span class="due ok">${I('check','sm')}修正 ${fmtS(v.fixedAt||'')}</span>`:'<span class="due">受容済み</span>';const n=vLeft(v);return n<0?`<span class="due bad">${I('alert','sm')}期限切れ ${-n}日</span>`:n<=7?`<span class="due warn">${I('clock','sm')}あと ${n}日</span>`:`<span class="due">期限 ${fmt(vDue(v).toISOString(),false)}</span>`}
function gates(){
 const v=S.data.devsec,od=v.vulns.filter(x=>vOpen(x)&&vLeft(x)<0).length,off=CHECKS.filter(([k])=>!isReq(k));
 return [
  {id:'G1',t:'main への直接の書き込みを禁止',d:'変更は必ず PR を通します。',s:'ok',why:'守られています'},
  {id:'G2',t:'PR には人のレビューが必要',d:'承認者が「レビューで承認」するまでマージできません。',s:'ok',why:'守られています'},
  {id:'G3',t:'マージ前の必須検査',d:'システム設定で選んだ検査に、すべて合格するまでマージできません。',s:off.length?'warn':'ok',why:off.length?'必須から外した検査が '+off.length+' 件あります（'+off.map(c=>c[1]).join('・')+'）':'9件すべてが必須です',set:'devops'},
  {id:'G4',t:'赤信号の仕事はAIに決めさせない',d:'赤の依頼は、承認者の確認がないと承認できません。',s:'ok',why:'守られています'},
  {id:'G5',t:'シークレットを含むコミットを止める',d:'シークレットの検査は、いつも必須です（外せません）。',s:'ok',why:'守られています'},
  {id:'G6',t:'期限切れの脆弱性が0件',d:'修正期限はシステム設定で決めます。',s:od?'bad':'ok',why:od?'期限切れが '+od+' 件あります':'期限切れはありません',tab:'vuln',set:'secops'},
  {id:'G7',t:'現場向けの道具は圏外テストが必須',d:'使う場所に現場（屋外）・電波の弱い現場がある道具です。',s:S.cfg.req.offline?'ok':'warn',why:S.cfg.req.offline?'必須になっています':'圏外テストが必須から外れています',set:'devops'}
 ];
}
function secKpi(){
 const v=S.data.devsec,op=v.vulns.filter(vOpen);
 return {over:op.filter(x=>vLeft(x)<0).length,soon:op.filter(x=>{const n=vLeft(x);return n>=0&&n<=7}).length,
  alert:v.alerts.filter(x=>x.status==='new').length,acc:v.access.filter(x=>x.status==='pending').length,gate:gates().filter(g=>g.s!=='ok').length,
  riskreq:v.vulns.filter(x=>x.status==='riskreq').length};
}

/* ---------- 共通部品 ---------- */
function abtn(key,act,label,ic,o){
 o=o||{};const can=may(key),ok=can&&!o.off;
 const tip=!can?'この操作ができるのは '+whoCanT(key)+' です':o.off||label;
 return `<button class="btn sm ${o.cls||''}${ok&&o.ready?' ready':''}" data-a="${act}"${o.id?` data-id="${E(o.id)}"`:''}${o.job?` data-job="${E(o.job)}"`:''} type="button"${ok?'':' disabled'} title="${E(tip)}">${I(ic)}${E(label)}</button>`;
}
function gateFor(keys){
 const ks=keys.filter(k=>!may(k));if(!ks.length)return '';
 const rs=[...new Set(ks.flatMap(k=>CAN[k]))].filter(k=>k!==S.role).map(roleOf);
 return `<div class="gatel">${I('lock','sm')}<span>この操作ができるのは ${rs.map(x=>E(x.l.replace(/（.*）/,''))).join('・')} です</span>${rs.map(x=>`<button class="btn ghost sm" data-a="role" data-v="${x.k}" type="button">${av(x.name)}${E(x.name)}に切り替え</button>`).join('')}</div>`;
}
function kstrip(arr){return `<div class="kstrip">${arr.map((k,i)=>`<div class="ks rise" style="--i:${i+1}"${k.go?` data-a="${k.go[0]}" data-v="${k.go[1]}" title="${E(k.go[2]||'')}"`:''}><div class="kt"><span class="ki${k.alarm?' alarm':''}" style="--kc:${k.c}">${I(k.ic)}</span><div class="v"><span data-count="${k.v}">${k.v}</span>${k.suf?`<small>${k.suf}</small>`:''}</div></div><div class="l">${E(k.l)}</div></div>`).join('')}</div>`}
function segTabs(act,cur,tabs){return `<div class="seg tabs" role="tablist">${tabs.map(t=>`<button class="${cur===t[0]?'on':''}" data-a="${act}" data-v="${t[0]}" type="button" role="tab" aria-selected="${cur===t[0]}">${I(t[2])}${E(t[1])}${t[3]!=null?`<span class="sn${t[4]?' hot':''}">${t[3]}</span>`:''}</button>`).join('')}</div>`}
const reqLink=(id,cls)=>{const r=find(id);return r?`<span class="mono hint">${E(r.id)}</span> <span class="${cls||'cl1'}" title="${E(r.title)}">${E(r.title)}</span>`:(id?`<span class="mono hint">${E(id)}</span>`:'<span class="hint">—</span>')};

/* ===================== DevOps ===================== */
V.devops=function(){
 const L=devLines(),k=devKpi();
 if(!L.some(x=>x.r.id===S.sel.devops)&&L[0]){const m=L.find(x=>lineNext(x.l,x.r).who===S.role)||L[0];S.sel.devops=m.r.id}
 const nD=S.data.devsec.deploys.length;
 return `${pageHead('code','DevOps','承認された依頼が、AIの実装 → 自動検査 → 人のレビュー → マージ → ステージング → 本番と進むようすを見て、操作します。','a')}
 ${kstrip([{ic:'loop',l:'開発ラインの依頼（進行中）',v:k.active,c:'var(--ai)'},{ic:'user',l:'あなたの番',v:k.mine,c:k.mine?'var(--accent)':'var(--ok)',alarm:k.mine>0},{ic:'alert',l:'検査の不合格',v:k.fail,c:k.fail?'var(--bad)':'var(--ok)'},{ic:'flag',l:'本番デプロイ（30日）',v:k.prod,c:'var(--ok)'},{ic:'undo',l:'変更の失敗率（30日）',v:k.cfr,suf:'%',c:k.cfr?'var(--warn)':'var(--ok)'}])}
 <div class="card rise" style="--i:6">${segTabs('devTab',S.devTab,[['line','開発ライン','loop',L.length],['deploy','デプロイ履歴','layers',nD],['metric','指標','trend']])}<div id="devbody"></div></div>`;
};
function devStepsMini(l){const si=stageIdx(l),f=ckState(l).fail;return `<span class="dbar" title="いま：${si>=7?'本番で稼働中':DSTAGES[si][0]}">${DSTAGES.map((s,i)=>`<i class="${i<si?'done':i===si?(f&&i===2?'bad':'cur'):''}" title="${s[0]}"></i>`).join('')}</span>`}
function ckMini(l){return `<span class="ckm" title="自動検査（緑＝合格・赤＝不合格・灰＝未実行）">${CHECKS.map(([k,lb])=>`<i class="${l.checks[k]}${l.running==='check'&&l.checks[k]!=='na'?' run':''}" title="${lb}：${{pass:'合格',fail:'不合格',pend:'未実行',na:'対象外'}[l.checks[k]]}"></i>`).join('')}</span>`}
function updDev(){
 const box=$('#devbody');if(!box)return;const D=S.data.devsec;
 if(S.devTab==='deploy'){
  const a=D.deploys.slice().reverse();
  box.innerHTML=a.length?`<div class="tbl"><table><thead><tr><th>日時</th><th>環境・版</th><th>依頼</th><th>操作者</th></tr></thead><tbody>${a.map((x,i)=>`<tr class="click${x.req===S.sel.devops?' on':''}" style="--i:${Math.min(i,14)}" data-a="devSel" data-id="${E(x.req)}"><td style="white-space:nowrap">${fmtS(x.at)}</td><td><div class="envrow"><span class="badge ${x.kind==='rollback'?'b-warn':x.env==='prod'?'b-ok':'b-acc'}">${I(x.kind==='rollback'?'undo':x.env==='prod'?'flag':'layers')}${x.kind==='rollback'?'ロールバック':x.env==='prod'?'本番':'ステージング'}</span><span class="mono">${x.kind==='rollback'?E(x.from)+' → '+E(x.ver):E(x.ver)}</span></div>${x.note?`<div class="hint cl1" title="${E(x.note)}">${E(x.note)}</div>`:''}</td><td><div style="max-width:200px">${reqLink(x.req)}</div></td><td>${avn(x.by)}</td></tr>`).join('')}</tbody></table></div>`:emptyBox('layers','まだデプロイはありません');
 }else if(S.devTab==='metric'){
  const P=D.deploys.filter(x=>x.env==='prod'&&x.kind==='deploy'),k=devKpi();
  const lead=Object.values(D.lines).map(l=>{const f=P.filter(x=>x.req===l.req)[0];return f?(new Date(f.at)-new Date(l.at))/DAY:null}).filter(x=>x!=null&&x>=0).sort((a,b)=>a-b);
  const med=lead.length?lead[Math.floor((lead.length-1)/2)]:null;
  const rbs=D.deploys.filter(x=>x.kind==='rollback').map(rb=>{const f=D.deploys.filter(x=>x.req===rb.req&&x.env==='prod'&&x.kind==='deploy'&&x.ver===rb.from&&x.at<=rb.at).pop();return f?(new Date(rb.at)-new Date(f.at))/3600000:null}).filter(x=>x!=null);
  const mttr=rbs.length?rbs.reduce((a,b)=>a+b,0)/rbs.length:null;
  const wk=[];for(let i=7;i>=0;i--){const t1=Date.now()-i*7*DAY,t0=t1-7*DAY;const inw=x=>{const t=new Date(x.at).getTime();return t>t0&&t<=t1};wk.push({p:D.deploys.filter(x=>x.env==='prod'&&x.kind==='deploy'&&inw(x)).length,s:D.deploys.filter(x=>x.env==='stg'&&inw(x)).length,l:i?i+'週前':'今週'})}
  const mx=Math.max(1,...wk.map(w=>w.p+w.s));
  box.innerHTML=`<div class="mt">
   <div class="mtc"><div class="l">${I('flag','sm')}本番デプロイ（30日）</div><div class="v">${k.prod}<small> 回</small></div><div class="hint">ロールバック ${k.rb}回を含まない</div></div>
   <div class="mtc"><div class="l">${I('clock','sm')}Issue化から本番まで（中央値）</div><div class="v">${med==null?'—':med.toFixed(1)}<small> 日</small></div><div class="hint">本番に出た ${lead.length}件の依頼から計算</div></div>
   <div class="mtc"><div class="l">${I('undo','sm')}変更の失敗率（30日）</div><div class="v">${k.cfr}<small> %</small></div><div class="hint">ロールバック ÷ 本番デプロイ</div></div>
   <div class="mtc"><div class="l">${I('activity','sm')}復旧までの時間（平均）</div><div class="v">${mttr==null?'—':mttr.toFixed(1)}<small> 時間</small></div><div class="hint">本番デプロイからロールバックまで</div></div>
  </div>
  <div class="sec-h" style="margin-top:14px">${I('trend','sm')}週ごとのデプロイ数（濃い色＝本番、薄い色＝ステージング）</div>
  <div class="wk">${wk.map((w,i)=>`<div class="wb" title="${w.l}：本番 ${w.p}・ステージング ${w.s}"><small>${w.p+w.s||''}</small><i class="st" style="--i:${i};height:${w.s/mx*86}%"></i><i style="--i:${i};height:${w.p/mx*86}%"></i></div>`).join('')}</div>
  <div class="wkl">${wk.map(w=>`<span>${w.l}</span>`).join('')}</div>
  <div class="note n-acc" style="margin-top:12px">${I('info')}<div>マージ前の必須検査は ${CHECKS.filter(([k])=>isReq(k)).length} / 9件です。<button class="lk" data-a="goSet" data-v="devops" type="button">システム設定で変える</button></div></div>`;
 }else{
  const L=devLines();
  box.innerHTML=L.length?`<div class="dlist">${L.map((x,i)=>{const nx=lineNext(x.l,x.r),me1=nx.who===S.role;return `<div class="li dl${x.r.id===S.sel.devops?' on':''}" style="--i:${Math.min(i,14)}" data-a="devSel" data-id="${E(x.r.id)}">${cico(x.r.dept)}<div class="bd"><div class="t cl1" title="${E(x.r.title)}">${E(x.r.title)}</div><div class="m"><span class="mono">${E(x.r.id)}</span>${sb(x.r.status)}${sig(colorOf(x.r))}${x.l.pr?`<span>${I('loop','sm')}PR #${x.l.pr}</span>`:''}</div><div class="vis">${devStepsMini(x.l)}${ckMini(x.l)}</div></div><div class="dl-r"><span class="nxt${me1?' me':''}">${nx.k==='run'?'<i class="spin sm"></i>':I(nx.k==='done'?'check':'arrow','sm')}${E(nx.t)}</span>${nx.who?`<span class="badge ${me1?'b-acc':''}">${me1?'あなたの番':E(rl(nx.who))}</span>`:''}</div></div>`}).join('')}</div>`:emptyBox('loop','開発ラインに乗っている依頼はありません。依頼が承認されると、ここに並びます。');
 }
}
AFTER.devops=updDev;
/* ---------- 開発ラインの実行記録（サーバ） ----------
   正本の DevOps は見本の段階表示を持つ。実データはこのブロックに出す（投入・承認・配備・戻し）。 */
const DL_TTL=5000, DL_LIVE=['approved','dev','verify','field','release_wait','done'];
const DL_ROLES=['desk','approver','admin'];
const DL_STATE={queued:'待機',planning:'計画中',implementing:'実装中',verifying:'CIで検証中',revising:'修正中',pr_ready:'PR候補の準備完了（人の確認待ち）',reviewing:'人が確認中',approved:'承認済み（merge待ち）',merged:'merge済み（配備の承認待ち）',staged:'配備済み（検証環境）',released:'公開',closed:'終了',stopped:'停止',failed:'失敗',cancelled:'中止'};
const dlCache=new Map();
function dlOf(id){if(!dlCache.has(id))dlCache.set(id,{loaded:false,loading:false,loadedAt:0,items:[],handoffs:[],evidence:{},release:{},busy:false,msg:null});return dlCache.get(id)}
function dlRel(jobId){for(const s of dlCache.values()){if(s.release&&s.release[jobId])return s.release[jobId]}return {}}
function dlLoad(id,force){
 const s=dlOf(id);
 if(!window.__MSF__)return Promise.resolve();
 if(s.loading)return s.p;
 if(!force&&s.loaded&&Date.now()-(s.loadedAt||0)<DL_TTL)return Promise.resolve();
 s.loading=true;
 s.p=window.__MSF__.readJobs(id).then(res=>{
  s.loading=false;s.loadedAt=Date.now();s.loaded=!!res;
  if(res){s.items=Array.isArray(res.items)?res.items:[];s.handoffs=Array.isArray(res.handoffs)?res.handoffs:[];s.evidence=res.evidence||{};s.release=res.release||{};}
  if(S.view==='devops'&&S.sel.devops===id)updPane();
 }).catch(()=>{s.loading=false;s.loadedAt=Date.now();s.loaded=true;s.items=[];s.handoffs=[];s.msg='実行記録を読み込めませんでした';if(S.view==='devops'&&S.sel.devops===id)updPane()});
 return s.p;
}
function dlShort(v){const t=String(v||'');return t?t.slice(0,8):'—'}
async function dlAct(id,jobId,path,body,okMsg){
 const s=dlOf(id);if(s.busy)return;
 s.busy=true;s.msg=null;updPane();
 try{await window.__MSF__.api('POST','/api/jobs/'+encodeURIComponent(jobId)+'/'+path,body);s.msg=okMsg||'受け付けました';toast(s.msg,'ok','code');}
 catch(err){s.msg=(err&&err.message)||'処理を完了できませんでした';toast(s.msg,'bad');}
 s.busy=false;await dlLoad(id,true);
}
function dlReason(title,hint,cb){
 dlPending=cb;
 modal(I('msg')+E(title),`<p class="hint" style="margin:0 0 8px">${E(hint)}</p><textarea id="dlr" rows="3" placeholder="理由"></textarea>`,`<button class="btn ghost" data-a="closeModal" type="button">キャンセル</button><button class="btn" data-a="dlReasonOk" type="button">${I('check')}実行</button>`);
}
function dlHTML(r){
 const s=dlOf(r.id);
 if(!s.loaded){if(!s.loading)dlLoad(r.id);return `<div class="sec-h">${I('code','sm')}開発ラインの実行記録（サーバ）</div><div class="hint">読み込み中…</div>`}
 const jobs=s.items||[],hs=s.handoffs||[],h=hs[0]||null;
 const canHandoff=DL_ROLES.includes(S.role)&&DL_LIVE.includes(r.status)&&Number(r.__orderVersion)>0;
 const head=`<div class="dp-acts">${abtn('handoff','devHandoff','開発ラインへ投入（Issueを作る）','send',{id:r.id,cls:'ai',ready:true,off:s.busy?'処理中です':canHandoff?'':'依頼が「承認済み」になってから、または注文書の版ができるまで待ちます'})}<span class="hint">注文書 版 ${E(String(r.__orderVersion||0))}</span></div>`;
 const issues=hs.length?hs.slice(0,3).map(x=>`<div class="hint">版 ${E(String(x.orderVersion))}：${x.issueNo?('Issue #'+E(String(x.issueNo))):'—'}・${E(x.state==='succeeded'?'投入済み':x.state)}・${fmtS(x.updatedAt)}</div>`).join(''):'<div class="hint">まだ投入していません</div>';
 const jobRows=jobs.length?jobs.slice(0,3).map(j=>{
  const rel=(s.release[j.id]||{});
  const acts=[];
  if(j.state==='pr_ready'&&j.headSha)acts.push(abtn('merge','devMerge','merge を承認','check',{id:r.id,job:j.id,cls:'ok',ready:true}));
  if(['approved','merged','staged'].includes(j.state)&&rel.mergeSha&&rel.imageDigest)acts.push(abtn('prod','devDeploy','検証環境へ配備','layers',{id:r.id,job:j.id,cls:'ok',ready:true}));
  if(['pr_ready','merged','staged','released'].includes(j.state))acts.push(abtn('rollback','devRollbackBtn','戻す','undo',{id:r.id,job:j.id,cls:'ghost dng'}));
  if(['planning','implementing','verifying','revising','reviewing'].includes(j.state))acts.push(abtn('stop','devCancel','止める','pause',{id:r.id,job:j.id,cls:'ghost'}));
  if(['stopped','failed','cancelled'].includes(j.state))acts.push(abtn('resume','devResume','再開','play',{id:r.id,job:j.id,cls:'ghost'}));
  return `<div class="blk" style="margin-top:6px"><h5>${I('code','sm')}ジョブ（注文書 版 ${E(String(j.orderVersion))}）</h5>
   <div><span class="badge b-acc">${E(DL_STATE[j.state]||j.state)}</span>${j.orderCurrent?'':' <span class="badge b-warn">版が古い</span>'}${j.supersededAt?' <span class="badge">差し替え済み</span>':''}</div>
   <div class="hint">head ${E(dlShort(j.headSha))}・費用 ¥${Number(j.costJpy||0).toLocaleString('ja-JP')}・修復 ${Number(j.repairCountTotal||0)}回・更新 ${fmtS(j.updatedAt)}</div>
   ${rel.mergeSha?`<div class="hint">merge ${E(dlShort(rel.mergeSha))}・配備 ${E(rel.imageDigest?'あり':'—')}・環境 ${E(rel.environment||'')}</div>`:''}
   ${j.stopReason?`<div class="note n-warn" style="margin-top:4px">${I('pause')}<div>停止理由：${E(j.stopReason)}</div></div>`:''}
   ${acts.length?`<div class="dp-acts" style="margin-top:4px">${acts.join('')}</div>`:''}
  </div>`}).join(''):'<div class="hint">ジョブはまだありません。投入すると Issue が作られ、AI の実装が始まります。</div>';
 return `<div class="sec-h">${I('code','sm')}開発ラインの実行記録（サーバ）</div>
  ${head}${issues}${jobRows}
  ${s.msg?`<div class="note ${/できません|失敗|エラー/.test(s.msg)?'n-bad':'n-acc'}" style="margin-top:6px">${I('info')}<div>${E(s.msg)}</div></div>`:''}`;
}
let dlPending=null;

function devPane(){
 const l=lineOf(S.sel.devops),r=l&&find(l.req);
 if(!l||!r)return emptyBox('code','開発ラインの依頼を選ぶと、ここに進み具合と操作が1ページで出ます');
 const nx=lineNext(l,r),c=ckState(l),si=stageIdx(l),id=r.id,busy=!!l.running,D=S.data.devsec;
 const okSt=['dev','verify'].includes(r.status),prodSt=['field','done'].includes(r.status);
 const prev=prodPrev(l);
 const A={
  ai:()=>abtn('ai','devAI',l.pr?'AIで直す（再実装）':'AIで実装する','bot',{id,cls:'ai',ready:nx.k==='ai',off:busy?'実行中です':l.merged?'マージ済みです':l.ai.cost>=100?'AI作業の費用が上限に達しています（人が対応してください）':!okSt?'依頼を「実装中」にしてから実行します':''}),
  check:()=>abtn('check','devCheck','自動検査を実行','shieldok',{id,ready:nx.k==='check',off:busy?'実行中です':!l.pr?'まだ PR がありません':l.merged?'マージ済みです':''}),
  review:()=>abtn('review','devReview','レビューで承認','stamp',{id,cls:'ok',ready:nx.k==='review',off:busy?'実行中です':!c.ok?'必須の検査がすべて合格してから承認します':l.review==='ok'?'承認済みです':''}),
  merge:()=>abtn('merge','devMerge','マージする','loop',{id,ready:nx.k==='merge',off:l.merged?'マージ済みです':l.review!=='ok'?'レビューの承認が必要です':!c.ok?'必須の検査に合格していません':''}),
  stg:()=>abtn('stg','devStg','ステージングに配備','layers',{id,ready:nx.k==='stg',off:!l.merged?'マージしてから配備します':l.stg===l.ver?'配備済みです':''}),
  prod:()=>abtn('prod','devProd','本番にデプロイ','flag',{id,cls:'ok',ready:nx.k==='prod',off:l.stg!==l.ver?'ステージングに配備してから出します':l.prod===l.ver?'本番に出ています':!prodSt?'依頼が「現場試用」になってから出します':''})
 };
 const main=nx.k==='run'||nx.k==='done'?'':A[nx.k]();
 const others=['ai','check','review','merge','stg','prod'].filter(k=>k!==nx.k).filter(k=>({ai:!l.merged,check:!!l.pr&&!l.merged,review:!!l.pr&&l.review!=='ok',merge:l.review==='ok'&&!l.merged,stg:l.merged&&l.stg!==l.ver,prod:l.merged&&l.prod!==l.ver})[k]).map(k=>A[k]());
 const stNote=(nx.k==='ai'&&!okSt&&!l.merged)?`<div class="note n-warn" style="margin:8px 0 0">${I('info')}<div>依頼はいま「${statusOf(r.status).l}」です。AIの実装は「実装中」にしてから始めます。<button class="lk" data-a="devStatus" data-id="${E(id)}" data-v="dev" type="button">状態を変更</button></div></div>`
  :(nx.k==='prod'&&!prodSt)?`<div class="note n-warn" style="margin:8px 0 0">${I('helmet')}<div>本番に出すのは、現場での試用が始まってからです（いま「${statusOf(r.status).l}」）。<button class="lk" data-a="devStatus" data-id="${E(id)}" data-v="field" type="button">状態を変更</button></div></div>`
  :(nx.k==='done'&&r.status!=='done')?`<div class="note n-ok" style="margin:8px 0 0">${I('flag')}<div>本番に出ました。依頼を「完了」にできます（承認者）。<button class="lk" data-a="devStatus" data-id="${E(id)}" data-v="done" type="button">完了にする</button></div></div>`:'';
 const ev=S.data.audit.filter(a=>a.ref===id&&a.area==='devops').slice(-3).reverse();
 const keys=nx.k==='run'||nx.k==='done'?[]:[nx.k];
 const serverMode=!!window.__MSF__;
 const actionBlock=serverMode
  ? `<div class="dp-acts"><button class="btn ghost sm" data-a="devStatus" data-id="${E(id)}" type="button" title="依頼の状態を変える">${I('flag')}状態を変更</button></div>
 <div class="note n-acc">${I('info')}<div>上の段階と自動検査は見本です。実際の開発ラインは下の「実行記録（サーバ）」で確認・操作します。</div></div>`
  : `${busy?`<div class="busyrow"><i class="spin sm"></i>${l.running==='ai'?'AIが実装しています…（このサンプルでは数秒で終わります）':'自動検査を実行しています…'}</div>`:`<div class="dp-acts">${main}${others.join('')}<button class="btn ghost sm" data-a="devStatus" data-id="${E(id)}" type="button" title="依頼の状態を変える">${I('flag')}状態を変更</button></div>`}
 ${busy?'':gateFor(keys)}`;
 return `<div class="dp-h">${cico(r.dept,'lg')}<div class="dp-t"><div class="hint"><span class="mono">${E(id)}</span>　Issue #${l.issue}${l.pr?'　PR #'+l.pr:''}</div><h2 class="cl2" title="${E(r.title)}">${E(r.title)}</h2><div class="btns xs" style="margin-top:3px">${sb(r.status)}${sig(colorOf(r))}<button class="badge b-acc lk2" data-a="devOpen" data-id="${E(id)}" type="button" title="ボードで依頼の詳細を見る">${I('board')}依頼を開く</button></div></div></div>
 <div class="msteps dsteps">${DSTAGES.map((s,i)=>{const cc=i<si?'done':i===si?(c.fail&&i===2?'bad':'cur'):'';return `<span class="ms ${cc}" title="${s[0]}">${cc==='done'?I('check'):I(s[1])}</span>${i<DSTAGES.length-1?`<i class="ml${i<si?' done':''}"></i>`:''}`}).join('')}</div>
 <div class="dcap">${I('target','sm')}いま：<b>${si>=7?'本番で稼働中':E(DSTAGES[si][0])}</b>　次：<b>${E(nx.t)}</b>${nx.who?`（${E(rl(nx.who))}）`:''}</div>
 ${actionBlock}${stNote}
 <div class="sec-h">${I('shieldok','sm')}自動検査（必須 ${c.all}件のうち 合格 ${c.all-c.fail-c.pend}・不合格 ${c.fail}・未実行 ${c.pend}）</div>
 <div class="ckgrid">${CHECKS.map(([k,lb,ic],i)=>{const v=l.checks[k],run=l.running==='check'&&v!=='na';return `<div class="ck ${run?'run':v}" style="--i:${i}" title="${E(lb)}"><span class="ci2">${run?'<i class="spin sm"></i>':I(v==='pass'?'check':v==='fail'?'x':ic)}</span><div style="min-width:0"><b class="cl1">${E(lb)}</b><small>${run?'実行中':{pass:'合格',fail:'不合格',pend:'未実行',na:'対象外'}[v]}</small></div>${isReq(k)&&v!=='na'?'<span class="rq">必須</span>':''}</div>`}).join('')}</div>
 <div class="g2c">
  <div class="blk"><h5>${I('bot','sm')}AI作業</h5><div>${l.ai.runs}回・${l.ai.min}分</div><div class="mrow"><span class="meter"><i style="width:${Math.min(100,l.ai.cost)}%"></i></span><small>費用の上限の ${Math.min(100,l.ai.cost)}%</small></div></div>
  <div class="blk"><h5>${I('layers','sm')}環境（版 ${E(l.ver)}）</h5><div class="envs"><span class="env${l.stg?' on':''}">${I('layers','sm')}ステージング ${l.stg?E(l.stg):'—'}</span><span class="env${l.prod?' on':''}">${I('flag','sm')}本番 ${l.prod?E(l.prod):'—'}</span></div>${l.prod&&prev?`<div style="margin-top:5px">${abtn('rollback','devRollback','ロールバック（'+prev.ver+'へ）','undo',{id,cls:'ghost dng'})}</div>`:''}</div>
  <div class="blk"><h5>${I('user','sm')}レビュー</h5><div>${l.review==='ok'?`${I('check','sm')}承認済み（${E(l.reviewBy||'承認者')}）`:'<span class="hint">承認者のレビュー待ち</span>'}</div></div>
  <div class="blk"><h5>${I('code','sm')}ブランチ</h5><div class="mono cl1" title="${E(l.branch)}">${E(l.branch)}</div></div>
 </div>
 ${window.__MSF__?dlHTML(r):''}
 <div class="sec-h">${I('audit','sm')}この依頼の DevOps の記録（新しい順）</div>
 ${ev.length?`<ul class="tl c">${ev.map((a,i)=>`<li style="--i:${i}"><b>${E(a.action)}</b><small>${fmtS(a.at)}　${E(a.by)}</small>${a.note?`<div class="cl1 hint" title="${E(a.note)}">${E(a.note)}</div>`:''}</li>`).join('')}</ul>`:'<div class="hint">まだありません</div>'}`;
}

/* ===================== SecOps ===================== */
V.secops=function(){
 const k=secKpi(),v=S.data.devsec;
 const list=secList();
 if(!secFind(S.sel.secops)||!list.some(x=>x.id===S.sel.secops)){const f=list[0];S.sel.secops=f?f.id:''}
 return `${pageHead('shield','SecOps','脆弱性・セキュリティ通知・権限の棚卸し・品質ゲートを見て、期限までに対応します。操作はすべて監査ログに残ります。','b')}
 ${kstrip([{ic:'alert',l:'期限切れの脆弱性',v:k.over,c:k.over?'var(--bad)':'var(--ok)',alarm:k.over>0,go:['secTab','vuln','脆弱性を見る']},{ic:'clock',l:'7日以内に期限',v:k.soon,c:k.soon?'var(--warn)':'var(--ok)',go:['secTab','vuln','脆弱性を見る']},{ic:'zap',l:'未確認の通知',v:k.alert,c:k.alert?'var(--bad)':'var(--ok)',alarm:k.alert>0,go:['secTab','alert','通知を見る']},{ic:'users',l:'棚卸しの確認待ち',v:k.acc,c:k.acc?'var(--warn)':'var(--ok)',go:['secTab','access','棚卸しを見る']},{ic:'shieldok',l:'品質ゲートの要対応',v:k.gate,c:k.gate?'var(--warn)':'var(--ok)',go:['secTab','gate','品質ゲートを見る']}])}
 <div class="card rise" style="--i:6">${segTabs('secTab',S.secTab,[['vuln','脆弱性','bug',v.vulns.filter(vOpen).length,k.over>0],['alert','通知','zap',k.alert,k.alert>0],['access','権限の棚卸し','users',k.acc],['gate','品質ゲート','shieldok',k.gate]])}<div id="secbody"></div>
 <div class="btns" style="margin-top:10px"><button class="btn ghost sm" data-a="go" data-v="log" type="button">${I('audit')}監査ログを見る</button><span class="hint">${I('info','sm')} 数値とできごとは、操作を確かめるための見本です</span></div></div>`;
};
function secList(){
 const v=S.data.devsec;
 if(S.secTab==='alert')return v.alerts.slice().sort((a,b)=>({new:0,ack:1,closed:2}[a.status]-{new:0,ack:1,closed:2}[b.status])||(a.at<b.at?1:-1));
 if(S.secTab==='access')return v.access.slice().sort((a,b)=>(a.status==='pending'?0:1)-(b.status==='pending'?0:1));
 if(S.secTab==='gate')return gates().slice().sort((a,b)=>({bad:0,warn:1,ok:2}[a.s]-{bad:0,warn:1,ok:2}[b.s]));
 return v.vulns.slice().sort((a,b)=>{const oa=vOpen(a),ob=vOpen(b);if(oa!==ob)return oa?-1:1;return oa?vDue(a)-vDue(b):(a.found<b.found?1:-1)});
}
function secFind(id){const v=S.data.devsec;if(!id)return null;if(/^VUL/.test(id))return v.vulns.find(x=>x.id===id);if(/^ALT/.test(id))return v.alerts.find(x=>x.id===id);if(/^ACC/.test(id))return v.access.find(x=>x.id===id);if(/^G\d/.test(id))return gates().find(x=>x.id===id);return null}
function updSec(){
 const box=$('#secbody');if(!box)return;const a=secList(),on=x=>x.id===S.sel.secops?' on':'';
 if(!a.length){box.innerHTML=emptyBox('shieldok','ありません');return}
 if(S.secTab==='alert')box.innerHTML=`<div class="dlist">${a.map((x,i)=>`<div class="li sl${on(x)}" style="--i:${Math.min(i,14)}" data-a="secSel" data-id="${x.id}"><span class="aic" style="--cc:${x.status==='new'?'var(--bad)':'var(--mute)'}">${I('zap')}</span><div class="bd"><div class="t cl1">${E(x.title)}</div><div class="m"><span class="mono">${x.id}</span><span class="badge ${SEV[x.sev].cls}">${SEV[x.sev].l}</span><span class="badge ${AST[x.status][1]}">${AST[x.status][0]}</span><span>${fmtS(x.at)}</span></div><div class="hint cl1" title="${E(x.detail)}">${E(x.detail)}</div></div></div>`).join('')}</div>`;
 else if(S.secTab==='access')box.innerHTML=`<div class="dlist">${a.map((x,i)=>{const d=Math.floor((Date.now()-new Date(x.last))/DAY);return `<div class="li sl${on(x)}" style="--i:${Math.min(i,14)}" data-a="secSel" data-id="${x.id}">${av(x.name)}<div class="bd"><div class="t cl1">${E(x.name)}</div><div class="m"><span>${E(rl(x.role))}</span><span class="mono">${GROUP[x.role]||''}</span><span class="badge ${RST[x.status][1]}">${RST[x.status][0]}</span></div>${x.note?`<div class="hint cl1">${I('info','sm')} ${E(x.note)}</div>`:''}</div><div class="dl-r"><span class="due${d>=90?' bad':d>=30?' warn':''}">${d?'最終ログイン '+d+'日前':'今日ログイン'}</span></div></div>`}).join('')}</div>`;
 else if(S.secTab==='gate'){const g=S.data.devsec.gchk;box.innerHTML=`<div class="row" style="align-items:center;margin-bottom:8px">${abtn('gate','gateCheck','いま点検する','shieldok',{})}<span class="hint">${g.at?'最後の点検：'+fmtS(g.at)+'　'+E(g.by):'まだ点検していません'}</span></div><div class="dlist">${a.map((x,i)=>`<div class="li sl${on(x)}" style="--i:${Math.min(i,14)}" data-a="secSel" data-id="${x.id}"><span class="gst ${x.s}">${I(x.s==='ok'?'check':'alert')}</span><div class="bd"><div class="t cl1">${E(x.t)}</div><div class="hint cl1" title="${E(x.why)}">${E(x.why)}</div></div></div>`).join('')}</div>`}
 else box.innerHTML=`<div class="dlist">${a.map((x,i)=>`<div class="li sl${on(x)}" style="--i:${Math.min(i,14)}" data-a="secSel" data-id="${x.id}"><span class="aic" style="--cc:${x.sev==='critical'?'var(--bad)':x.sev==='high'?'var(--warn)':'var(--mute)'}">${I('bug')}</span><div class="bd"><div class="t cl1" title="${E(x.title)}">${E(x.title)}</div><div class="m"><span class="mono">${x.id}</span><span class="badge ${SEV[x.sev].cls}">${SEV[x.sev].l}</span><span class="badge ${VST[x.status][1]}">${VST[x.status][0]}</span><span class="cl1" style="max-width:160px">${E(x.comp)}</span></div></div><div class="dl-r">${dueHTML(x)}${x.owner?`<span class="hint">${E(x.owner)}</span>`:''}</div></div>`).join('')}</div>`;
}
AFTER.secops=updSec;
function secPane(){
 const id=S.sel.secops,x=secFind(id);
 if(!x)return emptyBox('shield','左の一覧から選ぶと、ここに中身と操作が1ページで出ます');
 const hd=(ic,col,t,sub,badges)=>`<div class="dp-h"><span class="pic" style="background:${col}">${I(ic,'lg')}</span><div class="dp-t"><div class="hint">${sub}</div><h2 class="cl2" title="${E(t)}">${E(t)}</h2><div class="btns xs" style="margin-top:3px">${badges}</div></div></div>`;
 const recent=S.data.audit.filter(a=>a.ref===id).slice(-3).reverse();
 const rec=`<div class="sec-h">${I('audit','sm')}この項目の記録</div>${recent.length?`<ul class="tl c">${recent.map((a,i)=>`<li style="--i:${i}"><b>${E(a.action)}</b><small>${fmtS(a.at)}　${E(a.by)}（${E(rl0(a.role))}）</small>${a.note&&a.note!==id?`<div class="cl1 hint" title="${E(a.note)}">${E(a.note)}</div>`:''}</li>`).join('')}</ul>`:'<div class="hint">まだありません</div>'}`;
 if(/^VUL/.test(id)){
  const open=vOpen(x),n=vLeft(x);
  const acts=[
   x.status==='open'?abtn('vtake','vTake','担当する','user',{id,ready:true}):'',
   ['open','doing'].includes(x.status)?abtn('vfix','vFix','修正済みにする','check',{id,cls:'ok',ready:x.status==='doing'}):'',
   ['open','doing'].includes(x.status)?abtn('vrisk','vRisk','リスク受容を申請','msg',{id,cls:'ghost'}):'',
   x.status==='riskreq'?abtn('vriskok','vRiskOk','リスク受容を承認','stamp',{id,cls:'ok',ready:true}):'',
   x.status==='riskreq'?abtn('vriskok','vRiskNg','差し戻す（対応中へ）','undo',{id,cls:'ghost'}):''
  ].filter(Boolean);
  const keys=x.status==='riskreq'?['vriskok']:open?['vfix']:[];
  return hd('bug',x.sev==='critical'?TONE.b:x.sev==='high'?TONE.h:TONE.n,x.title,`<span class="mono">${x.id}</span>　見つけた日 ${fmt(x.found,false)}`,`<span class="badge ${SEV[x.sev].cls}">深刻度：${SEV[x.sev].l}</span><span class="badge ${VST[x.status][1]}">${VST[x.status][0]}</span>${dueHTML(x)}`)+
  `${acts.length?`<div class="dp-acts">${acts.join('')}</div>`:''}${gateFor(keys)}
  ${open&&n<0?`<div class="note n-bad" style="margin:8px 0 0">${I('alert')}<div>修正期限（${SEV[x.sev].l}：見つけてから ${S.cfg.sla[x.sev]}日）を ${-n}日すぎています。</div></div>`:''}
  <div class="g2c"><div class="blk"><h5>${I('box','sm')}部品</h5><div class="cl1" title="${E(x.comp)}">${E(x.comp)}</div></div><div class="blk"><h5>${I('clock','sm')}修正期限</h5><div>${fmt(vDue(x).toISOString(),false)}<span class="hint">（${S.cfg.sla[x.sev]}日）</span></div></div>
  <div class="blk"><h5>${I('user','sm')}担当</h5><div>${x.owner?E(x.owner):'<span class="hint">まだいません</span>'}</div></div><div class="blk"><h5>${I('inbox','sm')}影響する依頼</h5><div class="cl1">${reqLink(x.req,'')}</div>${lineOf(x.req)?`<button class="lk" data-a="go" data-v="devops" data-id="${E(x.req)}" type="button">${I('code','sm')}DevOpsで見る</button>`:''}</div></div>
  <div class="blk" style="margin-top:7px"><h5>${I('msg','sm')}メモ</h5><div class="cl2" title="${E(x.note)}">${E(x.note||'—')}</div></div>${rec}`;
 }
 if(/^ALT/.test(id)){
  const acts=[x.status==='new'?abtn('ack','aAck','確認した','eye',{id,ready:true}):'',x.status==='ack'?abtn('ack','aClose','対応済みにする','check',{id,cls:'ok'}):''].filter(Boolean);
  return hd('zap',x.status==='new'?TONE.b:TONE.n,x.title,`<span class="mono">${x.id}</span>　${fmtS(x.at)}`,`<span class="badge ${SEV[x.sev].cls}">重要度：${SEV[x.sev].l}</span><span class="badge ${AST[x.status][1]}">${AST[x.status][0]}</span>`)+
  `${acts.length?`<div class="dp-acts">${acts.join('')}</div>`:''}${x.status!=='closed'?gateFor(['ack']):''}
  <div class="blk" style="margin-top:8px"><h5>${I('info','sm')}内容</h5><div>${E(x.detail)}</div></div>
  <div class="g2c"><div class="blk"><h5>${I('inbox','sm')}関係する依頼</h5><div class="cl1">${reqLink(x.ref,'')}</div></div><div class="blk"><h5>${I('user','sm')}確認した人</h5><div>${x.ackBy?E(x.ackBy):'<span class="hint">まだいません</span>'}</div></div></div>
  <div class="note n-acc">${I('shield')}<div>通知は、見本の監視ルールで出しています。本番では、ログの集約先（SIEM など）と結びます。</div></div>${rec}`;
 }
 if(/^ACC/.test(id)){
  const d=Math.floor((Date.now()-new Date(x.last))/DAY);
  const acts=x.status==='revoked'?[]:[abtn('access','accOk','継続を確認','check',{id,cls:'ok',ready:x.status==='pending'&&d<90}),abtn('access','accRevoke','権限を外す','x',{id,cls:'ghost dng',ready:d>=90})];
  return `<div class="dp-h">${av(x.name).replace('class="av"','class="av big"')}<div class="dp-t"><div class="hint"><span class="mono">${x.id}</span>　権限の棚卸し</div><h2>${E(x.name)}</h2><div class="btns xs" style="margin-top:3px"><span class="badge">${E(rl(x.role))}</span><span class="badge ${RST[x.status][1]}">${RST[x.status][0]}</span></div></div></div>
  ${acts.length?`<div class="dp-acts">${acts.join('')}</div>`:''}${x.status==='revoked'?'':gateFor(['access'])}
  ${x.note?`<div class="note ${d>=90?'n-bad':'n-warn'}" style="margin:8px 0 0">${I('alert')}<div>${E(x.note)}</div></div>`:''}
  <div class="g2c"><div class="blk"><h5>${I('users','sm')}グループ（提案）</h5><div class="mono">${GROUP[x.role]||'—'}</div></div><div class="blk"><h5>${I('clock','sm')}最終ログイン</h5><div>${d?d+'日前':'今日'}</div></div>
  <div class="blk"><h5>${I('stamp','sm')}最後の確認</h5><div>${x.at?fmtS(x.at)+'　'+E(x.by||''):'<span class="hint">まだです</span>'}</div></div><div class="blk"><h5>${I('lock','sm')}できること</h5><div class="cl2">${E(ROLEDESC[x.role]||'')}</div></div></div>
  <div class="note n-acc">${I('info')}<div>本番では、Entra ID のグループで役割を持たせ、ここでの結果をグループに反映します（このサンプルでは記録だけです）。</div></div>${rec}`;
 }
 const g=x;
 return hd(g.s==='ok'?'shieldok':'alert',g.s==='ok'?TONE.s:g.s==='bad'?TONE.b:TONE.h,g.t,`品質ゲート ${g.id}`,`<span class="badge ${g.s==='ok'?'b-ok':g.s==='bad'?'b-bad':'b-warn'}">${g.s==='ok'?'守られています':g.s==='bad'?'要対応':'注意'}</span>`)+
  `<div class="blk" style="margin-top:8px"><h5>${I('info','sm')}決まり</h5><div>${E(g.d)}</div></div>
  <div class="blk" style="margin-top:7px"><h5>${I('target','sm')}いまの状態</h5><div>${E(g.why)}</div></div>
  <div class="dp-acts">${abtn('gate','gateCheck','いま点検する','shieldok',{})}${g.tab?`<button class="btn ghost sm" data-a="secTab" data-v="${g.tab}" type="button">${I('bug')}脆弱性を見る</button>`:''}${g.set?`<button class="btn ghost sm" data-a="goSet" data-v="${g.set}" type="button">${I('gear')}システム設定を開く</button>`:''}</div>${gateFor(['gate'])}
  <div class="hint" style="margin-top:8px">${I('clock','sm')} 最後の点検：${S.data.devsec.gchk.at?fmtS(S.data.devsec.gchk.at)+'　'+E(S.data.devsec.gchk.by):'まだです'}</div>`;
}
const rl0=s=>String(s||'').replace(/（.*）/,'');

/* ---------- 利用者（サーバの管理者のみ） ---------- */
const UA={loaded:false,loading:false,items:[],error:''};
const isAdmin=()=>!!(window.__MSF__&&window.__MSF__.user&&window.__MSF__.user.isAdmin);
const ROLE_SHORT={requester:'依頼者',desk:'受付担当',approver:'承認者'};
function rolesLabel(rs){return (rs||[]).map(r=>ROLE_SHORT[r]||r).join('・')||'—'}
function loadUsers(force){
 if(!window.__MSF__||!isAdmin())return;
 if(UA.loading)return;
 if(UA.loaded&&!force)return;
 UA.loading=true;UA.error='';
 window.__MSF__.api('GET','/api/admin/users').then(res=>{UA.items=(res&&res.items)||[];UA.loaded=true;UA.loading=false;if(S.view==='settings'&&S.setTab==='users')updPane()})
  .catch(err=>{UA.loading=false;UA.error=(err&&err.message)||'利用者を読み込めませんでした';if(S.view==='settings'&&S.setTab==='users')updPane()});
}
function usersHTML(){
 if(!isAdmin())return `<div class="note n-warn">${I('lock')}<div>利用者の管理は管理者だけができます。いまの利用者には管理者の権限がありません。</div></div>`;
 if(!UA.loaded&&!UA.error){loadUsers();return `<div class="hint">利用者を読み込んでいます…</div>`}
 if(UA.error)return `<div class="note n-bad">${I('alert')}<div>${E(UA.error)}</div></div><div class="btns"><button class="btn ghost sm" data-a="uReload" type="button">読み直す</button></div>`;
 return `<div class="hint">サーバ（PostgreSQL）の利用者です。追加・無効化・パスワードの再設定ができます。</div>
 <div class="btns" style="margin:6px 0 8px"><button class="btn sm" data-a="uAdd" type="button">${I('plus')}利用者を追加</button><button class="btn ghost sm" data-a="uReload" type="button">${I('reset')}読み直す</button></div>
 <div class="dlist">${UA.items.map(u=>`<div class="li" style="--i:0">${av(u.displayName)}<div class="bd"><div class="t cl1">${E(u.displayName)}${u.isAdmin?' <span class="badge b-acc">管理者</span>':''}${u.isActive?'':' <span class="badge b-warn">無効</span>'}</div><div class="m"><span class="mono cl1">${E(u.email)}</span><span>${E(rolesLabel(u.roles))}</span><span class="mono">${E(u.deptCode)}</span></div></div><div class="btns xs"><button class="btn ghost sm" data-a="uPw" data-id="${E(u.id)}" type="button">パスワード</button><button class="btn ghost sm ${u.isActive?'dng':''}" data-a="uToggle" data-id="${E(u.id)}" data-v="${u.isActive?'0':'1'}" type="button">${u.isActive?'無効にする':'有効に戻す'}</button></div></div>`).join('')}</div>`;
}
function uAddModal(){
 if(!isAdmin()){toast('利用者の管理は管理者だけができます','bad','lock');return}
 const deptOpts=CATALOG.map(d=>`<option value="${d.id}">${E(d.name)}</option>`).join('');
 modal(`${I('user')}利用者を追加`,
  `<div class="fld"><div class="lbl">表示名<span class="req">必須</span></div><input id="uName" maxlength="80" placeholder="例：山田 太郎"></div>
   <div class="fld"><div class="lbl">メールアドレス<span class="req">必須</span></div><input id="uEmail" type="email" maxlength="200" placeholder="user@example.com"></div>
   <div class="fld"><div class="lbl">部署</div><select id="uDept">${deptOpts}</select></div>
   <div class="fld"><div class="lbl">役割<span class="req">必須</span></div><div class="chips">${['requester','desk','approver'].map(r=>`<label class="chip"><input type="checkbox" name="urole" value="${r}"${r==='requester'?' checked':''}> ${E(ROLE_SHORT[r])}</label>`).join('')}</div></div>
   <div class="fld"><div class="lbl">初期パスワード<span class="req">必須</span></div><input id="uPass" type="password" minlength="1" maxlength="200" autocomplete="new-password"></div>
   <label class="tog"><input type="checkbox" id="uAdmin"><span class="sw"></span><span class="tx"><b>管理者にする</b><small>利用者の管理ができます</small></span></label>`,
  `<button class="btn ghost" data-a="closeModal" type="button">キャンセル</button><button class="btn" data-a="uAddOk" type="button">${I('check')}追加する</button>`);
}
function uPwModal(id){
 const u=UA.items.find(x=>x.id===id);if(!u)return;
 modal(`${I('lock')}パスワードを再設定 <span class="hint mono">${E(u.email)}</span>`,
  `<div class="fld"><div class="lbl">新しいパスワード<span class="req">必須</span></div><input id="uNewPw" type="password" autocomplete="new-password"></div>`,
  `<button class="btn ghost" data-a="closeModal" type="button">キャンセル</button><button class="btn" data-a="uPwOk" data-id="${E(id)}" type="button">${I('check')}再設定する</button>`);
}

/* ---------- メール送信簿（承認依頼メール） ---------- */
const MA={loaded:false,loading:false,summary:null,items:[],error:''};
function loadMail(force){
 if(!window.__MSF__)return;
 if(MA.loading)return;
 if(MA.loaded&&!force)return;
 MA.loading=true;MA.error='';
 const p1=window.__MSF__.api('GET','/api/mail/status').catch(()=>null);
 const p2=window.__MSF__.api('GET','/api/mail/outbox?limit=20').then(r=>r&&Array.isArray(r.items)?r.items:[]).catch(err=>{MA.error=(err&&err.message)||'送信簿を読めません';return []});
 Promise.all([p1,p2]).then(([sum,items])=>{MA.summary=sum;MA.items=items;MA.loaded=true;MA.loading=false;if(S.view==='settings'&&S.setTab==='mail')updPane()});
}
function mailHTML(){
 if(!MA.loaded&&!MA.error){loadMail();return `<div class="hint">メールの状態を読み込んでいます…</div>`}
 const st=MA.summary||{};
 const badge=s=>`<span class="badge ${s==='sent'?'b-ok':s==='failed'?'b-bad':s==='sending'?'b-ai':'b-warn'}">${{pending:'送信待ち',sending:'送信中',sent:'送信済み',failed:'失敗'}[s]||s}</span>`;
 const rows=MA.items.length?MA.items.map(m=>`<div class="li" style="--i:0"><span class="aic" style="--cc:var(--accent)">${I('send')}</span><div class="bd"><div class="t cl1" title="${E(m.subject)}">${E(m.subject)}</div><div class="m"><span class="mono">${E(m.id)}</span>${badge(m.status)}<span class="hint">${E(m.to)}</span><span class="hint">${fmtS(m.sentAt||m.createdAt)}</span></div>${m.lastError?`<div class="hint cl1">${E(m.lastError)}</div>`:''}</div>${m.status==='failed'?`<button class="btn ghost sm" data-a="mRetry" data-id="${E(m.id)}" type="button">再送</button>`:''}</div>`).join(''):'<div class="hint">まだありません</div>';
 return `<div class="hint">${st.mode?('送信の方法：<b>'+E(st.mode)+'</b>'+(st.ready?'（送信できます）':'（設定が未完了です）')):'—'}${st.lastSentAt?('　最終送信 '+fmtS(st.lastSentAt)):''}</div>
 <div class="g2c" style="margin:6px 0 8px">
  <div class="blk"><h5>${I('clock','sm')}送信待ち</h5><div>${st.pending||0}</div></div>
  <div class="blk"><h5>${I('alert','sm')}失敗</h5><div>${st.failed||0}</div></div>
  <div class="blk"><h5>${I('check','sm')}送信済み</h5><div>${st.sent||0}</div></div>
 </div>
 <div class="btns" style="margin-bottom:8px"><button class="btn ghost sm" data-a="mReload" type="button">${I('reset')}読み直す</button>${isAdmin()?`<button class="btn ghost sm" data-a="mFlush" type="button">${I('send')}送信待ちを送る</button>`:''}</div>
 ${MA.error?`<div class="note n-warn">${I('alert')}<div>${E(MA.error)}</div></div>`:''}
 <div class="dlist">${rows}</div>
 <div class="note n-acc">${I('info')}<div>承認依頼メールの記録です。宛先と本文はここから変更できません（送る内容は依頼の内容から作られます）。</div></div>`;
}

/* ===================== システム設定 ===================== */
const SETS=[
 ['personal','表示（自分用）','monitor',true],['general','基本','gear'],['approvers','承認者','stamp'],['users','利用者','user'],['mail','メール','send'],['roles','役割と権限','users',true],
 ['devops','DevOps','code'],['secops','SecOps','shield'],['data','データ','db',true],['about','このアプリについて','info',true]
];
function themeNow(){return document.documentElement.dataset.theme||'auto'}
function setSum(k){
 const c=S.cfg;
 return {personal:'テーマ：'+{auto:'自動',light:'ライト',dark:'ダーク'}[themeNow()]+'／動き：'+(c.motion==='reduce'?'減らす':'PCに合わせる'),
  general:'組織名：'+(c.org||'（なし）')+'／スタンプ：'+c.stampName+'／起動時：'+(c.startLogin?'ログイン画面':'そのまま使う'),
  approvers:MSF_ON?(APV.available?APV.items.length+'人：'+APV.items.map(a=>a.displayName).join('・'):'承認者一覧を取得できません'):c.approvers.length+'人：'+c.approvers.join('・'),
  users:(window.__MSF__?(UA.loaded?UA.items.length+'人（有効 '+UA.items.filter(u=>u.isActive).length+'人）':'サーバの利用者を読み込みます'):'サーバ接続時のみ'),
  mail:(window.__MSF__?(MA.summary?('送信待ち '+MA.summary.pending+'・失敗 '+MA.summary.failed+'（'+MA.summary.mode+'）'):'承認依頼メールの状態'):'サーバ接続時のみ'),
  roles:'3つの役割と、できること（参照のみ）',
  devops:'マージ前の必須検査：9件中 '+CHECKS.filter(([k])=>isReq(k)).length+'件',
  secops:'修正期限：'+SEVK.map(k=>SEV[k].l+c.sla[k]+'日').join('・'),
  data:'依頼 '+S.data.items.length+'件・開発ライン '+Object.keys(S.data.devsec.lines).length+'件・監査ログ '+logCount()+'件',
  about:(window.__MSF__?'版 1.1・サーバ保存（PostgreSQL）':'版 1.1・完全オフライン・外部通信なし')}[k];
}
function logCount(){return S.data.items.reduce((a,r)=>a+(r.history||[]).length,0)+S.data.audit.length}
V.settings=function(){
 if(!SETS.some(s=>s[0]===S.setTab))S.setTab='personal';
 return `${pageHead('gear','システム設定','承認者・必須の検査・修正期限などを決めます。設定はこのブラウザに保存され、変更は監査ログに残ります。','n')}
 ${may('cfg')?'':`<div class="note n-warn rise" style="--i:1">${I('lock')}<div>システム設定を変えられるのは受付担当（IT・DX）です。いまの役割では見るだけです（「表示（自分用）」は、だれでも変えられます）。</div></div>`}
 <div class="card rise" style="--i:2"><div id="setleft"></div></div>`;
};
function updSetList(){
 const box=$('#setleft');if(!box)return;
 box.innerHTML=`<div class="dlist">${SETS.map((s,i)=>`<div class="li setc${s[0]===S.setTab?' on':''}" style="--i:${i}" data-a="setTab" data-v="${s[0]}"><span class="aic" style="--cc:var(--accent)">${I(s[2])}</span><div class="bd"><div class="t">${E(s[1])}</div><div class="hint cl2">${E(setSum(s[0]))}</div></div>${!s[3]&&!may('cfg')?`<span class="lkic" title="受付担当（IT・DX）が変更します">${I('lock','sm')}</span>`:''}</div>`).join('')}</div>`;
}
AFTER.settings=updSetList;
function setPane(){
 const k=S.setTab,c=S.cfg,s=SETS.find(x=>x[0]===k)||SETS[0],ro=!s[3]&&!may('cfg'),dis=ro?' disabled':'';
 const head=`<div class="dp-h" style="align-items:center"><span class="pic" style="background:${TONE.n}">${I(s[2],'lg')}</span><div class="dp-t"><div class="hint">システム設定</div><h2>${E(s[1])}</h2></div></div>${ro?gateFor(['cfg']):''}`;
 const rc=(name,val,cur,lb,ic,d)=>`<label class="rc${cur===val?' on':''}${d?' dis':''}"><input type="radio" name="${name}" value="${val}" data-cfg="${name}"${cur===val?' checked':''}${d?' disabled':''}>${I(ic)}<span>${lb}</span></label>`;
 let b='';
 if(k==='personal')b=`<div class="sec-h">${I('sun','sm')}テーマ</div><div class="opt3">${rc('theme','auto',themeNow(),'自動（PCに合わせる）','monitor')}${rc('theme','light',themeNow(),'ライト','sun')}${rc('theme','dark',themeNow(),'ダーク','moon')}</div>
  <div class="sec-h">${I('sparkles','sm')}動き（アニメーション）</div><div class="opt3 o2">${rc('motion','auto',c.motion,'PCの設定に合わせる','monitor')}${rc('motion','reduce',c.motion,'減らす','pause')}</div>
  <div class="note n-acc">${I('info')}<div>この2つは、自分のブラウザだけの設定です。監査ログには残りません。</div></div>`;
 else if(k==='general')b=`<div class="fld"><div class="lbl">${I('briefcase','sm')}組織名（ヘッダーとログイン画面に出ます）</div><input data-cfg="org" maxlength="40" value="${E(c.org)}" placeholder="例：〇〇建設 情報システム部"${dis}></div>
  <div class="fld"><div class="lbl">${I('stamp','sm')}受付スタンプの名前（12文字まで）</div><input data-cfg="stampName" maxlength="12" value="${E(c.stampName)}"${dis}></div>
  <label class="tog${ro?' dis':''}"><input type="checkbox" data-cfg="startLogin"${c.startLogin?' checked':''}${dis}><span class="sw"></span><span class="tx"><b>起動したとき、ログイン画面から始める</b><small>オフにすると、前回の人のまま使い始めます</small></span></label>`;
 else if(k==='users')b=usersHTML();
 else if(k==='mail')b=mailHTML();
 else if(k==='approvers')b=MSF_ON?`<div class="hint" style="margin-top:6px">新しい依頼の STEP 7 で選べる承認者です。承認者の追加・変更はサーバの利用者管理で行います（この画面では参照のみ）。</div>
  ${APV.available?(APV.items.map((a,i)=>`<div class="apvrow" style="--i:${i}">${av(a.displayName)}<b style="flex:1">${E(apvLabel(a))}</b><span class="lkic" title="サーバの利用者管理で変更します">${I('lock','sm')}</span></div>`).join('')||`<div class="note n-warn">${I('alert')}<div>有効な承認者が登録されていません。</div></div>`):`<div class="note n-bad">${I('alert')}<div>${E(APV.reason)}</div></div>`}
  <div class="note n-acc">${I('info')}<div>承認者名簿はサーバ（PostgreSQL）から読み込んでいます。変更は管理の手順で行ってください。</div></div>`:`<div class="hint" style="margin-top:6px">新しい依頼の STEP 7 で選べる承認者です。いま入っている依頼の承認者は変わりません。</div>
  ${c.approvers.map((a,i)=>`<div class="apvrow" style="--i:${i}">${av(a)}<b style="flex:1">${E(a)}</b>${i===0?'<span class="badge b-acc">新しい依頼の最初の候補</span>':''}<button class="btn ghost sm icon dng" data-a="apvDel" data-v="${E(a)}" type="button" title="${c.approvers.length<2?'最低1人は必要です':'外す'}"${ro||c.approvers.length<2?' disabled':''}>${I('trash')}</button></div>`).join('')}
  <div class="inrow"><input id="apvNew" maxlength="20" placeholder="名前を入力して追加（Enter）"${dis}><button class="btn sm" data-a="apvAdd" type="button"${dis}>${I('plus')}追加</button></div>`;
 else if(k==='roles'){
  const Y=`<span class="yes">${I('check')}</span>`,N='<span class="no">—</span>',row=(t,f)=>`<tr><td>${t}</td>${ROLES.map(r=>`<td>${f(r.k)?Y:N}</td>`).join('')}</tr>`,cm=(a,b)=>rk=>canMove(rk,a,b);
  b=`<table class="mx"><thead><tr><th>できること</th>${ROLES.map(r=>`<th>${E(rl(r.k))}</th>`).join('')}</tr></thead><tbody>
  ${row('依頼を出す',()=>true)}${row('受付 → 内容確認中 → 承認待ちへ進める',cm('received','review'))}${row('承認する（信号の色を決める）・完了にする',cm('wait','approved'))}${row('差戻し',cm('wait','back'))}${row('見送り（受付・差戻しの依頼）',cm('received','hold'))}${row('依頼を削除',rk=>rk!=='requester')}
  ${row('DevOps：AIで実装・検査・マージ・配備',rk=>CAN.ai.includes(rk))}${row('DevOps：レビュー承認・本番デプロイ',rk=>CAN.prod.includes(rk))}${row('SecOps：脆弱性の対応・ゲートの点検',rk=>CAN.vfix.includes(rk))}${row('SecOps：リスク受容の承認・権限の棚卸し',rk=>CAN.access.includes(rk))}${row('SecOps：通知の確認',rk=>CAN.ack.includes(rk))}${row('システム設定の変更',rk=>CAN.cfg.includes(rk))}
  </tbody></table>
  <div class="blk" style="margin-top:8px"><h5>${I('lock','sm')}本人確認</h5><div>いま：<b>${window.__MSF__?'サーバのセッション（Cloudflare Access / パスワード）':'サンプル（操作する人を選ぶだけ）'}</b></div><div class="hint">${window.__MSF__?'役割はサーバの利用者情報に従います。画面右上の「操作する人」は動作確認用の切り替えです。':`本番の想定：Entra ID のシングルサインオンで本人を確かめ、グループ（${Object.values(GROUP).join('・')}）で役割を決めます。`}</div></div>`;
 }
 else if(k==='devops')b=`<div class="hint" style="margin-top:6px">マージする前に、合格していなければならない検査です。ビルドとシークレットは外せません。</div>
  ${CHECKS.map(([ck,lb,ic])=>{const lk=CHK_LOCK.includes(ck),d=ro||lk;return `<label class="tog${d?' dis':''}"><input type="checkbox" data-cfg="req.${ck}"${isReq(ck)?' checked':''}${d?' disabled':''}><span class="sw"></span>${I(ic)}<span class="tx"><b>${E(lb)}</b>${lk?'<small>いつも必須（外せません）</small>':ck==='offline'?'<small>現場向けの道具だけ</small>':''}</span></label>`}).join('')}`;
 else if(k==='secops')b=`<div class="hint" style="margin-top:6px">脆弱性を見つけてから直すまでの期限（日数・1〜365）です。期限切れは SecOps と品質ゲートに出ます。</div>
  ${SEVK.map(sv=>`<div class="slarow"><span class="badge ${SEV[sv].cls}">${SEV[sv].l}</span><span class="hint">見つけてから</span><span class="dnum"><input type="number" min="1" max="365" step="1" data-cfg="sla.${sv}" value="${c.sla[sv]}"${dis}><small>日</small></span></div>`).join('')}`;
 else if(k==='data'){
  const v=S.data.devsec;
  b=`<div class="g2c"><div class="blk"><h5>${I('db','sm')}保存先</h5><div>${window.__MSF__?'サーバ（PostgreSQL）':(S.persistent?'このブラウザ（localStorage）':'一時的（閉じると消えます）')}</div></div><div class="blk"><h5>${I('inbox','sm')}依頼</h5><div>${S.data.items.length}件</div></div><div class="blk"><h5>${I('code','sm')}開発ライン・デプロイ</h5><div>${Object.keys(v.lines).length}件・${v.deploys.length}回</div></div><div class="blk"><h5>${I('audit','sm')}監査ログ</h5><div>${logCount()}件</div></div></div>
  <div class="sec-h">${I('download','sm')}書き出し・取り込み</div><div class="btns"><button class="btn ghost sm" data-a="exportJSON" type="button">${I('download')}JSONで書き出す</button><button class="btn ghost sm" data-a="importPick" type="button">${I('upload')}JSONを取り込む</button><button class="btn ghost sm" data-a="auditCsv" type="button">${I('audit')}監査ログをCSVで</button></div>
  <div class="hint" style="margin-top:4px">JSONには、依頼・DevOps・SecOps・監査ログが入ります。システム設定は入りません。</div>
  <div class="sec-h">${I('reset','sm')}初期化</div><div class="btns"><button class="btn ghost sm dng" data-a="reset" type="button">${I('reset')}データをサンプルに戻す</button><button class="btn ghost sm dng" data-a="cfgReset" type="button"${dis}>${I('gear')}設定を初期値に戻す</button></div>`;
 }
 else b=`<dl class="kv" style="margin-top:8px"><dt>${I('factory','sm')}名前</dt><dd>ソフトウェアファクトリーステーション</dd><dt>${I('tag','sm')}版</dt><dd>1.1（DevOps・SecOps・システム設定・監査ログ）</dd><dt>${I('globe','sm')}通信</dt><dd>${window.__MSF__?'サーバ（同一オリジンの API）と通信します。依頼は PostgreSQL に保存されます。':'しません（完全オフライン。外部のライブラリ・フォントも読み込みません）'}</dd><dt>${I('db','sm')}保存のキー</dt><dd class="mono">${E(KEY)}・${E(KEY)}-settings・${E(KEY)}-theme・${E(KEY)}-session</dd><dt>${I('info','sm')}位置づけ</dt><dd>${window.__MSF__?'受付ステーションの画面です。依頼はサーバに保存されます。DevOps・SecOps の数値とできごとは見本です。':'操作を確かめるためのサンプルです。人名・数値は架空です。'}</dd></dl>`;
 return head+b;
}
function setCfg(t){
 const k=t.dataset.cfg,c=S.cfg,personal=['theme','motion'].includes(k);
 if(!personal&&!may('cfg')){toast('システム設定を変えられるのは受付担当（IT・DX）です','bad','lock');updPane();return}
 let note='',repane=false;
 if(k==='theme'){const v=t.value;if(v==='auto'){delete document.documentElement.dataset.theme;try{localStorage.removeItem(KEY+'-theme')}catch(e){}}else{document.documentElement.dataset.theme=v;try{localStorage.setItem(KEY+'-theme',v)}catch(e){}}updTheme();repane=true}
 else if(k==='motion'){c.motion=t.value==='reduce'?'reduce':'auto';applyMotion();repane=true}
 else if(k==='org'){const v=t.value.trim().slice(0,40);if(v===c.org)return;note='組織名：「'+(c.org||'なし')+'」→「'+(v||'なし')+'」';c.org=v;applyOrg()}
 else if(k==='stampName'){const v=t.value.trim().slice(0,12);if(!v){toast('受付スタンプの名前を入れてください','bad');t.value=c.stampName;return}if(v===c.stampName)return;note='受付スタンプの名前：「'+c.stampName+'」→「'+v+'」';c.stampName=v;applyOrg()}
 else if(k==='startLogin'){c.startLogin=t.checked;note='起動したとき、ログイン画面から'+(t.checked?'始める':'始めない')}
 else if(k.indexOf('req.')===0){const ck=k.slice(4);if(CHK_LOCK.includes(ck)||!(ck in c.req))return;c.req[ck]=t.checked;note='マージ前の必須検査：「'+CKL(ck)+'」を'+(t.checked?'必須にしました':'必須から外しました')}
 else if(k.indexOf('sla.')===0){const sv=k.slice(4),v=Math.round(+t.value);if(!(sv in c.sla))return;if(!(v>=1&&v<=365)){toast('1〜365の日数で入れてください','bad');t.value=c.sla[sv];return}if(v===c.sla[sv])return;note='修正期限（'+SEV[sv].l+'）：'+c.sla[sv]+'日 → '+v+'日';c.sla[sv]=v}
 else return;
 if(!saveCfg())toast('このブラウザでは設定を保存できません（開いている間だけ有効です）','bad');
 if(note){addAudit('settings','設定を変更',note,'set:'+(k.split('.')[0]==='req'?'devops':k.split('.')[0]==='sla'?'secops':['org','stampName','startLogin'].includes(k)?'general':k));persist();toast('設定を保存しました','ok','gear')}
 renderNav();updSetList();if(repane)updPane();
}
function apvAdd(){
 if(!may('cfg')){toast('システム設定を変えられるのは受付担当（IT・DX）です','bad','lock');return}
 const el=$('#apvNew');if(!el)return;const v=el.value.trim().slice(0,20);
 if(!v){toast('名前を入れてください','bad');return}
 if(S.cfg.approvers.includes(v)){toast('すでに入っています','bad');return}
 S.cfg.approvers.push(v);saveCfg();addAudit('settings','設定を変更','承認者に「'+v+'」を追加','set:approvers');persist();toast('承認者に追加しました','ok','stamp');updSetList();updPane();
 const n=$('#apvNew');if(n)try{n.focus()}catch(e){}
}

/* ===================== 監査ログの右端パネル（依頼の履歴以外） ===================== */
function refLabel(ref){
 if(!ref)return '';const r=find(ref);if(r)return r.id+'　'+r.title;
 const x=secFind(ref);if(x)return ref+'　'+(x.title||x.t||x.name||'');
 if(ref==='G')return '品質ゲート';
 if(ref.indexOf('set:')===0){const s=SETS.find(z=>z[0]===ref.slice(4));return 'システム設定 › '+(s?s[1]:ref.slice(4))}
 return ref;
}
function auditPane(a){
 const ar=AREA[a.area]||AREA.req,r=find(a.ref),same=a.ref?S.data.audit.filter(x=>x.ref===a.ref&&x.id!==a.id).slice(-3).reverse():[];
 let go='';
 if(r&&lineOf(r.id)&&a.area==='devops')go=`<button class="btn ghost sm" data-a="go" data-v="devops" data-id="${E(r.id)}" type="button">${I('code')}DevOpsで見る</button>`;
 else if(/^(VUL|ALT|ACC)/.test(a.ref))go=`<button class="btn ghost sm" data-a="secOpen" data-id="${E(a.ref)}" type="button">${I('shield')}SecOpsで見る</button>`;
 else if(a.ref==='G')go=`<button class="btn ghost sm" data-a="secTab" data-v="gate" type="button">${I('shieldok')}品質ゲートを見る</button>`;
 else if(a.ref.indexOf('set:')===0)go=`<button class="btn ghost sm" data-a="goSet" data-v="${E(a.ref.slice(4))}" type="button">${I('gear')}システム設定を開く</button>`;
 if(r)go+=`<button class="btn ghost sm" data-a="logSel" data-id="${E(r.id)}" type="button">${I('clock')}依頼の履歴を見る</button>`;
 return `<div class="dp-h"><span class="pic" style="background:${ar[2]}">${I(ar[1],'lg')}</span><div class="dp-t"><div class="hint"><span class="mono">${E(a.id)}</span>　${fmt(a.at)}</div><h2>${E(a.action)}</h2><div class="btns xs" style="margin-top:3px"><span class="badge" style="color:${ar[2]}">${I(ar[1])}${ar[0]}</span>${avn(a.by)}<span class="hint">${E(rl0(a.role))}</span></div></div></div>
 <dl class="kv" style="margin-top:10px"><dt>${I('clock','sm')}日時</dt><dd>${fmt(a.at)}</dd><dt>${I('user','sm')}操作者</dt><dd>${E(a.by)}（${E(a.role)}）</dd><dt>${I('target','sm')}対象</dt><dd>${a.ref?E(refLabel(a.ref)):'—'}</dd><dt>${I('msg','sm')}内容</dt><dd>${a.note?E(a.note):'—'}</dd></dl>
 ${go?`<div class="dp-acts">${go}</div>`:''}
 ${same.length?`<div class="sec-h">${I('audit','sm')}同じ対象のほかの記録</div><ul class="tl c">${same.map((x,i)=>`<li style="--i:${i}"><b>${E(x.action)}</b><small>${fmtS(x.at)}　${E(x.by)}</small>${x.note?`<div class="cl1 hint" title="${E(x.note)}">${E(x.note)}</div>`:''}</li>`).join('')}</ul>`:''}
 <div class="note n-acc" style="margin-top:10px">${I('lock')}<div>監査ログは追記だけです。この画面から書きかえ・削除はできません（データの初期化・取り込みをすると、まるごと置きかわります）。</div></div>`;
}

function devRefresh(){if(S.view==='devops')render();else renderNav()}
function secRefresh(){if(S.view==='secops')render();else renderNav()}


/* ===================== 描画・演出 ===================== */
function render(){
 renderNav();
 const html=(V[S.view]||V.dash)();
 const selKey=S.view+':'+(S.sel[S.view]||'')+(S.view==='new'?S.step:'');
 const fresh=S.view!==lastView,freshSel=!fresh&&selKey!==lastSel;
 lastView=S.view;lastSel=selKey;
 const m=$('#main'),sp=SPLIT.includes(S.view),w0=$('#work');
 const keep=sp&&!fresh&&w0?w0.scrollTop:0;
 m.className=(RM?'':(fresh?'anim':freshSel?'anim-d':''))+(sp?' split':'');
 m.innerHTML=sp?`<div class="work" id="work" tabindex="0">${html}</div><aside class="rpane" id="rpane" aria-label="右端パネル（要点を1ページで表示）"><div class="rin anim-in" id="rin"></div></aside>`:html;
 if(sp&&keep)$('#work').scrollTop=keep;
 if(fresh&&!RM)countUp();
 if(AFTER[S.view])AFTER[S.view]();
 if(sp)updPane();
 $('#role').value=S.role;updActor();
}
function go(v,id){S.view=v;if(id)S.sel[v]=id;if(v==='log')S.dtab='log';closeDrawer();render();const w=$('#work')||$('#main');if(w)w.scrollTop=0}
function countUp(){
 $$('#main [data-count]').forEach(el=>{
  const to=Number(el.dataset.count)||0,suf=el.dataset.suf||'';if(!to)return;
  const t0=performance.now(),d=1000;el.textContent='0'+suf;
  const f=t=>{const p=Math.min(1,(t-t0)/d),e=1-Math.pow(1-p,3);el.textContent=Math.round(to*e)+suf;if(p<1)requestAnimationFrame(f)};
  requestAnimationFrame(f);
 });
}
function updActor(){const el=$('#actorav');if(el)el.innerHTML=av(me().name)}
function toast(msg,kind,ic){
 const el=document.createElement('div');el.className='toast '+(kind||'');
 el.innerHTML=`${I(ic||(kind==='bad'?'alert':kind==='ok'?'check':'info'))}<span>${E(msg)}</span><i class="tbar"></i>`;
 $('#toast').appendChild(el);
 setTimeout(()=>{el.classList.add('out');setTimeout(()=>el.remove(),320)},3200);
}
function confetti(n){
 if(RM)return;
 const box=document.createElement('div');box.className='confetti';
 const cols=['#1d5fc4','#6941c6','#22b463','#f0b400','#e3403a','#5c9bff','#22c55e','#0ea5e9'];
 for(let i=0;i<n;i++){const s=document.createElement('i');s.style.left=(Math.random()*100)+'%';s.style.background=cols[i%cols.length];s.style.animationDuration=(1.8+Math.random()*1.6)+'s';s.style.animationDelay=(Math.random()*.35)+'s';s.style.setProperty('--r',(Math.random()*900-450)+'deg');s.style.setProperty('--x',(Math.random()*200-100)+'px');if(i%3===0)s.style.borderRadius='50%';box.appendChild(s)}
 document.body.appendChild(box);setTimeout(()=>box.remove(),4000);
}
function setRole(k){S.role=k;if(window.__MSF__)window.__MSF__.switchRole(k);toast(me().name+'／'+me().l.replace(/（.*）/,'')+' として操作します','','user');render();if(S.open)renderDrawer()}

/* ---------- ログアウト／ログイン（サンプル：操作する人を選ぶだけ。本人確認はしない） ---------- */
const SKEY=KEY+'-session';
const ROLEDESC={requester:'依頼を出す。差戻しを直して出し直す',desk:'中身を確かめて、承認を依頼する。進み具合を動かす',approver:'信号の色を決めて、承認・完了にする'};
let authSel='requester',authAt='';
function sessGet(){try{const v=localStorage.getItem(SKEY);return v?JSON.parse(v):null}catch(e){return null}}
function sessSet(o){try{if(o)localStorage.setItem(SKEY,JSON.stringify(o));else localStorage.removeItem(SKEY);return true}catch(e){return false}}
const authOpen=()=>$('#auth').classList.contains('open');
function setLock(on){[$('header.top'),$('.shell')].forEach(el=>{if(!el)return;if(on){el.setAttribute('inert','');el.setAttribute('aria-hidden','true')}else{el.removeAttribute('inert');el.removeAttribute('aria-hidden')}})}
function renderAuth(){
 $('#auth').innerHTML=`<div class="authcard">
  <div class="authhd"><span class="logo">${I('factory')}</span><div><b id="authttl">ソフトウェアファクトリーステーション</b><small>${E(brandSub())}</small></div></div>
  ${authAt?`<div class="authmsg" role="status">${I('check')}<span>ログアウトしました（${E(authAt)}）。保存した依頼は、このブラウザに残っています。</span></div>`:''}
  <h2>${I('login')}ログイン</h2>
  <p class="lead">操作する人を選んで、ログインしてください。</p>
  <div class="who" role="radiogroup" aria-label="操作する人">${ROLES.map(r=>`<label class="${r.k===authSel?'on':''}"><input type="radio" name="authrole" value="${r.k}"${r.k===authSel?' checked':''}>${av(r.name)}<span class="wt"><b>${E(r.name)}（${E(r.l.replace(/（.*）/,''))}）</b><small>${E(ROLEDESC[r.k]||'')}</small></span><span class="wc">${I('check')}</span></label>`).join('')}</div>
  <button class="btn go" data-a="login" type="button">${I('login')}ログイン</button>
  <p class="authnote">${I('info')}<span>このサンプルは、パスワードなどの本人確認をしません。操作する人を選ぶだけで入れます。</span></p>
 </div>`;
}
function showAuth(at){
 authAt=at?fmt(at):'';renderAuth();$('#auth').classList.add('open');setLock(true);
 const f=$('#auth input:checked');if(f)try{f.focus({preventScroll:true})}catch(e){}
}
function endSession(at){
 authSel=S.role;
 S.draft=null;S.editId=null;S.step=0;S.fresh=null;S.sel={};S.fq='';S.fd='';S.fs='';S.fc='';S.catq='';S.logq='';S.pickDept='';S.dtab='sum';S.dpTab='card';S.view='dash';S.devTab='line';S.secTab='vuln';S.setTab='personal';S.logk='';
 closeModal();closeDrawer();$$('#toast .toast').forEach(t=>t.remove());
 lastView=null;render();showAuth(at);
}
function doLogout(){
 const at=new Date().toISOString();addAudit('auth','ログアウト','','');persist();
 if(window.__MSF__){
  window.__MSF__.api('POST','/api/auth/logout',{}).catch(()=>undefined).then(()=>{location.replace(window.__MSF__.logoutUrl||'/login')});
  return;
 }
 sessSet({out:true,at,role:S.role});endSession(at);
}
function doLogin(){
 if(!authOpen())return;
 const v=($('#auth input[name=authrole]:checked')||{}).value||authSel;
 sessSet(null);S.role=ROLES.some(r=>r.k===v)?v:'requester';addAudit('auth','ログイン','','');persist();
 $('#auth').classList.remove('open');$('#auth').innerHTML='';setLock(false);
 lastView=null;render();
 toast(me().name+'／'+me().l.replace(/（.*）/,'')+' としてログインしました','ok','login');
}

/* ---------- ドロワー（ダッシュボード・一覧から開く詳細。中身は右端パネルと同じ1ページ） ---------- */
function openDrawer(id,tab){if(!find(id))return;S.open=id;S.dtab=tab||'sum';const d=$('#drawer');d.classList.add('open');d.setAttribute('aria-hidden','false');$('#dmask').classList.add('show');renderDrawer()}
function closeDrawer(){S.open=null;const d=$('#drawer');d.classList.remove('open');d.setAttribute('aria-hidden','true');$('#dmask').classList.remove('show')}
function renderDrawer(){
 const r=find(S.open);if(!r){closeDrawer();return}
 $('#drawer').innerHTML='<div class="rin anim-in" id="din">'+paneDetail(r,true)+'</div>';fitPane($('#din'));
}

/* ---------- モーダル ---------- */
function modal(title,body,foot){modalHook=null;$('#modal').innerHTML=`<div class="card"><h2 class="mt0">${title}</h2><div>${body}</div>${foot?`<div class="mft">${foot}</div>`:''}</div>`;$('#modal').classList.add('open')}
/* 閉じたら中身も消す（入力したパスワードなどを DOM に残さない。開く前と同じ空の状態へ戻す） */
function closeModal(){const m=$('#modal');m.classList.remove('open');m.innerHTML='';modalHook=null;confirmFn=null;setBusy(false)}
function confirmBox(t,msg,ok,fn,danger){modal(I('alert')+E(t),`<p style="margin:0">${E(msg)}</p>`,`<button class="btn ghost" data-a="closeModal" type="button">キャンセル</button><button class="btn ${danger?'bad':''}" data-a="cfok" type="button">${I('check')}${E(ok)}</button>`);confirmFn=fn}
function openStatus(r,preset){
 const j=judge(r),def=preset||NEXT[r.status],any=STATUSES.some(s=>canMove(S.role,r.status,s.k));
 modal(`${I('flag')}状態を変更 <span class="hint mono">${E(r.id)}</span>`,
  `<div class="btns" style="margin-bottom:10px"><span class="hint">いま</span>${sb(r.status)}<span class="hint">操作する人</span>${avn(me().name)}<span class="hint">（${E(me().l)}）</span></div>
  <div class="stopts">${STATUSES.map(s=>{const ok=canMove(S.role,r.status,s.k),sel=ok&&s.k===def;return `<label class="${ok?'':'dis'}"><input type="radio" name="ns" value="${s.k}"${ok?'':' disabled'}${sel?' checked':''}>${sb(s.k)}</label>`}).join('')}</div>
  ${any?`<div class="hint" style="margin-top:6px">${I('lock','sm')} 「承認済み」「完了」にできるのは承認者だけです。</div>`:`<div class="note n-warn">${I('lock')}<div>いまの役割では変更できる状態がありません。画面右上の「操作する人」を切り替えてください。</div></div>`}
  <div class="apv" id="apv" style="display:none"><b>${I('flag','sm')} 信号の色を決める</b> <span class="hint">候補：${sig(j.c)}　迷ったら1つ上の色に</span>
   <div class="sgopts">${['g','y','r'].map(c=>`<label><input type="radio" name="fc" value="${c}"${(r.signalFinal||j.c)===c?' checked':''}>${sig(c)}<span class="hint">${COLORS[c].n}</span></label>`).join('')}</div>
   <div class="redw" id="redw"><label><input type="checkbox" id="redok"><span>赤信号の仕事は<b>AIに決めさせません</b>。道具の範囲が「材料集め・表示」までで、決定は人が行うことを確認しました。</span></label></div></div>
  <div class="lbl" style="margin-top:12px">${I('msg','sm')}メモ <span class="hint">（差戻し・見送り・取消${needReason(r.status,'dev')?'・実装中への戻し':''}は必須）</span></div><textarea id="nnote" rows="2" style="min-height:64px" placeholder="例：合格の条件を数字で書き直してください"></textarea>`,
  `<button class="btn ghost" data-a="closeModal" type="button">キャンセル</button><button class="btn" data-a="sok" data-id="${E(r.id)}" type="button"${any?'':' disabled'}>${I('check')}変更する</button>`);
 const upd=()=>{const v=($('#modal input[name=ns]:checked')||{}).value,fc=($('#modal input[name=fc]:checked')||{}).value;const a=$('#apv');if(a)a.style.display=v==='approved'?'block':'none';const w=$('#redw');if(w)w.classList.toggle('show',v==='approved'&&fc==='r')};
 modalHook=upd;upd();
}
/* 理由（メモ）が必須の状態変更。サーバの isReasonRequired（src/shared/domain.ts）が必須とする組をすべて含む（差戻し・見送りは従来どおり常に必須） */
function needReason(from,to){return ['back','hold','cancel'].includes(to)||(to==='dev'&&['field','release_wait'].includes(from))}
function applyStatus(id){
 const r=find(id);if(!r)return;
 const v=($('#modal input[name=ns]:checked')||{}).value,note=$('#nnote').value.trim();
 if(!v){toast('変更先を選んでください','bad');return}
 if(!canMove(S.role,r.status,v)){toast('いまの役割ではできません','bad','lock');return}
 if(needReason(r.status,v)&&!note){toast('理由をメモに書いてください','bad');return}
 let extra='',fc='';
 if(v==='approved'){fc=($('#modal input[name=fc]:checked')||{}).value;if(!fc){toast('信号の色を選んでください','bad');return}if(fc==='r'&&!$('#redok').checked){toast('赤信号の確認にチェックしてください','bad','shield');return}r.signalFinal=fc;extra='信号の色を「'+COLORS[fc].l+'」に決定'}
 const now=nowISO();r.history=r.history||[];r.history.push({at:now,by:me().name,role:me().l,action:'状態を「'+statusOf(v).l+'」に変更',note:[extra,note].filter(Boolean).join('／')});
 if(note){r.comments=r.comments||[];r.comments.push({at:now,by:me().name,text:note})}
 r.status=v;r.updatedAt=now;persist();S.fresh=r.id;
 closeModal();render();if(S.open)renderDrawer();
 if(v==='approved')lineModal(r,fc);
 else{toast(r.id+' を「'+statusOf(v).l+'」にしました',v==='back'?'':'ok',statusOf(v).ic);if(v==='done')confetti(110)}
}
function lineModal(r,fc){
 const steps=[['stamp','承認記録を保存（承認者・メモ）'],['flag','信号の色を「'+COLORS[fc].l+'（'+COLORS[fc].n+'）」に確定'],['doc','注文書（作業指示書・YAML）を確定版にする'],['bot','DevOps の開発ラインに Issue を作り、ボードの「承認済み」列に並べる（次はAIが実装）'],['audit','監査ログに記録（このサンプルでは通知は送りません）']];
 modal(`<span class="rm-h"><span class="pic" style="background:${TONE.s}">${I('stamp','lg')}</span><span>承認完了<div class="hint" style="font-weight:400">${E(r.id)}　${E(r.title)}</div></span></span>`,
  `<ul class="runlist">${steps.map((s,i)=>`<li id="rs${i}"><span class="ic"><i class="wait"></i></span><span>${E(s[1])}</span><span class="rsi">${I(s[0])}</span></li>`).join('')}</ul>
  <div id="rsdone" style="display:none"><div class="okwrap"><svg class="bigok" viewBox="0 0 52 52"><circle cx="26" cy="26" r="24"/><path d="M15 27l7 7 15-15"/></svg><div><b>承認しました</b><div class="hint">信号の色は ${sig(fc)} に決まりました。受付担当が「実装中」へ進めると、AIの実装が始まる想定です。</div></div></div>
  <div class="btns"><button class="btn ai" data-a="lineYaml" data-id="${E(r.id)}" type="button">${I('doc')}注文書を見る</button><button class="btn ghost" data-a="lineBoard" type="button">${I('board')}ボードで見る</button><button class="btn ghost" data-a="closeModal" type="button">${I('x')}閉じる</button></div></div>`,'');
 setBusy(true);
 let i=0;
 const alive=()=>$('#modal').classList.contains('open');
 const run=()=>{const el=$('#rs'+i);if(!el||!alive()){setBusy(false);return}el.classList.add('cur');el.querySelector('.ic').innerHTML='<i class="spin"></i>';
  setTimeout(()=>{if(!el.isConnected||!alive()){setBusy(false);return}el.classList.remove('cur');el.classList.add('done');el.querySelector('.ic').innerHTML=I('check');i++;
   if(i<steps.length)run();else{setBusy(false);const dn=$('#rsdone');if(dn){dn.style.display='block';confetti(120)}}},RM?40:520)};
 setTimeout(run,RM?20:280);
}

/* ===================== 画面操作 ===================== */
const ymd=()=>{const d=new Date();return d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate())};
function updTheme(){const b=$('#themebtn');if(!b)return;const cur=document.documentElement.dataset.theme||(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');b.innerHTML=I(cur==='dark'?'sun':'moon')+`<span class="hide-sm">${cur==='dark'?'ライト':'ダーク'}</span>`}
function copyText(t,done){const fb=()=>{const ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');done()}catch(e){toast('コピーできませんでした','bad')}ta.remove()};if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(t).then(done,fb);else fb()}
const ACT={
 go(el){go(el.dataset.v,el.dataset.id)},
 navNew(){if(S.draft)go('new');else startNew()},
 goList(el){S.fs=el.dataset.v;S.fd='';S.fq='';S.fc='';go('list')},
 clearFlt(){S.fs='';S.fd='';S.fq='';S.fc='';lastView=null;render()},
 sel(el){S.sel[S.view]=el.dataset.id;render()},
 open(el){showDetail(el.dataset.id)},
 logSel(el){const k=el.dataset.id;if(String(k).indexOf('A:')===0){S.sel.log=k;updPane();markSel()}else showDetail(k,'log')},
 logOf(el){const id=el.dataset.id;S.logq=id;S.logk='';S.sel.log=id;S.dtab='log';go('log')},
 closeDrawer(){closeDrawer()},
 closeModal(){closeModal()},
 role(el){setRole(el.dataset.v)},
 theme(){const cur=document.documentElement.dataset.theme||(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');const nx=cur==='dark'?'light':'dark';document.documentElement.dataset.theme=nx;try{localStorage.setItem(KEY+'-theme',nx)}catch(e){}updTheme()},
 exportJSON(){download('SFステーション_受付データ_'+ymd()+'.json',JSON.stringify(S.data,null,2),'application/json')?toast('JSONを書き出しました','ok','download'):toast('書き出せませんでした','bad')},
 importPick(){if(window.__MSF__){toast('サーバ保存のため、この画面からは取り込めません（運用の手順で行います）','bad','lock');return}$('#imp').click()},
 reset(){if(window.__MSF__){toast('サーバ保存のため、この画面からは初期化できません（運用の手順で行います）','bad','lock');return}confirmBox('サンプルに戻す','登録した内容はすべて消え、最初のサンプルデータに戻ります。よろしいですか？','サンプルに戻す',()=>{S.data=normData(seed());addAudit('settings','データをサンプルに戻す','','set:data');S.draft=null;S.editId=null;S.sel={};persist();lastView=null;go('dash');toast('サンプルデータに戻しました','','reset')},true)},
 csv(){download('受付一覧_'+ymd()+'.csv',toCSV(listRows()),'text/csv')?toast('CSVを書き出しました','ok','download'):toast('書き出せませんでした','bad')},
 logcsv(){const rows=[['日時','区分','操作者','役割','操作','対象','件名','メモ']].concat(logRows().map(e=>[fmt(e.x.at),(AREA[e.k]||AREA.req)[0],e.x.by,e.x.role,e.x.action,e.r?e.r.id:(e.a?e.a.ref:''),e.r?e.r.title:(e.a?refLabel(e.a.ref):''),e.x.note]));download('監査ログ_'+ymd()+'.csv','\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n'),'text/csv')?toast('CSVを書き出しました','ok','download'):toast('書き出せませんでした','bad')},
 startNew(){startNew()},
 useTool(el){startNew(el.dataset.v)},
 cat(el){S.cat=el.dataset.v;S.catTool='';$$('#catleft .li').forEach(x=>x.classList.toggle('on',x===el));updPane()},
 catHit(el){const ref=el.dataset.v;S.cat=ref.split('|')[0];S.catTool=ref;$$('#catleft .li').forEach(x=>x.classList.toggle('on',x===el));updPane()},
 /* wizard */
 step(el){const to=+el.dataset.v;if(to<=S.step||validUpTo(to)){S.step=to;render();$('#work').scrollTop=0}},
 prev(){if(S.step>0){S.step--;render();$('#work').scrollTop=0}},
 next(){const e=validate(S.step);if(e.length){showErr(e);return}S.step++;render();$('#work').scrollTop=0},
 submit(){submit()},
 chip(el){const d=S.draft;if(!d)return;const f=el.dataset.f,v=el.dataset.v,a=d[f]=d[f]||[];const k=a.indexOf(v);if(k<0)a.push(v);else a.splice(k,1);el.classList.toggle('on');updPreview()},
 one(el){const d=S.draft;if(!d)return;const f=el.dataset.f;d[f]=el.dataset.v;$$('[data-a="one"][data-f="'+f+'"]').forEach(x=>x.classList.toggle('on',x===el));updPreview()},
 pick(el){S.pickDept=S.pickDept===el.dataset.v?'':el.dataset.v;if(!S.pickDept&&S.draft.toolRef)S.pickDept=el.dataset.v;renderStepBody()},
 tool(el){const d=S.draft;d.toolRef=el.dataset.v;const tl=toolOf(d.toolRef);if(tl){d.dept=tl.dept.id;S.pickDept=tl.dept.id;if(!d.title.trim())d.title=tl.name;if(!d.decides)d.decides=tl.c;toast('「'+tl.name+'」を選びました（件名・部署・信号の候補に反映）','','grid')}renderStepBody()},
 addC(){S.draft.criteria.push('');renderStepBody();const ins=$$('[data-crit]');if(ins.length)ins[ins.length-1].focus()},
 rmC(el){const d=S.draft;d.criteria.splice(+el.dataset.v,1);if(!d.criteria.length)d.criteria=[''];renderStepBody()},
 ex(el){const d=S.draft,empty=d.criteria.findIndex(x=>!x.trim());if(empty>=0)d.criteria[empty]=el.dataset.v;else if(d.criteria.length<8)d.criteria.push(el.dataset.v);else{toast('条件は8つまでです','bad');return}renderStepBody();toast('「〇〇」の所を、自分の言葉に書きかえてください','','edit')},
 rmAtt(el){S.draft.attachments.splice(+el.dataset.v,1);$('#attL').innerHTML=attHtml()},
 sample(el){const s=SEEDS[SAMPLES[+el.dataset.v].i];const d=Object.assign(blank(S.role),JSON.parse(JSON.stringify(s)));d.applicant=me().name;d.status='received';d.signalFinal='';delete d.d0;delete d.backNote;if(!d.criteria.length)d.criteria=[''];S.draft=d;S.pickDept=d.dept;renderStepBody();toast('サンプルを入力しました。「つぎへ」で各ステップを確認できます','','sparkles')},
 dp(el){S.dpTab=el.dataset.v;updPreview()},
 /* detail */
 status(el){const r=find(el.dataset.id);if(r)openStatus(r,el.dataset.v||undefined)},
 sok(el){applyStatus(el.dataset.id)},
 cfok(){const fn=confirmFn;closeModal();if(fn)fn()},
 /* ----- DevOps ----- */
 devTab(el){S.devTab=el.dataset.v;$$('#main .seg [data-a=devTab]').forEach(x=>{const on=x.dataset.v===S.devTab;x.classList.toggle('on',on);x.setAttribute('aria-selected',on)});updDev()},
 devSel(el){S.sel.devops=el.dataset.id;$$('#devbody [data-a=devSel]').forEach(x=>x.classList.toggle('on',x.dataset.id===S.sel.devops));updPane()},
 devOpen(el){go('board',el.dataset.id)},
 devStatus(el){const r=find(el.dataset.id);if(r)openStatus(r,el.dataset.v||undefined)},
 async devHandoff(el){
  const id=el.dataset.id,r=find(id);if(!r)return;const s=dlOf(id);if(s.busy)return;
  if(!(Number(r.__orderVersion)>0)){toast('注文書の版がありません（承認後に投入できます）','bad');return}
  s.busy=true;s.msg=null;updPane();
  const res=await window.__MSF__.handoff(id,Number(r.__orderVersion));
  s.busy=false;
  if(res.ok){s.msg=(res.result&&res.result.issueNo?'Issue #'+res.result.issueNo+' に投入しました':'投入しました');toast(s.msg,'ok','code');}
  else{s.msg=(res.message||'投入できませんでした');toast(s.msg,'bad');}
  await dlLoad(id,true);
 },
 devMerge(el){const id=el.dataset.id,job=el.dataset.job;if(!id||!job)return;const s=dlOf(id);const j=(s.items||[]).find(x=>x.id===job);if(!j||!j.headSha){toast('head の記録がありません','bad');return}void dlAct(id,job,'approve-merge',{headSha:j.headSha},'merge を承認しました');},
 devDeploy(el){const id=el.dataset.id,job=el.dataset.job;if(!id||!job)return;const rel=dlRel(job);if(!rel.mergeSha||!rel.imageDigest){toast('merge と成果物の記録がそろってから配備します','bad');return}void dlAct(id,job,'approve-deploy',{sha:rel.mergeSha,digest:rel.imageDigest,environment:rel.environment},'配備を受け付けました');},
 devRollbackBtn(el){const id=el.dataset.id,job=el.dataset.job;if(!id||!job)return;dlReason('本番を戻す','戻す理由を書いてください（監査に残ります）',reason=>{void dlAct(id,job,'rollback',{reason},'戻しを受け付けました')});},
 devCancel(el){const id=el.dataset.id,job=el.dataset.job;if(!id||!job)return;const s=dlOf(id);const j=(s.items||[]).find(x=>x.id===job);dlReason('ジョブを止める','止める理由を書いてください（監査に残ります）',reason=>{void dlAct(id,job,'cancel',{reason,...(j&&j.state?{expectedState:j.state}:{})},'停止を受け付けました')});},
 devResume(el){const id=el.dataset.id,job=el.dataset.job;if(!id||!job)return;dlReason('ジョブを再開する','再開する理由を書いてください（監査に残ります）',reason=>{void dlAct(id,job,'resume',{reason},'再開を受け付けました')});},
 dlReasonOk(){const el=$('#dlr');const v=el?el.value.trim():'';if(!v){toast('理由を書いてください','bad');return}const cb=dlPending;closeModal();if(cb)cb(v);},
 devAI(el){
  const l=lineOf(el.dataset.id),r=l&&find(l.req);if(!l||!r||l.running)return;
  if(!may('ai')){toast('この操作ができるのは '+whoCanT('ai')+' です','bad','lock');return}
  if(l.merged||!['dev','verify'].includes(r.status)||l.ai.cost>=100)return;
  l.running='ai';devRefresh();
  setTimeout(()=>{
   const v=S.data.devsec;if(!l.pr){v.pseq=(v.pseq||110)+1;l.pr=v.pseq}
   l.ai.runs++;l.ai.min+=12+l.ai.runs*3;l.ai.cost=Math.min(100,l.ai.cost+9);
   CHECKS.forEach(([k])=>{if(l.checks[k]!=='na')l.checks[k]='pend'});l.bug='';l.review='none';l.reviewBy='';l.running='';
   addAudit('devops','AIで実装','PR #'+l.pr+'（'+l.ai.runs+'回目）',l.req);persist();devRefresh();
   toast(l.req+'：AIが実装しました（PR #'+l.pr+'）。次は自動検査です','ok','bot');
  },RM?80:1300);
 },
 devCheck(el){
  const l=lineOf(el.dataset.id);if(!l||l.running||!l.pr||l.merged)return;
  if(!may('check')){toast('この操作ができるのは '+whoCanT('check')+' です','bad','lock');return}
  l.running='check';devRefresh();
  setTimeout(()=>{
   let nf=[];CHECKS.forEach(([k])=>{if(l.checks[k]==='na')return;const f=l.bug===k;l.checks[k]=f?'fail':'pass';if(f)nf.push(CKL(k))});
   l.running='';addAudit('devops','自動検査を実行',nf.length?'不合格 '+nf.length+'件（'+nf.join('・')+'）':'すべて合格',l.req);persist();devRefresh();
   if(nf.length)toast(l.req+'：自動検査で不合格が '+nf.length+' 件あります（'+nf.join('・')+'）','bad','alert');
   else toast(l.req+'：自動検査にすべて合格しました','ok','shieldok');
  },RM?80:1500);
 },
 devReview(el){const l=lineOf(el.dataset.id);if(!l||l.running)return;if(!may('review')){toast('この操作ができるのは '+whoCanT('review')+' です','bad','lock');return}if(!ckState(l).ok||l.review==='ok')return;
  l.review='ok';l.reviewBy=me().name;addAudit('devops','レビューで承認','PR #'+l.pr,l.req);persist();devRefresh();toast(l.req+'：PR #'+l.pr+' をレビューで承認しました','ok','stamp')},
 devMerge(el){const l=lineOf(el.dataset.id);if(!l||l.running)return;if(!may('merge')){toast('この操作ができるのは '+whoCanT('merge')+' です','bad','lock');return}if(l.merged||l.review!=='ok'||!ckState(l).ok)return;
  l.merged=true;addAudit('devops','マージ','PR #'+l.pr+' を main にマージ',l.req);persist();devRefresh();toast(l.req+'：PR #'+l.pr+' をマージしました','ok','loop')},
 devStg(el){const l=lineOf(el.dataset.id),r=l&&find(l.req);if(!l||!r)return;if(!may('stg')){toast('この操作ができるのは '+whoCanT('stg')+' です','bad','lock');return}if(!l.merged||l.stg===l.ver)return;
  const v=S.data.devsec;v.dseq=(v.dseq||0)+1;v.deploys.push({id:'DEP-'+pad(v.dseq,4),at:nowISO(),env:'stg',kind:'deploy',req:l.req,ver:l.ver,by:me().name});l.stg=l.ver;
  addAudit('devops','ステージングに配備',l.ver,l.req);persist();devRefresh();toast(l.req+'：ステージングに '+l.ver+' を配備しました','ok','layers')},
 devProd(el){const l=lineOf(el.dataset.id),r=l&&find(l.req);if(!l||!r)return;if(!may('prod')){toast('この操作ができるのは '+whoCanT('prod')+' です','bad','lock');return}
  if(l.stg!==l.ver||l.prod===l.ver||!['field','done'].includes(r.status))return;
  confirmBox('本番にデプロイ',l.req+'「'+r.title+'」の '+l.ver+' を本番に出します。利用者の画面が新しい版に変わります。','デプロイする',()=>{
   const v=S.data.devsec;v.dseq=(v.dseq||0)+1;v.deploys.push({id:'DEP-'+pad(v.dseq,4),at:nowISO(),env:'prod',kind:'deploy',req:l.req,ver:l.ver,by:me().name});l.prod=l.ver;
   addAudit('devops','本番にデプロイ',l.ver,l.req);persist();devRefresh();toast(l.req+'：本番に '+l.ver+' を出しました','ok','flag');confetti(70)})},
 devRollback(el){const l=lineOf(el.dataset.id);if(!l)return;if(!may('rollback')){toast('この操作ができるのは '+whoCanT('rollback')+' です','bad','lock');return}
  const v=S.data.devsec,prev=prodPrev(l);if(!prev)return;
  confirmBox('ロールバック','本番の '+l.prod+' を取り下げ、ひとつ前の '+prev.ver+' に戻します。','ロールバックする',()=>{
   v.dseq=(v.dseq||0)+1;v.deploys.push({id:'DEP-'+pad(v.dseq,4),at:nowISO(),env:'prod',kind:'rollback',req:l.req,ver:prev.ver,from:l.prod,by:me().name,note:'手動のロールバック'});
   addAudit('devops','ロールバック',l.prod+' → '+prev.ver,l.req);l.prod=prev.ver;persist();devRefresh();toast(l.req+'：本番を '+prev.ver+' に戻しました','','undo')},true)},
 /* ----- SecOps ----- */
 secTab(el){S.secTab=el.dataset.v;S.sel.secops='';go('secops')},
 secSel(el){S.sel.secops=el.dataset.id;$$('#secbody [data-a=secSel]').forEach(x=>x.classList.toggle('on',x.dataset.id===S.sel.secops));updPane()},
 secOpen(el){const id=el.dataset.id;S.secTab=/^ALT/.test(id)?'alert':/^ACC/.test(id)?'access':'vuln';S.sel.secops=id;go('secops')},
 vTake(el){const x=secFind(el.dataset.id);if(!x||x.status!=='open')return;if(!may('vtake')){toast('この操作ができるのは '+whoCanT('vtake')+' です','bad','lock');return}
  x.status='doing';x.owner=me().name;addAudit('secops','脆弱性を担当',x.title,x.id);persist();secRefresh();toast(x.id+' を担当しました','ok','user')},
 vFix(el){const x=secFind(el.dataset.id);if(!x||!['open','doing'].includes(x.status))return;if(!may('vfix')){toast('この操作ができるのは '+whoCanT('vfix')+' です','bad','lock');return}
  confirmBox('修正済みにする',x.id+'「'+x.title+'」を修正済みにします。部品を直した版が、検査に合格していることを確かめてから進めてください。','修正済みにする',()=>{x.status='fixed';x.fixedAt=nowISO();if(!x.owner)x.owner=me().name;addAudit('secops','修正済みにする',x.title,x.id);persist();secRefresh();toast(x.id+' を修正済みにしました','ok','check')})},
 vRisk(el){const x=secFind(el.dataset.id);if(!x||!['open','doing'].includes(x.status))return;if(!may('vrisk')){toast('この操作ができるのは '+whoCanT('vrisk')+' です','bad','lock');return}
  modal(I('msg')+'リスク受容を申請 <span class="hint mono">'+E(x.id)+'</span>',`<p style="margin:0 0 8px">${E(x.title)}（深刻度：${SEV[x.sev].l}）を、すぐには直さずに受け入れる理由を書いてください。承認者が判断します。</p><textarea id="rnote" rows="3" placeholder="例：本番の成果物に含まれないため、次の更新でまとめて直す"></textarea>`,`<button class="btn ghost" data-a="closeModal" type="button">キャンセル</button><button class="btn" data-a="vRiskSend" data-id="${E(x.id)}" type="button">${I('send')}申請する</button>`)},
 vRiskSend(el){const x=secFind(el.dataset.id);if(!x)return;const t=($('#rnote')||{}).value||'';if(!t.trim()){toast('理由を書いてください','bad');return}
  x.status='riskreq';x.note=t.trim();if(!x.owner)x.owner=me().name;addAudit('secops','リスク受容を申請',t.trim(),x.id);persist();closeModal();secRefresh();toast(x.id+'：リスク受容を申請しました（承認者が判断します）','ok','msg')},
 vRiskOk(el){const x=secFind(el.dataset.id);if(!x||x.status!=='riskreq')return;if(!may('vriskok')){toast('この操作ができるのは '+whoCanT('vriskok')+' です','bad','lock');return}
  confirmBox('リスク受容を承認',x.id+'「'+x.title+'」を、直さずに受け入れることを承認します。理由：'+x.note,'承認する',()=>{x.status='accepted';addAudit('secops','リスク受容を承認',x.note,x.id);persist();secRefresh();toast(x.id+'：リスク受容を承認しました','ok','stamp')})},
 vRiskNg(el){const x=secFind(el.dataset.id);if(!x||x.status!=='riskreq')return;if(!may('vriskok')){toast('この操作ができるのは '+whoCanT('vriskok')+' です','bad','lock');return}
  x.status='doing';addAudit('secops','リスク受容を差し戻し','修正で対応する',x.id);persist();secRefresh();toast(x.id+'：差し戻しました（対応中に戻ります）','','undo')},
 aAck(el){const x=secFind(el.dataset.id);if(!x||x.status!=='new')return;if(!may('ack')){toast('この操作ができるのは '+whoCanT('ack')+' です','bad','lock');return}
  x.status='ack';x.ackBy=me().name;addAudit('secops','通知を確認',x.title,x.id);persist();secRefresh();toast(x.id+' を確認しました','ok','eye')},
 aClose(el){const x=secFind(el.dataset.id);if(!x||x.status!=='ack')return;if(!may('ack')){toast('この操作ができるのは '+whoCanT('ack')+' です','bad','lock');return}
  x.status='closed';addAudit('secops','通知を対応済みにする',x.title,x.id);persist();secRefresh();toast(x.id+' を対応済みにしました','ok','check')},
 accOk(el){const x=secFind(el.dataset.id);if(!x||x.status==='revoked')return;if(!may('access')){toast('この操作ができるのは '+whoCanT('access')+' です','bad','lock');return}
  x.status='ok';x.at=nowISO();x.by=me().name;addAudit('secops','権限の継続を確認',x.name+'（'+rl(x.role)+'）',x.id);persist();secRefresh();toast(x.name+' の権限の継続を確認しました','ok','check')},
 accRevoke(el){const x=secFind(el.dataset.id);if(!x||x.status==='revoked')return;if(!may('access')){toast('この操作ができるのは '+whoCanT('access')+' です','bad','lock');return}
  confirmBox('権限を外す',x.name+'（'+rl(x.role)+'）の権限を外します。このサンプルでは記録だけで、実際のアカウントは変わりません。','権限を外す',()=>{x.status='revoked';x.at=nowISO();x.by=me().name;addAudit('secops','権限を外す',x.name+'（'+rl(x.role)+'）',x.id);persist();secRefresh();toast(x.name+' の権限を外しました','','x')},true)},
 gateCheck(){if(!may('gate')){toast('この操作ができるのは '+whoCanT('gate')+' です','bad','lock');return}
  const g=gates(),ng=g.filter(x=>x.s!=='ok');S.data.devsec.gchk={at:nowISO(),by:me().name};addAudit('secops','品質ゲートを点検',ng.length?'要対応・注意 '+ng.length+'件（'+ng.map(x=>x.id).join('・')+'）':'7項目すべて守られています','G');persist();secRefresh();
  toast(ng.length?'品質ゲート：要対応・注意が '+ng.length+' 件あります':'品質ゲート：7項目すべて守られています',ng.length?'bad':'ok','shieldok')},
 /* ----- システム設定 ----- */
 setTab(el){S.setTab=el.dataset.v;$$('#setleft [data-a=setTab]').forEach(x=>x.classList.toggle('on',x.dataset.v===S.setTab));updPane()},
 goSet(el){S.setTab=el.dataset.v||'personal';go('settings')},
 uReload(){UA.loaded=false;UA.error='';updPane()},
 mReload(){MA.loaded=false;MA.error='';updPane()},
 async mRetry(el){
  try{await window.__MSF__.api('POST','/api/mail/outbox/'+encodeURIComponent(el.dataset.id)+'/retry',{});toast('再送しました','ok','send');loadMail(true)}
  catch(err){toast((err&&err.message)||'再送できませんでした','bad')}
 },
 async mFlush(){
  try{const r=await window.__MSF__.api('POST','/api/mail/flush',{});toast('送信待ちを送りました'+((r&&r.sent!=null)?'（'+r.sent+'件）':''),'ok','send');loadMail(true)}
  catch(err){toast((err&&err.message)||'送信できませんでした','bad')}
 },
 uAdd(){uAddModal()},
 async uAddOk(){
  const g=id=>{const el=$('#'+id);return el?el:null};
  const name=(g('uName')||{}).value||'',email=(g('uEmail')||{}).value||'',pass=(g('uPass')||{}).value||'',dept=(g('uDept')||{}).value||'';
  const roles=$$('#modal input[name="urole"]:checked').map(x=>x.value);
  if(!name.trim()||!email.trim()||!pass){toast('表示名・メールアドレス・初期パスワードを入れてください','bad');return}
  if(!roles.length){toast('役割を1つ以上選んでください','bad');return}
  const admin=!!(g('uAdmin')&&g('uAdmin').checked);
  const passEl=g('uPass'); // 送信したダイアログの欄（待つあいだに開き直された別のダイアログの入力は消さない）
  try{
   await window.__MSF__.api('POST','/api/admin/users',{email:email.trim(),displayName:name.trim(),deptCode:dept,password:pass,roles,isAdmin:admin});
   closeModal();toast('利用者を追加しました','ok','user');loadUsers(true);
  }catch(err){if(passEl)passEl.value='';toast((err&&err.message)||'追加できませんでした','bad')}
 },
 async uToggle(el){
  const id=el.dataset.id,on=el.dataset.v==='1';
  try{await window.__MSF__.api('PATCH','/api/admin/users/'+encodeURIComponent(id),{isActive:on});toast(on?'有効に戻しました':'無効にしました','ok','user');loadUsers(true)}
  catch(err){toast((err&&err.message)||'変更できませんでした','bad')}
 },
 uPw(el){uPwModal(el.dataset.id)},
 async uPwOk(el){
  const elp=$('#uNewPw');const pw=elp?elp.value:'';
  if(!pw){toast('新しいパスワードを入れてください','bad');return}
  try{await window.__MSF__.api('PATCH','/api/admin/users/'+encodeURIComponent(el.dataset.id),{password:pw});closeModal();toast('パスワードを再設定しました','ok','lock')}
  catch(err){if(elp)elp.value='';toast((err&&err.message)||'再設定できませんでした','bad')}
 },
 apvAdd(){apvAdd()},
 apvDel(el){if(!may('cfg')){toast('システム設定を変えられるのは受付担当（IT・DX）です','bad','lock');return}const a=el.dataset.v;if(S.cfg.approvers.length<2)return;
  confirmBox('承認者から外す','「'+a+'」を承認者の候補から外します。いま入っている依頼の承認者は変わりません。','外す',()=>{S.cfg.approvers=S.cfg.approvers.filter(x=>x!==a);saveCfg();addAudit('settings','設定を変更','承認者から「'+a+'」を外す','set:approvers');persist();toast('承認者から外しました','','trash');updSetList();updPane()},true)},
 cfgReset(){if(!may('cfg')){toast('システム設定を変えられるのは受付担当（IT・DX）です','bad','lock');return}
  confirmBox('設定を初期値に戻す','組織名・受付スタンプ・承認者・必須の検査・修正期限・起動時の動きを初期値に戻します（テーマと動きはそのままです）。','初期値に戻す',()=>{const m=S.cfg.motion;S.cfg=cfg0();S.cfg.motion=m;CFGX=S.cfg;saveCfg();applyOrg();addAudit('settings','設定を初期値に戻す','','set:data');persist();toast('設定を初期値に戻しました','','reset');render()},true)},
 auditCsv(){const k=S.logk,q=S.logq;S.logk='';S.logq='';ACT.logcsv();S.logk=k;S.logq=q},
 /* ----- 監査ログ ----- */
 logk(el){S.logk=el.dataset.v;$$('#main .seg [data-a=logk]').forEach(x=>x.classList.toggle('on',x.dataset.v===S.logk));updLog();const a=logRows();if(a[0]&&!a.some(e=>e.key===S.sel.log)){S.sel.log=a[0].key;if(a[0].k==='req')S.dtab='log';updPane();markSel()}},

 logout(){const w=me(),lost=S.editId?'編集中の内容は保存されません。':S.draft?'書きかけの依頼（まだ受け付けていない入力）は消えます。':'';confirmBox('ログアウト',w.name+'（'+w.l.replace(/（.*）/,'')+'）の操作を終わり、ログイン画面に戻ります。保存した依頼は、このブラウザに残ります。'+lost,'ログアウトする',doLogout)},
 login(){doLogin()},
 edit(el){startEdit(el.dataset.id)},
 del(el){const r=find(el.dataset.id);if(!r)return;confirmBox('削除',r.id+'「'+r.title+'」を削除します。元に戻せません。','削除する',()=>{S.data.items=S.data.items.filter(x=>x.id!==r.id);addAudit('req','依頼を削除',r.title,r.id);persist();closeDrawer();toast(r.id+' を削除しました','','trash');render()},true)},
 dtab(el){S.dtab=el.dataset.v;refreshDetail()},
 comment(el){const r=find(el.dataset.id),t=$('#ctx').value.trim();if(!r)return;if(!t){toast('コメントを入力してください','bad');return}const now=nowISO();r.comments=r.comments||[];r.comments.push({at:now,by:me().name,text:t});r.updatedAt=now;persist();toast('コメントしました','ok','msg');refreshDetail()},
 ycopy(el){const r=find(el.dataset.id);if(r)copyText(toYAML(r),()=>toast('注文書をコピーしました','ok','copy'))},
 ydl(el){const r=find(el.dataset.id);if(r)download(r.id+'_注文書.yaml',toYAML(r),'text/yaml')?toast('ダウンロードしました','ok','download'):toast('ダウンロードできませんでした','bad')},
 lineYaml(el){const id=el.dataset.id;closeModal();S.dtab='yaml';go('board',id)},
 lineBoard(){closeModal();go('board')}
};
document.addEventListener('click',e=>{
 if(e.target.id==='modal'){closeModal();return}
 const el=e.target.closest&&e.target.closest('[data-a]');if(!el||el.disabled)return;
 const fn=ACT[el.dataset.a];if(fn)fn(el,e);
});
document.addEventListener('input',e=>{
 const t=e.target;if(!t||!t.dataset)return;
 if(t.dataset.bind!==undefined&&S.draft){bindDraft(S.draft,t.dataset.bind,t.value);updPreview();return}
 if(t.dataset.crit!==undefined&&S.draft){S.draft.criteria[+t.dataset.crit]=t.value;const L=lint(t.value),box=t.nextElementSibling;t.className=L.ok?'good':L.level==='empty'?'':'vague';box.className='lint '+(L.level==='empty'?'':L.level);box.innerHTML=lintMsg(L);updPreview();return}
 if(t.dataset.flt){S[t.dataset.flt]=t.value;if(S.view==='board'){render();return}$('#main').classList.remove('anim','anim-d');const f={list:updList,catalog:updCatalog,log:updLog}[S.view];if(f)f()}
});
document.addEventListener('change',e=>{
 const t=e.target;if(!t)return;
 if(t.dataset&&t.dataset.cfg!==undefined){setCfg(t);return}
 if(t.name==='authrole'){authSel=t.value;$$('#auth .who label').forEach(l=>l.classList.toggle('on',l.contains(t)));return}
 if(t.dataset&&t.dataset.bind!==undefined&&S.draft){
  bindDraft(S.draft,t.dataset.bind,t.value);
  if(t.dataset.bind==='approverUserId'){const h=t.closest('.fld')&&$('.hint',t.closest('.fld'));if(h)h.innerHTML=apvHint(S.draft)}
  if(t.dataset.bind==='dept'){
   const list=empOf(t.value);
   if(list&&list.length&&!list.some(e=>e.name===S.draft.applicant))S.draft.applicant=list[0].name;
   // 起票者の選択肢もその部署の名簿に差し替える
   renderStepBody();return;
  }
  updPreview();return;
 }
 if(t.id==='role'){setRole(t.value);return}
 if(t.id==='imp'){importFile(t);return}
 if(t.id==='att'&&S.draft){Array.from(t.files||[]).forEach(f=>S.draft.attachments.push({name:f.name,size:f.size}));t.value='';$('#attL').innerHTML=attHtml();return}
 if(t.closest&&t.closest('#modal')&&modalHook)modalHook();
});
function importFile(inp){
 const f=inp.files&&inp.files[0];if(!f)return;const rd=new FileReader();
 rd.onload=()=>{try{const o=JSON.parse(rd.result);if(!validImport(o))throw 0;
   confirmBox('JSONの取り込み',o.items.length+' 件のデータで、いまのデータを置き換えます。よろしいですか？','取り込む',()=>{o.seq=Math.max(o.seq||0,...o.items.map(x=>+String(x.id).split('-').pop()||0));S.data=normData(o);addAudit('settings','データを取り込み',o.items.length+'件','set:data');S.draft=null;S.editId=null;S.sel={};persist();lastView=null;go('board');toast(o.items.length+' 件を取り込みました','ok','upload')});
  }catch(_){toast('このファイルは取り込めません','bad')}inp.value=''};
 rd.readAsText(f);
}
document.addEventListener('keydown',e=>{if(authOpen()){if(e.key==='Enter'&&!e.isComposing&&!(e.target&&e.target.tagName==='BUTTON')){e.preventDefault();doLogin()}return}if(e.key==='Enter'&&!e.isComposing&&e.target&&e.target.id==='apvNew'){e.preventDefault();apvAdd();return}if(e.key==='Enter'&&!e.isComposing&&e.target&&e.target.id==='ctx'){e.preventDefault();ACT.comment(e.target);return}if(e.key==='Escape'){if($('#modal').classList.contains('open'))closeModal();else if(S.open)closeDrawer()}});
document.addEventListener('pointerdown',e=>{
 if(RM)return;const b=e.target.closest&&e.target.closest('.btn,.chip,.tile,.seg button,.choice,.tool');if(!b||b.disabled)return;
 const r=b.getBoundingClientRect(),s=document.createElement('span'),d=Math.max(r.width,r.height);
 s.className='rip';s.style.cssText=`width:${d}px;height:${d}px;left:${e.clientX-r.left-d/2}px;top:${e.clientY-r.top-d/2}px`;
 b.appendChild(s);setTimeout(()=>s.remove(),650);
});
function tickClock(){const el=$('#clock');if(!el)return;const d=new Date();el.innerHTML=I('clock','sm')+`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`}

/* ===================== 起動 ===================== */
try{const th=localStorage.getItem(KEY+'-theme');if(th)document.documentElement.dataset.theme=th}catch(e){}
$$('[data-ic]').forEach(el=>el.insertAdjacentHTML('afterbegin',I(el.dataset.ic)));
const ROLE_OPTS=(()=>{const A=window.__SF_ACTORS__,u=window.__MSF__&&window.__MSF__.user;return ROLES.map(r=>{const a=A&&A[r.k];const label=a&&a.name?`${a.name}（${a.divisionName||r.l}）`:`${u?u.displayName:r.name}（${r.l}）`;return `<option value="${r.k}">${E(label)}</option>`}).join('')})();
$('#role').innerHTML=ROLE_OPTS;
updTheme();tickClock();setInterval(tickClock,1000);
S.cfg=loadCfg();
if(window.__MSF__&&Array.isArray(window.__MSF__.approvers)&&window.__MSF__.approvers.length){
 S.cfg.approvers=window.__MSF__.approvers.map(a=>a.displayName);
}
CFGX=S.cfg;normData(S.data);applyMotion();applyOrg();
render();save(S.data);
if(window.__MSF__){setTimeout(serverAudit,600);loadEmployees();}
{const s0=sessGet();if(s0&&s0.out){authSel=ROLES.some(r=>r.k===s0.role)?s0.role:'requester';S.role=authSel;showAuth(s0.at)}}
if(S.cfg.startLogin&&!authOpen())showAuth('');
window.addEventListener('storage',e=>{if(e.key!==SKEY)return;const s1=sessGet();if(s1&&s1.out&&!authOpen())endSession(s1.at)});
let fitT=null;window.addEventListener('resize',()=>{clearTimeout(fitT);fitT=setTimeout(()=>{fitPane($('#rin'));fitPane($('#din'))},120)});
window.__SF={S,ACT,go,find,render,fitPane,logout:doLogout,login:doLogin,lineOf,gates,logRows,devKpi,secKpi};
window.__MSF_UI__={
 toast:toast,
 data:()=>S.data,
 syncApplied:function(changed){
  save(S.data);
  if(changed){
   if(S.view!=='new')render();
   if(S.open)renderDrawer();
  }
 }
};
})();
