import { z } from 'zod';

export const ContainerAnalysisRequest = z.object({
  image: z.string().min(1)
});

export const SBOMResult = z.object({
  imageName: z.string(),
  baseImage: z.string(),
  layers: z.array(z.object({
    layerId: z.string(),
    packages: z.array(z.object({
      name: z.string(),
      version: z.string(),
      type: z.string(),
    })),
  })),
  metadata: z.object({
    envVars: z.record(z.string()),
    buildArgs: z.record(z.string()).optional(),
    createdAt: z.string(),
  }),
});

export type ContainerAnalysisRequest = z.infer<typeof ContainerAnalysisRequest>;
export type SBOMResult = z.infer<typeof SBOMResult>;