const CATALOG = [
  {
    id: 'keiei',
    short: '経営企画室',
    name: '経営企画室',
    icon: 'i-gauge',
    role: '会社のかじ取り役。数字を見て、進む方向を決める',
    tools: [
      ['経営ダッシュボード', '受注・売上・利益を、支店ごと・海の工事／陸の工事ごとに1つの画面で見られる', 'g', 1],
      ['会議の議事録まとめ', '会議の録音から、決まったことと宿題を整理する', 'g'],
      ['公共事業の予算・発注見通しの情報あつめ', '港湾・空港・河川などの国の予算や発注の見通しを集めて、短くまとめる', 'g'],
      ['グループ向け報告資料のたたき台', '髙松コンストラクショングループへ出す報告資料の下書きを、過去の数字から作る', 'y'],
      ['経審の点数の試算', '経営事項審査の点数が、何で上がり下がりするかを試算する（申請内容は人が決める）', 'y'],
      ['投資・撤退の決定', '作業船の新しい建造などの投資は、AIは材料集めまで。決めるのは経営陣', 'r'],
    ],
  },
  {
    id: 'eigyo',
    short: '営業本部',
    name: '営業本部',
    icon: 'i-handshake',
    role: '国や自治体の工事（港・空港・護岸など）をとってくる係',
    tools: [
      ['入札・発注情報のお知らせ', '国や港の管理者などの公告を集めて、海の工事など自社に合いそうな案件を知らせる', 'g', 1],
      ['営業台帳（お客様・案件の管理）', 'だれと、どの案件を、どこまで話したかを記録する', 'g'],
      ['過去の実績さがし', '似た港・空港・護岸の工事の実績・写真・工事成績をすぐに探せる', 'g'],
      ['入札参加資格・提出期限の管理', '資格の更新日や書類の締切を知らせる', 'g'],
      ['技術提案書のたたき台', '総合評価の技術提案で、自社技術をどこで使えるかの下書きを作る', 'y'],
      ['入札に参加するか・入札価格の決定', '参加するかどうかと入札価格は、責任者が決める', 'r'],
    ],
  },
  {
    id: 'solution',
    short: 'ソリューション営業本部',
    name: 'ソリューション営業本部',
    icon: 'i-wind',
    role: '民間のお客様（不動産会社・発電事業者など）と一緒に計画をつくる係',
    tools: [
      ['民間案件の台帳と進み具合', 'お客様ごとの案件と、どこまで進んだかがひと目でわかる', 'g', 1],
      ['プロジェクトの宿題一覧', '打合せで出た宿題と期限を、関係者みんなで見られる', 'g'],
      ['再生可能エネルギーの情報あつめ', '風力発電など、エネルギー関連工事のニュースや制度を集めて短くまとめる', 'g'],
      ['提案資料のたたき台', 'お客様の要望から、提案資料の下書きを作る', 'y'],
      ['複数の案の比べっこ表', '工期・費用・環境への影響などを、同じ形の表に並べる（数字は担当者が確認）', 'y'],
      ['受注条件・契約条件の決定', 'どんな条件で引き受けるかは、責任者が決める', 'r'],
    ],
  },
  {
    id: 'sekkei',
    short: '技術本部（設計・積算）',
    name: '技術本部（設計・積算・照査）',
    icon: 'i-blueprint',
    role: '図面を考え、工事の値段を計算する係',
    tools: [
      ['社内単価・作業船の費用データの検索', '過去に使った単価や、作業船を使うときの費用をすぐに引ける', 'g', 1],
      ['図面・設計書の版の管理', 'どれが最新版か一目でわかる保管場所（共通データ環境）', 'g'],
      ['図面からの数量拾いの補助', '図面から数量を拾う作業を手伝う（数量は技術者が確認）', 'y'],
      ['過去工事との見積比べ', '似た工事と比べて、大きなズレがある項目を知らせる', 'y'],
      ['照査チェックリストの書きもれ確認', '照査の記入もれや、まだ確認していない項目を知らせる', 'y'],
      ['構造計算・設計の合否判断', '安全かどうかの判断は、資格を持つ技術者が行う', 'r'],
    ],
  },
  {
    id: 'ict',
    short: '技術本部（ICT・技術開発）',
    name: '技術本部（ICT・技術開発）',
    icon: 'i-spark',
    role: '新しい技術を作って試し、全国の現場に広める係',
    tools: [
      [
        '自社技術の使い方さがし',
        'MC-Navi・MC-Caisson・AR施工支援システムなど、社内技術の説明と使った現場の例をすぐに探せる',
        'g',
        1,
      ],
      ['NETISなど新技術の情報あつめ', '新しい技術の情報を集めて、短くまとめる', 'g'],
      ['現場での試しの記録と効果', '試した技術の結果と、効果の数字を記録する', 'g'],
      ['海底の3Dデータの変換と共有', '深さを測ったデータや点群を、みんなが見やすい形に変換する', 'y'],
      ['技術論文・発表資料のたたき台', '現場の成果から、発表資料の下書きを作る', 'y'],
      ['新しい工法を現場で使うかの決定', '現場で使うかどうかは、技術者と責任者が決める', 'r'],
    ],
  },
  {
    id: 'kaijo',
    sea: true,
    short: '現場（海の工事）',
    name: '支店工事部の現場（海の工事）',
    icon: 'i-wave',
    role: '海の上で、港・護岸・埋立・空港などの工事を進める係',
    tools: [
      ['工事写真の整理・写真台帳', '撮った写真を工種・場所ごとに並べ、台帳づくりを楽にする（海の上の圏外でも消えない）', 'g', 1],
      ['作業日報', '作業船・潜水士・天気・潮の記録を、スマホから入力。前の日の内容を引き継ぐ', 'g'],
      ['天気・波・潮のお知らせ', '予報を集めて、作業できそうな時間帯を色で見せる（作業するかは人が決める）', 'y'],
      ['浚渫・埋立の進み具合の見える化', '測った海の深さから、どこまで掘れたか・埋まったかを色で見る（数量の確定は技術者）', 'y'],
      ['打合せ簿・協議記録のたたき台', '打合せのメモから、決まった様式の記録を作る', 'y'],
      ['工程表のたたき台・遅れのお知らせ', '天気待ちの日数も見込んで下書きを作り、遅れそうな所を早めに知らせる', 'y'],
      ['起重機船の吊り計画・ケーソンを置く計画の決定', '重い物を海の上で吊る計画は、責任を持つ技術者が決める', 'r'],
    ],
  },
  {
    id: 'rikujo',
    short: '現場（陸・エネルギー）',
    name: '支店工事部の現場（陸の工事・エネルギー関連工事）',
    icon: 'i-helmet',
    role: '陸の上で、造成・解体・災害復旧・風力発電所などの工事を進める係',
    tools: [
      ['作業日報・工事日報', 'スマホで現場から入力。天気・人数・機械を前の日から引き継ぐ', 'g', 1],
      ['近隣の方からの問い合わせ記録', '解体や造成の工事で受けた問い合わせと、対応の進み具合を残す', 'g'],
      ['実行予算と原価の見える化', '予算と実際にかかったお金の差を、工種ごとに見る', 'y'],
      ['3D点群・ドローン写真の閲覧', '現場の形を3Dで見る（数量・寸法の確定は技術者）', 'y'],
      ['解体前の調査記録の整理', '解体前に必要な調査の記録をまとめ、届出の期限を知らせる（調査の判断は資格者）', 'y'],
      ['施工計画書のたたき台', '過去の計画書から下書きを作り、所長が手直しして決める', 'y'],
      ['仮設・揚重計画の決定', '足場やクレーンの計画を決めるのは、責任を持つ技術者', 'r'],
    ],
  },
  {
    id: 'senpaku',
    sea: true,
    short: '船舶事業部',
    name: '船舶事業部（作業船）',
    icon: 'i-ship',
    role: '浚渫船などの作業船と、船で働く人を守る係',
    tools: [
      ['作業船の予定表', 'どの船が、いつ、どの港の現場にいるかがひと目でわかる', 'g', 1],
      ['船の検査・点検の期限管理', '船の検査や機械の点検の期限を知らせ、期限切れの船は予定に入れられなくする', 'g'],
      ['船員の資格・乗船の記録', 'だれが何の資格を持ち、どの船に乗ったかの記録（見られる人はしぼる）', 'g'],
      ['燃料とCO2の記録', '使った燃料の量から、CO2の量を計算して残す', 'g'],
      ['修理の記録と故障の傾向', '修理の記録から、故障しやすい部品や時期を見える化する', 'y'],
      ['船を出してよいか・作業船を使ってよいかの判断', '船長と責任者が決める。AIは天気や点検の材料をそろえるまで', 'r'],
    ],
  },
  {
    id: 'kobai',
    short: '購買部',
    name: '施工本部 購買部',
    icon: 'i-box',
    role: '協力会社と、材料・船・機械を手配する係',
    tools: [
      ['協力会社データベース', '建設業許可・保険・実績を1か所で管理する', 'g', 1],
      ['協力会社からの書類回収', '安全書類（グリーンファイル）などの、出た・出ていないを見える化', 'g'],
      ['見積の比較表づくり', '複数社の見積を、同じ形の表に並べる', 'y'],
      ['注文書・契約書類の作成補助', '決まった内容から、注文書の下書きを作る', 'y'],
      ['出来高・支払いの確認補助', '出来高と請求の金額が合っているかを照らし合わせる', 'y'],
      ['発注先の決定・契約の締結', 'どこに頼むかと契約は、責任者が決める', 'r'],
    ],
  },
  {
    id: 'anzen',
    short: '安全',
    name: '安全品質環境本部（安全）',
    icon: 'i-shield',
    role: '海でも陸でも、みんなをけがから守る係',
    tools: [
      ['安全パトロール記録', '支店の安全パトロールでの指摘と、直したかどうかを記録する', 'g'],
      ['KY・安全書類の書きもれ確認', '空欄や記入もれを知らせるだけ。危険の見積もりは人', 'y', 1],
      ['暑さ指数（WBGT）のお知らせ', '気象データから暑さ指数を現場に知らせる（休憩・中止の判断は人）', 'y'],
      ['潜水作業の記録の整理', '潜った時間や深さの記録をまとめ、決まりを外れそうなときに知らせる（潜水の計画は人）', 'y'],
      ['ヒヤリハットの集計・傾向', '報告を集めて、多い場所・時間・作業を見える化する', 'y'],
      ['多言語の安全教育資料', '外国籍の仲間向けに資料を訳す（訳は必ず人が確認）', 'y'],
      ['作業中止・立入禁止などの安全判断', '現場の安全に関わる決定は、責任者が行う', 'r'],
    ],
  },
  {
    id: 'hinshitsu',
    short: '品質・環境',
    name: '安全品質環境本部（品質・環境）',
    icon: 'i-ruler',
    role: '出来ばえと、海や地球への影響を確かめる係',
    tools: [
      ['検査記録・試験成績の管理', 'コンクリート試験などの結果を、工事ごとに整理する', 'g', 1],
      ['不具合・是正の追跡', '見つかった不具合が、直ったかどうかを最後まで追う', 'g'],
      ['ISOの記録あつめ', 'ISO 9001・14001・45001で必要な記録が、そろっているかを示す', 'y'],
      ['海の濁りなどの測定記録', '工事中の海の濁りなどの測定値を集め、基準に近づいたら知らせる（工事を止めるかは人）', 'y'],
      ['電子納品の形式チェック', '提出データの形式やファイル名のまちがいを知らせる', 'y'],
      ['検査の合否判定', '合格か不合格かを決めるのは検査員', 'r'],
    ],
  },
  {
    id: 'iji',
    sea: true,
    short: '維持・補修',
    name: '維持・補修（支店・技術本部）',
    icon: 'i-loop',
    role: 'できあがった港や空港を、長く使えるように見守る係',
    tools: [
      ['点検記録・傷んだ所の写真の管理', '点検の結果と写真を、施設・場所ごとに整理する', 'g', 1],
      ['補修の記録の台帳', 'いつ、どこを、どう直したかを残す', 'g'],
      ['保証期間・定期点検のお知らせ', '保証の期限や点検の時期が近いことを知らせる', 'g'],
      ['写真からの「要確認」候補', 'ひび割れなどがありそうな写真に印を付ける（判断は技術者）', 'y'],
      ['補修方法の比べっこ資料', 'いくつかの補修方法を、費用・工期で並べた下書きを作る', 'y'],
      ['健全度・補修が必要かの判定', '施設の状態の評価は、資格を持つ技術者が行う', 'r'],
    ],
  },
  {
    id: 'shiten',
    short: '支店・営業所',
    name: '全国の支店・営業所（事務・地域の窓口）',
    icon: 'i-pin',
    role: '北海道から沖縄まで、地域の窓口として現場を支える係',
    tools: [
      ['支店ごとの現場一覧と連絡先', 'どこで、どんな工事を、だれが担当しているかがわかる', 'g', 1],
      ['地域の協力会社・役所の連絡先台帳', '地域の連絡先を、支店の中で同じものを使う', 'g'],
      ['災害のあとの安否確認・現場の被害報告', '地震や台風のあと、社員と現場の様子を集める', 'g'],
      ['事務所の申請（備品・車など）', '紙やメールの申請を、電子の申請にまとめる', 'g'],
      ['地域の発注予定のまとめ', 'その地域の発注予定を集めて、短くまとめる（どれをねらうかは人）', 'y'],
      ['災害復旧に出動するか・人を送るかの判断', '地域を助けに行くかどうかは、支店長と責任者が決める', 'r'],
    ],
  },
  {
    id: 'somu',
    short: '総務・法務',
    name: '管理本部（総務・法務）',
    icon: 'i-doc',
    role: '会社の書類とルールの係',
    tools: [
      ['規程・マニュアルの検索', '「この場合どうする？」を社内規程からすぐに探す', 'g', 1],
      [
        '許可・登録の更新期限の管理',
        '建設業許可・建設コンサルタント登録・測量業者登録など、たくさんの許可・登録の更新日を知らせる',
        'g',
      ],
      ['社内申請・稟議の電子化', "紙の申請を desknet's NEO / AppSuite の電子申請にする", 'g'],
      ['文書の保存期間と廃棄の管理', 'いつまで保存し、いつ廃棄するかを管理する', 'g'],
      ['契約書の条文チェック補助', 'ひな形とちがう条文に印を付ける（読み方は法務担当）', 'y'],
      ['契約の締結・法律の判断', '契約してよいか、法律上どうかは人が判断する', 'r'],
    ],
  },
  {
    id: 'jinji',
    short: '人事・労務',
    name: '管理本部（人事・労務）',
    icon: 'i-users',
    role: '人を育て、働き方を守る係',
    tools: [
      ['勤怠と時間外労働のお知らせ', '残業の上限に近づいた人と上司に、早めに知らせる', 'g', 1],
      ['資格・免許の取得と期限の管理', 'だれが何の資格を持ち、いつ更新かがわかる', 'g'],
      ['転勤・単身赴任の手続きの案内', '転勤や帰省のときに必要な手続きを、順番に案内する', 'g'],
      ['教育・研修の受講記録', '受けた研修と、まだ受けていない研修がわかる', 'g'],
      ['建設キャリアアップシステム（CCUS）の記録整理', '就業の記録を集計して、確認しやすくする', 'g'],
      ['求人票・研修資料のたたき台', '求人や研修の資料の下書きを作る（公平な表現か人が確認）', 'y'],
      ['採用・評価・配置・処分の決定', '人に関わる判断はAIに決めさせない。人が責任を持って決める', 'r'],
    ],
  },
  {
    id: 'keiri',
    short: '経理部',
    name: '管理本部 経理部',
    icon: 'i-yen',
    role: 'お金の出入りと、会社の財布を守る係',
    tools: [
      ['工事ごとの原価集計', '現場の入力から、工事ごとのお金を自動で集計する', 'g'],
      ['入金・支払いの予定の見える化', 'いつ、いくら入って、いくら出るかがわかる', 'g'],
      ['請求書の受け取りと仕訳の候補', '届いた請求書を読み取り、仕訳の候補を出す（確定は経理担当）', 'y', 1],
      ['経費精算の書きもれチェック', '領収書の不足や、ルールとちがう申請を知らせる', 'y'],
      ['内部統制（J-SOX）の証跡あつめ', 'グループの決まりに合わせて、確認に必要な記録を集め、そろっているか示す', 'y'],
      ['支払いの承認・決算の確定', 'お金を払うことと、決算の数字は人が確定する', 'r'],
    ],
  },
  {
    id: 'dx',
    short: 'DX推進部',
    name: 'DX推進部（情報システム）',
    icon: 'i-monitor',
    role: 'ITの道具をそろえ、会社の情報を守る係',
    tools: [
      ['PC・アカウントの台帳', '入社・退社・転勤と連動して、PCとアカウントを管理する', 'g', 1],
      ['全国の支店・現場の通信機器の状態', '支店や現場事務所の通信機器が動いているかを一覧で見る', 'g'],
      [
        'ヘルプデスクの受付と一次回答',
        "desknet's NEO / AppSuite で受け付け、よくある質問に答える（回答内容は担当が見守る）",
        'y',
      ],
      ['セキュリティ通知の整理', 'たくさんの警告をまとめ、急ぐものを上に出す', 'y'],
      ['ソフトウェアファクトリー自体の運用', 'このラインの検査ルールや権限を管理する', 'y'],
      ['権限の付与・セキュリティ例外の承認', 'だれに何の権限を渡すかは、人が承認する', 'r'],
    ],
  },
  {
    id: 'kansa',
    short: '内部監査',
    name: '内部監査・コンプライアンス',
    icon: 'i-eye',
    role: 'ルールが守られているかを確かめる係',
    tools: [
      ['法令改正のお知らせ', '建設業法や港の工事に関係する法令の改正を集めて知らせる', 'g', 1],
      ['監査の指摘のフォロー', '指摘された点が、直ったかどうかを追う', 'g'],
      ['監査の証跡あつめ・チェックリスト', '監査に必要な記録を集め、チェックリストを準備する', 'y'],
      ['規程と実際のずれの候補', '規程と実際の記録がちがいそうな所に印を付ける', 'y'],
      ['内部通報の受付台帳', '通報の受付と対応の記録（見られるのは担当者だけ、通報者を守る）', 'y'],
      ['不正の認定・処分の判断', '不正かどうか、どう対応するかは人が判断する', 'r'],
    ],
  },
  {
    id: 'koho',
    short: '広報・サステナ',
    name: '広報・サステナビリティ',
    icon: 'i-mega',
    role: '会社のことを社会に知ってもらい、地球にやさしい会社にする係',
    tools: [
      ['見学会・イベントの申込受付', '現場見学会や、港のイベントへの出展の申込と連絡をまとめる', 'g', 1],
      ['写真素材の管理（了解つき）', '広報用の写真を、写っている人の了解の有無と一緒に管理する', 'g'],
      [
        'サステナビリティ報告書のデータあつめ',
        'CO2・廃棄物・リサイクル材の量などを、報告書用に集める（数字は担当者が確認）',
        'y',
      ],
      ['広報記事・SNS投稿のたたき台', '現場の話題から、記事の下書きを作る', 'y'],
      ['近隣・漁業関係者へのお知らせ文', '工事のお知らせの下書きを作る（内容は現場と確認）', 'y'],
      ['対外発表・おわびの最終決定', '会社として何を発表するかは、責任者が決める', 'r'],
    ],
  },
];

/* ===== みらいソフトウェアファクトリー 詳細受付：共通コア（オフライン） ===== */
const SF = (function () {
  const COLORS = { g: { l: '青', n: '任せる' }, y: { l: '黄', n: 'チェック付き' }, r: { l: '赤', n: '決めさせない' } };
  const RANK = { g: 0, y: 1, r: 2 };
  const STATUSES = [
    { k: 'received', l: '受付', flow: 1 },
    { k: 'review', l: '内容確認中', flow: 1 },
    { k: 'wait', l: '承認待ち', flow: 1 },
    { k: 'approved', l: '承認済み', flow: 1 },
    { k: 'dev', l: '実装中', flow: 1 },
    { k: 'verify', l: '検証中', flow: 1 },
    { k: 'field', l: '現場試用', flow: 1 },
    { k: 'release_wait', l: '公開承認待ち', flow: 1 },
    { k: 'done', l: '完了', flow: 1 },
    { k: 'back', l: '差戻し', flow: 0 },
    { k: 'hold', l: '見送り', flow: 0 },
    { k: 'cancel', l: '取消', flow: 0 },
  ];
  const NEXT = {
    received: 'review',
    review: 'wait',
    wait: 'approved',
    approved: 'dev',
    dev: 'verify',
    verify: 'field',
    field: 'release_wait',
    release_wait: 'done',
    back: 'received',
  };
  /* 現場向けの道具（屋外・海の上・電波の弱い所で使う）だけが「現場試用」を通る */
  const FIELD_PLACES = ['陸の現場（屋外）', '海の上（作業船・台船）', '電波の弱い現場'];
  const isFieldTool = (r) => (r.places || []).some((p) => FIELD_PLACES.includes(p));
  function nextOf(r) {
    if (r.status === 'verify') return isFieldTool(r) ? 'field' : 'release_wait';
    return NEXT[r.status];
  }
  const ENDED = ['done', 'hold', 'cancel'];
  const ROLES = [
    { k: 'requester', l: '依頼者', name: '山田 太郎', dept: 'kaijo' },
    { k: 'desk', l: '受付担当（DX推進部）', name: '佐藤 花子', dept: 'dx' },
    { k: 'approver', l: '承認者（業務責任者）', name: '鈴木 一郎', dept: 'kaijo' },
    { k: 'ops', l: '運用担当（DX推進部 基盤・運用）', name: '井上 翔太', dept: 'dx' },
    { k: 'sec', l: 'セキュリティ担当（DX推進部）', name: '木村 玲奈', dept: 'dx' },
    { k: 'admin', l: '工場の管理責任者（DX推進部 責任者）', name: '森本 誠', dept: 'dx' },
    { k: 'auditor', l: '内部監査', name: '小川 直人', dept: 'kansa' },
  ];
  const KINDS = ['新しい道具がほしい', 'いまある道具を良くしたい', '不具合の報告', '相談・アイデア'];
  const USERS = [
    '現場の担当者',
    '現場所長',
    '現場事務',
    '作業船の船長・船員',
    '潜水士',
    '本社の本部の担当者',
    '支店・営業所の担当者',
    '協力会社',
    '発注者（国・港湾管理者など）',
    '民間のお客様',
    '経営層',
  ];
  const PLACES = ['事務所', '陸の現場（屋外）', '海の上（作業船・台船）', '電波の弱い現場', '移動中・車内'];
  const DATA = [
    { k: 'personal', l: '個人情報（名簿・資格・健康など）' },
    { k: 'client', l: '発注者から預かった図面・データ' },
    { k: 'location', l: '現場の位置情報' },
    { k: 'photo', l: '工事写真・検査記録の原本' },
    { k: 'money', l: 'お金の情報（金額・原価・支払い）' },
    { k: 'vessel', l: '作業船の運航・位置・点検の記録' },
    { k: 'env', l: '海の濁りなど環境の測定値' },
  ];
  const PARTIES = ['社内のみ', '協力会社も使う', '発注者も見る'];
  const DECIDES = [
    { k: 'g', l: '記録・整理・検索・お知らせ' },
    { k: 'y', l: 'たたき台づくり・比べっこ・見落としチェック' },
    { k: 'r', l: '合否・金額・契約・人の処遇・安全（出航・作業中止など）を決める' },
  ];
  const CONSTRAINTS = [
    'いまのログイン方法は変えない',
    '本物のデータを練習用の場所に持ち込まない',
    '写真・記録の原本は加工しない',
    '個人情報は必要な人だけが見られるようにする',
    '電波がなくても入力が消えないようにする',
    '天気・波の予報は「目安」として見せ、作業するかどうかは表示しない',
  ];
  const APPROVALS = [
    'データを消す・作り直す変更',
    'ログインや権限の変更',
    '新しい外部サービスとの接続',
    '協力会社・発注者に見せる範囲の変更',
    '提出様式の変更',
    '安全・品質の判定にかかわる変更',
    '作業船の運航・海の上の作業にかかわる変更',
  ];
  const FREQ = [
    { k: 'd', l: '毎日', m: 20 },
    { k: 'w', l: '毎週', m: 4 },
    { k: 'm', l: '毎月', m: 1 },
    { k: 'o', l: 'ときどき', m: 0.3 },
  ];
  const READY = [
    { k: 5, l: '電子データでそろっている' },
    { k: 3, l: '一部は紙・Excel' },
    { k: 1, l: '紙や人の頭の中' },
  ];
  const SPREAD = [
    { k: 5, l: '全社（海・陸・全支店）で使えそう' },
    { k: 3, l: 'いくつかの部署・支店・現場で使えそう' },
    { k: 1, l: '自分の部署・現場だけ' },
  ];
  const VAGUE = [
    '使いやすい',
    '使い易い',
    '見やすい',
    'わかりやすい',
    '分かりやすい',
    'いい感じ',
    'いいかんじ',
    '適切',
    '適宜',
    'なるべく',
    'できるだけ',
    '早く',
    '速く',
    'すばやく',
    '簡単',
    'かんたん',
    '便利',
    'スムーズ',
    'きれい',
    'ちゃんと',
    'しっかり',
    '柔軟',
    '直感的',
    '快適',
    'いろいろ',
    'など',
  ];

  const pad = (n, l) => String(n).padStart(l || 2, '0');
  function nowISO() {
    return new Date().toISOString();
  }
  function fmt(iso, withTime) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const s = d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate());
    return withTime === false ? s : s + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  }
  function lines(t) {
    return String(t || '')
      .split(/\r?\n/)
      .map((s) => s.replace(/^\s*[-・●]\s*/, '').trim())
      .filter(Boolean);
  }
  const statusOf = (k) => STATUSES.find((s) => s.k === k) || STATUSES[0];
  const deptOf = (id) => CATALOG.find((d) => d.id === id);
  function toolOf(ref) {
    if (!ref) return null;
    const [d, i] = ref.split('|');
    const dep = deptOf(d);
    if (!dep) return null;
    const t = dep.tools[+i];
    return t ? { dept: dep, name: t[0], desc: t[1], c: t[2] } : null;
  }
  const roleOf = (k) => ROLES.find((r) => r.k === k) || ROLES[0];

  /* ---- 信号の色の判定（候補） ---- */
  function judge(r) {
    const reasons = [];
    let c = 'g';
    const up = (to, why) => {
      if (RANK[to] > RANK[c]) c = to;
      reasons.push({ c: to, t: why });
    };
    if (r.decides)
      up(
        r.decides,
        r.decides === 'r'
          ? '「決める」仕事が入っています。AIに決めさせない範囲です'
          : r.decides === 'y'
            ? 'たたき台・チェックの道具は、担当者の確認が必要です'
            : '記録・整理・お知らせの道具です',
      );
    const tool = toolOf(r.toolRef);
    if (tool && tool.c !== 'g') up(tool.c, 'カタログ上の色が「' + COLORS[tool.c].l + '」の道具です');
    (r.data || []).forEach((k) => {
      const d = DATA.find((x) => x.k === k);
      if (d) up('y', d.l + 'を扱います');
    });
    if (r.parties && r.parties !== '社内のみ')
      up('y', '社外の人（' + r.parties.replace('も使う', '').replace('も見る', '') + '）が関わります');
    if ((r.approvals || []).includes('安全・品質の判定にかかわる変更')) up('y', '安全・品質の判定にかかわります');
    if ((r.approvals || []).includes('作業船の運航・海の上の作業にかかわる変更'))
      up('y', '作業船・海の上の作業にかかわります（出航・作業中止は人が決めます）');
    if (!reasons.length) reasons.push({ c: 'g', t: 'まだ判定材料がありません（「この道具は何をしますか」を選んでください）' });
    return { c, reasons };
  }

  /* ---- ものさし（参考値。着手順は別途決定） ---- */
  function measure(r) {
    const f = FREQ.find((x) => x.k === r.freq);
    const people = Math.max(0, +r.people || 0),
      minutes = Math.max(0, +r.minutes || 0);
    const hours = f ? Math.round(((people * f.m * minutes) / 60) * 10) / 10 : 0;
    const band = (v, cuts) => {
      let s = 1;
      cuts.forEach((x, i) => {
        if (v >= x) s = i + 2;
      });
      return Math.min(s, 5);
    };
    const j = judge(r);
    const scores = [
      { k: 'people', l: '困っている人の多さ', v: people ? band(people, [3, 10, 30, 100]) : 0 },
      { k: 'signal', l: '青信号か', v: r.decides ? { g: 5, y: 3, r: 1 }[j.c] : 0 },
      { k: 'hours', l: '手間の減り方', v: hours ? band(hours, [5, 20, 50, 150]) : 0 },
      { k: 'ready', l: 'データがそろっているか', v: +r.dataReady || 0 },
      { k: 'spread', l: 'ほかに広げられるか', v: +r.spread || 0 },
    ];
    return { hours, scores };
  }

  /* ---- 合格の条件のチェック ---- */
  function lint(text) {
    const t = String(text || '').trim();
    if (!t) return { ok: false, level: 'empty', words: [], tip: '' };
    if (/〇〇|△△|○○|□□/.test(t))
      return { ok: false, level: 'vague', words: ['〇〇'], tip: '「〇〇」「△△」の所を、自分の言葉に書きかえてください。' };
    const words = VAGUE.filter((w) => t.includes(w));
    if (words.length)
      return {
        ok: false,
        level: 'vague',
        words,
        tip:
          '「' +
          words.join('」「') +
          '」は人によって受け取り方がちがうため、検査機で合否を決められません。数字や「〜できる／〜できない」で書いてみましょう。',
      };
    if (t.length < 8)
      return { ok: false, level: 'short', words: [], tip: 'もう少し具体的に書きましょう（だれが・何を・どうなれば合格か）。' };
    return { ok: true, level: 'ok', words: [], tip: '検査で確かめられる書き方です。' };
  }
  function markVague(text) {
    let h = esc(text);
    VAGUE.slice()
      .sort((a, b) => b.length - a.length)
      .forEach((w) => {
        h = h.split(esc(w)).join('<mark class="vague">' + esc(w) + '</mark>');
      });
    return h;
  }

  /* ---- 権限（サンプル） ---- */
  function canMove(role, from, to) {
    if (from === to) return false;
    if (from === 'cancel') return role === 'approver';
    if (to === 'cancel' && ['done', 'hold'].includes(from)) return false;
    if (role === 'approver') return true;
    if (role === 'desk') return !['approved', 'done'].includes(to) && from !== 'done';
    if (role === 'requester')
      return (from === 'back' && to === 'received') || (['received', 'back'].includes(from) && to === 'hold');
    return false;
  }
  function canEdit(role, r, name) {
    if (!['requester', 'desk', 'approver'].includes(role)) return false;
    if (r.status === 'cancel') return false;
    return role !== 'requester'
      ? !['done'].includes(r.status)
      : ['received', 'back'].includes(r.status) && (!name || r.applicant === name);
  }
  /* 依頼者は「自分の依頼」だけを動かせる */
  function canMoveR(role, r, to, name) {
    return canMove(role, r.status, to) && (role !== 'requester' || r.applicant === name);
  }
  function whyNotR(role, r, to, name) {
    return role === 'requester' && r.applicant !== name && canMove(role, r.status, to)
      ? 'ほかの人の依頼は動かせません（起票者：' + r.applicant + '）'
      : whyNot(role, r.status, to);
  }
  const roleShort = (k) => roleOf(k).l.replace(/（.*）/, '');
  function whoCan(from, to) {
    return ROLES.filter((x) => canMove(x.k, from, to)).map((x) => roleShort(x.k));
  }
  function whyNot(role, from, to) {
    if (from === to) return 'いまの状態です';
    if (['ops', 'sec', 'admin', 'auditor'].includes(role))
      return '依頼の状態は受付担当・承認者が動かします（' + roleShort(role) + 'は運用・DevOps・SecOps の画面で操作します）';
    if (from === 'cancel') return '取り消した依頼を戻せるのは承認者だけです';
    if (to === 'cancel' && ['done', 'hold'].includes(from)) return '完了・見送りの依頼は取り消せません（記録として残します）';
    if (from === 'done') return '完了した依頼を動かせるのは承認者だけです';
    if (['approved', 'done'].includes(to) && role !== 'approver')
      return '「' + statusOf(to).l + '」にできるのは承認者だけです（最後は人が決めます）';
    if (role === 'requester') {
      if (to === 'received') return '受付に戻す（再提出する）のは、差戻しになったときだけです';
      if (to === 'hold') return '取り下げ（見送り）ができるのは、受付・差戻しのときだけです';
      return '依頼者が動かせるのは「差戻し→再提出」と「取り下げ」だけです。進め方は受付担当が決めます';
    }
    return 'いまの役割では選べません';
  }
  /* ---- だれの番か ---- */
  const NEXTBY = {
    received: 'desk',
    review: 'desk',
    wait: 'approver',
    approved: 'desk',
    dev: 'desk',
    verify: 'desk',
    field: 'desk',
    release_wait: 'approver',
    back: 'requester',
  };
  const TURN = {
    requester: { back: '指摘を直して再提出する', field: '現場で使ってみて感想をコメントする' },
    desk: {
      received: '中身を確認して「内容確認中」へ',
      review: '注文書を整えて承認を依頼する',
      approved: '開発（AIで作る）を始める',
      dev: 'できあがりを検証へ回す',
      verify: '検査に合格したら次へ（現場向けは現場試用、ほかは公開承認待ち）',
      field: '試用結果を記録して「公開承認待ち」へ',
    },
    approver: { wait: '信号の色を決めて、承認か差戻しを決める', release_wait: 'リリース判定（公開承認）をする' },
  };
  function turnOf(role, r, name) {
    const a = (TURN[role] || {})[r.status];
    if (!a) return '';
    if (role === 'requester' && r.applicant !== name) return '';
    if (role === 'approver' && r.approver && r.approver !== name) return '';
    return a;
  }
  /* ---- 滞留日数（いまの状態になってから） ---- */
  function since(r) {
    const h = (r.history || []).filter((x) => /^受付$|^状態を/.test(x.action || ''));
    return (h.length ? h[h.length - 1].at : r.createdAt) || r.updatedAt || '';
  }
  function stayDays(r, now) {
    const t = new Date(since(r)).getTime();
    if (isNaN(t)) return 0;
    return Math.max(0, Math.floor(((now || Date.now()) - t) / 86400000));
  }
  const STAY_WARN = 3,
    STAY_ALERT = 7;
  /* ---- あいまい語の書き換え候補 ---- */
  const REWRITE = [
    {
      w: ['使いやすい', '使い易い', '直感的', '簡単', 'かんたん', '便利', '快適', 'スムーズ'],
      hint: '「操作の回数」「かかる時間」「説明なしでできるか」で書くと検査できます',
      ex: [
        '〇〇まで3回以内の操作でたどり着ける',
        '初めての人が説明なしで〇〇を5分以内に終えられる',
        '手袋をしたままでも〇〇のボタンを押せる',
      ],
    },
    {
      w: ['見やすい', 'わかりやすい', '分かりやすい', 'きれい'],
      hint: '「どこに・何が・どの大きさで出るか」で書くと検査できます',
      ex: [
        '〇〇が画面のいちばん上に表示される',
        '〇〇は色だけでなく文字でも区別できる',
        '屋外の明るさでも〇〇の文字が△△ポイント以上で表示される',
      ],
    },
    {
      w: ['早く', '速く', 'すばやく'],
      hint: '「何秒・何分・いつまでに」を数字で書くと検査できます',
      ex: ['〇〇を押してから3秒以内に△△が表示される', '〇〇の翌営業日の朝9時までに△△へ通知される'],
    },
    {
      w: ['なるべく', 'できるだけ', 'しっかり', 'ちゃんと', '適切', '適宜'],
      hint: '「必ず〜する」「〜のときは〜できない」と言い切ると検査できます',
      ex: ['〇〇が空のままでは登録できない', '〇〇のときは必ず△△に通知される', '〇〇は△△だけが見られる'],
    },
    {
      w: ['柔軟', 'いろいろ', 'など'],
      hint: '対象をすべて書き出し、それ以外は「今回は作らない」へ回すと検査できます',
      ex: ['〇〇・△△・□□の3種類に対応する（それ以外は今回は作らない）'],
    },
    {
      w: ['いい感じ', 'いいかんじ'],
      hint: '「何と比べて・どれくらいの差なら合格か」を書くと検査できます',
      ex: ['〇〇と△△の差が□□以内のときに合格とする', '〇〇は担当者が「確定」を押すまで登録されない'],
    },
  ];
  function suggest(text) {
    const t = String(text || ''),
      out = [];
    REWRITE.forEach((g) => {
      const hit = g.w.filter((w) => t.includes(w));
      if (hit.length) out.push({ words: hit, hint: g.hint, ex: g.ex });
    });
    return out;
  }
  /* ---- 承認前チェック（自動） ---- */
  function precheck(r) {
    const out = [],
      add = (k, lv, t) => out.push({ k, lv, t });
    const cr = (r.criteria || []).map((x) => String(x).trim()).filter(Boolean),
      bad = cr.filter((x) => !lint(x).ok);
    if (!cr.length) add('crit', 'w', '合格の条件が1つもありません。検査機で合否を決められません');
    else if (bad.length)
      add(
        'crit',
        'w',
        '合格の条件 ' + cr.length + ' 件のうち ' + bad.length + ' 件が検査しにくい書き方です（例：「' + bad[0] + '」）',
      );
    else add('crit', 'ok', '合格の条件 ' + cr.length + ' 件は、すべて検査で確かめられる書き方です');
    if (!lines(r.outScope).length) add('out', 'w', '「今回は作らない」が空です。作りすぎ・手戻りのおそれがあります');
    else add('out', 'ok', '「今回は作らない」が書かれています');
    const dl = (r.data || []).map((k) => (DATA.find((x) => x.k === k) || {}).l).filter(Boolean);
    if (dl.length)
      add('data', 'w', '扱う情報：' + dl.join('、') + '。見られる人の範囲と、練習用の場所に本物を持ち込まないことを確認');
    else add('data', 'ok', '特別な情報（個人情報・お金など）は扱いません');
    if (r.parties && r.parties !== '社内のみ') add('party', 'w', '社外の人（' + r.parties + '）が関わります。見せる範囲を確認');
    const ap = r.approvals || [];
    if (ap.includes('安全・品質の判定にかかわる変更') || ap.includes('作業船の運航・海の上の作業にかかわる変更'))
      add('safety', 'w', '安全・品質／作業船の運航にかかわります。判定・出航・作業中止を道具に決めさせない作りか確認');
    if (r.decides === 'r' || judge(r).c === 'r')
      add('red', 'w', '赤信号の仕事（合否・金額・契約・処遇・安全を決める）が含まれます');
    return out;
  }
  /* ---- 差戻し・見送りの理由テンプレート ---- */
  const REASONS = {
    back: [
      { k: 'crit', t: '合格の条件を、数字や「〜できる／〜できない」で書き直してください。' },
      { k: 'out', t: '「今回は作らない」を書き足してください。' },
      {
        k: 'red',
        t: '「決める」仕事（合否・金額・安全など）はAIに任せられません。範囲を「材料集め・表示」までに変えてください。',
      },
      { k: 'data', t: '扱う情報（個人情報・お金など）と、見られる人の範囲を書き足してください。' },
      { k: '', t: '困っていること・目的を、もう少し具体的に（だれが・いつ・どれくらい）書いてください。' },
      { k: '', t: '似た依頼があるため、まとめて進めます（受付番号：　）。' },
    ],
    hold: [
      { k: '', t: '今期は優先度が低いため見送ります（次の見直しで再検討します）。' },
      { k: '', t: 'いまある道具・市販の製品で対応できるため見送ります。' },
      { k: '', t: '似た依頼にまとめました（受付番号：　）。' },
      { k: '', t: '元になるデータがそろっていないため見送ります。' },
      { k: '', t: '依頼者から取り下げの申し出がありました。' },
    ],
    received: [{ k: '', t: 'ご指摘の点を直して再提出します。' }],
    cancel: [
      { k: '', t: '重複して登録された依頼のため取り消します（記録は残します）。' },
      { k: '', t: '誤って登録された依頼のため取り消します（記録は残します）。' },
      { k: '', t: '依頼者の申し出により取り消します（記録は残します）。' },
    ],
  };

  /* ---- 注文書（作業指示書）YAML ---- */
  function q(s) {
    return (
      '"' +
      String(s == null ? '' : s)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r?\n/g, ' ') +
      '"'
    );
  }
  function list(key, arr, ind) {
    ind = ind || '';
    if (!arr || !arr.length) return ind + key + ': []\n';
    return ind + key + ':\n' + arr.map((x) => ind + '  - ' + q(x)).join('\n') + '\n';
  }
  function toYAML(r) {
    const j = judge(r),
      m = measure(r),
      d = deptOf(r.dept),
      tool = toolOf(r.toolRef);
    const dataL = (r.data || []).map((k) => (DATA.find((x) => x.k === k) || {}).l).filter(Boolean);
    const f = FREQ.find((x) => x.k === r.freq);
    let y = '';
    y += 'id: ' + q(r.id) + '\n';
    y += 'title: ' + q(r.title) + '\n';
    y += 'kind: ' + q(r.kind) + '\n';
    y += 'department: ' + q(d ? d.name : '') + '\n';
    y += 'catalog_tool: ' + q(tool ? tool.name : 'カタログ外') + '\n';
    y += 'requested_by: ' + q(r.applicant) + '\n';
    y += 'approver: ' + q(r.approver) + '\n';
    y += 'status: ' + q(statusOf(r.status).l) + '\n';
    y +=
      'signal:\n  suggested: ' +
      q(COLORS[j.c].l) +
      '\n  decided: ' +
      q(r.signalFinal ? COLORS[r.signalFinal].l : '未決定（承認者が決める）') +
      '\n';
    y += '\n' + list('problem', lines(r.problem));
    y += list('purpose', lines(r.purpose));
    y += list('users', r.users);
    y += list('places', r.places);
    y += '\n' + list('scope', lines(r.scope));
    y += list('out_of_scope', lines(r.outScope));
    y += '\n' + list('acceptance_criteria', (r.criteria || []).filter(Boolean));
    y += '\n' + list('constraints', (r.constraints || []).concat(lines(r.constraintsOther)));
    y += list('data_handling', dataL.length ? dataL : ['特別な情報は扱わない']);
    y += 'parties: ' + q(r.parties || '社内のみ') + '\n';
    y += list('requires_human_approval', r.approvals);
    y += '\nmeasure:  # 参考値。着手順は別途決める\n';
    y +=
      '  people: ' +
      (+r.people || 0) +
      '\n  frequency: ' +
      q(f ? f.l : '') +
      '\n  minutes_per_time: ' +
      (+r.minutes || 0) +
      '\n  est_hours_per_month: ' +
      m.hours +
      '\n';
    y += '\nrequested_at: ' + q(fmt(r.createdAt)) + '\nwish_date: ' + q(r.wish || '') + '\n';
    return y;
  }

  /* ---- CSV ---- */
  function toCSV(items) {
    const head = [
      '受付番号',
      '件名',
      '部署',
      '依頼区分',
      '起票者',
      '信号（候補）',
      '信号（決定）',
      '状態',
      '月あたり削減見込み(h)',
      '受付日時',
      '更新日時',
    ];
    const cell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const rows = items.map((r) => {
      const j = judge(r),
        m = measure(r),
        d = deptOf(r.dept);
      return [
        r.id,
        r.title,
        d ? d.name : '',
        r.kind,
        r.applicant,
        COLORS[j.c].l,
        r.signalFinal ? COLORS[r.signalFinal].l : '',
        statusOf(r.status).l,
        m.hours,
        fmt(r.createdAt),
        fmt(r.updatedAt),
      ]
        .map(cell)
        .join(',');
    });
    return '﻿' + head.map(cell).join(',') + '\r\n' + rows.join('\r\n');
  }
  function download(name, text, mime) {
    try {
      const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 500);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---- 保存（ブラウザ内のみ。使えない環境ではメモリ保持） ---- */
  let memory = null;
  function load(key) {
    try {
      const s = localStorage.getItem(key);
      if (s) {
        const d = JSON.parse(s);
        if (d && Array.isArray(d.items)) {
          if (!d.ops) d.ops = seedOps(d.items);
          return { data: d, persistent: true };
        }
      }
    } catch (e) {
      return { data: memory || seed(), persistent: false };
    }
    return { data: seed(), persistent: storageOK() };
  }
  function storageOK() {
    try {
      const k = '__sf_t';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }
  function save(key, data) {
    memory = data;
    try {
      localStorage.setItem(key, JSON.stringify(data));
      return true;
    } catch (e) {
      return false;
    }
  }
  function nextId(data) {
    data.seq = (data.seq || 0) + 1;
    return 'REQ-2026-' + pad(data.seq, 4);
  }
  function validImport(obj) {
    return (
      obj && Array.isArray(obj.items) && obj.items.every((x) => x && typeof x.id === 'string' && typeof x.title === 'string')
    );
  }

  function blank(role) {
    const ro = roleOf(role);
    return {
      id: '',
      createdAt: '',
      updatedAt: '',
      applicant: ro.name,
      dept: ro.dept,
      contact: '',
      title: '',
      kind: KINDS[0],
      toolRef: '',
      problem: '',
      purpose: '',
      users: [],
      people: '',
      places: [],
      scope: '',
      outScope: '',
      criteria: ['', '', ''],
      constraints: CONSTRAINTS.slice(0, 2),
      constraintsOther: '',
      data: [],
      parties: '社内のみ',
      approvals: [],
      decides: '',
      freq: '',
      minutes: '',
      dataReady: '',
      spread: '',
      wish: '',
      attachments: [],
      approver: '鈴木 一郎',
      status: 'received',
      signalFinal: '',
      history: [],
      comments: [],
    };
  }

  /* ---- サンプルデータ ---- */
  function seed() {
    const base = new Date('2026-10-01T09:00:00+09:00').getTime();
    const at = (day, h) => new Date(base + day * 86400000 + (h || 0) * 3600000).toISOString();
    const H = (day, by, role, action, note, h) => ({ at: at(day, h), by, role, action, note: note || '' });
    const S = [
      {
        title: '工事写真の圏外保存',
        dept: 'kaijo',
        toolRef: 'kaijo|0',
        kind: 'いまある道具を良くしたい',
        applicant: '山田 太郎',
        decides: 'g',
        data: ['photo'],
        status: 'field',
        signalFinal: 'y',
        problem: '作業船や台船の上では電波が弱く写真が送れず、事務所に戻ってから整理し直している',
        purpose: '海の上でも写真が消えずに残り、事務所での整理の手間をなくす',
        users: ['現場の担当者', '現場事務', '現場所長'],
        people: 40,
        places: ['海の上（作業船・台船）', '電波の弱い現場'],
        scope: '圏外での一時保存\n電波が戻った時の自動送信\n送信済み・未送信の表示',
        outScope: '発注者システムへの直接提出\n写真の加工・編集',
        criteria: [
          '圏外で撮った写真がアプリを閉じても消えない',
          '電波が戻ると自動で送られ、二重に登録されない',
          '撮影日時・撮影場所の記録をあとから書きかえられない',
          'ほかの現場の写真は見えない',
        ],
        constraints: [
          '写真・記録の原本は加工しない',
          '本物のデータを練習用の場所に持ち込まない',
          '電波がなくても入力が消えないようにする',
        ],
        approvals: ['提出様式の変更'],
        freq: 'd',
        minutes: 15,
        dataReady: 5,
        spread: 5,
        d0: 0,
      },
      {
        title: '作業船の予定をひと目で見たい',
        dept: 'senpaku',
        toolRef: 'senpaku|0',
        kind: '新しい道具がほしい',
        applicant: '高橋 健',
        decides: 'g',
        data: ['vessel'],
        status: 'dev',
        signalFinal: 'g',
        problem: 'どの作業船が、いつ、どの港の現場にいるかを電話で確認しており、現場どうしの調整に時間がかかる',
        purpose: '作業船の予定を、支店や現場のだれでもすぐに見られるようにする',
        users: ['現場所長', '作業船の船長・船員', '本社の本部の担当者', '支店・営業所の担当者'],
        people: 60,
        places: ['事務所', '海の上（作業船・台船）'],
        scope: '船ごとの予定カレンダー\n予定の登録・取り消し\n検査期限切れの船は予定に入れられない',
        outScope: '回航（船の移動）の手配\n費用の計算\n船を出すかどうかの判断',
        criteria: [
          '同じ作業船を同じ期間に二重に予定できない',
          '検査期限切れの船は予定画面に「予定不可」と表示される',
          '予定の変更履歴（だれが・いつ）が残る',
        ],
        constraints: ['いまのログイン方法は変えない'],
        approvals: ['作業船の運航・海の上の作業にかかわる変更'],
        freq: 'd',
        minutes: 10,
        dataReady: 3,
        spread: 5,
        d0: 2,
        apNote: '予定の表示と二重予約の防止だけで、船を出すかの判断は道具に含めないため',
      },
      {
        title: 'KY記録の書きもれ確認',
        dept: 'anzen',
        toolRef: 'anzen|1',
        kind: '新しい道具がほしい',
        applicant: '伊藤 誠',
        decides: 'y',
        data: ['personal'],
        parties: '協力会社も使う',
        status: 'wait',
        problem: 'KY活動記録の空欄や記入もれが、支店の安全パトロールのときに見つかる',
        purpose: '提出前に書きもれに気づけるようにする（危険の見積もりは人が行う）',
        users: ['現場の担当者', '協力会社', '現場所長'],
        people: 120,
        places: ['陸の現場（屋外）', '海の上（作業船・台船）'],
        scope: '必須欄の空欄チェック\n作業内容と危険のポイントの未記入の知らせ',
        outScope: '危険度の自動判定\n作業してよいかの判断',
        criteria: [
          '必須欄が空のまま提出すると、空欄の項目名が表示される',
          '記入内容の良し悪しは判定しない（空欄のみを知らせる）',
          '協力会社は自社の記録だけが見られる',
        ],
        constraints: ['個人情報は必要な人だけが見られるようにする'],
        approvals: ['安全・品質の判定にかかわる変更', '協力会社・発注者に見せる範囲の変更'],
        freq: 'd',
        minutes: 5,
        dataReady: 3,
        spread: 5,
        d0: 4,
      },
      {
        title: '請求書の仕訳候補',
        dept: 'keiri',
        toolRef: 'keiri|2',
        kind: '新しい道具がほしい',
        applicant: '渡辺 美咲',
        decides: 'y',
        data: ['money'],
        status: 'review',
        problem: '協力会社からの請求書を手で入力しており、月末に作業が集中する',
        purpose: '請求書の読み取りと仕訳の候補づくりで入力時間を減らす（確定は経理担当）',
        users: ['本社の本部の担当者', '支店・営業所の担当者'],
        people: 8,
        places: ['事務所'],
        scope: '請求書PDFの読み取り\n工事番号・勘定科目の候補表示',
        outScope: '支払いの承認\n会計システムへの自動登録',
        criteria: ['読み取った金額と請求書の金額が一致しない場合は警告を出す', '候補は経理担当が「確定」を押すまで登録されない'],
        constraints: ['本物のデータを練習用の場所に持ち込まない'],
        approvals: ['新しい外部サービスとの接続'],
        freq: 'm',
        minutes: 600,
        dataReady: 3,
        spread: 3,
        d0: 6,
      },
      {
        title: '残業上限の早めのお知らせ',
        dept: 'jinji',
        toolRef: 'jinji|0',
        kind: '新しい道具がほしい',
        applicant: '中村 由紀',
        decides: 'g',
        data: ['personal'],
        status: 'done',
        signalFinal: 'y',
        problem: '時間外労働の上限に近づいていることに、月末まで気づけない',
        purpose: '本人と上司が早めに気づき、働き方を調整できるようにする',
        users: ['現場所長', '本社の本部の担当者', '支店・営業所の担当者'],
        people: 300,
        places: ['事務所', '陸の現場（屋外）', '海の上（作業船・台船）'],
        scope: '月の途中での残業時間の見える化\n上限の8割を超えたら本人と上司へ知らせる',
        outScope: '評価や処分への利用',
        criteria: [
          '上限の8割を超えた日の翌朝までに本人と上司へ通知される',
          '本人と上司以外は個人の残業時間を見られない',
          '通知の記録が残る',
        ],
        constraints: ['個人情報は必要な人だけが見られるようにする'],
        approvals: ['ログインや権限の変更'],
        freq: 'w',
        minutes: 10,
        dataReady: 5,
        spread: 5,
        d0: -10,
      },
      {
        title: '入札・発注情報のお知らせ',
        dept: 'eigyo',
        toolRef: 'eigyo|0',
        kind: '新しい道具がほしい',
        applicant: '小林 大輔',
        decides: 'g',
        status: 'received',
        problem: '国や港湾管理者などのサイトを毎日見て回っている',
        purpose: '浚渫・港湾・空港など、自社に合いそうな案件だけを毎朝まとめて知らせる',
        users: ['本社の本部の担当者', '支店・営業所の担当者'],
        people: 15,
        places: ['事務所'],
        scope: '公告情報の収集\n工種（浚渫・港湾・空港・護岸など）と地域での絞り込み\n毎朝のお知らせ',
        outScope: '入札に参加するかの判断',
        criteria: ['登録した工種・地域に合う公告が、翌営業日の朝9時までに一覧で届く', '元の公告ページへのリンクが付いている'],
        constraints: ['いまのログイン方法は変えない'],
        approvals: ['新しい外部サービスとの接続'],
        freq: 'd',
        minutes: 30,
        dataReady: 5,
        spread: 3,
        d0: 12,
      },
      {
        title: '見積金額を自動で決めたい',
        dept: 'sekkei',
        toolRef: '',
        kind: '相談・アイデア',
        applicant: '加藤 修',
        decides: 'r',
        data: ['money'],
        status: 'back',
        problem: '作業船を使う工事の見積の作成に時間がかかる',
        purpose: '見積金額をAIで自動的に決めたい',
        users: ['本社の本部の担当者'],
        people: 10,
        places: ['事務所'],
        scope: '見積金額の自動決定',
        outScope: '',
        criteria: ['いい感じの金額が出る'],
        constraints: [],
        approvals: [],
        freq: 'w',
        minutes: 240,
        dataReady: 3,
        spread: 1,
        d0: 8,
        backNote:
          '金額の決定は赤信号（AIに決めさせない）です。「過去工事との見積比べ（黄）」や「社内単価・作業船の費用データの検索（青）」に範囲を変え、合格の条件を数字で書き直して再提出してください。',
      },
      {
        title: '協力会社書類の回収状況',
        dept: 'kobai',
        toolRef: 'kobai|1',
        kind: '新しい道具がほしい',
        applicant: '吉田 恵',
        decides: 'g',
        parties: '協力会社も使う',
        data: ['personal'],
        status: 'verify',
        signalFinal: 'y',
        problem: '安全書類が出たかどうかを、電話とメールで確認している',
        purpose: '書類の提出状況を一覧で見られるようにする',
        users: ['現場事務', '協力会社', '現場所長'],
        people: 80,
        places: ['事務所', '陸の現場（屋外）'],
        scope: '書類ごとの提出状況の一覧\n未提出の協力会社への連絡文の下書き',
        outScope: '書類内容の審査',
        criteria: [
          '協力会社は自社の書類と提出状況だけが見られる',
          '未提出の書類が現場ごとに件数で表示される',
          '提出日時が自動で記録される',
        ],
        constraints: ['個人情報は必要な人だけが見られるようにする'],
        approvals: ['協力会社・発注者に見せる範囲の変更'],
        freq: 'w',
        minutes: 60,
        dataReady: 3,
        spread: 5,
        d0: 3,
      },
      {
        title: '天気・波・潮の予報を現場で見たい',
        dept: 'kaijo',
        toolRef: 'kaijo|2',
        kind: '新しい道具がほしい',
        applicant: '森 拓也',
        decides: 'y',
        status: 'approved',
        signalFinal: 'y',
        problem: '朝ごとに複数の予報サイトを見比べ、作業できそうな時間を手で書き出している',
        purpose: 'みんなが同じ予報を見て、作業の段取りを早く話し合えるようにする（作業するかは人が決める）',
        users: ['現場所長', '現場の担当者', '作業船の船長・船員', '潜水士'],
        people: 50,
        places: ['事務所', '海の上（作業船・台船）'],
        scope: '波の高さ・風・潮の予報の表示\n現場で決めた基準を超える時間帯の色分け\n予報を取った日時の表示',
        outScope: '作業してよいか・船を出してよいかの判定\n作業中止の指示',
        criteria: [
          '予報を取った日時が画面の上に表示される',
          '現場で決めた波の高さの基準を超える時間帯は赤で表示される',
          '「作業できる／できない」という判定の文字は表示しない',
          '電波が切れても、最後に取った予報は見られる',
        ],
        constraints: [
          '天気・波の予報は「目安」として見せ、作業するかどうかは表示しない',
          '電波がなくても入力が消えないようにする',
        ],
        approvals: ['作業船の運航・海の上の作業にかかわる変更', '新しい外部サービスとの接続'],
        freq: 'd',
        minutes: 20,
        dataReady: 5,
        spread: 5,
        d0: 5,
      },
      {
        title: 'PC・アカウントの台帳',
        dept: 'dx',
        toolRef: 'dx|0',
        kind: '新しい道具がほしい',
        applicant: '佐藤 花子',
        decides: 'g',
        data: ['personal'],
        status: 'done',
        signalFinal: 'y',
        wave: '第1弾',
        problem: '入社・退社・異動のたびに、PCとアカウントの台帳をExcelで手直ししており、退職者のアカウントが残ることがある',
        purpose: '人事の異動情報と連動して、PCとアカウントの状態を1か所で確かめられるようにする',
        users: ['本社の本部の担当者'],
        people: 7,
        places: ['事務所'],
        scope: 'PC・アカウントの一覧\n入社・退社・異動の予定との突き合わせ\n退職日を過ぎたアカウントの知らせ',
        outScope: 'アカウントの自動削除（削除は人が行う）',
        criteria: [
          '退職日を過ぎても有効なアカウントが、翌朝9時までに一覧に表示される',
          '台帳を見られるのはDX推進部の担当者だけ',
          '変更の記録（だれが・いつ）が残る',
        ],
        constraints: ['いまのログイン方法は変えない', '個人情報は必要な人だけが見られるようにする'],
        approvals: ['ログインや権限の変更'],
        freq: 'w',
        minutes: 120,
        dataReady: 3,
        spread: 3,
        d0: -20,
      },
      {
        title: '規程・マニュアルの検索',
        dept: 'somu',
        toolRef: 'somu|0',
        kind: '新しい道具がほしい',
        applicant: '石井 早苗',
        decides: 'g',
        status: 'done',
        signalFinal: 'g',
        wave: '第1弾',
        problem: '「この場合どうする？」を確かめるのに、規程集のPDFを1つずつ開いて探している',
        purpose: '社内規程・マニュアルから、必要な所をすぐに探せるようにする（読み方の判断は人）',
        users: ['現場所長', '現場事務', '本社の本部の担当者', '支店・営業所の担当者'],
        people: 250,
        places: ['事務所', '移動中・車内'],
        scope: '規程・マニュアルの全文検索\n最新版だけを検索の対象にする\n該当ページへのリンク',
        outScope: '規程の解釈・判断の自動回答',
        criteria: [
          '廃止された版の規程は検索結果に出ない',
          '検索結果から該当ページを1回の操作で開ける',
          '検索語の記録に個人名を残さない',
        ],
        constraints: ['いまのログイン方法は変えない'],
        approvals: ['新しい外部サービスとの接続'],
        freq: 'w',
        minutes: 15,
        dataReady: 5,
        spread: 5,
        d0: -16,
      },
    ];
    const orderOf = (s) =>
      ['received', 'review', 'wait', 'approved', 'dev', 'verify']
        .concat(isFieldTool(s) ? ['field'] : [])
        .concat(['release_wait', 'done']);
    const items = S.map((s, i) => {
      const r = Object.assign(blank('requester'), s);
      r.id = 'REQ-2026-' + pad(i + 1, 4);
      r.createdAt = at(s.d0, 1);
      r.history = [H(s.d0, s.applicant, '依頼者', '受付', '依頼を登録しました', 1)];
      const order = orderOf(s);
      const upto = s.status === 'back' ? 2 : s.status === 'hold' ? 1 : order.indexOf(s.status);
      for (let k = 1; k <= upto && k < order.length; k++) {
        const st = order[k],
          who = ['approved', 'done'].includes(st) ? ROLES[2] : ROLES[1];
        if (st === 'done')
          r.history.push(
            H(
              s.d0 + k - 1,
              ROLES[2].name,
              ROLES[2].l,
              '公開を承認（リリース判定）',
              'リリース判定のチェックをすべて確認／公開範囲：' + (s.wave || '第1弾'),
              4,
            ),
          );
        const fc = r.signalFinal || judge(r).c,
          jc = judge(r).c;
        r.history.push(
          H(
            s.d0 + k,
            who.name,
            who.l,
            '状態を「' + statusOf(st).l + '」に変更',
            st === 'approved'
              ? '信号の色を「' +
                  COLORS[fc].l +
                  '」に決定' +
                  (fc !== jc ? '（候補は「' + COLORS[jc].l + '」）' : '') +
                  (s.apNote ? '／' + s.apNote : '')
              : '',
            2,
          ),
        );
      }
      if (s.status === 'back') {
        r.history.push(H(s.d0 + 3, ROLES[2].name, ROLES[2].l, '状態を「差戻し」に変更', s.backNote, 3));
        r.comments = [{ at: at(s.d0 + 3, 3), by: ROLES[2].name, text: s.backNote }];
      }
      if (s.status === 'field')
        r.comments = [
          {
            at: at(s.d0 + 7, 4),
            by: '山田 太郎',
            text: '港の現場の台船の上で試用中。手袋のままでも押しやすく、圏外でも写真が残りました。',
          },
        ];
      r.updatedAt = r.history[r.history.length - 1].at;
      delete r.d0;
      delete r.backNote;
      delete r.apNote;
      delete r.wave;
      return r;
    });
    return { seq: items.length, items, ops: seedOps(items) };
  }
  /* ===== 運用・DevOps・SecOps（リリース後の管理） ===== */
  const SEV = {
    S1: {
      l: 'S1 重大',
      ack: 15,
      fix: 240,
      fixL: '4時間以内',
      ackL: '15分以内',
      ex: '本番停止・情報漏えいの疑い・重大な脆弱性・監査ログの異常',
    },
    S2: {
      l: 'S2 高',
      ack: 30,
      fix: 24 * 60,
      fixL: '1営業日以内',
      ackL: '30分以内',
      ex: '主要機能の停止・承認や公開の停止・セキュリティ高',
    },
    S3: {
      l: 'S3 中',
      ack: 120,
      fix: 72 * 60,
      fixL: '3営業日以内',
      ackL: '2時間以内',
      ex: '一部の不具合・性能の低下・CIやジョブの停止',
    },
    S4: { l: 'S4 低', ack: 24 * 60, fix: 0, fixL: '次回リリース', ackL: '1営業日以内', ex: '表示の乱れ・軽い不具合・改善の要望' },
  };
  const VSEV = {
    crit: { l: '重大', days: 7 },
    high: { l: '高', days: 30 },
    mid: { l: '中', days: 90, an: 1 },
    low: { l: '低', days: 180, an: 1 },
  };
  const LIMITS = { same: 3, total: 6, hours: 2, cost: 5000 };
  const LINE = [
    '',
    'Issue化',
    '仕様案の整理',
    '実装計画',
    '実装',
    '独立検証（CI）',
    '修正ループ',
    'AIレビュー',
    'PR作成',
    '人の確認・マージ',
    'ステージング・現場試用',
    '公開承認・デプロイ',
    '運用・フィードバック',
  ];
  const CHECKS = [
    ['build', 'ビルド'],
    ['type', '型'],
    ['unit', '単体'],
    ['int', '結合'],
    ['e2e', 'E2E'],
    ['sast', 'SAST'],
    ['dep', '依存関係'],
    ['secret', 'シークレット'],
    ['offline', '圏外'],
  ];
  const PRITEMS = [
    '要望との対応',
    '変更範囲',
    '受入条件の検証',
    '自動検査の結果',
    '業務確認（プレビュー）',
    'モデル現場での結果',
    '記録の原本の保護',
    '運用への影響',
    '復旧方法',
    '残存リスク',
  ];
  const RELCHECK = [
    { t: '受入条件の検証がすべて「○」（充足率100%）で、重大な不具合が0件', gc: 'GC-43', hard: 1 },
    { t: '権限テスト（ほかの現場・他社・権限のない人には見えない）が全件合格', gc: 'GC-44', hard: 1 },
    { t: 'PRの判断材料10項目がそろい、マージを承認済み', gc: 'FR-36・FR-39' },
    { t: 'ステージングで確認済み（現場向けの道具はモデル現場の試用結果も記録）', gc: 'FR-40・FR-42' },
    { t: '戻し方（ロールバック手順）と、戻すときの担当が決まっている', gc: 'GC-52' },
    { t: '監視とアラート（エラー率・応答時間）の設定がある', gc: 'IF-10' },
    { t: '利用者への案内と問い合わせ窓口がある', gc: 'GC-51' },
    { t: '公開の範囲（対象の部署・支店）を決めた', gc: 'GC-52' },
  ];
  function nhash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  function auditHash(prev, e) {
    return nhash(prev + '|' + e.at + '|' + e.by + '|' + e.role + '|' + e.action + '|' + e.target + '|' + (e.detail || ''));
  }
  function chainAudit(list) {
    let prev = '00000000';
    list.forEach((e, i) => {
      e.no = i + 1;
      e.prev = prev;
      e.hash = auditHash(prev, e);
      prev = e.hash;
    });
    return list;
  }
  function verifyAudit(list) {
    let prev = '00000000';
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.prev !== prev || auditHash(prev, e) !== e.hash) return { ok: false, at: i };
      prev = e.hash;
    }
    return { ok: true };
  }
  function dueOf(v) {
    const d = VSEV[v.sev];
    return new Date(new Date(v.found).getTime() + d.days * 86400000).toISOString();
  }
  function daysLeft(iso, now) {
    return Math.floor((new Date(iso).getTime() - (now || Date.now())) / 86400000);
  }
  function routineNext(r) {
    const add = { d: 1, m: 30, q: 91, y: 365 }[r.freq] || 30;
    return new Date(new Date(r.last).getTime() + add * 86400000).toISOString();
  }
  function bumpVer(v, kind) {
    const p = String(v || '0.0.0')
      .split('.')
      .map((x) => +x || 0);
    if (kind === 'major') {
      p[0]++;
      p[1] = 0;
      p[2] = 0;
    } else if (kind === 'patch') {
      p[2]++;
    } else {
      p[1]++;
      p[2] = 0;
    }
    return p.join('.');
  }
  const ROLE_SIG = {
    requester: '依頼者',
    desk: '受付担当',
    approver: '承認者',
    ops: '運用担当',
    sec: 'セキュリティ担当',
    admin: '工場の管理責任者',
    auditor: '内部監査',
  };

  function seedOps(items) {
    const base = new Date('2026-10-01T09:00:00+09:00').getTime();
    const T = (day, h, m) => new Date(base + day * 86400000 + ((h || 0) - 9) * 3600000 + (m || 0) * 60000).toISOString();
    const apps = [
      {
        id: 'APP-001',
        req: 'REQ-2026-0005',
        name: '残業上限の早めのお知らせ',
        dept: 'jinji',
        ver: '1.1.0',
        wave: '第1弾',
        since: T(-2, 10),
        owner: '中村 由紀（人事・労務）',
        opsOwner: '井上 翔太',
        users: 300,
        mau: 212,
        slo: 99.5,
        avail: 99.92,
        err: 0.1,
        p95: 1.2,
        budget: 18000,
        spent: 9400,
        field: true,
      },
      {
        id: 'APP-002',
        req: 'REQ-2026-0010',
        name: 'PC・アカウントの台帳',
        dept: 'dx',
        ver: '1.0.2',
        wave: '第1弾',
        since: T(-13, 10),
        owner: '佐藤 花子（DX推進部）',
        opsOwner: '井上 翔太',
        users: 7,
        mau: 7,
        slo: 99.5,
        avail: 99.81,
        err: 0.2,
        p95: 0.9,
        budget: 6000,
        spent: 2100,
      },
      {
        id: 'APP-003',
        req: 'REQ-2026-0011',
        name: '規程・マニュアルの検索',
        dept: 'somu',
        ver: '1.0.0',
        wave: '第1弾',
        since: T(-9, 10),
        owner: '石井 早苗（総務・法務）',
        opsOwner: '井上 翔太',
        users: 250,
        mau: 168,
        slo: 99.5,
        avail: 99.31,
        err: 0.9,
        p95: 1.9,
        budget: 15000,
        spent: 12600,
      },
    ];
    const DJ = 'デプロイジョブ';
    const deploys = [
      {
        id: 'DEP-0001',
        app: 'APP-002',
        req: 'REQ-2026-0010',
        ver: '1.0.0',
        env: 'prod',
        at: T(-13, 18),
        type: '通常',
        pr: 64,
        result: '成功',
        mergeBy: '鈴木 一郎',
        releaseBy: '鈴木 一郎',
        by: DJ,
        note: '第1弾の公開',
      },
      {
        id: 'DEP-0002',
        app: 'APP-003',
        req: 'REQ-2026-0011',
        ver: '1.0.0',
        env: 'prod',
        at: T(-9, 18),
        type: '通常',
        pr: 71,
        result: '成功',
        mergeBy: '鈴木 一郎',
        releaseBy: '鈴木 一郎',
        by: DJ,
        note: '第1弾の公開',
      },
      {
        id: 'DEP-0003',
        app: 'APP-001',
        req: 'REQ-2026-0005',
        ver: '1.0.0',
        env: 'prod',
        at: T(-2, 18),
        type: '通常',
        pr: 88,
        result: '成功',
        mergeBy: '鈴木 一郎',
        releaseBy: '鈴木 一郎',
        by: DJ,
        note: '第1弾の公開',
      },
      {
        id: 'DEP-0004',
        app: 'APP-002',
        req: 'REQ-2026-0010',
        ver: '1.0.1',
        env: 'prod',
        at: T(1, 18),
        type: '通常',
        pr: 92,
        result: '成功',
        mergeBy: '鈴木 一郎',
        releaseBy: '鈴木 一郎',
        by: DJ,
        note: '退職日の判定を修正',
      },
      {
        id: 'DEP-0005',
        app: 'APP-001',
        req: 'REQ-2026-0005',
        ver: '1.1.0',
        env: 'staging',
        at: T(10, 15),
        type: '通常',
        pr: 104,
        result: '成功',
        mergeBy: '鈴木 一郎',
        releaseBy: '',
        by: DJ,
        note: '異動情報の取り込みを毎日に',
      },
      {
        id: 'DEP-0006',
        app: 'APP-001',
        req: 'REQ-2026-0005',
        ver: '1.1.0',
        env: 'prod',
        at: T(11, 18),
        type: '通常',
        pr: 104,
        result: '成功',
        mergeBy: '鈴木 一郎',
        releaseBy: '鈴木 一郎',
        by: DJ,
        note: 'INC-2026-001 の再発防止',
      },
      {
        id: 'DEP-0007',
        app: '',
        req: 'REQ-2026-0001',
        ver: '0.9.0',
        env: 'staging',
        at: T(14, 15),
        type: '通常',
        pr: 121,
        result: '成功',
        mergeBy: '鈴木 一郎',
        releaseBy: '',
        by: DJ,
        note: 'モデル現場（港の台船）での試用版',
      },
      {
        id: 'DEP-0008',
        app: 'APP-002',
        req: 'REQ-2026-0010',
        ver: '1.0.2',
        env: 'prod',
        at: T(15, 18),
        type: '標準',
        pr: 97,
        result: '成功',
        mergeBy: '鈴木 一郎',
        releaseBy: '鈴木 一郎',
        by: DJ,
        note: '表示の文言を修正（承認済み手順）',
      },
      {
        id: 'DEP-0009',
        app: 'APP-003',
        req: 'REQ-2026-0011',
        ver: '1.1.0',
        env: 'staging',
        at: T(17, 15),
        type: '通常',
        pr: 110,
        result: '成功',
        mergeBy: '鈴木 一郎',
        releaseBy: '',
        by: DJ,
        note: '検索の絞り込み条件を追加',
      },
      {
        id: 'DEP-0010',
        app: 'APP-003',
        req: 'REQ-2026-0011',
        ver: '1.1.0',
        env: 'prod',
        at: T(18, 18),
        type: '通常',
        pr: 110,
        result: '成功',
        mergeBy: '鈴木 一郎',
        releaseBy: '鈴木 一郎',
        by: DJ,
        note: '検索の絞り込み条件を追加',
        incident: 'INC-2026-002',
      },
      {
        id: 'DEP-0011',
        app: 'APP-003',
        req: 'REQ-2026-0011',
        ver: '1.0.0',
        env: 'prod',
        at: T(19, 10, 20),
        type: '緊急',
        pr: 110,
        result: 'ロールバック',
        mergeBy: '',
        releaseBy: '井上 翔太',
        by: DJ,
        note: 'INC-2026-002 のため直前の承認済み版へ戻した',
        incident: 'INC-2026-002',
      },
    ];
    const incidents = [
      {
        id: 'INC-2026-001',
        app: 'APP-001',
        cat: 'アプリ',
        sev: 'S3',
        title: '一部の人に通知が届かない（所属の変更が反映されていない）',
        opened: T(7, 10, 10),
        ack: T(7, 10, 40),
        restored: T(8, 15),
        closed: T(9, 11),
        status: '完了',
        owner: '井上 翔太',
        cause: '人事の異動情報の取り込みが週1回だったため、異動した人の上司が古いままだった',
        prevention: '取り込みを毎日に変更（DEP-0006 v1.1.0 で対応済み）',
        log: [
          { at: T(7, 10, 10), by: '井上 翔太', t: '起票（利用者からの問い合わせ）' },
          { at: T(7, 10, 40), by: '井上 翔太', t: '初動：影響範囲は異動者12名と特定' },
          { at: T(8, 15), by: '井上 翔太', t: '復旧：手動で取り込みを実行し、通知を再送' },
          { at: T(9, 11), by: '井上 翔太', t: '再発防止を決めて完了' },
        ],
      },
      {
        id: 'INC-2026-002',
        app: 'APP-003',
        cat: 'アプリ',
        sev: 'S2',
        title: '検索結果に、廃止された版の規程が表示される',
        opened: T(19, 9, 40),
        ack: T(19, 9, 52),
        restored: T(19, 10, 20),
        closed: '',
        status: '再発防止中',
        owner: '井上 翔太',
        cause:
          'v1.1.0 で版の絞り込み条件が外れていた（受入条件「廃止された版は出ない」のテストが、追加した検索経路を通っていなかった）',
        prevention: '',
        log: [
          { at: T(19, 9, 40), by: '井上 翔太', t: '起票（総務からの連絡）' },
          { at: T(19, 9, 52), by: '井上 翔太', t: '初動：v1.1.0 が原因と判断。ロールバックを決定（緊急変更 CHG-2026-004）' },
          { at: T(19, 10, 20), by: '井上 翔太', t: '復旧：v1.0.0 に戻し、廃止版が出ないことを確認' },
        ],
      },
      {
        id: 'INC-2026-003',
        app: '',
        req: 'REQ-2026-0002',
        cat: '開発ライン',
        sev: 'S3',
        title: 'CIが同じ原因で3回失敗し、自動で停止した（作業船の予定）',
        opened: T(20, 16, 30),
        ack: T(20, 16, 45),
        restored: '',
        closed: '',
        status: '対応中',
        owner: '佐藤 花子',
        cause: '',
        prevention: '',
        log: [
          { at: T(20, 16, 30), by: 'ワークフロー制御', t: '自動起票：同じ原因の修正が上限（3回）に達し停止（L2）' },
          { at: T(20, 16, 45), by: '佐藤 花子', t: '初動：単体テストの失敗内容を確認中' },
        ],
      },
    ];
    const feedback = [
      {
        id: 'FB-001',
        app: 'APP-001',
        at: T(13, 12),
        from: '現場所長（支店工事部）',
        text: '通知のメールが夜8時ごろに届くので、朝に届くとうれしい',
        status: '未対応',
      },
      {
        id: 'FB-002',
        app: 'APP-003',
        at: T(20, 14),
        from: '現場事務（支店）',
        text: '検索語が長いと結果が0件になることがある',
        status: '未対応',
      },
      {
        id: 'FB-003',
        app: 'APP-001',
        at: T(6, 9),
        from: '人事・労務',
        text: '異動した人の上司に通知が行かない',
        status: '対応済み',
        ref: 'INC-2026-001',
      },
    ];
    const routines = [
      { id: 'RT-01', freq: 'd', title: 'バックアップの結果を確かめる', who: 'ops', last: T(21, 6, 10), result: '成功' },
      {
        id: 'RT-02',
        freq: 'm',
        title: 'リストア検証（バックアップから1件戻せるかの小さな確認）',
        who: 'ops',
        last: T(0, 10),
        result: '成功',
      },
      {
        id: 'RT-03',
        freq: 'q',
        title: '復旧訓練（RTO 4時間・RPO 1時間（案）を測る）',
        who: 'ops',
        last: T(-77, 10),
        result: '成功（RTO 2時間40分）',
      },
      {
        id: 'RT-04',
        freq: 'q',
        title: '権限の棚卸し（Entra ID のグループと役割）',
        who: 'sec',
        last: T(-82, 10),
        result: '指摘2件・対応済み',
      },
      { id: 'RT-05', freq: 'm', title: '品質ゲート（保護ルール）の点検', who: 'sec', last: T(0, 11), result: '異常なし' },
      { id: 'RT-06', freq: 'm', title: '指標の集計と報告（8つの指標・費用）', who: 'desk', last: T(0, 15), result: '報告済み' },
      { id: 'RT-07', freq: 'm', title: '監査ログの検証（改ざんがないか）', who: 'auditor', last: T(0, 16), result: '異常なし' },
      {
        id: 'RT-08',
        freq: 'y',
        title: '採用製品の最新情報・信号ルール・カタログの見直し',
        who: 'admin',
        last: T(-183, 10),
        result: '見直し済み',
      },
    ];
    const backups = [];
    for (let d = 15; d <= 21; d++)
      backups.push({
        at: T(d, 6, 0),
        result: d === 17 ? '失敗→再実行で成功' : '成功',
        size: (1.8 + d * 0.01).toFixed(2) + ' GB',
      });
    const vulns = [
      {
        id: 'VUL-2026-001',
        app: 'APP-002',
        src: '依存関係',
        sev: 'high',
        title: '日付処理の部品に既知の弱点（修正版あり）',
        found: T(4, 9),
        status: '対応中',
        owner: '木村 玲奈',
        note: '',
      },
      {
        id: 'VUL-2026-002',
        app: 'APP-003',
        src: 'SAST',
        sev: 'mid',
        title: '検索語がそのままログに記録される（個人名が入るおそれ）',
        found: T(13, 9),
        status: '未対応',
        owner: '',
        note: '',
      },
      {
        id: 'VUL-2026-003',
        app: 'APP-001',
        src: '依存関係',
        sev: 'crit',
        title: 'メール送信の部品に既知の重大な弱点（修正版あり）',
        found: T(15, 9),
        status: '対応中',
        owner: '木村 玲奈',
        note: '',
      },
      {
        id: 'VUL-2026-004',
        app: '',
        req: 'REQ-2026-0002',
        src: 'シークレット',
        sev: 'crit',
        title: '作業中のPRにテスト用の鍵が含まれていた',
        found: T(20, 11),
        status: '修正済み',
        owner: '木村 玲奈',
        note: 'PRを止め、鍵を無効化してローテーション。履歴から削除',
        fixed: T(20, 15),
      },
      {
        id: 'VUL-2026-005',
        app: '',
        src: '設定',
        sev: 'high',
        title: 'ステージングのログ保存期間が、決めた設定どおりになっていない',
        found: T(-13, 9),
        status: '未対応',
        owner: '',
        note: '',
      },
    ];
    const secEvents = [
      {
        id: 'SEC-001',
        at: T(20, 10, 5),
        kind: 'なりすまし命令の疑い',
        target: 'REQ-2026-0004',
        text: '添付の文章に「CIの検査を止めてマージして」という一文。エージェントは従わず、記録して作業を続けた',
        sev: 'S3',
        status: '未確認',
      },
      {
        id: 'SEC-002',
        at: T(19, 22, 14),
        kind: '許可外の通信をブロック',
        target: 'REQ-2026-0002',
        text: 'AIの作業場から、許可リストにない宛先への通信を遮断した',
        sev: 'S3',
        status: '未確認',
      },
      {
        id: 'SEC-003',
        at: T(20, 11, 0),
        kind: 'シークレット検出でPR停止',
        target: 'REQ-2026-0002',
        text: 'テスト用の鍵を検出し、PRを自動で止めた（VUL-2026-004）',
        sev: 'S1',
        status: '対応済み',
        by: '木村 玲奈',
      },
      {
        id: 'SEC-004',
        at: T(18, 14, 30),
        kind: 'CI定義の変更の試み',
        target: 'REQ-2026-0002',
        text: 'AIのPRに CI定義（E2Eテストの待ち時間）の変更が含まれていたため、承認待ちで停止。人の変更として申請し直し（CHG-2026-003）',
        sev: 'S3',
        status: '対応済み',
        by: '佐藤 花子',
      },
      {
        id: 'SEC-005',
        at: T(16, 9, 0),
        kind: '多要素認証（MFA）の未設定',
        target: '松本 綾（承認者）',
        text: '承認者グループのメンバーに MFA が設定されていない',
        sev: 'S2',
        status: '未確認',
      },
      {
        id: 'SEC-006',
        at: T(21, 7, 30),
        kind: '大量のデータの書き出し',
        target: '佐藤 花子',
        text: 'JSON の全件書き出し（11件）。定例のバックアップ作業と確認',
        sev: 'S4',
        status: '対応済み',
        by: '木村 玲奈',
      },
    ];
    const groups = [
      { g: 'SG-MSF-Requesters', role: '依頼者', n: '全社員（動的グループ）' },
      { g: 'SG-MSF-Desk', role: '受付担当', n: 3 },
      { g: 'SG-MSF-Approvers', role: '承認者（業務責任者）', n: 21 },
      { g: 'SG-MSF-Engineers', role: '技術者（黄・赤の確認）', n: 8 },
      { g: 'SG-MSF-Ops', role: '運用担当', n: 2 },
      { g: 'SG-MSF-Sec', role: 'セキュリティ担当', n: 2 },
      { g: 'SG-MSF-Admins', role: '工場の管理責任者', n: 1 },
      { g: 'SG-MSF-Auditors', role: '内部監査', n: 2 },
    ];
    const findings = [
      {
        id: 'AR-01',
        kind: '退職者が残っている',
        who: '前田 浩',
        group: 'SG-MSF-Approvers',
        text: '2026-09-30 に退職。承認者グループに残っている',
        status: '未対応',
      },
      {
        id: 'AR-02',
        kind: 'MFA 未設定',
        who: '松本 綾',
        group: 'SG-MSF-Approvers',
        text: '承認者は多要素認証が必須（NFR-38）',
        status: '未対応',
      },
      {
        id: 'AR-03',
        kind: '職務分離の衝突',
        who: '佐藤 花子',
        group: 'SG-MSF-Desk ＋ SG-MSF-Approvers',
        text: '受付担当と承認者の両方に入っている。自分で整えた注文書を自分で承認できてしまう',
        status: '未対応',
      },
      {
        id: 'AR-04',
        kind: '長くサインインしていない',
        who: '2名',
        group: 'SG-MSF-Engineers',
        text: '90日以上サインインがない',
        status: '対応済み',
        by: '木村 玲奈',
        note: '1名は休職中のため例外、1名はグループから外した',
      },
    ];
    const controls = [
      { id: 'CTL-01', t: 'main への直接の書き込み禁止（ブランチ保護）', ok: 1 },
      { id: 'CTL-02', t: '必須チェック（ビルド・型・単体・結合・E2E・SAST・依存関係・シークレット）が未実行なら不合格', ok: 1 },
      { id: 'CTL-03', t: 'CI定義の変更は、管理責任者と承認者の承認が必要（実装AIは書き込めない）', ok: 1 },
      { id: 'CTL-04', t: '受入テストは別の管理境界。削除・弱体化を検知する', ok: 1 },
      { id: 'CTL-05', t: 'セキュリティ検査のスキップ・無効化の禁止', ok: 1 },
      { id: 'CTL-06', t: '保護ルールが承認記録なしに変わったら警告する', ok: 1 },
      {
        id: 'CTL-07',
        t: '現場向けの道具のリポジトリで、必須チェックに「圏外テスト」が入っている',
        ok: 0,
        note: '工事写真の圏外保存（REQ-2026-0001）のリポジトリで未設定',
      },
    ];
    controls.forEach((c) => {
      c.checked = T(0, 11);
      c.by = '木村 玲奈';
    });
    const changes = [
      {
        id: 'CHG-2026-001',
        type: '標準',
        area: '開発標準・ひな形',
        title: '注文書のひな形に schema_version と合格の条件の番号（AC-1…）を追加',
        by: '佐藤 花子',
        at: T(2, 10),
        need: ['desk'],
        appr: [{ role: 'desk', by: '佐藤 花子', at: T(2, 11) }],
        status: '適用済み',
      },
      {
        id: 'CHG-2026-002',
        type: '通常',
        area: 'CI・品質ゲート',
        title: '依存関係の検査を「高」以上で不合格にする（いまは「重大」のみ）',
        by: '木村 玲奈',
        at: T(16, 10),
        need: ['admin', 'approver'],
        appr: [{ role: 'admin', by: '森本 誠', at: T(17, 9) }],
        status: '承認待ち',
      },
      {
        id: 'CHG-2026-003',
        type: '通常',
        area: 'CI・品質ゲート',
        title: 'E2Eテストの待ち時間を60秒から90秒へ（AIのPRに入っていた変更を、人の変更として申請し直したもの）',
        by: '佐藤 花子',
        at: T(18, 15),
        need: ['admin', 'approver'],
        appr: [],
        status: '承認待ち',
        ref: 'SEC-004',
      },
      {
        id: 'CHG-2026-004',
        type: '緊急',
        area: 'リリース',
        title: '規程・マニュアルの検索 v1.1.0 → v1.0.0 へのロールバック（INC-2026-002）',
        by: '井上 翔太',
        at: T(19, 9, 55),
        need: ['admin', 'approver'],
        appr: [],
        status: '事後承認待ち',
        ref: 'INC-2026-002',
      },
    ];
    const pipes = {
      'REQ-2026-0009': {
        step: 1,
        issue: null,
        pr: null,
        checks: {},
        same: 0,
        total: 0,
        hours: 0,
        cost: 0,
        esc: '',
        fail: 0,
        prItems: [],
        merged: '',
        ai: '',
      },
      'REQ-2026-0002': {
        step: 6,
        issue: 142,
        pr: null,
        checks: { build: 'ok', type: 'ok', unit: 'ng', int: 'ok', e2e: '-', sast: 'ok', dep: 'ok', secret: 'ok' },
        same: 3,
        total: 4,
        hours: 1.6,
        cost: 3900,
        esc: 'L2',
        fail: 9,
        prItems: [],
        merged: '',
        ai: '',
      },
      'REQ-2026-0008': {
        step: 9,
        issue: 128,
        pr: 131,
        checks: { build: 'ok', type: 'ok', unit: 'ok', int: 'ok', e2e: 'ok', sast: 'ok', dep: 'ok', secret: 'ok', offline: 'ok' },
        same: 0,
        total: 1,
        hours: 1.1,
        cost: 2600,
        esc: '',
        fail: 0,
        prItems: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        merged: '',
        ai: '指摘2件（未提出の件数の数え方、協力会社名の並び順）。見落とし得る範囲：他社の書類が見えないことは権限テストでのみ確認',
      },
      'REQ-2026-0001': {
        step: 10,
        issue: 118,
        pr: 121,
        checks: { build: 'ok', type: 'ok', unit: 'ok', int: 'ok', e2e: 'ok', sast: 'ok', dep: 'ok', secret: 'ok', offline: 'ok' },
        same: 0,
        total: 2,
        hours: 1.4,
        cost: 3100,
        esc: '',
        fail: 0,
        prItems: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        merged: '鈴木 一郎',
        ai: '指摘1件（送信済みの印の色だけでの区別）→修正済み',
      },
      'REQ-2026-0005': {
        step: 12,
        issue: 84,
        pr: 104,
        checks: {},
        same: 0,
        total: 1,
        hours: 0.9,
        cost: 1800,
        esc: '',
        fail: 0,
        prItems: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        merged: '鈴木 一郎',
        ai: '',
      },
      'REQ-2026-0010': {
        step: 12,
        issue: 61,
        pr: 97,
        checks: {},
        same: 0,
        total: 0,
        hours: 0.6,
        cost: 1200,
        esc: '',
        fail: 0,
        prItems: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        merged: '鈴木 一郎',
        ai: '',
      },
      'REQ-2026-0011': {
        step: 12,
        issue: 69,
        pr: 110,
        checks: {},
        same: 0,
        total: 2,
        hours: 1.3,
        cost: 2700,
        esc: '',
        fail: 0,
        prItems: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        merged: '鈴木 一郎',
        ai: '',
      },
    };
    /* 監査ログ（追記のみ・ハッシュの鎖） */
    const ev = [];
    const A = (at, by, role, action, target, detail) => ev.push({ at, by, role, action, target, detail: detail || '' });
    (items || []).forEach((r) => (r.history || []).forEach((h) => A(h.at, h.by, h.role, h.action, r.id, h.note)));
    deploys.forEach((d) =>
      A(
        d.at,
        d.by,
        'デプロイジョブ',
        (d.result === 'ロールバック' ? 'ロールバック' : 'デプロイ') + '（' + (d.env === 'prod' ? '本番' : 'ステージング') + '）',
        d.app || d.req,
        'v' + d.ver + '／PR #' + d.pr + '／' + d.result,
      ),
    );
    incidents.forEach((i) => i.log.forEach((l) => A(l.at, l.by, '運用担当', '障害対応：' + l.t, i.id)));
    secEvents.forEach((e) => A(e.at, '監視', 'システム', 'セキュリティ通知：' + e.kind, e.target, e.text));
    changes.forEach((c) => {
      A(c.at, c.by, '', '変更申請（' + c.type + '）', c.id, c.title);
      c.appr.forEach((a) => A(a.at, a.by, ROLE_SIG[a.role], '変更を承認', c.id));
    });
    ev.sort((a, b) => (a.at < b.at ? -1 : 1));
    return {
      apps,
      deploys,
      incidents,
      feedback,
      routines,
      backups,
      vulns,
      secEvents,
      groups,
      findings,
      controls,
      changes,
      pipes,
      audit: chainAudit(ev),
      seq: { app: 3, dep: 11, inc: 3, fb: 3, vul: 5, chg: 4, issue: 150, pr: 135 },
    };
  }

  return {
    COLORS,
    RANK,
    STATUSES,
    NEXT,
    ROLES,
    KINDS,
    USERS,
    PLACES,
    DATA,
    PARTIES,
    DECIDES,
    CONSTRAINTS,
    APPROVALS,
    FREQ,
    READY,
    SPREAD,
    VAGUE,
    nowISO,
    fmt,
    esc,
    lines,
    statusOf,
    deptOf,
    toolOf,
    roleOf,
    judge,
    measure,
    lint,
    markVague,
    canMove,
    canEdit,
    toYAML,
    toCSV,
    download,
    load,
    save,
    storageOK,
    nextId,
    validImport,
    blank,
    seed,
    canMoveR,
    whyNotR,
    roleShort,
    whoCan,
    whyNot,
    NEXTBY,
    TURN,
    turnOf,
    since,
    stayDays,
    STAY_WARN,
    STAY_ALERT,
    REWRITE,
    suggest,
    precheck,
    REASONS,
    nextOf,
    isFieldTool,
    ENDED,
    SEV,
    VSEV,
    LIMITS,
    LINE,
    CHECKS,
    PRITEMS,
    RELCHECK,
    nhash,
    auditHash,
    chainAudit,
    verifyAudit,
    dueOf,
    daysLeft,
    routineNext,
    bumpVer,
    seedOps,
    ROLE_SIG,
  };
})();

(function () {
  const KEY = 'mirai-const-sf-console-v1';
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const E = SF.esc;
  const ico = (id) => '<svg class="ico"><use href="#' + id + '"/></svg>';
  const sig = (c) => (c ? '<span class="sig ' + c + '"><i></i>' + SF.COLORS[c].l + '</span>' : '');
  const st = (k) => '<span class="st ' + k + '">' + E(SF.statusOf(k).l) + '</span>';
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const loaded = SF.load(KEY);
  const S = {
    data: loaded.data,
    persistent: loaded.persistent,
    role: window.__MSF__ ? window.__MSF__.initialRole() : 'requester',
    view: 'home',
    step: 0,
    draft: null,
    draftId: null,
    editId: null,
    dpTab: 'card',
    fq: '',
    fd: '',
    fs: '',
    fc: '',
    open: null,
    dtab: 'sum',
    pickDept: '',
    fresh: null,
    critUndo: {},
    bmine: false,
    submitting: false,
    conflict: null,
    draftLk: null,
  };
  const me = () => SF.roleOf(S.role);
  const find = (id) => S.data.items.find((x) => x.id === id);
  const colorOf = (r) => r.signalFinal || SF.judge(r).c;
  function persist(opts) {
    if (!SF.save(KEY, S.data) && S.persistent) {
      S.persistent = false;
      notice();
    }
    if (!window.__MSF__) return Promise.resolve({ ok: true, ids: {}, notices: [] });
    return window.__MSF__.persist(S.data, opts).then((res) => {
      reportSync(res);
      return res;
    });
  }
  /* 同じ同期の結果は呼び出し元全員に同じものが返るので、知らせるのは 1 回だけにする */
  const reportedSync = new WeakSet();
  function reportSync(res) {
    if (!res || reportedSync.has(res)) return;
    reportedSync.add(res);
    if (!res.ok) toast(res.error || '保存できませんでした', true);
    (res.notices || []).forEach((n) =>
      toast(n.message || n.id + ' はサーバ上で「' + SF.statusOf(n.actual).l + '」になっています', true),
    );
  }
  /* 依頼の本体（新規・内容・状態）の保存が失敗したか。コメントだけの失敗は本体の成功として扱う */
  function coreFailed(res, id) {
    if (!res || res.ok) return false;
    const list = res.failures || [];
    return !list.length || list.some((f) => (f.id === id || f.serverId === id) && f.stage !== 'comment');
  }
  /* その依頼の保存が失敗したか（別の依頼の失敗では成功扱いのまま） */
  function failedFor(res, id) {
    if (!res || res.ok) return false;
    const list = res.failures || [];
    return !list.length || list.some((f) => f.id === id || f.serverId === id);
  }
  /* サーバの結果を画面へ反映する（bridge から呼ばれる）。入力中の内容は描き直さない。 */
  function syncApplied(changed) {
    SF.save(KEY, S.data);
    if (!changed) return;
    if (S.view !== 'new') render();
    if (S.open) {
      const a = document.activeElement;
      const typing = a && $('#drawer').contains(a) && ['TEXTAREA', 'INPUT'].includes(a.tagName) && a.value;
      if (!typing) renderDrawer();
    }
  }
  function notice() {
    $('#notice').innerHTML = window.__MSF__
      ? ico('i-shield') +
        ' 受付の依頼はサーバ（PostgreSQL）に保存されます。運用・DevOps・SecOps の数値とできごとは、操作を確かめるための見本です（「見本」と書いた開発ラインの操作は実行できません）。部署はみらい建設工業の公開情報（会社概要・役員一覧・事業所一覧）をもとにした例で、実際の組織の区切りとは異なる場合があります。人名はすべて架空です。'
      : ico('i-shield') +
        ' 外部と一切通信しない完全オフラインのサンプルです。データはこのブラウザの中だけに' +
        (S.persistent
          ? '保存されます。'
          : '一時的に保持されます（このブラウザでは保存できないため、閉じる前に「データ」からJSONで書き出してください）。') +
        ' 依頼のJSONは受付ステーションと共通です。運用・DevOps・SecOps の数値とできごとは、操作を確かめるための見本です。部署はみらい建設工業の公開情報（会社概要・役員一覧・事業所一覧）をもとにした例で、実際の組織の区切りとは異なる場合があります。人名はすべて架空です。';
  }
  function toast(m, ng, act) {
    const t = document.createElement('div');
    t.className = 'toast' + (ng ? ' ng' : '');
    t.setAttribute('role', 'status');
    t.innerHTML =
      ico(ng ? 'i-alert' : 'i-check') +
      '<span>' +
      E(m) +
      '</span>' +
      (act ? '<button type="button" class="tact">' + ico('i-undo') + E(act.l) + '</button>' : '');
    if (act)
      t.querySelector('.tact').addEventListener('click', () => {
        t.remove();
        act.fn();
      });
    $('#toast').appendChild(t);
    setTimeout(() => t.remove(), act ? 7000 : 3000);
  }
  window.__MSF_UI__ = { toast: toast, data: () => S.data, syncApplied: syncApplied };

  /* ---- 下書き（サーバが正・利用者ごとに複数件。端末をまたいで再開できる） ---- */
  const DKEY = KEY + '-draft'; // 旧: 単一の下書き（読み込み互換のみ）
  const DKEY_LIST = KEY + '-drafts'; // 新: 下書きの一覧
  let draftMem = null,
    draftTimer = null;
  const clearedDrafts = new WeakSet(); // 送信成功などで消した下書き（遅れて届く保存結果を残さない）

  function readDrafts() {
    try {
      const s = localStorage.getItem(DKEY_LIST);
      if (s) {
        const a = JSON.parse(s);
        if (Array.isArray(a)) return a.filter((o) => o && o.draft && typeof o.draft === 'object');
      }
    } catch (e) {}
    return draftMem && Array.isArray(draftMem) ? draftMem : [];
  }
  function writeDraftsList(a) {
    draftMem = a;
    try {
      localStorage.setItem(DKEY_LIST, JSON.stringify(a));
    } catch (e) {}
  }
  /* 下書きの識別子。サーバ保存前の下書きは端末内の鍵で区別する（1 件で上書きしない） */
  const draftKey = (o) => o.id || o.lk || 'local';
  function newLocalKey() {
    return window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2);
  }
  function removeDraftLocal(key) {
    writeDraftsList(readDrafts().filter((o) => draftKey(o) !== key));
  }

  function writeDraft() {
    if (!S.draft) return;
    if (!S.draftLk) S.draftLk = newLocalKey();
    const o = { id: S.draftId || null, lk: S.draftLk, draft: S.draft, editId: S.editId, step: S.step, at: SF.nowISO() };
    const list = readDrafts().filter((x) => draftKey(x) !== draftKey(o) && x.lk !== o.lk);
    list.unshift(o);
    writeDraftsList(list);
    if (window.__MSF__ && window.__MSF__.saveDraft) {
      window.__MSF__
        .saveDraft(o)
        .then((res) => {
          const saved = res && res.draft;
          if (!saved || !saved.id) return;
          if (clearedDrafts.has(o.draft)) {
            removeDraftLocal(saved.id);
            window.__MSF__.clearDraft(saved.id).catch(() => undefined);
            return;
          }
          if (S.draft === o.draft && S.draftId !== saved.id) S.draftId = saved.id;
          const next = readDrafts().map((x) => (x.id === saved.id || x.lk === o.lk ? Object.assign({}, x, { id: saved.id }) : x));
          writeDraftsList(next);
        })
        .catch(() => undefined);
    }
    const a = $('#autosv');
    if (a) a.innerHTML = ico('i-check') + '下書きを自動保存しました　' + E(SF.fmt(o.at).slice(11));
  }
  function saveDraftSoon() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(writeDraft, 400);
  }

  function clearDraft() {
    clearTimeout(draftTimer);
    const id = S.draftId;
    // いま開いている下書きだけを消す（開いていないときに、端末だけの下書きを巻き込まない）
    if (S.draft) {
      clearedDrafts.add(S.draft);
      if (id) removeDraftLocal(id);
      if (S.draftLk) writeDraftsList(readDrafts().filter((o) => o.lk !== S.draftLk));
    }
    if (id && window.__MSF__ && window.__MSF__.clearDraft) window.__MSF__.clearDraft(id).catch(() => undefined);
    try {
      localStorage.removeItem(DKEY);
    } catch (e) {}
    S.draftId = null;
    S.draftLk = null;
  }
  /* 別の下書きへ移る。いまの下書きは消さずに一覧へ残す（中身が無いものだけ片付ける） */
  function detachDraft() {
    if (S.draft && !hasContent(S.draft)) return clearDraft();
    if (S.draft) writeDraft();
    clearTimeout(draftTimer);
    S.draftId = null;
    S.draftLk = null;
  }
  function hasContent(d) {
    return (
      !!d &&
      (!!d.toolRef ||
        ['title', 'problem', 'purpose', 'scope', 'outScope'].some((k) => String(d[k] || '').trim()) ||
        (d.criteria || []).some((x) => String(x).trim()))
    );
  }
  function draftLabel(o) {
    return o.draft.title && o.draft.title.trim() ? o.draft.title : '（件名はまだありません）';
  }
  function resumeDraft(o) {
    if (!o) return;
    detachDraft();
    S.draft = o.draft;
    S.draftId = o.id || null;
    S.draftLk = o.lk || null;
    S.editId = o.editId || null;
    S.step = Math.min(Math.max(0, +o.step || 0), STEPS.length - 1);
    S.pickDept = '';
    go('new');
    toast('書きかけの依頼の続きから再開します');
  }
  function discardDraft(after) {
    clearDraft();
    S.draft = null;
    S.editId = null;
    toast('下書きを破棄しました');
    if (after) after();
  }

  /* ---- 状態の変更（共通） ---- */
  const QUICK = ['review', 'wait', 'dev', 'verify', 'field', 'release_wait', 'received'];
  function applyStatus(r, v, note, extra) {
    const now = SF.nowISO();
    const pipeBefore = O().pipes[r.id] ? JSON.stringify(O().pipes[r.id]) : null;
    r.history.push({
      at: now,
      by: me().name,
      role: me().l,
      action: '状態を「' + SF.statusOf(v).l + '」に変更',
      note: [extra, note].filter(Boolean).join('／'),
    });
    if (note) {
      r.comments = r.comments || [];
      r.comments.push({ at: now, by: me().name, text: note, __reason: true });
    }
    const from = r.status;
    r.status = v;
    r.updatedAt = now;
    S.fresh = r.id;
    addAudit(
      '状態を「' + SF.statusOf(v).l + '」に変更',
      r.id,
      ['「' + SF.statusOf(from).l + '」から', extra, note].filter(Boolean).join('／'),
    );
    // 見本モードだけパイプを動かす。サーバ接続時の実依頼で Issue・PR・検査結果を作らない
    if (!window.__MSF__) {
      const o = O(),
        p = o.pipes[r.id];
      if (v === 'approved' && !p) o.pipes[r.id] = newPipe();
      if (p && v === 'dev' && p.step === 1) {
        p.issue = p.issue || ++o.seq.issue;
        p.step = 2;
      }
      if (p && v === 'verify' && p.step < 9) {
        p.pr = p.pr || ++o.seq.pr;
        SF.CHECKS.forEach((c) => {
          if (c[0] !== 'offline' || SF.isFieldTool(r)) p.checks[c[0]] = 'ok';
        });
        p.prItems = SF.PRITEMS.map(() => 1);
        p.esc = '';
        p.step = 9;
      }
      if (p && v === 'field' && p.step < 10) p.step = 10;
      if (p && v === 'release_wait' && p.step < 11) p.step = 11;
      if (p && ['wait', 'back'].includes(v) && p.step < 12) {
        p.step = 1;
        p.esc = '';
      }
    }
    return persist().then((res) => {
      if (coreFailed(res, r.id)) {
        // 依頼は bridge がサーバの最新へ戻す。パイプラインの楽観更新も戻し、監査には取り消しを追記する。
        if (pipeBefore) O().pipes[r.id] = JSON.parse(pipeBefore);
        else delete O().pipes[r.id];
        addAudit('状態の変更を取り消した', r.id, '保存に失敗（' + (res.error || '') + '）');
        persist();
        refresh();
      }
      return res;
    });
  }
  /* マージ前に「現場試用」「公開承認待ち」「完了」へは進めない（本番の遷移表） */
  function mergeBlock(r, to) {
    // 接続時は見本のマージを実行できないので条件にしない。実際のマージの確認は開発ラインの接続後に足す
    if (window.__MSF__) return '';
    const p = O().pipes[r.id];
    return ['field', 'release_wait', 'done'].includes(to) && p && !p.merged
      ? 'PR #' + (p.pr || '－') + ' のマージがまだです（DevOps 画面で承認者がマージを判断します）'
      : '';
  }
  function refresh() {
    render();
    if (S.open) renderDrawer();
  }
  function advance(r) {
    const nx = SF.nextOf(r);
    if (!nx) return;
    if (!SF.canMoveR(S.role, r, nx, me().name)) return toast(SF.whyNotR(S.role, r, nx, me().name), true);
    const mb = mergeBlock(r, nx);
    if (mb) return toast(mb, true);
    if (!QUICK.includes(nx)) return openStatus(r, nx);
    const prev = {
      status: r.status,
      updatedAt: r.updatedAt,
      hl: r.history.length,
      cl: (r.comments || []).length,
      pipe: O().pipes[r.id] ? JSON.stringify(O().pipes[r.id]) : null,
    };
    const saving = applyStatus(r, nx, '', '');
    refresh();
    saving.then((res) => {
      if (coreFailed(res, r.id)) return;
      toast(r.id + ' を「' + SF.statusOf(nx).l + '」に進めました', false, {
        l: '元に戻す',
        fn: () => {
          const pipeNow = O().pipes[r.id] ? JSON.stringify(O().pipes[r.id]) : null;
          r.status = prev.status;
          r.updatedAt = prev.updatedAt;
          r.history.length = Math.min(r.history.length, prev.hl);
          if (r.comments) r.comments.length = Math.min(r.comments.length, prev.cl);
          if (prev.pipe) O().pipes[r.id] = JSON.parse(prev.pipe);
          else delete O().pipes[r.id];
          const undoing = persist();
          refresh();
          undoing.then((undone) => {
            if (coreFailed(undone, r.id)) {
              // 依頼は bridge がサーバの最新へ戻す。パイプラインも戻す
              if (pipeNow) O().pipes[r.id] = JSON.parse(pipeNow);
              refresh();
              return;
            }
            addAudit('操作を元に戻した', r.id, '「' + SF.statusOf(nx).l + '」→「' + SF.statusOf(prev.status).l + '」');
            persist();
            refresh();
            toast('元に戻しました');
          });
        },
      });
    });
  }
  const stay = (r, long) => {
    if (SF.ENDED.includes(r.status)) return '';
    const n = SF.stayDays(r),
      c = n >= SF.STAY_ALERT ? ' al' : n >= SF.STAY_WARN ? ' wn' : '';
    return (
      '<span class="stay' +
      c +
      '" title="いまの状態になってから ' +
      n +
      ' 日">' +
      ico('i-clock') +
      (n ? n + '日' + (long ? '目' : '') : '今日') +
      '</span>'
    );
  };
  const myTurn = () =>
    S.data.items
      .map((r) => ({ r, a: SF.turnOf(S.role, r, me().name) }))
      .filter((x) => x.a)
      .sort((x, y) => SF.stayDays(y.r) - SF.stayDays(x.r));
  const nextWho = (r) => {
    const k = SF.NEXTBY[r.status];
    return k ? SF.roleShort(k) : '';
  };

  /* ---- shell ---- */
  $('#role').innerHTML = SF.ROLES.map((r) => '<option value="' + r.k + '">' + E(r.name) + '（' + E(r.l) + '）</option>').join('');
  $('#role').addEventListener('change', (e) => {
    S.role = e.target.value;
    if (window.__MSF__) window.__MSF__.switchRole(e.target.value);
    toast(me().name + 'として操作します');
    if (S.open) renderDrawer();
    render();
  });
  $('#rail').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    if (b.dataset.v === 'new') startNew();
    else go(b.dataset.v);
  });
  function go(v) {
    if (S.submitting && v !== 'new') return toast('送信中です。完了までお待ちください', true);
    S.view = v;
    $$('#rail button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    render();
    window.scrollTo({ top: 0 });
  }
  function render() {
    const v = $('#view');
    v.style.animation = 'none';
    void v.offsetWidth;
    v.style.animation = '';
    const w = myTurn().length + opsTurn().length;
    const b = $('#bdg');
    b.textContent = w;
    b.style.display = w ? 'grid' : 'none';
    b.title = 'あなたの番 ' + w + ' 件';
    const o = O(),
      nInc = o.incidents.filter((i) => i.status !== '完了').length,
      nSec =
        o.vulns.filter((v) => ['未対応', '対応中'].includes(v.status) && SF.daysLeft(SF.dueOf(v)) < 0).length +
        o.secEvents.filter((e) => e.status === '未確認').length;
    const bo = $('#bdgOps');
    bo.textContent = nInc;
    bo.style.display = nInc ? 'grid' : 'none';
    bo.title = '対応中の障害 ' + nInc + ' 件';
    const bs = $('#bdgSec');
    bs.textContent = nSec;
    bs.style.display = nSec ? 'grid' : 'none';
    bs.title = '期限切れの脆弱性と未確認の通知 ' + nSec + ' 件';
    ({
      home: renderHome,
      new: renderWizard,
      board: renderBoard,
      list: renderList,
      data: renderData,
      ops: renderOps,
      devops: renderDevops,
      secops: renderSecops,
    })[S.view]();
  }

  /* ---- home ---- */
  function renderHome() {
    const it = S.data.items,
      h = new Date().getHours();
    const greet = h < 11 ? 'おはようございます' : h < 17 ? 'こんにちは' : 'おつかれさまです';
    const cnt = (ks) => it.filter((r) => ks.includes(r.status)).length;
    const hours = Math.round(it.reduce((a, r) => a + SF.measure(r).hours, 0));
    const t = { g: 0, y: 0, r: 0 };
    it.forEach((r) => t[colorOf(r)]++);
    const turn = myTurn(),
      late = turn.filter((x) => SF.stayDays(x.r) >= SF.STAY_WARN).length,
      ot = opsTurn(),
      all = turn.length + ot.length;
    const orow = (x) =>
      '<div class="trow ops' +
      (x.tone ? ' ' + x.tone : '') +
      '" data-goto="' +
      E(x.go.join('|')) +
      '"><div class="tm"><span class="kd">' +
      E(x.kind) +
      '</span><span class="no">' +
      E(x.id) +
      '</span></div><b>' +
      E(x.title) +
      '</b><div class="ta">' +
      ico('i-arrow') +
      E(x.a) +
      '</div><div class="tb"><button class="btn sm go" type="button" data-goto="' +
      E(x.go.join('|')) +
      '">' +
      ico('i-arrow') +
      '開く</button></div></div>';
    const o = O(),
      nInc = o.incidents.filter((i) => i.status !== '完了').length,
      nOver = o.vulns.filter((v) => ['未対応', '対応中'].includes(v.status) && SF.daysLeft(SF.dueOf(v)) < 0).length,
      nPipe = Object.values(o.pipes).filter((p) => p.step < 12).length;
    const active = (r) => !SF.ENDED.includes(r.status);
    const second =
      S.role === 'requester'
        ? it.filter((r) => r.applicant === me().name && !SF.turnOf(S.role, r, me().name))
        : it
            .filter((r) => active(r) && SF.stayDays(r) >= SF.STAY_WARN && !SF.turnOf(S.role, r, me().name))
            .sort((x, y) => SF.stayDays(y) - SF.stayDays(x));
    const secondT =
      S.role === 'requester' ? 'あなたの依頼（ほかの人の番）' : '止まっている依頼（' + SF.STAY_WARN + '日以上・ほかの人の番）';
    const ev = [];
    it.forEach((r) => r.history.forEach((x) => ev.push({ r, x })));
    ev.sort((a, b) => (a.x.at < b.x.at ? 1 : -1));
    const drafts = readDrafts().filter((o) => hasContent(o.draft));
    const tbtn = (x) => {
      const r = x.r;
      if (S.role === 'requester' && r.status === 'back')
        return '<button class="btn sm go" type="button" data-tedit="' + E(r.id) + '">' + ico('i-edit') + '直す</button>';
      if (S.role === 'requester' && r.status === 'field')
        return '<button class="btn sm" type="button" data-tcmt="' + E(r.id) + '">' + ico('i-chat') + '感想を書く</button>';
      const nx = SF.nextOf(r);
      if (!nx || !SF.canMoveR(S.role, r, nx, me().name)) return '';
      return (
        '<button class="btn sm go" type="button" data-tnx="' +
        E(r.id) +
        '">' +
        ico('i-arrow') +
        '「' +
        E(SF.statusOf(nx).l) +
        '」へ</button>'
      );
    };
    const row = (x) =>
      '<div class="trow' +
      (SF.stayDays(x.r) >= SF.STAY_ALERT ? ' al' : SF.stayDays(x.r) >= SF.STAY_WARN ? ' wn' : '') +
      '" data-id="' +
      E(x.r.id) +
      '"><div class="tm"><span class="no">' +
      E(x.r.id) +
      '</span>' +
      st(x.r.status) +
      sig(colorOf(x.r)) +
      stay(x.r, true) +
      '</div><b>' +
      E(x.r.title) +
      '</b><div class="ta">' +
      ico('i-arrow') +
      E(x.a) +
      '</div><div class="tb">' +
      tbtn(x) +
      '</div></div>';
    $('#view').innerHTML =
      '<div class="hero hero2"><div><h2>' +
      greet +
      '、' +
      E(me().name.split(' ')[0]) +
      'さん</h2><p>' +
      (all
        ? 'いま、<b>あなたの番</b>が <b class="big">' +
          all +
          '</b> 件あります' +
          (late ? '（うち ' + late + ' 件の依頼は ' + SF.STAY_WARN + ' 日以上止まっています）' : '') +
          '。'
        : 'いま、あなたが動かすものはありません。') +
      '</p></div><button class="btn go" id="cta" type="button">' +
      ico('i-plus') +
      '新しい依頼をはじめる' +
      ico('i-arrow') +
      '</button></div>' +
      (drafts.length
        ? '<div class="card pad drc"><span class="ib">' +
          ico('i-edit') +
          '</span><div><b>書きかけの依頼があります（' +
          drafts.length +
          '件）</b>' +
          drafts
            .slice(0, 3)
            .map(
              (o) =>
                '<div class="mini" style="margin-top:6px"><span class="no">STEP ' +
                ((+o.step || 0) + 1) +
                '</span><b>' +
                E(draftLabel(o)) +
                '</b><small class="muted">' +
                E(SF.fmt(o.at)) +
                ' に自動保存</small><span class="sp"></span><button class="btn sm pri" type="button" data-dres="' +
                E(draftKey(o)) +
                '">' +
                ico('i-arrow') +
                '続きから再開</button><button class="btn sm dng" type="button" data-ddis="' +
                E(draftKey(o)) +
                '">' +
                ico('i-trash') +
                '破棄</button></div>',
            )
            .join('') +
          (drafts.length > 3
            ? '<div class="muted" style="font-size:12.5px;margin-top:4px">ほか ' + (drafts.length - 3) + ' 件</div>'
            : '') +
          '</div></div>'
        : '') +
      '<div class="card pad turn"><h2 class="h2">' +
      ico('i-flag') +
      'あなたの番<em class="cnt">' +
      all +
      '</em><span class="muted" style="font-size:12.5px;font-weight:400;margin-left:auto">' +
      E(me().l) +
      'として、次に動かすものです（止まっている日数の長い順）</span></h2>' +
      (all
        ? turn.map(row).join('') + ot.map(orow).join('')
        : '<p class="muted" style="margin:0">' +
          ico('i-check') +
          ' いまはありません。ほかの人の番の依頼は、ボードと一覧で見られます。</p>') +
      '</div>' +
      '<div class="ostrip"><button type="button" data-goto="ops|apps">' +
      ico('i-pulse') +
      '<span>運用中の道具 <b>' +
      o.apps.length +
      '</b> 件</span></button><button type="button" data-goto="ops|inc" class="' +
      (nInc ? 'wn' : '') +
      '">' +
      ico('i-alert') +
      '<span>対応中の障害 <b>' +
      nInc +
      '</b> 件</span></button><button type="button" data-goto="devops|line">' +
      ico('i-git') +
      '<span>開発ラインの依頼 <b>' +
      nPipe +
      '</b> 件</span></button><button type="button" data-goto="secops|vul" class="' +
      (nOver ? 'al' : '') +
      '">' +
      ico('i-lock') +
      '<span>期限切れの脆弱性 <b>' +
      nOver +
      '</b> 件</span></button></div>' +
      '<div class="kpis">' +
      kpi('受付・確認中', cnt(['received', 'review']), 'i-inbox', '件') +
      kpi('承認待ち', cnt(['wait']), 'i-stamp', '件') +
      kpi('進行中', cnt(['approved', 'dev', 'verify', 'field', 'release_wait']), 'i-wrench', '件') +
      kpi(
        SF.STAY_WARN + '日以上止まっている',
        it.filter((r) => active(r) && SF.stayDays(r) >= SF.STAY_WARN).length,
        'i-clock',
        '件',
      ) +
      kpi('月あたり削減見込み', hours, 'i-gauge', 'h') +
      '</div>' +
      '<div class="two"><div class="card pad"><h2 class="h2">' +
      ico('i-users') +
      E(secondT) +
      '</h2>' +
      (second.length
        ? second
            .slice(0, 6)
            .map(
              (r) =>
                '<div class="mini" data-id="' +
                E(r.id) +
                '"><span class="no">' +
                E(r.id) +
                '</span><b>' +
                E(r.title) +
                '</b>' +
                st(r.status) +
                stay(r) +
                (nextWho(r) && active(r) ? '<small class="muted">次は' + E(nextWho(r)) + '</small>' : '') +
                '</div>',
            )
            .join('')
        : '<p class="muted">いまはありません</p>') +
      '</div>' +
      '<div class="card pad"><h2 class="h2">' +
      ico('i-clock') +
      '最近の動き</h2><ul class="feed">' +
      ev
        .slice(0, 7)
        .map(
          (e, i) =>
            '<li style="animation-delay:' +
            i * 0.05 +
            's"><span class="av">' +
            E(e.x.by.slice(0, 1)) +
            '</span><div><b>' +
            E(e.x.action) +
            '</b>　<a data-id="' +
            E(e.r.id) +
            '">' +
            E(e.r.title) +
            '</a><small>' +
            E(SF.fmt(e.x.at)) +
            '　' +
            E(e.x.by) +
            '</small></div></li>',
        )
        .join('') +
      '</ul></div></div>' +
      '<div class="card pad" style="margin-top:16px"><h2 class="h2">' +
      ico('i-flag') +
      '信号の色の割合</h2><div class="ratio" id="ratio"><i class="g"></i><i class="y"></i><i class="r"></i></div><div class="rl"><span>' +
      sig('g') +
      ' ' +
      t.g +
      '件</span><span>' +
      sig('y') +
      ' ' +
      t.y +
      '件</span><span>' +
      sig('r') +
      ' ' +
      t.r +
      '件</span></div>' +
      '<p class="hint" style="margin-top:12px">青＝任せる／黄＝担当者のチェック付き／赤＝AIに決めさせない。最終的な色は承認者が決めます。</p></div>';
    $('#cta').addEventListener('click', startNew);
    $$('#view [data-dres]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        resumeDraft(readDrafts().find((o) => draftKey(o) === b.dataset.dres));
      }),
    );
    $$('#view [data-ddis]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const o = readDrafts().find((x) => draftKey(x) === b.dataset.ddis);
        if (!o) return;
        confirmBox('下書きを破棄', '「' + draftLabel(o) + '」の入力内容を消します。元に戻せません。', '破棄する', () => {
          removeDraftLocal(draftKey(o));
          // id なしで呼ぶと全件消えるので、サーバに保存済みのものだけ送る
          if (o.id && window.__MSF__ && window.__MSF__.clearDraft) window.__MSF__.clearDraft(o.id).catch(() => undefined);
          renderHome();
        });
      }),
    );
    $$('#view [data-id]').forEach((a) => a.addEventListener('click', () => openDrawer(a.dataset.id)));
    $$('#view [data-goto]').forEach((a) =>
      a.addEventListener('click', (e) => {
        e.stopPropagation();
        goTo(a.dataset.goto.split('|'));
      }),
    );
    $$('#view [data-tnx]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const r = find(b.dataset.tnx);
        if (r) advance(r);
      }),
    );
    $$('#view [data-tedit]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        startEdit(b.dataset.tedit);
      }),
    );
    $$('#view [data-tcmt]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        openDrawer(b.dataset.tcmt);
        S.dtab = 'log';
        renderDrawer();
        const c = $('#ctx');
        if (c) c.focus();
      }),
    );
    const rb = $$('#ratio i'),
      n = Math.max(1, it.length);
    setTimeout(
      () => {
        rb[0].style.width = (t.g / n) * 100 + '%';
        rb[1].style.width = (t.y / n) * 100 + '%';
        rb[2].style.width = (t.r / n) * 100 + '%';
      },
      reduce ? 0 : 120,
    );
    $$('[data-count]').forEach((el) => {
      const target = +el.dataset.count;
      if (reduce) {
        el.textContent = target;
        return;
      }
      let s0 = null;
      const f = (t2) => {
        if (!s0) s0 = t2;
        const p = Math.min((t2 - s0) / 900, 1);
        el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
        if (p < 1) requestAnimationFrame(f);
      };
      requestAnimationFrame(f);
    });
  }
  const kpi = (l, n, i, u) =>
    '<div class="card kpi"><div class="t">' +
    ico(i) +
    E(l) +
    '</div><div class="n"><span data-count="' +
    n +
    '">0</span><small>' +
    u +
    '</small></div></div>';

  /* ---- wizard ---- */
  const STEPS = [
    { t: 'はじめに', h: 'どんな依頼ですか？', d: '近い道具がカタログにあれば選んでください。なくても大丈夫です。' },
    { t: 'だれが', h: 'だれが・どこで使いますか？', d: '使う人と場所がわかると、合格の条件や信号の色が決めやすくなります。' },
    {
      t: '困りごと',
      h: 'いま困っていること・目的',
      d: '「いま、こうで困っている」「こうなればうれしい」をそのまま書いてください。',
    },
    { t: '作るもの', h: '作るもの・今回は作らないもの', d: '「作らない」を書いておくと、作りすぎや手戻りを防げます。' },
    { t: '合格の条件', h: 'どうなれば合格？', d: '検査機で確かめられるように、数字や「〜できる／〜できない」で書きます。' },
    { t: 'データと安全', h: 'この道具は何をしますか？', d: '信号の色を決める大事な質問です。「決める」仕事はAIに任せません。' },
    { t: '確認', h: 'ものさしと最終確認', d: '手間の大きさは参考値です。着手順は別途決めます。' },
  ];
  /* 運用データから依頼を作る。サーバは必須項目を求めるので、入力画面へ渡して、受付できてから運用データへ結び付ける。 */
  function startRequestFrom(r, origin) {
    // 書きかけの下書きを黙って消さない。先に送信か破棄をしてもらう
    if (S.draft && hasContent(S.draft)) {
      toast('書きかけの依頼があります。「新しい依頼」から送信するか破棄してから、もう一度押してください', true);
      return;
    }
    detachDraft();
    r.criteria = r.criteria && r.criteria.length ? r.criteria : [''];
    r.__origin = origin;
    S.draft = r;
    S.editId = null;
    S.step = 0;
    S.pickDept = '';
    closeModal();
    go('new');
    toast('作るもの・合格の条件を書き足して受け付けてください');
  }
  function linkRequestOrigin(origin, id) {
    const o = O();
    if (origin.kind === 'feedback') {
      const f = o.feedback.find((x) => x.id === origin.id);
      if (!f) return;
      f.status = '依頼にした';
      f.ref = id;
      addAudit('利用者の声を依頼にした', id, f.id);
    } else if (origin.kind === 'incident') {
      const i = o.incidents.find((x) => x.id === origin.id);
      if (!i) return;
      i.prevention = (i.prevention ? i.prevention + '／' : '') + id + ' で対応';
      addAudit('再発防止を依頼にした', id, i.id);
    }
  }
  function freshDraft() {
    detachDraft();
    S.draft = SF.blank(S.role);
    S.draft.criteria = [''];
    S.editId = null;
    S.step = 0;
    S.pickDept = '';
    go('new');
  }
  function startNew() {
    if (S.view === 'new' && S.draft) return toast('入力中の依頼を表示しています（新しく始めるときは「下書きを破棄」）');
    const list = readDrafts().filter((o) => hasContent(o.draft));
    if (list.length) {
      modal(
        ico('i-edit') + '書きかけの依頼があります',
        '<p style="margin:0 0 8px">続きから再開する下書きを選んでください。新しく始めることもできます。</p>' +
          list
            .slice(0, 5)
            .map(
              (o) =>
                '<div class="drc in" style="margin-top:8px"><span class="ib">' +
                ico('i-doc') +
                '</span><div><b>' +
                E(draftLabel(o)) +
                '</b><div class="muted" style="font-size:12.5px">STEP ' +
                ((+o.step || 0) + 1) +
                '／' +
                STEPS.length +
                '　' +
                E(SF.fmt(o.at)) +
                ' に自動保存</div></div><span class="sp"></span><button class="btn pri" type="button" data-res="' +
                E(draftKey(o)) +
                '">続きから再開</button></div>',
            )
            .join(''),
        '<button class="btn dng" id="dfnew" type="button">' + ico('i-plus') + '新しく始める</button>',
      );
      $$('#modal [data-res]').forEach((b) =>
        b.addEventListener('click', () => {
          const o = readDrafts().find((x) => draftKey(x) === b.dataset.res);
          closeModal();
          if (o) resumeDraft(o);
        }),
      );
      $('#dfnew').addEventListener('click', () => {
        closeModal();
        freshDraft();
      });
      return;
    }
    freshDraft();
  }
  function startEdit(id) {
    const r = find(id);
    if (!r) return;
    const cur = readDrafts().find((o) => o.editId === id && hasContent(o.draft));
    if (cur) {
      closeDrawer();
      return resumeDraft(cur);
    }
    const begin = () => {
      detachDraft();
      S.draft = JSON.parse(JSON.stringify(r));
      if (!S.draft.criteria.length) S.draft.criteria = [''];
      S.draftId = null;
      S.editId = id;
      S.step = 0;
      S.pickDept = '';
      closeDrawer();
      go('new');
    };
    begin();
  }
  function renderWizard() {
    if (!S.draft) {
      S.draft = SF.blank(S.role);
      S.draft.criteria = [''];
      S.draftId = null;
    }
    const resub = S.editId && S.draft.status === 'back' && SF.canMoveR(S.role, S.draft, 'received', me().name);
    if (S.step !== 4) S.critUndo = {};
    const s = STEPS[S.step];
    $('#view').innerHTML =
      '<div class="steps">' +
      STEPS.map(
        (x, i) =>
          '<button type="button" class="stp ' +
          (i < S.step ? 'done' : i === S.step ? 'on' : '') +
          '" data-step="' +
          i +
          '"><div class="bar"><i></i></div><b>STEP ' +
          (i + 1) +
          '</b><span>' +
          E(x.t) +
          '</span></button>',
      ).join('') +
      '</div>' +
      '<div class="wiz"><div class="card pane" id="pane"><h3>' +
      (S.editId ? '<span class="muted" style="font-size:13px">' + E(S.editId) + ' を編集中　</span>' : '') +
      E(s.h) +
      '</h3><p class="lead">' +
      E(s.d) +
      '</p><div id="stepBody">' +
      stepHTML(S.step) +
      '</div>' +
      '<div class="err" id="err"></div>' +
      '<div class="navbtns"><button class="btn" id="prev" type="button"' +
      (S.step === 0 ? ' disabled' : '') +
      '>' +
      ico('i-back') +
      'もどる</button>' +
      '<div class="navmid"><span class="autosv" id="autosv" aria-live="polite">' +
      (S.persistent ? '入力は自動で下書き保存されます' : 'このブラウザでは保存できないため、閉じると入力が消えます') +
      '</span><button class="btn sm dng" id="ddraft" type="button">' +
      ico('i-trash') +
      (S.editId ? '編集をやめる' : '下書きを破棄') +
      '</button></div>' +
      (S.step < STEPS.length - 1
        ? '<button class="btn pri" id="next" type="button">つぎへ' + ico('i-arrow') + '</button>'
        : '<button class="btn go" id="submit" type="button">' +
          ico('i-stamp') +
          (resub ? '直した内容で再提出する' : S.editId ? 'この内容で更新する' : 'この内容で受け付ける') +
          '</button>') +
      '</div></div>' +
      '<aside class="pv" id="pv"></aside></div>';
    bindStep();
    updPreview();
    writeDraft();
    renderConflict();
    setWizardBusy(S.submitting);
    $('#ddraft').addEventListener('click', () =>
      confirmBox(
        S.editId ? '編集をやめる' : '下書きを破棄',
        S.editId ? 'ここまでの変更を保存せずに、編集をやめます。' : 'ここまでの入力内容を消します。元に戻せません。',
        S.editId ? '編集をやめる' : '破棄する',
        () => {
          const id = S.editId;
          discardDraft(() => {
            if (id) {
              go('board');
              openDrawer(id);
            } else go('home');
          });
        },
      ),
    );
    $$('.stp').forEach((b) =>
      b.addEventListener('click', () => {
        const to = +b.dataset.step;
        if (to <= S.step || validUpTo(to)) {
          S.step = to;
          renderWizard();
        }
      }),
    );
    $('#prev').addEventListener('click', () => {
      if (S.step > 0) {
        S.step--;
        renderWizard();
      }
    });
    if ($('#next'))
      $('#next').addEventListener('click', () => {
        const e = validate(S.step);
        if (e.length) return showErr(e);
        S.step++;
        renderWizard();
      });
    if ($('#submit')) $('#submit').addEventListener('click', submit);
  }
  function validUpTo(to) {
    for (let i = 0; i < to; i++) {
      const e = validate(i);
      if (e.length) {
        S.step = i;
        renderWizard();
        showErr(e);
        return false;
      }
    }
    return true;
  }
  function showErr(list) {
    const e = $('#err');
    e.innerHTML = ico('i-alert') + ' ' + list.map(E).join('<br>');
    e.classList.add('show');
    const p = $('#pane');
    p.classList.remove('shake');
    void p.offsetWidth;
    p.classList.add('shake');
  }
  function validate(i) {
    const d = S.draft,
      e = [];
    if (i === 0 && !d.kind) e.push('依頼の種類を選んでください');
    if (i === 1) {
      if (!d.applicant.trim()) e.push('起票者を入力してください');
      if (!d.users.length) e.push('使う人を1つ以上選んでください');
    }
    if (i === 2) {
      if (!d.title.trim()) e.push('件名を入力してください');
      if (!d.problem.trim()) e.push('困っていることを入力してください');
      if (!d.purpose.trim()) e.push('目的を入力してください');
    }
    if (i === 3 && !d.scope.trim()) e.push('作るものを1つ以上書いてください');
    if (i === 4 && !d.criteria.filter((x) => x.trim()).length) e.push('合格の条件を1つ以上書いてください');
    if (i === 5 && !d.decides) e.push('「この道具は何をしますか」を選んでください');
    if (i === 6 && !d.approver) e.push('承認者を選んでください');
    return e;
  }
  const chipsM = (field, opts) =>
    '<div class="chips">' +
    opts
      .map((o) => {
        const k = o.k !== undefined ? o.k : o,
          l = o.l || o;
        return (
          '<button type="button" class="chip' +
          ((S.draft[field] || []).includes(k) ? ' on' : '') +
          '" data-chip="' +
          field +
          '" data-v="' +
          E(k) +
          '">' +
          E(l) +
          '</button>'
        );
      })
      .join('') +
    '</div>';
  const chipsO = (field, opts) =>
    '<div class="chips">' +
    opts
      .map((o) => {
        const k = o.k !== undefined ? o.k : o,
          l = o.l || o;
        return (
          '<button type="button" class="chip' +
          (String(S.draft[field]) === String(k) ? ' on' : '') +
          '" data-one="' +
          field +
          '" data-v="' +
          E(k) +
          '">' +
          E(l) +
          '</button>'
        );
      })
      .join('') +
    '</div>';
  const fld = (label, req, html, hint) =>
    '<div class="f"><label class="fl">' +
    label +
    (req ? '<span class="req">必須</span>' : '') +
    '</label>' +
    html +
    (hint ? '<div class="hint">' + hint + '</div>' : '') +
    '</div>';
  const inp = (field, ph, type) =>
    '<input type="' +
    (type || 'text') +
    '" data-bind="' +
    field +
    '" value="' +
    E(S.draft[field]) +
    '" placeholder="' +
    E(ph || '') +
    '"' +
    (type === 'number' ? ' min="0"' : '') +
    '>';
  const ta = (field, ph) =>
    '<textarea data-bind="' + field + '" placeholder="' + E(ph || '') + '">' + E(S.draft[field]) + '</textarea>';
  function stepHTML(i) {
    const d = S.draft;
    if (i === 0) {
      const kicons = ['i-spark', 'i-wrench', 'i-bug', 'i-chat'],
        kdesc = [
          'まだない道具を作ってほしい',
          'いま使っている道具を直したい・足したい',
          '動かない・まちがっている',
          'まだ形になっていない思いつき',
        ];
      const dep = S.pickDept || (d.toolRef ? d.toolRef.split('|')[0] : '');
      return (
        '<div class="choices">' +
        SF.KINDS.map(
          (k, j) =>
            '<button type="button" class="choice' +
            (d.kind === k ? ' on' : '') +
            '" data-one="kind" data-v="' +
            E(k) +
            '"><span class="ib">' +
            ico(kicons[j]) +
            '</span><span><b>' +
            E(k) +
            '</b><small>' +
            E(kdesc[j]) +
            '</small></span></button>',
        ).join('') +
        '</div>' +
        fld(
          '部署別 道具カタログから選ぶ（任意）',
          0,
          '<div class="depts">' +
            CATALOG.map(
              (c) =>
                '<button type="button" class="chip' +
                (dep === c.id ? ' on' : '') +
                '" data-pick="' +
                c.id +
                '">' +
                E(c.short) +
                '</button>',
            ).join('') +
            '</div>' +
            (dep
              ? '<div class="tools">' +
                SF.deptOf(dep)
                  .tools.map((t, j) => {
                    const ref = dep + '|' + j;
                    return (
                      '<button type="button" class="tool' +
                      (d.toolRef === ref ? ' on' : '') +
                      '" data-tool="' +
                      ref +
                      '" style="animation-delay:' +
                      j * 0.03 +
                      's"><span class="d ' +
                      t[2] +
                      '"></span><span><b>' +
                      E(t[0]) +
                      '</b><small>' +
                      E(t[1]) +
                      '</small></span></button>'
                    );
                  })
                  .join('') +
                '</div>' +
                (d.toolRef
                  ? '<div style="margin-top:8px"><button type="button" class="btn sm" data-tool="">選択を外す</button></div>'
                  : '')
              : '<div class="hint">部署を選ぶと、その部署の道具の候補が出ます。丸の色はカタログ上の信号の色です。</div>'),
        )
      );
    }
    if (i === 1) {
      return (
        '<div class="grid2">' +
        fld('起票者', 1, inp('applicant', '例：山田 太郎')) +
        fld('連絡先', 0, inp('contact', '例：内線 1234')) +
        '</div>' +
        fld(
          '所属部署',
          1,
          '<select data-bind="dept">' +
            CATALOG.map(
              (c) => '<option value="' + c.id + '"' + (d.dept === c.id ? ' selected' : '') + '>' + E(c.name) + '</option>',
            ).join('') +
            '</select>',
        ) +
        fld('だれが使う？', 1, chipsM('users', SF.USERS)) +
        '<div class="grid2">' +
        fld('使う人のおよその人数', 0, inp('people', '例：40', 'number'), '人') +
        '<div></div></div>' +
        fld(
          'どこで使う？',
          0,
          chipsM('places', SF.PLACES),
          '「海の上」「電波の弱い現場」を選ぶと、圏外でも動くことが大事な条件になります',
        )
      );
    }
    if (i === 2) {
      return (
        fld('件名', 1, inp('title', '例：作業船の上での工事写真の圏外保存'), 'ひとことで「何がほしいか」がわかる名前に') +
        fld(
          'いま困っていること',
          1,
          ta('problem', '例：作業船や台船の上では電波が弱く写真が送れず、事務所に戻ってから整理し直している'),
        ) +
        fld('なんのため？（目的）', 1, ta('purpose', '例：海の上でも写真が消えずに残り、整理の手間をなくす'))
      );
    }
    if (i === 3) {
      return (
        fld('作るもの', 1, ta('scope', '1行に1つずつ\n例：圏外での一時保存\n例：電波が戻った時の自動送信'), '1行に1項目') +
        fld('今回は作らない', 0, ta('outScope', '例：写真の加工・編集'))
      );
    }
    if (i === 4) {
      return (
        '<div class="vsbox"><div class="b"><b style="color:var(--r)">' +
        ico('i-x') +
        ' 検査できない</b><br>「使いやすい画面にする」</div><div class="gd"><b style="color:var(--g)">' +
        ico('i-check') +
        ' 検査できる</b><br>「圏外で撮った写真がアプリを閉じても消えない」</div></div>' +
        '<div class="crit" id="crit">' +
        d.criteria.map((c, j) => critRow(c, j)).join('') +
        '</div>' +
        '<div style="margin-top:10px"><button type="button" class="btn sm" id="addC"' +
        (d.criteria.length >= 8 ? ' disabled' : '') +
        '>' +
        ico('i-plus') +
        '条件を追加</button></div>' +
        '<div class="hint" style="margin-top:12px">よく使う書き方（押すと追加されます）</div><div class="examples">' +
        [
          '〇〇しても消えない',
          '〇〇は自分の分だけが見られる',
          '同じ〇〇を二重に登録できない',
          '〇〇の翌朝9時までに通知される',
          '〇〇の記録（だれが・いつ）が残る',
          '〇〇は△△が「確定」を押すまで登録されない',
        ]
          .map((x) => '<button type="button" data-ex="' + E(x) + '">' + E(x) + '</button>')
          .join('') +
        '</div>'
      );
    }
    if (i === 5) {
      const ddesc = {
        g: 'まちがえてもすぐ直せる。人やお金に直接ひびかない',
        y: '結果は必ず担当者や技術者が見てから使う（天気・波の予報の目安など）',
        r: 'AIに決めさせない。出航・作業中止、合否、金額などは人が決める。道具は「材料集め・表示」までにする',
      };
      return (
        '<div class="choices" style="grid-template-columns:1fr">' +
        SF.DECIDES.map(
          (o) =>
            '<button type="button" class="choice sg ' +
            o.k +
            (d.decides === o.k ? ' on' : '') +
            '" data-one="decides" data-v="' +
            o.k +
            '"><span class="dot">' +
            SF.COLORS[o.k].l +
            '</span><span><b>' +
            E(o.l) +
            '</b><small>' +
            E(ddesc[o.k]) +
            '</small></span></button>',
        ).join('') +
        '</div>' +
        fld('扱う情報', 0, chipsM('data', SF.DATA)) +
        fld('関わる相手', 0, chipsO('parties', SF.PARTIES)) +
        fld(
          '守ること',
          0,
          chipsM('constraints', SF.CONSTRAINTS) +
            '<textarea data-bind="constraintsOther" style="margin-top:8px;min-height:60px" placeholder="その他に守ること（1行に1つ）">' +
            E(d.constraintsOther) +
            '</textarea>',
        ) +
        fld('必ず人に聞くこと', 0, chipsM('approvals', SF.APPROVALS), '当てはまる変更が出たら、作業を止めて承認者に確認します')
      );
    }
    if (i === 6) {
      return (
        '<div class="grid2">' +
        fld('その手間の頻度', 0, chipsO('freq', SF.FREQ)) +
        fld('1回あたりの手間（分）', 0, inp('minutes', '例：15', 'number')) +
        '</div>' +
        fld('元になるデータ', 0, chipsO('dataReady', SF.READY)) +
        fld('ほかに広げられそう？', 0, chipsO('spread', SF.SPREAD)) +
        '<div class="grid2">' +
        fld(
          '承認者（業務責任者）',
          1,
          '<select data-bind="approver">' +
            ['鈴木 一郎', '田中 誠司', '松本 綾']
              .map((a) => '<option' + (d.approver === a ? ' selected' : '') + '>' + a + '</option>')
              .join('') +
            '</select>',
          '信号の色の最終決定と承認を行う人',
        ) +
        fld('希望時期', 0, inp('wish', '', 'date'), '目安。着手順は別途決めます') +
        '</div>' +
        fld(
          '添付ファイル',
          0,
          '<input type="file" id="att" multiple><div class="hint" id="attL">' + attHtml() + '</div>',
          'サンプルではファイル名と大きさだけを記録します',
        )
      );
    }
    return '';
  }
  const suggHTML = (c, j) => {
    const sg = SF.suggest(c),
      u = (S.critUndo || {})[j];
    if (!sg.length && u === undefined) return '';
    return (
      sg
        .map(
          (g) =>
            '<div class="sg1"><div><b>' +
            ico('i-spark') +
            '「' +
            E(g.words.join('」「')) +
            '」の書きかえ候補</b>　' +
            E(g.hint) +
            '</div><div class="sgx">' +
            g.ex
              .map(
                (x) =>
                  '<button type="button" data-rw="' +
                  j +
                  '" data-v="' +
                  E(x) +
                  '" title="押すとこの文に置きかわります">' +
                  E(x) +
                  '</button>',
              )
              .join('') +
            '</div></div>',
        )
        .join('') +
      (u !== undefined
        ? '<a class="undo" data-ru="' + j + '">' + ico('i-undo') + '元の文に戻す（' + E(u || '空欄') + '）</a>'
        : '')
    );
  };
  const critRow = (c, j) => {
    const L = SF.lint(c);
    return (
      '<div class="ci" data-ci="' +
      j +
      '"><span class="n">' +
      (j + 1) +
      '</span><div><input type="text" data-crit="' +
      j +
      '" value="' +
      E(c) +
      '" class="' +
      (L.level === 'vague' ? 'vague' : L.ok ? 'good' : '') +
      '" placeholder="' +
      (j === 0 ? '例：圏外で撮った写真がアプリを閉じても消えない' : '') +
      '"><div class="lint ' +
      (L.level === 'empty' ? '' : L.level) +
      '">' +
      (L.level === 'empty' ? '' : (L.ok ? '✓ ' : '△ ') + E(L.tip)) +
      '</div><div class="sugg" data-sg="' +
      j +
      '">' +
      suggHTML(c, j) +
      '</div></div><button type="button" class="rm" data-rmc="' +
      j +
      '" title="削除"' +
      (S.draft.criteria.length <= 1 ? ' disabled' : '') +
      '>' +
      ico('i-x') +
      '</button></div>'
    );
  };
  function focusHole(j) {
    const x = $('[data-crit="' + j + '"]');
    if (!x) return;
    x.focus();
    const i = x.value.search(/〇〇|△△|□□/);
    if (i >= 0)
      try {
        x.setSelectionRange(i, i + 2);
      } catch (_) {}
  }
  const attHtml = () =>
    (S.draft.attachments || []).length
      ? S.draft.attachments
          .map(
            (a, i) =>
              '📎 ' +
              E(a.name) +
              ' <small>(' +
              Math.max(1, Math.round(a.size / 1024)) +
              ' KB)</small> <a data-rma="' +
              i +
              '">削除</a>',
          )
          .join('<br>')
      : 'なし';
  function bindStep() {
    const body = $('#stepBody'),
      d = S.draft;
    body.addEventListener('input', (e) => {
      const b = e.target.dataset.bind;
      if (b !== undefined) {
        d[b] = e.target.value;
        updPreview();
      }
      const c = e.target.dataset.crit;
      if (c !== undefined) {
        d.criteria[+c] = e.target.value;
        const L = SF.lint(e.target.value),
          box = e.target.nextElementSibling;
        e.target.className = L.level === 'vague' ? 'vague' : L.ok ? 'good' : '';
        box.className = 'lint ' + (L.level === 'empty' ? '' : L.level);
        box.textContent = L.level === 'empty' ? '' : (L.ok ? '✓ ' : '△ ') + L.tip;
        const sg = $('[data-sg="' + c + '"]', body);
        if (sg) sg.innerHTML = suggHTML(e.target.value, +c);
        updPreview();
      }
    });
    body.addEventListener('change', (e) => {
      const b = e.target.dataset.bind;
      if (b !== undefined) {
        d[b] = e.target.value;
        updPreview();
      }
    });
    body.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.chip) {
        const f = t.dataset.chip,
          v = t.dataset.v,
          a = (d[f] = d[f] || []);
        const k = a.indexOf(v);
        k < 0 ? a.push(v) : a.splice(k, 1);
        t.classList.toggle('on');
        updPreview();
      } else if (t.dataset.one) {
        const f = t.dataset.one;
        d[f] = t.dataset.v;
        $$('[data-one="' + f + '"]', body).forEach((x) => x.classList.toggle('on', x === t));
        updPreview();
      } else if (t.dataset.pick !== undefined) {
        S.pickDept = S.pickDept === t.dataset.pick ? '' : t.dataset.pick;
        $('#stepBody').innerHTML = stepHTML(0);
      } else if (t.dataset.tool !== undefined) {
        d.toolRef = t.dataset.tool;
        const tl = SF.toolOf(d.toolRef);
        if (tl) {
          d.dept = tl.dept.id;
          if (!d.title.trim()) d.title = tl.name;
          if (!d.decides) d.decides = tl.c;
          toast('「' + tl.name + '」を選びました（件名・部署・信号の候補に反映）');
        }
        $('#stepBody').innerHTML = stepHTML(0);
        updPreview();
      } else if (t.id === 'addC') {
        d.criteria.push('');
        $('#stepBody').innerHTML = stepHTML(4);
        const ins = $$('[data-crit]');
        ins[ins.length - 1].focus();
      } else if (t.dataset.rmc !== undefined) {
        d.criteria.splice(+t.dataset.rmc, 1);
        if (!d.criteria.length) d.criteria = [''];
        S.critUndo = {};
        $('#stepBody').innerHTML = stepHTML(4);
        updPreview();
      } else if (t.dataset.ex) {
        const empty = d.criteria.findIndex((x) => !x.trim());
        let j = empty;
        if (empty >= 0) d.criteria[empty] = t.dataset.ex;
        else if (d.criteria.length < 8) {
          d.criteria.push(t.dataset.ex);
          j = d.criteria.length - 1;
        }
        $('#stepBody').innerHTML = stepHTML(4);
        updPreview();
        if (j >= 0) focusHole(j);
        toast('「〇〇」の所を、自分の言葉に書きかえてください');
      } else if (t.dataset.rw !== undefined) {
        const j = +t.dataset.rw;
        S.critUndo = S.critUndo || {};
        if (S.critUndo[j] === undefined) S.critUndo[j] = d.criteria[j];
        d.criteria[j] = t.dataset.v;
        $('#stepBody').innerHTML = stepHTML(4);
        updPreview();
        focusHole(j);
        toast('置きかえました。選ばれている「〇〇」に、そのまま入力できます');
      }
    });
    body.addEventListener('click', (e) => {
      const u = e.target.closest('[data-ru]');
      if (u) {
        const j = +u.dataset.ru;
        if ((S.critUndo || {})[j] !== undefined) {
          d.criteria[j] = S.critUndo[j];
          delete S.critUndo[j];
          $('#stepBody').innerHTML = stepHTML(4);
          updPreview();
          const x = $('[data-crit="' + j + '"]');
          if (x) x.focus();
          toast('元の文に戻しました');
        }
        return;
      }
      const a = e.target.closest('[data-rma]');
      if (!a) return;
      d.attachments.splice(+a.dataset.rma, 1);
      $('#attL').innerHTML = attHtml();
      saveDraftSoon();
    });
    const att = $('#att');
    if (att)
      att.addEventListener('change', (e) => {
        Array.from(e.target.files).forEach((f) => d.attachments.push({ name: f.name, size: f.size }));
        e.target.value = '';
        $('#attL').innerHTML = attHtml();
        saveDraftSoon();
      });
  }
  function updPreview() {
    const d = S.draft,
      j = SF.judge(d),
      m = SF.measure(d),
      dep = SF.deptOf(d.dept),
      tl = SF.toolOf(d.toolRef);
    const crit = d.criteria.filter((x) => x.trim());
    const ul = (a) =>
      a.length
        ? '<ul>' + a.map((x) => '<li>' + E(x) + '</li>').join('') + '</ul>'
        : '<span class="muted">（まだありません）</span>';
    const pv = $('#pv');
    if (!pv) return;
    const card =
      '<dl><dt>件名</dt><dd><b>' +
      (E(d.title) || '<span class="muted">（未入力）</span>') +
      '</b></dd>' +
      '<dt>部署・起票者</dt><dd>' +
      E(dep ? dep.name : '') +
      '　' +
      E(d.applicant) +
      '</dd>' +
      '<dt>カタログ</dt><dd>' +
      (tl ? E(tl.name) + ' ' + sig(tl.c) : '<span class="muted">カタログ外</span>') +
      '</dd>' +
      '<dt>目的</dt><dd>' +
      (E(d.purpose) || '<span class="muted">（未入力）</span>') +
      '</dd>' +
      '<dt>使う人</dt><dd>' +
      ul(d.users) +
      '</dd>' +
      '<dt>作るもの</dt><dd>' +
      ul(SF.lines(d.scope)) +
      '</dd>' +
      '<dt>今回は作らない</dt><dd>' +
      ul(SF.lines(d.outScope)) +
      '</dd>' +
      '<dt>合格の条件</dt><dd>' +
      (crit.length
        ? '<ol style="margin:0;padding-left:18px">' + crit.map((c) => '<li>' + SF.markVague(c) + '</li>').join('') + '</ol>'
        : '<span class="muted">（まだありません）</span>') +
      '</dd>' +
      '<dt>必ず人に聞くこと</dt><dd>' +
      ul(d.approvals || []) +
      '</dd></dl>';
    const x = Object.assign({}, d, { id: d.id || '（受付時に採番）' });
    pv.innerHTML =
      '<div class="card"><div class="pvhead"><div class="light"><span class="g' +
      (j.c === 'g' ? ' on' : '') +
      '"></span><span class="y' +
      (j.c === 'y' ? ' on' : '') +
      '"></span><span class="r' +
      (j.c === 'r' ? ' on' : '') +
      '"></span></div><div><div class="muted" style="font-size:12px">信号の色（判定の候補）</div><b>' +
      sig(j.c) +
      ' ' +
      E(SF.COLORS[j.c].n) +
      '</b><ul class="reasons">' +
      j.reasons
        .slice(0, 4)
        .map((r) => '<li><i class="' + r.c + '"></i>' + E(r.t) + '</li>')
        .join('') +
      '</ul></div></div></div>' +
      '<div class="card meas"><div class="muted" style="font-size:12px">ものさし（参考値）</div><div class="big">' +
      m.hours +
      '<small style="font-size:13px"> 時間／月</small></div>' +
      m.scores
        .map(
          (s) =>
            '<div class="mb"><span>' +
            E(s.l) +
            '</span><span class="b"><i style="width:' +
            s.v * 20 +
            '%"></i></span><b>' +
            (s.v || '－') +
            '</b></div>',
        )
        .join('') +
      '<div class="hint">着手順はこの点数だけでは決めません</div></div>' +
      '<div class="card order"><div class="oh">' +
      ico('i-doc') +
      '注文書プレビュー<span class="sp"></span><span class="tg"><button type="button" data-dp="card" class="' +
      (S.dpTab === 'card' ? 'on' : '') +
      '">カード</button><button type="button" data-dp="yaml" class="' +
      (S.dpTab === 'yaml' ? 'on' : '') +
      '">YAML</button></span></div>' +
      (S.dpTab === 'card' ? card : '<pre class="yaml">' + E(SF.toYAML(x)) + '</pre>') +
      '</div>';
    $$('[data-dp]', pv).forEach((b) =>
      b.addEventListener('click', () => {
        S.dpTab = b.dataset.dp;
        updPreview();
      }),
    );
    saveDraftSoon();
  }
  /* 送信中は操作できないようにする（二重送信の防止）。競合の選択待ちの間も送信しない */
  const inConflict = () => !!S.conflict && S.conflict.draft === S.draft;
  function setWizardBusy(busy) {
    const submitBtn = $('#submit');
    if (submitBtn) submitBtn.disabled = busy || inConflict();
    ['#prev', '#ddraft'].forEach((q) => {
      const el = $(q);
      if (el) el.disabled = busy;
    });
    $$('.stp').forEach((b) => (b.disabled = busy));
  }
  /* ---- 競合（他の人が先に更新）: 差分を見せて、利用者が選ぶまで送らない ---- */
  const CONFLICT_FIELDS = [
    ['title', '件名'],
    ['kind', '依頼の種類'],
    ['dept', '部署'],
    ['applicant', '起票者'],
    ['contact', '連絡先'],
    ['toolRef', '対象の道具'],
    ['problem', '困っていること'],
    ['purpose', '目的'],
    ['users', '使う人'],
    ['people', '人数'],
    ['places', '使う場所'],
    ['scope', '作るもの'],
    ['outScope', '作らないもの'],
    ['criteria', '合格の条件'],
    ['decides', '決める仕事の信号'],
    ['data', '扱うデータ'],
    ['parties', '使う相手'],
    ['constraints', '制約'],
    ['constraintsOther', 'その他の制約'],
    ['approvals', '人の承認'],
    ['freq', '頻度'],
    ['minutes', '1回の時間（分）'],
    ['dataReady', 'データの準備'],
    ['spread', '広がり'],
    ['wish', '希望時期'],
    ['approver', '承認者'],
    ['status', '状態'],
  ];
  function conflictValue(key, v) {
    const text = Array.isArray(v)
      ? v
          .map((x) => String(x).trim())
          .filter(Boolean)
          .join('、')
      : v === null || v === undefined
        ? ''
        : String(v).trim();
    if (key === 'status' && text) return SF.statusOf(text).l;
    return text;
  }
  function conflictDiffs(latest, d) {
    return CONFLICT_FIELDS.map(([key, label]) => ({
      label,
      theirs: conflictValue(key, latest[key]),
      mine: conflictValue(key, d[key]),
    })).filter((x) => x.theirs !== x.mine);
  }
  function openConflict(d) {
    S.conflict = { draft: d };
    if (S.draft === d && S.view === 'new') renderWizard();
    if (S.draft === d) writeDraft();
  }
  function renderConflict() {
    if (!inConflict()) return;
    const d = S.draft,
      latest = find(S.editId),
      pane = $('#pane');
    if (!latest || !pane) return;
    const cell = (v) => (v ? E(v) : '<span class="muted">（なし）</span>');
    const rows = conflictDiffs(latest, d);
    pane.insertAdjacentHTML(
      'afterbegin',
      '<div id="conflict" class="card pad" role="alert" style="margin-bottom:12px">' +
        '<b>' +
        ico('i-alert') +
        ' 他の人が先にこの依頼を更新しました</b>' +
        '<p class="muted" style="margin:6px 0">どちらかを選ぶまで、送信しません。</p>' +
        (rows.length
          ? '<table style="width:100%;font-size:13px;border-collapse:collapse"><thead><tr><th style="text-align:left">項目</th><th style="text-align:left">サーバの最新</th><th style="text-align:left">あなたの入力</th></tr></thead><tbody>' +
            rows
              .map(
                (x) =>
                  '<tr><td style="vertical-align:top;white-space:nowrap;padding-right:8px">' +
                  E(x.label) +
                  '</td><td style="vertical-align:top;padding-right:8px">' +
                  cell(x.theirs) +
                  '</td><td style="vertical-align:top">' +
                  cell(x.mine) +
                  '</td></tr>',
              )
              .join('') +
            '</tbody></table>'
          : '<p style="margin:6px 0">内容の項目に差はありません（コメントなどの更新です）。</p>') +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
        '<button class="btn sm pri" id="cfTake" type="button">最新を取り込んで編集し直す</button>' +
        '<button class="btn sm dng" id="cfOverwrite" type="button">自分の内容で上書きする</button>' +
        '</div></div>',
    );
    $('#cfTake').addEventListener('click', () => {
      const cur = find(S.editId);
      if (!cur) return;
      Object.assign(d, JSON.parse(JSON.stringify(cur)));
      if (!d.criteria || !d.criteria.length) d.criteria = [''];
      S.conflict = null;
      renderWizard();
      toast('最新の内容を取り込みました。編集を続けてください');
    });
    $('#cfOverwrite').addEventListener('click', () => {
      const cur = find(S.editId);
      if (!cur) return;
      d.__v = cur.__v;
      d.status = cur.status;
      S.conflict = null;
      renderWizard();
      submit();
    });
  }
  function submitFailed(d, res, extra) {
    if (S.draft !== d) return; // 別の画面へ移ったあと（下書きは一覧から再開できる）
    if (S.view === 'new') {
      if (S.editId) {
        // 状態が変わっていれば、ボタンの表示をサーバの最新に合わせる
        const cur = find(S.editId);
        if (cur && cur.status !== d.status) {
          d.status = cur.status;
          renderWizard();
        }
      }
      showErr([res.error || '保存できませんでした'].concat(extra || []));
    }
    writeDraft();
  }
  /* 成功したときだけ呼ぶ。入力を破棄して依頼の詳細へ */
  function leaveWizardAfterSave(d, id) {
    S.submitting = false;
    if (S.draft !== d) return;
    clearDraft();
    S.draft = null;
    S.editId = null;
    if (S.view !== 'new') return;
    go('board');
    openDrawer(id);
  }
  async function submitEdit(d) {
    const k = S.data.items.findIndex((x) => x.id === S.editId);
    if (k < 0) {
      clearDraft();
      S.draft = null;
      S.editId = null;
      S.submitting = false;
      go('home');
      return toast('編集していた依頼が見つかりません（削除された可能性があります）', true);
    }
    // 下書きには手を付けない。状態・履歴・コメントはいまの依頼のものを使う（下書きの時点の値で戻さない）
    const cur = S.data.items[k],
      now = SF.nowISO();
    // 編集を始めた版と違う（再読込で base が最新になった場合を含む）なら、送らずに選んでもらう
    if (d.__v && cur.__v && d.__v !== cur.__v) return openConflict(d);
    const rec = JSON.parse(JSON.stringify(d));
    delete rec.__ticket;
    delete rec.__origin;
    rec.criteria = rec.criteria.map((x) => x.trim()).filter(Boolean);
    rec.status = cur.status;
    rec.signalFinal = cur.signalFinal;
    rec.history = JSON.parse(JSON.stringify(cur.history));
    rec.comments = JSON.parse(JSON.stringify(cur.comments || []));
    rec.updatedAt = now;
    rec.history.push({ at: now, by: me().name, role: me().l, action: '内容を編集', note: '' });
    const resub = cur.status === 'back' && SF.canMoveR(S.role, rec, 'received', me().name);
    const before = cur.status;
    S.data.items[k] = rec;
    const res = resub ? await applyStatus(rec, 'received', '', '再提出（指摘に合わせて内容を直しました）') : await persist();
    if (coreFailed(res, rec.id)) {
      const failure = (res.failures || []).find((f) => f.id === rec.id || f.serverId === rec.id);
      if (failure && failure.code === 'ERR-301') {
        openConflict(d);
        if (S.draft === d && S.view === 'new') showErr([res.error]);
        return;
      }
      // 競合ではない失敗。途中まで進んだ分（PATCH 成功）は自分の更新なので、基準の版を進める
      const latest = find(rec.id);
      if (latest) d.__v = latest.__v;
      return submitFailed(d, res);
    }
    const id = rec.id;
    addAudit('内容を編集', id, '');
    // 承認後の編集でサーバが承認待ちへ戻したら、パイプラインも最初へ戻す
    const p = O().pipes[id];
    if (p && before !== 'wait' && rec.status === 'wait' && p.step < 12) {
      p.step = 1;
      p.esc = '';
    }
    persist();
    toast(id + (resub ? ' を直して再提出しました' : ' を更新しました'));
    leaveWizardAfterSave(d, id);
  }
  /*
   * 新規登録の送信札（下書きと一緒に保存し、再読込しても残す）。
   * - 結果不明（unknown）: サーバの確定した応答がない場合だけ。同じキーと同じ本文で照合し、成功したら更新の経路へ進む
   * - サーバで作られたと分かったら（serverId）、以後は作らずに更新する
   * - 札の解放（unknown を外す）の規則は submitFailureKind を参照。解放後に入力が変わっていれば、新しいキーで送る
   * サーバは本文の検証を Idempotency-Key の照合より先に行うので、同じ本文の照合が 400 なら最初の POST も確定していない。
   */
  function submitFailureKind(f) {
    const status = f.status || 0;
    // 通信断・タイムアウト・中継の応答、JSON でない 5xx: サーバの確定した応答がない
    if (!status || status === 408 || [502, 503, 504].includes(status) || (status >= 500 && !f.code)) return 'unknown';
    // セッション・権限・混雑: 本文を検証していない。結果不明の札は解放しない
    if ([401, 403, 429].includes(status)) return 'unverified';
    // アプリが JSON で答えた 4xx / 500: 確定した失敗
    return 'rejected';
  }
  function draftJson(d) {
    const c = Object.assign({}, d);
    delete c.__ticket;
    return JSON.stringify(c);
  }
  function ticketFor(d) {
    const json = draftJson(d);
    const t = d.__ticket;
    if (t && (t.json === json || t.unknown || t.serverId)) return t;
    d.__ticket = { json, id: SF.nextId(S.data), key: newLocalKey(), first: null, unknown: false, serverId: null };
    return d.__ticket;
  }
  async function submitNew(d) {
    const now = SF.nowISO(),
      t = ticketFor(d),
      rec = JSON.parse(JSON.stringify(d));
    delete rec.__ticket;
    delete rec.__origin;
    rec.criteria = rec.criteria.map((x) => x.trim()).filter(Boolean);
    rec.updatedAt = now;
    const existing = t.serverId ? find(t.serverId) : null;
    let verifying = false; // 結果が不明な送信を照合している最中か
    if (existing) {
      // 前回の送信で依頼はできている。作り直さず、同じ依頼を更新する
      rec.id = existing.id;
      rec.createdAt = existing.createdAt;
      rec.status = existing.status;
      rec.signalFinal = existing.signalFinal;
      rec.history = JSON.parse(JSON.stringify(existing.history));
      rec.comments = JSON.parse(JSON.stringify(existing.comments || []));
      S.data.items[S.data.items.indexOf(existing)] = rec;
    } else {
      rec.id = t.id;
      rec.createdAt = now;
      rec.status = 'received';
      rec.history = [{ at: now, by: d.applicant, role: me().l, action: '受付', note: '依頼を登録しました' }];
      verifying = t.unknown;
      if (t.first) rec.__postAs = t.first;
      else t.first = JSON.parse(JSON.stringify(rec));
      // 再読込で同じ番号が一覧に現れていても、照合が済むまでは仮の番号で扱う（行を重ねない）
      if (find(t.id)) rec.id = 'LOCAL-' + t.key;
      rec.__idem = t.key;
      t.unknown = true;
      S.data.items.push(rec);
    }
    // 送る前に札を端末へ残す（応答を受け取る前に閉じられても、再送で照合できる）
    if (S.draft === d) writeDraft();
    const localId = rec.id;
    const res = await persist();
    if (coreFailed(res, localId)) {
      const failure = (res.failures || []).find((f) => f.id === localId) || {};
      if (failure.stage && failure.stage !== 'create') {
        t.serverId = failure.serverId;
        t.unknown = false;
        return submitFailed(d, res, ['依頼は ' + t.serverId + ' として登録済みです。もう一度送ると、この依頼を更新します']);
      }
      const kind = submitFailureKind(failure);
      if (kind === 'rejected' || (kind === 'unverified' && !verifying)) t.unknown = false;
      // 照合で解放され、入力がすでに直されているなら、直した本文で続けて送る（どの経路でも止まらない）
      if (verifying && !t.unknown && S.draft === d && draftJson(d) !== t.json) return submitNew(d);
      return submitFailed(d, res);
    }
    // 受付番号はサーバの値を正とする（別の端末と番号が重なると、サーバが別の番号を振る）
    const id = (res.ids && res.ids[localId]) || rec.id;
    addAudit('受付', id, '依頼を登録しました');
    if (d.__origin) linkRequestOrigin(d.__origin, id);
    persist();
    S.fresh = id;
    const stayed = S.draft === d;
    if (stayed) {
      clearDraft();
      S.draft = null;
    }
    S.submitting = false;
    const sp = $('#stamp');
    $('#stampNo').textContent = id;
    $('#stampDate').textContent = SF.fmt(now, false);
    sp.classList.add('show');
    const h = $('.hanko', sp);
    h.style.animation = 'none';
    void h.offsetWidth;
    h.style.animation = '';
    setTimeout(
      () => {
        sp.classList.remove('show');
        if (stayed && S.view === 'new') go('board');
        toast('受け付けました（' + id + '）');
      },
      reduce ? 300 : 1500,
    );
  }
  async function submit() {
    if (S.submitting || inConflict()) return;
    for (let i = 0; i < STEPS.length; i++) {
      const e = validate(i);
      if (e.length) {
        S.step = i;
        renderWizard();
        showErr(e);
        return;
      }
    }
    const d = S.draft;
    S.submitting = true;
    setWizardBusy(true);
    try {
      await (S.editId ? submitEdit(d) : submitNew(d));
    } finally {
      S.submitting = false;
      if (S.view === 'new' && S.draft) setWizardBusy(false);
    }
  }

  /* ---- board ---- */
  function renderBoard() {
    const flow = SF.STATUSES.filter((s) => s.flow),
      side = SF.STATUSES.filter((s) => !s.flow);
    const isMine = (r) => !!SF.turnOf(S.role, r, me().name);
    const items = S.data.items.filter((r) => (!S.fd || r.dept === S.fd) && (!S.bmine || isMine(r)));
    const card = (r) => {
      const c = colorOf(r),
        d = SF.deptOf(r.dept),
        nx = SF.nextOf(r),
        mine = isMine(r);
      const act = nx
        ? SF.canMoveR(S.role, r, nx, me().name)
          ? '<button type="button" class="kn" data-nx="' +
            E(r.id) +
            '" title="「' +
            E(SF.statusOf(nx).l) +
            '」へ進める">' +
            ico('i-arrow') +
            E(SF.statusOf(nx).l) +
            'へ</button>'
          : '<span class="kw">次は' + E(nextWho(r)) + '</span>'
        : '';
      return (
        '<div class="kc ' +
        c +
        (S.fresh === r.id ? ' new' : '') +
        (mine ? ' mine' : '') +
        '" draggable="true" data-id="' +
        E(r.id) +
        '" tabindex="0">' +
        (mine ? '<span class="myt">あなたの番</span>' : '') +
        '<span class="no">' +
        E(r.id) +
        '</span><b>' +
        E(r.title) +
        '</b><div class="meta">' +
        sig(c) +
        (r.signalFinal ? '' : '<span>候補</span>') +
        '<span>・' +
        E(d ? d.short : '') +
        '</span><span>・' +
        SF.measure(r).hours +
        'h/月</span></div>' +
        (act || stay(r) ? '<div class="kf">' + stay(r) + act + '</div>' : '') +
        '</div>'
      );
    };
    const col = (s, cls) => {
      const a = items.filter((r) => r.status === s.k);
      return (
        '<div class="col ' +
        (cls || '') +
        '" data-st="' +
        s.k +
        '"><h4>' +
        st(s.k) +
        '<em>' +
        a.length +
        '</em></h4>' +
        a.map(card).join('') +
        '</div>'
      );
    };
    $('#view').innerHTML =
      '<div class="btool"><h2 class="h2" style="margin:0">' +
      ico('i-board') +
      'ボード</h2><span class="muted" style="font-size:12.5px">カードの「→」ボタンで次へ進められます（ドラッグでも可・役割による制限あり）。カードを押すと詳細。</span><span class="sp"></span>' +
      '<label class="tgl"><input type="checkbox" id="bmine"' +
      (S.bmine ? ' checked' : '') +
      '> あなたの番だけ</label>' +
      '<select id="bfd" style="width:auto"><option value="">すべての部署</option>' +
      CATALOG.map(
        (c) => '<option value="' + c.id + '"' + (S.fd === c.id ? ' selected' : '') + '>' + E(c.name) + '</option>',
      ).join('') +
      '</select>' +
      '<button class="btn go" id="bnew" type="button">' +
      ico('i-plus') +
      '新しい依頼</button></div>' +
      '<div class="board" id="board">' +
      flow.map((s) => col(s)).join('') +
      side.map((s) => col(s, 'side')).join('') +
      '</div>';
    S.fresh = null;
    $('#bnew').addEventListener('click', startNew);
    $('#bfd').addEventListener('change', (e) => {
      S.fd = e.target.value;
      renderBoard();
    });
    $('#bmine').addEventListener('change', (e) => {
      S.bmine = e.target.checked;
      renderBoard();
    });
    $$('.kn').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const r = find(b.dataset.nx);
        if (r) advance(r);
      }),
    );
    let dragId = null;
    $$('.kc').forEach((k) => {
      k.addEventListener('click', () => openDrawer(k.dataset.id));
      k.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === k) {
          e.preventDefault();
          openDrawer(k.dataset.id);
        }
      });
      k.addEventListener('dragstart', (e) => {
        dragId = k.dataset.id;
        k.classList.add('drag');
        try {
          e.dataTransfer.setData('text/plain', dragId);
          e.dataTransfer.effectAllowed = 'move';
        } catch (_) {}
      });
      k.addEventListener('dragend', () => k.classList.remove('drag'));
    });
    $$('.col').forEach((c) => {
      c.addEventListener('dragover', (e) => {
        e.preventDefault();
        c.classList.add('over');
      });
      c.addEventListener('dragleave', () => c.classList.remove('over'));
      c.addEventListener('drop', (e) => {
        e.preventDefault();
        c.classList.remove('over');
        const r = find(dragId);
        if (!r) return;
        const to = c.dataset.st;
        if (r.status === to) return;
        if (!SF.canMoveR(S.role, r, to, me().name)) return toast(SF.whyNotR(S.role, r, to, me().name), true);
        openStatus(r, to);
      });
    });
  }

  /* ---- list ---- */
  function renderList() {
    const q = S.fq.toLowerCase();
    const a = S.data.items
      .filter(
        (r) =>
          (S.showCancel || S.fs === 'cancel' || r.status !== 'cancel') &&
          (!S.fd || r.dept === S.fd) &&
          (!S.fs || r.status === S.fs) &&
          (!S.fc || colorOf(r) === S.fc) &&
          (!q || [r.id, r.title, r.applicant, r.problem, r.purpose].join(' ').toLowerCase().includes(q)),
      )
      .sort((x, y) => (x.id < y.id ? 1 : -1));
    $('#view').innerHTML =
      '<div class="btool"><h2 class="h2" style="margin:0">' +
      ico('i-list') +
      '一覧</h2><span class="sp"></span><label class="tgl"><input type="checkbox" id="lcan"' +
      (S.showCancel ? ' checked' : '') +
      '> 取消も表示</label><button class="btn sm" id="lcsv" type="button">' +
      ico('i-down') +
      'CSV</button><button class="btn sm" id="ljson" type="button">' +
      ico('i-down') +
      'JSON</button></div>' +
      '<div class="fbar"><input type="search" id="lq" placeholder="キーワード（件名・起票者・内容）" value="' +
      E(S.fq) +
      '">' +
      '<select id="ld"><option value="">すべての部署</option>' +
      CATALOG.map(
        (c) => '<option value="' + c.id + '"' + (S.fd === c.id ? ' selected' : '') + '>' + E(c.name) + '</option>',
      ).join('') +
      '</select>' +
      '<select id="ls"><option value="">すべての状態</option>' +
      SF.STATUSES.map((s) => '<option value="' + s.k + '"' + (S.fs === s.k ? ' selected' : '') + '>' + E(s.l) + '</option>').join(
        '',
      ) +
      '</select>' +
      '<select id="lc"><option value="">すべての色</option>' +
      ['g', 'y', 'r']
        .map((c) => '<option value="' + c + '"' + (S.fc === c ? ' selected' : '') + '>' + SF.COLORS[c].l + '</option>')
        .join('') +
      '</select></div>' +
      '<div class="card tw"><table class="t"><thead><tr><th>受付番号</th><th>件名</th><th>部署</th><th>起票者</th><th>信号</th><th>状態</th><th>滞留</th><th>次は</th><th>削減見込み</th><th>更新</th></tr></thead><tbody id="ltb">' +
      (a.length
        ? a
            .map((r) => {
              const d = SF.deptOf(r.dept),
                mine = SF.turnOf(S.role, r, me().name);
              return (
                '<tr data-id="' +
                E(r.id) +
                '"' +
                (mine ? ' class="mine"' : '') +
                '><td style="font-family:ui-monospace,Consolas,monospace;white-space:nowrap">' +
                E(r.id) +
                '</td><td><b>' +
                E(r.title) +
                '</b></td><td>' +
                E(d ? d.short : '') +
                '</td><td>' +
                E(r.applicant) +
                '</td><td>' +
                sig(colorOf(r)) +
                '</td><td>' +
                st(r.status) +
                '</td><td style="white-space:nowrap">' +
                (stay(r) || '<span class="muted">－</span>') +
                '</td><td style="white-space:nowrap">' +
                (mine
                  ? '<span class="myt">あなたの番</span>'
                  : SF.ENDED.includes(r.status)
                    ? '<span class="muted">－</span>'
                    : E(nextWho(r))) +
                '</td><td>' +
                SF.measure(r).hours +
                ' h/月</td><td style="white-space:nowrap">' +
                E(SF.fmt(r.updatedAt)) +
                '</td></tr>'
              );
            })
            .join('')
        : '<tr><td colspan="10" class="muted" style="text-align:center;padding:30px">条件に合う依頼がありません</td></tr>') +
      '</tbody></table></div><p class="hint">' +
      a.length +
      ' 件 ／ 全 ' +
      S.data.items.length +
      ' 件</p>';
    const re = () => {
      const p = $('#lq').selectionStart;
      renderList();
      const x = $('#lq');
      x.focus();
      try {
        x.setSelectionRange(p, p);
      } catch (_) {}
    };
    $('#lq').addEventListener('input', (e) => {
      S.fq = e.target.value;
      re();
    });
    $('#ld').addEventListener('change', (e) => {
      S.fd = e.target.value;
      renderList();
    });
    $('#ls').addEventListener('change', (e) => {
      S.fs = e.target.value;
      renderList();
    });
    $('#lc').addEventListener('change', (e) => {
      S.fc = e.target.value;
      renderList();
    });
    $('#lcan').addEventListener('change', (e) => {
      S.showCancel = e.target.checked;
      renderList();
    });
    $$('#ltb tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openDrawer(tr.dataset.id)));
    $('#lcsv').addEventListener('click', () =>
      SF.download('受付一覧_' + ymd() + '.csv', SF.toCSV(a), 'text/csv')
        ? toast('CSVを書き出しました')
        : toast('書き出せませんでした', true),
    );
    $('#ljson').addEventListener('click', exportJSON);
  }
  const ymd = () => {
    const d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  };
  function exportJSON() {
    addAudit('JSONを書き出し', 'データ', S.data.items.length + '件');
    persist();
    SF.download('受付データ_' + ymd() + '.json', JSON.stringify(S.data, null, 2), 'application/json')
      ? toast('JSONを書き出しました')
      : toast('書き出せませんでした', true);
  }

  /* ---- 監査ログ（サーバ・管理者のみ） ---- */
  async function loadAuditBox() {
    const el = $('#auditbox');
    if (!el) return;
    const msf = window.__MSF__;
    const title = '<h2 class="h2">' + ico('i-shield') + '監査ログ（サーバ）</h2>';
    if (!msf || !msf.user || !msf.user.isAdmin) {
      el.innerHTML = title + '<p class="muted">管理者だけが見られます。</p>';
      return;
    }
    try {
      const res = await msf.api('GET', '/api/audit-logs?limit=20');
      el.innerHTML =
        title +
        '<p class="hint" style="margin-top:0">追記のみ・ハッシュ連鎖。直近20件を表示します（CSVは最大5000件）。</p>' +
        '<div class="tw"><table class="t"><thead><tr><th>時刻</th><th>操作</th><th>対象</th><th>人</th><th>結果</th></tr></thead><tbody>' +
        ((res && res.items) || [])
          .map(
            (a) =>
              '<tr><td>' +
              E(SF.fmt(a.at)) +
              '</td><td>' +
              E(a.action) +
              '</td><td>' +
              E(a.target_type) +
              (a.target_id ? ' ' + E(a.target_id) : '') +
              '</td><td>' +
              E(a.actor) +
              '</td><td>' +
              E(a.result) +
              '</td></tr>',
          )
          .join('') +
        '</tbody></table></div>' +
        '<div class="data-row" style="margin-top:10px"><a class="btn sm" href="/api/audit-logs.csv" download>' +
        ico('i-down') +
        'CSVで書き出す</a></div>';
    } catch (e) {
      el.innerHTML = title + '<p class="muted">取得できませんでした</p>';
    }
  }

  /* ---- data ---- */
  function renderData() {
    $('#view').innerHTML =
      '<div class="two"><div class="card pad"><h2 class="h2">' +
      ico('i-db') +
      'データの保存</h2>' +
      '<p>保存先：<b>' +
      (S.persistent ? 'このブラウザの保存領域（外部には送信しません）' : '一時保存（閉じると消えます）') +
      '</b><br>依頼：<b>' +
      S.data.items.length +
      '</b> 件　運用中の道具：<b>' +
      O().apps.length +
      '</b> 件　監査ログ：<b>' +
      O().audit.length +
      '</b> 件</p>' +
      '<div class="data-row"><button class="btn" id="dj" type="button">' +
      ico('i-down') +
      'JSONで書き出す</button><button class="btn" id="dc" type="button">' +
      ico('i-down') +
      'CSVで書き出す</button><button class="btn" id="di" type="button">' +
      ico('i-up') +
      'JSONを取り込む</button><button class="btn dng" id="dr" type="button">' +
      ico('i-undo') +
      'サンプルに戻す</button></div>' +
      '<p class="hint">JSONには、依頼に加えて運用・DevOps・SecOps のデータ（ops）も入ります。受付ステーション（mirai-construction-sf-intake.html）で書き出した JSON も取り込めます（その場合、運用のデータは空から始まります）。</p></div>' +
      '<div class="card pad"><h2 class="h2">' +
      ico('i-shield') +
      'このサンプルの約束</h2><ul style="margin:0;padding-left:18px">' +
      '<li>インターネットに接続せず、外部のサービスやライブラリを一切読み込みません</li>' +
      '<li>信号の色は「候補」を自動で出しますが、<b>最終決定は承認者</b>が行います</li>' +
      '<li>赤信号の承認には「AIに決めさせない」確認が必要です</li>' +
      '<li>「承認済み」「完了」にできるのは承認者だけです（役割の切り替えは動作確認用）</li>' +
      '<li>書きかけの依頼は、このブラウザの中だけに自動で下書き保存されます（送信はしません）</li>' +
      '<li>受付・相談・承認依頼の入口はここ。正式な判断は対象のPR等に記録する想定です</li>' +
      '<li>依頼は削除せず「取消」にします。操作は監査ログに追記され、あとから書きかえられません</li>' +
      '<li>運用・DevOps・SecOps の数値とできごとは操作確認用の見本で、GitHub・CI・Entra ID にはつながっていません</li></ul></div></div>';
    $('#dj').addEventListener('click', exportJSON);
    $('#dc').addEventListener('click', () =>
      SF.download('受付一覧_' + ymd() + '.csv', SF.toCSV(S.data.items), 'text/csv')
        ? toast('CSVを書き出しました')
        : toast('書き出せませんでした', true),
    );
    $('#di').addEventListener('click', () => $('#importFile').click());
    $('#dr').addEventListener('click', () =>
      confirmBox(
        'サンプルに戻す',
        '登録した内容はすべて消え、最初のサンプルデータに戻ります。よろしいですか？',
        'サンプルに戻す',
        () => {
          const prevOps = S.data.ops;
          S.data = SF.seed();
          const rowIds = S.data.items.map((x) => x.id);
          persist({ deferOps: true }).then((res) => {
            if (res.ok) {
              persist(); // 依頼の同期が成功したので、運用データを送る
              toast('サンプルデータに戻しました');
            } else {
              S.data.ops = prevOps; // 依頼を戻せなかったので、運用データも元のまま
              persist();
              toast('サンプルに戻せませんでした。' + importedNote(res, rowIds), true);
            }
            if (S.view === 'data') renderData();
          });
        },
      ),
    );
    $('#view').insertAdjacentHTML('beforeend', '<div id="auditbox" class="card pad" style="margin-top:16px">読み込み中…</div>');
    loadAuditBox();
  }
  /* 全件置換の失敗時の説明。取消はしないが、既存 ID の行は先に更新されていることがある */
  function importedNote(res, rowIds) {
    const stages = res.stages || {};
    const updated = rowIds.filter((id) => {
      const s = stages[id];
      return s && s.create === 'none' && (s.content === 'ok' || s.transition === 'ok');
    }).length;
    return updated ? '既存の依頼は取り消していませんが、' + updated + ' 件は更新済みです。' : '既存の依頼は取り消していません。';
  }
  $('#importFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const o = JSON.parse(rd.result);
        if (!SF.validImport(o)) throw 0;
        confirmBox(
          'JSONの取り込み',
          o.items.length + ' 件のデータで、いまのデータを置き換えます。よろしいですか？',
          '取り込む',
          () => {
            o.seq = Math.max(o.seq || 0, ...o.items.map((x) => +String(x.id).split('-').pop() || 0));
            const fromIntake = !o.ops;
            if (fromIntake) o.ops = emptyOps(o.items);
            const prevOps = S.data.ops,
              total = o.items.length,
              rowIds = o.items.map((x) => x.id);
            S.data = o;
            persist({ deferOps: true }).then((res) => {
              // 結果の件数で伝える。保存できなかった行は bridge が取り除いている
              const failed = (res.failures || []).filter((f) => f.stage !== 'comment');
              const rows = failed.filter((f) => rowIds.includes(f.id)).length,
                others = failed.length - rows,
                saved = total - rows;
              if (!rows && !others) {
                addAudit('JSONを取り込み', 'データ', total + '件' + (fromIntake ? '（受付ステーションの形式）' : ''));
                persist();
                toast(total + ' 件を取り込みました');
                return go('board');
              }
              // 置き換えは成立していないので、運用データは元のまま。既存の依頼も取り消していない
              S.data.ops = prevOps;
              if (saved) addAudit('JSONを取り込み', 'データ', total + '件中' + saved + '件');
              persist();
              toast(
                total +
                  ' 件中 ' +
                  saved +
                  ' 件を保存しました。' +
                  (rows ? rows + ' 件は保存できませんでした。' : '') +
                  (others ? 'ほかに ' + others + ' 件の保存に失敗しました。' : '') +
                  importedNote(res, rowIds),
                true,
              );
              if (saved) go('board');
              else if (S.view === 'data') renderData();
            });
          },
        );
      } catch (_) {
        toast('このファイルは取り込めません', true);
      }
      e.target.value = '';
    };
    rd.readAsText(f);
  });

  /* ---- drawer ---- */
  function openDrawer(id) {
    S.open = id;
    S.dtab = 'sum';
    renderDrawer();
    $('#drawer').classList.add('show');
    $('#dmask').classList.add('show');
    refreshRequestMail(id);
  }
  function closeDrawer() {
    S.open = null;
    $('#drawer').classList.remove('show');
    $('#dmask').classList.remove('show');
  }
  $('#dmask').addEventListener('click', closeDrawer);
  function renderDrawer() {
    const r = find(S.open);
    if (!r) return closeDrawer();
    const j = SF.judge(r),
      m = SF.measure(r),
      dep = SF.deptOf(r.dept),
      tl = SF.toolOf(r.toolRef);
    const flow = SF.STATUSES.filter((s) => s.flow),
      ci = flow.findIndex((s) => s.k === r.status),
      nx = SF.nextOf(r);
    const canNext = nx && SF.canMoveR(S.role, r, nx, me().name);
    const ul = (a) =>
      a && a.length ? '<ul>' + a.map((x) => '<li>' + E(x) + '</li>').join('') + '</ul>' : '<span class="muted">－</span>';
    const fq = SF.FREQ.find((x) => x.k === r.freq);
    let body = '';
    const turnA = SF.turnOf(S.role, r, me().name);
    const turnBox = turnA
      ? '<div class="box tbox"><h4>' +
        ico('i-flag') +
        'あなたの番です</h4><div>' +
        E(turnA) +
        '　' +
        stay(r, true) +
        '</div>' +
        (S.role === 'requester' && r.status === 'back' && SF.canEdit(S.role, r, me().name)
          ? '<div style="margin-top:8px"><button class="btn sm go" id="tfix" type="button">' +
            ico('i-edit') +
            '指摘を直す（直したら再提出）</button></div>'
          : '') +
        '</div>'
      : nx && !SF.ENDED.includes(r.status)
        ? '<p class="hint" style="margin:0 0 10px">' +
          ico('i-clock') +
          ' 次に動かすのは <b>' +
          E(nextWho(r)) +
          '</b> です（いまの状態になってから ' +
          SF.stayDays(r) +
          ' 日）</p>'
        : '';
    const pp = O().pipes[r.id],
      ap = appByReq(r.id),
      dlLive = !!window.__MSF__ && dlRelevant(r);
    const lineBox =
      pp || ap || dlLive
        ? '<div class="box"><h4>' +
          ico('i-git') +
          '開発ラインと運用</h4>' +
          (dlLive ? dlPanel(r) : '') +
          (pp && !window.__MSF__
            ? '<div>開発ライン：<b>L' +
              pp.step +
              ' ' +
              E(SF.LINE[pp.step]) +
              '</b>　Issue ' +
              (pp.issue ? '#' + pp.issue : '－') +
              '　PR ' +
              (pp.pr ? '#' + pp.pr : '－') +
              '　マージ ' +
              (pp.merged ? E(pp.merged) : '－') +
              (pp.esc ? '　<span class="sv s1">停止中 ' + E(pp.esc) + '</span>' : '') +
              '</div><div class="chks" style="margin-top:6px">' +
              chkChips(r, pp) +
              '</div>'
            : '') +
          (ap
            ? '<div style="margin-top:6px">運用中：<b>' +
              E(ap.id) +
              ' v' +
              E(ap.ver) +
              '</b>（' +
              E(ap.wave) +
              '）　' +
              pill(health(ap).l, health(ap).k) +
              '</div>'
            : '') +
          '<div class="data-row" style="margin-top:8px">' +
          (pp || dlLive
            ? '<button type="button" class="btn sm" data-go="devops|line">' + ico('i-git') + 'DevOps で見る</button>'
            : '') +
          (ap ? '<button type="button" class="btn sm" data-go="ops|apps">' + ico('i-pulse') + '運用で見る</button>' : '') +
          '</div></div>'
        : '';
    const mailBox = r.mail
      ? '<div class="box"><h4>' +
        ico('i-inbox') +
        '承認依頼メール</h4>' +
        '<div>状態：' +
        mailChip(r.mail.status) +
        '　宛先：' +
        E(r.mail.to) +
        (r.mail.sentAt ? '　送信：' + E(SF.fmt(r.mail.sentAt)) : '') +
        '</div>' +
        (r.mail.status === 'failed'
          ? '<div class="hint" style="margin-top:6px">' +
            E(r.mail.lastError || '送信できませんでした') +
            '</div><div style="margin-top:8px"><button class="btn sm pri" id="mretry" type="button">' +
            ico('i-undo') +
            'メールを再送</button></div>'
          : '') +
        (r.mail.status === 'pending' || r.mail.status === 'sending'
          ? '<p class="hint" style="margin:6px 0 0">送信キューに積まれています。少し待つと送信済みになります。</p>'
          : '') +
        '</div>'
      : '';
    if (S.dtab === 'sum')
      body =
        turnBox +
        mailBox +
        lineBox +
        '<div class="box"><h4>' +
        ico('i-flag') +
        '信号の色</h4><div>判定の候補：' +
        sig(j.c) +
        '　承認者の決定：' +
        (r.signalFinal ? sig(r.signalFinal) : '<span class="muted">未決定</span>') +
        '</div><ul class="reasons">' +
        j.reasons.map((x) => '<li><i class="' + x.c + '"></i>' + E(x.t) + '</li>').join('') +
        '</ul></div>' +
        '<div class="box"><h4>' +
        ico('i-inbox') +
        '依頼の中身</h4><dl class="kv">' +
        '<dt>起票者</dt><dd>' +
        E(r.applicant) +
        (r.contact ? '（' + E(r.contact) + '）' : '') +
        '</dd><dt>部署</dt><dd>' +
        E(dep ? dep.name : '') +
        '</dd><dt>依頼区分</dt><dd>' +
        E(r.kind) +
        '</dd>' +
        '<dt>カタログ</dt><dd>' +
        (tl ? E(tl.name) + ' ' + sig(tl.c) : '<span class="muted">カタログ外</span>') +
        '</dd>' +
        '<dt>困っていること</dt><dd>' +
        E(r.problem).replace(/\n/g, '<br>') +
        '</dd><dt>目的</dt><dd>' +
        E(r.purpose).replace(/\n/g, '<br>') +
        '</dd>' +
        '<dt>使う人</dt><dd>' +
        ul(r.users) +
        (r.people ? '<span class="muted">約 ' + E(r.people) + ' 人</span>' : '') +
        '</dd><dt>使う場所</dt><dd>' +
        ul(r.places) +
        '</dd>' +
        '<dt>作るもの</dt><dd>' +
        ul(SF.lines(r.scope)) +
        '</dd><dt>今回は作らない</dt><dd>' +
        ul(SF.lines(r.outScope)) +
        '</dd>' +
        '<dt>合格の条件</dt><dd>' +
        ((r.criteria || []).length
          ? '<ol>' +
            r.criteria
              .map((c) => {
                const L = SF.lint(c),
                  g = SF.suggest(c)[0];
                return (
                  '<li>' +
                  SF.markVague(c) +
                  (L.ok
                    ? ''
                    : ' <small class="rwn">△ 書き直しをおすすめ' +
                      (g ? '：' + E(g.hint) + '（例：' + E(g.ex[0]) + '）' : '') +
                      '</small>') +
                  '</li>'
                );
              })
              .join('') +
            '</ol>'
          : '－') +
        '</dd>' +
        '<dt>扱う情報</dt><dd>' +
        ul((r.data || []).map((k) => (SF.DATA.find((x) => x.k === k) || {}).l)) +
        '</dd><dt>関わる相手</dt><dd>' +
        E(r.parties) +
        '</dd>' +
        '<dt>守ること</dt><dd>' +
        ul((r.constraints || []).concat(SF.lines(r.constraintsOther))) +
        '</dd><dt>必ず人に聞くこと</dt><dd>' +
        ul(r.approvals) +
        '</dd>' +
        '<dt>ものさし</dt><dd><b>' +
        m.hours +
        '</b> 時間／月（' +
        (fq ? E(fq.l) : '－') +
        '・1回' +
        (r.minutes ? E(r.minutes) + '分' : '－') +
        '）</dd>' +
        '<dt>承認者</dt><dd>' +
        E(r.approver) +
        '</dd><dt>希望時期</dt><dd>' +
        E(r.wish || '－') +
        '</dd>' +
        '<dt>添付</dt><dd>' +
        ((r.attachments || []).length
          ? r.attachments.map((a) => '📎 ' + E(a.name)).join('<br>')
          : '<span class="muted">なし</span>') +
        '</dd></dl></div>';
    if (S.dtab === 'yaml')
      body =
        '<div class="box"><h4>' +
        ico('i-doc') +
        '注文書（作業指示書）</h4><p class="hint" style="margin-top:0">AIへ渡す前に、人がレビューします。</p><pre class="yaml" style="max-height:none;border-radius:10px">' +
        E(SF.toYAML(r)) +
        '</pre><div class="data-row" style="margin-top:10px"><button class="btn sm" id="ycp" type="button">' +
        ico('i-copy') +
        'コピー</button><button class="btn sm" id="ydl" type="button">' +
        ico('i-down') +
        'ダウンロード</button></div></div>';
    if (S.dtab === 'log')
      body =
        '<div class="box"><h4>' +
        ico('i-chat') +
        'コメント</h4>' +
        ((r.comments || []).length
          ? r.comments
              .map(
                (c) =>
                  '<div class="cmt"><small>' +
                  E(SF.fmt(c.at)) +
                  '　' +
                  E(c.by) +
                  '</small>' +
                  E(c.text).replace(/\n/g, '<br>') +
                  '</div>',
              )
              .join('')
          : '<p class="muted">まだありません</p>') +
        '<textarea id="ctx" placeholder="コメントを入力" style="margin-top:8px;min-height:70px"></textarea><div style="text-align:right;margin-top:6px"><button class="btn sm pri" id="cad" type="button">' +
        ico('i-chat') +
        'コメントする</button></div></div>' +
        '<div class="box"><h4>' +
        ico('i-clock') +
        '変更履歴</h4><ul class="tl">' +
        r.history
          .slice()
          .reverse()
          .map(
            (h, i) =>
              '<li style="animation-delay:' +
              i * 0.04 +
              's"><b>' +
              E(h.action) +
              '</b><small>' +
              E(SF.fmt(h.at)) +
              '　' +
              E(h.by) +
              '（' +
              E(h.role) +
              '）</small>' +
              (h.note ? '<div>' + E(h.note) + '</div>' : '') +
              '</li>',
          )
          .join('') +
        '</ul></div>';
    $('#drawer').innerHTML =
      '<div class="dh"><div class="r1"><span class="no">' +
      E(r.id) +
      '</span>' +
      st(r.status) +
      sig(colorOf(r)) +
      (r.signalFinal ? '' : '<span class="muted" style="font-size:12px">候補</span>') +
      stay(r, true) +
      '<button class="x" id="dx" type="button" title="閉じる">' +
      ico('i-x') +
      '</button></div>' +
      '<h3>' +
      E(r.title) +
      '</h3><div class="acts">' +
      (nx
        ? '<button class="btn sm go" id="dnext" type="button"' +
          (canNext ? '' : ' disabled title="' + E(SF.whyNotR(S.role, r, nx, me().name)) + '"') +
          '>' +
          ico('i-arrow') +
          '「' +
          E(SF.statusOf(nx).l) +
          '」へ進める</button>'
        : '') +
      '<button class="btn sm" id="dst" type="button">' +
      ico('i-flag') +
      '状態を変更</button>' +
      '<button class="btn sm" id="ded" type="button"' +
      (SF.canEdit(S.role, r, me().name) ? '' : ' disabled title="いまの役割・状態では編集できません"') +
      '>' +
      ico('i-edit') +
      '編集</button>' +
      '<button class="btn sm dng" id="ddl" type="button"' +
      (SF.canMoveR(S.role, r, 'cancel', me().name)
        ? ''
        : ' disabled title="' + E(SF.whyNotR(S.role, r, 'cancel', me().name)) + '"') +
      '>' +
      ico('i-trash') +
      '取消</button></div>' +
      '<div class="prog' +
      (ci < 0 ? ' off' : '') +
      '">' +
      flow.map((s, i) => '<span class="' + (ci < 0 ? '' : i < ci ? 'p' : i === ci ? 'c' : '') + '"></span>').join('') +
      (ci < 0 ? '<span class="c"></span>' : '') +
      '</div><div class="plab"><span>受付</span><span>' +
      (ci < 0 ? E(SF.statusOf(r.status).l) : '') +
      '</span><span>完了</span></div></div>' +
      '<div class="dtabs">' +
      [
        ['sum', '概要'],
        ['yaml', '注文書'],
        ['log', 'コメント・履歴（' + (r.comments || []).length + '）'],
      ]
        .map(
          (t) =>
            '<button type="button" data-dt="' + t[0] + '" class="' + (S.dtab === t[0] ? 'on' : '') + '">' + t[1] + '</button>',
        )
        .join('') +
      '</div>' +
      '<div class="db">' +
      body +
      '</div>';
    $('#dx').addEventListener('click', closeDrawer);
    $$('[data-dt]').forEach((b) =>
      b.addEventListener('click', () => {
        S.dtab = b.dataset.dt;
        renderDrawer();
      }),
    );
    if ($('#dnext')) $('#dnext').addEventListener('click', () => advance(r));
    if ($('#tfix')) $('#tfix').addEventListener('click', () => startEdit(r.id));
    $('#dst').addEventListener('click', () => openStatus(r));
    $('#ded').addEventListener('click', () => startEdit(r.id));
    $('#ddl').addEventListener('click', () => openStatus(r, 'cancel'));
    $$('#drawer [data-go]').forEach((b) =>
      b.addEventListener('click', () => {
        closeDrawer();
        goTo(b.dataset.go.split('|'));
      }),
    );
    if ($('#ycp'))
      $('#ycp').addEventListener('click', () => {
        try {
          navigator.clipboard.writeText(SF.toYAML(r)).then(
            () => toast('コピーしました'),
            () => toast('コピーできませんでした', true),
          );
        } catch (_) {
          toast('コピーできませんでした', true);
        }
      });
    if ($('#ydl'))
      $('#ydl').addEventListener('click', () =>
        SF.download(r.id + '_注文書.yaml', SF.toYAML(r), 'text/yaml')
          ? toast('ダウンロードしました')
          : toast('ダウンロードできませんでした', true),
      );
    if ($('#cad'))
      $('#cad').addEventListener('click', () => {
        const t = $('#ctx').value.trim();
        if (!t) return toast('コメントを入力してください', true);
        const now = SF.nowISO();
        r.comments = r.comments || [];
        r.comments.push({ at: now, by: me().name, text: t });
        r.updatedAt = now;
        persist().then((res) => {
          if (!failedFor(res, r.id)) return toast('コメントしました');
          const c = $('#ctx');
          if (c && !c.value) c.value = t; // 書いた内容を入力欄へ戻す
        });
        renderDrawer();
      });
    if ($('#mretry'))
      $('#mretry').addEventListener('click', async () => {
        try {
          const res = await window.__MSF__.api('POST', '/api/mail/outbox/' + encodeURIComponent(r.mail.id) + '/retry');
          r.mail.status = (res && res.status) || 'sent';
          r.mail.sentAt = SF.nowISO();
          r.mail.lastError = null;
          toast(
            r.mail.status === 'sent' ? '承認依頼メールを再送しました' : '再送しましたが送信できませんでした',
            r.mail.status !== 'sent',
          );
          renderDrawer();
        } catch (e) {
          toast((e && e.message) || '再送できませんでした', true);
        }
      });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('#mmask').classList.contains('show')) closeModal();
      else if (S.open) closeDrawer();
    }
  });

  /* ---- status modal ---- */
  function openStatus(r, preset) {
    const j = SF.judge(r),
      nxk = SF.nextOf(r);
    const others = SF.STATUSES.filter((s) => s.k !== r.status);
    const ok = others.filter((s) => SF.canMoveR(S.role, r, s.k, me().name)),
      ng = others.filter((s) => !SF.canMoveR(S.role, r, s.k, me().name));
    const def = preset && ok.some((s) => s.k === preset) ? preset : ok.some((s) => s.k === nxk) ? nxk : '';
    const pc = SF.precheck(r),
      warns = pc.filter((x) => x.lv === 'w'),
      wk = warns.map((x) => x.k);
    const ngHTML = ng.length
      ? '<details class="whynot"' +
        (ok.length ? '' : ' open') +
        '><summary>選べない状態（' +
        ng.length +
        '）とその理由</summary><ul>' +
        ng
          .map((s) => {
            const who = SF.whoCan(r.status, s.k);
            return (
              '<li>' +
              st(s.k) +
              '<span>' +
              E(SF.whyNotR(S.role, r, s.k, me().name)) +
              (who.length ? '<small>できる人：' + E(who.join('・')) + '</small>' : '') +
              '</span></li>'
            );
          })
          .join('') +
        '</ul></details>'
      : '';
    modal(
      ico('i-flag') + '状態を変更　<span class="muted" style="font-size:12.5px">' + E(r.id) + '</span>',
      '<p style="margin:0 0 10px">いま：' +
        st(r.status) +
        ' ' +
        stay(r, true) +
        '　操作する人：<b>' +
        E(me().name) +
        '</b>（' +
        E(me().l) +
        '）</p>' +
        (ok.length
          ? '<div class="stopts">' +
            ok
              .map(
                (s) =>
                  '<label><input type="radio" name="ns" value="' +
                  s.k +
                  '"' +
                  (s.k === def ? ' checked' : '') +
                  '>' +
                  st(s.k) +
                  (s.k === nxk ? '<small class="nxl">次の段階</small>' : '') +
                  '</label>',
              )
              .join('') +
            '</div>'
          : '<div class="nopt">' +
            ico('i-alert') +
            ' いまの役割（' +
            E(SF.roleShort(S.role)) +
            '）では、この依頼の状態は変えられません。' +
            (nxk && !SF.ENDED.includes(r.status) ? '次に動かすのは <b>' + E(nextWho(r)) + '</b> です。' : '') +
            '</div>') +
        ngHTML +
        '<div id="apv" class="apv" style="display:none">' +
        '<div class="pchk"><b>' +
        ico('i-shield') +
        '承認前チェック（自動）</b><ul>' +
        pc.map((x) => '<li class="' + x.lv + '">' + (x.lv === 'w' ? '△' : '✓') + ' ' + E(x.t) + '</li>').join('') +
        '</ul>' +
        (warns.length
          ? '<label class="pcok"><input type="checkbox" id="pcok"> 上の △ ' +
            warns.length +
            ' 件を確認しました（直してほしい点があれば「差戻し」を選びます）</label>'
          : '<div class="hint" style="margin:6px 0 0">注意点は見つかりませんでした。</div>') +
        '</div>' +
        '<b>信号の色を決める</b> <span class="muted" style="font-size:12.5px">（候補：' +
        sig(j.c) +
        '。迷ったら1つ上の色）</span>' +
        '<div class="chips" style="margin-top:8px">' +
        ['g', 'y', 'r']
          .map(
            (c) =>
              '<label class="chip" style="cursor:pointer"><input type="radio" name="fc" value="' +
              c +
              '"' +
              ((r.signalFinal || j.c) === c ? ' checked' : '') +
              ' style="margin:0 4px 0 0">' +
              sig(c) +
              '</label>',
          )
          .join('') +
        '</div>' +
        '<div class="loww" id="loww">' +
        ico('i-alert') +
        ' 候補（' +
        SF.COLORS[j.c].l +
        '）より<b>ゆるい色</b>にします。理由をメモに書いてください。</div>' +
        '<div class="redw" id="redw"><label><input type="checkbox" id="redok"> 赤信号の仕事は<b>AIに決めさせません</b>。道具の範囲が「材料集め・表示」までで、決定は人が行うことを確認しました。</label></div></div>' +
        '<div id="rel" class="apv" style="display:none"><div class="pchk"><b>' +
        ico('i-rocket') +
        'リリース判定（公開承認・G4 を道具ごとに読みかえ）</b><p class="hint" style="margin:4px 0 6px">マージとは別のリスク判断です。重大な不具合（GC-43）と権限・隔離（GC-44）は条件付きにしません。</p>' +
        SF.RELCHECK.map(
          (x, i) =>
            '<label class="rc"><input type="checkbox" data-rc="' +
            i +
            '"> ' +
            E(x.t) +
            ' <small class="muted">' +
            E(x.gc) +
            (x.hard ? '・条件付き不可' : '') +
            '</small></label>',
        ).join('') +
        '</div>' +
        '<div class="grid2"><div><label class="fl">公開の範囲</label><select id="rwave"><option>第1弾</option><option>第2弾</option><option>第3弾</option><option>全社</option></select></div><div><label class="fl">変更の種類</label><select id="rtype"><option>通常</option><option>緊急</option></select></div></div>' +
        '<p class="hint" style="margin:6px 0 0">承認すると、デプロイジョブが承認済みの成果物だけを本番へ配備し、運用の台帳に登録します（版：' +
        E(appByReq(r.id) ? 'v' + SF.bumpVer(appByReq(r.id).ver) : 'v1.0.0') +
        '）。</p></div>' +
        (ok.length
          ? '<label class="fl" for="nnote">メモ<span class="muted" id="nreq" style="font-weight:400;font-size:12px"></span></label><div class="tpl" id="tpl"></div><textarea id="nnote" style="min-height:70px" placeholder="理由や連絡事項"></textarea>'
          : ''),
      ok.length
        ? '<button class="btn" data-x type="button">キャンセル</button><button class="btn pri" id="sok" type="button">' +
            ico('i-check') +
            '変更する</button>'
        : '<button class="btn pri" data-x type="button">閉じる</button>',
    );
    if (!ok.length) return;
    const val = (n) => ($('#modal input[name=' + n + ']:checked') || {}).value;
    const lower = (fc) => fc && SF.RANK[fc] < SF.RANK[j.c];
    let lastV = null;
    const upd = () => {
      const v = val('ns'),
        fc = val('fc');
      $('#apv').style.display = v === 'approved' ? 'block' : 'none';
      $('#rel').style.display = v === 'done' ? 'block' : 'none';
      $('#redw').classList.toggle('show', v === 'approved' && fc === 'r');
      $('#loww').classList.toggle('show', v === 'approved' && lower(fc));
      const need = ['back', 'hold', 'cancel'].includes(v) || (v === 'approved' && lower(fc));
      $('#nreq').textContent = need ? '（必須）' : '（任意）';
      $('#nnote').placeholder =
        v === 'back'
          ? '直してほしい点を書いてください（下の候補を押すと入ります）'
          : v === 'hold'
            ? '見送る理由を書いてください'
            : v === 'cancel'
              ? '取り消す理由を書いてください（記録は消えません）'
              : '理由や連絡事項';
      if (v === lastV) return;
      lastV = v;
      const key = v === 'received' && r.status !== 'back' ? '' : v;
      const tp = SF.REASONS[key] || [];
      $('#tpl').innerHTML = tp.length
        ? '<div class="hint" style="margin:0 0 4px">よく使う理由（押すとメモに入ります）</div>' +
          tp
            .map((x) => {
              const rec = x.k && wk.includes(x.k);
              return (
                '<button type="button" class="tplb' +
                (rec ? ' rec' : '') +
                '" data-t="' +
                E(x.t) +
                '">' +
                (rec ? '<em>おすすめ</em>' : '') +
                E(x.t) +
                '</button>'
              );
            })
            .join('')
        : '';
      $$('#tpl .tplb').forEach((b) =>
        b.addEventListener('click', () => {
          const n = $('#nnote');
          if (n.value.includes(b.dataset.t)) return;
          n.value = n.value.trim() ? n.value.replace(/\s+$/, '') + '\n' + b.dataset.t : b.dataset.t;
          b.classList.add('used');
          n.focus();
        }),
      );
    };
    $$('#modal input[name=ns], #modal input[name=fc]').forEach((x) => x.addEventListener('change', upd));
    upd();
    let sending = false;
    $('#sok').addEventListener('click', async () => {
      if (sending) return;
      const v = val('ns'),
        note = $('#nnote').value.trim();
      if (!v) return toast('変更先を選んでください', true);
      if (['back', 'hold', 'cancel'].includes(v) && !note)
        return toast('理由をメモに書いてください（候補を押すと入ります）', true);
      const mb = mergeBlock(r, v);
      if (mb) return toast(mb, true);
      let extra = '';
      if (v === 'done') {
        if ($$('#modal [data-rc]').some((x) => !x.checked))
          return toast('リリース判定のチェックをすべて確認してください（GC-43・GC-44 は条件付きにできません）', true);
        const opt = { wave: $('#rwave').value, type: $('#rtype').value };
        if (!(await applyInDialog('done', note, '公開を承認（リリース判定のチェックをすべて確認）／公開範囲：' + opt.wave)))
          return;
        if (window.__MSF__) {
          closeModal();
          refresh();
          return toast(r.id + ' を完了にしました（配備は未接続のため、運用の台帳には登録しません）');
        }
        const a = releaseDeploy(r, opt);
        persist();
        closeModal();
        refresh();
        return toast(r.id + ' を公開しました（' + a.id + ' v' + a.ver + '・' + opt.wave + '）。運用の台帳に登録しました');
      }
      if (v === 'approved') {
        const fc = val('fc');
        if (!fc) return toast('信号の色を選んでください', true);
        if (warns.length && !$('#pcok').checked) return toast('承認前チェックの △ を確認して、チェックを入れてください', true);
        if (fc === 'r' && !$('#redok').checked) return toast('赤信号の確認にチェックしてください', true);
        if (lower(fc) && !note) return toast('候補よりゆるい色にする理由をメモに書いてください', true);
        r.signalFinal = fc;
        extra =
          '信号の色を「' +
          SF.COLORS[fc].l +
          '」に決定' +
          (fc !== j.c ? '（候補は「' + SF.COLORS[j.c].l + '」）' : '') +
          (warns.length ? '／承認前チェック △' + warns.length + '件を確認' : '');
      }
      if (!(await applyInDialog(v, note, extra))) return;
      closeModal();
      toast(r.id + ' を「' + SF.statusOf(v).l + '」にしました');
      refresh();
    });
    /* 保存の結果を待つ。失敗したらダイアログとメモを残し、もう一度押せるようにする */
    async function applyInDialog(v, note, extra) {
      const btn = $('#sok');
      sending = true;
      btn.disabled = true;
      const res = await applyStatus(r, v, note, extra);
      sending = false;
      btn.disabled = false;
      return !coreFailed(res, r.id);
    }
  }

  /* =====================================================================
     リリース後の管理（運用）・DevOps・SecOps
     ===================================================================== */
  const O = () => S.data.ops;
  const appOf = (id) => O().apps.find((a) => a.id === id);
  const appByReq = (id) => O().apps.find((a) => a.req === id);
  const RO = SF.ROLE_SIG;
  const CAN = {
    incCreate: ['ops', 'sec', 'desk'],
    incUpdate: ['ops', 'sec'],
    rollback: ['ops'],
    fbToReq: ['desk', 'ops'],
    pipeIssue: ['desk'],
    pipeRun: ['desk', 'ops'],
    merge: ['approver'],
    stagingOk: ['desk'],
    chgCreate: ['desk', 'ops', 'sec'],
    chgApply: ['desk', 'ops'],
    vulnWork: ['sec'],
    vulnFix: ['sec', 'ops'],
    secTriage: ['sec'],
    access: ['sec'],
    control: ['sec', 'admin'],
    auditExport: ['auditor', 'admin', 'sec'],
    tamperDemo: ['auditor', 'admin'],
  };
  const can = (k) => (CAN[k] || []).includes(S.role);
  const who = (k) => (CAN[k] || []).map((r) => RO[r]).join('・');
  const btn = (k, id, label, icon, cls, extra) =>
    can(k)
      ? '<button type="button" class="btn sm ' +
        (cls || '') +
        '" data-act="' +
        id +
        '"' +
        (extra || '') +
        '>' +
        (icon ? ico(icon) : '') +
        E(label) +
        '</button>'
      : '<button type="button" class="btn sm" disabled title="' +
        E(who(k)) +
        'が操作します">' +
        (icon ? ico(icon) : '') +
        E(label) +
        '</button>';
  const mono = (t) => '<span class="mono">' + E(t) + '</span>';
  const ymdOf = (iso) => (iso ? SF.fmt(iso, false) : '－');
  const minsBetween = (a, b) => Math.max(0, Math.round((new Date(b || SF.nowISO()).getTime() - new Date(a).getTime()) / 60000));
  const dur = (m) =>
    m < 60
      ? m + '分'
      : m < 60 * 48
        ? Math.floor(m / 60) + '時間' + (m % 60 ? (m % 60) + '分' : '')
        : Math.floor(m / 1440) + '日' + Math.floor((m % 1440) / 60) + '時間';
  const sevChip = (s) => '<span class="sv ' + s.toLowerCase() + '">' + E(SF.SEV[s].l) + '</span>';
  const vsevChip = (s) =>
    '<span class="sv ' + { crit: 's1', high: 's2', mid: 's3', low: 's4' }[s] + '">' + E(SF.VSEV[s].l) + '</span>';
  const pill = (t, k) =>
    '<span class="hl ' +
    k +
    '">' +
    (k === 'ok' ? ico('i-check') : k === 'ng' ? ico('i-alert') : ico('i-clock')) +
    E(t) +
    '</span>';
  const vtabs = (key, list) =>
    '<div class="vtabs" role="tablist">' +
    list
      .map(
        (t) =>
          '<button type="button" role="tab" data-vt="' +
          key +
          '|' +
          t[0] +
          '" class="' +
          ((S[key] || list[0][0]) === t[0] ? 'on' : '') +
          '">' +
          (t[2] ? ico(t[2]) : '') +
          E(t[1]) +
          (t[3] ? '<em>' + t[3] + '</em>' : '') +
          '</button>',
      )
      .join('') +
    '</div>';
  function bindTabs(fn) {
    $$('[data-vt]').forEach((b) =>
      b.addEventListener('click', () => {
        const [k, v] = b.dataset.vt.split('|');
        S[k] = v;
        fn();
      }),
    );
  }
  const kcard = (l, n, i, u, tone) =>
    '<div class="card kpi' +
    (tone ? ' ' + tone : '') +
    '"><div class="t">' +
    ico(i) +
    E(l) +
    '</div><div class="n"><span>' +
    n +
    '</span><small>' +
    (u || '') +
    '</small></div></div>';

  function addAudit(action, target, detail, actor) {
    const o = O();
    if (!o) return;
    const prev = o.audit.length ? o.audit[o.audit.length - 1].hash : '00000000';
    const e = {
      at: SF.nowISO(),
      by: actor || me().name,
      role: actor ? 'システム' : me().l,
      action,
      target: target || '',
      detail: detail || '',
    };
    e.no = o.audit.length + 1;
    e.prev = prev;
    e.hash = SF.auditHash(prev, e);
    o.audit.push(e);
  }
  function emptyOps(items) {
    const o = SF.seedOps(items);
    ['apps', 'deploys', 'incidents', 'feedback', 'vulns', 'secEvents', 'findings', 'changes'].forEach((k) => (o[k] = []));
    o.pipes = {};
    o.audit = SF.chainAudit(o.audit.filter((e) => (items || []).some((r) => r.id === e.target)));
    return o;
  }

  /* ---- 健康状態 ---- */
  function health(a) {
    const o = O(),
      why = [];
    const inc = o.incidents.filter((i) => i.app === a.id && i.status !== '完了');
    const vul = o.vulns.filter(
      (v) => v.app === a.id && !['修正済み'].includes(v.status) && !String(v.status).startsWith('リスク受容（期限'),
    );
    const over = vul.filter((v) => SF.daysLeft(SF.dueOf(v)) < 0);
    if (inc.some((i) => ['S1', 'S2'].includes(i.sev) && !i.restored)) {
      why.push('重大・高の障害が復旧していません');
      return { k: 'ng', l: '障害', why };
    }
    if (inc.length) why.push('対応中の障害 ' + inc.length + '件');
    if (a.avail < a.slo) why.push('稼働率が目標（' + a.slo + '%）を下回っています');
    if (over.length) why.push('期限切れの脆弱性 ' + over.length + '件');
    if (vul.some((v) => v.sev === 'crit')) why.push('重大な脆弱性に対応中');
    if (a.spent >= a.budget * 0.8) why.push('月の費用が予算の80%以上');
    return why.length ? { k: 'warn', l: '注意', why } : { k: 'ok', l: '正常', why: ['問題は見つかっていません'] };
  }

  /* ---- 開発ライン（実データ。サーバ接続時だけ使う） ----
     投入は POST /api/orders/:id/handoff。表示は GET /api/requests/:id/jobs の記録だけから作る。
     各項目の区別（実行確認済み／fake／未接続／見本）は runner_kind と証跡の種別で機械的に決める。 */
  const SAMPLE_LOCK =
    '見本の操作は実行できません（サーバ接続時は実依頼の状態を見本で進めません。実行の結果は開発ライン欄の記録だけを表示します）';
  const DL_KIND = {
    ok: { l: '実行確認済み', c: 'ok', m: '✓' },
    fake: { l: 'fake', c: 'fake', m: '△' },
    none: { l: '未接続', c: 'none', m: '－' },
    sample: { l: '見本', c: 'sample', m: '◇' },
  };
  const JOB_STATE_LABEL = {
    queued: '待機',
    planning: '計画中',
    implementing: '実装中',
    verifying: 'CIで検証中',
    revising: '修正中',
    pr_ready: 'PR候補まで完了・人の確認待ち',
    reviewing: '人が確認中',
    approved: '承認',
    merged: 'マージ',
    staged: 'ステージング',
    released: '公開',
    closed: '終了',
    stopped: '停止',
    failed: '失敗',
    cancelled: '中止',
  };
  const DL_LIVE_STATUS = ['approved', 'dev', 'verify', 'field', 'release_wait', 'done'];
  const DL_HANDOFF_ROLES = ['desk', 'approver', 'admin'];
  const DL_ABSENT_ROLES = ['approver', 'admin'];
  const DL_TTL_MS = 5000;
  const dlStates = new Map();
  function dlOf(id) {
    if (!dlStates.has(id)) {
      dlStates.set(id, {
        busy: false,
        loading: false,
        loadP: null,
        loadedAt: 0,
        failed: false,
        items: [],
        handoffs: [],
        evidence: {},
        msg: null,
        absentOpen: false,
        absentReason: '',
        absentChecked: false,
        follow: 0,
      });
    }
    return dlStates.get(id);
  }
  function dlRelevant(r) {
    return DL_LIVE_STATUS.includes(r.status) || r.__issueNo > 0 || !!O().pipes[r.id];
  }
  function dlCurrent(r, s) {
    return s.handoffs.find((h) => h.orderVersion === r.__orderVersion) || null;
  }
  function dlChip(kind) {
    const k = DL_KIND[kind];
    return (
      '<span class="dlk dlk-' +
      k.c +
      '"><span aria-hidden="true">' +
      k.m +
      '</span><span data-dl-kind>' +
      E(k.l) +
      '</span></span>'
    );
  }
  function dlRow(row, label, kind, body) {
    return (
      '<li class="dlrow" data-dl-row="' +
      row +
      '"><span class="dll">' +
      E(label) +
      '</span>' +
      dlChip(kind) +
      '<span class="dlb">' +
      body +
      '</span></li>'
    );
  }
  function dlIssueLink(h) {
    const label = 'Issue #' + E(h.issueNo);
    return /^https?:\/\//.test(h.issueUrl || '')
      ? '<a href="' + E(h.issueUrl) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'
      : label;
  }
  function dlIssueRow(r, s, cur) {
    if (cur && cur.state === 'succeeded') {
      const verb = cur.op === 'update_issue' ? '更新済み' : '作成済み';
      return dlRow(
        'issue',
        '注文書の投入',
        cur.issueSource === 'github' ? 'ok' : 'fake',
        dlIssueLink(cur) + '　版 ' + E(cur.orderVersion) + '（' + verb + '）',
      );
    }
    const older = s.handoffs.find((h) => h.state === 'succeeded');
    if (older) {
      return dlRow(
        'issue',
        '注文書の投入',
        older.issueSource === 'github' ? 'ok' : 'fake',
        dlIssueLink(older) + '　版 ' + E(older.orderVersion) + ' のまま（いまの版 ' + E(r.__orderVersion) + ' は未反映）',
      );
    }
    if (cur && (cur.state === 'unknown' || cur.state === 'sent'))
      return dlRow('issue', '注文書の投入', 'none', '結果不明・要照合');
    if (r.__issueNo > 0) {
      return dlRow('issue', '注文書の投入', 'none', 'Issue #' + E(r.__issueNo) + '（受付の記録のみ。投入の証跡はありません）');
    }
    return dlRow('issue', '注文書の投入', 'none', 'Issue はまだありません');
  }
  function dlJobRows(s) {
    const job = s.items[0];
    if (!job) {
      return (
        dlRow('job', 'ジョブ', 'none', s.failed ? '読み込めませんでした' : 'ジョブはありません') +
        dlRow('plan', '計画・実装', 'none', '実行の記録はありません') +
        dlRow('ci', '自動検査（CI）', 'none', '検査の記録はありません') +
        dlRow('pr', 'PR', 'none', 'PR の記録はありません')
      );
    }
    const ev = s.evidence[job.id] || { attempts: 0, verificationSources: [], hasPrDraft: false };
    const isFake = job.runnerKind === 'fake';
    const ran = ev.attempts > 0;
    const srcs = ev.verificationSources || [];
    // github の記録でも github.com の run でなければ実物として扱わない（判定はサーバ）
    const ciKind = !srcs.length ? 'none' : srcs.includes('fake_ci') || ev.ciSource === 'fake' ? 'fake' : 'ok';
    const isDocker = job.runnerKind === 'docker-claude';
    const realPr = ev.pr || null;
    const note = [
      job.state === 'queued' ? '実行者が動くまで進みません' : '',
      job.stopReason ? '理由：' + job.stopReason : '',
      job.orderCurrent === false ? 'この版はいまは無効です' : '',
    ].filter(Boolean);
    return (
      dlRow(
        'job',
        'ジョブ',
        isFake ? 'fake' : ran ? 'ok' : 'none',
        mono(job.id) +
          '　版 ' +
          E(job.orderVersion) +
          '　<b>' +
          E(JOB_STATE_LABEL[job.state] || job.state) +
          '</b>（' +
          E(job.state) +
          '）' +
          (note.length ? '<br><small>' + E(note.join('／')) + '</small>' : ''),
      ) +
      s.items
        .slice(1)
        .map((o) =>
          dlRow(
            'job-old',
            '前の版のジョブ',
            o.runnerKind === 'fake' ? 'fake' : 'none',
            '版 ' + E(o.orderVersion) + '　' + E(JOB_STATE_LABEL[o.state] || o.state) + '（' + E(o.state) + '）',
          ),
        )
        .join('') +
      dlRow(
        'plan',
        '計画・実装',
        ran ? (isFake ? 'fake' : 'ok') : 'none',
        ran
          ? '実行 ' +
              E(ev.attempts) +
              ' 回' +
              (isFake
                ? '（fake runner。AI は動いていません）'
                : isDocker
                  ? '（docker-claude。隔離したコンテナで AI を実行）'
                  : '') +
              (isDocker && job.costJpy ? '　費用 ' + E(job.costJpy) + ' 円' : '')
          : '実行の記録はありません',
      ) +
      dlRow(
        'ci',
        '自動検査（CI）',
        ciKind,
        ciKind === 'fake'
          ? srcs.includes('fake_ci')
            ? 'fake CI の記録のみ（実 CI ではありません）'
            : 'ローカルの連携先の記録のみ（実 GitHub ではありません）'
          : ciKind === 'ok'
            ? srcs.includes('github')
              ? 'GitHub Actions の記録あり' +
                (/^https:\/\//.test(ev.ciRunUrl || '')
                  ? '　<a href="' + E(ev.ciRunUrl) + '" target="_blank" rel="noopener noreferrer">実行の記録</a>'
                  : '')
              : '実 CI の記録あり'
            : '検査の記録はありません',
      ) +
      dlRow(
        'pr',
        'PR',
        realPr ? (realPr.source === 'github' ? 'ok' : 'fake') : ev.hasPrDraft ? (isFake ? 'fake' : 'ok') : 'none',
        realPr
          ? (/^https?:\/\//.test(realPr.url || '')
              ? '<a href="' + E(realPr.url) + '" target="_blank" rel="noopener noreferrer">PR #' + E(realPr.number) + '</a>'
              : 'PR #' + E(realPr.number)) + (job.state === 'pr_ready' ? '（人の承認待ち。AI は merge しません）' : '')
          : ev.hasPrDraft
            ? 'PR 本文の下書きのみ（実 PR はありません）'
            : 'PR の記録はありません',
      )
    );
  }
  function dlSampleRow(r) {
    const p = pipeOf(r);
    if (!p || !(p.step > 1 || p.issue || p.pr)) return '';
    const btn = pipeBtn(r, p);
    return dlRow(
      'sample',
      '見本の進み',
      'sample',
      'L' +
        E(p.step) +
        ' ' +
        E(SF.LINE[p.step] || '') +
        '　Issue ' +
        (p.issue ? '#' + E(p.issue) : '－') +
        '　PR ' +
        (p.pr ? '#' + E(p.pr) : '－') +
        '（操作を確かめるための見本で、実行していません）' +
        (btn ? '<br>' + btn + '<br><small>' + E(SAMPLE_LOCK) + '</small>' : ''),
    );
  }
  function dlStatusText(r, s, cur) {
    if (s.busy) return { t: '送信中です。結果が出るまでお待ちください', ng: false };
    if (s.msg) return s.msg;
    if (cur && cur.state === 'succeeded') {
      return {
        t: '投入済みです（Issue #' + cur.issueNo + '・版 ' + cur.orderVersion + '）。受付の状態はボードで人が進めます',
        ng: false,
      };
    }
    if (cur && (cur.state === 'unknown' || cur.state === 'sent')) {
      return {
        t: '結果不明・要照合：Issue が作られたか確認できていません。「照合する」を押すと一覧から探します（再送はしません）',
        ng: true,
      };
    }
    if (s.failed) return { t: '開発ラインの記録を読み込めませんでした（未接続として表示しています）', ng: true };
    if (cur && cur.state === 'failed') return { t: '前回の投入は完了していません。もう一度押して再試行できます', ng: true };
    return { t: 'まだ投入していません', ng: false };
  }
  function dlButton(r, s, cur) {
    if (cur && cur.state === 'succeeded') return '';
    const pending = cur && (cur.state === 'unknown' || cur.state === 'sent');
    const v = r.__orderVersion;
    let label = pending
      ? '照合する（再送しません）'
      : r.__issueNo > 0
        ? '開発ラインへ投入（Issue #' + r.__issueNo + ' を版 ' + v + ' に更新）'
        : '開発ラインへ投入（版 ' + v + '）';
    if (s.busy) label = '送信中…';
    let why = '';
    if (!DL_HANDOFF_ROLES.includes(S.role)) why = '投入できるのは受付担当か承認者です';
    else if (!v) why = '承認済みになってから投入します';
    else if (!pending && r.status !== 'approved' && !cur)
      why = '承認済みの状態でだけ投入できます（いまは「' + SF.statusOf(r.status).l + '」）';
    else if (!pending && !DL_LIVE_STATUS.includes(r.status)) why = '承認が取り消されているので投入できません';
    const off = s.busy || (s.loading && !s.loadedAt) || !!why;
    return (
      '<div class="dlact"><button type="button" class="btn sm ' +
      (off ? '' : 'go') +
      '" data-dl="handoff" data-id="' +
      E(r.id) +
      '"' +
      (off ? ' disabled aria-disabled="true"' : '') +
      '>' +
      ico(pending ? 'i-undo' : 'i-git') +
      E(label) +
      '</button>' +
      (why ? '<small class="muted">' + E(why) + '</small>' : '') +
      '</div>'
    );
  }
  function dlAbsentHtml(r, s, cur) {
    // 走査が完全で見つからなかったときだけ。サーバも不完全な走査では再作成しない
    if (!cur || cur.state !== 'unknown' || !s.msg || s.msg.scanComplete !== true) return '';
    if (!DL_ABSENT_ROLES.includes(S.role)) {
      return '<p class="hint" style="margin:6px 0 0">作られていないと確定して作り直せるのは、承認者か管理責任者です。</p>';
    }
    if (!s.absentOpen) {
      return (
        '<div class="dlact"><button type="button" class="btn sm" data-dl="absent-open" data-id="' +
        E(r.id) +
        '">' +
        ico('i-alert') +
        '作られていないと確定して作り直す…</button></div>'
      );
    }
    const ok = s.absentChecked && s.absentReason.trim();
    return (
      '<div class="dlform" data-dl-form data-id="' +
      E(r.id) +
      '"><b>Issue を作り直す前の確認</b>' +
      '<p class="hint" style="margin:4px 0">連携先に同じ Issue が無いことを人が確かめた場合だけ実行します。実はできていた場合は Issue が二重になります。</p>' +
      '<label class="fl" for="dlar-' +
      E(r.id) +
      '">確かめた内容（理由・必須）</label><textarea id="dlar-' +
      E(r.id) +
      '" data-dl-input="reason" data-id="' +
      E(r.id) +
      '" style="min-height:52px">' +
      E(s.absentReason) +
      '</textarea><label class="dlchk"><input type="checkbox" data-dl-input="check" data-id="' +
      E(r.id) +
      '"' +
      (s.absentChecked ? ' checked' : '') +
      '> 連携先に Issue が無いことを確かめました</label><div class="dlact"><button type="button" class="btn sm" data-dl="absent-cancel" data-id="' +
      E(r.id) +
      '">やめる</button><button type="button" class="btn sm dng" data-dl="absent-do" data-id="' +
      E(r.id) +
      '"' +
      (ok && !s.busy ? '' : ' disabled') +
      '>' +
      ico('i-alert') +
      'Issue を作り直す</button></div></div>'
    );
  }
  function dlInner(r) {
    const s = dlOf(r.id),
      cur = dlCurrent(r, s),
      st = dlStatusText(r, s, cur);
    return (
      '<div class="dlstatus' +
      (st.ng ? ' ng' : '') +
      '" data-dl-status role="status" tabindex="-1">' +
      ico(st.ng ? 'i-alert' : 'i-git') +
      '<span>' +
      E(st.t) +
      '</span></div>' +
      dlButton(r, s, cur) +
      dlAbsentHtml(r, s, cur) +
      '<ul class="dlrows">' +
      dlIssueRow(r, s, cur) +
      dlJobRows(s) +
      dlRow('release', 'マージ・配備・公開', 'none', 'この段階は開発ラインに接続していません') +
      dlSampleRow(r) +
      '</ul>'
    );
  }
  function dlPanel(r) {
    dlLoad(r.id);
    return '<div class="dlp" data-dl-panel="' + E(r.id) + '">' + dlInner(r) + '</div>';
  }
  function dlPaint(id) {
    const r = find(id);
    if (!r) return;
    $$('[data-dl-panel]')
      .filter((el) => el.dataset.dlPanel === id)
      .forEach((el) => {
        // 確認欄に入力中は描き直さない
        const a = document.activeElement;
        if (a && el.contains(a) && a.dataset && a.dataset.dlInput) return;
        el.innerHTML = dlInner(r);
      });
  }
  /* 読み込みは TTL の間は1回だけ。描画からは呼んでもよい（描き直しは dlPaint だけで、再描画のループにしない） */
  function dlLoad(id, force) {
    const s = dlOf(id);
    // 投入の直後は、読み込み中の古い結果ではなく、その後の新しい結果を待つ
    if (s.loading) return force ? s.loadP.then(() => dlLoad(id, true)) : s.loadP;
    if (!force && s.loadedAt && Date.now() - s.loadedAt < DL_TTL_MS) return Promise.resolve();
    s.loading = true;
    s.loadP = window.__MSF__.readJobs(id).then((res) => {
      s.loading = false;
      s.loadedAt = Date.now();
      s.failed = !res;
      if (res) {
        s.items = Array.isArray(res.items) ? res.items : [];
        s.handoffs = Array.isArray(res.handoffs) ? res.handoffs : [];
        s.evidence = res.evidence || {};
      }
      const r = find(id);
      const cur = r ? dlCurrent(r, s) : null;
      if (cur && cur.state === 'succeeded') {
        // 別のタブや通信断の裏で確定していた。古い失敗の表示を残さない
        s.msg = null;
        if (!(r.__issueNo > 0)) void window.__MSF__.refreshRequest(id);
      }
      if (!s.busy) dlPaint(id);
    });
    return s.loadP;
  }
  function dlMessage(r, res) {
    const message = res.message || '';
    switch (res.kind) {
      case 'not_connected':
        return { t: '開発ライン未接続：' + message + '。Issue は作られていません', ng: true };
      case 'unknown':
        if (res.details && res.details.scanComplete === true) {
          return {
            t: '結果不明・要照合：照合しましたが Issue は見つかりませんでした（一覧は最後まで確認済み）。自動では作り直しません',
            ng: true,
            scanComplete: true,
          };
        }
        if (res.details && res.details.scanComplete === false) {
          return { t: '結果不明・要照合：一覧を最後まで確認できませんでした。もう一度「照合する」を押してください', ng: true };
        }
        return {
          t: '結果不明・要照合：連携先の応答を確認できませんでした。Issue が作られた可能性があります。「照合する」を押すと一覧から探します（再送はしません）',
          ng: true,
        };
      case 'not_approved':
        return {
          t:
            '投入できません（ERR-205）：' +
            message +
            '。承認待ちへ戻して承認し直すと投入できます（見本データの承認記録には承認者の利用者IDがないため、そのままでは投入できません）',
          ng: true,
        };
      case 'stale':
        return {
          t: '注文書の版が新しくなっていました（ERR-202）。最新を読み込みました。内容を確かめて、もう一度押してください',
          ng: true,
        };
      case 'in_progress':
        return { t: '別の操作が投入を進めています（ERR-301）。少し待つと結果を読み込みます', ng: true, follow: true };
      case 'rate_limited':
        return {
          t:
            '連携先が混み合っています（ERR-302）。' +
            (res.details && res.details.nextAttemptAt ? SF.fmt(res.details.nextAttemptAt) + ' 以降に' : '少し待って') +
            '再試行してください',
          ng: true,
        };
      case 'denied':
        return { t: 'この操作の権限がありません（ERR-101）', ng: true };
      case 'rejected':
        return { t: '連携先が受け付けませんでした。Issue は作られていません。もう一度押して再試行できます', ng: true };
      case 'connect':
        return { t: '連携先に接続できませんでした（送信前です）。もう一度押して再試行できます', ng: true };
      case 'network':
        return { t: '通信できませんでした。接続を確かめて、もう一度押してください（押し直しても Issue は増えません）', ng: true };
      default:
        return { t: (message || '処理を完了できませんでした') + '。もう一度押して再試行できます', ng: true };
    }
  }
  function dlFocus(id, panel) {
    const el =
      panel && panel.isConnected ? panel : $('#drawer [data-dl-panel="' + id + '"]') || $('[data-dl-panel="' + id + '"]');
    const st = el && el.querySelector('[data-dl-status]');
    if (st) st.focus();
  }
  async function dlHandoff(id, panel, confirm) {
    const r = find(id),
      s = dlOf(id);
    if (!r || s.busy) return;
    if (!DL_HANDOFF_ROLES.includes(S.role)) return toast('投入できるのは受付担当か承認者です', true);
    if (confirm && !DL_ABSENT_ROLES.includes(S.role)) return toast('作り直しを確定できるのは承認者か管理責任者です', true);
    s.busy = true;
    s.msg = null;
    dlPaint(id);
    const res = await window.__MSF__.handoff(id, r.__orderVersion, confirm || undefined);
    if (res.ok) {
      s.absentOpen = false;
      s.absentReason = '';
      s.absentChecked = false;
    } else {
      s.msg = dlMessage(r, res);
    }
    await dlLoad(id, true);
    s.busy = false;
    dlPaint(id);
    dlFocus(id, panel);
    if (res.ok) {
      toast(
        res.result.created
          ? 'Issue #' + res.result.issueNo + '（版 ' + res.result.orderVersion + '）に投入しました'
          : 'Issue #' + res.result.issueNo + '（版 ' + res.result.orderVersion + '）を確認しました（重ねて作っていません）',
      );
    } else if (s.msg && s.msg.follow) {
      s.follow = 0;
      dlFollow(id);
    }
  }
  /* 別の操作の進行中は、少し待って読み直す（送信はしない） */
  function dlFollow(id) {
    const s = dlOf(id);
    if (s.follow >= 10) return;
    s.follow += 1;
    setTimeout(async () => {
      if (s.busy || !s.msg || !s.msg.follow) return;
      await dlLoad(id, true);
      if (s.msg && s.msg.follow) dlFollow(id);
    }, 1000);
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-dl]');
    if (!b || !window.__MSF__ || b.disabled) return;
    const id = b.dataset.id,
      s = dlOf(id),
      panel = b.closest('[data-dl-panel]');
    if (b.dataset.dl === 'handoff') return void dlHandoff(id, panel, null);
    if (b.dataset.dl === 'absent-open') {
      s.absentOpen = true;
      dlPaint(id);
      const area = panel && panel.querySelector('[data-dl-input="reason"]');
      if (area) area.focus();
      return;
    }
    if (b.dataset.dl === 'absent-cancel') {
      s.absentOpen = false;
      s.absentReason = '';
      s.absentChecked = false;
      dlPaint(id);
      dlFocus(id, panel);
      return;
    }
    if (b.dataset.dl === 'absent-do') {
      const reason = s.absentReason.trim();
      if (!reason || !s.absentChecked) return;
      return void dlHandoff(id, panel, { confirmAbsent: true, reason });
    }
  });
  function dlInputChanged(e) {
    const el = e.target;
    if (!el.dataset || !el.dataset.dlInput) return;
    const s = dlOf(el.dataset.id);
    if (el.dataset.dlInput === 'reason') s.absentReason = el.value;
    if (el.dataset.dlInput === 'check') s.absentChecked = el.checked;
    const form = el.closest('[data-dl-form]'),
      go = form && form.querySelector('[data-dl="absent-do"]');
    if (go) go.disabled = !(s.absentChecked && s.absentReason.trim()) || s.busy;
  }
  document.addEventListener('input', dlInputChanged);
  document.addEventListener('change', dlInputChanged);

  /* ---- 開発ライン（パイプライン） ---- */
  function pipeOf(r) {
    return O().pipes[r.id];
  }
  function newPipe() {
    return {
      step: 1,
      issue: null,
      pr: null,
      checks: {},
      same: 0,
      total: 0,
      hours: 0,
      cost: 0,
      esc: '',
      fail: 0,
      prItems: [],
      merged: '',
      ai: '',
    };
  }
  function escLevel(p) {
    if (p.cost >= SF.LIMITS.cost) return 'L4';
    if (p.total >= SF.LIMITS.total || p.cost >= SF.LIMITS.cost * 0.8) return 'L3';
    if (p.same >= SF.LIMITS.same || p.hours >= SF.LIMITS.hours) return 'L2';
    return '';
  }
  const ESC = {
    L2: { who: ['desk'], l: 'L2 開発（受付担当が4時間以内に判断）' },
    L3: { who: ['approver', 'admin'], l: 'L3 承認（承認者・管理責任者が1営業日以内に判断）' },
    L4: { who: ['admin'], l: 'L4 重大（管理責任者が2時間以内に判断）' },
  };
  function runCI(r, p) {
    if (window.__MSF__) return toast(SAMPLE_LOCK, true);
    p.total++;
    p.hours = Math.round((p.hours + 0.3) * 10) / 10;
    p.cost += 600;
    const keys = SF.CHECKS.map((c) => c[0]).filter((k) => k !== 'offline' || SF.isFieldTool(r));
    if (p.fail > 0) {
      p.fail--;
      p.same++;
      keys.forEach((k) => (p.checks[k] = k === 'unit' ? 'ng' : k === 'e2e' ? '-' : 'ok'));
      p.esc = escLevel(p);
      p.step = 6;
      addAudit(
        '自動検査（CI）：不合格',
        r.id,
        '単体テストが失敗（同じ原因 ' +
          p.same +
          '回目・修正合計 ' +
          p.total +
          '回）' +
          (p.esc ? '／上限に達したため停止（' + p.esc + '）' : ''),
        'CI',
      );
      persist();
      return toast(
        p.esc ? '上限に達したため自動で停止しました（' + p.esc + '）' : 'CIが不合格でした。AIが修正して再検査できます',
        !!p.esc,
      );
    }
    keys.forEach((k) => (p.checks[k] = 'ok'));
    p.esc = '';
    p.same = 0;
    p.pr = p.pr || ++O().seq.pr;
    p.step = 9;
    p.prItems = SF.PRITEMS.map(() => 1);
    if (!p.ai) p.ai = '指摘0件。見落とし得る範囲：画面の言葉づかい（人が確認）';
    addAudit('自動検査（CI）：合格／PR作成', r.id, 'PR #' + p.pr + '（判断材料10項目）', 'CI');
    if (r.status === 'dev') applyStatus(r, 'verify', '', 'CIに合格し PR #' + p.pr + ' を作成');
    else persist();
    toast('CIに合格し、PR #' + p.pr + ' を作りました。承認者がマージを判断します');
  }
  function pipeAct(r) {
    if (window.__MSF__) return toast(SAMPLE_LOCK, true);
    const p = pipeOf(r);
    if (!p) return;
    if (p.step === 1) {
      if (!can('pipeIssue')) return toast(who('pipeIssue') + 'が操作します', true);
      p.issue = ++O().seq.issue;
      p.step = 2;
      addAudit('開発ラインに投入（Issue化）', r.id, 'Issue #' + p.issue);
      if (r.status === 'approved') applyStatus(r, 'dev', '', '開発ラインに投入（Issue #' + p.issue + '）');
      else persist();
      return refreshAll('Issue #' + p.issue + ' を作りました');
    }
    if (p.step >= 2 && p.step <= 4) {
      if (!can('pipeRun')) return toast(who('pipeRun') + 'が操作します', true);
      p.step = 5;
      p.hours = Math.round((p.hours + 0.5) * 10) / 10;
      p.cost += 900;
      addAudit('AIの作業（仕様案・計画・実装）', r.id, '作業ブランチで実装しテストを作成');
      persist();
      return refreshAll('AIが仕様案・計画・実装を終えました（シミュレーション）');
    }
    if (p.step === 5 || (p.step === 6 && !p.esc)) {
      if (!can('pipeRun')) return toast(who('pipeRun') + 'が操作します', true);
      runCI(r, p);
      return refreshAll();
    }
    if (p.step === 6 && p.esc) return openEsc(r, p);
    if (p.step === 9) {
      if (!can('merge')) return toast('マージを承認できるのは承認者です', true);
      if (p.prItems.filter(Boolean).length < 10) return toast('PRの判断材料10項目がそろっていません', true);
      openMerge(r, p);
      return;
    }
    if (p.step === 10) {
      if (!can('stagingOk')) return toast(who('stagingOk') + 'が操作します', true);
      if (r.status === 'field') return toast('現場試用中です。試用結果を記録したら、ボードで「公開承認待ち」へ進めます', true);
      const nx = SF.isFieldTool(r) ? 'field' : 'release_wait';
      if (!['verify'].includes(r.status)) return toast('いまの状態（' + SF.statusOf(r.status).l + '）からは進められません', true);
      p.step = nx === 'field' ? 10 : 11;
      applyStatus(r, nx, '', 'ステージングで確認済み');
      return refreshAll(r.id + ' を「' + SF.statusOf(nx).l + '」にしました');
    }
    if (p.step === 11) {
      if (S.role !== 'approver') return toast('リリース判定（公開承認）は承認者が行います', true);
      return openStatus(r, 'done');
    }
  }
  function openMerge(r, p) {
    if (window.__MSF__) return toast(SAMPLE_LOCK, true);
    modal(
      ico('i-git') + 'マージを承認する　<span class="muted" style="font-size:12.5px">' + E(r.id) + '／PR #' + p.pr + '</span>',
      '<p style="margin:0 0 8px">完成版（main）への取り込みを判断します。<b>公開（本番）は別の判断</b>です。</p>' +
        '<div class="pchk"><b>PRの判断材料（10項目）</b><ul>' +
        SF.PRITEMS.map(
          (t, i) =>
            '<li class="ok">✓ ' +
            (i + 1) +
            '. ' +
            E(t) +
            ((i === 5 || i === 6) && !SF.isFieldTool(r) ? '（対象外）' : '') +
            '</li>',
        ).join('') +
        '</ul></div>' +
        '<div class="pchk"><b>自動検査</b><div class="chks">' +
        chkChips(r, p) +
        '</div><div class="hint">AIレビュー：' +
        E(p.ai || '－') +
        '</div></div>' +
        '<label class="pcok"><input type="checkbox" id="mgok"> 差分・検査結果・プレビューの動きを確認しました（承認はこのコミットに紐づけて記録されます）</label>',
      '<button class="btn" data-x type="button">キャンセル</button><button class="btn pri" id="mgdo" type="button">' +
        ico('i-check') +
        'マージを承認する</button>',
    );
    $('#mgdo').addEventListener('click', () => {
      if (!$('#mgok').checked) return toast('確認のチェックを入れてください', true);
      p.merged = me().name;
      p.step = 10;
      const o = O(),
        a = appByReq(r.id);
      const ver = a ? SF.bumpVer(a.ver) : '0.' + 9 + '.' + o.deploys.filter((d) => d.req === r.id).length;
      o.deploys.unshift({
        id: 'DEP-' + String(++o.seq.dep).padStart(4, '0'),
        app: a ? a.id : '',
        req: r.id,
        ver,
        env: 'staging',
        at: SF.nowISO(),
        type: '通常',
        pr: p.pr,
        result: '成功',
        mergeBy: me().name,
        releaseBy: '',
        by: 'デプロイジョブ',
        note: 'マージ後にステージングへ配備',
      });
      addAudit('マージを承認', r.id, 'PR #' + p.pr + '／ステージングへ配備 v' + ver);
      persist();
      closeModal();
      refreshAll('マージしてステージングへ配備しました');
    });
  }
  function openEsc(r, p) {
    if (window.__MSF__) return toast(SAMPLE_LOCK, true);
    const lv = p.esc,
      okRole = (ESC[lv] || { who: [] }).who.includes(S.role);
    modal(
      ico('i-alert') + 'エスカレーション（' + E(lv) + '）　<span class="muted" style="font-size:12.5px">' + E(r.id) + '</span>',
      '<p style="margin:0 0 8px">' +
        E((ESC[lv] || {}).l || '') +
        '</p>' +
        '<div class="pchk"><ul><li>同じ原因の修正：<b>' +
        p.same +
        '</b>／' +
        SF.LIMITS.same +
        ' 回</li><li>修正の合計：<b>' +
        p.total +
        '</b>／' +
        SF.LIMITS.total +
        ' 回</li><li>作業時間：<b>' +
        p.hours +
        '</b>／' +
        SF.LIMITS.hours +
        ' 時間</li><li>費用：<b>¥' +
        p.cost.toLocaleString() +
        '</b>／¥' +
        SF.LIMITS.cost.toLocaleString() +
        '（80%で警告・100%で停止）</li></ul></div>' +
        (okRole
          ? '<label class="fl">どうしますか</label><div class="stopts">' +
            [
              ['human', '人が修正する（AIの再試行を止める）'],
              ['split', 'タスクを小さく分けて、もう一度AIに任せる'],
              ['spec', '注文書を見直す（承認待ちへ戻す）'],
              ['hold', '見送る'],
            ]
              .map(
                (x, i) =>
                  '<label><input type="radio" name="ed" value="' +
                  x[0] +
                  '"' +
                  (i === 0 ? ' checked' : '') +
                  '>' +
                  E(x[1]) +
                  '</label>',
              )
              .join('') +
            '</div><label class="fl" for="enote">判断の理由<span class="muted" style="font-weight:400;font-size:12px">（必須）</span></label><textarea id="enote" style="min-height:60px" placeholder="例：テストデータの日付の作り方が原因。人が直す"></textarea>'
          : '<div class="nopt">' +
            ico('i-alert') +
            ' この段階の判断は ' +
            E((ESC[lv] || { who: [] }).who.map((k) => RO[k]).join('・')) +
            ' が行います。</div>'),
      okRole
        ? '<button class="btn" data-x type="button">キャンセル</button><button class="btn pri" id="edo" type="button">' +
            ico('i-check') +
            '判断を記録する</button>'
        : '<button class="btn pri" data-x type="button">閉じる</button>',
    );
    if (!okRole) return;
    let sending = false;
    $('#edo').addEventListener('click', async () => {
      if (sending) return;
      const d = ($('#modal input[name=ed]:checked') || {}).value,
        note = $('#enote').value.trim();
      if (!note) return toast('判断の理由を書いてください', true);
      const label = { human: '人が修正する', split: 'タスクを分ける', spec: '注文書を見直す', hold: '見送る' }[d];
      // 状態を変える判断は、保存の結果を待ってから記録する。失敗したらダイアログを残す
      const to = d === 'spec' ? 'wait' : d === 'hold' ? 'hold' : null;
      if (to && SF.canMove(S.role, r.status, to)) {
        const btn = $('#edo');
        sending = true;
        btn.disabled = true;
        const res = await applyStatus(
          r,
          to,
          note,
          'エスカレーション（' + lv + '）：' + (d === 'spec' ? '注文書を見直す' : '見送り'),
        );
        sending = false;
        btn.disabled = false;
        if (coreFailed(res, r.id)) return;
      }
      const pipe = O().pipes[r.id] || p;
      addAudit('エスカレーションを判断（' + lv + '）', r.id, label + '／' + note);
      pipe.esc = '';
      pipe.same = 0;
      pipe.fail = 0;
      if (d === 'human' || d === 'split') pipe.step = 5;
      if (d === 'spec') pipe.step = 1;
      if (d === 'hold') pipe.step = 12;
      O()
        .incidents.filter((i) => i.req === r.id && i.status !== '完了')
        .forEach((i) => {
          i.log.push({ at: SF.nowISO(), by: me().name, t: '判断：' + label + '（' + note + '）' });
          i.restored = i.restored || SF.nowISO();
          i.status = '完了';
          i.closed = SF.nowISO();
          i.cause = i.cause || note;
          i.prevention = i.prevention || label;
        });
      persist();
      closeModal();
      refreshAll('判断を記録しました（' + label + '）');
    });
  }
  const chkChips = (r, p) =>
    SF.CHECKS.filter((c) => c[0] !== 'offline' || SF.isFieldTool(r))
      .map((c) => {
        const v = (p.checks || {})[c[0]] || '-';
        return (
          '<span class="ck ' +
          (v === 'ok' ? 'ok' : v === 'ng' ? 'ng' : 'na') +
          '" title="' +
          E(c[1]) +
          '：' +
          (v === 'ok' ? '合格' : v === 'ng' ? '不合格' : '未実行') +
          '">' +
          (v === 'ok' ? '✓' : v === 'ng' ? '✕' : '－') +
          ' ' +
          E(c[1]) +
          '</span>'
        );
      })
      .join('');
  const meter = (l, v, max, unit, fmt) => {
    const pct = Math.min(100, Math.round((v / max) * 100));
    const k = pct >= 100 ? 'ng' : pct >= 80 ? 'warn' : 'ok';
    return (
      '<div class="mt"><span>' +
      E(l) +
      '</span><span class="bar ' +
      k +
      '"><i style="width:' +
      pct +
      '%"></i></span><b>' +
      (fmt ? fmt(v) : v) +
      '／' +
      (fmt ? fmt(max) : max) +
      E(unit || '') +
      '</b></div>'
    );
  };

  /* ---- リリース（公開承認 → 本番デプロイ） ---- */
  function releaseDeploy(r, opt) {
    const o = O();
    let a = appByReq(r.id);
    const p = pipeOf(r);
    const ver = a ? SF.bumpVer(a.ver) : '1.0.0';
    if (!a) {
      a = {
        id: 'APP-' + String(++o.seq.app).padStart(3, '0'),
        req: r.id,
        name: r.title,
        dept: r.dept,
        ver,
        wave: opt.wave,
        since: SF.nowISO(),
        owner: r.applicant + '（' + ((SF.deptOf(r.dept) || {}).short || '') + '）',
        opsOwner: '井上 翔太',
        users: +r.people || 0,
        mau: 0,
        slo: 99.5,
        avail: 100,
        err: 0,
        p95: 0,
        budget: 10000,
        spent: 0,
        field: SF.isFieldTool(r),
      };
      o.apps.push(a);
    } else {
      a.ver = ver;
      a.wave = opt.wave;
    }
    o.deploys.unshift({
      id: 'DEP-' + String(++o.seq.dep).padStart(4, '0'),
      app: a.id,
      req: r.id,
      ver,
      env: 'prod',
      at: SF.nowISO(),
      type: opt.type,
      pr: p ? p.pr : '',
      result: '成功',
      mergeBy: p ? p.merged : '',
      releaseBy: me().name,
      by: 'デプロイジョブ',
      note: '公開範囲：' + opt.wave,
    });
    if (p) p.step = 12;
    addAudit('デプロイ（本番）', a.id, 'v' + ver + '／' + opt.type + '／公開範囲 ' + opt.wave, 'デプロイジョブ');
    return a;
  }
  function refreshAll(msg) {
    render();
    if (S.open) renderDrawer();
    if (msg) toast(msg);
  }

  /* ---- あなたの番（運用・セキュリティ） ---- */
  function opsTurn() {
    const o = O(),
      out = [],
      role = S.role,
      now = Date.now();
    if (!o) return out;
    const add = (kind, id, title, a, go, days, tone) => out.push({ kind, id, title, a, go, days: days || 0, tone: tone || '' });
    const rtDue = (r) => SF.daysLeft(SF.routineNext(r));
    o.routines
      .filter((r) => r.who === role && rtDue(r) <= 0)
      .forEach((r) =>
        add(
          '定期作業',
          r.id,
          r.title,
          rtDue(r) < 0 ? '期限を' + -rtDue(r) + '日過ぎています。実施して記録する' : '今日が期限です。実施して記録する',
          ['ops', 'rt'],
          -rtDue(r),
          rtDue(r) < 0 ? 'al' : 'wn',
        ),
      );
    if (role === 'ops') {
      o.incidents
        .filter((i) => i.status !== '完了' && i.cat !== '開発ライン')
        .forEach((i) =>
          add(
            '障害',
            i.id,
            i.title,
            i.restored ? '再発防止を決めて完了にする' : '復旧する（目標：' + SF.SEV[i.sev].fixL + '）',
            ['ops', 'inc'],
            Math.floor(minsBetween(i.opened) / 1440),
            ['S1', 'S2'].includes(i.sev) ? 'al' : 'wn',
          ),
        );
      o.changes
        .filter((c) => c.status === '承認済み')
        .forEach((c) => add('変更', c.id, c.title, '承認された変更を適用する', ['devops', 'chg']));
    }
    if (role === 'sec') {
      o.vulns
        .filter((v) => ['未対応', '対応中'].includes(v.status))
        .forEach((v) => {
          const d = SF.daysLeft(SF.dueOf(v));
          if (d <= 7)
            add(
              '脆弱性',
              v.id,
              v.title,
              d < 0 ? '修正期限を' + -d + '日過ぎています' : d === 0 ? '今日が修正期限です' : '修正期限まであと' + d + '日',
              ['secops', 'vul'],
              -d,
              d < 0 ? 'al' : 'wn',
            );
        });
      o.secEvents
        .filter((e) => e.status === '未確認')
        .forEach((e) =>
          add(
            '通知',
            e.id,
            e.kind + '（' + e.target + '）',
            '確認して対応を記録する',
            ['secops', 'ev'],
            Math.floor(minsBetween(e.at) / 1440),
            e.sev === 'S1' || e.sev === 'S2' ? 'al' : '',
          ),
        );
      o.findings
        .filter((f) => f.status === '未対応')
        .forEach((f) => add('棚卸し', f.id, f.kind + '：' + f.who, '対応を記録する', ['secops', 'acc']));
      o.controls
        .filter((c) => !c.ok)
        .forEach((c) =>
          add(
            '品質ゲート',
            c.id,
            c.note || c.t,
            '設定を直して点検を記録する（守るべき状態：' + c.t + '）',
            ['secops', 'gate'],
            0,
            'wn',
          ),
        );
      o.incidents
        .filter((i) => i.status !== '完了' && i.cat === 'セキュリティ')
        .forEach((i) => add('障害', i.id, i.title, '封じ込めと復旧', ['ops', 'inc'], 0, 'al'));
    }
    const needMe = (c) =>
      c.need.includes(role) &&
      !c.appr.some((a) => a.role === role) &&
      ['承認待ち', '事後承認待ち'].includes(c.status) &&
      c.by !== me().name;
    if (role === 'admin' || role === 'approver') {
      o.changes
        .filter(needMe)
        .forEach((c) =>
          add(
            '変更',
            c.id,
            c.title,
            c.status === '事後承認待ち' ? '緊急変更を事後承認する' : '変更を承認する（2人の承認が必要）',
            ['devops', 'chg'],
          ),
        );
      o.vulns
        .filter(
          (v) =>
            v.accept &&
            v.accept.need.includes(role) &&
            !v.accept.appr.some((a) => a.role === role) &&
            v.status === 'リスク受容（承認待ち）',
        )
        .forEach((v) => add('脆弱性', v.id, v.title, 'リスク受容の申請を判断する', ['secops', 'vul']));
      Object.keys(window.__MSF__ ? {} : o.pipes).forEach((id) => {
        const p = o.pipes[id],
          r = find(id);
        if (r && p.esc && (ESC[p.esc] || { who: [] }).who.includes(role))
          add('開発ライン', id, r.title, 'エスカレーション（' + p.esc + '）を判断する', ['devops', 'line'], 0, 'al');
      });
    }
    if (role === 'admin')
      o.findings
        .filter((f) => f.status === '例外の承認待ち')
        .forEach((f) => add('棚卸し', f.id, f.kind + '：' + f.who, '例外を判断する', ['secops', 'acc']));
    if (role === 'approver')
      Object.keys(window.__MSF__ ? {} : o.pipes).forEach((id) => {
        const p = o.pipes[id],
          r = find(id);
        if (r && p.step === 9 && r.approver === me().name)
          add('開発ライン', id, r.title, 'PR #' + p.pr + ' のマージを判断する', ['devops', 'line']);
      });
    if (role === 'desk') {
      if (window.__MSF__) {
        S.data.items
          .filter((r) => r.status === 'approved' && !(r.__issueNo > 0))
          .forEach((r) => add('開発ライン', r.id, r.title, '注文書を開発ラインへ投入する', ['devops', 'line']));
      }
      Object.keys(window.__MSF__ ? {} : o.pipes).forEach((id) => {
        const p = o.pipes[id],
          r = find(id);
        if (!r || (SF.ENDED.includes(r.status) && p.step === 12)) return;
        if (p.step === 1 && r.status === 'approved')
          add('開発ライン', id, r.title, '注文書を投入して Issue を作る', ['devops', 'line']);
        else if (p.esc === 'L2')
          add('開発ライン', id, r.title, 'エスカレーション（L2）を判断する（4時間以内）', ['devops', 'line'], 0, 'al');
      });
      o.feedback
        .filter((f) => f.status === '未対応')
        .forEach((f) =>
          add('利用者の声', f.id, f.text, '依頼にするか決める', ['ops', 'fb'], Math.floor(minsBetween(f.at) / 1440)),
        );
      o.incidents
        .filter((i) => i.status !== '完了' && i.cat === '開発ライン' && (window.__MSF__ || !o.pipes[i.req]?.esc))
        .forEach((i) => add('障害', i.id, i.title, '対応を記録する', ['ops', 'inc']));
    }
    if (role === 'auditor')
      o.changes
        .filter((c) => c.status === '事後承認待ち')
        .forEach((c) => add('変更', c.id, c.title, '緊急変更の事後承認が終わるか見届ける', ['devops', 'chg']));
    return out.sort((x, y) => y.days - x.days);
  }
  function goTo(g) {
    const [v, t] = g;
    if (v === 'ops') S.otab = t;
    if (v === 'devops') S.dvtab = t;
    if (v === 'secops') S.sctab = t;
    go(v);
  }

  /* ================= 運用（リリース後の管理） ================= */
  /* ---- 承認依頼メール（サーバの送信キュー） ---- */
  const MAIL_LABEL = { pending: '送信待ち', sending: '送信中', sent: '送信済み', failed: '送信できませんでした' };
  function mailChip(s) {
    const k = s === 'sent' ? 'ok' : s === 'failed' ? 'ng' : s === 'sending' ? 'warn' : '';
    return pill(MAIL_LABEL[s] || s, k);
  }

  // 依頼詳細を開いたら、サーバ側のメール状態だけ取り直す（送信はコミット後なので画面を更新したい）
  function refreshRequestMail(id) {
    const msf = window.__MSF__;
    if (!msf || !msf.api) return;
    msf
      .api('GET', '/api/requests/' + encodeURIComponent(id))
      .then((res) => {
        const r = find(id);
        if (!r || !res || !res.request) return;
        const next = res.request.mail || null;
        if (JSON.stringify(next) === JSON.stringify(r.mail || null)) return;
        r.mail = next;
        if (S.open === id) renderDrawer();
      })
      .catch(() => {});
  }

  async function loadMailBox() {
    const el = $('#mailbox');
    if (!el) return;
    const msf = window.__MSF__;
    if (!msf || !msf.api) {
      el.innerHTML = '<p class="muted">サーバに接続していません</p>';
      return;
    }
    const canWrite = S.role === 'desk' || S.role === 'approver' || Boolean(msf.user && msf.user.isAdmin);
    try {
      const st = await msf.api('GET', '/api/mail/status');
      const mode =
        st.mode === 'off'
          ? '送らない設定（off）'
          : st.mode === 'file'
            ? 'ローカルの送信BOX（file）'
            : st.mode === 'sendmail'
              ? 'ローカルMTA（sendmail）'
              : 'SMTP（smtp）';
      let list = null;
      if (canWrite) list = await msf.api('GET', '/api/mail/outbox?limit=20');
      let html =
        '<div class="card pad"><h2 class="h2">' +
        ico('i-inbox') +
        'メール送信BOX</h2>' +
        '<p>送信方法：<b>' +
        E(mode) +
        '</b>　送信済み <b>' +
        st.sent +
        '</b> 件　送信待ち <b>' +
        (st.pending + st.sending) +
        '</b> 件　失敗 <b>' +
        st.failed +
        '</b> 件' +
        (st.lastSentAt ? '　最終送信：' + E(SF.fmt(st.lastSentAt)) : '') +
        '</p>';
      if (canWrite)
        html +=
          '<div class="data-row"><button class="btn sm" id="mflush" type="button">' +
          ico('i-undo') +
          '未送信をまとめて送る</button><button class="btn sm" id="mreload" type="button">' +
          ico('i-arrow') +
          '再読み込み</button></div>';
      else html += '<p class="hint">送信BOXの一覧は受付担当・承認者・管理者だけが見られます。</p>';
      if (canWrite && list && list.items.length) {
        html +=
          '<div class="tw" style="margin-top:12px"><table class="t"><thead><tr><th>作成</th><th>宛先</th><th>件名</th><th>状態</th><th></th></tr></thead><tbody>' +
          list.items
            .map(
              (m) =>
                '<tr><td>' +
                E(SF.fmt(m.createdAt)) +
                '</td><td>' +
                E(m.to) +
                '</td><td>' +
                E(m.subject) +
                '</td><td>' +
                mailChip(m.status) +
                (m.lastError ? '<br><small class="muted">' + E(m.lastError) + '</small>' : '') +
                '</td><td>' +
                (m.status === 'failed'
                  ? '<button class="btn sm" data-mretry="' + E(m.id) + '" type="button">再送</button>'
                  : '') +
                '</td></tr>',
            )
            .join('') +
          '</tbody></table></div>';
      } else if (canWrite && list) html += '<p class="muted" style="margin-top:12px">まだメールはありません。</p>';
      html += '</div>';
      el.innerHTML = html;
      if ($('#mflush'))
        $('#mflush').addEventListener('click', async () => {
          try {
            const r = await msf.api('POST', '/api/mail/flush');
            toast('送信しました（成功 ' + r.sent + '／失敗 ' + r.failed + '）');
            loadMailBox();
          } catch (e) {
            toast((e && e.message) || '送信できませんでした', true);
          }
        });
      if ($('#mreload')) $('#mreload').addEventListener('click', loadMailBox);
      $$('[data-mretry]').forEach((b) =>
        b.addEventListener('click', async () => {
          try {
            await msf.api('POST', '/api/mail/outbox/' + encodeURIComponent(b.dataset.mretry) + '/retry');
            toast('再送しました');
            loadMailBox();
          } catch (e) {
            toast((e && e.message) || '再送できませんでした', true);
          }
        }),
      );
    } catch (e) {
      el.innerHTML = '<p class="muted">送信BOXを取得できませんでした（' + E((e && e.message) || '') + '）</p>';
    }
  }

  function renderOps() {
    const o = O(),
      t = S.otab || 'apps';
    const openInc = o.incidents.filter((i) => i.status !== '完了'),
      fbOpen = o.feedback.filter((f) => f.status === '未対応');
    const rtOver = o.routines.filter((r) => SF.daysLeft(SF.routineNext(r)) < 0);
    const avg = o.apps.length ? (o.apps.reduce((a, x) => a + x.avail, 0) / o.apps.length).toFixed(2) : '－';
    let body = '';
    if (t === 'apps') {
      const pre = S.data.items.filter((r) => ['field', 'release_wait'].includes(r.status));
      body =
        '<div class="apps">' +
        o.apps
          .map((a) => {
            const h = health(a),
              r = find(a.req),
              dep = o.deploys.find((d) => d.app === a.id && d.env === 'prod');
            return (
              '<div class="card appc ' +
              h.k +
              '"><div class="ah"><b>' +
              E(a.name) +
              '</b>' +
              pill(h.l, h.k) +
              '</div>' +
              '<div class="am">' +
              mono(a.id) +
              ' v' +
              E(a.ver) +
              '　' +
              E((SF.deptOf(a.dept) || {}).short || '') +
              '　' +
              E(a.wave) +
              (r ? '　<a data-open="' + E(r.id) + '">' + E(r.id) + '</a>' : '') +
              '</div>' +
              '<div class="mt"><span>稼働率（30日）</span><span class="bar ' +
              (a.avail >= a.slo ? 'ok' : 'ng') +
              '" title="99%〜100%の範囲で表示"><i style="width:' +
              Math.max(2, Math.min(100, (a.avail - 99) * 100)) +
              '%"></i></span><b>' +
              a.avail.toFixed(2) +
              '%</b></div>' +
              '<div class="am2"><span>目標 ' +
              a.slo +
              '%</span><span>エラー率 ' +
              a.err +
              '%</span><span>応答 P95 ' +
              a.p95 +
              '秒</span><span>利用者 ' +
              a.mau +
              '／' +
              a.users +
              '人</span></div>' +
              meter('今月の費用', a.spent, a.budget, '円', (v) => '¥' + Number(v).toLocaleString()) +
              '<ul class="why">' +
              h.why.map((w) => '<li>' + E(w) + '</li>').join('') +
              '</ul>' +
              '<div class="am">最後の本番デプロイ：' +
              (dep ? E(SF.fmt(dep.at)) + '（' + E(dep.result) + '）' : '－') +
              '　運用：' +
              E(a.opsOwner) +
              '</div>' +
              '<div class="data-row" style="margin-top:8px"><button type="button" class="btn sm" data-act="appd|' +
              a.id +
              '">' +
              ico('i-doc') +
              '詳細</button>' +
              btn('incCreate', 'incnew|' + a.id, '障害を起票', 'i-alert') +
              btn('rollback', 'rb|' + a.id, 'ロールバック', 'i-undo', 'dng') +
              '</div></div>'
            );
          })
          .join('') +
        '</div>' +
        '<h3 class="h3">' +
        ico('i-rocket') +
        '公開前（現場試用・公開承認待ち）</h3>' +
        (pre.length
          ? '<div class="card tw"><table class="t"><thead><tr><th>受付番号</th><th>件名</th><th>状態</th><th>ステージング</th><th>次は</th></tr></thead><tbody>' +
            pre
              .map((r) => {
                const d = o.deploys.find((x) => x.req === r.id && x.env === 'staging');
                return (
                  '<tr data-open="' +
                  E(r.id) +
                  '"><td>' +
                  mono(r.id) +
                  '</td><td><b>' +
                  E(r.title) +
                  '</b></td><td>' +
                  st(r.status) +
                  '</td><td>' +
                  (d ? 'v' + E(d.ver) + '（' + E(ymdOf(d.at)) + '）' : '－') +
                  '</td><td>' +
                  E(nextWho(r)) +
                  '</td></tr>'
                );
              })
              .join('') +
            '</tbody></table></div>'
          : '<p class="muted">いまはありません</p>');
    }
    if (t === 'inc') {
      body =
        '<div class="btool">' +
        btn('incCreate', 'incnew|', '障害を起票', 'i-alert', 'go') +
        '<span class="sp"></span><span class="muted" style="font-size:12.5px">目標時間：' +
        ['S1', 'S2', 'S3', 'S4'].map((k) => E(k) + ' 初動' + SF.SEV[k].ackL + '・復旧' + SF.SEV[k].fixL).join('／') +
        '</span></div>' +
        '<div class="card tw"><table class="t"><thead><tr><th>番号</th><th>重大度</th><th>内容</th><th>対象</th><th>初動</th><th>復旧</th><th>状態</th><th></th></tr></thead><tbody>' +
        o.incidents
          .slice()
          .sort((a, b) => (a.opened < b.opened ? 1 : -1))
          .map((i) => {
            const ack = i.ack ? minsBetween(i.opened, i.ack) : null,
              fix = i.restored ? minsBetween(i.opened, i.restored) : minsBetween(i.opened),
              sv = SF.SEV[i.sev];
            const ackOver = (ack === null ? minsBetween(i.opened) : ack) > sv.ack,
              fixOver = sv.fix && fix > sv.fix;
            return (
              '<tr><td>' +
              mono(i.id) +
              '<br><small class="muted">' +
              E(SF.fmt(i.opened)) +
              '</small></td><td>' +
              sevChip(i.sev) +
              '</td><td><b>' +
              E(i.title) +
              '</b><br><small class="muted">' +
              E(i.cat) +
              (i.cause ? '／原因：' + E(i.cause) : '') +
              '</small></td><td>' +
              (i.app
                ? E((appOf(i.app) || {}).name || i.app)
                : i.req
                  ? '<a data-open="' + E(i.req) + '">' + E(i.req) + '</a>'
                  : '－') +
              '</td>' +
              '<td class="nw ' +
              (ackOver ? 'over' : '') +
              '">' +
              (ack === null ? '未' : dur(ack)) +
              '<br><small>目標 ' +
              E(sv.ackL) +
              '</small></td><td class="nw ' +
              (fixOver ? 'over' : '') +
              '">' +
              (i.restored ? dur(fix) : '経過 ' + dur(fix)) +
              '<br><small>目標 ' +
              E(sv.fixL) +
              '</small></td><td>' +
              pill(i.status, i.status === '完了' ? 'ok' : i.restored ? 'warn' : 'ng') +
              '</td>' +
              '<td><button type="button" class="btn sm" data-act="incd|' +
              i.id +
              '">' +
              ico('i-doc') +
              '記録</button></td></tr>'
            );
          })
          .join('') +
        '</tbody></table></div>' +
        '<p class="hint">障害は個人の責任追及ではなく、仕組みの改善につなげます（ふりかえり）。重大度 S1 は電話で即時連絡し、当日中に報告書を出します。</p>';
    }
    if (t === 'fb') {
      body =
        '<div class="card tw"><table class="t"><thead><tr><th>番号</th><th>道具</th><th>声</th><th>だれから</th><th>受付</th><th>状態</th><th></th></tr></thead><tbody>' +
        o.feedback
          .slice()
          .sort((a, b) => (a.at < b.at ? 1 : -1))
          .map(
            (f) =>
              '<tr><td>' +
              mono(f.id) +
              '</td><td>' +
              E((appOf(f.app) || {}).name || '') +
              '</td><td><b>' +
              E(f.text) +
              '</b></td><td>' +
              E(f.from) +
              '</td><td class="nw">' +
              E(SF.fmt(f.at)) +
              '</td><td>' +
              pill(f.status, f.status === '未対応' ? 'warn' : 'ok') +
              (f.ref ? '<br><small><a data-open="' + E(f.ref) + '">' + E(f.ref) + '</a></small>' : '') +
              '</td><td class="nw">' +
              (f.status === '未対応'
                ? btn('fbToReq', 'fbreq|' + f.id, '依頼にする', 'i-plus', 'go') +
                  ' ' +
                  btn('fbToReq', 'fbno|' + f.id, '対応しない', 'i-x')
                : '') +
              '</td></tr>',
          )
          .join('') +
        '</tbody></table></div>' +
        '<p class="hint">利用者の声は、新しい依頼として受付の先頭に戻します（運用・改善 → 次のリリース）。依頼にするときは、合格の条件を書き直してから承認に回します。</p>';
    }
    if (t === 'rt') {
      const fl = { d: '毎日', m: '毎月', q: '四半期', y: '年1回' };
      body =
        '<div class="card tw"><table class="t"><thead><tr><th>頻度</th><th>作業</th><th>担当</th><th>前回</th><th>次回</th><th>結果</th><th></th></tr></thead><tbody>' +
        o.routines
          .map((r) => {
            const nx = SF.routineNext(r),
              d = SF.daysLeft(nx),
              okRole = r.who === S.role || S.role === 'admin';
            return (
              '<tr><td>' +
              E(fl[r.freq]) +
              '</td><td><b>' +
              E(r.title) +
              '</b></td><td>' +
              E(RO[r.who]) +
              '</td><td class="nw">' +
              E(ymdOf(r.last)) +
              '</td><td class="nw ' +
              (d < 0 ? 'over' : '') +
              '">' +
              E(ymdOf(nx)) +
              '<br><small>' +
              (d < 0 ? -d + '日超過' : d === 0 ? '今日' : 'あと' + d + '日') +
              '</small></td><td>' +
              E(r.result) +
              '</td><td>' +
              (okRole && S.role !== 'auditor'
                ? '<button type="button" class="btn sm" data-act="rt|' + r.id + '">' + ico('i-check') + '実施を記録</button>'
                : '<button type="button" class="btn sm" disabled title="' +
                  E(RO[r.who]) +
                  'が記録します">' +
                  ico('i-check') +
                  '実施を記録</button>') +
              '</td></tr>'
            );
          })
          .join('') +
        '</tbody></table></div>' +
        '<h3 class="h3">' +
        ico('i-db') +
        'バックアップ（直近7日）</h3><div class="bkp">' +
        o.backups
          .slice()
          .reverse()
          .map(
            (b) =>
              '<div class="' +
              (b.result === '成功' ? 'ok' : 'warn') +
              '"><b>' +
              E(ymdOf(b.at)) +
              '</b><span>' +
              E(b.result) +
              '</span><small>' +
              E(b.size) +
              '</small></div>',
          )
          .join('') +
        '</div>' +
        '<p class="hint">目標（案）：RPO 1時間・RTO 4時間。バックアップが失敗したら S2 として再実行または手動で取ります。リストア検証は毎月、復旧訓練は四半期ごと（案）。</p>';
    }
    if (t === 'mail') {
      body = '<div id="mailbox"><p class="muted">読み込み中…</p></div>';
    }
    $('#view').innerHTML =
      '<div class="btool"><h2 class="h2" style="margin:0">' +
      ico('i-pulse') +
      '運用（リリース後の管理）</h2><span class="sp"></span><span class="muted" style="font-size:12.5px">数値とできごとは操作確認用の見本です</span></div>' +
      '<div class="kpis">' +
      kcard('稼働中の道具', o.apps.length, 'i-rocket', '件') +
      kcard('平均の稼働率（30日）', avg, 'i-pulse', '%') +
      kcard(
        '対応中の障害',
        openInc.length,
        'i-alert',
        '件',
        openInc.some((i) => ['S1', 'S2'].includes(i.sev) && !i.restored) ? 'ng' : openInc.length ? 'warn' : '',
      ) +
      kcard('未対応の利用者の声', fbOpen.length, 'i-chat', '件', fbOpen.length ? 'warn' : '') +
      kcard('期限切れの定期作業', rtOver.length, 'i-clock', '件', rtOver.length ? 'ng' : '') +
      '</div>' +
      vtabs('otab', [
        ['apps', '道具の稼働', 'i-rocket'],
        ['inc', '障害対応', 'i-alert', openInc.length || ''],
        ['fb', '利用者の声', 'i-chat', fbOpen.length || ''],
        ['rt', '定期作業', 'i-clock', rtOver.length || ''],
        ['mail', 'メール送信', 'i-inbox'],
      ]) +
      '<div class="vbody">' +
      body +
      '</div>';
    bindTabs(renderOps);
    bindCommon();
    if (t === 'mail') loadMailBox();
  }

  /* ================= DevOps ================= */
  function renderDevops() {
    const o = O(),
      t = S.dvtab || 'line';
    // サーバ接続時は見本のパイプの有無によらず、依頼の状態と Issue の記録から並べる
    const act = window.__MSF__
      ? S.data.items
          .filter(
            (r) =>
              !SF.ENDED.includes(r.status) &&
              (r.status === 'approved' || r.__issueNo > 0 || (o.pipes[r.id] && o.pipes[r.id].step < 12)),
          )
          .map((r) => ({ r, p: o.pipes[r.id] || null }))
      : Object.keys(o.pipes)
          .map((id) => ({ r: find(id), p: o.pipes[id] }))
          .filter((x) => x.r && x.p.step < 12 && !SF.ENDED.includes(x.r.status))
          .sort((a, b) => b.p.step - a.p.step);
    const relWait = S.data.items.filter((r) => r.status === 'release_wait');
    const since30 = Date.now() - 30 * 86400000,
      prod = o.deploys.filter((d) => d.env === 'prod' && new Date(d.at).getTime() >= since30);
    let body = '';
    if (t === 'line') {
      body =
        (act.length
          ? act
              .map(({ r, p }) => {
                if (window.__MSF__) {
                  return (
                    '<div class="card pipe"><div class="ph"><a data-open="' +
                    E(r.id) +
                    '">' +
                    mono(r.id) +
                    '</a><b>' +
                    E(r.title) +
                    '</b>' +
                    sig(colorOf(r)) +
                    st(r.status) +
                    '</div>' +
                    dlPanel(r) +
                    '</div>'
                  );
                }
                const nextBtn = pipeBtn(r, p);
                return (
                  '<div class="card pipe"><div class="ph"><a data-open="' +
                  E(r.id) +
                  '">' +
                  mono(r.id) +
                  '</a><b>' +
                  E(r.title) +
                  '</b>' +
                  sig(colorOf(r)) +
                  st(r.status) +
                  (p.esc ? '<span class="sv s1">' + ico('i-alert') + '停止中 ' + E(p.esc) + '</span>' : '') +
                  '</div>' +
                  '<div class="seg">' +
                  SF.LINE.slice(1)
                    .map(
                      (l, i) =>
                        '<span class="' +
                        (i + 1 < p.step ? 'p' : i + 1 === p.step ? (p.esc ? 'x' : 'c') : '') +
                        '" title="L' +
                        (i + 1) +
                        ' ' +
                        E(l) +
                        '"></span>',
                    )
                    .join('') +
                  '</div>' +
                  '<div class="pm"><span>いま：<b>L' +
                  p.step +
                  ' ' +
                  E(SF.LINE[p.step]) +
                  '</b></span><span>Issue ' +
                  (p.issue ? '#' + p.issue : '－') +
                  '</span><span>PR ' +
                  (p.pr ? '#' + p.pr : '－') +
                  '</span><span>マージ ' +
                  (p.merged ? E(p.merged) : '－') +
                  '</span><span>型 ' +
                  (r.status && SF.isFieldTool(r) ? '現場向け' : '事務所') +
                  '</span></div>' +
                  '<div class="chks">' +
                  chkChips(r, p) +
                  '</div>' +
                  '<div class="mts">' +
                  meter('同じ原因の修正', p.same, SF.LIMITS.same, '回') +
                  meter('修正の合計', p.total, SF.LIMITS.total, '回') +
                  meter('AIの作業時間', p.hours, SF.LIMITS.hours, '時間') +
                  meter('費用', p.cost, SF.LIMITS.cost, '', (v) => '¥' + Number(v).toLocaleString()) +
                  '</div>' +
                  (p.ai ? '<div class="hint">AIレビュー：' + E(p.ai) + '</div>' : '') +
                  '<div class="data-row" style="margin-top:8px">' +
                  nextBtn +
                  '</div></div>'
                );
              })
              .join('')
          : '<p class="muted">開発ラインに流れている依頼はありません</p>') +
        (window.__MSF__
          ? '<p class="hint">各項目の「実行確認済み」「fake」「未接続」「見本」は記録の種類です。fake と見本は実際の実行ではありません。受付の状態はボードで人が進めます。</p>'
          : '<p class="hint">AIの修正には上限（案）があります：同じ原因3回・合計6回・作業2時間・1タスク¥5,000（80%で警告、100%で停止）。上限に達すると自動で止まり、L2〜L4 のエスカレーションで人が判断します。操作はシミュレーションです。</p>');
    }
    if (t === 'rel') {
      const latestProd = {};
      o.deploys
        .filter((d) => d.env === 'prod' && d.result !== '失敗')
        .forEach((d) => {
          if (!latestProd[d.app]) latestProd[d.app] = d.id;
        });
      body =
        '<h3 class="h3" style="margin-top:0">' +
        ico('i-stamp') +
        'リリース判定（公開承認）待ち</h3>' +
        (relWait.length
          ? relWait
              .map(
                (r) =>
                  '<div class="mini" data-open="' +
                  E(r.id) +
                  '"><span class="no">' +
                  E(r.id) +
                  '</span><b>' +
                  E(r.title) +
                  '</b>' +
                  st(r.status) +
                  stay(r) +
                  (S.role === 'approver'
                    ? '<button type="button" class="btn sm go" data-act="rel|' +
                      E(r.id) +
                      '">' +
                      ico('i-stamp') +
                      'リリース判定</button>'
                    : '<small class="muted">承認者が判定します</small>') +
                  '</div>',
              )
              .join('')
          : '<p class="muted">いまはありません</p>') +
        '<p class="hint">公開承認は、マージとは別のリスク判断です。重大な不具合（GC-43）と権限・隔離（GC-44）は条件付きにしません。定例リリースは月1回＋緊急修正（提案）。</p>' +
        '<h3 class="h3">' +
        ico('i-git') +
        'デプロイの履歴</h3><div class="card tw"><table class="t"><thead><tr><th>番号</th><th>日時</th><th>道具</th><th>版</th><th>環境</th><th>変更の種類</th><th>PR</th><th>マージ／公開の承認</th><th>結果</th><th></th></tr></thead><tbody>' +
        o.deploys
          .slice()
          .sort((a, b) => (a.at < b.at ? 1 : -1))
          .map(
            (d) =>
              '<tr><td>' +
              mono(d.id) +
              '</td><td class="nw">' +
              E(SF.fmt(d.at)) +
              '</td><td>' +
              E(d.app ? (appOf(d.app) || {}).name || d.app : (find(d.req) || {}).title || d.req) +
              '</td><td>v' +
              E(d.ver) +
              '</td><td><span class="env ' +
              d.env +
              '">' +
              (d.env === 'prod' ? '本番' : 'ステージング') +
              '</span></td><td>' +
              E(d.type) +
              '</td><td>#' +
              E(d.pr) +
              '</td><td><small>' +
              E(d.mergeBy || '－') +
              '／' +
              E(d.releaseBy || '－') +
              '</small></td><td>' +
              pill(d.result, d.result === '成功' ? 'ok' : d.result === 'ロールバック' ? 'warn' : 'ng') +
              (d.incident ? '<br><small>' + E(d.incident) + '</small>' : '') +
              '</td><td>' +
              (d.env === 'prod' && latestProd[d.app] === d.id && d.result === '成功'
                ? btn('rollback', 'rb|' + d.app, 'ロールバック', 'i-undo', 'dng')
                : '') +
              '</td></tr>',
          )
          .join('') +
        '</tbody></table></div>';
    }
    if (t === 'met') {
      const rels = o.apps
        .map((a) => {
          const r = find(a.req);
          if (!r) return null;
          const ap = r.history.find((h) => /承認済み/.test(h.action));
          const fd = o.deploys.filter((d) => d.req === r.id && d.env === 'prod').sort((x, y) => (x.at < y.at ? -1 : 1))[0];
          return ap && fd ? (new Date(fd.at) - new Date(ap.at)) / 86400000 : null;
        })
        .filter((x) => x !== null)
        .sort((a, b) => a - b);
      const med = rels.length ? rels[Math.floor(rels.length / 2)].toFixed(1) : '－';
      const prodNR = o.deploys.filter((d) => d.env === 'prod' && d.result !== 'ロールバック');
      const failed = prodNR.filter((d) => d.incident || d.result === '失敗').length;
      const rest = o.incidents.filter((i) => i.restored && i.cat !== '開発ライン');
      const mttr = rest.length ? Math.round(rest.reduce((a, i) => a + minsBetween(i.opened, i.restored), 0) / rest.length) : 0;
      const waits = S.data.items
        .map((r) => {
          const w = r.history.find((h) => /「承認待ち」/.test(h.action)),
            a = r.history.find((h) => /「承認済み」/.test(h.action));
          return w && a ? (new Date(a.at) - new Date(w.at)) / 86400000 : null;
        })
        .filter((x) => x !== null);
      const costs = Object.values(o.pipes).filter((p) => p.step >= 9);
      const avgCost = costs.length ? Math.round(costs.reduce((a, p) => a + p.cost, 0) / costs.length) : 0;
      const backs = S.data.items.filter((r) => r.history.some((h) => /「差戻し」/.test(h.action))).length;
      const weeks = [];
      for (let w = 5; w >= 0; w--) {
        const from = Date.now() - (w + 1) * 7 * 86400000,
          to = Date.now() - w * 7 * 86400000;
        weeks.push({
          l: w === 0 ? '今週' : w + '週前',
          n: o.deploys.filter((d) => {
            const t = new Date(d.at).getTime();
            return d.env === 'prod' && t >= from && t < to;
          }).length,
        });
      }
      const mx = Math.max(1, ...weeks.map((w) => w.n));
      body =
        '<h3 class="h3" style="margin-top:0">' +
        ico('i-gauge') +
        'DevOps の4つの指標（DORAの考え方を参考に）</h3>' +
        '<div class="kpis k4">' +
        kcard('本番デプロイの回数（30日）', prod.filter((d) => d.result !== 'ロールバック').length, 'i-rocket', '回') +
        kcard('承認から本番までの日数（中央値）', med, 'i-clock', '日') +
        kcard(
          '変更の失敗率（障害・戻しになった割合）',
          prodNR.length ? Math.round((failed / prodNR.length) * 100) : 0,
          'i-alert',
          '%',
          failed ? 'warn' : '',
        ) +
        kcard('復旧までの平均時間', mttr ? dur(mttr) : '－', 'i-pulse', '') +
        '</div>' +
        '<div class="card pad"><b>週ごとの本番デプロイ</b><div class="wk">' +
        weeks
          .map((w) => '<div><i style="height:' + (w.n / mx) * 100 + '%"></i><b>' + w.n + '</b><small>' + w.l + '</small></div>')
          .join('') +
        '</div></div>' +
        '<h3 class="h3">' +
        ico('i-flag') +
        'みらいSFの8つの指標（抜粋）</h3><div class="card tw"><table class="t"><thead><tr><th>指標</th><th>いまの値（見本データ）</th><th>目標（案）</th></tr></thead><tbody>' +
        '<tr><td>KPI-03 受入条件を満たした割合（公開前）</td><td>100%（公開済み ' +
        o.apps.length +
        '件）</td><td>100%</td></tr>' +
        '<tr><td>KPI-04 差戻しの回数</td><td>' +
        backs +
        '件（全 ' +
        S.data.items.length +
        '件中）</td><td>差戻し1回以下・再試行2回以下</td></tr>' +
        '<tr><td>KPI-05 公開後の重大な不具合</td><td>' +
        o.incidents.filter((i) => i.sev === 'S1').length +
        '件</td><td>0件</td></tr>' +
        '<tr><td>KPI-06 完了タスクあたりの費用</td><td>¥' +
        avgCost.toLocaleString() +
        '</td><td>予算内（¥5,000（案）、80%警告・100%停止）</td></tr>' +
        '<tr><td>KPI-07 承認待ちの時間</td><td>' +
        (waits.length ? (waits.reduce((a, b) => a + b, 0) / waits.length).toFixed(1) + '日（平均）' : '－') +
        '</td><td>1営業日以内</td></tr>' +
        '<tr><td>KPI-01・02・08（リードタイム・人の手直し時間・再開成功率）</td><td class="muted">PoC から実測</td><td>実測後に決める（Q-12）</td></tr></tbody></table></div>';
    }
    if (t === 'chg') {
      body =
        '<div class="btool">' +
        btn('chgCreate', 'chgnew', '変更を申請', 'i-plus', 'go') +
        '<span class="sp"></span><span class="muted" style="font-size:12.5px">CI定義・保護ルール・権限は「管理責任者＋承認者」の2人の承認。実装AIは変えられません（CTL-03）</span></div>' +
        '<div class="card tw"><table class="t"><thead><tr><th>番号</th><th>種類</th><th>内容</th><th>申請</th><th>必要な承認</th><th>状態</th><th></th></tr></thead><tbody>' +
        o.changes
          .slice()
          .sort((a, b) => (a.at < b.at ? 1 : -1))
          .map((c) => {
            const mine =
              c.need.includes(S.role) &&
              !c.appr.some((a) => a.role === S.role) &&
              ['承認待ち', '事後承認待ち'].includes(c.status);
            return (
              '<tr><td>' +
              mono(c.id) +
              '</td><td>' +
              E(c.type) +
              '<br><small class="muted">' +
              E(c.area) +
              '</small></td><td><b>' +
              E(c.title) +
              '</b>' +
              (c.ref ? '<br><small class="muted">関連：' + E(c.ref) + '</small>' : '') +
              '</td><td class="nw">' +
              E(c.by) +
              '<br><small>' +
              E(ymdOf(c.at)) +
              '</small></td>' +
              '<td>' +
              c.need
                .map((k) => {
                  const a = c.appr.find((x) => x.role === k);
                  return (
                    '<span class="hl ' +
                    (a ? 'ok' : 'warn') +
                    '">' +
                    (a ? ico('i-check') : ico('i-clock')) +
                    E(RO[k]) +
                    (a ? '（' + E(a.by) + '）' : '') +
                    '</span>'
                  );
                })
                .join(' ') +
              '</td>' +
              '<td>' +
              pill(c.status, /適用済み|事後承認済み/.test(c.status) ? 'ok' : c.status === '承認済み' ? 'ok' : 'warn') +
              '</td>' +
              '<td class="nw">' +
              (mine
                ? c.by === me().name
                  ? '<button type="button" class="btn sm" disabled title="自分の申請は承認できません">' +
                    ico('i-check') +
                    '承認する</button>'
                  : '<button type="button" class="btn sm go" data-act="chgok|' +
                    c.id +
                    '">' +
                    ico('i-check') +
                    (c.status === '事後承認待ち' ? '事後承認する' : '承認する') +
                    '</button>'
                : '') +
              (c.status === '承認済み' ? btn('chgApply', 'chgap|' + c.id, '適用する', 'i-rocket') : '') +
              '</td></tr>'
            );
          })
          .join('') +
        '</tbody></table></div>';
    }
    if (t === 'gate') {
      const ph = [
        ['PoC', '技術的に成立するか？', 'G0 着手判定（GC-01〜05）／G1 Go / No-Go（GC-11〜23）', '準備中', '経営層'],
        [
          'Prototype（必要に応じて）',
          '利用者が理解・操作できるか？',
          'G2 MVP着手判定（GC-24〜33）',
          '画面の検証を先行（受付ステーション試作）',
          '業務責任者（代表）＋DX推進部 責任者',
        ],
        [
          'MVP',
          '最小の価値で、本当に使われるか？',
          'G3 Staging移行判定（GC-34〜41）',
          '未着手',
          '業務責任者（代表）＋DX推進部 責任者',
        ],
        [
          'Staging',
          '本番に近い条件で、安全・安定して運用できるか？',
          'G4 リリース判定（GC-42〜52）',
          '未着手',
          '公開承認者＋経営層',
        ],
        ['Release', '本番環境で、対象ユーザーへ正式提供する', 'G5 運用移行判定（GC-53〜57）', '未着手', 'DX推進部 責任者'],
        ['運用・改善', '計測→学習→改善→次リリース', '次のリリースは受付から G3・G4 を通る', '－', '－'],
      ];
      body =
        '<div class="card pad"><b>工場（みらいSF）そのもののフェーズ</b><p class="hint" style="margin-top:4px">フェーズ計画書 V1.0 の6フェーズとゲート。期間ではなく、ゲートのチェック項目を満たしたら次へ進みます。</p>' +
        '<div class="phs">' +
        ph
          .map(
            (x, i) =>
              '<div class="' +
              (i === 0 ? 'cur' : '') +
              '"><b>' +
              E(x[0]) +
              '</b><small>' +
              E(x[1]) +
              '</small><span>' +
              E(x[2]) +
              '</span><em>' +
              E(x[3]) +
              '</em></div>',
          )
          .join('') +
        '</div></div>' +
        '<h3 class="h3">' +
        ico('i-board') +
        '道具ごとの当てはめ（いま流れている依頼）</h3><div class="card tw"><table class="t"><thead><tr><th>受付番号</th><th>件名</th><th>型</th><th>いまのフェーズ</th></tr></thead><tbody>' +
        S.data.items
          .filter((r) => !['hold', 'cancel'].includes(r.status))
          .map((r) => {
            const c = colorOf(r),
              type =
                c === 'r'
                  ? '赤（対象外・範囲を変えて受け直す）'
                  : r.kind === 'いまある道具を良くしたい' || r.kind === '不具合の報告'
                    ? 'T1 小さな改善'
                    : c === 'y'
                      ? 'T3 新しい道具（黄）'
                      : 'T2 新しい道具（青）';
            const ph2 =
              {
                received: '企画（受付）',
                review: '企画（受付）',
                wait: '企画（承認＝G0）',
                approved: '作る（PoC／Prototype／MVP）',
                dev: '作る（PoC／Prototype／MVP）',
                verify: '検査と人の確認（Staging相当）',
                field: 'MVPの限定利用（モデル現場）',
                release_wait: 'G4 リリース判定',
                done: 'Release → 運用・改善',
                back: '企画（差戻し）',
              }[r.status] || '';
            return (
              '<tr data-open="' +
              E(r.id) +
              '"><td>' +
              mono(r.id) +
              '</td><td><b>' +
              E(r.title) +
              '</b></td><td>' +
              E(type) +
              (SF.isFieldTool(r) ? '＋現場向け' : '') +
              '</td><td>' +
              E(ph2) +
              '</td></tr>'
            );
          })
          .join('') +
        '</tbody></table></div>';
    }
    $('#view').innerHTML =
      '<div class="btool"><h2 class="h2" style="margin:0">' +
      ico('i-git') +
      'DevOps（開発ライン・リリース）</h2><span class="sp"></span><span class="muted" style="font-size:12.5px">' +
      (window.__MSF__
        ? '開発ライン欄は記録だけを表示します。リリース・指標・変更管理は見本です'
        : 'GitHub・CI・デプロイの動きを、オフラインで再現した見本です') +
      '</span></div>' +
      '<div class="kpis">' +
      kcard('開発ラインに流れている依頼', act.length, 'i-git', '件') +
      kcard(
        '止まっている（エスカレーション）',
        act.filter((x) => !window.__MSF__ && x.p.esc).length,
        'i-alert',
        '件',
        act.some((x) => !window.__MSF__ && x.p.esc) ? 'ng' : '',
      ) +
      kcard('マージ判断待ち', act.filter((x) => !window.__MSF__ && x.p.step === 9).length, 'i-stamp', '件') +
      kcard('リリース判定待ち', relWait.length, 'i-rocket', '件') +
      kcard('本番デプロイ（30日）', prod.filter((d) => d.result !== 'ロールバック').length, 'i-gauge', '回') +
      '</div>' +
      vtabs('dvtab', [
        ['line', '開発ライン', 'i-git', act.length || ''],
        ['rel', 'リリースとデプロイ', 'i-rocket', relWait.length || ''],
        ['met', 'DevOps 指標', 'i-gauge'],
        ['chg', '工場の変更管理', 'i-wrench', o.changes.filter((c) => /待ち/.test(c.status)).length || ''],
        ['gate', 'フェーズとゲート', 'i-flag'],
      ]) +
      '<div class="vbody">' +
      body +
      '</div>';
    bindTabs(renderDevops);
    bindCommon();
  }
  function pipeBtn(r, p) {
    const live = !!window.__MSF__;
    // 接続時の step 1 は投入ボタン（実 API）が別にあるので、見本のボタンを出さない
    if (live && p.step === 1) return '';
    const B = (ok, label, icon, why, cls) =>
      ok && !live
        ? '<button type="button" class="btn sm ' +
          (cls || 'go') +
          '" data-act="pipe|' +
          E(r.id) +
          '">' +
          ico(icon) +
          E(label) +
          '</button>'
        : '<button type="button" class="btn sm" disabled title="' +
          E(live ? SAMPLE_LOCK : why) +
          '">' +
          ico(icon) +
          E(label) +
          '</button>';
    if (p.step === 1)
      return B(
        can('pipeIssue') && r.status === 'approved',
        'Issueを作る（注文書を投入）',
        'i-git',
        r.status !== 'approved' ? '承認済みになってから投入します' : who('pipeIssue') + 'が操作します',
      );
    if (p.step >= 2 && p.step <= 4)
      return B(can('pipeRun'), 'AIの作業を進める（仕様案→計画→実装）', 'i-spark', who('pipeRun') + 'が操作します');
    if (p.step === 5) return B(can('pipeRun'), '自動検査（CI）を実行', 'i-check', who('pipeRun') + 'が操作します');
    if (p.step === 6 && p.esc) return B(true, 'エスカレーション（' + p.esc + '）を開く', 'i-alert', '', 'dng');
    if (p.step === 6) return B(can('pipeRun'), 'AIが修正して再検査', 'i-undo', who('pipeRun') + 'が操作します');
    if (p.step === 9) return B(can('merge'), 'マージを承認する', 'i-git', '承認者が判断します');
    if (p.step === 10)
      return B(
        can('stagingOk') && r.status === 'verify',
        'ステージングで確認済み → 次へ',
        'i-arrow',
        r.status === 'field' ? '現場試用中（試用結果を記録したらボードで次へ）' : who('stagingOk') + 'が操作します',
      );
    if (p.step === 11) return B(S.role === 'approver', 'リリース判定（公開承認）', 'i-stamp', '承認者が判定します');
    return '';
  }

  /* ================= SecOps ================= */
  function renderSecops() {
    const o = O(),
      t = S.sctab || 'vul';
    const openV = o.vulns.filter((v) => ['未対応', '対応中'].includes(v.status));
    const overV = openV.filter((v) => SF.daysLeft(SF.dueOf(v)) < 0),
      soonV = openV.filter((v) => {
        const d = SF.daysLeft(SF.dueOf(v));
        return d >= 0 && d <= 7;
      });
    const evOpen = o.secEvents.filter((e) => e.status === '未確認'),
      fOpen = o.findings.filter((f) => !['対応済み', '例外として承認'].includes(f.status)),
      ctlNg = o.controls.filter((c) => !c.ok);
    const rtAcc = o.routines.find((r) => r.id === 'RT-04');
    let body = '';
    if (t === 'vul') {
      body =
        '<div class="card tw"><table class="t"><thead><tr><th>番号</th><th>深刻度</th><th>内容</th><th>対象</th><th>見つけた日</th><th>修正期限</th><th>状態</th><th></th></tr></thead><tbody>' +
        o.vulns
          .slice()
          .sort((a, b) => (SF.dueOf(a) < SF.dueOf(b) ? -1 : 1))
          .map((v) => {
            const due = SF.dueOf(v),
              d = SF.daysLeft(due),
              done = v.status === '修正済み' || String(v.status).startsWith('リスク受容（期限');
            return (
              '<tr><td>' +
              mono(v.id) +
              '</td><td>' +
              vsevChip(v.sev) +
              '</td><td><b>' +
              E(v.title) +
              '</b><br><small class="muted">' +
              E(v.src) +
              (v.note ? '／' + E(v.note) : '') +
              '</small></td><td>' +
              (v.app
                ? E((appOf(v.app) || {}).name || v.app)
                : v.req
                  ? '<a data-open="' + E(v.req) + '">' + E(v.req) + '</a>'
                  : '基盤') +
              '</td><td class="nw">' +
              E(ymdOf(v.found)) +
              '</td>' +
              '<td class="nw ' +
              (!done && d < 0 ? 'over' : '') +
              '">' +
              E(ymdOf(due)) +
              (SF.VSEV[v.sev].an ? '<small>（案）</small>' : '') +
              '<br><small>' +
              (done ? '－' : d < 0 ? -d + '日超過' : d === 0 ? '今日が期限' : 'あと' + d + '日') +
              '</small></td>' +
              '<td>' +
              pill(v.status, done ? 'ok' : d < 0 ? 'ng' : 'warn') +
              (v.owner ? '<br><small>' + E(v.owner) + '</small>' : '') +
              '</td>' +
              '<td class="nw">' +
              vulBtns(v) +
              '</td></tr>'
            );
          })
          .join('') +
        '</tbody></table></div>' +
        '<p class="hint">修正の期限：重大は7日以内、高は30日以内（NFR-38）。中90日・低180日は（案）。期限までに直せないときは、理由と期限を書いて「リスク受容」を申請し、管理責任者と承認者の2人が判断します。</p>';
    }
    if (t === 'ev') {
      body =
        '<div class="card tw"><table class="t"><thead><tr><th>日時</th><th>種類</th><th>対象</th><th>内容</th><th>重大度</th><th>状態</th><th></th></tr></thead><tbody>' +
        o.secEvents
          .slice()
          .sort((a, b) => (a.at < b.at ? 1 : -1))
          .map(
            (e) =>
              '<tr><td class="nw">' +
              E(SF.fmt(e.at)) +
              '</td><td><b>' +
              E(e.kind) +
              '</b></td><td>' +
              (/^REQ-/.test(e.target) ? '<a data-open="' + E(e.target) + '">' + E(e.target) + '</a>' : E(e.target)) +
              '</td><td>' +
              E(e.text) +
              '</td><td>' +
              sevChip(e.sev) +
              '</td><td>' +
              pill(e.status, e.status === '未確認' ? 'warn' : 'ok') +
              (e.by ? '<br><small>' + E(e.by) + '</small>' : '') +
              '</td><td class="nw">' +
              (e.status === '未確認'
                ? btn('secTriage', 'evok|' + e.id, '確認した', 'i-check') +
                  ' ' +
                  btn('secTriage', 'evinc|' + e.id, '障害にする', 'i-alert', 'dng')
                : '') +
              '</td></tr>',
          )
          .join('') +
        '</tbody></table></div>' +
        '<p class="hint">Issue・README・添付の文章にある「権限を変えて」「検査を止めて」のような命令には、AIは従いません（NFR-05）。従わなかった記録もここに残ります。</p>';
    }
    if (t === 'acc') {
      const nx = SF.routineNext(rtAcc),
        d = SF.daysLeft(nx);
      body =
        '<div class="card pad"><b>' +
        ico('i-users') +
        ' Entra ID のグループと役割</b><p class="hint" style="margin-top:4px">本番では、みらいSFの役割を Entra ID のグループで判別し、非対話式のシングルサインオンで識別します。メンバーは Microsoft Graph から読み取る想定（提案）です。ここに出ている人と人数は見本です。</p>' +
        '<div class="tw"><table class="t"><thead><tr><th>グループ</th><th>役割</th><th>人数</th></tr></thead><tbody>' +
        o.groups.map((g) => '<tr><td>' + mono(g.g) + '</td><td>' + E(g.role) + '</td><td>' + E(g.n) + '</td></tr>').join('') +
        '</tbody></table></div>' +
        '<div class="data-row"><span class="hint" style="margin:0">前回の棚卸し：' +
        E(ymdOf(rtAcc.last)) +
        '　次回：<b class="' +
        (d < 0 ? 'over' : '') +
        '">' +
        E(ymdOf(nx)) +
        '（' +
        (d < 0 ? -d + '日超過' : 'あと' + d + '日') +
        '）</b></span><span class="sp"></span>' +
        (S.role === 'sec' || S.role === 'admin'
          ? '<button type="button" class="btn sm go" data-act="rt|RT-04">' + ico('i-check') + '棚卸しを記録</button>'
          : '') +
        '</div></div>' +
        '<h3 class="h3">' +
        ico('i-alert') +
        '棚卸しの指摘</h3><div class="card tw"><table class="t"><thead><tr><th>番号</th><th>指摘</th><th>だれ</th><th>グループ</th><th>内容</th><th>状態</th><th></th></tr></thead><tbody>' +
        o.findings
          .map(
            (f) =>
              '<tr><td>' +
              mono(f.id) +
              '</td><td><b>' +
              E(f.kind) +
              '</b></td><td>' +
              E(f.who) +
              '</td><td>' +
              mono(f.group) +
              '</td><td>' +
              E(f.text) +
              (f.note ? '<br><small class="muted">対応：' + E(f.note) + '</small>' : '') +
              '</td><td>' +
              pill(f.status, ['対応済み', '例外として承認'].includes(f.status) ? 'ok' : 'warn') +
              '</td><td class="nw">' +
              (f.status === '未対応'
                ? btn('access', 'arfix|' + f.id, '対応を記録', 'i-check')
                : f.status === '例外の承認待ち'
                  ? S.role === 'admin'
                    ? '<button type="button" class="btn sm go" data-act="arex|' +
                      f.id +
                      '">' +
                      ico('i-check') +
                      '例外を判断</button>'
                    : '<small class="muted">管理責任者が判断</small>'
                  : '') +
              '</td></tr>',
          )
          .join('') +
        '</tbody></table></div>';
    }
    if (t === 'gate') {
      body =
        '<div class="card tw"><table class="t"><thead><tr><th>番号</th><th>守っていること</th><th>状態</th><th>最後の点検</th><th></th></tr></thead><tbody>' +
        o.controls
          .map(
            (c) =>
              '<tr><td>' +
              mono(c.id) +
              '</td><td><b>' +
              E(c.t) +
              '</b>' +
              (c.note ? '<br><small class="muted">' + E(c.note) + '</small>' : '') +
              '</td><td>' +
              pill(c.ok ? '有効' : '要対応', c.ok ? 'ok' : 'ng') +
              '</td><td class="nw">' +
              E(ymdOf(c.checked)) +
              '<br><small>' +
              E(c.by) +
              '</small></td><td>' +
              btn('control', 'ctl|' + c.id, c.ok ? '点検を記録' : '直したことを記録', 'i-check') +
              '</td></tr>',
          )
          .join('') +
        '</tbody></table></div>' +
        '<p class="hint">品質ゲート（合格しないと先へ進めない関所）は、実装AIが弱めたり外したりできないように守ります。点検は毎月（RT-05）。承認記録のない変更は S1 として扱います。</p>';
    }
    if (t === 'audit') {
      const q = (S.aq || '').toLowerCase(),
        list = o.audit
          .slice()
          .reverse()
          .filter((e) => !q || [e.by, e.role, e.action, e.target, e.detail].join(' ').toLowerCase().includes(q));
      const vr = S.auditResult;
      body =
        '<div class="btool"><input type="search" id="aq" placeholder="だれ・操作・対象で絞り込み" value="' +
        E(S.aq || '') +
        '" style="max-width:320px"><span class="sp"></span>' +
        '<button type="button" class="btn sm pri" data-act="auv">' +
        ico('i-shield') +
        '改ざんがないか検証</button>' +
        btn('auditExport', 'aucsv', 'CSVで書き出す', 'i-down') +
        btn('tamperDemo', 'audemo', '改ざん検知を試す（デモ）', 'i-alert', 'dng') +
        '</div>' +
        (vr
          ? '<div class="ban ' + (vr.ok ? 'ok' : 'ng') + '">' + ico(vr.ok ? 'i-check' : 'i-alert') + E(vr.msg) + '</div>'
          : '') +
        '<div class="card tw"><table class="t aud"><thead><tr><th>No.</th><th>日時</th><th>だれ（役割）</th><th>操作</th><th>対象</th><th>内容</th><th>ハッシュ</th></tr></thead><tbody>' +
        list
          .slice(0, 200)
          .map(
            (e) =>
              '<tr><td>' +
              e.no +
              '</td><td class="nw">' +
              E(SF.fmt(e.at)) +
              '</td><td>' +
              E(e.by) +
              (e.role ? '<br><small class="muted">' + E(e.role) + '</small>' : '') +
              '</td><td><b>' +
              E(e.action) +
              '</b></td><td>' +
              E(e.target) +
              '</td><td><small>' +
              E(e.detail) +
              '</small></td><td>' +
              mono(e.hash) +
              '</td></tr>',
          )
          .join('') +
        '</tbody></table></div>' +
        '<p class="hint">' +
        list.length +
        ' 件（新しい順、最大200件を表示）。記録は追記のみで、1件ごとに「前の記録のハッシュ」を含めて鎖のようにつないでいます。1件でも書きかわると、そこから先の鎖が合わなくなります（見本は簡易ハッシュ。本番は SHA-256 など、提案）。</p>';
    }
    $('#view').innerHTML =
      '<div class="btool"><h2 class="h2" style="margin:0">' +
      ico('i-lock') +
      'SecOps（セキュリティの運用）</h2><span class="sp"></span><span class="muted" style="font-size:12.5px">見本データです。実在の脆弱性番号は使っていません</span></div>' +
      '<div class="kpis">' +
      kcard('期限切れの脆弱性', overV.length, 'i-alert', '件', overV.length ? 'ng' : '') +
      kcard('7日以内に期限', soonV.length, 'i-clock', '件', soonV.length ? 'warn' : '') +
      kcard('未確認の通知', evOpen.length, 'i-shield', '件', evOpen.length ? 'warn' : '') +
      kcard('棚卸しの未対応', fOpen.length, 'i-users', '件', fOpen.length ? 'warn' : '') +
      kcard('品質ゲートの要対応', ctlNg.length, 'i-lock', '件', ctlNg.length ? 'ng' : '') +
      '</div>' +
      vtabs('sctab', [
        ['vul', '脆弱性', 'i-bug', openV.length || ''],
        ['ev', 'セキュリティ通知', 'i-shield', evOpen.length || ''],
        ['acc', '権限の棚卸し', 'i-users', fOpen.length || ''],
        ['gate', '品質ゲート', 'i-lock', ctlNg.length || ''],
        ['audit', '監査ログ', 'i-doc'],
      ]) +
      '<div class="vbody">' +
      body +
      '</div>';
    bindTabs(renderSecops);
    bindCommon();
    const aq = $('#aq');
    if (aq)
      aq.addEventListener('input', (e) => {
        S.aq = e.target.value;
        const p = e.target.selectionStart;
        renderSecops();
        const x = $('#aq');
        x.focus();
        try {
          x.setSelectionRange(p, p);
        } catch (_) {}
      });
  }
  function vulBtns(v) {
    if (v.status === '修正済み' || String(v.status).startsWith('リスク受容（期限')) return '';
    if (v.status === 'リスク受容（承認待ち）') {
      const mine = v.accept.need.includes(S.role) && !v.accept.appr.some((a) => a.role === S.role);
      return (
        '<small class="muted">申請：' +
        E(v.accept.reason) +
        '</small><br>' +
        v.accept.need
          .map((k) => {
            const a = v.accept.appr.find((x) => x.role === k);
            return '<span class="hl ' + (a ? 'ok' : 'warn') + '">' + E(RO[k]) + '</span>';
          })
          .join(' ') +
        (mine
          ? '<br><button type="button" class="btn sm go" data-act="vacc|' +
            v.id +
            '">' +
            ico('i-check') +
            '承認する</button> <button type="button" class="btn sm" data-act="vrej|' +
            v.id +
            '">' +
            ico('i-x') +
            '認めない</button>'
          : '')
      );
    }
    return (
      (v.status === '未対応' ? btn('vulnWork', 'vown|' + v.id, '担当する', 'i-users') + ' ' : '') +
      btn('vulnFix', 'vfix|' + v.id, '修正済みにする', 'i-check', 'go') +
      ' ' +
      btn('vulnWork', 'vreq|' + v.id, 'リスク受容を申請', 'i-flag')
    );
  }

  /* ---- 共通の操作 ---- */
  function bindCommon() {
    $$('#view [data-open]').forEach((a) =>
      a.addEventListener('click', (e) => {
        e.stopPropagation();
        openDrawer(a.dataset.open);
      }),
    );
    $$('#view [data-act]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        doAct(b.dataset.act);
      }),
    );
  }
  function askText(title, label, ph, okLabel, fn, opts) {
    opts = opts || {};
    modal(
      title,
      (opts.pre || '') +
        '<label class="fl" for="atx">' +
        E(label) +
        (opts.optional ? '' : '<span class="muted" style="font-weight:400;font-size:12px">（必須）</span>') +
        '</label><textarea id="atx" style="min-height:70px" placeholder="' +
        E(ph || '') +
        '">' +
        E(opts.value || '') +
        '</textarea>',
      '<button class="btn" data-x type="button">キャンセル</button><button class="btn pri" id="atok" type="button">' +
        ico('i-check') +
        E(okLabel) +
        '</button>',
    );
    $('#atok').addEventListener('click', () => {
      const v = $('#atx').value.trim();
      if (!v && !opts.optional) return toast(label + 'を書いてください', true);
      if (opts.check && !opts.check()) return;
      closeModal();
      fn(v);
    });
  }
  function doAct(a) {
    const [k, id] = a.split('|'),
      o = O(),
      now = SF.nowISO();
    if (S.role === 'auditor' && !['appd', 'incd', 'auv', 'aucsv', 'audemo'].includes(k))
      return toast('内部監査は閲覧のみです', true);
    if (k === 'pipe') {
      const r = find(id);
      if (r) pipeAct(r);
      return;
    }
    if (k === 'rel') {
      const r = find(id);
      if (r) openStatus(r, 'done');
      return;
    }
    if (k === 'appd') return openApp(id);
    if (k === 'incd') return openInc(id);
    if (k === 'incnew') {
      modal(
        ico('i-alert') + '障害を起票する',
        '<label class="fl">対象</label><select id="ia"><option value="">開発ライン・基盤</option>' +
          o.apps
            .map((x) => '<option value="' + x.id + '"' + (x.id === id ? ' selected' : '') + '>' + E(x.name) + '</option>')
            .join('') +
          '</select>' +
          '<label class="fl">重大度</label><div class="stopts">' +
          ['S1', 'S2', 'S3', 'S4']
            .map(
              (s) =>
                '<label><input type="radio" name="isv" value="' +
                s +
                '"' +
                (s === 'S3' ? ' checked' : '') +
                '>' +
                sevChip(s) +
                '<small class="muted">' +
                E(SF.SEV[s].ex) +
                '</small></label>',
            )
            .join('') +
          '</div>' +
          '<label class="fl" for="it">何が起きているか<span class="muted" style="font-weight:400;font-size:12px">（必須）</span></label><textarea id="it" style="min-height:60px" placeholder="例：検索結果が0件になる（支店から3件の問い合わせ）"></textarea>',
        '<button class="btn" data-x type="button">キャンセル</button><button class="btn pri" id="iok" type="button">' +
          ico('i-check') +
          '起票する</button>',
      );
      $('#iok').addEventListener('click', () => {
        const t = $('#it').value.trim();
        if (!t) return toast('何が起きているかを書いてください', true);
        const sv = ($('#modal input[name=isv]:checked') || {}).value,
          app = $('#ia').value;
        const inc = {
          id: 'INC-2026-' + String(++o.seq.inc).padStart(3, '0'),
          app,
          cat: S.role === 'sec' ? 'セキュリティ' : app ? 'アプリ' : '開発ライン',
          sev: sv,
          title: t,
          opened: now,
          ack: now,
          restored: '',
          closed: '',
          status: '対応中',
          owner: me().name,
          cause: '',
          prevention: '',
          log: [{ at: now, by: me().name, t: '起票・初動開始' }],
        };
        o.incidents.unshift(inc);
        addAudit('障害を起票（' + sv + '）', inc.id, t);
        persist();
        closeModal();
        S.otab = 'inc';
        go('ops');
        toast(inc.id + ' を起票しました' + (sv === 'S1' ? '。S1 は電話で即時連絡し、当日中に報告書を出します' : ''));
      });
      return;
    }
    if (k === 'rb') {
      const app = appOf(id);
      if (!app) return;
      const prods = o.deploys
        .filter((d) => d.app === id && d.env === 'prod' && d.result === '成功')
        .sort((x, y) => (x.at < y.at ? 1 : -1));
      const prev = prods.find((d) => d.ver !== app.ver);
      if (!prev) return toast('戻せる前の版がありません', true);
      askText(
        ico('i-undo') + 'ロールバック　<span class="muted" style="font-size:12.5px">' + E(app.name) + '</span>',
        '戻す理由',
        '例：v' + app.ver + ' で検索結果がおかしい（INC-…）',
        'v' + prev.ver + ' に戻す',
        (note) => {
          o.deploys.unshift({
            id: 'DEP-' + String(++o.seq.dep).padStart(4, '0'),
            app: id,
            req: app.req,
            ver: prev.ver,
            env: 'prod',
            at: SF.nowISO(),
            type: '緊急',
            pr: prev.pr,
            result: 'ロールバック',
            mergeBy: '',
            releaseBy: me().name,
            by: 'デプロイジョブ',
            note,
          });
          const from = app.ver;
          app.ver = prev.ver;
          const c = {
            id: 'CHG-2026-' + String(++o.seq.chg).padStart(3, '0'),
            type: '緊急',
            area: 'リリース',
            title: app.name + ' v' + from + ' → v' + prev.ver + ' へのロールバック',
            by: me().name,
            at: SF.nowISO(),
            need: ['admin', 'approver'],
            appr: [],
            status: '事後承認待ち',
            ref: '',
          };
          o.changes.unshift(c);
          addAudit('ロールバック（本番）', id, 'v' + from + ' → v' + prev.ver + '／' + note);
          addAudit('緊急変更（事後承認待ち）', c.id, c.title);
          persist();
          refreshAll('v' + prev.ver + ' に戻しました。緊急変更 ' + c.id + ' の事後承認を管理責任者と承認者に依頼しました');
        },
        {
          pre:
            '<p style="margin:0 0 8px">直前の承認済みの版 <b>v' +
            E(prev.ver) +
            '</b>（' +
            E(SF.fmt(prev.at)) +
            '）へ戻します。目標：30分以内（案）。<b>緊急変更</b>として記録し、あとで管理責任者と承認者が事後承認します。</p>',
        },
      );
      return;
    }
    if (k === 'fbreq') {
      const f = o.feedback.find((x) => x.id === id),
        app = appOf(f.app);
      if (!f || !app) return;
      const r = Object.assign(SF.blank(S.role), {
        title: app.name + '：' + f.text.slice(0, 30),
        kind: 'いまある道具を良くしたい',
        dept: app.dept,
        applicant: f.from,
        problem: f.text + '（利用者の声 ' + f.id + '）',
        purpose: app.name + ' を改善する',
        users: ['本社の本部の担当者'],
        scope: '',
        criteria: [''],
        decides: 'g',
      });
      if (window.__MSF__) return startRequestFrom(r, { kind: 'feedback', id: f.id });
      r.id = SF.nextId(S.data);
      r.createdAt = now;
      r.updatedAt = now;
      r.status = 'received';
      r.history = [
        { at: now, by: me().name, role: me().l, action: '受付', note: '利用者の声 ' + f.id + '（' + app.id + '）から登録' },
      ];
      S.data.items.push(r);
      f.status = '依頼にした';
      f.ref = r.id;
      addAudit('利用者の声を依頼にした', r.id, f.id + '／' + app.name);
      persist();
      toast(r.id + ' として受け付けました。作るもの・合格の条件を書き足してください');
      openDrawer(r.id);
      render();
      return;
    }
    if (k === 'fbno') {
      const f = o.feedback.find((x) => x.id === id);
      return askText(ico('i-x') + '対応しない', '理由', '例：次の定例リリース（v1.2）で対応済みのため', '記録する', (t) => {
        f.status = '対応しない';
        f.note = t;
        addAudit('利用者の声：対応しない', f.id, t);
        persist();
        refreshAll('記録しました');
      });
    }
    if (k === 'rt') {
      const r = o.routines.find((x) => x.id === id);
      if (!r) return;
      if (!(r.who === S.role || S.role === 'admin')) return toast(RO[r.who] + 'が記録します', true);
      return askText(
        ico('i-check') + '定期作業の実施を記録　<span class="muted" style="font-size:12.5px">' + E(r.title) + '</span>',
        '結果',
        '例：成功／異常なし／指摘2件',
        '記録する',
        (t) => {
          r.last = SF.nowISO();
          r.result = t;
          addAudit('定期作業を実施', r.id, r.title + '／' + t);
          persist();
          refreshAll('記録しました。次回は ' + ymdOf(SF.routineNext(r)) + ' です');
        },
        { value: r.id === 'RT-04' ? '指摘0件' : '成功' },
      );
    }
    if (k === 'chgnew') {
      const AREAS = {
        '開発標準・ひな形': ['desk', 'approver'],
        道具カタログ: ['desk', 'approver'],
        'CI・品質ゲート': ['admin', 'approver'],
        '権限・役割': ['admin', 'approver'],
        リリース: ['admin', 'approver'],
      };
      modal(
        ico('i-wrench') + '変更を申請する',
        '<label class="fl">種類</label><select id="ct"><option>通常</option><option>標準</option><option>緊急</option></select>' +
          '<label class="fl">対象</label><select id="ca">' +
          Object.keys(AREAS)
            .map((x) => '<option>' + x + '</option>')
            .join('') +
          '</select>' +
          '<div class="hint" id="cneed"></div><label class="fl" for="cti">変更の内容<span class="muted" style="font-weight:400;font-size:12px">（必須）</span></label><textarea id="cti" style="min-height:60px" placeholder="例：シークレット検査の対象に設定ファイルを加える"></textarea>',
        '<button class="btn" data-x type="button">キャンセル</button><button class="btn pri" id="cok" type="button">' +
          ico('i-check') +
          '申請する</button>',
      );
      const need = () => ($('#ct').value === '標準' ? ['desk'] : AREAS[$('#ca').value]);
      const upd = () => {
        $('#cneed').textContent =
          '必要な承認：' +
          need()
            .map((k2) => RO[k2])
            .join('＋') +
          ($('#ct').value === '緊急'
            ? '（先に適用し、あとで事後承認）'
            : $('#ct').value === '標準'
              ? '（承認済みの手順どおりの変更）'
              : '');
      };
      $('#ct').addEventListener('change', upd);
      $('#ca').addEventListener('change', upd);
      upd();
      $('#cok').addEventListener('click', () => {
        const t = $('#cti').value.trim();
        if (!t) return toast('変更の内容を書いてください', true);
        const ty = $('#ct').value,
          c = {
            id: 'CHG-2026-' + String(++o.seq.chg).padStart(3, '0'),
            type: ty,
            area: $('#ca').value,
            title: t,
            by: me().name,
            at: SF.nowISO(),
            need: need(),
            appr: [],
            status: ty === '緊急' ? '事後承認待ち' : '承認待ち',
          };
        o.changes.unshift(c);
        addAudit('変更を申請（' + ty + '）', c.id, t);
        persist();
        closeModal();
        refreshAll(c.id + ' を申請しました');
      });
      return;
    }
    if (k === 'chgok') {
      const c = o.changes.find((x) => x.id === id);
      if (!c) return;
      if (c.by === me().name) return toast('自分の申請は承認できません（職務の分離）', true);
      if (!c.need.includes(S.role)) return toast('この変更の承認者ではありません', true);
      c.appr.push({ role: S.role, by: me().name, at: SF.nowISO() });
      if (c.need.every((k2) => c.appr.some((a2) => a2.role === k2)))
        c.status = c.status === '事後承認待ち' ? '事後承認済み' : c.type === '標準' ? '適用済み' : '承認済み';
      addAudit('変更を承認', c.id, RO[S.role] + 'として承認');
      persist();
      return refreshAll(c.status === '承認済み' ? '承認がそろいました。運用担当・受付担当が適用します' : '承認しました');
    }
    if (k === 'chgap') {
      const c = o.changes.find((x) => x.id === id);
      c.status = '適用済み';
      addAudit('変更を適用', c.id, c.title);
      persist();
      return refreshAll(c.id + ' を適用しました');
    }
    if (k === 'vown') {
      const v = o.vulns.find((x) => x.id === id);
      v.owner = me().name;
      v.status = '対応中';
      addAudit('脆弱性を担当', v.id, me().name);
      persist();
      return refreshAll('担当しました');
    }
    if (k === 'vfix') {
      const v = o.vulns.find((x) => x.id === id);
      return askText(
        ico('i-check') + '修正済みにする　<span class="muted" style="font-size:12.5px">' + E(v.id) + '</span>',
        '修正の証拠',
        '例：PR #140 で部品を更新、CIの依存関係検査が合格',
        '修正済みにする',
        (t) => {
          v.status = '修正済み';
          v.fixed = SF.nowISO();
          v.note = t;
          v.owner = v.owner || me().name;
          addAudit('脆弱性を修正済みに', v.id, t);
          persist();
          refreshAll(v.id + ' を修正済みにしました');
        },
      );
    }
    if (k === 'vreq') {
      const v = o.vulns.find((x) => x.id === id);
      return askText(
        ico('i-flag') + 'リスク受容を申請　<span class="muted" style="font-size:12.5px">' + E(v.id) + '</span>',
        '理由と期限・代わりの対策',
        '例：修正版が出るまで（〜11/30）。該当機能を止めて影響をなくす',
        '申請する',
        (t) => {
          v.accept = { reason: t, need: ['admin', 'approver'], appr: [], at: SF.nowISO(), by: me().name };
          v.status = 'リスク受容（承認待ち）';
          addAudit('リスク受容を申請', v.id, t);
          persist();
          refreshAll('申請しました。管理責任者と承認者が判断します');
        },
      );
    }
    if (k === 'vacc' || k === 'vrej') {
      const v = o.vulns.find((x) => x.id === id);
      if (!v || !v.accept) return;
      if (k === 'vrej') {
        v.status = '対応中';
        addAudit('リスク受容を認めない', v.id, RO[S.role]);
        v.accept = null;
        persist();
        return refreshAll('認めませんでした。修正を続けます');
      }
      v.accept.appr.push({ role: S.role, by: me().name, at: SF.nowISO() });
      if (v.accept.need.every((k2) => v.accept.appr.some((a2) => a2.role === k2))) {
        const lim = new Date(Date.now() + 30 * 86400000).toISOString();
        v.status = 'リスク受容（期限 ' + ymdOf(lim) + '）';
      }
      addAudit('リスク受容を承認', v.id, RO[S.role]);
      persist();
      return refreshAll('承認しました');
    }
    if (k === 'evok') {
      const e = o.secEvents.find((x) => x.id === id);
      return askText(
        ico('i-check') + '通知を確認した　<span class="muted" style="font-size:12.5px">' + E(e.id) + '</span>',
        '確認した内容・対応',
        '例：エージェントは従っておらず影響なし。依頼者に添付の出どころを確認',
        '記録する',
        (t) => {
          e.status = '対応済み';
          e.by = me().name;
          e.note = t;
          addAudit('セキュリティ通知を確認', e.id, t);
          persist();
          refreshAll('記録しました');
        },
      );
    }
    if (k === 'evinc') {
      const e = o.secEvents.find((x) => x.id === id);
      const inc = {
        id: 'INC-2026-' + String(++o.seq.inc).padStart(3, '0'),
        app: '',
        req: /^REQ-/.test(e.target) ? e.target : '',
        cat: 'セキュリティ',
        sev: e.sev,
        title: e.kind + '（' + e.target + '）',
        opened: SF.nowISO(),
        ack: SF.nowISO(),
        restored: '',
        closed: '',
        status: '対応中',
        owner: me().name,
        cause: '',
        prevention: '',
        log: [{ at: SF.nowISO(), by: me().name, t: 'セキュリティ通知 ' + e.id + ' から起票。証跡を保全' }],
      };
      o.incidents.unshift(inc);
      e.status = '障害にした';
      e.by = me().name;
      addAudit('セキュリティ通知を障害に', inc.id, e.id);
      persist();
      S.otab = 'inc';
      go('ops');
      return toast(inc.id + ' を起票しました');
    }
    if (k === 'arfix') {
      const f = o.findings.find((x) => x.id === id);
      modal(
        ico('i-users') + '棚卸しの指摘に対応　<span class="muted" style="font-size:12.5px">' + E(f.id) + '</span>',
        '<p style="margin:0 0 8px"><b>' +
          E(f.kind) +
          '</b>：' +
          E(f.who) +
          '（' +
          E(f.group) +
          '）</p><div class="stopts">' +
          [
            ['グループから外す依頼を出した', 'fix'],
            ['本人に設定してもらった（MFAなど）', 'fix'],
            ['役割を分けた（職務の分離）', 'fix'],
            ['例外として申請する（管理責任者が判断）', 'ex'],
          ]
            .map(
              (x, i) =>
                '<label><input type="radio" name="ar" value="' +
                i +
                '"' +
                (i === 0 ? ' checked' : '') +
                '>' +
                E(x[0]) +
                '</label>',
            )
            .join('') +
          '</div><label class="fl" for="arn">メモ<span class="muted" style="font-weight:400;font-size:12px">（必須）</span></label><textarea id="arn" style="min-height:60px" placeholder="例：人事の退職者一覧と突き合わせ、Entra ID 管理者に削除を依頼"></textarea>',
        '<button class="btn" data-x type="button">キャンセル</button><button class="btn pri" id="arok" type="button">' +
          ico('i-check') +
          '記録する</button>',
      );
      $('#arok').addEventListener('click', () => {
        const n = $('#arn').value.trim();
        if (!n) return toast('メモを書いてください', true);
        const i = +($('#modal input[name=ar]:checked') || {}).value;
        f.note = n;
        f.by = me().name;
        f.status = i === 3 ? '例外の承認待ち' : '対応済み';
        addAudit('権限の棚卸し：' + (i === 3 ? '例外を申請' : '対応'), f.id, n);
        persist();
        closeModal();
        refreshAll('記録しました');
      });
      return;
    }
    if (k === 'arex') {
      const f = o.findings.find((x) => x.id === id);
      return askText(
        ico('i-check') + '例外を判断　<span class="muted" style="font-size:12.5px">' + E(f.id) + '</span>',
        '判断と期限',
        '例：異動の引継ぎ期間として 11/30 まで例外を認める',
        '例外として承認',
        (t) => {
          f.status = '例外として承認';
          f.note = (f.note ? f.note + '／' : '') + t;
          addAudit('権限の例外を承認', f.id, t);
          persist();
          refreshAll('例外として承認しました');
        },
      );
    }
    if (k === 'ctl') {
      const c = o.controls.find((x) => x.id === id);
      return askText(
        ico('i-check') +
          (c.ok ? '点検を記録' : '直したことを記録') +
          '　<span class="muted" style="font-size:12.5px">' +
          E(c.id) +
          '</span>',
        '点検の結果',
        c.ok ? '例：設定どおり。保護解除の記録なし' : '例：圏外テストを必須チェックに追加（CHG申請済み）',
        '記録する',
        (t) => {
          c.checked = SF.nowISO();
          c.by = me().name;
          if (!c.ok) {
            c.ok = 1;
            c.note = '対応：' + t;
          }
          addAudit('品質ゲートを点検', c.id, t);
          persist();
          refreshAll('記録しました');
        },
        { value: c.ok ? '異常なし' : '' },
      );
    }
    if (k === 'auv') {
      const v = SF.verifyAudit(o.audit);
      S.auditResult = v.ok
        ? {
            ok: true,
            msg:
              '検証しました：全 ' +
              o.audit.length +
              ' 件の鎖がつながっており、改ざんは見つかりませんでした（' +
              SF.fmt(SF.nowISO()) +
              '）',
          }
        : {
            ok: false,
            msg: 'No.' + (v.at + 1) + ' から先の鎖が合いません。改ざんの疑いがあります（S1：内部監査・管理責任者へ）',
          };
      addAudit('監査ログを検証', '監査ログ', v.ok ? '異常なし' : '不一致 No.' + (v.at + 1));
      persist();
      return renderSecops();
    }
    if (k === 'aucsv') {
      const cell = (x) => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
      const csv =
        '﻿' +
        ['No.', '日時', 'だれ', '役割', '操作', '対象', '内容', '前のハッシュ', 'ハッシュ'].map(cell).join(',') +
        '\r\n' +
        o.audit
          .map((e) => [e.no, SF.fmt(e.at), e.by, e.role, e.action, e.target, e.detail, e.prev, e.hash].map(cell).join(','))
          .join('\r\n');
      addAudit('監査ログを書き出し', '監査ログ', o.audit.length + '件');
      persist();
      return SF.download('監査ログ_' + ymd() + '.csv', csv, 'text/csv')
        ? toast('CSVを書き出しました')
        : toast('書き出せませんでした', true);
    }
    if (k === 'audemo') {
      const copy = JSON.parse(JSON.stringify(o.audit));
      const n = Math.min(5, copy.length - 1);
      copy[n].detail = copy[n].detail + '（書きかえ）';
      const v = SF.verifyAudit(copy);
      S.auditResult = {
        ok: false,
        msg:
          'デモ：コピーした記録の No.' +
          (n + 1) +
          ' の内容を1文字書きかえて検証すると、' +
          (v.ok ? '検知できませんでした' : 'No.' + (v.at + 1) + ' で不一致を検知しました') +
          '。本物の記録は変えていません。',
      };
      return renderSecops();
    }
  }
  function openApp(id) {
    const o = O(),
      a = appOf(id);
    if (!a) return;
    const h = health(a);
    const deps = o.deploys.filter((d) => d.app === id).sort((x, y) => (x.at < y.at ? 1 : -1)),
      incs = o.incidents.filter((i) => i.app === id),
      vs = o.vulns.filter((v) => v.app === id),
      fbs = o.feedback.filter((f) => f.app === id);
    modal(
      ico('i-rocket') + E(a.name) + '　<span class="muted" style="font-size:12.5px">' + E(a.id) + ' v' + E(a.ver) + '</span>',
      '<p style="margin:0 0 8px">' +
        pill(h.l, h.k) +
        '　' +
        E(h.why.join('／')) +
        '</p>' +
        '<dl class="kv"><dt>元の依頼</dt><dd>' +
        E(a.req) +
        '</dd><dt>公開の範囲</dt><dd>' +
        E(a.wave) +
        '（' +
        E(SF.fmt(a.since)) +
        ' から）</dd><dt>業務の持ち主</dt><dd>' +
        E(a.owner) +
        '</dd><dt>運用担当</dt><dd>' +
        E(a.opsOwner) +
        '</dd><dt>稼働率（30日）</dt><dd>' +
        a.avail +
        '%（目標 ' +
        a.slo +
        '%）</dd><dt>エラー率・応答</dt><dd>' +
        a.err +
        '%・P95 ' +
        a.p95 +
        '秒（目標（案）：初期表示2秒以内）</dd><dt>利用者</dt><dd>月 ' +
        a.mau +
        ' 人／対象 ' +
        a.users +
        ' 人</dd><dt>今月の費用</dt><dd>¥' +
        a.spent.toLocaleString() +
        '／¥' +
        a.budget.toLocaleString() +
        '</dd></dl>' +
        '<h4 class="h4">デプロイ</h4><ul class="tl">' +
        deps
          .map(
            (d) =>
              '<li><b>v' +
              E(d.ver) +
              '（' +
              (d.env === 'prod' ? '本番' : 'ステージング') +
              '・' +
              E(d.result) +
              '）</b><small>' +
              E(SF.fmt(d.at)) +
              '　PR #' +
              E(d.pr) +
              '　' +
              E(d.type) +
              '</small><div>' +
              E(d.note || '') +
              '</div></li>',
          )
          .join('') +
        '</ul>' +
        '<h4 class="h4">障害 ' +
        incs.length +
        '件・脆弱性 ' +
        vs.length +
        '件・利用者の声 ' +
        fbs.length +
        '件</h4><ul>' +
        incs
          .map((i) => '<li>' + E(i.id) + ' ' + E(SF.SEV[i.sev].l) + ' ' + E(i.title) + '（' + E(i.status) + '）</li>')
          .join('') +
        vs.map((v) => '<li>' + E(v.id) + ' ' + E(SF.VSEV[v.sev].l) + ' ' + E(v.title) + '（' + E(v.status) + '）</li>').join('') +
        fbs.map((f) => '<li>' + E(f.id) + ' ' + E(f.text) + '（' + E(f.status) + '）</li>').join('') +
        '</ul>',
      '<button class="btn" type="button" id="apreq">' +
        ico('i-doc') +
        '元の依頼を開く</button><button class="btn pri" data-x type="button">閉じる</button>',
    );
    $('#apreq').addEventListener('click', () => {
      closeModal();
      openDrawer(a.req);
    });
  }
  function openInc(id) {
    const o = O(),
      i = o.incidents.find((x) => x.id === id);
    if (!i) return;
    const sv = SF.SEV[i.sev],
      canU = can('incUpdate') || (i.cat === '開発ライン' && S.role === 'desk');
    modal(
      ico('i-alert') + E(i.id) + '　' + sevChip(i.sev),
      '<p style="margin:0 0 6px"><b>' +
        E(i.title) +
        '</b></p><p class="hint" style="margin:0 0 8px">目標：初動 ' +
        E(sv.ackL) +
        '・復旧 ' +
        E(sv.fixL) +
        '　起票 ' +
        E(SF.fmt(i.opened)) +
        '　状態 ' +
        E(i.status) +
        '</p>' +
        '<ul class="tl">' +
        i.log
          .slice()
          .reverse()
          .map((l) => '<li><b>' + E(l.t) + '</b><small>' + E(SF.fmt(l.at)) + '　' + E(l.by) + '</small></li>')
          .join('') +
        '</ul>' +
        '<dl class="kv"><dt>原因</dt><dd>' +
        E(i.cause || '－') +
        '</dd><dt>再発防止</dt><dd>' +
        E(i.prevention || '－') +
        '</dd></dl>' +
        (canU && i.status !== '完了'
          ? '<label class="fl" for="ilog">記録を追加</label><textarea id="ilog" style="min-height:56px" placeholder="例：影響範囲を特定（支店3か所）"></textarea>' +
            (i.restored
              ? '<label class="fl" for="ica">原因</label><textarea id="ica" style="min-height:46px">' +
                E(i.cause) +
                '</textarea><label class="fl" for="ipr">再発防止</label><textarea id="ipr" style="min-height:46px">' +
                E(i.prevention) +
                '</textarea>'
              : '')
          : ''),
      canU && i.status !== '完了'
        ? '<button class="btn" data-x type="button">閉じる</button>' +
            (i.app || i.req
              ? '<button class="btn" id="ireq" type="button">' + ico('i-plus') + '再発防止を依頼にする</button>'
              : '') +
            '<button class="btn" id="iadd" type="button">' +
            ico('i-chat') +
            '記録だけ追加</button>' +
            (i.restored
              ? '<button class="btn pri" id="iclose" type="button">' + ico('i-check') + '完了にする</button>'
              : '<button class="btn pri" id="ires" type="button">' + ico('i-check') + '復旧した</button>')
        : '<button class="btn pri" data-x type="button">閉じる</button>',
    );
    const log = (t) => {
      i.log.push({ at: SF.nowISO(), by: me().name, t });
    };
    if ($('#iadd'))
      $('#iadd').addEventListener('click', () => {
        const t = $('#ilog').value.trim();
        if (!t) return toast('記録を書いてください', true);
        log(t);
        addAudit('障害対応：記録', i.id, t);
        persist();
        openInc(id);
        render();
      });
    if ($('#ires'))
      $('#ires').addEventListener('click', () => {
        const t = $('#ilog').value.trim() || '復旧を確認';
        log('復旧：' + t);
        i.restored = SF.nowISO();
        i.status = '再発防止中';
        if (!i.ack) i.ack = i.restored;
        addAudit('障害対応：復旧', i.id, t + '（' + dur(minsBetween(i.opened, i.restored)) + '）');
        persist();
        openInc(id);
        render();
        toast('復旧を記録しました（' + dur(minsBetween(i.opened, i.restored)) + '）');
      });
    if ($('#iclose'))
      $('#iclose').addEventListener('click', () => {
        const ca = $('#ica').value.trim(),
          pr = $('#ipr').value.trim();
        if (!ca || !pr) return toast('原因と再発防止を書いてから完了にします', true);
        i.cause = ca;
        i.prevention = pr;
        log('完了：再発防止を決定');
        i.status = '完了';
        i.closed = SF.nowISO();
        addAudit('障害対応：完了', i.id, '原因：' + ca + '／再発防止：' + pr);
        persist();
        closeModal();
        render();
        toast(i.id + ' を完了にしました');
      });
    if ($('#ireq'))
      $('#ireq').addEventListener('click', () => {
        const app = appOf(i.app),
          base = app ? find(app.req) : find(i.req),
          now = SF.nowISO();
        const r = Object.assign(SF.blank(S.role), {
          title: (app ? app.name : base ? base.title : '') + '：' + i.id + ' の再発防止',
          kind: '不具合の報告',
          dept: base ? base.dept : 'dx',
          problem: i.title + '（' + i.id + '）' + (i.cause ? '\n原因：' + i.cause : ''),
          purpose: '同じ障害が起きないようにする',
          users: base ? base.users.slice() : ['本社の本部の担当者'],
          scope: '',
          criteria: [''],
          decides: 'g',
        });
        if (window.__MSF__) return startRequestFrom(r, { kind: 'incident', id: i.id });
        r.id = SF.nextId(S.data);
        r.createdAt = now;
        r.updatedAt = now;
        r.status = 'received';
        r.history = [{ at: now, by: me().name, role: me().l, action: '受付', note: i.id + ' の再発防止として登録' }];
        S.data.items.push(r);
        i.prevention = (i.prevention ? i.prevention + '／' : '') + r.id + ' で対応';
        log('再発防止を依頼にした（' + r.id + '）');
        addAudit('再発防止を依頼にした', r.id, i.id);
        persist();
        closeModal();
        openDrawer(r.id);
        render();
        toast(r.id + ' として受け付けました');
      });
  }

  /* ---- modal ---- */
  function modal(t, b, f) {
    $('#modal').innerHTML = '<h3>' + t + '</h3><div class="mbd">' + b + '</div><div class="mft">' + f + '</div>';
    $('#mmask').classList.add('show');
    $$('#modal [data-x]').forEach((x) => x.addEventListener('click', closeModal));
  }
  function closeModal() {
    $('#mmask').classList.remove('show');
  }
  $('#mmask').addEventListener('click', (e) => {
    if (e.target.id === 'mmask') closeModal();
  });
  function confirmBox(t, msg, ok, fn) {
    modal(
      ico('i-alert') + E(t),
      '<p style="margin:0">' + E(msg) + '</p>',
      '<button class="btn" data-x type="button">キャンセル</button><button class="btn pri" id="cfok" type="button">' +
        E(ok) +
        '</button>',
    );
    $('#cfok').addEventListener('click', () => {
      closeModal();
      fn();
    });
  }

  notice();
  render();
})();
