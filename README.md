# eks-pulumi

Minimal Pulumi (TypeScript) bootstrap for an Amazon EKS cluster. Creates only the AWS infrastructure required to run ArgoCD; ArgoCD then manages the rest via the sister GitOps repo [`eks-argo-bootstrap`](https://github.com/slikk66/eks-argo-bootstrap).

**Cattle, not pets.** One command up, one command down. No multi-run convergence. No orphaned ENIs / LBs / finalizers.

## Tenets

- **Pulumi owns AWS, ArgoCD owns the cluster.** Pulumi installs ArgoCD; everything else (cert-manager, Karpenter, AWS LB Controller, External Secrets, observability) is GitOps via the sister repo.
- **Cattle.** `make up` and `make down` work cleanly every time. No manual finalizer patching.
- **Self-contained.** Repo bootstraps its own Pulumi state bucket. One AWS admin account is the only credential needed.
- **Zero leakage.** Account IDs, role ARNs, hostnames live in gitignored config. Repo is safe to publish.
- **Latest stable.** EKS 1.35 (~3 months in EKS as of May 2026; greenfield Bottlerocket dodges the 1.35 deprecations).
- **No pinned addon versions.** Pulumi queries the EKS API per `kubernetesVersion` and uses AWS's recommended default — versions stay aligned to the cluster automatically.

## What this repo creates

| Layer | Resource |
|---|---|
| Networking | VPC (configurable AZ count, default 3, public + private subnets), S3 gateway endpoint, optional multi-AZ NAT |
| Cluster | EKS 1.35, private endpoint, OIDC, access entries (admin + EC2_LINUX) |
| Addons (managed, auto-versioned) | vpc-cni, kube-proxy, coredns, eks-pod-identity-agent |
| Compute | One 2-node Bottlerocket managed group (m7a.large, `CriticalAddonsOnly` taint) — hosts ArgoCD + Karpenter controller only |
| IAM | Pod Identity / IRSA roles for Karpenter, AWS LB Controller, External Secrets, Fluent Bit |
| Karpenter prereqs | SQS interruption queue, EventBridge rules, controller + node IAM (Karpenter v1 creates instance profiles dynamically) |
| Remote access | AWS Client VPN, mTLS, Pulumi-generated PKI, ACM-uploaded |
| GitOps seed | ArgoCD Helm chart, GitOps-Bridge cluster-secret, root `Application` CR |

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
$EDITOR .env                                  # AWS_PROFILE, region overrides
make login

# 3. Stack config
cp infra/Pulumi.main.yaml.example infra/Pulumi.main.yaml
$EDITOR infra/Pulumi.main.yaml                # adminRoleArn, argoBootstrapRepoUrl

# 4. Stand up (~25 min)
make up

# 5. Get on the cluster
make vpn-config                               # writes ./client.ovpn
# (connect via your OpenVPN client)
make kubeconfig                               # writes ~/.kube/eks-pulumi-main
kubectl get nodes
kubectl get applications -n argocd            # root-app + GitOps children
```

## Configuration

`infra/Pulumi.main.yaml` (gitignored; example committed):

```yaml
config:
  aws:region: us-west-2
  eks-pulumi:kubernetesVersion: "1.35"
  eks-pulumi:vpcCidr: "10.50.0.0/16"
  eks-pulumi:clientVpnCidr: "10.100.0.0/22"
  eks-pulumi:enableNat: false                          # see Networking modes
  eks-pulumi:azCount: 3                                # AZ count, [2,6]; set to 2 for us-west-1
  eks-pulumi:adminRoleArn: "arn:aws:iam::<ACCT>:role/<ROLE>"
  eks-pulumi:argoBootstrapRepoUrl: "https://github.com/<you>/eks-argo-bootstrap.git"
  eks-pulumi:argoBootstrapRepoRevision: "HEAD"
  eks-pulumi:argoBootstrapRepoPath: "bootstrap"
```

Stack name is `main` (not `stage` / `prod`) — this is a base, not an environment.

## Networking modes

| Mode | Worker placement | Outbound | Extra cost | When |
|---|---|---|---:|---|
| `enableNat: false` (default) | Public subnets, public IPs, locked-down SG | Direct | $0 | Learning, dev, cost-sensitive |
| `enableNat: true` | Private subnets | Multi-AZ NAT (one per AZ) | ~$96/mo + data | Anything resembling prod |

Default-off is safe: SGs deny all inbound except node-to-node and cluster-API; no NodePort services; cluster API itself is VPN-only. Public IPs on workers are not a vulnerability when the SG is correct.

No single-AZ NAT option — losing one AZ would kill all egress; not worth the savings.

**AZ count** is configurable via `azCount` (range `[2, 6]`, default `3`). Regions with fewer AZs (e.g. us-west-1: 2) require explicit `azCount: 2`; otherwise a pre-flight guard fails fast with `Region X has only N AZ(s); azCount=K requested`. CIDRs are derived deterministically from `vpcCidr` (each subnet a `/20`), so re-runs at the same `azCount` produce no diff churn. NAT gateway count tracks `azCount` when `enableNat=true`. EKS minimum 2 AZs is enforced; cap at 6 leaves CIDR headroom (a `/16` yields 16 `/20` slots; `2 × azCount` are used).

## State backend

Pulumi DIY backend on S3, project-scoped layout (Pulumi ≥ 3.61):

```
s3://eks-pulumi-state-<account-id>-us-west-2?region=us-west-2&awssdk=v2
```

- Versioning, SSE-S3, public-access-block, 90-day lifecycle on old versions
- Native S3 locking (`PULUMI_SELF_MANAGED_STATE_LOCKING=1`); no DynamoDB
- Empty passphrase (`PULUMI_CONFIG_PASSPHRASE=""`)
- Bucket name auto-derived from `aws sts get-caller-identity`; override via `.env`
- Backend URL lives in `.env` (gitignored), not `Pulumi.yaml` — keeps account ID out of the public repo

## GitOps Bridge

The public `eks-argo-bootstrap` repo contains zero account-specific values. All ARNs, hostnames, account IDs, and queue names live as **annotations on a cluster `Secret`** that Pulumi plants in the `argocd` namespace. ApplicationSets in the GitOps repo template these into Helm values via `{{ metadata.annotations.<key> }}`.

Pattern: <https://github.com/gitops-bridge-dev/gitops-bridge>

This is what makes the GitOps repo publishable — it's a generic template; the cluster-specific values are injected at runtime by Pulumi.

## Teardown

```bash
make down                                     # one-shot
```

Enforced order:

1. `kubectl delete application root-app -n argocd --cascade=foreground`  
   (cascades through GitOps-managed apps; ALB Controller deletes ALBs, ESO deletes secrets, etc.)
2. Poll until Ingress + Service-type-LoadBalancer count = 0
3. Poll until Karpenter NodeClaims count = 0
4. `pulumi destroy`
5. Sweep orphan ENIs as a backstop

If a teardown wedges: open the Pulumi destroy log, identify the stuck resource, run the matching script in `scripts/unstick/` (finalizer patches for Ingress / NodeClaim / Namespace). Standard rookie hangs documented inline.

## Repo structure

```
eks-pulumi/
  README.md
  Makefile                                    # bootstrap-state-bucket, login, up, down, kubeconfig, vpn-config
  .env.example                                # committed
  scripts/
    bootstrap-state-bucket.sh                 # idempotent
    pre-destroy.sh
    nuke-orphan-enis.sh
    unstick/                                  # finalizer-patch fallbacks
  infra/
    Pulumi.yaml                               # no backend.url (it's in .env)
    Pulumi.main.yaml.example                  # committed
    package.json
    tsconfig.json
    pulumi.config.ts                          # typed config loader
    src/
      vpc.ts
      cluster.ts
      nodegroup.ts
      vpn.ts                                  # Client VPN + PKI generation
      iam.ts                                  # all in-cluster IAM roles
      karpenter-aws.ts                        # SQS + EventBridge + node role
      argocd.ts                               # Helm + bridge secret + root Application
    index.ts                                  # composition only
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

- **Kubernetes version:** bump `kubernetesVersion` in `Pulumi.main.yaml` once a new minor has been in EKS for 3+ months. Managed addons re-resolve to AWS-recommended defaults on the next `pulumi up` automatically — no separate version bumps in this repo.
- **Pulumi `@pulumi/eks` major bumps:** read release notes; cluster recreation is rare but possible.
- **Karpenter chart, AWS LB Controller, etc.:** version-pinned in `eks-argo-bootstrap`, not here.

## License

MIT
