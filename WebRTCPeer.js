'use strict';

import {recursive} from 'merge';
import freeice from 'freeice';
import EventEmitter from 'events';
import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription
} from 'react-native-webrtc';

const MEDIA_CONSTRAINTS = {
  audio: true,
  video: {
    width: 640,
    framerate: 15
  }
};

// Somehow, the UAParser constructor gets an empty window object.
// We need to pass the user agent string in order to get information
// var ua = (window && window.navigator) ? window.navigator.userAgent : ''
// var parser = new UAParser(ua)
// var browser = parser.getBrowser()

function noop(error) {
  if (error) logger.error(error)
}

function trackStop(track) {
  track.stop && track.stop()
}

function streamStop(stream) {
  stream.getTracks().forEach(trackStop)
}

/**
 * Returns a string representation of a SessionDescription object.
 */
function dumpSDP(description) {
  if (typeof description === 'undefined' || description === null) {
    return ''
  }

  return 'type: ' + description.type + '\r\n' + description.sdp
}

function bufferizeCandidates(pc, onerror) {
  let candidatesQueue = [];

  pc.addEventListener('signalingstatechange', function () {
    if (this.signalingState === 'stable') {
      while (candidatesQueue.length) {
        let entry = candidatesQueue.shift();

        this.addIceCandidate(entry.candidate, entry.callback, entry.callback)
      }
    }
  });

  return function (candidate, callback) {
    callback = callback || onerror;

    switch (pc.signalingState) {
      case 'closed':
        callback(new Error('PeerConnection object is closed'));
        break;
      case 'stable':
        if (pc.remoteDescription) {
          pc.addIceCandidate(candidate, callback, callback);
          break
        }
      // TODO: fallthrough or not?
      default:
        candidatesQueue.push({
          candidate: candidate,
          callback: callback
        })
    }
  }
}

/* Simulcast utilities */

function removeFIDFromOffer(sdp) {
  let n = sdp.indexOf("a=ssrc-group:FID");

  if (n > 0) {
    return sdp.slice(0, n);
  } else {
    return sdp;
  }
}

function getSimulcastInfo(videoStream) {
  let videoTracks = videoStream.getVideoTracks();

  if (!videoTracks.length) {
    logger.warn('No video tracks available in the video stream');
    return ''
  }

  let lines = [
    'a=x-google-flag:conference',
    'a=ssrc-group:SIM 1 2 3',
    'a=ssrc:1 cname:localVideo',
    'a=ssrc:1 msid:' + videoStream.id + ' ' + videoTracks[0].id,
    'a=ssrc:1 mslabel:' + videoStream.id,
    'a=ssrc:1 label:' + videoTracks[0].id,
    'a=ssrc:2 cname:localVideo',
    'a=ssrc:2 msid:' + videoStream.id + ' ' + videoTracks[0].id,
    'a=ssrc:2 mslabel:' + videoStream.id,
    'a=ssrc:2 label:' + videoTracks[0].id,
    'a=ssrc:3 cname:localVideo',
    'a=ssrc:3 msid:' + videoStream.id + ' ' + videoTracks[0].id,
    'a=ssrc:3 mslabel:' + videoStream.id,
    'a=ssrc:3 label:' + videoTracks[0].id
  ];

  lines.push('');

  return lines.join('\n');
}

class WebRTCPeer extends EventEmitter {

  _localVideo: string;
  _remoteVideo: string;
  _videoStream: string;
  _audioStream: string;

  _mediaConstraints: string;
  _connectionConstraints: string;
  _peerConnection: string;
  _sendSource: string;

  _dataChannelConfig: {};
  _useDataChannels: boolean;


  constructor(mode: string, options = {}, callback) {
    super();

    this._localVideo = options._localVideo;
    this._remoteVideo = options._remoteVideo;
    this._videoStream = options._videoStream;
    this._audioStream = options._audioStream;

    this._mediaConstraints = options._mediaConstraints;
    this._connectionConstraints = options._connectionConstraints;
    this._peerConnection = options.peerConnection;
    this._sendSource = options._sendSource || 'webcam';

    this._dataChannelConfig = options._dataChannelConfig;
    this._useDataChannels = options.dataChannels || false;

    this._dataChannel = null;

    this._id = options.id;
    this._guid = uuid.v4();

    this._configuration = recursive(
      {iceServers: freeice()},
      options._configuration || {});

    {
      let onicecandidate = options.onicecandidate;
      let oncandidategatheringdone = options.oncandidategatheringdone;

      if (onicecandidate) this.on('icecandidate', onicecandidate);
      if (oncandidategatheringdone) this.on('_candidategatheringdone', oncandidategatheringdone);
    }

    this._simulcast = options._simulcast;
    this._multistream = options._multistream;
    this._candidatesQueueOut = [];
    this._candidategatheringdone = false;

    if (!this._peerConnection) {
      this._peerConnection = new RTCPeerConnection(this.configuration);

      if (this._useDataChannels && !this._dataChannel) {
        let dcId = 'WebRtcPeer-' + self.id;
        let dcOptions = undefined;

        if (this._dataChannelConfig) {
          dcId = this._dataChannelConfig.id || dcId;
          dcOptions = this._dataChannelConfig.options;
        }

        this._dataChannel = this._peerConnection.createDataChannel(dcId, dcOptions);

        if (this._dataChannelConfig) {
          this._dataChannel.onopen = this._dataChannelConfig.onopen;
          this._dataChannel.onclose = this._dataChannelConfig.onclose;
          this._dataChannel.onmessage = this._dataChannelConfig.onmessage;
          this._dataChannel.onbufferedamountlow = this._dataChannelConfig.onbufferedamountlow;
          this._dataChannel.onerror = this._dataChannelConfig.onerror || noop;
        }
      }
    }

    this._peerConnection.addEventListener('icecandidate', (event) => {
      let candidate = event.candidate;

      if (
        EventEmitter.listenerCount(this, 'icecandidate') ||
        EventEmitter.listenerCount(this, 'candidategatheringdone')
      ) {
        if (candidate) {
          this.emit('icecandidate', candidate);

          this._candidategatheringdone = false;
        } else if (!this._candidategatheringdone) {
          this.emit('candidategatheringdone');

          this._candidategatheringdone = true;
        }

      } else if (!this._candidategatheringdone) {
        // Not listening to 'icecandidate' or 'candidategatheringdone' events, queue
        // the candidate until one of them is listened
        this._candidatesQueueOut.push(candidate);

        if (!candidate) this._candidategatheringdone = true;
      }
    });

    this._peerConnection.onaddstream = options.onaddstream;
    this._peerConnection.onnegotiationneeded = options.onnegotiationneeded;

    this.on('newListener', (event, listener) => {
      if (event === 'icecandidate' || event === 'candidategatheringdone') {
        while (candidatesQueueOut.length) {
          let candidate = candidatesQueueOut.shift();

          if (!candidate === (event === 'candidategatheringdone')) {
            listener(candidate)
          }
        }
      }
    });

    let addIceCandidate = bufferizeCandidates(this._peerConnection);
  }

  get peerConnection() {
    return this._peerConnection
  }

  get id() {
    return this._id || this._guid;
  }

  get remoteVideo() {
    return this._remoteVideo;
  }

  get localVideo() {
    return this._localVideo;
  }

  get dataChannel() {
    return this._dataChannel;
  }

  get currentFrame() {
    // [ToDo] Find solution when we have a remote stream but we didn't set
    // a remoteVideo tag
    if (!this._remoteVideo) return;

    if (this._remoteVideo.readyState < this._remoteVideo.HAVE_CURRENT_DATA) {
      throw new Error('No video stream data available');
    }

    let canvas = document.createElement('canvas');

    canvas.width = this._remoteVideo.videoWidth;
    canvas.height = this._remoteVideo.videoHeight;

    canvas.getContext('2d').drawImage(this._remoteVideo, 0, 0);

    return canvas
  }

  /**
   * Callback function invoked when an ICE candidate is received. Developers are
   * expected to invoke this function in order to complete the SDP negotiation.
   *
   * @function module:kurentoUtils.WebRtcPeer.prototype.addIceCandidate
   *
   * @param iceCandidate - Literal object with the ICE candidate description
   * @param callback - Called when the ICE candidate has been added.
   */
  addIceCandidate(iceCandidate, callback) {
    let candidate = new RTCIceCandidate(iceCandidate);

    logger.debug('Remote ICE candidate received', iceCandidate);
    callback = (callback || noop).bind(this);
    addIceCandidate(candidate, callback);
  }

  generateOffer(callback) {
    callback = callback.bind(this);

    let offerAudio = true;
    let offerVideo = true;

    // Constraints must have both blocks
    if (this._mediaConstraints) {
      offerAudio = (typeof this._mediaConstraints.audio === 'boolean') ?
        this._mediaConstraints.audio : true;
      offerVideo = (typeof this._mediaConstraints.video === 'boolean') ?
        this._mediaConstraints.video : true;
    }


    let constraints = this._connectionConstraints;

    logger.info('constraints: ' + JSON.stringify(constraints));

    this._peerConnection.createOffer(constraints)
      .then((offer) => {
        logger.info('Created SDP offer');
        offer = this.mangleSdpToAddSimulcast(offer);
        return this._peerConnection.setLocalDescription(offer);
      }).then(() => {
        let localDescription = this._peerConnection.localDescription;
        logger.info('Local description set', localDescription.sdp);

        callback(null, this.localDescription.sdp, this.processAnswer.bind(self))
      }).catch(callback)
  }

  getLocalSessionDescriptor() {
    return this._peerConnection.localDescription;
  }

  getRemoteSessionDescriptor() {
    return this._peerConnection.remoteDescription;
  }

  setRemoteVideo() {
    if (this._remoteVideo) {
      let stream = this._peerConnection.getRemoteStreams()[0];
      let url = stream ? URL.createObjectURL(stream) : '';

      this._remoteVideo.pause();
      this._remoteVideo.src = url;
      this._remoteVideo.load();

      logger.info('Remote URL:', url)
    }
  }

  showLocalVideo() {
    this._localVideo.src = URL.createObjectURL(videoStream);
    this._localVideo.muted = true;
  }

  send(data) {
    if (this._dataChannel && this._dataChannel.readyState === 'open') {
      this._dataChannel.send(data)
    } else {
      logger.warn('Trying to send data over a non-existing or closed data channel')
    }
  }

  /**
   * Callback function invoked when a SDP answer is received. Developers are
   * expected to invoke this function in order to complete the SDP negotiation.
   *
   * @function module:kurentoUtils.WebRtcPeer.prototype.processAnswer
   *
   * @param sdpAnswer - Description of sdpAnswer
   * @param callback -
   *            Invoked after the SDP answer is processed, or there is an error.
   */
  processAnswer(sdpAnswer, callback) {
    callback = (callback || noop).bind(this);

    let answer = new RTCSessionDescription({
      type: 'answer',
      sdp: sdpAnswer
    });

    logger.info('SDP answer received, setting remote description');

    if (this._peerConnection.signalingState === 'closed') {
      return callback('PeerConnection is closed')
    }

    this._peerConnection.setRemoteDescription(answer, function () {
        setRemoteVideo();

        callback()
      },
      callback)
  }

  /**
   * Callback function invoked when a SDP offer is received. Developers are
   * expected to invoke this function in order to complete the SDP negotiation.
   *
   * @function module:kurentoUtils.WebRtcPeer.prototype.processOffer
   *
   * @param sdpOffer - Description of sdpOffer
   * @param callback - Called when the remote description has been set
   *  successfully.
   */
  processOffer (sdpOffer, callback) {
    callback = callback.bind(this);

    let offer = new RTCSessionDescription({
      type: 'offer',
      sdp: sdpOffer
    });

    logger.info('SDP offer received, setting remote description');

    if (this._peerConnection.signalingState === 'closed') {
      return callback('PeerConnection is closed')
    }

    this._peerConnection.setRemoteDescription(offer)
      .then(() => {
        return setRemoteVideo()
      }).then(() => {
        return pc.createAnswer()
      }).then((answer) => {
        answer = this.mangleSdpToAddSimulcast(answer);
        logger.info('Created SDP answer');
        return this._peerConnection.setLocalDescription(answer);
      }).then(() => {
        let localDescription = this._peerConnection.localDescription;
        logger.info('Local description set', localDescription.sdp);
        callback(null, localDescription.sdp)
      }).catch(callback)
  }

  mangleSdpToAddSimulcast(answer) {
    if (this.simulcast) {
      if (browser.name === 'Chrome' || browser.name === 'Chromium') {
        logger.info('Adding multicast info');
        answer = new RTCSessionDescription({
          'type': answer.type,
          'sdp': removeFIDFromOffer(answer.sdp) + getSimulcastInfo(this._videoStream)
        })
      } else {
        logger.warn('Simulcast is only available in Chrome browser.')
      }
    }

    return answer
  }
}

export default WebRTCPeer;