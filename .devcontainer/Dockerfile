# Development container image.
# Debian-based on purpose: the Temporal SDK needs glibc, so Alpine (musl) images do not work.
FROM mcr.microsoft.com/devcontainers/javascript-node:22-bookworm

# Temporal CLI: used from session 3 onwards to send signals and queries by hand.
# The install is allowed to fail so that a network hiccup does not break the container build.
USER node
RUN curl -sSf https://temporal.download/cli.sh | sh || echo "Temporal CLI install skipped"
ENV PATH="/home/node/.temporalio/bin:${PATH}"
