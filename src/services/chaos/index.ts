// Export all chaos testing related functionality
import {
  ChaosTestParams,
  ChaosEngineParams,
  DeploymentOptions,
  DeploymentResult,
  PodChaosParams,
  NetworkChaosParams,
  IOChaosParams,
  ChaosExperimentResult,
} from "./types.js";

// Export core functionality
export {
  cloneRepository,
  setupKubernetesCluster,
  deployApplication,
  findTargetDeployment,
  deployFallbackApplication,
} from "./core.js";

// Export LitmusChaos specific functionality
export {
  setupLitmusChaos,
  runChaosExperiment,
  validateChaosResources,
  installPodDeleteExperiment,
} from "./litmus.js";

// Export service account management
export { ensureLitmusChaosServiceAccount } from "./serviceaccount.js";

// Export pod chaos functions
export {
  runPodDeleteExperiment,
  runPodKillExperiment,
  runContainerKillExperiment,
} from "./pod-chaos.js";

// Export network chaos functions
export {
  runNetworkLatencyExperiment,
  runNetworkLossExperiment,
  runNetworkCorruptionExperiment,
} from "./network-chaos.js";

// Export IO chaos functions
export {
  runDiskFillExperiment,
  runIOStressExperiment,
  runNodeIOStressExperiment,
} from "./io-chaos.js";

// Export recovery functions for stuck experiments
export {
  detectStuckExperiments,
  recoverStuckExperiment,
  autoRecoverStuckExperiments,
} from "./recovery.js";

// Export types
export type {
  ChaosTestParams,
  ChaosEngineParams,
  DeploymentOptions,
  DeploymentResult,
  PodChaosParams,
  NetworkChaosParams,
  IOChaosParams,
  ChaosExperimentResult,
};
