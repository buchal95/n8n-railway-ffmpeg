FROM alpine:3.20 AS ffmpeg
RUN apk add --no-cache ffmpeg

FROM n8nio/n8n:latest
USER root
COPY --from=ffmpeg /usr/bin/ffmpeg /usr/bin/ffmpeg
COPY --from=ffmpeg /usr/bin/ffprobe /usr/bin/ffprobe
COPY --from=ffmpeg /usr/lib/libav* /usr/lib/
COPY --from=ffmpeg /usr/lib/libsw* /usr/lib/
COPY --from=ffmpeg /usr/lib/libpostproc* /usr/lib/
RUN chown -R node:node /home/node/.n8n || true
USER node
