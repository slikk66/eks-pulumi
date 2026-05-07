#!/usr/bin/env bash
# pre-destroy.sh
# In-cluster cleanup ahead of `pulumi destroy`. Cascades the ArgoCD root app,
# then waits for AWS-attached objects (Ingresses, LoadBalancer Services,
# Karpenter NodeClaims) to drain so Pulumi can tear down the VPC/EKS layer
# without orphaned ENIs, ALBs, or EC2 instances.
#
# Idempotent: safe to re-run. No-op if the kubeconfig is missing (cluster
# already gone) or if ArgoCD / Karpenter CRDs are not present.
#
# Dependencies: bash 4+, kubectl >= 1.32, AWS CLI v2 (only indirectly, via
# kubeconfig that uses `aws eks get-token`).
#
# References:
#   ArgoCD cascade delete (foreground propagation):
#     https://argo-cd.readthedocs.io/en/stable/user-guide/app_deletion/
#   AWS LB Controller cleanup behavior on Ingress/Service deletion:
#     https://docs.aws.amazon.com/eks/latest/userguide/aws-load-balancer-controller.html
#   Karpenter NodeClaim termination / disruption:
#     https://karpenter.sh/docs/concepts/disruption/

set -euo pipefail

# ---- Locate repo root and load .env ---------------------------------------
# This script lives at infra/gitops/scripts/pre-destroy.sh — three levels
# below the repo root.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

AWS_REGION="${AWS_REGION:-us-west-2}"
STACK="${STACK:-main}"
# Kubeconfig path matches the Makefile's `kubeconfig` target, which writes
# ~/.kube/<cluster-project>-<stack> (cluster-project = eks-pulumi-cluster).
KUBECONFIG_PATH="${HOME}/.kube/eks-pulumi-cluster-${STACK}"

ts() { printf '[%s] ' "$(date +%H:%M:%S)"; }

echo ""
ts; echo "pre-destroy: stack=${STACK} region=${AWS_REGION}"
ts; echo "pre-destroy: kubeconfig=${KUBECONFIG_PATH}"
echo ""

# ---- Skip kubectl phase if kubeconfig missing -----------------------------
if [[ ! -f "$KUBECONFIG_PATH" ]]; then
  ts; echo "WARN: kubeconfig not found — cluster likely already torn down."
  ts; echo "      skipping in-cluster cleanup; proceeding to pulumi destroy."
  exit 0
fi

export KUBECONFIG="$KUBECONFIG_PATH"

# Probe API server. If unreachable (VPN down, control plane gone), warn + skip.
if ! kubectl version --request-timeout=10s >/dev/null 2>&1; then
  ts; echo "WARN: kubectl cannot reach the API server (VPN connected?)."
  ts; echo "      skipping in-cluster cleanup; proceeding to pulumi destroy."
  exit 0
fi

# ---- Phase 1: cascade-delete ArgoCD root app ------------------------------
ts; echo "phase 1: cascade-delete ArgoCD root-app (timeout 15m)"

if kubectl get crd applications.argoproj.io >/dev/null 2>&1; then
  set +e
  kubectl delete application root-app -n argocd \
    --cascade=foreground --wait=true --timeout=15m \
    --ignore-not-found=true
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    ts; echo "WARN: kubectl delete root-app exited $rc (continuing)" >&2
  else
    ts; echo "phase 1: root-app deleted (or already absent)"
  fi
else
  ts; echo "phase 1: ArgoCD CRDs not installed — skipping"
fi
echo ""

# ---- Polling helper -------------------------------------------------------
# poll_until_zero <label> <timeout-seconds> <shell-command-printing-int>
poll_until_zero() {
  local label="$1"
  local timeout_s="$2"
  local cmd="$3"

  local start now elapsed count
  start=$(date +%s)
  while :; do
    count=$(eval "$cmd" 2>/dev/null || echo 0)
    count="${count:-0}"
    [[ "$count" =~ ^[0-9]+$ ]] || count=0

    if (( count == 0 )); then
      ts; echo "$label: 0 (cleared)"
      return 0
    fi

    now=$(date +%s)
    elapsed=$(( now - start ))
    if (( elapsed >= timeout_s )); then
      ts; echo "WARN: $label still $count after ${timeout_s}s — continuing anyway" >&2
      return 1
    fi
    ts; echo "$label: $count (waiting, ${elapsed}s/${timeout_s}s)"
    sleep 15
  done
}

# ---- Phase 2: wait for Ingress + LoadBalancer Services to drain -----------
# AWS LB Controller must be alive to remove ALB/NLB finalizers. If the GitOps
# stack already deleted the controller before its Ingresses/Services, those
# objects will hang on finalizers and require unstick/ scripts.
ts; echo "phase 2: wait for Ingress + LoadBalancer Services = 0 (timeout 10m)"
poll_until_zero "ingress+LB-svc" 600 '
  ing=$(kubectl get ingress -A --no-headers 2>/dev/null | wc -l | tr -d " ")
  lb=$(kubectl get svc -A --no-headers 2>/dev/null | awk "\$3==\"LoadBalancer\"" | wc -l | tr -d " ")
  echo $((ing + lb))
' || true
echo ""

# ---- Phase 3: wait for Karpenter NodeClaims to terminate ------------------
# NodeClaim is cluster-scoped. Karpenter terminates them in response to
# pod evictions; we just need to wait the controller out.
ts; echo "phase 3: wait for Karpenter NodeClaims = 0 (timeout 10m)"
if kubectl get crd nodeclaims.karpenter.sh >/dev/null 2>&1; then
  poll_until_zero "nodeclaims" 600 '
    kubectl get nodeclaims --no-headers 2>/dev/null | wc -l | tr -d " "
  ' || true
else
  ts; echo "phase 3: Karpenter CRDs not installed — skipping"
fi
echo ""

# ---- Tail: LB controller eventual consistency -----------------------------
# Even after Ingress/Service objects vanish, the LB controller may still be
# finalizing target group / listener deletions in AWS. 30s buffer reduces
# the chance of `pulumi destroy` racing those calls.
ts; echo "settling 30s for LB controller eventual consistency"
sleep 30

ts; echo "pre-destroy: complete"
