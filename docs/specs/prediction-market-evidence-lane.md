# Prediction-market evidence lane — preregistration v1

Status: **research/shadow only**. This lane may fetch public market data and
write point-in-time observations; it has no wallet, signing, order, deposit,
withdrawal, or transaction authority.

## Venue and source contract

The initial venue is Polymarket's public Gamma API. Its official documentation
states that Gamma market/event discovery is public and requires neither an API
key nor authentication. The adapter calls only `GET /markets`; it deliberately
does not import or expose CLOB authenticated trading operations.

Primary references, consulted before implementation:

- https://docs.polymarket.com/api-reference/introduction
- https://docs.polymarket.com/market-data/fetching-markets
- https://docs.polymarket.com/api-reference/events/list-events
- https://docs.polymarket.com/market-data/overview

## Frozen v1 discovery universe

At each observation time, a market is eligible only when all conditions below
hold. These constants are code-level configuration and may only change in a
new preregistration version.

| Rule | v1 value |
| --- | --- |
| Public endpoint | Gamma `GET /markets?active=true&closed=false&order=volume24hr` |
| Time to `endDate` | 15 minutes to 72 hours |
| Market type | binary Yes/No; exactly two valid probabilities summing within 0.02 of 1 |
| Minimum liquidity | $10,000 |
| Minimum 24h volume | $2,000 |
| Required provenance | event id, condition id, question, `resolutionSource`, source URL, observed time |

The first captured eligible observation is prospective evidence. Historical
market data is never inserted as a shadow observation or counted as prospective
evidence.

The public endpoint was live-verified on 2026-08-02. Gamma currently accepts
`order=volume24hr`; its documentation's `volume_24hr` spelling returned HTTP
422, so the adapter uses the accepted field and treats any non-2xx response as
a failed discovery rather than silently weakening the universe.

## Dependence and settlement accounting

Every record receives two `independenceClusterIds`: its `polymarket:event:<id>`
and `polymarket:resolution:<resolution-source-host>:<UTC-end-date>`. Analysis
must union observations sharing *either* key before bootstrapping or aggregation.
This groups all markets in an event and, conservatively, distinct markets that
share an official resolution host and day. Unknown or unparseable resolution
sources share the `unparseable-source` bucket and are not credited as independent
evidence.

No performance result may be reported until a future settlement collector
captures the venue's terminal result alongside its observation history. A
closed or determined market is not automatically a settled outcome. The
collector must preserve raw venue status, result, settlement timestamp, and
resolution-source URL, and must record disputes/amendments rather than
overwriting prior facts.

## Gates

This is an evidence-discovery lane, not a trading strategy. It cannot generate
orders or recommendations. Any future analytical claim must be isolated by this
preregistration version, use only post-registration observations, retain the
conservative cluster counts, and pass the existing supervised paper-review
gates. Integrating data into the signal engine, enabling notifications, or
adding another venue requires a separate reviewed change.
