// Stack composition. Importing each src/*.ts module triggers its top-level
// resource declarations as a side effect; index.ts only re-exports the
// values that should appear as stack outputs.

import "./src/vpc";
import "./src/cluster";
import "./src/nodegroup";
import "./src/iam";
import "./src/karpenter-aws";
import "./src/vpn";
import "./src/argocd";

import { clusterName } from "./src/cluster";
import { clientOvpn, clientVpnEndpointId } from "./src/vpn";
import { argocdNamespace } from "./src/argocd";

// `clientOvpn` is already wrapped with pulumi.secret(...) in src/vpn.ts;
// re-exporting preserves the secret marking on the stack output.
export { clusterName, clientOvpn, clientVpnEndpointId, argocdNamespace };
