// GitOps-stack composition. Side-effect import triggers the top-level
// resource declarations in src/argocd.ts (k8s.Provider → namespace → Helm
// release → cluster Secret → root Application). Exports below surface the
// values consumers need to verify the bootstrap landed.

import "./src/argocd";

import { argocdNamespace, rootAppName } from "./src/argocd";

export { argocdNamespace, rootAppName };
