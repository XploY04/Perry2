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
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (typeof errorMessage === 'string' && 
          errorMessage.includes("permission denied") && 
          errorMessage.includes("docker.sock")) {
        throw new Error(
          `Docker permission denied when pulling image ${image}. Please try these solutions:\n` +
          "1. Add your user to the docker group: sudo usermod -aG docker $USER\n" +
          "2. Log out and log back in, or run: newgrp docker\n" +
          "3. Run the application with sudo (not recommended for production)"
        );
      }
      
      throw new Error(`Failed to pull image ${image}: ${errorMessage}`);
    }
  }

  async inspectImage(image: string): Promise<any> {
    try {
      const imageWithTag = image.includes(':') ? image : `${image}:latest`;
      const { stdout } = await execAsync(`docker inspect ${imageWithTag}`);
      return JSON.parse(stdout)[0];
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (typeof errorMessage === 'string' && 
          errorMessage.includes("permission denied") && 
          errorMessage.includes("docker.sock")) {
        throw new Error(
          `Docker permission denied when inspecting image ${image}. Please try these solutions:\n` +
          "1. Add your user to the docker group: sudo usermod -aG docker $USER\n" +
          "2. Log out and log back in, or run: newgrp docker\n" +
          "3. Run the application with sudo (not recommended for production)"
        );
      }
      
      throw new Error(`Failed to inspect image ${image}: ${errorMessage}`);
    }
  }

  async getImageLayers(image: string): Promise<string[]> {
    try {
      const imageWithTag = image.includes(':') ? image : `${image}:latest`;
      const { stdout } = await execAsync(`docker history --no-trunc --format "{{.ID}}" ${imageWithTag}`);
      return stdout.split('\n').filter(Boolean);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (typeof errorMessage === 'string' && 
          errorMessage.includes("permission denied") && 
          errorMessage.includes("docker.sock")) {
        throw new Error(
          `Docker permission denied when getting image layers for ${image}. Please try these solutions:\n` +
          "1. Add your user to the docker group: sudo usermod -aG docker $USER\n" +
          "2. Log out and log back in, or run: newgrp docker\n" +
          "3. Run the application with sudo (not recommended for production)"
        );
      }
      
      throw new Error(`Failed to get image layers for ${image}: ${errorMessage}`);
    }
  }

  async runSyftAnalysis(image: string): Promise<string> {
    try {
      const imageWithTag = image.includes(':') ? image : `${image}:latest`;
      const { stdout } = await execAsync(`syft ${imageWithTag} -o json`);
      return stdout;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (typeof errorMessage === 'string' && 
          errorMessage.includes("permission denied") && 
          errorMessage.includes("docker.sock")) {
        throw new Error(
          `Docker permission denied when running Syft analysis on ${image}. Please try these solutions:\n` +
          "1. Add your user to the docker group: sudo usermod -aG docker $USER\n" +
          "2. Log out and log back in, or run: newgrp docker\n" +
          "3. Run the application with sudo (not recommended for production)"
        );
      }
      
      throw new Error(`Failed to run Syft analysis on ${image}: ${errorMessage}`);
    }
  }

  async cleanup(image: string): Promise<void> {
    try {
      const imageWithTag = image.includes(':') ? image : `${image}:latest`;
      await execAsync(`docker rmi ${imageWithTag}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (typeof errorMessage === 'string' && 
          errorMessage.includes("permission denied") && 
          errorMessage.includes("docker.sock")) {
        console.error(
          `Docker permission denied when cleaning up image ${image}. Please try these solutions:\n` +
          "1. Add your user to the docker group: sudo usermod -aG docker $USER\n" +
          "2. Log out and log back in, or run: newgrp docker\n" +
          "3. Run the application with sudo (not recommended for production)"
        );
      } else {
        console.error(`Error cleaning up image ${image}: ${errorMessage}`);
      }
    }
  }
}