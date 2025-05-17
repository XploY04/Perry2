// Types for chaos testing

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

export interface DeploymentOptions {
  namespace?: string;
  kubectl?: string;
  timeout?: number;
  context?: string;
  applyStrategy?: "normal" | "strict-order" | "parallel";
  additionalArgs?: string[];
  dryRun?: boolean;
  waitForReadiness?: boolean;
  logLevel?: "silent" | "normal" | "verbose";
}

export interface DeploymentResult {
  success: boolean;
  manifestsApplied: number;
  totalManifests: number;
  errors: Array<{ file: string; error: string }>;
  warnings: string[];
  appliedFiles: string[];
  namespace: string;
}

// Interface for Pod Chaos parameters
export interface PodChaosParams extends ChaosEngineParams {
  podsAffectedPercentage?: number;
  sequence?: "serial" | "parallel";
  containerNames?: string[];
}

// Interface for Network Chaos parameters
export interface NetworkChaosParams extends ChaosEngineParams {
  networkLatency?: number;
  networkPacketLoss?: number;
  networkCorruption?: number;
}

// Interface for IO Chaos parameters
export interface IOChaosParams extends ChaosEngineParams {
  /**
   * The mount path of the volume to fill (for disk-fill)
   */
  volumeMountPath?: string;

  /**
   * The delay in milliseconds to introduce during IO operations
   */
  ioDelay?: number;

  /**
   * The number of bytes to be written for IO stress tests
   * For reference, you can convert from percentage to bytes:
   * e.g. 10% → 10 * 1024 * 1024 (10MB)
   */
  ioBytesCount?: number;
}

// Generic chaos experiment results
export interface ChaosExperimentResult {
  verdict: string;
  failStep: string;
  experimentStatus: string;
  details?: any;
}

// Interfaces for experiment recovery
export interface StuckExperimentInfo {
  engineName: string;
  targetNamespace: string;
  chaosType: string;
  stuckSince: Date;
  diagnostics: Record<string, any>;
}

export interface ExperimentRecoveryResult {
  success: boolean;
  message: string;
  actions: string[];
}

export interface AutoRecoveryResults {
  stuckExperiments: StuckExperimentInfo[];
  recoveryResults: Record<string, ExperimentRecoveryResult>;
}
