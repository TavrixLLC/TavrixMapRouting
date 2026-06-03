FROM ghcr.io/valhalla/valhalla@sha256:35362dd5f215a8dd6f19b8dab7b41a85cbf0e743e010b7ccf8f5aa984bf565a1

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates coreutils curl jq osmium-tool \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 tavrix \
  && useradd --uid 10001 --gid 10001 --create-home tavrix \
  && mkdir -p /valhalla \
  && chown -R tavrix:tavrix /valhalla

USER tavrix
WORKDIR /valhalla

CMD ["sleep", "infinity"]
