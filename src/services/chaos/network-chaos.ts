// Network Chaos specific implementations
import { NetworkChaosParams } from './types.js';
import { execAsync } from './utils.js';
import { runChaosExperiment } from './litmus.js';

/**
 * Runs a network-latency chaos experiment
 * @param params Network chaos experiment parameters
 */
export async function runNetworkLatencyExperiment(params: NetworkChaosParams): Promise<any> {
  await ensureNetworkChaosExperiment('network-latency');
  
  return runChaosExperiment({
    ...params,
    chaosType: 'network-latency'
  });
}

/**
 * Runs a network-loss chaos experiment
 * @param params Network chaos experiment parameters
 */
export async function runNetworkLossExperiment(params: NetworkChaosParams): Promise<any> {
  await ensureNetworkChaosExperiment('network-loss');
  
  return runChaosExperiment({
    ...params,
    chaosType: 'network-loss'
  });
}

/**
 * Runs a network-corruption chaos experiment
 * @param params Network chaos experiment parameters
 */
export async function runNetworkCorruptionExperiment(params: NetworkChaosParams): Promise<any> {
  await ensureNetworkChaosExperiment('network-corruption');
  
  return runChaosExperiment({
    ...params,
    chaosType: 'network-corruption'
  });
}

/**
 * Ensures a network chaos experiment is installed
 * @param experimentType Type of network chaos experiment
 */
async function ensureNetworkChaosExperiment(experimentType: string): Promise<void> {
  try {
    const { stdout: expStatus } = await execAsync(`kubectl get chaosexperiment ${experimentType} -o json || echo "not found"`);
    
    if (expStatus.includes("not found")) {
      console.log(`⚠️ ${experimentType} experiment not found, installing it...`);
      await installNetworkChaosExperiment(experimentType);
    }
  } catch (error) {
    console.log(`⚠️ Error checking ${experimentType} experiment, will try to install it: ${error}`);
    await installNetworkChaosExperiment(experimentType);
  }
}

/**
 * Installs a network chaos experiment
 * @param experimentType Type of network chaos experiment
 */
async function installNetworkChaosExperiment(experimentType: string): Promise<void> {
  try {
    await execAsync(`kubectl apply -f https://hub.litmuschaos.io/api/chaos/2.0.0/experiments/${experimentType}/${experimentType}.yaml`);
    console.log(`✅ Applied ${experimentType} experiment from LitmusChaos Hub`);
  } catch (error) {
    console.log(`Failed to apply ${experimentType} experiment from hub, applying manually...`);
    
    // Network chaos ENV variables based on the experiment type
    let envVars = '';
    
    if (experimentType === 'network-latency') {
      envVars = `
      - name: NETWORK_LATENCY
        value: '2000'  # latency in ms`;
    } else if (experimentType === 'network-loss') {
      envVars = `
      - name: NETWORK_PACKET_LOSS_PERCENTAGE
        value: '100'  # packet loss in percentage`;
    } else if (experimentType === 'network-corruption') {
      envVars = `
      - name: NETWORK_PACKET_CORRUPTION_PERCENTAGE
        value: '100'  # packet corruption in percentage`;
    }
    
    // Apply a simplified network chaos experiment
    await execAsync(`kubectl apply -f - <<EOF
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosExperiment
metadata:
  name: ${experimentType}
  labels:
    name: ${experimentType}
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
      - ./experiments -name ${experimentType}
    command:
      - /bin/bash
    env:
      - name: TOTAL_CHAOS_DURATION
        value: '60'
      - name: RAMP_TIME
        value: '0'
      - name: CONTAINER_RUNTIME
        value: 'docker'
      - name: SOCKET_PATH
        value: '/var/run/docker.sock'
      - name: PODS_AFFECTED_PERC
        value: '50'
      - name: TARGET_CONTAINER
        value: ''
      - name: NETWORK_INTERFACE
        value: 'eth0'
      - name: LIB
        value: 'pumba'${envVars}
    labels:
      name: ${experimentType}
      app.kubernetes.io/part-of: litmus
      app.kubernetes.io/component: experiment-job
      app.kubernetes.io/version: latest
EOF`);
    console.log(`✅ Applied ${experimentType} experiment manually`);
  }
  
  // Verify installation
  try {
    await execAsync(`kubectl get chaosexperiment ${experimentType}`);
    console.log(`✅ ${experimentType} experiment installed successfully`);
  } catch (error) {
    throw new Error(`Failed to verify ${experimentType} installation: ${error}`);
  }
}
