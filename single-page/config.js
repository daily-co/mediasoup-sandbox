module.exports = {
  httpIp: '0.0.0.0',
  httpPort: 3000,
  httpPeerStale: 15000,

  sslCrt: 'fullchain.pem',
  sslKey: 'privkey.pem',

  mediasoup: {
    // Worker settings
    worker: {
      rtcMinPort: 40000,
      rtcMaxPort: 49999,
      logLevel: 'debug',
      logTags: [
        'info',
        'ice',
        'dtls',
        'rtp',
        'srtp',
        'rtcp',
        // 'rtx',
        // 'bwe',
        // 'score',
        // 'simulcast',
        // 'svc'
      ],
    },
    // Router settings
    router: {
      mediaCodecs:
        [
          {
            kind: 'audio',
            mimeType: 'audio/opus',
            clockRate: 48000,
            channels: 2
          },
          {
            kind: 'video',
            mimeType: 'video/VP8',
            clockRate: 90000,
            parameters:
              {
//                'x-google-start-bitrate': 1000
              }
          },
          {
					  kind       : 'video',
					  mimeType   : 'video/h264',
					  clockRate  : 90000,
					  parameters :
					  {
						  'packetization-mode'      : 1,
						  'profile-level-id'        : '4d0032',
						  'level-asymmetry-allowed' : 1,
						  'x-google-start-bitrate'  : 1000
					  }
				  },
				  {
					  kind       : 'video',
					  mimeType   : 'video/h264',
					  clockRate  : 90000,
					  parameters :
					  {
						  'packetization-mode'      : 1,
						  'profile-level-id'        : '42e01f',
						  'level-asymmetry-allowed' : 1,
						  'x-google-start-bitrate'  : 1000
					  }
				  }
        ]
    },
    // WebRtcTransport settings
    webRtcTransport: {
      listenIps: [
         { ip: '10.10.23.101', announcedIp: null },
       //{ ip: '10.100.100.1', announcedIp: null },
       //{ ip: '192.168.7.131', announcedIp: null }
      ],
      initialAvailableOutgoingBitrate: 600000,
    }
  }
};
