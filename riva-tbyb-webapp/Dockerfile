FROM node:14@sha256:167d0a4af6b4e0d0769086b871a36c25faed75b72705144cabbda70466cc0d8e
RUN wget -O /usr/local/bin/dumb-init https://github.com/Yelp/dumb-init/releases/download/v1.2.5/dumb-init_1.2.5_x86_64 \
    && chmod +x /usr/local/bin/dumb-init
WORKDIR /usr/src/app
COPY --chown=node:node . /usr/src/app
RUN npm install --save hcaptcha \
    && npm ci --only=production

USER node
ENTRYPOINT ["/usr/local/bin/dumb-init", "--"]
CMD [ "node", "server.js" ]
