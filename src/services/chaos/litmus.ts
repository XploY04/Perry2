// LitmusChaos specific implementations
import * as fs from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { exec } from "child_process";
import { execAsync } from "./utils.js";
import { ChaosEngineParams } from "./types.js";
import { ensureLitmusChaosServiceAccount } from "./serviceaccount.js";

// Interface for experiment debug info
interface ExperimentDebugInfo {
  experimentPods?: string;
  experimentResourceAvailable?: boolean;
  stuckInInitialized?: boolean;
  nodeStatus?: string;
  nodeMetrics?: string;
  message?: string;
  recommendation?: string;
  possibleCauses?: string[];
  permissionDiagnostics?: {
    canCreatePods: boolean;
    canAccessNodes: boolean;
  };
  recoveryAction?: string;
  serviceAccountRecreated?: boolean;
  serviceAccountFixError?: string;
  permissionCheckError?: string;
  error?: string;
  [key: string]: any; // Allow additional properties
}

/**
 * Installs LitmusChaos if not already installed
 */
export async function setupLitmusChaos(): Promise<void> {
  console.log("Setting up LitmusChaos...");

  let litmusAlreadyInstalled = false;
  let isLitmusSetupComplete = false;

  // First check all CRDs to see if LitmusChaos is already fully installed
  try {
    // Check for namespace
    await execAsync(`kubectl get namespace litmus`);
    console.log("✅ LitmusChaos namespace exists");

    // Check operator status
    const { stdout: pods } = await execAsync(
      `kubectl get pods -n litmus -l name=chaos-operator`
    );
    if (pods && !pods.includes("No resources found")) {
      console.log("✅ LitmusChaos operator is running");
      litmusAlreadyInstalled = true;

      // Verify all CRDs are properly installed
      const crdChecks = await Promise.allSettled([
        execAsync(`kubectl get crd chaosengines.litmuschaos.io`),
        execAsync(`kubectl get crd chaosexperiments.litmuschaos.io`),
        execAsync(`kubectl get crd chaosresults.litmuschaos.io`),
      ]);

      const allCrdsExist = crdChecks.every(
        (result) => result.status === "fulfilled"
      );
      if (allCrdsExist) {
        console.log("✅ All LitmusChaos CRDs are installed");

        // Verify pod-delete experiment exists
        try {
          await execAsync(`kubectl get chaosexperiment pod-delete`);
          console.log("✅ pod-delete experiment is available");
          isLitmusSetupComplete = true;
        } catch (error) {
          console.log("❌ pod-delete experiment is missing, will install it");
        }
      } else {
        console.log(
          "❌ Some LitmusChaos CRDs are missing, will reinstall them"
        );
      }
    } else {
      console.log(
        "❌ LitmusChaos namespace exists but operator is not running"
      );
    }
  } catch (error) {
    console.log("❌ LitmusChaos is not installed, installing now...");
  }

  // If LitmusChaos is not fully set up, install or fix missing components
  if (!isLitmusSetupComplete) {
    if (!litmusAlreadyInstalled) {
      try {
        console.log("Installing LitmusChaos operator...");

        // Try different known sources for LitmusChaos operator manifests
        try {
          await execAsync(
            `kubectl apply -f https://litmuschaos.github.io/litmus/litmus-operator-latest.yaml`
          );
        } catch (operatorError) {
          console.log(
            "Failed to fetch operator from primary URL, trying alternative sources..."
          );

          try {
            await execAsync(
              `kubectl apply -f https://litmuschaos.github.io/litmus/litmus-operator-v2.0.0.yaml`
            );
          } catch (v2Error) {
            console.log(
              "Failed to fetch operator from v2 URL, trying v1.13..."
            );

            try {
              await execAsync(
                `kubectl apply -f https://litmuschaos.github.io/litmus/litmus-operator-v1.13.8.yaml`
              );
            } catch (v1Error) {
              console.log(
                "All external sources failed, applying operator manually"
              );

              // Create the namespace ourselves since the yaml fetching failed
              await execAsync(`kubectl create namespace litmus`).catch(() =>
                console.log("Namespace might already exist")
              );

              // Create basic operator components manually
              await execAsync(`kubectl apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: chaos-operator
  namespace: litmus
spec:
  replicas: 1
  selector:
    matchLabels:
      name: chaos-operator
  template:
    metadata:
      labels:
        name: chaos-operator
    spec:
      serviceAccountName: chaos-operator
      containers:
        - name: chaos-operator
          image: litmuschaos/chaos-operator:latest
          command:
          - chaos-operator
          imagePullPolicy: Always
          env:
            - name: WATCH_NAMESPACE
              value: ""
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: OPERATOR_NAME
              value: "chaos-operator"
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: chaos-operator
  namespace: litmus
  labels:
    name: chaos-operator
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: chaos-operator
  labels:
    name: chaos-operator
rules:
- apiGroups: ["*"]
  resources: ["*"]
  verbs: ["*"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: chaos-operator
  labels:
    name: chaos-operator
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: chaos-operator
subjects:
- kind: ServiceAccount
  name: chaos-operator
  namespace: litmus
EOF`);
            }
          }
        }

        console.log("Creating LitmusChaos service account...");
        await execAsync(`kubectl apply -f - <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: litmus-admin
  namespace: default
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
  resources: ["pods","events","pods/log","pods/exec","jobs","configmaps","secrets","services"]
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
  namespace: default
EOF`);

        // Wait for the operator to be ready if it was installed
        try {
          console.log("Waiting for LitmusChaos operator to be ready...");
          await execAsync(
            `kubectl wait --for=condition=Ready pods -l name=chaos-operator -n litmus --timeout=120s`
          );
          console.log("✅ LitmusChaos operator is ready");
        } catch (waitError) {
          console.warn(
            "Warning: Timed out waiting for operator to be ready, continuing anyway..."
          );
        }
      } catch (error) {
        console.error("Error installing LitmusChaos operator:", error);
        throw new Error(
          `Failed to install LitmusChaos operator: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    // Install all required CRDs
    console.log("Installing or verifying LitmusChaos CRDs...");
    const crdsResult = await installLitmusChaosCustomResourceDefinitions();
    if (!crdsResult.success) {
      throw new Error(
        `Failed to install LitmusChaos CRDs: ${crdsResult.error}`
      );
    }
    console.log("✅ LitmusChaos CRDs installed successfully");

    // Install pod-delete experiment
    console.log("Installing pod-delete experiment...");
    await installPodDeleteExperiment();
    console.log("✅ Pod-delete experiment installed");
  }

  // Final verification
  try {
    // Verify CRDs
    await execAsync(`kubectl get crd chaosengines.litmuschaos.io`);
    await execAsync(`kubectl get crd chaosexperiments.litmuschaos.io`);
    await execAsync(`kubectl get crd chaosresults.litmuschaos.io`);

    // Verify pod-delete experiment
    await execAsync(`kubectl get chaosexperiment pod-delete`);

    console.log("✅ LitmusChaos setup complete and verified");
  } catch (error) {
    console.error("⚠️ LitmusChaos verification failed:", error);
    throw new Error(
      "LitmusChaos installation verification failed. The required components are not properly installed."
    );
  }
}

/**
 * Installs LitmusChaos Custom Resource Definitions
 */
async function installLitmusChaosCustomResourceDefinitions(): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    // First try to fetch and apply from the official URL
    try {
      await execAsync(
        `kubectl apply -f https://raw.githubusercontent.com/litmuschaos/litmus/master/litmus-portal/manifests/litmus/crds/chaosengine_crd.yaml`
      );
      console.log("Applied chaosengine CRD from GitHub");
    } catch (error) {
      console.log(
        "Failed to apply chaosengine CRD from GitHub, applying manually"
      );
      await execAsync(`kubectl apply -f - <<EOF
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: chaosengines.litmuschaos.io
spec:
  group: litmuschaos.io
  names:
    kind: ChaosEngine
    listKind: ChaosEngineList
    plural: chaosengines
    singular: chaosengine
  scope: Namespaced
  versions:
    - name: v1alpha1
      schema:
        openAPIV3Schema:
          type: object
          properties:
            apiVersion:
              type: string
            kind:
              type: string
            metadata:
              type: object
            spec:
              type: object
              properties:
                appinfo:
                  type: object
                engineState:
                  type: string
                chaosServiceAccount:
                  type: string
                experiments:
                  type: array
                  items:
                    type: object
                    properties:
                      name:
                        type: string
                      spec:
                        type: object
                        properties:
                          components:
                            type: object
                            properties:
                              env:
                                type: array
                                items:
                                  type: object
                                  properties:
                                    name:
                                      type: string
                                    value:
                                      type: string
                monitoring:
                  type: boolean
                jobCleanUpPolicy:
                  type: string
                annotationCheck:
                  type: string
            status:
              type: object
              x-kubernetes-preserve-unknown-fields: true
      served: true
      storage: true
EOF`);
    }

    try {
      await execAsync(
        `kubectl apply -f https://raw.githubusercontent.com/litmuschaos/litmus/master/litmus-portal/manifests/litmus/crds/chaosexperiment_crd.yaml`
      );
      console.log("Applied chaosexperiment CRD from GitHub");
    } catch (error) {
      console.log(
        "Failed to apply chaosexperiment CRD from GitHub, applying manually"
      );
      await execAsync(`kubectl apply -f - <<EOF
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: chaosexperiments.litmuschaos.io
spec:
  group: litmuschaos.io
  names:
    kind: ChaosExperiment
    listKind: ChaosExperimentList
    plural: chaosexperiments
    singular: chaosexperiment
  scope: Namespaced
  versions:
    - name: v1alpha1
      schema:
        openAPIV3Schema:
          type: object
          properties:
            apiVersion:
              type: string
            kind:
              type: string
            metadata:
              type: object
            spec:
              type: object
              properties:
                definition:
                  type: object
                  properties:
                    scope:
                      type: string
                    permissions:
                      type: array
                      items:
                        type: object
                    image:
                      type: string
                    imagePullPolicy:
                      type: string
                    args:
                      type: array
                      items:
                        type: string
                    command:
                      type: array
                      items:
                        type: string
                    env:
                      type: array
                      items:
                        type: object
                        properties:
                          name:
                            type: string
                          value:
                            type: string
                    labels:
                      type: object
                      x-kubernetes-preserve-unknown-fields: true
      served: true
      storage: true
EOF`);
    }

    try {
      await execAsync(
        `kubectl apply -f https://raw.githubusercontent.com/litmuschaos/litmus/master/litmus-portal/manifests/litmus/crds/chaosresult_crd.yaml`
      );
      console.log("Applied chaosresult CRD from GitHub");
    } catch (error) {
      console.log(
        "Failed to apply chaosresult CRD from GitHub, applying manually"
      );
      await execAsync(`kubectl apply -f - <<EOF
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: chaosresults.litmuschaos.io
spec:
  group: litmuschaos.io
  names:
    kind: ChaosResult
    listKind: ChaosResultList
    plural: chaosresults
    singular: chaosresult
  scope: Namespaced
  versions:
    - name: v1alpha1
      schema:
        openAPIV3Schema:
          type: object
          properties:
            apiVersion:
              type: string
            kind:
              type: string
            metadata:
              type: object
            spec:
              type: object
              x-kubernetes-preserve-unknown-fields: true
            status:
              type: object
              properties:
                experimentStatus:
                  type: object
                  properties:
                    phase:
                      type: string
                    verdict:
                      type: string
                    failStep:
                      type: string
                history:
                  type: object
                  properties:
                    passedRuns:
                      type: array
                      items:
                        type: object
                    failedRuns:
                      type: array
                      items:
                        type: object
              x-kubernetes-preserve-unknown-fields: true
      served: true
      storage: true
EOF`);
    }

    // Wait for CRDs to be established
    console.log("Waiting for CRDs to be established...");
    await new Promise((resolve) => setTimeout(resolve, 5000));

    return { success: true };
  } catch (error) {
    console.error("Error installing CRDs:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Installs pod-delete chaos experiment
 */
export async function installPodDeleteExperiment(): Promise<void> {
  try {
    // Check if pod-delete experiment already exists and is valid
    try {
      const { stdout } = await execAsync(
        `kubectl get chaosexperiment pod-delete -o yaml`
      );
      if (stdout && !stdout.includes("error")) {
        console.log("Pod-delete experiment already exists, validating it...");

        // Try to get a simple attribute to validate the experiment works
        try {
          const { stdout: podDeleteJson } = await execAsync(
            `kubectl get chaosexperiment pod-delete -o json`
          );
          const podDeleteObj = JSON.parse(podDeleteJson);

          // Check if the experiment has valid structure
          if (podDeleteObj?.spec?.definition?.image) {
            console.log("✅ Existing pod-delete experiment is valid");
            return; // Exit early if the experiment exists and is valid
          } else {
            console.log(
              "⚠️ Existing pod-delete experiment has invalid structure, will reinstall"
            );
          }
        } catch (parseError) {
          console.log(
            "⚠️ Could not validate existing pod-delete experiment, will reinstall"
          );
        }
      }
    } catch (error) {
      console.log("Pod-delete experiment does not exist, will install it");
    }

    // First try to fetch the pod-delete experiment from the official URL
    try {
      await execAsync(
        `kubectl apply -f https://hub.litmuschaos.io/api/chaos/2.0.0/experiments/pod-delete/pod-delete.yaml`
      );
      console.log("Applied pod-delete experiment from LitmusChaos Hub");

      // Verify the experiment was created successfully
      try {
        await execAsync(`kubectl get chaosexperiment pod-delete`);
        console.log("✅ Successfully verified pod-delete experiment from Hub");
        return;
      } catch (verifyError) {
        console.log(
          "⚠️ Hub installation succeeded but verification failed, trying alternative schema"
        );
      }
    } catch (error) {
      console.log(
        "Failed to get pod-delete experiment from LitmusChaos Hub, installing it directly"
      );
    }

    // Create the pod-delete experiment manually with compatible schema structure
    console.log("Trying installation with rbac schema...");

    try {
      await execAsync(`kubectl apply -f - <<EOF
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosExperiment
metadata:
  name: pod-delete
  labels:
    name: pod-delete
    app.kubernetes.io/part-of: litmus
    app.kubernetes.io/component: chaosexperiment
    app.kubernetes.io/version: latest
spec:
  definition:
    scope: Namespaced
    # Using rbac object instead of direct permissions array
    rbac:
      rules:
        - apiGroups: ["", "apps", "batch", "litmuschaos.io"]
          resources: 
            - "deployments"
            - "jobs"
            - "pods"
            - "pods/log"
            - "events"
            - "configmaps"
            - "chaosengines"
            - "chaosexperiments"
            - "chaosresults"
          verbs: 
            - "create"
            - "list"
            - "get"
            - "patch"
            - "update"
            - "delete"
            - "deletecollection"
    image: "litmuschaos/go-runner:latest"
    imagePullPolicy: Always
    args:
      - -c
      - ./experiments -name pod-delete
    command:
      - /bin/bash
    env:
      - name: TOTAL_CHAOS_DURATION
        value: '30'
      - name: RAMP_TIME
        value: '0'
      - name: FORCE
        value: 'true'
      - name: CHAOS_INTERVAL
        value: '10'
      - name: PODS_AFFECTED_PERC
        value: '50'
      - name: LIB
        value: litmus
      - name: TARGET_PODS
        value: ''
      - name: SEQUENCE
        value: 'parallel'
    labels:
      name: pod-delete
      app.kubernetes.io/part-of: litmus
      app.kubernetes.io/component: experiment-job
      app.kubernetes.io/version: latest
EOF`);

      console.log("Pod-delete experiment installed manually with rbac schema");

      // Verify installation
      await execAsync(`kubectl get chaosexperiment pod-delete`);
      console.log(
        "✅ Successfully verified pod-delete installation with rbac schema"
      );
      return;
    } catch (rbacError) {
      console.log(
        "❌ Failed to install pod-delete with rbac schema, trying legacy permissions format..."
      );
    }

    // Try with a simplified format as fallback
    try {
      await execAsync(`kubectl apply -f - <<EOF
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosExperiment
metadata:
  name: pod-delete
  labels:
    name: pod-delete
    app.kubernetes.io/part-of: litmus
    app.kubernetes.io/component: chaosexperiment
    app.kubernetes.io/version: latest
spec:
  definition:
    scope: Namespaced
    image: "litmuschaos/go-runner:latest"
    imagePullPolicy: Always
    args:
      - -c
      - ./experiments -name pod-delete
    command:
      - /bin/bash
    env:
      - name: TOTAL_CHAOS_DURATION
        value: '30'
      - name: RAMP_TIME
        value: '0'
      - name: FORCE
        value: 'true'
      - name: CHAOS_INTERVAL
        value: '10'
      - name: PODS_AFFECTED_PERC
        value: '50'
      - name: LIB
        value: litmus
      - name: TARGET_PODS
        value: ''
      - name: SEQUENCE
        value: 'parallel'
    labels:
      name: pod-delete
      app.kubernetes.io/part-of: litmus
      app.kubernetes.io/component: experiment-job
      app.kubernetes.io/version: latest
EOF`);

      console.log(
        "Pod-delete experiment installed with simplified schema (no permissions)"
      );

      // Verify installation
      await execAsync(`kubectl get chaosexperiment pod-delete`);
      console.log(
        "✅ Successfully verified simplified pod-delete installation"
      );
    } catch (simpleError) {
      console.error(
        "❌ All pod-delete installation attempts failed:",
        simpleError
      );
      throw new Error(
        "Failed to install pod-delete experiment with any schema format"
      );
    }
  } catch (error) {
    console.error("Error installing pod-delete experiment:", error);
    throw new Error(
      `Failed to install pod-delete experiment: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Creates and runs a chaos experiment
 */
export async function runChaosExperiment(
  params: ChaosEngineParams
): Promise<any> {
  const {
    targetDeployment,
    targetNamespace,
    chaosType,
    duration,
    manifestPath,
  } = params;

  console.log(
    `Running ${chaosType} chaos experiment against ${targetDeployment} in namespace ${targetNamespace}...`
  );

  // First, verify that the chaos experiment is properly installed
  try {
    console.log("Verifying chaos experiment is properly installed...");
    const { stdout: expStatus } = await execAsync(
      `kubectl get chaosexperiment ${chaosType} -o json || echo "not found"`
    );

    if (expStatus.includes("not found")) {
      console.log(
        `⚠️ Chaos experiment '${chaosType}' not found, attempting to install it...`
      );
      // Try to install the pod-delete experiment if that's what we're using
      if (chaosType === "pod-delete") {
        await installPodDeleteExperiment();
      } else {
        throw new Error(
          `Chaos experiment '${chaosType}' is not installed. Only pod-delete is supported for auto-installation.`
        );
      }
    } else {
      // Check if the experiment is valid by parsing the JSON
      try {
        const exp = JSON.parse(expStatus);
        console.log(
          `✅ Chaos experiment '${chaosType}' is installed. Image: ${
            exp.spec?.definition?.image || "unknown"
          }`
        );
      } catch (jsonError) {
        console.log(
          `⚠️ Warning: Could not parse chaos experiment definition. It may be invalid.`
        );
      }
    }
  } catch (expError) {
    console.error(
      `Error verifying chaos experiment: ${
        expError instanceof Error ? expError.message : String(expError)
      }`
    );
    throw new Error(
      `Failed to verify chaos experiment: ${
        expError instanceof Error ? expError.message : String(expError)
      }`
    );
  }

  // Ensure service account exists
  try {
    console.log("Ensuring LitmusChaos service account exists...");
    await ensureLitmusChaosServiceAccount(targetNamespace);
    console.log("✅ LitmusChaos service account is ready");
  } catch (saError) {
    console.error("Failed to create LitmusChaos service account:", saError);
    throw new Error(
      `Failed to create LitmusChaos service account: ${
        saError instanceof Error ? saError.message : String(saError)
      }`
    );
  }

  // Get the actual labels for the deployment
  let appLabel = "app=" + targetDeployment;
  try {
    const labelCmd = await execAsync(
      `kubectl get deployment ${targetDeployment} -n ${targetNamespace} -o jsonpath='{.spec.selector.matchLabels}'`
    );
    const labelsStr = labelCmd.stdout.toString();

    // Parse the labels from JSON format
    if (labelsStr) {
      try {
        const labels = JSON.parse(labelsStr.replace(/'/g, '"'));
        // Use the first label as the target
        const firstKey = Object.keys(labels)[0];
        if (firstKey) {
          appLabel = `${firstKey}=${labels[firstKey]}`;
          console.log(`Using label selector: ${appLabel}`);
        }
      } catch (err) {
        console.log(
          "Failed to parse deployment labels, using default app label"
        );
      }
    }
  } catch (err) {
    console.log("Failed to get deployment labels, using default app label");
  }

  const timestamp = Date.now();
  const engineName = `${targetDeployment}-chaos-${timestamp}`;

  // Create the chaos engine manifest with enhanced configuration
  await fs.writeFile(
    manifestPath,
    `
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: ${engineName}
  namespace: ${targetNamespace}
  labels:
    app: ${targetDeployment}
    chaostype: ${chaosType}
spec:
  engineState: active
  appinfo:
    appns: ${targetNamespace}
    applabel: "${appLabel}"
    appkind: deployment
  chaosServiceAccount: litmus-admin
  jobCleanUpPolicy: delete
  components:
    runner:
      image: "litmuschaos/chaos-runner:latest"
      imagePullPolicy: Always
      runnerannotation:
        iam.amazonaws.com/role: ""
  experiments:
    - name: ${chaosType}
      spec:
        components:
          statusCheckTimeouts:
            delay: 2
            timeout: 180
          nodeSelector: {}
          env:
            - name: TOTAL_CHAOS_DURATION
              value: '${duration}'
            - name: CHAOS_INTERVAL
              value: '10'
            - name: FORCE
              value: 'true'
            - name: PODS_AFFECTED_PERC
              value: '50'
            - name: TARGET_PODS
              value: ''
            - name: SEQUENCE
              value: 'parallel'
`,
    "utf-8"
  );

  try {
    console.log(`Applying chaos engine manifest: ${manifestPath}`);

    // First, check if we can access the chaos engine CRD
    try {
      await execAsync(`kubectl get crd chaosengines.litmuschaos.io`);
      console.log("✅ ChaosEngine CRD is accessible");
    } catch (crdError) {
      console.error(
        "❌ ChaosEngine CRD is not accessible, attempting to reinstall LitmusChaos CRDs"
      );
      // Try to reinstall the CRDs
      const crdsResult = await installLitmusChaosCustomResourceDefinitions();
      if (!crdsResult.success) {
        throw new Error(
          `Failed to reinstall ChaosEngine CRD: ${crdsResult.error}`
        );
      }
      console.log("✅ Successfully reinstalled LitmusChaos CRDs");

      // Wait for the CRDs to be available
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // Try to apply the chaos engine manifest
    try {
      await execAsync(`kubectl apply -f ${manifestPath}`);
      console.log("✅ Successfully applied chaos engine manifest");
    } catch (applyError) {
      // If it fails, try to get more detailed error information
      console.error("❌ Error applying chaos engine manifest");

      // Try running with --validate=false as a fallback
      console.log("Attempting to apply chaos engine with --validate=false...");
      await execAsync(`kubectl apply --validate=false -f ${manifestPath}`);
      console.log("✅ Applied chaos engine with validation disabled");
    }

    console.log(
      `Waiting for chaos experiment to complete (${duration} seconds)...`
    );

    // Wait for chaos engine to be created
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Check if chaos engine is created properly
    try {
      const { stdout: engineStatus } = await execAsync(
        `kubectl get chaosengine ${engineName} -n ${targetNamespace} -o yaml`
      );
      console.log("✅ Chaos engine created successfully");

      // Check for any warnings or errors in the status
      if (
        engineStatus.includes("error") ||
        engineStatus.includes("Error") ||
        engineStatus.includes("failed") ||
        engineStatus.includes("Failed")
      ) {
        console.warn(
          "⚠️ Chaos engine may have issues. Status contains error indicators."
        );
        console.log(
          "Engine Status excerpt:",
          engineStatus.substring(0, 500) + "..."
        );
      }
    } catch (error) {
      console.error("❌ Failed to create chaos engine");
      throw new Error(
        `Failed to create chaos engine: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // Wait for experiment pod to be spawned
    console.log("Waiting for experiment pod to be created...");

    let experimentPodName = "";
    let retries = 0;
    const maxRetries = 10;

    // Try multiple label selectors to find experiment pods
    const podLabelSelectors = [
      `chaosengine=${engineName}`,
      `app=${targetDeployment},chaosengine=${engineName}`,
      `chaosName=${chaosType}`,
      `name=chaos-runner`,
      `app.kubernetes.io/component=experiment-job`,
      `name=${chaosType}`,
    ];

    // Special handling for node-io-stress
    if (chaosType === "node-io-stress") {
      // Add more selectors specific to node-io-stress
      podLabelSelectors.push(
        `name=node-io-stress`,
        `app=node-io-stress`,
        `app.kubernetes.io/name=node-io-stress`,
        `chaosUID`
      );
    }

    while (retries < maxRetries) {
      // Try each label selector until we find a pod
      for (const selector of podLabelSelectors) {
        try {
          const { stdout: podList } = await execAsync(
            `kubectl get pods -n ${targetNamespace} -l ${selector} --no-headers -o custom-columns=":metadata.name" 2>/dev/null || echo ""`
          );

          if (podList && podList.trim()) {
            experimentPodName = podList.trim().split("\n")[0];
            console.log(
              `Found experiment pod with selector '${selector}': ${experimentPodName}`
            );
            break;
          }
        } catch (error) {
          // Just continue to the next selector
        }
      }

      if (experimentPodName) {
        break; // Exit the retry loop if we found a pod
      }

      // Check if a chaos engine exists and is running
      try {
        const { stdout: engineStatus } = await execAsync(
          `kubectl get chaosengine ${engineName} -n ${targetNamespace} -o jsonpath='{.status.engineStatus}' 2>/dev/null || echo ""`
        );

        if (engineStatus && engineStatus.trim()) {
          console.log(`Chaos engine status: ${engineStatus.trim()}`);
        }
      } catch (error) {
        // Ignore errors from this check
      }

      console.log(
        `Waiting for experiment pod (attempt ${retries + 1}/${maxRetries})...`
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
      retries++;
    }

    if (!experimentPodName) {
      console.log("Could not find experiment pod after multiple attempts.");

      // Check for pods with chaos-related labels as a fallback
      try {
        console.log(
          "Performing extended pod search with multiple label combinations..."
        );

        // Try to collect all possible chaos-related pods for diagnostics
        const podSearchResults: Record<string, string> = {};

        // Check engine status first to understand the current state
        console.log(
          "Checking engine status to diagnose why pods weren't created..."
        );
        let engineStatus = "";
        let enginePhase = "";
        try {
          const { stdout: engineJson } = await execAsync(
            `kubectl get chaosengine ${engineName} -n ${targetNamespace} -o json 2>/dev/null || echo "{}"`
          );

          if (engineJson && !engineJson.includes("{}")) {
            const engineData = JSON.parse(engineJson);
            engineStatus = engineData.status?.engineStatus || "unknown";
            enginePhase = engineData.status?.engineStatus || "unknown";

            console.log(`Engine status: ${engineStatus}`);
            podSearchResults.engineStatus = engineStatus;
            podSearchResults.enginePhase = enginePhase;

            // Check for permission issues if engine is stuck in pending or initialized state
            if (engineStatus === "initialized" || engineStatus === "pending") {
              console.log(
                "Engine is stuck in initialized/pending state, checking service account permissions..."
              );

              try {
                const { stdout: saPermissions } = await execAsync(
                  `kubectl auth can-i --list --as=system:serviceaccount:${targetNamespace}:litmus-admin || echo "Permission check failed"`
                );
                podSearchResults.serviceAccountPermissions = saPermissions
                  .trim()
                  .split("\n")
                  .slice(0, 10)
                  .join("\n");
              } catch (permError) {
                console.log("Could not check service account permissions");
              }

              // Check for events related to the chaos engine
              try {
                const { stdout: engineEvents } = await execAsync(
                  `kubectl get events --field-selector involvedObject.name=${engineName},involvedObject.namespace=${targetNamespace} --sort-by='.lastTimestamp' || echo "No events found"`
                );
                podSearchResults.engineEvents = engineEvents
                  .trim()
                  .split("\n")
                  .slice(0, 10)
                  .join("\n");
              } catch (eventError) {
                console.log("Could not check engine events");
              }
            }
          }
        } catch (engineError) {
          console.log("Error checking engine status:", engineError);
        }

        // Check for chaos operator pods
        const { stdout: allChaosPods } = await execAsync(
          `kubectl get pods -n ${targetNamespace} -l name=chaos-operator,chaosUID -o custom-columns=":metadata.name" --no-headers || echo ""`
        );

        if (allChaosPods && allChaosPods.trim()) {
          console.log(`Found chaos operator pods: ${allChaosPods.trim()}`);
          podSearchResults.chaosOperatorPods = allChaosPods.trim();
        }

        // Check for experiment job pods
        const { stdout: anyChaosPods } = await execAsync(
          `kubectl get pods -n ${targetNamespace} -l app.kubernetes.io/component=experiment-job -o custom-columns=":metadata.name" --no-headers || echo ""`
        );

        if (anyChaosPods && anyChaosPods.trim()) {
          // Try to use the most recent pod
          experimentPodName = anyChaosPods.trim().split("\n")[0];
          console.log(`Found experiment job pod: ${experimentPodName}`);
          podSearchResults.experimentJobPods = anyChaosPods.trim();
        }

        // Check for runner pods
        const { stdout: runnerPods } = await execAsync(
          `kubectl get pods -n ${targetNamespace} -l app.kubernetes.io/name=chaos-runner -o custom-columns=":metadata.name" --no-headers || echo ""`
        );

        if (runnerPods && runnerPods.trim()) {
          console.log(`Found chaos runner pods: ${runnerPods.trim()}`);
          podSearchResults.chaosRunnerPods = runnerPods.trim();
        }

        // Check for any pod with chaosUID label
        const { stdout: chaosUIDPods } = await execAsync(
          `kubectl get pods -n ${targetNamespace} -l chaosUID -o custom-columns=":metadata.name" --no-headers || echo ""`
        );

        if (chaosUIDPods && chaosUIDPods.trim()) {
          console.log(`Found pods with chaosUID label: ${chaosUIDPods.trim()}`);
          podSearchResults.chaosUIDPods = chaosUIDPods.trim();
        }

        // Check for any chaos-related problems in the events
        try {
          console.log("Checking for chaos-related errors in recent events...");
          const { stdout: events } = await execAsync(
            `kubectl get events -n ${targetNamespace} --sort-by='.lastTimestamp' | grep -i "chaos\\|error\\|fail\\|warn" || echo "No relevant events found"`
          );

          if (
            events &&
            events.trim() &&
            !events.includes("No relevant events found")
          ) {
            console.log("Found potentially relevant events:");
            console.log(events.trim());
            podSearchResults.relevantEvents = events.trim();
          }
        } catch (eventError) {
          console.log("Error checking events:", eventError);
        }

        // If we didn't find an experiment pod but found other chaos-related pods, save this info for later
        if (!experimentPodName && Object.keys(podSearchResults).length > 0) {
          console.log(
            "Found some chaos-related pods but couldn't identify the specific experiment pod"
          );
          // Store this info for later use in results
          (params as any).podSearchResults = podSearchResults;
        } else if (!experimentPodName) {
          console.log(
            "No chaos experiment pods found. The experiment might be delayed or failed to start. Will continue and check for results anyway."
          ); // Check if this is a node-io-stress experiment and add specific debug info
          if (chaosType === "node-io-stress") {
            console.log(
              "Note: node-io-stress experiments sometimes fail to create experiment pods in certain environments"
            );
            console.log(
              "This is a known issue with LitmusChaos node-level experiments"
            );

            // Enhanced diagnostics specifically for node-io-stress experiments
            const nodeIOStressDebugInfo: Record<string, any> = {
              experimentType: chaosType,
              problemDescription:
                "Node-IO-Stress experiments often get stuck in 'initialized' state without creating experiment pods",
            };

            // Check the current state of nodes
            try {
              const { stdout: nodeStatus } = await execAsync(
                `kubectl get nodes -o wide || echo "No nodes found"`
              );
              nodeIOStressDebugInfo.nodeStatus = nodeStatus
                .trim()
                .split("\n")
                .slice(0, 5)
                .join("\n");
            } catch (nodeError) {
              nodeIOStressDebugInfo.nodeStatusError = String(nodeError);
            }

            // Check for any IO-related metrics if possible
            try {
              const { stdout: nodeResourceUsage } = await execAsync(
                `kubectl top nodes || echo "Resource metrics not available"`
              );
              nodeIOStressDebugInfo.nodeResourceUsage =
                nodeResourceUsage.trim();
            } catch (resError) {
              // Metrics server might not be available, that's ok
            }

            // Find details about the chaos service account
            try {
              const { stdout: saRights } = await execAsync(
                `kubectl describe clusterrolebinding litmus-admin || echo "Service account details not found"`
              );
              if (saRights && !saRights.includes("not found")) {
                console.log(
                  "Chaos service account has these permissions - excerpt:"
                );
                console.log(saRights.substring(0, 200) + "...");
                nodeIOStressDebugInfo.serviceAccountInfo = saRights.substring(
                  0,
                  500
                );
              }
            } catch (saError) {
              console.log("Could not check service account permissions");
            }

            // Try to get any already running chaos experiments of this type
            try {
              const { stdout: runningExps } = await execAsync(
                `kubectl get pods --all-namespaces -l chaosType=${chaosType} || echo "No running experiments found"`
              );
              if (
                runningExps &&
                !runningExps.includes("No running experiments found")
              ) {
                nodeIOStressDebugInfo.runningExperiments = runningExps.trim();
              }
            } catch (expError) {
              // Ignore errors
            }

            // Store the debug info
            (params as any).nodeIOStressDebugInfo = nodeIOStressDebugInfo;
          }
        }
      } catch (podSearchError) {
        console.log(
          "Error while searching for any chaos pods:",
          podSearchError
        );
        console.log("Will continue and check for results anyway.");
      }
    }

    // If we found a pod, follow its logs
    if (experimentPodName) {
      try {
        const logProcess = exec(
          `kubectl logs -f ${experimentPodName} -n ${targetNamespace}`
        );
        logProcess.stdout?.on("data", (data: Buffer) => {
          console.log(`[Experiment Log] ${data.toString().trim()}`);
        });
        // Kill the log process after the experiment should be done
        setTimeout(() => {
          logProcess.kill();
        }, (duration + 15) * 1000);
      } catch (error) {
        console.log("Could not stream experiment logs");
      }
    }

    // Wait for the experiment to complete
    const waitTimeBuffer = chaosType === "node-io-stress" ? 40 : 20; // Extra buffer for node-io-stress
    console.log(
      `Waiting for experiment to complete (${duration} seconds + ${waitTimeBuffer} buffer)...`
    );
    await new Promise((resolve) =>
      setTimeout(resolve, (duration + waitTimeBuffer) * 1000)
    );

    // For node-io-stress, check if we're still waiting in initialized state
    if (chaosType === "node-io-stress") {
      try {
        const { stdout: currentEngineStatus } = await execAsync(
          `kubectl get chaosengine ${engineName} -n ${targetNamespace} -o jsonpath='{.status.engineStatus}' 2>/dev/null || echo "unknown"`
        );

        if (currentEngineStatus === "initialized") {
          console.log(
            "⚠️ Warning: node-io-stress experiment is still in 'initialized' state after waiting"
          );
          console.log(
            "This is a common issue with node-io-stress experiments. The experiment may still be causing stress effects."
          );

          // Check for the service account being used
          try {
            const { stdout: saStatus } = await execAsync(
              `kubectl get serviceaccount litmus-admin -n ${targetNamespace} -o yaml || echo "Service account not found"`
            );

            if (saStatus.includes("not found")) {
              console.log(
                "Service account 'litmus-admin' is missing in namespace",
                targetNamespace
              );
              console.log("Creating service account...");

              // Try to create the service account
              await ensureLitmusChaosServiceAccount(targetNamespace);

              console.log(
                "✅ Created service account, but experiment already running"
              );
              console.log(
                "Note: You'll need to delete the current experiment and try again"
              );
            } else {
              console.log(
                "Service account exists, checking other potential issues..."
              );

              // Check for experiment pods by name pattern
              const { stdout: podSearch } = await execAsync(
                `kubectl get pods -n ${targetNamespace} --show-labels | grep -E "${chaosType}|node-io|stress" || echo "No matching pods found"`
              );

              if (!podSearch.includes("No matching pods found")) {
                console.log(
                  "Found potential experiment-related pods:",
                  podSearch
                );
              }

              // Check for experiment pod creation permissions
              try {
                const { stdout: permTest } = await execAsync(
                  `kubectl auth can-i create pods --as=system:serviceaccount:${targetNamespace}:litmus-admin -n ${targetNamespace} || echo "No"`
                );

                if (permTest.trim() !== "yes") {
                  console.log(
                    "⚠️ Service account may not have permission to create pods in namespace",
                    targetNamespace
                  );
                  (params as any).permissionIssue =
                    "Service account cannot create pods";
                }
              } catch (permError) {
                console.log("Could not check permissions:", permError);
              }
            }
          } catch (saCheckError) {
            console.log("Error checking service account:", saCheckError);
          }

          // Add extra wait time to see if it eventually completes
          console.log(
            "Adding extra 20 seconds wait time for node-io-stress..."
          );
          await new Promise((resolve) => setTimeout(resolve, 20 * 1000));

          // Get node status to help with diagnosis
          const { stdout: nodeStatus } = await execAsync(
            `kubectl top nodes || echo "Node metrics not available"`
          );
          console.log("Current node resource usage:");
          console.log(nodeStatus);

          // Store this information for results
          (params as any).stuckInInitialized = true;
          (params as any).nodeStatus = nodeStatus;
          (params as any).serviceAccountChecked = true;
        }
      } catch (statusError) {
        console.log("Could not check current engine status");
      }
    }

    // Check for the pod-delete experiment CRD one more time to ensure it's still there
    try {
      await execAsync(`kubectl get chaosexperiment ${chaosType}`);
      console.log(`✅ ${chaosType} experiment is still available`);
    } catch (error) {
      console.error(
        `❌ ${chaosType} experiment is no longer available! Re-installing...`
      );
      if (chaosType === "pod-delete") {
        await installPodDeleteExperiment();
      }
    }

    // Get the experiment result using multiple methods for resilience
    let resultsJson = null;
    const possibleResultNames = [
      `${engineName}-${chaosType}`,
      `${targetDeployment}-chaos-${chaosType}`,
      `${engineName}`,
      `${targetDeployment}-${chaosType}`,
      `${targetDeployment}-${timestamp}`,
      `${targetDeployment}-runner`,
    ];

    // Print current chaos results
    try {
      // Extended search for any available results
      const { stdout: availableResults } = await execAsync(
        `kubectl get chaosresults -n ${targetNamespace} || echo "No results found"`
      );
      console.log("Available chaos results:", availableResults.trim());

      // Get all chaos engines for more context
      const { stdout: allEngines } = await execAsync(
        `kubectl get chaosengine -n ${targetNamespace} -o wide || echo "No engines found"`
      );
      console.log("Available chaos engines:", allEngines.trim());

      // Get details about our specific engine
      try {
        const { stdout: engineDetails } = await execAsync(
          `kubectl get chaosengine ${engineName} -n ${targetNamespace} -o yaml`
        );
        console.log(`Details for engine ${engineName} (excerpt):`);
        // Print just the first 300 chars to avoid log flooding
        console.log(engineDetails.substring(0, 300) + "...");
      } catch (e) {
        console.log(`Failed to get details for engine ${engineName}`);
      }
    } catch (error) {
      console.log("Error fetching chaos resources:", error);
    }

    // Try with additional naming patterns for the node-io-stress experiment
    if (chaosType === "node-io-stress") {
      // Add additional naming patterns specific to node-io-stress
      possibleResultNames.push(
        `${engineName}-io-stress`,
        `${targetDeployment}-io-stress`,
        `chaos-${chaosType}`,
        `${targetDeployment}-chaos-runner-${chaosType}`
      );
    }

    for (const resultName of possibleResultNames) {
      try {
        console.log(`Trying to get results with name: ${resultName}`);
        const chaosResults = await execAsync(
          `kubectl get chaosresult ${resultName} -n ${targetNamespace} -o json 2>/dev/null || echo ""`
        );

        if (
          chaosResults.stdout &&
          !chaosResults.stdout.includes("No resources found") &&
          chaosResults.stdout.trim() !== ""
        ) {
          try {
            resultsJson = JSON.parse(chaosResults.stdout.toString());
            console.log(`✅ Found results with name: ${resultName}`);
            break;
          } catch (parseError) {
            console.log(
              `Error parsing result JSON for ${resultName}: ${parseError}`
            );
          }
        } else {
          console.log(`Could not find results with name: ${resultName}`);
        }
      } catch (error) {
        console.log(`Could not find results with name: ${resultName}`);
      }
    }

    // If all specific names failed, try listing all results and find a match
    if (!resultsJson) {
      try {
        console.log("Searching for any matching chaos results...");
        const allResults = await execAsync(
          `kubectl get chaosresults -n ${targetNamespace} -o json`
        );
        const resultsData = JSON.parse(allResults.stdout.toString());

        if (resultsData && resultsData.items && resultsData.items.length > 0) {
          // Find most recent result by creation timestamp
          const matchingResults = resultsData.items
            .filter(
              (item: any) =>
                item.metadata.name.includes(targetDeployment) ||
                item.metadata.name.includes(chaosType) ||
                item.metadata.name.includes("chaos")
            )
            .sort(
              (a: any, b: any) =>
                new Date(b.metadata.creationTimestamp).getTime() -
                new Date(a.metadata.creationTimestamp).getTime()
            );

          if (matchingResults.length > 0) {
            resultsJson = matchingResults[0];
            console.log(`Found matching result: ${resultsJson.metadata.name}`);
          } else {
            // Get all results even if they don't match filters, for diagnostic purposes
            console.log(
              `Found ${resultsData.items.length} chaos results, but none matched the target deployment or chaos type.`
            );

            // Add list of available results to params for diagnostic info
            (params as any).availableResults = resultsData.items.map(
              (item: any) => ({
                name: item.metadata.name,
                namespace: item.metadata.namespace,
                creationTime: item.metadata.creationTimestamp,
              })
            );
          }
        } else {
          console.log("No chaos results found at all");
        }
      } catch (error) {
        console.log("Failed to list and search all chaos results");
      }
    } // Get engine status if we couldn't find results
    if (!resultsJson) {
      console.log(
        "Could not find chaos results, getting engine status instead..."
      );
      try {
        const engineStatus = await execAsync(
          `kubectl get chaosengine ${engineName} -n ${targetNamespace} -o json 2>/dev/null || echo ""`
        );

        if (engineStatus.stdout && engineStatus.stdout.trim() !== "") {
          try {
            const engineData = JSON.parse(engineStatus.stdout.toString());

            // Print the important engine status details for debugging
            console.log("Engine Status:", {
              phase: engineData.status?.engineStatus || "Unknown",
              experiments: engineData.status?.experiments || [],
              runnerPod: engineData.status?.runnerPod || "None",
            });

            // Extract more detailed information from the engine status
            const experimentDetails = engineData.status?.experiments?.[0] || {};
            const events = [];

            // Add any events from the status if available
            if (engineData.status?.events) {
              for (const event of engineData.status.events) {
                events.push({
                  type: event.type,
                  reason: event.reason,
                  message: event.message,
                  timestamp:
                    event.lastTimestamp ||
                    event.firstTimestamp ||
                    new Date().toISOString(),
                });
              }
            }

            // Try to get specific debug info for node-io-stress
            let experimentDebugInfo: ExperimentDebugInfo = {};
            if (chaosType === "node-io-stress") {
              try {
                // Check for specific experiment pods
                const { stdout: experimentPods } = await execAsync(
                  `kubectl get pods -n ${targetNamespace} -l name=node-io-stress --no-headers || echo ""`
                );

                if (experimentPods && experimentPods.trim()) {
                  experimentDebugInfo = {
                    experimentPods: experimentPods.trim(),
                    message:
                      "Found dedicated node-io-stress experiment pods, may need different result collection mechanism",
                  };
                }

                // Check for available ChaosExperiment resource
                const { stdout: experimentResource } = await execAsync(
                  `kubectl get chaosexperiment node-io-stress -o yaml 2>/dev/null || echo "Not available"`
                );

                if (
                  experimentResource &&
                  !experimentResource.includes("Not available")
                ) {
                  experimentDebugInfo = {
                    ...experimentDebugInfo,
                    experimentResourceAvailable: true,
                  };
                }

                // Check if engine is stuck in initialized state - this is common for node-io-stress
                if (engineData.status?.engineStatus === "initialized") {
                  // Get info about node status
                  const { stdout: nodeStatus } = await execAsync(
                    `kubectl get nodes -o wide || echo "No nodes found"`
                  );

                  // Get node resource metrics if available
                  let nodeMetrics = "";
                  try {
                    const { stdout: metrics } = await execAsync(
                      `kubectl top nodes || echo "Node metrics not available"`
                    );
                    nodeMetrics = metrics.trim();
                  } catch (e) {
                    // Metrics server might not be available
                  }

                  // Initialize experimentDebugInfo with additional diagnostic information
                  experimentDebugInfo = {
                    ...experimentDebugInfo,
                    stuckInInitialized: true,
                    nodeStatus: nodeStatus
                      .trim()
                      .split("\n")
                      .slice(0, 3)
                      .join("\n"),
                    nodeMetrics: nodeMetrics,
                    message:
                      "Engine is stuck in 'initialized' state - a common issue with node-io-stress experiments",
                    recommendation:
                      "The experiment may still be causing stress effects even though it's stuck. Consider this a partial success.",
                    possibleCauses: [
                      "Missing permissions for service account",
                      "Node resource constraints",
                      "LitmusChaos operator limitations",
                    ],
                  };

                  // Check service account permissions to diagnose the issue
                  try {
                    const { stdout: saPermCheck } = await execAsync(
                      `kubectl auth can-i create pods --as=system:serviceaccount:${targetNamespace}:litmus-admin -n ${targetNamespace} || echo "No"`
                    );

                    const { stdout: nodePermCheck } = await execAsync(
                      `kubectl auth can-i get nodes --as=system:serviceaccount:${targetNamespace}:litmus-admin -n ${targetNamespace} || echo "No"`
                    );

                    experimentDebugInfo.permissionDiagnostics = {
                      canCreatePods: saPermCheck.trim() === "yes",
                      canAccessNodes: nodePermCheck.trim() === "yes",
                    };

                    if (
                      saPermCheck.trim() !== "yes" ||
                      nodePermCheck.trim() !== "yes"
                    ) {
                      experimentDebugInfo.recoveryAction =
                        "Create service account with proper permissions using ensureLitmusChaosServiceAccount function";

                      // Try to fix the service account
                      try {
                        console.log(
                          "Attempting to recreate service account with proper permissions..."
                        );
                        await ensureLitmusChaosServiceAccount(targetNamespace);
                        experimentDebugInfo.serviceAccountRecreated = true;
                      } catch (fixError) {
                        experimentDebugInfo.serviceAccountFixError =
                          String(fixError);
                      }
                    }
                  } catch (permError) {
                    experimentDebugInfo.permissionCheckError =
                      String(permError);
                  }
                }
              } catch (debugError) {
                experimentDebugInfo = {
                  error:
                    debugError instanceof Error
                      ? debugError.message
                      : String(debugError),
                };
              }
            }

            resultsJson = {
              kind: "ChaosResult",
              metadata: {
                name: engineName,
                namespace: targetNamespace,
                creationTimestamp: engineData.metadata?.creationTimestamp,
              },
              status: {
                experimentStatus: {
                  phase: engineData.status?.engineStatus || "Completed",
                  verdict: experimentDetails.verdict || "Awaited",
                  failStep: experimentDetails.failStep || "N/A",
                },
                engineDetails: {
                  engineState: engineData.spec?.engineState || "active",
                  appInfo: engineData.spec?.appinfo || {},
                  runnerPod: engineData.status?.runnerPod || "None",
                  experimentStatuses: engineData.status?.experiments || [],
                },
                events: events.length > 0 ? events : undefined,
                podSearchResults: (params as any).podSearchResults || undefined,
                nodeIOStressSpecific:
                  chaosType === "node-io-stress"
                    ? experimentDebugInfo
                    : undefined,
              },
              rawEngineStatus: engineData.status,
            };

            console.log(
              "Created result data from engine status with detailed diagnostic information"
            );
          } catch (parseError) {
            console.log(`Error parsing engine status JSON: ${parseError}`);
          }
        } else {
          console.log("Engine status is empty or not found");
        }
      } catch (error) {
        console.log("Could not get chaos engine status either:", error);

        // Try to get general pod status for diagnostics
        try {
          const { stdout: podStatus } = await execAsync(
            `kubectl get pods -n ${targetNamespace} -l app=${targetDeployment} -o wide || echo "No pods found"`
          );
          console.log("Current pod status:", podStatus.trim());
        } catch (e) {
          // Ignore error
        }

        // Create a minimal result so we don't fail completely
        resultsJson = {
          kind: "ChaosResult",
          metadata: {
            name: engineName,
            namespace: targetNamespace,
          },
          status: {
            experimentStatus: {
              phase: "Completed",
              verdict: "Awaited",
              failStep: "Result retrieval",
            },
            diagnosticInfo: {
              engine: engineName,
              target: targetDeployment,
              namespace: targetNamespace,
              chaosType: chaosType,
              errorMessage:
                error instanceof Error ? error.message : String(error),
            },
            podSearchResults: (params as any).podSearchResults || undefined,
          },
        };
      }
    }

    // Wait for pods to recover and be ready
    try {
      console.log("Waiting for pods to recover...");
      await execAsync(
        `kubectl wait --for=condition=Ready pods --selector=${appLabel} -n ${targetNamespace} --timeout=60s`
      );
      console.log("✅ All pods recovered successfully");
    } catch (error) {
      console.log("⚠️ Warning: Not all pods recovered within timeout");

      // Add recovery information to results
      if (resultsJson && resultsJson.status) {
        resultsJson.status.recoveryInfo = {
          status: "Incomplete",
          message: "Not all pods recovered within timeout period",
        };
      }
    }

    return resultsJson;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error running chaos experiment: ${errorMessage}`);

    // Try to get diagnostic information
    let diagnosticInfo = {
      error: errorMessage,
      engineName: engineName,
      targetDeployment: targetDeployment,
      targetNamespace: targetNamespace,
      chaosType: chaosType,
      appliedManifest: manifestPath,
    };

    try {
      const { stdout: engineStatus } = await execAsync(
        `kubectl get chaosengine ${engineName} -n ${targetNamespace} -o yaml`
      );
      // Use direct property assignment instead of object spread
      (diagnosticInfo as any).engineStatus = engineStatus;
    } catch (e) {
      // Ignore errors in getting diagnostic info
    }

    // Return a structured error result
    return {
      status: "error",
      error: errorMessage,
      diagnosticInfo: diagnosticInfo,
    };
  }
}

/**
 * Validates that all required chaos resources are properly installed
 * @returns Promise with validation results
 */
export async function validateChaosResources(): Promise<{
  valid: boolean;
  diagnostics: Record<string, any>;
}> {
  console.log("Validating LitmusChaos resources...");

  const result = {
    valid: true,
    diagnostics: {
      crdsExist: false,
      operatorRunning: false,
      serviceAccountExists: false,
      experimentExists: false,
      message: "All LitmusChaos resources are properly set up",
    },
  };

  try {
    // Check for CRDs
    try {
      await execAsync(`kubectl get crd chaosengines.litmuschaos.io`);
      await execAsync(`kubectl get crd chaosexperiments.litmuschaos.io`);
      await execAsync(`kubectl get crd chaosresults.litmuschaos.io`);
      result.diagnostics.crdsExist = true;
      console.log("✅ LitmusChaos CRDs exist");
    } catch (error) {
      result.valid = false;
      result.diagnostics.message = "LitmusChaos CRDs are missing";
      console.log("❌ LitmusChaos CRDs are missing");
    }

    // Check for operator
    try {
      const { stdout: pods } = await execAsync(
        `kubectl get pods -n litmus -l name=chaos-operator`
      );
      if (pods && !pods.includes("No resources found")) {
        result.diagnostics.operatorRunning = true;
        console.log("✅ LitmusChaos operator is running");
      } else {
        result.valid = false;
        result.diagnostics.message = "LitmusChaos operator is not running";
        console.log("❌ LitmusChaos operator is not running");
      }
    } catch (error) {
      result.valid = false;
      result.diagnostics.message = "LitmusChaos operator is not running";
      console.log("❌ LitmusChaos operator is not running");
    }

    // Check for service account
    try {
      await execAsync(`kubectl get serviceaccount litmus-admin`);
      result.diagnostics.serviceAccountExists = true;
      console.log("✅ LitmusChaos service account exists");
    } catch (error) {
      result.valid = false;
      result.diagnostics.message = "LitmusChaos service account is missing";
      console.log("❌ LitmusChaos service account is missing");
    }

    // Check for basic experiment
    try {
      await execAsync(`kubectl get chaosexperiment pod-delete`);
      result.diagnostics.experimentExists = true;
      console.log("✅ Basic experiment (pod-delete) exists");
    } catch (error) {
      result.valid = false;
      result.diagnostics.message = "Basic experiment (pod-delete) is missing";
      console.log("❌ Basic experiment (pod-delete) is missing");
    }

    return result;
  } catch (error) {
    return {
      valid: false,
      diagnostics: {
        crdsExist: false,
        operatorRunning: false,
        serviceAccountExists: false,
        experimentExists: false,
        message: `Failed to validate chaos resources: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  }
}
