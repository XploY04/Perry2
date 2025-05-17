import { exec } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';

const execAsync = promisify(exec);

export class KubernetesService {
  async createAnalysisJob(image: string, jobId: string): Promise<void> {
    try {
      // Create a job manifest
      const jobManifest = `
apiVersion: batch/v1
kind: Job
metadata:
  name: syft-analysis-${jobId}
spec:
  template:
    spec:
      containers:
      - name: syft
        image: anchore/syft:latest
        args: ["${image}", "-o", "json"]
      restartPolicy: Never
`;

      // Create a temporary file for the job manifest using system temp directory
      const manifestPath = join(tmpdir(), `job-${jobId}.yaml`);
      await execAsync(`echo '${jobManifest.replace(/'/g, "'\\''").replace(/\n/g, "\\n")}' > ${manifestPath}`);

      // Apply the job using kubectl with perry context
      await execAsync(`kubectl --context kind-perry apply -f ${manifestPath}`);
      
      // Clean up the manifest file
      await execAsync(`rm ${manifestPath}`);
    } catch (error) {
      throw new Error(`Failed to create analysis job: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async waitForJobCompletion(jobId: string): Promise<void> {
    try {
      // Wait for the job to complete using perry context
      await execAsync(`kubectl --context kind-perry wait --for=condition=complete job/syft-analysis-${jobId} --timeout=300s`);
    } catch (error) {
      throw new Error(`Job failed or timed out: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getJobLogs(jobId: string): Promise<string> {
    try {
      // Get the pod name using perry context
      const { stdout: podNameResult } = await execAsync(`kubectl --context kind-perry get pods -l job-name=syft-analysis-${jobId} -o jsonpath="{.items[0].metadata.name}"`);
      const podName = podNameResult.trim();
      
      if (!podName) {
        throw new Error('No pod found for the analysis job');
      }

      // Get the logs using perry context
      const { stdout: logsResult } = await execAsync(`kubectl --context kind-perry logs ${podName}`);
      return logsResult;
    } catch (error) {
      throw new Error(`Failed to get job logs: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async cleanupJob(jobId: string): Promise<void> {
    try {
      await execAsync(`kubectl --context kind-perry delete job syft-analysis-${jobId}`);
    } catch (error) {
      console.error(`Error cleaning up job ${jobId}:`, error);
    }
  }
}