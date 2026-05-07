# eks-pulumi

Minimal Pulumi (TypeScript) bootstrap for an Amazon EKS cluster, split into 3 sibling stacks to break the bootstrap chicken-and-egg between a private EKS endpoint and the Client VPN that the same Pulumi run is provisioning. Creates only the AWS infrastructure required to run ArgoCD; ArgoCD then manages the rest via the sister GitOps repo [`eks-argo-bootstrap`](https://github.com/slikk66/eks-argo-bootstrap).

**Cattle, not pets.** One command up, one command down — with one documented mid-flow operator pause to connect the VPN. No multi-run convergence. No orphaned ENIs / LBs / finalizers.

## Tenets

- **Pulumi owns AWS, ArgoCD owns the cluster.** Pulumi installs ArgoCD; everything else (cert-manager, Karpenter, AWS LB Controller, External Secrets, observability) is GitOps via the sister repo.
- **Cattle, with one documented pause.** `make up` and `make down` work cleanly every time. The single mid-flow stop is the operator-driven VPN connect between `up-network` and `up-cluster` — see [Architecture rationale](#architecture-rationale) for why this is structurally necessary.
- **Self-contained.** Repo bootstraps its own Pulumi state bucket. One AWS admin account is the only credential needed.
- **Zero leakage.** Account IDs, role ARNs, hostnames live in gitignored config. Repo is safe to publish.
- **Latest stable.** EKS 1.35 (~3 months in EKS as of May 2026; greenfield Bottlerocket dodges the 1.35 deprecations).
- **No pinned addon versions.** Pulumi queries the EKS API per `kubernetesVersion` and uses AWS's recommended default — versions stay aligned to the cluster automatically.
- **Cross-stack glue is `StackReference` only.** No TypeScript `import` ever crosses a stack boundary; outputs flow `network → cluster → gitops` via typed wrappers.

## What this repo creates

Split per stack:

| Stack | Resources |
|---|---|
| `infra/network` (`eks-pulumi-network`) | VPC (configurable AZ count, default 3, public + private subnets), S3 gateway endpoint, optional multi-AZ NAT, AWS Client VPN endpoint with mTLS + Pulumi-generated PKI + ACM-uploaded server cert (single-CA pattern), optional VPN HA |
| `infra/cluster` (`eks-pulumi-cluster`) | EKS 1.35 (private endpoint), OIDC provider, access entries (admin + Karpenter `EC2_LINUX`), managed addons (vpc-cni, kube-proxy, coredns, eks-pod-identity-agent), 1× 2-node Bottlerocket managed group (m7a.large, `CriticalAddonsOnly` taint), Pod Identity for Karpenter, IRSA for ALB Controller / EBS-CSI / EFS-CSI / VPC-CNI / External Secrets / Fluent Bit, Karpenter prereqs (SQS interruption queue, EventBridge rules, controller + node IAM) |
| `infra/gitops` (`eks-pulumi-gitops`) | ArgoCD Helm release, GitOps-Bridge cluster `Secret` (13 annotations sourced from cluster stack outputs), root `Application` CR pointing at the sister GitOps repo |

## What this repo does NOT install

In-cluster software is the GitOps repo's job:

cert-manager, AWS Load Balancer Controller, Karpenter chart + NodePool + EC2NodeClass, External Secrets Operator, EBS/EFS CSI, metrics-server, ADOT, Fluent Bit, ArgoCD self-management, application workloads.

See [`eks-argo-bootstrap`](https://github.com/slikk66/eks-argo-bootstrap).

## Prerequisites

- AWS account with admin credentials (single account)
- AWS CLI v2 configured (profile + region)
- Pulumi CLI ≥ 3.61 (required for project-scoped DIY backend)
- Node.js 22+, pnpm 9+ (`corepack enable && corepack prepare pnpm@latest --activate`)
- OpenVPN client (Tunnelblick on macOS, `openvpn` on Linux)
- A Git repo to point ArgoCD at (the public `eks-argo-bootstrap` template, or a fork)

## Quick start

```bash
# 1. One-time per AWS account: create the Pulumi state bucket
make bootstrap-state-bucket

# 2. Local config
cp .env.example .env
$EDITOR .env                                       # AWS_PROFILE, region overrides
make login

# 3. Stack configs (one per project)
cp infra/network/Pulumi.main.yaml.example infra/network/Pulumi.main.yaml
cp infra/cluster/Pulumi.main.yaml.example infra/cluster/Pulumi.main.yaml
cp infra/gitops/Pulumi.main.yaml.example  infra/gitops/Pulumi.main.yaml
$EDITOR infra/network/Pulumi.main.yaml             # vpcCidr, enableNat, clientVpnCidr
$EDITOR infra/cluster/Pulumi.main.yaml             # adminRoleArn (full SSO ARN with path)
$EDITOR infra/gitops/Pulumi.main.yaml              # argoBootstrapRepoUrl

# 4. Stand up — EXPECT a mid-flow pause.
#    `make up` brings up the network stack, writes ./client.ovpn,
#    then prompts you to connect your OpenVPN client and press enter.
#    Cluster + gitops then run over the VPN.
#    Assumes an interactive terminal — the read prompt blocks indefinitely
#    otherwise (CI / unattended use is not supported on purpose).
make up

# 5. Get on the cluster
make kubeconfig                                    # writes ~/.kube/eks-pulumi-cluster-main
export KUBECONFIG=~/.kube/eks-pulumi-cluster-main
kubectl get nodes
kubectl get applications -n argocd                 # root-app + GitOps children
```

## Configuration

Stack name stays `main` across all three projects — this is a base, not an environment.

`infra/network/Pulumi.main.yaml`:

```yaml
config:
  aws:region: us-west-2
  eks-pulumi-network:vpcCidr: "10.50.0.0/16"
  eks-pulumi-network:enableNat: false                 # see Networking modes
  # eks-pulumi-network:azCount: 3                     # AZ count, [2,6]; us-west-1 needs 2
  eks-pulumi-network:clientVpnCidr: "10.100.0.0/22"   # client IP pool, must not overlap vpcCidr
  # eks-pulumi-network:vpnHighAvailability: false     # true = one assoc per private subnet (~$72/mo per extra AZ)
```

`infra/cluster/Pulumi.main.yaml`:

```yaml
config:
  aws:region: us-west-2
  eks-pulumi-cluster:kubernetesVersion: "1.35"
  # Full IAM ARN including path — SSO roles include
  # /aws-reserved/sso.amazonaws.com/<region>/... ; keep it, do NOT strip.
  # EKS rejects path-less ARNs at access-entry create.
  eks-pulumi-cluster:adminRoleArn: "arn:aws:iam::<ACCOUNT_ID>:role/<YOUR_ADMIN_ROLE>"
  # External Secrets IRSA — opt-in allow-list of Secrets Manager ARNs.
  # When omitted/empty, the role is scoped to `secret:<project>-<stack>-*` only.
  # eks-pulumi-cluster:externalSecretsAllowedSecretArns:
  #   - "arn:aws:secretsmanager:us-west-2:<ACCOUNT_ID>:secret:my-app-*"
```

`infra/gitops/Pulumi.main.yaml`:

```yaml
config:
  eks-pulumi-gitops:argoBootstrapRepoUrl: "https://github.com/<your-org>/eks-argo-bootstrap.git"
  eks-pulumi-gitops:argoBootstrapRepoRevision: "HEAD"
  eks-pulumi-gitops:argoBootstrapRepoPath: "bootstrap"
```

## Networking modes

| Mode | Worker placement | Outbound | Extra cost | When |
|---|---|---|---:|---|
| `enableNat: false` (default) | Public subnets, public IPs, locked-down SG | Direct | $0 | Learning, dev, cost-sensitive |
| `enableNat: true` | Private subnets | Multi-AZ NAT (one per AZ) | ~$98/mo + data | Anything resembling prod |

Default-off is safe: SGs deny all inbound except node-to-node and cluster-API; no NodePort services; cluster API itself is VPN-only. Public IPs on workers are not a vulnerability when the SG is correct.

No single-AZ NAT option — losing one AZ would kill all egress; not worth the savings.

**AZ count** is configurable via `azCount` (range `[2, 6]`, default `3`). Regions with fewer AZs (e.g. us-west-1: 2) require explicit `azCount: 2`; otherwise a pre-flight guard fails fast with `Region X has only N AZ(s); azCount=K requested`. CIDRs are derived deterministically from `vpcCidr` (each subnet a `/20`), so re-runs at the same `azCount` produce no diff churn. NAT gateway count tracks `azCount` when `enableNat=true`. EKS minimum 2 AZs is enforced; cap at 6 leaves CIDR headroom (a `/16` yields 16 `/20` slots; `2 × azCount` are used).

The cluster stack does not consume `enableNat` directly — the network stack computes `workerSubnetIds` (private when NAT is on, public otherwise) and exports it; cluster reads `workerSubnetIds`. Cluster stays oblivious to NAT.

## State backend

Pulumi DIY backend on S3, **single bucket reused across all 3 projects** with project-scoped state isolation (Pulumi ≥ 3.61):

```
s3://eks-pulumi-state-<account-id>-us-west-2?region=us-west-2&awssdk=v2
```

Pulumi's project-scoped layout writes each project's state under `<bucket>/<project-name>/...`, so `eks-pulumi-network`, `eks-pulumi-cluster`, and `eks-pulumi-gitops` share the bucket without colliding.

- Versioning, SSE-S3, public-access-block, 90-day lifecycle on old versions
- Native S3 locking (`PULUMI_SELF_MANAGED_STATE_LOCKING=1`); no DynamoDB
- Empty passphrase (`PULUMI_CONFIG_PASSPHRASE=""`)
- Bucket name auto-derived from `aws sts get-caller-identity`; override via `.env`
- Backend URL lives in `.env` (gitignored), not any `Pulumi.yaml` — keeps account ID out of the public repo

## GitOps Bridge

The public `eks-argo-bootstrap` repo contains zero account-specific values. All ARNs, account IDs, region, cluster name, OIDC issuer URL, and queue names live as **annotations on a cluster `Secret`** that the gitops stack plants in the `argocd` namespace. ApplicationSets in the GitOps repo template these into Helm values via `{{ metadata.annotations.<key> }}`. The gitops stack reads cluster outputs via `StackReference`, so the annotations stay in sync with whatever the cluster stack last produced.

Pattern: <https://github.com/gitops-bridge-dev/gitops-bridge>

This is what makes the GitOps repo publishable — it's a generic template; the cluster-specific values are injected at runtime by Pulumi.

## Teardown

```bash
make down                                          # one-shot
```

Reverse of `make up`:

1. `make down-gitops` — runs `infra/gitops/scripts/pre-destroy.sh` first (cascade-delete root-app, drain Ingresses + LoadBalancer Services + Karpenter NodeClaims, settle 30s), then `pulumi destroy` with `PULUMI_K8S_DELETE_UNREACHABLE=true` exported. The env var lets destroy complete even if the cluster API is already gone (e.g. cluster destroyed first, VPN down) — see [pulumi-kubernetes #2517](https://github.com/pulumi/pulumi-kubernetes/issues/2517) and [#2311](https://github.com/pulumi/pulumi-kubernetes/issues/2311).
2. `make down-cluster` — `pulumi destroy` against `infra/cluster/`.
3. `make down-network` — `pulumi destroy` against `infra/network/`.
4. `scripts/nuke-orphan-enis.sh` — backstop sweep for ENIs left in `available` state (VPC CNI / ALB Controller occasionally leak when in-cluster controllers tear down before dependents).

`make down` is safe to re-run after a partial failure — the gitops env var handles the cluster-gone case, and the ENI sweep is idempotent.

## Repo structure

```
eks-pulumi/
  README.md
  Makefile                                         # bootstrap-state-bucket, login, up, down,
                                                   # per-stack targets, kubeconfig, vpn-config
  .env.example                                     # committed
  .gitignore
  package.json                                     # workspace root
  pnpm-workspace.yaml                              # lists infra/network, infra/cluster, infra/gitops
  pnpm-lock.yaml                                   # workspace lockfile
  scripts/
    bootstrap-state-bucket.sh                      # idempotent
    nuke-orphan-enis.sh                            # tail sweep, runs after down-network
  infra/
    network/                                       # eks-pulumi-network
      Pulumi.yaml
      Pulumi.main.yaml.example
      package.json
      pulumi.config.ts                             # typed config
      tsconfig.json
      index.ts                                     # composition + exports
      src/
        vpc.ts
        vpn.ts
    cluster/                                       # eks-pulumi-cluster
      Pulumi.yaml
      Pulumi.main.yaml.example
      package.json
      pulumi.config.ts
      tsconfig.json
      index.ts
      src/
        cluster.ts
        iam.ts
        karpenter-aws.ts
        nodegroup.ts
        stack-references.ts                        # typed wrapper around network outputs
    gitops/                                        # eks-pulumi-gitops
      Pulumi.yaml
      Pulumi.main.yaml.example
      package.json
      pulumi.config.ts
      tsconfig.json
      index.ts
      src/
        argocd.ts
        stack-references.ts                        # typed wrapper around cluster outputs
      scripts/
        pre-destroy.sh                             # cascade root-app, drain LBs/NodeClaims, settle 30s
```

## Approximate cost (us-west-2, May 2026)

| Item | Default (NAT off) | NAT on |
|---|---:|---:|
| EKS control plane | ~$73/mo | ~$73/mo |
| 2× m7a.large nodes | ~$133/mo | ~$133/mo |
| AWS Client VPN (1 subnet assoc, 1 always-on connection) | ~$110/mo | ~$110/mo |
| NAT gateways (default 3 AZ; scales with `azCount`: 2 → ~$66/mo, 6 → ~$196/mo + data) | $0 | ~$98/mo + data |
| S3 state, EIPs, misc | <$5/mo | <$5/mo |
| **Baseline** | **~$321/mo** | **~$419/mo** |
| VPN HA (`vpnHighAvailability: true`, +`azCount-1` subnet assocs at ~$72/mo each) | +~$144/mo | +~$144/mo |

Add the GitOps stack (AMP, AMG, CloudWatch Logs, ALB) on top.

For a learning cluster: `make down` after each session brings cost to ~$0/mo (S3 state only).

## Upgrade path

- **Kubernetes version:** bump `kubernetesVersion` in `infra/cluster/Pulumi.main.yaml` once a new minor has been in EKS for 3+ months. Managed addons re-resolve to AWS-recommended defaults on the next `pulumi up` automatically — no separate version bumps in this repo.
- **`@pulumi/aws` major bumps:** read release notes; resource-shape diffs are usually cosmetic but a `pulumi preview` first is cheap.
- **Karpenter chart, AWS LB Controller, etc.:** version-pinned in `eks-argo-bootstrap`, not here.

## Architecture rationale

### The chicken-and-egg problem

A naive single-Pulumi-project bootstrap fails because the EKS API endpoint is private (cluster runs in private subnets, no public-IP allowlist), and the only path in is the Client VPN — which the same Pulumi run is provisioning. The Kubernetes provider needs the API endpoint to install ArgoCD, but it cannot reach it from the laptop running `pulumi up` because (a) the `.ovpn` isn't generated yet, and (b) even once it is, the operator cannot connect inside an unattended `pulumi up` invocation.

Pulumi cannot break this on its own — `StackReference` is the canonical Pulumi escape hatch for cross-cycle dependencies (one stack's outputs feed another's inputs in the next `preview` / `up`). Cited sources:

- [Pulumi — Stacks (StackReference)](https://www.pulumi.com/docs/iac/concepts/stacks/#stackreferences) — official documentation of the cross-stack reference primitive.
- [pulumi/pulumi-eks #1134](https://github.com/pulumi/pulumi-eks/issues/1134) — same root cause discussed in the Pulumi EKS provider; consensus is "split the stack."
- [OneUptime — Pulumi Stack References for Resource Sharing](https://oneuptime.com/blog/post/2024-08-25-pulumi-stack-references) — canonical multi-stack tutorial cited by Pulumi org docs.
- [terraform-aws-modules/terraform-aws-eks #1841](https://github.com/terraform-aws-modules/terraform-aws-eks/issues/1841), [#2467](https://github.com/terraform-aws-modules/terraform-aws-eks/issues/2467), [#2969](https://github.com/terraform-aws-modules/terraform-aws-eks/issues/2969) — same problem in the Terraform ecosystem; same solution (multi-stack / multi-state).
- [AWS — Configure cluster endpoint access](https://docs.aws.amazon.com/eks/latest/userguide/cluster-endpoint.html) — confirms private-only endpoints are not reachable from outside the VPC absent a VPN, peering, or IP-allowlisted public endpoint.
- [pulumi/pulumi-kubernetes #2517](https://github.com/pulumi/pulumi-kubernetes/issues/2517) and [#2311](https://github.com/pulumi/pulumi-kubernetes/issues/2311) — the cluster-gone teardown path, fixed via `PULUMI_K8S_DELETE_UNREACHABLE=true`.

### Why three stacks (not two)

Splitting cleanly along *cycle boundaries*:

- **`infra/network/`** — pure AWS, no k8s API consumer. Outputs the `.ovpn`.
- **`infra/cluster/`** — pure AWS, no k8s API consumer. Outputs the kubeconfig.
- **`infra/gitops/`** — first stack with a `k8s.Provider`. Requires the operator to be on the VPN.

The `network → cluster → gitops` data flow is one-directional via typed `StackReference` wrappers (no TypeScript `import` ever crosses a stack boundary). Each stack independently `pulumi preview`-able, `pulumi up`-able, and `pulumi destroy`-able. The 3-stack split also gives the gitops layer (which iterates more rapidly than network/cluster) its own state file and blast radius, matching Pulumi's own guidance on splitting projects by deployment cadence.

`vpc-cni` is installed as part of the cluster stack and runs before the managed nodegroup. Without that ordering, nodes boot without CNI and the nodegroup never reaches `ACTIVE`. This is now a structural decision codified in the cluster stack, not a discovered runtime constraint.

## Migration path

For operators upgrading from the legacy single-stack monolithic `infra/` layout to the 3-stack layout.

### Option A — clean redeploy (recommended for non-prod)

1. `make down` against the legacy single-stack (if you still have it). After this slice merges, the legacy stack is gone from the repo; restore it from git history if needed (`git log -- infra/index.ts`).
2. Pull the new layout (`git pull`).
3. Run the [Quick start](#quick-start) above. Project names change (`eks-pulumi` → `eks-pulumi-network` / `-cluster` / `-gitops`), so resource URN prefixes change. Pulumi creates new resources; AWS-side resource names are preserved verbatim where they were explicit (IAM roles, addons, Karpenter resources) so audit history is mostly continuous.

### Option B — `pulumi import` per resource (recommended for live clusters)

For each resource in the legacy stack, run `pulumi import` against the new project that owns it:

- VPC, subnets, route tables, IGW, NAT, S3 endpoint, Client VPN endpoint + assoc + auth + route + ACM cert → import into `infra/network/`.
- EKS cluster, OIDC provider, IAM roles, EKS addons, managed nodegroup, Karpenter SQS + EventBridge + IAM, access entries → import into `infra/cluster/`.
- argocd namespace, Helm release, cluster `Secret`, root `Application` CR → import into `infra/gitops/`.

Then either `pulumi stack rm` the legacy stack after confirming all resources have been imported, or run `pulumi destroy` against it with the imported resource IDs already absent from its state — Pulumi destroys nothing because the resources have moved.

Option A is cleaner; Option B preserves running workloads.

## Trade-off vs single-stack-public-allowlist

### Alternative considered: single stack, public endpoint with IP allowlist

Keep the monolithic `infra/` Pulumi project. Make the EKS endpoint public-with-IP-allowlist (set the operator laptop's egress IP in the allowlist). The k8s provider can reach the endpoint from within the same `pulumi up` run, and the Client VPN is provisioned in the same run as a normal AWS resource (no cycle).

Why we rejected it:

- Public endpoint, even allowlisted, is a larger attack surface and the allowlist requires updating every time the operator's IP changes (residential ISPs, coffee shops, etc.).
- "Flip private after bootstrap" is a manual procedure that drifts from declarative IaC.
- Pulumi's own docs explicitly recommend separate projects for components that deploy at different cadences. Network + cluster change rarely; gitops iterates rapidly.
- This repo doubles as a reference architecture; the architecturally correct answer (split state along cycle boundaries) is the one to demonstrate publicly.

The cost / convenience trade-off (single-stack would be one fewer mental step) is real but small; the 3-stack architecture is what makes `make up` deterministic across all networking modes (private-only OR public-allowlist) without an in-band workaround.

## License

MIT
