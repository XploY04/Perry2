// Pod Chaos specific implementations
import { PodChaosParams } from './types.js';
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
