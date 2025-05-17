// Pod Chaos specific implementations
import { PodChaosParams } from './types.js';
import { execAsync } from './utils.js';
import { runChaosExperiment } from './litmus.js';

/**
 * Runs a pod-delete chaos experiment
 * @param params Pod chaos experiment parameters
 */
export async function runPodDeleteExperiment(params: PodChaosParams): Promise<any> {
  return runChaosExperiment({
    ...params,
    chaosType: 'pod-delete'
  });
}

/**
 * Runs a pod-kill chaos experiment
 * @param params Pod chaos experiment parameters
 */
export async function runPodKillExperiment(params: PodChaosParams): Promise<any> {
  return runChaosExperiment({
    ...params,
    chaosType: 'pod-kill'
  });
}

/**
 * Runs a container-kill chaos experiment
 * @param params Pod chaos experiment parameters
 */
export async function runContainerKillExperiment(params: PodChaosParams): Promise<any> {
  // Install the container-kill experiment if needed
  try {
    const { stdout: expStatus } = await execAsync(`kubectl get chaosexperiment container-kill -o json || echo "not found"`);
    
    if (expStatus.includes("not found")) {
      console.log(`⚠️ container-kill experiment not found, installing it...`);
      await installContainerKillExperiment();
    }
  } catch (error) {
    console.log(`⚠️ Error checking container-kill experiment, will try to install it: ${error}`);
    await installContainerKillExperiment();
  }
  
  return runChaosExperiment({
    ...params,
    chaosType: 'container-kill'
  });
}

/**
 * Installs the container-kill chaos experiment
 */
async function installContainerKillExperiment(): Promise<void> {
  try {
    await execAsync(`kubectl apply -f https://hub.litmuschaos.io/api/chaos/2.0.0/experiments/container-kill/container-kill.yaml`);
    console.log("✅ Applied container-kill experiment from LitmusChaos Hub");
  } catch (error) {
    console.log("Failed to apply container-kill experiment from hub, applying manually...");
    // Apply a simplified container-kill experiment
    await execAsync(`kubectl apply -f - <<EOF
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosExperiment
metadata:
  name: container-kill
  labels:
    name: container-kill
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
      - ./experiments -name container-kill
    command:
      - /bin/bash
    env:
      - name: TOTAL_CHAOS_DURATION
        value: '30'
      - name: RAMP_TIME
        value: '0'
      - name: CONTAINER_RUNTIME
        value: 'docker'
      - name: SOCKET_PATH
        value: '/var/run/docker.sock'
      - name: TARGET_CONTAINER
        value: ''
      - name: PODS_AFFECTED_PERC
        value: ''
      - name: LIB
        value: 'litmus'
    labels:
      name: container-kill
      app.kubernetes.io/part-of: litmus
      app.kubernetes.io/component: experiment-job
      app.kubernetes.io/version: latest
EOF`);
    console.log("✅ Applied container-kill experiment manually");
  }
  
  // Verify installation
  try {
    await execAsync(`kubectl get chaosexperiment container-kill`);
    console.log("✅ container-kill experiment installed successfully");
  } catch (error) {
    throw new Error(`Failed to verify container-kill installation: ${error}`);
  }
}
