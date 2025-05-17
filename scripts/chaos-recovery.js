#!/usr/bin/env node

// Command-line script for recovering stuck chaos experiments
import { program } from "commander";
import {
  detectStuckExperiments,
  autoRecoverStuckExperiments,
} from "../src/services/chaos/index.js";

program
  .name("chaos-recovery")
  .description("Detect and recover stuck LitmusChaos experiments")
  .version("1.0.0");

program
  .option(
    "-n, --namespace <namespace>",
    "Kubernetes namespace to check for stuck experiments",
    "default"
  )
  .option(
    "-a, --auto-recover <boolean>",
    "Automatically recover detected stuck experiments",
    "true"
  )
  .option(
    "-d, --detect-only",
    "Only detect experiments without recovering them",
    false
  );

program.parse(process.argv);

const options = program.opts();

async function main() {
  const namespace = options.namespace;
  const autoRecover = options.detectOnly
    ? false
    : options.autoRecover === "true";

  console.log(`📋 Checking for stuck experiments in namespace: ${namespace}`);
  console.log(`📋 Auto-recovery: ${autoRecover ? "Enabled" : "Disabled"}`);

  if (options.detectOnly) {
    // Run detection only
    const stuckExperiments = await detectStuckExperiments(namespace);

    console.log(`\n📊 Found ${stuckExperiments.length} stuck experiments:`);

    if (stuckExperiments.length === 0) {
      console.log("✅ No stuck experiments detected.");
      return;
    }

    // Print detailed information about stuck experiments
    stuckExperiments.forEach((exp, index) => {
      console.log(`\n${index + 1}. Engine: ${exp.engineName}`);
      console.log(`   Type: ${exp.chaosType}`);
      console.log(`   Namespace: ${exp.targetNamespace}`);
      console.log(`   Stuck since: ${exp.stuckSince.toISOString()}`);
      console.log(
        `   Service account exists: ${
          exp.diagnostics.serviceAccount?.exists || "unknown"
        }`
      );

      if (exp.diagnostics.serviceAccount?.permissions) {
        console.log(
          `   Service account can create pods: ${exp.diagnostics.serviceAccount.permissions.canCreatePods}`
        );
        console.log(
          `   Service account can access nodes: ${exp.diagnostics.serviceAccount.permissions.canAccessNodes}`
        );
      }
    });

    console.log(
      "\n📌 To recover these experiments, run this command with --auto-recover=true"
    );
  } else {
    // Run auto-recovery
    const results = await autoRecoverStuckExperiments(namespace, autoRecover);

    console.log(
      `\n📊 Found ${results.stuckExperiments.length} stuck experiments.`
    );

    if (results.stuckExperiments.length === 0) {
      console.log("✅ No stuck experiments detected.");
      return;
    }

    console.log(`\n🔧 Recovery results:`);

    // Print recovery results
    Object.entries(results.recoveryResults).forEach(([engineName, result]) => {
      console.log(`\n📌 Engine: ${engineName}`);
      console.log(`   Status: ${result.success ? "✅ Success" : "❌ Failed"}`);
      console.log(`   Message: ${result.message}`);
      console.log("   Actions taken:");
      result.actions.forEach((action, i) => {
        console.log(`     ${i + 1}. ${action}`);
      });
    });
  }
}

main().catch((error) => {
  console.error("❌ Error during recovery process:", error);
  process.exit(1);
});
