FROM node:20-alpine
WORKDIR /app
RUN npm install peer
EXPOSE 9000
CMD ["npx", "peerjs", "--port", "9000", "--path", "/"]
