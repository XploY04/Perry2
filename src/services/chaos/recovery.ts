// Helper functions for handling stuck experiments
import { execAsync } from "./utils.js";
import { ensureLitmusChaosServiceAccount } from "./serviceaccount.js";
import {
  StuckExperimentInfo,
  ExperimentRecoveryResult,
  AutoRecoveryResults,
} from "./types.js";

/**
 * Checks for experiments that are stuck in the "initialized" state
 * @param namespace Namespace to check for stuck experiments
 * @returns Array of detected stuck experiments
 */
export async function detectStuckExperiments(
  namespace: string = "default"
): Promise<StuckExperimentInfo[]> {
  console.log(`Checking for stuck experiments in namespace ${namespace}...`);

  const stuckExperiments: StuckExperimentInfo[] = [];

  try {
    // Get all chaos engines in the namespace
    const { stdout: enginesJson } = await execAsync(
      `kubectl get chaosengines -n ${namespace} -o json || echo '{"items":[]}'`
    );

    const engines = JSON.parse(enginesJson).items || [];
    console.log(
      `Found ${engines.length} chaos engines in namespace ${namespace}`
    );

    for (const engine of engines) {
      const engineName = engine.metadata?.name;
      const chaosType = engine.metadata?.labels?.chaostype || "unknown";
      const engineStatus = engine.status?.engineStatus;
      const creationTime = new Date(
        engine.metadata?.creationTimestamp || Date.now()
      );
      const currentTime = new Date();

      // Check if engine has been stuck for more than 5 minutes
      const stuckTimeMinutes =
        (currentTime.getTime() - creationTime.getTime()) / (1000 * 60);

      if (engineStatus === "initialized" && stuckTimeMinutes > 5) {
        console.log(
          `Detected stuck experiment: ${engineName} (${chaosType}) - stuck for ~${Math.floor(
            stuckTimeMinutes
          )} minutes`
        );

        // Get detailed diagnostics
        const diagnostics: Record<string, any> = {
          engineStatus,
          stuckTimeMinutes: Math.floor(stuckTimeMinutes),
          creationTime: engine.metadata?.creationTimestamp,
          engineSpec: engine.spec,
        };

        // Check for service account issues
        try {
          const { stdout: saStatus } = await execAsync(
            `kubectl get serviceaccount litmus-admin -n ${namespace} -o name 2>/dev/null || echo "not found"`
          );

          diagnostics.serviceAccount = {
            exists: !saStatus.includes("not found"),
            name: saStatus.includes("not found") ? null : saStatus.trim(),
          };

          // Check permissions if service account exists
          if (diagnostics.serviceAccount.exists) {
            try {
              const { stdout: podPermission } = await execAsync(
                `kubectl auth can-i create pods --as=system:serviceaccount:${namespace}:litmus-admin -n ${namespace} || echo "no"`
              );

              const { stdout: nodePermission } = await execAsync(
                `kubectl auth can-i get nodes --as=system:serviceaccount:${namespace}:litmus-admin || echo "no"`
              );

              diagnostics.serviceAccount.permissions = {
                canCreatePods: podPermission.trim() === "yes",
                canAccessNodes: nodePermission.trim() === "yes",
              };
            } catch (error) {
              diagnostics.serviceAccount.permissionCheckError = String(error);
            }
          }
        } catch (error) {
          diagnostics.serviceAccountCheckError = String(error);
        }

        stuckExperiments.push({
          engineName,
          targetNamespace: namespace,
          chaosType,
          stuckSince: creationTime,
          diagnostics,
        });
      }
    }
  } catch (error) {
    console.error(`Error detecting stuck experiments: ${error}`);
  }

  return stuckExperiments;
}

/**
 * Recovers a stuck experiment by recreating service account and cleaning up the experiment
 * @param stuckExperiment Information about the stuck experiment
 * @returns Recovery result
 */
export async function recoverStuckExperiment(
  stuckExperiment: StuckExperimentInfo
): Promise<ExperimentRecoveryResult> {
  const { engineName, targetNamespace, chaosType, diagnostics } =
    stuckExperiment;
  const actions: string[] = [];

  console.log(
    `Attempting to recover stuck experiment: ${engineName} in namespace ${targetNamespace}`
  );

  // Step 1: Recreate service account if missing or has insufficient permissions
  if (
    !diagnostics.serviceAccount?.exists ||
    (diagnostics.serviceAccount?.permissions &&
      (!diagnostics.serviceAccount.permissions.canCreatePods ||
        !diagnostics.serviceAccount.permissions.canAccessNodes))
  ) {
    console.log(
      `Service account issues detected, recreating service account...`
    );
    actions.push("Recreating service account with proper permissions");

    try {
      await ensureLitmusChaosServiceAccount(targetNamespace);
      console.log(
        `✅ Service account recreated in namespace ${targetNamespace}`
      );
    } catch (error) {
      return {
        success: false,
        message: `Failed to recreate service account: ${error}`,
        actions,
      };
    }
  }

  // Step 2: Delete the stuck experiment
  console.log(`Deleting stuck chaos engine: ${engineName}`);
  actions.push(`Deleting stuck chaos engine: ${engineName}`);

  try {
    await execAsync(
      `kubectl delete chaosengine ${engineName} -n ${targetNamespace} --grace-period=0 --force || echo "not found"`
    );
    console.log(`✅ Deleted chaos engine: ${engineName}`);
  } catch (error) {
    console.error(`Error deleting chaos engine: ${error}`);
    // Continue anyway, as this is a best-effort cleanup
  }

  // Step 3: Clean up any orphaned resources
  console.log(`Cleaning up any orphaned resources for experiment...`);
  actions.push("Cleaning up orphaned resources");

  try {
    // Try to find and delete any experiment pods
    const { stdout: expPods } = await execAsync(
      `kubectl get pods -n ${targetNamespace} -l chaosengine=${engineName} -o name 2>/dev/null || echo ""`
    );

    if (expPods && expPods.trim()) {
      const podNames = expPods.trim().split("\n");
      for (const pod of podNames) {
        if (pod) {
          console.log(`Deleting orphaned pod: ${pod}`);
          await execAsync(
            `kubectl delete ${pod} -n ${targetNamespace} --grace-period=0 --force || echo "already deleted"`
          );
          actions.push(`Deleted orphaned pod: ${pod}`);
        }
      }
    }

    // Try to find and delete any orphaned chaos results
    const { stdout: results } = await execAsync(
      `kubectl get chaosresults -n ${targetNamespace} -l chaosengine=${engineName} -o name 2>/dev/null || echo ""`
    );

    if (results && results.trim()) {
      const resultNames = results.trim().split("\n");
      for (const result of resultNames) {
        if (result) {
          console.log(`Deleting orphaned result: ${result}`);
          await execAsync(
            `kubectl delete ${result} -n ${targetNamespace} || echo "already deleted"`
          );
          actions.push(`Deleted orphaned result: ${result}`);
        }
      }
    }
  } catch (error) {
    console.error(`Error during cleanup: ${error}`);
    // Continue anyway, as this is a best-effort cleanup
  }

  console.log(`Recovery process completed for experiment: ${engineName}`);

  return {
    success: true,
    message: `Successfully recovered from stuck experiment: ${engineName}`,
    actions,
  };
}

/**
 * Automatically detects and recovers stuck experiments in a namespace
 * @param namespace Namespace to check for stuck experiments
 * @param autoRecover Whether to automatically recover detected stuck experiments
 * @returns Results of detection and recovery
 */
export async function autoRecoverStuckExperiments(
  namespace: string = "default",
  autoRecover: boolean = true
): Promise<AutoRecoveryResults> {
  const stuckExperiments = await detectStuckExperiments(namespace);
  const recoveryResults: Record<string, ExperimentRecoveryResult> = {};

  if (stuckExperiments.length === 0) {
    console.log(`No stuck experiments detected in namespace ${namespace}`);
    return { stuckExperiments, recoveryResults };
  }

  console.log(
    `Detected ${stuckExperiments.length} stuck experiments in namespace ${namespace}`
  );

  if (autoRecover) {
    for (const exp of stuckExperiments) {
      console.log(`Recovering experiment: ${exp.engineName}`);
      recoveryResults[exp.engineName] = await recoverStuckExperiment(exp);
    }
  }

  return { stuckExperiments, recoveryResults };
}
