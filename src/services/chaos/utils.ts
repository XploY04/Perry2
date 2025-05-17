// Common utility functions for chaos testing
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

export const execAsync = promisify(exec);

/**
 * Checks if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true).catch(() => false);
}

/**
 * Checks if a directory contains a specific file
 */
export async function directoryContains(baseDir: string, subDir: string, fileName: string): Promise<boolean> {
  const targetPath = path.join(baseDir, subDir, fileName);
  return fileExists(targetPath);
}

/**
 * Waits for pods to be ready in the specified namespace
 */
export async function waitForPodsReadiness(namespace: string, options: any): Promise<void> {
  const timeout = options.timeout || 120;
  const kubectlBin = options.kubectl || 'kubectl';
  const contextArg = options.context ? `--context=${options.context}` : '';
  
  console.log(`Waiting for pods to be ready in namespace ${namespace}...`);
  
  try {
    await execAsync(`${kubectlBin} wait --for=condition=Ready pods --all --timeout=${timeout}s --namespace=${namespace} ${contextArg}`);
    console.log("All pods are ready!");
  } catch (error) {
    console.warn("Warning: Not all pods became ready within timeout");
    // Continue anyway as we want to report the status
  }
}
