# Never built. The helper images the Docker publish workflows run
# (docker-publish.yml, docker-aio-build.yml), pinned by digest:
#   binfmt    runs --privileged to register the QEMU emulators (arm64 build)
#   buildkit  the Buildx builder that builds and pushes the images with the
#             registry login
# The workflows read these lines (scripts/helper-images.mjs) instead of the
# actions' moving defaults (binfmt:latest, buildkit:buildx-stable-1), and
# Dependabot's docker ecosystem keeps the tags and digests current.
FROM docker.io/tonistiigi/binfmt:qemu-v10.2.3@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0 AS binfmt
FROM docker.io/moby/buildkit:v0.33.1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea AS buildkit
