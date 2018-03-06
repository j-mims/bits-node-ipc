/**
Copyright 2017 LGS Innovations

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
**/

(() => {
  'use strict';

  const REQUEST_GET_SOCKET_PATH = 'bits-node-ipc#GetSocketPath';

  const EventEmitter = require('events');
  const ipc = require('node-ipc');
  const logger = global.LoggerFactory.getLogger();

  // see MessageCenter._messageHandler
  const validMessageTypes = [
    'event',
    'request',
    'response',
    'addEventListener',
    'removeEventListener',
    'addRequestListener',
    'removeRequestListener',
    'addResponseListener',
    'removeResponseListener',
    'addEventSubscriberListener',
    'removeEventSubscriberListener'
  ];

  let responseEmitter = new EventEmitter();

  // List of event listeners that have been registered with the
  // MessageCenter on behalf of an IPC client socket.
  let eventListeners = [];

  // List of request listeners that have been registered with the
  // MessageCenter on behalf of an IPC client socket.
  let requestListeners = [];

  // Primary handler for responding to incoming message from an IPC
  // client socket. There are five message types that are expected:
  //
  // event              - The IPC client wants to send an event to the
  //                      MessageCenter
  // request            - The IPC client wants to send a request to the
  //                      MessageCenter
  // response           - The IPC client is sending a response due to a request
  //                      received from the MessageCenter
  // addEventListener   - The IPC client wants to receive events from the
  //                      MessageCenter
  // addRequestListener - The IPC client wants to receive requests from the
  //                      MessageCenter
  //
  // IMPORTANT: if there are multiple IPC clients connected to the socket, only
  // one of them can register with the request listener.
  function handleIpcMessage(messageCenter, socket, msg) {
    try {
      ////////////////////////////////////////////////////////////////////////
      // event
      if (msg.type === 'event') {
        // Incoming events are easy, just forward them to the BITS message center
        messageCenter.sendEvent(msg.event, ...msg.params);

      ////////////////////////////////////////////////////////////////////////
      // request
      } else if (msg.type === 'request') {
        // For incoming requests we pass the request to the BITS message center
        // tied to a callback with this socket.  When the BITS response comes
        // back we forward it to IPC
        messageCenter.sendRequest(msg.event, ...msg.params)
        .then((...data) => {
          ipc.server.emit(
            socket,
            'bits-ipc',
            {
              type: 'response',
              event: msg.event,
              responseId: msg.requestId,
              err: null,
              result: data
            }
          );
        })
        .catch((err) => {
          logger.error('error on request', err);
        });

      ////////////////////////////////////////////////////////////////////////
      // response
      } else if (msg.type === 'response') {
        // For outoing responses we simply pass to the IPC
        responseEmitter.emit(msg.event, msg.responseId, msg.err, msg.params);

      ////////////////////////////////////////////////////////////////////////
      // addEventListener
      } else if (msg.type === 'addEventListener') {

        // First see if we have already registered this request event for
        // this socket only, if so this is a duplicate and we can ignore it
        for (let i=requestListeners.length-1; i >=0; --i) {
          let rl = requestListeners[i];
          if ((rl.event === msg.event) && (rl.socket === socket)) {
            logger.warn(`ignoring duplicate addEventListener for ${msg.event}`);
            return;
          }
        }

        // When the IPC client wishes to be notified of events,
        // create a listener bound to this socket
        let scope = msg.params[0];
        let listener = (...data) => {
          if (!socket.destroyed) {
            // if the socket is still active, sent the event
            ipc.server.emit(
              socket,
              'bits-ipc',
              {
                type: 'event',
                event: msg.event,
                params: data
              }
            );
          } else {
            // otherwise remove this listener
            messageCenter.removeEventListener(msg.event, listener);
          }
        };

        // Update the listener in our internal list
        eventListeners.push({
          event: msg.event,
          scope: scope,
          socket: socket,
          listener: listener
        });

        // And finally register with the messageCenter
        messageCenter.addEventListener(msg.event, scope, listener);

      ////////////////////////////////////////////////////////////////////////
      // addRequestListener
      } else if (msg.type === 'addRequestListener') {
        // First see if we have already registered this request listener
        // for *any* socket; BITS message center has undefined behaviour
        // if two listeners are registered for the same request
        for (let i=requestListeners.length-1; i >=0; --i) {
          let rl = requestListeners[i];
          if (rl.event === msg.event) {
            logger.warn(`removing previously registered request listener for ${msg.event}`);
            messageCenter.removeRequestListener(msg.event, rl.listener);
            requestListeners.splice(i, 1);
          }
        }

        // Now create a new listener
        let scope = msg.params[0];
        let listener = (metadata, ...data) => {
          if (!socket.destroyed) {
            // if the socket is still active, sent the event
            ipc.server.emit(
              socket,
              'bits-ipc',
              {
                type: 'request',
                requestId: metadata.requestId,
                event: msg.event,
                params: data
              }
            );


            let responsePromise = new Promise((resolve, reject) => {
              const handleIpcResponse = (responseId, err, result) => {
                if (responseId === metadata.requestId) {
                  responseEmitter.removeListener(msg.event, handleIpcResponse);
                  if (err) {
                    reject(err);
                  } else {
                    resolve(result);
                  }
                }
              };
              responseEmitter.on(msg.event, handleIpcResponse);
            });

            return responsePromise;
          } else {
            // otherwise remove this listener
            messageCenter.removeRequestListener(msg.event, listener);
            return Promise.resolve();
          }
        };

        // Update the listener in our internal list
        requestListeners.push({
          event: msg.event,
          scope: scope,
          socket: socket,
          listener: listener
        });

        // And finally register with the messageCenter
        messageCenter.addRequestListener(msg.event, scope, listener);
      }
    } catch (err) {
      logger.warn('Failed to send IPC message', err);
      return;
    }
  }

  // Method to start the Ipc Server
  function startIpcServer(messageCenter) {
    return messageCenter.sendRequest('base#System bitsId')
    .then((systemId) => {
      // create the socket path
      const socketPath = ipc.config.socketRoot + 'bits.' + systemId;

      // setup the server
      ipc.config.silent = true;
      ipc.serve(socketPath);
      ipc.server.on('start', () => {
        logger.info(`IPC server started at ${socketPath}`);
      });

      // Handler for new connections
      ipc.server.on('connect', (socket) => {
        logger.info('Received new connection on bits-node-ipc socket');
      });

      // Handler for disconnects
      ipc.server.on('socket.disconnected', (socket) => {
        logger.info('Received disconnect of bits-node-ipc socket');
        for (let i=requestListeners.length-1; i >=0; --i) {
          let rl = requestListeners[i];
          if (rl.socket === socket) {
            logger.silly(`removing registered request listener for ${rl.event}`);
            messageCenter.removeRequestListener(rl.event, rl.listener);
            requestListeners.splice(i, 1);
          }
        }

        for (let i=eventListeners.length-1; i >=0; --i) {
          let el = eventListeners[i];
          if (el.socket === socket) {
            logger.silly(`removing registered event listener for ${el.event}`);
            messageCenter.removeRequestListener(el.event, el.listener);
            eventListeners.splice(i, 1);
          }
        }
      });

      // Handle incoming messages from clients
      ipc.server.on('bits-ipc', (msg, socket) => {
        if (!msg) {
          logger.warn('Received empty IPC message');
          return;
        }

        logger.silly('Received IPC message', msg);

        if (msg && validMessageTypes.includes(msg.type)) {
          handleIpcMessage(messageCenter, socket, msg);
        } else {
          logger.warn('Ignoring invalid message');
        }
      });

      // start the server
      ipc.server.start();
      return socketPath;
    })
    .catch((err) => {
      logger.error('Failed to get the BITS system id:', err);
      return null;
    });
  }

  // The ModuleApp
  class ModuleApp {
    constructor() {
      this._socketPath = null;
      this._messenger = new global.helper.Messenger();
      this._messenger.addEventListener('bits-ipc#Client connected', {scopes: null}, (name) => {
        logger.info('IPC client connected');
      });
      this._messenger.addRequestListener(REQUEST_GET_SOCKET_PATH, {scopes: null}, () => Promise.resolve(this._socketPath));
    }

    load(messageCenter) {
      return Promise.resolve()
      .then(() => startIpcServer(messageCenter))
      .then((socketPath) => {
        this._socketPath = socketPath;
      })
      .then(() => this._messenger.load(messageCenter))
      .then(() => this.startHeartbeat(messageCenter));
    }

    startHeartbeat(messageCenter) {
      setInterval(() => {
        messageCenter.sendEvent('bits-ipc#heartbeat', {scopes: null}, Date.now());
        messageCenter.sendRequest('bits-ipc#ping', {scopes: null}, Date.now())
        .then((result) => {
          // TODO update a watchdog?
        })
        .catch((err) => {
          logger.silly('Failed to start heartbeat', err);
        });
      }, 1000);
    }

    unload() {
      return Promise.resolve()
      .then(() => this._messenger.unload());
    }
  }

  module.exports = new ModuleApp();
})();
