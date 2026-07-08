# Commercial Capability Boundary

Last updated: 2026-07-08

This document defines the public Zendio boundary for trial packaging, capability policy contracts, and future private commercial overlays.

## Boundary Rules

- Public Zendio source contains no private entitlement implementation.
- Trial packaging is an artifact channel, not subscription proof.
- The tracked public runtime must not enforce Pro, subscription, customer, payment, or remote entitlement state.
- Future private layers may inject capability policy through explicit public-safe ports, but private providers stay outside this repository.
- Reader, Video, and Options code must not import private commercial concepts.
- Retention policy selection remains generic. P03 owns any retention selector work and must not couple Reader or Video to subscription logic.
- Remote entitlement endpoints, customer identifiers, subscription status, payment state, private dashboards, and owner server behavior are private overlay concerns.
- Public builds must not add extension permissions for commercial behavior.

## Decision Table

| Concern              | Public repo owner               | Private overlay owner | Public behavior now             |
| -------------------- | ------------------------------- | --------------------- | ------------------------------- |
| Trial package marker | package scripts/trial lifecycle | none                  | first-install local config only |
| Feature entitlement  | none                            | private provider      | no public gating                |
| Retention policy     | generic policy contract         | private selector      | Free defaults                   |
| Pro UI               | none                            | private UI layer      | not present                     |
| Remote entitlement   | none                            | private service       | not present                     |

## Public Contracts

- `scripts/package-trial.mjs` creates trial artifacts through an isolated dist channel and must not mutate `package.json`.
- `scripts/package.mjs --trial` may write `trial-config.json` into the selected dist directory and may label the manifest name for the artifact.
- `src/background/trialLifecycle.ts`, `src/utils/trial-manager.ts`, and `src/utils/trial-manager-ports.ts` are production-owned because background startup imports the trial lifecycle path.
- `src/components/trial-notice.ts` remains a retained facade and is not delete-approved.
- `src/shared/capabilities/capabilityPolicy.ts` is a neutral facade over the production `SessionDraftStoragePolicy` normalizer. The public contract contains retention limits, draft technical caps, and video screenshot cache caps; it does not define a separate tier source of truth.
- Public Free defaults remain `48h` retention, `5` restorable page identities, `20` items per page, `100` draft entries, `512 KiB` per draft envelope, `100` screenshot cache entries globally, `50` per page, and `1 MiB` per screenshot.

## Private-Owner Only Decisions

- How a private overlay authenticates users.
- Whether a private overlay has Pro UI, payment UI, subscription state, or customer identifiers.
- Which remote entitlement service, if any, exists.
- How owner-only retention policy selection maps private business state to the public generic policy contract.
- Any live commercial server behavior, telemetry dashboard, deployment record, or rollback record.
