# Reason, as a long-running process on a server.
#
# Playwright's own image rather than a plain Node one: Reason drives a real Chromium, and the
# system libraries that needs are a long list that is easy to get subtly wrong. This image already
# has them, and a matching browser build, which is the thing most likely to break a deployment.
#
# The tag MUST match the playwright version in package.json (1.63.0 at the time of writing): the
# image ships the browser build that version of the library expects, and a mismatch fails at
# runtime rather than at build time. Bump them together.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# Node 24 is what Reason is developed on, and node:sqlite is a moving target before it.
# The Playwright image ships a Node; this makes the version explicit rather than inherited.
RUN . /etc/os-release \
 && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a code change does not re-download the world.
COPY --chown=pwuser:pwuser package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY --chown=pwuser:pwuser src ./src
COPY --chown=pwuser:pwuser README.md LICENSE* ./

# Everything Reason keeps goes here: the database, call recordings, saved browser profiles,
# screenshots. Mount a volume at this path or a restart forgets everything.
ENV REASON_DATA_DIR=/data
VOLUME ["/data"]

# Listen on every interface inside the container; the host decides what is exposed.
ENV REASON_HOST=0.0.0.0
ENV REASON_PORT=8787
EXPOSE 8787

# One Chromium at a time in a container this size, and no sandbox: the container IS the sandbox,
# and Chromium's own needs root or extra capabilities it should not have here.
ENV REASON_BROWSER_HEADED=0

# Reason answers /health from the database and the adapters, not from uptime, so this is a real
# check rather than "the port is open".
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.REASON_PORT||8787)+'/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

# Not root. The image's own non-root user owns /data at runtime via the volume mount.
USER pwuser

# No init shim and no npm in front: node is PID 1 so it gets SIGTERM directly, which is what the
# graceful shutdown in src/serve.js is waiting for. `npm start` would swallow it.
STOPSIGNAL SIGTERM
CMD ["node", "src/serve.js"]
