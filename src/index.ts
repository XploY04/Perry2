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
const PORT = process.env.PORT || 3000;

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

// Function to run the appropriate chaos experiment
async function runChaosExperimentByType(params: {
  chaosType: "pod-delete" | "disk-fill" | "node-io-stress";
  targetDeployment: string;
  targetNamespace: string;
  duration: number;
  manifestPath: string;
  fillPercentage?: number;
  ioPercentage?: number;
}) {
  const {
    chaosType,
    targetDeployment,
    targetNamespace,
    duration,
    manifestPath,
    ioPercentage = 10,
  } = params;

  switch (chaosType) {
    case "pod-delete":
      return runPodDeleteExperiment({
        targetDeployment,
        targetNamespace,
        chaosType: "pod-delete",
        duration,
        manifestPath,
      });

    case "disk-fill":
      return runDiskFillExperiment({
        targetDeployment,
        targetNamespace,
        chaosType: "disk-fill",
        duration,
        manifestPath,
      });

    case "node-io-stress":
      return runNodeIOStressExperiment({
        targetDeployment,
        targetNamespace,
        chaosType: "node-io-stress",
        duration,
        manifestPath,
        ioBytesCount: ioPercentage * 1024 * 1024, // Convert percentage to MB
      });

    default:
      throw new Error(`Unsupported chaos type: ${chaosType}`);
  }
}

// Helper to extract result information from chaos result
function extractChaosResultInfo(resultsJson: any) {
  if (!resultsJson || !resultsJson.status) {
    return { verdict: "Unknown", failStep: "None", valid: false };
  }

  let verdict = "Awaited";
  let failStep = "None";
  let valid = false;

  if (resultsJson.status.experimentStatus?.verdict) {
    verdict = resultsJson.status.experimentStatus.verdict;
    failStep = resultsJson.status.experimentStatus.failStep || "None";
    valid = true;
  } else if (resultsJson.status.verdict) {
    verdict = resultsJson.status.verdict;
    failStep = resultsJson.status.failStep || "None";
    valid = true;
  }

  return { verdict, failStep, valid };
}

// Chaos test endpoint
app.post("/chaos-test", (async (
  req: Request<any, any, ChaosTestRequest>,
  res: Response
) => {
  try {
    const {
      githubUrl,
      chaosType = "node-io-stress",
      duration = 30,
      targetNamespace,
      targetDeployment,
      fillPercentage = 80,
      ioPercentage = 10,
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
      await setupLitmusChaos().catch((litmusError) => {
        console.error("Error setting up LitmusChaos:", litmusError);
        throw litmusError;
      });
      console.log(`✅ LitmusChaos framework ready`);

      // 5. Get the first deployment to target for chaos
      const deploymentInfo = await findTargetDeployment();
      const finalTargetDeployment = targetDeployment || deploymentInfo.targetDeployment;
      const finalTargetNamespace = targetNamespace || deploymentInfo.targetNamespace;
      
      console.log(
        `✅ Found target deployment: ${finalTargetDeployment} in namespace ${finalTargetNamespace}`
      );

      // 5.5 Validate LitmusChaos resources and dependencies
      try {
        const validationResult = await validateChaosResources();
        if (!validationResult.valid) {
          console.warn(
            "⚠️ Some LitmusChaos resources are missing or invalid. Will try to continue, but this may cause issues."
          );
          
          // Attempt fixes for common issues
          if (
            validationResult.diagnostics.serviceAccount &&
            !validationResult.diagnostics.serviceAccount.exists
          ) {
            await ensureLitmusChaosServiceAccount(finalTargetNamespace);
            console.log("✅ Created litmus-admin service account");
          }

          if (
            validationResult.diagnostics.podDeleteExperiment &&
            !validationResult.diagnostics.podDeleteExperiment.exists
          ) {
            await installPodDeleteExperiment();
            console.log("✅ Installed pod-delete experiment");
          }
        }
      } catch (validationError) {
        console.error("Error validating chaos resources:", validationError);
        // Continue anyway
      }

      // 6. Run chaos experiment
      const chaosManifest = join(tmpdir(), `chaos-manifest-${timestamp}.yaml`);
      console.log(
        `Starting chaos experiment (${chaosType}) for ${duration} seconds...`
      );

      // Run the appropriate experiment and get results
      const resultsJson = await runChaosExperimentByType({
        chaosType,
        targetDeployment: finalTargetDeployment,
        targetNamespace: finalTargetNamespace,
        duration,
        manifestPath: chaosManifest,
        fillPercentage,
        ioPercentage,
      });

      // Process and return the results
      const { verdict, failStep, valid } = extractChaosResultInfo(resultsJson);

      if (valid) {
        res.json({
          success: true,
          message: "Chaos test completed successfully",
          chaosType,
          duration,
          targetDeployment: finalTargetDeployment,
          targetNamespace: finalTargetNamespace,
          repository: githubUrl,
          verdict,
          failStep,
          experimentStatus: "Completed",
          result: {
            phase: resultsJson.status?.experimentStatus?.phase || "Unknown",
            engineStatus: resultsJson.status?.engineDetails?.engineState || "unknown",
            podStatus: resultsJson.status?.podSearchResults || [],
            debug: resultsJson.status?.debug || {}
          }
        });
      } else {
        res.json({
          success: true,
          message: "Chaos test executed but results may be incomplete",
          chaosType,
          duration,
          targetDeployment: finalTargetDeployment,
          targetNamespace: finalTargetNamespace,
          repository: githubUrl,
          verdict: resultsJson.status?.verdict || "Unknown",
          failStep: resultsJson.status?.failStep || "Unknown",
          experimentStatus: "Completed with partial results",
          debug: resultsJson.status?.debug || {}
        });
      }
    } catch (error) {
      let statusCode = 500;
      let errorMessage = "Unexpected error during chaos test";
      let errorStage = "unknown";
      let errorDetails = error instanceof Error ? error.toString() : String(error);

      // Classify the error based on error message
      if (error instanceof Error) {
        if (error.message.includes("No Kubernetes manifest files")) {
          statusCode = 400;
          errorMessage = error.message;
          errorStage = "manifest detection";
        } else if (error.message.includes("No deployments found")) {
          statusCode = 400;
          errorMessage = error.message;
          errorStage = "target deployment detection";
        } else if (error.message.includes("Failed to clone repository") || 
                   error.message.includes("git clone")) {
          errorMessage = "Failed to clone repository";
          errorStage = "repository cloning";
        } else if (error.message.includes("kubernetes") || 
                   error.message.includes("kind ")) {
          errorStage = "kubernetes setup";
        } else if (error.message.includes("deploy")) {
          errorStage = "application deployment";
        } else if (error.message.includes("chaos") || 
                   error.message.includes("litmus")) {
          errorStage = "chaos execution";
        }
      }

      return res.status(statusCode).json({
        success: false,
        error: errorMessage,
        details: errorDetails,
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
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
