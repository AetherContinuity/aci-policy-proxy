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
`HI-LAIT` and `HI-KAYNNISSA` used to hard-cap at `size:500` with no way to
see past it — they now page automatically up to the API's 10000 max per
page, looping further with `sort`-based `searchAfter` if a category ever
exceeds that. **The multi-page branch is unverified** — nothing tested
against this API has needed a second page yet, so if `?series=HI-KAYNNISSA`
ever looks truncated again, check whether the cursor field is really `sort`
before trusting the result.

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
5. **No HE-tunnus on the kohde, and the join to Eduskunta is still open.**
   None of the LAINSAADANTO hits carry an Eduskunta HE-number, so
   `?asia=HE x/2026` can't be built directly off `kohteet/haku` results.
   `kohde.asianumerot` is a structured VN-diaarinumero (e.g.
   `VN/30707/2025`), present on every hit tested, stable for the case's
   lifecycle, and a solid anchor **within** Hankeikkuna — but it does not
   carry over to Eduskunta. Confirmed dead end: `?asia=` (Eduskunnan
   `search`, property `teksti`) returns **0 hits** both for the VN-number
   and for the plain-language nimeke text — `teksti` does not do free-text
   matching the way the name implies. `eduskuntatunnus` lookups work fine
   once the HE-number is already known (`HE 100/2026`, `VNS 8/2025` both
   returned full aikajana). Two untried paths, neither ruled in or out: a
   VaskiData-style document table might carry the VN-number in its metadata
   (see trap 6 below on where that table actually lives), or the
   `valtiopaivaasia` category may accept some other `search` property than
   `teksti` — worth asking the API directly rather than guessing further.
6. **`api.eduskunta.fi/api/v1` has no table API.** `?edk=` used to proxy
   `/tables/{Table}/rows`, but every table path 404s, and the host root
   returns an S3 `AccessDenied` — there's no table endpoint at this base at
   all. Removed rather than left advertising a broken route.
   `avoindata.eduskunta.fi` is the likely real host for that data; not
   confirmed, not wired up. `/search` (used by `?asia=`) is the only
   Eduskunta route confirmed working here.

## Etappi cross-check: jumissa vs. kirjanpitovelka

An overdue `etapit` entry (`saavutettu: false`, past `etappiLoppu`) is
**not by itself** a stalled project — most of the time it's just a stage
nobody flagged done after the project moved on. The two cases are only
distinguishable by ordinal position, using the order `tyypit/kohteenValmisteluvaiheet`
returns:

- **Jumissa (stalled):** the overdue etappi's `valmisteluvaihe` **equals**
  the kohde's current `valmisteluvaihe`. The project hasn't moved past the
  stage it's late on.
- **Kirjanpitovelka (bookkeeping lag):** the kohde's current
  `valmisteluvaihe` is **ahead of** the overdue etappi's stage. It's stale
  data, not a stuck project.

Measured on the 33 EDUSKUNTAKASITTELY-stage LAINSAADANTO hits (one test
run): 2 jumissa, 10 kirjanpitovelkaa, 21 with no overdue etappi. Without
this ordinal check every one of the 12 overdue cases looks like an alarm;
with it, only 2 are.

Fetched values are re-queryable and do not belong in memory; this interface does.
