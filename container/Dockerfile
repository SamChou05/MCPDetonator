FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

RUN apt-get update \
    && apt-get install --yes --no-install-recommends strace util-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/forge
COPY container/trace-entrypoint.sh /usr/local/bin/forge-trace-entrypoint

RUN chmod 0555 /usr/local/bin/forge-trace-entrypoint

ENTRYPOINT ["/usr/local/bin/forge-trace-entrypoint"]
