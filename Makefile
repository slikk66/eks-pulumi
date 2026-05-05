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
.PHONY: help bootstrap-state-bucket login install preview up down refresh \
        vpn-config kubeconfig outputs clean

help:
	@echo "eks-pulumi targets"
	@echo ""
	@echo "  Setup (one-time):"
	@echo "    bootstrap-state-bucket   Create the Pulumi S3 state bucket (idempotent)"
	@echo "    login                    pulumi login + stack select"
	@echo "    install                  yarn install"
	@echo ""
	@echo "  Lifecycle:"
	@echo "    preview                  pulumi preview"
	@echo "    up                       pulumi up (full cluster, ~25 min)"
	@echo "    down                     pre-destroy + pulumi destroy + ENI sweep"
	@echo "    refresh                  pulumi refresh"
	@echo ""
	@echo "  Access:"
	@echo "    vpn-config               Write ./client.ovpn from stack output"
	@echo "    kubeconfig               Write kubeconfig (requires VPN connection)"
	@echo "    outputs                  Print all stack outputs"
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
	cd infra && pulumi stack select --create $(STACK)

install:
	cd infra && pnpm install

preview: install
	cd infra && pulumi preview

up: install
	cd infra && pulumi up --yes
	@$(MAKE) --no-print-directory kubeconfig
	@echo ""
	@echo "Next:"
	@echo "  make vpn-config        # writes ./client.ovpn"
	@echo "  (connect via your OpenVPN client)"
	@echo "  export KUBECONFIG=$(KUBECONFIG_PATH)"
	@echo "  kubectl get nodes"

down:
	@./scripts/pre-destroy.sh
	cd infra && pulumi destroy --yes
	@./scripts/nuke-orphan-enis.sh || true

refresh:
	cd infra && pulumi refresh --yes

vpn-config:
	@cd infra && pulumi stack output --show-secrets clientOvpn > ../client.ovpn
	@chmod 600 client.ovpn
	@echo "Wrote ./client.ovpn (mode 600)"

kubeconfig:
	$(eval CLUSTER_NAME := $(shell cd infra && pulumi stack output clusterName))
	aws eks update-kubeconfig \
		--region $(AWS_REGION) \
		--name $(CLUSTER_NAME) \
		--kubeconfig $(KUBECONFIG_PATH)
	@echo ""
	@echo "Kubeconfig: $(KUBECONFIG_PATH)"
	@echo "export KUBECONFIG=$(KUBECONFIG_PATH)"

outputs:
	cd infra && pulumi stack output --show-secrets

clean:
	rm -rf infra/node_modules infra/bin client.ovpn
