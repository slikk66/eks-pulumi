#!/usr/bin/env bash
# pre-destroy.sh
# In-cluster cleanup ahead of `pulumi destroy`. Drains Karpenter, cascades
# the ArgoCD root app, then waits for AWS-attached objects (Ingresses,
# LoadBalancer Services) to drain so Pulumi can tear down the VPC/EKS layer
# without orphaned ENIs, ALBs, or EC2 instances.
#
# Idempotent: safe to re-run. No-op if the kubeconfig is missing (cluster
# already gone) or if ArgoCD / Karpenter CRDs are not present.
#
# Dependencies: bash 4+, kubectl >= 1.32, AWS CLI v2.
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
# Cluster name matches infra/cluster/pulumi.config.ts:
#   prefix = `${project}-${stack}` where project = eks-pulumi-cluster
#   clusterName = `${prefix}-cluster`
CLUSTER_NAME="eks-pulumi-cluster-${STACK}-cluster"

ts() { printf '[%s] ' "$(date +%H:%M:%S)"; }

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

echo ""
ts; echo "pre-destroy: stack=${STACK} region=${AWS_REGION} cluster=${CLUSTER_NAME}"
ts; echo "pre-destroy: kubeconfig=${KUBECONFIG_PATH}"
echo ""

# ---- Phase 5 (AWS-side, runs even without kubeconfig) helper --------------
# Defined here so the kubeconfig-missing fast path below can still invoke it.
sweep_orphan_karpenter_instances() {
  ts; echo "phase 5: AWS-side sweep for orphan Karpenter EC2 instances"

  local ids
  ids=$(aws ec2 describe-instances \
    --region "$AWS_REGION" \
    --filters \
      "Name=tag-key,Values=karpenter.sh/nodepool" \
      "Name=tag:kubernetes.io/cluster/${CLUSTER_NAME},Values=owned" \
      "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[*].Instances[*].InstanceId' \
    --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d')

  if [[ -z "$ids" ]]; then
    ts; echo "phase 5: 0 orphan instances (cleared)"
    return 0
  fi

  ts; echo "phase 5: terminating $(echo "$ids" | wc -l | tr -d ' ') orphan instance(s):"
  echo "$ids" | sed 's/^/  /'
  # shellcheck disable=SC2086
  aws ec2 terminate-instances --region "$AWS_REGION" --instance-ids $ids \
    --query 'TerminatingInstances[*].[InstanceId,CurrentState.Name]' \
    --output text 2>&1 | sed 's/^/  /'

  # Wait for shutdown so Pulumi's SG delete doesn't race ENI detachment.
  poll_until_zero "phase 5: instances still attaching ENIs" 600 "
    aws ec2 describe-instances \
      --region '$AWS_REGION' \
      --instance-ids $(echo "$ids" | tr '\n' ' ') \
      --query 'length(Reservations[*].Instances[?State.Name!=\`terminated\`][])' \
      --output text 2>/dev/null
  " || true
}

# ---- Skip kubectl phases if kubeconfig missing ----------------------------
if [[ ! -f "$KUBECONFIG_PATH" ]]; then
  ts; echo "WARN: kubeconfig not found — cluster likely already torn down."
  ts; echo "      skipping in-cluster phases; running AWS-side sweep only."
  echo ""
  sweep_orphan_karpenter_instances
  ts; echo "pre-destroy: complete"
  exit 0
fi

export KUBECONFIG="$KUBECONFIG_PATH"

# Probe API server. If unreachable (VPN down, control plane gone), warn + skip.
if ! kubectl version --request-timeout=10s >/dev/null 2>&1; then
  ts; echo "WARN: kubectl cannot reach the API server (VPN connected?)."
  ts; echo "      skipping in-cluster phases; running AWS-side sweep only."
  echo ""
  sweep_orphan_karpenter_instances
  ts; echo "pre-destroy: complete"
  exit 0
fi

# ---- Phase 1: drain Karpenter --------------------------------------------
# Delete NodePools while Karpenter is still alive so it terminates its own
# NodeClaims (and thus the EC2 instances) cleanly. If we wait until the
# root-app cascade tears down the karpenter Application, the controller is
# gone and its provisioned instances orphan, blocking cluster-SG delete on
# `pulumi destroy` because their ENIs still reference the SG.
#
# Phase 5 below is the AWS-side fallback for instances Karpenter couldn't
# drain (e.g. controller pod Pending, CRDs already gone).
ts; echo "phase 1: drain Karpenter (delete nodepools + wait nodeclaims=0)"
if kubectl get crd nodepools.karpenter.sh >/dev/null 2>&1; then
  set +e
  kubectl delete nodepools --all --wait=true --timeout=5m 2>&1 | sed 's/^/  /'
  set -e
  poll_until_zero "nodeclaims" 600 '
    kubectl get nodeclaims --no-headers 2>/dev/null | wc -l | tr -d " "
  ' || true
else
  ts; echo "phase 1: Karpenter CRDs not installed — skipping"
fi
echo ""

# ---- Phase 2: cascade-delete ArgoCD root app ------------------------------
ts; echo "phase 2: cascade-delete ArgoCD root-app (timeout 15m)"

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
    ts; echo "phase 2: root-app deleted (or already absent)"
  fi
else
  ts; echo "phase 2: ArgoCD CRDs not installed — skipping"
fi
echo ""

# ---- Phase 3: wait for Ingress + LoadBalancer Services to drain -----------
# AWS LB Controller must be alive to remove ALB/NLB finalizers. If the GitOps
# stack already deleted the controller before its Ingresses/Services, those
# objects will hang on finalizers and require unstick/ scripts.
ts; echo "phase 3: wait for Ingress + LoadBalancer Services = 0 (timeout 10m)"
poll_until_zero "ingress+LB-svc" 600 '
  ing=$(kubectl get ingress -A --no-headers 2>/dev/null | wc -l | tr -d " ")
  lb=$(kubectl get svc -A --no-headers 2>/dev/null | awk "\$3==\"LoadBalancer\"" | wc -l | tr -d " ")
  echo $((ing + lb))
' || true
echo ""

# ---- Phase 4: strip orphaned ArgoCD hook-finalizers in argocd ns ----------
# ArgoCD's hook mechanism stamps `argocd.argoproj.io/hook-finalizer` on
# resources spawned by Helm hooks during Application sync (e.g. the chart's
# own argocd-redis-secret-init Job). Once ArgoCD itself is being torn down,
# nothing remains to clear these finalizers — the argocd namespace then
# hangs in Terminating for ~5min until `kubectl delete ns --force` or a
# manual finalizer strip. We do the strip here proactively.
#
# Safe / idempotent: only matches resources that still carry the finalizer.
ts; echo "phase 4: strip argocd hook-finalizers in argocd ns"
if kubectl get ns argocd >/dev/null 2>&1; then
  for kind in jobs.batch serviceaccounts roles.rbac.authorization.k8s.io rolebindings.rbac.authorization.k8s.io; do
    set +e
    names=$(kubectl get "$kind" -n argocd \
      -o jsonpath='{range .items[?(@.metadata.finalizers)]}{.metadata.name}{"\n"}{end}' \
      2>/dev/null)
    set -e
    while IFS= read -r name; do
      [[ -z "$name" ]] && continue
      ts; echo "  patching $kind/$name"
      kubectl patch "$kind" "$name" -n argocd --type=merge \
        -p '{"metadata":{"finalizers":null}}' >/dev/null 2>&1 || true
    done <<< "$names"
  done
else
  ts; echo "phase 4: argocd ns absent — skipping"
fi
echo ""

# ---- Phase 5: AWS-side sweep for orphan Karpenter instances --------------
# Belt-and-suspenders: even with Phase 1 draining Karpenter cleanly, the
# controller may not have finished terminating EC2 instances if it was
# evicted mid-run, or if NodeClaims were cleaned but the underlying
# instances lingered. Anything tagged `karpenter.sh/nodepool` AND
# `kubernetes.io/cluster/<name>=owned` that's still running gets terminated
# directly so Pulumi's cluster-SG delete doesn't block on stuck ENIs.
sweep_orphan_karpenter_instances
echo ""

# ---- Tail: LB controller eventual consistency -----------------------------
# Even after Ingress/Service objects vanish, the LB controller may still be
# finalizing target group / listener deletions in AWS. 30s buffer reduces
# the chance of `pulumi destroy` racing those calls.
ts; echo "settling 30s for LB controller eventual consistency"
sleep 30

ts; echo "pre-destroy: complete"
