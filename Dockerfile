# Use a build argument for the Playwright version to ensure image compatibility with package.json
ARG PLAYWRIGHT_VERSION=1.61.1
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy

# Set the working directory
WORKDIR /app

# Prevent interactive prompts during package installation
ARG DEBIAN_FRONTEND=noninteractive

# Install system dependencies for Python, yt-dlp, and ffmpeg, plus VNC stack for manual auth
RUN apt-get update && apt-get install -y --no-install-recommends software-properties-common \
    && add-apt-repository -y universe \
    && apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg curl \
    xvfb x11vnc novnc websockify fluxbox \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies for Shazam recognition
RUN pip3 install shazamio

# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

# Copy package files and install node dependencies
COPY package.json ./
RUN npm install

# Copy the rest of the application code
COPY . .

# Create logs directory
RUN mkdir -p logs

# Setup entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

# Set environment variables (defaults)
ENV NODE_ENV=production
ENV HEADLESS=true

# Use entrypoint script to manage Xvfb/VNC
ENTRYPOINT ["/entrypoint.sh"]

# Command to run the scraper in continuous mode
CMD ["node", "scrape.js", "--continuous"]
