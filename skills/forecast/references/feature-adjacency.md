# Feature Adjacency Reference

Dense reference table for reasoning about what features are likely next based on observed development patterns. See the main [SKILL.md](../SKILL.md) for the workflow.

## Feature Adjacency Reasoning Table

| Observed pattern | Likely next |
|---|---|
| Active feature branches not yet merged | Direct feature signal — the roadmap in code (highest confidence) |
| New database migrations creating tables | CRUD endpoints, API, then UI for the new entities |
| Schema field additions to existing entities | Feature enrichment using those fields in the UI |
| Test factory additions for new entities | Team is committed to shipping the feature (high confidence) |
| Export features (CSV, PDF, data transforms) | Reporting features (aggregates, charts, dashboards) |
| CRUD operations for new entities | Search, filter, and sort capabilities |
| Data model additions | API endpoints exposing the data |
| Authentication/authorization scaffolding | User management, roles, permissions UI |
| Test file additions in a cluster | Committed feature work (the team is investing) |
| Configuration/settings additions | Feature flags, admin controls |
| Event/webhook infrastructure | Notification and integration features |
| Migration file recreation/renumbering | Schema stabilization before ship — feature is close to merge |
| Multiple "review cleaning" commits | Code review in progress — approaching merge |
| Idempotency key additions | Offline mode or distributed operation hardening |
| CORS configuration changes | Deployment environment changes (new domains, staging environments) |
| Test coverage push (many test-only commits) | CI pipeline enforcement or pre-release quality gate |
| Service decomposed into sub-modules (lock, utils, payloads) | Feature maturing toward production — expect monitoring/alerting additions next |
| P0/security fix branches alongside feature branches | Hardening phase — team is stabilizing before or during feature rollout |
| Hub/infrastructure changes (CORS, server.ts, env config) | Deployment environment shift (new domains, staging, or architecture change) |
| Multiple clusters with same domain keyword in added_paths | Coordinated multi-sprint initiative — treat as single feature for trajectory |
