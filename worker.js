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

      // ── EDUSKUNTA-PASSTHROUGH (lisätty 2026-09-07) ───────────────
      // ?edkpath=taysistunnot/asian-aanestykset/HE%20101%2F2024
      //
      // Sama ratkaisu kuin ECB-, Valtiokonttori- ja Finto-proxyissa.
      // Peruste on tässä konkreettinen: ?votes= arvasi polun kahdesti
      // väärin (404 molemmilla tunnusmuodoilla), ja jokainen arvaus
      // maksoi deployn. Passthrough tekee polkujen koestamisesta
      // kutsukysymyksen, ei koodikysymyksen.
      //
      // Polku annetaan VALMIIKSI koodattuna — proxy ei koodaa sitä
      // uudelleen, koska juuri koodaus on se muuttuja jota koestetaan.
      // ANSA (löytyi 2026-09-07): URLSearchParams.get() PURKAA
      // prosenttikoodauksen. `edkpath=VNT%201%2F2026%20vp` luettiin
      // muodossa `VNT 1/2026 vp` ja rakennettiin URL:iin sellaisenaan —
      // proxy lähetti literaaleja välilyöntejä. Diagnoosi oli vaikea,
      // koska vika näytti olevan Cloudflaren fetchissä tai otsikoissa;
      // neljä otsikkovarianttia kokeiltiin turhaan ennen kuin
      // `upstream`-kenttä katsottiin.
      //
      // Luetaan raakana kyselymerkkijonosta: koodaus on juuri se
      // muuttuja jota koestetaan, eikä sitä saa purkaa matkalla.
      const rawEdk = (u.search.match(/[?&]edkpath=([^&]*)/) || [])[1];
      const edkPath = rawEdk !== undefined ? rawEdk : null;
      if (edkPath) {
        if (edkPath.includes('..')) throw new Error('?edkpath: .. ei sallittu');
        const pass = new URLSearchParams(
          [...u.searchParams].filter(([k]) => !['edkpath','series','ua','accept'].includes(k))
        ).toString();
        const url = `${EDK_BASE}/${edkPath}${pass ? '?' + pass : ''}`;
        // ?accept= ja ?ua= otsikoiden koestamiseen. Havainto 2026-09-07:
        // SELAIN saa datan osoitteesta
        //   /taysistunnot/asian-aanestykset/VNT%201%2F2026%20vp
        // mutta worker sai tyhjän 404:n kolmella eri koodauksella.
        // Ero on siis pyynnössä, ei polussa. Selain lähettää
        // Accept: text/html ja selaimen User-Agentin; worker lähetti
        // application/json ja oman tunnisteensa.
        const r = await fetch(url, {
          headers: {
            Accept: p.get('accept') || 'application/json',
            'User-Agent': p.get('ua') || 'ACI-policy-proxy/1.0'
          }
        });
        const text = await r.text();
        let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 2000) }; }
        return Response.json({
          source: 'Eduskunnan avoin data (passthrough)',
          upstream: url, http_status: r.status,
          data_class: 'authoritative',
          fetched: new Date().toISOString(),
          count: Array.isArray(data) ? data.length : undefined,
          data
        }, { status: 200, headers: CORS });
      }

      // ── ÄÄNESTYKSET (lisätty 2026-09-07) — GATE 5 ────────────────
      // ?votes=HE 100/2026
      //
      // MIKSI TÄMÄ ON OGAS3:N VIIMEINEN PORTTI
      //
      // ROE:n `uptake` mittaa näkyykö kanta päätöksessä. Lausunto ei voi
      // todistaa uptakea EIKÄ sen puuttumista, koska se kirjoitetaan
      // ENNEN päätöstä — todiste syntyy myöhemmin. Siksi lausunnoista
      // luettu uptake on None, ja siksi L on määrittämätön ja RRI
      // laskematon.
      //
      // Äänestystulos on ainoa lähde tässä järjestelmässä, jossa NOLLA
      // ON HAVAINTO: jos kanta äänestettiin ja hävisi, uptake = 0 on
      // mitattu eikä "ei vielä tiedetä". Kaikkialla muualla nolla
      // tarkoittaa tiedon puutetta.
      //
      // Se on myös ainoa paikka, jossa actor_role = puolue esiintyy —
      // äänestysdata on kansanedustajakohtaista ja eduskuntaryhmä on
      // johdettavissa.
      //
      // ANSA: {eduskuntatunnus+} on plus-polkuparametri, eli se SAA
      // sisältää kauttaviivoja ("HE 100/2026"). Sitä EI saa
      // encodeURIComponent-koodata kokonaan, koska se muuttaisi
      // kauttaviivan %2F:ksi ja polku hajoaisi. Välilyönti koodataan,
      // kauttaviiva ei.
      const votes = p.get('votes');
      if (votes) {
        const tunnus = votes.trim();
        if (!/^[A-ZÅÄÖa-zåäö]{1,6}\s+\d+\/\d{4}(\s+vp)?$/.test(tunnus))
          throw new Error(`?votes: kelvoton eduskuntatunnus "${tunnus}" `+
            `(odotettu esim. "HE 100/2026")`);
        // ANSA 2: Eduskunnan sisäinen tunnusmuoto sisältää `vp`-päätteen.
        // `?asia=`-reitin vastauksessa kenttä on "LA 27/2026 vp", ja
        // ilman päätettä äänestyspolku palauttaa 404. Todennettu
        // 2026-09-07: HE 101/2024, HE 100/2026 ja LA 27/2026 antoivat
        // kaikki 404 ilman päätettä.
        //
        // Kokeillaan molemmat muodot: ensin vp-päätteellä, ja jos se
        // ei osu, ilman. Kaksi kutsua on hyväksyttävä hinta siitä,
        // ettei muotoa tarvitse arvata kutsujan päässä — ja POST-raja
        // (450/3000 s) ei koske näitä GET-kutsuja.
        // KORJATTU 2026-09-07: aiemmin kauttaviiva jätettiin raakana,
        // koska greedy-parametrin `{eduskuntatunnus+}` oletettiin
        // vaativan sen polkuerottimena. OLETUS OLI VÄÄRÄ — selain saa
        // datan osoitteella .../VNT%201%2F2026%20vp, eli kauttaviiva ON
        // koodattuna. Koodataan koko tunnus.
        const enc = t => encodeURIComponent(t);
        const withVp = /\s+vp$/i.test(tunnus) ? tunnus : `${tunnus} vp`;
        const bare   = tunnus.replace(/\s+vp$/i, '');
        let r, url, text, tried = [];
        for (const cand of [withVp, bare]) {
          url = `${EDK_BASE}/taysistunnot/asian-aanestykset/${enc(cand)}`;
          r = await fetch(url, {
            headers: { Accept: 'application/json', 'User-Agent': 'ACI-policy-proxy/1.0' }
          });
          text = await r.text();
          tried.push(`${cand} -> ${r.status}`);
          if (r.ok) break;
          if (r.status !== 404) break;   // muu virhe: älä yritä toista muotoa
        }
        // TYHJÄ 404: SYYTÄ EI TIEDETÄ. Älä tulkitse.
        //
        // Tulkittiin 2026-09-07 ensin "ei äänestetty", koska selaintesti
        // antoi tyhjän ruudun. TULKINTA OLI VÄÄRÄ ja se kumottiin samana
        // päivänä: VNT 1/2026 vp (valtioneuvoston tiedonanto Garden
        // Helsinki -hankkeesta) antaa myös tyhjän 404:n — ja
        // tiedonannoista ÄÄNESTETÄÄN AINA, luottamusäänestys on niiden
        // koko tarkoitus. Kolme koodausta kokeiltu, kaikki tyhjä.
        //
        // Havaittu ero: `taysistunnot` yksin antaa JSON-virheen
        // reitittimeltä, `taysistunnot/asian-aanestykset/X` antaa tyhjän.
        // Eri käsittelijä, mutta ei tiedetä kumpi tarkoittaa mitä.
        //
        // Polku on dokumentaatiosta (api.eduskunta.fi, GET
        // /api/v1/taysistunnot/asian-aanestykset/{eduskuntatunnus+}),
        // joten joko koodaus on yhä väärä tai polku on vanhentunut.
        // RATKAISEMATTA — ja tyhjä 404 nostetaan virheenä, ei
        // tulkita havainnoksi.
        if (!r.ok) throw new Error(
          `Äänestykset ${tunnus}: ${r.status}. Kokeillut muodot: ${tried.join(', ')}`);
        let data;
        try { data = JSON.parse(text); }
        catch { throw new Error(`Äänestykset ${tunnus}: vastaus ei ole JSONia`); }
        const rows = Array.isArray(data) ? data : [data];

        // ÄÄNESTYSTYYPPI — lisätty 2026-09-07.
        //
        // Luottamusäänestys EI mittaa kantaa asiakysymykseen. Se mittaa
        // hallituksen enemmistöä. VNT 1/2026 vp:ssä jako oli
        // hallitusryhmät 100–0 ja oppositio 1–90: se kertoo
        // hallituspohjasta, ei siitä mitä puolueet ajattelevat Garden
        // Helsingin tuesta.
        //
        // ROE:n uptake-asteikko sanoo "esitys noudattaa kannan linjaa"
        // ja "laki on kannan mukainen". Luottamusäänestys ei tuota
        // kumpaakaan — häviö ei todista että KANTA hylättiin, vaan että
        // hallituksella on enemmistö.
        //
        // Tunnistus on karkea ja perustuu otsikkoon + jakauman
        // puhtauteen. Se EI ratkaise puolesta: jokainen äänestys saa
        // `vote_kind`-merkinnän ja `uptake_usable`-lipun, ja
        // rajatapaukset merkitään epävarmoiksi eikä pudoteta.
        const classify = (v) => {
          const t = ((v.aanestysotsikko || {}).fi || '').toLowerCase();
          const vaihe = (((v.kohta || {}).kasittelyvaihenimi || {}).fi || '').toLowerCase();
          if (/luottamus/.test(t))
            return { kind: 'luottamusaanestys', usable: false,
                     why: 'mittaa hallituksen enemmistöä, ei kantaa asiakysymykseen' };
          // Hallitus–oppositio-jako lähes täydellinen -> todennäköisesti
          // ryhmäkuri, ei sisältökysymys. Merkitään epävarmaksi.
          const ho = v.hallitusoppositioJakaumat || [];
          const hal = ho.find(x => /hallitus/i.test((x.nimi || {}).fi || ''));
          const opp = ho.find(x => /oppositio/i.test((x.nimi || {}).fi || ''));
          if (hal && opp) {
            const halPuhdas = hal.ei === 0 || hal.jaa === 0;
            const oppPuhdas = opp.ei === 0 || opp.jaa === 0;
            if (halPuhdas && oppPuhdas)
              return { kind: 'ryhmakuri-epailty', usable: null,
                       why: 'hallitus–oppositio-jako täydellinen: voi olla '
                          + 'luottamuskysymys tai sisältökysymys jossa ryhmäkuri. '
                          + 'EI ratkaista automaattisesti.' };
          }
          return { kind: vaihe.includes('toinen') ? 'sisaltoaanestys-2k' : 'sisaltoaanestys',
                   usable: true,
                   why: 'jako ei noudata hallitus–oppositio-rajaa: '
                      + 'häviö tarkoittaa että sisältö hylättiin' };
        };
        const marked = rows.map(v => {
          const c = classify(v);
          return { ...v, _vote_kind: c.kind, _uptake_usable: c.usable, _uptake_note: c.why };
        });
        const usable = marked.filter(v => v._uptake_usable === true).length;
        const uncertain = marked.filter(v => v._uptake_usable === null).length;
        return Response.json({
          source: 'Eduskunnan avoin data',
          upstream: url,
          data_class: 'authoritative (äänestystulos)',
          fetched: new Date().toISOString(),
          eduskuntatunnus: tunnus,
          upstream_form: tried[tried.length-1].split(' -> ')[0],
          n: rows.length,
          // Tyhjä taulukko EI ole virhe: asiasta ei ole äänestetty.
          // Se on eri asia kuin "haku epäonnistui", ja ero on kirjattava
          // — sama piilonolla-luokka kuin muualla tässä järjestelmässä.
          status: rows.length === 0
            ? 'tyhja taulukko 200:lla — asiasta ei ole aanestetty'
            : `${rows.length} aanestysta: ${usable} uptake-kelpoista, `
              + `${uncertain} epavarmaa, ${rows.length - usable - uncertain} ei-kelpoista`,
          // uptake_measurable EI ole enää sama kuin "aanestyksia loytyi".
          // Luottamusaanestys on aanestys muttei uptaken mittari.
          uptake_measurable: usable > 0,
          vote_kinds: marked.reduce((a, v) => {
            a[v._vote_kind] = (a[v._vote_kind] || 0) + 1; return a; }, {}),
          data: marked
        }, { headers: CORS });
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
