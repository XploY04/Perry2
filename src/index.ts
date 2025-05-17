import express, { Request, Response, RequestHandler } from 'express';
import { ContainerAnalysisRequest, SBOMResult, ChaosTestRequest, ChaosTestResult } from './types';
import { DockerService } from './services/docker';
import { KubernetesService } from './services/kubernetes';
import { 
  cloneRepository, 
  setupKubernetesCluster, 
  deployApplication, 
  setupLitmusChaos, 
  findTargetDeployment, 
  runChaosExperiment 
} from './services/chaos';
import { v4 as uuidv4 } from 'uuid';
import bodyParser from 'body-parser';
import fs from 'fs/promises';
import path from 'path';
import { join } from 'path';
import os from 'os';
import { tmpdir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

const app = express();

// Middleware

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const dockerService = new DockerService();
const k8sService = new KubernetesService();

// Health check endpoint
app.get('/health', ((_req: Request, res: Response) => {
  res.json({ status: 'ok' });
}) as RequestHandler);

// Main analysis endpoint
app.post('/analyze', (async (req: Request, res: Response) => {
  let image: string = '';
  let jobId: string = '';
  let sbomPath: string = '';
  try {
    // Generate unique job ID
    console.log('image', JSON.stringify(req.body));
    if (!req.body.image || typeof req.body.image !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid image in request body' });
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
    await fs.writeFile(sbomPath, sbomJson, 'utf-8');
    // Run grype on the SBOM file
    const { stdout: grypeOutput } = await execAsync(`grype sbom:${sbomPath} -o json`);
    // Return grype output as JSON
    res.type('application/json').send(grypeOutput);
  } catch (error) {
    console.error('Analysis failed:', error);
    
    // Check for Docker permission errors
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes("permission denied") && errorMessage.includes("docker.sock")) {
      res.status(500).json({ 
        error: 'Docker permission denied', 
        details: 'This application requires Docker permissions. Please try one of these solutions:\n' +
                 '1. Add your user to the docker group: sudo usermod -aG docker $USER\n' +
                 '2. Log out and log back in, or run: newgrp docker\n' +
                 '3. Start the application with sudo (not recommended for production)'
      });
    } else {
      res.status(500).json({ 
        error: 'Analysis failed', 
        details: errorMessage
      });
    }
  } finally {
    // Cleanup resources
    if (image) {
      try {
        await dockerService.cleanup(image);
      } catch (e) {
        console.error('Error cleaning up Docker image:', e);
      }
    }
    if (jobId) {
      try {
        await k8sService.cleanupJob(jobId);
      } catch (e) {
        console.error('Error cleaning up K8s job:', e);
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
app.post('/chaos-test', (async (req: Request<any, any, ChaosTestRequest>, res: Response) => {
  try {
    const { githubUrl } = req.body;

    if (!githubUrl) {
      return res.status(400).json({
        success: false,
        error: "GitHub URL is required"
      });
    }

    console.log(`Starting chaos test for repo: ${githubUrl}`);

    try {
      // 1. Clone the GitHub repository
      const { repoDir, timestamp } = await cloneRepository(githubUrl);

      // 2. Create a Kind cluster if it doesn't exist
      await setupKubernetesCluster();

      // 3. Apply Kubernetes manifests from the repo
      await deployApplication(repoDir);

      // 4. Install LitmusChaos if not already installed
      await setupLitmusChaos();

      // 5. Get the first deployment to target for chaos
      const { targetDeployment, targetNamespace } = await findTargetDeployment();

      // 6. Run pod-delete chaos experiment
      const chaosManifest = join(tmpdir(), `chaos-manifest-${timestamp}.yaml`);
      const chaosType = "pod-delete";
      const duration = 30;

      try {
        const resultsJson = await runChaosExperiment({
          targetDeployment,
          targetNamespace,
          chaosType,
          duration,
          manifestPath: chaosManifest
        });

        // 7. Return results
        res.json({
          success: true,
          message: "Chaos test completed successfully",
          chaosType,
          duration,
          targetDeployment,
          targetNamespace,
          repository: githubUrl,
          verdict: resultsJson.status?.verdict || "Awaited",
          failStep: resultsJson.status?.failStep || "None",
          experimentStatus: "Completed"
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: "Error during chaos testing",
          details: error instanceof Error ? error.toString() : String(error),
          chaosType,
          targetDeployment,
          targetNamespace,
          repository: githubUrl
        });
      }
    } catch (error) {
      // Handle specific errors from different stages
      let statusCode = 500;
      let errorMessage = "Unexpected error during chaos test";

      if (error instanceof Error) {
        if (error.message.includes("No Kubernetes manifest files")) {
          statusCode = 400;
          errorMessage = error.message;
        } else if (error.message.includes("No deployments found")) {
          statusCode = 400;
          errorMessage = error.message;
        } else if (error.message.includes("Failed to clone repository")) {
          errorMessage = "Failed to clone repository";
        }
      }

      return res.status(statusCode).json({
        success: false,
        error: errorMessage,
        details: error instanceof Error ? error.toString() : String(error)
      });
    }
  } catch (error) {
    console.error("Unexpected error:", error);
    res.status(500).json({
      success: false,
      error: "Unexpected error occurred",
      details: error instanceof Error ? error.toString() : String(error)
    });
  }
}) as RequestHandler);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});