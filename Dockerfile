FROM alpine:3.20 AS ffmpeg
RUN apk add --no-cache ffmpeg

FROM n8nio/n8n:latest
USER root
COPY --from=ffmpeg /usr/bin/ffmpeg /usr/bin/ffmpeg
COPY --from=ffmpeg /usr/bin/ffprobe /usr/bin/ffprobe
COPY --from=ffmpeg /usr/lib/ /usr/lib/
USER node
