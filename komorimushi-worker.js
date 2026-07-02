// こもりむし 中継サーバー（Cloudflare Worker）
// 役割：iPhone のアプリから届いた「写真1枚」を Anthropic API に投げて、
//       判定結果の JSON だけを返す。APIキーはこの中（サーバー側）だけに置く。
//
// 使い方は komorimushi-relay-README.md を参照。
// 必要な設定：Settings → Variables and Secrets に Secret 「ANTHROPIC_API_KEY」を登録。
// 任意：Variable 「MODEL」でモデルを上書き（未設定なら Haiku 4.5）。

const MODEL_FALLBACK = "claude-haiku-4-5";

const SYS = `あなたは幼児向け自然観察アプリ「こもりむし」の はんてい エンジン。3歳児が散歩で撮った写真の主役を、見た目の「かたち」で次の8グループのどれか1つに分類する。種の厳密同定よりグループ分けを優先。
happa=葉が主役（葉っぱ・クローバーの葉・木の葉）
hana=花が主役（タンポポ・シロツメクサの花・ハルジオン等）
dango=地を歩く丸い殻のむし（ダンゴムシ・ワラジムシ）
tentou=つやつや丸い甲虫（テントウムシ・カナブン・コガネムシ）
imomushi=芋虫・毛虫
chouchou=チョウ・ガ
tonbo=トンボ
kumo=クモ
どれにも当てはまらない（ドングリ・きのこ・鳥・石・人・生きものが写っていない等）は group を "none"。
必ず次のJSONだけを返す。前置き・コードフェンス・説明は禁止。
{"group":"happa|hana|dango|tentou|imomushi|chouchou|tonbo|kumo|none","kidword":"3歳に見せるひらがなの一言。例: はっぱの こびとだ！","wamei":"和名の推定。例: シロツメクサ","gakumei":"学名の推定。例: Trifolium repens","confidence":"high|mid|low","note":"親向けの短い一文。特徴か季節。断定しすぎない"}
group が none のとき: kidword は やさしい一言、wamei と gakumei は ""、note に写っているものを書く。`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export default {
  async fetch(request, env) {
    // プリフライト（ブラウザが最初に投げてくる確認）
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // 生存確認：ブラウザで URL を直接開くと {"ok":true} が返る
    if (request.method === "GET") {
      return json({ ok: true });
    }

    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405);
    }

    const key = env.ANTHROPIC_API_KEY;
    if (!key) {
      return json({ error: "APIキーが未設定です（Secret ANTHROPIC_API_KEY）" }, 500);
    }

    let image;
    try {
      const body = await request.json();
      image = body.image;
    } catch (e) {
      return json({ error: "リクエストの形式が不正です" }, 400);
    }
    if (!image) {
      return json({ error: "画像が届いていません" }, 400);
    }

    const model = env.MODEL || MODEL_FALLBACK;

    let apiRes;
    try {
      apiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1000,
          system: SYS,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
                { type: "text", text: "この写真をはんていして。JSONだけ返して。" },
              ],
            },
          ],
        }),
      });
    } catch (e) {
      return json({ error: "APIに接続できませんでした" }, 502);
    }

    if (!apiRes.ok) {
      const t = await apiRes.text().catch(() => "");
      return json({ error: "(HTTP " + apiRes.status + ") " + t.slice(0, 200) }, apiRes.status);
    }

    const data = await apiRes.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    // モデルの返答から JSON だけを取り出す
    const clean = text.replace(/```json|```/g, "").trim();
    const m = clean.match(/\{[\s\S]*\}/);
    let out;
    try {
      out = JSON.parse(m ? m[0] : clean);
    } catch (e) {
      return json({ error: "判定結果を読み取れませんでした", raw: text.slice(0, 200) }, 502);
    }

    return json(out);
  },
};
