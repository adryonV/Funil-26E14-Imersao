# Funil 26E14-Imersão — Meta Ads

Dashboard de funil de tráfego (Meta Ads) hospedada no GitHub Pages, 100% na nuvem.
Cruza 2 planilhas Google (somente leitura) e se reconstrói a cada 2h.

- **Ao vivo:** https://adryonv.github.io/Funil-26E14-Imersao/
- **Build:** `build.mjs` (Node, sem dependências) → `public/data.json` (agregado, sem PII).
- **Deploy:** GitHub Actions → GitHub Pages.

## Fontes
1. Métricas dos Anúncios — aba **Meta Ads** (gasto, impressões, cliques, page views, checkouts).
2. Lista de Compradores — aba **OUTRAS** (só linhas do **11/08 pra cima**; data, valor, UTMs).

## Regras
- **Imposto ×1,1385** sobre o gasto — aplicado no dashboard, então CPM/CPC/CAC/ROAS usam gasto COM imposto.
- Atribuição por **UTM** (utm_campaign→campanha, utm_medium→conjunto, utm_content→anúncio), com fallback por `sck bruto`.
- Somente leitura — as planilhas nunca são modificadas.

## Automação externa (cron-job.org, a cada 2h)
`POST https://api.github.com/repos/adryonV/Funil-26E14-Imersao/dispatches`
Body: `{"event_type":"rebuild"}` — headers de autorização com PAT no cron-job.org.
