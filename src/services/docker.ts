import { exec } from 'child_process';
import { promisify } from 'util';

interface DockerImageHistory {
  Id: string;
  Created: number;
  CreatedBy: string;
  Tags: string[];
  Size: number;
  Comment: string;
}

const execAsync = promisify(exec);

export class DockerService {
  async pullImage(image: string): Promise<void> {
    try {
      // Ensure image has a tag
      const imageWithTag = image.includes(':') ? image : `${image}:latest`;
      console.log(`Pulling image: ${imageWithTag}`);
      
      await execAsync(`docker pull ${imageWithTag}`);
    } catch (error) {
      throw new Error(`Failed to pull image ${image}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async inspectImage(image: string): Promise<any> {
    try {
      const imageWithTag = image.includes(':') ? image : `${image}:latest`;
      const { stdout } = await execAsync(`docker inspect ${imageWithTag}`);
      return JSON.parse(stdout)[0];
    } catch (error) {
      throw new Error(`Failed to inspect image ${image}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getImageLayers(image: string): Promise<string[]> {
    try {
      const imageWithTag = image.includes(':') ? image : `${image}:latest`;
      const { stdout } = await execAsync(`docker history --no-trunc --format "{{.ID}}" ${imageWithTag}`);
      return stdout.split('\n').filter(Boolean);
    } catch (error) {
      throw new Error(`Failed to get image layers for ${image}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async runSyftAnalysis(image: string): Promise<string> {
    try {
      const imageWithTag = image.includes(':') ? image : `${image}:latest`;
      const { stdout } = await execAsync(`syft ${imageWithTag} -o json`);
      return stdout;
    } catch (error) {
      throw new Error(`Failed to run Syft analysis on ${image}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async cleanup(image: string): Promise<void> {
    try {
      const imageWithTag = image.includes(':') ? image : `${image}:latest`;
      await execAsync(`docker rmi ${imageWithTag}`);
    } catch (error) {
      console.error(`Error cleaning up image ${image}:`, error);
    }
  }
}