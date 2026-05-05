#!/usr/bin/env bash
# nuke-orphan-enis.sh
# Backstop sweep for ENIs left in 'available' state after `pulumi destroy`.
# VPC CNI and AWS Load Balancer Controller occasionally leak ENIs when the
# in-cluster controllers are torn down before all dependent objects; the VPC
# delete then fails with "DependencyViolation". This script deletes those
# orphans so a re-run of `pulumi destroy` can complete.
#
# Idempotent: re-runnable; exits 0 with `found=0` when there is nothing to do.
# Failures on individual ENIs (already deleted, transitioning to in-use) are
# tolerated and counted, never fatal.
#
# Dependencies: bash 4+, AWS CLI v2.
#
# References:
#   ENI cleanup pattern (LB controller / VPC CNI):
#     https://docs.aws.amazon.com/eks/latest/userguide/aws-load-balancer-controller.html
#   describe-network-interfaces / delete-network-interface:
#     https://docs.aws.amazon.com/cli/latest/reference/ec2/describe-network-interfaces.html
#     https://docs.aws.amazon.com/cli/latest/reference/ec2/delete-network-interface.html

set -euo pipefail

# ---- Locate repo root and load .env ---------------------------------------
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

AWS_REGION="${AWS_REGION:-us-west-2}"

ts() { printf '[%s] ' "$(date +%H:%M:%S)"; }

echo ""
ts; echo "nuke-orphan-enis: region=${AWS_REGION}"

# ---- Verify AWS creds ------------------------------------------------------
if ! aws sts get-caller-identity --query Account --output text >/dev/null 2>&1; then
  ts; echo "ERROR: AWS credentials not configured (check AWS_PROFILE)." >&2
  exit 1
fi

# ---- Discover candidate ENIs ----------------------------------------------
# Filter server-side by status=available, then filter by description in the
# shell. AWS CLI filters do not support glob/regex, so substring matching is
# done locally with bash case (case-insensitive via shopt nocasematch).
ENIS_TSV="$(
  aws ec2 describe-network-interfaces \
    --region "$AWS_REGION" \
    --filters Name=status,Values=available \
    --query 'NetworkInterfaces[].[NetworkInterfaceId,Description]' \
    --output text 2>/dev/null || true
)"

found=0
deleted=0
failed=0

shopt -s nocasematch

while IFS=$'\t' read -r eni_id desc; do
  [[ -z "${eni_id:-}" ]] && continue
  case "$desc" in
    *amazon-eks*|*ELB*)
      found=$((found + 1))
      ts; echo "orphan: $eni_id  ($desc)"
      set +e
      err="$(aws ec2 delete-network-interface \
              --network-interface-id "$eni_id" \
              --region "$AWS_REGION" 2>&1)"
      rc=$?
      set -e
      if [[ $rc -eq 0 ]]; then
        deleted=$((deleted + 1))
        ts; echo "  deleted"
      else
        failed=$((failed + 1))
        ts; echo "  failed: $err" >&2
      fi
      ;;
  esac
done <<< "$ENIS_TSV"

shopt -u nocasematch

echo ""
ts; echo "nuke-orphan-enis: found=${found}, deleted=${deleted}, failed=${failed}"
exit 0
