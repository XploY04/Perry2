import express from 'express';
import type { Request, Response } from 'express';
import { ContainerAnalysisRequest, SBOMResult } from './types';
import { DockerService } from './services/docker';
import { KubernetesService } from './services/kubernetes';
import { v4 as uuidv4 } from 'uuid';
import bodyParser from 'body-parser';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
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
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Main analysis endpoint
app.post('/analyze', async (req: Request, res: Response) => {
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
    res.status(500).json({ 
      error: 'Analysis failed', 
      details: error instanceof Error ? error.message : 'Unknown error'
    });
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
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});