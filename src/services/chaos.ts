// filepath: /home/yash2004/Documents/Perry2/src/services/chaos.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { tmpdir } from 'os';

const execAsync = promisify(exec);

// ------------------------------------
// Interfaces
// ------------------------------------

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

interface DeploymentOptions {
  namespace?: string;
  kubectl?: string;
  timeout?: number;
  context?: string;
  applyStrategy?: 'normal' | 'strict-order' | 'parallel';
  additionalArgs?: string[];
  dryRun?: boolean;
  waitForReadiness?: boolean;
  logLevel?: 'silent' | 'normal' | 'verbose';
}

interface DeploymentResult {
  success: boolean;
  manifestsApplied: number;
  totalManifests: number;
  errors: Array<{ file: string; error: string }>;
  warnings: string[];
  appliedFiles: string[];
  namespace: string;
}

// ------------------------------------
// Helper Functions
// ------------------------------------

/**
 * Checks if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true).catch(() => false);
}

/**
 * Checks if a directory contains a specific file
 */
async function directoryContains(baseDir: string, subDir: string, fileName: string): Promise<boolean> {
  const targetPath = path.join(baseDir, subDir, fileName);
  return fileExists(targetPath);
}

/**
 * Waits for pods to be ready in the specified namespace
 */
async function waitForPodsReadiness(namespace: string, options: DeploymentOptions): Promise<void> {
  const timeout = options.timeout || 120;
  const kubectlBin = options.kubectl || 'kubectl';
  const contextArg = options.context ? `--context=${options.context}` : '';
  
  console.log(`Waiting for pods to be ready in namespace ${namespace}...`);
  
  try {
    await execAsync(`${kubectlBin} wait --for=condition=Ready pods --all --timeout=${timeout}s --namespace=${namespace} ${contextArg}`);
    console.log("All pods are ready!");
  } catch (error) {
    console.warn("Warning: Not all pods became ready within timeout");
    // Continue anyway as we want to report the status
  }
}

// ------------------------------------
// Repository Management
// ------------------------------------

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

// ------------------------------------
// Kubernetes Cluster Management
// ------------------------------------

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

// ------------------------------------
// Application Detection and Deployment
// ------------------------------------

/**
 * Detects the type of Kubernetes application structure present in the repository
 */
async function detectApplicationType(repoDir: string): Promise<'google-microservices' | 'helm' | 'kustomize' | 'standard'> {
  // Check for Google Microservices Demo
  const hasK8sManifests = await fileExists(path.join(repoDir, 'kubernetes-manifests'));
  if (hasK8sManifests) {
    return 'google-microservices';
  }
  
  // Check for Helm charts
  const hasHelmCharts = await fileExists(path.join(repoDir, 'Chart.yaml')) || 
                         await directoryContains(repoDir, 'charts', 'Chart.yaml');
  if (hasHelmCharts) {
    return 'helm';
  }
  
  // Check for Kustomize
  const hasKustomize = await fileExists(path.join(repoDir, 'kustomization.yaml')) ||
                       await fileExists(path.join(repoDir, 'kustomization.yml')) ||
                       await directoryContains(repoDir, 'base', 'kustomization.yaml') ||
                       await directoryContains(repoDir, 'overlays', 'kustomization.yaml');
  if (hasKustomize) {
    return 'kustomize';
  }
  
  return 'standard';
}

/**
 * Finds Kubernetes manifest files in the repository
 */
async function findManifestFiles(repoDir: string, appType: string): Promise<string[]> {
  let manifestPaths: string[] = [];
  
  switch (appType) {
    case 'google-microservices':
      const k8sManifestsDir = path.join(repoDir, 'kubernetes-manifests');
      try {
        const directManifests = await execAsync(`find ${k8sManifestsDir} -name "*.yaml" -o -name "*.yml"`);
        manifestPaths = directManifests.stdout.toString().trim().split('\n').filter(Boolean);
      } catch (error) {
        // If specific approach fails, will fall back to standard search
      }
      break;
      
    case 'standard':
    default:
      // Fallback to standard search
      try {
        const manifestFiles = await execAsync(`find ${repoDir} -name "*.yaml" -o -name "*.yml"`);
        const allFiles = manifestFiles.stdout.toString().trim().split('\n').filter(Boolean);
        
        // Filter out non-Kubernetes manifests by validating content
        manifestPaths = [];
        for (const file of allFiles) {
          try {
            const content = await fs.readFile(file, 'utf8');
            const doc = yaml.load(content);
            
            // Basic check if it's a Kubernetes manifest
            if (doc && typeof doc === 'object' && 'apiVersion' in doc && 'kind' in doc) {
              manifestPaths.push(file);
            }
          } catch (err) {
            // Skip files that can't be parsed
          }
        }
      } catch (error) {
        // Handle find command failure
        throw new Error(`Failed to search for manifest files: ${error instanceof Error ? error.message : String(error)}`);
      }
      break;
  }
  
  return manifestPaths;
}

/**
 * Sorts manifest files based on Kubernetes resource dependencies
 */
async function sortManifestsByDependency(manifestPaths: string[]): Promise<string[]> {
  // Define order of resource types based on dependencies
  const resourceOrder: { [key: string]: number } = {
    'Namespace': 0,
    'NetworkPolicy': 1,
    'ResourceQuota': 2,
    'LimitRange': 3, 
    'PodSecurityPolicy': 4,
    'Secret': 5,
    'ConfigMap': 6,
    'StorageClass': 7,
    'PersistentVolume': 8,
    'PersistentVolumeClaim': 9,
    'ServiceAccount': 10,
    'CustomResourceDefinition': 11,
    'ClusterRole': 12,
    'ClusterRoleBinding': 13,
    'Role': 14,
    'RoleBinding': 15,
    'Service': 16,
    'StatefulSet': 17,
    'Deployment': 18,
    'DaemonSet': 19,
    'Job': 20,
    'CronJob': 21,
    'Ingress': 22,
    'HorizontalPodAutoscaler': 23
  };
  
  // Build an array of [path, priority] tuples
  const manifestsWithPriority: Array<[string, number]> = [];
  
  for (const filePath of manifestPaths) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const docs = Array.isArray(yaml.loadAll(content)) ? yaml.loadAll(content) : [yaml.load(content)];
      
      // Find the highest priority (lowest number) in the file
      let highestPriority = Number.MAX_SAFE_INTEGER;
      
      for (const doc of docs) {
        if (doc && typeof doc === 'object' && 'kind' in doc) {
          const kind = doc.kind as string;
          const priority = kind in resourceOrder ? resourceOrder[kind] : 999;
          highestPriority = Math.min(highestPriority, priority);
        }
      }
      
      manifestsWithPriority.push([filePath, highestPriority]);
    } catch (err) {
      // If we can't parse, assign a default high priority
      manifestsWithPriority.push([filePath, 999]);
    }
  }
  
  // Sort by priority
  manifestsWithPriority.sort((a, b) => a[1] - b[1]);
  
  // Return just the paths
  return manifestsWithPriority.map(item => item[0]);
}

// ------------------------------------
// Helm Deployment
// ------------------------------------

/**
 * Find the path to a Helm chart in the repository
 */
async function findHelmChartPath(repoDir: string): Promise<string> {
  // Check if the repo directory itself is a chart
  if (await fileExists(path.join(repoDir, 'Chart.yaml'))) {
    return repoDir;
  }
  
  // Check if there's a charts directory
  const chartsDir = path.join(repoDir, 'charts');
  if (await fileExists(chartsDir)) {
    try {
      const entries = await fs.readdir(chartsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const chartFile = path.join(chartsDir, entry.name, 'Chart.yaml');
          if (await fileExists(chartFile)) {
            return path.join(chartsDir, entry.name);
          }
        }
      }
    } catch (err) {
      // Continue to next check if this fails
    }
  }
  
  // Recursively look for Chart.yaml files, but not too deep
  try {
    const { stdout } = await execAsync(`find ${repoDir} -maxdepth 3 -name "Chart.yaml"`);
    const chartFiles = stdout.trim().split('\n').filter(Boolean);
    
    if (chartFiles.length > 0) {
      // Return the directory containing the first Chart.yaml
      return path.dirname(chartFiles[0]);
    }
  } catch (err) {
    // Continue if find command fails
  }
  
  return '';
}

/**
 * Execute a deployment for a Helm chart
 */
async function deployHelm(
  repoDir: string, 
  options: DeploymentOptions
): Promise<DeploymentResult> {
  const chartPath = await findHelmChartPath(repoDir);
  if (!chartPath) {
    throw new Error("Could not locate valid Helm chart in repository");
  }

  const releaseName = path.basename(repoDir).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const namespace = options.namespace || 'default';
  const timeoutArg = options.timeout ? `--timeout ${options.timeout}s` : '';
  const contextArg = options.context ? `--kube-context ${options.context}` : '';
  const namespaceArg = `--namespace ${namespace}`;
  const dryRunArg = options.dryRun ? '--dry-run' : '';
  const additionalArgs = options.additionalArgs ? options.additionalArgs.join(' ') : '';

  const command = `helm upgrade --install ${releaseName} ${chartPath} ${namespaceArg} ${timeoutArg} ${contextArg} ${dryRunArg} ${additionalArgs}`;
  
  if (options.logLevel === 'verbose') {
    console.log(`Executing command: ${command}`);
  }

  try {
    const result = await execAsync(command);
    console.log(result.stdout);
    
    if (options.waitForReadiness && !options.dryRun) {
      await waitForPodsReadiness(namespace, options);
    }
    
    return {
      success: true,
      manifestsApplied: 1, // Helm chart counts as one "manifest"
      totalManifests: 1,
      errors: [],
      warnings: [],
      appliedFiles: [chartPath],
      namespace
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      manifestsApplied: 0,
      totalManifests: 1,
      errors: [{ file: chartPath, error: errorMessage }],
      warnings: [],
      appliedFiles: [],
      namespace
    };
  }
}

// ------------------------------------
// Kustomize Deployment
// ------------------------------------

/**
 * Find the path to a Kustomization file in the repository
 */
async function findKustomizationPath(repoDir: string): Promise<string> {
  // Check common locations for kustomization files
  const possiblePaths = [
    path.join(repoDir, 'kustomization.yaml'),
    path.join(repoDir, 'kustomization.yml'),
    path.join(repoDir, 'base', 'kustomization.yaml'),
    path.join(repoDir, 'overlays', 'dev', 'kustomization.yaml'),
    path.join(repoDir, 'overlays', 'prod', 'kustomization.yaml')
  ];
  
  for (const p of possiblePaths) {
    if (await fileExists(p)) {
      return p;
    }
  }
  
  // Recursively look for kustomization files, but not too deep
  try {
    const { stdout } = await execAsync(`find ${repoDir} -maxdepth 3 -name "kustomization.yaml" -o -name "kustomization.yml"`);
    const kustomizationFiles = stdout.trim().split('\n').filter(Boolean);
    
    if (kustomizationFiles.length > 0) {
      return kustomizationFiles[0];
    }
  } catch (err) {
    // Continue if find command fails
  }
  
  return '';
}

/**
 * Execute a deployment for Kustomize
 */
async function deployKustomize(
  repoDir: string, 
  options: DeploymentOptions
): Promise<DeploymentResult> {
  const kustomizationPath = await findKustomizationPath(repoDir);
  if (!kustomizationPath) {
    throw new Error("Could not locate valid kustomization.yaml in repository");
  }

  const namespace = options.namespace || 'default';
  const kubectlBin = options.kubectl || 'kubectl';
  const contextArg = options.context ? `--context=${options.context}` : '';
  const namespaceArg = `--namespace=${namespace}`;
  const dryRunArg = options.dryRun ? '--dry-run=client' : '';
  const additionalArgs = options.additionalArgs ? options.additionalArgs.join(' ') : '';

  // Use kustomize build and pipe to kubectl apply
  const kustomizeDir = path.dirname(kustomizationPath);
  const command = `kustomize build ${kustomizeDir} | ${kubectlBin} apply -f - ${contextArg} ${namespaceArg} ${dryRunArg} ${additionalArgs}`;
  
  if (options.logLevel === 'verbose') {
    console.log(`Executing command: ${command}`);
  }

  try {
    const result = await execAsync(command);
    console.log(result.stdout);
    
    // Count the number of resources applied
    const appliedMatches = result.stdout.match(/configured|created|unchanged/g);
    const appliedCount = appliedMatches ? appliedMatches.length : 0;
    
    if (options.waitForReadiness && !options.dryRun) {
      await waitForPodsReadiness(namespace, options);
    }
    
    return {
      success: true,
      manifestsApplied: appliedCount,
      totalManifests: appliedCount, // We don't know the exact count before applying
      errors: [],
      warnings: [],
      appliedFiles: [kustomizationPath],
      namespace
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      manifestsApplied: 0,
      totalManifests: 1,
      errors: [{ file: kustomizationPath, error: errorMessage }],
      warnings: [],
      appliedFiles: [],
      namespace
    };
  }
}

// ------------------------------------
// Standard Kubernetes Deployment
// ------------------------------------

/**
 * Apply Kubernetes manifests in the correct order
 */
async function applyManifests(
  manifestPaths: string[], 
  options: DeploymentOptions
): Promise<DeploymentResult> {
  const namespace = options.namespace || 'default';
  const kubectlBin = options.kubectl || 'kubectl';
  const contextArg = options.context ? `--context=${options.context}` : '';
  const namespaceArg = `--namespace=${namespace}`;
  const dryRunArg = options.dryRun ? '--dry-run=client' : '';
  const additionalArgs = options.additionalArgs ? options.additionalArgs.join(' ') : '';
  
  // Create namespace if it doesn't exist and isn't default
  if (namespace !== 'default' && !options.dryRun) {
    try {
      await execAsync(`${kubectlBin} get namespace ${namespace} ${contextArg}`);
    } catch (error) {
      console.log(`Creating namespace ${namespace}...`);
      try {
        await execAsync(`${kubectlBin} create namespace ${namespace} ${contextArg}`);
      } catch (nsError) {
        console.warn(`Warning: Failed to create namespace ${namespace}`);
      }
    }
  }
  
  let manifestsWithDependencies: string[] = manifestPaths;
  
  // Sort manifests by dependency if using strict-order strategy
  if (options.applyStrategy === 'strict-order') {
    manifestsWithDependencies = await sortManifestsByDependency(manifestPaths);
  }
  
  let appliedCount = 0;
  const errors: Array<{ file: string; error: string }> = [];
  const warnings: string[] = [];
  const appliedFiles: string[] = [];
  
  // Apply manifests based on the selected strategy
  if (options.applyStrategy === 'parallel' && manifestsWithDependencies.length > 0) {
    // Apply all manifests in parallel
    const applyPromises = manifestsWithDependencies.map(async (file) => {
      if (options.logLevel !== 'silent') {
        console.log(`Applying ${file}...`);
      }
      
      try {
        await execAsync(`${kubectlBin} apply -f ${file} ${contextArg} ${namespaceArg} ${dryRunArg} ${additionalArgs}`);
        return { success: true, file };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { success: false, file, error: errorMessage };
      }
    });
    
    const results = await Promise.all(applyPromises);
    
    for (const result of results) {
      if (result.success) {
        appliedCount++;
        appliedFiles.push(result.file);
      } else {
        errors.push({ file: result.file, error: result.error || "Unknown error" });
        if (options.logLevel !== 'silent') {
          console.warn(`Warning: Failed to apply ${result.file}: ${result.error}`);
        }
      }
    }
  } else {
    // Apply manifests sequentially
    for (const file of manifestsWithDependencies) {
      if (file.trim()) {
        if (options.logLevel !== 'silent') {
          console.log(`Applying ${file}...`);
        }
        
        try {
          await execAsync(`${kubectlBin} apply -f ${file} ${contextArg} ${namespaceArg} ${dryRunArg} ${additionalArgs}`);
          appliedCount++;
          appliedFiles.push(file);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (options.logLevel !== 'silent') {
            console.warn(`Warning: Failed to apply ${file}: ${errorMessage}`);
          }
          errors.push({ file, error: errorMessage });
          // Continue with other files
        }
      }
    }
  }
  
  // Wait for pods to be ready if requested
  if (options.waitForReadiness && appliedCount > 0 && !options.dryRun) {
    try {
      await waitForPodsReadiness(namespace, options);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      warnings.push(`Not all pods became ready: ${errorMessage}`);
    }
  }
  
  return {
    success: appliedCount > 0,
    manifestsApplied: appliedCount,
    totalManifests: manifestsWithDependencies.length,
    errors,
    warnings,
    appliedFiles,
    namespace
  };
}

/**
 * Deploys an application to Kubernetes
 * @param repoDir Directory containing the application code and Kubernetes manifests
 * @param options Deployment options
 * @returns DeploymentResult with details of the deployment
 */
export async function deployApplication(
  repoDir: string, 
  options: DeploymentOptions = {}
): Promise<DeploymentResult> {
  if (options.logLevel !== 'silent') {
    console.log("Deploying application to Kubernetes...");
  }
  
  // Determine the type of application we're dealing with
  const appType = await detectApplicationType(repoDir);
  
  if (options.logLevel === 'verbose') {
    console.log(`Detected application type: ${appType}`);
  }
  
  // Handle deployment based on application type
  switch (appType) {
    case 'helm':
      return deployHelm(repoDir, options);
      
    case 'kustomize':
      return deployKustomize(repoDir, options);
      
    case 'google-microservices':
    case 'standard':
    default:
      // Find manifest files
      const manifestPaths = await findManifestFiles(repoDir, appType);
      
      if (manifestPaths.length === 0) {
        throw new Error("No valid Kubernetes manifest files found in the repository");
      }
      
      if (options.logLevel === 'verbose') {
        console.log(`Found ${manifestPaths.length} manifest files`);
      }
      
      // Apply the manifests
      return applyManifests(manifestPaths, options);
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

// ------------------------------------
// Chaos Testing Functions
// ------------------------------------

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
    const { stdout: pods } = await execAsync(`kubectl get pods -n litmus -l name=chaos-operator`);
    if (pods && !pods.includes("No resources found")) {
      console.log("✅ LitmusChaos operator is running");
      litmusAlreadyInstalled = true;

      // Verify all CRDs are properly installed
      const crdChecks = await Promise.allSettled([
        execAsync(`kubectl get crd chaosengines.litmuschaos.io`),
        execAsync(`kubectl get crd chaosexperiments.litmuschaos.io`),
        execAsync(`kubectl get crd chaosresults.litmuschaos.io`)
      ]);
      
      const allCrdsExist = crdChecks.every(result => result.status === 'fulfilled');
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
        console.log("❌ Some LitmusChaos CRDs are missing, will reinstall them");
      }
    } else {
      console.log("❌ LitmusChaos namespace exists but operator is not running");
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
          await execAsync(`kubectl apply -f https://litmuschaos.github.io/litmus/litmus-operator-latest.yaml`);
        } catch (operatorError) {
          console.log("Failed to fetch operator from primary URL, trying alternative sources...");
          
          try {
            await execAsync(`kubectl apply -f https://litmuschaos.github.io/litmus/litmus-operator-v2.0.0.yaml`);
          } catch (v2Error) {
            console.log("Failed to fetch operator from v2 URL, trying v1.13...");
            
            try {
              await execAsync(`kubectl apply -f https://litmuschaos.github.io/litmus/litmus-operator-v1.13.8.yaml`);
            } catch (v1Error) {
              console.log("All external sources failed, applying operator manually");
              
              // Create the namespace ourselves since the yaml fetching failed
              await execAsync(`kubectl create namespace litmus`).catch(() => console.log("Namespace might already exist"));
              
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
          await execAsync(`kubectl wait --for=condition=Ready pods -l name=chaos-operator -n litmus --timeout=120s`);
          console.log("✅ LitmusChaos operator is ready");
        } catch (waitError) {
          console.warn("Warning: Timed out waiting for operator to be ready, continuing anyway...");
        }
      } catch (error) {
        console.error("Error installing LitmusChaos operator:", error);
        throw new Error(`Failed to install LitmusChaos operator: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    // Install all required CRDs
    console.log("Installing or verifying LitmusChaos CRDs...");
    const crdsResult = await installLitmusChaosCustomResourceDefinitions();
    if (!crdsResult.success) {
      throw new Error(`Failed to install LitmusChaos CRDs: ${crdsResult.error}`);
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
    throw new Error("LitmusChaos installation verification failed. The required components are not properly installed.");
  }
}

/**
 * Installs LitmusChaos Custom Resource Definitions
 */
async function installLitmusChaosCustomResourceDefinitions(): Promise<{success: boolean, error?: string}> {
  try {
    // First try to fetch and apply from the official URL
    try {
      await execAsync(`kubectl apply -f https://raw.githubusercontent.com/litmuschaos/litmus/master/litmus-portal/manifests/litmus/crds/chaosengine_crd.yaml`);
      console.log("Applied chaosengine CRD from GitHub");
    } catch (error) {
      console.log("Failed to apply chaosengine CRD from GitHub, applying manually");
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
      await execAsync(`kubectl apply -f https://raw.githubusercontent.com/litmuschaos/litmus/master/litmus-portal/manifests/litmus/crds/chaosexperiment_crd.yaml`);
      console.log("Applied chaosexperiment CRD from GitHub");
    } catch (error) {
      console.log("Failed to apply chaosexperiment CRD from GitHub, applying manually");
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
      await execAsync(`kubectl apply -f https://raw.githubusercontent.com/litmuschaos/litmus/master/litmus-portal/manifests/litmus/crds/chaosresult_crd.yaml`);
      console.log("Applied chaosresult CRD from GitHub");
    } catch (error) {
      console.log("Failed to apply chaosresult CRD from GitHub, applying manually");
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
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    return { success: true };
  } catch (error) {
    console.error("Error installing CRDs:", error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : String(error)
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
      const { stdout } = await execAsync(`kubectl get chaosexperiment pod-delete -o yaml`);
      if (stdout && !stdout.includes("error")) {
        console.log("Pod-delete experiment already exists, validating it...");
        
        // Try to get a simple attribute to validate the experiment works
        try {
          const { stdout: podDeleteJson } = await execAsync(`kubectl get chaosexperiment pod-delete -o json`);
          const podDeleteObj = JSON.parse(podDeleteJson);
          
          // Check if the experiment has valid structure
          if (podDeleteObj?.spec?.definition?.image) {
            console.log("✅ Existing pod-delete experiment is valid");
            return; // Exit early if the experiment exists and is valid
          } else {
            console.log("⚠️ Existing pod-delete experiment has invalid structure, will reinstall");
          }
        } catch (parseError) {
          console.log("⚠️ Could not validate existing pod-delete experiment, will reinstall");
        }
      }
    } catch (error) {
      console.log("Pod-delete experiment does not exist, will install it");
    }
    
    // First try to fetch the pod-delete experiment from the official URL
    try {
      await execAsync(`kubectl apply -f https://hub.litmuschaos.io/api/chaos/2.0.0/experiments/pod-delete/pod-delete.yaml`);
      console.log("Applied pod-delete experiment from LitmusChaos Hub");
      
      // Verify the experiment was created successfully
      try {
        await execAsync(`kubectl get chaosexperiment pod-delete`);
        console.log("✅ Successfully verified pod-delete experiment from Hub");
        return;
      } catch (verifyError) {
        console.log("⚠️ Hub installation succeeded but verification failed, trying alternative schema");
      }
    } catch (error) {
      console.log("Failed to get pod-delete experiment from LitmusChaos Hub, installing it directly");
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
      console.log("✅ Successfully verified pod-delete installation with rbac schema");
      return;
    } catch (rbacError) {
      console.log("❌ Failed to install pod-delete with rbac schema, trying legacy permissions format...");
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

      console.log("Pod-delete experiment installed with simplified schema (no permissions)");
      
      // Verify installation
      await execAsync(`kubectl get chaosexperiment pod-delete`);
      console.log("✅ Successfully verified simplified pod-delete installation");
    } catch (simpleError) {
      console.error("❌ All pod-delete installation attempts failed:", simpleError);
      throw new Error("Failed to install pod-delete experiment with any schema format");
    }
  } catch (error) {
    console.error("Error installing pod-delete experiment:", error);
    throw new Error(`Failed to install pod-delete experiment: ${error instanceof Error ? error.message : String(error)}`);
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
 * Creates and runs a chaos experiment
 */
export async function runChaosExperiment(params: ChaosEngineParams): Promise<any> {
  const { targetDeployment, targetNamespace, chaosType, duration, manifestPath } = params;
  
  console.log(`Running ${chaosType} chaos experiment against ${targetDeployment} in namespace ${targetNamespace}...`);
  
  // First, verify that the chaos experiment is properly installed
  try {
    console.log("Verifying chaos experiment is properly installed...");
    const { stdout: expStatus } = await execAsync(`kubectl get chaosexperiment ${chaosType} -o json || echo "not found"`);
    
    if (expStatus.includes("not found")) {
      console.log(`⚠️ Chaos experiment '${chaosType}' not found, attempting to install it...`);
      // Try to install the pod-delete experiment if that's what we're using
      if (chaosType === "pod-delete") {
        await installPodDeleteExperiment();
      } else {
        throw new Error(`Chaos experiment '${chaosType}' is not installed. Only pod-delete is supported for auto-installation.`);
      }
    } else {
      // Check if the experiment is valid by parsing the JSON
      try {
        const exp = JSON.parse(expStatus);
        console.log(`✅ Chaos experiment '${chaosType}' is installed. Image: ${exp.spec?.definition?.image || 'unknown'}`);
      } catch (jsonError) {
        console.log(`⚠️ Warning: Could not parse chaos experiment definition. It may be invalid.`);
      }
    }
  } catch (expError) {
    console.error(`Error verifying chaos experiment: ${expError instanceof Error ? expError.message : String(expError)}`);
    throw new Error(`Failed to verify chaos experiment: ${expError instanceof Error ? expError.message : String(expError)}`);
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
        console.log("Failed to parse deployment labels, using default app label");
      }
    }
  } catch (err) {
    console.log("Failed to get deployment labels, using default app label");
  }
  
  const timestamp = Date.now();
  const engineName = `${targetDeployment}-chaos-${timestamp}`;
  
  // Create the chaos engine manifest with enhanced configuration
  await fs.writeFile(manifestPath, `
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
`, 'utf-8');

  try {
    console.log(`Applying chaos engine manifest: ${manifestPath}`);
    
    // First, check if we can access the chaos engine CRD
    try {
      await execAsync(`kubectl get crd chaosengines.litmuschaos.io`);
      console.log("✅ ChaosEngine CRD is accessible");
    } catch (crdError) {
      console.error("❌ ChaosEngine CRD is not accessible, attempting to reinstall LitmusChaos CRDs");
      // Try to reinstall the CRDs
      const crdsResult = await installLitmusChaosCustomResourceDefinitions();
      if (!crdsResult.success) {
        throw new Error(`Failed to reinstall ChaosEngine CRD: ${crdsResult.error}`);
      }
      console.log("✅ Successfully reinstalled LitmusChaos CRDs");
      
      // Wait for the CRDs to be available
      await new Promise(resolve => setTimeout(resolve, 5000));
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
    
    console.log(`Waiting for chaos experiment to complete (${duration} seconds)...`);
    
    // Wait for chaos engine to be created
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Check if chaos engine is created properly
    try {
      const { stdout: engineStatus } = await execAsync(`kubectl get chaosengine ${engineName} -n ${targetNamespace} -o yaml`);
      console.log("✅ Chaos engine created successfully");
      
      // Check for any warnings or errors in the status
      if (engineStatus.includes("error") || engineStatus.includes("Error") || engineStatus.includes("failed") || engineStatus.includes("Failed")) {
        console.warn("⚠️ Chaos engine may have issues. Status contains error indicators.");
        console.log("Engine Status excerpt:", engineStatus.substring(0, 500) + "...");
      }
    } catch (error) {
      console.error("❌ Failed to create chaos engine");
      throw new Error(`Failed to create chaos engine: ${error instanceof Error ? error.message : String(error)}`);
    }
    
    // Wait for experiment pod to be spawned
    console.log("Waiting for experiment pod to be created...");
    
    let experimentPodName = "";
    let retries = 0;
    const maxRetries = 10;
    
    while (retries < maxRetries) {
      try {
        const { stdout: podList } = await execAsync(
          `kubectl get pods -n ${targetNamespace} -l chaosengine=${engineName} --no-headers -o custom-columns=":metadata.name"`
        );
        
        if (podList && podList.trim()) {
          experimentPodName = podList.trim().split('\n')[0];
          console.log(`Found experiment pod: ${experimentPodName}`);
          break;
        }
      } catch (error) {
        // Just continue to retry
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      retries++;
    }
    
    if (!experimentPodName) {
      console.log("Could not find experiment pod after multiple attempts, continuing...");
    } else {
      // Follow pod logs in the background for diagnostic purposes
      try {
        const logProcess = exec(`kubectl logs -f ${experimentPodName} -n ${targetNamespace}`);
        logProcess.stdout?.on('data', (data) => {
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
    await new Promise(resolve => setTimeout(resolve, (duration + 20) * 1000));
    
    // Check for the pod-delete experiment CRD one more time to ensure it's still there
    try {
      await execAsync(`kubectl get chaosexperiment ${chaosType}`);
      console.log(`✅ ${chaosType} experiment is still available`);
    } catch (error) {
      console.error(`❌ ${chaosType} experiment is no longer available! Re-installing...`);
      if (chaosType === "pod-delete") {
        await installPodDeleteExperiment();
      }
    }
    
    // Get the experiment result using multiple methods for resilience
    let resultsJson = null;
    const possibleResultNames = [
      `${engineName}-${chaosType}`,
      `${targetDeployment}-chaos-${chaosType}`,
      `${engineName}`
    ];
    
    // Print current chaos results
    try {
      const { stdout: availableResults } = await execAsync(`kubectl get chaosresults -n ${targetNamespace}`);
      console.log("Available chaos results:", availableResults);
    } catch (error) {
      console.log("No chaos results found");
    }
    
    for (const resultName of possibleResultNames) {
      try {
        console.log(`Trying to get results with name: ${resultName}`);
        const chaosResults = await execAsync(`kubectl get chaosresult ${resultName} -n ${targetNamespace} -o json`);
        resultsJson = JSON.parse(chaosResults.stdout.toString());
        console.log(`✅ Found results with name: ${resultName}`);
        break;
      } catch (error) {
        console.log(`Could not find results with name: ${resultName}`);
      }
    }
    
    // If all specific names failed, try listing all results and find a match
    if (!resultsJson) {
      try {
        console.log("Searching for any matching chaos results...");
        const allResults = await execAsync(`kubectl get chaosresults -n ${targetNamespace} -o json`);
        const resultsData = JSON.parse(allResults.stdout.toString());
        
        if (resultsData && resultsData.items && resultsData.items.length > 0) {
          // Find most recent result by creation timestamp
          const matchingResults = resultsData.items
            .filter((item: any) => 
              item.metadata.name.includes(targetDeployment) || 
              item.metadata.name.includes(chaosType) ||
              item.metadata.name.includes("chaos")
            )
            .sort((a: any, b: any) => 
              new Date(b.metadata.creationTimestamp).getTime() - 
              new Date(a.metadata.creationTimestamp).getTime()
            );
          
          if (matchingResults.length > 0) {
            resultsJson = matchingResults[0];
            console.log(`Found matching result: ${resultsJson.metadata.name}`);
          }
        }
      } catch (error) {
        console.log("Failed to list and search all chaos results");
      }
    }
    
    // Get engine status if we couldn't find results
    if (!resultsJson) {
      console.log("Could not find chaos results, getting engine status instead...");
      try {
        const engineStatus = await execAsync(`kubectl get chaosengine ${engineName} -n ${targetNamespace} -o json`);
        const engineData = JSON.parse(engineStatus.stdout.toString());
        
        resultsJson = {
          kind: "ChaosResult",
          metadata: {
            name: engineName,
            namespace: targetNamespace
          },
          status: {
            experimentStatus: {
              phase: engineData.status?.engineStatus || "Completed",
              verdict: "Awaited", // We don't have a clear verdict
              failStep: "N/A"
            }
          },
          engineStatus: engineData.status
        };
        
        console.log("Created result data from engine status");
      } catch (error) {
        console.log("Could not get chaos engine status either");
        
        // Create a minimal result so we don't fail completely
        resultsJson = {
          kind: "ChaosResult",
          metadata: {
            name: engineName,
            namespace: targetNamespace
          },
          status: {
            experimentStatus: {
              phase: "Completed",
              verdict: "Awaited",
              failStep: "Result retrieval"
            },
            diagnosticInfo: {
              engine: engineName,
              target: targetDeployment,
              namespace: targetNamespace,
              chaosType: chaosType
            }
          }
        };
      }
    }
    
    // Wait for pods to recover and be ready
    try {
      console.log("Waiting for pods to recover...");
      await execAsync(`kubectl wait --for=condition=Ready pods --selector=${appLabel} -n ${targetNamespace} --timeout=60s`);
      console.log("✅ All pods recovered successfully");
    } catch (error) {
      console.log("⚠️ Warning: Not all pods recovered within timeout");
      
      // Add recovery information to results
      if (resultsJson && resultsJson.status) {
        resultsJson.status.recoveryInfo = {
          status: "Incomplete",
          message: "Not all pods recovered within timeout period"
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
      appliedManifest: manifestPath
    };
    
    try {
      const { stdout: engineStatus } = await execAsync(`kubectl get chaosengine ${engineName} -n ${targetNamespace} -o yaml`);
      // Use direct property assignment instead of object spread
      (diagnosticInfo as any).engineStatus = engineStatus;
    } catch (e) {
      // Ignore errors in getting diagnostic info
    }
    
    // Return a structured error result
    return {
      status: {
        verdict: "Failed",
        failStep: "ChaosExperiment execution",
        description: errorMessage,
        diagnosticInfo
      }
    };
  }
}

/**
 * Validates all ChaosExperiment related resources and returns diagnostic information
 */
export async function validateChaosResources(): Promise<{ valid: boolean, diagnostics: Record<string, any> }> {
  const diagnostics: Record<string, any> = {};
  let valid = true;
  
  try {
    // Check CRDs
    const crdPromises = [
      execAsync('kubectl get crd chaosengines.litmuschaos.io'),
      execAsync('kubectl get crd chaosexperiments.litmuschaos.io'),
      execAsync('kubectl get crd chaosresults.litmuschaos.io')
    ];
    
    const crdResults = await Promise.allSettled(crdPromises);
    diagnostics.crds = {
      chaosengines: crdResults[0].status === 'fulfilled',
      chaosexperiments: crdResults[1].status === 'fulfilled',
      chaosresults: crdResults[2].status === 'fulfilled'
    };
    
    if (crdResults.some(result => result.status === 'rejected')) {
      valid = false;
      diagnostics.crds.error = "Some LitmusChaos CRDs are missing";
    }
    
    // Check pod-delete experiment
    try {
      const { stdout: podDeleteStatus } = await execAsync('kubectl get chaosexperiment pod-delete -o json');
      const podDeleteObj = JSON.parse(podDeleteStatus);
      diagnostics.podDeleteExperiment = {
        exists: true,
        image: podDeleteObj.spec?.definition?.image || 'unknown',
        hasRbacOrPermissions: !!(
          podDeleteObj.spec?.definition?.rbac || 
          podDeleteObj.spec?.definition?.permissions
        ),
        scope: podDeleteObj.spec?.definition?.scope || 'unknown'
      };
    } catch (error) {
      diagnostics.podDeleteExperiment = {
        exists: false,
        error: error instanceof Error ? error.message : String(error)
      };
      valid = false;
    }
    
    // Check service account
    try {
      const { stdout: saExists } = await execAsync('kubectl get serviceaccount litmus-admin');
      diagnostics.serviceAccount = {
        exists: !!saExists,
        name: 'litmus-admin'
      };
    } catch (error) {
      diagnostics.serviceAccount = {
        exists: false,
        error: error instanceof Error ? error.message : String(error)
      };
      valid = false;
    }
    
  } catch (error) {
    diagnostics.overallError = error instanceof Error ? error.message : String(error);
    valid = false;
  }
  
  return { valid, diagnostics };
}
