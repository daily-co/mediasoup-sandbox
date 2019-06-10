const config = require('./config');
const debugModule = require('debug');
const mediasoup = require('mediasoup');
const express = require('express');
const https = require('https');
const fs = require('fs');

const expressApp = express();
let httpsServer;

const log = debugModule('demo-app');
const warn = debugModule('demo-app:WARN');
const err = debugModule('demo-app:ERROR');

let worker, router, audioLevelObserver;

//
// data structure for our single "room".
//
// for each peer that connects, we keep up to date info about which
// tracks are being sent and received. we also need to know the last
// time we saw the peer, so that we can disconnect clients that have
// network issues.
//
// for this simple demo, we'll just send this roomState.peers data
// structure to each client every time the client polls.
//
// [peerId] : {
//   joinTs: <ms timestamp>
//   lastSeenTs: <ms timestamp>
//   media: {
//     [mediaTag] : {
//       paused: <bool>
//       encodings: []
//     }
//   },
//   stats: {
//     producers: {
//       [producerId]: {
//         ...(selected producer stats)
//       }
//     consumers: {
//       [consumerId]: { ...(selected consumer stats) }
//     }
//   }
//   consumerLayers: {
//     [consumerId]:
//         currentLayer,
//         clientSelectedLayer,
//       }
//     }
//   }
// }
//
// we also keep lists of transports, producers, consumers, and the
// activeSpeaker. whenever we create a transport, producer, or
// consumer, we save the remote peerId in the object's `appData`. for
// producers and consumers we also keep track of the client-side
// "media id", to correlate tracks.
//
const roomState = {
  peers: {},
  transports: {},
  producers: [],
  consumers: [],
  activeSpeaker: { producerId: null, volume: null, peerId: null }
}

//
// http server needs to send 'index.html' and 'client-bundle.js'.
// might as well just send everything in this directory
//

expressApp.use(express.static(__dirname));

//
// main() -- our execution entry point
//
async function main() {
  // start mediasoup
  console.log('starting mediasoup');
  ({ worker, router, audioLevelObserver } = await startMediasoup());

  // start https server, falling back to http if https fails
  console.log('starting express');
  try {
    const tls = {
      cert: fs.readFileSync(config.sslCrt),
      key: fs.readFileSync(config.sslKey),
    };
    httpsServer = https.createServer(tls, expressApp);
    httpsServer.on('error', (e) => {
      console.error('https server error,', e.message);
    });
    await new Promise((resolve) => {
      httpsServer.listen(config.httpPort, config.httpIp, () => {
        console.log(`server is running and listening on ` +
                    `https://${config.httpIp}:${config.httpPort}`);
        resolve();
      });
    });
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error('no certificates found (check config.js)');
      console.error('  could not start https server ... trying http');
    } else {
      err('could not start https server', e);
    }
    expressApp.listen(config.httpPort, config.httpIp, () => {
      console.log(`http server listening on port ${config.httpPort}`);
    });
  }

  // periodically clean up peers that disconnected without sending us
  // a final "beacon"
  setInterval(() => {
    let now = Date.now();
    Object.entries(roomState.peers).forEach(([id, p]) => {
      if ((now - p.lastSeenTs) > config.httpPeerStale) {
        warn(`removing stale peer ${id}`);
        closePeer(id);
      }
    });
  }, 1000);

  // periodically update video stats we're sending to peers
  setInterval(updatePeerStats, 5000);
}

main();


//
// start mediasoup with a single worker and router
//
async function startMediasoup() {
  let worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  worker.on('died', () => {
    console.error('mediasoup worker died (this should never happen)');
    process.exit(1);
  });

  const mediaCodecs = config.mediasoup.router.mediaCodecs;
  const router = await worker.createRouter({ mediaCodecs });
  const audioLevelObserver = await router.createAudioLevelObserver({
		interval: 800
	});

  audioLevelObserver.on('volumes', (volumes) => {
    const { producer, volume } = volumes[0];
    log('audio-level volumes event', producer.appData.peerId, volume);
    roomState.activeSpeaker.producerId = producer.id;
    roomState.activeSpeaker.volume = volume;
    roomState.activeSpeaker.peerId = producer.appData.peerId;
  });
  audioLevelObserver.on('silence', () => {
    log('audio-level silence event');
    roomState.activeSpeaker.producerId = null;
    roomState.activeSpeaker.volume = null;
    roomState.activeSpeaker.peerId = null;
  });

  return { worker, router, audioLevelObserver };
}

async function createWebRtcTransport({ peerId, direction }) {
  const {
    listenIps,
    initialAvailableOutgoingBitrate
  } = config.mediasoup.webRtcTransport;

  const transport = await router.createWebRtcTransport({
    listenIps: listenIps,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
//    initialAvailableOutgoingBitrate: initialAvailableOutgoingBitrate,
    appData: { peerId, clientDirection: direction }
  });

  return transport;
}

//
// -- our minimal signaling is just http polling --
//

// parse every request body for json, no matter the content-type. this
// lets us use sendBeacon or fetch interchangeably to POST to
// signaling endpoints. (sendBeacon can't set the Content-Type header)
expressApp.use(express.json({ type: '*/*' }));

//
// /signaling/join-as-new-peer
//
// adds the peer to the roomState data structure and creates a
// transport that the peer will use for receiving media. returns
// router rtpCapabilities and the new transport.
//
expressApp.post('/signaling/join-as-new-peer', async (req, res) => {
  let { peerId } = req.body,
      now = Date.now();

  roomState.peers[peerId] = {
    joinTs: now,
    lastSeenTs: now,
    media: {}, consumerLayers: {}, stats: {}
  };

  res.send({
    routerRtpCapabilities: router.rtpCapabilities,
  });
});

expressApp.post('/signaling/leave', async (req, res) => {
  let { peerId } = req.body;

  console.log('LEAVE', peerId);

  await closePeer(peerId);
  delete roomState.peers[peerId];
  res.send({});
});

function closePeer(peerId) {
  log(`closing peer ${peerId}`);
  roomState.producers.filter((p) => p.appData.peerId === peerId)
                     .forEach((p) => {
    closeProducer(p);
  });
  delete roomState.peers[peerId];
}

function closeProducer(producer) {
  for (let consumer of [...roomState.consumers]) {
    if (consumer.producerId === producer.id) {
      closeConsumer(consumer);
    }
  }
  producer.close();
  roomState.producers = roomState.producers.filter((p) => p.id !== producer.id);
  if (roomState.peers[producer.appData.peerId]) {
    delete (roomState.peers[producer.appData.peerId]
              .media[producer.appData.mediaTag]);
  }
}

function closeConsumer(consumer) {
  log(`closing consumer ${consumer.id}`);
  consumer.close();
  roomState.consumers = roomState.consumers.filter((c) => c.id !== consumer.id);
  if (roomState.peers[consumer.appData.peerId]) {
    delete roomState.peers[consumer.appData.peerId].consumerLayers[consumer.id];
  }
}

expressApp.post('/signaling/sync', async (req, res) => {
  let { peerId } = req.body;
  try {
    // make sure this peer is connected. if we've disconnected the
    // peer because of a network outage we want the peer to know that
    // happened, when/if it returns
    if (!roomState.peers[peerId]) {
      throw new Error('not connected');
    }
    roomState.peers[peerId].lastSeenTs = Date.now();
    res.send({
      peers: roomState.peers,
      activeSpeaker: roomState.activeSpeaker
    });
  } catch (e) {
    console.error(e.message);
    res.send({ error: e.message });
  }
});

//
expressApp.post('/signaling/create-transport', async (req, res) => {
  let { peerId, direction } = req.body;
  console.log('CREATE', req.body);

  let transport = await createWebRtcTransport({ peerId, direction });
  roomState.transports[transport.id] = transport;

  let { id, iceParameters, iceCandidates, dtlsParameters } = transport;
  res.send({
    transportOptions: { id, iceParameters, iceCandidates, dtlsParameters }
  });
});

expressApp.post('/signaling/connect-transport', async (req, res) => {
  let { transportId, dtlsParameters } = req.body;

  console.log('CONNECT', transportId);

  if (!roomState.transports[transportId]) {
    res.send({ error: `server-side transport ${transportId} not found` });
    return;
  }
  await roomState.transports[transportId].connect({ dtlsParameters });
  res.send({});
});

//
expressApp.post('/signaling/close-transport', async (req, res) => {
  let { peerId, transportId } = req.body;
  log(`close-transport from ${peerId} on transport ${transportId}`);

  try {
    let transport = roomState.transports[transportId];
    if (!transport) {
      throw new Error(`can not find transport ${transportId}`);
    }
    // close all producers and consumers
    for (let producer of [...roomState.producers]) {
      if (producer.appData.transportId === transport.id) {
        closeProducer(producer);
      }
    }
    // close the transport
    transport.close();
    roomState.peers[peerId].media = {};
    res.send({});
  } catch (e) {
    err(e);
    res.send({ error: e.message });
  }
});

expressApp.post('/signaling/close-producer', async (req, res) => {
  let { peerId, producerId } = req.body;
  log(`close-producer from ${peerId} on producer ${producerId}`);

  try {
    let producer = roomState.producers.find((p) => p.id === producerId);
    if (!producer) {
      throw new Error(`can not find producer ${producerId}`);
    }
    closeProducer(producer);
    res.send({});
  } catch (e) {
    err(e);
    res.send({ error: e.message });
  }
});


//
expressApp.post('/signaling/send-track', async (req, res) => {
  let { peerId, transportId, kind, rtpParameters,
        paused=false, appData } = req.body;
  log(`send-track from ${peerId}, ${kind}, ${JSON.stringify(appData)}, ${paused ?'paused':''}`);
  if (!roomState.transports[transportId]) {
    let msg = `server-side transport ${transportId} not found`;
    warn(msg);
    res.send({ error: msg });
    return;
  }
  let producer = await roomState.transports[transportId].produce({
    kind,
    rtpParameters,
    paused,
    appData: { ...appData, peerId, transportId }
  });

  roomState.producers.push(producer);
  // monitor audio level of this producer. we call addProducer() here,
  // but we don't ever need to call removeProducer() because the core
  // AudioLevelObserver code automatically removes closed producers
  if (producer.kind === 'audio') {
    audioLevelObserver.addProducer({ producerId: producer.id });
  }

  res.send({ id: producer.id });

  // todo -- do something if media id is already found (replace track?)
  //
  roomState.peers[peerId].media[appData.mediaTag] = {
    paused,
    encodings: rtpParameters.encodings
  };
});

//
expressApp.post('/signaling/recv-track', async (req, res) => {
  let { peerId, mediaPeerId, mediaTag, rtpCapabilities } = req.body;
  try {
    console.log('RECV-TRACK', peerId, mediaPeerId, mediaTag);

    let producer = roomState.producers.find(
      (p) => p.appData.mediaTag === mediaTag &&
             p.appData.peerId === mediaPeerId
    );
    if (!producer) {
      throw new Error('can not find producer');
    }
    if (!router.canConsume({ producerId: producer.id,
                             rtpCapabilities })) {
      throw new Error('can not find producer');
    }

    let transport = Object.values(roomState.transports).find((t) =>
      t.appData.peerId === peerId && t.appData.clientDirection === 'recv'
    );
    if (!transport) {
      throw new Error(`can not find recv transport for ${peerId}`);
    }

    let consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: true,
      appData: { peerId, mediaPeerId, mediaTag }
    });

    // stick this consumer in our list of consumers to keep track of,
    // and create a data structure to track the client-relevant state
    // of this consume
    roomState.consumers.push(consumer);
    roomState.peers[peerId].consumerLayers[consumer.id] = {
      currentLayer: null,
      clientSelectedLayer: null
    };

    // update above data structure when layer changes.
    consumer.on('layerschange', (layers) => {
      log('consumer layerschange', peerId, mediaPeerId, mediaTag, layers);
      if (roomState.peers[peerId] &&
          roomState.peers[peerId].consumerLayers[consumer.id]) {
        roomState.peers[peerId].consumerLayers[consumer.id]
          .currentLayer = layers && layers.spatialLayer;
      }
    });
    res.send({
      producerId: producer.id,
      id: consumer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
      producerPaused: consumer.producerPaused
    });
  } catch (e) {
    console.error(e);
    res.send ({ error: e.message });
  }
});

expressApp.post('/signaling/pause-consumer', async (req, res) => {
  let { peerId, consumerId } = req.body;
  console.log('PAUSE-TRACK', peerId, consumerId);

  try {
    let consumer = roomState.consumers.find((c) => c.id === consumerId)
    if (!consumer) {
      throw new Error(`can not find consumer ${consumerId}`);
    }
    consumer.pause();
    res.send({});
  } catch (e) {
    res.send({ error: e.message });
  }
});

expressApp.post('/signaling/resume-consumer', async (req, res) => {
  let { peerId, consumerId } = req.body;
  console.log('RESUME-TRACK', peerId, consumerId);

  try {
    let consumer = roomState.consumers.find((c) => c.id === consumerId)
    if (!consumer) {
      throw new Error(`can not find consumer ${consumerId}`);
    }
    consumer.resume();
    res.send({});
  } catch (e) {
    res.send({ error: e.message });
  }
});

expressApp.post('/signaling/close-consumer', async (req, res) => {
  let { peerId, consumerId } = req.body;
  console.log('CLOSE-TRACK', peerId, consumerId);

  try {
    let consumer = roomState.consumers.find((c) => c.id === consumerId)
    if (!consumer) {
      throw new Error(`can not find consumer ${consumerId}`);
    }
    closeConsumer(consumer);
    res.send({});
  } catch (e) {
    res.send({ error: e.message });
  }
});

expressApp.post('/signaling/consumer-set-layers', async (req, res) => {
  let { peerId, consumerId, spatialLayer } = req.body;
  console.log('SET-LAYERS', peerId, consumerId);

  try {
    let consumer = roomState.consumers.find((c) => c.id === consumerId)
    if (!consumer) {
      throw new Error(`can not find consumer ${consumerId}`);
    }
    consumer.setPreferredLayers({ spatialLayer });
    res.send({});
  } catch (e) {
    res.send({ error: e.message });
  }
});

expressApp.post('/signaling/pause-producer', async (req, res) => {
  let { peerId, producerId } = req.body;
  log(`pause-producer from ${peerId} on producer ${producerId}`);

  try {
    let producer = roomState.producers.find((p) => p.id === producerId)
    if (!producer) {
      throw new Error(`can not find producer ${producerId}`);
    }
    producer.pause();
    roomState.peers[peerId].media[producer.appData.mediaTag].paused = true;
    res.send({});
  } catch (e) {
    err(e);
    res.send({ error: e.message });
  }
});

expressApp.post('/signaling/resume-producer', async (req, res) => {
  let { peerId, producerId } = req.body;
  log(`resume-producer from ${peerId} on producer ${producerId}`);

  try {
    let producer = roomState.producers.find((p) => p.id === producerId)
    if (!producer) {
      throw new Error(`can not find producer ${producerId}`);
    }
    producer.resume();
    roomState.peers[peerId].media[producer.appData.mediaTag].paused = false;
    res.send({});
  } catch (e) {
    err(e);
    res.send({ error: e.message });
  }
});

expressApp.post('/signaling/producer-stats', async (req, res) => {
  let { peerId, producerId } = req.body;
  log(`producer-stats from ${peerId} on producer ${producerId}`);

  try {
    let producer = roomState.producers.find((p) => p.id === producerId)
    if (!producer) {
      throw new Error(`can not find producer ${producerId}`);
    }
    let stats = await producer.getStats();
    res.send({ stats });
  } catch (e) {
    err(e);
    res.send({ error: e.message });
  }
});

//
// stats
//

async function updatePeerStats() {
  for (let producer of roomState.producers) {
    if (producer.kind !== 'video') {
      continue;
    }
    try {
      let stats = await producer.getStats(),
          peerId = producer.appData.peerId;
      roomState.peers[peerId].stats[producer.id] = stats.map((s) => ({
        bitrate: s.bitrate,
        fractionLost: s.fractionLost,
        jitter: s.jitter,
        score: s.score,
        rid: s.rid
      }));
    } catch (e) {
      warn('error while updating producer stats', e);
    }
  }

  for (let consumer of roomState.consumers) {
    try {
      let stats = (await consumer.getStats())
                    .find((s) => s.type === 'outbound-rtp'),
          peerId = consumer.appData.peerId;
      if (!stats || !roomState.peers[peerId]) {
        continue;
      }
      roomState.peers[peerId].stats[consumer.id] = {
        bitrate: stats.bitrate,
        fractionLost: stats.fractionLost,
        score: stats.score
      }
    } catch (e) {
      warn('error while updating consumer stats', e);
    }
  }
}
