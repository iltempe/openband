# DiffSinger + OpenBand's OMEP adapter on a GPU machine (RunPod, Modal, a Hugging Face Space, your own
# server): an OMEP engine at http://<host>:8765/mcp that OpenBand reaches as a "url" engine. Build from
# the root of the OpenBand repository:
#   docker build -f deploy/diffsinger/Dockerfile -t openband-diffsinger .
# Run with your voicebank mounted as DiffSinger's experiment folder and a token of your own:
#   docker run --gpus all -p 8765:8765 -e OMEP_TOKEN=… -e VOICEBANK=my_voice \
#     -v /path/to/my_voice:/opt/DiffSinger/checkpoints/my_voice openband-diffsinger
FROM pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime

RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates libsndfile1 \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*

# DiffSinger (openvpi, Apache-2.0), pinned.
ARG DIFFSINGER_COMMIT=76b75dec8a5233afa47ef0e1377d25a080af3289
RUN git clone https://github.com/openvpi/DiffSinger /opt/DiffSinger \
 && cd /opt/DiffSinger && git checkout "$DIFFSINGER_COMMIT" \
 && pip install --no-cache-dir -r requirements.txt

# OpenBand's adapter and what it needs (the MCP SDK and zod).
WORKDIR /opt/omep
COPY omep/ ./omep/
RUN npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund @modelcontextprotocol/sdk@1.32.1 zod@4.6.7 ajv@8.20.0 ajv-formats@3.0.1

ENV VOICEBANK=my_voice PORT=8765
EXPOSE 8765
CMD node omep/diffsinger-engine.mjs --http "$PORT" --host 0.0.0.0 --repo /opt/DiffSinger --exp "$VOICEBANK" --python python
