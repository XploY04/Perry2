#!/usr/bin/env node

// Test script for node-io-stress experiment recovery
import {
  ensureLitmusChaosServiceAccount,
  runNodeIOStressExperiment,
  detectStuckExperiments,
  recoverStuckExperiment,
  autoRecoverStuckExperiments,
} from "../src/services/chaos/index.js";

// Target namespace for testing
const TEST_NAMESPACE = "default";

async function main() {
  console.log("🧪 Testing node-io-stress experiment and recovery functions");

  // Step 1: Set up the service account first
  console.log("\n📋 Step 1: Setting up LitmusChaos service account...");
  try {
    await ensureLitmusChaosServiceAccount(TEST_NAMESPACE);
    console.log("✅ Service account setup complete");
  } catch (error) {
    console.error("❌ Service account setup failed:", error);
    process.exit(1);
  }

  // Step 2: Run a node-io-stress experiment
  console.log("\n📋 Step 2: Running node-io-stress experiment...");
  let experimentResult;
  try {
    experimentResult = await runNodeIOStressExperiment({
      targetDeployment: "test-deployment", // Replace with actual deployment
      targetNamespace: TEST_NAMESPACE,
      chaosType: "node-io-stress",
      duration: 30, // Short duration for testing
      manifestPath: `/tmp/node-io-stress-manifest-${Date.now()}.yaml`,
    });
    console.log("✅ Experiment run complete");
    console.log("🔍 Result summary:", {
      phase: experimentResult?.status?.experimentStatus?.phase,
      verdict: experimentResult?.status?.experimentStatus?.verdict,
      stuckInInitialized: experimentResult?.status?.stuckExperimentDiagnostics
        ? true
        : false,
    });
  } catch (error) {
    console.error("❌ Experiment run failed:", error);
  }

  // Step 3: Check for stuck experiments
  console.log("\n📋 Step 3: Checking for stuck experiments...");
  try {
    const stuckExperiments = await detectStuckExperiments(TEST_NAMESPACE);
    console.log(`Found ${stuckExperiments.length} stuck experiments`);

    for (const exp of stuckExperiments) {
      console.log(
        `• ${exp.engineName} (${
          exp.chaosType
        }) - stuck since ${exp.stuckSince.toISOString()}`
      );
    }

    // Step 4: Recover stuck experiments if any found
    if (stuckExperiments.length > 0) {
      console.log("\n📋 Step 4: Recovering stuck experiments...");

      const recovery = await autoRecoverStuckExperiments(TEST_NAMESPACE, true);
      console.log("✅ Recovery complete");

      // Print recovery results
      for (const [engineName, result] of Object.entries(
        recovery.recoveryResults
      )) {
        console.log(
          `• ${engineName}: ${result.success ? "✅ Success" : "❌ Failed"}`
        );
        console.log(`  Message: ${result.message}`);
        console.log(`  Actions: ${result.actions.length} actions taken`);
      }
    } else {
      console.log("👍 No stuck experiments to recover");
    }
  } catch (error) {
    console.error("❌ Error during experiment detection/recovery:", error);
  }

  console.log("\n🏁 Test complete!");
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
