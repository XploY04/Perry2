import express, { Request, Response, RequestHandler } from "express";
import {
  ContainerAnalysisRequest,
  SBOMResult,
  ChaosTestRequest,
  ChaosTestResult,
} from "./types";
import { DockerService } from "./services/docker";
import { KubernetesService } from "./services/kubernetes";
import {
  cloneRepository,
  setupKubernetesCluster,
  deployApplication,
  setupLitmusChaos,
  findTargetDeployment,
  runChaosExperiment,
  validateChaosResources,
  installPodDeleteExperiment,
  runPodDeleteExperiment,
  runNetworkLatencyExperiment,
  runNetworkLossExperiment,
  runNetworkCorruptionExperiment,
  runDiskFillExperiment,
  runIOStressExperiment,
  runNodeIOStressExperiment,
  ensureLitmusChaosServiceAccount,
} from "./services/chaos/index.js";
import { v4 as uuidv4 } from "uuid";
import bodyParser from "body-parser";
import fs from "fs/promises";
import path from "path";
import { join } from "path";
import os from "os";
import { tmpdir } from "os";
import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);

const app = express();

// Middleware

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const dockerService = new DockerService();
const k8sService = new KubernetesService();

// Health check endpoint
app.get("/health", ((_req: Request, res: Response) => {
  res.json({ status: "ok" });
}) as RequestHandler);

// Main analysis endpoint
app.post("/analyze", (async (req: Request, res: Response) => {
  let image: string = "";
  let jobId: string = "";
  let sbomPath: string = "";
  try {
    // Generate unique job ID
    console.log("image", JSON.stringify(req.body));
    if (!req.body.image || typeof req.body.image !== "string") {
      return res
        .status(400)
        .json({ error: "Missing or invalid image in request body" });
    }
    jobId = uuidv4();
    image = req.body.image;
    // Pull and analyze image
    await dockerService.pullImage(image);
    const imageInspect = await dockerService.inspectImage(image);
    // Create and run analysis job in KIND cluster
    await k8sService.createAnalysisJob(image, jobId);
    await k8sService.waitForJobCompletion(jobId);
    // Get SBOM results
    const sbomJson = await k8sService.getJobLogs(jobId);
    // Write SBOM to a temp file
    const tmpDir = os.tmpdir();
    sbomPath = path.join(tmpDir, `sbom-${jobId}.json`);
    await fs.writeFile(sbomPath, sbomJson, "utf-8");
    // Run grype on the SBOM file
    const { stdout: grypeOutput } = await execAsync(
      `grype sbom:${sbomPath} -o json`
    );
    // Return grype output as JSON
    res.type("application/json").send(grypeOutput);
  } catch (error) {
    console.error("Analysis failed:", error);

    // Check for Docker permission errors
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      errorMessage.includes("permission denied") &&
      errorMessage.includes("docker.sock")
    ) {
      res.status(500).json({
        error: "Docker permission denied",
        details:
          "This application requires Docker permissions. Please try one of these solutions:\n" +
          "1. Add your user to the docker group: sudo usermod -aG docker $USER\n" +
          "2. Log out and log back in, or run: newgrp docker\n" +
          "3. Start the application with sudo (not recommended for production)",
      });
    } else {
      res.status(500).json({
        error: "Analysis failed",
        details: errorMessage,
      });
    }
  } finally {
    // Cleanup resources
    if (image) {
      try {
        await dockerService.cleanup(image);
      } catch (e) {
        console.error("Error cleaning up Docker image:", e);
      }
    }
    if (jobId) {
      try {
        await k8sService.cleanupJob(jobId);
      } catch (e) {
        console.error("Error cleaning up K8s job:", e);
      }
    }
    if (sbomPath) {
      try {
        await fs.unlink(sbomPath);
      } catch (e) {
        // It's ok if the file doesn't exist
      }
    }
  }
}) as RequestHandler);

// Chaos test endpoint
app.post("/chaos-test", (async (
  req: Request<any, any, ChaosTestRequest>,
  res: Response
) => {
  try {
    const {
      githubUrl,
      chaosType = "node-io-stress", // Default to pod-delete if not specified
      duration = 30, // Default to 30 seconds
      targetNamespace,
      targetDeployment,
      fillPercentage = 80, // Default disk fill percentage
      ioPercentage = 10, // Default IO stress percentage
      networkLatency = 200, // Default network latency in ms
      networkLossPercentage = 10, // Default network loss percentage
    } = req.body;

    if (!githubUrl) {
      return res.status(400).json({
        success: false,
        error: "GitHub URL is required",
      });
    }

    // Validate chaos type
    const validChaosTypes = [
      "pod-delete",
      "network-latency",
      "network-loss",
      "network-corruption",
      "disk-fill",
      "node-io-stress",
    ];

    if (!validChaosTypes.includes(chaosType)) {
      return res.status(400).json({
        success: false,
        error: `Invalid chaos type: ${chaosType}. Must be one of: ${validChaosTypes.join(
          ", "
        )}`,
      });
    }

    console.log(`Starting chaos test for repo: ${githubUrl}`);
    console.log(`Chaos type: ${chaosType}, duration: ${duration}s`);

    try {
      // 1. Clone the GitHub repository
      const { repoDir, timestamp } = await cloneRepository(githubUrl);
      console.log(`✅ Cloned repository to ${repoDir}`);

      // 2. Create a Kind cluster if it doesn't exist
      await setupKubernetesCluster();
      console.log(`✅ Kubernetes cluster ready`);

      // 3. Apply Kubernetes manifests from the repo
      const deployResult = await deployApplication(repoDir);
      console.log(
        `✅ Deployed ${deployResult.manifestsApplied}/${deployResult.totalManifests} manifests to ${deployResult.namespace} namespace`
      );

      // 4. Install LitmusChaos if not already installed
      try {
        await setupLitmusChaos();
        console.log(`✅ LitmusChaos framework ready`);
      } catch (litmusError) {
        console.error("Error setting up LitmusChaos:", litmusError);

        // Try to provide detailed diagnostic information
        let diagnosticInfo = "No additional information available";
        try {
          const { stdout: crdStatus } = await execAsync(
            `kubectl get crd | grep litmuschaos.io || echo "No LitmusChaos CRDs found"`
          );
          const { stdout: nsStatus } = await execAsync(
            `kubectl get ns litmus --no-headers 2>/dev/null || echo "Namespace litmus not found"`
          );
          const { stdout: operatorStatus } = await execAsync(
            `kubectl get pods -n litmus --no-headers 2>/dev/null || echo "No pods in litmus namespace"`
          );

          diagnosticInfo = `CRD Status: ${crdStatus.trim()}\nNamespace Status: ${nsStatus.trim()}\nOperator Status: ${operatorStatus.trim()}`;
        } catch (diagError) {
          // Ignore errors in diagnostic collection
        }

        return res.status(500).json({
          success: false,
          error: "Failed to set up chaos testing framework",
          details:
            litmusError instanceof Error
              ? litmusError.toString()
              : String(litmusError),
          stage: "LitmusChaos setup",
          repository: githubUrl,
          diagnostic: diagnosticInfo,
        });
      }

      // 5. Get the first deployment to target for chaos
      const { targetDeployment, targetNamespace } =
        await findTargetDeployment();
      console.log(
        `✅ Found target deployment: ${targetDeployment} in namespace ${targetNamespace}`
      );

      // 5.5 Validate LitmusChaos resources and dependencies
      try {
        // This function is defined in src/services/chaos.ts
        const validationResult = await validateChaosResources();
        if (!validationResult.valid) {
          console.warn(
            "⚠️ Some LitmusChaos resources are missing or invalid. Will try to continue, but this may cause issues."
          );
          console.log(
            "Diagnostics:",
            JSON.stringify(validationResult.diagnostics, null, 2)
          );

          // If the service account doesn't exist, create it
          if (
            validationResult.diagnostics.serviceAccount &&
            !validationResult.diagnostics.serviceAccount.exists
          ) {
            console.log(
              "Service account 'litmus-admin' is missing. Creating it now..."
            );
            try {
              await ensureLitmusChaosServiceAccount(targetNamespace);
              console.log(
                "✅ Successfully created litmus-admin service account"
              );
            } catch (saError) {
              console.error("Error creating service account:", saError);
            }
          }

          // If the pod-delete experiment doesn't exist, try to reinstall it
          if (
            validationResult.diagnostics.podDeleteExperiment &&
            !validationResult.diagnostics.podDeleteExperiment.exists
          ) {
            console.log("Attempting to reinstall pod-delete experiment...");
            await installPodDeleteExperiment();
          }
        } else {
          console.log("✅ All LitmusChaos resources are valid");
        }
      } catch (validationError) {
        console.error("Error validating chaos resources:", validationError);
        // Continue anyway and hope for the best
      }

      // 6. Run chaos experiment
      const chaosManifest = join(tmpdir(), `chaos-manifest-${timestamp}.yaml`);

      try {
        console.log(
          `Starting chaos experiment (${chaosType}) for ${duration} seconds...`
        );

        let resultsJson;

        // Run the appropriate chaos experiment based on the chaosType
        switch (chaosType) {
          case "pod-delete":
            resultsJson = await runPodDeleteExperiment({
              targetDeployment,
              targetNamespace,
              chaosType: "pod-delete",
              duration,
              manifestPath: chaosManifest,
            });
            break;

          case "network-latency":
            resultsJson = await runNetworkLatencyExperiment({
              targetDeployment,
              targetNamespace,
              chaosType: "network-latency",
              duration,
              manifestPath: chaosManifest,
              networkLatency,
            });
            break;

          case "network-loss":
            resultsJson = await runNetworkLossExperiment({
              targetDeployment,
              targetNamespace,
              chaosType: "network-loss",
              duration,
              manifestPath: chaosManifest,
              networkPacketLoss: networkLossPercentage,
            });
            break;

          case "network-corruption":
            resultsJson = await runNetworkCorruptionExperiment({
              targetDeployment,
              targetNamespace,
              chaosType: "network-corruption",
              duration,
              manifestPath: chaosManifest,
            });
            break;

          case "disk-fill":
            resultsJson = await runDiskFillExperiment({
              targetDeployment,
              targetNamespace,
              chaosType: "disk-fill",
              duration,
              manifestPath: chaosManifest,
            });
            break;

          case "node-io-stress":
            resultsJson = await runNodeIOStressExperiment({
              targetDeployment,
              targetNamespace,
              chaosType: "node-io-stress",
              duration,
              manifestPath: chaosManifest,
              ioBytesCount: ioPercentage * 1024 * 1024, // Convert percentage to MB
            });
            break;

          default:
            // Fallback to generic chaos experiment
            resultsJson = await runChaosExperiment({
              targetDeployment,
              targetNamespace,
              chaosType,
              duration,
              manifestPath: chaosManifest,
            });
        }

        // Check if we have a valid result with proper structure
        const hasValidStatus =
          resultsJson &&
          resultsJson.status &&
          (resultsJson.status.experimentStatus || resultsJson.status.verdict);

        if (hasValidStatus) {
          // Extract verdict from result structure
          let verdict = "Awaited";
          let failStep = "None";

          if (
            resultsJson.status.experimentStatus &&
            resultsJson.status.experimentStatus.verdict
          ) {
            verdict = resultsJson.status.experimentStatus.verdict;
            failStep = resultsJson.status.experimentStatus.failStep || "None";
          } else if (resultsJson.status.verdict) {
            verdict = resultsJson.status.verdict;
            failStep = resultsJson.status.failStep || "None";
          }

          // 7. Return results
          res.json({
            success: true,
            message: "Chaos test completed successfully",
            chaosType,
            duration,
            targetDeployment,
            targetNamespace,
            repository: githubUrl,
            verdict: verdict,
            failStep: failStep,
            experimentStatus: "Completed",
            result: resultsJson,
            resultSource: resultsJson.metadata?.name?.includes("engine")
              ? "engineStatus"
              : "chaosResult",
            experimentPhase:
              resultsJson.status?.experimentStatus?.phase || "Unknown",
            additionalDiagnostics: {
              podSearchResults: resultsJson.status?.podSearchResults,
              nodeIOStressSpecific: resultsJson.status?.nodeIOStressSpecific,
              availableResults: (resultsJson as any).availableResults,
              stuckInInitialized:
                chaosType === "node-io-stress" &&
                resultsJson.status?.nodeIOStressSpecific?.stuckInInitialized ===
                  true
                  ? "The node-io-stress experiment is stuck in initialized state. This is a known issue but the experiment may still be causing stress effects."
                  : undefined,
              engineStatus:
                resultsJson.status?.engineDetails?.engineState || "unknown",
              enginePhase:
                resultsJson.status?.experimentStatus?.phase || "unknown",
            },
          });
        } else {
          // We got a result object but it's not well-formed
          res.json({
            success: true,
            message: "Chaos test executed but results may be incomplete",
            chaosType,
            duration,
            targetDeployment,
            targetNamespace,
            repository: githubUrl,
            verdict: "Unknown",
            experimentStatus: "Completed with partial results",
            resultData: resultsJson,
          });
        }
      } catch (error) {
        // Check if we have a chaos experiment that's still running
        try {
          const { stdout: engineList } = await execAsync(
            `kubectl get chaosengine -n ${targetNamespace} | grep ${targetDeployment}-chaos`
          );

          if (engineList && engineList.trim()) {
            // Try to get pod status for more diagnostic information
            let podStatus = "";
            try {
              const { stdout: pods } = await execAsync(
                `kubectl get pods -n ${targetNamespace} -l app=${targetDeployment} -o wide`
              );
              podStatus = pods.trim();
            } catch (e) {
              // Ignore if we can't get pod status
            }

            res.status(500).json({
              success: false,
              error:
                "Chaos experiment is running but results couldn't be fetched",
              details:
                error instanceof Error ? error.toString() : String(error),
              chaosType,
              targetDeployment,
              targetNamespace,
              repository: githubUrl,
              podStatus: podStatus,
              message:
                "Experiment appears to be running, but results could not be retrieved. You can check the experiment results manually using kubectl.",
            });
          } else {
            // Check for any ChaosResult resources
            try {
              const { stdout: resultsList } = await execAsync(
                `kubectl get chaosresults -n ${targetNamespace} --no-headers || echo "No results found"`
              );

              res.status(500).json({
                success: false,
                error: "Error during chaos testing",
                details:
                  error instanceof Error ? error.toString() : String(error),
                chaosType,
                targetDeployment,
                targetNamespace,
                repository: githubUrl,
                availableResults: resultsList.trim(),
              });
            } catch (e) {
              res.status(500).json({
                success: false,
                error: "Error during chaos testing",
                details:
                  error instanceof Error ? error.toString() : String(error),
                chaosType,
                targetDeployment,
                targetNamespace,
                repository: githubUrl,
              });
            }
          }
        } catch (e) {
          // If we can't check for the engine, fall back to the generic error
          res.status(500).json({
            success: false,
            error: "Error during chaos testing",
            details: error instanceof Error ? error.toString() : String(error),
            chaosType,
            targetDeployment,
            targetNamespace,
            repository: githubUrl,
          });
        }
      }
    } catch (error) {
      // Handle specific errors from different stages
      let statusCode = 500;
      let errorMessage = "Unexpected error during chaos test";
      let errorStage = "unknown";

      if (error instanceof Error) {
        if (error.message.includes("No Kubernetes manifest files")) {
          statusCode = 400;
          errorMessage = error.message;
          errorStage = "manifest detection";
        } else if (error.message.includes("No deployments found")) {
          statusCode = 400;
          errorMessage = error.message;
          errorStage = "target deployment detection";
        } else if (
          error.message.includes("Failed to clone repository") ||
          error.message.includes("git clone")
        ) {
          errorMessage = "Failed to clone repository";
          errorStage = "repository cloning";
        } else if (
          error.message.includes("kubernetes") ||
          error.message.includes("kind ")
        ) {
          errorStage = "kubernetes setup";
        } else if (error.message.includes("deploy")) {
          errorStage = "application deployment";
        }
      }

      return res.status(statusCode).json({
        success: false,
        error: errorMessage,
        details: error instanceof Error ? error.toString() : String(error),
        stage: errorStage,
        repository: githubUrl,
      });
    }
  } catch (error) {
    console.error("Unexpected error:", error);
    res.status(500).json({
      success: false,
      error: "Unexpected error occurred",
      details: error instanceof Error ? error.toString() : String(error),
    });
  }
}) as RequestHandler);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
