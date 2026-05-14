# Use official Playwright image — browsers + system deps pre-installed
# Pin version to match the playwright npm package in package.json (1.44.0)
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Copy dependency manifests first for Docker layer cache
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci

# Copy build config and source
COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript
RUN npm run build

# Ensure data directories exist (will be overridden by volume mount at runtime)
RUN mkdir -p data/debug

CMD ["node", "dist/interfaces/cli/index.js"]
