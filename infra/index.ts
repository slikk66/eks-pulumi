// Stack composition. Importing each src/*.ts module triggers its top-level
// resource declarations as a side effect; index.ts only re-exports the
// values that should appear as stack outputs.
//
// The named imports below transitively load cluster, nodegroup, iam,
// karpenter-aws, vpc, and argocd. Only vpn needs an explicit side-effect
// import — the GitOps repo doesn't depend on its outputs but the Client
// VPN must still be created.

import "./src/vpn";

import { clusterName } from "./src/cluster";
import { clientOvpn, clientVpnEndpointId } from "./src/vpn";
import { argocdNamespace } from "./src/argocd";

// `clientOvpn` is already wrapped with pulumi.secret(...) in src/vpn.ts;
// re-exporting preserves the secret marking on the stack output.
export { clusterName, clientOvpn, clientVpnEndpointId, argocdNamespace };
