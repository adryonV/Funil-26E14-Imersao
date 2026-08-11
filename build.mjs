// ============================================================================
// build.mjs — Dashboard "26E14-Imersão — Meta Ads" (funil de vendas)
// Roda 100% na nuvem (GitHub Actions). Sem dependências.
//
// Cruza 2 planilhas Google (somente leitura, export CSV):
//   1) Métricas dos Anúncios (aba "Meta Ads", gid 0)
//   2) Lista de Compradores  (aba "OUTRAS",  gid 1648121717)
//
// Regra do imposto: gasto BRUTO fica no data.json; o imposto ×1,1385 é
// aplicado NO DASHBOARD (accAd: t.spend += r.spend * tax), então TODAS as
// métricas (CPM/CPC/CAC/ROAS/…) usam o gasto COM imposto.
//
// A aba é dedicada ao lançamento, então TODAS as vendas dela entram (sem filtro de data).
// ============================================================================
import { writeFile, readFile } from "node:fs/promises";

// ----------------------------------------------------------------- config
const ADS_ID   = "1AzTwhLfEKsMlNvnmvQ_Cday0N0YeKAsTz4g6H5OUnCI";
const ADS_GID  = "0";                 // aba "Meta Ads"
const SALES_ID = "1EFghI3MYmjRvIGKUHTermmTb74DZDNcyrI48bZ_39t4";
const SALES_GID= "1045242815";        // aba "26-E14 IMERSAO"
const SALES_TAB= "26-E14 IMERSAO";

const TAX_RATE   = 1.1385;            // imposto obrigatório (aplicado no dashboard)
const DATE_FALLBACK = "2026-08-11";   // usado só se não houver linha de anúncio (fallback de date_min/max)
const TRAFFIC_SRC= "meta-ads";        // marcador de venda de tráfego pago
const PAID_STATUS = new Set(["approved","aprovado","complete","completed","paid","pago",""]); // Hotmart: só venda paga conta

const csvUrl = (id, gid) => `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;

// ----------------------------------------------------------------- helpers
async function fetchCsv(url, what){
  const r = await fetch(url, { redirect:"follow", headers:{ "User-Agent":"Mozilla/5.0 dash-build" } });
  if (!r.ok) throw new Error(`${what}: HTTP ${r.status}`);
  const txt = await r.text();
  if (/^\s*<(!doctype|html)/i.test(txt)) throw new Error(`${what}: recebeu HTML (planilha privada? libere "qualquer pessoa com o link → Leitor")`);
  return txt;
}

// Parser CSV RFC-4180 (aspas, vírgulas e quebras de linha dentro de campo).
function parseCsv(text){
  const rows = []; let row = [], field = "", i = 0, q = false;
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  while (i < s.length){
    const c = s[i];
    if (q){
      if (c === '"'){ if (s[i+1] === '"'){ field += '"'; i += 2; continue; } q = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"'){ q = true; i++; continue; }
    if (c === ','){ row.push(field); field = ""; i++; continue; }
    if (c === '\n'){ row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r => r.length && r.some(x => String(x).trim() !== ""));
}

// Cabeçalho → função de acesso por nome (case/acentos tolerante).
function fold(s){ return String(s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/\s+/g," ").trim(); }
function headerIndex(header){
  const map = new Map();
  header.forEach((h,i) => { const k = fold(h); if (!map.has(k)) map.set(k, i); });
  return (...names) => { for (const n of names){ const i = map.get(fold(n)); if (i !== undefined) return i; } return -1; };
}

// Número pt-BR: "1.234,56" → 1234.56 · "188,94" → 188.94 · "4590" → 4590.
function num(v){
  if (v == null) return 0;
  let s = String(v).trim().replace(/[^\d.,-]/g, "");
  if (!s) return 0;
  const hasC = s.includes(","), hasD = s.includes(".");
  if (hasC && hasD) s = s.replace(/\./g, "").replace(",", ".");   // ponto=milhar, vírgula=decimal
  else if (hasC)    s = s.replace(",", ".");                       // vírgula=decimal
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

// Data → "YYYY-MM-DD" (aceita ISO "2026-08-11 08:23" e "11/08/2026 ...").
function isoDate(v){
  const s = String(v||"").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  return "";
}

const normKey = s => fold(s);
// Só conta como tráfego pago quem tem utm_source EXATAMENTE "facebook-ads" (regra do cliente).
const isPaidSrc = s => fold(s) === "facebook-ads";

// ----------------------------------------------------------------- ADS
function parseAds(csv){
  const rows = parseCsv(csv);
  const H = rows[0]; const at = headerIndex(H);
  const iDay = at("Day","Dia","Date");
  const iC   = at("Campaign Name","Campanha","Campaign");
  const iS   = at("Ad Set Name","Conjunto","Ad Set");
  const iA   = at("Ad Name","Anúncio","Ad");
  const iSpend = at("Amount Spent","Amount spent (BRL)","Valor usado","Gasto","Spend");
  const iImp = at("Impressions","Impressões");
  const iClk = at("Link Clicks","Clicks","Cliques","Cliques no link");
  const iLpv = at("Landing Page Views","Visualizações da página de destino","Page Views");
  const iIc  = at("Checkouts Initiated","Checkout Initiated","Finalizações de compra iniciadas","Checkouts");
  const ads = [];
  const canonCamp = new Map(), canonSet = new Map(), canonAd = new Map();
  for (const r of rows.slice(1)){
    const d = isoDate(r[iDay]); if (!d) continue;
    const c = (r[iC]||"").trim(), s = (r[iS]||"").trim(), a = (r[iA]||"").trim();
    ads.push({
      d, c, s, a,
      spend: num(r[iSpend]),      // BRUTO — imposto aplicado no dashboard
      imp: Math.round(num(r[iImp])),
      clk: Math.round(num(r[iClk])),
      lpv: iLpv >= 0 ? Math.round(num(r[iLpv])) : 0,
      ic:  iIc  >= 0 ? Math.round(num(r[iIc]))  : 0,
    });
    if (c) canonCamp.set(normKey(c), c);
    if (s) canonSet.set(normKey(s), s);
    if (a) canonAd.set(normKey(a), a);
  }
  return { ads, canonCamp, canonSet, canonAd };
}

// ----------------------------------------------------------------- SALES
function parseSales(csv, canon){
  const rows = parseCsv(csv);
  const H = rows[0]; const at = headerIndex(H);
  const iDate = at("Data/Hora","Data","Date","DATA(UTC-3)","Data da Compra");
  const iVal  = at("Valor","Valor da Compra","Bruto","Faturamento","Amount","Value","Revenue");
  const iStat = at("Status","Situação");
  const iSrc  = at("UTM Source","Utm_source","utm_source");
  const iMed  = at("UTM Medium","utm_medium");
  const iCamp = at("UTM Campaign","utm_campaign");
  const iCont = at("UTM Content","utm_content");
  const iSck  = at("sck bruto","sck","SCK");
  const iSrcB = at("src bruto");

  const { canonCamp, canonSet, canonAd } = canon;
  // Fallback por SCK/src bruto: acha nome conhecido por substring (longest-first).
  const knownAds = [...canonAd.values()].sort((a,b)=>b.length-a.length);
  const knownSets= [...canonSet.values()].sort((a,b)=>b.length-a.length);
  const knownCamp= [...canonCamp.values()].sort((a,b)=>b.length-a.length);
  const findIn = (blob, list) => { const f = fold(blob); for (const name of list){ if (f.includes(fold(name))) return name; } return ""; };

  const sales = [];
  const counts = { ad:0, adset:0, campaign:0, unmatched:0, none:0 };
  let skippedStatus = 0;

  for (const r of rows.slice(1)){
    const d = isoDate(r[iDate]); if (!d) continue;
    const status = fold(iStat >= 0 ? r[iStat] : "");
    if (iStat >= 0 && !PAID_STATUS.has(status)){ skippedStatus++; continue; } // só venda paga

    const v = num(r[iVal]);
    const rawSrc = iSrc >= 0 ? r[iSrc] : "";
    const paid = isPaidSrc(rawSrc);
    const src = paid ? TRAFFIC_SRC : "organico";

    // Atribuição: UTM direto (campaign/medium/content) → nomes canônicos da planilha de anúncios.
    let c = "", s = "", a = "", m = "";
    if (paid){
      const uCamp = iCamp >= 0 ? (r[iCamp]||"").trim() : "";
      const uMed  = iMed  >= 0 ? (r[iMed]||"").trim()  : "";
      const uCont = iCont >= 0 ? (r[iCont]||"").trim() : "";
      c = canonCamp.get(normKey(uCamp)) || "";
      s = canonSet.get(normKey(uMed))   || "";
      a = canonAd.get(normKey(uCont))   || "";
      // Fallback: varre sck/src bruto por nomes conhecidos (UTM às vezes vem quebrada).
      if (!a || !c){
        const blob = [(iSck>=0?r[iSck]:""), (iSrcB>=0?r[iSrcB]:"")].join(" | ");
        if (!a) a = findIn(blob, knownAds);
        if (!s) s = findIn(blob, knownSets);
        if (!c) c = findIn(blob, knownCamp);
      }
      if (a && s && c) m = "ad";
      else if (s && c) m = "adset";
      else if (c)      m = "campaign";
      else             m = "";           // paga mas sem campanha casada → unmatched
    }

    if (m === "ad") counts.ad++;
    else if (m === "adset") counts.adset++;
    else if (m === "campaign") counts.campaign++;
    else if (paid) counts.unmatched++;
    else counts.none++;

    sales.push({ d, v, src, c, s, a, m });
  }
  return { sales, counts, skippedStatus };
}

// ----------------------------------------------------------------- build
function brNow(){
  const now = new Date();
  const br = new Date(now.getTime() - 3*3600*1000);   // UTC-3
  const p = n => String(n).padStart(2,"0");
  return `${p(br.getUTCDate())}/${p(br.getUTCMonth()+1)}/${br.getUTCFullYear()} ${p(br.getUTCHours())}:${p(br.getUTCMinutes())}`;
}

async function main(){
  const [adsCsv, salesCsv] = await Promise.all([
    fetchCsv(csvUrl(ADS_ID, ADS_GID),   "planilha de anúncios"),
    fetchCsv(csvUrl(SALES_ID, SALES_GID),"planilha de compradores"),
  ]);

  const canon = parseAds(adsCsv);
  const ads = canon.ads;
  const { sales, counts, skippedStatus } = parseSales(salesCsv, canon);

  const days = ads.map(r => r.d).sort();
  const date_min = days[0] || DATE_FALLBACK;
  const date_max = days[days.length-1] || DATE_FALLBACK;

  const trafSales = sales.filter(s => s.src === TRAFFIC_SRC).length;

  const warnings = [];
  if (!ads.length) warnings.push("Nenhuma linha de anúncio encontrada na planilha de métricas.");
  if (skippedStatus) warnings.push(`${skippedStatus} linha(s) de compra com status não-pago foram ignoradas.`);
  if (counts.unmatched) warnings.push(`${counts.unmatched} venda(s) de tráfego pago sem UTM/SCK reconhecível — contam no total de mídia, mas ficam "sem campanha".`);

  const meta = {
    title: "26E14-Imersão — Meta Ads",
    platform: "Meta Ads",
    traffic_source: TRAFFIC_SRC,
    tax: TAX_RATE,
    currency: "BRL",
    generated_at: new Date().toISOString(),
    generated_at_br: brNow(),
    date_min, date_max,
    ads_url:   `https://docs.google.com/spreadsheets/d/${ADS_ID}/edit#gid=${ADS_GID}`,
    sales_url: `https://docs.google.com/spreadsheets/d/${SALES_ID}/edit#gid=${SALES_GID}`,
    sales_tab: SALES_TAB,
    counts: {
      ads_rows: ads.length,
      sales_rows: sales.length,
      traffic_sales: trafSales,
      attribution: counts,
    },
    warnings,
  };

  const data = { meta, ads, sales };
  await writeFile("public/data.json", JSON.stringify(data));

  // Cache-bust: carimba BUILD_ID no index.html a cada build.
  const buildId = new Date().toISOString().replace(/[^\d]/g,"").slice(0,14);
  let html = await readFile("public/index.html", "utf8");
  html = html.replace(/const BUILD_ID = "[^"]*";/, `const BUILD_ID = "${buildId}";`);
  await writeFile("public/index.html", html);

  console.log(`OK · ${ads.length} anúncios · ${sales.length} vendas (${trafSales} tráfego) · atribuição`, counts);
  console.log(`   período ${date_min}..${date_max} · build ${buildId}`);
  if (warnings.length) console.log("   avisos:\n   - " + warnings.join("\n   - "));
}

main().catch(e => { console.error("FALHA no build:", e.message); process.exit(1); });
