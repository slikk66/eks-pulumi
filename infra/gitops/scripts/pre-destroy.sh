#!/usr/bin/env bash
# pre-destroy.sh
# In-cluster cleanup ahead of `pulumi destroy`. Drives each addon controller
# (ALB Controller, EBS/EFS CSI, Karpenter) through its own happy-path
# cleanup of AWS-attached resources while the controller is still alive,
# then cascades the ArgoCD root app, then sweeps any AWS-side leftovers
# directly. The end state is: zero EC2 instances, ALBs/NLBs, EBS volumes,
# or ENIs left referencing the cluster, so Pulumi's VPC/EKS teardown does
# not race or block.
#
# Idempotent: safe to re-run. No-op of in-cluster phases if the kubeconfig
# is missing or API server is unreachable; AWS-side sweep still runs.
#
# Dependencies: bash 4+, kubectl >= 1.32, AWS CLI v2.
#
# References:
#   ArgoCD cascade delete + auto-sync semantics:
#     https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/
#     https://argo-cd.readthedocs.io/en/stable/user-guide/app_deletion/
#   AWS LB Controller cleanup (Ingress/Service finalizers, ALB tagging):
#     https://docs.aws.amazon.com/eks/latest/userguide/aws-load-balancer-controller.html
#   Karpenter NodeClaim termination / disruption:
#     https://karpenter.sh/docs/concepts/disruption/

set -euo pipefail

# ---- Locate repo root and load .env ---------------------------------------
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
KUBECONFIG_PATH="${HOME}/.kube/eks-pulumi-cluster-${STACK}"
# Cluster name matches infra/cluster/pulumi.config.ts:
#   prefix = `${project}-${stack}` where project = eks-pulumi-cluster
#   clusterName = `${prefix}-cluster`
CLUSTER_NAME="eks-pulumi-cluster-${STACK}-cluster"

ts() { printf '[%s] ' "$(date +%H:%M:%S)"; }

# ---- Polling helper -------------------------------------------------------
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

# ===========================================================================
# AWS-side sweep functions (defined here so the kubeconfig-missing fast
# path can also invoke them).
# ===========================================================================

# Terminate any EC2 instance tagged karpenter.sh/nodepool AND
# kubernetes.io/cluster/<name>=owned. Catches Karpenter-launched nodes
# orphaned because the controller died before draining them.
sweep_orphan_karpenter_instances() {
  ts; echo "sweep: orphan Karpenter EC2 instances"

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
    ts; echo "sweep: 0 orphan Karpenter instances"
    return 0
  fi

  ts; echo "sweep: terminating $(echo "$ids" | wc -l | tr -d ' ') Karpenter instance(s):"
  echo "$ids" | sed 's/^/  /'
  # shellcheck disable=SC2086
  aws ec2 terminate-instances --region "$AWS_REGION" --instance-ids $ids \
    --query 'TerminatingInstances[*].[InstanceId,CurrentState.Name]' \
    --output text 2>&1 | sed 's/^/  /'

  poll_until_zero "sweep: instances still attaching ENIs" 600 "
    aws ec2 describe-instances \
      --region '$AWS_REGION' \
      --instance-ids $(echo "$ids" | tr '\n' ' ') \
      --query 'length(Reservations[*].Instances[?State.Name!=\`terminated\`][])' \
      --output text 2>/dev/null
  " || true
}

# Delete ALBs/NLBs and Target Groups tagged elbv2.k8s.aws/cluster=<name>.
# Catches LBs orphaned because the ALB controller died before its consumers'
# Ingress/LoadBalancer-Service objects were deleted (controller normally
# cleans up via finalizers, but if it dies first the finalizers strand the
# K8s object and the AWS LB).
sweep_orphan_load_balancers() {
  ts; echo "sweep: orphan ALB/NLB load balancers + target groups"

  # Resource Groups Tagging API returns LB and TG ARNs in one call.
  local arns lb_arns tg_arns
  arns=$(aws resourcegroupstaggingapi get-resources \
    --region "$AWS_REGION" \
    --tag-filters "Key=elbv2.k8s.aws/cluster,Values=${CLUSTER_NAME}" \
    --resource-type-filters \
      elasticloadbalancing:loadbalancer \
      elasticloadbalancing:targetgroup \
    --query 'ResourceTagMappingList[*].ResourceARN' \
    --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d')

  if [[ -z "$arns" ]]; then
    ts; echo "sweep: 0 orphan load balancers / target groups"
    return 0
  fi

  lb_arns=$(echo "$arns" | grep ':loadbalancer/' || true)
  tg_arns=$(echo "$arns" | grep ':targetgroup/' || true)

  # Delete LBs first; target groups can't be removed while attached to a
  # listener.
  if [[ -n "$lb_arns" ]]; then
    ts; echo "sweep: deleting $(echo "$lb_arns" | wc -l | tr -d ' ') load balancer(s)"
    while IFS= read -r arn; do
      [[ -z "$arn" ]] && continue
      ts; echo "  delete-load-balancer $arn"
      aws elbv2 delete-load-balancer --region "$AWS_REGION" \
        --load-balancer-arn "$arn" 2>&1 | sed 's/^/    /' || true
    done <<< "$lb_arns"

    # Wait for AWS to actually deprovision so target-group delete and
    # subsequent VPC subnet/SG delete don't race.
    ts; echo "sweep: waiting for load balancers to fully deprovision (timeout 5m)"
    while IFS= read -r arn; do
      [[ -z "$arn" ]] && continue
      aws elbv2 wait load-balancers-deleted --region "$AWS_REGION" \
        --load-balancer-arns "$arn" 2>/dev/null || true
    done <<< "$lb_arns"
  fi

  if [[ -n "$tg_arns" ]]; then
    ts; echo "sweep: deleting $(echo "$tg_arns" | wc -l | tr -d ' ') target group(s)"
    while IFS= read -r arn; do
      [[ -z "$arn" ]] && continue
      ts; echo "  delete-target-group $arn"
      aws elbv2 delete-target-group --region "$AWS_REGION" \
        --target-group-arn "$arn" 2>&1 | sed 's/^/    /' || true
    done <<< "$tg_arns"
  fi
}

# ---- Skip kubectl phases if kubeconfig missing or API unreachable --------
if [[ ! -f "$KUBECONFIG_PATH" ]]; then
  ts; echo "WARN: kubeconfig not found — cluster likely already torn down."
  ts; echo "      skipping in-cluster phases; running AWS-side sweep only."
  echo ""
  sweep_orphan_karpenter_instances
  echo ""
  sweep_orphan_load_balancers
  echo ""
  ts; echo "pre-destroy: complete"
  exit 0
fi

export KUBECONFIG="$KUBECONFIG_PATH"

if ! kubectl version --request-timeout=10s >/dev/null 2>&1; then
  ts; echo "WARN: kubectl cannot reach the API server (VPN connected?)."
  ts; echo "      skipping in-cluster phases; running AWS-side sweep only."
  echo ""
  sweep_orphan_karpenter_instances
  echo ""
  sweep_orphan_load_balancers
  echo ""
  ts; echo "pre-destroy: complete"
  exit 0
fi

# ===========================================================================
# In-cluster phases
# ===========================================================================

# ---- Phase 0: pause ArgoCD reconciliation --------------------------------
# Without this, selfHeal=true on every App will recreate any resource we
# delete in phase 1 within ~3min. Patching `spec.syncPolicy.automated` to
# null disables auto-sync + selfHeal + auto-prune for the rest of the
# teardown. The cascade in phase 2 still works because resources-finalizer
# triggers ArgoCD reconciliation regardless of automated mode.
ts; echo "phase 0: disable ArgoCD auto-sync/selfHeal on all Applications"
if kubectl get crd applications.argoproj.io >/dev/null 2>&1; then
  apps=$(kubectl get applications.argoproj.io -n argocd \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null)
  count=0
  while IFS= read -r app; do
    [[ -z "$app" ]] && continue
    kubectl patch application "$app" -n argocd --type=merge \
      -p '{"spec":{"syncPolicy":{"automated":null}}}' >/dev/null 2>&1 || true
    count=$((count + 1))
  done <<< "$apps"
  ts; echo "phase 0: paused ${count} Application(s)"
else
  ts; echo "phase 0: ArgoCD CRDs not installed — skipping"
fi
echo ""

# ---- Phase 1: drain in-cluster AWS-attached resources --------------------
# Each kind below maps to AWS resources that the corresponding controller
# is responsible for cleaning up. Delete the K8s object → controller
# observes the deletion → controller calls AWS to release the resource →
# K8s object's finalizer clears → object disappears.
#
# Order is intentional: NodePool deletion last, so any pods evicted by
# Ingress/LB/PVC churn can still reschedule briefly before the nodes go.
#
# CAUTION: phase 1c deletes ALL PVCs cluster-wide. Destructive for any
# stateful workload using EBS/EFS volumes — appropriate for ephemeral
# dev clusters (this stack), NOT for production data planes.
ts; echo "phase 1: drain in-cluster AWS-attached resources"

# 1a. Ingresses → ALB controller deletes ALBs + target groups
ts; echo "  1a: delete all Ingress resources (ALB controller cleans up)"
kubectl delete ingress -A --all --wait=false --ignore-not-found=true 2>&1 | sed 's/^/    /' || true
poll_until_zero "  1a: ingresses" 600 '
  kubectl get ingress -A --no-headers 2>/dev/null | wc -l | tr -d " "
' || true

# 1b. LoadBalancer Services → ALB controller deletes NLBs
ts; echo "  1b: delete all LoadBalancer Services (NLB cleanup)"
kubectl get svc -A --no-headers 2>/dev/null | awk '$5=="LoadBalancer" {print $1, $2}' | \
  while read -r ns name; do
    [[ -z "$ns" ]] && continue
    kubectl delete svc "$name" -n "$ns" --wait=false --ignore-not-found=true 2>&1 | sed 's/^/    /' || true
  done
poll_until_zero "  1b: LB-svc" 600 '
  kubectl get svc -A --no-headers 2>/dev/null | awk "\$5==\"LoadBalancer\"" | wc -l | tr -d " "
' || true

# 1c. PVCs → EBS/EFS CSI release backing volumes
ts; echo "  1c: delete all PersistentVolumeClaims (CSI releases volumes — DESTRUCTIVE)"
kubectl delete pvc -A --all --wait=false --ignore-not-found=true 2>&1 | sed 's/^/    /' || true
poll_until_zero "  1c: pvcs" 600 '
  kubectl get pvc -A --no-headers 2>/dev/null | wc -l | tr -d " "
' || true

# 1d. NodePools → Karpenter terminates NodeClaims + EC2
ts; echo "  1d: delete all Karpenter NodePools (controller terminates EC2)"
if kubectl get crd nodepools.karpenter.sh >/dev/null 2>&1; then
  kubectl delete nodepools --all --wait=false --ignore-not-found=true 2>&1 | sed 's/^/    /' || true
  poll_until_zero "  1d: nodeclaims" 600 '
    kubectl get nodeclaims --no-headers 2>/dev/null | wc -l | tr -d " "
  ' || true
else
  ts; echo "  1d: Karpenter CRDs not installed — skipping"
fi
echo ""

# ---- Phase 2: cascade-delete ArgoCD root app -----------------------------
# By now, all AWS-attached resources are gone, so this is just deleting
# manifests/RBAC/CRDs. ArgoCD's resources-finalizer cascades through child
# Apps regardless of phase 0's automated=null.
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

# ---- Phase 3: strip orphaned ArgoCD hook-finalizers in argocd ns ---------
# ArgoCD's hook mechanism stamps `argocd.argoproj.io/hook-finalizer` on
# resources spawned by Helm hooks during Application sync (e.g. the chart's
# own argocd-redis-secret-init Job). Once ArgoCD itself is being torn down,
# nothing remains to clear these finalizers — the argocd namespace then
# hangs in Terminating for ~5min until a manual finalizer strip.
ts; echo "phase 3: strip argocd hook-finalizers in argocd ns"
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
  ts; echo "phase 3: argocd ns absent — skipping"
fi
echo ""

# ---- Phase 4: AWS-side belt-and-suspenders sweep -------------------------
# Catches anything controllers couldn't clean up: Karpenter EC2 instances
# whose controller crashed mid-drain, ALBs/NLBs whose controller died
# before clearing finalizers, etc. Tag filters scope to this cluster.
ts; echo "phase 4: AWS-side sweep"
sweep_orphan_karpenter_instances
echo ""
sweep_orphan_load_balancers
echo ""

# ---- Phase 5: settle for AWS eventual consistency ------------------------
ts; echo "phase 5: settling 30s for AWS eventual consistency"
sleep 30

ts; echo "pre-destroy: complete"
