#!/usr/bin/env node

/**
 * Command line tool for running chaos tests against Kubernetes deployments
 * 
 * Usage:
 *   node chaos-test.js [options]
 * 
 * Options:
 *   --github-url <url>        GitHub repository URL containing Kubernetes manifests
 *   --chaos-type <type>       Type of chaos test to run (default: pod-delete)
 *                             Options: pod-delete, network-latency, network-loss, 
 *                             network-corruption, disk-fill, node-io-stress
 *   --duration <seconds>      Duration of chaos test in seconds (default: 30)
 *   --namespace <namespace>   Target namespace (default: auto-detect)
 *   --deployment <name>       Target deployment (default: auto-detect)
 *   --io-percentage <num>     IO stress percentage for node-io-stress (default: 10)
 *   --network-latency <ms>    Network latency in ms for network-latency (default: 200)
 *   --network-loss <percent>  Network packet loss percentage for network-loss (default: 10)
 * 
 * Example:
 *   node chaos-test.js --github-url https://github.com/user/app --chaos-type pod-delete --duration 60
 *   node chaos-test.js --github-url https://github.com/user/app --chaos-type disk-fill --duration 120
 *   node chaos-test.js --github-url https://github.com/user/app --chaos-type node-io-stress --io-percentage 20
 */

const { 
  cloneRepository, 
  setupKubernetesCluster, 
  deployApplication,
  setupLitmusChaos,
  findTargetDeployment,
  runChaosExperiment,
  runPodDeleteExperiment,
  runPodKillExperiment,
  runContainerKillExperiment,
  runNetworkLatencyExperiment,
  runNetworkLossExperiment,
  runNetworkCorruptionExperiment,
  runDiskFillExperiment,
  runIOStressExperiment,
  validateChaosResources
} = require('../dist/services/chaos/index.js');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  githubUrl: '',
  chaosType: 'pod-delete',
  duration: 30,
  namespace: '',
  deployment: '',
  ioPercentage: 10,
  networkLatency: 200,
  networkLossPercentage: 10,
  fillPercentage: 80
};

// Parse command line arguments
for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--github-url':
      options.githubUrl = args[++i];
      break;
    case '--chaos-type':
      options.chaosType = args[++i];
      break;
    case '--duration':
      options.duration = parseInt(args[++i], 10);
      break;
    case '--namespace':
      options.namespace = args[++i];
      break;
    case '--deployment':
      options.deployment = args[++i];
      break;
    case '--io-percentage':
      options.ioPercentage = parseInt(args[++i], 10);
      break;
    case '--network-latency':
      options.networkLatency = parseInt(args[++i], 10);
      break;
    case '--network-loss':
      options.networkLossPercentage = parseInt(args[++i], 10);
      break;
    case '--fill-percentage':
      options.fillPercentage = parseInt(args[++i], 10);
      break;
    case '--help':
      console.log(`
Command line tool for running chaos tests against Kubernetes deployments

Usage:
  node chaos-test.js [options]

Options:
  --github-url <url>        GitHub repository URL containing Kubernetes manifests
  --chaos-type <type>       Type of chaos test to run (default: pod-delete)
                            Options: pod-delete, network-latency, network-loss, 
                            network-corruption, disk-fill, node-io-stress
  --duration <seconds>      Duration of chaos test in seconds (default: 30)
  --namespace <namespace>   Target namespace (default: auto-detect)
  --deployment <name>       Target deployment (default: auto-detect)
  --io-percentage <num>     IO stress percentage for node-io-stress (default: 10)
  --network-latency <ms>    Network latency in ms for network-latency (default: 200)
  --network-loss <percent>  Network packet loss percentage for network-loss (default: 10)
  --fill-percentage <percent> Disk fill percentage for disk-fill (default: 80)

Example:
  node chaos-test.js --github-url https://github.com/user/app --chaos-type pod-delete --duration 60
  node chaos-test.js --github-url https://github.com/user/app --chaos-type disk-fill --fill-percentage 70
  node chaos-test.js --github-url https://github.com/user/app --chaos-type node-io-stress --io-percentage 20
`);
      process.exit(0);
    default:
      console.error(`Unknown option: ${args[i]}`);
      process.exit(1);
  }
}

// Validate required options
if (!options.githubUrl) {
  console.error('Error: --github-url is required');
  process.exit(1);
}

// Run the chaos test
async function runChaosTest() {
  try {
    console.log(`Starting chaos test for repo: ${options.githubUrl}`);
    console.log(`Chaos type: ${options.chaosType}`);
    console.log(`Duration: ${options.duration} seconds`);
    
    // 1. Clone the GitHub repository
    const { repoDir, timestamp } = await cloneRepository(options.githubUrl);
    console.log(`✅ Cloned repository to ${repoDir}`);

    // 2. Create a Kind cluster if it doesn't exist
    await setupKubernetesCluster();
    console.log(`✅ Kubernetes cluster ready`);

    // 3. Apply Kubernetes manifests from the repo
    const deployResult = await deployApplication(repoDir);
    console.log(`✅ Deployed ${deployResult.manifestsApplied}/${deployResult.totalManifests} manifests to ${deployResult.namespace} namespace`);

    // 4. Install LitmusChaos if not already installed
    await setupLitmusChaos();
    console.log(`✅ LitmusChaos framework ready`);

    // 5. Get the deployment to target for chaos
    let targetDeployment, targetNamespace;
    
    if (options.deployment && options.namespace) {
      targetDeployment = options.deployment;
      targetNamespace = options.namespace;
    } else {
      const result = await findTargetDeployment();
      targetDeployment = result.targetDeployment;
      targetNamespace = result.targetNamespace;
    }
    
    console.log(`✅ Target deployment: ${targetDeployment} in namespace ${targetNamespace}`);

    
    // 6. Run chaos experiment
    const chaosManifest = path.join(os.tmpdir(), `chaos-manifest-${timestamp}.yaml`);
    console.log(`Starting chaos experiment (${options.chaosType}) for ${options.duration} seconds...`);
    
    let results;
    switch (options.chaosType) {
      case 'pod-delete':
        results = await runPodDeleteExperiment({
          targetDeployment,
          targetNamespace,
          chaosType: 'pod-delete',
          duration: options.duration,
          manifestPath: chaosManifest
        });
        break;
      case 'network-latency':
        results = await runNetworkLatencyExperiment({
          targetDeployment,
          targetNamespace,
          chaosType: 'network-latency',
          duration: options.duration,
          manifestPath: chaosManifest,
          networkLatency: options.networkLatency
        });
        break;
      case 'network-loss':
        results = await runNetworkLossExperiment({
          targetDeployment,
          targetNamespace,
          chaosType: 'network-loss',
          duration: options.duration,
          manifestPath: chaosManifest,
          networkPacketLoss: options.networkLossPercentage
        });
        break;
      case 'network-corruption':
        results = await runNetworkCorruptionExperiment({
          targetDeployment,
          targetNamespace,
          chaosType: 'network-corruption',
          duration: options.duration,
          manifestPath: chaosManifest
        });
        break;
      case 'disk-fill':
        results = await runDiskFillExperiment({
          targetDeployment,
          targetNamespace,
          chaosType: 'disk-fill',
          duration: options.duration,
          manifestPath: chaosManifest
        });
        break;
      case 'node-io-stress':
        results = await runIOStressExperiment({
          targetDeployment,
          targetNamespace,
          chaosType: 'node-io-stress',
          duration: options.duration,
          manifestPath: chaosManifest,
          ioBytesCount: options.ioPercentage * 1024 * 1024 // Convert percentage to MB
        });
        break;
      default:
        results = await runChaosExperiment({
          targetDeployment,
          targetNamespace,
          chaosType: options.chaosType,
          duration: options.duration,
          manifestPath: chaosManifest
        });
    }

    // 7. Return results
    console.log('✅ Chaos test completed!');
    
    // Extract verdict
    let verdict = "Awaited";
    if (results?.status?.experimentStatus?.verdict) {
      verdict = results.status.experimentStatus.verdict;
    } else if (results?.status?.verdict) {
      verdict = results.status.verdict;
    }
    
    console.log(`Verdict: ${verdict}`);
    console.log(`Target: ${targetDeployment} in namespace ${targetNamespace}`);
    
    // Write results to file
    const resultsFile = path.join(process.cwd(), `chaos-results-${timestamp}.json`);
    await fs.writeFile(resultsFile, JSON.stringify(results, null, 2));
    console.log(`Results written to: ${resultsFile}`);
    
  } catch (error) {
    console.error('Error running chaos test:', error);
    process.exit(1);
  }
}

runChaosTest();
