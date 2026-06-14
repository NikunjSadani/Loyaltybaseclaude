# Loyaltybase — Canonical Design & Spec

**Product:** Loyaltybase · **Operator:** Gifsy · **Domain:** `gifsy.in` (per-tenant subdomains)

This is the source-of-truth design documentation for the platform, reverse-engineered
from the existing codebase and refined with product intent. It exists to drive future
planning, catch gaps/inconsistencies, and decide what to build next.

## How this is organized

Produced in the order a disciplined greenfield project would, each artifact
reverse-engineered from what's already built. Benchmarked against industry practice:
PRD (product track), DDD ubiquitous language + bounded contexts (domain), arc42 + C4
(architecture track), event storming (workflows).

| Phase | Artifact | File | Status |
|-------|----------|------|--------|
| 0 | Foundation — Vision, Personas, Glossary | [00-foundation.md](00-foundation.md) | ✅ drafted |
| 1 | Capability / Module Catalog (bounded contexts) | [01-capabilities.md](01-capabilities.md) | ✅ done (17 contexts, 4 deep-dives resolved) |
| 1 | Core Workflows & State Machines | [02-workflows.md](02-workflows.md) | ✅ done (6 workflows + state machines) |
| 2 | Domain & Data Model | [03-data-model.md](03-data-model.md) | ✅ drafted (ERDs + patterns) |
| 2 | Architecture & Cross-cutting (arc42/C4) | [04-architecture.md](04-architecture.md) | ✅ drafted (C4 + arc42 sections) |
| 2 | API Surface | [05-api-surface.md](05-api-surface.md) | ✅ done (~113 handlers, verified methods) |
| 3 | Per-tenant Configurability Matrix | [06-configurability.md](06-configurability.md) | ✅ drafted (8 categories) |
| 3 | Non-functional & Compliance | [07-nfr-compliance.md](07-nfr-compliance.md) | ✅ drafted |
| — | **Gap & Inconsistency Register** (living) | [gap-register.md](gap-register.md) | 🔄 ongoing |

## Conventions

- **Current state** = what the code does today. **Target state** = intended design.
  Where they differ, it's logged in the Gap Register.
- Bounded contexts are named as domains, not just feature buckets.
