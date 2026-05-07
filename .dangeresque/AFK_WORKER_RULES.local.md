<!-- Project-specific additions to AFK_WORKER_RULES.md — never overwritten by dangeresque init. -->

# eks-pulumi worker rules

## File layout (3 sibling Pulumi projects under `infra/`)

```
infra/
  network/         # eks-pulumi-network — VPC + Client VPN; pure AWS, no k8s deps
  cluster/         # eks-pulumi-cluster — EKS + IAM + addons + nodegroup + Karpenter AWS-side
  gitops/          # eks-pulumi-gitops  — k8s.Provider; ArgoCD + Bridge Secret + root App
```

Each project is self-contained: own `Pulumi.yaml`, `package.json`, `pulumi.config.ts`, `index.ts`, `src/*.ts`, `tsconfig.json`. The repo-root `pnpm-workspace.yaml` lists all three. The repo-root `package.json` is the workspace root only — do NOT add Pulumi dependencies there.

The pre-destroy script lives at `infra/gitops/scripts/pre-destroy.sh` (NOT `scripts/`) and is invoked by the `down-gitops` Makefile target before `pulumi destroy`. The repo-root `scripts/nuke-orphan-enis.sh` is the tail sweep run after `down-network` (top-level `make down`).

## Inter-stack import rule

**No TypeScript `import` across stack boundaries, ever.** Cross-stack data flow is `StackReference` only:

- `infra/cluster/src/stack-references.ts` reads from `organization/eks-pulumi-network/<stack>` (typed wrappers; never `Output<any>`).
- `infra/gitops/src/stack-references.ts` reads from `organization/eks-pulumi-cluster/<stack>` (same pattern).

If your issue tells you to import a value from another stack, use `pulumi.StackReference` and add a typed getter to the consuming project's `stack-references.ts`. If a needed output is missing from the upstream stack, that is a slice scope problem — STOP and report; do not edit a sibling project's source to add the export.

## Cycle-break notes (codified, no longer discoveries)

These were debugged in slices 1-3 of #22 and are now structural decisions:

- **`vpc-cni` installs before the managed nodegroup** (cluster stack). Without this, nodes boot without CNI and the nodegroup never reaches `ACTIVE`. Codified — do not rewire.
- **EKS API endpoint is private-only.** The operator MUST be on the Client VPN before `up-gitops`. The top-level `make up` writes `./client.ovpn` after `up-network` and pauses with a `read -p` prompt; `up-cluster` and `up-gitops` run after the operator presses enter. Assumes an interactive terminal — CI / unattended use is not supported.
- **The cluster stack does not consume `enableNat` directly.** The network stack computes `workerSubnetIds` (private when NAT is on, public otherwise) and exports it; cluster reads `workerSubnetIds`. The cluster stack stays oblivious to NAT.
- **`PULUMI_K8S_DELETE_UNREACHABLE=true` is set inside the `down-gitops` Makefile target.** This lets `pulumi destroy` complete even if the cluster API is already gone (cluster destroyed first, VPN down, etc.). Do not relitigate.

## Sanity check (every IMPLEMENT)

Before writing code, the worker MUST:

1. Read `README.md` end-to-end (architecture rationale + tenets are ground truth).
2. Identify which of the three projects the issue scopes you to (`network/`, `cluster/`, or `gitops/`). If unclear, STOP.
3. Read that project's `pulumi.config.ts` (typed config — use exported names exactly).
4. Read that project's `Pulumi.main.yaml.example` (config keys + example values).
5. Read every `src/*.ts` file in the same project that the issue cites as a dependency. **Do NOT read other projects' src files** unless the issue explicitly tells you to consume one of their stack outputs (in which case use a `StackReference` getter).
6. If `node_modules/` is missing in the target project: run `pnpm install` from the repo root (workspace install).
7. Run `cd infra/<project> && pnpm exec tsc --noEmit` and confirm clean baseline (exit 0) BEFORE making changes.

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
- **Pulumi DIY S3 backend, project-scoped layout** (Pulumi ≥ 3.61). `awssdk=v2` in URL. **Single bucket reused across all 3 projects** — Pulumi's project-scoped state layout isolates them automatically.
- **Three sibling Pulumi projects under `infra/`.** The chicken-and-egg between EKS-private-endpoint and k8s-provider-bootstrap is broken by splitting along cycle boundaries (see README "Architecture rationale" for cited sources).

## API guidance

- Pulumi resources go in `infra/<project>/src/<area>.ts`. Each file exports values that other files in the SAME project depend on. Wiring happens in `infra/<project>/index.ts`.
- All Pulumi outputs flow via `pulumi.Output.apply` — never string-interpolate outputs.
- Use `aws.getAvailabilityZonesOutput()` for dynamic AZ enumeration; do not hard-code AZ names.
- For naming, use the `prefix` exported from each project's `pulumi.config.ts` (`<project-name>-<stack>`). Cluster name uses `clusterName` from `infra/cluster/pulumi.config.ts`.
- Cite AWS or Pulumi doc URL in code comments for any non-obvious resource argument or IAM policy statement (one-line link comment is fine).

## Scope discipline

Each issue declares a single primary file (or tight pair) within ONE project. Do NOT modify files in other projects. Cross-project data flow is `StackReference` only. The opportunistic budget is set to 0 in `config.json` — there is no drive-by budget on this project.

`infra/<project>/index.ts` is mutable when the issue's scope is in that project (each src/ file's exports get wired in). Treat additions to that project's `index.ts` as `extension`, not opportunistic.

## Verification

- `pnpm exec tsc --noEmit` MUST pass at end of run, in the project the issue scopes you to. The verify hook enforces this.
- `pulumi preview` is NOT required (worker won't have AWS creds AFK). Worker may attempt it if creds present; if it fails on missing creds, that's expected — note in run report.
- A run report MUST list each AWS or k8s resource type added with a one-line "why."

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

Code in `infra/<project>/src/*.ts` MUST source identifiers from `pulumi.config.ts` (typed config), Pulumi resource outputs (e.g., `cluster.identities[0].oidcs[0].issuer`), OR a typed `stack-references.ts` getter. Never hardcode account IDs, ARNs, or domain names. The user-filled `Pulumi.main.yaml` is gitignored; only `Pulumi.main.yaml.example` (placeholders) is committed.
