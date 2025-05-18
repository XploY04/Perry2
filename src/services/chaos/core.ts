// Core functionality for chaos testing
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { join } from 'path';
import { tmpdir } from 'os';
import { DeploymentOptions, DeploymentResult } from './types.js';
import { fileExists, directoryContains, waitForPodsReadiness, execAsync } from './utils.js';

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
  console.log("Deploying application to Kubernetes...");
  
  // Find any manifest files
  const appType = await detectApplicationType(repoDir);
  console.log(`Detected application type: ${appType}`);
  const manifestPaths = await findManifestFiles(repoDir, appType);
  
  if (manifestPaths.length === 0) {
    // If no manifests found, deploy a fallback application
    console.log("No Kubernetes manifests found, using fallback application");
    await deployFallbackApplication();
    
    return {
      success: true,
      manifestsApplied: 1,
      totalManifests: 1,
      errors: [],
      warnings: ["Used fallback application as no manifest files were found"],
      appliedFiles: ["fallback-nginx.yaml"],
      namespace: "default"
    };
  }

  // Apply the manifest files
  const namespace = options.namespace || 'default';
  const kubectlBin = options.kubectl || 'kubectl';
  
  // Create namespace if needed
  if (namespace !== 'default') {
    try {
      await execAsync(`${kubectlBin} get namespace ${namespace}`);
    } catch (error) {
      console.log(`Creating namespace ${namespace}...`);
      await execAsync(`${kubectlBin} create namespace ${namespace}`);
    }
  }
  
  let appliedCount = 0;
  const errors: Array<{ file: string; error: string }> = [];
  const warnings: string[] = [];
  const appliedFiles: string[] = [];
  
  // Apply each manifest
  for (const filePath of manifestPaths) {
    try {
      console.log(`Applying manifest: ${filePath}`);
      await execAsync(`${kubectlBin} apply -f ${filePath} --namespace=${namespace}`);
      appliedCount++;
      appliedFiles.push(filePath);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push({ file: filePath, error: errorMessage });
      warnings.push(`Failed to apply manifest: ${filePath}`);
    }
  }
  
  // Wait for pods to be ready
  try {
    await waitForPodsReadiness(namespace, { timeout: 60 });
  } catch (error) {
    warnings.push("Not all pods were ready within timeout period");
  }
  
  return {
    success: appliedCount > 0,
    manifestsApplied: appliedCount,
    totalManifests: manifestPaths.length,
    errors,
    warnings,
    appliedFiles,
    namespace
  };
}

/**
 * Deploys a fallback application if no deployments are found
 */
export async function deployFallbackApplication(): Promise<void> {
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
 * Finds a deployment to target for chaos testing
 */
export async function findTargetDeployment(): Promise<{ targetDeployment: string, targetNamespace: string }> {
  console.log("Finding deployment for chaos testing...");
  
  try {
    // Check if any deployments exist
    const { stdout: deploymentList } = await execAsync(`kubectl get deployments --all-namespaces`);
    
    // If no deployments found, deploy the fallback application
    if (!deploymentList.trim() || deploymentList.includes("No resources found")) {
      console.log("No deployments found. Deploying fallback sample application...");
      await deployFallbackApplication();
      
      return { 
        targetDeployment: "nginx-chaos-test", 
        targetNamespace: "default" 
      };
    }
    
    // Get the deployments using a simplified approach
    const { stdout: jsonOutput } = await execAsync(
      `kubectl get deployments --all-namespaces -o json`
    );
    
    const deployments = JSON.parse(jsonOutput);
    
    if (!deployments.items || deployments.items.length === 0) {
      throw new Error("No deployments found to run chaos testing against");
    }
    
    // Get the first deployment
    const firstDeployment = deployments.items[0];
    const targetDeployment = firstDeployment.metadata.name;
    const targetNamespace = firstDeployment.metadata.namespace || "default";
    
    console.log(`Found target deployment: ${targetDeployment} in namespace ${targetNamespace}`);
    
    return { targetDeployment, targetNamespace };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error finding target deployment: ${errorMessage}`);
    throw new Error(`Failed to find target deployment: ${errorMessage}`);
  }
}

// Export from core.ts these will be re-exported by index.ts
// This export is now removed to avoid circular dependencies
// We'll keep the appropriate exports in index.ts instead
