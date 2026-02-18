FROM node:20-alpine
RUN apk add --no-cache ffmpeg fontconfig ttf-dejavu
RUN mkdir -p /app/fonts
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js ./
EXPOSE 3000
CMD ["node", "server.js"]
