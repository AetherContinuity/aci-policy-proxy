// aci-policy-proxy
// Valtionhallinnon rajapinnat: Hankeikkuna, Eduskunta, Finlex.
//
// NOTE ON DATA CLASS: unlike the Fingrid / Eurostat / ECB proxies, most of
// what this worker returns is SELF-REPORTED PROCESS DATA — a ministry's own
// account of its own work. Hankeikkuna "etapit" and schedules are reported,
// not measured. Eduskunta sitting and voting dates ARE events, and Finlex
// statute numbers ARE authoritative. Cross-check reported schedules against
// those two rather than trusting them directly.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const UA = 'curl/8.5.0';

const HI_BASE     = 'https://api.hankeikkuna.fi/api/v2';
const EDK_BASE    = 'https://api.eduskunta.fi/api/v1';
const FINLEX_BASE = 'https://opendata.finlex.fi/finlex/avoindata/v1';

// ─────────────────────────────────────────────────────────────
// 1. HANKEIKKUNA   api.hankeikkuna.fi/api/v2     CC BY 4.0
//
// Paths below are read from the live OpenAPI 3.1 spec at /api/api-docs
// (verified 2026-09-01). NOTE: the official testausohje PDF documents
// /api/v1 — that prefix 404s. The spec is authoritative, the PDF is not.
//
// GET   asettajat  ·  asettajat/uuid/{uuid}
//       kohteet/uuid/{uuid}  ·  henkilot/uuid/{uuid}
//       hallitusohjelmat/hallitukset | karkihankkeet | painopistealueet
//                       | toimenpiteet | rakenneElementtiTyypit
//                       | valitavoiteTyypit          (+ /uuid/{uuid})
//       istuntokaudet  ·  teemat
//       tyypit/kohteenValmisteluvaiheet | heSaadosTyypit | heTaeTyypit
// POST  kohteet/haku  ·  henkilot/haku
//       hallitusohjelmat/rakenneElementit/haku   <- current toimintasuunnitelma model
//
// kohteet/haku body (KohdeV2SearchFormData), all optional:
//   tyyppi          HANKE | LAINSAADANTO | TOIMIELIN | STRATEGIA
//   tila            SUUNNITTEILLA | KAYNNISSA | PAATTYNYT
//   valmisteluvaihe ESIVALMISTELU | PERUSVALMISTELU | LAUSUNTOMENETTELY
//                   | JATKOVALMISTELU | VALTIONEUVOSTON_PAATOKSENTEKO
//                   | EDUSKUNTAKASITTELY | LAIN_VAHVISTAMINEN
//                   | KESKEYTETTY | VALMISTUNUT
//   lainsaadantoTehtavaluokka  HALLITUKSEN_ESITYKSEN_VALMISTELU |
//                   ASETUKSEN_ANTAMINEN | TALOUSARVIOT |
//                   VALTION_LAINANOTTO_JA_ANTO | VALTIONTAKAUKSET
//   etappiTyyppi    LAUSUNTOKIERROS | SAADOS | BUDJETTIPAATOS | ... (14 values)
//   toimielinTyyppi / strategiaTyyppi — see spec
//   tunnus[] e.g. "VNK:500:2014" · uuid[] · asettajaUuid[] · teemaUuid[]
//   asiasanat[] YSO/JUHO URIs · teksti (STRING, not array)
//   asettamisPaivaAlku/Loppu · muokattuPaivaAlku/Loppu ·
//   etappiAlkamisPaivaAlku/Loppu     format "YYYY-MM-DDTHH:MM:SS"  (no Z)
//   hallitusohjelmaElementtiUuid[] / hallitusohjelmaValitavoiteUuid[]
//
// PAGINATION IS CURSOR-BASED: `size` (1..10000) + `searchAfter`, not pages.
// Responses use { result: [...] } with a top-level `size`.
//
// RESPONSE SHAPE IS NESTED (LAINSAADANTO hits): each result is
//   { kohde, lainsaadanto, etapit, asiakirjat, asiasanat, linkit, ... }
// tunnus/nimi/valmisteluvaihe live under `kohde`, not at the root.
// `lainsaadanto.heTiedot` has tehtavaluokka, saadostyypit, sivumaara,
// kiireellisyys, perustuslakivaliokunnanLausuntoVaaditaan.
// No HE-tunnus on the kohde. `kohde.asianumerot` (structured VN-diaarinumero,
// e.g. VN/30707/2025) is a solid anchor WITHIN Hankeikkuna but does not carry
// over to Eduskunta: EDK search (?asia=, property `teksti`) returns 0 hits for
// both the VN-number and the plain nimeke text. eduskuntatunnus lookups work
// once the HE-number is already known. Untried: VaskiData rows, or another
// search property on the valtiopaivaasia category.
//
// ETAPIT CROSS-CHECK: an overdue etappi (saavutettu:false, past etappiLoppu)
// only means the kohde is stalled if its valmisteluvaihe EQUALS the kohde's
// current valmisteluvaihe (compare ordinal position from
// tyypit/kohteenValmisteluvaiheet). If the kohde's valmisteluvaihe is ahead
// of the overdue etappi's stage, it's stale bookkeeping, not a stuck project.
// Measured on 33 EDUSKUNTAKASITTELY LAINSAADANTO hits: 2 jumissa, 10
// kirjanpitovelkaa, 21 clean — without the ordinal check all 12 look alike.
// ─────────────────────────────────────────────────────────────

const HI_SHORTCUT = {
  'HI-ASETTAJAT':  { method: 'GET',  path: 'asettajat' },
  'HI-HALLITUKSET':{ method: 'GET',  path: 'hallitusohjelmat/hallitukset' },
  'HI-TEEMAT':     { method: 'GET',  path: 'teemat' },
  'HI-VAIHEET':    { method: 'GET',  path: 'tyypit/kohteenValmisteluvaiheet' },
  'HI-ISTUNTOKAUDET': { method: 'GET', path: 'istuntokaudet' },
  'HI-LAIT':       { method: 'POST', path: 'kohteet/haku', paged: true,
                     body: { tyyppi: ['LAINSAADANTO'], tila: ['KAYNNISSA'] } },
  'HI-KAYNNISSA':  { method: 'POST', path: 'kohteet/haku', paged: true,
                     body: { tila: ['KAYNNISSA'] } },
  // In parliament right now — the join point with the Eduskunta side
  'HI-EDUSKUNNASSA': { method: 'POST', path: 'kohteet/haku',
                     body: { tyyppi: ['LAINSAADANTO'],
                             valmisteluvaihe: ['EDUSKUNTAKASITTELY'], size: 500 } },
  'HI-LAUSUNNOLLA': { method: 'POST', path: 'kohteet/haku',
                     body: { tyyppi: ['LAINSAADANTO'],
                             valmisteluvaihe: ['LAUSUNTOMENETTELY'], size: 500 } }
};

async function fetchHankeikkuna(path, { method = 'GET', body = null, query = '' } = {}) {
  const url = `${HI_BASE}/${path}${query ? '?' + query : ''}`;
  const r = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json', 'User-Agent': UA,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Hankeikkuna ${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  return {
    upstream: url, method,
    source: 'Valtioneuvoston Hankeikkuna (CC BY 4.0)',
    data_class: 'self-reported process data',
    fetched: new Date().toISOString(),
    totalHits: j.totalHits, size: j.size,
    data: j
  };
}

// Paged fetch for shortcuts too big to fit one size-capped call (HI-LAIT,
// HI-KAYNNISSA — previously hard-capped at size:500 with no way to see past
// it). Page size defaults to the API's documented max (10000); most
// currently-KAYNNISSA categories fit in a single page, so the multi-page
// branch below usually never runs. If a category ever exceeds one page,
// pagination continues using the `sort` array attached to each hit — the
// OpenSearch/Elasticsearch convention behind the "searchAfter" terminology
// the spec uses. UNVERIFIED: nothing tested against this API so far has
// exceeded one page, so the second-page path has not been exercised live.
async function fetchHankeikkunaPaged(path, body, { pageSize = 10000, maxPages = 10 } = {}) {
  const results = [];
  let searchAfter, totalHits, upstream;
  for (let page = 0; page < maxPages; page++) {
    const reqBody = { ...body, size: pageSize, ...(searchAfter ? { searchAfter } : {}) };
    const r = await fetchHankeikkuna(path, { method: 'POST', body: reqBody });
    upstream = r.upstream;
    totalHits = r.totalHits ?? totalHits;
    const hits = r.data?.result || [];
    results.push(...hits);
    if (hits.length < pageSize) break;          // last page
    searchAfter = hits.at(-1)?.sort;
    if (!searchAfter) break;                     // no cursor to continue with
  }
  return {
    upstream, method: 'POST',
    source: 'Valtioneuvoston Hankeikkuna (CC BY 4.0)',
    data_class: 'self-reported process data',
    fetched: new Date().toISOString(),
    totalHits, size: results.length,
    data: { result: results }
  };
}

// Incremental fetch: only what changed since `since` (ISO, no Z).
async function hankeikkunaSince(since, tyyppi) {
  const body = { muokattuPaivaAlku: since };
  if (tyyppi) body.tyyppi = Array.isArray(tyyppi) ? tyyppi : [tyyppi];
  return fetchHankeikkuna('kohteet/haku', { method: 'POST', body });
}

// ─────────────────────────────────────────────────────────────
// 2. EDUSKUNTA   api.eduskunta.fi/api/v1
//    /search?q=<json>   — the only confirmed-working route on this host.
//    /tables/{Table}/rows does NOT exist here: 404s, and the host root
//    returns an S3 AccessDenied, i.e. no table API at this base at all.
//    (Was wrongly documented as working — removed rather than left broken.
//    avoindata.eduskunta.fi is the likely real host; unconfirmed.)
// ─────────────────────────────────────────────────────────────

async function edkSearch(q) {
  const url = `${EDK_BASE}/search?q=${encodeURIComponent(JSON.stringify(q))}`;
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Eduskunta search: ${r.status}`);
  return { url, json: await r.json() };
}

// Raw passthrough to edkSearch() for the caller's own query object — exists
// to test candidate `property` names for joining Hankeikkuna's
// kohde.asianumerot (VN-diaarinumero) to Eduskunta without a new deploy per
// guess. Same category/expression shape fetchAsia() uses internally.
//
// /search is SCORED, not filtered — a known property always returns
// results, ranked by relevance to the whole corpus, even for a match value
// that doesn't exist (confirmed: a fake tunnus scored 21,156 / 67 hits
// depending on property). An UNKNOWN property name is what reliably
// returns 0 hits — that's the actual signal this route is for, not
// "0 hits = no match". Never trust results[0] as a real match without
// separately verifying the field you asked about actually equals what you
// asked for (see fetchAsia's fix for the same bug).
//
// Ruled out on `valtiopaivaasia` (confirmed 0 hits = property doesn't
// exist): diaarinumero, vnDiaarinumero, hankenumero, asianumero,
// vnAsianumero, valtioneuvostonAsianumero, tunnus. `eduskuntatunnus` is
// confirmed to exist; `teksti` exists but isn't free-text match.
async function edkSearchRaw(qJson) {
  let q;
  try { q = JSON.parse(qJson); } catch { throw new Error('edk_search: invalid JSON'); }
  const { url, json } = await edkSearch(q);
  return { upstream: url, source: 'Eduskunnan avoin data',
           fetched: new Date().toISOString(), data: json };
}

// Generalised from the old hardcoded VNS 8/2025 handler.
// tunnus e.g. "VNS 8/2025", "HE 12/2026", "LA 3/2025"
//
// /search is a SCORED/FUZZY search, not a filter: a valid property always
// returns results (a nonexistent tunnus like "HE 999/2099" scored 21,156
// hits, not zero), ranked by relevance, with the best guess at index 0.
// maxResults:1 alone silently returns that best guess even when it's
// unrelated to what was asked for — the exact wrong-window-for-a-query
// failure shape as aci-fingrid-proxy's startTime. So the top hit's own
// eduskuntatunnus MUST be checked against the request before trusting it.
async function fetchAsia(tunnus) {
  const { url, json } = await edkSearch({
    category: 'valtiopaivaasia',
    maxResults: 1,
    startFromIndex: 0,
    expression: { and: [{ property: 'eduskuntatunnus', match: tunnus }] }
  });
  const asia = json.results?.[0]?.valtiopaivaasia;
  const actualTunnus = asia?.eduskuntatunnus?.fi || '';
  if (!asia || !actualTunnus.startsWith(tunnus)) {
    throw new Error(`Valtiopäiväasia not found: ${tunnus}`);
  }

  const kasittelyt = asia.kasittelyt?.fi || [];
  const asiakirjat = asia.keskeisetAsiakirjat?.fi || [];
  const mietinnot  = asiakirjat.filter(a => /VM$/.test(a.asiakirjatyyppikoodi || ''));
  const lausunnot  = asiakirjat.filter(a => /VL$/.test(a.asiakirjatyyppikoodi || ''));

  return {
    upstream: url,
    source: 'Eduskunnan avoin data',
    data_class: 'events (dates are authoritative)',
    fetched: new Date().toISOString(),
    eduskuntatunnus: actualTunnus,
    nimeke: asia.nimeke?.fi || '',
    tila: asia.tila?.fi || 'tuntematon',
    viimeisinKasittelyvaihe: asia.viimeisinKasittelyvaihe?.fi || 'ei tietoa',
    mietinnot: mietinnot.map(m => ({
      tyyppi: m.asiakirjatyyppikoodi, valiokunta: m.valiokuntanimi,
      edktunnus: m.edktunnus, laadintapvm: m.laadintapvm,
      nimeketeksti: m.nimeketeksti, htmlSaatavilla: m.htmlSaatavilla
    })),
    lausunnot: lausunnot.map(l => ({
      valiokunta: l.valiokuntanimi, edktunnus: l.edktunnus, laadintapvm: l.laadintapvm
    })),
    // Full stage timeline — this is the cross-check against Hankeikkuna's
    // self-reported schedule.
    kasittelyvaiheetLkm: kasittelyt.length,
    aikajana: kasittelyt.map(k => ({
      pvm: k.tapahtumapvm, vaihe: k.kasittelyvaihe
    })),
    viimeisinKasittely: kasittelyt.length
      ? { pvm: kasittelyt.at(-1).tapahtumapvm, vaihe: kasittelyt.at(-1).kasittelyvaihe }
      : null
  };
}

// ─────────────────────────────────────────────────────────────
// 3. FINLEX   opendata.finlex.fi/finlex/avoindata/v1
//    Akoma Ntoso XML. TLS 1.2+. No registration. 429 on rate limit.
//    ?fx=akn/fi/act/statute/2024/123/fin@
// ─────────────────────────────────────────────────────────────

async function fetchFinlex(path, query, accept) {
  const url = `${FINLEX_BASE}/${path}${query ? '?' + query : ''}`;
  const r = await fetch(url, {
    headers: { Accept: accept || 'application/xml', 'User-Agent': UA }
  });
  const text = await r.text();
  if (r.status === 429) throw new Error('Finlex 429 — rate limited, back off');
  if (!r.ok) throw new Error(`Finlex ${path}: ${r.status} ${text.slice(0, 300)}`);
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('json')) {
    return { upstream: url, source: 'Finlex avoin data',
             data_class: 'authoritative', fetched: new Date().toISOString(),
             data: JSON.parse(text) };
  }
  return new Response(text, {
    headers: { ...CORS, 'Content-Type': 'application/xml; charset=utf-8',
               'X-Upstream': url, 'X-Source': 'Finlex avoin data' }
  });
}

// ─────────────────────────────────────────────────────────────

const INDEX = {
  service: 'aci-policy-proxy',
  note: 'Hankeikkuna + Eduskunta = reported process data. Finlex + Eduskunta dates = authoritative.',
  hankeikkuna: {
    shortcuts: Object.keys(HI_SHORTCUT),
    get:  '?hi=asettajat  |  ?hi=kohteet/uuid/<uuid>',
    post: 'POST ?hi=kohteet/haku   body: {"tyyppi":["LAINSAADANTO"],"tila":["KAYNNISSA"]}',
    since: '?hi_since=2026-08-01T00:00:00&tyyppi=LAINSAADANTO  — incremental',
    spec: 'https://api.hankeikkuna.fi/api/api-docs  (OpenAPI 3.1 — authoritative)',
    warning: 'base is /api/v2; the 2017 testausohje PDF documents /api/v1, which 404s',
    paging: 'cursor-based: size (1..10000) + searchAfter, not page numbers'
  },
  eduskunta: {
    asia: '?asia=VNS 8/2025   — käsittelyaikajana + mietinnöt + lausunnot',
    search: '?edk_search=<json>   — raw search query, e.g. {"category":"valtiopaivaasia","maxResults":5,"startFromIndex":0,"expression":{"and":[{"property":"eduskuntatunnus","match":"HE 100/2026"}]}}   — for testing candidate join properties against Hankeikkuna\'s asianumerot; teksti confirmed not free-text'
  },
  finlex: {
    raw: '?fx=akn/fi/act/statute/2024/123/fin@   — Akoma Ntoso XML',
    note: 'returns XML unchanged; 429 means back off'
  }
};

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    const p = u.searchParams;
    const series = p.get('series');

    const pass = (drop) => new URLSearchParams(
      [...p].filter(([k]) => !drop.includes(k))
    ).toString();

    try {
      // ── Asiakirjahaku (lisätty 2026-09-05) ────────────────────────
      // ?doc=<hankeikkuna-url>            -> PDF sellaisenaan
      // ?doc=<url>&as=base64              -> JSON jossa base64-sisältö
      //
      // Miksi: lausuntojen PDF-osoitteet osoittavat api.hankeikkuna.fi:hin,
      // joka ei ole hiekkalaatikon sallilistalla. Ilman tätä L-tapahtumien
      // SISÄLTÖ ei ole luettavissa — vain metatiedot. ROE:n targeting,
      // policy_proximity ja uptake vaativat tekstin, eivät nimekettä.
      //
      // TURVARAJAUS: vain api.hankeikkuna.fi. Avoin URL-passthrough tekisi
      // tästä yleisen välityspalvelimen, mikä ei ole tarkoitus.
      const doc = p.get('doc');
      if (doc) {
        let target;
        try { target = new URL(doc); } catch { throw new Error(`?doc: kelvoton URL`); }
        if (target.hostname !== 'api.hankeikkuna.fi') {
          throw new Error(`?doc: vain api.hankeikkuna.fi sallittu, oli ${target.hostname}`);
        }
        const r = await fetch(target.toString(), {
          headers: { 'User-Agent': 'ACI-policy-proxy/1.0', Accept: '*/*' },
        });
        if (!r.ok) throw new Error(`asiakirja ${target.pathname}: ${r.status}`);
        const buf = await r.arrayBuffer();
        const ct = r.headers.get('content-type') || 'application/octet-stream';

        if (p.get('as') === 'base64') {
          let bin = '';
          const bytes = new Uint8Array(buf);
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          return Response.json({
            source: 'Hankeikkuna asiakirjat (CC BY 4.0)',
            data_class: 'authoritative (virallinen lausuntomenettely)',
            url: target.toString(), content_type: ct, bytes: bytes.length,
            base64: btoa(bin),
          }, { headers: CORS });
        }
        return new Response(buf, {
          headers: { ...CORS, 'Content-Type': ct, 'Cache-Control': 'public, max-age=604800' },
        });
      }

      // Hankeikkuna
      const hi = p.get('hi');
      if (hi) {
        let body = null;
        if (req.method === 'POST') { try { body = await req.json(); } catch { body = {}; } }
        return Response.json(
          await fetchHankeikkuna(hi, {
            method: body ? 'POST' : 'GET', body,
            query: pass(['hi', 'series'])
          }), { headers: CORS });
      }
      const since = p.get('hi_since');
      if (since) {
        return Response.json(await hankeikkunaSince(since, p.get('tyyppi')), { headers: CORS });
      }
      if (series && HI_SHORTCUT[series]) {
        const s = HI_SHORTCUT[series];
        const result = s.paged
          ? await fetchHankeikkunaPaged(s.path, s.body || {})
          : await fetchHankeikkuna(s.path, { method: s.method, body: s.body || null });
        return Response.json({ series, ...result }, { headers: CORS });
      }

      // Eduskunta
      const asia = p.get('asia');
      if (asia) return Response.json(await fetchAsia(asia), { headers: CORS });

      const edkSearchQ = p.get('edk_search');
      if (edkSearchQ) return Response.json(await edkSearchRaw(edkSearchQ), { headers: CORS });

      // Finlex
      const fx = p.get('fx');
      if (fx) {
        const out = await fetchFinlex(fx, pass(['fx', 'series', 'accept']), p.get('accept'));
        return out instanceof Response ? out : Response.json(out, { headers: CORS });
      }

      return Response.json(INDEX, { status: 400, headers: CORS });

    } catch (e) {
      return Response.json({ error: e.message }, { status: 502, headers: CORS });
    }
  }
};
