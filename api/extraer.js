// Lee capturas de Meta Ads, Shopify o la plataforma COD y devuelve los números en JSON.
// Variables de entorno en Vercel:
//   ANTHROPIC_API_KEY            (obligatoria)
//   ANTHROPIC_MODEL              (opcional, por defecto claude-sonnet-5-5)
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (o KV_REST_API_URL / KV_REST_API_TOKEN) para limitar usos por IP
//   DAILY_LIMIT                  (opcional, lecturas por IP por día, por defecto 15)

const PROMPTS = {
  "meta": "These are screenshots from Meta Ads Manager (Facebook/Instagram ads) for one product. Today is {HOY}. Extract the advertising metrics.\nReply with only JSON in this shape: {\"currency\": \"3-letter code of the money amounts if visible, else null\", \"days\": [{\"date\": \"YYYY-MM-DD\", \"spend\": 0, \"impressions\": 0, \"link_clicks\": 0, \"landing_page_views\": 0, \"results\": 0}], \"totals\": {\"spend\": 0, \"impressions\": 0, \"link_clicks\": 0, \"landing_page_views\": 0, \"results\": 0}, \"notes\": \"one short sentence in Spanish about anything unclear, or empty\"}.\nRules: fill \"days\" only when the screenshot shows a breakdown with one row per date; otherwise use an empty array. \"totals\" is the total/summary row when shown, otherwise the sum of the rows you can see (if several campaigns or ad sets appear without a total row, add them up). spend = \"Importe gastado\" / \"Amount spent\". link_clicks = \"Clics en el enlace\" / \"Link clicks\" (use all clicks only if that is the only clicks column). landing_page_views = \"Visitas a la página de destino\" / \"Landing page views\". results = \"Resultados\" / \"Results\" / \"Compras\" / \"Purchases\". Use null for any metric that is not visible. Write numbers as plain JSON numbers without thousands separators, reading the locale correctly (in \"1.234,56\" the comma is the decimal separator). A date without year takes the year of today and is never in the future.",
  "shop": "These are screenshots from Shopify (an orders list, or a sales / analytics report) for one product. Today is {HOY}.\nReply with only JSON in this shape: {\"currency\": \"3-letter code if visible, else null\", \"orders\": 0, \"sales\": 0, \"aov\": 0, \"notes\": \"one short sentence in Spanish about anything unclear, or empty\"}.\nRules: for an orders list, count the distinct orders you can see and add up their totals. For a report, use its total orders and total (or gross) sales, and its average order value if shown. Use null for anything not visible. Write numbers as plain JSON numbers without thousands separators, reading the locale correctly (in \"1.234,56\" the comma is the decimal separator).",
  "cod": "These are screenshots from a cash-on-delivery logistics platform (for example Dropi) showing orders and their delivery status for one product. Today is {HOY}.\nGroup every order into: delivered (entregado, delivered, finalizado), returned (devolución, devuelto, rechazado, rehusado, no entregado, retornado), in_transit (en tránsito, en reparto, en camino, guía generada, despachado, en bodega, novedad, en oficina), cancelled (cancelado, anulado, pendiente de confirmación: orders that were never shipped).\nReply with only JSON in this shape: {\"delivered\": 0, \"returned\": 0, \"in_transit\": 0, \"cancelled\": 0, \"statuses\": [{\"name\": \"status as written\", \"count\": 0, \"group\": \"delivered|returned|in_transit|cancelled\"}], \"notes\": \"one short sentence in Spanish about anything unclear, or empty\"}.\nRules: if the screenshot shows a summary with a count per status, use those counts. If it shows a list of orders, count each order once. Write numbers as plain JSON numbers."
};
const TYPES = ["image/jpeg", "image/png", "image/webp"];

function parseJson(text) {
  try { return JSON.parse(text); } catch (e) {}
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) { try { return JSON.parse(m[1]); } catch (e) {} }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a > -1 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e) {} }
  return null;
}

async function overLimit(ip) {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  const limit = parseInt(process.env.DAILY_LIMIT || "15", 10);
  const key = "crm-extraer:" + ip + ":" + new Date().toISOString().slice(0, 10);
  try {
    const r = await fetch(url.replace(/\/$/, "") + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify([["INCR", key], ["EXPIRE", key, "90000"]]),
    });
    const j = await r.json();
    const count = j && j[0] && j[0].result;
    return typeof count === "number" && count > limit ? limit : false;
  } catch (e) {
    return false;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido." });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "La lectura de capturas no está configurada (falta ANTHROPIC_API_KEY)." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const type = body && body.type;
  if (!PROMPTS[type]) return res.status(400).json({ error: "Tipo de captura no válido." });
  const images = (Array.isArray(body.images) ? body.images : []).slice(0, 3)
    .filter(i => i && TYPES.includes(i.media_type) && typeof i.data === "string" && i.data.length < 4000000);
  if (!images.length) return res.status(400).json({ error: "No llegó ninguna imagen válida." });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  const lim = await overLimit(ip);
  if (lim) return res.status(429).json({ error: "Llegaste al límite de " + lim + " lecturas por día. Probá mañana o importá el archivo CSV." });

  const content = images.map(i => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } }));
  content.push({ type: "text", text: PROMPTS[type].replace("{HOY}", new Date().toISOString().slice(0, 10)) });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5", max_tokens: 2500, messages: [{ role: "user", content }] }),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("Anthropic", r.status, t.slice(0, 500));
      return res.status(502).json({ error: "No pude leer la captura en este momento. Probá de nuevo en unos minutos." });
    }
    const j = await r.json();
    const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    const data = parseJson(text);
    if (!data) return res.status(422).json({ error: "No pude sacar números de esa captura. Probá con una imagen más nítida." });
    return res.status(200).json({ data });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: "No pude leer la captura en este momento. Probá de nuevo en unos minutos." });
  }
};
