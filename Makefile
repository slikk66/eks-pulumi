# eks-pulumi
# Run 'make help' for a list of targets.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# ---- Load .env (gitignored) ------------------------------------------------
ifneq (,$(wildcard .env))
  include .env
  export
endif

# ---- Defaults --------------------------------------------------------------
AWS_REGION ?= us-west-2
STACK      ?= main
PROJECT    := eks-pulumi
KUBECONFIG_PATH := $(HOME)/.kube/$(PROJECT)-$(STACK)

# ---- Auto-derive PULUMI_STATE_BUCKET if not set ----------------------------
ifeq ($(strip $(PULUMI_STATE_BUCKET)),)
  PULUMI_STATE_BUCKET := eks-pulumi-state-$(shell aws sts get-caller-identity --query Account --output text 2>/dev/null)-$(AWS_REGION)
endif

# ---- Pulumi env ------------------------------------------------------------
export PULUMI_CONFIG_PASSPHRASE :=
export PULUMI_SELF_MANAGED_STATE_LOCKING := 1
export PULUMI_BACKEND_URL := s3://$(PULUMI_STATE_BUCKET)?region=$(AWS_REGION)&awssdk=v2

# ---- Targets ---------------------------------------------------------------
.PHONY: help bootstrap-state-bucket login install \
        preview up down refresh outputs \
        preview-network up-network down-network refresh-network outputs-network \
        preview-cluster up-cluster down-cluster refresh-cluster outputs-cluster \
        preview-gitops up-gitops down-gitops refresh-gitops outputs-gitops \
        vpn-config kubeconfig clean

help:
	@echo "eks-pulumi targets (per-stack: -network, -cluster, -gitops)"
	@echo ""
	@echo "  Setup (one-time):"
	@echo "    bootstrap-state-bucket   Create the Pulumi S3 state bucket (idempotent)"
	@echo "    login                    pulumi login + stack select for all 3 projects"
	@echo "    install                  pnpm install at workspace root"
	@echo ""
	@echo "  Network slice (live):"
	@echo "    preview-network          pulumi preview (infra/network)"
	@echo "    up-network               pulumi up    (infra/network)"
	@echo "    down-network             pulumi destroy (infra/network)"
	@echo "    refresh-network          pulumi refresh (infra/network)"
	@echo "    outputs-network          pulumi stack output --show-secrets (infra/network)"
	@echo ""
	@echo "  Cluster slice (placeholder until #22 slice 2):"
	@echo "    preview-cluster / up-cluster / down-cluster / refresh-cluster / outputs-cluster"
	@echo ""
	@echo "  Gitops slice (placeholder until #22 slice 3):"
	@echo "    preview-gitops / up-gitops / down-gitops / refresh-gitops / outputs-gitops"
	@echo ""
	@echo "  Top-level (deferred to slice 4 of #22):"
	@echo "    preview / up / down / refresh / outputs"
	@echo ""
	@echo "  Access:"
	@echo "    vpn-config               Write ./client.ovpn from network stack output"
	@echo "    kubeconfig               (placeholder; live in slice 2)"
	@echo ""
	@echo "  Misc:"
	@echo "    clean                    Remove node_modules and build artifacts"
	@echo ""
	@echo "  Resolved:"
	@echo "    backend = $(PULUMI_BACKEND_URL)"
	@echo "    stack   = $(STACK)"
	@echo "    region  = $(AWS_REGION)"

bootstrap-state-bucket:
	@./scripts/bootstrap-state-bucket.sh

login:
	pulumi login "$(PULUMI_BACKEND_URL)"
	cd infra/network && pulumi stack select --create $(STACK)
	cd infra/cluster && pulumi stack select --create $(STACK)
	cd infra/gitops  && pulumi stack select --create $(STACK)

install:
	pnpm install

# ---- Network (live) --------------------------------------------------------

preview-network: install
	pulumi login "$(PULUMI_BACKEND_URL)"
	cd infra/network && pulumi stack select --create $(STACK) && pulumi preview

up-network: install
	pulumi login "$(PULUMI_BACKEND_URL)"
	cd infra/network && pulumi stack select --create $(STACK) && pulumi up --yes

down-network:
	pulumi login "$(PULUMI_BACKEND_URL)"
	cd infra/network && pulumi stack select --create $(STACK) && pulumi destroy --yes

refresh-network:
	pulumi login "$(PULUMI_BACKEND_URL)"
	cd infra/network && pulumi stack select --create $(STACK) && pulumi refresh --yes

outputs-network:
	pulumi login "$(PULUMI_BACKEND_URL)"
	cd infra/network && pulumi stack select --create $(STACK) && pulumi stack output --show-secrets

# ---- Cluster (placeholder until #22 slice 2) -------------------------------

preview-cluster up-cluster down-cluster refresh-cluster outputs-cluster:
	@echo "not implemented yet — see #22"

# ---- Gitops (placeholder until #22 slice 3) --------------------------------

preview-gitops up-gitops down-gitops refresh-gitops outputs-gitops:
	@echo "not implemented yet — see #22"

# ---- Top-level orchestration (deferred to slice 4 of #22) ------------------

preview up down refresh outputs:
	@echo "not implemented yet — wait for slice 4 of #22"

# ---- Access ----------------------------------------------------------------

vpn-config:
	@cd infra/network && pulumi stack output --show-secrets clientOvpn > ../../client.ovpn
	@chmod 600 client.ovpn
	@echo "Wrote ./client.ovpn (mode 600)"

kubeconfig:
	@echo "not implemented yet — see #22 slice 2"

clean:
	rm -rf node_modules \
	       infra/network/node_modules infra/cluster/node_modules infra/gitops/node_modules \
	       infra/network/bin infra/cluster/bin infra/gitops/bin \
	       client.ovpn
