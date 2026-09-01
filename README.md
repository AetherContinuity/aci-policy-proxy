# aci-policy-proxy

Cloudflare Worker proxy for Finnish central-government open APIs.
Same pattern as `aci-fingrid-proxy` and `aci-pxweb-proxy`: these hosts are
not reachable from sandboxed tooling, and two of them need request shapes
(POST with JSON body, XML responses) that plain fetch helpers handle badly.

## Upstreams

| Source | Base | Data class |
|---|---|---|
| Valtioneuvoston Hankeikkuna | `api.hankeikkuna.fi/api/v2` | self-reported process data |
| Eduskunta | `api.eduskunta.fi/api/v1` | events — dates authoritative |
| Finlex | `opendata.finlex.fi/finlex/avoindata/v1` | authoritative |

**Read this before using the data.** Hankeikkuna milestones and schedules
are what a ministry reports about its own work, not measurements. Cross-check
them against Eduskunta sitting/committee dates and Finlex statute numbers,
which are events and law respectively.

## Routes

    GET  ?hi=asettajat
    GET  ?hi=kohteet/uuid/<uuid>
    POST ?hi=kohteet/haku          body forwarded verbatim
    GET  ?hi_since=2026-08-01T00:00:00&tyyppi=LAINSAADANTO
    GET  ?series=HI-LAIT           live legislative projects
    GET  ?asia=VNS 8/2025          processing timeline + reports + opinions
    GET  ?edk=tables/<Table>/rows&perPage=100&page=0
    GET  ?fx=akn/fi/act/statute/2024/123/fin@     Akoma Ntoso XML

No args returns the route index.

## kohteet/haku body fields

`tyyppi` HANKE | LAINSAADANTO | TOIMIELIN | STRATEGIA ·
`tila` SUUNNITTEILLA | KAYNNISSA | PAATTYNYT ·
`valmisteluvaihe` ESIVALMISTELU | PERUSVALMISTELU | LAUSUNTOMENETTELY |
JATKOVALMISTELU | VALTIONEUVOSTON_PAATOKSENTEKO | EDUSKUNTAKASITTELY |
LAIN_VAHVISTAMINEN | KESKEYTETTY | VALMISTUNUT ·
`lainsaadantoTehtavaluokka`, `etappiTyyppi`, `toimielinTyyppi`,
`strategiaTyyppi` — see spec ·
`tunnus` e.g. `VNK:500:2014` · `asiasanat` YSO/JUHO URIs · `teksti` (string) ·
`asettamisPaivaAlku/Loppu`, `muokattuPaivaAlku/Loppu`,
`etappiAlkamisPaivaAlku/Loppu` as `YYYY-MM-DDTHH:MM:SS` — **no Z**.

Paging is **cursor-based**: `size` (1..10000) plus `searchAfter`. Not pages.

## kohteet/haku response shape (LAINSAADANTO)

Each hit is `{ kohde, lainsaadanto, etapit, asiakirjat, asiasanat, linkit, ... }`.
`tunnus`, `nimi`, and `valmisteluvaihe` live inside `kohde`, not at the top
level — parse for `kohde.valmisteluvaihe`, not `.valmisteluvaihe`.

`lainsaadanto.heTiedot` carries tehtäväluokka, säädöstyypit, arvioitu
sivumäärä, kiireellisyys, and `perustuslakivaliokunnanLausuntoVaaditaan`.
`säädöstyyppi` includes `MUU_EU_POLITIIKKAAN_LIITTYVA` — EU origin is
machine-readable per statute. `linkit` carries EUR-Lex URLs where relevant.
`asiakirjat` (lausunnot etc.) can be large — 1,667 entries across 33
EDUSKUNTAKASITTELY-stage LAINSAADANTO hits in one test run.

## Known traps

1. **Base is `/api/v2`.** The official testausohje PDF documents `/api/v1`,
   which 404s with `No static resource`. The live OpenAPI 3.1 spec at
   <https://api.hankeikkuna.fi/api/api-docs> is authoritative; the PDF is not.
2. `hallitusohjelmat/karkihankkeet|painopistealueet|toimenpiteet` are the
   Sipilä-era model and still served. The current model is
   `hallitusohjelmat/rakenneElementit/haku` (POST) plus
   `rakenneElementtiTyypit` and `valitavoiteTyypit`.
3. `valmisteluvaihe` is the useful field for pipeline work: it exposes the
   whole chain esivalmistelu → lausuntomenettely → eduskuntakäsittely →
   lain vahvistaminen as a machine-readable enum.
4. **Response fields are nested, not flat.** See "kohteet/haku response
   shape" above — a parser expecting `.tunnus` or `.valmisteluvaihe` at the
   root gets `undefined` silently. Same trap shape as PxWeb's `category.index`.
5. **No HE-tunnus on the kohde.** None of the LAINSAADANTO hits carry an
   Eduskunta HE-number, so `?asia=HE x/2026` can't be joined directly off
   `kohteet/haku` results. `kohde.asianumerot` is the better anchor instead
   of the nimeke text: it's a structured VN-diaarinumero (e.g.
   `VN/30707/2025`), present on every hit tested, and stable for the life of
   the case — but it has not yet been confirmed to match anything on the
   Eduskunta side. That match is the open question for joining this proxy's
   two halves; it needs testing against `?edk=`, not more Hankeikkuna reading.

Fetched values are re-queryable and do not belong in memory; this interface does.
