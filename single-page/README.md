# mediasoup sample code

Sample code with the the simplest possible signaling, and fewest
possible dependencies, for cross-browser testing of:

- sending/receiving audio and video tracks
- switching to a different input device and replacing a track
- screen sharing
- subscribing to and unsubscribing from tracks
- pausing tracks for sender and receiver independently
- simulcast
- setting maximum simulcast layer when sending
- setting maximum simulcast layer when receiving
- display of stats
- display of "active speaker"

## Running the sample code

```
npm install
DEBUG="mediasoup*, demo-app*" npm run start
```

Then open http://localhost:3000/

The demo "application" is a single video-call "room." Super
simple.

Click on `[send camera streams]`. You should see listings for
your own video and audio track show up, with `[subscribe]` buttons next
to them. Click the `[subscribe]` button next to the video track to
subscribe to your camera feed.

Don't subscribe to your own audio feed. :-)

Open the same page in another tab, window, or browser.

Uncheck the checkboxes to pause producers/consumers. Click on the
radio buttons to select a different simulcast layer for
sending/receiving.

## Clients on other machines

To send media from a client that's not running on localhost, you'll
need to enable HTTPS. Point the `sslCrt` and `sslKey` values in
`config.js` at an ssl certificate and key pair. You can use a
[self-signed
certificate](https://devcenter.heroku.com/articles/ssl-certificate-self).

If `sslCrt`/`sslKey` are found, the server will start as an HTTPS
rather than an HTTP server. Check the console output to confirm that
this happened as expected.

You'll also need to add an entry to the `webRtcTransport.listIps` array
in `config.js`.

## Running on AWS EC2 instances

1. Make sure that your instance security group allows inbound TCP to
   port 3000, inbound UDP to ports 40000-49999, and all outbound traffic.

2. On AWS Linux you'll need to install a newer version of g++ than is
   included in the Development Tools package group.

```
# from-scratch install on AWS Linux

sudo yum install git
curl -o- https://raw.githubusercontent.com/creationix/nvm/v0.32.0/install.sh | bash
. ~/.nvm/nvm.sh
nvm install 11
sudo yum groupinstall "Development Tools"
sudo yum install gcc72-c++
git clone https://github.com/daily-co/mediasoup-sandbox.git
cd mediasoup-sandbox/
npm install
```

3. Make a `listenIps` entry with `ip` set to the instance's private IP
   address, and `announcedIp` set to the instance's public IPv4 address.

## A note on signaling and code structure

The signaling in this sample code is very, very simple. No
websockets. Just a few http endpoints and a http polling at one herz.

All of the server code is in a single file: [server.js](server.js).

All of the client-side javascript code is in a single file:
[client.js](client.js).

With the goal of making the mediasoup parts of the code as clear and
concise as possible, the UI is implemented directly in javascript,
without using a framework or any other dependencies. It's not good
front-end code! For example, we redraw large parts of the UI each time
our one herz polling loop gives us new data. This means that you may
have to click on a radio button multiple times for the click to
actually work.
