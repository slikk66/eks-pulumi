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
AWS_REGION      ?= us-west-2
STACK           ?= main
PROJECT         := eks-pulumi
CLUSTER_PROJECT := eks-pulumi-cluster
KUBECONFIG_PATH := $(HOME)/.kube/$(CLUSTER_PROJECT)-$(STACK)

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
        up down \
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
	@echo "  Cluster slice (live):"
	@echo "    preview-cluster          pulumi preview (infra/cluster)"
	@echo "    up-cluster               pulumi up    (infra/cluster)"
	@echo "    down-cluster             pulumi destroy (infra/cluster)"
	@echo "    refresh-cluster          pulumi refresh (infra/cluster)"
	@echo "    outputs-cluster          pulumi stack output --show-secrets (infra/cluster)"
	@echo ""
	@echo "  Gitops slice (live):"
	@echo "    preview-gitops           pulumi preview (infra/gitops)"
	@echo "    up-gitops                pulumi up    (infra/gitops)"
	@echo "    down-gitops              pre-destroy.sh + pulumi destroy (infra/gitops)"
	@echo "    refresh-gitops           pulumi refresh (infra/gitops)"
	@echo "    outputs-gitops           pulumi stack output --show-secrets (infra/gitops)"
	@echo ""
	@echo "  Top-level orchestration (chains the 3 stacks):"
	@echo "    up                       up-network -> vpn-config -> [PAUSE: connect VPN] -> up-cluster -> up-gitops"
	@echo "    down                     down-gitops -> down-cluster -> down-network -> nuke-orphan-enis.sh"
	@echo "                             (assumes interactive terminal — make up blocks on a read prompt)"
	@echo ""
	@echo "  Access:"
	@echo "    vpn-config               Write ./client.ovpn from network stack output"
	@echo "    kubeconfig               Write $(KUBECONFIG_PATH) from cluster stack output"
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

# ---- Cluster (live) --------------------------------------------------------

preview-cluster: install
	pulumi login "$(PULUMI_BACKEND_URL)"
	cd infra/cluster && pulumi stack select --create $(STACK) && pulumi preview

up-cluster: install
	pulumi login "$(PULUMI_BACKEND_URL)"
	cd infra/cluster && pulumi stack select --create $(STACK) && pulumi up --yes

down-cluster:
	pulumi login "$(PULUMI_BACKEND_URL)"
	cd infra/cluster && pulumi stack select --create $(STACK) && pulumi destroy --yes

refresh-cluster:
	pulumi login "$(PULUMI_BACKEND_URL)"
	cd infra/cluster && pulumi stack select --create $(STACK) && pulumi refresh --yes

outputs-cluster:
	pulumi login "$(PULUMI_BACKEND_URL)"
	cd infra/cluster && pulumi stack select --create $(STACK) && pulumi stack output --show-secrets

# ---- Gitops (live) ---------------------------------------------------------

preview-gitops: install
	pulumi login "$(PULUMI_BACKEND_URL)"
	cd infra/gitops && pulumi stack select --create $(STACK) && pulumi preview

up-gitops: install
	pulumi login "$(PULUMI_BACKEND_URL)"
	cd infra/gitops && pulumi stack select --create $(STACK) && pulumi up --yes

# `down-gitops` runs the in-cluster cleanup hook FIRST (cascade root-app, drain
# Ingresses / LoadBalancer Services / NodeClaims, settle 30s) so AWS-attached
# objects are gone before pulumi tries to delete the k8s resources.
# PULUMI_K8S_DELETE_UNREACHABLE=true lets `pulumi destroy` complete even if
# the cluster API is already gone (cluster destroyed first, VPN down, etc.).
#   https://github.com/pulumi/pulumi-kubernetes/issues/2517
#   https://github.com/pulumi/pulumi-kubernetes/issues/2311
down-gitops:
	@./infra/gitops/scripts/pre-destroy.sh
	pulumi login "$(PULUMI_BACKEND_URL)"
	cd infra/gitops && pulumi stack select --create $(STACK) && \
	  PULUMI_K8S_DELETE_UNREACHABLE=true pulumi destroy --yes

refresh-gitops:
	pulumi login "$(PULUMI_BACKEND_URL)"
	cd infra/gitops && pulumi stack select --create $(STACK) && pulumi refresh --yes

outputs-gitops:
	pulumi login "$(PULUMI_BACKEND_URL)"
	cd infra/gitops && pulumi stack select --create $(STACK) && pulumi stack output --show-secrets

# ---- Top-level orchestration -----------------------------------------------
#
# `make up` — full bring-up with operator-driven VPN-connect pause:
#   1. up-network (VPC + Client VPN)
#   2. assert clientOvpn stack output present (defensive — should never fail)
#   3. vpn-config (write ./client.ovpn, mode 600)
#   4. PAUSE: operator connects to VPN with their OpenVPN client, presses enter
#   5. up-cluster (EKS + IAM + addons + nodegroup)
#   6. up-gitops (ArgoCD + GitOps-Bridge cluster Secret + root Application)
#
# Assumes an interactive terminal — the read prompt blocks indefinitely
# otherwise. CI / unattended use is not supported (operator MUST connect
# the VPN manually; OpenVPN client choice varies by OS).
#
# `make down` — reverse, with cluster-gone safety on gitops destroy.
# PULUMI_K8S_DELETE_UNREACHABLE=true is set inside the down-gitops target,
# so destroy completes even if the cluster API is already gone.
#   1. down-gitops (pre-destroy.sh cascades root-app, then pulumi destroy)
#   2. down-cluster (pulumi destroy)
#   3. down-network (pulumi destroy)
#   4. nuke-orphan-enis.sh (sweep ENIs left in 'available' state)

up:
	@$(MAKE) up-network
	@cd infra/network && \
	  out="$$(pulumi stack output clientOvpn 2>/dev/null)"; \
	  test -n "$$out" || { \
	    echo ""; \
	    echo "ERROR: up-network completed without a clientOvpn stack output."; \
	    echo "       The Client VPN was not created — refusing to proceed."; \
	    echo "       Inspect with: make outputs-network"; \
	    exit 1; \
	  }
	@$(MAKE) vpn-config
	@echo ""
	@read -p "Connect to VPN now (use ./client.ovpn). Press enter to continue with cluster + gitops..." _
	@$(MAKE) up-cluster
	@$(MAKE) kubeconfig
	@$(MAKE) up-gitops

down:
	@$(MAKE) down-gitops
	@$(MAKE) down-cluster
	@$(MAKE) down-network
	@./scripts/nuke-orphan-enis.sh

# ---- Access ----------------------------------------------------------------

vpn-config:
	@cd infra/network && pulumi stack output --show-secrets clientOvpn > ../../client.ovpn
	@chmod 600 client.ovpn
	@echo "Wrote ./client.ovpn (mode 600)"

kubeconfig:
	@mkdir -p $(dir $(KUBECONFIG_PATH))
	@cd infra/cluster && pulumi stack output --show-secrets kubeconfig > $(KUBECONFIG_PATH)
	@chmod 600 $(KUBECONFIG_PATH)
	@echo "Wrote $(KUBECONFIG_PATH) (mode 600)"
	@echo "    export KUBECONFIG=$(KUBECONFIG_PATH)"

clean:
	rm -rf node_modules \
	       infra/network/node_modules infra/cluster/node_modules infra/gitops/node_modules \
	       infra/network/bin infra/cluster/bin infra/gitops/bin \
	       client.ovpn
