FROM --platform=linux/amd64 python:3.12.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends diffutils && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir pyyaml pytest anthropic httpx
WORKDIR /fixer
COPY *.py run.sh /fixer/
ENTRYPOINT ["/bin/sh", "/fixer/run.sh"]
