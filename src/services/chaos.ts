import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { join } from 'path';
import { tmpdir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface ChaosTestParams {
  githubUrl: string;
}

export interface ChaosEngineParams {
  targetDeployment: string;
  targetNamespace: string;
  chaosType: string;
  duration: number;
  manifestPath: string;
}

/**
 * Clones a GitHub repository into a temporary directory
 */
export async function cloneRepository(githubUrl: string): Promise<{ repoDir: string, timestamp: number }> {
  const timestamp = Date.now();
  const repoDir = join(tmpdir(), `chaos-test-${timestamp}`);
  
  console.log(`Cloning repository to ${repoDir}...`);
  await execAsync(`git clone ${githubUrl} ${repoDir}`);
  
  return { repoDir, timestamp };
}

/**
 * Sets up or reuses an existing Kind Kubernetes cluster
 */
export async function setupKubernetesCluster(): Promise<void> {
  console.log("Setting up Kubernetes cluster...");
  
  try {
    const clusterCheck = await execAsync(`kind get clusters`);
    const clusters = clusterCheck.stdout.toString().trim().split('\n');
    
    if (!clusters.includes('chaos-test')) {
      console.log("Creating new Kind cluster 'chaos-test'...");
      await execAsync(`kind create cluster --name chaos-test`);
    } else {
      console.log("Using existing 'chaos-test' cluster");
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    if (typeof errorMessage === 'string' && 
        errorMessage.includes("permission denied") && 
        errorMessage.includes("docker.sock")) {
      console.error(`Docker permission error: ${errorMessage}`);
      throw new Error(
        "Docker permission denied. Please try one of these solutions:\n" +
        "1. Add your user to the docker group: sudo usermod -aG docker $USER\n" +
        "2. Log out and log back in, or run: newgrp docker\n" +
        "3. Run the command with sudo (e.g., sudo kind get clusters)\n" +
        "4. Start the application with sudo (not recommended for production)"
      );
    }
    console.error(`Error setting up Kubernetes cluster: ${errorMessage}`);
    throw new Error(`Failed to setup Kubernetes cluster: ${errorMessage}`);
  }
}

/**
 * Deploys an application from Kubernetes manifest files in the repository
 */
export async function deployApplication(repoDir: string): Promise<void> {
  console.log("Deploying application to Kubernetes...");
  
  // Check if this is the Google microservices demo repository
  const isGoogleMicroservicesDemo = await fs.access(path.join(repoDir, 'kubernetes-manifests')).then(() => true).catch(() => false);
  
  let manifestPaths: string[] = [];
  
  if (isGoogleMicroservicesDemo) {
    console.log('Detected Google Microservices Demo repository - using kubernetes-manifests directory');
    // For Google microservices demo, specifically use the kubernetes-manifests directory
    try {
      const k8sManifestsDir = path.join(repoDir, 'kubernetes-manifests');
      const directManifests = await execAsync(`find ${k8sManifestsDir} -name "*.yaml" -o -name "*.yml"`);
      manifestPaths = directManifests.stdout.toString().trim().split('\n').filter(Boolean);
      
      if (manifestPaths.length === 0) {
        throw new Error("No Kubernetes manifest files found in kubernetes-manifests directory");
      }
      
      console.log(`Found ${manifestPaths.length} manifest files in kubernetes-manifests directory`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Error loading kubernetes-manifests: ${errorMessage}`);
      // Fall back to standard search if the specific directory approach fails
    }
  }
  
  // If we don't have manifest paths yet (not Google microservices or that approach failed)
  if (manifestPaths.length === 0) {
    const manifestFiles = await execAsync(`find ${repoDir} -name "*.yaml" -o -name "*.yml"`);
    const allFiles = manifestFiles.stdout.toString().trim().split('\n').filter(Boolean);
    
    if (allFiles.length === 0) {
      throw new Error("No Kubernetes manifest files (yaml/yml) found in the repository");
    }
    
    // Filter out Istio, Knative, and Kustomize manifests
    manifestPaths = allFiles.filter(file => 
      !file.includes("istio") && 
      !file.includes("knative") && 
      !file.includes("kustomize"));
    
    if (manifestPaths.length === 0) {
      throw new Error("No valid Kubernetes manifest files found. Files with istio, knative, or kustomize dependencies are excluded.");
    }
  }
  
  let appliedCount = 0;
  let deploymentErrors = [];
  
  for (const file of manifestPaths) {
    if (file.trim()) {
      console.log(`Applying ${file}...`);
      try {
        await execAsync(`kubectl apply -f ${file}`);
        appliedCount++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log(`Warning: Failed to apply ${file}: ${errorMessage}`);
        deploymentErrors.push({ file, error: errorMessage });
        // Continue with other files
      }
    }
  }
  
  if (appliedCount === 0) {
    throw new Error(`Failed to apply any Kubernetes manifests. First error: ${deploymentErrors[0]?.error || "Unknown error"}`);
  }
  
  console.log(`Successfully applied ${appliedCount} out of ${manifestPaths.length} manifest files`);
  
  // Wait for pods to be ready
  console.log("Waiting for pods to be ready...");
  try {
    await execAsync(`kubectl wait --for=condition=Ready pods --all --timeout=120s`);
  } catch (error) {
    console.log("Warning: Not all pods became ready within timeout");
    // Continue anyway since we want to test chaos scenarios
  }
}

/**
 * Installs LitmusChaos if not already installed
 */
export async function setupLitmusChaos(): Promise<void> {
  console.log("Setting up LitmusChaos...");
  
  try {
    await execAsync(`kubectl get namespace litmus`);
    console.log("LitmusChaos is already installed");
  } catch (error) {
    console.log("Installing LitmusChaos...");
    
    await execAsync(`kubectl apply -f https://litmuschaos.github.io/litmus/litmus-operator-v2.0.0.yaml`);
    await execAsync(`kubectl apply -f https://litmuschaos.github.io/litmus/litmus-operator-latest.yaml`);
    await execAsync(`kubectl apply -f https://hub.litmuschaos.io/api/chaos/master/experiments.yaml`);
    
    // Create a service account for LitmusChaos
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
    
    await execAsync(`kubectl wait --for=condition=Ready pods -l name=chaos-operator -n litmus --timeout=120s`);
  }
}

/**
 * Finds a deployment to target for chaos testing
 */
export async function findTargetDeployment(): Promise<{ targetDeployment: string, targetNamespace: string }> {
  console.log("Finding deployment for chaos testing...");
  
  try {
    // First check if any deployments exist
    const deploymentCheck = await execAsync(`kubectl get deployments --all-namespaces`);
    if (!deploymentCheck.stdout.toString().trim() || deploymentCheck.stdout.toString().includes("No resources found")) {
      console.log("No deployments found. Deploying fallback sample application...");
      await deployFallbackApplication();
    }
    
    // Get the first deployment name
    const deployments = await execAsync(`kubectl get deployments --all-namespaces -o jsonpath='{.items[0].metadata.name}'`);
    const targetDeployment = deployments.stdout.toString().trim();
    
    if (!targetDeployment) {
      throw new Error("No deployments found to run chaos testing against");
    }
    
    // Get the namespace of the first deployment
    const namespaceCmd = await execAsync(`kubectl get deployments --all-namespaces -o jsonpath='{.items[0].metadata.namespace}'`);
    const targetNamespace = namespaceCmd.stdout.toString().trim() || "default";
    
    console.log(`Found target deployment: ${targetDeployment} in namespace ${targetNamespace}`);
    
    return { targetDeployment, targetNamespace };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error finding target deployment: ${errorMessage}`);
    
    if (errorMessage.includes("No deployments found")) {
      throw new Error("No deployments found to run chaos testing against. Ensure your application was properly deployed.");
    } else {
      throw new Error(`Failed to find target deployment: ${errorMessage}`);
    }
  }
}

/**
 * Deploys a fallback application if no deployments are found
 */
async function deployFallbackApplication(): Promise<void> {
  console.log("Deploying fallback nginx application for chaos testing");
  
  const nginxYaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-chaos-test
  namespace: default
  labels:
    app: nginx-chaos-test
spec:
  replicas: 2
  selector:
    matchLabels:
      app: nginx-chaos-test
  template:
    metadata:
      labels:
        app: nginx-chaos-test
    spec:
      containers:
      - name: nginx
        image: nginx:latest
        ports:
        - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: nginx-chaos-test
  namespace: default
spec:
  selector:
    app: nginx-chaos-test
  ports:
  - port: 80
    targetPort: 80
  type: ClusterIP
`;

  const tempYamlPath = join(tmpdir(), `nginx-chaos-test-${Date.now()}.yaml`);
  await fs.writeFile(tempYamlPath, nginxYaml, 'utf-8');
  
  try {
    await execAsync(`kubectl apply -f ${tempYamlPath}`);
    console.log("Waiting for fallback deployment to be ready...");
    await execAsync(`kubectl wait --for=condition=available deployment/nginx-chaos-test --timeout=60s`);
    console.log("Fallback deployment ready");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Failed to deploy fallback application: ${errorMessage}`);
    throw new Error(`Failed to deploy fallback application: ${errorMessage}`);
  } finally {
    // Clean up the temporary file
    await fs.unlink(tempYamlPath).catch(() => {});
  }
}

/**
 * Creates and runs a chaos experiment
 */
export async function runChaosExperiment(params: ChaosEngineParams): Promise<any> {
  const { targetDeployment, targetNamespace, chaosType, duration, manifestPath } = params;
  
  console.log(`Running ${chaosType} chaos experiment...`);
  
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
        console.log("Failed to parse deployment labels, using default");
      }
    }
  } catch (err) {
    console.log("Failed to get deployment labels, using default");
  }
  
  // Create the chaos engine manifest
  await fs.writeFile(manifestPath, `
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: ${targetDeployment}-chaos
  namespace: ${targetNamespace}
spec:
  appinfo:
    appns: ${targetNamespace}
    applabel: "${appLabel}"
    appkind: deployment
  chaosServiceAccount: litmus-admin
  jobCleanUpPolicy: delete
  components:
    runner:
      image: "litmuschaos/chaos-runner:latest"
  experiments:
    - name: ${chaosType}
      spec:
        components:
          env:
            - name: TOTAL_CHAOS_DURATION
              value: '${duration}'
            - name: CHAOS_INTERVAL
              value: '10'
`, 'utf-8');

  try {
    await execAsync(`kubectl apply -f ${manifestPath}`);
    
    console.log(`Waiting for chaos experiment to complete (${duration} seconds)...`);
    await new Promise(resolve => setTimeout(resolve, (duration + 20) * 1000));
    
    const chaosResults = await execAsync(`kubectl get chaosresult ${targetDeployment}-chaos-${chaosType} -n ${targetNamespace} -o json`);
    const resultsJson = JSON.parse(chaosResults.stdout.toString());
    
    try {
      await execAsync(`kubectl wait --for=condition=Ready pods --all -n ${targetNamespace} --timeout=60s`);
    } catch (error) {
      console.log("Warning: Not all pods recovered within timeout");
    }
    
    return resultsJson;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error running chaos experiment: ${errorMessage}`);
    
    // Return a structured error result if we can't get the real results
    return {
      status: {
        verdict: "Failed",
        failStep: "ChaosExperiment execution",
        description: errorMessage
      }
    };
  }
}
