#!/usr/bin/env bash
# bootstrap-state-bucket.sh
# Idempotent: creates the Pulumi DIY S3 state bucket (project-scoped layout)
# with versioning + SSE-S3 + public-access-block + lifecycle.
# Auto-derives bucket name from AWS account ID if PULUMI_STATE_BUCKET is unset
# and writes the value back to .env for future runs.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"

# ---- Ensure .env exists ----------------------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$ENV_EXAMPLE" ]]; then
    echo "Creating .env from .env.example..."
    cp "$ENV_EXAMPLE" "$ENV_FILE"
  else
    echo "ERROR: $ENV_FILE missing and $ENV_EXAMPLE not found." >&2
    exit 1
  fi
fi

# Source .env (export every variable)
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

AWS_REGION="${AWS_REGION:-us-west-2}"

# ---- Verify AWS creds ------------------------------------------------------
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
if [[ -z "$ACCOUNT_ID" ]]; then
  echo "ERROR: Could not get AWS account ID. Check AWS_PROFILE / credentials." >&2
  exit 1
fi

# ---- Derive bucket name if not set, persist to .env ------------------------
if [[ -z "${PULUMI_STATE_BUCKET:-}" ]]; then
  PULUMI_STATE_BUCKET="eks-pulumi-state-${ACCOUNT_ID}-${AWS_REGION}"
  echo "Derived bucket name: $PULUMI_STATE_BUCKET"

  if grep -q '^PULUMI_STATE_BUCKET=' "$ENV_FILE"; then
    tmpfile="$(mktemp)"
    awk -v b="$PULUMI_STATE_BUCKET" \
      '/^PULUMI_STATE_BUCKET=/ { print "PULUMI_STATE_BUCKET=" b; next } { print }' \
      "$ENV_FILE" > "$tmpfile"
    mv "$tmpfile" "$ENV_FILE"
  else
    printf 'PULUMI_STATE_BUCKET=%s\n' "$PULUMI_STATE_BUCKET" >> "$ENV_FILE"
  fi
  echo "Persisted to $ENV_FILE"
fi

echo ""
echo "  Account: $ACCOUNT_ID"
echo "  Region : $AWS_REGION"
echo "  Bucket : $PULUMI_STATE_BUCKET"
echo ""

# ---- Create or adopt bucket ------------------------------------------------
err_file="$(mktemp)"
trap 'rm -f "$err_file"' EXIT

if [[ "$AWS_REGION" == "us-east-1" ]]; then
  create_args=(--bucket "$PULUMI_STATE_BUCKET" --region us-east-1)
else
  create_args=(
    --bucket "$PULUMI_STATE_BUCKET"
    --region "$AWS_REGION"
    --create-bucket-configuration "LocationConstraint=$AWS_REGION"
  )
fi

if aws s3api create-bucket "${create_args[@]}" >/dev/null 2>"$err_file"; then
  echo "Created bucket."
else
  if grep -q "BucketAlreadyOwnedByYou" "$err_file"; then
    echo "Bucket exists (owned by you)."
  elif grep -q "BucketAlreadyExists" "$err_file"; then
    echo "ERROR: Bucket name '$PULUMI_STATE_BUCKET' is taken by another AWS account." >&2
    echo "Set PULUMI_STATE_BUCKET in .env to a different name and re-run." >&2
    exit 1
  else
    cat "$err_file" >&2
    exit 1
  fi
fi

# ---- Apply configuration (idempotent) -------------------------------------
echo "  - Versioning: Enabled"
aws s3api put-bucket-versioning \
  --bucket "$PULUMI_STATE_BUCKET" \
  --versioning-configuration Status=Enabled

echo "  - Encryption: SSE-S3 (AES256), bucket key on"
aws s3api put-bucket-encryption \
  --bucket "$PULUMI_STATE_BUCKET" \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": { "SSEAlgorithm": "AES256" },
      "BucketKeyEnabled": true
    }]
  }'

echo "  - Public access: fully blocked"
aws s3api put-public-access-block \
  --bucket "$PULUMI_STATE_BUCKET" \
  --public-access-block-configuration '{
    "BlockPublicAcls": true,
    "IgnorePublicAcls": true,
    "BlockPublicPolicy": true,
    "RestrictPublicBuckets": true
  }'

echo "  - Lifecycle: noncurrent versions expire after 90d"
aws s3api put-bucket-lifecycle-configuration \
  --bucket "$PULUMI_STATE_BUCKET" \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "expire-noncurrent-versions",
      "Status": "Enabled",
      "Filter": {},
      "NoncurrentVersionExpiration": { "NoncurrentDays": 90 }
    }]
  }'

echo "  - Tags: ManagedBy=eks-pulumi, Purpose=pulumi-state"
aws s3api put-bucket-tagging \
  --bucket "$PULUMI_STATE_BUCKET" \
  --tagging "TagSet=[{Key=ManagedBy,Value=eks-pulumi},{Key=Purpose,Value=pulumi-state}]"

echo ""
echo "Done."
echo "Backend URL: s3://${PULUMI_STATE_BUCKET}?region=${AWS_REGION}&awssdk=v2"
echo ""
echo "Next:"
echo "  make login"
