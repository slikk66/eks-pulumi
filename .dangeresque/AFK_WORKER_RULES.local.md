<!-- Project-specific additions to AFK_WORKER_RULES.md — never overwritten by dangeresque init. -->

# eks-pulumi worker rules

## Sanity check (every IMPLEMENT — INVESTIGATE was skipped by user sign-off)

Before writing code, the worker MUST:

1. Read `README.md` end-to-end (architecture and tenets are ground truth)
2. Read `infra/pulumi.config.ts` (typed config — use these exported names exactly; do not invent new ones)
3. Read `infra/Pulumi.main.yaml.example` (config keys + example values)
4. Read every `infra/src/*.ts` file referenced as a dependency in the issue (their exports define the shape your code must consume)
5. If `infra/node_modules/` is missing: run `cd infra && pnpm install`
6. Run `cd infra && npx tsc --noEmit` and confirm clean baseline (exit 0) BEFORE making changes

If any of these fail or contradict the issue body — STOP and report. Do not invent. Do not guess at types.

## Locked architectural decisions (do NOT relitigate)

These were researched and confirmed against May 2026 AWS / Pulumi docs:

- **Use raw `aws.eks.*` resources**, NOT the `@pulumi/eks` v4 high-level wrapper. The wrapper bundles defaults that fight our minimal-bootstrap pattern.
- **OIDC provider is mandatory.** ALB Controller, EBS-CSI, EFS-CSI, and VPC-CNI all require IRSA in May 2026.
- **Karpenter uses Pod Identity** (chart v1.12+ supports it). ALB Controller + CSI drivers use IRSA.
- **Karpenter `EC2_LINUX` access entry has NO `AccessPolicyAssociation`** — AWS forbids policy associations on non-`STANDARD` types. The bare `AccessEntry` with `type: "EC2_LINUX"` implicitly grants `system:nodes`.
- **Client VPN single-CA pattern:** server cert in ACM is reused as `rootCertificateChainArn` (saves a resource).
- **EKS addon `resolveConflictsOnCreate / resolveConflictsOnUpdate: "OVERWRITE"`** on every addon (cattle infra; Pulumi is source of truth).
- **Public subnet workers** when `enableNat=false` rely on `mapPublicIpOnLaunch: true` on the subnet (AWS docs requirement for managed node group public placement, since 2020-04-22).
- **Pulumi DIY S3 backend, project-scoped layout** (Pulumi ≥ 3.61). `awssdk=v2` in URL.

## API guidance

- Pulumi resources go in `infra/src/<area>.ts`. Each file exports the resources/values that other files depend on. Wiring happens in `infra/index.ts`.
- All Pulumi outputs flow via `pulumi.Output.apply` — never string-interpolate outputs.
- Use `aws.getAvailabilityZonesOutput()` for dynamic AZ enumeration; do not hard-code AZ names.
- For naming, use the `prefix` exported from `pulumi.config.ts` (`<project>-<stack>`). Cluster name uses `clusterName` from same.
- Cite AWS or Pulumi doc URL in code comments for any non-obvious resource argument or IAM policy statement (one-line link comment is fine).

## Scope discipline

Each issue declares a single primary file (or tight pair). Do NOT modify files outside the issue's scope. If a sibling file (e.g. `pulumi.config.ts`) needs a new config key, declare it as an `extension` and justify in the run report. The opportunistic budget is set to 0 in `config.json` — there is no drive-by budget on this project.

`infra/index.ts` is mutable by EVERY src/ issue (each file's exports get wired in). Treat additions to `index.ts` as `extension`, not opportunistic.

## Verification

- `tsc --noEmit` MUST pass at end of run (verify hook enforces this; the worker should run it before declaring done).
- `pulumi preview` is NOT required (worker won't have AWS creds AFK). Worker may attempt it if creds present; if it fails on missing creds, that's expected — note in run report.
- A `run report` MUST list each AWS resource type added with a one-line "why."

## Sanitization (this repo is PUBLIC)

Issue bodies, run reports, code comments, and any artifact you produce are visible to the world. NEVER write:

- Real AWS account IDs → use `<ACCOUNT_ID>` or `123456789012`
- Real role / user / policy ARNs → use `arn:aws:iam::<ACCOUNT_ID>:role/<NAME>` placeholders
- Real domain names → use `example.com` or `<DOMAIN>`
- Real VPC / subnet / SG IDs → use `vpc-xxxx`, `subnet-xxxx`, `sg-xxxx`
- Real Pulumi stack outputs containing identifiers (paste-by-reference: "redacted: account ID")
- Real GitHub App IDs / installation IDs
- Local filesystem paths outside the repo (e.g., `/Users/...`, `~/.aws/...`)

If you encounter a real value while working (test output, environment vars, etc.), abstract before quoting in the run report.

Code in `infra/src/*.ts` MUST source identifiers from `pulumi.config.ts` (typed config) or Pulumi resource outputs (e.g., `cluster.identities[0].oidcs[0].issuer`). Never hardcode account IDs, ARNs, or domain names. The user-filled `Pulumi.main.yaml` is gitignored; only `Pulumi.main.yaml.example` (placeholders) is committed.
