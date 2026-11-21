# Fleet Updates dashboard as a container: the page, the API, the install scripts and the agent
# binaries they download. Built from the repo root:
#   docker build -f deploy/Dockerfile -t fleet-updates .
FROM golang:1.24-alpine AS agents
WORKDIR /src
COPY agent ./agent
RUN cd agent && for t in darwin/arm64 linux/amd64 windows/amd64; do \
      os=${t%/*}; arch=${t#*/}; ext=; [ "$os" = windows ] && ext=.exe; \
      CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w" -o /dist/fleet-agent-$os-$arch$ext . ; \
    done

FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY agents ./agents
COPY --from=agents /dist ./dist
RUN rm -rf server/test
ENV DATA_DIR=/data DIST_DIR=/app/dist HOST=0.0.0.0 PORT=7480
USER 1000:1000
EXPOSE 7480
CMD ["node", "server/server.js"]
