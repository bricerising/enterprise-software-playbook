# Spec 013: Topic Strategy

## Problem

The intelligence tool classifies collected events into topics, which serve as the semantic spine for trends, search filtering, forecasting, and chain detection. The current `topics.yaml` contains ~71 topics organized by **technology vendor** (16 AWS service topics, 4 individual AI vendor topics, etc.), but the tool's purpose is to inform **SDLC decisions** — what to build with, how to build it, when to change course.

Three structural problems follow from vendor-organized topics:

1. **Granularity mismatch** — 16 AWS service topics vs 2 OSS topics vs 3 database topics. AWS Step Functions gets its own topic; the entire data engineering discipline shares one. The density reflects vendor familiarity, not decision-relevance.

2. **Vendor identity ≠ decision identity** — An OpenAI model release and an Anthropic model release inform the same SDLC decision: "should we switch or upgrade our foundation model?" Separate vendor topics fragment the signal that should inform a single decision.

3. **Missing decision-relevant areas** — No topics for frontend architecture, API design, testing practices, data governance, identity/auth, WebAssembly, cloud cost optimization, or compliance standards. These are areas where trend detection directly changes engineering decisions, but they're invisible to the classifier.

The forecast module (spec 007) amplifies these problems: chain detection between `aws.bedrock` and `aws.lambda` is a within-vendor correlation that rarely informs a decision, while the cross-domain chain between `ai.foundation-models` and `data.vector` — where the decision-relevant signal lives — is fragmented across vendor topics.

## Goal

Establish a topic strategy that derives topics from SDLC decisions:

1. Define the SDLC decision categories that topic classification exists to inform
2. Design a taxonomy organized by decision-relevance, not technology vendor
3. Set principles for topic granularity, lifecycle, and evolution
4. Identify what the new taxonomy demands from the classifier

## Non-Goals

- Classifier implementation details (covered in spec 006, Topic Classification section)
- Forecast algorithm changes (covered in spec 007)
- Per-topic keyword/regex definitions (those belong in `topics.yaml` as a follow-up implementation task)
- Prompt engineering for LLM-based classification (future work)

---

## SDLC Decisions Topics Must Inform

Topics exist to detect trends that change engineering decisions. Each topic must map to at least one decision category from this table. If a topic can't answer "what would an engineer do differently if this were trending?" — it doesn't earn its own slot.

| Decision category | Example question | What a trend signal looks like | Action it triggers |
|---|---|---|---|
| **Stack selection** | Should we adopt Rust for our new CLI tool? | `lang.rust` volume +300% over 90d, accelerating phase | Evaluate Rust; sustained adoption growth signals ecosystem maturity and hiring pool expansion |
| **Build vs buy vs adopt** | Build custom observability or adopt Datadog? | `devex.observability` emerging + `market.licensing` chain activity | Commercial tool ecosystem shifting; evaluate alternatives before committing |
| **Architecture evolution** | Should we move from REST to event-driven? | `arch.event-driven` emerging + `data.streaming` accelerating, cross-domain chain | Architecture shift underway in industry; schedule architecture review |
| **Dependency governance** | Is our Redis dependency safe long-term? | `data.caching` + `market.licensing` co-movement; BSL licensing signals | Dependency risk materializing; evaluate Valkey fork, assess migration cost |
| **Security posture** | Are supply chain attacks increasing? | `security.supply-chain` CUSUM change point + volume spike | Escalating threat landscape; audit dependency tree, tighten SBOM policy |
| **Operational model** | Should we invest more in platform engineering? | `devex.platform` accelerating + `devex.cicd` stable high volume | Industry investing in developer platforms; evaluate internal platform gaps |
| **AI integration** | When to integrate AI coding assistants into our SDLC? | `ai.coding-assistants` peaking phase, `market.talent` hiring shift signals | Tool maturity plateauing (adoption peak); evaluate and standardize now, not later |
| **Compliance & regulation** | Will AI regulation affect our product? | `regulation.ai` accelerating + `ai.safety` chain, cross-domain convergence | Regulatory pressure building; start compliance roadmap before mandates arrive |
| **Market position** | Where is cloud investment heading? | `market.investment` + `compute.gpu` co-movement, `market.earnings` confirmation | CapEx shifting to AI infrastructure; adjust capacity planning and vendor negotiations |

---

## Topic Design Principles

### P1. Decision-Relevance Test

A topic earns its own slot if and only if trend signals in that topic can change an SDLC decision. The test: "if this topic moves from stable to accelerating, what does an engineering team do differently?" If the answer is nothing — or the same thing they'd do for a neighboring topic — it doesn't need its own slot.

**Passes:** `security.supply-chain` — a spike means "audit your dependencies now," a different action than a spike in `security.appsec` (which means "review your input validation").

**Fails:** `aws.s3` as a standalone topic — an S3 trend doesn't trigger a different decision than an `aws.general` trend. S3 signals are absorbed into `compute.cloud-platforms` (general cloud platform developments) or `data.*` topics depending on the signal content.

### P2. Granularity Rules

**Split** when two sub-areas inform different SDLC decisions with different actions:
- PostgreSQL vs MongoDB inform different data architecture choices (relational vs document model) → separate topics `data.relational` and `data.document`

**Merge** when sub-areas consistently co-move and inform the same decision:
- OpenAI, Anthropic, Google AI, Meta AI all inform "which foundation model should we use?" → single topic `ai.foundation-models`
- AWS CDK and Terraform both inform "which IaC tool?" → single topic `compute.iac`

**Absorb** when a sub-area rarely generates independent signal:
- AWS Aurora is a PostgreSQL variant; Aurora trends are PostgreSQL decision signals → absorbed into `data.relational`
- AWS Step Functions trends inform event-driven architecture decisions → absorbed into `arch.event-driven`
- SQLite trends rarely diverge from relational database trends at the SDLC decision level → absorbed into `data.relational`

### P3. Signal-to-Noise Threshold

Topics must generate enough signal to produce actionable trends:

- **Minimum viable volume**: A topic that averages <5 events/month over 3 consecutive months is a candidate for absorption into its parent domain. Below this threshold, lifecycle classification is noise and chain detection has insufficient support.
- **Overlap ceiling**: If >50% of events classified into topic A are also classified into topic B, they likely inform the same decision. Evaluate merging.
- **False positive ceiling**: If >30% of events classified into a topic are false positives (per manual audit or learning loop feedback), the topic definition needs refinement or the topic should be absorbed.

### P4. Forecast Chain Value

Topics that frequently appear in cross-domain chains provide disproportionate forecast value and should be preserved even if their standalone volume is moderate:

- A topic that enables cross-domain chain detection (e.g., `compute.gpu` linking `ai.training` to `market.investment`) earns its slot through forecast utility, not just trend volume.
- A topic that only chains within its own domain (e.g., `aws.bedrock` → `aws.lambda`) may be too granular — the chain is a within-vendor correlation, not a cross-domain insight.

### P5. Vendor Neutrality

Topics represent technology areas and decisions, not vendors. Vendor identity is metadata (captured in event content and tags), not a classification axis.

- **Right**: `ai.foundation-models` captures OpenAI, Anthropic, Google, Meta model releases under one decision-relevant topic
- **Right**: `compute.cloud-platforms` captures AWS, Azure, GCP platform developments under one topic
- **Wrong**: Separate `ai.openai`, `ai.anthropic`, `ai.google` topics that fragment the "which model?" decision signal

When vendor identity matters for a decision (e.g., "should we move from AWS to Azure?"), the relevant signal is in `compute.cloud-platforms` and the vendor is in the event content, searchable via FTS.

### P6. Domain Balance

No single domain should consume >30% of total topics. Disproportionate density in one domain signals vendor/familiarity bias, not decision-relevance. The current taxonomy violates this: AWS alone is 22% of topics (16/71).

---

## Taxonomy

### Domain Structure

Nine domains organized by the SDLC decisions they primarily inform:

| Domain | Primary decisions informed | Topic count | % of total |
|---|---|---|---|
| `ai` | AI integration, stack selection, build vs buy | 9 | 15.5% |
| `compute` | Stack selection, architecture evolution, operational model | 8 | 13.8% |
| `security` | Security posture, dependency governance | 6 | 10.3% |
| `data` | Stack selection, architecture evolution | 7 | 12.1% |
| `devex` | Build vs buy, operational model | 6 | 10.3% |
| `lang` | Stack selection, dependency governance | 6 | 10.3% |
| `arch` | Architecture evolution | 5 | 8.6% |
| `regulation` | Compliance & regulation | 4 | 6.9% |
| `market` | Market position, build vs buy | 7 | 12.1% |
| **Total** | | **58** | |

Maximum domain density: 15.5% (ai). All domains under 30%.

### Topic ID Convention

Format: `domain.name` where `name` uses hyphens for multi-word identifiers. Examples: `ai.foundation-models`, `security.supply-chain`, `compute.cloud-platforms`.

### Full Topic List

#### ai — AI & Machine Learning

| ID | Label | Decision | Example trend signal |
|---|---|---|---|
| `ai.foundation-models` | Foundation Models | AI integration, stack selection | New model release benchmarks indicate capability threshold crossed; evaluate for production use |
| `ai.coding-assistants` | AI Coding Assistants | AI integration, build vs buy | Copilot/Cursor adoption accelerating; standardize tooling before fragmented adoption |
| `ai.agents` | AI Agents | AI integration, architecture | Agentic framework maturity improving; evaluate agent-based workflows for automation |
| `ai.rag` | Retrieval Augmented Generation | AI integration, architecture | RAG pipeline patterns stabilizing; adopt for knowledge-grounded applications |
| `ai.inference` | ML Inference | Stack selection, operational model | Local/edge inference improving; evaluate self-hosted vs API-based deployment |
| `ai.training` | ML Training & Fine-Tuning | Build vs buy, stack selection | Fine-tuning cost dropping; evaluate custom models vs prompted foundation models |
| `ai.safety` | AI Safety & Alignment | Security posture, compliance | Red-teaming incidents increasing; strengthen guardrails before deployment |
| `ai.multimodal` | Multimodal AI | AI integration, stack selection | Image/video/audio generation maturing; evaluate multimodal integration points |
| `ai.protocols` | AI Protocols & Interop | Stack selection, architecture | MCP adoption accelerating; adopt protocol for agent-tool integration |

#### compute — Compute & Deployment

| ID | Label | Decision | Example trend signal |
|---|---|---|---|
| `compute.serverless` | Serverless & FaaS | Stack selection, architecture | Edge function ecosystem expanding; evaluate for latency-sensitive workloads |
| `compute.containers` | Containers & Orchestration | Stack selection, operational model | Kubernetes complexity driving platform-team investment; evaluate managed alternatives |
| `compute.iac` | Infrastructure as Code | Build vs buy, stack selection | IaC consolidation trend (Terraform vs Pulumi vs CDK); standardize before drift |
| `compute.edge` | Edge Computing | Architecture, stack selection | Edge compute capabilities expanding; evaluate for data-locality requirements |
| `compute.gpu` | GPU & Accelerators | Stack selection, market position | GPU availability improving; reassess self-hosted training/inference economics |
| `compute.semiconductor` | Semiconductors & Chips | Market position, stack selection | ARM/RISC-V adoption accelerating; evaluate architecture portability |
| `compute.cloud-platforms` | Cloud Platforms | Stack selection, market position | Multi-cloud trend shifting; reassess vendor lock-in and migration costs |
| `compute.networking` | Cloud Networking | Architecture, operational model | Service mesh adoption patterns changing; evaluate networking architecture |

#### security — Security

| ID | Label | Decision | Example trend signal |
|---|---|---|---|
| `security.vulnerabilities` | Vulnerabilities & CVEs | Security posture, dependency governance | Critical CVE volume spike in ecosystem dependency; trigger patch cycle |
| `security.supply-chain` | Supply Chain Security | Dependency governance, security posture | Typosquatting attacks increasing; tighten package verification, audit SBOM |
| `security.appsec` | Application Security | Security posture | New OWASP category gaining volume; review application for exposure |
| `security.cloud` | Cloud Security | Security posture, operational model | Cloud misconfiguration incidents rising; audit IAM policies, review least-privilege |
| `security.cryptography` | Cryptography | Stack selection, compliance | Post-quantum migration timeline accelerating; assess cryptographic dependencies |
| `security.identity` | Identity & Access | Architecture, security posture | Passkey/FIDO adoption accelerating; evaluate auth modernization path |

#### data — Data & Storage

| ID | Label | Decision | Example trend signal |
|---|---|---|---|
| `data.relational` | Relational Databases | Stack selection, architecture | PostgreSQL extension ecosystem accelerating; evaluate consolidated data platform |
| `data.document` | Document & KV Stores | Stack selection, architecture | Document DB usage patterns shifting; reassess data model choices |
| `data.streaming` | Event Streaming | Architecture, stack selection | Kafka alternative ecosystem growing; evaluate streaming infrastructure options |
| `data.analytics` | Data Analytics & Warehousing | Stack selection, build vs buy | Lakehouse convergence trend; evaluate unified analytics architecture |
| `data.vector` | Vector & Embedding Stores | AI integration, stack selection | Vector database maturity improving; evaluate for RAG and semantic search |
| `data.caching` | Caching & In-Memory | Stack selection, dependency governance | Redis licensing shift; evaluate Valkey/Dragonfly alternatives |
| `data.governance` | Data Governance | Compliance, architecture | Data mesh and governance tooling maturing; invest in data quality infrastructure |

#### devex — Developer Experience & Operations

| ID | Label | Decision | Example trend signal |
|---|---|---|---|
| `devex.cicd` | CI/CD & Deployment | Build vs buy, operational model | GitHub Actions ecosystem expanding; consolidate pipeline tooling |
| `devex.observability` | Observability | Build vs buy, operational model | OpenTelemetry adoption accelerating; standardize instrumentation before vendor lock-in |
| `devex.platform` | Platform Engineering | Build vs buy, operational model | Internal developer platform investment growing; evaluate build vs adopt for developer portal |
| `devex.testing` | Testing & Quality | Stack selection, operational model | AI-assisted testing maturing; evaluate test generation and mutation testing tools |
| `devex.api` | API Design & Protocols | Architecture, stack selection | GraphQL federation evolving; reassess API architecture strategy |
| `devex.cost` | Cloud Cost & FinOps | Operational model, market position | Cloud cost optimization tools maturing; invest in FinOps practices and tooling |

#### lang — Languages & Runtimes

| ID | Label | Decision | Example trend signal |
|---|---|---|---|
| `lang.typescript` | TypeScript & JS Runtimes | Stack selection, dependency governance | Bun/Deno adoption growing; evaluate runtime alternatives for new services |
| `lang.rust` | Rust | Stack selection | Rust adoption in infrastructure tooling accelerating; evaluate for performance-critical services |
| `lang.python` | Python | Stack selection, AI integration | Python packaging ecosystem improving; reassess Python for production services |
| `lang.go` | Go | Stack selection | Go generics ecosystem maturing; evaluate for cloud-native tooling |
| `lang.java` | Java & JVM | Stack selection | GraalVM/Kotlin momentum; evaluate JVM modernization path |
| `lang.wasm` | WebAssembly | Stack selection, architecture | WASI component model stabilizing; evaluate for portable serverless workloads |

#### arch — Architecture Patterns

| ID | Label | Decision | Example trend signal |
|---|---|---|---|
| `arch.microservices` | Microservices & Boundaries | Architecture evolution | Modular monolith pattern gaining momentum; evaluate bounded context boundaries |
| `arch.event-driven` | Event-Driven Architecture | Architecture evolution | Event sourcing adoption growing in domain; evaluate CQRS for write-heavy services |
| `arch.reliability` | Reliability & SRE | Operational model | SLO-based reliability practices maturing; adopt error budget framework |
| `arch.frontend` | Frontend Architecture | Stack selection, architecture | React Server Components adoption growing; evaluate frontend architecture refresh |
| `arch.migration` | Migration & Modernization | Architecture evolution | Cloud-native migration tooling improving; reassess modernization timeline |

#### regulation — Compliance & Regulation

| ID | Label | Decision | Example trend signal |
|---|---|---|---|
| `regulation.ai` | AI Regulation | Compliance, AI integration | EU AI Act enforcement timeline advancing; prepare classification and documentation |
| `regulation.privacy` | Privacy & Data Protection | Compliance, architecture | New privacy regulation introduced; audit data flows and consent mechanisms |
| `regulation.antitrust` | Antitrust & Competition | Market position | Major antitrust ruling affecting cloud vendor; reassess vendor strategy |
| `regulation.standards` | Industry Standards | Compliance, operational model | SOC2/ISO requirements tightening; invest in compliance automation |

#### market — Market & Business Intelligence

| ID | Label | Decision | Example trend signal |
|---|---|---|---|
| `market.funding` | Startup Funding | Build vs buy, stack selection | VC funding concentrated in observability startups; evaluate emerging vendors |
| `market.acquisition` | M&A Activity | Dependency governance, stack selection | Key dependency acquired by competitor; assess migration risk |
| `market.earnings` | Earnings & Revenue | Market position, stack selection | Cloud revenue growth decelerating; negotiate pricing, evaluate alternatives |
| `market.talent` | Talent & Workforce | Stack selection, market position | Rust hiring demand accelerating; confirms ecosystem viability for stack decision |
| `market.licensing` | Open Source Licensing | Dependency governance, build vs buy | BSL relicensing trend continuing; audit dependencies for license risk |
| `market.investment` | Technology Investment | Market position | AI infrastructure CapEx surging; confirms long-term platform viability |
| `market.ipo` | IPOs & Public Markets | Market position | Developer tooling IPO wave; signals maturity and consolidation in segment |

---

## Migration from Current Topics

The 71 current topics map to the 58 new topics. Vendor-specific topics are absorbed into decision-relevant categories. The `event_topics` side table and `events.topics` JSON column require reclassification for historical data (via `intel db rebuild-topic-index` after updating the classifier).

### Absorption Map

| Current topic | New topic | Rationale |
|---|---|---|
| `aws.bedrock` | `ai.foundation-models` | Managed AI service; informs foundation model selection |
| `aws.lambda` | `compute.serverless` | Serverless compute; informs FaaS stack selection |
| `aws.sagemaker` | `ai.training` | ML training infrastructure; informs training platform selection |
| `aws.ecs` | `compute.containers` | Container orchestration; informs container platform selection |
| `aws.eks` | `compute.containers` | Kubernetes managed service; informs container platform selection |
| `aws.s3` | `compute.cloud-platforms` | General cloud storage; informs cloud platform decisions |
| `aws.dynamodb` | `data.document` | Document/KV store; informs data model selection |
| `aws.cloudformation` | `compute.iac` | IaC tool; informs infrastructure tooling selection |
| `aws.cdk` | `compute.iac` | IaC tool; informs infrastructure tooling selection |
| `aws.stepfunctions` | `arch.event-driven` | Workflow orchestration; informs event-driven architecture decisions |
| `aws.eventbridge` | `data.streaming` | Event bus; informs event streaming architecture decisions |
| `aws.rds` | `data.relational` | Managed relational DB; informs database selection |
| `aws.aurora` | `data.relational` | PostgreSQL/MySQL variant; informs relational DB selection |
| `aws.ec2` | `compute.cloud-platforms` | General compute; informs cloud platform decisions |
| `aws.iam` | `security.identity` | Identity/access management; informs auth architecture |
| `aws.general` | `compute.cloud-platforms` | General cloud platform signals |
| `ai.llm` | `ai.foundation-models` | Foundation model; same decision as vendor-specific model topics |
| `ai.openai` | `ai.foundation-models` | Vendor absorbed; informs same "which model" decision |
| `ai.anthropic` | `ai.foundation-models` | Vendor absorbed; informs same "which model" decision |
| `ai.google` | `ai.foundation-models` | Vendor absorbed; informs same "which model" decision |
| `ai.meta` | `ai.foundation-models` | Vendor absorbed; informs same "which model" decision |
| `ai.diffusion` | `ai.multimodal` | Image generation is a multimodal AI concern |
| `ai.embeddings` | `data.vector` | Embeddings are a data/storage concern for RAG architecture |
| `ai.coding` | `ai.coding-assistants` | Renamed for clarity |
| `ai.rag` | `ai.rag` | Unchanged |
| `ai.agents` | `ai.agents` | Unchanged |
| `ai.training` | `ai.training` | Unchanged |
| `ai.inference` | `ai.inference` | Unchanged |
| `ai.safety` | `ai.safety` | Unchanged |
| `ai.mcp` | `ai.protocols` | Broadened to cover AI interop protocols generally |
| `cloud.kubernetes` | `compute.containers` | Container orchestration; merged with Docker under containers |
| `cloud.docker` | `compute.containers` | Container tooling; merged with Kubernetes under containers |
| `cloud.terraform` | `compute.iac` | IaC tool; merged into infrastructure-as-code topic |
| `cloud.serverless` | `compute.serverless` | Domain renamed from `cloud` to `compute` |
| `cloud.observability` | `devex.observability` | Observability is a developer experience concern |
| `cloud.cicd` | `devex.cicd` | CI/CD is a developer experience concern |
| `cloud.networking` | `compute.networking` | Domain renamed from `cloud` to `compute` |
| `security.vulnerability` | `security.vulnerabilities` | Pluralized for consistency |
| `security.supply_chain` | `security.supply-chain` | Reformatted with hyphen convention |
| `security.cloud` | `security.cloud` | Unchanged |
| `security.appsec` | `security.appsec` | Unchanged |
| `security.crypto` | `security.cryptography` | Expanded name for clarity |
| `lang.typescript` | `lang.typescript` | Unchanged; absorbs `framework.node` (Node.js is TS/JS runtime) |
| `lang.rust` | `lang.rust` | Unchanged |
| `lang.python` | `lang.python` | Unchanged |
| `lang.go` | `lang.go` | Unchanged |
| `framework.react` | `arch.frontend` | React is a frontend architecture signal, not a standalone framework topic |
| `framework.node` | `lang.typescript` | Node.js is part of the TypeScript/JavaScript runtime ecosystem |
| `db.postgres` | `data.relational` | PostgreSQL signals inform relational database decisions |
| `db.sqlite` | `data.relational` | SQLite signals inform relational database decisions |
| `db.redis` | `data.caching` | Redis signals inform caching/in-memory architecture decisions |
| `biz.cloud_revenue` | `market.earnings` | Cloud revenue is an earnings/financial signal |
| `biz.ai_spend` | `market.investment` | AI spending is a technology investment signal |
| `biz.guidance` | `market.earnings` | Forward guidance is an earnings signal |
| `biz.sec_filing` | `market.earnings` | SEC filings are earnings/financial signals |
| `biz.earnings` | `market.earnings` | Direct mapping |
| `biz.acquisition` | `market.acquisition` | Domain renamed from `biz` to `market` |
| `biz.funding` | `market.funding` | Domain renamed from `biz` to `market` |
| `biz.ipo` | `market.ipo` | Domain renamed from `biz` to `market` |
| `biz.layoff` | `market.talent` | Layoffs are talent/workforce signals |
| `oss.release` | *(absorbed)* | Software releases are signals within the relevant domain topic (React release → `arch.frontend`, Rust release → `lang.rust`). "Release" is a content type, not a decision category. |
| `oss.license` | `market.licensing` | Open source licensing informs dependency governance decisions |
| `eng.architecture` | `arch.microservices` | Software architecture signals map to microservices/boundaries topic |
| `eng.platform` | `devex.platform` | Platform engineering is a developer experience concern |
| `eng.sre` | `arch.reliability` | SRE signals inform reliability architecture decisions |
| `eng.data` | `data.analytics` | Data engineering signals inform analytics architecture decisions |
| `hw.gpu` | `compute.gpu` | GPU signals inform compute infrastructure decisions |
| `hw.chip` | `compute.semiconductor` | Semiconductor signals inform hardware platform decisions |
| `policy.ai_regulation` | `regulation.ai` | Domain renamed from `policy` to `regulation` |
| `policy.privacy` | `regulation.privacy` | Domain renamed from `policy` to `regulation` |
| `policy.antitrust` | `regulation.antitrust` | Domain renamed from `policy` to `regulation` |

### New Topics (No Current Equivalent)

| New topic | Rationale |
|---|---|
| `security.identity` | Authentication and identity decisions (passkeys, SSO, OAuth, OIDC) were split across `aws.iam` and `security.appsec`; deserve focused tracking |
| `data.document` | Document/KV stores (MongoDB, DynamoDB) inform different data model decisions than relational databases |
| `data.streaming` | Event streaming (Kafka, Pulsar) is a distinct architecture decision from data analytics |
| `data.vector` | Vector databases are a rapidly evolving category critical to AI integration decisions |
| `data.governance` | Data quality, lineage, and mesh are growing decision areas with no prior coverage |
| `devex.testing` | Testing practices and tools inform quality and process decisions; previously uncovered |
| `devex.api` | API design choices (GraphQL, gRPC, OpenAPI) inform architecture and stack decisions |
| `devex.cost` | Cloud cost optimization and FinOps inform operational and stack decisions |
| `lang.java` | JVM ecosystem is a major enterprise stack with no prior coverage |
| `lang.wasm` | WebAssembly is an emerging deployment target informing architecture decisions |
| `arch.frontend` | Frontend architecture decisions (SSR, RSC, web platform) were implicit in `framework.react` |
| `arch.migration` | Migration and modernization patterns inform architecture evolution decisions |
| `regulation.standards` | Industry compliance standards (SOC2, ISO) inform operational and compliance decisions |

---

## Classifier Requirements

The new taxonomy changes what the classifier must do. This section identifies where the current keyword/regex system is sufficient and where it falls short.

### What Keyword Matching Handles Well

**Vendor-specific terms that map cleanly to new topics:**
- "Terraform", "Pulumi", "CDK" → `compute.iac` (same keyword match, different topic ID)
- "PostgreSQL", "Aurora", "MySQL" → `data.relational`
- "CVE-2026-*", "zero-day" → `security.vulnerabilities`
- "Kafka", "Pulsar", "EventBridge" → `data.streaming`

These are mechanical remappings: the keywords stay the same, only the target topic ID changes.

**Distinctive terminology:**
- "SBOM", "typosquatting", "dependency confusion" → `security.supply-chain`
- "passkey", "FIDO", "OIDC", "OAuth" → `security.identity`
- "WebAssembly", "WASI", "component model" → `lang.wasm`
- "FinOps", "cloud cost", "cost optimization" → `devex.cost`

### Where Keyword Matching Falls Short

**Conceptual topics with diffuse vocabulary:**
- `arch.migration` — "modernization", "replatforming", "monolith-to-microservices" are common but also appear in unrelated contexts. Migration stories often describe the *what* (moving to Kubernetes) without using migration-specific terms.
- `data.governance` — "data quality", "lineage", "catalog" overlap with `data.analytics`. Distinguishing governance (process) from analytics (technology) requires understanding intent, not just matching keywords.
- `arch.event-driven` — "event", "message", "queue" are too generic; distinguishing architecture discussions from product announcements requires context.

**Merged vendor topics requiring broader keyword lists:**
- `ai.foundation-models` now covers OpenAI, Anthropic, Google, Meta, and managed services (Bedrock, SageMaker). The keyword list must be comprehensive across vendors *and* must be maintained as new vendors emerge.
- `compute.cloud-platforms` absorbs 5 former AWS topics plus Azure/GCP signals. Context terms must disambiguate "cloud platform" signals from specific service signals that route elsewhere (Lambda → `compute.serverless`, not `compute.cloud-platforms`).

**Topics where classifier priority resolution matters:**
- An article about "fine-tuning Llama 3 on SageMaker" should classify as `ai.training` (the decision-relevant topic) not `ai.foundation-models` or `compute.cloud-platforms`. Priority must favor the most specific, most decision-relevant topic.
- An article about "Kafka security vulnerabilities" should classify as both `security.vulnerabilities` and `data.streaming`. Multi-topic assignment is correct here; the classifier should not force a single topic.

### Priority Guidance for the New Taxonomy

The current priority system (1-100) carries forward. New priority assignments should follow this hierarchy:

1. **Security events (70-80):** Vulnerabilities and supply-chain threats demand immediate attention
2. **AI developments (55-65):** Fast-moving domain where trends change decisions quickly
3. **Architecture and data (40-55):** Core SDLC decisions, moderate pace
4. **Languages and compute (35-45):** Stack selection, slower-moving trends
5. **Market and regulation (40-60):** Variable urgency — M&A and regulatory changes are high-priority, general earnings are lower
6. **DevEx and operations (30-40):** Important but slower-moving trends

### Classifier Evolution Path

The keyword/regex system is adequate for the v1 taxonomy migration. Known improvement paths for future work:

1. **Confidence-weighted classification** (spec 007, section I) — already specified. The new taxonomy amplifies its value: broader topics like `ai.foundation-models` will have more keyword hits per event, making confidence differentiation more important.

2. **Negative examples** — Topics like `compute.cloud-platforms` need "not Lambda, not Bedrock, not RDS" rules to prevent over-classification. The current system lacks negative matching.

3. **Hierarchical classification** — Classify domain first, then topic within domain. This would make `compute.serverless` vs `compute.cloud-platforms` disambiguation more reliable than flat keyword matching.

---

## Topic Lifecycle

### Adding a Topic

A new topic is warranted when:

1. **Signal threshold**: A technology area generates ≥10 events/month for 3 consecutive months from ≥2 independent sources
2. **Decision test**: The trend signal informs an SDLC decision that existing topics don't cover (principle P1)
3. **Independence test**: Events in the proposed topic are not >50% co-classified with an existing topic (principle P3)

**Process:**
1. Propose the topic with ID, label, decision category, and example trend signal
2. Verify it passes the decision-relevance test (P1) and granularity rules (P2)
3. Add to this spec's taxonomy table
4. Add keyword/regex definitions to `topics.yaml`
5. Run `intel db rebuild-topic-index` to reclassify historical events

### Retiring a Topic

A topic is a candidate for retirement when:

1. **Staleness**: Average <5 events/month for 3 consecutive months (below minimum viable volume)
2. **Absorption**: >50% overlap with another topic for 3 consecutive months
3. **Decision irrelevance**: The SDLC decision it informs is no longer distinct (technology was absorbed, market consolidated, etc.)

Retirement means merging into a parent or sibling topic, not deletion. Historical events are reclassified under the absorbing topic.

### Splitting a Topic

A topic should split when:

1. **Divergent lifecycle phases**: Two sub-areas within a topic show persistently different lifecycle phases (one accelerating, one decaying) for >30 days
2. **Different decision implications**: Events in the topic inform two different SDLC decisions with different actions
3. **Volume justification**: Both resulting topics would independently pass the signal threshold (≥10 events/month)

### Review Cadence

**Quarterly review** (aligned with the 90-day lifecycle window):

1. Identify topics below minimum viable volume → candidates for absorption
2. Identify topics with >50% co-classification overlap → candidates for merge
3. Identify technology areas with growing signal volume but no topic coverage → candidates for addition
4. Review false positive rates from the learning loop (spec 007, section J2) → candidates for refinement
5. Validate domain balance: no domain >30% of total topics

The review examines `intel topics audit` output (see below), learning loop weight changes, and the cross-domain chain map to identify structural changes in the topic landscape.

### Audit Command

The quarterly review requires correlating data from multiple sources (event volumes, co-classification rates, learning loop weights, chain participation, lifecycle phases). `intel topics audit` assembles this into a single structured report.

```
intel topics audit                  # full quarterly review
intel topics audit --domain ai      # single domain
intel topics audit --flagged        # only topics with review flags
intel topics audit --below-minimum  # only topics below 5 events/month
intel topics audit --overlap        # only topics with >50% co-classification
```

#### Per-Topic Metrics

| Metric | Source | Review criterion |
|---|---|---|
| Monthly volume (3-month window) | `event_topics` + `events` | Minimum viable volume — <5/month for 3 months → absorb (P3) |
| Volume trend | Month-over-month direction | Staleness detection for retirement candidates |
| Top co-classified topics + overlap % | `event_topics` self-join on `event_id` | Overlap ceiling — >50% → merge candidate (P3) |
| Learning loop weight | `topic_weights` table | False positive signal — weight trending toward 0.5 indicates poor classifier precision |
| Cross-domain chain count | Active chains where topic appears as `from_topic` or `to_topic` with a different top-level domain | Forecast chain value — topics enabling cross-domain chains earn their slot (P4) |
| Current lifecycle phase | `computeLifecycles` output | General health — persistent `stable` with low volume differs from `stable` with high volume |

#### Domain-Level Metrics

| Metric | Review criterion |
|---|---|
| Topic count per domain, % of total | Domain balance cap — >30% triggers rebalance (P6) |
| Domain-level volume (sum of topic volumes) | Coverage distribution — identifies over/under-represented areas |

#### Output

```json
{
  "tool": "intel",
  "schema_version": "v1",
  "status": "ok",
  "data": {
    "window": { "start": "2026-01-01T00:00:00Z", "end": "2026-03-21T00:00:00Z" },
    "domain_summary": [
      { "domain": "ai", "topics": 9, "pct": 15.5, "volume_90d": 1240, "flagged_topics": 0 },
      { "domain": "lang", "topics": 6, "pct": 10.3, "volume_90d": 310, "flagged_topics": 1 }
    ],
    "topics": [
      {
        "topic": "ai.foundation-models",
        "domain": "ai",
        "volume": { "month_1": 89, "month_2": 112, "month_3": 97, "trend": "stable" },
        "overlap": [
          { "topic": "ai.training", "pct": 18.2 },
          { "topic": "compute.gpu", "pct": 12.1 }
        ],
        "learning_weight": 0.82,
        "cross_domain_chains": 7,
        "phase": "stable",
        "flags": []
      },
      {
        "topic": "lang.wasm",
        "domain": "lang",
        "volume": { "month_1": 3, "month_2": 2, "month_3": 4, "trend": "flat" },
        "overlap": [
          { "topic": "compute.edge", "pct": 55.0 }
        ],
        "learning_weight": 0.61,
        "cross_domain_chains": 1,
        "phase": "stable",
        "flags": ["below_minimum_volume", "high_overlap:compute.edge"]
      }
    ]
  }
}
```

#### Flags

The `flags` array pre-computes review criteria so operators can filter to topics that need attention rather than scanning all 58:

| Flag | Condition | Lifecycle action |
|---|---|---|
| `below_minimum_volume` | <5 events/month for all 3 months in the window | Candidate for absorption into parent or sibling topic |
| `high_overlap:<topic>` | >50% co-classification with the named topic | Candidate for merge with the overlapping topic |
| `low_learning_weight` | `topic_weights.weight` < 0.65 (below neutral ~0.75) | Classifier producing false positives; refine keywords or absorb |
| `no_cross_domain_chains` | Zero cross-domain chains in 90-day window | Low forecast utility; evaluate whether standalone topic is justified (P4) |
| `domain_imbalance` | Topic's domain exceeds 30% of total topics | Domain needs rebalancing; evaluate which topics to merge or absorb |
| `multimodal_volume` | Daily volume distribution fails unimodality test (Hartigan's dip test, p < 0.05) over the 90-day window | Candidate for split — distinct event populations may inform different decisions (P2). Verify by inspecting content clusters at each mode; bursty unimodal (same content, variable intensity) is normal and not a split signal. |

The `--flagged` filter returns only topics with at least one flag, producing a focused review checklist. An empty `--flagged` result means no topics require attention this quarter.

#### Co-Classification Computation

Overlap percentage is computed from the `event_topics` table:

```sql
-- For each pair of topics (A, B), compute what fraction of A's events also have B
SELECT
  a.topic AS topic_a,
  b.topic AS topic_b,
  COUNT(*) AS shared_events,
  ROUND(100.0 * COUNT(*) / a_total.total, 1) AS overlap_pct
FROM event_topics a
JOIN event_topics b ON b.event_id = a.event_id AND b.topic != a.topic
JOIN events e ON e.event_id = a.event_id
JOIN (
  SELECT topic, COUNT(*) AS total
  FROM event_topics et2
  JOIN events e2 ON e2.event_id = et2.event_id
  WHERE e2.fetched_at >= :window_start
  GROUP BY topic
) a_total ON a_total.topic = a.topic
WHERE e.fetched_at >= :window_start
GROUP BY a.topic, b.topic
HAVING overlap_pct > 10.0
ORDER BY overlap_pct DESC;
```

Only overlaps above 10% are reported to keep the output focused. The top 5 co-classified topics per topic are included in the audit output.

### Review Tracking

The quarterly review cadence is only useful if the tool knows when the last review happened. A `tool_metadata` table stores operational timestamps so commands can warn when a review is overdue.

#### Schema

```sql
CREATE TABLE tool_metadata (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

This is a general-purpose key-value store for tool operational state — not configuration (that's `config.yaml`) and not per-event data (that's `events`). The table is intentionally minimal; only the topic review process writes to it in this spec. Future specs may add other keys.

#### Recording a Review

`intel topics audit --mark-reviewed` writes the current timestamp after a review is completed:

```sql
INSERT INTO tool_metadata (key, value, updated_at)
VALUES ('topic_review_last_completed', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at;
```

This is a deliberate manual action — running `intel topics audit` alone does not mark the review as complete. The operator runs the audit, acts on flagged topics, then marks the review done.

#### Overdue Warning

Commands that benefit from a healthy topic taxonomy — `intel trends`, `intel forecast`, `intel topics`, `intel pack` — check `topic_review_last_completed` at query time. If the value is missing or older than 90 days, the response includes a warning in the standard `warnings` array:

```json
{
  "warnings": [
    "Topic review overdue: last completed 127 days ago (2025-11-14). Run 'intel topics audit' to review topic health."
  ]
}
```

If no review has ever been recorded, the warning reads:

```json
{
  "warnings": [
    "No topic review on record. Run 'intel topics audit --mark-reviewed' after reviewing topic health."
  ]
}
```

The warning is informational — it does not block any command. Agents can check the `warnings` array programmatically and surface the reminder.

#### Why Not Automatic

The review is not marked complete automatically when `intel topics audit` runs because the audit is the *input* to the review, not the review itself. The review involves human judgment: reading the flags, deciding which topics to merge/split/add, updating `topics.yaml`, and reclassifying. `--mark-reviewed` is the operator's attestation that this work was done.

---

## Verification

- [ ] Every topic maps to at least one SDLC decision category from the decision framework table
- [ ] No orphan topics that don't inform a decision
- [ ] No domain exceeds 30% of total topics (max: ai at 15.5%)
- [ ] All 71 current topics have a defined migration path (absorption map is complete)
- [ ] New topics each have a rationale explaining what decision gap they fill
- [ ] Topic ID format follows `domain.hyphenated-name` convention consistently
- [ ] Design principles provide testable criteria (not subjective judgments) for split/merge/add/retire decisions
- [ ] Classifier requirements identify specific gaps, not generic "needs improvement" statements
- [ ] `intel topics audit` output includes all metrics needed for the quarterly review (volume, overlap, learning weight, chain participation, flags)
- [ ] `intel topics audit --mark-reviewed` records the review timestamp; `intel trends` and `intel forecast` warn when >90 days overdue

---

## Decision Summary

| Decision | Selected | Rationale |
|---|---|---|
| Organize by decision-relevance | 9 domains mapped to SDLC decisions | Vendor-organized topics fragment decision-relevant signals and create granularity mismatches |
| 58 topics (down from 71) | Reduction via vendor merging, expansion via decision gaps | Every topic passes decision-relevance test; removed topics were redundant vendor splits |
| Absorb individual AI vendor topics | Single `ai.foundation-models` | OpenAI/Anthropic/Google/Meta all inform the same "which model?" decision |
| Absorb AWS service topics into domain topics | 16 AWS topics → distributed across 7 domain topics | AWS Lambda informs serverless decisions, not "AWS" decisions; DynamoDB informs document DB decisions |
| Hyphenated topic IDs | `domain.hyphenated-name` | More readable and URL-friendly than underscores; establishes forward convention |
| oss.release as content type, not topic | Absorbed into relevant domain topics | "Release" describes content type (announcement), not a decision category; React release → `arch.frontend` |
| Quarterly review cadence | Aligned with 90-day lifecycle window | Matches the longest lifecycle analysis window; frequent enough to catch landscape shifts |
| Minimum 5 events/month threshold | 3-month sustained minimum for topic viability | Below this, lifecycle classification and chain detection have insufficient statistical support |
| Domain balance cap at 30% | Hard constraint on taxonomy design | Prevents single-vendor or single-area bias from distorting coverage |
| Strategy spec, not implementation spec | Topic IDs and labels only; keywords stay in topics.yaml | Separates "what to classify" (this spec) from "how to classify" (topics.yaml + classifier code) |
| `intel topics audit` command | Pre-computed flags over per-topic metrics | Quarterly review requires correlating 5 data sources; a dedicated command makes the review actionable instead of manual |
| Review tracking via `tool_metadata` | `--mark-reviewed` writes timestamp; query commands warn when overdue | Review cadence is only useful if the tool enforces it; manual mark avoids false "reviewed" state from running audit without acting |
