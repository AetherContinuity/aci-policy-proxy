# aci-policy-proxy

Cloudflare Worker proxy for Finnish central-government open APIs.
Same pattern as `aci-fingrid-proxy` and `aci-pxweb-proxy`: these hosts are
not reachable from sandboxed tooling, and two of them need request shapes
(POST with JSON body, XML responses) that plain fetch helpers handle badly.

## Upstreams

| Source | Base | Data class |
|---|---|---|
| Valtioneuvoston Hankeikkuna | `api.hankeikkuna.fi/api/v1` | self-reported process data |
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
`tila` e.g. KAYNNISSA · `tunnus` e.g. `VNK:500:2014` ·
`asiasanat` YSO/JUHO URIs · `teksti` (string) ·
`muokattuPaivaAlku` / `muokattuPaivaLoppu` as `YYYY-MM-DDTHH:MM:SS` — **no Z**.

## Known trap

`hallitusohjelmat/karkihankkeet|painopistealueet|toimenpiteet` are the
Sipilä-era data model. The current model is *toimintasuunnitelma* with
*elementit* and *välitavoitteet*; its endpoints are not in the official
testausohje (2017). Verify at <https://api.hankeikkuna.fi/api> (Swagger).

Fetched values are re-queryable and do not belong in memory; this interface does.
