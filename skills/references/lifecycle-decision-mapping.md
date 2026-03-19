# Lifecycle Decision Mapping

Consolidated reference for mapping forecast lifecycle phases to domain-specific decisions. Each skill references the section relevant to its workflow.

Lifecycle phases are produced by the forecast external engine (see [`forecast`](../forecast/SKILL.md)):
- **emerging** — new topic with short-term spike, low historical volume
- **accelerating** — growing across multiple timescales
- **peaking** — short-term deceleration, medium-term still positive
- **stable** — flat across timescales
- **decaying** — declining across timescales

## Architecture: Boundary Design

Used by [`architecture`](../architecture/SKILL.md) step 0b (Ecosystem Pressure Check).

| Lifecycle phase | Boundary recommendation |
|---|---|
| emerging | Keep boundaries loose — expect interface churn, use Adapter |
| accelerating | Good adoption window — design against current APIs |
| peaking / stable | Design for longevity — pin versions confidently |
| decaying | Wall off behind Facade — minimize coupling surface |

**Dynamic signals**:
| Dynamics signal | Architecture implication |
|---|---|
| reinforcing loop detected | Area is compounding — delaying adoption widens the gap |
| dampening detected | Growth arrested — don't over-invest in integration depth |
| accumulation detected | Pressure building — define boundary before forced migration |

## Design: Pattern Longevity

Used by [`design`](../design/SKILL.md) step 2b (Pattern Longevity Check).

| Lifecycle phase | Pattern guidance |
|---|---|
| decaying | Adapter/Facade is urgent — isolate the dying dependency, prepare swap interface |
| accelerating | Lighter wrapping — the API is still finding its shape; heavy abstraction fights upstream changes |
| stable | Any pattern works — optimize for internal coupling concerns from archobs |
| emerging | Adapter with narrow surface — expect rapid breaking changes |

**Compound signal** (archobs x forecast):
| Archobs signal | Forecast signal | Implication |
|---|---|---|
| High xnbr + external dependency | decaying | Urgent extraction candidate — the bridge is to a sinking island |
| High hubness + external dependency | accelerating | Monitor — high fan-in to a moving target risks cascading breakage |
| High leakage between clusters | diverging lifecycles | Split is natural — the ecosystems are pulling apart |

## Plan: Risk Amplification

Used by [`plan`](../plan/SKILL.md) step 4b (Risk Amplification).

| Archobs signal | Forecast signal | Interpretation | Priority adjustment |
|---|---|---|---|
| High risk (>0.5) | reinforcing loop | Compound risk — structural debt accelerating | Prioritize first |
| High risk (>0.5) | stable / decaying | Structural debt, stable ecosystem | Schedule normally |
| High leakage (>0.20) | diverging lifecycles | Boundary spans ecosystems moving in different directions | Prioritize boundary extraction |
| Low risk | emerging / accelerating | Emerging opportunity | Plan adoption path before coupling grows organically |
| High coupling to dependency | decaying phase | Dependency is dying — extraction is urgent | Elevate to P0 |

## Spec: Versioning Strategy

Used by [`spec`](../spec/SKILL.md) step 0b (Versioning guidance from forecast).

| Lifecycle phase | Versioning strategy |
|---|---|
| accelerating | Design for version negotiation — expect API churn, use flexible contracts |
| stable | Pin versions confidently — stable API surface |
| decaying | Include migration timeline in spec — plan for replacement |
| emerging | Use narrow contract surface — only pin what you use today |
