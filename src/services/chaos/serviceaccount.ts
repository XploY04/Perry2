// Service account management for chaos tests
import { execAsync } from "./utils.js";

/**
 * Ensures that the LitmusChaos service account exists and has proper permissions
 * @param namespace The namespace where the service account should exist
 */
export async function ensureLitmusChaosServiceAccount(
  namespace: string = "default"
): Promise<void> {
  console.log(
    `Ensuring LitmusChaos service account exists in namespace ${namespace}...`
  );

  // Check if service account already exists
  try {
    const { stdout } = await execAsync(
      `kubectl get serviceaccount litmus-admin -n ${namespace} -o name`
    );
    if (stdout.trim()) {
      console.log("✅ LitmusChaos service account already exists");
      return;
    }
  } catch (error) {
    console.log("LitmusChaos service account not found, creating it...");
  }

  // Create the service account and associated permissions
  try {
    await execAsync(`kubectl apply -f - <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: litmus-admin
  namespace: ${namespace}
  labels:
    name: litmus-admin
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: litmus-admin
  labels:
    name: litmus-admin
rules:
- apiGroups: [""]
  resources: ["pods","events","pods/log","pods/exec","jobs","configmaps","secrets","services","nodes"]
  verbs: ["create","list","get","patch","update","delete","deletecollection"]
- apiGroups: ["batch"]
  resources: ["jobs"]
  verbs: ["create","list","get","delete","deletecollection"]
- apiGroups: ["litmuschaos.io"]
  resources: ["chaosengines","chaosexperiments","chaosresults"]
  verbs: ["create","list","get","patch","update","delete"]
- apiGroups: ["apps"]
  resources: ["deployments","statefulsets","replicasets","daemonsets"]
  verbs: ["list","get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: litmus-admin
  labels:
    name: litmus-admin
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: litmus-admin
subjects:
- kind: ServiceAccount
  name: litmus-admin
  namespace: ${namespace}
EOF`);

    console.log(
      "✅ Created LitmusChaos service account with required permissions"
    );
  } catch (error) {
    console.error("Error creating LitmusChaos service account:", error);
    throw new Error(`Failed to create LitmusChaos service account: ${error}`);
  }

  // Verify service account was created
  try {
    await execAsync(`kubectl get serviceaccount litmus-admin -n ${namespace}`);
    console.log("✅ Verified LitmusChaos service account exists");
  } catch (error) {
    throw new Error(
      `Failed to verify LitmusChaos service account creation: ${error}`
    );
  }
}
