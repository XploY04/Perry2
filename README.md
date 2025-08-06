# Perry2

A comprehensive chaos engineering and container security analysis platform that provides vulnerability scanning and fault injection testing for Kubernetes applications.

## Features

### Container Security Analysis

- **SBOM Generation**: Creates Software Bill of Materials (SBOM) for container images
- **Vulnerability Scanning**: Uses Grype to scan containers for security vulnerabilities
- **Docker Integration**: Seamlessly pulls and analyzes Docker images
- **REST API**: Easy-to-use HTTP endpoints for container analysis

### Chaos Engineering

- **Multiple Chaos Types**: Support for various chaos experiments
  - Pod deletion chaos
  - Disk fill chaos
  - Node I/O stress testing
  - Network latency/loss/corruption (planned)
- **Kubernetes Integration**: Native support for KIND clusters
- **LitmusChaos Integration**: Built on top of the LitmusChaos framework
- **Automated Recovery**: Detection and recovery of stuck experiments
- **GitHub Integration**: Clone and test applications directly from GitHub repositories

## Prerequisites

- **Docker**: Required for container analysis and Kubernetes cluster management
- **kubectl**: Kubernetes command-line tool
- **KIND**: Kubernetes in Docker for local testing
- **Grype**: Container vulnerability scanner
- **Node.js**: Runtime environment (Node.js 16+ recommended)

## Installation

1. Clone the repository:

```bash
git clone https://github.com/XploY04/Perry2.git
cd Perry2
```

2. Install dependencies:

```bash
npm install
```

3. Build the project:

```bash
npm run build
```

4. Ensure your user has Docker permissions:

```bash
sudo usermod -aG docker $USER
newgrp docker
```

## Usage

### Starting the Server

```bash
npm start
```

The server will start on port 3000 (or the port specified in the `PORT` environment variable).

### Container Analysis API

#### Analyze Container Image

```bash
POST /analyze
Content-Type: application/json

{
  "image": "nginx:latest"
}
```

Response includes vulnerability scan results from Grype.

#### Health Check

```bash
GET /health
```

### Chaos Testing API

#### Run Chaos Test

```bash
POST /chaos-test
Content-Type: application/json

{
  "githubUrl": "https://github.com/user/app",
  "chaosType": "pod-delete",
  "duration": 60,
  "targetNamespace": "default",
  "targetDeployment": "my-app"
}
```

Supported chaos types:

- `pod-delete`: Randomly deletes pods
- `disk-fill`: Fills disk space to test storage resilience
- `node-io-stress`: Creates I/O stress on nodes

### Command Line Tools

#### Chaos Testing Script

```bash
node scripts/chaos-test.js --github-url https://github.com/user/app --chaos-type pod-delete --duration 60
```

Available options:

- `--github-url`: GitHub repository URL containing Kubernetes manifests
- `--chaos-type`: Type of chaos test (pod-delete, disk-fill, node-io-stress)
- `--duration`: Duration in seconds (default: 30)
- `--namespace`: Target namespace (auto-detected if not specified)
- `--deployment`: Target deployment (auto-detected if not specified)
- `--io-percentage`: I/O stress percentage for node-io-stress (default: 10)

#### Chaos Recovery Script

```bash
node scripts/chaos-recovery.js
```

Automatically detects and recovers stuck chaos experiments.

#### Node I/O Stress Test

```bash
node scripts/test-node-io-stress.js
```

Runs specific I/O stress testing scenarios.

## Development Scripts

- `npm run dev`: Build and start the development server
- `npm run build`: Compile TypeScript to JavaScript
- `npm run chaos`: Run chaos testing script
- `npm run chaos-recovery`: Run chaos recovery script
- `npm run test-node-io-stress`: Run I/O stress test

## Architecture

### Core Components

- **Express Server**: REST API for container analysis and chaos testing
- **Docker Service**: Container image management and analysis
- **Kubernetes Service**: K8s cluster operations and job management
- **Chaos Services**:
  - LitmusChaos integration
  - Pod chaos experiments
  - I/O chaos experiments
  - Recovery mechanisms

### Directory Structure

```
src/
├── index.ts              # Main Express server
├── services/
│   ├── docker.ts         # Docker operations
│   ├── kubernetes.ts     # Kubernetes operations
│   └── chaos/            # Chaos engineering modules
│       ├── core.ts       # Core chaos functionality
│       ├── litmus.ts     # LitmusChaos integration
│       ├── pod-chaos.ts  # Pod-related experiments
│       ├── io-chaos.ts   # I/O stress experiments
│       ├── recovery.ts   # Experiment recovery
│       └── utils.ts      # Utility functions
├── types/
│   └── index.ts          # TypeScript type definitions
└── scripts/              # Command-line tools
```

## Configuration

### Environment Variables

- `PORT`: Server port (default: 3000)

### Docker Requirements

The application requires Docker socket access. Ensure your user is in the docker group or run with appropriate permissions.

## Error Handling

The application includes comprehensive error handling for:

- Docker permission issues
- Kubernetes cluster connectivity
- Stuck chaos experiments
- Resource cleanup failures

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

ISC License

## Troubleshooting

### Docker Permission Denied

If you encounter Docker permission errors:

1. Add your user to the docker group: `sudo usermod -aG docker $USER`
2. Log out and log back in, or run: `newgrp docker`
3. Restart the application

### KIND Cluster Issues

If KIND cluster creation fails:

1. Ensure Docker is running
2. Check if port 8080 is available
3. Try deleting existing clusters: `kind delete cluster --name chaos-test`

### Stuck Chaos Experiments

Use the recovery script to clean up stuck experiments:

```bash
npm run chaos-recovery
```

## Security Considerations

- Always run chaos tests in isolated environments
- Be cautious with production clusters
- Review chaos experiment configurations before execution
- Monitor resource usage during chaos tests
